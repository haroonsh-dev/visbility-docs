import os
import asyncio
import traceback
import logging
from uuid import uuid4
from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Body, Request, status
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field
from ..config import settings
from ..database import SupabaseDB
from ..models.schemas import UploadResponse, DocumentListResponse, ProcessResponse
from ..services.document_service import document_service
from ..utils.file_utils import save_upload_file, is_allowed_file

logger = logging.getLogger("visibility-docs")

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])


class ClassifyTextRequest(BaseModel):
    text: str = Field(..., min_length=1, description="Document text to classify")
    filename: str = Field("", description="Original filename")


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload a document",
    description="Upload PDF, image, DOCX, XLSX, or PPTX file for processing",
)
async def upload_document(
    file: UploadFile = File(..., description="Document file (PDF, images, DOCX, XLSX, PPTX)"),
    organization_id: str = Form(..., description="Tenant organization ID"),
    title: str = Form(None, description="Optional document title"),
):
    print("\n" + "="*70)
    print(f"[UPLOAD] Received file: {file.filename} for org: {organization_id}")
    print("="*70)
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    if not is_allowed_file(file.filename):
        print(f"[UPLOAD] REJECTED - unsupported type: {file.filename}")
        raise HTTPException(
            status_code=400,
            detail=f"File type not supported: {file.filename}. Allowed: PDF, JPG, PNG, TIFF, BMP, WEBP, DOCX, XLSX, PPTX, TXT",
        )

    doc_title = title or file.filename

    try:
        file_info = await save_upload_file(file, organization_id)
        print(f"[UPLOAD] File saved: {file_info.get('path', '?')} (hash: {file_info.get('file_hash', '?')[:16]}...)")
    except Exception as e:
        logger.error(f"Failed to save upload file: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to save file: {str(e)}")

    # Duplicate detection by file hash
    file_hash = file_info.get("file_hash", "")
    if file_hash:
        existing = SupabaseDB.select("documents", filters={"organization_id": organization_id, "file_hash": file_hash})
        existing_data = getattr(existing, "data", existing if isinstance(existing, list) else [])
        if isinstance(existing_data, list) and existing_data:
            dup = existing_data[0] if isinstance(existing_data[0], dict) else {}
            old_file = dup.get("original_file_url", "")
            if old_file and not os.path.exists(old_file):
                print(f"[UPLOAD] Old file missing on disk - deleting stale record and allowing re-upload")
                SupabaseDB.delete_document_cascade(dup.get("id", ""))
            else:
                print(f"[UPLOAD] DUPLICATE DETECTED - already uploaded as '{dup.get('title', 'unknown')}'")
                raise HTTPException(
                    status_code=409,
                    detail=f"Duplicate file detected. Already uploaded as '{dup.get('title', 'unknown')}' (status: {dup.get('status', '?')})",
                )

    try:
        doc = await document_service.create_document(
            organization_id=organization_id,
            title=doc_title,
            file_info=file_info,
        )
        print(f"[UPLOAD] Document record created: ID={doc.get('id', '?')}")
    except Exception as e:
        logger.error(f"Failed to create document record: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Failed to create document record: {str(e)}")

    doc_id = doc.get("id", uuid4().hex) if isinstance(doc, dict) else str(doc) if doc else ""

    # Auto-start pipeline in background
    try:
        print(f"[UPLOAD] Auto-starting pipeline for document: {doc_id}")
        asyncio.ensure_future(document_service.process_document(doc_id, organization_id))
    except Exception as e:
        logger.warning(f"Failed to auto-start pipeline: {e}")

    return UploadResponse(
        id=doc_id,
        title=doc_title,
        status="processing",
        message="Document uploaded and processing started.",
    )


