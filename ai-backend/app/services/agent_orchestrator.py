import os
import json
import logging
from .orchestration_logger import get_logger, C
from .resume_transcript_disambiguation import reconcile_resume_transcript_classification

logger = logging.getLogger("visibility-docs")

PROMPTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "prompts")


def _load_prompt(filename: str) -> str:
    path = os.path.join(PROMPTS_DIR, filename)
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
            log = get_logger()
            log.info(f"Prompt loaded: {C.DIM}{filename}{C.RESET} ({len(content)} chars)")
            return content
    return ""


def _load_phase3_prompt(filename: str) -> str:
    return _load_prompt(os.path.join("phase3", filename))


def get_phase3_prompt_for_doc(doc_type: str, agent_type: str = "") -> tuple[str, str]:
    """Resolve skill.md for the *effective* agent only.

    Never loads another specialist's skills when agent_type is clamped
    (e.g. invoice + other_agent must not load finance/invoice/skill.md).
    """
    canonical_agent = DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent") if doc_type else "other_agent"
    agent = agent_type or canonical_agent
    folder_name = agent.replace("_agent", "")

    # Per-type skill under the effective agent only
    if agent != "other_agent" and doc_type and doc_type != "other":
        subfolder_path = os.path.join("phase3", folder_name, doc_type, "skill.md")
        content = _load_prompt(subfolder_path)
        if content:
            print("\n" + "★"*65)
            print(f"[SKILL.MD LOADED] Subfolder Skill File Used: app/prompts/{subfolder_path}")
            print(f"[SKILL.MD LOADED] Category: '{folder_name}' | DocType: '{doc_type}' | Agent: '{agent}'")
            print("★"*65 + "\n")
            return content, subfolder_path

    # Parent agent prompt for the effective agent
    if agent and agent != "other_agent":
        agent_path = os.path.join("phase3", f"{agent}.md")
        content = _load_prompt(agent_path)
        if content:
            print("\n" + "★"*65)
            print(f"[PARENT AGENT PROMPT LOADED] Main Agent File Used: app/prompts/{agent_path}")
            print(f"[PARENT AGENT PROMPT LOADED] Agent: '{agent}'")
            print("★"*65 + "\n")
            return content, agent_path

    fallback_path = os.path.join("phase3", "other.md")
    print("\n" + "★"*65)
    print(f"[FALLBACK PROMPT LOADED] Generic File Used: app/prompts/{fallback_path}")
    print(f"[FALLBACK PROMPT LOADED] Effective agent: '{agent}' (canonical for type was '{canonical_agent}')")
    print("★"*65 + "\n")
    return _load_prompt(fallback_path), fallback_path


def get_agent_from_prompt_path(prompt_path: str) -> str:
    """Extract canonical agent ID from a resolved prompt file path."""
    if not prompt_path:
        return "other_agent"
    path_lower = prompt_path.lower().replace("\\", "/")
    if "finance" in path_lower:
        return "finance_agent"
    if "procurement" in path_lower:
        return "procurement_agent"
    if "hr" in path_lower:
        return "hr_agent"
    if "legal" in path_lower:
        return "legal_agent"
    if "compliance" in path_lower:
        return "compliance_agent"
    return "other_agent"


PHASE3_AGENT_PROMPT_MAP = {
    "finance_agent": os.path.join("phase3", "finance_agent.md"),
    "procurement_agent": os.path.join("phase3", "procurement_agent.md"),
    "hr_agent": os.path.join("phase3", "hr_agent.md"),
    "legal_agent": os.path.join("phase3", "legal_agent.md"),
    "compliance_agent": os.path.join("phase3", "compliance_agent.md"),
    "other_agent": os.path.join("phase3", "other.md"),
}

