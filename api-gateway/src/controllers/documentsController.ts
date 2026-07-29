import path from 'path';
import fs from 'fs';
import DepartmentMember from '../models/DepartmentMember';
import { Request, Response, NextFunction } from 'express';
import Document from '../models/Document';
import DocumentShare from '../models/DocumentShare';
import {
    buildDocumentFilter,
    canAccessDocument,
    canDeleteDocument,
    canSuperviseUser,
    getLeaderDeletableUploaderIds,
    loadUserDeptContext,
    hasPermission,
} from '../services/accessScope';
import {
    annotateDuplicateCounts,
    getDuplicateDocumentIds,
    getDuplicateGroupSizes,
} from '../services/duplicateDetection';
import {
    deleteDocumentFully,
    ensureUploadDir,
    saveUploadedFile,
    applyDocumentTypeStorage,
} from '../services/documentStorage';
import { recordActivityFromReq } from '../services/activityLog';
import {
    getAiDocument,
    getAiDocumentImages,
    getDocumentExtractions,
    getDocumentJobStatus,
    getSimilarDocuments,
    isAiServiceEnabled,
    listAiValidations,
    resolveAiOrganizationId,
    resolveDocumentAiOrgId,
    streamAiAsset,
    triggerDocumentReprocess,
    updateAiDocumentSettings,
} from '../services/aiServiceClient';
import { PERMISSIONS } from '../types/permissions';
import logger from '../utils/logger';

const SORT_FIELDS: Record<string, string> = {
    createdAt: 'createdAt',
    name: 'originalFilename',
    size: 'sizeBytes',
    status: 'status',
    score: 'metadata.cvScore',
};

const PYTHON_DONE_STATUSES = ['processed', 'embedded', 'classified', 'completed', 'ready'];
const PYTHON_FAILED_STATUSES = ['failed', 'error'];

async function syncStatusFromAiDocument(
    doc: InstanceType<typeof Document>,
    orgId: string,
    user?: { organizationId?: string | null; userId: string }
): Promise<Record<string, unknown> | null> {
    if (!isAiServiceEnabled() || !doc.pythonDocumentId) return null;

    const aiOrgId = user ? resolveDocumentAiOrgId(doc, user) : orgId;
    const aiDoc = await getAiDocument(doc.pythonDocumentId, aiOrgId);
    if (!aiDoc) return null;

    const pyStatus = String(aiDoc.status || '').toLowerCase();
    if (aiDoc.status) {
        doc.aiProcessingStatus = String(aiDoc.status);
    }

    if (PYTHON_FAILED_STATUSES.some((s) => pyStatus.includes(s))) {
        doc.status = 'failed';
        if (aiDoc.error_message) {
            doc.aiErrorMessage = String(aiDoc.error_message);
        }
    } else if (PYTHON_DONE_STATUSES.some((s) => pyStatus.includes(s))) {
        doc.status = 'ready';
        if (aiDoc.page_count != null) {
            doc.pageCount = Number(aiDoc.page_count) || 0;
        }
        if (aiDoc.cv_score != null) {
            doc.metadata = { ...(doc.metadata || {}), cvScore: Number(aiDoc.cv_score) };
        }
        if (aiDoc.phase3_agent) {
            doc.metadata = {
                ...(doc.metadata || {}),
                phase3Agent: String(aiDoc.phase3_agent),
            };
        }
    } else if (pyStatus) {
        doc.status = 'processing';
    }

    // Relocate only after AI finishes (or fails) so we never move the file mid-OCR/pipeline
    if (aiDoc.document_type) {
        doc.classification = String(aiDoc.document_type);
        try {
            const { applyDocumentVisibilityScope } = await import('../services/documentVisibility');
            await applyDocumentVisibilityScope(doc, String(aiDoc.document_type));
        } catch (e: any) {
            logger.warn(`Visibility scope failed for ${doc.documentId}: ${e.message}`);
        }
        const pipelineSettled =
            PYTHON_DONE_STATUSES.some((s) => pyStatus.includes(s)) ||
            PYTHON_FAILED_STATUSES.some((s) => pyStatus.includes(s));
        if (pipelineSettled) {
            try {
                const moved = await applyDocumentTypeStorage(doc, String(aiDoc.document_type));
                if (moved && doc.pythonDocumentId && fs.existsSync(doc.storagePath)) {
                    const { updateAiDocumentFilePath } = await import('../services/aiServiceClient');
                    await updateAiDocumentFilePath({
                        pythonDocumentId: doc.pythonDocumentId,
                        organizationId: aiOrgId,
                        filePath: doc.storagePath,
                    });
                }
            } catch (e: any) {
                logger.warn(`Storage relocate failed for ${doc.documentId}: ${e.message}`);
            }
        }
    }

    return aiDoc;
}

