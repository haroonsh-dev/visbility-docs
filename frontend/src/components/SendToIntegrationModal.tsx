"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Send, X, HardDrive, Link2 } from "lucide-react";
import { apiRequest } from "@/lib/apiClient";
import { useToast } from "@/components/Toast";

type ConnectionRow = {
    connectionId: string;
    providerId: string;
    label: string;
    isActive: boolean;
    hasOutboundWebhook?: boolean;
    outboundWebhookUrl?: string | null;
    supportsFolderSend?: boolean;
};

type LibraryDoc = {
    documentId: string;
    originalFilename: string;
    status?: string;
};

type Props = {
    open: boolean;
    onClose: () => void;
    /** Pre-selected document ids (document details). If empty, modal loads a library picker. */
    documentIds?: string[];
    /** Optional filename hint for single-doc mode */
    filename?: string;
    /** Pre-select a connection (Integrations Status) */
    connectionId?: string;
    onSent?: (message: string) => void;
};

export default function SendToIntegrationModal({
    open,
    onClose,
    documentIds: initialDocIds,
    filename,
    connectionId: initialConnectionId,
    onSent,
}: Props) {
    const { showToast } = useToast();
    const [connections, setConnections] = useState<ConnectionRow[]>([]);
    const [connectionId, setConnectionId] = useState("");
    const [library, setLibrary] = useState<LibraryDoc[]>([]);
    const [selectedDocs, setSelectedDocs] = useState<string[]>([]);
    const [destFolder, setDestFolder] = useState(true);
    const [destWebhook, setDestWebhook] = useState(false);
    const [loading, setLoading] = useState(false);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [docSearch, setDocSearch] = useState("");

    const fixedDocs = (initialDocIds || []).filter(Boolean);
    const needsDocPicker = fixedDocs.length === 0;

    const activeConn = useMemo(
        () => connections.find((c) => c.connectionId === connectionId),
        [connections, connectionId]
    );

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [connRes, docsRes] = await Promise.all([
                apiRequest("/docs/integrations"),
                needsDocPicker
                    ? apiRequest("/docs/documents?limit=50&sort=-createdAt")
                    : Promise.resolve(null),
            ]);
            const list: ConnectionRow[] = (connRes?.data?.connections || []).filter(
                (c: ConnectionRow) => c.isActive
            );
            setConnections(list);
            const preferred =
                initialConnectionId && list.some((c) => c.connectionId === initialConnectionId)
                    ? initialConnectionId
                    : list.find((c) => c.providerId === "google_drive")?.connectionId ||
                      list[0]?.connectionId ||
                      "";
            setConnectionId(preferred);

            if (needsDocPicker) {
                const docs: LibraryDoc[] = (docsRes?.data?.documents || docsRes?.data?.items || []).map(
                    (d: any) => ({
                        documentId: d.documentId,
                        originalFilename: d.originalFilename || d.filename || d.documentId,
                        status: d.status,
                    })
                );
                setLibrary(docs);
            }
        } catch (e: any) {
            const msg = e?.message || "Failed to load integrations";
            setError(msg);
            showToast(msg, "error");
        } finally {
            setLoading(false);
        }
    }, [initialConnectionId, needsDocPicker, showToast]);

    useEffect(() => {
        if (!open) return;
        setSuccess(null);
        setError(null);
        setSelectedDocs(fixedDocs);
        load();
    }, [open, load, fixedDocs.join("|")]);

    useEffect(() => {
        if (!activeConn) return;
        setDestFolder(!!activeConn.supportsFolderSend);
        setDestWebhook(!!activeConn.hasOutboundWebhook);
        if (!activeConn.supportsFolderSend && activeConn.hasOutboundWebhook) {
            setDestWebhook(true);
            setDestFolder(false);
        }
    }, [activeConn?.connectionId]);

    const filteredLibrary = useMemo(() => {
        const q = docSearch.trim().toLowerCase();
        if (!q) return library;
        return library.filter(
            (d) =>
                d.originalFilename.toLowerCase().includes(q) ||
                d.documentId.toLowerCase().includes(q)
        );
    }, [library, docSearch]);

    const toggleDoc = (id: string) => {
        setSelectedDocs((prev) =>
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
        );
    };

    const send = async () => {
        setError(null);
        setSuccess(null);
        if (!connectionId) {
            const msg = "Select a connection";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        const ids = needsDocPicker ? selectedDocs : fixedDocs;
        if (!ids.length) {
            const msg = "Select at least one document";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (!destFolder && !destWebhook) {
            const msg = "Select at least one destination (folder or webhook)";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (destFolder && !activeConn?.supportsFolderSend) {
            const msg = "Folder send is only available for Google Drive right now";
            setError(msg);
            showToast(msg, "error");
            return;
        }
        if (destWebhook && !activeConn?.hasOutboundWebhook) {
            const msg = "Set Outbound webhook URL in Integrations → Edit first";
            setError(msg);
            showToast(msg, "error");
            return;
        }

        setSending(true);
        try {
            const res = await apiRequest(`/docs/integrations/${connectionId}/send`, {
                method: "POST",
                body: JSON.stringify({
                    documentIds: ids,
                    include: {
                        file: true,
                        summary: false,
                        extracted: false,
                    },
                    destinations: {
                        folder: destFolder,
                        webhook: destWebhook,
                    },
                }),
            });

            const resultErrors = (res?.data?.results || [])
                .flatMap((r: any) => r?.errors || [])
                .filter(Boolean);
            const msg =
                res?.message ||
                (res?.success === false
                    ? resultErrors[0] || "Send failed"
                    : "Sent successfully");

            if (res?.success === false) {
                setError(msg);
                showToast(msg, "error");
                return;
            }

            setSuccess(msg);
            showToast(msg, "success");
            onSent?.(msg);
        } catch (e: any) {
            const nested =
                Array.isArray(e?.data?.data?.results)
                    ? e.data.data.results.flatMap((r: any) => r.errors || []).filter(Boolean)[0]
                    : null;
            const msg = e?.data?.message || e?.message || nested || "Send failed";
            setError(String(msg));
            showToast(String(msg), "error");
        } finally {
            setSending(false);
        }
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[85] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
            onClick={() => !sending && onClose()}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="send-integration-title"
                className="w-full max-w-lg surface-card border border-[var(--border)] shadow-2xl flex flex-col max-h-[90vh] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]">
                    <div className="h-9 w-9 rounded-lg bg-[var(--accent-muted)] text-[var(--accent)] flex items-center justify-center shrink-0">
                        <Send size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <h2 id="send-integration-title" className="text-sm font-bold">
                            Send to integration
                        </h2>
                        <p className="text-xs text-[var(--foreground-muted)] truncate">
                            {filename
                                ? `Upload file: ${filename}`
                                : fixedDocs.length
                                  ? `Upload ${fixedDocs.length} file(s)`
                                  : "Choose documents and destination"}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={() => !sending && onClose()}
                        className="btn-ghost rounded-lg p-2"
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
                    {loading ? (
                        <div className="py-10 flex justify-center">
                            <Loader2 className="animate-spin text-[var(--accent)]" size={22} />
                        </div>
                    ) : connections.length === 0 ? (
                        <p className="text-sm text-[var(--foreground-muted)]">
                            No active integrations. Connect Google Drive (or another system) under
                            Integrations first.
                        </p>
                    ) : (
                        <>
                            <label className="block space-y-1.5">
                                <span className="text-xs font-semibold text-[var(--foreground-muted)]">
                                    Connection
                                </span>
                                <select
                                    value={connectionId}
                                    onChange={(e) => setConnectionId(e.target.value)}
                                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm"
                                >
                                    {connections.map((c) => (
                                        <option key={c.connectionId} value={c.connectionId}>
                                            {c.label || c.providerId}
                                            {c.supportsFolderSend ? " · folder" : ""}
                                            {c.hasOutboundWebhook ? " · webhook" : ""}
                                        </option>
                                    ))}
                                </select>
                            </label>

                            {needsDocPicker && (
                                <div className="space-y-2">
                                    <span className="text-xs font-semibold text-[var(--foreground-muted)]">
                                        Documents
                                    </span>
                                    <input
                                        value={docSearch}
                                        onChange={(e) => setDocSearch(e.target.value)}
                                        placeholder="Search library…"
                                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
                                    />
                                    <ul className="max-h-40 overflow-y-auto rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
                                        {filteredLibrary.length === 0 ? (
                                            <li className="px-3 py-3 text-xs text-[var(--foreground-muted)]">
                                                No documents found
                                            </li>
                                        ) : (
                                            filteredLibrary.map((d) => (
                                                <li key={d.documentId}>
                                                    <label className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-[var(--surface-2)]">
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedDocs.includes(d.documentId)}
                                                            onChange={() => toggleDoc(d.documentId)}
                                                        />
                                                        <span className="truncate flex-1">
                                                            {d.originalFilename}
                                                        </span>
                                                    </label>
                                                </li>
                                            ))
                                        )}
                                    </ul>
                                </div>
                            )}

                            <p className="text-[11px] text-[var(--foreground-muted)] rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-2">
                                Sends the original file only (simple upload).
                            </p>

                            <div className="space-y-2">
                                <span className="text-xs font-semibold text-[var(--foreground-muted)]">
                                    Destination
                                </span>
                                <div className="grid gap-2">
                                    <button
                                        type="button"
                                        disabled={!activeConn?.supportsFolderSend}
                                        onClick={() =>
                                            activeConn?.supportsFolderSend && setDestFolder(!destFolder)
                                        }
                                        className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-45 ${
                                            destFolder && activeConn?.supportsFolderSend
                                                ? "border-[var(--accent)] bg-[var(--accent-muted)]"
                                                : "border-[var(--border)]"
                                        }`}
                                    >
                                        <HardDrive
                                            size={16}
                                            className="mt-0.5 text-[var(--accent)] shrink-0"
                                        />
                                        <span>
                                            <span className="text-sm font-semibold block">
                                                Connected Drive folder
                                            </span>
                                            <span className="text-[11px] text-[var(--foreground-muted)]">
                                                {activeConn?.supportsFolderSend
                                                    ? "Uploads into the same folder you linked for this connection"
                                                    : "Available for Google Drive connections"}
                                            </span>
                                        </span>
                                    </button>
                                    <button
                                        type="button"
                                        disabled={!activeConn?.hasOutboundWebhook}
                                        onClick={() =>
                                            activeConn?.hasOutboundWebhook &&
                                            setDestWebhook(!destWebhook)
                                        }
                                        className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-45 ${
                                            destWebhook && activeConn?.hasOutboundWebhook
                                                ? "border-[var(--accent)] bg-[var(--accent-muted)]"
                                                : "border-[var(--border)]"
                                        }`}
                                    >
                                        <Link2
                                            size={16}
                                            className="mt-0.5 text-[var(--accent)] shrink-0"
                                        />
                                        <span>
                                            <span className="text-sm font-semibold block">
                                                Outbound webhook URL
                                            </span>
                                            <span className="text-[11px] text-[var(--foreground-muted)]">
                                                {activeConn?.hasOutboundWebhook
                                                    ? "POST meta + files to your webhook"
                                                    : "Set URL in Integrations → Edit"}
                                            </span>
                                        </span>
                                    </button>
                                </div>
                                {!activeConn?.supportsFolderSend && !activeConn?.hasOutboundWebhook && (
                                    <p className="text-[11px] text-amber-600 dark:text-amber-300">
                                        Set Outbound webhook URL in Edit, or connect Google Drive for folder
                                        send.
                                    </p>
                                )}
                            </div>
                        </>
                    )}

                    {error && (
                        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300 px-3 py-2 text-sm">
                            {error}
                        </div>
                    )}
                    {success && (
                        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-sm">
                            {success}
                        </div>
                    )}
                </div>

                <div className="flex gap-2 px-5 py-4 border-t border-[var(--border)] bg-[var(--surface-2)]/60">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={sending}
                        className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-2.5 text-sm font-semibold"
                    >
                        Close
                    </button>
                    <button
                        type="button"
                        onClick={send}
                        disabled={sending || loading || connections.length === 0}
                        className="flex-[1.3] btn-gradient rounded-xl py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                        Send now
                    </button>
                </div>
            </div>
        </div>
    );
}