DOCUMENT_TO_PHASE3_AGENT = {
    # Finance
    "invoice": "finance_agent",
    "financial_statement": "finance_agent",
    "expense_report": "finance_agent",
    "payment_receipt": "finance_agent",
    "tax_document": "finance_agent",
    "bank_statement": "finance_agent",
    "budget": "finance_agent",
    # HR
    "employee_record": "hr_agent",
    "hr_document": "hr_agent",
    "offer_letter": "hr_agent",
    "experience_letter": "hr_agent",
    "employment_contract": "hr_agent",
    "leave_application": "hr_agent",
    "payroll": "hr_agent",
    "attendance": "hr_agent",
    "performance_review": "hr_agent",
    "training_certificate": "hr_agent",
    "resume": "hr_agent",
    "transcript": "hr_agent",
    # Legal
    "contract": "legal_agent",
    "agreement": "legal_agent",
    "nda": "legal_agent",
    "service_agreement": "legal_agent",
    "lease_agreement": "legal_agent",
    "vendor_contract": "legal_agent",
    # Procurement
    "purchase_order": "procurement_agent",
    "quotation": "procurement_agent",
    "supplier_agreement": "procurement_agent",
    "vendor_list": "procurement_agent",
    "rfq": "procurement_agent",
    "delivery_note": "procurement_agent",
    "procurement_request": "procurement_agent",
    # Compliance
    "sop": "compliance_agent",
    "audit_report": "compliance_agent",
    "quality_report": "compliance_agent",
    "certificate": "compliance_agent",
    "maintenance_report": "compliance_agent",
    "engineering_drawing": "compliance_agent",
    "inspection_report": "compliance_agent",
    "safety_manual": "compliance_agent",
    "iso_document": "compliance_agent",
    "compliance_form": "compliance_agent",
    "regulatory_document": "compliance_agent",
    "other": "other_agent",
}

VALID_PHASE3_AGENTS = set(PHASE3_AGENT_PROMPT_MAP.keys())

HEURISTIC_RULES = [
    (
        "finance_agent",
        "invoice",
        [
            "invoice", "subtotal", "tax", "total", "amount due", "due date",
            "invoice #", "inv-", "tax invoice", "bill to", "ship to",
            "payment terms", "net 30", "unit price", "quantity", "line items",
            "gst", "grand total",
            "رسید", "بل", "ٹیکس", "رقم", "واجب الادا", "تاریخ", "انوائس",
        ],
    ),
    (
        "finance_agent",
        "financial_statement",
        [
            "balance sheet", "income statement", "profit & loss", "p&l",
            "cash flow", "assets", "liabilities", "equity", "revenue",
            "expenses", "net profit", "gross margin", "operating income",
            "financial summary", "financial statement",
            "مالی گوشوارہ", "آمدنی", "اخراجات", "منافع",
        ],
    ),
    (
        "procurement_agent",
        "purchase_order",
        [
            "purchase order", "po number", "po-", "order date", "supplier",
            "vendor", "delivery date", "ship to", "requisition",
            "payment terms", "net 30", "order quantity", "buyer",
            "آرڈر", "خریداری", "سپلائر", "ونڈر",
        ],
    ),
    (
        "procurement_agent",
        "quotation",
        [
            "quotation", "quote", "quotation #", "price list", "valid until",
            "offer", "estimate", "proposal", "unit price",
            "کوٹیشن", "اقتباس", "قیمت", "پیشکش",
        ],
    ),
    (
        "hr_agent",
        "hr_document",
        [
            "employee", "salary", "appraisal", "leave application",
            "offer letter", "hr policy", "payroll", "designation",
            "department", "training", "manager", "employee id",
            "performance review", "appointment letter",
            "ملازم", "تنخواہ", "چھٹی", "عہدہ", "شعبہ",
        ],
    ),
    (
        "legal_agent",
        "contract",
        [
            "contract", "agreement", "party a", "party b", "nda",
            "governing law", "jurisdiction", "clause", "termination",
            "renewal", "signature", "whereas", "in witness whereof",
            "indemnity", "confidentiality", "lease agreement",
            "service agreement", "binding", "executed",
            "معاہدہ", "کنٹریکٹ", "دستخط", "شرائط", "قانون",
        ],
    ),
    (
        "hr_agent",
        "resume",
        [
            "resume", "cv", "curriculum vitae", "work experience",
            "education", "skills", "professional summary",
            "employment history", "qualifications", "achievements",
            "certifications", "objective",
            "سوانح عمری", "تعلیم", "تجربہ", "مہارتیں", "اسناد",
        ],
    ),
    (
        "compliance_agent",
        "audit_report",
        [
            "audit report", "audit findings", "observations",
            "non-conformance", "corrective action", "finding",
            "critical", "major", "minor", "recommendations",
            "auditor", "scope", "compliance status",
            "آڈٹ", "جانچ", "مشاہدات", "سفارشات",
        ],
    ),
    (
        "compliance_agent",
        "quality_report",
        [
            "quality report", "quality control", "qc", "quality assurance",
            "qa", "inspection report", "defect", "pass rate", "fail rate",
            "specification", "tolerance", "quality metrics",
            "کوالٹی", "معیار", "جانچ", "نقص",
        ],
    ),
    (
        "compliance_agent",
        "certificate",
        [
            "certificate", "certification", "certificate of",
            "this certifies", "cert no", "certificate of analysis",
            "certificate of origin", "certificate of compliance",
            "iso certificate", "certifying body",
            "سند", "تصدیق", "سرٹیفکیٹ",
        ],
    ),
    (
        "compliance_agent",
        "maintenance_report",
        [
            "maintenance", "service report", "repair", "equipment",
            "downtime", "technician", "work order", "breakdown",
            "fault", "servicing", "preventive maintenance",
            "مرمت", "دیکھ بھال", "سروس", "خرابی",
        ],
    ),
    (
        "compliance_agent",
        "sop",
        [
            "standard operating procedure", "sop", "procedure",
            "steps", "instructions", "protocol", "step-by-step",
            "operating procedure", "process guide",
            "طریقہ کار", "ہدایات", "مراحل", "پروٹوکول",
        ],
    ),
    (
        "compliance_agent",
        "engineering_drawing",
        [
            "drawing", "dwg", "schematic", "dimension", "tolerance",
            "scale", "revision", "title block", "part no",
            "drawn by", "checked by", "blueprint", "datum",
            "ڈرائنگ", "خاکہ", "پیمائش", "طول و عرض",
        ],
    ),
    (
        "hr_agent",
        "transcript",
        [
            "official transcript",
            "academic transcript",
            "transcript of records",
            "grade point average",
            "cgpa",
            "sgpa",
            "marksheet",
            "marks sheet",
            "result card",
            "controller of examinations",
            "registrar",
            "roll number",
            "roll no",
            "course code",
            "credit hours",
            "credits earned",
            "semester result",
            "grade report",
        ],
    ),
]


