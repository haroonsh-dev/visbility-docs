import type { ChatVisualSpec } from "@/types/chatVisuals";
import type { PortfolioFile } from "@/lib/agentWorkspaceKpis";
import type { WorkspaceCoverage, WorkspaceMetrics } from "@/lib/agentWorkspaceInsights";
import type { AgentVaultDoc } from "@/hooks/useAgentPortfolio";
import { docTypeLabel, inferDocTypeFromFilename } from "@/lib/documentAgents";

export type HrPillarId = "hiring" | "people" | "time" | "pay";

export type HrPillar = {
    id: HrPillarId;
    label: string;
    subtitle: string;
    count: number;
    chartView?: string;
    askPrompt: string;
    status: "ready" | "partial" | "empty";
};

export type HrPriority = {
    id: string;
    title: string;
    detail: string;
    tone: "warn" | "info";
    prompt?: string;
    chartView?: string;
};

export type HrWorkforceSnapshot = {
    headline: string;
    subline: string;
    pillars: HrPillar[];
    priorities: HrPriority[];
    docMix: Array<{ type: string; label: string; count: number }>;
    stats: {
        totalFiles: number;
        cvs: number;
        cvsScored: number;
        topCvScore?: number;
        certsTracked: number;
        certsExpiring: number;
    };
};

const PILLAR_TYPES: Record<HrPillarId, string[]> = {
    hiring: ["resume", "offer_letter", "experience_letter", "joining_letter", "internship_letter", "hr_shortlist"],
    people: ["employee_record", "employment_contract", "hr_document", "promotion_letter", "relieving_letter"],
    time: ["leave_application", "attendance"],
    pay: ["payroll", "performance_review", "training_certificate", "transcript"],
};

const PILLAR_META: Record<HrPillarId, { label: string; subtitle: string; chartView?: string; askPrompt: string }> = {
    hiring: {
        label: "Hiring & CVs",
        subtitle: "Recruitment pipeline and candidate scores",
        chartView: "scores",
        askPrompt: "Show CV score ranking",
    },
    people: {
        label: "People records",
        subtitle: "Employees, contracts, and HR files",
        chartView: "directory",
        askPrompt: "Show employee directory",
    },
    time: {
        label: "Leave & attendance",
        subtitle: "Time off and presence tracking",
        chartView: "leave",
        askPrompt: "Who is on leave?",
    },
    pay: {
        label: "Payroll & development",
        subtitle: "Pay runs, reviews, certs, transcripts",
        chartView: "payroll",
        askPrompt: "Summarize payroll by department",
    },
};

function resolveDocType(doc: AgentVaultDoc): string {
    const cls = String(doc.classification || "").trim().toLowerCase();
    if (cls && cls !== "unclassified" && cls !== "other") {
        return cls === "cv" || cls === "curriculum_vitae" ? "resume" : cls;
    }
    return inferDocTypeFromFilename(doc.originalFilename || "") || "hr_document";
}

function countByPillar(vaultDocs: AgentVaultDoc[]): Record<HrPillarId, number> {
    const counts: Record<HrPillarId, number> = { hiring: 0, people: 0, time: 0, pay: 0 };
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        for (const [pillar, types] of Object.entries(PILLAR_TYPES) as [HrPillarId, string[]][]) {
            if (types.includes(type)) counts[pillar]++;
        }
    }
    return counts;
}

