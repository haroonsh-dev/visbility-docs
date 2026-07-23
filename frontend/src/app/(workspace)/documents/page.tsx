"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
    FileText, Upload, Trash2, RefreshCw, Eye, Search, FolderUp, Copy, X, Loader2, Info, Filter, Share2,
    CheckCircle, Clock, AlertTriangle, List, FolderTree,
} from "lucide-react";
import FilterSelect from "@/components/FilterSelect";
import ClassifyAgentPopup from "@/components/ClassifyAgentPopup";
import DocumentFolderTree from "@/components/DocumentFolderTree";
import LibraryPagination from "@/components/LibraryPagination";
import ShareModal from "@/components/ShareModal";
import { PageHeader, EmptyState } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_FILTER_OPTIONS, AGENT_OPTIONS, agentLabel, resolveDocAgent, DOC_TYPE_FILTER_OPTIONS } from "@/lib/documentAgents";
import { ACCEPT_ATTR, filterAllowedFiles, getFileTypeLabel } from "@/lib/fileValidation";
import { usePermissions } from "@/context/PermissionsContext";
import { getStoredUser } from "@/lib/authSession";

type DocItem = {
    documentId: string; originalFilename: string; mimeType: string; sizeBytes: number; status: string;
    classification?: string | null; visibilityScope?: "personal" | "department" | null;
    departmentId?: string | null; uploaderIsLeader?: boolean; uploadedBy?: string; createdAt: string;
    duplicateCount?: number; isDuplicate?: boolean; pythonDocumentId?: string | null;
    aiProcessingStatus?: string | null; aiErrorMessage?: string | null;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
};

type Pagination = { page: number; limit: number; total: number; totalPages: number };
type PendingFile = { id: string; file: File };
type QueueItemStatus = "queued" | "uploading" | "processing" | "done" | "error";
type QueueItem = { id: string; name: string; size: number; mimeType: string; status: QueueItemStatus; error?: string; documentId?: string };

const SORT_PRESETS = [
    { value: "newest", label: "Newest first", sortBy: "createdAt", sortOrder: "desc" },
    { value: "oldest", label: "Oldest first", sortBy: "createdAt", sortOrder: "asc" },
    { value: "score_high", label: "Score: high → low", sortBy: "score", sortOrder: "desc" },
    { value: "score_low", label: "Score: low → high", sortBy: "score", sortOrder: "asc" },
    { value: "name", label: "Name A–Z", sortBy: "name", sortOrder: "asc" },
] as const;

const SCORE_FILTER_OPTIONS = [
    { value: "", label: "All scores" }, { value: "high", label: "High (70+)" },
    { value: "medium", label: "Medium (40–69)" }, { value: "low", label: "Low (<40)" },
    { value: "scored", label: "Scored only" },
];

function formatBytes(n: number) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusBadge(status: string) {
    const s = status.toLowerCase();
    if (["ready", "processed", "completed", "complete", "done"].includes(s)) return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (["processing", "uploaded", "queued", "uploading"].includes(s)) return "bg-amber-50 text-amber-700 border-amber-200";
    if (s === "failed" || s.includes("fail") || s.includes("error")) return "bg-rose-50 text-rose-700 border-rose-200";
    return "bg-slate-50 text-slate-500 border-slate-200";
}

const IN_PROGRESS_AI = ["queued", "running", "processing", "ocr", "classify", "extract", "embed", "uploaded", "pending"];

