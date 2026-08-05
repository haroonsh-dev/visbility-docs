import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import User, { defaultPermissionsForRole } from '../models/User';
import Organization from '../models/Organization';
import Document from '../models/Document';
import ApiKey from '../models/ApiKey';
import { syncProviderToAIBackend } from '../services/aiServiceClient';
import {
    annotateDuplicateCounts,
    getDuplicateDocumentIds,
    getDuplicateGroupSizes,
} from '../services/duplicateDetection';
import { recordActivityFromReq } from '../services/activityLog';
import openRemoteService from '../services/openRemoteService';
import { ensureDefaultOrgRoles } from '../services/orgRoleSeed';
import logger from '../utils/logger';

const SORT_FIELDS: Record<string, string> = {
    createdAt: 'createdAt',
    name: 'originalFilename',
    size: 'sizeBytes',
    status: 'status',
    score: 'metadata.cvScore',
};

function generateUserId() {
    return `usr_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

async function buildUniqueUsername(email: string): Promise<string> {
    const base = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 24) || 'admin';
    let candidate = base;
    let i = 0;
    while (await User.findOne({ username: candidate })) {
        i += 1;
        candidate = `${base}_${i}`;
    }
    return candidate;
}

function deriveRealm(organizationName: string) {
    return (
        organizationName
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 40) || 'enterprise'
    );
}

function maskGroqApiKey(key?: string | null): string | null {
    if (!key || typeof key !== 'string') return null;
    const trimmed = key.trim();
    if (!trimmed) return null;
    if (trimmed.length <= 11) return 'gsk_••••••••';
    return `${trimmed.slice(0, 7)}...${trimmed.slice(-4)}`;
}

export const listAdmins = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const admins = await User.find({ role: 'admin' })
            .select('-passwordHash -openRemoteSecret')
            .sort({ createdAt: -1 })
            .lean();

        const orgIds = [
            ...new Set(admins.map((a) => a.organizationId).filter(Boolean) as string[]),
        ];

        const [orgs, teamMembers, docCounts] = await Promise.all([
            orgIds.length
                ? Organization.find({ organizationId: { $in: orgIds } }).lean()
                : Promise.resolve([]),
            orgIds.length
                ? User.find({
                      role: 'team',
                      organizationId: { $in: orgIds },
                  })
                      .select('-passwordHash -openRemoteSecret')
                      .sort({ fullName: 1 })
                      .lean()
                : Promise.resolve([]),
            orgIds.length
                ? Document.aggregate([
                      { $match: { organizationId: { $in: orgIds } } },
                      { $group: { _id: '$organizationId', totalDocs: { $sum: 1 } } },
                  ])
                : Promise.resolve([]),
        ]);

        const orgMap = new Map(orgs.map((o) => [o.organizationId, o]));
        const docCountMap = new Map(docCounts.map((d) => [d._id, d.totalDocs]));
        const membersByOrg = new Map<string, typeof teamMembers>();
        for (const m of teamMembers) {
            const key = m.organizationId || '';
            if (!key) continue;
            const list = membersByOrg.get(key) || [];
            list.push(m);
            membersByOrg.set(key, list);
        }

        const enriched = admins.map((admin) => {
            const org = admin.organizationId ? orgMap.get(admin.organizationId) : null;
            const members = admin.organizationId
                ? membersByOrg.get(admin.organizationId) || []
                : [];
            const documentCount = admin.organizationId ? docCountMap.get(admin.organizationId) || 0 : 0;
            return {
                ...admin,
                organization: org
                    ? {
                          organizationId: org.organizationId,
                          organizationName: org.organizationName,
                          status: org.status,
                          subscriptionPlan: org.subscriptionPlan,
                          contactEmail: org.contactEmail,
                          hasGroqApiKey: !!org.groqApiKey,
                          groqApiKeyMasked: maskGroqApiKey(org.groqApiKey),
                      }
                    : null,
                teamMembers: members,
                teamMemberCount: members.length,
                documentCount,
            };
        });

        res.json({ success: true, data: { admins: enriched } });
    } catch (error) {
        next(error);
    }
};

/** SuperAdmin creates a company admin (+ organization). */
export const createAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const {
            fullName,
            email,
            password,
            contactNumber,
            organizationName,
            status = 'active',
            groqApiKey,
        } = req.body;

        const normalizedEmail = (email || '').toString().trim().toLowerCase();
        const orgName = (organizationName || '').toString().trim();
        if (!normalizedEmail || !password || !fullName || !orgName) {
            return res.status(400).json({
                success: false,
                message: 'fullName, email, password and organizationName are required',
            });
        }
        if (String(password).length < 8) {
            return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
        }
        if (!['active', 'blocked', 'pending'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be active, blocked, or pending' });
        }

        let initialGroqKey: string | null = null;
        if (groqApiKey && typeof groqApiKey === 'string' && groqApiKey.trim()) {
            const k = groqApiKey.trim();
            if (!k.startsWith('gsk_')) {
                return res.status(400).json({ success: false, message: 'Groq API keys must start with gsk_' });
            }
            initialGroqKey = k;
        }

        const existing = await User.findOne({ email: normalizedEmail });
        if (existing) {
            return res.status(409).json({ success: false, message: 'Email already exists' });
        }

        const username = await buildUniqueUsername(normalizedEmail);
        const userId = generateUserId();
        const orgId = `org_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const realm = deriveRealm(orgName);
        const passwordHash = await bcrypt.hash(String(password), 12);

        let openRemoteUserId: string | undefined;
        let openRemoteSecret: string | undefined;
        let openRemoteRealm = realm;
        let openRemoteSynced = false;

        const openRemoteEnabled = process.env.OPENREMOTE_ENABLED !== 'false';
        const allowLocal = process.env.ALLOW_LOCAL_SEED === 'true' || process.env.NODE_ENV !== 'production';

        if (openRemoteEnabled) {
            try {
                await openRemoteService.ensureRealmExists(realm, orgName);
                const or = await openRemoteService.createUser({
                    username,
                    email: normalizedEmail,
                    fullName: String(fullName).trim(),
                    role: 'admin',
                    realm,
                });
                openRemoteUserId = or.userId || undefined;
                openRemoteSecret = or.openRemoteSecret || undefined;
                openRemoteRealm = or.realm || realm;
                openRemoteSynced = !!openRemoteUserId;
            } catch (e: any) {
                if (!allowLocal) {
                    return res.status(502).json({
                        success: false,
                        message: `OpenRemote user create failed: ${e.message || e}`,
                    });
                }
                logger.warn(`OpenRemote skipped for admin ${normalizedEmail}: ${e.message}`);
            }
        }

        const org = await Organization.create({
            organizationId: orgId,
            organizationName: orgName,
            contactEmail: normalizedEmail,
            status: 'active',
            subscriptionPlan: 'free',
            openRemoteRealm,
            groqApiKey: initialGroqKey,
        });

        if (initialGroqKey) {
            await ApiKey.findOneAndUpdate(
                { organizationId: orgId, provider: 'groq' },
                {
                    keyId: `key_groq_${orgId}`,
                    organizationId: orgId,
                    provider: 'groq',
                    apiKey: initialGroqKey,
                    label: 'Groq',
                    aiModel: 'llama-3.3-70b-versatile',
                    baseUrl: 'https://api.groq.com/openai/v1',
                    isActive: true,
                    createdBy: req.user.userId,
                },
                { upsert: true, new: true }
            );
            await syncProviderToAIBackend({
                provider: 'groq',
                apiKey: initialGroqKey,
                model: 'llama-3.3-70b-versatile',
                baseUrl: 'https://api.groq.com/openai/v1',
            });
        }

        try {
            await ensureDefaultOrgRoles(orgId);
        } catch (e: any) {
            logger.warn(`Org roles seed failed for ${orgId}: ${e.message}`);
        }

        const admin = await User.create({
            userId,
            username,
            fullName: String(fullName).trim(),
            email: normalizedEmail,
            contactNumber: contactNumber ? String(contactNumber).trim() : undefined,
            passwordHash,
            role: 'admin',
            accountType: 'enterprise',
            organizationId: orgId,
            createdBy: req.user.userId,
            permissions: defaultPermissionsForRole('admin'),
            status,
            emailVerified: true,
            openRemoteRealm,
            openRemoteSynced,
            openRemoteSyncedAt: openRemoteSynced ? new Date() : undefined,
            openRemoteUserId,
            openRemoteSecret,
        });

        recordActivityFromReq(req, {
            action: 'admin.create',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Created admin ${admin.email} for org ${orgName}`,
            metadata: { organizationId: orgId },
        });

        const safe = await User.findById(admin._id).select('-passwordHash -openRemoteSecret').lean();
        res.status(201).json({
            success: true,
            data: {
                admin: {
                    ...safe,
                    organization: {
                        organizationId: org.organizationId,
                        organizationName: org.organizationName,
                        status: org.status,
                        subscriptionPlan: org.subscriptionPlan,
                        contactEmail: org.contactEmail,
                        hasGroqApiKey: !!org.groqApiKey,
                        groqApiKeyMasked: maskGroqApiKey(org.groqApiKey),
                    },
                    teamMembers: [],
                    teamMemberCount: 0,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updateAdminStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.params.userId === req.user.userId) {
            return res.status(400).json({ success: false, message: 'Cannot change your own status' });
        }
        const { status } = req.body;
        if (!['active', 'blocked'].includes(status)) {
            return res.status(400).json({ success: false, message: 'status must be active or blocked' });
        }
        const admin = await User.findOneAndUpdate(
            { userId: req.params.userId, role: 'admin' },
            { status },
            { new: true }
        ).select('-passwordHash -openRemoteSecret');
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });
        recordActivityFromReq(req, {
            action: 'admin.status',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Set admin ${admin.email} status to ${status}`,
            metadata: { status },
        });
        res.json({ success: true, data: { admin } });
    } catch (error) {
        next(error);
    }
};

