import time
from .conversation_service import conversation_service
from .rag_service import rag_service
from .document_service import document_service
from ..database import SupabaseDB
from .orchestration_logger import get_chat_logger, C
from .agent_orchestrator import _load_phase3_prompt, _load_prompt, DOCUMENT_TO_PHASE3_AGENT, PHASE3_AGENT_PROMPT_MAP

_RESUME_KEYWORDS = ["resume", "cv ", "candidate", "applicant", "hiring", "recruit",
                    "top.*resume", "best.*candidate", "rank.*resume", "score.*resume",
                    "sorted.*resume", "highest.*score", "top.*candidate",
                    "give me.*top", "list.*resume", "show.*candidate", "list.*candidate",
                    "top.*resume", "recommend.*candidate", "best.*fit"]

_AGGREGATE_KEYWORDS = [r"\bsum\b", r"\btotal\b", r"\baggregate\b", r"\bcombine\b",
                       r"\boverall\b", r"\bgrand total\b", r"\ball\b.*\btotal\b",
                       r"\btotal\b.*\ball\b", r"\badd up\b", r"\bsum up\b",
                       r"\baccumulated\b", r"\bcombined\b", r"\btogether\b"]

# ── Cross-document search triggers ──
# When query matches these (or no doc is selected), switch from hybrid_search
# to aggregate_search so every document contributes at least 1 chunk.
_CROSS_DOC_PHRASES = [
    "saare numbers", "sab numbers", "all numbers", "har file",
    "saari files", "sari files", "all files", "sab files",
    "har document", "all documents", "saare documents",
    "saare phone", "sab phone", "all phone",
    "every file", "every document", "all data",
    "all info", "saari information", "sari information",
    "har ek", "each file", "each document",
]
_CROSS_DOC_WORDS = [
    "saare", "saari", "sari", "sab", "har", "tamam",
]
_CROSS_DOC_DROP = {
    "a", "an", "the", "is", "are", "was", "were",
    "in", "on", "at", "to", "for", "of", "with", "by",
    "mai", "mein", "say", "se", "laa", "kr", "kar", "par",
}

# ── Field extraction patterns ──
# These detect and extract specific field values from chunk text, allowing
# cross-doc field queries (e.g. "saare numbers") to build a compact summary
# instead of feeding all chunks to the LLM.  This is faster and avoids the
# 413 "Request too large" error because the summary is tiny (a few KB).
import re

_FIELD_PATTERNS = {
    "phone": {
        "triggers": {"phone", "phones", "number", "numbers", "contact", "mobile", "cell", "telephone", "phone number", "phone numbers", "contact number"},
        "regex": re.compile(r'(?:\+?92|0)[.\- ]?[0-9]{2,3}[.\- ]?[0-9]{3,4}[.\- ]?[0-9]{3,4}(?:x\d+)?|0[.\- ]?3[0-9]{2}[.\- ]?[0-9]{3,4}[.\- ]?[0-9]{3,4}'),
        "label": "Phone",
    },
    "email": {
        "triggers": {"email", "emails", "e-mail", "mail", "contact"},
        "regex": re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'),
        "label": "Email",
    },
    "amount": {
        "triggers": {"amount", "amounts", "total", "totals", "sum", "price", "prices", "cost", "costs", "value", "values", "figure", "figures", "number", "numbers", "rate", "rates", "fee", "fees", "payment", "payments", "subtotal", "grand total", "tax", "vat", "gst", "raqam", "paisa"},
        "regex": re.compile(r'(?:PKR|Rs\.?|USD|\$|EUR|£)[.\- ]?[0-9,]+(?:\.[0-9]{2,})?|[0-9,]+(?:\.[0-9]{2,})?\s*(?:PKR|Rs\.?|USD|\$|EUR|£)|[0-9,]+(?:\.[0-9]{2,})?'),
        "label": "Amount",
    },
    "date": {
        "triggers": {"date", "dates", "day", "days", "month", "year", "years", "time", "deadline", "due date", "invoice date", "created", "created at", "dob", "birth date"},
        "regex": re.compile(r'\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2}|[A-Z][a-z]{2,}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Z][a-z]{2,}\s+\d{4}'),
        "label": "Date",
    },
}


