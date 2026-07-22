export const DOC_TYPE_TO_AGENT: Record<string, string> = {
    invoice: "finance_agent",
    purchase_order: "procurement_agent",
    po: "procurement_agent",
    hr_document: "hr_agent",
    resume: "hr_agent",
    transcript: "hr_agent",
    contract: "legal_agent",
    sop: "compliance_agent",
    audit_report: "compliance_agent",
    quality_report: "compliance_agent",
    certificate: "compliance_agent",
    maintenance_report: "compliance_agent",
    engineering_drawing: "compliance_agent",
    other: "other_agent",
};

export const AGENT_OPTIONS = [
    { value: "", label: "Auto (from document type)" },
    { value: "finance_agent", label: "Finance Agent" },
    { value: "procurement_agent", label: "Procurement Agent" },
    { value: "hr_agent", label: "HR Agent" },
    { value: "legal_agent", label: "Legal Agent" },
    { value: "compliance_agent", label: "Compliance Agent" },
    { value: "other_agent", label: "Other Agent" },
];

export const AGENT_FILTER_OPTIONS = [
    { value: "", label: "All agents" },
    ...AGENT_OPTIONS.filter((o) => o.value),
];

export const DOC_TYPE_LABELS: Record<string, string> = {
    resume: "Resume / CV",
    hr_document: "HR document",
    invoice: "Invoice",
    purchase_order: "Purchase order",
    quotation: "Quotation",
    financial_statement: "Financial statement",
    contract: "Contract",
    transcript: "Transcript",
    audit_report: "Audit report",
    quality_report: "Quality report",
    certificate: "Certificate",
    sop: "SOP",
    maintenance_report: "Maintenance report",
    engineering_drawing: "Engineering drawing",
    unclassified: "Unclassified",
    other: "Other",
};

export function docTypeLabel(type: string): string {
    return DOC_TYPE_LABELS[type] || type.replace(/_/g, " ");
}

export function agentLabel(agent: string): string {
    const found = AGENT_OPTIONS.find((o) => o.value === agent);
    return found?.label || agent.replace(/_/g, " ");
}

export function resolveDocAgent(doc: {
    phase3_agent?: string | null;
    document_type?: string | null;
    classification?: string | null;
    metadata?: { phase3Agent?: string } | null;
}): string {
    const metaAgent = doc.metadata?.phase3Agent;
    if (metaAgent) return metaAgent;
    if (doc.phase3_agent) return doc.phase3_agent;
    const docType = doc.document_type || doc.classification || "";
    return DOC_TYPE_TO_AGENT[docType] || "other_agent";
}

export function inferDocTypeFromFilename(filename: string): string | null {
    const name = filename.toLowerCase();
    if (/\b(cv|resume|curriculum)\b/.test(name)) return "resume";
    if (name.includes("invoice")) return "invoice";
    if (name.includes("contract")) return "contract";
    if (name.includes("purchase") || /\bpo\b/.test(name)) return "purchase_order";
    return null;
}