@router.post(
    "/{document_id}/classify",
    summary="Classify document (OCR + Groq)",
    description="Run OCR and Groq classification. Returns type suggestion for user confirmation.",
)
async def classify_document(document_id: str, request: Request):
    org_id = request.query_params.get("organization_id")
    if not org_id:
        try:
            body = await request.json()
            org_id = body.get("organization_id") if isinstance(body, dict) else None
        except Exception:
            pass
    if not org_id:
        raise HTTPException(status_code=400, detail="organization_id is required")

    from ..services.orchestrator_service import orchestrator
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(None, orchestrator.classify_only, document_id, org_id)
    if "error" in result:
        raise HTTPException(status_code=500, detail=result["error"])
    return result


@router.get(
    "/{document_id}/file",
    summary="Download/serve uploaded file",
    description="Returns the original uploaded file for viewing or download",
)
async def get_document_file(document_id: str, organization_id: str = ""):
    doc = document_service.get_document(document_id, organization_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    file_path = doc.get("original_file_url", "")
    if not file_path:
        raise HTTPException(status_code=404, detail="File not found")
    if file_path.startswith("http"):
        return RedirectResponse(url=file_path)
    supabase_url = f"{settings.SUPABASE_URL}/storage/v1/object/public/documents/{file_path}"
    return RedirectResponse(url=supabase_url)


@router.post(
    "/{document_id}/process",
    response_model=ProcessResponse,
    summary="Process a document",
    description="Run OCR, classification, entity extraction, and indexing on a document",
)
async def process_document(document_id: str, request: Request):
    org_id = request.query_params.get("organization_id")
    if not org_id:
        try:
            body = await request.json()
            org_id = body.get("organization_id") if isinstance(body, dict) else None
        except Exception:
            pass
    if not org_id:
        raise HTTPException(status_code=400, detail="organization_id is required in query param or JSON body")

    # Skip if already processed or processing
    existing = document_service.get_document(document_id, org_id)
    if existing:
        if existing.get("status") in ("processed", "processing"):
            return ProcessResponse(
                document_id=document_id,
                status=existing.get("status", "processing"),
                classification={"document_type": existing.get("document_type", "unknown"), "confidence": 0},
                extraction={"extracted_data": {}, "confidence": 0},
            )

    result = await document_service.process_document_await(document_id, org_id)

    classification = result.get("classification")
    extraction = result.get("extraction")

    return ProcessResponse(
        document_id=result.get("document_id", document_id),
        status=result.get("status", "processing"),
        classification=classification if isinstance(classification, dict) else None,
        extraction=extraction if isinstance(extraction, dict) else None,
    )


@router.post(
    "/check-duplicate",
    summary="Check if document filename already exists",
    description="Returns the existing document if filename already uploaded for this org",
)
async def check_duplicate(organization_id: str = Form(...), filename: str = Form(...)):
    existing = document_service.list_documents(organization_id, search=filename)
    for d in existing:
        if d.get("title", "").lower() == filename.lower():
            return {"duplicate": True, "document": d}
    return {"duplicate": False, "document": None}


@router.get(
    "/{document_id}",
    summary="Get document details",
    description="Retrieve document metadata and status",
)
async def get_document(document_id: str, organization_id: str = ""):
    doc = document_service.get_document(document_id, organization_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return doc


class UpdateDocTypeRequest(BaseModel):
    document_type: str = Field(..., description="Document type (invoice, contract, etc.)")
    phase3_agent: str = Field("", description="Phase 3 agent to use for extraction")
    organization_id: str = Field(..., description="Tenant ID")


@router.patch(
    "/{document_id}",
    summary="Update document metadata",
    description="Update document type and phase3 agent for extraction",
)
async def update_document(document_id: str, body: UpdateDocTypeRequest):
    from ..database import SupabaseDB
    updates = {"document_type": body.document_type}
    if body.phase3_agent:
        updates["phase3_agent"] = body.phase3_agent
    SupabaseDB.update("documents", updates, "id", document_id)
    return {"id": document_id, "document_type": body.document_type, "phase3_agent": body.phase3_agent, "status": "updated"}


@router.get(
    "",
    response_model=DocumentListResponse,
    summary="List documents",
    description="List all documents for an organization. Use q to search by title.",
)
async def list_documents(organization_id: str = "", q: str = "", phase3_agent: str = "", limit: int = 50, offset: int = 0):
    docs = document_service.list_documents(organization_id, limit, offset, search=q, phase3_agent=phase3_agent)
    return DocumentListResponse(documents=docs, total=len(docs))


@router.get(
    "/{document_id}/job",
    summary="Get processing job status",
    description="Get the current processing job stage and status for a document",
)
async def get_job_status(document_id: str, organization_id: str = ""):
    from ..services.orchestrator_service import orchestrator
    job = orchestrator.get_or_create_job(document_id, organization_id)
    return job


@router.post(
    "/{document_id}/validate",
    summary="Run cross-document validation",
    description="Run all validations for this document against related documents",
)
async def validate_document(document_id: str, organization_id: str = ""):
    if not organization_id:
        raise HTTPException(status_code=400, detail="organization_id required")
    from ..services.validation_service import validation_service
    results = validation_service.run_all_validations(document_id, organization_id)
    return {"document_id": document_id, "validation_results": results}


@router.get(
    "/{document_id}/workflow",
    summary="Get workflow status",
    description="Get workflow/approval status for a document",
)
async def get_workflow(document_id: str, organization_id: str = ""):
    from ..services.workflow_service import workflow_service
    wf = workflow_service.get_workflow_status(document_id, organization_id)
    if not wf:
        raise HTTPException(status_code=404, detail="No workflow found for this document")
    return wf


@router.post(
    "/{document_id}/workflow/advance",
    summary="Advance workflow stage",
    description="Move the workflow to the next stage",
)
async def advance_workflow(document_id: str, organization_id: str = "", notes: str = ""):
    from ..services.workflow_service import workflow_service
    return workflow_service.advance_stage(document_id, organization_id, notes)


@router.post(
    "/{document_id}/workflow/approve",
    summary="Approve document in workflow",
    description="Approve the document at the current workflow stage",
)
async def approve_document(document_id: str, organization_id: str = "", approver: str = "", notes: str = ""):
    from ..services.workflow_service import workflow_service
    if not approver:
        raise HTTPException(status_code=400, detail="approver name required")
    return workflow_service.approve(document_id, organization_id, approver, notes)


@router.post(
    "/{document_id}/workflow/reject",
    summary="Reject document in workflow",
    description="Reject the document at the current workflow stage",
)
async def reject_document(document_id: str, organization_id: str = "", approver: str = "", reason: str = ""):
    from ..services.workflow_service import workflow_service
    if not approver or not reason:
        raise HTTPException(status_code=400, detail="approver and reason required")
    return workflow_service.reject(document_id, organization_id, approver, reason)


@router.get(
    "/validations/list",
    summary="List validation results",
    description="Get all validation results for an organization",
)
async def list_validations(organization_id: str = "", document_id: str = "", limit: int = 50):
    from ..database import SupabaseDB
    filters = {}
    if organization_id:
        filters["organization_id"] = organization_id
    if document_id:
        filters["source_document_id"] = document_id
    result = SupabaseDB.select("validation_results", filters=filters)
    data = getattr(result, "data", [])
    if not isinstance(data, list):
        data = []
    return {"validations": data[:limit], "total": len(data)}


@router.get(
    "/workflows/pending",
    summary="List pending approvals",
    description="Get all documents pending approval in workflows",
)
async def list_pending_approvals(organization_id: str = "", assigned_to: str = ""):
    from ..services.workflow_service import workflow_service
    pending = workflow_service.list_pending_approvals(organization_id, assigned_to or None)
    return {"pending_approvals": pending, "total": len(pending)}


@router.delete(
    "/{document_id}",
    status_code=status.HTTP_200_OK,
    summary="Delete a document",
    description="Delete document and all associated data",
)
async def delete_document(document_id: str, organization_id: str = ""):
    return document_service.delete_document(document_id, organization_id)


@router.get(
    "/image/{path:path}",
    summary="Serve extracted image file",
    description="Returns an image file from the uploads/images directory",
)
async def serve_image(path: str):
    from fastapi.responses import FileResponse
    full_path = os.path.join(settings.UPLOAD_DIR, path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(full_path, media_type="image/jpeg")


@router.get(
    "/{document_id}/images",
    summary="Get detected images with descriptions",
    description="Return images extracted from the document with their Vision-generated descriptions",
)
async def get_document_images(document_id: str, organization_id: str = ""):
    result = SupabaseDB.select("document_extractions", filters={
        "document_id": document_id,
        "organization_id": organization_id,
        "extraction_type": "image_extraction",
    })
    data = getattr(result, "data", result if isinstance(result, list) else [])
    images = []
    if isinstance(data, list) and data:
        extracted = data[0].get("extracted_data", {})
        images = extracted.get("images", [])
    desc_url = f"/api/v1/documents/image/images/{document_id}/descriptions.txt" if images else ""
    return {"images": images, "descriptions_file": desc_url}


@router.post(
    "/classify-text",
    summary="Classify document text",
    description="Classify document text into invoice, contract, PO, etc. using Groq AI",
)
async def classify_text(request: ClassifyTextRequest = Body(...)):
    from ..services.classification_service import classification_service
    result = classification_service.classify(request.text, request.filename)
    return result


@router.post(
    "/reindex-all",
    summary="Re-index all documents with current RAG logic",
    description="Delete existing chunks/embeddings and re-index every document using the latest heading detection and chunking.",
)
async def reindex_all():
    from ..services.rag_service import rag_service as rag
    from ..database import _get_supabase
    from ..services.pinecone_service import pinecone_service

    print("\n" + "="*70)
    print("[REINDEX] Starting full re-index of all documents...")
    print("="*70)

    client = _get_supabase()
    if not client:
        raise HTTPException(status_code=500, detail="Supabase client unavailable")
    res = client.table("documents").select(
        "id, organization_id, raw_text, document_type, status"
    ).execute()
    docs = getattr(res, "data", []) or []
    print(f"[REINDEX] Found {len(docs)} documents in DB")

    results = {"total": len(docs), "reindexed": 0, "skipped": 0, "errors": []}

    for d in docs:
        doc_id = d.get("id")
        org_id = d.get("organization_id")
        raw_text = d.get("raw_text") or ""
        doc_type = d.get("document_type")
        if not doc_id or not org_id or not raw_text.strip():
            results["skipped"] += 1
            print(f"[REINDEX] SKIP doc={doc_id} (no org/raw_text)")
            continue

        print(f"\n[REINDEX] ({results['reindexed'] + 1}/{len(docs)}) doc={doc_id[:12]} type={doc_type} chars={len(raw_text)}")

        try:
            # Delete old chunks
            if pinecone_service.available:
                try:
                    pinecone_service.delete_by_document(doc_id, namespace=org_id)
                except Exception as e:
                    print(f"  [WARN] Pinecone delete: {e}")
            client.table("document_chunks").delete().eq("document_id", doc_id).execute()
            client.table("document_embeddings").delete().eq("document_id", doc_id).execute()

            # Re-index with current logic
            rag.index_document(
                doc_id, org_id, raw_text, None,
                document_type=doc_type,
            )
            results["reindexed"] += 1
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"  [ERROR] {e}\n{tb}")
            results["errors"].append({"doc_id": doc_id, "error": str(e)})
            results["skipped"] += 1

    print(f"\n[REINDEX] DONE: {results['reindexed']} reindexed, {results['skipped']} skipped, {len(results['errors'])} errors")
    return results



