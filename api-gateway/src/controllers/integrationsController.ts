import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import IntegrationConnection, { IntegrationSyncMode } from '../models/IntegrationConnection';
import User from '../models/User';
import { INTEGRATION_PROVIDER_IDS, SECRET_FIELD_KEYS } from '../constants/integrations';
import { getActiveSubscription } from '../services/planService';
import { recordActivityFromReq, recordActivity } from '../services/activityLog';
import { ensureUploadDir, saveUploadedFile } from '../services/documentStorage';
import { assertStorageAvailable } from '../services/planService';
import { hasPermission, type AuthUser } from '../services/accessScope';
import { PERMISSIONS } from '../types/permissions';
import {
    computeNextSyncAt,
    importDriveFiles,
    listDriveFilesWithLibraryStatus,
    testGoogleDriveConnection,
} from '../services/integrationSyncService';
import { normalizeFolderId, parseCredentials } from '../services/googleDriveService';
import { sendDocumentsViaIntegration, sendRawFileViaIntegration } from '../services/integrationSendService';
import fs from 'fs';

function maskSecret(value: string): string {
    if (!value || value.length < 8) return '****';
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

function maskSecrets(secrets: Record<string, string> | undefined | null) {
    const out: Record<string, string> = {};
    if (!secrets) return out;
    for (const [k, v] of Object.entries(secrets)) {
        out[k] = maskSecret(String(v || ''));
    }
    return out;
}

function splitPayload(raw: Record<string, unknown>) {
    const config: Record<string, string | number | boolean | null> = {};
    const secrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (value === undefined || value === null || value === '') continue;
        if (SECRET_FIELD_KEYS.has(key) || key.toLowerCase().includes('secret') || key.toLowerCase().includes('password') || key === 'privateKey') {
            secrets[key] = String(value);
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            config[key] = value;
        } else {
            config[key] = String(value);
        }
    }
    return { config, secrets };
}

function generateIngestKey(): string {
    return `vdint_${crypto.randomBytes(24).toString('hex')}`;
}

function parseSyncMode(raw: unknown): IntegrationSyncMode {
    const v = String(raw || 'interval').toLowerCase();
    if (v === 'daily' || v === 'manual' || v === 'interval') return v;
    return 'interval';
}

function parseDailyAt(raw: unknown): string {
    const v = String(raw || '09:00').trim();
    return /^\d{1,2}:\d{2}$/.test(v) ? v : '09:00';
}

function parseBool(raw: unknown, fallback = true): boolean {
    if (typeof raw === 'boolean') return raw;
    const v = String(raw ?? '').toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes') return true;
    if (v === 'false' || v === '0' || v === 'no') return false;
    return fallback;
}

async function requireAdminWithActivePlan(req: Request, res: Response): Promise<string | null> {
    if (!req.user || !hasPermission(req.user, PERMISSIONS.PAGE_INTEGRATIONS)) {
        res.status(403).json({ success: false, message: 'Missing permission: page.integrations' });
        return null;
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
        res.status(400).json({ success: false, message: 'organizationId required' });
        return null;
    }
    const sub = await getActiveSubscription(orgId);
    if (!sub) {
        res.status(403).json({
            success: false,
            code: 'PLAN_REQUIRED',
            message: 'An active subscription plan is required to use Integrations',
        });
        return null;
    }
    return orgId;
}

