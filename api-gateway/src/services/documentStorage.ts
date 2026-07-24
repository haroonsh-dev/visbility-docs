import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import Document, { IDocument } from '../models/Document';
import DocumentChunk from '../models/DocumentChunk';
import { isAllowedFile, sanitizeFilename } from '../utils/fileValidation';
import { AuthUser } from './accessScope';
import {
    AiUploadResult,
    deleteDocumentFromAi,
    isAiServiceEnabled,
    resolveAiOrganizationId,
    uploadDocumentToAi,
} from './aiServiceClient';
import logger from '../utils/logger';

const VM_MAIN_ROOT = path.resolve(process.cwd(), '..');

/** Shared folder used by Node api-gateway and Python ai-backend */
export const UPLOAD_ROOT = process.env.SHARED_STORAGE_PATH
    ? path.resolve(process.env.SHARED_STORAGE_PATH)
    : path.join(VM_MAIN_ROOT, 'shared-storage');

/** Known document types → by-type/{type}/… folders */
export const KNOWN_DOCUMENT_TYPES = new Set([
    // Finance
    'invoice',
    'financial_statement',
    'expense_report',
    'payment_receipt',
    'tax_document',
    'bank_statement',
    'budget',
    // HR
    'employee_record',
    'hr_document',
    'offer_letter',
    'employment_contract',
    'leave_application',
    'payroll',
    'attendance',
    'performance_review',
    'training_certificate',
    'resume',
    'transcript',
    // Legal
    'contract',
    'agreement',
    'nda',
    'service_agreement',
    'lease_agreement',
    'vendor_contract',
    // Procurement
    'purchase_order',
    'quotation',
    'supplier_agreement',
    'vendor_list',
    'rfq',
    'delivery_note',
    'procurement_request',
    // Compliance
    'sop',
    'audit_report',
    'quality_report',
    'certificate',
    'maintenance_report',
    'engineering_drawing',
    'inspection_report',
    'safety_manual',
    'iso_document',
    'compliance_form',
    'regulatory_document',
    'other',
]);

export function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_ROOT)) {
        fs.mkdirSync(UPLOAD_ROOT, { recursive: true });
    }
}

export function resolveOrgFolder(organizationId?: string | null, userId?: string | null): string {
    if (organizationId) return organizationId;
    if (userId) return `personal_${userId}`;
    return 'personal_unknown';
}

export function normalizeDocumentType(raw?: string | null): string {
    if (!raw) return 'other';
    let t = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (t === 'cv' || t === 'curriculum_vitae' || t === 'curriculum') t = 'resume';
    if (t === 'po') t = 'purchase_order';
    if (t === 'hr') t = 'hr_document';
    if (t === 'non_disclosure' || t === 'non_disclosure_agreement') t = 'nda';
    if (t === 'request_for_quotation') t = 'rfq';
    if (!KNOWN_DOCUMENT_TYPES.has(t)) return 'other';
    return t;
}

export function inferDocumentTypeFromFilename(filename: string): string | null {
    const name = filename.toLowerCase();
    if (/\b(cv|resume|curriculum)\b/.test(name)) return 'resume';
    if (name.includes('invoice')) return 'invoice';
    if (name.includes('contract')) return 'contract';
    if (name.includes('quotation') || name.includes('quote')) return 'quotation';
    if (name.includes('purchase') || /\bpo\b/.test(name)) return 'purchase_order';
    if (name.includes('certificate')) return 'certificate';
    if (name.includes('transcript')) return 'transcript';
    if (name.includes('sop')) return 'sop';
    return null;
}

function yyyyMm(date: Date = new Date()): { yyyy: string; mm: string } {
    const yyyy = String(date.getUTCFullYear());
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    return { yyyy, mm };
}

/**
 * Layout:
 *   orgs/{orgId}/by-type/{documentType}/{yyyy}/{mm}/{documentId}/
 * Unclassified inbox:
 *   orgs/{orgId}/by-type/other/inbox/{documentId}/
 */
export function getDocumentDir(
    orgFolder: string,
    documentId: string,
    options?: {
        documentType?: string | null;
        createdAt?: Date | string | null;
        inbox?: boolean;
    }
): string {
    if (options?.inbox) {
        return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'by-type', 'other', 'inbox', documentId);
    }

    const type = normalizeDocumentType(options?.documentType);
    const when = options?.createdAt ? new Date(options.createdAt) : new Date();
    const { yyyy, mm } = yyyyMm(Number.isNaN(when.getTime()) ? new Date() : when);
    return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'by-type', type, yyyy, mm, documentId);
}

