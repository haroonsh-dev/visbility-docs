import axios, { AxiosError } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

const BASE_URL = (process.env.AI_SERVICE_URL || 'http://localhost:8001').replace(/\/$/, '');
const TIMEOUT = parseInt(process.env.AI_SERVICE_TIMEOUT_MS || '120000', 10);
const ENABLED = process.env.AI_SERVICE_ENABLED !== 'false';

export function isAiServiceEnabled(): boolean {
    return ENABLED;
}

function client() {
    return axios.create({
        baseURL: BASE_URL,
        timeout: TIMEOUT,
        validateStatus: () => true,
    });
}

/** Preserve AI JSON body so callers can detect GROQ_RATE_LIMIT etc. */
export class AiHttpError extends Error {
    status: number;
    data: any;
    constructor(message: string, status: number, data: any) {
        super(message);
        this.name = 'AiHttpError';
        this.status = status;
        this.data = data;
    }
}

function throwIfAiFailed(res: { status: number; data: any }, label: string): void {
    if (res.status < 400) return;
    const detail =
        typeof res.data?.detail === 'string'
            ? res.data.detail
            : res.data?.message || JSON.stringify(res.data);
    throw new AiHttpError(`${label} (${res.status}): ${detail}`, res.status, res.data);
}

export function resolveAiOrganizationId(user: {
    organizationId?: string | null;
    userId: string;
}): string {
    return user.organizationId || `personal_${user.userId}`;
}

export function resolveDocumentAiOrgId(
    doc: { metadata?: Record<string, unknown> | null; organizationId?: string | null; uploadedBy?: string },
    user: { organizationId?: string | null; userId: string }
): string {
    const stored = doc.metadata?.aiOrgId;
    if (typeof stored === 'string' && stored.trim()) return stored;
    return resolveAiOrganizationId({
        organizationId: doc.organizationId || user.organizationId,
        userId: doc.uploadedBy || user.userId,
    });
}

export type AiUploadResult = {
    id: string;
    title: string;
    status: string;
    message: string;
};

export async function deleteDocumentFromAi(
    pythonDocumentId: string,
    organizationId: string
): Promise<boolean> {
    if (!ENABLED || !pythonDocumentId) return false;

    const res = await client().delete(`/api/v1/documents/${pythonDocumentId}`, {
        params: { organization_id: organizationId },
    });
    return res.status < 400;
}

export async function uploadDocumentToAi(params: {
    filePath: string;
    originalFilename: string;
    mimeType: string;
    organizationId: string;
    title?: string;
    phase3Agent?: string;
    uploadedBy?: string;
    allowedAgents?: string[];
}): Promise<AiUploadResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const form = new FormData();
    form.append('organization_id', params.organizationId);
    form.append('title', params.title || params.originalFilename);
    form.append('local_file_path', path.resolve(params.filePath));
    if (params.phase3Agent) form.append('phase3_agent', params.phase3Agent);
    if (params.uploadedBy) form.append('uploaded_by', params.uploadedBy);
    if (params.allowedAgents?.length) {
        form.append('allowed_agents', params.allowedAgents.join(','));
    }

    const res = await client().post('/api/v1/documents/upload', form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

    throwIfAiFailed(res, 'AI upload failed');

    return res.data as AiUploadResult;
}

export type AiChatResult = {
    answer: string;
    sources: Array<Record<string, unknown>>;
    document_id: string;
    session_id?: string;
    provider?: string;
    model?: string;
};

export type AiProviderConfig = {
    provider: string;
    apiKey: string;
    model?: string;
    baseUrl?: string | null;
};

export async function syncProviderToAIBackend(config: AiProviderConfig): Promise<void> {
    if (!ENABLED) return;
    try {
        const res = await client().post('/api/v1/settings/providers', {
            provider: config.provider,
            apiKey: config.apiKey,
            model: config.model || '',
            baseUrl: config.baseUrl || '',
        });
        if (res.status >= 400) {
            logger.warn(`AI provider sync failed for ${config.provider}: ${JSON.stringify(res.data)}`);
        }
    } catch (err) {
        logger.warn(`AI provider sync failed for ${config.provider}: ${err}`);
    }
}

