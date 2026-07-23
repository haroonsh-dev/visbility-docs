import os
import json
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from ..database import SupabaseDB
from ..config import settings
from ..models.schemas import DocumentStatus
from .orchestrator_service import orchestrator

logger = logging.getLogger("visibility-docs")
_pool = ThreadPoolExecutor(max_workers=8)


class DocumentService:
    async def create_document(self, organization_id: str, title: str, file_info: dict, uploaded_by: str = None) -> dict:
        import datetime
        now = datetime.datetime.utcnow().isoformat()
        doc_id = __import__("uuid").uuid4().hex
        doc_data = {
            "id": doc_id,
            "organization_id": organization_id,
            "title": title,
            "status": DocumentStatus.UPLOADED.value,
            "original_file_url": file_info["file_path"],
            "file_size": file_info["file_size"],
            "file_hash": file_info.get("file_hash", ""),
            "uploaded_by": uploaded_by or "",
            "created_at": now,
            "updated_at": now,
        }

        result = SupabaseDB.insert("documents", doc_data)
        if hasattr(result, "data") and result.data:
            return result.data[0]
        return doc_data

    async def process_document(self, document_id: str, organization_id: str) -> dict:
        SupabaseDB.update("documents", {"status": DocumentStatus.PROCESSING.value}, "id", document_id)
        def _safe_run(did, oid):
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as runner:
                fut = runner.submit(orchestrator.run_pipeline, did, oid)
                try:
                    return fut.result(timeout=1800)
                except concurrent.futures.TimeoutError:
                    logger.error(f"Pipeline timed out (>30 min) for {did}")
                    try:
                        SupabaseDB.update("documents", {"status": "failed", "error_message": "Pipeline timed out"}, "id", did)
                    except Exception:
                        pass
                    return {"status": "failed"}
                except Exception as e:
                    logger.error(f"Pipeline crashed for {did}: {e}")
                    import traceback
                    traceback.print_exc()
                    try:
                        SupabaseDB.update("documents", {"status": "failed", "error_message": str(e)}, "id", did)
                    except Exception:
                        pass
                    return {"status": "failed"}
        fut = _pool.submit(_safe_run, document_id, organization_id)
        def _log_err(f):
            try:
                exc = f.exception()
                if exc:
                    logger.error(f"Pipeline background failed for {document_id}: {exc}")
            except:
                pass
        fut.add_done_callback(_log_err)
        return {"document_id": document_id, "status": "processing", "message": "Pipeline started in background"}

    async def process_document_await(self, document_id: str, organization_id: str) -> dict:
        SupabaseDB.update("documents", {"status": DocumentStatus.PROCESSING.value}, "id", document_id)
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(_pool, orchestrator.run_pipeline, document_id, organization_id)
        return result

    def _attach_cv_extraction(self, doc: dict, organization_id: str, full_data: bool = False):
        if doc.get("document_type") != "resume":
            return
        try:
            ext_result = SupabaseDB.select("document_extractions",
                columns="extracted_data",
                filters={"document_id": doc["id"], "organization_id": organization_id},
            )
            ext_data = getattr(ext_result, "data", ext_result if isinstance(ext_result, list) else [])
            if isinstance(ext_data, list) and ext_data:
                raw = ext_data[0].get("extracted_data", "{}")
                if isinstance(raw, str):
                    import json
                    parsed = json.loads(raw)
                else:
                    parsed = raw or {}
                ev = parsed.get("cv_evaluation") or {}
                score = ev.get("overall_score") if ev.get("overall_score") is not None else parsed.get("cv_score")
                if score is not None:
                    try:
                        doc["cv_score"] = float(score)
                    except (ValueError, TypeError):
                        pass
                if full_data and ev:
                    doc["cv_extraction_data"] = ev
        except Exception:
            pass

    def get_document(self, document_id: str, organization_id: str) -> dict:
        result = SupabaseDB.select("documents", filters={"id": document_id, "organization_id": organization_id})
        data = getattr(result, "data", result if isinstance(result, list) else [])
        if isinstance(data, list) and len(data) > 0:
            doc = data[0]
            self._attach_cv_extraction(doc, organization_id, full_data=True)
            return doc
        return data if isinstance(data, dict) else None

    def _batch_attach_extractions(self, docs: list[dict], organization_id: str):
        """Batch-fetch document_extractions for all docs in one query, attach cv_score to resumes."""
        resume_ids = [d["id"] for d in docs if d.get("document_type") == "resume"]
        if not resume_ids:
            return
        try:
            import json
            from ..database import _local_select_in, _get_supabase, _use_supabase
            unique_ids = list(set(resume_ids))
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_extractions") \
                    .select("document_id, extracted_data") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", organization_id) \
                    .execute()
                rows = getattr(r, "data", [])
            else:
                rows = _local_select_in("document_extractions",
                    columns="document_id, extracted_data",
                    filters={"organization_id": organization_id},
                    in_column="document_id", in_values=unique_ids)
            scores = {}
            for row in rows:
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    parsed = json.loads(raw)
                else:
                    parsed = raw or {}
                ev = parsed.get("cv_evaluation") or {}
                score = ev.get("overall_score") if ev.get("overall_score") is not None else parsed.get("cv_score")
                if score is not None:
                    try:
                        scores[row["document_id"]] = float(score)
                    except (ValueError, TypeError):
                        pass
            for d in docs:
                if d["id"] in scores:
                    d["cv_score"] = scores[d["id"]]
        except Exception:
            pass

    def list_documents(self, organization_id: str, limit: int = 50, offset: int = 0, search: str = "", phase3_agent: str = "") -> list[dict]:
        filters = {"organization_id": organization_id}
        if phase3_agent:
            filters["phase3_agent"] = phase3_agent
        like = {"title": search} if search else None
        result = SupabaseDB.select("documents", filters=filters, like=like, limit=limit, offset=offset)
        data = getattr(result, "data", result if isinstance(result, list) else [])
        docs = data if isinstance(data, list) else []

        # Batch-attach cv_score for resume documents (single query instead of N queries)
        self._batch_attach_extractions(docs, organization_id)

        return docs

    def delete_document(self, document_id: str, organization_id: str):
        doc = self.get_document(document_id, organization_id)
        if doc:
            file_path = doc.get("original_file_url", "")
            if file_path and os.path.exists(file_path):
                try:
                    os.remove(file_path)
                except Exception:
                    pass
            supabase_url = doc.get("supabase_url") or ""
            if supabase_url:
                try:
                    filename = supabase_url.rsplit("/", 1)[-1]
                    SupabaseDB.delete_file("documents", filename)
                except Exception:
                    pass
        SupabaseDB.delete_document_cascade(document_id)
        try:
            from .pinecone_service import pinecone_service
            pinecone_service.delete_by_document(document_id, namespace=organization_id)
        except Exception:
            pass
        return {"message": "Document deleted successfully"}


document_service = DocumentService()
