"use client";

import React, { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
    AlertCircle,
    BarChart3,
    CheckCircle2,
    Download,
    FileStack,
    FolderOpen,
    Home,
    MessageSquare,
    Plug,
    RefreshCw,
    Sparkles,
    Upload,
    Wrench,
    Zap,
} from "lucide-react";
import ChatAnalyticsSidePanel, { type AnalyticsPanelView } from "@/components/ChatAnalyticsSidePanel";
import AgentWorkspaceNav from "@/components/AgentWorkspaceNav";
import AgentWorkspaceChatRail, { type AgentWorkspaceChatRailHandle } from "@/components/AgentWorkspaceChatRail";
import AgentWorkspaceActivityFeed from "@/components/AgentWorkspaceActivityFeed";
import AgentOnboardingChecklist from "@/components/AgentOnboardingChecklist";
import AgentWorkspaceHeroBanner from "@/components/AgentWorkspaceHeroBanner";
import AgentChartPreviews from "@/components/AgentChartPreviews";
import AgentPortfolioPanel from "@/components/AgentPortfolioPanel";
import AgentReportsPanel from "@/components/AgentReportsPanel";
import AgentAnalyticsEmptyState from "@/components/AgentAnalyticsEmptyState";
import AgentWorkspaceStatusBar from "@/components/AgentWorkspaceStatusBar";
import AgentWorkspaceTabs, { MOBILE_ASK_TAB, type WorkspaceTabId } from "@/components/AgentWorkspaceTabs";
import AgentWorkspacePulse from "@/components/AgentWorkspacePulse";
import type {
    AgentAnalyticsCoverage,
    ChatVisualSpec,
    ComplianceAnalyticsCoverage,
    FinanceAnalyticsCoverage,
} from "@/types/chatVisuals";
import type { AnalyticsAgentId } from "@/lib/documentAgents";
import { agentChatPath } from "@/lib/documentAgents";
import { AGENT_QUICK_ASKS, type AgentWorkspaceMeta } from "@/lib/agentWorkspace";
import {
    deriveAttentionItems,
    deriveWorkspaceMetrics,
    getSkippedFiles,
} from "@/lib/agentWorkspaceInsights";
import {
    AGENT_CHART_SHORTCUTS,
    deriveSpotlightKpis,
    mergePortfolioFiles,
    type SpotlightKpi,
} from "@/lib/agentWorkspaceKpis";
import { useAgentPortfolio } from "@/hooks/useAgentPortfolio";
import type { PlanAgentOption } from "@/hooks/usePlanAgents";
import { downloadVisualsCsv } from "@/lib/analyticsExport";
import { deriveWorkspaceHero } from "@/lib/agentWorkspaceHero";
import { deriveWorkspacePulse } from "@/lib/agentWorkspacePulse";
import type { WorkspaceIntegration } from "@/lib/integrationConnections";
import AgentConnectedSystemsPanel from "@/components/AgentConnectedSystemsPanel";
import { deriveHrWorkforceSnapshot } from "@/lib/agentWorkspaceHr";
import { deriveProcurementSnapshot } from "@/lib/agentWorkspaceProcurement";
import { deriveComplianceSnapshot } from "@/lib/agentWorkspaceCompliance";
import { deriveFinanceSnapshot } from "@/lib/agentWorkspaceFinance";
import AgentFinanceCommandPanel from "@/components/AgentFinanceCommandPanel";
import AgentFinanceAnalyticsPanel from "@/components/AgentFinanceAnalyticsPanel";
import AgentFinancePortfolioPanel from "@/components/AgentFinancePortfolioPanel";
import AgentFinanceReportsPanel from "@/components/AgentFinanceReportsPanel";
import AgentHrCommandPanel from "@/components/AgentHrCommandPanel";
import AgentHrAnalyticsPanel from "@/components/AgentHrAnalyticsPanel";
import AgentHrPortfolioPanel from "@/components/AgentHrPortfolioPanel";
import AgentHrOutreachPanel from "@/components/AgentHrOutreachPanel";
import AgentProcurementCommandPanel from "@/components/AgentProcurementCommandPanel";
import AgentProcurementAnalyticsPanel from "@/components/AgentProcurementAnalyticsPanel";
import AgentProcurementPortfolioPanel from "@/components/AgentProcurementPortfolioPanel";
import AgentProcurementReviewPanel from "@/components/AgentProcurementReviewPanel";
import AgentComplianceCommandPanel from "@/components/AgentComplianceCommandPanel";
import AgentComplianceAnalyticsPanel from "@/components/AgentComplianceAnalyticsPanel";
import AgentCompliancePortfolioPanel from "@/components/AgentCompliancePortfolioPanel";
import AgentComplianceReportsPanel from "@/components/AgentComplianceReportsPanel";
import { cn } from "@/lib/utils";