export const listDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        if (req.query.withIntel === 'true') {
            return listAllDocumentIntelligence(req, res, next);
        }

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
        const departmentId = ((req.query.departmentId as string) || '').trim() || undefined;
        const scopeRaw = ((req.query.scope as string) || '').trim();
        const scope =
            scopeRaw === 'personal' || scopeRaw === 'department' || scopeRaw === 'all'
                ? scopeRaw
                : undefined;
        const classification = ((req.query.classification as string) || (req.query.documentType as string) || '').trim() || undefined;
        const uploadedBy = ((req.query.uploadedBy as string) || '').trim() || undefined;

        const extra: Record<string, unknown> = {};
        if (status) extra.status = status;
        if (mimeType) extra.mimeType = new RegExp(mimeType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        if (q) {
            extra.$or = [
                { originalFilename: { $regex: q, $options: 'i' } },
                { classification: { $regex: q, $options: 'i' } },
                { documentId: { $regex: q, $options: 'i' } },
            ];
        }
        if (scoreFilter === 'high') {
            extra['metadata.cvScore'] = { $gte: 70 };
        } else if (scoreFilter === 'medium') {
            extra['metadata.cvScore'] = { $gte: 40, $lt: 70 };
        } else if (scoreFilter === 'low') {
            extra['metadata.cvScore'] = { $gte: 0, $lt: 40 };
        } else if (scoreFilter === 'scored') {
            extra['metadata.cvScore'] = { $exists: true, $ne: null };
        }

        if (uploadedBy) {
            if (uploadedBy !== req.user.userId) {
                const check = await canSuperviseUser(req.user, uploadedBy, departmentId ? { departmentId } : undefined);
                if (!check.allowed) {
                    return res.status(403).json({ success: false, message: check.reason || 'Forbidden' });
                }
            }
            extra.uploadedBy = uploadedBy;
        }

        // If querying by departmentId, expand results for admins and leaders to include documents
        // uploaded by any member of the department (so admins/leaders see member uploads).
        if (departmentId && !uploadedBy) {
            try {
                const members = await DepartmentMember.find({ departmentId }).select('userId').lean();
                const memberIds = members.map((m) => m.userId).filter(Boolean);
                const isAdminView =
                    req.user.role === 'superAdmin' ||
                    (req.user.role === 'admin' && hasPermission(req.user, PERMISSIONS.ORG_DOCUMENTS_VIEW));
                let isLeaderView = false;
                if (req.user.role === 'team') {
                    const ctx = await loadUserDeptContext(req.user);
                    isLeaderView = ctx.isLeader && ctx.departmentId === departmentId;
                }
                if (isAdminView || isLeaderView) {
                    extra.$or = [
                        ...(extra.$or as any[] || []),
                        { uploadedBy: { $in: memberIds } },
                    ];
                }
            } catch (e: any) {
                // ignore member expand on error
            }
        }

        let baseFilter: Record<string, unknown>;
        if (uploadedBy) {
            // Supervisor/admin oversight: list that user's uploads (already authorized above).
            const { uploadedBy: _ub, $or: searchOr, ...restExtra } = extra as {
                uploadedBy?: string;
                $or?: unknown;
                [k: string]: unknown;
            };
            baseFilter = {
                ...restExtra,
                uploadedBy,
            };
            const andParts: Record<string, unknown>[] = [];
            if (searchOr) andParts.push({ $or: searchOr as any });

            if (req.user.role === 'admin' && req.user.organizationId) {
                baseFilter.organizationId = req.user.organizationId;
            } else if (req.user.role === 'team') {
                const ctx = await loadUserDeptContext(req.user);
                if (ctx.departmentId) {
                    andParts.push({
                        $or: [
                            { departmentId: ctx.departmentId },
                            { departmentId: null },
                            { departmentId: { $exists: false } },
                        ],
                    });
                }
            } else if (organizationId && req.user.role === 'superAdmin') {
                baseFilter.organizationId = organizationId;
            }
            if (classification) baseFilter.classification = classification;
            if (scope === 'personal' || scope === 'department') {
                baseFilter.visibilityScope = scope;
            }
            if (andParts.length === 1) {
                Object.assign(baseFilter, andParts[0]);
            } else if (andParts.length > 1) {
                baseFilter.$and = andParts;
            }
        } else {
            baseFilter = await buildDocumentFilter(req.user, extra, {
                organizationId,
                departmentId,
                scope,
                classification,
            });
        }
        let filter = baseFilter;

        if (duplicatesOnly) {
            const duplicateIds = await getDuplicateDocumentIds(baseFilter);
            if (!duplicateIds.length) {
                return res.json({
                    success: true,
                    data: {
                        documents: [],
                        pagination: { page: 1, limit, total: 0, totalPages: 0 },
                    },
                });
            }
            filter = { ...baseFilter, documentId: { $in: duplicateIds } };
        }

        const [documents, total, duplicateSizes] = await Promise.all([
            Document.find(filter)
                .sort({ [sortBy]: sortOrder })
                .skip((page - 1) * limit)
                .limit(limit)
                .lean(),
            Document.countDocuments(filter),
            getDuplicateGroupSizes(baseFilter),
        ]);

        const documentIds = documents.map((doc) => doc.documentId).filter(Boolean);
        const departmentIdQuery = (req.query.departmentId as string) || undefined;
        const sharedDocs = documentIds.length
            ? await DocumentShare.find({
                  documentId: { $in: documentIds },
                  $or: [
                      { scope: 'department' },
                      { scope: 'all' },
                  ],
                  ...(departmentIdQuery ? { departmentId: departmentIdQuery } : {}),
              })
                  .select('documentId scope visibility departmentId')
                  .lean()
            : [];

        // Build per-document share summary
        const shareMap: Record<string, { sharedToDepartment: boolean; shareCount: number; hasAllShare: boolean }> = {};
        for (const s of sharedDocs) {
            if (!shareMap[s.documentId]) {
                shareMap[s.documentId] = { sharedToDepartment: false, shareCount: 0, hasAllShare: false };
            }
            shareMap[s.documentId].shareCount++;
            if (s.scope === 'department') shareMap[s.documentId].sharedToDepartment = true;
            if (s.scope === 'all') shareMap[s.documentId].hasAllShare = true;
        }

        const documentsWithShareStatus = documents.map((doc) => ({
            ...doc,
            sharedToDepartment: shareMap[doc.documentId]?.sharedToDepartment || false,
            shareCount: shareMap[doc.documentId]?.shareCount || 0,
            hasAllShare: shareMap[doc.documentId]?.hasAllShare || false,
        }));

        res.json({
            success: true,
            data: {
                documents: annotateDuplicateCounts(documentsWithShareStatus, duplicateSizes),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 0,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

export const getDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        res.json({ success: true, data: { document: doc } });
    } catch (error) {
        next(error);
    }
};

export const streamDocument = (disposition: 'inline' | 'attachment') =>
    async (req: Request, res: Response, next: NextFunction) => {
        try {
            // View covers both preview (inline) and download
            if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }

            const doc = await Document.findOne({ documentId: req.params.id });
            if (!doc) {
                return res.status(404).json({ success: false, message: 'Document not found' });
            }
            if (!(await canAccessDocument(req.user, doc))) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
            if (!fs.existsSync(doc.storagePath)) {
                return res.status(404).json({ success: false, message: 'File not found on disk' });
            }

            res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
            res.setHeader(
                'Content-Disposition',
                `${disposition}; filename="${encodeURIComponent(doc.originalFilename)}"`
            );
            recordActivityFromReq(req, {
                action: disposition === 'inline' ? 'document.preview' : 'document.download',
                category: 'document',
                resourceType: 'document',
                resourceId: doc.documentId,
                message: `${disposition === 'inline' ? 'Previewed' : 'Downloaded'} ${doc.originalFilename}`,
                metadata: { filename: doc.originalFilename },
            });
            fs.createReadStream(doc.storagePath).pipe(res);
        } catch (error) {
            next(error);
        }
    };

export const uploadDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_UPLOAD)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        ensureUploadDir();
        const file = req.file;
        if (!file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { assertStorageAvailable } = await import('../services/planService');
        const storageCheck = await assertStorageAvailable(
            req.user.organizationId,
            file.size || 0
        );
        if (!storageCheck.ok) {
            return res.status(403).json({
                success: false,
                code: 'STORAGE_LIMIT',
                message: storageCheck.message,
                data: {
                    usedBytes: storageCheck.usedBytes,
                    limitBytes: storageCheck.limitBytes,
                },
            });
        }

        const phase3Agent = ((req.body?.phase3Agent as string) || '').trim() || undefined;
        if (req.user.organizationId && req.user.role !== 'superAdmin') {
            const { requireAllowedAgent } = await import('../services/planService');
            const check = await requireAllowedAgent(req.user, phase3Agent);
            if (!check.ok) {
                return res.status(403).json({
                    success: false,
                    code: check.code,
                    message: check.message,
                    data: { allowedAgents: check.entitlement.agentIds },
                });
            }
        }

        const { doc, aiModelResponse } = await saveUploadedFile(req.user, file, phase3Agent);
        recordActivityFromReq(req, {
            action: 'document.upload',
            category: 'document',
            resourceType: 'document',
            resourceId: doc.documentId,
            message: `Uploaded ${doc.originalFilename}`,
            metadata: { filename: doc.originalFilename, mimeType: doc.mimeType },
        });
        res.status(201).json({
            success: true,
            message: 'Document uploaded successfully',
            data: { document: doc, aiModelResponse },
        });
    } catch (error: any) {
        if (error.statusCode === 429 || error.code === 'GROQ_RATE_LIMIT') {
            return res.status(429).json({
                success: false,
                code: 'GROQ_RATE_LIMIT',
                message: error.message || 'Groq rate limit reached',
                ...(error.groq || {}),
                console_url: error.groq?.console_url || 'https://console.groq.com/keys',
                billing_url: error.groq?.billing_url || 'https://console.groq.com/settings/billing',
                retry_after_seconds: error.groq?.retry_after_seconds || 24 * 3600,
            });
        }
        if (error.statusCode === 415) {
            return res.status(415).json({ success: false, message: error.message });
        }
        if (error.statusCode === 409) {
            return res.status(409).json({ success: false, message: error.message });
        }
        next(error);
    }
};