export async function chatWithAi(params: {
    organizationId: string;
    question: string;
    documentIds?: string[];
    sessionId?: string;
    chatHistory?: Array<{ role: string; content: string }>;
    userId?: string;
    selectedText?: string;
    phase3Agent?: string;
    documentType?: string;
    allowedAgents?: string[];
    provider?: string;
    model?: string;
    providerConfig?: AiProviderConfig;
}): Promise<AiChatResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const body: Record<string, unknown> = {
        organization_id: params.organizationId,
        question: params.question,
    };
    if (params.documentIds?.length) body.document_ids = params.documentIds;
    if (params.sessionId) body.session_id = params.sessionId;
    if (params.chatHistory?.length) body.chat_history = params.chatHistory;
    if (params.userId) body.user_id = params.userId;
    if (params.selectedText) body.selected_text = params.selectedText;
    if (params.phase3Agent) body.phase3_agent = params.phase3Agent;
    if (params.documentType) body.document_type = params.documentType;
    if (params.allowedAgents?.length) body.allowed_agents = params.allowedAgents;
    if (params.provider) body.provider = params.provider;
    if (params.model) body.model = params.model;
    if (params.providerConfig) {
        body.provider_config = {
            provider: params.providerConfig.provider,
            apiKey: params.providerConfig.apiKey,
            model: params.providerConfig.model || params.model || '',
            baseUrl: params.providerConfig.baseUrl || '',
        };
    }

    // Prefer /chat when docs selected; /chat/all for org-wide or agent-folder scope
    const path =
        params.documentIds?.length || params.phase3Agent || params.documentType
            ? '/api/v1/chat'
            : '/api/v1/chat/all';
    const res = await client().post(path, body);

    throwIfAiFailed(res, 'AI chat failed');

    return res.data as AiChatResult;
}

export type AiSearchResult = {
    results: Array<{
        document_id: string;
        document_title: string;
        document_type?: string;
        chunk_text: string;
        page_number?: number;
        score: number;
        metadata?: Record<string, unknown>;
    }>;
    total: number;
    query: string;
};

export async function searchWithAi(params: {
    organizationId: string;
    query: string;
    documentType?: string;
    phase3Agent?: string;
    status?: string;
    limit?: number;
    offset?: number;
}): Promise<AiSearchResult> {
    if (!ENABLED) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post('/api/v1/search', {
        query: params.query,
        organization_id: params.organizationId,
        document_type: params.documentType || undefined,
        phase3_agent: params.phase3Agent || undefined,
        status: params.status || undefined,
        limit: params.limit ?? 20,
        offset: params.offset ?? 0,
    });

    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI search failed (${res.status}): ${detail}`);
    }

    return res.data as AiSearchResult;
}

export type AiJobStatus = {
    document_id?: string;
    status?: string;
    stage?: string;
    progress?: number;
    error?: string;
    [key: string]: unknown;
};

export async function getDocumentJobStatus(
    pythonDocumentId: string,
    organizationId?: string
): Promise<AiJobStatus | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    try {
        const params = organizationId ? { organization_id: organizationId } : {};
        const res = await client().get(`/api/v1/documents/${pythonDocumentId}/job`, { params });
        if (res.status >= 400) return null;
        return res.data as AiJobStatus;
    } catch (e: any) {
        logger.warn(`AI job status fetch failed: ${e.message}`);
        return null;
    }
}

export type AiDocumentDetails = Record<string, unknown>;

export async function getAiDocument(
    pythonDocumentId: string,
    organizationId: string
): Promise<AiDocumentDetails | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().get(`/api/v1/documents/${pythonDocumentId}`, {
        params: organizationId ? { organization_id: organizationId } : {},
    });
    if (res.status >= 400 && organizationId) {
        const fallback = await client().get(`/api/v1/documents/${pythonDocumentId}`);
        if (fallback.status < 400) return fallback.data as AiDocumentDetails;
        return null;
    }
    if (res.status >= 400) return null;
    return res.data as AiDocumentDetails;
}

export async function updateAiDocumentSettings(params: {
    pythonDocumentId: string;
    organizationId: string;
    documentType: string;
    phase3Agent: string;
}): Promise<Record<string, unknown> | null> {
    if (!ENABLED || !params.pythonDocumentId) return null;

    const res = await client().patch(`/api/v1/documents/${params.pythonDocumentId}`, {
        document_type: params.documentType,
        phase3_agent: params.phase3Agent,
        organization_id: params.organizationId,
    });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI document update failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

/** Keep AI original_file_url in sync after gateway relocates the file on disk. */
export async function updateAiDocumentFilePath(params: {
    pythonDocumentId: string;
    organizationId: string;
    filePath: string;
}): Promise<void> {
    if (!ENABLED || !params.pythonDocumentId || !params.filePath) return;

    const res = await client().patch(`/api/v1/documents/${params.pythonDocumentId}`, {
        organization_id: params.organizationId,
        original_file_url: path.resolve(params.filePath),
    });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI file path update failed (${res.status}): ${detail}`);
    }
}