type WorkspaceTab = WorkspaceTabId;

type Props = {
    agentId: AnalyticsAgentId;
    meta: AgentWorkspaceMeta;
    agentOptions: PlanAgentOption[];
    visuals: ChatVisualSpec[];
    loading: boolean;
    documentCount?: number;
    summary: string;
    scopeMode: "all" | "selected";
    coverage: FinanceAnalyticsCoverage | ComplianceAnalyticsCoverage | AgentAnalyticsCoverage | null;
    integrations: WorkspaceIntegration[];
    integrationsLoading?: boolean;
    view: AnalyticsPanelView;
    onViewChange: (view: AnalyticsPanelView) => void;
    onRefresh: () => void;
    onSyncIntegration?: (connectionId: string) => Promise<string | undefined>;
    lastUpdated?: string | null;
    live?: boolean;
    onLiveChange?: (live: boolean) => void;
    initialTab?: WorkspaceTab;
};

const DESKTOP_TABS: { id: WorkspaceTab; label: string; icon: React.ElementType }[] = [
    { id: "home", label: "Command", icon: Home },
    { id: "charts", label: "Analytics", icon: BarChart3 },
    { id: "files", label: "Portfolio", icon: FolderOpen },
    { id: "reports", label: "Reports", icon: FileStack },
    { id: "fix", label: "Fix", icon: Wrench },
];

function KpiCard({ kpi, accent }: { kpi: SpotlightKpi; accent: string }) {
    const toneClass =
        kpi.tone === "success"
            ? "text-emerald-600 dark:text-emerald-400"
            : kpi.tone === "warn"
              ? "text-amber-600 dark:text-amber-400"
              : kpi.tone === "accent"
                ? "text-accent"
                : "text-foreground";

    return (
        <div className="rounded-2xl border border-border/80 bg-background/60 backdrop-blur-sm p-4 min-h-[84px] flex flex-col justify-between shadow-sm">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">{kpi.label}</p>
            <p className={cn("text-xl font-bold tabular-nums truncate mt-1", toneClass)}>{kpi.value}</p>
            {kpi.hint && <p className="text-[10px] text-foreground-muted mt-1 truncate">{kpi.hint}</p>}
            <div className="h-0.5 w-10 rounded-full mt-2 opacity-70" style={{ backgroundColor: accent }} />
        </div>
    );
}

