/**
 * ClickUp structured task records — chat queries against synced task JSON (Path 2 ingest).
 */
import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import { formatAgentHeading, formatAgentIntro } from './agentResponseFormat';

export type ClickUpTaskRow = {
    documentId: string;
    taskId: string;
    name: string;
    status: string;
    assignees: string;
    dueDate: string;
    listName: string;
    url: string;
    updatedAt: string;
};

export type ClickUpChatResult = {
    handled: boolean;
    answer?: string;
    citations?: Array<{
        documentId: string;
        filename?: string;
        documentType?: string;
        phase3Agent?: string;
    }>;
};

function normalizeAssignee(raw: unknown): string {
    if (!raw || typeof raw !== 'object') return '';
    const o = raw as Record<string, unknown>;
    const username = String(o.username || o.name || '').trim();
    const email = String(o.email || '').trim();
    if (username && email) return `${username} (${email})`;
    return username || email || String(o.id || '').trim();
}

export function formatClickUpAssignees(assignees: unknown): string {
    if (!assignees) return 'Unassigned';
    if (Array.isArray(assignees)) {
        const names = assignees.map(normalizeAssignee).filter(Boolean);
        return names.length ? names.join(', ') : 'Unassigned';
    }
    if (typeof assignees === 'string' && assignees.trim()) return assignees.trim();
    return 'Unassigned';
}

function formatDueDate(raw: unknown): string {
    if (raw == null || raw === '') return '—';
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
        const d = n > 1e12 ? new Date(n) : new Date(n * 1000);
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    const s = String(raw).trim();
    return s || '—';
}

export function parseClickUpTaskFromDoc(doc: {
    documentId: string;
    originalFilename?: string | null;
    metadata?: Record<string, unknown> | null;
    updatedAt?: Date;
}): ClickUpTaskRow | null {
    const meta = (doc.metadata || {}) as Record<string, unknown>;
    const data = (meta.structuredData || {}) as Record<string, unknown>;
    const ext = (meta.integrationExternalRef || {}) as Record<string, unknown>;

    const taskId = String(
        data.taskId || ext.clickupTaskId || ext.recordId || ''
    )
        .replace(/^clickup:task:/i, '')
        .trim();
    const name =
        String(data.name || ext.clickupTaskName || doc.originalFilename || '')
            .replace(/\.json$/i, '')
            .trim() || 'Untitled task';

    if (!taskId && !name) return null;

    const listObj = data.list as { name?: string } | undefined;
    const listName = String(
        listObj?.name || ext.clickupListName || meta.integrationLabel || '—'
    ).trim();

    return {
        documentId: doc.documentId,
        taskId: taskId || doc.documentId,
        name,
        status: String(data.status || '—').trim() || '—',
        assignees: formatClickUpAssignees(data.assignees),
        dueDate: formatDueDate(data.due_date),
        listName,
        url: String(data.url || '').trim(),
        updatedAt: doc.updatedAt ? doc.updatedAt.toISOString().slice(0, 10) : '—',
    };
}

/** Detect asks about synced ClickUp tasks, assignees, or list status. */
export function detectClickUpTaskAsk(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;

    if (/\bclick\s*up\b/.test(q) || /\bclickup\b/.test(q)) {
        return (
            /\b(task|tasks|assign|assigned|assignee|list|status|sync|ticket|tickets|project)\b/.test(q) ||
            /\b(what|show|list|check|who|which|give|tell)\b/.test(q)
        );
    }

    if (/\b(integration\s+record|synced\s+task)\b/.test(q)) return true;

    if (
        /\b(who\s+is\s+assigned|assigned\s+to|assignees?|my\s+tasks)\b/.test(q) &&
        /\b(task|tasks|clickup|list)\b/.test(q)
    ) {
        return true;
    }

    return false;
}

