/**
 * Generic Integration Pipeline chat — query structured JSON records (Path 2)
 * for any provider/recordType. ClickUp-specific formatting stays in clickupChatActionService.
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { formatAgentHeading, formatAgentIntro } from './agentResponseFormat';

export type StructuredRecordChatResult = {
    handled: boolean;
    answer?: string;
    citations?: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }>;
};

type RecordRow = {
    documentId: string;
    title: string;
    recordType: string;
    source: string;
    classification: string;
    phase3Agent?: string;
    summary: string;
    data: Record<string, unknown>;
};

const AGENT_META_FLAG: Record<string, string> = {
    hr_agent: 'structuredHrRecord',
    finance_agent: 'structuredFinanceRecord',
    compliance_agent: 'structuredComplianceRecord',
    legal_agent: 'structuredLegalRecord',
    procurement_agent: 'structuredProcurementRecord',
};

/** Detect asks about synced integration / API records (not file RAG). */
export function detectStructuredRecordAsk(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;

    if (
        /\b(synced\s+records?|integration\s+records?|structured\s+(data|records?)|api\s+records?)\b/.test(
            q
        )
    ) {
        return true;
    }

    if (
        /\b(show|list|what|give|tell|find|check|how\s+many)\b/.test(q) &&
        /\b(synced|integration|from\s+(clickup|sap|odoo|dynamics|drive|ats))\b/.test(q)
    ) {
        return true;
    }

    // Explicit record types commonly pushed via Path 2
    if (
        /\b(show|list|find|how\s+many)\b/.test(q) &&
        /\b(candidates?|employees?|invoices?|purchase\s+orders?|tasks?)\b/.test(q) &&
        /\b(synced|integration|record|records|from\s+)/.test(q)
    ) {
        return true;
    }

    return false;
}

function pickSummaryFields(data: Record<string, unknown>): string {
    const preferred = [
        'name',
        'title',
        'status',
        'email',
        'candidateEmail',
        'amount',
        'total',
        'vendor',
        'assignee',
        'assignees',
        'due_date',
        'dueDate',
    ];
    const parts: string[] = [];
    for (const key of preferred) {
        const v = data[key];
        if (v == null || v === '') continue;
        if (typeof v === 'object') continue;
        parts.push(`${key}: ${String(v).slice(0, 80)}`);
        if (parts.length >= 4) break;
    }
    if (!parts.length) {
        const keys = Object.keys(data).slice(0, 3);
        for (const k of keys) {
            const v = data[k];
            if (v != null && typeof v !== 'object') parts.push(`${k}: ${String(v).slice(0, 60)}`);
        }
    }
    return parts.join(' · ') || '—';
}

function parseRecordFromDoc(doc: {
    documentId: string;
    originalFilename?: string | null;
    classification?: string | null;
    metadata?: Record<string, unknown> | null;
}): RecordRow | null {
    const meta = (doc.metadata || {}) as Record<string, unknown>;
    if (meta.ingestKind !== 'structured_record') return null;
    const data = (meta.structuredData || {}) as Record<string, unknown>;
    const title =
        String(meta.title || data.name || data.title || doc.originalFilename || 'Record')
            .replace(/\.json$/i, '')
            .trim() || 'Record';
    return {
        documentId: doc.documentId,
        title,
        recordType: String(meta.recordType || 'generic'),
        source: String(meta.source || meta.integrationLabel || 'integration'),
        classification: String(doc.classification || meta.classification || 'integration_record'),
        phase3Agent: meta.phase3Agent ? String(meta.phase3Agent) : undefined,
        summary: pickSummaryFields(data),
        data,
    };
}