function publicConnection(doc: any, req: Request) {
    const base =
        process.env.PUBLIC_API_URL ||
        process.env.API_PUBLIC_URL ||
        `${req.protocol}://${req.get('host')}`;
    const ingestUrl = `${base.replace(/\/$/, '')}/api/docs/integrations/ingest`;
    const intervalMinutes = Number(doc.intervalMinutes || doc.config?.intervalMinutes || 15);
    return {
        connectionId: doc.connectionId,
        providerId: doc.providerId,
        label: doc.label,
        config: {
            ...(doc.config || {}),
            intervalMinutes,
            syncMode: doc.syncMode || doc.config?.syncMode || 'interval',
            dailyAt: doc.dailyAt || doc.config?.dailyAt || '09:00',
            autoSyncEnabled:
                doc.autoSyncEnabled != null
                    ? doc.autoSyncEnabled
                    : String(doc.config?.autoSyncEnabled ?? 'true') !== 'false',
            intervalAutoUpload:
                doc.intervalAutoUpload === true ||
                String(doc.config?.intervalAutoUpload ?? '') === 'true',
        },
        secretsMasked: maskSecrets(doc.secrets),
        hasSecrets: Object.keys(doc.secrets || {}).length > 0,
        ingestApiKeyMasked: maskSecret(doc.ingestApiKey),
        ingestApiKey: undefined as string | undefined,
        ingestUrl,
        isActive: doc.isActive,
        intervalMinutes,
        syncMode: doc.syncMode || 'interval',
        dailyAt: doc.dailyAt || '09:00',
        autoSyncEnabled: doc.autoSyncEnabled !== false,
        intervalAutoUpload: doc.intervalAutoUpload === true,
        nextSyncAt: doc.nextSyncAt || null,
        pendingSyncPrompt: doc.pendingSyncPrompt || null,
        unreadSyncAlert: doc.unreadSyncAlert || null,
        direction: doc.direction,
        lastSyncAt: doc.lastSyncAt,
        lastStatus: doc.lastStatus,
        lastSyncSummary: doc.lastSyncSummary || null,
        outboundWebhookUrl: doc.config?.outboundWebhookUrl
            ? String(doc.config.outboundWebhookUrl)
            : null,
        hasOutboundWebhook: Boolean(String(doc.config?.outboundWebhookUrl || '').trim()),
        outboundFolderId: doc.config?.outboundFolderId
            ? String(doc.config.outboundFolderId)
            : null,
        supportsFolderSend: doc.providerId === 'google_drive',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

export const listIntegrations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const rows = await IntegrationConnection.find({ organizationId: orgId }).sort({ updatedAt: -1 }).lean();
        res.json({
            success: true,
            data: {
                connections: rows.map((r) => publicConnection(r, req)),
                providerIds: INTEGRATION_PROVIDER_IDS,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const saveIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const providerId = String(req.body?.providerId || '').trim();
        if (!INTEGRATION_PROVIDER_IDS.includes(providerId as any)) {
            return res.status(400).json({ success: false, message: 'Invalid providerId' });
        }

        const label = String(req.body?.label || providerId).trim() || providerId;
        const direction = (['inbound', 'outbound', 'both'].includes(req.body?.direction)
            ? req.body.direction
            : 'both') as 'inbound' | 'outbound' | 'both';
        const fields = (req.body?.fields || {}) as Record<string, unknown>;
        const intervalRaw = req.body?.intervalMinutes ?? fields.intervalMinutes ?? 15;
        const intervalMinutes = Math.max(5, Math.min(1440, Number(intervalRaw) || 15));
        const syncMode = parseSyncMode(req.body?.syncMode ?? fields.syncMode);
        const dailyAt = parseDailyAt(req.body?.dailyAt ?? fields.dailyAt);
        const autoSyncEnabled = parseBool(
            req.body?.autoSyncEnabled ?? fields.autoSyncEnabled,
            syncMode !== 'manual'
        );
        const intervalAutoUpload = parseBool(
            req.body?.intervalAutoUpload ?? fields.intervalAutoUpload,
            false
        );
        const { config, secrets } = splitPayload(fields);

        config.intervalMinutes = intervalMinutes;
        config.syncMode = syncMode;
        config.dailyAt = dailyAt;
        config.autoSyncEnabled = autoSyncEnabled;
        config.intervalAutoUpload = intervalAutoUpload;
        if (fields.phase3Agent != null) config.phase3Agent = String(fields.phase3Agent);
        if (Object.prototype.hasOwnProperty.call(fields, 'outboundWebhookUrl')) {
            const outbound = String(fields.outboundWebhookUrl ?? '').trim();
            if (outbound) config.outboundWebhookUrl = outbound;
        }
        if (fields.serviceAccountEmail) config.serviceAccountEmail = String(fields.serviceAccountEmail);
        if (fields.folderId) config.folderId = normalizeFolderId(String(fields.folderId));

        // Normalize Google service-account JSON/PEM so OpenSSL can read the stored key
        if (providerId === 'google_drive' && secrets.privateKey) {
            try {
                const parsed = parseCredentials(
                    String(config.serviceAccountEmail || fields.serviceAccountEmail || ''),
                    secrets.privateKey
                );
                secrets.privateKey = parsed.privateKey;
                if (parsed.clientEmail) config.serviceAccountEmail = parsed.clientEmail;
            } catch (e: any) {
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'Invalid Google Drive private key',
                });
            }
        }

        const nextSyncAt =
            autoSyncEnabled && syncMode !== 'manual'
                ? computeNextSyncAt(syncMode, intervalMinutes, dailyAt, new Date())
                : null;

        let doc = await IntegrationConnection.findOne({ organizationId: orgId, providerId });
        const isNew = !doc;
        if (!doc) {
            doc = await IntegrationConnection.create({
                connectionId: `int_${uuidv4()}`,
                organizationId: orgId,
                providerId,
                label,
                config,
                secrets,
                ingestApiKey: generateIngestKey(),
                isActive: true,
                intervalMinutes,
                syncMode,
                dailyAt,
                autoSyncEnabled,
                intervalAutoUpload: syncMode === 'daily' ? true : intervalAutoUpload,
                nextSyncAt,
                direction,
                lastStatus: 'connected',
                createdBy: req.user.userId,
            });
        } else {
            doc.label = label;
            doc.direction = direction;
            doc.intervalMinutes = intervalMinutes;
            doc.syncMode = syncMode;
            doc.dailyAt = dailyAt;
            doc.autoSyncEnabled = autoSyncEnabled;
            if (syncMode === 'interval') {
                doc.intervalAutoUpload = intervalAutoUpload;
            } else if (syncMode === 'daily') {
                // Daily is always silent auto-upload
                doc.intervalAutoUpload = true;
                doc.pendingSyncPrompt = null;
            } else {
                doc.intervalAutoUpload = false;
                doc.pendingSyncPrompt = null;
            }
            doc.nextSyncAt = nextSyncAt;
            doc.config = { ...(doc.config || {}), ...config };
            if (
                Object.prototype.hasOwnProperty.call(fields, 'outboundWebhookUrl') &&
                !String(fields.outboundWebhookUrl ?? '').trim()
            ) {
                delete doc.config.outboundWebhookUrl;
            }
            const mergedSecrets = { ...(doc.secrets || {}) };
            for (const [k, v] of Object.entries(secrets)) {
                if (v && !String(v).includes('****')) mergedSecrets[k] = v;
            }
            doc.secrets = mergedSecrets;
            doc.isActive = true;
            doc.lastStatus = 'connected';
            await doc.save();
        }

        recordActivityFromReq(req, {
            action: isNew ? 'integrations.connect' : 'integrations.update',
            category: 'admin',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `${isNew ? 'Connected' : 'Updated'} integration ${providerId}`,
            metadata: { providerId, label },
        });

        const payload = publicConnection(doc.toObject ? doc.toObject() : doc, req);
        // Show full ingest key once on create
        if (isNew) {
            payload.ingestApiKey = doc.ingestApiKey;
        }

        res.status(isNew ? 201 : 200).json({
            success: true,
            message: isNew ? 'Integration connected' : 'Integration updated',
            data: { connection: payload },
        });
    } catch (error: any) {
        if (error?.code === 11000) {
            return res.status(409).json({ success: false, message: 'Integration already exists for this provider' });
        }
        next(error);
    }
};

export const testIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        if (doc.providerId === 'google_drive') {
            try {
                const result = await testGoogleDriveConnection(doc);
                doc.lastStatus = `test_ok: folder accessible (${result.fileCount} file(s) visible)`;
                doc.lastSyncAt = new Date();
                await doc.save();
                return res.json({
                    success: true,
                    message: `Google Drive connected. Folder is accessible (${result.fileCount} file(s) visible in first page).`,
                    data: {
                        ok: true,
                        fileCount: result.fileCount,
                        folderId: result.folderId,
                        lastStatus: doc.lastStatus,
                    },
                });
            } catch (e: any) {
                doc.lastStatus = `test_failed: ${e?.message || e}`;
                await doc.save();
                return res.status(400).json({
                    success: false,
                    message: e?.message || 'Google Drive test failed',
                    data: { ok: false },
                });
            }
        }

        const missing: string[] = [];
        if (!doc.providerId) missing.push('providerId');
        if (doc.providerId === 'custom_webhook') {
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
        } else {
            const cfg = doc.config || {};
            const sec = doc.secrets || {};
            const scheduleKeys = new Set([
                'intervalMinutes',
                'phase3Agent',
                'outboundWebhookUrl',
                'syncMode',
                'dailyAt',
                'autoSyncEnabled',
            ]);
            const meaningful =
                Object.keys(cfg).filter((k) => !scheduleKeys.has(k)).length > 0 ||
                Object.keys(sec).length > 0;
            if (!meaningful) missing.push('connection fields');
        }

        if (missing.length) {
            doc.lastStatus = `test_failed: missing ${missing.join(', ')}`;
            await doc.save();
            return res.status(400).json({
                success: false,
                message: `Test failed — missing: ${missing.join(', ')}`,
                data: { ok: false, missing },
            });
        }

        doc.lastStatus = 'test_ok';
        doc.lastSyncAt = new Date();
        await doc.save();

        res.json({
            success: true,
            message: 'Connection fields look valid.',
            data: { ok: true, lastStatus: doc.lastStatus },
        });
    } catch (error) {
        next(error);
    }
};

