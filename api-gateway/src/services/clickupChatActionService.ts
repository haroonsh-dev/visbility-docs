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

/** Product agent names — never treat as ClickUp task-name filters. */
const AGENT_PRODUCT_NAMES =
    /\b(hr|finance|legal|compliance|procurement|other)\s*agents?\b|\bagents?\s+(hr|finance|legal|compliance)\b/i;

const HR_TASK_HINTS =
    /\b(candidate|candidates|resume|cv|hiring|recruit|interview|employee|hr|engineer|offer|onboard)\b/i;

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

function readStructuredPayload(meta: Record<string, unknown>): Record<string, unknown> {
    const data = meta.structuredData ?? meta.structuredPayload ?? meta.data;
    return data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
}

function readExternalRef(meta: Record<string, unknown>): Record<string, unknown> {
    const ext = meta.integrationExternalRef ?? meta.externalRef;
    return ext && typeof ext === 'object' && !Array.isArray(ext)
        ? (ext as Record<string, unknown>)
        : {};
}

export function parseClickUpTaskFromDoc(doc: {
    documentId: string;
    originalFilename?: string | null;
    metadata?: Record<string, unknown> | null;
    updatedAt?: Date;
}): ClickUpTaskRow | null {
    const meta = (doc.metadata || {}) as Record<string, unknown>;
    const data = readStructuredPayload(meta);
    const ext = readExternalRef(meta);

    const taskId = String(data.taskId || data.id || ext.clickupTaskId || ext.recordId || '')
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

    const statusRaw = data.status;
    let status = '—';
    if (typeof statusRaw === 'string') status = statusRaw.trim() || '—';
    else if (statusRaw && typeof statusRaw === 'object') {
        status = String((statusRaw as { status?: string }).status || '').trim() || '—';
    }

    return {
        documentId: doc.documentId,
        taskId: taskId || doc.documentId,
        name,
        status,
        assignees: formatClickUpAssignees(data.assignees),
        dueDate: formatDueDate(data.due_date ?? data.dueDate),
        listName,
        url: String(data.url || '').trim(),
        updatedAt: doc.updatedAt ? doc.updatedAt.toISOString().slice(0, 10) : '—',
    };
}

function isHrAgentContext(phase3Agent?: string, question?: string): boolean {
    if ((phase3Agent || '').toLowerCase() === 'hr_agent') return true;
    return /\bhr\s*agent\b|\bhr\b.*\b(task|tasks|clickup)\b|\b(task|tasks|clickup)\b.*\bhr\b/i.test(
        question || ''
    );
}

/** Detect asks about synced ClickUp tasks (incl. HR Agent task questions). */
export function detectClickUpTaskAsk(question: string, phase3Agent?: string): boolean {
    const q = question.toLowerCase().trim();
    if (!q) return false;

    if (/\bclick\s*up\b/.test(q) || /\bclickup\b/.test(q)) return true;
    if (/\b(integration\s+record|synced\s+task|synced\s+tasks)\b/.test(q)) return true;

    if (
        /\b(who\s+is\s+assigned|assigned\s+to|assignees?|my\s+tasks)\b/.test(q) &&
        /\b(task|tasks|list|ticket)\b/.test(q)
    ) {
        return true;
    }

    if (
        /\b(task|tasks|tickets?)\b/.test(q) &&
        /\b(show|list|what|any|all|find|check|give|tell|which)\b/.test(q)
    ) {
        return true;
    }

    if (AGENT_PRODUCT_NAMES.test(q) && /\b(task|tasks|ticket|tickets)\b/.test(q)) {
        return true;
    }

    if (
        isHrAgentContext(phase3Agent, question) &&
        /\b(candidate|candidates|hiring|recruit|interview|synced|integration)\b/.test(q)
    ) {
        return true;
    }

    return false;
}