function docMix(vaultDocs: AgentVaultDoc[]): HrWorkforceSnapshot["docMix"] {
    const counts = new Map<string, number>();
    for (const doc of vaultDocs) {
        const type = resolveDocType(doc);
        counts.set(type, (counts.get(type) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([type, count]) => ({ type, label: docTypeLabel(type), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
}

function cvStats(visuals: ChatVisualSpec[], vaultDocs: AgentVaultDoc[]) {
    const cvs = vaultDocs.filter((d) => resolveDocType(d) === "resume").length;
    const scoreVisual = visuals.find((v) => /score|cv/i.test(v.title));
    const key = scoreVisual?.series[0]?.key;
    const scored = scoreVisual?.data.length ?? 0;
    let topCvScore: number | undefined;
    if (key && scoreVisual?.data.length) {
        topCvScore = Math.max(...scoreVisual.data.map((row) => Number(row[key] || 0)));
    }
    return { cvs, cvsScored: scored, topCvScore: topCvScore && Number.isFinite(topCvScore) ? topCvScore : undefined };
}

export function deriveHrWorkforceSnapshot(
    vaultDocs: AgentVaultDoc[],
    portfolio: PortfolioFile[],
    visuals: ChatVisualSpec[],
    coverage: WorkspaceCoverage,
    metrics: WorkspaceMetrics
): HrWorkforceSnapshot {
    const pillarCounts = countByPillar(vaultDocs);
    const { cvs, cvsScored, topCvScore } = cvStats(visuals, vaultDocs);
    const certsTracked =
        coverage && "documentsWithExpiry" in coverage ? (coverage.documentsWithExpiry ?? 0) : 0;
    const certsExpiring = certsTracked; // proxy until expiry breakdown in coverage

    const pillars: HrPillar[] = (Object.keys(PILLAR_META) as HrPillarId[]).map((id) => {
        const count = pillarCounts[id];
        const meta = PILLAR_META[id];
        return {
            id,
            ...meta,
            count,
            status: count === 0 ? "empty" : count >= 3 ? "ready" : "partial",
        };
    });

    const priorities: HrPriority[] = [];
    const unscoredCvs = Math.max(0, cvs - cvsScored);
    if (unscoredCvs > 0) {
        priorities.push({
            id: "unscored-cvs",
            title: `${unscoredCvs} CV${unscoredCvs === 1 ? "" : "s"} without scores`,
            detail: "Open resumes until processing completes, then rank candidates.",
            tone: "warn",
            prompt: "Show CV score ranking",
            chartView: "scores",
        });
    }
    if (certsExpiring > 0) {
        priorities.push({
            id: "certs",
            title: `${certsExpiring} certificate${certsExpiring === 1 ? "" : "s"} with expiry dates`,
            detail: "Review training and compliance renewals before they lapse.",
            tone: "warn",
            prompt: "Any certificates expiring in the next 90 days?",
        });
    }
    if (metrics.skippedDocs > 0) {
        priorities.push({
            id: "fix",
            title: `${metrics.skippedDocs} HR file${metrics.skippedDocs === 1 ? "" : "s"} not in charts`,
            detail: "Fix extraction or linking so leave, payroll, and directory views populate.",
            tone: "warn",
            prompt: "Why are some HR files not in charts?",
        });
    }
    if (pillarCounts.hiring > 0 && cvsScored > 0 && topCvScore != null) {
        priorities.push({
            id: "top-candidate",
            title: `Top CV score: ${Math.round(topCvScore)}/100`,
            detail: `${cvsScored} ranked candidate${cvsScored === 1 ? "" : "s"} in scope.`,
            tone: "info",
            chartView: "scores",
            prompt: "Export shortlist top 10 candidates",
        });
    }
    if (priorities.length === 0 && metrics.totalDocs > 0) {
        priorities.push({
            id: "healthy",
            title: "Workforce data looks current",
            detail: "Use Reports for an HR snapshot or explore analytics by pillar.",
            tone: "info",
            prompt: "Generate HR report",
        });
    }

    let headline = "Build your workforce hub";
    let subline = "Upload CVs, employee records, leave forms, and payroll to unlock HR analytics.";
    if (metrics.totalDocs > 0) {
        const parts: string[] = [];
        if (cvs > 0) parts.push(`${cvs} CV${cvs === 1 ? "" : "s"}`);
        if (pillarCounts.people > 0) parts.push(`${pillarCounts.people} people record${pillarCounts.people === 1 ? "" : "s"}`);
        if (pillarCounts.time > 0) parts.push(`${pillarCounts.time} leave/attendance`);
        if (pillarCounts.pay > 0) parts.push(`${pillarCounts.pay} pay/dev`);
        headline = parts.length ? parts.join(" · ") : `${metrics.totalDocs} HR files in portfolio`;
        subline =
            metrics.skippedDocs > 0
                ? `${metrics.chartedDocs} of ${metrics.totalDocs} files feeding charts — resolve gaps for full workforce views.`
                : `${metrics.chartedDocs} files chart-ready · ${visuals.length} live view${visuals.length === 1 ? "" : "s"}`;
    }

    return {
        headline,
        subline,
        pillars,
        priorities: priorities.slice(0, 4),
        docMix: docMix(vaultDocs),
        stats: {
            totalFiles: metrics.totalDocs,
            cvs,
            cvsScored,
            topCvScore,
            certsTracked,
            certsExpiring,
        },
    };
}

export type CvShortlistRow = {
    rank: number;
    name: string;
    score: number;
    documentId?: string;
};

export function extractCvShortlist(visuals: ChatVisualSpec[], limit = 10): CvShortlistRow[] {
    const visual = visuals.find((v) => /score|cv/i.test(v.title) && v.series.some((s) => s.key === "score"));
    if (!visual) return [];
    const scoreKey = "score";
    const nameKey = visual.categoryKey || "candidate";
    return [...visual.data]
        .map((row) => ({
            name: String(row[nameKey] || "Candidate"),
            score: Number(row[scoreKey] || 0),
            documentId: row._documentIds ? String(row._documentIds).split(",")[0] : undefined,
        }))
        .filter((r) => Number.isFinite(r.score) && r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r, i) => ({ rank: i + 1, ...r }));
}

export type HrAnalyticsGroupId = "all" | HrPillarId;

export const HR_ANALYTICS_GROUPS: Array<{
    id: HrAnalyticsGroupId;
    label: string;
    views: string[];
    defaultView: string;
    emptyHint: string;
    askPrompt: string;
}> = [
    {
        id: "all",
        label: "Overview",
        views: ["overview"],
        defaultView: "overview",
        emptyHint: "Upload HR files across hiring, people, leave, and payroll.",
        askPrompt: "Generate HR report",
    },
    {
        id: "hiring",
        label: "Hiring",
        views: ["scores", "score_dist"],
        defaultView: "scores",
        emptyHint: "Upload CVs/resumes to rank candidates and see score distribution.",
        askPrompt: "Show CV score ranking",
    },
    {
        id: "people",
        label: "People",
        views: ["directory", "onboarding"],
        defaultView: "directory",
        emptyHint: "Add employee records and contracts for directory and onboarding views.",
        askPrompt: "Show employee directory",
    },
    {
        id: "time",
        label: "Time off",
        views: ["leave", "attendance"],
        defaultView: "leave",
        emptyHint: "Upload leave applications and attendance sheets.",
        askPrompt: "Who is on leave?",
    },
    {
        id: "pay",
        label: "Pay & dev",
        views: ["payroll", "performance", "transcript", "expiry"],
        defaultView: "payroll",
        emptyHint: "Add payroll exports, reviews, training certs, or transcripts.",
        askPrompt: "Summarize payroll by department",
    },
];

export function hrGroupForView(view: string): HrAnalyticsGroupId {
    const found = HR_ANALYTICS_GROUPS.find((g) => g.id !== "all" && g.views.includes(view));
    return found?.id ?? "all";
}

export type HrViewKpi = { label: string; value: string };

export function deriveHrViewKpis(visuals: ChatVisualSpec[], view: string): HrViewKpi[] {
    if (view === "scores" || view === "overview") {
        const list = extractCvShortlist(visuals, 100);
        if (!list.length) return [];
        const avg = Math.round(list.reduce((s, r) => s + r.score, 0) / list.length);
        return [
            { label: "Candidates", value: String(list.length) },
            { label: "Top score", value: String(list[0].score) },
            { label: "Avg score", value: String(avg) },
        ];
    }
    const v = visuals[0];
    if (!v?.data.length) return [];
    const key = v.series[0]?.key;
    if (!key) return [{ label: "Rows", value: String(v.data.length) }];
    if (v.kind === "pie") {
        const total = v.data.reduce((s, row) => s + Number(row[key] || 0), 0);
        return [
            { label: "Segments", value: String(v.data.length) },
            { label: "Total", value: String(total) },
        ];
    }
    const total = v.data.reduce((s, row) => s + Number(row[key] || 0), 0);
    return [
        { label: "Entries", value: String(v.data.length) },
        {
            label: v.currency ? `Total (${v.currency})` : "Total",
            value: v.currency
                ? total.toLocaleString(undefined, { maximumFractionDigits: 0 })
                : String(total),
        },
    ];
}

export function filterPortfolioByPillar(
    files: PortfolioFile[],
    vaultDocs: AgentVaultDoc[],
    pillar: HrPillarId | "all"
): PortfolioFile[] {
    if (pillar === "all") return files;
    const types = new Set(PILLAR_TYPES[pillar]);
    const ids = new Set(
        vaultDocs.filter((d) => types.has(resolveDocType(d))).map((d) => d.documentId)
    );
    return files.filter((f) => ids.has(f.documentId));
}
