import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import AgentApiToken from '../models/AgentApiToken';
import Document from '../models/Document';
import { hasPermission, canAccessDocument } from '../services/accessScope';
import { getActiveSubscription, getAllowedAgentsForOrg, requireAllowedAgent } from '../services/planService';
import { PERMISSIONS } from '../types/permissions';
import { PLAN_AGENT_LABELS } from '../models/AgentStoragePricing';
import { chatWithDocuments } from './chatController';
import { recordActivityFromReq } from '../services/activityLog';
import { ensureUploadDir, saveUploadedFile } from '../services/documentStorage';
import {
    agentApiTtlHours,
    buildPartnerDocumentPayload,
    markAgentApiDocument,
    normalizeAgentApiAgentId,
    purgeAgentApiDocument,
    waitForPartnerDocumentReady,
} from '../services/agentApiDocumentService';
import { resolveAgentApiUploadFile } from '../middleware/agentApiUpload';

function generateAgentApiKey(): string {
    return `vdag_${crypto.randomBytes(24).toString('hex')}`;
}

function maskToken(token: string): string {
    const t = String(token || '');
    if (t.length < 12) return '••••';
    return `${t.slice(0, 6)}****${t.slice(-4)}`;
}

function publicBase(req: Request): string {
    return (
        process.env.PUBLIC_API_URL ||
        process.env.API_PUBLIC_URL ||
        `${req.protocol}://${req.get('host')}`
    ).replace(/\/$/, '');
}

async function requireSettingsAdmin(req: Request, res: Response): Promise<string | null> {
    if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
        res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        return null;
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
        res.status(400).json({ success: false, message: 'organizationId required' });
        return null;
    }
    const sub = await getActiveSubscription(orgId);
    if (!sub && req.user.role !== 'superAdmin') {
        res.status(403).json({
            success: false,
            message: 'Active subscription required to use Agent API',
        });
        return null;
    }
    return orgId;
}

