import time
from .conversation_service import conversation_service
from .rag_service import rag_service
from .document_service import document_service
from ..database import SupabaseDB
from .orchestration_logger import get_chat_logger, C
from .agent_orchestrator import _load_phase3_prompt, _load_prompt, get_phase3_prompt_for_doc, DOCUMENT_TO_PHASE3_AGENT, PHASE3_AGENT_PROMPT_MAP

_RESUME_KEYWORDS = ["resume", "cv ", "candidate", "applicant", "hiring", "recruit",
                    "top.*resume", "best.*candidate", "rank.*resume", "score.*resume",
                    "sorted.*resume", "highest.*score", "top.*candidate",
                    "give me.*top", "list.*resume", "show.*candidate", "list.*candidate",
                    "top.*resume", "recommend.*candidate", "best.*fit"]

_AGGREGATE_KEYWORDS = [r"\bsum\b", r"\btotal\b", r"\baggregate\b", r"\bcombine\b",
                       r"\boverall\b", r"\bgrand total\b", r"\ball\b.*\btotal\b",
                       r"\btotal\b.*\ball\b", r"\badd up\b", r"\bsum up\b",
                       r"\baccumulated\b", r"\bcombined\b", r"\btogether\b"]

# Short conversational messages that should not hit document search / DB
_CHITCHAT_PATTERNS = [
    r"^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam.?o.?alaikum|aoa|slm)\b",
    r"^(good\s*(morning|afternoon|evening|night)|gm|gn)\b",
    r"^(how are you|how's it going|how r u|whats? up|sup)\??$",
    r"^(thanks?|thank you|thx|ty|shukriya|jazakallah)\b",
    r"^(ok|okay|okaye|k|kk|cool|great|nice|awesome|perfect|alright)\b",
    r"^(bye|goodbye|see you|take care|tc)\b",
    r"^(yes|no|yep|yup|nope|yeah|nah)\b",
    r"^(who are you|what can you do|help|help me)\??$",
]

# Cross-document "list a field from every file" intent (used when NO document is selected)
_CROSS_DOC_PHRASES = [
    "all files", "all documents", "all the files", "all of the files", "all of them",
    "every file", "every document", "each file", "each document", "each of the",
    "from all", "across all", "in every", "of every", "saari files", "har file",
    "tamam documents", "sari files", "تمام فائلیں",
]
_CROSS_DOC_WORDS = {
    "all", "every", "each", "list", "both", "saari", "sari", "har", "tamam", "sab",
    "تمام", "ساری", "ہر",
}
# Tokens to drop when extracting the target field from the query
_CROSS_DOC_DROP = {
    "all", "every", "each", "both", "list", "the", "of", "for", "with", "in", "on",
    "my", "me", "do", "la", "give", "show", "find", "from", "across", "and", "or",
    "files", "file", "documents", "document", "docs", "mujhe", "batao", "bata",
    "dikhao", "nikal", "nikalo", "chahiye", "ke", "ki", "ka", "kay", "kai", "ko",
    "please", "can", "you", "could",
}