export const listIntegrationFiles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (doc.providerId !== 'google_drive') {
            return res.status(400).json({
                success: false,
                message: 'File listing is currently available for Google Drive only',
            });
        }

        const files = await listDriveFilesWithLibraryStatus(doc);
        res.json({
            success: true,
            data: {
                files,
                total: files.length,
                missing: files.filter((f) => !f.existsInLibrary).length,
                existing: files.filter((f) => f.existsInLibrary).length,
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Failed to list files',
        });
    }
};

export const syncIntegrationFiles = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (doc.providerId !== 'google_drive') {
            return res.status(400).json({
                success: false,
                message: 'Sync is currently available for Google Drive only',
            });
        }

        const fileIds = Array.isArray(req.body?.fileIds)
            ? req.body.fileIds.map((x: unknown) => String(x))
            : undefined;
        const result = await importDriveFiles(doc, fileIds);
        const summary = `imported=${result.imported.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`;

        doc.lastSyncAt = new Date();
        doc.lastStatus = result.failed.length ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
        doc.lastSyncSummary = summary;
        if (doc.autoSyncEnabled && doc.syncMode !== 'manual') {
            doc.nextSyncAt = computeNextSyncAt(
                doc.syncMode || 'interval',
                doc.intervalMinutes || 15,
                doc.dailyAt || '09:00',
                new Date()
            );
        }
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.sync',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Google Drive sync: ${summary}`,
            metadata: { summary, imported: result.imported.length },
        });

        res.json({
            success: true,
            message: `Sync finished — ${summary}`,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Sync failed',
        });
    }
};

