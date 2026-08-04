import { Request, Response, NextFunction } from 'express';
import Document from '../models/Document';
import ApiKey, { AIProvider } from '../models/ApiKey';
import Organization from '../models/Organization';
import { buildDocumentFilter, hasPermission } from '../services/accessScope';
import {
    chatWithAi,
    deleteChatSession,
    ensureDocumentsInAi,
    extractGroqLimitError,
    formatAiError,
    getChatSession,
    isAiServiceEnabled,
    listChatSessions,
    renameChatSession,
    resolveAiOrganizationId,
    syncProviderToAIBackend,
    type AiProviderConfig,
} from '../services/aiServiceClient';
import { PERMISSIONS } from '../types/permissions';
import logger from '../utils/logger';
import { recordActivityFromReq } from '../services/activityLog';

async function resolveChatProviderConfig(
    organizationId: string,
    provider?: string,
    model?: string,
): Promise<AiProviderConfig | null> {
    const filter: { isActive: boolean; organizationId?: string; provider?: AIProvider } = {
        isActive: true,
    };
    if (organizationId) filter.organizationId = organizationId;

    if (provider) {
        filter.provider = provider as AIProvider;
        const key = await ApiKey.findOne(filter).lean();
        if (key?.apiKey) {
            return {
                provider: key.provider,
                apiKey: key.apiKey,
                model: model || key.aiModel || '',
                baseUrl: key.baseUrl || null,
            };
        }
    } else {
        const keys = await ApiKey.find(filter).sort({ createdAt: 1 }).lean();
        const primary = keys.find((k) => k.provider === 'groq') || keys[0];
        if (primary?.apiKey) {
            return {
                provider: primary.provider,
                apiKey: primary.apiKey,
                model: model || primary.aiModel || '',
                baseUrl: primary.baseUrl || null,
            };
        }
    }

    // Fallback 1: Check Organization.groqApiKey for this organization
    if (organizationId) {
        const org = await Organization.findOne({ organizationId }).lean();
        if (org?.groqApiKey) {
            return {
                provider: 'groq',
                apiKey: org.groqApiKey,
                model: model || 'llama-3.3-70b-versatile',
                baseUrl: 'https://api.groq.com/openai/v1',
            };
        }
    }

    // Fallback 2: Check global active key in ApiKey collection
    const globalKey = await ApiKey.findOne({
        isActive: true,
        ...(provider ? { provider: provider as AIProvider } : {}),
    }).sort({ createdAt: 1 }).lean();

    if (globalKey?.apiKey) {
        return {
            provider: globalKey.provider,
            apiKey: globalKey.apiKey,
            model: model || globalKey.aiModel || '',
            baseUrl: globalKey.baseUrl || null,
        };
    }

    return null;
}