export const uploadDocumentsBulk = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_UPLOAD)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        ensureUploadDir();
        const files = (req.files as Express.Multer.File[]) || [];
        if (!files.length) {
            return res.status(400).json({ success: false, message: 'No files uploaded' });
        }

        const uploaded: any[] = [];
        const failed: { name: string; reason: string }[] = [];

        const { assertStorageAvailable } = await import('../services/planService');
        const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
        const storageCheck = await assertStorageAvailable(req.user.organizationId, totalBytes);
        if (!storageCheck.ok) {
            return res.status(403).json({
                success: false,
                code: 'STORAGE_LIMIT',
                message: storageCheck.message,
                data: {
                    usedBytes: storageCheck.usedBytes,
                    limitBytes: storageCheck.limitBytes,
                },
            });
        }

        for (const file of files) {
            try {
                const { doc } = await saveUploadedFile(req.user, file);
                uploaded.push(doc);
            } catch (err: any) {
                if (err.statusCode === 429 || err.code === 'GROQ_RATE_LIMIT') {
                    return res.status(429).json({
                        success: false,
                        code: 'GROQ_RATE_LIMIT',
                        message: err.message || 'Groq rate limit reached',
                        ...(err.groq || {}),
                        console_url: err.groq?.console_url || 'https://console.groq.com/keys',
                        billing_url: err.groq?.billing_url || 'https://console.groq.com/settings/billing',
                        retry_after_seconds: err.groq?.retry_after_seconds || 24 * 3600,
                        data: { uploaded, failed },
                    });
                }
                failed.push({ name: file.originalname, reason: err.message || 'Upload failed' });
            }
        }

        if (uploaded.length) {
            recordActivityFromReq(req, {
                action: 'document.upload.bulk',
                category: 'document',
                message: `Uploaded ${uploaded.length} file(s)${failed.length ? `, ${failed.length} failed` : ''}`,
                metadata: {
                    uploadedCount: uploaded.length,
                    failedCount: failed.length,
                    filenames: uploaded.map((d) => d.originalFilename),
                },
            });
        }

        res.status(uploaded.length ? 201 : 400).json({
            success: uploaded.length > 0,
            message: `Uploaded ${uploaded.length} file(s)${failed.length ? `, ${failed.length} failed` : ''}`,
            data: { uploaded, failed },
        });
    } catch (error) {
        next(error);
    }
};

