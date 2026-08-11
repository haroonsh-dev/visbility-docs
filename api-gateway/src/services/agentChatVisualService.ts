import type { ChatVisualSpec, AgentChatVisualResult, FinanceAnalyticsCoverage } from '../types/chatVisuals';
import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import { listTopResumesForUser } from './hrChatActionService';
import { HR_AGENT } from './offerLetterGenerationService';
import {
    type FinanceVisualIntent,
    tryFinanceChatVisual,
    wantsVisualization,
} from './financeChatVisualService';
import { FINANCE_AGENT } from './financeAnalyticsService';
import { COMPLIANCE_AGENT } from './complianceAnalyticsService';
import {
    type ComplianceVisualIntent,
    tryComplianceChatVisual,
} from './complianceChatVisualService';
import { runDynamicAnalytics, runDynamicDashboard } from './dynamicAnalyticsEngine';

export type HrVisualIntent = 'ranking' | 'distribution';

function detectHrVisualIntent(question: string, phase3Agent?: string): HrVisualIntent | null {
    const q = question.toLowerCase();
    const hrContext =
        phase3Agent === HR_AGENT ||
        /\b(resume|resumes|cv|cvs|candidate|candidates|hiring)\b/i.test(question);
    if (!hrContext) return null;
    const wantsViz =
        /\b(chart|graph|visuali[sz]e|visual|plot|rank|ranking|score|distribution|histogram|bucket)\b/i.test(
            q
        ) || (/\btop\b/.test(q) && /\b(resume|cv|candidate)\b/.test(q));
    if (!wantsViz) return null;
    if (/\b(distribution|histogram|bucket|spread)\b/i.test(q)) return 'distribution';
    return 'ranking';
}

export async function executeHrAnalytics(
    user: AuthUser,
    limit = 10,
    documentIds?: string[],
    intent: HrVisualIntent = 'ranking'
): Promise<{
    visuals: ChatVisualSpec[];
    citations: NonNullable<AgentChatVisualResult['citations']>;
    answer: string;
    documentCount: number;
}> {
    const fetchLimit = intent === 'distribution' ? 100 : limit;
    const pool = await listTopResumesForUser(user, fetchLimit, documentIds);
    const top = intent === 'distribution' ? pool : pool.slice(0, limit);

    if (!top.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer:
                'No resumes in scope yet. Select CVs in Document scope, wait until they’re ready, then ask again.',
        };
    }

    const citations = top.map((r) => ({
        documentId: r.documentId,
        filename: r.originalFilename,
        documentType: 'resume',
        phase3Agent: HR_AGENT,
    }));

    if (intent === 'distribution') {
        const buckets = [
            { label: '0–39', min: 0, max: 39 },
            { label: '40–59', min: 40, max: 59 },
            { label: '60–79', min: 60, max: 79 },
            { label: '80–100', min: 80, max: 100 },
        ];
        const counts = buckets.map((b) => ({
            bucket: b.label,
            count: top.filter((r) => {
                if (!Number.isFinite(r.cvScore)) return false;
                return r.cvScore >= b.min && r.cvScore <= b.max;
            }).length,
        }));
        return {
            visuals: [
                {
                    id: `hr_dist_${Date.now()}`,
                    agentId: HR_AGENT,
                    kind: 'bar',
                    title: 'CV score distribution',
                    subtitle: `Across ${top.length} resume(s) in scope`,
                    categoryKey: 'bucket',
                    series: [{ key: 'count', label: 'Candidates', color: '#a855f7' }],
                    data: counts,
                    footer: 'From CV scores on scoped resumes.',
                },
            ],
            documentCount: top.length,
            citations,
            answer: `Here’s the CV score distribution across ${top.length} resume(s) in your scope.`,
        };
    }

    const data = top
        .map((r) => ({
            candidate:
                r.originalFilename.length > 24
                    ? `${r.originalFilename.slice(0, 22)}…`
                    : r.originalFilename,
            score: Number.isFinite(r.cvScore) ? r.cvScore : null,
            _documentIds: r.documentId,
        }))
        .filter((row) => row.score != null) as Array<{
        candidate: string;
        score: number;
        _documentIds: string;
    }>;

    if (!data.length) {
        return {
            visuals: [],
            documentCount: top.length,
            citations,
            answer:
                'Those CVs don’t have scores yet. Open each resume until processing finishes, then ask again.',
        };
    }

    return {
        visuals: [
            {
                id: `hr_cv_${Date.now()}`,
                agentId: HR_AGENT,
                kind: 'bar',
                title: 'Candidate CV scores',
                subtitle: `Top ${data.length} by score`,
                categoryKey: 'candidate',
                series: [{ key: 'score', label: 'CV score (0–100)', color: '#7c3aed' }],
                data,
                footer: 'Scores from your HR processing pipeline.',
            },
        ],
        documentCount: top.length,
        citations,
        answer: `Here’s how your scoped candidates rank by CV score (${data.length} with scores). Charts are in the analytics panel.`,
    };
}

