"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    Sparkles, ChevronLeft, ChevronRight, FileText,
    Plus, Trash2, MessageSquare, MessageCircle,
} from "lucide-react";
import ChatComposer from "@/components/ChatComposer";
import ChatScopePanel, {
    type ChatScope,
    type DocStatusFilter,
    type ScopeLibraryDoc,
} from "@/components/ChatScopePanel";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { usePermissions } from "@/context/PermissionsContext";
import { resolveDocAgent } from "@/lib/documentAgents";

type ChatMessage = {
    id: string;
    role: "user" | "assistant";
    content: string;
    citations?: Array<{
        documentId?: string;
        filename?: string;
        pageNumber?: number;
        snippet?: string;
        score?: number;
    }>;
};

type LibraryDoc = ScopeLibraryDoc;

type ChatSessionSummary = {
    id: string;
    title: string;
    document_ids?: string[];
    updated_at?: string;
    created_at?: string;
};

const WELCOME_MSG: ChatMessage = {
    id: "welcome",
    role: "assistant",
    content:
        "Ask about your uploaded documents — summaries, expiries, invoice fields, and more. Start a **New chat**, or open a past conversation from the left.",
};

const LAST_SESSION_KEY = "docs_ai_last_chat_session";

function isChitchatMessage(text: string): boolean {
    const q = text.trim().toLowerCase();
    if (!q || q.length > 80) return false;
    const docHints = [
        "resume", "cv", "invoice", "document", "file", "score", "candidate",
        "pdf", "contract", "find", "show", "list", "who", "what is", "kitne",
        "kitna", "batao", "tell me", "search", "summar", "extract",
    ];
    if (docHints.some((h) => q.includes(h))) return false;
    return /^(hi|hii+|hello|hey|hy|helo|hola|salam|assalam|aoa|slm|good\s*(morning|afternoon|evening|night)|gm|gn|how are you|how's it going|how r u|whats? up|sup|thanks?|thank you|thx|ty|shukriya|ok|okay|k|cool|great|nice|bye|goodbye|yes|no|yep|yup|nope|yeah|help|who are you|what can you do)\b/i.test(
        q
    );
}