/** Admin: get token status + example URLs (key masked). */
export const getAgentApiStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const row = await AgentApiToken.findOne({ organizationId: orgId }).lean();
        const agents = await getAllowedAgentsForOrg(orgId);
        const base = publicBase(req);

        res.json({
            success: true,
            data: {
                hasToken: Boolean(row?.token && row?.isActive),
                tokenMasked: row?.token ? maskToken(row.token) : null,
                label: row?.label || null,
                isActive: row?.isActive ?? false,
                lastUsedAt: row?.lastUsedAt || null,
                createdAt: row?.createdAt || null,
                allowedAgents: agents.map((id) => ({
                    id,
                    label: PLAN_AGENT_LABELS[id] || id,
                })),
                askUrlTemplate: `${base}/api/v1/agents/{agentId}/ask`,
                processUrlTemplate: `${base}/api/v1/agents/{agentId}/process`,
                documentsUrlTemplate: `${base}/api/v1/agents/{agentId}/documents`,
                exampleAskUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/ask`
                    : `${base}/api/v1/agents/compliance_agent/ask`,
                exampleProcessUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/process`
                    : `${base}/api/v1/agents/compliance_agent/process`,
                ephemeralTtlHours: agentApiTtlHours(),
                partnerFlow: [
                    'POST /process once (multipart file + optional message)',
                    'Visibility runs upload + OCR/extract + agent',
                    'Save data.store (+ data.reply) in YOUR database',
                    'DELETE /documents/:id (or auto-expire)',
                ],
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Admin: create or rotate Agent API token (full key returned once). */
export const rotateAgentApiToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const label = String(req.body?.label || 'Agent API').trim() || 'Agent API';
        const token = generateAgentApiKey();
        const tokenId = `aat_${crypto.randomBytes(8).toString('hex')}`;

        let row = await AgentApiToken.findOne({ organizationId: orgId });
        const isNew = !row;
        if (!row) {
            row = new AgentApiToken({
                tokenId,
                organizationId: orgId,
                token,
                label,
                isActive: true,
            });
        } else {
            row.token = token;
            row.label = label;
            row.isActive = true;
            row.lastUsedAt = null;
        }
        await row.save();

        recordActivityFromReq(req, {
            action: isNew ? 'agent_api.create' : 'agent_api.rotate',
            category: 'admin',
            resourceType: 'agent_api_token',
            resourceId: row.tokenId,
            message: isNew ? 'Created Agent API token' : 'Rotated Agent API token',
        });

        const base = publicBase(req);
        const agents = await getAllowedAgentsForOrg(orgId);

        res.json({
            success: true,
            message: isNew
                ? 'Agent API token created — copy it now'
                : 'Agent API token rotated — copy the new key now',
            data: {
                token,
                tokenMasked: maskToken(token),
                label: row.label,
                askUrlTemplate: `${base}/api/v1/agents/{agentId}/ask`,
                processUrlTemplate: `${base}/api/v1/agents/{agentId}/process`,
                documentsUrlTemplate: `${base}/api/v1/agents/{agentId}/documents`,
                exampleAskUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/ask`
                    : `${base}/api/v1/agents/compliance_agent/ask`,
                exampleProcessUrl: agents[0]
                    ? `${base}/api/v1/agents/${agents[0]}/process`
                    : `${base}/api/v1/agents/compliance_agent/process`,
                ephemeralTtlHours: agentApiTtlHours(),
                allowedAgents: agents,
                curlExample: buildCurlExample(
                    agents[0] || 'compliance_agent',
                    `${base}/api/v1/agents/${agents[0] || 'compliance_agent'}/ask`,
                    token
                ),
                curlProcessExample: buildProcessCurlExample(
                    `${base}/api/v1/agents/${agents[0] || 'compliance_agent'}/process`,
                    token
                ),
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Admin: revoke token. */
export const revokeAgentApiToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireSettingsAdmin(req, res);
        if (!orgId) return;

        const row = await AgentApiToken.findOne({ organizationId: orgId });
        if (!row) {
            return res.status(404).json({ success: false, message: 'No Agent API token found' });
        }
        row.isActive = false;
        await row.save();

        recordActivityFromReq(req, {
            action: 'agent_api.revoke',
            category: 'admin',
            resourceType: 'agent_api_token',
            resourceId: row.tokenId,
            message: 'Revoked Agent API token',
        });

        res.json({ success: true, message: 'Agent API token revoked' });
    } catch (error) {
        next(error);
    }
};

function buildCurlExample(agentId: string, url: string, token: string): string {
    return `curl -sS -X POST '${url}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"message":"What can you help with?","sessionId":"demo-1"}'`;
}

function buildProcessCurlExample(url: string, token: string): string {
    return `curl -sS -X POST '${url}' \\\n  -H 'Authorization: Bearer ${token}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"fileName":"doc.pdf","fileBase64":"<BASE64>","message":"Scan and summarize","waitSeconds":90}'\n\n# or multipart (do not set Content-Type by hand):\ncurl -sS -X POST '${url}' -H 'Authorization: Bearer ${token}' -F 'file=@/path/to/document.pdf' -F 'message=Scan and summarize'`;
}

async function resolveEntitledAgentId(
    req: Request,
    res: Response
): Promise<string | null> {
    if (!req.user?.organizationId) {
        res.status(401).json({ success: false, message: 'Unauthorized' });
        return null;
    }
    const rawAgent = String(req.params.agentId || '').trim();
    const allowed = await getAllowedAgentsForOrg(req.user.organizationId);
    const agentId = normalizeAgentApiAgentId(rawAgent, allowed);
    if (!agentId) {
        res.status(400).json({
            success: false,
            message: 'agentId is required in the path, e.g. /api/v1/agents/compliance_agent/process',
        });
        return null;
    }
    const check = await requireAllowedAgent(req.user, agentId);
    if (!check.ok) {
        res.status(403).json({
            success: false,
            code: check.code,
            message: check.message,
            data: { allowedAgents: check.entitlement.agentIds },
        });
        return null;
    }
    return agentId;
}

function mapUploadError(error: any, res: Response): Response | null {
    if (error.statusCode === 429 || error.code === 'GROQ_RATE_LIMIT') {
        return res.status(429).json({
            success: false,
            code: 'GROQ_RATE_LIMIT',
            message: error.message || 'Groq rate limit reached',
            ...(error.groq || {}),
        });
    }
    if (error.statusCode === 415) {
        return res.status(415).json({ success: false, message: error.message });
    }
    if (error.statusCode === 409) {
        return res.status(409).json({
            success: false,
            code: error.code || 'DUPLICATE_FILE',
            message: error.message,
            data: error.existingDocumentId
                ? { existingDocumentId: error.existingDocumentId }
                : undefined,
        });
    }
    if (error.statusCode === 403 && error.code === 'STORAGE_LIMIT') {
        return res.status(403).json({
            success: false,
            code: 'STORAGE_LIMIT',
            message: error.message,
        });
    }
    return null;
}

/**
 * Public: POST /api/v1/agents/:agentId/documents
 * Multipart file upload → Visibility OCR/extract pipeline (ephemeral for partners).
 */
export const uploadDocumentViaAgentApi = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const agentId = await resolveEntitledAgentId(req, res);
        if (!agentId || !req.user) return;

        const resolved = await resolveAgentApiUploadFile(req);
        if ('error' in resolved) {
            return res.status(400).json({
                success: false,
                message: resolved.error,
                hint: resolved.hint,
            });
        }
        const file = resolved.file;

        const { assertStorageAvailable } = await import('../services/planService');
        const storageCheck = await assertStorageAvailable(
            req.user.organizationId,
            file.size || 0
        );
        if (!storageCheck.ok) {
            if (file.path && fs.existsSync(file.path)) {
                try {
                    fs.unlinkSync(file.path);
                } catch {
                    /* ignore */
                }
            }
            return res.status(403).json({
                success: false,
                code: 'STORAGE_LIMIT',
                message: storageCheck.message,
            });
        }

        ensureUploadDir();
        const ephemeral =
            String(req.body?.ephemeral ?? req.query?.ephemeral ?? 'true').toLowerCase() !==
            'false';

        const { doc } = await saveUploadedFile(
            req.user,
            {
                path: file.path,
                originalname: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
            },
            agentId
        );
        await markAgentApiDocument(doc.documentId, { ephemeral, agentId });
        const refreshed = await Document.findOne({ documentId: doc.documentId });
        const payload = refreshed
            ? await buildPartnerDocumentPayload(refreshed, req.user)
            : null;

        recordActivityFromReq(req, {
            action: 'agent_api.document_upload',
            category: 'document',
            resourceType: 'document',
            resourceId: doc.documentId,
            message: `Agent API uploaded ${doc.originalFilename}`,
            metadata: { agentId, ephemeral },
        });

        return res.status(201).json({
            success: true,
            message:
                'File accepted. Visibility is extracting data. Poll GET …/documents/:id or use POST …/process with wait.',
            data: {
                ...payload,
                next: {
                    statusUrl: `${publicBase(req)}/api/v1/agents/${agentId}/documents/${doc.documentId}`,
                    askUrl: `${publicBase(req)}/api/v1/agents/${agentId}/ask`,
                    askBodyExample: {
                        message: 'Summarize compliance risks in this document',
                        documentIds: [doc.documentId],
                        sessionId: 'partner-1',
                    },
                    note: 'Persist data.store in YOUR database when ready=true, then DELETE the document or let it expire.',
                },
            },
        });
    } catch (error: any) {
        const mapped = mapUploadError(error, res);
        if (mapped) return mapped;
        next(error);
    }
};

/**
 * Public: GET /api/v1/agents/:agentId/documents/:documentId
 * Status + OCR/extract payload for the partner to copy into their DB.
 */
export const getDocumentViaAgentApi = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const agentId = await resolveEntitledAgentId(req, res);
        if (!agentId || !req.user) return;

        const documentId = String(req.params.documentId || '').trim();
        if (!documentId) {
            return res.status(400).json({ success: false, message: 'documentId required' });
        }

        const doc = await Document.findOne({
            documentId,
            organizationId: req.user.organizationId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const payload = await buildPartnerDocumentPayload(doc, req.user);

        const purge =
            String(req.query.purge || '').toLowerCase() === '1' ||
            String(req.query.purge || '').toLowerCase() === 'true';
        if (purge && payload.ready) {
            await purgeAgentApiDocument(documentId, req.user.organizationId!);
            return res.json({
                success: true,
                message: 'Extract ready — document purged from Visibility after return',
                data: {
                    ...payload,
                    purged: true,
                    note: 'Save data.store in your DB now; Visibility no longer holds this file.',
                },
            });
        }

        return res.json({
            success: true,
            data: {
                ...payload,
                agentId,
                hint: payload.ready
                    ? 'Copy data.store into your database, then DELETE this document or call ?purge=1'
                    : 'Still processing — poll again in a few seconds',
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Public: DELETE /api/v1/agents/:agentId/documents/:documentId
 * Partner deletes after they stored extract in their system.
 */
export const deleteDocumentViaAgentApi = async (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    try {
        const agentId = await resolveEntitledAgentId(req, res);
        if (!agentId || !req.user?.organizationId) return;

        const documentId = String(req.params.documentId || '').trim();
        const ok = await purgeAgentApiDocument(documentId, req.user.organizationId);
        if (!ok) {
            return res.status(404).json({
                success: false,
                message: 'Document not found or not an Agent API document',
            });
        }
        recordActivityFromReq(req, {
            action: 'agent_api.document_purge',
            category: 'document',
            resourceType: 'document',
            resourceId: documentId,
            message: 'Agent API purged document after partner stored data',
            metadata: { agentId },
        });
        return res.json({
            success: true,
            message: 'Document removed from Visibility storage',
        });
    } catch (error) {
        next(error);
    }
};

/** Capture chatWithDocuments JSON without double-sending the HTTP response. */
async function runAgentAskCaptured(
    req: Request,
    res: Response,
    next: NextFunction,
    opts: {
        agentId: string;
        message: string;
        documentIds: string[];
        sessionId?: string;
    }
): Promise<{ reply?: string; citations?: unknown; model?: string; error?: string }> {
    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let captured: any = null;
    let statusCode = 200;

    (res as any).json = (body: any) => {
        captured = body;
        return res;
    };
    (res as any).status = (code: number) => {
        statusCode = code;
        return res;
    };

    const prevBody = req.body;
    req.body = {
        ...prevBody,
        message: opts.message,
        phase3Agent: opts.agentId,
        phase3_agent: opts.agentId,
        chatScope: 'selected',
        documentIds: opts.documentIds,
        sessionId: opts.sessionId || prevBody?.sessionId || `agent-api-${Date.now()}`,
    };

    try {
        await chatWithDocuments(req, res, (err?: any) => {
            if (err && !captured) {
                captured = { message: err?.message || 'Agent ask failed' };
                statusCode = 500;
            }
        });
    } catch (e: any) {
        (res as any).json = originalJson;
        (res as any).status = originalStatus;
        req.body = prevBody;
        return { error: e?.message || 'Agent ask failed' };
    }

    (res as any).json = originalJson;
    (res as any).status = originalStatus;
    req.body = prevBody;

    if (statusCode >= 400) {
        return {
            error: captured?.message || `Agent ask failed (${statusCode})`,
        };
    }
    return {
        reply: captured?.data?.reply,
        citations: captured?.data?.citations,
        model: captured?.data?.model,
    };
}

/**
 * Public: POST /api/v1/agents/:agentId/process
 * One-shot partner API: upload → OCR/extract → agent reply.
 * Chat-only (message, no file) is accepted and handled like /ask.
 */
export const processViaAgentApi = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> => {
    try {
        const agentId = await resolveEntitledAgentId(req, res);
        if (!agentId || !req.user) return;

        const resolved = await resolveAgentApiUploadFile(req);
        if ('error' in resolved) {
            // Message without file → chat (same as /ask)
            const chatOnly = String(
                req.body?.message || req.body?.query || req.query?.message || ''
            ).trim();
            if (chatOnly) {
                return askAgentViaApi(req, res, next);
            }
            return res.status(400).json({
                success: false,
                message: resolved.error,
                hint: resolved.hint || {
                    ask: {
                        method: 'POST',
                        path: `/api/v1/agents/${agentId}/ask`,
                        body: { message: 'What can you help with?', sessionId: 'demo-1' },
                    },
                    process: {
                        method: 'POST',
                        path: `/api/v1/agents/${agentId}/process`,
                        body: {
                            fileName: 'invoice.pdf',
                            fileBase64: '<base64>',
                            message: 'Extract key fields as JSON',
                            waitSeconds: 90,
                        },
                    },
                },
            });
        }
        const file = resolved.file;

        const { assertStorageAvailable } = await import('../services/planService');
        const storageCheck = await assertStorageAvailable(
            req.user.organizationId,
            file.size || 0
        );
        if (!storageCheck.ok) {
            if (file.path && fs.existsSync(file.path)) {
                try {
                    fs.unlinkSync(file.path);
                } catch {
                    /* ignore */
                }
            }
            return res.status(403).json({
                success: false,
                code: 'STORAGE_LIMIT',
                message: storageCheck.message,
            });
        }

        ensureUploadDir();
        const ephemeral =
            String(req.body?.ephemeral ?? req.query?.ephemeral ?? 'true').toLowerCase() !==
            'false';
        const waitSeconds = Math.min(
            120,
            Math.max(
                0,
                Number(req.body?.waitSeconds ?? req.query?.waitSeconds ?? 90) || 90
            )
        );
        const skipAgent =
            String(req.body?.skipAgent ?? req.query?.skipAgent ?? '').toLowerCase() ===
                'true' ||
            String(req.body?.skipAgent ?? req.query?.skipAgent ?? '') === '1';

        const rawUserMessage = String(
            req.body?.message || req.body?.query || req.query?.message || ''
        ).trim();
        const usedDefaultMessage = !rawUserMessage;
        const userMessage = usedDefaultMessage
            ? 'List the key fields from this document (invoice number, dates, parties, totals, line items if any). Answer briefly.'
            : rawUserMessage;

        // Force the chat agent to obey the partner's instruction (not a generic template)
        const message = usedDefaultMessage
            ? userMessage
            : [
                  'Answer ONLY what the user asked below, using this document.',
                  'Do not invent a different task. Do not give a long generic “OCR summary / risks” essay unless they asked for that.',
                  'Be direct and match their requested format (JSON, table, short list, etc.).',
                  '',
                  'User request:',
                  userMessage,
              ].join('\n');

        const { doc } = await saveUploadedFile(
            req.user,
            {
                path: file.path,
                originalname: file.originalname,
                mimetype: file.mimetype,
                size: file.size,
            },
            agentId
        );
        await markAgentApiDocument(doc.documentId, { ephemeral, agentId });

        let payload = await waitForPartnerDocumentReady(
            doc.documentId,
            req.user,
            waitSeconds * 1000
        );
        if (!payload) {
            const refreshed = await Document.findOne({ documentId: doc.documentId });
            if (!refreshed) {
                return res.status(500).json({
                    success: false,
                    message: 'Document disappeared after upload',
                });
            }
            payload = await buildPartnerDocumentPayload(refreshed, req.user);
        }

        let reply: string | null = null;
        let citations: unknown = null;
        let model: string | null = null;
        let agentError: string | null = null;

        if (!skipAgent && payload?.ready) {
            const askResult = await runAgentAskCaptured(req, res, next, {
                agentId,
                message,
                documentIds: [doc.documentId],
                sessionId: String(req.body?.sessionId || req.body?.threadId || '').trim() || undefined,
            });
            reply = askResult.reply || null;
            citations = askResult.citations ?? null;
            model = askResult.model || null;
            agentError = askResult.error || null;
        } else if (!skipAgent && !payload?.ready) {
            agentError =
                'Extract still running — agent skipped. Poll statusUrl or call /process again with higher waitSeconds.';
        }

        recordActivityFromReq(req, {
            action: 'agent_api.process',
            category: 'document',
            resourceType: 'document',
            resourceId: doc.documentId,
            message: `Agent API one-shot processed ${doc.originalFilename}`,
            metadata: {
                agentId,
                ephemeral,
                ready: payload?.ready,
                hasReply: Boolean(reply),
            },
        });

        const store = payload?.store
            ? {
                  ...payload.store,
                  reply,
                  message: userMessage,
                  agentId,
              }
            : payload?.ready
              ? {
                    documentId: doc.documentId,
                    fileName: doc.originalFilename,
                    classification: payload.classification,
                    ocrText: payload.ocrText,
                    extracted: payload.extracted,
                    cvScore: payload.cvScore,
                    reply,
                    message: userMessage,
                    agentId,
                    processedAt: new Date().toISOString(),
                }
              : null;

        return res.status(payload?.ready ? 200 : 202).json({
            success: true,
            message: payload?.ready
                ? reply
                    ? 'Upload + OCR/extract + agent done — save data.store in YOUR database'
                    : 'Upload + OCR/extract done — agent reply missing; see agentError'
                : 'File accepted; OCR still running — poll statusUrl',
            data: {
                ...payload,
                store,
                reply,
                citations,
                model,
                agentError,
                agentId,
                message: userMessage,
                messageUsedDefault: usedDefaultMessage,
                deleteUrl: `${publicBase(req)}/api/v1/agents/${agentId}/documents/${doc.documentId}`,
                statusUrl: `${publicBase(req)}/api/v1/agents/${agentId}/documents/${doc.documentId}`,
                note: 'Durable data belongs in the partner DB. DELETE the document (or wait for TTL) after you save data.store.',
            },
        });
    } catch (error: any) {
        const mapped = mapUploadError(error, res);
        if (mapped) return mapped;
        next(error);
    }
};

/**
 * Public: POST /api/v1/agents/:agentId/ask
 * Auth via Agent API token. If multipart file is present, runs full process (upload+OCR+agent).
 */
export const askAgentViaApi = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> => {
    try {
        const fileResolved = await resolveAgentApiUploadFile(req);
        if (!('error' in fileResolved)) {
            req.file = fileResolved.file;
            return processViaAgentApi(req, res, next);
        }

        // Same one-shot path when client uploads a file on /ask
        if (req.file) {
            return processViaAgentApi(req, res, next);
        }

        const agentId = await resolveEntitledAgentId(req, res);
        if (!agentId) return;

        // Also accept nested { data: { message } } some clients send
        const nested =
            req.body?.data && typeof req.body.data === 'object'
                ? req.body.data.message || req.body.data.query || req.body.data.question
                : '';
        const message = (
            req.body?.message ||
            req.body?.query ||
            req.body?.question ||
            nested ||
            req.query?.message ||
            req.query?.query ||
            req.query?.question ||
            ''
        )
            .toString()
            .trim();
        if (!message) {
            return res.status(400).json({
                success: false,
                message: 'message is required',
                hint: {
                    body: { message: 'What can you help with?', sessionId: 'demo-1' },
                },
            });
        }

        // Normalize body for chatWithDocuments
        req.body = {
            ...req.body,
            message,
            phase3Agent: agentId,
            phase3_agent: agentId,
            chatScope: req.body?.chatScope || (Array.isArray(req.body?.documentIds) && req.body.documentIds.length ? 'selected' : 'all'),
            sessionId: req.body?.sessionId || req.body?.threadId || undefined,
            documentIds: Array.isArray(req.body?.documentIds) ? req.body.documentIds : [],
        };

        return chatWithDocuments(req, res, next);
    } catch (error) {
        next(error);
    }
};