class ClassificationAgent:
    def _heuristic_classify(self, text: str, filename: str = "") -> dict:
        haystack = f"{filename}\n{text}".lower()
        best = None
        best_score = 0

        for agent_type, doc_type, keywords in HEURISTIC_RULES:
            score = sum(1 for keyword in keywords if keyword in haystack)
            if score > best_score:
                best = (agent_type, doc_type)
                best_score = score

        if not best:
            return {
                "document_type": "other",
                "agent_type": "other_agent",
                "confidence": 0.15,
                "reasoning": "Heuristic fallback did not find a strong match",
                "language": "en",
                "estimated_quality": "low",
            }

        agent_type, doc_type = best
        confidence = min(0.95, 0.35 + (best_score * 0.12))
        return reconcile_resume_transcript_classification(
            {
            "document_type": doc_type,
            "agent_type": agent_type,
            "confidence": confidence,
            "reasoning": f"Heuristic fallback matched {best_score} keyword groups for {agent_type}",
            "language": "en",
            "estimated_quality": "medium",
        },
            text,
            filename,
        )

    def classify(self, text: str, filename: str = "") -> dict:
        from .groq_service import groq_service

        log = get_logger()
        log.info(f"Text: {len(text)} chars")
        prompt_template = _load_prompt("classification_agent.md")
        if not prompt_template:
            log.warn("No prompt template found, using heuristic fallback")
            return self._heuristic_classify(text, filename)

        prompt = prompt_template.replace("{text}", text[:6000]).replace("{filename}", filename)
        log.info(f"Prompt preview: {C.DIM}{prompt[:200].replace(chr(10), ' ')}...{C.RESET}")
        log.info(f"Input text: {C.DIM}{len(text)} chars, filename='{filename}'{C.RESET}")
        try:
            t0 = __import__("time").time()
            primary = None
            try:
                from .provider_manager import provider_manager
                primary = provider_manager.get_primary_provider()
            except Exception:
                primary = None
            provider_name = primary.provider if primary else "groq"
            log.info(f"Calling active AI provider ({provider_name}) for classification...")
            raw_response = groq_service.chat_with_active_providers(
                [{"role": "user", "content": prompt}],
                temperature=0.05,
                max_tokens=1024,
                prefer_fast_groq=True,
            )
            import re
            scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
            scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else ""
            
            result = groq_service._parse_json(raw_response, {})
            duration = __import__("time").time() - t0
            if not result:
                log.warn(f"LLM returned empty ({duration:.1f}s), falling back to heuristic")
                return self._heuristic_classify(text, filename)
            doc_type = str(result.get("document_type", "other")).lower().replace(" ", "_")
            agent_type = str(result.get("phase3_agent", "")).lower().replace(" ", "_")

            from ..models.schemas import DocumentType
            valid_types = {t.value for t in DocumentType}
            if doc_type not in valid_types:
                log.warn(f"Invalid doc_type '{doc_type}' from LLM, falling back to 'other'")
                doc_type = "other"

            if agent_type not in VALID_PHASE3_AGENTS:
                old_agent = agent_type
                agent_type = DOCUMENT_TO_PHASE3_AGENT.get(doc_type, "other_agent")
                log.warn(f"Invalid agent '{old_agent}' from LLM → mapped to '{agent_type}' for '{doc_type}'")

            result_data = {
                "document_type": doc_type,
                "agent_type": agent_type,
                "confidence": float(result.get("confidence", 0)),
                "reasoning": scratchpad_text or result.get("reasoning", ""),
                "language": result.get("language", "en"),
                "estimated_quality": result.get("estimated_quality", "medium"),
            }
            log.result("Result", f"type={doc_type}, agent={agent_type}, conf={result_data['confidence']:.2f}, time={duration:.1f}s", C.GREEN)
            return reconcile_resume_transcript_classification(result_data, text, filename)
        except Exception as e:
            log.warn(f"LLM error: {e}, falling back to heuristic")
            logger.warning(f"Classification agent fallback used: {e}")
            fallback = self._heuristic_classify(text, filename)
            fallback["reasoning"] = f"{fallback['reasoning']}; LLM fallback reason: {e}"
            return reconcile_resume_transcript_classification(fallback, text, filename)