export const updateAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const admin = await User.findOne({ userId: req.params.userId, role: 'admin' });
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

        const { fullName, email, contactNumber, password, organizationName, status, groqApiKey } = req.body;
        if (fullName) admin.fullName = String(fullName).trim();
        if (contactNumber !== undefined) {
            admin.contactNumber = contactNumber ? String(contactNumber).trim() : undefined;
        }
        if (email) {
            const normalized = email.toString().trim().toLowerCase();
            const dup = await User.findOne({ email: normalized, userId: { $ne: admin.userId } });
            if (dup) return res.status(409).json({ success: false, message: 'Email already in use' });
            admin.email = normalized;
        }
        if (password) {
            if (String(password).length < 8) {
                return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
            }
            admin.passwordHash = await bcrypt.hash(String(password), 12);
        }
        if (status && ['active', 'blocked', 'pending'].includes(status)) {
            if (req.params.userId === req.user.userId) {
                return res.status(400).json({ success: false, message: 'Cannot change your own status' });
            }
            admin.status = status;
        }
        await admin.save();

        if (admin.organizationId) {
            const updates: Record<string, unknown> = {};
            if (organizationName) updates.organizationName = String(organizationName).trim();
            if (groqApiKey !== undefined) {
                if (typeof groqApiKey === 'string' && groqApiKey.trim()) {
                    const k = groqApiKey.trim();
                    if (!k.startsWith('gsk_')) {
                        return res.status(400).json({ success: false, message: 'Groq API keys must start with gsk_' });
                    }
                    updates.groqApiKey = k;
                    await ApiKey.findOneAndUpdate(
                        { organizationId: admin.organizationId, provider: 'groq' },
                        {
                            keyId: `key_groq_${admin.organizationId}`,
                            organizationId: admin.organizationId,
                            provider: 'groq',
                            apiKey: k,
                            label: 'Groq',
                            aiModel: 'llama-3.3-70b-versatile',
                            baseUrl: 'https://api.groq.com/openai/v1',
                            isActive: true,
                            createdBy: req.user.userId,
                        },
                        { upsert: true, new: true }
                    );
                    await syncProviderToAIBackend({
                        provider: 'groq',
                        apiKey: k,
                        model: 'llama-3.3-70b-versatile',
                        baseUrl: 'https://api.groq.com/openai/v1',
                    });
                } else {
                    updates.groqApiKey = null;
                    await ApiKey.deleteMany({ organizationId: admin.organizationId, provider: 'groq' });
                }
            }
            if (Object.keys(updates).length > 0) {
                await Organization.findOneAndUpdate(
                    { organizationId: admin.organizationId },
                    updates
                );
            }
        }

        recordActivityFromReq(req, {
            action: 'admin.update',
            category: 'admin',
            resourceType: 'user',
            resourceId: admin.userId,
            message: `Updated admin ${admin.email}`,
        });

        res.json({
            success: true,
            data: { admin: await User.findById(admin._id).select('-passwordHash -openRemoteSecret').lean() },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteAdmin = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (req.params.userId === req.user.userId) {
            return res.status(400).json({ success: false, message: 'Cannot delete yourself' });
        }
        const admin = await User.findOne({ userId: req.params.userId, role: 'admin' });
        if (!admin) return res.status(404).json({ success: false, message: 'Admin not found' });

        const result = await User.deleteOne({ userId: req.params.userId, role: 'admin' });
        if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Admin not found' });

        recordActivityFromReq(req, {
            action: 'admin.delete',
            category: 'admin',
            resourceType: 'user',
            resourceId: String(req.params.userId),
            message: `Deleted admin ${admin.email}`,
        });
        res.json({ success: true, message: 'Admin deleted' });
    } catch (error) {
        next(error);
    }
};