/** @deprecated Prefer getDocumentDir with type options — kept for callers expecting old signature */
export function getLegacyDocumentDir(orgFolder: string, documentId: string) {
    return path.join(UPLOAD_ROOT, 'orgs', orgFolder, 'documents', documentId);
}

export function deleteDocumentFolder(storagePath: string) {
    const dir = path.dirname(storagePath);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clean empty parent month/year folders (best-effort)
    try {
        let parent = path.dirname(dir);
        for (let i = 0; i < 3; i++) {
            if (!fs.existsSync(parent)) break;
            const entries = fs.readdirSync(parent);
            if (entries.length > 0) break;
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
        }
    } catch {
        /* ignore */
    }
}

/**
 * Move document folder into by-type/{type}/{yyyy}/{mm}/{documentId}/ and return new storagePath.
 * No-op if already at the correct location.
 */
export function relocateDocumentOnDisk(
    doc: {
        documentId: string;
        storagePath: string;
        storedFilename: string;
        organizationId?: string | null;
        uploadedBy: string;
        createdAt?: Date | string;
        classification?: string | null;
    },
    documentType: string
): { storagePath: string; moved: boolean; destDir: string } {
    const type = normalizeDocumentType(documentType);
    const orgFolder = resolveOrgFolder(doc.organizationId, doc.uploadedBy);
    const destDir = getDocumentDir(orgFolder, doc.documentId, {
        documentType: type,
        createdAt: doc.createdAt || new Date(),
        inbox: false,
    });

    const currentDir = path.dirname(doc.storagePath);
    const newStoragePath = path.join(destDir, doc.storedFilename || path.basename(doc.storagePath));

    if (path.resolve(currentDir) === path.resolve(destDir)) {
        return { storagePath: doc.storagePath, moved: false, destDir };
    }

    fs.mkdirSync(destDir, { recursive: true });

    if (fs.existsSync(doc.storagePath)) {
        // Move whole document directory contents if currentDir is the doc folder
        if (path.basename(currentDir) === doc.documentId && fs.existsSync(currentDir)) {
            // Move each entry into destDir (handles original + any derived files)
            for (const name of fs.readdirSync(currentDir)) {
                const from = path.join(currentDir, name);
                const to = path.join(destDir, name);
                if (fs.existsSync(to)) {
                    fs.rmSync(to, { recursive: true, force: true });
                }
                fs.renameSync(from, to);
            }
            try {
                fs.rmSync(currentDir, { recursive: true, force: true });
            } catch {
                /* ignore */
            }
        } else {
            fs.renameSync(doc.storagePath, newStoragePath);
        }
    } else if (!fs.existsSync(newStoragePath)) {
        logger.warn(`relocateDocumentOnDisk: source missing ${doc.storagePath}`);
        return { storagePath: doc.storagePath, moved: false, destDir };
    }

    // Clean empty old parents
    try {
        let parent = currentDir;
        for (let i = 0; i < 4; i++) {
            if (!fs.existsSync(parent)) break;
            if (fs.readdirSync(parent).length > 0) break;
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
        }
    } catch {
        /* ignore */
    }

    const finalPath = fs.existsSync(newStoragePath)
        ? newStoragePath
        : path.join(destDir, doc.storedFilename || path.basename(doc.storagePath));

    logger.info(`Relocated document ${doc.documentId} → ${finalPath}`);
    return { storagePath: finalPath, moved: true, destDir };
}

/** Apply type-based folder layout and persist storagePath on the mongoose doc (caller may save). */
export async function applyDocumentTypeStorage(
    doc: InstanceType<typeof Document>,
    documentType: string
): Promise<boolean> {
    const type = normalizeDocumentType(documentType);
    if (!type) return false;

    const result = relocateDocumentOnDisk(
        {
            documentId: doc.documentId,
            storagePath: doc.storagePath,
            storedFilename: doc.storedFilename,
            organizationId: doc.organizationId,
            uploadedBy: doc.uploadedBy,
            createdAt: doc.createdAt,
            classification: doc.classification,
        },
        type
    );

    if (result.moved) {
        doc.storagePath = result.storagePath;
        doc.metadata = {
            ...(doc.metadata || {}),
            storageLayout: 'by-type',
            storageType: type,
        };
    }
    return result.moved;
}

