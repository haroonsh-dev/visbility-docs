import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import IntegrationConnection from '../models/IntegrationConnection';
import User from '../models/User';
import { INTEGRATION_PROVIDER_IDS, SECRET_FIELD_KEYS } from '../constants/integrations';
import { getActiveSubscription } from '../services/planService';
import { recordActivityFromReq, recordActivity } from '../services/activityLog';
import { ensureUploadDir, saveUploadedFile } from '../services/documentStorage';
import { assertStorageAvailable } from '../services/planService';
import type { AuthUser } from '../services/accessScope';

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
        if (SECRET_FIELD_KEYS.has(key) || key.toLowerCase().includes('secret') || key.toLowerCase().includes('password')) {
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

async function requireAdminWithActivePlan(req: Request, res: Response): Promise<string | null> {
    if (!req.user || req.user.role !== 'admin') {
        res.status(403).json({ success: false, message: 'Only organization admins can manage integrations' });
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
    return {
        connectionId: doc.connectionId,
        providerId: doc.providerId,
        label: doc.label,
        config: doc.config || {},
        secretsMasked: maskSecrets(doc.secrets),
        hasSecrets: Object.keys(doc.secrets || {}).length > 0,
        ingestApiKeyMasked: maskSecret(doc.ingestApiKey),
        ingestApiKey: undefined as string | undefined,
        ingestUrl,
        isActive: doc.isActive,
        intervalMinutes: doc.intervalMinutes,
        direction: doc.direction,
        lastSyncAt: doc.lastSyncAt,
        lastStatus: doc.lastStatus,
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
        const intervalMinutes = Math.max(5, Math.min(1440, Number(req.body?.intervalMinutes) || 15));
        const fields = (req.body?.fields || {}) as Record<string, unknown>;
        const { config, secrets } = splitPayload(fields);

        // interval / agent / outbound often live in fields too
        if (fields.intervalMinutes != null) {
            config.intervalMinutes = intervalMinutes;
        }
        if (fields.phase3Agent != null) config.phase3Agent = String(fields.phase3Agent);
        if (fields.outboundWebhookUrl) config.outboundWebhookUrl = String(fields.outboundWebhookUrl);

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
                direction,
                lastStatus: 'connected',
                createdBy: req.user.userId,
            });
        } else {
            doc.label = label;
            doc.direction = direction;
            doc.intervalMinutes = intervalMinutes;
            doc.config = { ...(doc.config || {}), ...config };
            // Only overwrite secrets that were re-submitted (non-empty)
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

        const missing: string[] = [];
        if (!doc.providerId) missing.push('providerId');
        if (doc.providerId === 'custom_webhook') {
            if (!doc.ingestApiKey) missing.push('ingestApiKey');
        } else {
            const cfg = doc.config || {};
            const sec = doc.secrets || {};
            // Light validation: at least one config or secret field beyond schedule
            const meaningful =
                Object.keys(cfg).filter((k) => !['intervalMinutes', 'phase3Agent', 'outboundWebhookUrl'].includes(k))
                    .length > 0 || Object.keys(sec).length > 0;
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
            message: 'Connection fields look valid. Live remote ping will be available when the sync worker is enabled.',
            data: { ok: true, lastStatus: doc.lastStatus },
        });
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