def _clean_repetitive_ocr(text: str) -> str:
    """Strip repetitive OCR loops to keep token count compact."""
    if not text:
        return ""
    lines = text.split("\n")
    cleaned = []
    seen = set()
    repeat_count = 0
    for line in lines:
        stripped = line.strip()
        if not stripped:
            cleaned.append(line)
            continue
        # Skip OCR vision artifact repetition loops
        if "looking at" in stripped.lower() or "transcribe" in stripped.lower() or "crop" in stripped.lower():
            if stripped in seen:
                continue
        if stripped in seen:
            repeat_count += 1
            if repeat_count > 3:
                continue
        else:
            repeat_count = 0
            seen.add(stripped)
        cleaned.append(line)
    return "\n".join(cleaned)


def _heuristic_extract_fields(text: str, document_type: str) -> dict:
    """Regex-based fallback extraction when LLM hits rate limit or payload too large."""
    import re
    data = {}
    if not text:
        return data

    inv_num = re.search(r"(?:invoice\s*#?|inv\s*#?|order\s*#?|bill\s*#?)\s*:?\s*([A-Za-z0-9\-_]+)", text, re.IGNORECASE)
    if inv_num:
        data["invoice_number"] = inv_num.group(1)
        data["document_number"] = inv_num.group(1)

    inv_date = re.search(r"(?:date|invoice\s*date)\s*:?\s*(\d{1,4}[\/\.-]\d{1,4}[\/\.-]\d{1,4})", text, re.IGNORECASE)
    if inv_date:
        data["invoice_date"] = inv_date.group(1)

    total_amt = re.search(r"(?:total|net\s*amount|amount\s*due|grand\s*total)\s*:?\s*(?:rs\.?|pkr|\$|eur|usd)?\s*([\d,]+\.?\d*)", text, re.IGNORECASE)
    if total_amt:
        data["total_amount"] = total_amt.group(1)

    vendor = re.search(r"^(?:company|vendor|from)?\s*([A-Z0-9\s\.\-]{3,40})(?=\n|\r)", text, re.MULTILINE)
    if vendor:
        data["vendor_name"] = vendor.group(1).strip()

    return data


