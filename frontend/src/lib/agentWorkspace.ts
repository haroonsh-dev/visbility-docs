import type { AnalyticsAgentId } from "@/lib/documentAgents";
import {
    Briefcase,
    FileQuestion,
    MessageSquare,
    Scale,
    ShieldCheck,
    Users,
    Wallet,
    type LucideIcon,
} from "lucide-react";

export type AgentWorkspaceMeta = {
    id: AnalyticsAgentId;
    shortName: string;
    tagline: string;
    icon: LucideIcon;
    /** Sidebar + hero accent */
    accent: string;
    accentMuted: string;
};

export const AGENT_WORKSPACE_META: Record<AnalyticsAgentId, AgentWorkspaceMeta> = {
    finance_agent: {
        id: "finance_agent",
        shortName: "Finance",
        tagline: "AP, AR, aging, and spend across your invoice portfolio",
        icon: Wallet,
        accent: "var(--vb-blue-bright)",
        accentMuted: "rgba(56,182,255,0.12)",
    },
    hr_agent: {
        id: "hr_agent",
        shortName: "HR",
        tagline: "Hiring, people records, leave, payroll, and workforce analytics",
        icon: Users,
        accent: "#7c3aed",
        accentMuted: "rgba(124,58,237,0.08)",
    },
    legal_agent: {
        id: "legal_agent",
        shortName: "Legal",
        tagline: "Contracts, risk flags, clauses, and obligations",
        icon: Scale,
        accent: "#a78bfa",
        accentMuted: "rgba(167,139,250,0.12)",
    },
    compliance_agent: {
        id: "compliance_agent",
        shortName: "Compliance",
        tagline: "Certificates, audits, findings, and regulatory readiness",
        icon: ShieldCheck,
        accent: "#fbbf24",
        accentMuted: "rgba(251,191,36,0.12)",
    },
    procurement_agent: {
        id: "procurement_agent",
        shortName: "Procurement",
        tagline: "POs, suppliers, RFQs, and invoice matching",
        icon: Briefcase,
        accent: "#ea580c",
        accentMuted: "rgba(234,88,12,0.08)",
    },
    other_agent: {
        id: "other_agent",
        shortName: "General",
        tagline: "Cross-document search and mixed file types",
        icon: FileQuestion,
        accent: "#94a3b8",
        accentMuted: "rgba(148,163,184,0.12)",
    },
};

/** Short chat prompts shown as chips on the workspace (not capability manifest). */
export const AGENT_QUICK_ASKS: Record<AnalyticsAgentId, string[]> = {
    finance_agent: [
        "Show vendor totals",
        "Chart AP aging",
        "Monthly invoice trend",
        "Generate finance report",
    ],
    hr_agent: [
        "Certificates expiring soon?",
        "Who is on leave?",
        "Show CV score ranking",
        "Generate HR report",
    ],
    compliance_agent: [
        "Chart certificate expiry",
        "Audit findings by severity",
        "Compliance status mix",
        "Generate compliance report",
    ],
    legal_agent: [
        "Chart risk flags",
        "Show clause type mix",
        "Contracts with missing data",
        "Summarize legal portfolio",
    ],
    procurement_agent: [
        "Chart spend by supplier",
        "PO vs invoice amounts",
        "Show procurement summary",
        "List unmatched POs",
    ],
    other_agent: [
        "Show document type mix",
        "List files in scope",
        "Summarize these documents",
        "Compare key files",
    ],
};

/** One-click power actions (reports & deep tasks) */
export const AGENT_POWER_ACTIONS: Record<
    AnalyticsAgentId,
    Array<{ id: string; label: string; prompt: string; description: string }>
> = {
    finance_agent: [
        {
            id: "report",
            label: "Finance report PDF",
            prompt: "Generate finance report",
            description: "Printable AP/AR summary",
        },
        {
            id: "aging",
            label: "AP aging analysis",
            prompt: "Chart AP aging and summarize overdue vendors",
            description: "Overdue payables focus",
        },
        {
            id: "vendors",
            label: "Top vendors",
            prompt: "Show vendor totals ranked by spend",
            description: "AP concentration",
        },
    ],
    hr_agent: [
        {
            id: "report",
            label: "HR report PDF",
            prompt: "Generate HR report",
            description: "Workforce snapshot",
        },
        {
            id: "shortlist",
            label: "CV shortlist",
            prompt: "Export shortlist top 10 candidates",
            description: "Ranked CV scores",
        },
        {
            id: "candidate_email",
            label: "Email shortlist",
            prompt: "Email top 5 candidates interview invite",
            description: "Templated outreach to ranked CVs",
        },
        {
            id: "expiry",
            label: "Cert expiry scan",
            prompt: "Any certificates expiring in the next 90 days?",
            description: "Compliance risk for HR certs",
        },
    ],
    compliance_agent: [
        {
            id: "report",
            label: "Compliance report",
            prompt: "Generate compliance report",
            description: "Full audit posture PDF",
        },
        {
            id: "ncr",
            label: "NCR letter",
            prompt: "Generate NCR letter for top critical finding. Company Visibility Bots, standard ISO 9001",
            description: "Non-conformance notice",
        },
        {
            id: "evidence",
            label: "Evidence pack",
            prompt: "Generate audit evidence pack for all compliance documents in scope",
            description: "Pre-audit bundle",
        },
        {
            id: "gaps",
            label: "Framework gaps",
            prompt: "What compliance documents are missing?",
            description: "Required doc types",
        },
    ],
    legal_agent: [
        {
            id: "risk",
            label: "Risk summary",
            prompt: "Chart risk flags by document and summarize",
            description: "Contract risk heatmap",
        },
        {
            id: "missing",
            label: "Missing clauses",
            prompt: "Show chart all missing data in contracts",
            description: "Gap analysis",
        },
        {
            id: "obligations",
            label: "Obligations",
            prompt: "List key obligations across contracts",
            description: "Deadline tracking",
        },
    ],
    procurement_agent: [
        {
            id: "spend",
            label: "Spend analysis",
            prompt: "Chart spend by supplier and summarize",
            description: "Supplier concentration",
        },
        {
            id: "match",
            label: "3-way match",
            prompt: "Run 3-way PO matching for all documents in scope",
            description: "PO · delivery · invoice gaps",
        },
        {
            id: "quotes",
            label: "Compare quotes",
            prompt: "Compare vendor quotes and rank by price",
            description: "RFQ bid comparison",
        },
        {
            id: "summary",
            label: "Procurement summary",
            prompt: "Show procurement summary for all POs",
            description: "Full order register",
        },
    ],
    other_agent: [
        {
            id: "mix",
            label: "Document mix",
            prompt: "Show document type mix",
            description: "What you have uploaded",
        },
        {
            id: "summary",
            label: "Summarize all",
            prompt: "Summarize all documents in scope",
            description: "Cross-file overview",
        },
    ],
};

export function getAgentWorkspaceMeta(agentId: string): AgentWorkspaceMeta | null {
    if (agentId in AGENT_WORKSPACE_META) {
        return AGENT_WORKSPACE_META[agentId as AnalyticsAgentId];
    }
    return null;
}

export function agentWorkspacePath(agentId: string): string {
    return `/agents/${encodeURIComponent(agentId)}`;
}

export function agentChatPath(agentId: string): string {
    return `/chat?agent=${encodeURIComponent(agentId)}&new=1`;
}

/** @deprecated use agentWorkspacePath */
export const agentDashboardPath = agentWorkspacePath;
