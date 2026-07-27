"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Plug, Search, Loader2, Check, AlertTriangle, X, Copy, Eye, EyeOff,
    ArrowLeftRight, Download, Upload, BookOpen, Save, Trash2, RefreshCw,
    Settings2, Activity, Pencil, CheckCircle2, XCircle,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { usePermissions } from "@/context/PermissionsContext";
import { apiRequest } from "@/lib/apiClient";
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
    direction: string;
    lastSyncAt?: string | null;
    lastStatus?: string | null;
};

type PanelTab = "guide" | "setup" | "status";
type TestResult = { ok: boolean; message: string } | null;

function DirectionBadge({ directions }: { directions: IntegrationCatalogItem["directions"] }) {
    if (directions === "both") {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-teal-300/90">
                <ArrowLeftRight size={10} /> In + Out
            </span>
        );
    }
    if (directions === "inbound") {
        return (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-sky-300/90">
                <Download size={10} /> Inbound
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90">
            <Upload size={10} /> Outbound
        </span>
    );
}

function IntegrationsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const { role, ready } = usePermissions();

    const [hasActivePlan, setHasActivePlan] = useState<boolean | null>(null);
    const [connections, setConnections] = useState<Connection[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState<IntegrationCategory | "all">("all");
    const [activeId, setActiveId] = useState<string | null>(null);
    const [panelTab, setPanelTab] = useState<PanelTab>("guide");
    const [form, setForm] = useState<Record<string, string>>({});
    const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [freshIngestKey, setFreshIngestKey] = useState<string | null>(null);
    const [testResult, setTestResult] = useState<TestResult>(null);

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
        if (!ready || role !== "admin" || hasActivePlan !== true) return;
        loadConnections();
    }, [ready, role, hasActivePlan, loadConnections]);

    const byProvider = useMemo(() => {
        const map = new Map<string, Connection>();
        connections.forEach((c) => map.set(c.providerId, c));
        return map;
    }, [connections]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return INTEGRATION_CATALOG.filter((item) => {
            if (category !== "all" && item.category !== category) return false;
            if (!q) return true;
            return (
                item.name.toLowerCase().includes(q) ||
                item.description.toLowerCase().includes(q) ||
                item.id.includes(q)
            );
        });
    }, [search, category]);

    const activeItem = activeId ? INTEGRATION_CATALOG.find((i) => i.id === activeId) || null : null;
    const activeConn = activeId ? byProvider.get(activeId) : undefined;
    const isConnected = !!activeConn?.isActive;

    const fillForm = (item: IntegrationCatalogItem, conn?: Connection) => {
        const next: Record<string, string> = {};
        for (const field of item.fields) {
            if (field.secret) {
                next[field.key] = "";
            } else if (conn?.config?.[field.key] != null) {
                next[field.key] = String(conn.config[field.key]);
            } else if (field.key === "intervalMinutes") {
                next[field.key] = String(conn?.intervalMinutes || 15);
            } else if (field.key === "label") {
                next[field.key] = conn?.label || item.name;
            } else {
                next[field.key] = "";
            }
        }
        if (!next.label && item.id === "custom_webhook") next.label = item.name;
        if (!next.intervalMinutes) next.intervalMinutes = "15";
        setForm(next);
    };

    const openPanel = (item: IntegrationCatalogItem) => {
        setActiveId(item.id);
        setSuccess(null);
        setError(null);
        setFreshIngestKey(null);
        setTestResult(null);
        const conn = byProvider.get(item.id);
        fillForm(item, conn);
        setPanelTab(conn?.isActive ? "status" : "guide");
    };

    const closePanel = () => {
        setActiveId(null);
        setFreshIngestKey(null);
        setTestResult(null);
    };

    const setField = (key: string, value: string) => {
        setForm((prev) => ({ ...prev, [key]: value }));
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
        const rows: Array<{ label: string; value: string }> = [
            { label: "Label", value: activeConn.label || activeItem.name },
            { label: "Sync interval", value: `${activeConn.intervalMinutes || 15} minutes` },
            { label: "Direction", value: activeConn.direction || activeItem.directions },
        ];
        for (const field of activeItem.fields) {
            if (["label", "intervalMinutes"].includes(field.key)) continue;
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

    if (!ready || hasActivePlan === null) {
        return (
            <div className="h-64 flex items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: colors.primary }} />
            </div>
        );
    }

    if (role !== "admin") {
        return (
            <div className="p-8 max-w-lg mx-auto text-center space-y-3">
                <AlertTriangle className="mx-auto text-amber-400" size={28} />
                <h1 className="text-lg font-semibold">Admin only</h1>
                <p className={`text-sm ${colors.textMuted}`}>
                    Integrations are available to organization admins with an active plan.
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

            {error && !activeItem && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    {error}
                </div>
            )}
            {success && !activeItem && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 px-4 py-3 text-sm flex items-center gap-2">
                    <Check size={16} />
                    {success}
                </div>
            )}

            <div className="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
                <div className="relative flex-1 max-w-md">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)]" />
                    <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search integrations…"
                        className="w-full rounded-full border border-[var(--border)] bg-[var(--surface)] pl-9 pr-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
                    />
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
                                    : "border-[var(--border)] text-[var(--foreground-muted)] hover:border-[rgba(45,212,191,0.35)]"
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
                                className={`text-left surface-card border p-4 transition-all hover:border-[rgba(45,212,191,0.4)] ${
                                    connected ? "border-emerald-500/30" : "border-[var(--border)]"
                                }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="h-10 w-10 rounded-xl bg-teal-500/15 text-teal-300 flex items-center justify-center shrink-0">
                                        <Plug size={18} />
                                    </div>
                                    {connected ? (
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                            Connected
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-[var(--foreground-muted)] border border-[var(--border)]">
                                            Not connected
                                        </span>
                                    )}
                                </div>
                                <h3 className="mt-3 text-sm font-bold text-[var(--foreground)]">{item.name}</h3>
                                <p className="mt-1 text-xs text-[var(--foreground-muted)] line-clamp-2 leading-relaxed">
                                    {item.description}
                                </p>
                                <div className="mt-3 flex items-center justify-between gap-2">
                                    <DirectionBadge directions={item.directions} />
                                    <span className="text-[11px] text-[var(--accent)] font-medium">
                                        {connected ? "View status" : "Setup"} →
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
                                            {activeItem.fields.map(renderField)}
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
                                                onClick={() => setPanelTab("setup")}
                                                className="flex-1 btn-secondary rounded-xl px-4 py-2.5 text-sm inline-flex items-center justify-center gap-2"
                                            >
                                                <Pencil size={14} /> Edit settings
                                            </button>
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
        </div>
    );
}

export default function IntegrationsPage() {
    return <IntegrationsContent />;
}