class ChatService:
    @staticmethod
    def _is_chitchat(question: str) -> bool:
        """True for greetings / small-talk that do not need document retrieval."""
        import re
        q = (question or "").strip().lower()
        if not q or len(q) > 80:
            return False
        # If it clearly asks about docs/data, never treat as chitchat
        doc_hints = (
            "resume", "cv", "invoice", "document", "file", "score", "candidate",
            "pdf", "contract", "find", "show", "list", "who", "what is", "kitne",
            "kitna", "batao", "tell me", "search", "summar", "extract",
        )
        if any(h in q for h in doc_hints):
            return False
        return any(re.search(p, q, re.IGNORECASE) for p in _CHITCHAT_PATTERNS)

    def _chitchat_reply(self, question: str, session_id: str, is_first: bool) -> str:
        prompt = (
            "You are Visibility Docs AI, a friendly document assistant.\n"
            "The user sent a greeting or casual message — NOT a document question.\n"
            "Reply briefly and warmly in the same language as the user "
            "(Urdu/Roman Urdu → short Roman Urdu/Urdu; English → English).\n"
            "Invite them to ask about their uploaded documents.\n"
            "Do NOT say you cannot find information in documents.\n"
            "Do NOT invent document facts."
        )
        return conversation_service.chat(
            question,
            "",
            session_id=session_id,
            is_followup=not is_first,
            system_prompt=prompt,
        )

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
    KEYWORD_TO_DOC_TYPE = {
        "invoice": ["invoice", "inv ", "inv.", "bill", "انوائس", "بل", "رسید"],
        "expense_report": ["expense report", "expense", "reimbursement", "اخراجات", "اخراجات رپورٹ"],
        "bank_statement": ["bank statement", "bank stmt", "statement of account", "بینک سٹیٹمنٹ"],
        "payment_receipt": ["payment receipt", "receipt", "وصولی", "رسید ادائیگی"],
        "tax_document": ["tax document", "tax return", "wht", "withholding", "ٹیکس"],
        "budget": ["budget", "बजٹ"],
        "financial_statement": ["financial statement", "balance sheet", "پروفٹ", "مالیاتی بیان"],
        "purchase_order": ["purchase order", "po ", "p.o.", "خریداری", "خریداری آرڈر"],
        "quotation": ["quotation", "quote", "کوٹیشن"],
        "rfq": ["rfq", "request for quotation", "درخواست برائے کوٹیشن"],
        "delivery_note": ["delivery note", "delivery slip", "ڈیلیوری نوٹ"],
        "procurement_request": ["procurement request", "purchase request", "خریداری کی درخواست"],
        "contract": ["contract", "معاہدہ"],
        "agreement": ["agreement", "اتفاق نامہ"],
        "nda": ["nda", "non-disclosure", "non disclosure", "confidentiality agreement", "این ڈی اے"],
        "service_agreement": ["service agreement", "سروس معاہدہ"],
        "lease_agreement": ["lease agreement", "lease", "کرایہ نامہ"],
        "vendor_contract": ["vendor contract", "supplier contract"],
        "resume": ["resume", "cv", "c.v.", "bio data", "بائیو ڈیٹا", "ریزیومہ", "امیدوار"],
        "transcript": ["transcript", "نتیجہ", "رزلٹ", "transcripts"],
        "offer_letter": ["offer letter", "آفر لیٹر", "پیشکش"],
        "payroll": ["payroll", "salary slip", "payslip", "تنخواہ"],
        "leave_application": ["leave application", "leave request", "چھٹی"],
        "attendance": ["attendance", "حاضری"],
        "employee_record": ["employee record", "hr document", "ملازم", "اسناد ملازمین"],
        "certificate": ["certificate", "سرٹیفکیٹ", "سند"],
        "audit_report": ["audit", "audit report", "آڈٹ", "آڈٹ رپورٹ"],
        "quality_report": ["quality report", "کوالٹی", "معیاری رپورٹ"],
        "maintenance_report": ["maintenance report", "دیکھ بھال", "مرمت"],
        "sop": ["sop", "standard operating", "ایس او پی", "ایسوپی"],
        "engineering_drawing": ["engineering drawing", "نقشہ", "ڈرائنگ", "انجینئرنگ ڈرائنگ"],
        "inspection_report": ["inspection report", "معائنہ رپورٹ"],
        "safety_manual": ["safety manual", "حفاظتی دستی"],
        "other": ["other", "general", "عام", "general document"],
    }

    # Agent → retrieval-context anchor. Prepended to the SEARCH query only
    # (never to the model-facing question) so hybrid/aggregate retrieval is steered.
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
        if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
            return None
        return ranked[0][0]

    def _detect_cross_doc_intent(self, query: str):
        """Detect 'list a field from EVERY document' intent (when no doc is selected).

        Returns (is_cross_doc, field_terms) where field_terms is the cleaned list of
        query words (aggregation/stopwords removed) used to scan each document.
        """
        import re
        q = (query or "").lower().strip()
        if not q:
            return False, []
        is_cross = any(p in q for p in _CROSS_DOC_PHRASES)
        if not is_cross:
            # single aggregation word (e.g. "har file ka phone number") + a content word
            hits = sum(1 for w in q.split() if w in _CROSS_DOC_WORDS)
            if hits == 0:
                return False, []
            is_cross = True
        terms = [t for t in re.sub(r'[^\w\s]', ' ', q).split()
                 if t and t not in _CROSS_DOC_DROP and t not in _CROSS_DOC_WORDS and len(t) >= 2]
        return True, terms

    def _get_or_create_session(
        self,
        session_id: str,
        organization_id: str,
        document_ids: list = None,
        user_id: str = None,
    ) -> tuple[str, list | None, bool]:
        """document_ids=None means all docs; a list means selected scope only."""
        is_first = True
        if session_id:
            existing = SupabaseDB.get_chat_session(session_id)
            if existing:
                # Do not continue another user's session
                owner = existing.get("user_id")
                session_org = existing.get("organization_id")
                if user_id and owner and owner != user_id:
                    existing = None
                elif session_org and session_org != organization_id:
                    existing = None
            if existing:
                stored_ids = existing.get("document_ids") or []
                messages = existing.get("messages") or []
                is_first = len(messages) == 0
                if messages:
                    conversation_service.load_history_from_db(session_id, messages)
                if document_ids is not None:
                    resolved = list(document_ids)
                    if set(resolved) != set(stored_ids):
                        SupabaseDB.update_chat_session_doc_ids(session_id, resolved)
                else:
                    # All-documents mode: do not restrict by previously stored selection
                    resolved = None
                return session_id, resolved, is_first
        doc_list = list(document_ids) if document_ids is not None else []
        new_id = SupabaseDB.create_chat_session(organization_id, "New Chat", doc_list, user_id=user_id)
        return new_id, (list(document_ids) if document_ids is not None else None), True

    @staticmethod
    def _dedupe_sources(sources: list, limit: int = 3) -> list:
        """One source chip per document (drop duplicate chunks)."""
        seen = set()
        out = []
        for s in sources or []:
            did = s.get("document_id")
            if not did or did in seen:
                continue
            seen.add(did)
            out.append(s)
            if len(out) >= limit:
                break
        return out

    def _build_multi_prompt_for_search_results(self, doc_type_counts: dict, agents: set) -> tuple[str, list[str]]:
        """Load and sanitize multiple .md prompt files for top matched document types.
        Compactly limits loaded prompts to top 3 matched types (max ~1,200 chars per prompt)
        to stay safely under Groq token limits while providing specialized domain guidelines."""
        import re
        loaded_prompts = []
        loaded_paths = []
        seen_paths = set()

        sorted_types = [dt for dt, _ in sorted(doc_type_counts.items(), key=lambda x: x[1], reverse=True) if dt]
        if len(sorted_types) > 1 and "other" in sorted_types:
            sorted_types.remove("other")

        top_types = sorted_types[:3]

        pairs = []
        for dt in top_types:
            p3a = DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
            pairs.append((dt, p3a))

        if not pairs and agents:
            for ag in list(agents)[:3]:
                if ag and ag != "other_agent":
                    pairs.append(("", ag))

        if not pairs:
            pairs.append(("", "other_agent"))

        for dt, ag in pairs:
            raw_prompt, prompt_path = get_phase3_prompt_for_doc(dt, ag)
            if raw_prompt and prompt_path not in seen_paths:
                seen_paths.add(prompt_path)
                cleaned = re.sub(
                    r"##\s*(?:Field Extraction Example|Extraction Example|Field Specifications).*?(?=\n##|\Z)",
                    "", raw_prompt, flags=re.DOTALL | re.IGNORECASE,
                )
                cleaned = re.sub(r"Return ONLY valid JSON\..*?(?=\n|\Z)", "", cleaned, flags=re.DOTALL | re.IGNORECASE)
                cleaned = cleaned.replace("{text}", "{context}")
                cleaned = cleaned.replace("\nDocument text:\n{context}", "").strip()

                if len(cleaned) > 1200:
                    cleaned = cleaned[:1150] + "\n..."

                doc_name_label = dt.upper() if dt else ag.replace("_", " ").upper()
                label = f"### Domain Guidelines for {doc_name_label} ({prompt_path.split('/')[-1]})"
                loaded_prompts.append(f"{label}\n{cleaned}")
                loaded_paths.append(prompt_path)

        merged_prompt = "\n\n".join(loaded_prompts)
        return merged_prompt, loaded_paths

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
                        max_chars: int = 30000, titles: list = None) -> str:
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
                    if isinstance(val, str) and val:
                        lines.append(f"    {key}: {val}")
                    elif isinstance(val, (int, float)):
                        lines.append(f"    {key}: {val}")
                        totals[key] = totals.get(key, 0) + val
                    elif isinstance(val, list) and val:
                        lines.append(f"    {key}:")
                        for item in val[:500]:
                            if isinstance(item, dict):
                                parts = [f"{k}={v}" for k, v in item.items() if v not in (None, "", [], {})]
                                if parts:
                                    lines.append("      - " + ", ".join(parts))
                            else:
                                lines.append(f"      - {item}")

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

    def chat_with_document(self, question: str, document_ids: list, organization_id: str,
                           document_type: str = None, phase3_agent: str = None,
                           status: str = None, date_from: str = None, date_to: str = None,
                           chat_history: list[dict] = None, session_id: str = None,
                           user_id: str = None, selected_text: str = None) -> dict:
        chat_log = get_chat_logger()
        chat_log.chat_start(question, session_id=session_id or "", doc_count=len(document_ids or []))
        t_start = time.time()

        sid, resolved_ids, is_first = self._get_or_create_session(
            session_id, organization_id, document_ids, user_id=user_id
        )

        # ── Focused Q&A on a selected excerpt (ChatGPT-style "ask about this") ──
        if selected_text and selected_text.strip():
            return self._answer_on_excerpt(
                question=question, selected_text=selected_text.strip(),
                organization_id=organization_id, sid=sid, is_first=is_first,
            )

        # Greetings / small-talk → reply without searching documents
        if self._is_chitchat(question):
            chat_log.info("Chitchat detected — skipping document search")
            answer = self._chitchat_reply(question, sid, is_first)
            self._save_exchange(sid, question, answer, [], is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": [],
                "document_id": "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
            }

        # Selected scope with empty list → no docs (do not search everything)
        if document_ids is not None and not resolved_ids:
            answer = "No documents selected. Select at least one document and try again."
            self._save_exchange(sid, question, answer, [], is_first)
            return {
                "answer": answer,
                "sources": [],
                "document_id": "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
            }

        # ── Agent-context anchoring for retrieval (search query only) ──
        anchor_agent = phase3_agent or None
        if resolved_ids and not anchor_agent:
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

        # ── Keyword → document_type filter (org-wide / no_scope only) ──
        detected_doc_type = self.detect_doc_type_keyword(question)
        apply_type_filter = bool(detected_doc_type) and not resolved_ids and not document_type
        if apply_type_filter:
            document_type = detected_doc_type

        # Cross-document "list a field from every file" intent (only when no doc chosen)
        cross_doc = False
        agg_field_terms = []
        if not resolved_ids:
            cross_doc, agg_field_terms = self._detect_cross_doc_intent(question)

        hybrid_kwargs = dict(
            query=search_query,
            organization_id=organization_id,
            document_type=document_type,
            phase3_agent=phase3_agent,
            status=status,
            date_from=date_from,
            date_to=date_to,
            document_ids=resolved_ids,  # None = all; list = selected only
            limit=60 if cross_doc else 15,
            aggregate=cross_doc,
        )
        if cross_doc:
            chat_log.info("Cross-doc intent detected — using aggregate_search")
            search_results = rag_service.aggregate_search(
                query=search_query,
                organization_id=organization_id,
                document_ids=resolved_ids if resolved_ids else None,
                max_docs=150,
            )
            if not search_results:
                search_results = rag_service.hybrid_search(**hybrid_kwargs)
        else:
            search_results = rag_service.hybrid_search(**hybrid_kwargs)

        q_lower = question.lower()
        is_resume_query = any(
            __import__("re").search(kw, q_lower) for kw in _RESUME_KEYWORDS
        )
        is_finance_query = (
            document_type in ("invoice", "purchase_order", "quotation", "rfq")
            or phase3_agent in ("finance_agent", "procurement_agent")
            or any(term in q_lower for term in [
                "invoice", "subtotal", "amount due", "grand total", "due date",
                "payment terms", "vendor", "customer", "bill to", "ship to",
                "tax", "vat", "gst", "line item", "line items", "invoice number",
                "purchase order", "po number", "quotation", "rfq", "supplier",
            ])
        )

        if not search_results and not is_resume_query and document_type:
            chat_log.warn(f"No results with document_type={document_type} — retrying without type filter")
            retry_kwargs = {k: v for k, v in hybrid_kwargs.items() if k != "document_type"}
            search_results = rag_service.hybrid_search(**retry_kwargs)

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

            # If search returned nothing but we are clearly in finance/invoice mode,
            # answer directly from structured extraction data when available.
            finance_context = ""
            if is_finance_query and resolved_ids:
                finance_context = self._fetch_extraction_summary(resolved_ids, organization_id)
                raw_text_block = self._fetch_raw_text(resolved_ids, organization_id)
                if raw_text_block:
                    finance_context = (finance_context + "\n\n" + raw_text_block) if finance_context else raw_text_block
            if finance_context:
                chat_log.search_strategy("Structured Extraction Fallback", "no vector matches, using invoice metadata")
                finance_prompt = (
                    "You are a Finance Agent for Visibility Docs AI.\n\n"
                    "Use the provided structured extraction summary to answer the question exactly.\n"
                    "If the answer is missing, say you cannot find it in the documents.\n"
                    "Do not invent numbers, dates, or names.\n"
                )
                chat_log.llm_call("llama-3.3-70b-versatile", len(finance_context), len(question), 1)
                llm_t0 = time.time()
                answer = conversation_service.chat(question, finance_context, session_id=sid, system_prompt=finance_prompt)
                chat_log.llm_response(time.time() - llm_t0, len(answer))
                self._save_exchange(sid, question, answer, [], is_first)
                total = time.time() - t_start
                chat_log.chat_end(total, 0)
                return {
                    "answer": answer,
                    "sources": [],
                    "document_id": resolved_ids[0] if resolved_ids else "",
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
            unique_resume_sources = self._dedupe_sources(resume_sources, limit=3)
            self._save_exchange(sid, question, answer, unique_resume_sources, is_first)
            total = time.time() - t_start
            chat_log.chat_end(total, 0)
            return {
                "answer": answer,
                "sources": unique_resume_sources,
                "document_id": resolved_ids[0] if resolved_ids else "",
                "history": conversation_service.get_history(sid),
                "session_id": sid,
            }

        context_parts = []
        sources = []
        for r in search_results:
            context_parts.append(f'<document filename="{r["document_title"]}">\n{r["chunk_text"]}\n</document>')
            sources.append({
                "document_id": r["document_id"],
                "document_title": r["document_title"],
                "document_type": r.get("document_type", ""),
                "cv_score": r.get("cv_score"),
                "phase3_agent": r.get("phase3_agent", ""),
                "page_number": r["page_number"],
                "score": r["score"],
            })
        sources = self._dedupe_sources(sources, limit=3)

        context = "\n\n".join(context_parts)
        
        # Limit context size to prevent Groq API Token limits (Limit 6000 TPM for Llama-3.1-8b on free tier)
        if len(context) > 16000:
            chat_log.warn(f"Truncating search context from {len(context)} to 16000 characters to respect token limits.")
            context = context[:16000] + "\n...[Content Truncated due to API token limits]..."
            
        context_len = len(context)

        # ── Attach file_url to sources for frontend file name display ──
        try:
            unique_ids = list(set(s["document_id"] for s in sources))
            if unique_ids:
                file_result = SupabaseDB.select("documents",
                    columns="id, original_file_url",
                    filters={"organization_id": organization_id},
                )
                file_data = getattr(file_result, "data", file_result if isinstance(file_result, list) else [])
                if isinstance(file_data, list):
                    id_to_url = {row["id"]: row.get("original_file_url", "") for row in file_data if row.get("id") in unique_ids}
                    for s in sources:
                        s["file_url"] = id_to_url.get(s["document_id"], "")
        except Exception:
            pass

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

        # ── Structured extraction summary for aggregate/multi-doc queries ──
        is_aggregate_query = any(
            __import__("re").search(kw, q_lower) for kw in _AGGREGATE_KEYWORDS
        )
        if (is_aggregate_query or is_finance_query) and resolved_ids:
            extraction_summary = self._fetch_extraction_summary(resolved_ids, organization_id)
            if extraction_summary:
                context = extraction_summary + "\n\n" + context if context else extraction_summary
                chat_log.info(f"Injected structured extraction summary for {len(resolved_ids)} documents")
            # Also inject raw source text for table/finance data — critical for Excel docs
            # where chunks may be truncated or IDs mismatch between local/remote DBs.
            raw_text_block = self._fetch_raw_text(resolved_ids, organization_id)
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
                _, prompt_file = get_phase3_prompt_for_doc(dt, p3a)
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
            chat_log.source_item(i, s["document_title"], s.get("document_type", "") + agent_tag, s["score"])

        # ── Determine dominant agent and document_type from selected documents ──
        doc_agent_counts = {}
        doc_type_counts = {}
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
                        dt = d.get("document_type", "")
                        if dt:
                            doc_type_counts[dt] = doc_type_counts.get(dt, 0) + 1
                        p3a = d.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
                        if p3a:
                            doc_agent_counts[p3a] = doc_agent_counts.get(p3a, 0) + 1
            except Exception:
                pass

        # Also count from search results as fallback
        agent_counts = {}
        search_doc_type_counts = {}
        for r in search_results:
            dt = r.get("document_type", "")
            if dt:
                search_doc_type_counts[dt] = search_doc_type_counts.get(dt, 0) + 1
            p3a = r.get("phase3_agent") or DOCUMENT_TO_PHASE3_AGENT.get(dt, "other_agent")
            agent_counts[p3a] = agent_counts.get(p3a, 0) + 1

        # Use selected-doc agents if available, otherwise fall back to search result agents
        dominant_source = doc_agent_counts if doc_agent_counts else agent_counts
        dominant_agent = max(dominant_source, key=dominant_source.get) if dominant_source else "other_agent"

        dominant_dt_source = doc_type_counts if doc_type_counts else search_doc_type_counts
        dominant_doc_type = max(dominant_dt_source, key=dominant_dt_source.get) if dominant_dt_source else (document_type or "")

        no_scope = not resolved_ids and not document_type and not phase3_agent
        is_folder_selection = bool(phase3_agent and not resolved_ids and not document_type)
        target_doc_type = "" if is_folder_selection else dominant_doc_type

        if phase3_agent and (is_folder_selection or not dominant_source):
            dominant_agent = phase3_agent
        elif no_scope:
            detected = self._detect_query_agent(question)
            if detected:
                dominant_agent = detected

        # Load agent / per-type .md prompts and adapt them for Q&A
        qa_prompt = ""
        try:
            if is_finance_query or dominant_agent == "finance_agent":
                qa_prompt = (
                    "You are the Finance Agent for Visibility Docs AI, answering questions about invoices and other financial documents.\n\n"
                    "Use ONLY the provided context. Prefer the structured extraction summary when it exists, because it contains exact extracted fields.\n\n"
                    "Rules:\n"
                    "0. Always answer in the same language as the user's question — Urdu/Saraiki question → Urdu answer, English question → English answer.\n"
                    "1. Answer directly and precisely.\n"
                    "2. For invoice questions, use exact values for invoice number, dates, vendor, customer, subtotal, tax, total, due date, payment terms, and line items.\n"
                    "3. Keep currency symbols and units intact.\n"
                    "4. If the answer is not present, say \"I cannot find this information in the documents.\"\n"
                    "5. If there is a mismatch between structured data and raw text, mention it briefly.\n"
                    "6. Do not invent values.\n"
                    "7. If line items are present, list them cleanly and include quantities/prices when available.\n"
                    "8. Do not output JSON, unless the user explicitly requests JSON format.\n"
                )
            else:
                multi_types = dominant_dt_source or search_doc_type_counts
                use_multi = no_scope or (len(multi_types) > 1)

                if use_multi:
                    matched_counts = dict(search_doc_type_counts)
                    if doc_type_counts:
                        for dt, c in doc_type_counts.items():
                            matched_counts[dt] = matched_counts.get(dt, 0) + c
                    if no_scope:
                        query_doc_type = self.detect_doc_type_keyword(question)
                        if query_doc_type:
                            matched_counts[query_doc_type] = matched_counts.get(query_doc_type, 0) + 100
                            chat_log.info(f"Query intent classified as doc_type: '{query_doc_type}'")
                    matched_agents = set(agent_counts.keys())
                    if phase3_agent:
                        matched_agents.add(phase3_agent)
                    detected_agent = self._detect_query_agent(question)
                    if detected_agent:
                        matched_agents.add(detected_agent)
                    merged_rules, loaded_paths = self._build_multi_prompt_for_search_results(
                        matched_counts, matched_agents
                    )
                    if merged_rules:
                        chat_log.info(
                            f"Dynamically loaded intent-matched .md prompt file(s) "
                            f"({len(loaded_paths)} files): {', '.join(loaded_paths)}"
                        )
                        qa_prompt = merged_rules

                if not qa_prompt:
                    raw_prompt, prompt_path = get_phase3_prompt_for_doc(
                        target_doc_type or dominant_doc_type, dominant_agent
                    )
                    if raw_prompt:
                        import re
                        chat_log.info(
                            f"Loaded prompt file: {prompt_path} "
                            f"(folder_selection={is_folder_selection}, "
                            f"doc_type='{target_doc_type or dominant_doc_type}', "
                            f"agent='{dominant_agent}')"
                        )
                        cleaned_prompt = re.sub(
                            r"##\s*(?:Field Extraction Example|Extraction Example|Field Specifications).*?(?=\n##|\Z)",
                            "", raw_prompt, flags=re.DOTALL | re.IGNORECASE,
                        )
                        cleaned_prompt = re.sub(
                            r"Return ONLY valid JSON\..*?(?=\n|\Z)",
                            "", cleaned_prompt, flags=re.DOTALL | re.IGNORECASE,
                        )
                        cleaned_prompt = cleaned_prompt.replace("{text}", "{context}")
                        cleaned_prompt = cleaned_prompt.replace("\nDocument text:\n{context}", "")
                        qa_prompt = cleaned_prompt
                        qa_prompt += (
                            "\n\nRules:\n"
                            "0. Always answer in the same language as the user's question — Urdu/Saraiki question → Urdu answer, English question → English answer.\n"
                            "1. Answer concisely and directly using the context.\n"
                            "2. If the context contains image/vision descriptions, use them to answer.\n"
                            "3. If the answer is NOT in the context, say \"I cannot find this information in the documents.\"\n"
                            "4. Do NOT make up or hallucinate information.\n"
                            "5. Do NOT output JSON or extract fields, unless the user explicitly requests JSON format.\n"
                            "6. If the context has tables or diagrams, explain what they show.\n"
                        )
                        resume_rank_instruction = (
                            "\n7. The context may include a [Resume Rankings] block with CV evaluation scores. "
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
                    "Answer only from the provided context and structured summary.\n\n"
                    "Rules:\n"
                    "1. Be exact about amounts, dates, and names.\n"
                    "2. Keep currency symbols and percentages intact.\n"
                    "3. If the answer is missing, say you cannot find it in the documents.\n"
                    "4. Do not hallucinate or infer unsupported numbers.\n"
                    "5. Do not output JSON, unless the user explicitly requests JSON format.\n"
                )
            else:
                resume_rank_instruction = (
                    "\n7. The context may include a [Resume Rankings] block with CV evaluation scores. "
                    "Use those scores to rank, compare, or recommend candidates when asked.\n"
                ) if is_resume_query and any(r.get("cv_score") is not None for r in resumes) else ""
                qa_prompt = (
                    f"You are the {agent_label} - a document Q&A assistant for Visibility Docs AI.\n\n"
                    "Your job is to answer the user's question based ONLY on the provided document context below.\n\n"
                    "Rules:\n"
                    "1. Answer concisely and directly using the context.\n"
                    "2. If the context contains image/vision descriptions, use them to answer.\n"
                    "3. If the answer is NOT in the context, say \"I cannot find this information in the documents.\"\n"
                    "4. Do NOT make up or hallucinate information.\n"
                    "5. Do NOT output JSON or extract fields, unless the user explicitly requests JSON format.\n"
                    "6. If the context has tables or diagrams, explain what they show.\n"
                    "7. NEVER output `<document>` XML tags or repeat the document metadata in your response. Speak naturally to the user.\n"
                    "8. Use rich Markdown formatting. Always make labels, headers, and key terms **bold** (e.g., **Vendor Name:** Acme Corp) so the data is easy to read.\n"
                    "9. When performing math or calculating sums, NEVER write out a messy running tally (e.g., do not write A+B=C, C+D=E). \n"
                    "10. When asked to sum or compare data across rows, present the data in a clean Markdown Table, and place the **Grand Total** in bold on a new line below the table.\n"
                    f"{resume_rank_instruction}"
                )

        # Cross-document aggregation instruction (list a field from EVERY file)
        if cross_doc:
            field_str = " ".join(agg_field_terms) if agg_field_terms else "the requested information"
            qa_prompt += (
                f"\n\nIMPORTANT — CROSS-DOCUMENT REQUEST:\n"
                f"The user asked for '{field_str}' from EVERY document (no specific file was selected).\n"
                f"Go through the provided context document-by-document and list the value for each one.\n"
                f"Format as a clear per-document list, e.g.:\n"
                f"  • <Document Title>: <value>\n"
                f"If a particular document does not contain the requested information, write:\n"
                f"  • <Document Title>: not found in this document\n"
                f"Cover ALL documents present in the context. Do not collapse into a single answer; show each document's value separately.\n"
            )

        chat_log.info(f"Built Q&A prompt for agent: {dominant_agent} ({len(qa_prompt)} chars)")

        chat_log.llm_call("llama-3.3-70b-versatile", context_len, len(question), len(sources))
        llm_t0 = time.time()
        is_followup = not is_first
        answer = conversation_service.chat(question, context, session_id=sid, is_followup=is_followup,
                                            system_prompt=qa_prompt)
        chat_log.llm_response(time.time() - llm_t0, len(answer))

        history = conversation_service.get_history(sid)
        self._save_exchange(sid, question, answer, sources, is_first)

        total = time.time() - t_start
        chat_log.chat_end(total, len(sources))
        chat_log.info(f"Answer length: {len(answer)} chars")

        return {
            "answer": answer,
            "sources": sources,
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
