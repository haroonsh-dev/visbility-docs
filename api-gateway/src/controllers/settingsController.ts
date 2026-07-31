import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import ApiKey, { AIProvider } from '../models/ApiKey';
import { PERMISSIONS } from '../types/permissions';
import { hasPermission } from '../services/accessScope';
import { recordActivityFromReq } from '../services/activityLog';

const PROVIDER_DEFAULTS: Record<AIProvider, { label: string; model: string; baseUrl?: string }> = {
    groq: { label: 'Groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
    openai: { label: 'OpenAI', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
    gemini: { label: 'Google Gemini', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
    anthropic: { label: 'Anthropic Claude', model: 'claude-3-5-sonnet-20241022', baseUrl: 'https://api.anthropic.com/v1' },
    custom: { label: 'Custom Provider', model: '', baseUrl: '' },
};

function requireOrg(req: Request): string | null {
    if (req.user.role === 'superAdmin') {
        return (req.query.organizationId as string) || req.body?.organizationId || req.user.organizationId || null;
    }
    return req.user.organizationId || null;
}

/** List all API keys for the organization */
export const listApiKeys = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = requireOrg(req);
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const filter: Record<string, unknown> = {};
        if (orgId) filter.organizationId = orgId;

        const keys = await ApiKey.find(filter).sort({ provider: 1, createdAt: -1 }).lean();

        // Mask the API keys for security
        const masked = keys.map((k) => ({
            ...k,
            apiKey: maskKey(k.apiKey),
            model: k.aiModel,
            hasKey: k.apiKey.length > 0,
        }));

        res.json({ success: true, data: { keys: masked, providerDefaults: PROVIDER_DEFAULTS } });
    } catch (error) {
        next(error);
    }
};

/** Create or update an API key for a provider */
export const saveApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const { provider, apiKey, label, model, baseUrl, keyId } = req.body || {};

        if (!provider || !Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid provider. Must be groq, openai, gemini, anthropic, or custom' });
        }
        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
            return res.status(400).json({ success: false, message: 'API key is required (min 8 characters)' });
        }

        const defaults = PROVIDER_DEFAULTS[provider as AIProvider];
        const finalLabel = label || defaults.label;
        const finalModel = model || defaults.model;
        const finalBaseUrl = baseUrl || defaults.baseUrl || null;

        let keyDoc;
        if (keyId) {
            // Update existing key
            keyDoc = await ApiKey.findOne({ keyId, organizationId: orgId || undefined });
            if (!keyDoc) {
                return res.status(404).json({ success: false, message: 'API key not found' });
            }
            keyDoc.apiKey = apiKey.trim();
            keyDoc.label = finalLabel;
            keyDoc.aiModel = finalModel;
            keyDoc.baseUrl = finalBaseUrl;
            keyDoc.isActive = true;
            await keyDoc.save();
        } else {
            // Check if provider key already exists - update it
            const existing = await ApiKey.findOne({
                organizationId: orgId || undefined,
                provider,
            });
            if (existing) {
                existing.apiKey = apiKey.trim();
                existing.label = finalLabel;
                existing.aiModel = finalModel;
                existing.baseUrl = finalBaseUrl;
                existing.isActive = true;
                keyDoc = await existing.save();
            } else {
                // Create new
                keyDoc = await ApiKey.create({
                    keyId: `key_${uuidv4()}`,
                    organizationId: orgId || '',
                    provider,
                    apiKey: apiKey.trim(),
                    label: finalLabel,
                    aiModel: finalModel,
                    baseUrl: finalBaseUrl,
                    isActive: true,
                    createdBy: req.user.userId,
                });
            }
        }

        // Sync to AI backend
        await syncKeyToAIBackend(provider, apiKey.trim(), finalModel, finalBaseUrl);

        recordActivityFromReq(req, {
            action: 'settings.api_key.save',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: keyDoc.keyId,
            message: `Saved ${finalLabel} API key`,
            metadata: { provider, label: finalLabel },
        });

        res.status(201).json({
            success: true,
            data: {
                key: {
                    ...keyDoc.toObject(),
                    apiKey: maskKey(keyDoc.apiKey),
                    model: keyDoc.aiModel,
                    hasKey: true,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Toggle API key active status */
export const toggleApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const key = await ApiKey.findOne({ keyId: req.params.keyId, organizationId: orgId || undefined });
        if (!key) return res.status(404).json({ success: false, message: 'API key not found' });

        key.isActive = !key.isActive;
        await key.save();

        res.json({ success: true, data: { key: { ...key.toObject(), apiKey: maskKey(key.apiKey), model: key.aiModel } } });
    } catch (error) {
        next(error);
    }
};

/** Delete an API key */
export const deleteApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const key = await ApiKey.findOne({ keyId: req.params.keyId, organizationId: orgId || undefined });
        if (!key) return res.status(404).json({ success: false, message: 'API key not found' });

        const provider = key.provider;
        await ApiKey.deleteOne({ keyId: key.keyId });

        // Check if any keys remain for this org
        const remainingCount = await ApiKey.countDocuments(orgId ? { organizationId: orgId } : {});

        // Sync provider deletion to Python AI backend
        try {
            const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
            await fetch(`${aiUrl}/api/v1/settings/providers/${provider}`, { method: 'DELETE' });
            if (remainingCount === 0) {
                await fetch(`${aiUrl}/api/v1/settings/providers`, { method: 'DELETE' });
            }
        } catch (e) {
            console.warn(`[SETTINGS] Failed to sync provider deletion '${provider}' to AI backend:`, e);
        }

        recordActivityFromReq(req, {
            action: 'settings.api_key.delete',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: key.keyId,
            message: `Deleted ${key.label} API key`,
            metadata: { provider },
        });

        res.json({ success: true, message: 'API key deleted' });
    } catch (error) {
        next(error);
    }
};