async function tryHrChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<AgentChatVisualResult> {
    const intent = detectHrVisualIntent(params.question, params.phase3Agent);
    if (!intent) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, HR_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message, agentId: HR_AGENT };
        }
    }

    const m = params.question.toLowerCase().match(/top\s+(\d{1,2})/);
    const limit = m ? Math.max(1, Math.min(20, Number(m[1]))) : 10;
    const result = await executeHrAnalytics(params.user, limit, params.documentIds, intent);

    if (!result.visuals.length) {
        return { handled: true, agentId: HR_AGENT, answer: result.answer };
    }

    return {
        handled: true,
        agentId: HR_AGENT,
        visuals: result.visuals,
        citations: result.citations,
        answer: result.answer,
    };
}

function mapHrView(view?: string): HrVisualIntent {
    if (view === 'score_dist') return 'distribution';
    return 'ranking';
}

export async function getAgentAnalyticsDashboard(params: {
    user: AuthUser;
    agentId: string;
    view?: string;
    limit?: number;
    documentIds?: string[];
}): Promise<{
    agentId: string;
    visuals: ChatVisualSpec[];
    citations: AgentChatVisualResult['citations'];
    summary: string;
    documentCount: number;
    coverage?: FinanceAnalyticsCoverage | import('../types/chatVisuals').ComplianceAnalyticsCoverage;
    scopeMode?: 'all' | 'selected';
}> {
    const { user, agentId } = params;

    if (user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(user, agentId);
        if (!check.ok) {
            return {
                agentId,
                visuals: [],
                citations: [],
                summary: check.message,
                documentCount: 0,
            };
        }
    }

    const scopeMode = params.documentIds?.length ? 'selected' : 'all';

    if (params.documentIds?.length) {
        const dyn = await runDynamicDashboard({
            user,
            agentId,
            view: params.view,
            documentIds: params.documentIds,
        });
        return {
            agentId: dyn.agentId || agentId,
            visuals: dyn.visuals || [],
            citations: dyn.citations || [],
            summary: dyn.answer || '',
            documentCount: dyn.documentCount || 0,
            coverage: dyn.coverage,
            scopeMode,
        };
    }

    if (agentId === FINANCE_AGENT) {
        return {
            agentId: FINANCE_AGENT,
            visuals: [],
            citations: [],
            summary:
                'Select invoice or finance files in chat scope, then refresh — charts follow those documents only.',
            documentCount: 0,
            coverage: {
                documentsInScope: 0,
                documentsWithAmount: 0,
                documentsWithClient: 0,
                documentsWithVendor: 0,
                files: [],
            },
            scopeMode: 'selected',
        };
    }

    if (agentId === HR_AGENT) {
        const limit = params.limit ? Math.max(1, Math.min(20, params.limit)) : 10;
        const intent = mapHrView(params.view);
        const result = await executeHrAnalytics(user, limit, params.documentIds, intent);
        return {
            agentId: HR_AGENT,
            visuals: result.visuals,
            citations: result.citations,
            summary: result.answer,
            documentCount: result.documentCount,
            scopeMode,
        };
    }

    if (agentId === COMPLIANCE_AGENT) {
        return {
            agentId: COMPLIANCE_AGENT,
            visuals: [],
            citations: [],
            summary:
                'Select compliance documents in chat scope (certificates, audits, SOPs), then ask for a chart or refresh analytics.',
            documentCount: 0,
            coverage: {
                documentsInScope: 0,
                documentsWithExpiry: 0,
                documentsWithFindings: 0,
                files: [],
            },
            scopeMode: 'selected',
        };
    }

    return {
        agentId,
        visuals: [],
        citations: [],
        summary:
            'Select documents in chat scope, then ask for a chart. Analytics are built from those files’ extractions.',
        documentCount: 0,
        scopeMode,
    };
}

export async function tryAgentChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    focusDocumentIds?: string[];
    sessionId?: string;
}): Promise<AgentChatVisualResult> {
    // Single router: dynamic engine is the only chart path when scope/focus exists
    if (params.documentIds?.length || params.focusDocumentIds?.length || wantsVisualization(params.question)) {
        const dyn = await runDynamicAnalytics({
            ...params,
            sessionId: params.sessionId,
        });
        if (dyn.handled) {
            return {
                handled: true,
                agentId: dyn.agentId || params.phase3Agent,
                answer: dyn.answer,
                visuals: dyn.visuals,
                citations: dyn.citations,
                coverage: dyn.coverage,
                analyticsView: dyn.analyticsView,
            };
        }
    }

    // Legacy fallbacks only when dynamic engine declines (no chart keywords / no docs)
    const finance = await tryFinanceChatVisual({ ...params, sessionId: params.sessionId });
    if (finance.handled) return finance;

    const compliance = await tryComplianceChatVisual(params);
    if (compliance.handled) return compliance;

    const hr = await tryHrChatVisual(params);
    if (hr.handled) return hr;

    if (wantsVisualization(params.question)) {
        return {
            handled: true,
            agentId: params.phase3Agent || 'other_agent',
            answer:
                'Select the documents you want charted in Document scope, then ask again — for example vendor totals, CV scores, certificate expiry, or PO amounts. Charts follow whatever is in scope.',
        };
    }

    return { handled: false };
}

// Keep unused type exports for view mapping callers
export type { FinanceVisualIntent, ComplianceVisualIntent };