class CategoryExtractionAgent:
    def extract(self, text: str, document_type: str, agent_type: str = "") -> dict:
        from .groq_service import groq_service

        agent = agent_type or DOCUMENT_TO_PHASE3_AGENT.get(document_type, "other_agent")
        log = get_logger()
        log.info(f"DocType: {document_type} | Text: {len(text if text else '')} chars")

        raw_clean_text = (text or "").strip()
        clean_text = _clean_repetitive_ocr(raw_clean_text)
        if not clean_text or clean_text == "[OCR failed]" or len(clean_text) < 15:
            log.warn(f"Empty or failed OCR text ({len(clean_text)} chars) — skipping extraction LLM call to prevent field leakage")
            return {
                "extracted_data": {},
                "scratchpad": "Document text is empty or OCR failed.",
                "confidence": 0.0,
                "field_confidence": {},
                "agent_type": agent,
            }

        prompt_template, prompt_path = get_phase3_prompt_for_doc(document_type, agent)
        if prompt_path:
            log.info(f"LOADED PROMPT FILE: {prompt_path} for agent '{agent}'")
        if not prompt_template:
            log.warn(f"No prompt found for agent '{agent}' / type '{document_type}', returning empty")
            return {"extracted_data": {}, "confidence": 0.0}

        prompt_base = prompt_template.replace("{text}", "")
        prompt_base += "\n\nCRITICAL INSTRUCTION: You MUST extract EVERY SINGLE line item, row, and record present in the text. DO NOT truncate, summarize, or stop early to save space."
        prompt_base += "\nCRITICAL INSTRUCTION: You MUST format your response exactly as follows. First, write out your reasoning inside a `<scratchpad>` XML block. Then, output the final JSON block."
        prompt_base += "\nCRITICAL INSTRUCTION [ANTI-HALLUCINATION]: You MUST NOT invent, guess, or hallucinate ANY data. If a specific field is NOT explicitly written in the document text, output `null` or `\"\"`."

        # Cap text size to ~8,000 chars (~2,000 tokens) to prevent Groq 6,000 TPM limit 413 error
        doc_slice = clean_text[:8000]
        prompt = prompt_base + f"\n\n<document>\n{doc_slice}\n</document>"

        log.info(f"Prompt loaded ({C.DIM}{prompt_path}, {len(prompt_template)} chars{C.RESET})")
        log.info(f"Prompt preview: {C.DIM}{prompt[:200].replace(chr(10), ' ')}...{C.RESET}")

        try:
            t0 = __import__("time").time()
            primary = None
            try:
                from .provider_manager import provider_manager
                primary = provider_manager.get_primary_provider()
            except Exception:
                primary = None
            provider_name = primary.provider if primary else "groq"
            model_name = (primary.model if primary else "") or "default"
            log.info(f"Calling active AI provider ({provider_name}/{model_name}) for extraction...")
            raw_response = groq_service.chat_with_active_providers(
                [{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=2500,
                prefer_fast_groq=True,
            )

            import re
            scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
            scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else ""

            result = groq_service._parse_json(raw_response, {})
            # Escalate once with truncated prompt if first pass was weak (same active providers)
            if (not isinstance(result, dict) or len(result) < 2) and clean_text:
                try:
                    log.warn("First extraction pass returned weak JSON — retrying with shorter document slice")
                    short_doc_slice = clean_text[:4000]
                    short_prompt = prompt_base + f"\n\n<document>\n{short_doc_slice}\n</document>"
                    raw_response = groq_service.chat_with_active_providers(
                        [{"role": "user", "content": short_prompt}],
                        temperature=0.0,
                        max_tokens=3000,
                        prefer_fast_groq=False,
                    )
                    scratchpad_match = re.search(r"<scratchpad>(.*?)</scratchpad>", raw_response, re.DOTALL)
                    scratchpad_text = scratchpad_match.group(1).strip() if scratchpad_match else scratchpad_text
                    result = groq_service._parse_json(raw_response, {})
                except Exception as escalate_err:
                    log.warn(f"Extraction retry failed: {escalate_err}")

            duration = __import__("time").time() - t0
            field_confidence = result.pop("_field_confidence", {}) if isinstance(result, dict) else {}
            avg_confidence = 0.7
            if field_confidence:
                scores = [v for v in field_confidence.values() if isinstance(v, (int, float))]
                avg_confidence = sum(scores) / len(scores) if scores else 0.7
            fields = list(result.keys()) if isinstance(result, dict) else []
            log.result("Fields", f"{fields[:8]}", C.GREEN)
            log.result("Confidence", f"{avg_confidence:.2f}", C.GREEN)
            log.result("Duration", f"{duration:.1f}s", C.DIM)
            return {
                "extracted_data": result if isinstance(result, dict) else {},
                "scratchpad": scratchpad_text,
                "confidence": avg_confidence,
                "field_confidence": field_confidence,
                "agent_type": agent,
                "prompt_path": prompt_path,
            }
        except Exception as e:
            log.fail(f"Extraction failed: {e}, falling back to local heuristic extraction")
            logger.error(f"Category extraction agent ({document_type}) error: {e}")
            fallback_data = _heuristic_extract_fields(clean_text, document_type)
            return {
                "extracted_data": fallback_data,
                "scratchpad": f"LLM rate limit fallback: {e}",
                "confidence": 0.5 if fallback_data else 0.0,
                "field_confidence": {},
                "agent_type": agent,
            }


classification_agent = ClassificationAgent()
category_agents = CategoryExtractionAgent()