export type AiDocumentImages = {
    images: Array<{ page?: number; image_path?: string; description?: string }>;
    descriptions_file?: string;
};

export async function getAiDocumentImages(
    pythonDocumentId: string,
    organizationId: string
): Promise<AiDocumentImages | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().get(`/api/v1/documents/${pythonDocumentId}/images`, {
        params: { organization_id: organizationId },
    });
    if (res.status >= 400) return null;
    return res.data as AiDocumentImages;
}

export type AiDocumentExtraction = {
    id?: number;
    organization_id?: string;
    document_id: string;
    extraction_type: string;
    extracted_data: Record<string, unknown>;
    confidence?: number;
    reviewed?: number;
    created_at?: string;
};

export async function getDocumentExtractions(
    pythonDocumentId: string,
    organizationId: string,
    extractionType?: string
): Promise<AiDocumentExtraction[]> {
    if (!ENABLED || !pythonDocumentId) return [];

    const params: Record<string, string> = { organization_id: organizationId };
    if (extractionType) params.extraction_type = extractionType;
    const res = await client().get(`/api/v1/documents/${pythonDocumentId}/extractions`, {
        params,
    });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data?.extractions)) return data.extractions as AiDocumentExtraction[];
    return [];
}

export type AiSimilarDocument = {
    document_id: string;
    document_title?: string;
    document_type?: string;
    chunk_text?: string;
    page_number?: number;
    score: number;
    metadata?: Record<string, unknown>;
};

export async function getSimilarDocuments(
    pythonDocumentId: string,
    organizationId: string,
    limit = 5
): Promise<AiSimilarDocument[]> {
    if (!ENABLED || !pythonDocumentId) return [];

    const res = await client().get(`/api/v1/search/similar/${pythonDocumentId}`, {
        params: { organization_id: organizationId, limit },
    });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data?.results)) return data.results as AiSimilarDocument[];
    if (Array.isArray(data)) return data as AiSimilarDocument[];
    return [];
}

export async function triggerDocumentReprocess(
    pythonDocumentId: string,
    organizationId: string
): Promise<Record<string, unknown>> {
    if (!ENABLED || !pythonDocumentId) {
        throw new Error('AI service is disabled');
    }

    const res = await client().post(
        `/api/v1/documents/${pythonDocumentId}/reprocess`,
        {},
        { params: { organization_id: organizationId }, timeout: 30000 }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI reprocess failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

export async function runDocumentProcess(
    pythonDocumentId: string,
    organizationId: string,
    force = false
): Promise<Record<string, unknown> | null> {
    if (!ENABLED || !pythonDocumentId) return null;

    const res = await client().post(
        `/api/v1/documents/${pythonDocumentId}/process`,
        { organization_id: organizationId, force },
        { params: { organization_id: organizationId, force: force ? 'true' : 'false' } }
    );
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(`AI process failed (${res.status}): ${detail}`);
    }
    return res.data as Record<string, unknown>;
}

export async function streamAiAsset(path: string): Promise<{ data: NodeJS.ReadableStream; contentType: string } | null> {
    if (!ENABLED || !path) return null;

    const res = await client().get(`/api/v1/documents/image/${path}`, {
        responseType: 'stream',
    });
    if (res.status >= 400) return null;
    const contentType = String(res.headers['content-type'] || 'application/octet-stream');
    return { data: res.data, contentType };
}

export async function listAiValidations(
    organizationId: string,
    documentId?: string
): Promise<unknown[]> {
    if (!ENABLED) return [];

    const params: Record<string, string | number> = { organization_id: organizationId, limit: 50 };
    if (documentId) params.document_id = documentId;

    const res = await client().get('/api/v1/documents/validations/list', { params });
    if (res.status >= 400) return [];
    const data = res.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.validations)) return data.validations;
    if (Array.isArray(data?.validation_results)) return data.validation_results;
    if (Array.isArray(data?.results)) return data.results;
    return [];
}

export type ChatSessionSummary = {
    id: string;
    organization_id: string;
    user_id?: string | null;
    document_ids: string[];
    title: string;
    created_at?: string;
    updated_at?: string;
};

export type ChatSessionMessage = {
    id?: number;
    session_id?: string;
    role: string;
    content: string;
    sources?: Array<Record<string, unknown>>;
    created_at?: string;
};

export type ChatSessionDetails = ChatSessionSummary & {
    messages: ChatSessionMessage[];
};

