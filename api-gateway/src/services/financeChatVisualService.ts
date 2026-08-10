import { AuthUser } from './accessScope';
import { requireAllowedAgent } from './planService';
import type { AgentChatVisualResult, FinanceAnalyticsCoverage } from '../types/chatVisuals';
import {
    buildAgingVisual,
    buildClientSpendVisual,
    buildDocTypeMixVisual,
    buildMonthlyTrendVisual,
    buildVendorSpendVisual,
    FINANCE_AGENT,
    loadFinanceRecords,
    sumTotalsByCurrency,
    buildFinanceFileCoverage,
    computeFinanceCoverage,
    countFinanceDocumentsInScope,
    executeLineItemAnalytics,
    resolveFinanceDocumentIdsFromQuestion,
    loadFinanceDocsForAnalytics,
    formatVendorSpendTable,
    type LoadFinanceOptions,
    narrowFinanceDocumentIds,
    questionRefersToSpecificDocument,
    extractDocumentNameTokens,
} from './financeAnalyticsService';
import Document from '../models/Document';
import { buildDocumentFilter } from './accessScope';

export type FinanceVisualIntent =
    | 'vendor_spend'
    | 'client_spend'
    | 'monthly_trend'
    | 'aging'
    | 'doc_mix'
    | 'line_items'
    | 'overview';

function hasFinanceContext(question: string, phase3Agent?: string): boolean {
    if (phase3Agent === FINANCE_AGENT) return true;
    return /\b(invoice|invoices|vendor|spend|ap|payable|expense|finance|financial|budget|bank statement)\b/i.test(
        question
    );
}

export function wantsVisualization(question: string): boolean {
    const q = question.toLowerCase();
    return (
        /\b(chart|graph|graphs|visuali[sz]e|visual|plot|dashboard|breakdown|analytics)\b/.test(q) ||
        /\b(show me|give me)\b.*\b(numbers|stats|summary|graph|chart|visual)\b/.test(q)
    );
}

export type FinanceVisualDetectOptions = {
    /** At least one scoped document is finance-classified (invoice, etc.). */
    hasScopedFinanceDocuments?: boolean;
    scopedFinanceDocCount?: number;
};

function wantsLineItemBreakdown(question: string): boolean {
    const q = question.toLowerCase();
    return (
        /\b(line[\s-]?items?|items?\s+list|list\s+(of\s+)?items?|each item|item\s+wise|item-wise)\b/.test(q) ||
        (/\b(show|list|give)\b/.test(q) && /\bitems?\b/.test(q)) ||
        (/\b(quantity|quantities|unit price|unit_price|subtotal)\b/.test(q) &&
            /\b(item|items|invoice|bill)\b/.test(q))
    );
}

function wantsVendorRollup(question: string): boolean {
    const q = question.toLowerCase();
    return (
        (/\b(vendor|supplier)\b/.test(q) &&
            /\b(total|totals|sum|spend|amount|breakdown|grand|verify|correct|compare|per vendor)\b/.test(q)) ||
        /\bspend by\b/.test(q) ||
        (/\b(vendor|supplier)\b/.test(q) && /\b(chart|graph|visual)\b/.test(q))
    );
}