function getDisplayStatus(doc: DocItem) {
    if (doc.status === "failed" || (doc.aiErrorMessage && !doc.pythonDocumentId)) return { label: "Failed", isProcessing: false, isComplete: false };
    if (doc.status === "ready") return { label: "Complete", isProcessing: false, isComplete: true };
    const ai = (doc.aiProcessingStatus || "").toLowerCase();
    if (ai.includes("fail")) return { label: "Failed", isProcessing: false, subtitle: doc.aiProcessingStatus || undefined, isComplete: false };
    if (doc.status === "processing" || doc.status === "uploaded") {
        const inProgress = !ai || IN_PROGRESS_AI.some((s) => ai.includes(s));
        if (inProgress) return { label: "Processing", isProcessing: true, subtitle: doc.aiProcessingStatus && doc.aiProcessingStatus !== "processing" ? doc.aiProcessingStatus : undefined, isComplete: false };
    }
    if (doc.status === "uploaded") return { label: "Uploaded", isProcessing: false, isComplete: false };
    return { label: doc.status, isProcessing: doc.status === "processing", isComplete: false };
}

type ClassifyQueueItem = { documentId: string; originalFilename: string; document_type?: string; classification?: string | null };

function StatMini({ icon: Icon, label, value, accent, delay = 0 }: { icon: any; label: string; value: number; accent: string; delay?: number }) {
    return (
        <motion.div
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className={`stat-card ${accent} p-4 flex-1 min-w-[140px]`}
        >
            <div className="flex items-center gap-3">
                <div className={`icon-box ${accent}`} style={{ width: '2.5rem', height: '2.5rem' }}>
                    <Icon size={16} />
                </div>
                <div>
                    <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">{label}</p>
                    <p className="text-xl font-bold text-slate-800 mt-0.5">{value}</p>
                </div>
            </div>
        </motion.div>
    );
}

function DocumentsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const router = useRouter();
    const containerRef = useRef<HTMLDivElement>(null);
    const { canUpload, canViewDocs, canDeleteDocs } = usePermissions();
    const me = getStoredUser<{ userId?: string }>();

    const [docs, setDocs] = useState<DocItem[]>([]);
    const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 10, total: 0, totalPages: 0 });
    const [loading, setLoading] = useState(true);
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
    const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
    const [q, setQ] = useState("");
    const [searchInput, setSearchInput] = useState("");
    const [sortPreset, setSortPreset] = useState<string>("newest");
    const [scoreFilter, setScoreFilter] = useState("");
    const [scopeFilter, setScopeFilter] = useState("");
    const [typeFilter, setTypeFilter] = useState("");
    const [page, setPage] = useState(1);
    const [pageLimit, setPageLimit] = useState(10);
    const [agentFilter, setAgentFilter] = useState("");
    const [preferredAgent, setPreferredAgent] = useState("");
    const [classifyQueue, setClassifyQueue] = useState<ClassifyQueueItem[]>([]);
    const [toast, setToast] = useState<string | null>(null);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [sharingDoc, setSharingDoc] = useState<{ documentId: string; filename: string } | null>(null);
    const [viewMode, setViewMode] = useState<"list" | "tree">("list");

    const activeSort = SORT_PRESETS.find((s) => s.value === sortPreset) || SORT_PRESETS[0];
    const applySearch = () => { setQ(searchInput); setPage(1); };

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try {
            const limit = viewMode === "tree" ? 200 : pageLimit;
            const params = new URLSearchParams({
                page: viewMode === "tree" ? "1" : String(page),
                limit: String(limit),
                sortBy: activeSort.sortBy,
                sortOrder: activeSort.sortOrder,
            });
            if (q) params.set("q", q);
            if (scoreFilter) params.set("scoreFilter", scoreFilter);
            if (scopeFilter) params.set("scope", scopeFilter);
            if (typeFilter) params.set("classification", typeFilter);
            const data = await apiRequest(`/docs/documents?${params}`);
            setDocs(data?.data?.documents || []);
            setPagination(data?.data?.pagination || { page: 1, limit: 10, total: 0, totalPages: 0 });
        } catch (e: any) { setError(e.message || "Failed to load documents"); }
        finally { setLoading(false); }
    }, [page, pageLimit, q, activeSort.sortBy, activeSort.sortOrder, scoreFilter, scopeFilter, typeFilter, viewMode]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); }, [toast]);

    const queueClassifyPopup = async (documentId: string) => {
        try {
            const data = await apiRequest(`/docs/documents/${documentId}/intelligence`);
            const doc = data?.data?.document; const ai = data?.data?.aiDocument;
            const docType = ai?.document_type || doc?.classification;
            if (!docType) return;
            setClassifyQueue((prev) => { if (prev.some((p) => p.documentId === documentId)) return prev; return [...prev, { documentId, originalFilename: doc?.originalFilename || "Document", document_type: String(docType), classification: doc?.classification }]; });
        } catch { /* ignore */ }
    };

    const handleAgentConfirm = async (documentId: string, documentType: string, phase3Agent: string) => {
        try {
            await apiRequest(`/docs/documents/${documentId}/ai-settings`, { method: "PATCH", body: JSON.stringify({ documentType, phase3Agent }) });
            setClassifyQueue((prev) => prev.filter((p) => p.documentId !== documentId));
            setToast(`Agent set to ${agentLabel(phase3Agent)}`);
            await load();
        } catch (e: any) { setError(e.message || "Failed to save agent"); }
    };

    const filteredDocs = agentFilter ? docs.filter((d) => resolveDocAgent(d) === agentFilter) : docs;
    const processingDocIds = docs.filter((d) => d.status === "processing" || d.status === "uploaded").map((d) => d.documentId);

    useEffect(() => {
        if (!processingDocIds.length) return;
        const interval = setInterval(async () => {
            let changed = false;
            const updates: Record<string, Partial<DocItem>> = {};
            let becameReady = false;
            await Promise.all(processingDocIds.map(async (id) => {
                try {
                    const data = await apiRequest(`/docs/documents/${id}/processing`);
                    const proc = data?.data;
                    if (!proc) return;
                    const next: Partial<DocItem> = {
                        status: proc.status,
                        aiProcessingStatus: proc.aiProcessingStatus,
                    };
                    if (proc.cvScore != null || proc.metadata?.cvScore != null) {
                        next.metadata = {
                            cvScore: Number(proc.cvScore ?? proc.metadata?.cvScore),
                        };
                    }
                    if (proc.classification) next.classification = proc.classification;
                    updates[id] = next;
                    changed = true;
                    if (proc.status === "ready" || proc.status === "failed") becameReady = true;
                } catch { /* ignore */ }
            }));
            if (!changed) return;
            if (becameReady) {
                load();
                return;
            }
            setDocs((prev) => prev.map((d) => {
                const u = updates[d.documentId];
                if (!u) return d;
                return {
                    ...d,
                    ...u,
                    metadata: u.metadata ? { ...(d.metadata || {}), ...u.metadata } : d.metadata,
                };
            }));
        }, 3000);
        return () => clearInterval(interval);
    }, [processingDocIds.join(","), load]);

    const pollUntilTerminal = async (documentId: string): Promise<"done" | "error"> => {
        for (let i = 0; i < 120; i++) {
            try { const data = await apiRequest(`/docs/documents/${documentId}/processing`); const status = data?.data?.status; if (status === "ready") return "done"; if (status === "failed") return "error"; } catch { /* retry */ }
            await new Promise((r) => setTimeout(r, 3000));
        }
        return "error";
    };

    const addFilesToQueue = (fileList: FileList | File[]) => {
        const { allowed, rejected } = filterAllowedFiles(fileList);
        if (rejected.length) setError(`Rejected unsupported files: ${rejected.join(", ")}`);
        if (!allowed.length) return;
        setPendingFiles((prev) => [...prev, ...allowed.map((file) => ({ id: `pf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, file }))]);
    };

    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => { const files = e.clipboardData?.files; if (!files?.length) return; e.preventDefault(); addFilesToQueue(files); };
        const el = containerRef.current; el?.addEventListener("paste", onPaste as any); return () => el?.removeEventListener("paste", onPaste as any);
    });

    const removeFromQueue = (id: string) => setPendingFiles((prev) => prev.filter((p) => p.id !== id));
    const clearQueue = () => setPendingFiles([]);

    const uploadQueue = async () => {
        if (!pendingFiles.length || uploading) return;
        setUploading(true); setError(null);
        const filesToUpload = [...pendingFiles];
        const items: QueueItem[] = filesToUpload.map((p) => ({ id: p.id, name: p.file.name, size: p.file.size, mimeType: p.file.type, status: "queued" }));
        setQueueItems(items); setPendingFiles([]);
        const processingIds: string[] = [];
        for (let i = 0; i < filesToUpload.length; i++) {
            const pf = filesToUpload[i];
            setQueueItems((prev) => prev.map((q) => (q.id === pf.id ? { ...q, status: "uploading" } : q)));
            try {
                const form = new FormData(); form.append("file", pf.file);
                if (preferredAgent) form.append("phase3Agent", preferredAgent);
                const data = await apiRequest("/docs/documents", { method: "POST", body: form });
                const doc = data?.data?.document; const aiMsg = data?.data?.aiModelResponse?.message;
                const failed = doc?.status === "failed" || !!doc?.aiErrorMessage;
                if (doc?.documentId && !failed) processingIds.push(doc.documentId);
                setQueueItems((prev) => prev.map((q) => q.id === pf.id ? { ...q, status: failed ? "error" : "processing", documentId: doc?.documentId, error: doc?.aiErrorMessage || (failed ? "Upload to model failed" : undefined) } : q));
                if (!failed && aiMsg) setQueueItems((prev) => prev.map((q) => q.id === pf.id ? { ...q, error: undefined } : q));
            } catch (e: any) { setQueueItems((prev) => prev.map((q) => q.id === pf.id ? { ...q, status: "error", error: e.message } : q)); }
        }
        if (processingIds.length) {
            await Promise.all(processingIds.map(async (docId) => {
                const result = await pollUntilTerminal(docId);
                setQueueItems((prev) => prev.map((q) => q.documentId === docId ? { ...q, status: result === "done" ? "done" : "error" } : q));
                if (result === "done") await queueClassifyPopup(docId);
            }));
        }
        await load(); setUploading(false); setTimeout(() => setQueueItems([]), 8000);
    };

    const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length) addFilesToQueue(e.dataTransfer.files); };
    const remove = async (id: string, name: string) => { if (!confirm(`Delete "${name}" and its folder permanently?`)) return; try { await apiRequest(`/docs/documents/${id}`, { method: "DELETE" }); await load(); } catch (e: any) { setError(e.message || "Delete failed"); } };

    const allowUpload = canUpload();
    const allowView = canViewDocs();
    const allowDelete = canDeleteDocs();
    const showStaging = pendingFiles.length > 0 || queueItems.length > 0;
    const hasActiveFilters = Boolean(scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest");

    const totalDocs = pagination.total;
    const readyCount = docs.filter((d) => ["ready", "processed", "completed", "done"].includes((d.status || "").toLowerCase())).length;
    const processingCount = docs.filter((d) => ["processing", "uploaded", "queued"].includes((d.status || "").toLowerCase())).length;
    const failedCount = docs.filter((d) => { const s = (d.status || "").toLowerCase(); return s === "failed" || s.includes("fail") || s.includes("error"); }).length;

    return (
        <div ref={containerRef} tabIndex={0} className="p-4 sm:p-6 lg:p-8 space-y-5 max-w-6xl mx-auto outline-none">
            <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
                <PageHeader title="Documents" subtitle={allowUpload ? "Add files to queue, review, then upload. Files go to server then AI model automatically." : "Browse documents available to your account."} />
            </motion.div>

            {allowView && (
                <div className="flex flex-wrap items-center gap-4">
                    <StatMini icon={FileText} label="Total" value={totalDocs} accent="teal" delay={0.1} />
                    <StatMini icon={CheckCircle} label="Ready" value={readyCount} accent="emerald" delay={0.15} />
                    <StatMini icon={Clock} label="Processing" value={processingCount} accent="amber" delay={0.2} />
                    <StatMini icon={AlertTriangle} label="Failed" value={failedCount} accent="rose" delay={0.25} />
                </div>
            )}

            {!allowUpload && !allowView && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-700 px-4 py-3 text-sm">
                    You do not have permission to view or upload documents. Ask your admin to update your permissions.
                </div>
            )}

            {allowUpload && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
                    onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                    className={`relative overflow-hidden rounded-3xl border-2 border-dashed transition-all ${
                        dragOver
                            ? "border-teal-400 bg-gradient-to-br from-teal-50 to-cyan-50 shadow-lg shadow-teal-500/10"
                            : "border-slate-200 bg-white hover:border-teal-300 hover:bg-teal-50/30"
                    }`}
                >
                    <div className="absolute inset-0 opacity-[0.015]">
                        <div className="absolute -top-10 -right-10 w-40 h-40 rounded-full bg-teal-500 blur-3xl" />
                        <div className="absolute -bottom-10 -left-10 w-32 h-32 rounded-full bg-cyan-500 blur-3xl" />
                    </div>
                    <div className="relative p-8 sm:p-10 flex flex-col items-center text-center gap-4">
                        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all ${
                            dragOver
                                ? "bg-teal-500 text-white shadow-lg shadow-teal-500/30 scale-110"
                                : "bg-gradient-to-br from-teal-50 to-cyan-50 text-teal-600 border border-teal-200"
                        }`}>
                            <Upload size={26} />
                        </div>
                        <div>
                            <p className="font-bold text-slate-800 text-base">{uploading ? "Uploading..." : "Drag & drop files or folder"}</p>
                            <p className="text-sm text-slate-400 mt-1">PDF, images, DOCX, XLSX, PPTX — max 50 MB each · paste with Ctrl+V</p>
                        </div>
                        <div className="flex flex-wrap gap-2.5 justify-center">
                            <label className="btn-gradient rounded-xl px-6 py-2.5 text-sm cursor-pointer inline-flex items-center gap-2 shadow-sm hover:shadow-md transition-shadow">
                                <Upload size={14} /> Browse files
                                <input type="file" className="hidden" accept={ACCEPT_ATTR} multiple disabled={uploading} onChange={(e) => { if (e.target.files?.length) addFilesToQueue(e.target.files); e.target.value = ""; }} />
                            </label>
                            <label className="btn-secondary rounded-xl px-6 py-2.5 text-sm cursor-pointer inline-flex items-center gap-2">
                                <FolderUp size={14} /> Upload folder
                                <input type="file" className="hidden" accept={ACCEPT_ATTR} multiple {...({ webkitdirectory: "", directory: "" } as any)} disabled={uploading} onChange={(e) => { if (e.target.files?.length) addFilesToQueue(e.target.files); e.target.value = ""; }} />
                            </label>
                        </div>
                    </div>
                </motion.div>
            )}

            {toast && <div className="rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 px-4 py-3 text-sm">{toast}</div>}

            {allowUpload && classifyQueue.length > 0 && (
                <ClassifyAgentPopup doc={classifyQueue[0]} queueLen={classifyQueue.length} defaultAgent={preferredAgent || undefined} onConfirm={handleAgentConfirm} onDismiss={() => setClassifyQueue((prev) => prev.slice(1))} />
            )}

            {allowUpload && showStaging && (
                <div className="surface-card overflow-visible">
                    <div className="px-5 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-semibold text-slate-800">{uploading ? "Uploading queue" : `Ready to upload (${pendingFiles.length})`}</h2>
                            <p className="text-xs mt-0.5 text-slate-500">Review files, pick extraction agent, then click Upload</p>
                        </div>
                        <div className="flex gap-2">
                            {!uploading && pendingFiles.length > 0 && <button type="button" onClick={clearQueue} className="btn-ghost rounded-xl px-3 py-2 text-sm">Clear all</button>}
                            <button type="button" onClick={uploadQueue} disabled={uploading || pendingFiles.length === 0} className="btn-gradient rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 disabled:opacity-50">
                                {uploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                Upload {pendingFiles.length || queueItems.length} file(s)
                            </button>
                        </div>
                    </div>
                    {!uploading && pendingFiles.length > 0 && (
                        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/50">
                            <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 block mb-1">Extraction agent (optional)</label>
                            <select value={preferredAgent} onChange={(e) => setPreferredAgent(e.target.value)} className="premium-input rounded-xl py-2.5 px-3 text-sm w-full sm:min-w-[240px]">
                                {AGENT_OPTIONS.map((o) => <option key={o.value || "auto"} value={o.value}>{o.label}</option>)}
                            </select>
                        </div>
                    )}
                    <ul className="divide-y divide-slate-100">
                        {(queueItems.length ? queueItems : pendingFiles.map((p) => ({ id: p.id, name: p.file.name, size: p.file.size, mimeType: p.file.type, status: "queued" as QueueItemStatus, error: undefined as string | undefined }))).map((item) => (
                            <li key={item.id} className="px-5 py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-slate-50/50">
                                <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate text-sm text-slate-800">{item.name}</p>
                                    <p className="text-xs mt-0.5 text-slate-500">{formatBytes(item.size)}{"mimeType" in item && item.mimeType && <span className="ml-2">{getFileTypeLabel(item.mimeType, item.name)}</span>}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {"status" in item && item.status !== "queued" && <span className={`text-xs px-2 py-0.5 rounded-full border ${statusBadge(item.status)}`}>{item.status}{item.error ? `: ${item.error}` : ""}</span>}
                                    {!uploading && pendingFiles.some((p) => p.id === item.id) && <button type="button" onClick={() => removeFromQueue(item.id)} className="btn-ghost rounded-lg p-2 text-rose-400" aria-label="Remove from queue"><X size={14} /></button>}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {error && <div className="rounded-xl border border-rose-200 bg-rose-50 text-rose-700 px-4 py-3 text-sm">{error}</div>}

            {allowView && (
                <div className="surface-card">
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-teal-500/20">
                                <FileText size={16} className="text-white" />
                            </div>
                            <div>
                                <h2 className="text-sm font-bold text-slate-800">Library</h2>
                                <p className="text-[11px] text-slate-400">{pagination.total} document{pagination.total !== 1 ? "s" : ""}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
                                <button
                                    type="button"
                                    onClick={() => setViewMode("list")}
                                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        viewMode === "list"
                                            ? "bg-white text-teal-700 shadow-sm border border-slate-200"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <List size={13} /> List
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setViewMode("tree")}
                                    className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                                        viewMode === "tree"
                                            ? "bg-white text-teal-700 shadow-sm border border-slate-200"
                                            : "text-slate-500 hover:text-slate-700"
                                    }`}
                                >
                                    <FolderTree size={13} /> Tree
                                </button>
                            </div>
                            <button type="button" onClick={load} className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2">
                                <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
                            </button>
                        </div>
                    </div>

                    <div className="px-5 py-4 border-b border-slate-100 relative z-20">
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
                                <div className="relative flex-1 min-w-0">
                                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
                                    <input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applySearch()} placeholder="Search by filename…" className="w-full premium-input rounded-xl py-2.5 pl-10 pr-4 text-sm h-[44px]" />
                                </div>
                                <button type="button" onClick={applySearch} className="btn-gradient rounded-xl px-5 text-sm font-medium h-[44px] shrink-0 sm:w-auto w-full">Search</button>
                                <button type="button" onClick={() => setFiltersOpen((v) => !v)}
                                    className={`rounded-xl px-4 text-sm font-medium h-[44px] shrink-0 inline-flex items-center justify-center gap-2 border transition-colors ${filtersOpen || hasActiveFilters ? "bg-teal-50 border-teal-200 text-teal-700" : "btn-secondary"}`}
                                    aria-expanded={filtersOpen}>
                                    <Filter size={15} /> Filters
                                    {hasActiveFilters && <span className="h-5 min-w-5 px-1 rounded-full bg-teal-600 text-white text-[10px] font-bold flex items-center justify-center">{[scoreFilter, agentFilter, scopeFilter, typeFilter, sortPreset !== "newest"].filter(Boolean).length}</span>}
                                </button>
                            </div>
                            {filtersOpen && (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 pt-1 animate-fade-in-up">
                                    <FilterSelect label="Scope" value={scopeFilter} onChange={(v) => { setScopeFilter(v); setPage(1); }} options={[{ value: "", label: "All scopes" }, { value: "department", label: "Department" }, { value: "personal", label: "Personal" }]} minWidth="w-full" />
                                    <FilterSelect label="Doc type" value={typeFilter} onChange={(v) => { setTypeFilter(v); setPage(1); }} options={DOC_TYPE_FILTER_OPTIONS} minWidth="w-full" />
                                    <FilterSelect label="Score" value={scoreFilter} onChange={(v) => { setScoreFilter(v); setPage(1); }} options={SCORE_FILTER_OPTIONS} minWidth="w-full" />
                                    <FilterSelect label="Sort" value={sortPreset} onChange={(v) => { setSortPreset(v); setPage(1); }} options={SORT_PRESETS.map((s) => ({ value: s.value, label: s.label }))} minWidth="w-full" />
                                    <FilterSelect label="Agent" value={agentFilter} onChange={(v) => { setAgentFilter(v); setPage(1); }} options={AGENT_FILTER_OPTIONS} minWidth="w-full" />
                                </div>
                            )}
                        </div>
                        {(scoreFilter || agentFilter || scopeFilter || typeFilter || sortPreset !== "newest" || q) && (
                            <div className="flex flex-wrap items-center gap-2 mt-3">
                                {q && <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-600">"{q}"<button type="button" onClick={() => { setSearchInput(""); setQ(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear search"><X size={11} /></button></span>}
                                {scoreFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] text-emerald-700">{SCORE_FILTER_OPTIONS.find((o) => o.value === scoreFilter)?.label}<button type="button" onClick={() => { setScoreFilter(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear score"><X size={11} /></button></span>}
                                {agentFilter && <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] text-cyan-700">{agentLabel(agentFilter)}<button type="button" onClick={() => { setAgentFilter(""); setPage(1); }} className="hover:text-rose-500" aria-label="Clear agent"><X size={11} /></button></span>}
                                <button type="button" onClick={() => { setSearchInput(""); setQ(""); setScoreFilter(""); setScopeFilter(""); setTypeFilter(""); setAgentFilter(""); setSortPreset("newest"); setPage(1); }} className="text-[11px] text-slate-400 hover:text-teal-600 underline-offset-2 hover:underline">Clear filters</button>
                            </div>
                        )}
                    </div>

                    <div className="rounded-b-2xl">
                    {loading ? (
                        <div className="p-8 text-sm text-slate-500">Loading…</div>
                    ) : filteredDocs.length === 0 ? (
                        <EmptyState icon={<FileText size={22} />} title="No documents found" description="Upload files above or adjust your filters to see documents here." />
                    ) : viewMode === "tree" ? (
                        <DocumentFolderTree
                            docs={filteredDocs}
                            search={q}
                            agentFilter={agentFilter}
                            onSelectDoc={(id) => router.push(`/documents/details?doc=${id}`)}
                            onDelete={allowDelete ? remove : undefined}
                        />
                    ) : (
                        <ul className="divide-y divide-slate-100">
                            {filteredDocs.map((doc) => {
                                const { label: displayStatus, isProcessing, isComplete } = getDisplayStatus(doc);
                                return (
                                <li key={doc.documentId} className={`px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/50 transition-colors ${!isComplete ? "border-l-[3px] border-l-amber-400" : ""}`}>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <p className="font-semibold truncate min-w-0 text-slate-800 text-sm">{doc.originalFilename}</p>
                                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border ${statusBadge(displayStatus)}`}>
                                                {isProcessing && <Loader2 size={10} className="animate-spin" />}{displayStatus}
                                            </span>
                                            {doc.metadata?.cvScore != null && (
                                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
                                                    doc.metadata.cvScore >= 70 ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                                                    doc.metadata.cvScore >= 40 ? "bg-amber-50 text-amber-700 border-amber-200" :
                                                    "bg-rose-50 text-rose-700 border-rose-200"
                                                }`}>
                                                    {doc.metadata.cvScore >= 70 ? "✓" : doc.metadata.cvScore >= 40 ? "—" : "✗"} {doc.metadata.cvScore}
                                                </span>
                                            )}
                                            {doc.isDuplicate && <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-amber-50 text-amber-700 border border-amber-200"><Copy size={10} /> Dup</span>}
                                            {doc.visibilityScope === "department" && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-teal-50 text-teal-700 border border-teal-200">Dept</span>}
                                            {doc.visibilityScope === "personal" && <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase bg-slate-50 text-slate-500 border border-slate-200">Personal</span>}
                                        </div>
                                        <p className="text-xs text-slate-400 mt-1.5 flex items-center gap-2 flex-wrap">
                                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase bg-slate-100 text-slate-500">{getFileTypeLabel(doc.mimeType, doc.originalFilename)}</span>
                                            <span>{formatBytes(doc.sizeBytes)}</span>
                                            <span className="text-slate-300">&middot;</span>
                                            <span>{new Date(doc.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                                            {doc.classification && <><span className="text-slate-300">&middot;</span><span className="text-teal-600">{doc.classification}</span></>}
                                        </p>
                                        {doc.aiErrorMessage && <p className="text-xs text-rose-500 mt-1.5 flex items-center gap-1"><AlertTriangle size={11} /> {doc.aiErrorMessage}</p>}
                                    </div>
                                    <div className="flex gap-1.5 flex-wrap w-full sm:w-auto">
                                        {allowView && <Link href={`/documents/details?doc=${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-[36px]"><Info size={13} /> Details</Link>}
                                        {allowView && <Link href={`/documents/${doc.documentId}`} className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-[36px]"><Eye size={13} /> Preview</Link>}
                                        {allowDelete && <button type="button" onClick={() => remove(doc.documentId, doc.originalFilename)} className="btn-ghost rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 text-rose-500 min-h-[36px] hover:bg-rose-50"><Trash2 size={13} /></button>}
                                        {allowView && doc.uploadedBy === me?.userId && <button type="button" onClick={() => setSharingDoc({ documentId: doc.documentId, filename: doc.originalFilename })} className="btn-secondary rounded-lg px-3 py-2 text-xs flex items-center justify-center gap-1.5 min-h-[36px]"><Share2 size={13} /></button>}
                                    </div>
                                </li>
                            );})}
                        </ul>
                    )}
                    </div>
                    {viewMode === "list" && (
                        <LibraryPagination page={pagination.page} limit={pagination.limit} total={pagination.total} totalPages={pagination.totalPages} onPageChange={setPage} onLimitChange={(limit) => { setPageLimit(limit); setPage(1); }} borderClass="border-slate-200" textMutedClass="text-slate-500" />
                    )}
                </div>
            )}

            {sharingDoc && <ShareModal documentId={sharingDoc.documentId} filename={sharingDoc.filename} open={true} onClose={() => setSharingDoc(null)} onShared={() => load()} />}
        </div>
    );
}

export default function DocumentsPage() {
    return (
        <DocumentsContent />
    );
}