class ChatService:
    def _get_or_create_session(self, session_id: str, organization_id: str, document_ids: list = None) -> tuple[str, list, bool]:
        is_first = True
        if session_id:
            existing = SupabaseDB.get_chat_session(session_id)
            if existing:
                stored_ids = existing.get("document_ids") or []
                messages = existing.get("messages") or []
                is_first = len(messages) == 0
                if messages:
                    conversation_service.load_history_from_db(session_id, messages)
                resolved = document_ids if document_ids is not None else stored_ids
                if document_ids is not None and set(document_ids) != set(stored_ids):
                    SupabaseDB.update_chat_session_doc_ids(session_id, document_ids)
                return session_id, resolved, is_first
        doc_list = document_ids or []
        new_id = SupabaseDB.create_chat_session(organization_id, "New Chat", doc_list)
        return new_id, doc_list, True

    def _auto_title(self, session_id: str, first_question: str):
        title = first_question[:80].strip()
        if len(title) == 80:
            title = title[:77] + "..."
        SupabaseDB.update_chat_session_title(session_id, title)

    def _save_exchange(self, session_id: str, question: str, answer: str, sources: list, is_first: bool):
        SupabaseDB.save_chat_message(session_id, "user", question)
        SupabaseDB.save_chat_message(session_id, "assistant", answer, sources)
        if is_first:
            self._auto_title(session_id, question)

    def _fetch_raw_text(self, document_ids: list, organization_id: str,
                        max_chars: int = 28000, titles: list = None) -> str:
        """Fetch raw_text (full document text) for selected docs. Critical for Excel/table docs
        where chunks may be missing or extraction truncates data."""
        if not document_ids:
            return ""
        try:
            unique_ids = set(document_ids)
            title_set = set((t or "").lower().strip() for t in (titles or []))
            result = SupabaseDB.select("documents",
                columns="id, title, document_type, raw_text",
                filters={"organization_id": organization_id},
                limit=200,
            )
            data = getattr(result, "data", result if isinstance(result, list) else [])
            parts = []
            total = 0
            matched_any = False
            for row in (data or []):
                raw = row.get("raw_text") or ""
                if not raw:
                    continue
                doc_id = row.get("id", "")
                doc_title = (row.get("title") or "").lower().strip()
                # Match by ID or by title
                id_match = doc_id in unique_ids
                title_match = doc_title in title_set if title_set else False
                if not id_match and not title_match:
                    continue
                matched_any = True
                display = row.get("title") or doc_id
                remaining = max_chars - total
                if remaining <= 0:
                    break
                truncated = raw[:remaining]
                parts.append(f"[Document: {display} (Full Source Text)]:\n{truncated}")
                total += len(truncated)
            # Fallback: if no match by ID or title, include ALL org docs with raw_text
            # This handles ID mismatches between local/remote databases
            if not matched_any:
                for row in (data or []):
                    raw = row.get("raw_text") or ""
                    if not raw:
                        continue
                    display = row.get("title") or row.get("id", "")
                    remaining = max_chars - total
                    if remaining <= 0:
                        break
                    truncated = raw[:remaining]
                    parts.append(f"[Document: {display} (Full Source Text)]:\n{truncated}")
                    total += len(truncated)
            return "\n\n".join(parts) if parts else ""
        except Exception:
            return ""

    def _fetch_extraction_summary(self, document_ids: list, organization_id: str) -> str:
        if not document_ids:
            return ""
        try:
            import json
            from ..database import _get_supabase, _use_supabase, _local_select_in
            unique_ids = list(set(document_ids))
            client = _get_supabase()
            if _use_supabase and client:
                r = client.table("document_extractions") \
                    .select("document_id, extraction_type, extracted_data, confidence") \
                    .in_("document_id", unique_ids) \
                    .eq("organization_id", organization_id) \
                    .execute()
                rows = getattr(r, "data", [])
            else:
                rows = _local_select_in("document_extractions",
                    columns="document_id, extraction_type, extracted_data, confidence",
                    filters={"organization_id": organization_id},
                    in_column="document_id", in_values=unique_ids)
            if not rows:
                return ""

            doc_info = {}
            try:
                title_result = SupabaseDB.select("documents",
                    columns="id, title",
                    filters={"organization_id": organization_id},
                )
                title_data = getattr(title_result, "data", title_result if isinstance(title_result, list) else [])
                for row in title_data:
                    doc_info[row["id"]] = row.get("title", "")
            except Exception:
                pass

            lines = ["[Structured Document Data for Aggregation]"]
            totals = {}
            parsed_count = 0

            # Group extractions by document_id, merging image data into main extraction
            doc_extractions = {}
            for row in rows:
                did = row.get("document_id", "")
                ext_type = row.get("extraction_type", "")
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        continue
                else:
                    parsed = raw or {}
                if not isinstance(parsed, dict):
                    continue

                if did not in doc_extractions:
                    doc_extractions[did] = {"type": ext_type, "data": {}}
                if ext_type == "image_extraction":
                    doc_extractions[did]["has_images"] = True
                    doc_extractions[did]["images"] = parsed.get("images", [])
                else:
                    doc_extractions[did]["type"] = ext_type
                    doc_extractions[did]["data"].update(parsed)

            for did, ext_info in doc_extractions.items():
                parsed = ext_info["data"]
                title = doc_info.get(did, did)
                lines.append(f"\n  Document: {title}  (id: {did})")
                lines.append(f"  Type: {ext_info['type']}")

                for key, val in parsed.items():
                    if key.startswith("_"):
                        continue
                    array_keys = {"findings", "deviations", "corrective_actions", "observations", "recommendations"}
                    if isinstance(val, list) and val and key in array_keys:
                        lines.append(f"    {key}:")
                        for i, item in enumerate(val, 1):
                            lines.append(f"      {i}. {item}")
                    elif isinstance(val, list) and val and key in ("line_items", "items"):
                        lines.append(f"    {key}:")
                        for item in val[:200]:
                            if isinstance(item, dict):
                                parts = []
                                for field in ("description", "quantity", "unit_price", "price", "total", "amount",
                                              "vendor_name", "vendor_city", "client_name", "client_city",
                                              "invoice_no", "order_date", "delivery_date", "category",
                                              "payment_mode", "status"):
                                    if item.get(field) not in (None, "", []):
                                        parts.append(f"{field}={item.get(field)}")
                                if parts:
                                    lines.append(f"      - " + ", ".join(parts))
                            else:
                                lines.append(f"      - {item}")
                    elif isinstance(val, str) and val:
                        lines.append(f"    {key}: {val}")
                    elif isinstance(val, (int, float)):
                        lines.append(f"    {key}: {val}")
                        totals[key] = totals.get(key, 0) + val

                if ext_info.get("has_images"):
                    img_count = len(ext_info.get("images", []))
                    lines.append(f"    images: {img_count} image(s) with vision descriptions in document context")
                parsed_count += 1

            if parsed_count > 1 and totals:
                lines.append("\n  --- Aggregated Totals ---")
                for key, val in sorted(totals.items()):
                    lines.append(f"    Sum of {key}: {val}")

            result = "\n".join(lines)
            return result
        except Exception as e:
            chat_log = get_chat_logger()
            chat_log.warn(f"Extraction summary error: {e}")
            return ""

    # Keyword → agent intent map for query-type detection (used when no doc is selected)
    _AGENT_INTENT_KEYWORDS = {
        "hr_agent": ["resume", "cv", "candidate", "candidates", "applicant", "applicants",
                     "hiring", "recruit", "recruitment", "experience", "skill", "skills",
                     "qualification", "interview", "employee"],
        "finance_agent": ["invoice", "inv", "payment", "due date", "vendor", "supplier",
                          "seller", "tax", "vat", "gst", "subtotal", "line item", "line items",
                          "amount due", "bill to", "ship to", "purchase order", "po", "total amount",
                          "رقم", "انوائس", "بل", "ٹوٹل", "وصولی"],
        "procurement_agent": ["rfq", "quotation", "quote", "suggestive", "required language",
                        "bid", "tender", "proposal", "procurement", "request for quotation",
                        "رقم", "کوٹیشن", "درخواست"],
        "legal_agent": ["contract", "agreement", "clause", "liability", "terms and conditions",
                        "legal", "party", "indemnity", "jurisdiction", "معاہدہ", "قانون"],
        "compliance_agent": ["audit", "audit report", "finding", "findings", "corrective action",
                             "compliance", "non-compliance", "non compliance", "sop", "procedure",
                             "certificate", "certification", "quality report", "qc", "maintenance",
                             "inspection", "safety", "regulatory", "standard operating",
                             "deviation", "pass fail", "آڈٹ", "سرٹیفکیٹ", "کوالٹی", "مرمت",
                             "حفاظت", "طریقہ کار", "تعمیل", "خلاف ورزی", "معائنہ"],
    }

    # Keyword → document_type map for query-type detection (org-wide chat).
    # If the user's question contains one of these (EN or UR), retrieval is
    # restricted to documents of that type; if none match, all docs are searched.
    KEYWORD_TO_DOC_TYPE = {
        "invoice": ["invoice", "inv ", "inv.", "bill", "انوائس", "بل", "رسید"],
        "purchase_order": ["purchase order", "po ", "p.o.", "خریداری", "خریداری آرڈر"],
        "quotation": ["quotation", "quote", "rfq", "request for quotation", "کوٹیشن", "درخواست"],
        "contract": ["contract", "agreement", "معاہدہ", "قانون", "شرط"],
        "resume": ["resume", "cv", "c.v.", "bio data", "بائیو ڈیٹا", "ریزیومہ", "امیدوار"],
        "transcript": ["transcript", "نتیجہ", "رزلٹ", "transcripts"],
        "hr_document": ["hr document", "employee record", "ملازم", "اسناد ملازمین"],
        "certificate": ["certificate", "سرٹیفکیٹ", "سند"],
        "audit_report": ["audit", "audit report", "آڈٹ", "آڈٹ رپورٹ"],
        "quality_report": ["quality report", "کوالٹی", "معیاری رپورٹ"],
        "maintenance_report": ["maintenance report", "دیکھ بھال", "مرمت"],
        "sop": ["sop", "standard operating", "ایس او پی", "ایسوپی"],
        "engineering_drawing": ["engineering drawing", "نقشہ", "ڈرائنگ", "انجینئرنگ ڈرائنگ"],
        "financial_statement": ["financial statement", "balance sheet", "پروفٹ", "مالیاتی بیان"],
        "other": ["other", "general", "عام", "general document"],
    }

    # Agent → retrieval-context anchor. Prepended (bilingual EN+UR) to the SEARCH
    # query only (never to the model-facing question) so vector/keyword retrieval
    # is steered toward the right domain vocabulary even when the user's wording or
    # the document text lacks the agent's exact keywords. Purely additive — does not
    # change routing, prompts, or existing behaviour.
    AGENT_CONTEXT_ANCHORS = {
        "finance_agent": "invoice financial document: invoice number, vendor, customer, subtotal, tax, total amount, due date, line items, payment terms | انوائس بل وصولی ٹوٹل رقم",
        "hr_agent": "HR document: employee, resume, CV, candidate, salary, leave, appraisal, designation, department | ملازم ریزیومہ تنخواہ چھٹی تقرری",
        "legal_agent": "legal document: contract, agreement, party, clause, indemnity, jurisdiction, liability, term | معاہدہ قانون شرط فریق",
        "compliance_agent": "compliance document: audit report, SOP, certificate, quality report, maintenance report, engineering drawing, finding, deviation, corrective action, pass/fail, standard, non-conformance, inspection, safety | آڈٹ رپورٹ سرٹیفکیٹ کوالٹی رپورٹ مرمت رپورٹ خلاف ورزی ایس او پی معائنہ حفاظت",
        "procurement_agent": "procurement document: purchase order, quotation, RFQ, supplier, vendor, delivery note, line items, total amount | خریداری آرڈر کوٹیشن سپلائر وینڈر بل",
        "other_agent": "general document: summary, key points, parties, dates, references",
    }

    def _detect_query_agent(self, query: str) -> str | None:
        """Detect the most likely document agent from query keywords.

        Returns the agent name when intent is clear, or None when no/ambiguous intent
        (so the caller can fall back to a generic Q&A agent).
        """
        q = (query or "").lower()
        if not q:
            return None
        scores = {}
        for agent, kws in self._AGENT_INTENT_KEYWORDS.items():
            hits = sum(1 for kw in kws if kw in q)
            if hits:
                scores[agent] = hits
        if not scores:
            return None
        # Only commit if a single intent clearly dominates (no tie)
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            return None
        return ranked[0][0]

    def detect_doc_type_keyword(self, query: str) -> str | None:
        """Detect a document_type from query keywords (bilingual EN+UR).

        Used for org-wide chat: if the user's question mentions a type (e.g.
        'invoice', 'quotation', 'ریزیومہ'), retrieval is restricted to documents
        of that type. Returns the best-matching document_type, or None when no
        keyword matches (or multiple types tie) so the caller searches all docs.
        """
        q = (query or "").lower()
        if not q:
            return None
        scores = {}
        for doc_type, kws in self.KEYWORD_TO_DOC_TYPE.items():
            hits = sum(1 for kw in kws if kw in q)
            if hits:
                scores[doc_type] = hits
        if not scores:
            return None
        ranked = sorted(scores.items(), key=lambda x: -x[1])
        # Tie between the top two types → ambiguous → search all docs
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            return None
        return ranked[0][0]

    def _detect_field_type(self, query: str) -> str | None:
        """Return the field type (phone/email/amount/date) if the query asks for
        specific field values, or None for general questions."""
        q = query.lower().strip()
        # Weighted scoring: direct trigger matches + overall relevance
        best_field = None
        best_score = 0
        for field, cfg in _FIELD_PATTERNS.items():
            score = sum(1 for t in cfg["triggers"] if t in q) * 2
            # Boost if the word is the main subject (near start of query)
            for t in cfg["triggers"]:
                if q.startswith(t) or q.endswith(t) or f" {t} " in f" {q} ":
                    score += 1
            if score > best_score:
                best_score = score
                best_field = field
        return best_field if best_score >= 2 else None

    def _is_ambiguous(self, query: str) -> bool:
        """Heuristic check: is the user's question too vague to answer directly?
        Ambiguous queries (e.g. 'data do', 'ye file mein kya hai') benefit from
        counter-questions; specific queries ('invoice total kitna hai') do not."""
        q = (query or "").lower().strip()
        if not q:
            return True
        words = [w for w in re.split(r"[^a-z0-9\u0600-\u06ff]+", q) if w]
        if len(words) <= 2:
            return True
        # Generic / filler words that carry no specific intent
        generic = {
            "data", "do", "day", "dijiye", "de", "dein", "den", "batao", "bataye",
            "dikhaiye", "dikhao", "file", "files", "document", "documents", "info",
            "information", "kya", "kyaa", "what", "show", "show me", "give", "get",
            "this", "that", "these", "those", "ye", "wo", "woh", "in", "the", "a",
            "an", "some", "all", "sab", "saare", "sari", "har", "kuch", "koi",
            "mere", "meri", "apna", "contents", "content", "details", "detail",
            "summary", "bataye", "hai", "hain", "ka", "ki", "ke", "ko", "se",
            "par", "aur", "bhi", "to", "is", "us", "kay", "ky", "ne", "pe",
            "say", "laa", "kr", "kar", "mein", "main", "mai", "k", "of", "for",
            "on", "at", "with", "from", "by", "as", "i", "you", "we", "they",
            "it", "me", "my", "your", "our", "their",
        }
        specific = {
            "invoice", "resume", "cv", "contract", "rfq", "quotation", "quote",
            "po", "purchase", "agreement", "phone", "number", "numbers", "email",
            "amount", "total", "date", "name", "names", "price", "tax", "vendor",
            "customer", "employee", "candidate", "skill", "skills", "education",
            "experience", "salary", "payment", "due", "gst", "vat",
        }
        has_specific = any(w in specific for w in words)
        non_generic = [w for w in words if w not in generic]
        # Ambiguous if: no specific entity word AND mostly filler words
        if not has_specific and len(non_generic) == 0:
            return True
        if not has_specific and len(non_generic) <= 1:
            return True
        return False

    def _filename_from_url(self, url: str) -> str:
        """Extract filename from a URL/path like 'path/to/file.pdf' → 'file.pdf'."""
        if not url:
            return ""
        # Handle both forward slashes (URLs) and backslashes (Windows paths)
        sep = "\\" if "\\" in url else "/"
        name = url.rstrip("/\\").split(sep)[-1]
        # Decode URL-encoded characters (%20 → space, etc.)
        if "%" in name:
            try:
                from urllib.parse import unquote
                name = unquote(name)
            except Exception:
                pass
        return name

    def _build_field_summary(self, chunks: list[dict], field_type: str,
                             name_map: dict = None) -> str:
        """From a list of chunks, extract field values via regex for the given
        field type and build a compact text summary.  Falls back to a simple
        listing when extraction yields nothing."""
        cfg = _FIELD_PATTERNS.get(field_type)
        if not cfg:
            return ""
        lines = [f"[Extracted {cfg['label']} values from documents]"]
        found_any = False
        for i, r in enumerate(chunks):
            text = r.get("chunk_text", "")
            raw = r.get("document_title", f"Document {i+1}")
            display = (name_map or {}).get(r.get("document_id", ""), raw)
            matches = cfg["regex"].findall(text)
            if matches:
                found_any = True
                vals = ", ".join(set(m.strip() for m in matches[:3]))
                lines.append(f"  [Document: {display}]: {vals}")
            else:
                lines.append(f"  [Document: {display}]: (none found)")
        if not found_any:
            # No regex matches – fall back to showing raw text snippets from each doc
            lines = [f"[{cfg['label']} - raw snippets from each document]"]
            for i, r in enumerate(chunks):
                text = r.get("chunk_text", "")[:200].strip()
                raw = r.get("document_title", f"Document {i+1}")
                display = (name_map or {}).get(r.get("document_id", ""), raw)
                if text:
                    lines.append(f"  [Document: {display}]: {text}")
                else:
                    lines.append(f"  [Document: {display}]: (empty)")
        return "\n".join(lines)

    def _fetch_resume_details(self, doc_ids: list[str], organization_id: str) -> dict[str, dict]:
        """Batch-fetch the full extracted_data for resume documents.
        Returns {doc_id: {skills, total_experience_years, education, certifications,
                          cv_evaluation{overall_score, strengths, recommendation, ...}}}."""
        if not doc_ids:
            return {}
        try:
            import json
            from ..database import _get_supabase, _use_supabase, _local_select_in
            unique_ids = list(set(doc_ids))
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
            result = {}
            for row in rows:
                raw = row.get("extracted_data", "{}")
                if isinstance(raw, str):
                    try:
                        parsed = json.loads(raw)
                    except Exception:
                        continue
                else:
                    parsed = raw or {}
                did = row.get("document_id", "")
                if not did:
                    continue
                detail = {}
                skills = parsed.get("skills")
                if skills and isinstance(skills, list):
                    detail["skills"] = skills
                exp_y = parsed.get("total_experience_years")
                if exp_y is not None:
                    detail["total_experience_years"] = exp_y
                edu = parsed.get("education")
                if edu and isinstance(edu, list):
                    detail["education"] = edu
                certs = parsed.get("certifications")
                if certs and isinstance(certs, list):
                    detail["certifications"] = certs
                ev = parsed.get("cv_evaluation") or {}
                cv_d = {}
                for k in ("overall_score", "strengths", "recommendation",
                          "evaluation_summary", "skills_score",
                          "experience_score", "education_score"):
                    v = ev.get(k)
                    if v is not None:
                        cv_d[k] = v
                if cv_d:
                    detail["cv_evaluation"] = cv_d
                if detail:
                    result[did] = detail
            return result
        except Exception:
            return {}

    def _build_resume_details_block(self, resumes: list[dict],
                                     details: dict[str, dict]) -> str:
        """Build a compact [Resume Details] block with skills, experience, education, etc."""
        if not details:
            return ""
        lines = ["[Resume Details]"]
        for r in resumes:
            did = r["id"]
            d = details.get(did)
            if not d:
                continue
            title = r.get("title") or r.get("original_filename") or did[:8]
            parts = [f"  {title}"]
            cv_ev = d.get("cv_evaluation") or {}
            score = cv_ev.get("overall_score")
            if score is not None:
                parts.append(f"Score: {score}/100")
            skills = d.get("skills")
            if skills:
                parts.append(f"Skills: {', '.join(skills[:8])}")
            exp_y = d.get("total_experience_years")
            if exp_y is not None:
                parts.append(f"Exp: {exp_y}yrs")
            edu = d.get("education")
            if edu:
                degs = []
                for e in edu[:2]:
                    deg = e.get("degree", "")
                    inst = e.get("institution", "")
                    if deg and inst:
                        degs.append(f"{deg} - {inst}")
                    elif deg:
                        degs.append(deg)
                    elif inst:
                        degs.append(inst)
                if degs:
                    parts.append(f"Education: {' | '.join(degs)}")
            certs = d.get("certifications")
            if certs:
                parts.append(f"Certs: {', '.join(certs[:3])}")
            strengths = cv_ev.get("strengths")
            if strengths:
                parts.append(f"Strengths: {' | '.join(strengths[:3])}")
            lines.append("  " + " — ".join(parts))
        if len(lines) > 1:
            return "\n".join(lines)
        return ""

    def chat_with_document(self, question: str, document_ids: list, organization_id: str,
                           document_type: str = None, phase3_agent: str = None,
                           status: str = None, date_from: str = None, date_to: str = None,
                           chat_history: list[dict] = None, session_id: str = None,
                           selected_text: str = None) -> dict:
        chat_log = get_chat_logger()
        chat_log.chat_start(question, session_id=session_id or "", doc_count=len(document_ids or []))
        t_start = time.time()

        sid, resolved_ids, is_first = self._get_or_create_session(session_id, organization_id, document_ids)

        # ── Focused Q&A on a selected excerpt (ChatGPT-style "ask about this") ──
        # If the user highlighted part of a previous response and asked about it,
        # ground the answer STRICTLY on that excerpt — no document retrieval. This
        # keeps the answer tightly scoped to exactly what the user pointed at.
        if selected_text and selected_text.strip():
            return self._answer_on_excerpt(
                question=question, selected_text=selected_text.strip(),
                organization_id=organization_id, sid=sid, is_first=is_first,
            )

        # ── Agent-context anchoring for retrieval (additive) ──
        # Anchor the search query to the document's agent so retrieval works even
        # when the user's wording (or the document text) lacks the agent's keywords
        # (e.g. a Purchase Order that never says "quotation"). Only the retrieval
        # query is augmented; the model still sees the original question.
        anchor_agent = None
        if resolved_ids:
            try:
                doc_result = SupabaseDB.select("documents",
                    columns="id, document_type, phase3_agent",
                    filters={"organization_id": organization_id},
                )
                doc_data = getattr(doc_result, "data", doc_result if isinstance(doc_result, list) else [])
                resolved_set = set(resolved_ids)
                _agent_counts = {}
                for d in doc_data:
                    if d.get("id") in resolved_set:
                        p3a = d.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(d.get("document_type", ""), "other_agent")
                        if p3a:
                            _agent_counts[p3a] = _agent_counts.get(p3a, 0) + 1
                if _agent_counts:
                    anchor_agent = max(_agent_counts, key=_agent_counts.get)
            except Exception:
                pass
        if not anchor_agent:
            anchor_agent = self._detect_query_agent(question)

        search_query = question
        if anchor_agent and anchor_agent in self.AGENT_CONTEXT_ANCHORS:
            search_query = f"{question} | {self.AGENT_CONTEXT_ANCHORS[anchor_agent]}"

        # ── Keyword → document_type filter (org-wide chat only) ──
        # If the question mentions a document type (e.g. 'invoice', 'quotation',
        # 'ریزیومہ'), restrict retrieval to those files. Only applied when no
        # specific document is selected (org-wide) and nothing explicit was passed;
        # if no keyword matches, document_type stays None → search all docs.
        detected_doc_type = self.detect_doc_type_keyword(question)
        apply_type_filter = bool(detected_doc_type) and not resolved_ids and not document_type
        if apply_type_filter:
            document_type = detected_doc_type

        hybrid_kwargs = dict(
            query=search_query,
            organization_id=organization_id,
            document_type=document_type,
            phase3_agent=phase3_agent,
            status=status,
            date_from=date_from,
            date_to=date_to,
            document_ids=resolved_ids if resolved_ids else None,
            limit=50,
        )

        # ── Cross-document intent detection ──
        # When no doc is selected, or query asks for all/saare/sab/har files,
        # switch to aggregate_search so every doc contributes ≥1 chunk.
        q_lower = question.lower().strip()
        is_cross_doc = not resolved_ids  # no doc selected → search all visible
        if not is_cross_doc and len(q_lower.split()) <= 12:
            for phrase in _CROSS_DOC_PHRASES:
                if phrase in q_lower:
                    is_cross_doc = True
                    break
            if not is_cross_doc:
                words = [w for w in q_lower.split() if w not in _CROSS_DOC_DROP and len(w) >= 2]
                if any(w in _CROSS_DOC_WORDS for w in words):
                    is_cross_doc = True

        type_ids = []
        if is_cross_doc:
            chat_log.info(f"Cross-doc intent detected — using aggregate_search")
            target_ids = resolved_ids
            if apply_type_filter:
                try:
                    type_res = SupabaseDB.select(
                        "documents", columns="id",
                        filters={"organization_id": organization_id, "document_type": detected_doc_type},
                    )
                    type_rows = getattr(type_res, "data", type_res if isinstance(type_res, list) else [])
                    type_ids = [r["id"] for r in type_rows if isinstance(r, dict)]
                    if type_ids:
                        target_ids = type_ids
                        chat_log.info(f"Keyword '{detected_doc_type}' → restricting cross-doc search to {len(type_ids)} docs")
                except Exception:
                    pass
            search_results = rag_service.aggregate_search(
                query=search_query,
                organization_id=organization_id,
                document_ids=target_ids if target_ids else None,
                max_docs=150,
            )
            # Keyword matched but that type has no (matching) docs → retry across
            # ALL org docs so the user still gets an answer from other files.
            if not search_results and apply_type_filter:
                chat_log.warn(f"No results for type '{detected_doc_type}' — retrying across all docs")
                search_results = rag_service.aggregate_search(
                    query=search_query,
                    organization_id=organization_id,
                    document_ids=resolved_ids if resolved_ids else None,
                    max_docs=150,
                )
        else:
            search_results = rag_service.hybrid_search(**hybrid_kwargs)

        # Documents to pull the structured extraction summary from: a selected
        # doc takes priority; otherwise, when a keyword type filter is active
        # (org-wide chat), use the matched-type documents so aggregate/finance
        # questions see authoritative totals (mirrors single-doc behaviour).
        extraction_doc_ids = resolved_ids if resolved_ids else (type_ids if (apply_type_filter and type_ids) else None)

        # ── Field-type detection (phone, email, amount, date) ──
        # When the query asks for specific field values from all docs, build a
        # compact regex-based summary instead of feeding full chunk text to the
        # LLM.  This is faster, avoids 413 errors, and is more accurate.
        field_type = self._detect_field_type(question) if search_results and is_cross_doc else None

        q_lower = question.lower()
        is_resume_query = any(
            __import__("re").search(kw, q_lower) for kw in _RESUME_KEYWORDS
        )
        is_finance_query = (
            document_type == "invoice"
            or phase3_agent == "finance_agent"
            or any(term in q_lower for term in [
                "invoice", "subtotal", "amount due", "grand total", "due date",
                "payment terms", "vendor", "customer", "bill to", "ship to",
                "tax", "vat", "gst", "line item", "line items", "invoice number",
            ])
        )

        if not search_results and not is_resume_query and document_type:
            chat_log.warn(f"No results with document_type={document_type} — retrying without type filter")
            retry_kwargs = {k: v for k, v in hybrid_kwargs.items() if k != "document_type"}
            search_results = rag_service.hybrid_search(**retry_kwargs)

        if not search_results:
            # ── Fallback: when a specific doc is selected but search found nothing,
            # fetch any available chunks from the selected doc directly.
            if resolved_ids:
                try:
                    fb_results = rag_service._fetch_any_chunks(resolved_ids, organization_id, limit_per_doc=3)
                    if fb_results:
                        search_results = fb_results
                        chat_log.info(f"Fallback chunks: {len(search_results)} for {len(resolved_ids)} docs")
                except Exception:
                    pass

        if not search_results:
            resumes = []
            if is_resume_query:
                try:
                    resumes = document_service.list_documents(organization_id)
                    if resolved_ids:
                        resolved_set = set(resolved_ids)
                        resumes = [r for r in resumes if r["id"] in resolved_set]
                    document_service._batch_attach_extractions(resumes, organization_id)
                    resumes = [r for r in resumes if r.get("cv_score") is not None]
                    resumes.sort(key=lambda x: x.get("cv_score", 0) or 0, reverse=True)
                except Exception:
                    resumes = []

            resume_context = ""
            resume_sources = []
            if resumes:
                lines = ["[Resume Rankings (sorted by CV evaluation score)]"]
                for i, r in enumerate(resumes[:20], 1):
                    score_str = f"{r['cv_score']}/100" if r["cv_score"] is not None else "N/A"
                    lines.append(f"{i}. {r['title']} — {score_str}")
                    resume_sources.append({
                        "document_id": r["id"],
                        "document_title": r["title"],
                        "cv_score": r.get("cv_score"),
                        "score": r.get("cv_score", 0) / 100.0,
                    })
                resume_context = "\n".join(lines)
                res_doc_ids = [r["id"] for r in resumes if r.get("id")]
                res_details = self._fetch_resume_details(res_doc_ids, organization_id)
                if res_details:
                    details_block = self._build_resume_details_block(resumes, res_details)
                    if details_block:
                        resume_context = resume_context + "\n\n" + details_block

            # ── Finance/table data fallback: extraction + raw source text ──
            if is_finance_query and extraction_doc_ids:
                finance_context = self._fetch_extraction_summary(extraction_doc_ids, organization_id)
                if not finance_context:
                    finance_context = ""

                # Include raw source text (full table/document) so LLM sees ALL data
                # Pass titles from search results for title-based matching (handles ID mismatches)
                search_titles = list({r.get("document_title", "") for r in (search_results or []) if r.get("document_title")})
                raw_text_block = self._fetch_raw_text(extraction_doc_ids, organization_id, titles=search_titles)
                if raw_text_block:
                    finance_context += "\n\n" + raw_text_block

                # Also include search result chunks (skip structured summaries when raw_text available)
                if search_results:
                    raw_parts = []
                    seen_docs = set()
                    for r in search_results:
                        ct = r.get("chunk_text", "")
                        if raw_text_block and ct and "Structured Document Summary" in ct:
                            continue
                        did = r.get("document_id", "")
                        if did in seen_docs:
                            continue
                        seen_docs.add(did)
                        if ct:
                            display = id_to_display.get(did, r.get("document_title", ""))
                            raw_parts.append(f"[Document: {display}]: {ct}")
                    if raw_parts:
                        raw_block = "\n\n".join(raw_parts[:5])
                        if finance_context:
                            finance_context += "\n\n" + raw_block
                        else:
                            finance_context = raw_block
                if finance_context:
                    chat_log.search_strategy("Finance from extraction+chunks", f"{len(finance_context)} chars")
                    finance_prompt = (
                        "You are a Finance Agent for Visibility Docs AI.\n\n"
                        "CRITICAL INSTRUCTION: Ignore any 'field_confidence' values in the data. "
                        "Those are metadata meant for debugging, not actual content.\n"
                        "The document contains a FULL TABLE with columns: Vendor Name, Vendor City, "
                        "Client Name, Client City, Invoice No, Order Date, Delivery Date, Category, "
                        "Quantity, Unit Price, Total Amount, Payment Mode, Status.\n"
                        "Use the table data to answer questions — it has all the vendor information.\n"
                        "If the answer is truly missing from ALL provided data, say so.\n"
                        "Do not invent numbers, dates, or names.\n"
                    )
                    chat_log.llm_call("llama-3.3-70b-versatile", len(finance_context), len(question), 1)
                    # DEBUG: show context length and first 2000 chars in answer
                    debug_ctx = f"[DEBUG] Context length: {len(finance_context)} chars. First 2000 chars:\n{finance_context[:2000]}"
                    llm_t0 = time.time()
                    answer = debug_ctx + "\n\n--- LLM Response ---\n" + conversation_service.chat(question, finance_context, session_id=sid, system_prompt=finance_prompt)
                    chat_log.llm_response(time.time() - llm_t0, len(answer))
                    self._save_exchange(sid, question, answer, sources[:5] if sources else [], is_first)
                    total = time.time() - t_start
                    chat_log.chat_end(total, 0)
                    return {
                        "answer": answer,
                        "sources": sources[:5] if sources else [],
                        "document_id": extraction_doc_ids[0] if extraction_doc_ids else "",
                        "history": conversation_service.get_history(sid),
                        "session_id": sid,
                    }

            chat_log.search_strategy("Context Building", "no results found")
            chat_log.warn("No relevant documents found in search")
            chat_log.llm_call("llama-3.3-70b-versatile", 0, len(question), 0)
            system_prompt = ""
            if resume_context:
                system_prompt = "You are a Resume Screening assistant. Use the [Resume Rankings] block to answer ranking/comparison questions. Do not make up information."
            if is_first:
                llm_t0 = time.time()
                answer = conversation_service.chat(question, resume_context, session_id=sid,
                    system_prompt=system_prompt)
                chat_log.llm_response(time.time() - llm_t0, len(answer))
            else:
                llm_t0 = time.time()
                answer = conversation_service.chat(question, resume_context, session_id=sid, is_followup=True)
                chat_log.llm_response(time.time() - llm_t0, len(answer))
            self._save_exchange(sid, question, answer, resume_sources[:5], is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": resume_sources[:5],
                "document_id": resolved_ids[0] if resolved_ids else "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
            }

        # ── Build sources list from search results ──
        sources = []
        for r in search_results:
            sources.append({
                "document_id": r["document_id"],
                "document_title": r["document_title"],
                "document_type": r.get("document_type", ""),
                "cv_score": r.get("cv_score"),
                "phase3_agent": r.get("phase3_agent", ""),
                "page_number": r["page_number"],
                "score": r["score"],
            })

        # ── Fetch original_file_url and build display-name map ──
        # Prefer the actual filename from the URL over the stored document_title.
        id_to_display = {}
        try:
            unique_ids = list(set(s["document_id"] for s in sources))
            if unique_ids:
                file_result = SupabaseDB.select("documents",
                    columns="id, original_file_url, title",
                    filters={"organization_id": organization_id},
                )
                file_data = getattr(file_result, "data", file_result if isinstance(file_result, list) else [])
                if isinstance(file_data, list):
                    for row in file_data:
                        rid = row.get("id")
                        if rid in unique_ids:
                            url = row.get("original_file_url") or ""
                            title = row.get("title") or ""
                            # Extract filename from URL; fall back to title or doc ID
                            fname = self._filename_from_url(url) if url else ""
                            id_to_display[rid] = fname or title or rid
                            # Also attach file_url + display_name to sources for frontend
                            for s in sources:
                                if s["document_id"] == rid:
                                    s["file_url"] = url
                                    s["display_name"] = id_to_display[rid]
        except Exception:
            pass

        # ── Build context with display names ──
        # Skip "Structured Document Summary" chunks when extraction data is available
        # (they contain field_confidence debugging metadata that confuses LLMs)
        has_extraction = bool(extraction_doc_ids)
        context_parts = []
        for r in search_results:
            ct = r.get("chunk_text", "")
            if has_extraction and ct.startswith("Structured Document Summary"):
                continue
            display = id_to_display.get(r["document_id"], r["document_title"])
            context_parts.append(f"[Document: {display}]: {ct}")

        # ── Compact field summary (for field queries like "saare numbers") ──
        field_summary = self._build_field_summary(search_results, field_type, id_to_display) if field_type else None

        if field_summary:
            context = field_summary
            context_len = len(context)
            chat_log.info(f"Field summary: {context_len} chars for {field_type}")
        else:
            context = "\n\n".join(context_parts)
            context_len = len(context)

            # Truncate context to stay within Groq free-tier input limits (12K
            # TPM).  Context + qa_prompt (~1.5K tokens) + system (~80) + question
            # + history must stay under 12K tokens.  For Urdu-dense text, 16K
            # chars ≈ 5K tokens, leaving safe margin. 28K chars ~ 8.8K tokens.
            MAX_CONTEXT_CHARS = 28000
            if len(context) > MAX_CONTEXT_CHARS:
                kept_parts, kept_sources = [], []
                total = 0
                for i, part in enumerate(context_parts):
                    added = len(part) + 2
                    if total + added > MAX_CONTEXT_CHARS:
                        break
                    kept_parts.append(part)
                    if i < len(sources):
                        kept_sources.append(sources[i])
                    total += added
                context = "\n\n".join(kept_parts)
                if kept_sources:
                    sources = kept_sources
                context_len = len(context)
                chat_log.info(f"Truncated context to {context_len} chars ({len(sources)} sources)")

        # ── Resume ranking: if query mentions resumes, inject sorted scores ──
        resumes = []
        if is_resume_query:
            try:
                resumes = document_service.list_documents(organization_id)
                if resolved_ids:
                    resolved_set = set(resolved_ids)
                    resumes = [r for r in resumes if r["id"] in resolved_set]
                document_service._batch_attach_extractions(resumes, organization_id)
                resumes = [r for r in resumes if r.get("cv_score") is not None]
                resumes.sort(key=lambda x: x.get("cv_score", 0) or 0, reverse=True)
            except Exception:
                resumes = []
            if resumes:
                lines = ["[Resume Rankings (sorted by CV evaluation score)]"]
                for i, r in enumerate(resumes[:20], 1):
                    score_str = f"{r['cv_score']}/100" if r["cv_score"] is not None else "N/A"
                    lines.append(f"{i}. {r['title']} — {score_str}")
                resume_block = "\n".join(lines)
                context = resume_block + "\n\n" + context if context else resume_block
                chat_log.info(f"Injected {len(resumes)} resume scores into context")
                # Also inject rich resume details (skills, experience, education, certs)
                res_doc_ids = [r["id"] for r in resumes if r.get("id")]
                res_details = self._fetch_resume_details(res_doc_ids, organization_id)
                if res_details:
                    details_block = self._build_resume_details_block(resumes, res_details)
                    if details_block:
                        context = context + "\n\n" + details_block if context else details_block
                        chat_log.info(f"Injected resume details for {len(res_details)} resumes")

        # ── Structured extraction summary for aggregate/multi-doc queries ──
        is_aggregate_query = any(
            __import__("re").search(kw, q_lower) for kw in _AGGREGATE_KEYWORDS
        )
        if (is_aggregate_query or is_finance_query) and extraction_doc_ids:
            extraction_summary = self._fetch_extraction_summary(extraction_doc_ids, organization_id)
            if extraction_summary:
                context = extraction_summary + "\n\n" + context if context else extraction_summary
                chat_log.info(f"Injected structured extraction summary for {len(extraction_doc_ids)} documents")
            # Also inject raw source text for table/finance data — critical for Excel docs
            # where chunks may be truncated or IDs mismatch between local/remote DBs.
            # _fetch_raw_text handles ID fallback via title matching internally.
            raw_text_block = self._fetch_raw_text(extraction_doc_ids, organization_id)
            if raw_text_block:
                context = context + "\n\n" + raw_text_block if context else raw_text_block
                chat_log.info(f"Injected raw text: {len(raw_text_block)} chars")

        chat_log.search_strategy("Context Building", f"{len(search_results)} chunks → {context_len} chars")
        doc_types_seen = {}
        agent_prompts_seen = {}
        for r in search_results:
            dt = r.get("document_type", "unknown")
            doc_types_seen[dt] = doc_types_seen.get(dt, 0) + 1
            p3a = r.get("phase3_agent", "")
            if p3a:
                prompt_file = f"prompts/phase3/{p3a}.md"
                agent_prompts_seen[prompt_file] = agent_prompts_seen.get(prompt_file, 0) + 1
        if doc_types_seen:
            chat_log.info(f"Document types: {', '.join(f'{k}={v}' for k, v in doc_types_seen.items())}")
        if agent_prompts_seen:
            chat_log.info(f"Agent prompts used: {', '.join(f'{k}' for k, v in agent_prompts_seen.items())}")

        unique_docs = list(set(r["document_id"] for r in search_results))
        chat_log.info(f"Unique documents: {len(unique_docs)}")
        for i, s in enumerate(sources[:5]):
            p3a = s.get("phase3_agent", "")
            agent_tag = f" [{p3a}]" if p3a else ""
            doc_type = s.get("document_type") or ""
            chat_log.source_item(i, s["document_title"], doc_type + agent_tag, s["score"])

        # ── Determine dominant agent from selected documents directly ──
        doc_agent_counts = {}
        if resolved_ids:
            try:
                doc_result = SupabaseDB.select("documents",
                    columns="id, document_type, phase3_agent",
                    filters={"organization_id": organization_id},
                )
                doc_data = getattr(doc_result, "data", doc_result if isinstance(doc_result, list) else [])
                resolved_set = set(resolved_ids)
                for d in doc_data:
                    if d.get("id") in resolved_set:
                        p3a = d.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(d.get("document_type", ""), "other_agent")
                        if p3a:
                            doc_agent_counts[p3a] = doc_agent_counts.get(p3a, 0) + 1
            except Exception:
                pass

        # Also count from search results as fallback
        agent_counts = {}
        for r in search_results:
            p3a = r.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(r.get("document_type", ""), "other_agent")
            agent_counts[p3a] = agent_counts.get(p3a, 0) + 1

        # Use selected-doc agents if available, otherwise fall back to search result agents
        dominant_source = doc_agent_counts if doc_agent_counts else agent_counts
        dominant_agent = max(dominant_source, key=dominant_source.get) if dominant_source else "other_agent"

        # ── Smart agent when no document is explicitly selected ──
        # Avoid forcing the majority agent (e.g. hr_agent for resumes) onto a question
        # about invoices/RFQs. Detect intent from the query; fall back to a generic
        # Q&A agent when intent is unclear so the LLM answers from whatever doc has it.
        no_scope = not resolved_ids and not document_type and not phase3_agent
        if no_scope:
            detected = self._detect_query_agent(question)
            dominant_agent = detected if detected else "other_agent"

        # Load the full agent .md prompt and adapt it for Q&A
        qa_prompt = ""
        try:
            if is_finance_query or dominant_agent == "finance_agent":
                qa_prompt = (
                    "You are the Finance Agent for Visibility Docs AI, answering questions about invoices and other financial documents.\n\n"
                    "Always respond in the same language as the user's question. Use ONLY the provided context. "
                    "When a structured extraction summary is present, prefer it — it contains exact extracted values.\n\n"
                    "Answer in detail: include exact invoice numbers, dates, vendor and customer names, subtotal, tax, total, "
                    "due date, payment terms, and line items with quantities and prices. Keep currency symbols and units intact. "
                    "If the answer is not in the context, say so. If line items are present, list them cleanly. "
                    "When structured data and raw text disagree, mention it briefly. Do not invent values.\n"
                )
            else:
                raw_prompt = _load_phase3_prompt(f"{dominant_agent}.md")
                if raw_prompt:
                    import re
                    qa_prompt = raw_prompt.replace("{text}", "{context}")
                    # Remove extraction-specific JSON instructions, keep Document text line
                    qa_prompt = re.sub(
                        r"Return ONLY valid JSON\..*?(?=\nDocument text:)",
                        "Answer the user's question based ONLY on the provided document context below.",
                        qa_prompt,
                        flags=re.DOTALL,
                    )
                    # Remove the now-unnecessary "Document text:" line
                    qa_prompt = qa_prompt.replace("\nDocument text:\n{context}", "")
                    qa_prompt += (
                        "\n\nAnswer naturally in the same language as the user's question. "
                        "Base your reply on the provided context — include relevant skills, experience, "
                        "qualifications, and supporting evidence. If the context contains image descriptions, "
                        "use them. If the answer is not in the context, say so. "
                        "If there are tables or diagrams, explain what they show. "
                        "Do not make up information.\n"
                    )
                    resume_rank_instruction = (
                        "\nThe context may include a [Resume Rankings] block with CV evaluation scores. "
                        "Use those scores to rank, compare, or recommend candidates when asked.\n"
                    ) if is_resume_query and any(r.get("cv_score") is not None for r in resumes) else ""
                    qa_prompt += resume_rank_instruction
        except Exception:
            pass

        if not qa_prompt:
            # Fallback: generic prompt with agent label
            agent_label = dominant_agent.replace("_", " ").title()
            if is_finance_query or dominant_agent == "finance_agent":
                qa_prompt = (
                    "You are a Finance Agent for Visibility Docs AI.\n\n"
                    "Answer only from the provided context and structured summary. "
                    "Be exact about amounts, dates, and names. "
                    "Keep currency symbols and percentages intact. "
                    "If the answer is missing, say so. "
                    "Do not invent numbers.\n"
                )
            else:
                resume_rank_instruction = (
                    "\nThe context may include a [Resume Rankings] block with CV evaluation scores. "
                    "Use those scores to rank, compare, or recommend candidates when asked.\n"
                ) if is_resume_query and any(r.get("cv_score") is not None for r in resumes) else ""
                qa_prompt = (
                    f"You are the {agent_label} - a document Q&A assistant for Visibility Docs AI.\n\n"
                    "Answer naturally in the same language as the user's question. "
                    "Base your reply on the provided context — include relevant details, "
                    "evidence, and supporting information. If the context contains image "
                    "descriptions, use them. If the answer is not in the context, say so. "
                    "If there are tables or diagrams, explain what they show. "
                    "Do not make up information.\n"
                    f"{resume_rank_instruction}"
                )
        # ── Common instructions: source citation + counter questions ──
        qa_prompt += (
            "\nWhen you share extracted values or information, always mention which "
            "document it came from — use the document name shown in the context naturally, "
            "like \"Invoice-001 shows...\" or \"the resume of John contains...\". "
            "Do not list values without saying which file they belong to."
        )
        # ── Clarifying counter-questions (ChatGPT-style) ──
        # Ask a natural follow-up whenever something is genuinely unclear: the
        # request is ambiguous/underspecified, OR the context does not contain
        # enough to answer confidently. The model self-gates this — it must NOT
        # add questions when it can already answer. Phrasing must be conversational
        # (no "Counter-questions:" headings, no bulleted lists).
        qa_prompt += (
            "\nIf the user's request is ambiguous, missing important details, or the "
            "provided context does not contain enough information to answer confidently, "
            "end your reply by naturally asking 1-2 short clarifying follow-up questions "
            "as a normal conversational sentence (no heading, no \"Counter-questions:\" "
            "label, no bullet-list formatting). If you can already answer the question "
            "confidently from the context, do NOT add any questions."
        )

        chat_log.info(f"Built Q&A prompt for agent: {dominant_agent} ({len(qa_prompt)} chars)")

        chat_log.llm_call("llama-3.3-70b-versatile", context_len, len(question), len(sources))
        llm_t0 = time.time()
        is_followup = not is_first
        answer = conversation_service.chat(question, context, session_id=sid, is_followup=is_followup,
                                            system_prompt=qa_prompt)
        chat_log.llm_response(time.time() - llm_t0, len(answer))

        history = conversation_service.get_history(sid)
        self._save_exchange(sid, question, answer, sources[:5], is_first)

        total = time.time() - t_start
        chat_log.chat_end(total, len(sources))
        chat_log.info(f"Answer length: {len(answer)} chars")

        return {
            "answer": answer,
            "sources": sources[:5],
            "document_id": sources[0]["document_id"] if sources else "",
            "history": history,
            "session_id": sid,
        }

    def _answer_on_excerpt(self, question: str, selected_text: str, organization_id: str,
                           sid: str, is_first: bool) -> dict:
        """Answer a follow-up question grounded STRICTLY on a user-selected excerpt.

        Used for the ChatGPT-style "highlight a response → ask about it" flow. No
        document retrieval is performed; the model may only use the excerpt.
        """
        chat_log = get_chat_logger()
        excerpt_context = (
            "The following is an excerpt the user selected from a previous answer. "
            "Answer the user's question using ONLY this excerpt.\n\n"
            f"[Selected Excerpt]\n{selected_text}\n[/Selected Excerpt]"
        )
        system_prompt = (
            "You are a helpful assistant for Visibility Docs AI.\n\n"
            "The user selected a specific portion of a previous response and is asking a "
            "follow-up question about it. Answer the question using ONLY the provided "
            "[Selected Excerpt]. Do not use any outside knowledge or other documents.\n\n"
            "Base every claim on the excerpt — quote or reference the relevant part when useful. "
            "If the excerpt does not contain the information needed, say so naturally and "
            "ask one short clarifying question about what they would like to know instead. "
            "Keep the answer concise. Reply in the same language as the user's question. "
            "Do not invent facts.\n"
        )
        chat_log.info(f"Focused excerpt Q&A — excerpt {len(selected_text)} chars, question {len(question)} chars")
        chat_log.llm_call("llama-3.3-70b-versatile", len(excerpt_context), len(question), 0)
        llm_t0 = time.time()
        answer = conversation_service.chat(
            question, excerpt_context, session_id=sid,
            is_followup=not is_first, system_prompt=system_prompt,
        )
        chat_log.llm_response(time.time() - llm_t0, len(answer))
        self._save_exchange(sid, question, answer, [], is_first)
        history = conversation_service.get_history(sid)
        return {
            "answer": answer,
            "sources": [],
            "document_id": "",
            "history": history,
            "session_id": sid,
        }


chat_service = ChatService()