function dedupeCitations(
    items: Array<{ documentId?: string; filename?: string; pageNumber?: number; snippet?: string; score?: number }>
) {
    const seen = new Set<string>();
    const out: typeof items = [];
    for (const c of items) {
        const key = String(c.documentId || c.filename || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(c);
        if (out.length >= 3) break;
    }
    return out;
}

function citationMeta(c: { pageNumber?: number; score?: number }) {
    if (c.pageNumber != null && c.pageNumber !== undefined) return `p.${c.pageNumber}`;
    if (c.score != null && !Number.isNaN(Number(c.score))) return `${Math.round(Number(c.score) * 100)}%`;
    return null;
}

function mapSessionMessages(raw: any[], pythonToNode: Map<string, string>): ChatMessage[] {
    return raw.map((m, i) => ({
        id: `m_${m.id || i}`,
        role: m.role === "user" ? "user" : "assistant",
        content: m.content || "",
        citations: Array.isArray(m.sources)
            ? dedupeCitations(
                  m.sources.map((s: any) => ({
                      documentId: pythonToNode.get(s.document_id) || s.document_id,
                      filename: s.document_title || s.title,
                      pageNumber: s.page_number,
                      score: s.score,
                  }))
              )
            : undefined,
    }));
}

function ChatContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const isDark = theme.name === "dark";
    const { canChat } = usePermissions();

    const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MSG]);
    const [input, setInput] = useState("");
    const [sending, setSending] = useState(false);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [scopePanelOpen, setScopePanelOpen] = useState(false);
    const [isLg, setIsLg] = useState(false);
    const [chatScope, setChatScope] = useState<ChatScope>("all");
    const [libraryDocs, setLibraryDocs] = useState<LibraryDoc[]>([]);
    const [selectedDocIds, setSelectedDocIds] = useState<string[]>([]);
    const [sessionId, setSessionId] = useState<string | undefined>();
    const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
    const [sessionsLoading, setSessionsLoading] = useState(false);
    const [docSearch, setDocSearch] = useState("");
    const [docStatusFilter, setDocStatusFilter] = useState<DocStatusFilter>("");
    const [focusedExcerpt, setFocusedExcerpt] = useState("");
    const [selPopover, setSelPopover] = useState<{ text: string; x: number; y: number } | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const msgsContainerRef = useRef<HTMLDivElement>(null);

    const pythonToNode = new Map(
        libraryDocs.filter((d) => d.pythonDocumentId).map((d) => [d.pythonDocumentId as string, d.documentId])
    );

    const loadDocs = useCallback(() => {
        apiRequest("/docs/documents?limit=100")
            .then((data) => {
                const docs = (data?.data?.documents || []).map((d: any) => ({
                    documentId: d.documentId,
                    originalFilename: d.originalFilename,
                    status: d.status,
                    pythonDocumentId: d.pythonDocumentId,
                    classification: d.classification,
                    mimeType: d.mimeType,
                    metadata: d.metadata
                        ? {
                              phase3Agent: d.metadata.phase3Agent,
                              cvScore: d.metadata.cvScore,
                          }
                        : null,
                }));
                setLibraryDocs(docs);
            })
            .catch(() => setLibraryDocs([]));
    }, []);

    const loadSessions = useCallback(async () => {
        setSessionsLoading(true);
        try {
            const data = await apiRequest("/docs/chat/sessions");
            setSessions(data?.data?.sessions || []);
        } catch {
            setSessions([]);
        } finally {
            setSessionsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadDocs();
        loadSessions();
    }, [loadDocs, loadSessions]);

    useEffect(() => {
        const mq = window.matchMedia("(min-width: 1024px)");
        const apply = () => {
            setIsLg(mq.matches);
            setSidebarOpen(mq.matches);
        };
        apply();
        mq.addEventListener("change", apply);
        return () => mq.removeEventListener("change", apply);
    }, []);

    useEffect(() => {
        if (!sidebarOpen || isLg) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setSidebarOpen(false);
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [sidebarOpen, isLg]);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, sending]);

    const isInsideAssistant = (node: Node | null): boolean => {
        while (node) {
            if ((node as HTMLElement).dataset?.role === "assistant") return true;
            node = node.parentNode;
        }
        return false;
    };

    const handleSelection = () => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) {
            setSelPopover(null);
            return;
        }
        const text = sel.toString().trim();
        if (!text) {
            setSelPopover(null);
            return;
        }
        if (!isInsideAssistant(sel.anchorNode) || !isInsideAssistant(sel.focusNode)) {
            setSelPopover(null);
            return;
        }
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        setSelPopover({ text, x: rect.left + rect.width / 2, y: rect.top - 8 });
    };

    const startExcerptQuestion = () => {
        if (!selPopover) return;
        setFocusedExcerpt(selPopover.text);
        setSelPopover(null);
        window.getSelection()?.removeAllRanges();
    };

    useEffect(() => {
        if (!selPopover) return;
        const handler = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            if (t?.closest?.("[data-popover-btn]")) return;
            if (msgsContainerRef.current && !msgsContainerRef.current.contains(t)) {
                setSelPopover(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [selPopover]);

    const selectableDocs = libraryDocs.filter((d) => d.pythonDocumentId);

    const filteredDocs = selectableDocs.filter((doc) => {
        const q = docSearch.trim().toLowerCase();
        if (q && !doc.originalFilename.toLowerCase().includes(q)) return false;
        if (docStatusFilter === "ready" && doc.status !== "ready") return false;
        if (docStatusFilter === "processing" && doc.status !== "processing" && doc.status !== "uploaded") return false;
        if (docStatusFilter === "failed" && doc.status !== "failed") return false;
        return true;
    });

    const unprocessedCount = libraryDocs.length - selectableDocs.length;

    const toggleDoc = (id: string) => {
        setSelectedDocIds((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };

    const toggleFolder = (ids: string[]) => {
        setSelectedDocIds((prev) => {
            const set = new Set(prev);
            const allSelected = ids.every((id) => set.has(id));
            if (allSelected) {
                ids.forEach((id) => set.delete(id));
            } else {
                ids.forEach((id) => set.add(id));
            }
            return [...set];
        });
    };

    const selectAllFiltered = () => {
        setSelectedDocIds(filteredDocs.map((d) => d.documentId));
    };

    const clearSelection = () => setSelectedDocIds([]);

    const startNewChat = () => {
        setSessionId(undefined);
        setMessages([WELCOME_MSG]);
        setFocusedExcerpt("");
        localStorage.removeItem(LAST_SESSION_KEY);
    };

    const loadSession = async (id: string) => {
        try {
            const data = await apiRequest(`/docs/chat/sessions/${id}`);
            const session = data?.data?.session;
            if (!session) return;

            setSessionId(session.id);
            localStorage.setItem(LAST_SESSION_KEY, session.id);
            if (!isLg) setSidebarOpen(false);

            const pythonIds: string[] = session.document_ids || [];
            if (pythonIds.length) {
                setChatScope("selected");
                const nodeIds = pythonIds
                    .map((pid) => pythonToNode.get(pid))
                    .filter(Boolean) as string[];
                setSelectedDocIds(nodeIds);
            } else {
                setChatScope("all");
                setSelectedDocIds([]);
            }

            const msgs = mapSessionMessages(session.messages || [], pythonToNode);
            setMessages(msgs.length ? msgs : [WELCOME_MSG]);
            setFocusedExcerpt("");
        } catch (e: any) {
            setMessages([
                {
                    id: `e_${Date.now()}`,
                    role: "assistant",
                    content: `Could not load chat: ${e.message || "unknown error"}`,
                },
            ]);
        }
    };

    const deleteSession = async (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (!confirm("Delete this chat permanently?")) return;
        try {
            await apiRequest(`/docs/chat/sessions/${id}`, { method: "DELETE" });
            if (sessionId === id) startNewChat();
            await loadSessions();
        } catch {
            /* ignore */
        }
    };

    useEffect(() => {
        const last = localStorage.getItem(LAST_SESSION_KEY);
        if (last && libraryDocs.length) {
            loadSession(last);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [libraryDocs.length > 0]);

    const send = async () => {
        const text = input.trim();
        if (!text || sending) return;
        if (chatScope === "selected" && !selectedDocIds.length && !isChitchatMessage(text)) {
            setMessages((m) => [
                ...m,
                {
                    id: `e_${Date.now()}`,
                    role: "assistant",
                    content: "Select at least one processed document in Document scope before chatting.",
                },
            ]);
            setScopePanelOpen(true);
            return;
        }

        const userMsg: ChatMessage = {
            id: `u_${Date.now()}`,
            role: "user",
            content: focusedExcerpt ? `Regarding: “${focusedExcerpt.slice(0, 120)}${focusedExcerpt.length > 120 ? "…" : ""}”\n\n${text}` : text,
        };
        setMessages((m) => [...m, userMsg]);
        setInput("");
        setSending(true);

        try {
            const body: Record<string, unknown> = {
                message: text,
                chatScope,
                sessionId,
            };
            if (chatScope === "selected") {
                body.documentIds = selectedDocIds;
                const selected = libraryDocs.filter((d) => selectedDocIds.includes(d.documentId));
                const agents = new Set(selected.map((d) => resolveDocAgent(d)));
                if (agents.size === 1) {
                    const only = [...agents][0];
                    if (only && only !== "other_agent") body.phase3Agent = only;
                }
                const types = new Set(
                    selected.map((d) => d.classification).filter((t): t is string => Boolean(t))
                );
                if (types.size === 1) body.documentType = [...types][0];
            }
            if (focusedExcerpt) body.selected_text = focusedExcerpt;

            const data = await apiRequest("/docs/chat", {
                method: "POST",
                body: JSON.stringify(body),
            });
            setFocusedExcerpt("");
            if (data?.data?.sessionId) {
                setSessionId(data.data.sessionId);
                localStorage.setItem(LAST_SESSION_KEY, data.data.sessionId);
                loadSessions();
            }
            setMessages((m) => [
                ...m,
                {
                    id: `a_${Date.now()}`,
                    role: "assistant",
                    content: data?.data?.reply || "No response.",
                    citations: dedupeCitations(data?.data?.citations || []),
                },
            ]);
        } catch (e: any) {
            setMessages((m) => [
                ...m,
                {
                    id: `e_${Date.now()}`,
                    role: "assistant",
                    content: `Error: ${e.message || "Chat failed"}`,
                },
            ]);
        } finally {
            setSending(false);
        }
    };

    const scopeLabel =
        chatScope === "all"
            ? `All documents (${libraryDocs.length})`
            : `Selected (${selectedDocIds.length} of ${selectableDocs.length})`;

    const isWelcomeOnly = messages.length === 1 && messages[0].id === "welcome";

    if (!canChat()) {
        return (
            <div className="h-full flex items-center justify-center p-8">
                <div className={`surface-card max-w-md p-6 text-center space-y-2 ${colors.textPrimary}`}>
                    <p className="text-lg font-semibold">Chat not available</p>
                    <p className={`text-sm ${colors.textMuted}`}>
                        You do not have Chat permission. Ask your admin to enable it for your account.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full min-h-0 flex relative">
            <button
                type="button"
                className={`lg:hidden fixed inset-0 z-30 bg-black/50 backdrop-blur-sm transition-opacity ${
                    sidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
                }`}
                aria-label="Close chats"
                onClick={() => setSidebarOpen(false)}
                tabIndex={sidebarOpen && !isLg ? 0 : -1}
            />

            <aside
                className={`w-[min(280px,85vw)] border-r border-[var(--border)] flex flex-col z-40
                    fixed inset-y-0 left-0 transition-transform duration-200 ease-out
                    lg:static lg:z-auto lg:shrink-0 lg:translate-x-0 lg:w-[280px]
                    ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:hidden"}
                    ${
                        isDark
                            ? "bg-gradient-to-b from-[var(--surface)] to-[rgba(12,20,30,0.95)]"
                            : "bg-gradient-to-b from-white to-slate-50"
                    }`}
            >
                <div className="px-4 py-4 border-b border-[var(--border)]">
                    <div className="flex items-center justify-between gap-2">
                        <h2 className={`text-sm font-semibold tracking-tight ${colors.textPrimary}`}>Chats</h2>
                        <button
                            type="button"
                            onClick={() => {
                                startNewChat();
                                if (!isLg) setSidebarOpen(false);
                            }}
                            className="btn-gradient rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1 min-h-9"
                        >
                            <Plus size={12} /> New
                        </button>
                    </div>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto py-2">
                    {sessionsLoading ? (
                        <p className={`px-4 py-3 text-xs ${colors.textMuted}`}>Loading chats…</p>
                    ) : sessions.length === 0 ? (
                        <div className="px-4 py-8 text-center">
                            <MessageSquare size={22} className="mx-auto mb-2 text-[var(--accent)] opacity-60" />
                            <p className={`text-xs ${colors.textMuted}`}>No past chats yet.</p>
                            <p className={`text-[11px] mt-1 ${colors.textMuted}`}>Start typing to create one.</p>
                        </div>
                    ) : (
                        sessions.map((s) => {
                            const active = sessionId === s.id;
                            return (
                                <div
                                    key={s.id}
                                    className={`mx-2 mb-1 flex items-start gap-1 rounded-xl px-2 py-2 transition-colors ${
                                        active
                                            ? "bg-[var(--accent-muted)] border border-[rgba(45,212,191,0.25)]"
                                            : isDark
                                              ? "border border-transparent hover:bg-white/[0.04]"
                                              : "border border-transparent hover:bg-slate-100/80"
                                    }`}
                                >
                                    <button
                                        type="button"
                                        onClick={() => loadSession(s.id)}
                                        className="flex-1 flex items-start gap-2 min-w-0 text-left px-1 py-0.5"
                                    >
                                        <MessageSquare
                                            size={14}
                                            className={`shrink-0 mt-0.5 ${active ? "text-[var(--accent)]" : "text-[var(--foreground-muted)]"}`}
                                        />
                                        <div className="flex-1 min-w-0">
                                            <p className={`${colors.textPrimary} line-clamp-2 text-xs font-medium leading-snug`}>
                                                {s.title || "New Chat"}
                                            </p>
                                            <p className={`${colors.textMuted} mt-0.5 text-[10px]`}>
                                                {s.updated_at || s.created_at
                                                    ? new Date(s.updated_at || s.created_at!).toLocaleString()
                                                    : ""}
                                            </p>
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(e) => deleteSession(s.id, e)}
                                        className="btn-ghost p-1.5 text-rose-400/80 hover:text-rose-300 shrink-0 rounded-lg"
                                        aria-label="Delete chat"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>
            </aside>

            <div className="flex-1 min-w-0 flex flex-col bg-gradient-to-br from-transparent via-teal-500/[0.02] to-cyan-500/[0.04]">
                <div className="px-3 sm:px-6 lg:px-8 py-3 sm:py-4 border-b border-[var(--border)] shrink-0 flex flex-wrap items-center gap-2 sm:gap-3">
                    <button
                        type="button"
                        onClick={() => setSidebarOpen((o) => !o)}
                        className="btn-ghost rounded-lg p-2.5 min-h-11 min-w-11 flex items-center justify-center"
                        aria-label={sidebarOpen ? "Hide chats" : "Show chats"}
                    >
                        {sidebarOpen && isLg ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
                    </button>
                    <div
                        className={`h-9 w-9 sm:h-10 sm:w-10 rounded-xl flex items-center justify-center shrink-0 ${
                            isDark ? "bg-teal-500/15 text-teal-300" : "bg-teal-100 text-teal-700"
                        }`}
                    >
                        <Sparkles size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h1 className={`text-base sm:text-xl font-bold tracking-tight ${colors.textPrimary}`}>AI Chat</h1>
                        <p className={`text-xs sm:text-sm ${colors.textMuted} truncate hidden sm:block`}>
                            Ask questions across your document library
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setScopePanelOpen(true)}
                        className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] hover:border-[rgba(45,212,191,0.4)] hover:bg-[var(--accent-muted)] px-3 py-2 text-xs sm:text-sm transition-colors min-h-10"
                    >
                        <FileText size={14} className="text-[var(--accent)] shrink-0" />
                        <span className={`${colors.textPrimary} font-medium truncate max-w-[100px] sm:max-w-[220px]`}>
                            {scopeLabel}
                        </span>
                    </button>
                    <button
                        type="button"
                        onClick={startNewChat}
                        className="hidden sm:inline-flex btn-secondary rounded-xl px-3 py-2 text-xs sm:text-sm items-center gap-1.5 shrink-0"
                    >
                        <Plus size={14} /> New chat
                    </button>
                </div>

                <div
                    className="flex-1 min-h-0 overflow-y-auto"
                    ref={msgsContainerRef}
                    onMouseUp={handleSelection}
                >
                    <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 space-y-4 min-h-full flex flex-col">
                        {isWelcomeOnly ? (
                            <div className="flex-1 flex flex-col items-center justify-center text-center px-4 py-12 animate-fade-in-up">
                                <div className="h-14 w-14 rounded-2xl bg-[var(--accent-muted)] border border-[rgba(45,212,191,0.25)] flex items-center justify-center text-[var(--accent)] mb-4">
                                    <Sparkles size={26} />
                                </div>
                                <h2 className={`text-xl font-bold tracking-tight ${colors.textPrimary}`}>
                                    Ask your documents
                                </h2>
                                <p className={`text-sm mt-2 max-w-md ${colors.textMuted} leading-relaxed`}>
                                    Summaries, fields, comparisons — scoped to all files or a selection you choose.
                                </p>
                                <button
                                    type="button"
                                    onClick={() => setScopePanelOpen(true)}
                                    className="mt-5 btn-secondary rounded-full px-4 py-2 text-sm inline-flex items-center gap-2"
                                >
                                    <FileText size={14} className="text-[var(--accent)]" />
                                    {scopeLabel}
                                </button>
                            </div>
                        ) : (
                            messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                                >
                                    <div
                                        data-role={msg.role === "assistant" ? "assistant" : undefined}
                                        className={`max-w-[90%] sm:max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                                            msg.role === "user"
                                                ? "btn-gradient shadow-lg"
                                                : `bg-[var(--surface)] border border-[var(--border)] shadow-sm ${colors.textPrimary}`
                                        }`}
                                    >
                                        {msg.role === "assistant" ? (
                                            <div className={`prose prose-sm max-w-none ${isDark ? "prose-invert" : "prose-slate"}`}>
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                                                {msg.citations && msg.citations.length > 0 && (
                                                    <div className={`mt-3 pt-3 border-t ${colors.borderPrimary} not-prose`}>
                                                        <p className={`text-[10px] font-semibold uppercase tracking-wider mb-2 ${colors.textMuted}`}>
                                                            Sources
                                                        </p>
                                                        <div className="flex flex-wrap gap-1.5">
                                                            {msg.citations.map((c, i) => {
                                                                const label = c.filename || c.documentId || "Source";
                                                                const meta = citationMeta(c);
                                                                const href = c.documentId
                                                                    ? `/documents/details?doc=${c.documentId}`
                                                                    : null;
                                                                const chipClass = `inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-1 border transition-colors ${
                                                                    isDark
                                                                        ? "bg-white/5 border-white/10 text-slate-200 hover:border-teal-400/40 hover:bg-teal-500/10"
                                                                        : "bg-slate-100 border-slate-200 text-slate-700 hover:border-teal-400 hover:bg-teal-50"
                                                                }`;

                                                                const inner = (
                                                                    <>
                                                                        <FileText size={11} className="shrink-0 opacity-70" />
                                                                        <span className="truncate max-w-[160px]">{label}</span>
                                                                        {meta && (
                                                                            <span className="text-[10px] opacity-70 shrink-0">{meta}</span>
                                                                        )}
                                                                    </>
                                                                );

                                                                if (href) {
                                                                    return (
                                                                        <Link
                                                                            key={`${c.documentId || c.filename}-${i}`}
                                                                            href={href}
                                                                            className={chipClass}
                                                                            title={`Open: ${label}`}
                                                                        >
                                                                            {inner}
                                                                        </Link>
                                                                    );
                                                                }

                                                                return (
                                                                    <span
                                                                        key={`${c.documentId || c.filename}-${i}`}
                                                                        className={chipClass}
                                                                        title={label}
                                                                    >
                                                                        {inner}
                                                                    </span>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            msg.content
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                        {sending && (
                            <div className="flex justify-start" aria-live="polite" aria-label="Assistant is thinking">
                                <div
                                    className={`inline-flex items-center gap-1.5 rounded-2xl px-4 py-3 border shadow-sm ${
                                        isDark
                                            ? "bg-[var(--surface)] border-[var(--border)]"
                                            : "bg-white border-slate-200"
                                    }`}
                                >
                                    <span className="sr-only">Processing…</span>
                                    <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:0ms]" />
                                    <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:150ms]" />
                                    <span className="h-2 w-2 rounded-full bg-[var(--accent)] animate-bounce [animation-delay:300ms]" />
                                </div>
                            </div>
                        )}
                        <div ref={bottomRef} />
                    </div>
                </div>

                {focusedExcerpt && (
                    <div className="shrink-0 px-4 sm:px-6 lg:px-8 pt-2">
                        <div className="max-w-3xl mx-auto flex items-start gap-2 p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25">
                            <MessageCircle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                                <div className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider mb-0.5">
                                    Asking about this selection
                                </div>
                                <div className={`text-xs line-clamp-2 italic ${colors.textMuted}`}>
                                    “{focusedExcerpt}”
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setFocusedExcerpt("")}
                                className="shrink-0 text-amber-400 hover:text-rose-400 transition-colors"
                                aria-label="Clear selection"
                            >
                                <Trash2 size={13} />
                            </button>
                        </div>
                    </div>
                )}

                {selPopover && (
                    <button
                        type="button"
                        data-popover-btn
                        onClick={startExcerptQuestion}
                        style={{
                            position: "fixed",
                            left: selPopover.x,
                            top: selPopover.y,
                            transform: "translate(-50%, -100%)",
                        }}
                        className="z-50 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-xs font-medium shadow-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5"
                    >
                        <MessageCircle size={13} />
                        Ask about this
                    </button>
                )}

                <div className="px-4 sm:px-6 lg:px-8 py-4 border-t border-[var(--border)] shrink-0 bg-gradient-to-t from-[var(--surface)] via-[var(--surface)]/90 to-transparent">
                    <div className="max-w-3xl mx-auto w-full space-y-2">
                        <button
                            type="button"
                            onClick={() => setScopePanelOpen(true)}
                            className={`text-[11px] ${colors.textMuted} hover:text-[var(--accent)] inline-flex items-center gap-1.5 transition-colors`}
                        >
                            <FileText size={11} />
                            Searching: {scopeLabel}
                        </button>
                        <ChatComposer
                            value={input}
                            onChange={setInput}
                            onSend={send}
                            sending={sending}
                            placeholder={
                                chatScope === "selected" && !selectedDocIds.length
                                    ? "Select documents in scope first…"
                                    : focusedExcerpt
                                      ? "Ask about the selected text…"
                                      : "Ask about your documents…"
                            }
                        />
                    </div>
                </div>
            </div>

            <ChatScopePanel
                open={scopePanelOpen}
                onClose={() => setScopePanelOpen(false)}
                chatScope={chatScope}
                onChatScopeChange={setChatScope}
                filteredDocs={filteredDocs}
                selectedDocIds={selectedDocIds}
                onToggleDoc={toggleDoc}
                onToggleFolder={toggleFolder}
                onSelectAll={selectAllFiltered}
                onClearSelection={clearSelection}
                docSearch={docSearch}
                onDocSearchChange={setDocSearch}
                docStatusFilter={docStatusFilter}
                onDocStatusFilterChange={setDocStatusFilter}
                unprocessedCount={unprocessedCount}
                libraryCount={libraryDocs.length}
                selectableCount={selectableDocs.length}
                textPrimary={colors.textPrimary}
                textMuted={colors.textMuted}
                textSecondary={colors.textSecondary}
                bgHover={colors.bgHover}
            />
        </div>
    );
}

export default function ChatPage() {
    return (
        <ChatContent />
    );
}