function parseAssigneeNeedle(question: string): string | null {
    if (AGENT_PRODUCT_NAMES.test(question)) return null;
    const patterns = [
        /tasks?\s+(?:for|assigned\s+to|of)\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /assigned\s+to\s+([A-Za-z][A-Za-z\s.'-]{1,40})/i,
        /([A-Za-z][A-Za-z\s.'-]{1,40})['']?s\s+tasks?/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (
            raw &&
            raw.length >= 2 &&
            !/^(click|clickup|the|all|my|what|show|list|check|hr|agent)$/i.test(raw)
        ) {
            return raw.replace(/\b(tasks?|clickup|list|agent)\b.*$/i, '').trim();
        }
    }
    return null;
}

function parseTaskNameNeedle(question: string): string | null {
    if (AGENT_PRODUCT_NAMES.test(question) && !/task\s+(?:named|called|title)\s+/i.test(question)) {
        return null;
    }
    const m = question.match(/task\s+(?:named|called|title)\s+["']?([^"'\n.]+)/i);
    const raw = m?.[1]?.trim() || null;
    if (raw && AGENT_PRODUCT_NAMES.test(raw)) return null;
    return raw;
}

function isHrRelevantTask(row: ClickUpTaskRow): boolean {
    return HR_TASK_HINTS.test(`${row.name} ${row.listName}`);
}

function rowQualityScore(row: ClickUpTaskRow): number {
    let score = 0;
    if (row.status && row.status !== '—') score += 3;
    if (row.listName && row.listName !== '—' && !/^clickup$/i.test(row.listName)) score += 2;
    if (row.assignees && row.assignees !== 'Unassigned') score += 1;
    if (row.dueDate && row.dueDate !== '—') score += 1;
    if (row.url) score += 1;
    return score;
}

/** Prefer richer row when the same ClickUp task was synced twice. */
export function dedupeClickUpTaskRows(rows: ClickUpTaskRow[]): ClickUpTaskRow[] {
    const byTaskId = new Map<string, ClickUpTaskRow>();
    const noId: ClickUpTaskRow[] = [];

    for (const row of rows) {
        const id = String(row.taskId || '')
            .replace(/^clickup:task:/i, '')
            .trim()
            .toLowerCase();
        if (!id || id === row.documentId.toLowerCase()) {
            noId.push(row);
            continue;
        }
        const prev = byTaskId.get(id);
        if (!prev || rowQualityScore(row) > rowQualityScore(prev)) {
            byTaskId.set(id, row);
        }
    }

    const merged = [...byTaskId.values(), ...noId];
    const byName = new Map<string, ClickUpTaskRow>();
    for (const row of merged) {
        const key = row.name.trim().toLowerCase().replace(/\s+/g, ' ');
        const prev = byName.get(key);
        if (!prev) {
            byName.set(key, row);
            continue;
        }
        const prevWeak = prev.status === '—' || /^clickup$/i.test(prev.listName);
        const rowWeak = row.status === '—' || /^clickup$/i.test(row.listName);
        if (prevWeak !== rowWeak) {
            byName.set(key, rowWeak ? prev : row);
        } else if (rowQualityScore(row) > rowQualityScore(prev)) {
            byName.set(key, row);
        }
    }

    return [...byName.values()];
}

function structuredRecordMatch(): Record<string, unknown> {
    return {
        $or: [
            { 'metadata.ingestKind': 'structured_record' },
            { mimeType: 'application/json', 'metadata.source': 'clickup' },
            { mimeType: 'application/json', 'metadata.recordType': 'task' },
            { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
        ],
    };
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
        $and: [
            structuredRecordMatch(),
            {
                $or: [
                    { 'metadata.source': 'clickup' },
                    { 'metadata.integrationExternalRef.clickupTaskId': { $exists: true, $ne: '' } },
                    { 'metadata.recordType': 'task' },
                    { classification: 'integration_record' },
                ],
            },
        ],
    })
        .select('documentId originalFilename metadata updatedAt mimeType classification')
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

    return dedupeClickUpTaskRows(rows).slice(0, limit);
}

function buildTaskTable(rows: ClickUpTaskRow[]): string {
    const header = '| Task | Status | Assignee(s) | Due | List |';
    const sep = '| --- | --- | --- | --- | --- |';
    const body = rows.map((r) => {
        const status = r.status === '—' ? 'unknown' : r.status;
        return `| ${r.name.replace(/\|/g, '/')} | ${status.replace(/\|/g, '/')} | ${r.assignees.replace(/\|/g, '/')} | ${r.dueDate} | ${r.listName.replace(/\|/g, '/')} |`;
    });
    return [header, sep, ...body].join('\n');
}

export async function tryClickUpTaskCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
}): Promise<ClickUpChatResult> {
    if (!detectClickUpTaskAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const hrContext = isHrAgentContext(params.phase3Agent, params.question);
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
                    hrContext
                        ? '**HR Agent** is the Visibility assistant — it is not a ClickUp task name.'
                        : '',
                    `No synced ClickUp task records found${filterHint} in your portfolio.`,
                    '**To load tasks:** Admin → Integrations → ClickUp → **Sync now** (or add the webhook for live updates).',
                    hrContext
                        ? 'For hiring work, also upload resumes in **Documents** — HR Agent analyzes files there. ClickUp sync is for task/status data.'
                        : 'Each task in your connected list is stored with assignees, status, and custom fields.',
                ]),
            ].join('\n'),
            citations: [],
        };
    }

    const q = params.question.toLowerCase();
    const wantsByAssignee =
        Boolean(assigneeNeedle) ||
        /\b(who\s+is\s+assigned|assigned\s+to|assignees?|by\s+assignee)\b/.test(q);

    let answer = formatAgentHeading('ClickUp tasks', 2);

    if (hrContext) {
        answer += `\n\n${formatAgentIntro([
            '**HR Agent** is this Visibility assistant — not a task inside ClickUp.',
            `Here are **${rows.length}** synced ClickUp task(s) for HR / hiring context.`,
        ])}\n\n`;

        const hrish = rows.filter(isHrRelevantTask);
        if (hrish.length) {
            answer += '**Closest to HR / hiring:**\n\n';
            for (const t of hrish.slice(0, 8)) {
                const status = t.status === '—' ? 'unknown' : t.status;
                answer += `- **${t.name}** — ${status} · ${t.assignees}\n`;
            }
            answer += '\n';
        } else {
            answer +=
                '_No task titles look explicitly HR-related (candidate / hiring / interview). Full list below — say which task to focus on._\n\n';
        }
    } else {
        answer += `\n\n${formatAgentIntro([
            `${rows.length} task(s) from your synced ClickUp connection(s).`,
        ])}\n\n`;
    }

    if (wantsByAssignee) {
        const byAssignee = new Map<string, ClickUpTaskRow[]>();
        for (const row of rows) {
            const key = row.assignees === 'Unassigned' ? 'Unassigned' : row.assignees;
            const bucket = byAssignee.get(key) || [];
            bucket.push(row);
            byAssignee.set(key, bucket);
        }
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

    if (hrContext) {
        answer +=
            '\n\n_Tip: Upload CVs in Documents for scoring/shortlist. Ask “tasks assigned to …” to filter ClickUp._';
    } else {
        answer +=
            '\n\n_Sync again from Admin → Integrations → ClickUp → **Sync now** to refresh._';
    }

    return { handled: true, answer, citations };
}