export const getDocumentProcessing = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        let aiJob = null;
        let aiDocument = null;
        const orgId = resolveDocumentAiOrgId(doc, req.user);
        const runModel = req.query.runModel === 'true' || req.query.runModel === '1';

        if (isAiServiceEnabled() && doc.pythonDocumentId) {
            aiDocument = await syncStatusFromAiDocument(doc, orgId, req.user);
            aiJob = await getDocumentJobStatus(doc.pythonDocumentId, orgId);

            const missingData =
                !aiDocument?.cv_score &&
                !aiDocument?.extracted_data &&
                !(typeof aiDocument?.raw_text === 'string' && String(aiDocument.raw_text).length > 50);

            const jobStage = String(aiJob?.stage || '').toLowerCase();
            const jobStatus = String(aiJob?.status || '').toLowerCase();
            const activeStages = [
                'queued', 'running', 'preprocessing', 'ocr_processing', 'ocr_done',
                'classifying', 'classified', 'extracting', 'extracted', 'embedding', 'embedded', 'image_extraction',
            ];
            const alreadyRunning =
                activeStages.includes(jobStage) ||
                jobStatus === 'running' ||
                String(aiDocument?.status || '').toLowerCase() === 'processing';

            if (runModel && missingData && !alreadyRunning) {
                try {
                    doc.status = 'processing';
                    doc.aiErrorMessage = null;
                    await doc.save();
                    await triggerDocumentReprocess(doc.pythonDocumentId, orgId);
                } catch (e: any) {
                    const logger = (await import('../utils/logger')).default;
                    logger.warn(`Auto model run failed for ${doc.documentId}: ${e.message}`);
                }
            }

            await doc.save();
            aiDocument = await syncStatusFromAiDocument(doc, orgId, req.user);
            await doc.save();
            if (!aiJob) {
                aiJob = await getDocumentJobStatus(doc.pythonDocumentId, orgId);
            }
        }

        const cvScore =
            doc.metadata?.cvScore != null
                ? Number(doc.metadata.cvScore)
                : aiDocument?.cv_score != null
                  ? Number(aiDocument.cv_score)
                  : null;

        res.json({
            success: true,
            data: {
                documentId: doc.documentId,
                pythonDocumentId: doc.pythonDocumentId,
                status: doc.status,
                aiProcessingStatus: doc.aiProcessingStatus,
                aiErrorMessage: doc.aiErrorMessage,
                cvScore,
                classification: doc.classification || null,
                metadata: doc.metadata || null,
                job: aiJob,
                aiDocument,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updateDocumentAiSettings = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!doc.pythonDocumentId) {
            return res.status(400).json({ success: false, message: 'Document not linked to AI model' });
        }

        const { documentType, phase3Agent } = req.body || {};
        if (!documentType || !phase3Agent) {
            return res.status(400).json({ success: false, message: 'documentType and phase3Agent are required' });
        }

        if (req.user.role !== 'superAdmin') {
            const { requireAllowedAgent } = await import('../services/planService');
            const check = await requireAllowedAgent(req.user, String(phase3Agent));
            if (!check.ok) {
                return res.status(403).json({
                    success: false,
                    code: check.code,
                    message: check.message,
                    data: { allowedAgents: check.entitlement.agentIds },
                });
            }
        }

        const orgId = resolveAiOrganizationId(req.user);
        const result = await updateAiDocumentSettings({
            pythonDocumentId: doc.pythonDocumentId,
            organizationId: orgId,
            documentType: String(documentType),
            phase3Agent: String(phase3Agent),
        });

        doc.classification = String(documentType);
        doc.metadata = {
            ...(doc.metadata || {}),
            phase3Agent: String(phase3Agent),
        };
        try {
            const moved = await applyDocumentTypeStorage(doc, String(documentType));
            if (moved && doc.pythonDocumentId && fs.existsSync(doc.storagePath)) {
                const { updateAiDocumentFilePath } = await import('../services/aiServiceClient');
                await updateAiDocumentFilePath({
                    pythonDocumentId: doc.pythonDocumentId,
                    organizationId: orgId,
                    filePath: doc.storagePath,
                });
            }
        } catch (e: any) {
            logger.warn(`Storage relocate failed for ${doc.documentId}: ${e?.message || e}`);
        }
        await doc.save();

        res.json({
            success: true,
            data: { document: doc, aiUpdate: result },
        });
    } catch (error) {
        next(error);
    }
};