export async function loadStructuredRecords(
    user: AuthUser,
    opts?: {
        limit?: number;
        phase3Agent?: string;
        recordType?: string;
        source?: string;
        q?: string;
    }
): Promise<RecordRow[]> {
    const filter = await buildDocumentFilter(user, {});
    const limit = Math.min(80, Math.max(1, opts?.limit ?? 40));
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        'metadata.ingestKind': 'structured_record',
    };

    if (opts?.phase3Agent) {
        const flag = AGENT_META_FLAG[opts.phase3Agent];
        if (flag) {
            query.$or = [
                { [`metadata.${flag}`]: true },
                { 'metadata.phase3Agent': opts.phase3Agent },
            ];
        } else {
            query['metadata.phase3Agent'] = opts.phase3Agent;
        }
    }
    if (opts?.recordType) {
        query['metadata.recordType'] = opts.recordType;
    }
    if (opts?.source) {
        query['metadata.source'] = new RegExp(
            String(opts.source).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'i'
        );
    }

    const docs = await Document.find(query)
        .select('documentId originalFilename classification metadata updatedAt')
        .sort({ updatedAt: -1 })
        .limit(limit * 2)
        .lean();

    let rows = docs
        .map((d) =>
            parseRecordFromDoc({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                classification: d.classification,
                metadata: d.metadata as Record<string, unknown> | undefined,
            })
        )
        .filter((r): r is RecordRow => Boolean(r));

    const needle = opts?.q?.toLowerCase().trim();
    if (needle) {
        rows = rows.filter(
            (r) =>
                r.title.toLowerCase().includes(needle) ||
                r.recordType.toLowerCase().includes(needle) ||
                r.source.toLowerCase().includes(needle) ||
                r.summary.toLowerCase().includes(needle)
        );
    }

    return rows.slice(0, limit);
}

function inferRecordTypeFromQuestion(question: string): string | undefined {
    const q = question.toLowerCase();
    if (/\bcandidates?\b|\bemployees?\b|\bresumes?\b/.test(q)) return 'candidate';
    if (/\binvoices?\b/.test(q)) return 'invoice';
    if (/\bpurchase\s+orders?\b|\b\bpo\b/.test(q)) return 'purchase_order';
    if (/\btasks?\b/.test(q)) return 'task';
    return undefined;
}

function inferSourceFromQuestion(question: string): string | undefined {
    const q = question.toLowerCase();
    if (/\bclick\s*up\b|\bclickup\b/.test(q)) return 'clickup';
    if (/\bsap\b/.test(q)) return 'sap';
    if (/\bodoo\b/.test(q)) return 'odoo';
    if (/\bdynamics\b/.test(q)) return 'dynamics365';
    if (/\bdrive\b|\bgoogle\b/.test(q)) return 'google_drive';
    return undefined;
}

function buildTable(rows: RecordRow[]): string {
    const header = '| Title | Type | Source | Summary |';
    const sep = '| --- | --- | --- | --- |';
    const body = rows.map(
        (r) =>
            `| ${r.title.replace(/\|/g, '/')} | ${r.recordType} | ${r.source} | ${r.summary.replace(/\|/g, '/')} |`
    );
    return [header, sep, ...body].join('\n');
}

export async function tryStructuredRecordCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
}): Promise<StructuredRecordChatResult> {
    if (!detectStructuredRecordAsk(params.question)) {
        return { handled: false };
    }

    const recordType = inferRecordTypeFromQuestion(params.question);
    const source = inferSourceFromQuestion(params.question);
    const rows = await loadStructuredRecords(params.user, {
        phase3Agent: params.phase3Agent,
        recordType,
        source,
        limit: 40,
    });

    const agent = params.phase3Agent || 'other_agent';
    const heading = formatAgentHeading('Synced integration records', 2);
    const intro = formatAgentIntro(
        rows.length
            ? [
                  `Found **${rows.length}** synced record${rows.length === 1 ? '' : 's'} from Integrations (API/JSON).`,
              ]
            : ['No synced integration records match this question yet.']
    );

    if (!rows.length) {
        return {
            handled: true,
            answer: [
                heading,
                '',
                intro,
                '',
                'Connect an integration and sync or push records, then ask again.',
            ].join('\n'),
            citations: [],
        };
    }

    const answer = [
        heading,
        '',
        intro,
        '',
        buildTable(rows),
        '',
        '_These are Integration pipeline records (structured data), not uploaded PDF/DOCX files._',
    ].join('\n');

    return {
        handled: true,
        answer,
        citations: rows.slice(0, 12).map((r) => ({
            documentId: r.documentId,
            filename: `${r.title}.json`,
            documentType: r.classification || 'integration_record',
            phase3Agent: r.phase3Agent || agent,
        })),
    };
}
