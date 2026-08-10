import { inferDocTypeFromFilename } from "@/lib/documentAgents";

/** Doc types that should appear in finance charts when tied to chat scope. */
const FINANCE_ANALYTICS_TYPES = new Set([
    "invoice",
    "financial_statement",
    "expense_report",
    "payment_receipt",
    "tax_document",
    "bank_statement",
    "budget",
    "purchase_order",
    "po",
    "receipt",
]);

const EXCLUDED_TYPES = new Set([
    "offer_letter",
    "resume",
    "transcript",
    "employment_contract",
    "leave_application",
]);

type ScopeDoc = {
    documentId: string;
    originalFilename?: string;
    classification?: string | null;
    mimeType?: string | null;
};

export function isFinanceAnalyticsDoc(doc: ScopeDoc): boolean {
    const c = String(doc.classification || "").toLowerCase();
    if (EXCLUDED_TYPES.has(c)) return false;
    if (FINANCE_ANALYTICS_TYPES.has(c)) return true;
    const inferred = inferDocTypeFromFilename(doc.originalFilename || "");
    if (inferred && FINANCE_ANALYTICS_TYPES.has(inferred)) return true;
    const name = (doc.originalFilename || "").toLowerCase();
    if (/\.xlsx?$/i.test(doc.originalFilename || "")) {
        return FINANCE_ANALYTICS_TYPES.has(c) && c !== "quotation";
    }
    if (/invoice|inv[_\-.]|bill|receipt|expense|statement/i.test(name)) return true;
    return false;
}

export function filterFinanceAnalyticsDocIds(docs: ScopeDoc[], ids: string[]): string[] {
    const set = new Set(ids);
    return docs.filter((d) => set.has(d.documentId) && isFinanceAnalyticsDoc(d)).map((d) => d.documentId);
}