export const chatWithDocuments = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        const message = (req.body.message || req.body.query || req.body.question || '').toString().trim();
        const documentIds: string[] = Array.isArray(req.body.documentIds) ? req.body.documentIds : [];
        const chatScope = (req.body.chatScope || 'all').toString() as 'all' | 'selected';
        const sessionId = req.body.sessionId as string | undefined;

        if (!message) {
            return res.status(400).json({ success: false, message: 'message is required' });
        }

        const isChitchat = (() => {
            const q = message.toLowerCase();
            if (!q || q.length > 80) return false;
            const docHints = [
                'resume', 'cv', 'invoice', 'document', 'file', 'score', 'candidate',
                'pdf', 'contract', 'find', 'show', 'list', 'who', 'what is', 'kitne',
                'kitna', 'batao', 'tell me', 'search', 'summar', 'extract',
            ];
            if (docHints.some((h) => q.includes(h))) return false;
            return /^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam|aoa|slm|good\s*(morning|afternoon|evening|night)|gm|gn|how are you|how's it going|how r u|whats? up|sup|thanks?|thank you|thx|ty|shukriya|ok|okay|k|cool|great|nice|bye|goodbye|yes|no|yep|yup|nope|yeah|help|who are you|what can you do)\b/i.test(
                q
            );
        })();

        if (chatScope === 'selected' && !documentIds.length && !isChitchat) {
            return res.status(400).json({
                success: false,
                message: 'Select at least one document for selected chat scope',
            });
        }

        // Chitchat: skip Mongo document scan — greetings do not need library context.
        let docs: any[] = [];
        if (!isChitchat) {
            const filter = await buildDocumentFilter(req.user, {});
            docs = await Document.find(filter).sort({ createdAt: -1 }).limit(100).lean();
        }

        if (!docs.length && !isChitchat) {
            return res.json({
                success: true,
                data: {
                    reply: "I don't see any documents in your library yet. Upload a PDF or image on the Documents page, then ask again.",
                    citations: [],
                    model: 'docs-ai',
                },
            });
        }

        if (!isAiServiceEnabled()) {
            if (isChitchat) {
                return res.json({
                    success: true,
                    data: {
                        reply: 'Hello! AI service is offline right now — start it on port 8000, then ask about your documents.',
                        citations: [],
                        model: 'docs-ai-offline',
                    },
                });
            }
            return res.json({
                success: true,
                data: {
                    reply: `AI service is offline. You have **${docs.length}** document(s) in your library. Start the Python AI service on port 8000 and try again.`,
                    citations: docs.slice(0, 3).map((d) => ({
                        documentId: d.documentId,
                        filename: d.originalFilename,
                        status: d.status,
                    })),
                    model: 'docs-ai-offline',
                },
            });
        }

        const pythonIdToDoc = new Map(
            docs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d])
        );
        const pythonDocumentIds = [...pythonIdToDoc.keys()];

        if (!pythonDocumentIds.length && !isChitchat) {
            return res.json({
                success: true,
                data: {
                    reply: `Your documents are saved but not yet processed by the AI service. Re-upload after starting the AI backend, or wait for processing to complete.`,
                    citations: docs.slice(0, 5).map((d) => ({
                        documentId: d.documentId,
                        filename: d.originalFilename,
                        status: d.status,
                        pythonDocumentId: d.pythonDocumentId,
                    })),
                    model: 'docs-ai-pending',
                },
            });
        }

        try {
            const orgId = resolveAiOrganizationId(req.user);
            let scopedPythonIds: string[] | undefined;

            if (isChitchat) {
                // Greetings skip document scope — AI replies without RAG
                scopedPythonIds = undefined;
            } else if (chatScope === 'selected') {
                const selectedMongo = await Document.find({
                    ...(await buildDocumentFilter(req.user, {})),
                    documentId: { $in: documentIds },
                })
                    .select('documentId pythonDocumentId originalFilename mimeType storagePath')
                    .lean();
                const healed = await ensureDocumentsInAi(selectedMongo as any[], orgId, req.user.userId);
                scopedPythonIds = selectedMongo
                    .map((d) => healed.get(d.documentId) || d.pythonDocumentId)
                    .filter(Boolean) as string[];
                if (!scopedPythonIds.length) {
                    return res.status(400).json({
                        success: false,
                        message:
                            'Selected documents are not available in the AI index yet. Open Documents → Reprocess (or re-upload) so chat can read their content.',
                    });
                }
            } else {
                // All-documents mode: heal library so AI search can see uploaded files
                const library = await Document.find(await buildDocumentFilter(req.user, {}))
                    .select('documentId pythonDocumentId originalFilename mimeType storagePath')
                    .sort({ createdAt: -1 })
                    .limit(40)
                    .lean();
                await ensureDocumentsInAi(library as any[], orgId, req.user.userId);
                scopedPythonIds = undefined;
            }

            const phase3AgentRaw = (req.body.phase3_agent || req.body.phase3Agent || '').toString().trim() || undefined;
            const documentType = (req.body.document_type || req.body.documentType || '').toString().trim() || undefined;
            const provider = (req.body.provider || req.body.modelProvider || '').toString().trim() || undefined;
            const model = (req.body.model || req.body.aiModel || '').toString().trim() || undefined;

            const providerConfig = await resolveChatProviderConfig(orgId, provider, model);
            if (!providerConfig) {
                return res.status(400).json({
                    success: false,
                    message: provider
                        ? `Selected AI provider "${provider}" is not configured. Add an API key in AI Settings.`
                        : 'No active AI provider configured. Please go to AI Settings and enter your API key.',
                });
            }
            // Chitchat already sends providerConfig in the chat payload — skip extra sync round-trip.
            if (!isChitchat) {
                await syncProviderToAIBackend(providerConfig);
            }

            let phase3Agent = phase3AgentRaw;
            let allowedAgents: string[] | undefined;
            if (!isChitchat && req.user.role !== 'superAdmin') {
                const { requireAllowedAgent } = await import('../services/planService');
                const check = await requireAllowedAgent(req.user, phase3AgentRaw);
                if (!check.ok) {
                    return res.status(403).json({
                        success: false,
                        code: check.code,
                        message: check.message,
                        data: { allowedAgents: check.entitlement.agentIds },
                    });
                }
                allowedAgents = check.entitlement.agentIds;
                // If chat inferred an agent outside plan via docs, still clamp explicit request only;
                // AI receives allowed_agents for all routing.
            }

            const result = await chatWithAi({
                organizationId: orgId,
                question: message,
                documentIds: scopedPythonIds,
                sessionId,
                chatHistory: Array.isArray(req.body.chatHistory) ? req.body.chatHistory : undefined,
                userId: req.user.userId,
                selectedText: (req.body.selected_text || req.body.selectedText || '').toString().trim() || undefined,
                phase3Agent,
                documentType,
                allowedAgents,
                provider: providerConfig?.provider || provider,
                model: providerConfig?.model || model,
                providerConfig: providerConfig || undefined,
            });

            const seenCite = new Set<string>();
            const citations = (result.sources || [])
                .map((source: any) => {
                    const nodeDoc = pythonIdToDoc.get(source.document_id || source.documentId);
                    return {
                        documentId: nodeDoc?.documentId || source.document_id,
                        filename: nodeDoc?.originalFilename || source.document_title || source.title,
                        pageNumber: source.page_number,
                        score: source.score,
                    };
                })
                .filter((c) => {
                    const key = String(c.documentId || c.filename || '');
                    if (!key || seenCite.has(key)) return false;
                    seenCite.add(key);
                    return true;
                })
                .slice(0, 3);

            res.json({
                success: true,
                data: {
                    reply: result.answer,
                    citations,
                    sessionId: result.session_id,
                    chatScope,
                    model: 'visibility-ai-rag',
                    aiProvider: (result as any).provider || providerConfig?.provider || provider,
                    aiModel: (result as any).model || providerConfig?.model || model,
                    agentId: phase3Agent || undefined,
                },
            });
            recordActivityFromReq(req, {
                action: 'chat.message',
                category: 'chat',
                resourceType: 'chat_session',
                resourceId: result.session_id || sessionId || undefined,
                message: `Sent chat message (${chatScope})`,
                metadata: {
                    chatScope,
                    preview: message.slice(0, 120),
                    citationCount: citations.length,
                },
            });
        } catch (aiError: any) {
            logger.error(`AI chat proxy failed: ${formatAiError(aiError)}`);
            const groq = extractGroqLimitError(aiError);
            if (groq) {
                return res.status(429).json({
                    success: false,
                    code: groq.code,
                    message: groq.message,
                    retry_after_seconds: groq.retry_after_seconds,
                    until_ts: groq.until_ts,
                    console_url: groq.console_url,
                    billing_url: groq.billing_url,
                });
            }
            return res.status(502).json({
                success: false,
                message:
                    aiError?.code === 'ECONNABORTED' || String(aiError?.message || '').includes('timeout')
                        ? 'Chat took too long. Narrow document scope or increase AI_CHAT_TIMEOUT_MS on the gateway.'
                        : 'AI backend (Python) is not reachable. Start it with: cd ai-backend && python run.py (see AI_SERVICE_URL in api-gateway/.env).',
                error: formatAiError(aiError),
            });
        }
    } catch (error) {
        next(error);
    }
};