function parseAssigneeNeedle(question: string): string | null {
    const patterns = [
        /tasks?\s+(?:for|assigned\s+to|of)\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /assigned\s+to\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /([A-Za-z][A-Za-z\s.'-]{1,40})['']?s\s+tasks?/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (raw && raw.length >= 2 && !/^(click|clickup|the|all|my|what|show|list|check)$/i.test(raw)) {
            return raw.replace(/\b(tasks?|clickup|list)\b.*$/i, '').trim();
        }
    }
    return null;
}

function parseTaskNameNeedle(question: string): string | null {
    const m = question.match(/task\s+(?:named|called|title)\s+["']?([^"'\n.]+)/i);
    return m?.[1]?.trim() || null;
}

export async function loadClickUpTaskRows(
    user: AuthUser,
    opts?: { limit?: number; assigneeNeedle?: string; nameNeedle?: string }
): Promise<ClickUpTaskRow[]> {
    const filter = await buildDocumentFilter(user, {});
    const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));

    const docs = await Document.find({
        ...filter,
        status: 'ready',
        'metadata.ingestKind': 'structured_record',
        $or: [
            { 'metadata.source': 'clickup' },
            { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
        ],
    })
        .select('documentId originalFilename metadata updatedAt')
        .sort({ updatedAt: -1 })
        .limit(limit * 2)
        .lean();

    let rows = docs
        .map((d) =>
            parseClickUpTaskFromDoc({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                metadata: d.metadata as Record<string, unknown> | undefined,
                updatedAt: d.updatedAt,
            })
        )
        .filter((r): r is ClickUpTaskRow => Boolean(r));

    const assigneeNeedle = opts?.assigneeNeedle?.toLowerCase();
    if (assigneeNeedle) {
        rows = rows.filter(
            (r) =>
                r.assignees.toLowerCase().includes(assigneeNeedle) ||
                r.name.toLowerCase().includes(assigneeNeedle)
        );
    }

    const nameNeedle = opts?.nameNeedle?.toLowerCase();
    if (nameNeedle) {
        rows = rows.filter((r) => r.name.toLowerCase().includes(nameNeedle));
    }

    return rows.slice(0, limit);
}

function buildTaskTable(rows: ClickUpTaskRow[]): string {
    const header = '| Task | Status | Assignee(s) | Due | List |';
    const sep = '| --- | --- | --- | --- | --- |';
    const body = rows.map(
        (r) =>
            `| ${r.name.replace(/\|/g, '/')} | ${r.status.replace(/\|/g, '/')} | ${r.assignees.replace(/\|/g, '/')} | ${r.dueDate} | ${r.listName.replace(/\|/g, '/')} |`
    );
    return [header, sep, ...body].join('\n');
}

export async function tryClickUpTaskCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
}): Promise<ClickUpChatResult> {
    if (!detectClickUpTaskAsk(params.question)) {
        return { handled: false };
    }

    const assigneeNeedle = parseAssigneeNeedle(params.question);
    const nameNeedle = parseTaskNameNeedle(params.question);
    const rows = await loadClickUpTaskRows(params.user, {
        assigneeNeedle: assigneeNeedle || undefined,
        nameNeedle: nameNeedle || undefined,
        limit: 40,
    });

    const citations = rows.map((r) => ({
        documentId: r.documentId,
        filename: `${r.name}.json`,
        documentType: 'integration_record',
        phase3Agent: params.phase3Agent,
    }));

    if (!rows.length) {
        const filterHint = assigneeNeedle
            ? ` matching **${assigneeNeedle}**`
            : nameNeedle
              ? ` matching **${nameNeedle}**`
              : '';
        return {
            handled: true,
            answer: [
                formatAgentHeading('ClickUp tasks', 2),
                '',
                formatAgentIntro([
                    `No synced ClickUp task records found${filterHint} in your portfolio.`,
                    '**To load tasks:** Admin → Integrations → ClickUp → **Sync now** (or add the webhook for live updates).',
                    'Each task in your connected list is stored with assignees, status, and custom fields.',
                ]),
            ].join('\n'),
            citations: [],
        };
    }

    const byAssignee = new Map<string, ClickUpTaskRow[]>();
    for (const row of rows) {
        const key = row.assignees === 'Unassigned' ? 'Unassigned' : row.assignees;
        const bucket = byAssignee.get(key) || [];
        bucket.push(row);
        byAssignee.set(key, bucket);
    }

    const q = params.question.toLowerCase();
    const wantsByAssignee =
        /\b(assign|assigned|assignee|who)\b/.test(q) || Boolean(assigneeNeedle);

    let answer = formatAgentHeading('ClickUp tasks', 2);
    answer += `\n\n${formatAgentIntro([
        `${rows.length} task(s) from your synced ClickUp connection(s).`,
    ])}\n\n`;

    if (wantsByAssignee && byAssignee.size > 1) {
        answer += '**By assignee:**\n\n';
        for (const [assignee, tasks] of [...byAssignee.entries()].sort((a, b) =>
            a[0].localeCompare(b[0])
        )) {
            answer += `- **${assignee}** — ${tasks.length} task(s): ${tasks
                .slice(0, 8)
                .map((t) => t.name)
                .join(', ')}${tasks.length > 8 ? '…' : ''}\n`;
        }
        answer += '\n';
    }

    answer += buildTaskTable(rows.slice(0, 25));

    if (rows.length > 25) {
        answer += `\n\n_Showing 25 of ${rows.length} tasks. Narrow with e.g. "tasks assigned to Ahmed"._`;
    }

    answer +=
        '\n\n_Sync again from Admin → Integrations → ClickUp → **Sync now** to refresh._';

    return { handled: true, answer, citations };
}