export const getDocumentIntelligence = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const orgId = resolveDocumentAiOrgId(doc, req.user);
        let aiDocument = null;
        let job = null;
        let validations: unknown[] = [];

        if (isAiServiceEnabled() && doc.pythonDocumentId) {
            const synced = await syncStatusFromAiDocument(doc, orgId, req.user);
            await doc.save();
            aiDocument = synced;
            const [extractions, jobResult, validationResult] = await Promise.all([
                getDocumentExtractions(doc.pythonDocumentId, orgId),
                getDocumentJobStatus(doc.pythonDocumentId, orgId),
                doc.status === 'ready' ? listAiValidations(orgId, doc.pythonDocumentId) : Promise.resolve([]),
            ]);
            if (Array.isArray(extractions) && extractions.length > 0) {
                aiDocument = { ...(aiDocument || {}), extractions };
            }
            job = jobResult;
            validations = validationResult;
        }

        res.json({
            success: true,
            data: {
                document: doc,
                aiDocument,
                job,
                validations,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const listAllDocumentIntelligence = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const filter = await buildDocumentFilter(req.user, {});
        const docs = await Document.find(filter).sort({ createdAt: -1 }).limit(100);

        const documents = await Promise.all(
            docs.map(async (doc) => {
                let aiDocument = null;
                let job = null;
                let validations: unknown[] = [];
                const orgId = resolveDocumentAiOrgId(doc, req.user);

                if (isAiServiceEnabled() && doc.pythonDocumentId) {
                    const synced = await syncStatusFromAiDocument(doc, orgId, req.user);
                    await doc.save();
                    aiDocument = synced;
                    job = await getDocumentJobStatus(doc.pythonDocumentId, orgId);
                    if (doc.status === 'ready') {
                        validations = await listAiValidations(orgId, doc.pythonDocumentId);
                    }
                }

                return {
                    document: doc.toObject(),
                    aiDocument,
                    job,
                    validations,
                };
            })
        );

        const summary = {
            total: documents.length,
            processing: documents.filter((d) =>
                d.document.status === 'processing' || d.document.status === 'uploaded'
            ).length,
            ready: documents.filter((d) => d.document.status === 'ready').length,
            failed: documents.filter((d) => d.document.status === 'failed').length,
        };

        res.json({ success: true, data: { summary, documents } });
    } catch (error) {
        next(error);
    }
};

export const getDocumentImages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!doc.pythonDocumentId) {
            return res.json({ success: true, data: { images: [], descriptions_file: '' } });
        }

        const orgId = resolveDocumentAiOrgId(doc, req.user);
        const imagesData = await getAiDocumentImages(doc.pythonDocumentId, orgId);
        const images = imagesData?.images || [];
        const descriptionsFile = images.length
            ? `/api/docs/documents/${doc.documentId}/ai-file?path=images/${doc.pythonDocumentId}/descriptions.txt`
            : '';

        res.json({
            success: true,
            data: { images, descriptions_file: descriptionsFile },
        });
    } catch (error) {
        next(error);
    }
};

