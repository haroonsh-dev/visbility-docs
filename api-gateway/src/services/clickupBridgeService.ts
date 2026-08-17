import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IIntegrationConnection } from '../models/IntegrationConnection';
import Document from '../models/Document';
import { getExtension, isAllowedFile } from '../utils/fileValidation';
import {
    ingestFileForConnection,
    type IngestUploadInput,
} from './integrationIngestService';

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const CLICKUP_TIMEOUT_MS = 45_000;

export type ClickUpAttachment = {
    id: string;
    title?: string;
    url?: string;
    extension?: string;
    mimetype?: string;
    size?: number;
};

export type ClickUpWebhookPayload = {
    event?: string;
    task_id?: string;
    history_items?: Array<{ field?: string; after?: unknown }>;
};

function clickUpHeaders(apiToken: string) {
    return {
        Authorization: String(apiToken || '').trim(),
        'Content-Type': 'application/json',
    };
}

export async function verifyClickUpToken(apiToken: string): Promise<{ user: string; teams: number }> {
    const token = String(apiToken || '').trim();
    if (!token) {
        throw Object.assign(new Error('ClickUp API token is required'), { statusCode: 400 });
    }
    const res = await axios.get(`${CLICKUP_API}/user`, {
        headers: clickUpHeaders(token),
        timeout: CLICKUP_TIMEOUT_MS,
    });
    const user = res.data?.user?.username || res.data?.user?.email || 'ok';
    const teams = Array.isArray(res.data?.teams) ? res.data.teams.length : 0;
    return { user: String(user), teams };
}

export async function fetchClickUpTask(taskId: string, apiToken: string): Promise<Record<string, unknown>> {
    const res = await axios.get(`${CLICKUP_API}/task/${encodeURIComponent(taskId)}`, {
        headers: clickUpHeaders(apiToken),
        timeout: CLICKUP_TIMEOUT_MS,
        params: { include_subtasks: false },
    });
    return res.data || {};
}

export async function fetchClickUpListTasks(listId: string, apiToken: string): Promise<Array<Record<string, unknown>>> {
    const tasks: Array<Record<string, unknown>> = [];
    let page = 0;
    const maxPages = 20;
    while (page < maxPages) {
        const res = await axios.get(`${CLICKUP_API}/list/${encodeURIComponent(listId)}/task`, {
            headers: clickUpHeaders(apiToken),
            timeout: CLICKUP_TIMEOUT_MS,
            params: { page, include_closed: true, subtasks: false },
        });
        const batch = Array.isArray(res.data?.tasks) ? res.data.tasks : [];
        tasks.push(...batch);
        if (batch.length < 100) break;
        page += 1;
    }
    return tasks;
}

function taskListId(task: Record<string, unknown>): string {
    const list = task.list as { id?: string } | undefined;
    return String(list?.id || '');
}

function taskAttachments(task: Record<string, unknown>): ClickUpAttachment[] {
    const raw = task.attachments;
    if (!Array.isArray(raw)) return [];
    return raw
        .map((a) => ({
            id: String((a as ClickUpAttachment).id || ''),
            title: (a as ClickUpAttachment).title,
            url: (a as ClickUpAttachment).url,
            extension: (a as ClickUpAttachment).extension,
            mimetype: (a as ClickUpAttachment).mimetype,
            size: (a as ClickUpAttachment).size,
        }))
        .filter((a) => a.id && a.url);
}

function attachmentFilename(att: ClickUpAttachment): string {
    const title = String(att.title || 'attachment').trim() || 'attachment';
    if (path.extname(title)) return title;
    const ext = String(att.extension || '').replace(/^\./, '').trim();
    if (ext) return `${title}.${ext}`;
    return title;
}

export async function downloadClickUpAttachment(
    att: ClickUpAttachment,
    apiToken: string
): Promise<IngestUploadInput> {
    const url = String(att.url || '').trim();
    if (!url) {
        throw Object.assign(new Error('Attachment has no download URL'), { statusCode: 400 });
    }
    const originalname = attachmentFilename(att);
    const ext = getExtension(originalname);
    const mimeType =
        String(att.mimetype || '').trim() ||
        (ext === 'pdf'
            ? 'application/pdf'
            : ext === 'xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : ext === 'csv'
                ? 'text/csv'
                : 'application/octet-stream');

    const validation = isAllowedFile(originalname, mimeType);
    if (!validation.ok) {
        throw Object.assign(new Error(validation.reason || 'File type not allowed'), { statusCode: 415 });
    }

    const res = await axios.get(url, {
        headers: clickUpHeaders(apiToken),
        responseType: 'arraybuffer',
        timeout: CLICKUP_TIMEOUT_MS,
        maxContentLength: 52_428_800,
    });

    const buffer = Buffer.from(res.data);
    const tmpPath = path.join(os.tmpdir(), `clickup_${Date.now()}_${Math.random().toString(36).slice(2)}_${originalname}`);
    fs.writeFileSync(tmpPath, buffer);

    return {
        path: tmpPath,
        originalname,
        mimetype: mimeType,
        size: buffer.length,
    };
}

async function attachmentAlreadyIngested(
    organizationId: string,
    connectionId: string,
    attachmentId: string
): Promise<boolean> {
    const hit = await Document.findOne({
        organizationId,
        'metadata.integrationConnectionId': connectionId,
        'metadata.integrationExternalRef.clickupAttachmentId': attachmentId,
    })
        .select('documentId')
        .lean();
    return Boolean(hit);
}