export default function AgentWorkspaceShell({
    agentId,
    meta,
    agentOptions,
    visuals,
    loading,
    documentCount,
    summary,
    scopeMode,
    coverage,
    integrations,
    integrationsLoading = false,
    view,
    onViewChange,
    onRefresh,
    onSyncIntegration,
    lastUpdated,
    live = true,
    onLiveChange,
    initialTab = "home",
}: Props) {
    const router = useRouter();
    const chatRef = useRef<AgentWorkspaceChatRailHandle>(null);
    const [tab, setTab] = useState<WorkspaceTab>(initialTab);
    const Icon = meta.icon;
    const { docs: vaultDocs, loading: portfolioLoading, refresh: refreshPortfolio } = useAgentPortfolio(agentId);

    const portfolio = useMemo(
        () => mergePortfolioFiles(coverage, vaultDocs),
        [coverage, vaultDocs]
    );
    const metrics = useMemo(() => {
        const base = deriveWorkspaceMetrics(documentCount, coverage, integrations.length);
        if (portfolio.length <= base.totalDocs) return base;

        const totalDocs = portfolio.length;
        const chartedDocs = portfolio.filter((f) => f.inCharts).length;
        const skippedDocs = Math.max(0, totalDocs - chartedDocs);
        let healthScore = 0;
        let healthLabel: typeof base.healthLabel = "Empty";
        if (totalDocs === 0) {
            healthScore = 0;
            healthLabel = "Empty";
        } else {
            healthScore = Math.round((chartedDocs / totalDocs) * 100);
            if (healthScore >= 85) healthLabel = "Ready";
            else if (healthScore >= 45) healthLabel = "Partial";
            else healthLabel = "Needs work";
        }
        return { ...base, totalDocs, chartedDocs, skippedDocs, healthScore, healthLabel };
    }, [documentCount, coverage, integrations.length, portfolio]);
    const spotlight = useMemo(
        () => deriveSpotlightKpis(agentId, visuals, coverage, metrics),
        [agentId, visuals, coverage, metrics]
    );
    const attention = useMemo(
        () => deriveAttentionItems(agentId, coverage, metrics.totalDocs || documentCount),
        [agentId, coverage, metrics.totalDocs, documentCount]
    );
    const skippedFiles = useMemo(() => getSkippedFiles(coverage), [coverage]);
    const quickAsks = AGENT_QUICK_ASKS[agentId] || [];
    const chartShortcuts = AGENT_CHART_SHORTCUTS[agentId] || [];
    const plainSummary = summary.replace(/\*\*/g, "").trim();
    const fixCount = metrics.skippedDocs;
    const hero = useMemo(() => deriveWorkspaceHero(agentId, visuals, metrics), [agentId, visuals, metrics]);
    const pulse = useMemo(
        () =>
            deriveWorkspacePulse(agentId, metrics, portfolio, visuals.length, integrations),
        [agentId, metrics, portfolio, visuals.length, integrations]
    );

    const handlePulsePrimaryAction = () => {
        if (pulse.primaryAction === "fix") setTab("fix");
        else if (pulse.primaryAction === "analytics") setTab("charts");
        else if (pulse.primaryAction === "upload") router.push("/documents");
    };

    const hrSnapshot = useMemo(
        () =>
            agentId === "hr_agent"
                ? deriveHrWorkforceSnapshot(vaultDocs, portfolio, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, portfolio, visuals, coverage, metrics]
    );

    const procSnapshot = useMemo(
        () =>
            agentId === "procurement_agent"
                ? deriveProcurementSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );

    const compSnapshot = useMemo(
        () =>
            agentId === "compliance_agent"
                ? deriveComplianceSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );

    const financeSnapshot = useMemo(
        () =>
            agentId === "finance_agent"
                ? deriveFinanceSnapshot(vaultDocs, visuals, coverage, metrics)
                : null,
        [agentId, vaultDocs, visuals, coverage, metrics]
    );
    const [syncingId, setSyncingId] = useState<string | null>(null);

    const formatUpdated = (iso: string | null | undefined) => {
        if (!iso) return null;
        const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (mins < 1) return "Updated just now";
        if (mins < 60) return `Updated ${mins}m ago`;
        return `Updated ${Math.floor(mins / 60)}h ago`;
    };

    const goAsk = (prompt?: string) => {
        const base = agentChatPath(agentId);
        router.push(prompt ? `${base}&q=${encodeURIComponent(prompt)}` : base);
    };

    const runInChat = async (prompt: string) => {
        if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
            await chatRef.current?.sendPrompt(prompt);
            return;
        }
        goAsk(prompt);
    };

    const handleRefresh = () => {
        onRefresh();
        void refreshPortfolio();
    };

    const openChartView = (viewId: string) => {
        onViewChange(viewId as AnalyticsPanelView);
        setTab("charts");
    };

    const [integrationSyncNote, setIntegrationSyncNote] = useState<{
        tone: "ok" | "err";
        text: string;
    } | null>(null);

    const handleIntegrationSync = async (connectionId: string) => {
        if (!onSyncIntegration) return;
        setSyncingId(connectionId);
        setIntegrationSyncNote(null);
        try {
            const message = await onSyncIntegration(connectionId);
            setIntegrationSyncNote({
                tone: "ok",
                text: message || "Sync finished — check Documents and refresh the shortlist.",
            });
            handleRefresh();
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "Sync failed";
            setIntegrationSyncNote({ tone: "err", text: msg });
        } finally {
            setSyncingId(null);
        }
    };

    const renderConnectedSystems = () => (
        <AgentConnectedSystemsPanel
            agentName={meta.shortName}
            accent={meta.accent}
            connections={integrations}
            loading={integrationsLoading}
            syncingId={syncingId}
            onSync={onSyncIntegration ? handleIntegrationSync : undefined}
            syncNote={integrationSyncNote}
        />
    );

    const renderHome = () => {
        if (agentId === "finance_agent" && financeSnapshot) {
            return (
                <div className="space-y-5 animate-in fade-in duration-300">
                    <AgentFinanceCommandPanel
                        snapshot={financeSnapshot}
                        accent={meta.accent}
                        accentMuted={meta.accentMuted}
                        visuals={visuals}
                        attention={attention}
                        onOpenChart={openChartView}
                        onAsk={(p) => void runInChat(p)}
                        onOpenReports={() => setTab("reports")}
                        onOpenFix={() => setTab("fix")}
                        onNavigate={(href) => router.push(href)}
                    />
                    {renderConnectedSystems()}
                </div>
            );
        }

        if (agentId === "hr_agent" && hrSnapshot) {
            return (
                <div className="space-y-5 animate-in fade-in duration-300">
                    <AgentHrCommandPanel
                        snapshot={hrSnapshot}
                        accent={meta.accent}
                        accentMuted={meta.accentMuted}
                        visuals={visuals}
                        attention={attention}
                        onOpenChart={openChartView}
                        onAsk={(p) => void runInChat(p)}
                        onOpenReports={() => setTab("reports")}
                        onOpenFix={() => setTab("fix")}
                        onNavigate={(href) => router.push(href)}
                    />
                    {renderConnectedSystems()}
                </div>
            );
        }

        if (agentId === "procurement_agent" && procSnapshot) {
            return (
                <div className="space-y-5 animate-in fade-in duration-300">
                    <AgentProcurementCommandPanel
                        snapshot={procSnapshot}
                        accent={meta.accent}
                        visuals={visuals}
                        attention={attention}
                        onOpenChart={openChartView}
                        onAsk={(p) => void runInChat(p)}
                        onOpenReports={() => setTab("reports")}
                        onOpenFix={() => setTab("fix")}
                        onNavigate={(href) => router.push(href)}
                    />
                    {renderConnectedSystems()}
                </div>
            );
        }

        if (agentId === "compliance_agent" && compSnapshot) {
            return (
                <div className="space-y-5 animate-in fade-in duration-300">
                    <AgentComplianceCommandPanel
                        snapshot={compSnapshot}
                        accent={meta.accent}
                        visuals={visuals}
                        attention={attention}
                        onOpenChart={openChartView}
                        onAsk={(p) => void runInChat(p)}
                        onOpenReports={() => setTab("reports")}
                        onOpenFix={() => setTab("fix")}
                        onNavigate={(href) => router.push(href)}
                    />
                    {renderConnectedSystems()}
                </div>
            );
        }

        return (
        <div className="space-y-5 animate-in fade-in duration-300">
            {hero.variant === "highlight" && (
                <AgentWorkspaceHeroBanner hero={hero} accent={meta.accent} accentMuted={meta.accentMuted} />
            )}

            {hero.variant === "empty" && (
                <AgentWorkspaceHeroBanner hero={hero} accent={meta.accent} accentMuted={meta.accentMuted} />
            )}

            <AgentOnboardingChecklist
                metrics={metrics}
                integrationCount={integrations.length}
                chartCount={visuals.length}
                accent={meta.accent}
            />

            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                {spotlight.map((kpi) => (
                    <KpiCard key={kpi.label} kpi={kpi} accent={meta.accent} />
                ))}
            </div>

            {plainSummary && (
                <div
                    className="rounded-2xl border px-4 py-3 text-sm text-foreground-muted leading-relaxed"
                    style={{ borderColor: `${meta.accent}33`, backgroundColor: meta.accentMuted }}
                >
                    {plainSummary.slice(0, 360)}
                    {plainSummary.length > 360 ? "…" : ""}
                </div>
            )}

            {visuals.length > 0 && (
                <AgentChartPreviews visuals={visuals} maxCharts={3} onOpenCharts={() => setTab("charts")} />
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <section className="xl:col-span-2 rounded-2xl border border-border bg-surface/40 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3">
                        Needs attention
                    </p>
                    <div className="space-y-2">
                        {attention.slice(0, 4).map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => {
                                    if (item.href) router.push(item.href);
                                    else if (item.prompt) void runInChat(item.prompt);
                                    else setTab("fix");
                                }}
                                className={cn(
                                    "w-full text-left rounded-xl border px-3 py-2.5 flex gap-2 transition-colors",
                                    item.severity === "warning"
                                        ? "border-amber-500/25 bg-amber-500/5 hover:bg-amber-500/10"
                                        : "border-border hover:bg-surface-2"
                                )}
                            >
                                {item.severity === "warning" ? (
                                    <AlertCircle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                                ) : (
                                    <CheckCircle2 size={14} className="text-emerald-500 shrink-0 mt-0.5" />
                                )}
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold truncate">{item.title}</p>
                                    {item.detail && (
                                        <p className="text-[10px] text-foreground-muted line-clamp-2">{item.detail}</p>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                </section>

                <section className="rounded-2xl border border-border bg-surface/40 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-3 flex items-center gap-1.5">
                        <Zap size={12} /> Quick actions
                    </p>
                    <div className="flex flex-col gap-2">
                        <button
                            type="button"
                            onClick={() => setTab("reports")}
                            className="text-left rounded-xl border border-border bg-background/60 px-3 py-2.5 text-xs font-semibold hover:border-accent/40"
                        >
                            Open reports & PDF tasks →
                        </button>
                        <button
                            type="button"
                            onClick={() => setTab("charts")}
                            className="text-left rounded-xl border border-border bg-background/60 px-3 py-2.5 text-xs font-semibold hover:border-accent/40"
                        >
                            View full analytics →
                        </button>
                        {fixCount > 0 && (
                            <button
                                type="button"
                                onClick={() => setTab("fix")}
                                className="text-left rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs font-semibold text-amber-800 dark:text-amber-300"
                            >
                                Fix {fixCount} file{fixCount === 1 ? "" : "s"} →
                            </button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-border">
                        {quickAsks.slice(0, 4).map((p) => (
                            <button
                                key={p}
                                type="button"
                                onClick={() => void runInChat(p)}
                                className="rounded-full border border-border bg-background px-3 py-1.5 text-[11px] font-medium hover:border-accent/40"
                            >
                                {p}
                            </button>
                        ))}
                    </div>
                    {chartShortcuts.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-3 mt-3 border-t border-border">
                            {chartShortcuts.map((s) => (
                                <button
                                    key={s.view}
                                    type="button"
                                    onClick={() => openChartView(s.view)}
                                    className="rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium hover:bg-surface-2"
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    )}
                    <div className="flex gap-2 mt-4 pt-4 border-t border-border">
                        <Link
                            href="/documents"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-surface-2"
                        >
                            <Upload size={13} /> Upload
                        </Link>
                        <Link
                            href="/admin/integrations"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-surface-2"
                        >
                            <Plug size={13} /> Connect
                        </Link>
                    </div>
                </section>
            </div>

            <AgentWorkspaceActivityFeed agentId={agentId} />

            {renderConnectedSystems()}
        </div>
        );
    };

    const renderCharts = () => (
        <div className="min-h-[520px] flex flex-col">
            {agentId === "finance_agent" && financeSnapshot ? (
                <AgentFinanceAnalyticsPanel
                    accent={meta.accent}
                    snapshot={financeSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : agentId === "hr_agent" && hrSnapshot ? (
                <AgentHrAnalyticsPanel
                    accent={meta.accent}
                    snapshot={hrSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                    onOpenOutreach={() => setTab("reports")}
                />
            ) : agentId === "procurement_agent" && procSnapshot ? (
                <AgentProcurementAnalyticsPanel
                    accent={meta.accent}
                    snapshot={procSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : agentId === "compliance_agent" && compSnapshot ? (
                <AgentComplianceAnalyticsPanel
                    accent={meta.accent}
                    snapshot={compSnapshot}
                    visuals={visuals}
                    loading={loading}
                    documentCount={documentCount}
                    scopeMode={scopeMode}
                    coverage={coverage}
                    view={view}
                    onViewChange={onViewChange}
                    onRefresh={handleRefresh}
                    onRunPrompt={(p) => void runInChat(p)}
                    onClose={() => setTab("home")}
                />
            ) : !loading && visuals.length === 0 ? (
                <div className="rounded-2xl border border-border bg-surface/30 overflow-hidden flex-1">
                    <AgentAnalyticsEmptyState
                        agentId={agentId}
                        meta={meta}
                        documentCount={documentCount}
                        onRunPrompt={(p) => void runInChat(p)}
                        onOpenCharts={() => setTab("charts")}
                    />
                </div>
            ) : (
                <div className="rounded-2xl border border-border bg-surface/30 overflow-hidden flex-1 flex flex-col">
                <ChatAnalyticsSidePanel
                    layout="page"
                    open
                    onClose={() => setTab("home")}
                    agentId={agentId}
                    visuals={visuals}
                    loading={loading}
                    onRefresh={handleRefresh}
                    view={view}
                    onViewChange={onViewChange}
                    documentCount={documentCount}
                    unifiedHeader
                    suppressCoverageBanner
                    scopeMode={scopeMode}
                    coverage={coverage}
                    scopeDocCount={documentCount}
                    onRunPrompt={(p) => void runInChat(p)}
                />
                </div>
            )}
        </div>
    );

    const renderFiles = () =>
        agentId === "finance_agent" ? (
            <AgentFinancePortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "hr_agent" ? (
            <AgentHrPortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "procurement_agent" ? (
            <AgentProcurementPortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : agentId === "compliance_agent" ? (
            <AgentCompliancePortfolioPanel
                files={portfolio}
                vaultDocs={vaultDocs}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        ) : (
            <AgentPortfolioPanel
                files={portfolio}
                loading={portfolioLoading}
                accent={meta.accent}
                onAskFix={(filename) => void runInChat(`Fix ${filename} for charts`)}
            />
        );

    const renderReports = () => (
        <div className="space-y-6">
            {agentId === "finance_agent" && financeSnapshot && (
                <AgentFinanceReportsPanel
                    snapshot={financeSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId === "hr_agent" && (
                <AgentHrOutreachPanel
                    accent={meta.accent}
                    accentMuted={meta.accentMuted}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId === "procurement_agent" && procSnapshot && (
                <AgentProcurementReviewPanel
                    snapshot={procSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            {agentId === "compliance_agent" && compSnapshot && (
                <AgentComplianceReportsPanel
                    snapshot={compSnapshot}
                    accent={meta.accent}
                    visuals={visuals}
                    onRunInChat={(p) => void runInChat(p)}
                />
            )}
            <AgentReportsPanel
                agentId={agentId}
                accent={meta.accent}
                accentMuted={meta.accentMuted}
                shortName={meta.shortName}
                visuals={visuals}
                onRunInChat={(p) => void runInChat(p)}
                onOpenFullChat={goAsk}
            />
        </div>
    );

    const renderFix = () => (
        <div className="space-y-4 animate-in fade-in duration-300">
            <div
                className="rounded-2xl border px-4 py-3 flex flex-wrap items-center justify-between gap-3"
                style={{ borderColor: `${meta.accent}33`, backgroundColor: meta.accentMuted }}
            >
                <div>
                    <p className="text-sm font-bold">Fix queue</p>
                    <p className="text-xs text-foreground-muted mt-0.5">
                        {fixCount === 0
                            ? "All portfolio files are chart-ready"
                            : `${fixCount} file${fixCount === 1 ? "" : "s"} blocking full analytics`}
                    </p>
                </div>
                {fixCount > 0 && (
                    <button
                        type="button"
                        onClick={() => void runInChat("Why are some files not in charts? Summarize fixes needed.")}
                        className="btn-secondary rounded-xl px-3 py-2 text-xs font-semibold"
                    >
                        Ask AI to diagnose all
                    </button>
                )}
            </div>
            <div className="space-y-2">
            {skippedFiles.length === 0 ? (
                <div className="rounded-2xl border border-dashed py-16 text-center">
                    <Sparkles size={36} className="mx-auto text-emerald-500 mb-3" />
                    <p className="text-sm font-semibold">All clear</p>
                    <button type="button" onClick={() => setTab("charts")} className="mt-3 text-sm text-accent font-medium">
                        View analytics →
                    </button>
                </div>
            ) : (
                skippedFiles.map((f) => (
                    <div
                        key={f.documentId}
                        className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 flex flex-wrap items-center gap-3"
                    >
                        <AlertCircle size={16} className="text-amber-600 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <Link
                                href={`/documents/${f.documentId}/details`}
                                className="text-sm font-semibold hover:text-accent truncate block"
                            >
                                {f.filename}
                            </Link>
                            <p className="text-xs text-foreground-muted">{f.detail || f.status}</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void runInChat(`Why is ${f.filename} not in charts?`)}
                            className="btn-secondary rounded-lg px-3 py-1.5 text-xs"
                        >
                            Ask AI
                        </button>
                        <Link href={`/documents/${f.documentId}/details`} className="text-xs text-accent">
                            Open →
                        </Link>
                    </div>
                ))
            )}
            </div>
        </div>
    );

    const mainContent = (
        <>
            {tab === "home" && renderHome()}
            {tab === "charts" && renderCharts()}
            {tab === "files" && renderFiles()}
            {tab === "reports" && renderReports()}
            {tab === "fix" && renderFix()}
            {tab === "ask" && (
                <div className="lg:hidden h-[min(70vh,640px)]">
                    <AgentWorkspaceChatRail
                        agentId={agentId}
                        shortName={meta.shortName}
                        accent={meta.accent}
                        onAnalyticsReply={onRefresh}
                        className="h-full"
                    />
                </div>
            )}
        </>
    );

    return (
        <div className="flex flex-col min-h-[calc(100vh-3.5rem)] bg-background relative">
            <div
                className="pointer-events-none absolute inset-0 opacity-[0.35]"
                style={{
                    background: `radial-gradient(ellipse 70% 50% at 100% 0%, ${meta.accentMuted}, transparent 50%)`,
                }}
            />

            <header className="relative shrink-0 border-b border-border bg-surface/40 backdrop-blur-md">
                <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 pt-4 pb-3 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                            <Link
                                href="/agents"
                                className="text-[10px] font-semibold text-foreground-muted hover:text-accent uppercase tracking-wider"
                            >
                                ← All workspaces
                            </Link>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {onLiveChange && (
                                <button
                                    type="button"
                                    onClick={() => onLiveChange(!live)}
                                    className={cn(
                                        "rounded-lg px-2.5 py-1.5 text-[11px] font-semibold border",
                                        live
                                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                            : "border-border text-foreground-muted"
                                    )}
                                >
                                    {live ? "● Live" : "Paused"}
                                </button>
                            )}
                            {lastUpdated && (
                                <span className="text-[10px] text-foreground-muted hidden sm:inline">
                                    {formatUpdated(lastUpdated)}
                                </span>
                            )}
                            <button
                                type="button"
                                onClick={handleRefresh}
                                disabled={loading}
                                className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5 disabled:opacity-50"
                            >
                                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
                                Sync
                            </button>
                            {visuals.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => downloadVisualsCsv(visuals, `${agentId}-export.csv`)}
                                    className="btn-secondary rounded-xl px-3 py-2 text-xs inline-flex items-center gap-1.5"
                                >
                                    <Download size={13} /> CSV
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                        <div
                            className="h-12 w-12 rounded-2xl flex items-center justify-center shrink-0"
                            style={{ backgroundColor: meta.accentMuted }}
                        >
                            <Icon size={22} style={{ color: meta.accent }} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{meta.shortName} workspace</h1>
                            <p className="text-xs text-foreground-muted">{meta.tagline}</p>
                        </div>
                    </div>

                    <AgentWorkspaceNav agents={agentOptions} currentAgentId={agentId} />
                </div>
            </header>

            <div className="relative shrink-0 border-b border-border bg-surface/20 py-2">
                <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
                    <AgentWorkspaceTabs
                        tabs={DESKTOP_TABS}
                        mobileTabs={[...DESKTOP_TABS, MOBILE_ASK_TAB]}
                        active={tab}
                        accent={meta.accent}
                        fixCount={fixCount}
                        onChange={setTab}
                    />
                </div>
            </div>

            <div className="relative flex-1 min-h-0 overflow-hidden flex flex-col">
                <div className="shrink-0 max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 pt-3 pb-2">
                    <AgentWorkspacePulse
                        shortName={meta.shortName}
                        metrics={metrics}
                        pulse={pulse}
                        accent={meta.accent}
                        live={live}
                        lastUpdated={lastUpdated}
                        onPrimaryAction={pulse.primaryAction !== "none" ? handlePulsePrimaryAction : undefined}
                    />
                </div>
                <div className="max-w-[1600px] mx-auto w-full flex-1 min-h-0 px-4 sm:px-6 lg:px-8 py-2">
                    <div className="grid grid-cols-1 lg:grid-cols-[minmax(300px,380px)_1fr] gap-4 h-full min-h-[560px]">
                        <div className="hidden lg:flex flex-col min-h-0 h-full max-h-[calc(100vh-22rem)]">
                            <AgentWorkspaceChatRail
                                ref={chatRef}
                                agentId={agentId}
                                shortName={meta.shortName}
                                accent={meta.accent}
                                onAnalyticsReply={handleRefresh}
                                className="flex-1 min-h-0"
                            />
                        </div>
                        <div className="min-h-0 overflow-y-auto lg:max-h-[calc(100vh-22rem)]">{mainContent}</div>
                    </div>
                </div>
            </div>

            <AgentWorkspaceStatusBar
                metrics={metrics}
                accent={meta.accent}
                live={live}
                activeTab={tab}
            />
        </div>
    );
}