export const getDocumentSimilar = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!doc.pythonDocumentId) {
            return res.json({ success: true, data: { results: [], total: 0 } });
        }

        const orgId = resolveDocumentAiOrgId(doc, req.user);
        const limit = Math.min(20, Math.max(1, parseInt((req.query.limit as string) || '5', 10)));
        const results = await getSimilarDocuments(doc.pythonDocumentId, orgId, limit);

        const pythonIds = [...new Set(results.map((r) => r.document_id).filter(Boolean))];
        const nodeDocs = pythonIds.length
            ? await Document.find(
                  await buildDocumentFilter(req.user, { pythonDocumentId: { $in: pythonIds } })
              ).lean()
            : [];
        const pythonToNode = new Map(
            nodeDocs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d])
        );

        const enriched = results.map((hit) => {
            const nodeDoc = pythonToNode.get(hit.document_id);
            return {
                ...hit,
                nodeDocumentId: nodeDoc?.documentId || null,
                previewDocumentId: nodeDoc?.documentId || hit.document_id,
            };
        });

        res.json({
            success: true,
            data: { results: enriched, total: enriched.length },
        });
    } catch (error) {
        next(error);
    }
};

export const streamDocumentAiFile = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const assetPath = String(req.query.path || '');
        if (!assetPath || assetPath.includes('..')) {
            return res.status(400).json({ success: false, message: 'Invalid path' });
        }
        if (doc.pythonDocumentId && !assetPath.includes(doc.pythonDocumentId)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const streamed = await streamAiAsset(assetPath);
        if (!streamed) {
            return res.status(404).json({ success: false, message: 'File not found' });
        }

        res.setHeader('Content-Type', streamed.contentType);
        streamed.data.pipe(res);
    } catch (error) {
        next(error);
    }
};