export const listChatModelsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const organizationId = req.user.organizationId || null;
        if (!organizationId && req.user.role !== 'superAdmin') {
            return res.json({ success: true, data: { models: [], primary: null } });
        }

        const keys = await ApiKey.find({
            organizationId: organizationId || undefined,
            isActive: true,
        })
            .sort({ createdAt: 1 })
            .lean();

        const models = keys.map((k) => ({
            provider: k.provider,
            label: k.label || k.provider,
            model: k.aiModel || '',
            baseUrl: k.baseUrl || null,
        }));
        const primary = models[0] || null;

        res.json({
            success: true,
            data: { models, primary },
        });
    } catch (error) {
        next(error);
    }
};

export const listChatSessionsHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.json({ success: true, data: { sessions: [], total: 0 } });
        }
        const orgId = resolveAiOrganizationId(req.user);
        const sessions = await listChatSessions(orgId, req.user.userId);
        res.json({ success: true, data: { sessions, total: sessions.length } });
    } catch (error) {
        next(error);
    }
};

export const getChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const session = await getChatSession(sessionId);
        if (!session) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (session.organization_id && session.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (session.user_id && session.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        res.json({ success: true, data: { session } });
    } catch (error) {
        next(error);
    }
};

export const deleteChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const existing = await getChatSession(sessionId);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (existing.organization_id && existing.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (existing.user_id && existing.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const ok = await deleteChatSession(sessionId);
        if (!ok) {
            return res.status(502).json({ success: false, message: 'Failed to delete session' });
        }
        recordActivityFromReq(req, {
            action: 'chat.session.delete',
            category: 'chat',
            resourceType: 'chat_session',
            resourceId: sessionId,
            message: 'Deleted a chat session',
        });
        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
        next(error);
    }
};

