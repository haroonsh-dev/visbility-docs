import Document from '../models/Document';
import { deleteDocumentFully } from './documentStorage';
import {
    getAiDocument,
    getDocumentJobStatus,
    isAiServiceEnabled,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import logger from '../utils/logger';

const DEFAULT_TTL_HOURS = Number(process.env.AGENT_API_DOC_TTL_HOURS || 24);
const MAX_WAIT_MS = Math.min(
    Number(process.env.AGENT_API_PROCESS_WAIT_MS || 45000),
    120000
);

export function agentApiTtlHours(): number {
    return Number.isFinite(DEFAULT_TTL_HOURS) && DEFAULT_TTL_HOURS > 0
        ? DEFAULT_TTL_HOURS
        : 24;
}

export function computeAgentApiExpiresAt(from = new Date()): Date {
    return new Date(from.getTime() + agentApiTtlHours() * 60 * 60 * 1000);
}

/** Mark a freshly uploaded doc as partner Agent API (ephemeral / customer-owned storage). */
export async function markAgentApiDocument(
    documentId: string,
    opts?: { ephemeral?: boolean; agentId?: string }
): Promise<InstanceType<typeof Document> | null> {
    const doc = await Document.findOne({ documentId });
    if (!doc) return null;
    const ephemeral = opts?.ephemeral !== false;
    const expiresAt = computeAgentApiExpiresAt();
    doc.metadata = {
        ...(doc.metadata || {}),
        source: 'agent_api',
        agentApi: true,
        agentApiEphemeral: ephemeral,
        agentApiExpiresAt: expiresAt.toISOString(),
        ...(opts?.agentId ? { phase3Agent: opts.agentId } : {}),
    };
    await doc.save();
    return doc;
}

export type PartnerDocumentPayload = {
    documentId: string;
    status: string;
    aiProcessingStatus: string | null;
    aiErrorMessage: string | null;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    classification: string | null;
    ocrText: string | null;
    extracted: unknown;
    cvScore: number | null;
    pageCount: number | null;
    expiresAt: string | null;
    ephemeral: boolean;
    ready: boolean;
    /** Bundle for the customer to persist in their DB */
    store: {
        documentId: string;
        fileName: string;
        classification: string | null;
        ocrText: string | null;
        extracted: unknown;
        cvScore: number | null;
        processedAt: string;
    } | null;
};

function pickOcrText(aiDoc: Record<string, unknown> | null): string | null {
    if (!aiDoc) return null;
    const raw = aiDoc.raw_text ?? aiDoc.ocr_text ?? aiDoc.text;
    if (typeof raw === 'string' && raw.trim()) return raw;
    return null;
}

function pickExtracted(aiDoc: Record<string, unknown> | null): unknown {
    if (!aiDoc) return null;
    return aiDoc.extracted_data ?? aiDoc.extractions ?? aiDoc.structured_data ?? null;
}

export async function buildPartnerDocumentPayload(
    doc: InstanceType<typeof Document>,
    user: { organizationId?: string | null; userId: string }
): Promise<PartnerDocumentPayload> {
    let aiDoc: Record<string, unknown> | null = null;
    let job: Record<string, unknown> | null = null;

    if (isAiServiceEnabled() && doc.pythonDocumentId) {
        const orgId = resolveDocumentAiOrgId(doc, user);
        try {
            aiDoc = (await getAiDocument(doc.pythonDocumentId, orgId)) as Record<
                string,
                unknown
            > | null;
        } catch {
            aiDoc = null;
        }
        try {
            job = (await getDocumentJobStatus(doc.pythonDocumentId, orgId)) as Record<
                string,
                unknown
            > | null;
        } catch {
            job = null;
        }

        // Light sync of terminal status onto the gateway doc
        const pyStatus = String(aiDoc?.status || job?.status || '').toLowerCase();
        if (pyStatus.includes('fail')) {
            doc.status = 'failed';
            if (aiDoc?.error_message) doc.aiErrorMessage = String(aiDoc.error_message);
        } else if (
            ['ready', 'done', 'completed', 'extracted', 'embedded'].some((s) =>
                pyStatus.includes(s)
            ) ||
            (typeof aiDoc?.raw_text === 'string' && String(aiDoc.raw_text).length > 20) ||
            aiDoc?.extracted_data
        ) {
            if (doc.status === 'uploaded' || doc.status === 'processing') {
                doc.status = 'ready';
            }
            if (aiDoc?.document_type) {
                doc.classification = String(aiDoc.document_type);
            }
            if (aiDoc?.cv_score != null) {
                doc.metadata = {
                    ...(doc.metadata || {}),
                    cvScore: Number(aiDoc.cv_score),
                };
            }
        } else if (pyStatus) {
            doc.status = 'processing';
        }
        if (aiDoc?.status) doc.aiProcessingStatus = String(aiDoc.status);
        if (doc.isModified()) await doc.save();
    }

    const ocrText = pickOcrText(aiDoc);
    const extracted = pickExtracted(aiDoc);
    const ready =
        doc.status === 'ready' ||
        Boolean(ocrText && ocrText.length > 20) ||
        extracted != null;
    const cvScore =
        doc.metadata?.cvScore != null
            ? Number(doc.metadata.cvScore)
            : aiDoc?.cv_score != null
              ? Number(aiDoc.cv_score)
              : null;
    const expiresAt =
        typeof doc.metadata?.agentApiExpiresAt === 'string'
            ? doc.metadata.agentApiExpiresAt
            : null;
    const ephemeral = doc.metadata?.agentApiEphemeral !== false;

    return {
        documentId: doc.documentId,
        status: doc.status,
        aiProcessingStatus: doc.aiProcessingStatus || null,
        aiErrorMessage: doc.aiErrorMessage || null,
        fileName: doc.originalFilename,
        mimeType: doc.mimeType,
        sizeBytes: doc.sizeBytes,
        classification: doc.classification || null,
        ocrText,
        extracted,
        cvScore,
        pageCount: doc.pageCount ?? null,
        expiresAt,
        ephemeral,
        ready,
        store: ready
            ? {
                  documentId: doc.documentId,
                  fileName: doc.originalFilename,
                  classification: doc.classification || null,
                  ocrText,
                  extracted,
                  cvScore,
                  processedAt: new Date().toISOString(),
              }
            : null,
    };
}

/** Poll until OCR ready; for invoices keep waiting a bit for structured extracted JSON. */
export async function waitForPartnerDocumentReady(
    documentId: string,
    user: { organizationId?: string | null; userId: string },
    waitMs = MAX_WAIT_MS
): Promise<PartnerDocumentPayload | null> {
    const deadline = Date.now() + Math.max(0, waitMs);
    let last: PartnerDocumentPayload | null = null;
    while (Date.now() <= deadline) {
        const doc = await Document.findOne({ documentId });
        if (!doc) return null;
        last = await buildPartnerDocumentPayload(doc, user);
        if (last.status === 'failed') return last;

        const extractedObj =
            last.extracted && typeof last.extracted === 'object'
                ? (last.extracted as Record<string, unknown>)
                : null;
        const hasExtracted = Boolean(
            extractedObj && Object.keys(extractedObj).length > 0
        );
        const aiStatus = String(last.aiProcessingStatus || '').toLowerCase();
        const extractDone = [
            'extracted',
            'embedded',
            'ready',
            'completed',
            'done',
            'image_extraction',
        ].some((s) => aiStatus.includes(s));

        if (last.ready) {
            // Invoice/finance docs: prefer waiting for structured extract when time remains
            const wantsExtract =
                ['invoice', 'receipt', 'purchase_order', 'bill'].includes(
                    String(last.classification || '').toLowerCase()
                ) || aiStatus.includes('extract');
            if (wantsExtract && !hasExtracted && !extractDone && Date.now() + 3000 < deadline) {
                await new Promise((r) => setTimeout(r, 1500));
                continue;
            }
            return last;
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
    return last;
}

export async function purgeAgentApiDocument(
    documentId: string,
    organizationId: string
): Promise<boolean> {
    const doc = await Document.findOne({ documentId, organizationId });
    if (!doc) return false;
    if (doc.metadata?.agentApi !== true && doc.metadata?.source !== 'agent_api') {
        // Still allow delete of org docs created via Agent API user
        if (!String(doc.uploadedBy || '').startsWith('agent_api:')) return false;
    }
    await deleteDocumentFully(doc.documentId, doc.storagePath, {
        pythonDocumentId: doc.pythonDocumentId,
        aiOrgId: resolveDocumentAiOrgId(doc, {
            userId: doc.uploadedBy,
            organizationId: doc.organizationId,
        }),
    });
    return true;
}

/** Delete expired ephemeral Agent API docs (customer should have stored results by then). */
export async function purgeExpiredAgentApiDocuments(): Promise<number> {
    const now = new Date().toISOString();
    const candidates = await Document.find({
        'metadata.agentApi': true,
        'metadata.agentApiEphemeral': true,
        'metadata.agentApiExpiresAt': { $lte: now },
    })
        .limit(50)
        .lean();

    let n = 0;
    for (const row of candidates) {
        try {
            await deleteDocumentFully(row.documentId, row.storagePath, {
                pythonDocumentId: row.pythonDocumentId,
                aiOrgId: resolveDocumentAiOrgId(row, {
                    userId: row.uploadedBy,
                    organizationId: row.organizationId,
                }),
            });
            n += 1;
        } catch (e: any) {
            logger.warn(
                `[agent-api] purge failed for ${row.documentId}: ${e?.message || e}`
            );
        }
    }
    if (n > 0) {
        logger.info(`[agent-api] purged ${n} expired ephemeral document(s)`);
    }
    return n;
}

export function normalizeAgentApiAgentId(raw: string, allowed: string[]): string {
    let agentId = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
    if (agentId && !allowed.includes(agentId) && !agentId.endsWith('_agent')) {
        const withSuffix = `${agentId}_agent`;
        if (allowed.includes(withSuffix)) agentId = withSuffix;
    }
    return agentId;
}