export const listOrganizations = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const orgs = await Organization.find().sort({ createdAt: -1 }).lean();
        const enriched = orgs.map((o) => ({
            ...o,
            hasGroqApiKey: !!o.groqApiKey,
            groqApiKeyMasked: maskGroqApiKey(o.groqApiKey),
        }));
        res.json({ success: true, data: { organizations: enriched } });
    } catch (error) {
        next(error);
    }
};

export const updateOrganizationGroqKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { orgId } = req.params;
        const apiKey = String(req.body?.groqApiKey || req.body?.api_key || req.body?.apiKey || '').trim();
        if (!apiKey) {
            return res.status(400).json({ success: false, message: 'groqApiKey is required' });
        }
        if (!apiKey.startsWith('gsk_')) {
            return res.status(400).json({ success: false, message: 'Groq API keys must start with gsk_' });
        }

        const org = await Organization.findOneAndUpdate(
            { organizationId: orgId },
            { groqApiKey: apiKey },
            { new: true }
        );

        if (!org) {
            return res.status(404).json({ success: false, message: 'Organization not found' });
        }

        // Upsert into ApiKey collection so chat/RAG/OCR find this active provider key for the org
        await ApiKey.findOneAndUpdate(
            { organizationId: orgId, provider: 'groq' },
            {
                keyId: `key_groq_${orgId}`,
                organizationId: orgId,
                provider: 'groq',
                apiKey: apiKey,
                label: 'Groq',
                aiModel: 'llama-3.3-70b-versatile',
                baseUrl: 'https://api.groq.com/openai/v1',
                isActive: true,
                createdBy: req.user.userId,
            },
            { upsert: true, new: true }
        );

        // Sync with AI backend
        await syncProviderToAIBackend({
            provider: 'groq',
            apiKey: apiKey,
            model: 'llama-3.3-70b-versatile',
            baseUrl: 'https://api.groq.com/openai/v1',
        });

        recordActivityFromReq(req, {
            action: 'organization.groq_key_update',
            category: 'admin',
            resourceType: 'organization',
            resourceId: org.organizationId,
            message: `Updated Groq API key for organization ${org.organizationName}`,
        });

        res.json({
            success: true,
            message: `Groq API key updated for organization ${org.organizationName}`,
            data: {
                organizationId: org.organizationId,
                organizationName: org.organizationName,
                hasGroqApiKey: true,
                groqApiKeyMasked: maskGroqApiKey(org.groqApiKey),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteOrganizationGroqKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { orgId } = req.params;
        const org = await Organization.findOneAndUpdate(
            { organizationId: orgId },
            { groqApiKey: null },
            { new: true }
        );

        if (!org) {
            return res.status(404).json({ success: false, message: 'Organization not found' });
        }

        // Delete from ApiKey collection
        await ApiKey.deleteMany({ organizationId: orgId, provider: 'groq' });

        recordActivityFromReq(req, {
            action: 'organization.groq_key_delete',
            category: 'admin',
            resourceType: 'organization',
            resourceId: org.organizationId,
            message: `Deleted Groq API key for organization ${org.organizationName}`,
        });

        res.json({
            success: true,
            message: `Groq API key deleted for organization ${org.organizationName}`,
            data: {
                organizationId: org.organizationId,
                organizationName: org.organizationName,
                hasGroqApiKey: false,
                groqApiKeyMasked: null,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const listAllDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const page = Math.max(1, parseInt((req.query.page as string) || '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || '20', 10)));
        const q = ((req.query.q as string) || '').trim();
        const sortBy = SORT_FIELDS[(req.query.sortBy as string) || 'createdAt'] || 'createdAt';
        const sortOrder = (req.query.sortOrder as string) === 'asc' ? 1 : -1;
        const status = (req.query.status as string) || '';
        const mimeType = (req.query.mimeType as string) || '';
        const organizationId = (req.query.organizationId as string) || undefined;
        const duplicatesOnly = (req.query.duplicatesOnly as string) === 'true';
        const scoreFilter = ((req.query.scoreFilter as string) || '').trim();

        const filter: Record<string, unknown> = {};
        if (organizationId) filter.organizationId = organizationId;
        if (status) filter.status = status;
        if (mimeType) {
            filter.mimeType = new RegExp(mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }
        if (q) {
            filter.$or = [
                { originalFilename: { $regex: q, $options: 'i' } },
                { classification: { $regex: q, $options: 'i' } },
                { documentId: { $regex: q, $options: 'i' } },
            ];
        }
        if (scoreFilter === 'high') {
            filter['metadata.cvScore'] = { $gte: 70 };
        } else if (scoreFilter === 'medium') {
            filter['metadata.cvScore'] = { $gte: 40, $lt: 70 };
        } else if (scoreFilter === 'low') {
            filter['metadata.cvScore'] = { $gte: 0, $lt: 40 };
        } else if (scoreFilter === 'scored') {
            filter['metadata.cvScore'] = { $exists: true, $ne: null };
        }

        let queryFilter = filter;
        if (duplicatesOnly) {
            const duplicateIds = await getDuplicateDocumentIds(filter);
            if (!duplicateIds.length) {
                return res.json({
                    success: true,
                    data: {
                        documents: [],
                        pagination: { page: 1, limit, total: 0, totalPages: 0 },
                    },
                });
            }
            queryFilter = { ...filter, documentId: { $in: duplicateIds } };
        }

        const [documents, total, duplicateSizes] = await Promise.all([
            Document.find(queryFilter)
                .sort({ [sortBy]: sortOrder })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Document.countDocuments(queryFilter),
            getDuplicateGroupSizes(filter),
        ]);

        res.json({
            success: true,
            data: {
                documents: annotateDuplicateCounts(documents, duplicateSizes),
                pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 0 },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const listAllTeams = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const members = await User.find({ role: 'team' })
            .select('-passwordHash -openRemoteSecret')
            .sort({ createdAt: -1 })
            .lean();
        res.json({ success: true, data: { members } });
    } catch (error) {
        next(error);
    }
};
