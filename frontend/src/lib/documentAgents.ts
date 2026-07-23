export const DOC_TYPE_TO_AGENT: Record<string, string> = {
    // Finance
    invoice: "finance_agent",
    financial_statement: "finance_agent",
    expense_report: "finance_agent",
    payment_receipt: "finance_agent",
    tax_document: "finance_agent",
    bank_statement: "finance_agent",
    budget: "finance_agent",
    // HR
    employee_record: "hr_agent",
    hr_document: "hr_agent",
    offer_letter: "hr_agent",
    employment_contract: "hr_agent",
    leave_application: "hr_agent",
    payroll: "hr_agent",
    attendance: "hr_agent",
    performance_review: "hr_agent",
    training_certificate: "hr_agent",
    resume: "hr_agent",
    transcript: "hr_agent",
    // Legal
    contract: "legal_agent",
    agreement: "legal_agent",
    nda: "legal_agent",
    service_agreement: "legal_agent",
    lease_agreement: "legal_agent",
    vendor_contract: "legal_agent",
    // Procurement
    purchase_order: "procurement_agent",
    po: "procurement_agent",
    quotation: "procurement_agent",
    supplier_agreement: "procurement_agent",
    vendor_list: "procurement_agent",
    rfq: "procurement_agent",
    delivery_note: "procurement_agent",
    procurement_request: "procurement_agent",
    // Compliance
    sop: "compliance_agent",
    audit_report: "compliance_agent",
    quality_report: "compliance_agent",
    certificate: "compliance_agent",
    maintenance_report: "compliance_agent",
    engineering_drawing: "compliance_agent",
    inspection_report: "compliance_agent",
    safety_manual: "compliance_agent",
    iso_document: "compliance_agent",
    compliance_form: "compliance_agent",
    regulatory_document: "compliance_agent",
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
    invoice: "Invoice",
    financial_statement: "Financial statement",
    expense_report: "Expense report",
    payment_receipt: "Payment receipt",
    tax_document: "Tax document",
    bank_statement: "Bank statement",
    budget: "Budget",
    employee_record: "Employee record",
    hr_document: "HR document",
    offer_letter: "Offer letter",
    employment_contract: "Employment contract",
    leave_application: "Leave application",
    payroll: "Payroll",
    attendance: "Attendance",
    performance_review: "Performance review",
    training_certificate: "Training certificate",
    resume: "Resume / CV",
    transcript: "Transcript",
    contract: "Contract",
    agreement: "Agreement",
    nda: "NDA",
    service_agreement: "Service agreement",
    lease_agreement: "Lease agreement",
    vendor_contract: "Vendor contract",
    purchase_order: "Purchase order",
    quotation: "Quotation",
    supplier_agreement: "Supplier agreement",
    vendor_list: "Vendor list",
    rfq: "RFQ",
    delivery_note: "Delivery note",
    procurement_request: "Procurement request",
    sop: "SOP",
    audit_report: "Audit report",
    quality_report: "Quality report",
    certificate: "Certificate",
    maintenance_report: "Maintenance report",
    engineering_drawing: "Engineering drawing",
    inspection_report: "Inspection report",
    safety_manual: "Safety manual",
    iso_document: "ISO document",
    compliance_form: "Compliance form",
    regulatory_document: "Regulatory document",
    unclassified: "Unclassified",
    other: "Other",
};

/** Options for search / filter dropdowns */
export const DOC_TYPE_FILTER_OPTIONS = [
    { value: "", label: "All types" },
    ...Object.entries(DOC_TYPE_LABELS)
        .filter(([k]) => k !== "unclassified")
        .map(([value, label]) => ({ value, label })),
];

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
    if (name.includes("nda") || name.includes("non-disclosure")) return "nda";
    if (name.includes("contract")) return "contract";
    if (name.includes("quotation") || name.includes("quote")) return "quotation";
    if (name.includes("purchase") || /\bpo\b/.test(name)) return "purchase_order";
    if (name.includes("rfq")) return "rfq";
    if (name.includes("certificate")) return "certificate";
    if (name.includes("transcript")) return "transcript";
    if (name.includes("payroll")) return "payroll";
    if (name.includes("sop")) return "sop";
    if (name.includes("bank")) return "bank_statement";
    return null;
}