export const reprocessDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_VIEW)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canAccessDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!doc.pythonDocumentId) {
            return res.status(400).json({ success: false, message: 'Document not linked to AI model' });
        }

        const orgId = resolveDocumentAiOrgId(doc, req.user);
        if (!doc.storagePath || !fs.existsSync(doc.storagePath)) {
            return res.status(404).json({
                success: false,
                message:
                    'Original file is missing from storage. Please delete this entry and re-upload the document.',
            });
        }

        doc.status = 'processing';
        doc.aiErrorMessage = null;
        await doc.save();

        const { updateAiDocumentFilePath } = await import('../services/aiServiceClient');
        await updateAiDocumentFilePath({
            pythonDocumentId: doc.pythonDocumentId,
            organizationId: orgId,
            filePath: doc.storagePath,
        });
        await triggerDocumentReprocess(doc.pythonDocumentId, orgId);

        res.json({
            success: true,
            message: 'AI analysis started — refresh in a few seconds',
            data: {
                document: doc,
                aiDocument: null,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteDocument = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const doc = await Document.findOne({ documentId: req.params.id });
        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }
        if (!(await canDeleteDocument(req.user, doc))) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        await deleteDocumentFully(doc.documentId, doc.storagePath, {
            pythonDocumentId: doc.pythonDocumentId,
            aiOrgId: resolveDocumentAiOrgId(doc, req.user),
        });
        recordActivityFromReq(req, {
            action: 'document.delete',
            category: 'document',
            resourceType: 'document',
            resourceId: doc.documentId,
            message: `Deleted ${doc.originalFilename}`,
            metadata: { filename: doc.originalFilename },
        });
        res.json({ success: true, message: 'Document and folder deleted' });
    } catch (error) {
        next(error);
    }
};

/**
 * Bulk delete with optional filters:
 * - classification / documentType (e.g. resume, invoice)
 * - dateFrom / dateTo (createdAt range, ISO dates)
 * - uploadedBy (userId)
 * - dryRun: true → only return matching count + sample, no delete
 *
 * Scope by role:
 * - employee: own uploads only (shared docs excluded)
 * - leader: own + department members' uploads
 * - admin / superAdmin: org-wide / all
 */