export async function listChatSessions(
    organizationId: string,
    userId?: string
): Promise<ChatSessionSummary[]> {
    if (!ENABLED) return [];

    const params: Record<string, string> = { organization_id: organizationId };
    if (userId) params.user_id = userId;

    const res = await client().get('/api/v1/chat/sessions', { params });
    if (res.status >= 400) return [];
    return (res.data?.sessions || []) as ChatSessionSummary[];
}

export async function getChatSession(sessionId: string): Promise<ChatSessionDetails | null> {
    if (!ENABLED || !sessionId) return null;

    const res = await client().get(`/api/v1/chat/sessions/${sessionId}`);
    if (res.status >= 400) return null;
    return res.data as ChatSessionDetails;
}

export async function deleteChatSession(sessionId: string): Promise<boolean> {
    if (!ENABLED || !sessionId) return false;

    const res = await client().delete(`/api/v1/chat/sessions/${sessionId}`);
    return res.status < 400;
}

export async function checkAiHealth(): Promise<boolean> {
    if (!ENABLED) return false;
    try {
        const res = await client().get('/health');
        return res.status === 200;
    } catch {
        return false;
    }
}

export type GroqLimitStatus = {
    limited: boolean;
    configured?: boolean;
    until_ts?: number | null;
    retry_after_seconds?: number;
    message?: string | null;
    model?: string | null;
    console_url?: string;
    billing_url?: string;
    key_hint?: string | null;
};

export async function getGroqStatus(): Promise<GroqLimitStatus> {
    if (!ENABLED) {
        return { limited: false, configured: false, retry_after_seconds: 0 };
    }
    const res = await client().get('/api/v1/groq/status');
    if (res.status >= 400) {
        return { limited: false, configured: false, retry_after_seconds: 0 };
    }
    return res.data as GroqLimitStatus;
}

export async function setGroqApiKey(apiKey: string): Promise<Record<string, unknown>> {
    if (!ENABLED) throw new Error('AI service is disabled');
    const res = await client().post('/api/v1/groq/api-key', { api_key: apiKey });
    if (res.status >= 400) {
        const detail = res.data?.detail || res.data?.message || JSON.stringify(res.data);
        throw new Error(typeof detail === 'string' ? detail : 'Failed to set Groq API key');
    }
    return res.data as Record<string, unknown>;
}

export type GroqLimitErrorInfo = {
    code: 'GROQ_RATE_LIMIT';
    message: string;
    retry_after_seconds?: number;
    until_ts?: number;
    console_url?: string;
    billing_url?: string;
};

export function extractGroqLimitError(error: unknown): GroqLimitErrorInfo | null {
    let data: any = null;
    if (error instanceof AiHttpError) {
        data = error.data;
    } else if (error instanceof AxiosError) {
        data = error.response?.data;
    } else if (typeof error === 'object' && error && (error as any).data) {
        data = (error as any).data;
    }

    const msgFallback = error instanceof Error ? error.message : String(error || '');

    if (!data) {
        if (/rate.?limit|429|tokens per day|tpd|GROQ_RATE_LIMIT/i.test(msgFallback)) {
            return {
                code: 'GROQ_RATE_LIMIT',
                message: msgFallback,
                console_url: 'https://console.groq.com/keys',
                billing_url: 'https://console.groq.com/settings/billing',
                retry_after_seconds: 24 * 3600,
            };
        }
        return null;
    }
    const code = data.code || data?.error?.code;
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || '');
    const message = data.message || detail || msgFallback;
    if (
        code === 'GROQ_RATE_LIMIT' ||
        code === 'rate_limit_exceeded' ||
        /rate.?limit|tokens per day|tpd|GROQ_RATE_LIMIT/i.test(String(message)) ||
        /rate.?limit|tokens per day|GROQ_RATE_LIMIT/i.test(detail) ||
        /rate.?limit|tokens per day|GROQ_RATE_LIMIT/i.test(msgFallback)
    ) {
        return {
            code: 'GROQ_RATE_LIMIT',
            message: String(message || detail || 'Groq rate limit reached'),
            retry_after_seconds: Number(data.retry_after_seconds) || 24 * 3600,
            until_ts: data.until_ts ? Number(data.until_ts) : undefined,
            console_url: data.console_url || 'https://console.groq.com/keys',
            billing_url: data.billing_url || 'https://console.groq.com/settings/billing',
        };
    }
    return null;
}

export function formatAiError(error: unknown): string {
    if (error instanceof AxiosError) {
        const d = error.response?.data;
        if (d?.message) return d.message;
        if (typeof d?.detail === 'string') return d.detail;
        return error.message;
    }
    if (error instanceof Error) return error.message;
    return 'AI service error';
}
