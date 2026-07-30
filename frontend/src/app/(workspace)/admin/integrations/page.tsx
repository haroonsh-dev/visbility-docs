"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Plug, Search, Loader2, Check, AlertTriangle, X, Copy, Eye, EyeOff,
    ArrowLeftRight, Download, Upload, BookOpen, Save, Trash2, RefreshCw,
    Settings2, Activity, Pencil, CheckCircle2, XCircle, Send,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { usePermissions } from "@/context/PermissionsContext";
import { apiRequest } from "@/lib/apiClient";
import SendToIntegrationModal from "@/components/SendToIntegrationModal";
import {
    INTEGRATION_CATALOG,
    INTEGRATION_CATEGORIES,
    type IntegrationCatalogItem,
    type IntegrationCategory,
    type IntegrationField,
} from "@/lib/integrationCatalog";

type Connection = {
    connectionId: string;
    providerId: string;
    label: string;
    config: Record<string, string | number | boolean | null>;
    secretsMasked: Record<string, string>;
    hasSecrets: boolean;
    ingestApiKeyMasked?: string;
    ingestApiKey?: string;
    ingestUrl?: string;
    isActive: boolean;
    intervalMinutes: number;
    syncMode?: "interval" | "daily" | "manual";
    dailyAt?: string;
    autoSyncEnabled?: boolean;
    intervalAutoUpload?: boolean;
    nextSyncAt?: string | null;
    pendingSyncPrompt?: { count?: number } | null;
    direction: string;
    lastSyncAt?: string | null;
    lastStatus?: string | null;
    lastSyncSummary?: string | null;
    hasOutboundWebhook?: boolean;
    outboundWebhookUrl?: string | null;
    outboundFolderId?: string | null;
    supportsFolderSend?: boolean;
};

type DriveFileRow = {
    id: string;
    name: string;
    mimeType: string;
    size?: number;
    md5Checksum?: string;
    modifiedTime?: string;
    existsInLibrary: boolean;
    documentId?: string | null;
    documentStatus?: string | null;
    duplicateMatch?: "drive_id" | "checksum" | "name_size" | "name" | null;
};

type PanelTab = "guide" | "setup" | "status";
type TestResult = { ok: boolean; message: string } | null;
type ConnectionFilter = "all" | "connected" | "disconnected";

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
    file_cloud: "File & Cloud",
    erp: "ERP",
    mes: "MES",
    quality: "Quality",
    maintenance: "Maintenance",
    generic: "Generic",
};

function DirectionBadge({ directions }: { directions: IntegrationCatalogItem["directions"] }) {
    if (directions === "both") {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--accent)]">
                <ArrowLeftRight size={10} /> In + Out
            </span>
        );
    }
    if (directions === "inbound") {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-300/90">
                <Download size={10} /> Inbound
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-300/90">
            <Upload size={10} /> Outbound
        </span>
    );
}

function IntegrationsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const { ready, canAccessPage } = usePermissions();

    const [hasActivePlan, setHasActivePlan] = useState<boolean | null>(null);
    const [connections, setConnections] = useState<Connection[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<IntegrationCategory | "all">("all");
    const [connFilter, setConnFilter] = useState<ConnectionFilter>("all");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<PanelTab>("guide");
    const [form, setForm] = useState<Record<string, string>>({});
    const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [freshIngestKey, setFreshIngestKey] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<TestResult>(null);
    const [driveFiles, setDriveFiles] = useState<DriveFileRow[]>([]);
    const [filesLoading, setFilesLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
    const [sendOpen, setSendOpen] = useState(false);

    const loadPlan = useCallback(async () => {
        try {
            const res = await apiRequest("/docs/plans/subscription");
            const sub = res?.data?.entitlement?.subscription;
            setHasActivePlan(!!sub && String(sub.status || "active").toLowerCase() === "active");
        } catch {
            setHasActivePlan(false);
        }
    }, []);

    const loadConnections = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiRequest("/docs/integrations");
            setConnections(res?.data?.connections || []);
        } catch (e: any) {
            setError(e.message || "Failed to load integrations");
            setConnections([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!ready) return;
        loadPlan();
    }, [ready, loadPlan]);

    useEffect(() => {
        if (!ready || !canAccessPage("integrations") || hasActivePlan !== true) return;
        loadConnections();
    }, [ready, canAccessPage, hasActivePlan, loadConnections]);

    const byProvider = useMemo(() => {
        const map = new Map<string, Connection>();
        connections.forEach((c) => map.set(c.providerId, c));
        return map;
    }, [connections]);

    const connectionCounts = useMemo(() => {
        let connected = 0;
        for (const item of INTEGRATION_CATALOG) {
            if (byProvider.get(item.id)?.isActive) connected += 1;
        }
        return {
            total: INTEGRATION_CATALOG.length,
            connected,
            disconnected: INTEGRATION_CATALOG.length - connected,
        };
    }, [byProvider]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = INTEGRATION_CATALOG.filter((item) => {
            const connected = !!byProvider.get(item.id)?.isActive;
            if (connFilter === "connected" && !connected) return false;
            if (connFilter === "disconnected" && connected) return false;
            if (category !== "all" && item.category !== category) return false;
            if (!q) return true;
            return (
                item.name.toLowerCase().includes(q) ||
                item.description.toLowerCase().includes(q) ||
                item.id.includes(q) ||
                (CATEGORY_LABELS[item.category] || "").toLowerCase().includes(q)
            );
        });
        // Connected first, then A–Z
        return list.sort((a, b) => {
            const ac = byProvider.get(a.id)?.isActive ? 0 : 1;
            const bc = byProvider.get(b.id)?.isActive ? 0 : 1;
            if (ac !== bc) return ac - bc;
            return a.name.localeCompare(b.name);
        });
    }, [search, category, connFilter, byProvider]);

    const activeItem = activeId ? INTEGRATION_CATALOG.find((i) => i.id === activeId) || null : null;
    const activeConn = activeId ? byProvider.get(activeId) : undefined;
    const isConnected = !!activeConn?.isActive;

    const fillForm = (item: IntegrationCatalogItem, conn?: Connection) => {
        const next: Record<string, string> = {};
        for (const field of item.fields) {
            if (field.secret) {
                next[field.key] = "";
            } else if (field.key === "intervalMinutes") {
                next[field.key] = String(conn?.intervalMinutes || conn?.config?.intervalMinutes || 15);
            } else if (field.key === "syncMode") {
                next[field.key] = String(conn?.syncMode || conn?.config?.syncMode || "interval");
            } else if (field.key === "dailyAt") {
                next[field.key] = String(conn?.dailyAt || conn?.config?.dailyAt || "09:00");
            } else if (field.key === "autoSyncEnabled") {
                const on = conn?.autoSyncEnabled ?? conn?.config?.autoSyncEnabled;
                next[field.key] = on === false || on === "false" ? "false" : "true";
            } else if (field.key === "intervalAutoUpload") {
                const on = conn?.intervalAutoUpload ?? conn?.config?.intervalAutoUpload;
                next[field.key] = on === true || on === "true" ? "true" : "false";
            } else if (field.key === "label") {
                next[field.key] = conn?.label || item.name;
            } else if (conn?.config?.[field.key] != null) {
                next[field.key] = String(conn.config[field.key]);
            } else {
                next[field.key] = "";
            }
        }
        if (!next.label && item.id === "custom_webhook") next.label = item.name;
        if (!next.intervalMinutes) next.intervalMinutes = "15";
        if (!next.syncMode) next.syncMode = "interval";
        if (!next.dailyAt) next.dailyAt = "09:00";
        if (!next.autoSyncEnabled) next.autoSyncEnabled = "true";
        if (!next.intervalAutoUpload) next.intervalAutoUpload = "false";
        setForm(next);
    };

    const openPanel = (item: IntegrationCatalogItem) => {
        setActiveId(item.id);
        setSuccess(null);
        setError(null);
        setFreshIngestKey(null);
        setTestResult(null);
        setDriveFiles([]);
        setSelectedFileIds(new Set());
        const conn = byProvider.get(item.id);
        fillForm(item, conn);
        setPanelTab(conn?.isActive ? "status" : "guide");
    };

    const closePanel = () => {
        setActiveId(null);
        setFreshIngestKey(null);
        setTestResult(null);
        setDriveFiles([]);
        setSelectedFileIds(new Set());
    };

    const setField = (key: string, value: string) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const loadDriveFiles = async (connectionId?: string) => {
        const id = connectionId || activeConn?.connectionId;
        if (!id) return;
        setFilesLoading(true);
        setError(null);
        try {
            const res = await apiRequest(`/docs/integrations/${id}/files`);
            const files: DriveFileRow[] = res?.data?.files || [];
            setDriveFiles(files);
            setSelectedFileIds(new Set(files.filter((f) => !f.existsInLibrary).map((f) => f.id)));
        } catch (e: any) {
            setError(e.message || "Failed to list Drive files");
            setDriveFiles([]);
        } finally {
            setFilesLoading(false);
        }
    };

    const syncDriveFiles = async (mode: "selected" | "missing") => {
        if (!activeConn) return;
        setSyncing(true);
        setError(null);
        setSuccess(null);
        try {
            const body =
                mode === "selected"
                    ? { fileIds: [...selectedFileIds] }
                    : { fileIds: driveFiles.filter((f) => !f.existsInLibrary).map((f) => f.id) };
            if (!body.fileIds.length) {
                setError("No files selected to upload");
                return;
            }
            const res = await apiRequest(`/docs/integrations/${activeConn.connectionId}/sync`, {
                method: "POST",
                body: JSON.stringify(body),
            });
            setSuccess(res?.message || "Sync finished");
            await loadConnections();
            await loadDriveFiles(activeConn.connectionId);
        } catch (e: any) {
            setError(e.message || "Sync failed");
        } finally {
            setSyncing(false);
        }
    };

    const save = async () => {
        if (!activeItem) return;
        setSaving(true);
        setError(null);
        setSuccess(null);
        setTestResult(null);
        try {
            const res = await apiRequest("/docs/integrations", {
                method: "POST",
                body: JSON.stringify({
                    providerId: activeItem.id,
                    label: form.label || activeItem.name,
                    direction: activeItem.directions,
                    intervalMinutes: Number(form.intervalMinutes) || 15,
                    syncMode: form.syncMode || "interval",
                    dailyAt: form.dailyAt || "09:00",
                    autoSyncEnabled: form.autoSyncEnabled !== "false",
                    intervalAutoUpload: form.intervalAutoUpload === "true",
                    fields: form,
                }),
            });
            const conn = res?.data?.connection as Connection | undefined;
            if (conn?.ingestApiKey) setFreshIngestKey(conn.ingestApiKey);
            setSuccess(res?.message || "Connected successfully");
            await loadConnections();
            setPanelTab("status");
        } catch (e: any) {
            setError(e.message || "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    const test = async () => {
        if (!activeConn) {
            setError("Save the connection first, then test.");
            setPanelTab("setup");
            return;
        }
        setTesting(true);
        setError(null);
        setSuccess(null);
        setTestResult(null);
        setPanelTab("status");
        try {
            const res = await apiRequest(`/docs/integrations/${activeConn.connectionId}/test`, {
                method: "POST",
            });
            const msg = res?.message || "Test passed — connection fields look valid.";
            setTestResult({ ok: true, message: msg });
            setSuccess(msg);
            await loadConnections();
        } catch (e: any) {
            const msg = e.message || "Test failed";
            setTestResult({ ok: false, message: msg });
            setError(msg);
        } finally {
            setTesting(false);
        }
    };

    const disconnect = async () => {
        if (!activeConn || !activeItem) return;
        if (!confirm(`Disconnect ${activeItem.name}?`)) return;
        setSaving(true);
        setError(null);
        try {
            await apiRequest(`/docs/integrations/${activeConn.connectionId}`, { method: "DELETE" });
            setSuccess("Disconnected");
            setFreshIngestKey(null);
            setTestResult(null);
            await loadConnections();
            fillForm(activeItem);
            setPanelTab("setup");
        } catch (e: any) {
            setError(e.message || "Failed to disconnect");
        } finally {
            setSaving(false);
        }
    };

    const rotateKey = async () => {
        if (!activeConn) return;
        if (!confirm("Rotate ingest API key? Old keys will stop working immediately.")) return;
        setSaving(true);
        try {
            const res = await apiRequest(`/docs/integrations/${activeConn.connectionId}/rotate-key`, {
                method: "POST",
            });
            const key = res?.data?.connection?.ingestApiKey;
            if (key) setFreshIngestKey(key);
            setSuccess("New ingest key generated — copy it now");
            await loadConnections();
        } catch (e: any) {
            setError(e.message || "Failed to rotate key");
        } finally {
            setSaving(false);
        }
    };

    const copyText = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setSuccess("Copied to clipboard");
        } catch {
            setError("Could not copy");
        }
    };

    const renderField = (field: IntegrationField) => {
        const value = form[field.key] ?? "";
        const show = showSecrets[field.key];
        const inputType =
            field.type === "password" && !show
                ? "password"
                : field.type === "number"
                  ? "number"
                  : field.type === "url"
                    ? "url"
                    : "text";

        return (
            <label key={field.key} className="block space-y-1.5">
                <span className="text-xs font-semibold text-[var(--foreground)]">
                    {field.label}
                    {field.required ? <span className="text-rose-400"> *</span> : null}
                </span>
                {field.type === "select" ? (
                    <select
                        value={value}
                        onChange={(e) => setField(field.key, e.target.value)}
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                    >
                        {(field.options || []).map((o) => (
                            <option key={o.value || "_empty"} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                ) : (
                    <div className="relative">
                        <input
                            type={inputType}
                            value={value}
                            onChange={(e) => setField(field.key, e.target.value)}
                            placeholder={
                                field.secret && isConnected
                                    ? "Leave blank to keep existing secret"
                                    : field.placeholder
                            }
                            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)] pr-10"
                        />
                        {field.type === "password" && (
                            <button
                                type="button"
                                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                                onClick={() =>
                                    setShowSecrets((s) => ({ ...s, [field.key]: !s[field.key] }))
                                }
                            >
                                {show ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                        )}
                    </div>
                )}
                {field.help && (
                    <p className="text-[11px] leading-relaxed text-[var(--foreground-muted)]">{field.help}</p>
                )}
            </label>
        );
    };

    const configRows = useMemo(() => {
        if (!activeItem || !activeConn) return [];
        const interval = Number(activeConn.intervalMinutes || activeConn.config?.intervalMinutes || 15);
        const syncMode = String(activeConn.syncMode || activeConn.config?.syncMode || "interval");
        const dailyAt = String(activeConn.dailyAt || activeConn.config?.dailyAt || "09:00");
        const autoOn = activeConn.autoSyncEnabled !== false && activeConn.config?.autoSyncEnabled !== "false";
        const intervalAuto =
            activeConn.intervalAutoUpload === true || activeConn.config?.intervalAutoUpload === true;

        const scheduleLabel =
            syncMode === "manual"
                ? "Manual only"
                : syncMode === "daily"
                  ? `Daily at ${dailyAt}${autoOn ? " — auto upload" : " (paused)"}`
                  : `Every ${interval} minutes${
                        autoOn
                            ? intervalAuto
                                ? " — auto upload"
                                : " — ask before upload"
                            : " (paused)"
                    }`;

        const rows: Array<{ label: string; value: string }> = [
            { label: "Label", value: activeConn.label || activeItem.name },
            { label: "Schedule", value: scheduleLabel },
            { label: "Interval (minutes)", value: String(interval) },
            { label: "Daily time", value: dailyAt },
            { label: "Auto sync", value: autoOn ? "Enabled" : "Paused" },
            {
                label: "Interval confirm",
                value:
                    syncMode !== "interval"
                        ? "—"
                        : intervalAuto
                          ? "Off (auto upload)"
                          : activeConn.pendingSyncPrompt?.count
                            ? `Waiting — ${activeConn.pendingSyncPrompt.count} file(s)`
                            : "Ask before upload",
            },
            {
                label: "Next auto sync",
                value: activeConn.nextSyncAt
                    ? new Date(activeConn.nextSyncAt).toLocaleString()
                    : syncMode === "manual" || !autoOn
                      ? "—"
                      : "Soon",
            },
            { label: "Direction", value: activeConn.direction || activeItem.directions },
        ];
        for (const field of activeItem.fields) {
            if (
                [
                    "label",
                    "intervalMinutes",
                    "syncMode",
                    "dailyAt",
                    "autoSyncEnabled",
                    "intervalAutoUpload",
                ].includes(field.key)
            ) {
                continue;
            }
            if (field.secret) {
                const masked = activeConn.secretsMasked?.[field.key];
                if (masked || activeConn.hasSecrets) {
                    rows.push({ label: field.label, value: masked || "•••• saved" });
                }
                continue;
            }
            const v = activeConn.config?.[field.key];
            if (v != null && String(v) !== "") {
                rows.push({ label: field.label, value: String(v) });
            }
        }
        return rows;
    }, [activeItem, activeConn]);

    useEffect(() => {
        if (panelTab === "status" && activeConn?.providerId === "google_drive" && activeConn.connectionId) {
            loadDriveFiles(activeConn.connectionId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [panelTab, activeConn?.connectionId, activeConn?.providerId]);

    if (!ready || hasActivePlan === null) {
        return (
            <div className="h-64 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: colors.primary }} />
            </div>
        );
    }

    if (!canAccessPage("integrations")) {
        return (
            <div className="p-8 max-w-lg mx-auto text-center space-y-3">
                <AlertTriangle className="mx-auto text-amber-400" size={28} />
                <h1 className="text-lg font-semibold">Admin only</h1>
                <p className={`text-sm ${colors.textMuted}`}>
                    Your assigned role does not include access to integrations.
                </p>
            </div>
        );
    }

    if (!hasActivePlan) {
        return (
            <div className="p-8 max-w-lg mx-auto text-center space-y-4">
                <Plug className="mx-auto text-[var(--accent)]" size={28} />
                <h1 className="text-lg font-semibold">Active plan required</h1>
                <p className={`text-sm ${colors.textMuted}`}>
                    Connect factory software after your organization plan is activated.
                </p>
                <Link href="/plans" className="btn-gradient inline-flex rounded-xl px-4 py-2 text-sm">
                    View plans
                </Link>
            </div>
        );
    }

    const tabs: Array<{ id: PanelTab; label: string; icon: React.ElementType; show: boolean }> = [
        { id: "guide", label: "Guide", icon: BookOpen, show: true },
        { id: "setup", label: isConnected ? "Edit" : "Connect", icon: isConnected ? Pencil : Settings2, show: true },
        { id: "status", label: "Status", icon: Activity, show: isConnected },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
            <PageHeader
                title="Integrations"
                subtitle="Connect factory ERP, MES, QMS, and file systems. Pull documents in and optionally push AI summaries back."
            />

            {/* Summary strip */}
            <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {[
                    { label: "Available", value: connectionCounts.total, tone: "text-[var(--foreground)]" },
                    { label: "Connected", value: connectionCounts.connected, tone: "text-emerald-600 dark:text-emerald-300" },
                    { label: "Not connected", value: connectionCounts.disconnected, tone: "text-[var(--foreground-muted)]" },
                ].map((s) => (
                    <div
                        key={s.label}
                        className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-3 sm:px-4"
                    >
                        <p className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
                            {s.label}
                        </p>
                        <p className={`mt-1 text-xl sm:text-2xl font-bold tabular-nums ${s.tone}`}>{s.value}</p>
                    </div>
                ))}
            </div>

            {error && !activeItem && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300 px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    {error}
                </div>
            )}
            {success && !activeItem && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 px-4 py-3 text-sm flex items-center gap-2">
                    <Check size={16} />
                    {success}
                </div>
            )}

            <div className="space-y-3">
                <div className="flex flex-col lg:flex-row gap-3 lg:items-center justify-between">
                    <div className="relative flex-1 max-w-md">
                        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)]" />
                        <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search by name, category…"
                            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 py-2.5 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                        />
                    </div>
                    <div className="inline-flex rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 gap-0.5 self-start">
                        {(
                            [
                                { id: "all", label: "All" },
                                { id: "connected", label: "Connected" },
                                { id: "disconnected", label: "Disconnected" },
                            ] as Array<{ id: ConnectionFilter; label: string }>
                        ).map((f) => (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => setConnFilter(f.id)}
                                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                                    connFilter === f.id
                                        ? f.id === "connected"
                                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                                            : f.id === "disconnected"
                                              ? "bg-[var(--surface-3)] text-[var(--foreground)]"
                                              : "bg-[var(--accent-muted)] text-[var(--accent)]"
                                        : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                                }`}
                            >
                                {f.label}
                                <span className="ml-1.5 tabular-nums opacity-70">
                                    {f.id === "all"
                                        ? connectionCounts.total
                                        : f.id === "connected"
                                          ? connectionCounts.connected
                                          : connectionCounts.disconnected}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex flex-wrap gap-1.5">
                    {INTEGRATION_CATEGORIES.map((c) => (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => setCategory(c.id)}
                            className={`rounded-full px-3 py-1.5 text-xs font-medium border transition-colors ${
                                category === c.id
                                    ? "border-[var(--accent)] bg-[var(--accent-muted)] text-[var(--accent)]"
                                    : "border-[var(--border)] text-[var(--foreground-muted)] hover:border-[rgba(13,148,136,0.35)] hover:text-[var(--foreground)]"
                            }`}
                        >
                            {c.label}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="h-40 flex items-center justify-center">
                    <Loader2 className="h-7 w-7 animate-spin text-[var(--accent)]" />
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]/60 px-6 py-14 text-center">
                    <Plug className="mx-auto text-[var(--foreground-muted)] mb-3" size={28} />
                    <p className="text-sm font-semibold text-[var(--foreground)]">No integrations match</p>
                    <p className="mt-1 text-xs text-[var(--foreground-muted)] max-w-sm mx-auto">
                        Try another search, category, or connection status filter.
                    </p>
                    <button
                        type="button"
                        onClick={() => {
                            setSearch("");
                            setCategory("all");
                            setConnFilter("all");
                        }}
                        className="mt-4 text-xs font-semibold text-[var(--accent)] hover:underline"
                    >
                        Clear filters
                    </button>
                </div>
            ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {filtered.map((item) => {
                        const conn = byProvider.get(item.id);
                        const connected = !!conn?.isActive;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => openPanel(item)}
                                className={`group text-left surface-card border p-4 transition-all hover:-translate-y-0.5 hover:border-[rgba(13,148,136,0.45)] ${
                                    connected
                                        ? "border-emerald-500/35 bg-gradient-to-br from-emerald-500/[0.06] to-transparent"
                                        : "border-[var(--border)]"
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div
                                        className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                                            connected
                                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
                                                : "bg-[var(--accent-muted)] text-[var(--accent)]"
                                        }`}
                                    >
                                        <Plug size={18} />
                                    </div>
                                    {connected ? (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/25">
                                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                            Connected
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[var(--surface-2)] text-[var(--foreground-muted)] border border-[var(--border)]">
                                            Disconnected
                                        </span>
                                    )}
                                </div>
                                <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
                                    {CATEGORY_LABELS[item.category]}
                                </p>
                                <h3 className="mt-0.5 text-sm font-bold text-[var(--foreground)] group-hover:text-[var(--accent)] transition-colors">
                                    {item.name}
                                </h3>
                                <p className="mt-1.5 text-xs text-[var(--foreground-muted)] line-clamp-2 leading-relaxed">
                                    {item.description}
                                </p>
                                {connected && conn?.lastStatus && (
                                    <p className="mt-2 text-[10px] text-[var(--foreground-muted)] truncate" title={conn.lastStatus}>
                                        Status: {conn.lastStatus}
                                    </p>
                                )}
                                <div className="mt-3 flex items-center justify-between gap-2 pt-2 border-t border-[var(--border)]/70">
                                    <DirectionBadge directions={item.directions} />
                                    <span className="text-[11px] text-[var(--accent)] font-semibold">
                                        {connected ? "Manage" : "Connect"} →
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {activeItem && (
                <div className="fixed inset-0 z-50 flex justify-end">
                    <button
                        type="button"
                        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                        aria-label="Close"
                        onClick={closePanel}
                    />
                    <aside className="relative z-10 h-full w-full max-w-xl flex flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl">
                        {/* Header */}
                        <div className="shrink-0 border-b border-[var(--border)] px-5 pt-4 pb-0 bg-[var(--surface)]">
                            <div className="flex items-start justify-between gap-3 mb-4">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h2 className="text-base font-bold tracking-tight">{activeItem.name}</h2>
                                        {isConnected ? (
                                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                                <CheckCircle2 size={10} /> Connected
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-[var(--foreground-muted)] border border-[var(--border)]">
                                                Not connected
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-1.5">
                                        <DirectionBadge directions={activeItem.directions} />
                                    </div>
                                </div>
                                <button type="button" onClick={closePanel} className="btn-ghost rounded-lg p-2 shrink-0">
                                    <X size={18} />
                                </button>
                            </div>

                            <div className="flex gap-1 -mb-px">
                                {tabs.filter((t) => t.show).map((t) => {
                                    const Icon = t.icon;
                                    const active = panelTab === t.id;
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            onClick={() => setPanelTab(t.id)}
                                            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
                                                active
                                                    ? "border-[var(--accent)] text-[var(--accent)]"
                                                    : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                                            }`}
                                        >
                                            <Icon size={13} />
                                            {t.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Body */}
                        <div className="flex-1 min-h-0 overflow-y-auto">
                            <div className="p-5 space-y-4">
                                {(error || success) && activeItem && panelTab !== "status" && (
                                    <div
                                        className={`rounded-xl px-3.5 py-2.5 text-sm flex items-start gap-2 ${
                                            error
                                                ? "border border-red-500/30 bg-red-500/10 text-red-300"
                                                : "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                        }`}
                                    >
                                        {error ? <AlertTriangle size={15} className="mt-0.5 shrink-0" /> : <Check size={15} className="mt-0.5 shrink-0" />}
                                        <span>{error || success}</span>
                                    </div>
                                )}

                                {/* GUIDE TAB */}
                                {panelTab === "guide" && (
                                    <div className="space-y-4">
                                        <div className="rounded-2xl border border-sky-500/20 bg-gradient-to-br from-sky-500/10 via-transparent to-transparent p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <div className="h-8 w-8 rounded-lg bg-sky-500/20 text-sky-300 flex items-center justify-center">
                                                    <BookOpen size={15} />
                                                </div>
                                                <div>
                                                    <h3 className="text-sm font-bold text-[var(--foreground)]">Setup guide</h3>
                                                    <p className="text-[11px] text-[var(--foreground-muted)]">
                                                        Follow these steps in order
                                                    </p>
                                                </div>
                                            </div>
                                            <p className="text-xs text-[var(--foreground-muted)] leading-relaxed mt-2">
                                                {activeItem.description}
                                            </p>
                                        </div>

                                        <ol className="space-y-3">
                                            {activeItem.guideSteps.map((step, i) => (
                                                <li
                                                    key={i}
                                                    className="flex gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-3.5"
                                                >
                                                    <span className="shrink-0 h-7 w-7 rounded-full bg-[var(--accent-muted)] text-[var(--accent)] text-xs font-bold flex items-center justify-center border border-[rgba(45,212,191,0.25)]">
                                                        {i + 1}
                                                    </span>
                                                    <p className="text-sm leading-relaxed text-[var(--foreground)] pt-0.5">
                                                        {step}
                                                    </p>
                                                </li>
                                            ))}
                                        </ol>

                                        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                                            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/90 mb-1">
                                                Bidirectional note
                                            </p>
                                            <p className="text-xs leading-relaxed text-[var(--foreground-muted)]">
                                                {activeItem.setupNotes}
                                            </p>
                                        </div>

                                        <button
                                            type="button"
                                            onClick={() => setPanelTab(isConnected ? "status" : "setup")}
                                            className="w-full btn-gradient rounded-xl px-4 py-3 text-sm font-semibold"
                                        >
                                            {isConnected ? "View connection status" : "Continue to Connect form"}
                                        </button>
                                    </div>
                                )}

                                {/* SETUP / EDIT TAB */}
                                {panelTab === "setup" && (
                                    <div className="space-y-4">
                                        <div className="rounded-2xl border border-teal-500/20 bg-gradient-to-br from-teal-500/10 via-transparent to-transparent p-4">
                                            <div className="flex items-center gap-2">
                                                <div className="h-8 w-8 rounded-lg bg-teal-500/20 text-teal-300 flex items-center justify-center">
                                                    <Settings2 size={15} />
                                                </div>
                                                <div>
                                                    <h3 className="text-sm font-bold text-[var(--foreground)]">
                                                        {isConnected ? "Update connection" : "Connection form"}
                                                    </h3>
                                                    <p className="text-[11px] text-[var(--foreground-muted)]">
                                                        {isConnected
                                                            ? "Change credentials or settings, then save"
                                                            : "Fill required fields, then save to connect"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/30 p-4 space-y-4">
                                            {activeItem.fields
                                                .filter((field) => {
                                                    if (field.key === "intervalMinutes") {
                                                        return (form.syncMode || "interval") === "interval";
                                                    }
                                                    if (field.key === "intervalAutoUpload") {
                                                        return (form.syncMode || "interval") === "interval";
                                                    }
                                                    if (field.key === "dailyAt") {
                                                        return (form.syncMode || "interval") === "daily";
                                                    }
                                                    if (field.key === "autoSyncEnabled") {
                                                        return (form.syncMode || "interval") !== "manual";
                                                    }
                                                    return true;
                                                })
                                                .map(renderField)}
                                        </div>

                                        <div className="flex flex-col gap-2 pb-4">
                                            <button
                                                type="button"
                                                onClick={save}
                                                disabled={saving}
                                                className="w-full btn-gradient rounded-xl px-4 py-3 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                                            >
                                                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                                                {isConnected ? "Save changes" : "Save & connect"}
                                            </button>
                                            {isConnected && (
                                                <button
                                                    type="button"
                                                    onClick={() => setPanelTab("status")}
                                                    className="w-full btn-secondary rounded-xl px-4 py-2.5 text-sm"
                                                >
                                                    Back to status
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* STATUS TAB (after connect) */}
                                {panelTab === "status" && isConnected && activeConn && (
                                    <div className="space-y-4">
                                        <div className="rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/15 via-emerald-500/5 to-transparent p-4">
                                            <div className="flex items-start gap-3">
                                                <div className="h-10 w-10 rounded-xl bg-emerald-500/20 text-emerald-300 flex items-center justify-center shrink-0">
                                                    <CheckCircle2 size={20} />
                                                </div>
                                                <div className="min-w-0">
                                                    <h3 className="text-sm font-bold text-emerald-200">
                                                        {activeItem.name} is connected
                                                    </h3>
                                                    <p className="text-xs text-[var(--foreground-muted)] mt-1 leading-relaxed">
                                                        Credentials saved. Run a test anytime, or edit settings from the Edit tab.
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        {/* Test result */}
                                        <div
                                            className={`rounded-2xl border p-4 ${
                                                testing
                                                    ? "border-[var(--border)] bg-[var(--surface-2)]/40"
                                                    : testResult?.ok
                                                      ? "border-emerald-500/30 bg-emerald-500/10"
                                                      : testResult && !testResult.ok
                                                        ? "border-red-500/30 bg-red-500/10"
                                                        : "border-[var(--border)] bg-[var(--surface-2)]/40"
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2 mb-2">
                                                <p className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground-muted)]">
                                                    Connection test
                                                </p>
                                                {testing && (
                                                    <span className="text-[11px] text-[var(--accent)] inline-flex items-center gap-1">
                                                        <Loader2 size={12} className="animate-spin" /> Running…
                                                    </span>
                                                )}
                                            </div>
                                            {testResult ? (
                                                <div className="flex items-start gap-2">
                                                    {testResult.ok ? (
                                                        <CheckCircle2 size={18} className="text-emerald-300 shrink-0 mt-0.5" />
                                                    ) : (
                                                        <XCircle size={18} className="text-rose-300 shrink-0 mt-0.5" />
                                                    )}
                                                    <div>
                                                        <p className={`text-sm font-semibold ${testResult.ok ? "text-emerald-200" : "text-rose-200"}`}>
                                                            {testResult.ok ? "Test passed" : "Test failed"}
                                                        </p>
                                                        <p className="text-xs text-[var(--foreground-muted)] mt-1 leading-relaxed">
                                                            {testResult.message}
                                                        </p>
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="text-xs text-[var(--foreground-muted)] leading-relaxed">
                                                    No test run yet. Click <strong className="text-[var(--foreground)]">Run test</strong> to validate saved fields.
                                                </p>
                                            )}
                                            <button
                                                type="button"
                                                onClick={test}
                                                disabled={testing}
                                                className="mt-3 w-full btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
                                            >
                                                {testing ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}
                                                {testing ? "Testing…" : "Run test"}
                                            </button>
                                        </div>

                                        {/* Saved details */}
                                        <div className="rounded-2xl border border-[var(--border)] overflow-hidden">
                                            <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)]/50">
                                                <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground-muted)]">
                                                    Saved details
                                                </h4>
                                            </div>
                                            <dl className="divide-y divide-[var(--border)]">
                                                {configRows.map((row) => (
                                                    <div key={row.label} className="px-4 py-2.5 flex items-start justify-between gap-3">
                                                        <dt className="text-xs text-[var(--foreground-muted)] shrink-0">{row.label}</dt>
                                                        <dd className="text-xs font-medium text-[var(--foreground)] text-right break-all">
                                                            {row.value}
                                                        </dd>
                                                    </div>
                                                ))}
                                                <div className="px-4 py-2.5 flex items-start justify-between gap-3">
                                                    <dt className="text-xs text-[var(--foreground-muted)]">Last status</dt>
                                                    <dd className="text-xs font-medium text-[var(--foreground)] text-right">
                                                        {activeConn.lastStatus || "connected"}
                                                        {activeConn.lastSyncAt
                                                            ? ` · ${new Date(activeConn.lastSyncAt).toLocaleString()}`
                                                            : ""}
                                                    </dd>
                                                </div>
                                            </dl>
                                        </div>

                                        {/* Google Drive file browser */}
                                        {activeConn.providerId === "google_drive" && (
                                            <div className="rounded-2xl border border-[var(--border)] overflow-hidden">
                                                <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)]/50 flex items-center justify-between gap-2">
                                                    <div>
                                                        <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground-muted)]">
                                                            Drive files
                                                        </h4>
                                                        <p className="text-[11px] text-[var(--foreground-muted)] mt-0.5">
                                                            {driveFiles.length
                                                                ? `${driveFiles.filter((f) => f.existsInLibrary).length} already in library · ${driveFiles.filter((f) => !f.existsInLibrary).length} new`
                                                                : "Check the folder and upload missing files"}
                                                        </p>
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => loadDriveFiles()}
                                                        disabled={filesLoading}
                                                        className="btn-secondary rounded-lg px-2.5 py-1.5 text-[11px] inline-flex items-center gap-1 disabled:opacity-50"
                                                    >
                                                        {filesLoading ? (
                                                            <Loader2 size={12} className="animate-spin" />
                                                        ) : (
                                                            <RefreshCw size={12} />
                                                        )}
                                                        Refresh
                                                    </button>
                                                </div>

                                                <div className="p-3 space-y-2 max-h-72 overflow-y-auto">
                                                    {filesLoading && !driveFiles.length ? (
                                                        <div className="py-8 flex justify-center">
                                                            <Loader2 className="h-5 w-5 animate-spin text-[var(--accent)]" />
                                                        </div>
                                                    ) : driveFiles.length === 0 ? (
                                                        <p className="text-xs text-[var(--foreground-muted)] text-center py-6">
                                                            No files found in this folder (or not loaded yet). Click Refresh.
                                                        </p>
                                                    ) : (
                                                        driveFiles.map((f) => {
                                                            const checked = selectedFileIds.has(f.id);
                                                            return (
                                                                <label
                                                                    key={f.id}
                                                                    className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                                                                        f.existsInLibrary
                                                                            ? "border-emerald-500/20 bg-emerald-500/5"
                                                                            : "border-[var(--border)] bg-[var(--surface)] hover:border-[rgba(45,212,191,0.35)]"
                                                                    }`}
                                                                >
                                                                    <input
                                                                        type="checkbox"
                                                                        className="mt-1"
                                                                        checked={checked}
                                                                        disabled={f.existsInLibrary}
                                                                        onChange={() => {
                                                                            setSelectedFileIds((prev) => {
                                                                                const next = new Set(prev);
                                                                                if (next.has(f.id)) next.delete(f.id);
                                                                                else next.add(f.id);
                                                                                return next;
                                                                            });
                                                                        }}
                                                                    />
                                                                    <div className="min-w-0 flex-1">
                                                                        <p className="text-xs font-medium text-[var(--foreground)] truncate">
                                                                            {f.name}
                                                                        </p>
                                                                        <p className="text-[10px] text-[var(--foreground-muted)] mt-0.5">
                                                                            {f.existsInLibrary
                                                                                ? `Already exists${f.duplicateMatch === "checksum" ? " · exact file match" : ""}${f.documentStatus ? ` · ${f.documentStatus}` : ""}`
                                                                                : "Not in library — select to upload"}
                                                                            {f.modifiedTime
                                                                                ? ` · ${new Date(f.modifiedTime).toLocaleString()}`
                                                                                : ""}
                                                                        </p>
                                                                    </div>
                                                                    {f.existsInLibrary ? (
                                                                        <CheckCircle2 size={14} className="text-emerald-300 shrink-0 mt-0.5" />
                                                                    ) : (
                                                                        <Upload size={14} className="text-[var(--accent)] shrink-0 mt-0.5" />
                                                                    )}
                                                                </label>
                                                            );
                                                        })
                                                    )}
                                                </div>

                                                <div className="px-3 py-3 border-t border-[var(--border)] flex flex-col sm:flex-row gap-2">
                                                    <button
                                                        type="button"
                                                        onClick={() => syncDriveFiles("selected")}
                                                        disabled={syncing || selectedFileIds.size === 0}
                                                        className="flex-1 btn-gradient rounded-xl px-3 py-2.5 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                                    >
                                                        {syncing ? (
                                                            <Loader2 size={13} className="animate-spin" />
                                                        ) : (
                                                            <Upload size={13} />
                                                        )}
                                                        Upload selected ({selectedFileIds.size})
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => syncDriveFiles("missing")}
                                                        disabled={
                                                            syncing ||
                                                            driveFiles.filter((f) => !f.existsInLibrary).length === 0
                                                        }
                                                        className="flex-1 btn-secondary rounded-xl px-3 py-2.5 text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                                                    >
                                                        Upload all missing
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {/* Ingest endpoint */}
                                        <div className="rounded-2xl border border-teal-500/25 bg-teal-500/5 p-4 space-y-3">
                                            <p className="text-xs font-semibold uppercase tracking-wider text-teal-300">
                                                Inbound ingest endpoint
                                            </p>
                                            <div className="space-y-1">
                                                <p className="text-[11px] text-[var(--foreground-muted)]">URL</p>
                                                <div className="flex gap-2">
                                                    <code className="flex-1 text-[11px] break-all rounded-lg bg-black/20 border border-[var(--border)] px-2.5 py-2">
                                                        {activeConn.ingestUrl || "—"}
                                                    </code>
                                                    {activeConn.ingestUrl && (
                                                        <button
                                                            type="button"
                                                            className="btn-ghost p-2 rounded-lg border border-[var(--border)]"
                                                            onClick={() => copyText(activeConn.ingestUrl!)}
                                                            aria-label="Copy URL"
                                                        >
                                                            <Copy size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="space-y-1">
                                                <p className="text-[11px] text-[var(--foreground-muted)]">X-Integration-Key</p>
                                                <div className="flex gap-2">
                                                    <code className="flex-1 text-[11px] break-all rounded-lg bg-black/20 border border-[var(--border)] px-2.5 py-2">
                                                        {freshIngestKey || activeConn.ingestApiKeyMasked || "••••"}
                                                    </code>
                                                    {freshIngestKey && (
                                                        <button
                                                            type="button"
                                                            className="btn-ghost p-2 rounded-lg border border-[var(--border)]"
                                                            onClick={() => copyText(freshIngestKey)}
                                                            aria-label="Copy key"
                                                        >
                                                            <Copy size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                                {freshIngestKey ? (
                                                    <p className="text-[11px] text-amber-300 mt-1">
                                                        Copy this key now — full key is shown only once.
                                                    </p>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={rotateKey}
                                                        className="text-[11px] text-[var(--accent)] inline-flex items-center gap-1 mt-1 hover:underline"
                                                    >
                                                        <RefreshCw size={11} /> Rotate key
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex flex-col sm:flex-row gap-2 pb-6">
                                            <button
                                                type="button"
                                                onClick={() => setSendOpen(true)}
                                                className="flex-1 btn-gradient rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2"
                                            >
                                                <Send size={14} /> Send from library…
                                            </button>
                                            {/* <button
                                                type="button"
                                                onClick={() => setPanelTab("setup")}
                                                className="flex-1 btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2"
                                            >
                                                <Pencil size={14} /> Edit settings
                                            </button> */}
                                            <button
                                                type="button"
                                                onClick={disconnect}
                                                disabled={saving}
                                                className="flex-1 rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2 border border-rose-500/30 text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
                                            >
                                                <Trash2 size={14} /> Disconnect
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    </aside>
                </div>
            )}

            {activeConn && (
                <SendToIntegrationModal
                    open={sendOpen}
                    onClose={() => setSendOpen(false)}
                    connectionId={activeConn.connectionId}
                    onSent={() => {
                        void loadConnections();
                    }}
                />
            )}
        </div>
    );
}

export default function IntegrationsPage() {
    return <IntegrationsContent />;
}