export async function ingestClickUpAttachment(opts: {
    connection: IIntegrationConnection;
    task: Record<string, unknown>;
    attachment: ClickUpAttachment;
    apiToken: string;
}) {
    const { connection, task, attachment, apiToken } = opts;

    if (
        await attachmentAlreadyIngested(
            connection.organizationId,
            connection.connectionId,
            attachment.id
        )
    ) {
        return { skipped: true as const, reason: 'already_ingested', attachmentId: attachment.id };
    }

    let tmpPath = '';
    try {
        const file = await downloadClickUpAttachment(attachment, apiToken);
        tmpPath = file.path;
        const result = await ingestFileForConnection({
            connection,
            file,
            ingestMode: 'multipart',
            externalRef: {
                clickupAttachmentId: attachment.id,
                clickupTaskId: String(task.id || ''),
                clickupTaskName: String(task.name || ''),
                clickupListId: taskListId(task),
            },
        });
        return { skipped: false as const, result };
    } finally {
        if (tmpPath && fs.existsSync(tmpPath)) {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* ignore */
            }
        }
    }
}

function listFilterMatches(connection: IIntegrationConnection, task: Record<string, unknown>): boolean {
    const configured = String(connection.config?.listId || connection.config?.clickupListId || '').trim();
    if (!configured) return true;
    return taskListId(task) === configured;
}

export async function ingestAttachmentsFromTask(connection: IIntegrationConnection, taskId: string) {
    const apiToken = String(connection.secrets?.apiToken || '').trim();
    if (!apiToken) {
        throw Object.assign(new Error('ClickUp API token not configured on this connection'), { statusCode: 400 });
    }

    const task = await fetchClickUpTask(taskId, apiToken);
    if (!listFilterMatches(connection, task)) {
        return { ingested: 0, skipped: 0, failed: 0, details: [{ taskId, reason: 'list_filter' }] };
    }

    const attachments = taskAttachments(task);
    let ingested = 0;
    let skipped = 0;
    let failed = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const att of attachments) {
        try {
            const out = await ingestClickUpAttachment({ connection, task, attachment: att, apiToken });
            if (out.skipped) {
                skipped += 1;
                details.push({ attachmentId: att.id, status: 'skipped', reason: out.reason });
            } else {
                ingested += 1;
                details.push({
                    attachmentId: att.id,
                    status: 'ingested',
                    documentId: out.result.documentId,
                    filename: out.result.filename,
                });
            }
        } catch (e: any) {
            failed += 1;
            details.push({ attachmentId: att.id, status: 'failed', error: e?.message || 'ingest failed' });
        }
    }

    return { ingested, skipped, failed, details, taskId, attachmentCount: attachments.length };
}

export async function syncClickUpList(connection: IIntegrationConnection) {
    const apiToken = String(connection.secrets?.apiToken || '').trim();
    const listId = String(connection.config?.listId || connection.config?.clickupListId || '').trim();
    if (!apiToken) {
        throw Object.assign(new Error('ClickUp API token not configured'), { statusCode: 400 });
    }
    if (!listId) {
        throw Object.assign(new Error('ClickUp List ID is required for sync'), { statusCode: 400 });
    }

    const tasks = await fetchClickUpListTasks(listId, apiToken);
    let ingested = 0;
    let skipped = 0;
    let failed = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const task of tasks) {
        const taskId = String(task.id || '');
        if (!taskId) continue;
        const attachments = taskAttachments(task);
        for (const att of attachments) {
            try {
                const out = await ingestClickUpAttachment({ connection, task, attachment: att, apiToken });
                if (out.skipped) {
                    skipped += 1;
                } else {
                    ingested += 1;
                    details.push({ taskId, documentId: out.result.documentId, filename: out.result.filename });
                }
            } catch (e: any) {
                failed += 1;
                details.push({ taskId, attachmentId: att.id, error: e?.message || 'failed' });
            }
        }
    }

    return {
        ingested,
        skipped,
        failed,
        taskCount: tasks.length,
        details: details.slice(0, 50),
    };
}

export async function processClickUpWebhook(
    connection: IIntegrationConnection,
    payload: ClickUpWebhookPayload
) {
    const taskId = String(payload?.task_id || '').trim();
    if (!taskId) {
        return { ok: true, action: 'ignored', reason: 'no task_id in webhook payload' };
    }

    const event = String(payload?.event || '').toLowerCase();
    const relevant =
        !event ||
        event.includes('task') ||
        event.includes('attachment') ||
        (Array.isArray(payload.history_items) &&
            payload.history_items.some((h) => String(h.field || '').toLowerCase().includes('attachment')));
    if (!relevant) {
        return { ok: true, action: 'ignored', reason: `event ${event || 'unknown'} not handled`, taskId };
    }

    const summary = await ingestAttachmentsFromTask(connection, taskId);
    return { ok: true, action: 'processed', taskId, ...summary };
}

export function buildClickUpWebhookUrl(base: string, connectionId: string, ingestKey: string): string {
    const root = base.replace(/\/$/, '');
    return `${root}/api/docs/integrations/clickup/${encodeURIComponent(connectionId)}/webhook?key=${encodeURIComponent(ingestKey)}`;
}