/** Admin poll: pending interval confirm prompts + unread sync alerts (e.g. daily failures). */
export const listSyncInbox = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const docs = await IntegrationConnection.find({
            organizationId: orgId,
            providerId: 'google_drive',
            isActive: true,
        })
            .select(
                'connectionId label syncMode intervalMinutes intervalAutoUpload pendingSyncPrompt unreadSyncAlert lastStatus'
            )
            .lean();

        const prompts = docs
            .filter((d) => d.pendingSyncPrompt && Number((d.pendingSyncPrompt as any).count || 0) > 0)
            .map((d) => ({
                connectionId: d.connectionId,
                label: d.label,
                syncMode: d.syncMode,
                intervalMinutes: d.intervalMinutes,
                intervalAutoUpload: d.intervalAutoUpload === true,
                pendingSyncPrompt: d.pendingSyncPrompt,
            }));

        const alerts = docs
            .filter((d) => d.unreadSyncAlert)
            .map((d) => ({
                connectionId: d.connectionId,
                label: d.label,
                alert: d.unreadSyncAlert,
            }));

        res.json({ success: true, data: { prompts, alerts } });
    } catch (error) {
        next(error);
    }
};

export const confirmSyncPrompt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        const enableAutoUpload = parseBool(req.body?.enableAutoUpload, false);
        const fileIds = Array.isArray(req.body?.fileIds)
            ? req.body.fileIds.map((x: unknown) => String(x))
            : doc.pendingSyncPrompt?.files?.map((f) => f.id);

        if (enableAutoUpload) {
            doc.intervalAutoUpload = true;
            doc.config = { ...(doc.config || {}), intervalAutoUpload: true };
        }

        const result = await importDriveFiles(doc, fileIds?.length ? fileIds : undefined);
        const summary = `imported=${result.imported.length}, skipped=${result.skipped.length}, failed=${result.failed.length}`;

        doc.pendingSyncPrompt = null;
        doc.lastSyncAt = new Date();
        doc.lastStatus = result.failed.length ? `sync_partial: ${summary}` : `sync_ok: ${summary}`;
        doc.lastSyncSummary = summary;
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.sync.confirm',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Google Drive confirm upload: ${summary}`,
            metadata: { summary, enableAutoUpload },
        });

        res.json({
            success: true,
            message: enableAutoUpload
                ? `Uploaded. Auto-upload is on for future intervals — ${summary}`
                : `Uploaded — ${summary}`,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        return res.status(400).json({
            success: false,
            message: error?.message || 'Confirm sync failed',
        });
    }
};