export function detectFinanceVisualIntent(
    question: string,
    phase3Agent?: string,
    options?: FinanceVisualDetectOptions
): FinanceVisualIntent | null {
    const q = question.toLowerCase();
    const financeScoped = Boolean(options?.hasScopedFinanceDocuments);
    const scopedCount = options?.scopedFinanceDocCount ?? 0;

    if (
        wantsLineItemBreakdown(question) &&
        (wantsVisualization(question) ||
            /\b(give|show|list|get)\b/.test(q) ||
            phase3Agent === FINANCE_AGENT ||
            hasFinanceContext(question, phase3Agent) ||
            financeScoped)
    ) {
        return 'line_items';
    }

    const financeContext =
        hasFinanceContext(question, phase3Agent) || financeScoped || phase3Agent === FINANCE_AGENT;

    if (!financeContext && !wantsVisualization(question)) return null;
    if (!financeContext && wantsVisualization(question)) {
        if (phase3Agent && phase3Agent !== FINANCE_AGENT && !financeScoped) return null;
    }

    if (wantsVisualization(question) && financeContext) {
        if (wantsLineItemBreakdown(question)) return 'line_items';
        if (wantsVendorRollup(question)) return 'vendor_spend';
        if (phase3Agent === FINANCE_AGENT && /\b(graph|chart|visual|plot)\b/.test(q)) {
            if (/\b(vendor|supplier|spend)\b/.test(q)) return 'vendor_spend';
            if (/\b(trend|monthly)\b/.test(q)) return 'monthly_trend';
            if (scopedCount > 0 && scopedCount <= 12) return 'line_items';
            return 'overview';
        }
    }

    if (!wantsVisualization(question)) {
        if (wantsLineItemBreakdown(question)) return 'line_items';
        if (/\b(client|customer|bill to)\b/.test(q) && /\b(spend|total|amount|breakdown|revenue)\b/.test(q)) {
            return 'client_spend';
        }
        if (wantsVendorRollup(question)) {
            return 'vendor_spend';
        }
        if (/\b(aging|overdue|outstanding|past due)\b/.test(q)) return 'aging';
        if (/\b(trend|over time|monthly|per month)\b/.test(q)) return 'monthly_trend';
        return null;
    }

    if (/\b(client|customer)\b/.test(q) && /\b(chart|graph|visual|breakdown)\b/.test(q)) return 'client_spend';
    if (/\b(aging|overdue|outstanding|past due|due date)\b/.test(q)) return 'aging';
    if (/\b(client|customer|bill to)\b/.test(q) && /\b(spend|total|amount|breakdown|revenue)\b/.test(q)) {
        return 'client_spend';
    }
    if (wantsLineItemBreakdown(question)) return 'line_items';
    if (wantsVendorRollup(question) || (/\b(vendor|supplier)\b/.test(q) && /\b(chart|graph)\b/.test(q))) {
        return 'vendor_spend';
    }
    if (/\b(vendor|supplier)\b/.test(q) || /\bspend by\b/.test(q)) return 'vendor_spend';
    if (/\b(trend|over time|monthly|timeline|history)\b/.test(q)) return 'monthly_trend';
    if (/\b(mix|types|breakdown)\b/.test(q) && /\b(document|doc)\b/.test(q)) return 'doc_mix';
    if (financeContext) return 'overview';
    return null;
}

export async function tryFinanceChatVisual(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
    focusDocumentIds?: string[];
}): Promise<AgentChatVisualResult> {
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, FINANCE_AGENT);
        if (!check.ok) {
            if (!detectFinanceVisualIntent(params.question, params.phase3Agent)) {
                return { handled: false };
            }
            return { handled: true, answer: check.message, agentId: FINANCE_AGENT };
        }
    }

    let resolvedIds = await narrowFinanceDocumentIds({
        user: params.user,
        question: params.question,
        scopedIds: params.documentIds,
        focusIds: params.focusDocumentIds,
    });

    if (
        questionRefersToSpecificDocument(params.question) &&
        (params.documentIds?.length || 0) > 1 &&
        !(params.focusDocumentIds && params.focusDocumentIds.length)
    ) {
        const named = await resolveFinanceDocumentIdsFromQuestion(
            params.user,
            params.question,
            { preferIds: params.documentIds }
        );
        if (!named?.length) {
            return {
                handled: true,
                agentId: FINANCE_AGENT,
                answer:
                    'Which document do you mean by “that”? Name the file (e.g. digilog) or leave only that invoice selected in Document scope, then ask again.',
            };
        }
        resolvedIds = named;
    }

    let scopedFinanceCount = 0;
    if (resolvedIds?.length) {
        scopedFinanceCount = await countFinanceDocumentsInScope(params.user, resolvedIds);
        if (!scopedFinanceCount) {
            resolvedIds = undefined;
        }
    }

    if (
        !resolvedIds?.length &&
        params.phase3Agent === FINANCE_AGENT &&
        wantsVisualization(params.question)
    ) {
        const docs = await loadFinanceDocsForAnalytics(params.user, { maxDocs: 8 });
        if (docs.length) {
            resolvedIds = docs.map((d) => d.documentId);
            scopedFinanceCount = docs.length;
        }
    }

    let intent = detectFinanceVisualIntent(params.question, params.phase3Agent, {
        hasScopedFinanceDocuments: scopedFinanceCount > 0,
        scopedFinanceDocCount: scopedFinanceCount,
    });
    // Named file or "that" for a single invoice → line items, not portfolio overview
    if (
        intent &&
        intent !== 'line_items' &&
        resolvedIds?.length === 1 &&
        /\b(chart|graph|visual|plot)\b/i.test(params.question) &&
        (questionRefersToSpecificDocument(params.question) ||
            extractDocumentNameTokens(params.question).length > 0)
    ) {
        intent = 'line_items';
    }
    if (!intent) return { handled: false };

    const loadOpts: LoadFinanceOptions = {
        documentIds: resolvedIds?.length ? resolvedIds : undefined,
    };
    const result = await executeFinanceAnalytics(params.user, intent, loadOpts);
    return {
        handled: true,
        agentId: FINANCE_AGENT,
        visuals: result.visuals,
        citations: result.citations,
        answer: result.answer,
    };
}