export const renameChatSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!hasPermission(req.user, PERMISSIONS.CHAT_USE)) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (!isAiServiceEnabled()) {
            return res.status(503).json({ success: false, message: 'AI service offline' });
        }
        const sessionId = String(req.params.id);
        const title = String(req.body?.title || '').trim();
        if (!title) {
            return res.status(400).json({ success: false, message: 'Title is required' });
        }
        const existing = await getChatSession(sessionId);
        if (!existing) {
            return res.status(404).json({ success: false, message: 'Session not found' });
        }
        const orgId = resolveAiOrganizationId(req.user);
        if (existing.organization_id && existing.organization_id !== orgId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        if (existing.user_id && existing.user_id !== req.user.userId) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }
        const session = await renameChatSession(sessionId, title);
        if (!session) {
            return res.status(502).json({ success: false, message: 'Failed to rename session' });
        }
        recordActivityFromReq(req, {
            action: 'chat.session.rename',
            category: 'chat',
            resourceType: 'chat_session',
            resourceId: sessionId,
            message: `Renamed chat to "${title.slice(0, 80)}"`,
            metadata: { title },
        });
        res.json({ success: true, message: 'Session renamed', data: { session } });
    } catch (error) {
        next(error);
    }
};

function generateFeedbackId(): string {
    return `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export const submitFeedback = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { sessionId, messageIndex, type } = req.body || {};
        if (!sessionId || messageIndex == null || !type) {
            return res.status(400).json({
                success: false,
                message: 'sessionId, messageIndex, and type are required',
            });
        }
        if (!['like', 'dislike'].includes(String(type))) {
            return res.status(400).json({ success: false, message: 'type must be "like" or "dislike"' });
        }

        const idx = Number(messageIndex);
        if (Number.isNaN(idx) || idx < 0) {
            return res.status(400).json({ success: false, message: 'messageIndex must be a non-negative integer' });
        }

        const { default: MessageFeedback } = await import('../models/MessageFeedback');
        const existing = await MessageFeedback.findOne({
            sessionId,
            messageIndex: idx,
            userId: req.user.userId,
        });

        if (existing) {
            existing.type = String(type) as 'like' | 'dislike';
            await existing.save();
            return res.json({ success: true, data: { feedback: existing, updated: true } });
        }

        const fb = await MessageFeedback.create({
            feedbackId: generateFeedbackId(),
            sessionId,
            messageIndex: idx,
            userId: req.user.userId,
            organizationId: req.user.organizationId || 'personal',
            type: String(type) as 'like' | 'dislike',
        });

        res.status(201).json({ success: true, data: { feedback: fb } });
    } catch (error) {
        next(error);
    }
};