export const bulkDeleteDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.DOCUMENT_DELETE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const classification = (
            req.body.classification ||
            req.body.documentType ||
            ''
        )
            .toString()
            .trim() || undefined;
        const uploadedBy = (req.body.uploadedBy || '').toString().trim() || undefined;
        const dateFrom = (req.body.dateFrom || '').toString().trim() || undefined;
        const dateTo = (req.body.dateTo || '').toString().trim() || undefined;
        const dryRun = req.body.dryRun === true || req.body.dryRun === 'true' || req.body.dryRun === 1;

        const ctx = await loadUserDeptContext(req.user);
        const isAdmin =
            req.user.role === 'superAdmin' ||
            req.user.role === 'admin';

        let deletableUploaderIds: string[] | null = null;
        if (!isAdmin) {
            if (ctx.isLeader) {
                deletableUploaderIds = await getLeaderDeletableUploaderIds(req.user, ctx);
            } else {
                // Employee: only own uploads — never shared docs
                deletableUploaderIds = [req.user.userId];
            }
        }

        let effectiveUploader = uploadedBy;
        if (!isAdmin) {
            if (effectiveUploader) {
                if (!deletableUploaderIds?.includes(effectiveUploader)) {
                    return res.status(403).json({
                        success: false,
                        message: ctx.isLeader
                            ? 'You can only delete documents from your department members'
                            : 'You can only delete your own documents',
                    });
                }
            } else if (!ctx.isLeader) {
                effectiveUploader = req.user.userId;
            }
        }

        const extra: Record<string, unknown> = {};
        if (effectiveUploader) {
            extra.uploadedBy = effectiveUploader;
        } else if (deletableUploaderIds) {
            // Leader deleting "all" they can: restrict to dept uploaders (excludes shared-only docs)
            extra.uploadedBy = { $in: deletableUploaderIds };
        } else if (req.user.role === 'admin' && req.user.organizationId) {
            extra.organizationId = req.user.organizationId;
        }

        if (dateFrom || dateTo) {
            const createdAt: Record<string, Date> = {};
            if (dateFrom) {
                const d = new Date(dateFrom);
                if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
            }
            if (dateTo) {
                const d = new Date(dateTo);
                if (!Number.isNaN(d.getTime())) {
                    d.setHours(23, 59, 59, 999);
                    createdAt.$lte = d;
                }
            }
            if (Object.keys(createdAt).length) extra.createdAt = createdAt;
        }

        // Prefer delete-scope filter (uploader-based) over access filter so shared docs
        // are never bulk-deleted by employees/leaders who only received a share.
        const filter: Record<string, unknown> = { ...extra };
        if (classification) filter.classification = classification;

        const candidates = await Document.find(filter)
            .select('documentId originalFilename uploadedBy storagePath pythonDocumentId organizationId departmentId classification createdAt metadata')
            .sort({ createdAt: -1 })
            .limit(2000)
            .lean();

        const memberSet = deletableUploaderIds ? new Set(deletableUploaderIds) : undefined;
        const deletable: typeof candidates = [];
        for (const d of candidates) {
            if (
                await canDeleteDocument(req.user, d, {
                    ctx,
                    deptMemberIds: memberSet,
                })
            ) {
                deletable.push(d);
            }
        }

        if (dryRun) {
            return res.json({
                success: true,
                data: {
                    count: deletable.length,
                    sample: deletable.slice(0, 20).map((d) => ({
                        documentId: d.documentId,
                        originalFilename: d.originalFilename,
                        classification: d.classification || null,
                        uploadedBy: d.uploadedBy,
                        createdAt: d.createdAt,
                    })),
                    truncated: candidates.length >= 2000,
                    scope: isAdmin
                        ? 'organization'
                        : ctx.isLeader
                          ? 'department'
                          : 'own',
                },
            });
        }

        if (!deletable.length) {
            return res.json({
                success: true,
                data: { deleted: 0, failed: 0 },
                message: 'No matching documents to delete',
            });
        }

        let deleted = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const doc of deletable) {
            try {
                await deleteDocumentFully(doc.documentId, doc.storagePath, {
                    pythonDocumentId: doc.pythonDocumentId,
                    aiOrgId: resolveDocumentAiOrgId(doc as any, req.user),
                });
                deleted += 1;
            } catch (e: any) {
                failed += 1;
                if (errors.length < 5) errors.push(`${doc.originalFilename}: ${e.message || e}`);
            }
        }

        recordActivityFromReq(req, {
            action: 'document.delete.bulk',
            category: 'document',
            resourceType: 'document',
            message: `Bulk deleted ${deleted} document(s)`,
            metadata: {
                deleted,
                failed,
                classification: classification || null,
                uploadedBy: effectiveUploader || null,
                dateFrom: dateFrom || null,
                dateTo: dateTo || null,
                scope: isAdmin ? 'organization' : ctx.isLeader ? 'department' : 'own',
            },
        });

        res.json({
            success: true,
            data: { deleted, failed, errors },
            message: `Deleted ${deleted} document(s)${failed ? `, ${failed} failed` : ''}`,
        });
    } catch (error) {
        next(error);
    }
};