export async function executeFinanceAnalytics(
    user: AuthUser,
    intent: FinanceVisualIntent,
    loadOpts: LoadFinanceOptions = {}
): Promise<{
    visuals: import('../types/chatVisuals').ChatVisualSpec[];
    citations: AgentChatVisualResult['citations'];
    answer: string;
    documentCount: number;
    coverage?: FinanceAnalyticsCoverage;
}> {
    if (intent === 'line_items') {
        return executeLineItemAnalytics(user, loadOpts);
    }

    const records = await loadFinanceRecords(user, loadOpts);
    const docsInScope = await countFinanceDocumentsInScope(user, loadOpts.documentIds);
    const scopedNote = loadOpts.documentIds?.length
        ? ` (scoped to **${loadOpts.documentIds.length}** selected file(s))`
        : '';

    if (!records.length) {
        const filter = await buildDocumentFilter(user, {});
        const count = await Document.countDocuments({
            ...filter,
            status: 'ready',
            classification: { $in: ['invoice', 'expense_report', 'payment_receipt', 'financial_statement'] },
        });
        const fileReport = await buildFinanceFileCoverage(user, [], loadOpts);
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            coverage: computeFinanceCoverage([], docsInScope, fileReport),
            answer: [
                '**Finance analytics**',
                '',
                count > 0
                    ? `You have **${count}** ready finance-classified document(s), but extracted amounts are not available yet. Open each document and wait for extraction to finish, then refresh analytics.`
                    : 'No ready finance documents found. Upload invoices or expense reports and wait until status is **ready** with extraction complete.',
            ].join('\n'),
        };
    }

    const visuals = [];
    const citations = records.slice(0, 8).map((r) => ({
        documentId: r.documentId,
        filename: r.filename,
        documentType: 'invoice',
        phase3Agent: FINANCE_AGENT,
    }));

    if (intent === 'vendor_spend' || intent === 'overview') {
        visuals.push(buildVendorSpendVisual(records));
    }
    if (intent === 'client_spend' || intent === 'overview') {
        visuals.push(buildClientSpendVisual(records));
    }
    if (intent === 'monthly_trend' || intent === 'overview') {
        const trend = buildMonthlyTrendVisual(records);
        if (trend.data.length) visuals.push(trend);
    }
    if (intent === 'aging' || intent === 'overview') {
        visuals.push(buildAgingVisual(records));
    }
    if (intent === 'doc_mix') {
        const filter = await buildDocumentFilter(user, {});
        const docQuery: Record<string, unknown> = {
            ...filter,
            classification: {
                $in: [
                    'invoice',
                    'expense_report',
                    'payment_receipt',
                    'financial_statement',
                    'tax_document',
                    'bank_statement',
                    'budget',
                ],
            },
        };
        if (loadOpts.documentIds?.length) {
            docQuery.documentId = { $in: loadOpts.documentIds };
        }
        const docs = await Document.find(docQuery).select('classification').lean();
        const counts = new Map<string, number>();
        for (const d of docs) {
            const t = String(d.classification || 'other');
            counts.set(t, (counts.get(t) || 0) + 1);
        }
        visuals.push(
            buildDocTypeMixVisual(
                [...counts.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
            )
        );
    }

    const uniqueVisuals = visuals.filter((v, i, arr) => arr.findIndex((x) => x.title === v.title) === i);
    const totalsByCurrency = sumTotalsByCurrency(records);
    const totalLines = [...totalsByCurrency.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cur, amt]) => `**${cur}** ${Math.round(amt * 100) / 100}`)
        .join(' · ');
    const docIds = new Set(records.map((r) => r.documentId));
    const fileReport = await buildFinanceFileCoverage(user, records, loadOpts);
    const coverage = computeFinanceCoverage(records, docsInScope, fileReport);

    const vendorTable =
        intent === 'vendor_spend' || intent === 'overview'
            ? formatVendorSpendTable(records)
            : '';

    return {
        visuals: uniqueVisuals,
        citations,
        documentCount: docIds.size,
        coverage,
        answer: [
            `I used **${docIds.size}** document(s) with extracted amounts${scopedNote}.`,
            '',
            `- Totals: ${totalLines || '—'}`,
            `- Charts: ${uniqueVisuals.map((v) => v.title).join(' · ') || 'none'}`,
            '',
            vendorTable ? `### Vendor totals\n\n${vendorTable}` : '',
            '',
            'Numbers are summed from invoice extractions (one total per invoice).',
        ]
            .filter(Boolean)
            .join('\n'),
    };
}