/** Get active provider configuration (for AI backend consumption) */
export const getProviderConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgId = req.query.organizationId as string || req.user.organizationId || null;
        if (!orgId && req.user.role !== 'superAdmin') {
            return res.status(400).json({ success: false, message: 'organizationId required' });
        }

        const filter: Record<string, unknown> = { isActive: true };
        if (orgId) filter.organizationId = orgId;

        const activeKeys = await ApiKey.find(filter).lean();
        const providers = activeKeys.map((k) => ({
            provider: k.provider,
            apiKey: k.apiKey,
            model: k.aiModel,
            baseUrl: k.baseUrl,
            label: k.label,
        }));

        // Determine primary provider (first active one, preferring groq)
        const primary = providers.find((p) => p.provider === 'groq') || providers[0] || null;

        res.json({
            success: true,
            data: {
                primary: primary ? { provider: primary.provider, apiKey: primary.apiKey, model: primary.model, baseUrl: primary.baseUrl } : null,
                providers,
            },
        });
    } catch (error) {
        next(error);
    }
};

/** Set the primary active provider */
export const setPrimaryProvider = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.PAGE_SETTINGS)) {
            return res.status(403).json({ success: false, message: 'Missing permission: page.settings' });
        }

        const orgId = requireOrg(req);
        const { provider } = req.body || {};
        if (!provider || !Object.keys(PROVIDER_DEFAULTS).includes(provider)) {
            return res.status(400).json({ success: false, message: 'Invalid provider' });
        }

        const targetKey = await ApiKey.findOne({ organizationId: orgId || undefined, provider });
        if (!targetKey || !targetKey.apiKey) {
            return res.status(400).json({ success: false, message: `No API key configured for provider ${provider}` });
        }

        // Set targetKey as primary in MongoDB
        await ApiKey.updateMany({ organizationId: orgId || undefined }, { isActive: true });
        
        // Sync primary choice to AI backend
        try {
            const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8001';
            await fetch(`${aiUrl}/api/v1/settings/providers/primary`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider,
                    apiKey: targetKey.apiKey,
                    model: targetKey.aiModel,
                    baseUrl: targetKey.baseUrl,
                }),
            });
        } catch {
            // Best effort
        }

        recordActivityFromReq(req, {
            action: 'settings.api_key.set_primary',
            category: 'admin',
            resourceType: 'api_key',
            resourceId: targetKey.keyId,
            message: `Set ${provider} as primary AI provider`,
            metadata: { provider },
        });

        res.json({ success: true, message: `Primary provider set to ${provider}` });
    } catch (error) {
        next(error);
    }
};

// ── Helpers ──────────────────────────────────────────────

function maskKey(key: string): string {
    if (!key || key.length < 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
}

async function syncKeyToAIBackend(provider: string, apiKey: string, model: string, baseUrl: string | null) {
    try {
        const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8001';
        await fetch(`${aiUrl}/api/v1/settings/providers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey, model, baseUrl }),
        });
    } catch {
        // Best effort - AI backend may not be running
    }
}