export async function deleteDocumentFully(
    documentId: string,
    storagePath: string,
    options?: { pythonDocumentId?: string | null; aiOrgId?: string }
) {
    if (options?.pythonDocumentId && options.aiOrgId && isAiServiceEnabled()) {
        try {
            await deleteDocumentFromAi(options.pythonDocumentId, options.aiOrgId);
        } catch (e: any) {
            logger.warn(`AI delete failed for ${documentId}: ${e.message}`);
        }
    }
    deleteDocumentFolder(storagePath);
    await DocumentChunk.deleteMany({ documentId });
    await Document.deleteOne({ documentId });
}

export interface UploadFileInput {
    path: string;
    originalname: string;
    mimetype: string;
    size: number;
}

export type SaveUploadResult = {
    doc: IDocument;
    aiModelResponse: AiUploadResult | null;
};

export async function saveUploadedFile(
    user: AuthUser,
    file: UploadFileInput,
    phase3Agent?: string
): Promise<SaveUploadResult> {
    const validation = isAllowedFile(file.originalname, file.mimetype);
    if (!validation.ok) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        throw Object.assign(new Error(validation.reason), { statusCode: 415 });
    }

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);

    // Always land in inbox — filename is unreliable; AI/manual classify moves to by-type/{type}/…
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });

    fs.mkdirSync(destDir, { recursive: true });

    const storedFilename = sanitizeFilename(file.originalname);
    const storagePath = path.join(destDir, storedFilename);
    fs.renameSync(file.path, storagePath);

    const contentHash = crypto.createHash('sha256').update(fs.readFileSync(storagePath)).digest('hex');

    const existingDup = await Document.findOne({
        uploadedBy: user.userId,
        contentHash,
        pythonDocumentId: { $exists: true, $ne: null },
    }).lean();

    if (existingDup) {
        deleteDocumentFolder(storagePath);
        throw Object.assign(
            new Error(
                `This file was already uploaded as "${existingDup.originalFilename}". Delete the existing copy first or upload a different file.`
            ),
            { statusCode: 409 }
        );
    }

    let pythonDocumentId: string | null = null;
    let aiProcessingStatus: string | null = null;
    let aiErrorMessage: string | null = null;
    let status: 'uploaded' | 'processing' | 'failed' = 'uploaded';
    let aiModelResponse: AiUploadResult | null = null;
    let aiOrgId: string | null = null;

    if (isAiServiceEnabled()) {
        try {
            aiOrgId = resolveAiOrganizationId(user);
            let allowedAgents: string[] | undefined;
            if (user.role !== 'superAdmin' && user.organizationId) {
                const { getAllowedAgentsForOrg } = await import('./planService');
                allowedAgents = await getAllowedAgentsForOrg(user.organizationId);
            }
            const aiResult = await uploadDocumentToAi({
                filePath: storagePath,
                originalFilename: file.originalname,
                mimeType: file.mimetype,
                organizationId: aiOrgId,
                title: file.originalname,
                phase3Agent: phase3Agent || undefined,
                uploadedBy: user.userId,
                allowedAgents,
            });
            pythonDocumentId = aiResult.id;
            aiProcessingStatus = aiResult.status;
            status = 'processing';
            aiModelResponse = aiResult;
        } catch (e: any) {
            const { extractGroqLimitError } = await import('./aiServiceClient');
            const groq = extractGroqLimitError(e);
            if (groq) {
                deleteDocumentFolder(storagePath);
                throw Object.assign(new Error(groq.message), {
                    statusCode: 429,
                    code: 'GROQ_RATE_LIMIT',
                    groq,
                });
            }
            aiErrorMessage = e.message || 'AI upload failed';
            status = 'failed';
            logger.warn(`AI forward failed for ${documentId}: ${aiErrorMessage}`);
        }
    }

    const doc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as any).openRemoteUserId || null,
        originalFilename: file.originalname,
        storedFilename,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storagePath,
        contentHash,
        pythonDocumentId,
        aiProcessingStatus,
        aiErrorMessage,
        status,
        classification: null,
        metadata: {
            source: 'web_upload',
            aiSynced: !!pythonDocumentId,
            storageLayout: 'by-type',
            storageType: 'inbox',
            ...(phase3Agent ? { phase3Agent } : {}),
            ...(pythonDocumentId && aiOrgId ? { aiOrgId } : {}),
        },
    });

    try {
        const { applyDocumentVisibilityScope } = await import('./documentVisibility');
        await applyDocumentVisibilityScope(doc, null);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Initial visibility assignment failed for ${doc.documentId}: ${e?.message || e}`);
    }

    return { doc, aiModelResponse };
}