export const dismissSyncPrompt = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.pendingSyncPrompt = null;
        doc.lastStatus = 'sync_skipped: user dismissed prompt';
        await doc.save();

        res.json({
            success: true,
            message: 'Sync prompt dismissed — files were not uploaded',
            data: { connection: publicConnection(doc.toObject(), req) },
        });
    } catch (error) {
        next(error);
    }
};

export const ackSyncAlert = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.unreadSyncAlert = null;
        await doc.save();

        res.json({ success: true, message: 'Alert acknowledged' });
    } catch (error) {
        next(error);
    }
};

export const deleteIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        const providerId = doc.providerId;
        await IntegrationConnection.deleteOne({ connectionId: doc.connectionId });

        recordActivityFromReq(req, {
            action: 'integrations.disconnect',
            category: 'admin',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Disconnected integration ${providerId}`,
            metadata: { providerId },
        });

        res.json({ success: true, message: 'Integration disconnected' });
    } catch (error) {
        next(error);
    }
};

export const rotateIngestKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }

        doc.ingestApiKey = generateIngestKey();
        await doc.save();

        const payload = publicConnection(doc.toObject(), req);
        payload.ingestApiKey = doc.ingestApiKey;

        res.json({
            success: true,
            message: 'Ingest API key rotated — copy the new key now',
            data: { connection: payload },
        });
    } catch (error) {
        next(error);
    }
};

/** User-triggered send: original file / AI summary / extracted JSON → Drive folder and/or webhook */
export const sendViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (!doc.isActive) {
            return res.status(400).json({ success: false, message: 'Integration is not active' });
        }

        const documentIds = Array.isArray(req.body?.documentIds)
            ? req.body.documentIds.map((x: unknown) => String(x)).filter(Boolean)
            : [];
        if (!documentIds.length) {
            return res.status(400).json({ success: false, message: 'documentIds required' });
        }

        const include = {
            file: !!req.body?.include?.file,
            summary: !!req.body?.include?.summary,
            extracted: !!req.body?.include?.extracted,
        };
        if (!include.file && !include.summary && !include.extracted) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one payload: file, summary, or extracted',
            });
        }

        const destinations = {
            folder: !!req.body?.destinations?.folder,
            webhook: !!req.body?.destinations?.webhook,
        };
        if (!destinations.folder && !destinations.webhook) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one destination: folder or webhook',
            });
        }

        const { results, outboundFolderId } = await sendDocumentsViaIntegration({
            conn: doc,
            organizationId: orgId,
            documentIds,
            include,
            destinations,
        });

        const isSoftWarning = (e: string) => /missing on disk/i.test(e);
        const deliveredOk = results.filter((r) => {
            const hasUpload = Array.isArray(r.uploaded) && r.uploaded.length > 0;
            const webhookOk = r.webhookOk === true;
            const hardErrors = (r.errors || []).filter((e) => !isSoftWarning(e));
            if (hardErrors.length) return false;
            if (destinations.folder && destinations.webhook) return hasUpload || webhookOk;
            if (destinations.folder) return hasUpload;
            if (destinations.webhook) return webhookOk;
            return false;
        });
        const okDocs = deliveredOk.length;
        const failCount = results.length - okDocs;
        const detailErrors = results
            .flatMap((r) => (r.errors || []).filter((e) => !isSoftWarning(e)))
            .filter(Boolean)
            .slice(0, 3);

        doc.lastStatus =
            failCount === 0
                ? `send_ok: ${okDocs} document(s)`
                : `send_partial: ok=${okDocs}, failed=${failCount}`;
        doc.lastSyncAt = new Date();
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.send',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message: `Sent ${okDocs}/${results.length} document(s) via ${doc.providerId}`,
            metadata: { include, destinations, results },
        });

        const message =
            failCount === 0
                ? `Sent ${okDocs} document(s) successfully`
                : detailErrors.length
                  ? `Send failed — ${detailErrors.join(' · ')}`
                  : `Sent with issues — ${okDocs} ok, ${failCount} failed`;

        res.status(failCount === results.length && results.length > 0 ? 400 : 200).json({
            success: failCount === 0,
            message,
            data: {
                results,
                outboundFolderId: outboundFolderId || doc.config?.outboundFolderId || null,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Send failed',
        });
    }
};

/** Upload a raw file (e.g. chat .txt) straight to Drive folder / webhook — not the document library */
export const uploadFileViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    const tmpPath = req.file?.path;
    try {
        const orgId = await requireAdminWithActivePlan(req, res);
        if (!orgId) return;

        const doc = await IntegrationConnection.findOne({
            connectionId: req.params.id,
            organizationId: orgId,
        });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Integration not found' });
        }
        if (!doc.isActive) {
            return res.status(400).json({ success: false, message: 'Integration is not active' });
        }

        const file = req.file;
        if (!file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded (multipart field: file)',
            });
        }

        const destFolderRaw = req.body?.folder ?? req.body?.destinations?.folder;
        const destWebhookRaw = req.body?.webhook ?? req.body?.destinations?.webhook;
        const destinations = {
            folder:
                destFolderRaw === undefined
                    ? undefined
                    : destFolderRaw === true ||
                      destFolderRaw === 'true' ||
                      destFolderRaw === '1',
            webhook:
                destWebhookRaw === undefined
                    ? undefined
                    : destWebhookRaw === true ||
                      destWebhookRaw === 'true' ||
                      destWebhookRaw === '1',
        };

        const buffer = fs.readFileSync(file.path);
        const result = await sendRawFileViaIntegration({
            conn: doc,
            organizationId: orgId,
            filename: file.originalname || 'upload.bin',
            mimeType: file.mimetype || 'application/octet-stream',
            buffer,
            destinations,
        });

        const delivered =
            (Array.isArray(result.uploaded) && result.uploaded.length > 0) || result.webhookOk === true;
        const message = delivered
            ? `Sent ${file.originalname || 'file'} to ${doc.label || doc.providerId}`
            : result.errors[0] || 'Send failed';

        doc.lastStatus = delivered ? `upload_ok: ${file.originalname}` : `upload_failed`;
        doc.lastSyncAt = new Date();
        await doc.save();

        recordActivityFromReq(req, {
            action: 'integrations.upload',
            category: 'document',
            resourceType: 'integration',
            resourceId: doc.connectionId,
            message,
            metadata: { filename: file.originalname, result },
        });

        res.status(delivered ? 200 : 400).json({
            success: delivered,
            message,
            data: {
                ...result,
                connection: publicConnection(doc.toObject(), req),
            },
        });
    } catch (error: any) {
        const status = error?.statusCode || 400;
        return res.status(status).json({
            success: false,
            message: error?.message || 'Upload failed',
        });
    } finally {
        if (tmpPath) {
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                /* ignore */
            }
        }
    }
};

/** Public ingest endpoint — authenticated via X-Integration-Key */
export const ingestViaIntegration = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiKey = String(req.headers['x-integration-key'] || req.body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(401).json({
                success: false,
                message: 'Missing X-Integration-Key header',
            });
        }

        const connection = await IntegrationConnection.findOne({
            ingestApiKey: apiKey,
            isActive: true,
        });
        if (!connection) {
            return res.status(401).json({ success: false, message: 'Invalid integration key' });
        }

        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, message: 'No file uploaded (multipart field: file)' });
        }

        const storageCheck = await assertStorageAvailable(connection.organizationId, file.size || 0);
        if (!storageCheck.ok) {
            return res.status(403).json({
                success: false,
                code: 'STORAGE_LIMIT',
                message: storageCheck.message,
            });
        }

        const adminUser =
            (await User.findOne({
                organizationId: connection.organizationId,
                role: 'admin',
                status: 'active',
            }).lean()) ||
            (await User.findOne({ userId: connection.createdBy, status: 'active' }).lean());

        if (!adminUser) {
            return res.status(500).json({ success: false, message: 'No active admin user for organization' });
        }

        const authUser: AuthUser = {
            userId: adminUser.userId,
            role: adminUser.role,
            organizationId: connection.organizationId,
            permissions: undefined,
        };

        const phase3Agent =
            String(req.body?.phase3Agent || connection.config?.phase3Agent || '').trim() || undefined;

        ensureUploadDir();
        const { doc, aiModelResponse } = await saveUploadedFile(authUser, file, phase3Agent);

        // Tag source
        doc.metadata = {
            ...(doc.metadata || {}),
            source: connection.providerId,
            integrationConnectionId: connection.connectionId,
            integrationLabel: connection.label,
        };
        await doc.save();

        connection.lastSyncAt = new Date();
        connection.lastStatus = 'ingest_ok';
        await connection.save();

        recordActivity({
            organizationId: connection.organizationId,
            actorUserId: adminUser.userId,
            actorEmail: adminUser.email,
            actorRole: adminUser.role,
            action: 'integrations.ingest',
            category: 'document',
            resourceType: 'document',
            resourceId: doc.documentId,
            message: `Integration ingest (${connection.providerId}): ${doc.originalFilename}`,
            metadata: {
                providerId: connection.providerId,
                connectionId: connection.connectionId,
                filename: doc.originalFilename,
            },
        });

        res.status(201).json({
            success: true,
            message: 'Document ingested',
            data: {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: doc.status,
                providerId: connection.providerId,
                aiModelResponse,
            },
        });
    } catch (error: any) {
        if (error?.statusCode) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        next(error);
    }
};
