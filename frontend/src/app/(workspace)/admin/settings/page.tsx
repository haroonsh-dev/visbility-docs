"use client";

import React, { useCallback, useEffect, useState } from "react";
import {
    Key, Shield, Zap, Brain, Sparkles, Globe, Save, Trash2, Loader2, Check, AlertTriangle,
    Eye, EyeOff, RotateCcw,
} from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";

type Provider = "groq" | "openai" | "gemini" | "anthropic" | "custom";

type ApiKeyRecord = {
    keyId: string;
    provider: Provider;
    apiKey: string;
    label: string;
    model?: string | null;
    baseUrl?: string | null;
    isActive: boolean;
    hasKey: boolean;
    createdAt: string;
};

type ProviderDefaults = Record<Provider, { label: string; model: string; baseUrl?: string }>;

const PROVIDER_CONFIG: Record<Provider, { icon: React.ReactNode; color: string; bgColor: string; borderColor: string; description: string }> = {
    groq: {
        icon: <Zap size={20} />,
        color: "text-amber-300",
        bgColor: "bg-amber-500/15",
        borderColor: "border-amber-500/30",
        description: "Fast inference with LLaMA models. Free tier available.",
    },
    openai: {
        icon: <Brain size={20} />,
        color: "text-emerald-300",
        bgColor: "bg-emerald-500/15",
        borderColor: "border-emerald-500/30",
        description: "GPT-4o, GPT-4 Turbo. Industry-leading models.",
    },
    gemini: {
        icon: <Sparkles size={20} />,
        color: "text-blue-300",
        bgColor: "bg-blue-500/15",
        borderColor: "border-blue-500/30",
        description: "Google Gemini Flash (free-tier friendly). Avoid 2.5-pro on free keys.",
    },
    anthropic: {
        icon: <Shield size={20} />,
        color: "text-orange-300",
        bgColor: "bg-orange-500/15",
        borderColor: "border-orange-500/30",
        description: "Claude 3.5 Sonnet & Opus. Best for analysis.",
    },
    custom: {
        icon: <Globe size={20} />,
        color: "text-purple-300",
        bgColor: "bg-purple-500/15",
        borderColor: "border-purple-500/30",
        description: "Any OpenAI-compatible API endpoint.",
    },
};

function SettingsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;

    const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
    const [defaults, setDefaults] = useState<ProviderDefaults | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Form state per provider
    const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
    const [formKey, setFormKey] = useState("");
    const [formModel, setFormModel] = useState("");
    const [formBaseUrl, setFormBaseUrl] = useState("");
    const [formLabel, setFormLabel] = useState("");
    const [saving, setSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
    const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});

    const loadKeys = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiRequest("/docs/settings/api-keys");
            setKeys(res?.data?.keys || []);
            setDefaults(res?.data?.providerDefaults || null);
        } catch (e: any) {
            setError(e.message || "Failed to load API keys");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadKeys();
    }, [loadKeys]);

    const getKeyForProvider = (provider: Provider): ApiKeyRecord | undefined => {
        return keys.find((k) => k.provider === provider);
    };

    const startEdit = (provider: Provider) => {
        const existing = getKeyForProvider(provider);
        const def = defaults?.[provider];
        setEditingProvider(provider);
        setFormKey(""); // Never pre-fill the key for security
        setFormModel(existing?.model || def?.model || "");
        setFormBaseUrl(existing?.baseUrl || def?.baseUrl || "");
        setFormLabel(existing?.label || def?.label || provider);
        setSaveSuccess(null);
        setError(null);
    };

    const cancelEdit = () => {
        setEditingProvider(null);
        setFormKey("");
        setFormModel("");
        setFormBaseUrl("");
        setFormLabel("");
    };

    const saveKey = async () => {
        if (!editingProvider) return;
        if (!formKey && !getKeyForProvider(editingProvider)) {
            setError("API key is required");
            return;
        }

        setSaving(true);
        setError(null);
        setSaveSuccess(null);
        try {
            const existing = getKeyForProvider(editingProvider);
            const payload: Record<string, unknown> = {
                provider: editingProvider,
                label: formLabel,
                model: formModel,
                baseUrl: formBaseUrl,
            };
            if (formKey) {
                payload.apiKey = formKey;
            } else if (existing) {
                // Keep existing key
                payload.apiKey = existing.apiKey;
            } else {
                setError("API key is required");
                setSaving(false);
                return;
            }
            if (existing?.keyId) {
                payload.keyId = existing.keyId;
            }

            await apiRequest("/docs/settings/api-keys", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            setSaveSuccess(`${formLabel || editingProvider} API key saved successfully!`);
            cancelEdit();
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to save API key");
        } finally {
            setSaving(false);
        }
    };

    const deleteKey = async (keyId: string, label: string) => {
        if (!confirm(`Delete ${label} API key? This cannot be undone.`)) return;
        try {
            await apiRequest(`/docs/settings/api-keys/${keyId}`, { method: "DELETE" });
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to delete API key");
        }
    };

    const toggleKey = async (keyId: string) => {
        try {
            await apiRequest(`/docs/settings/api-keys/${keyId}/toggle`, { method: "PATCH" });
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to toggle API key");
        }
    };

    const toggleShowKey = (keyId: string) => {
        setShowKeys((prev) => ({ ...prev, [keyId]: !prev[keyId] }));
    };

    const [settingPrimary, setSettingPrimary] = useState(false);

    // Filter ONLY providers that have a configured key
    const configuredKeys = keys.filter((k) => k.hasKey);

    const handleSetPrimary = async (providerToSet: Provider) => {
        if (!providerToSet) return;
        setSettingPrimary(true);
        setError(null);
        setSaveSuccess(null);
        try {
            await apiRequest("/docs/settings/api-keys/primary", {
                method: "POST",
                body: JSON.stringify({ provider: providerToSet }),
            });
            setSaveSuccess(`Active AI Provider set to ${providerToSet.toUpperCase()}`);
            await loadKeys();
        } catch (e: any) {
            setError(e.message || "Failed to set active provider");
        } finally {
            setSettingPrimary(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center py-20">
                <Loader2 className="h-8 w-8 animate-spin" style={{ color: colors.primary }} />
            </div>
        );
    }

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
            <PageHeader
                title="AI Provider Settings"
                subtitle="Manage API keys for AI providers. Keys are used for document processing, vision models, chat, and search."
            />

            {error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 px-4 py-3 text-sm flex items-center gap-2">
                    <AlertTriangle size={16} />
                    {error}
                </div>
            )}
            {saveSuccess && (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 px-4 py-3 text-sm flex items-center gap-2">
                    <Check size={16} />
                    {saveSuccess}
                </div>
            )}

            {/* Active Provider Selector Card */}
            <div className="surface-card border border-[var(--border)] rounded-2xl p-5 space-y-3 bg-gradient-to-r from-[var(--surface-2)]/60 to-[var(--surface-1)]">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2">
                            <Brain size={18} className="text-amber-400" />
                            <h3 className="text-sm font-bold text-[var(--foreground)]">Active AI & Vision Provider</h3>
                        </div>
                        <p className="text-xs text-[var(--foreground-muted)] mt-1">
                            Select which uploaded API key to use for Vision, OCR, and AI processing. Only configured keys are shown below.
                        </p>
                    </div>

                    <div className="flex items-center gap-2 min-w-[240px]">
                        <select
                            value={keys.find((k) => k.isActive)?.provider || ""}
                            onChange={(e) => handleSetPrimary(e.target.value as Provider)}
                            disabled={settingPrimary || configuredKeys.length === 0}
                            className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-medium border border-[var(--border)] bg-[var(--surface-1)] text-[var(--foreground)] focus:ring-2 focus:ring-[var(--accent)] cursor-pointer"
                        >
                            {configuredKeys.length === 0 ? (
                                <option value="">No Configured API Keys Found</option>
                            ) : (
                                configuredKeys.map((k) => (
                                    <option key={k.provider} value={k.provider}>
                                        {k.label || k.provider.toUpperCase()} ({k.provider})
                                    </option>
                                ))
                            )}
                        </select>
                        {settingPrimary && <Loader2 size={16} className="animate-spin text-[var(--accent)] shrink-0" />}
                    </div>
                </div>
            </div>

            {/* Provider Cards */}
            <div className="grid gap-4">
                {(Object.keys(PROVIDER_CONFIG) as Provider[]).map((provider) => {
                    const config = PROVIDER_CONFIG[provider];
                    const existing = getKeyForProvider(provider);
                    const isEditing = editingProvider === provider;
                    const hasKey = existing?.hasKey || false;

                    return (
                        <div
                            key={provider}
                            className={`surface-card border transition-all ${
                                isEditing ? "border-[var(--accent)]" : hasKey ? config.borderColor : "border-[var(--border)]"
                            }`}
                        >
                            {/* Header */}
                            <div className="px-5 py-4 flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <div className={`h-11 w-11 rounded-xl ${config.bgColor} ${config.color} flex items-center justify-center`}>
                                        {config.icon}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-bold text-[var(--foreground)]">{existing?.label || config.description.split(".")[0]}</h3>
                                            {hasKey && existing?.isActive && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                                    Active
                                                </span>
                                            )}
                                            {hasKey && !existing?.isActive && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25">
                                                    Disabled
                                                </span>
                                            )}
                                            {!hasKey && (
                                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-white/5 text-[var(--foreground-muted)] border border-[var(--border)]">
                                                    Not configured
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-[var(--foreground-muted)] mt-0.5">{config.description}</p>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {hasKey && existing?.model && (
                                        <span className="text-[11px] text-[var(--foreground-muted)] hidden sm:block">
                                            Model: {existing.model}
                                        </span>
                                    )}
                                    {hasKey && (
                                        <button
                                            type="button"
                                            onClick={() => toggleKey(existing!.keyId)}
                                            className={`p-1.5 rounded-lg transition-colors ${
                                                existing?.isActive
                                                    ? "text-emerald-400 hover:bg-emerald-500/15"
                                                    : "text-amber-400 hover:bg-amber-500/15"
                                            }`}
                                            title={existing?.isActive ? "Disable" : "Enable"}
                                        >
                                            {existing?.isActive ? <Check size={15} /> : <RotateCcw size={15} />}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => isEditing ? cancelEdit() : startEdit(provider)}
                                        className={`btn-secondary rounded-lg px-3 py-2 text-xs font-medium ${
                                            isEditing ? "border-red-500/30 text-red-300" : ""
                                        }`}
                                    >
                                        {isEditing ? "Cancel" : hasKey ? "Update" : "Add Key"}
                                    </button>
                                </div>
                            </div>

                            {/* Existing Key Display */}
                            {hasKey && !isEditing && (
                                <div className="px-5 pb-4">
                                    <div className="flex items-center gap-2 rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border)] px-4 py-2.5">
                                        <Key size={13} className="text-[var(--foreground-muted)] shrink-0" />
                                        <span className="text-xs font-mono text-[var(--foreground-muted)] flex-1 min-w-0 truncate">
                                            {showKeys[existing!.keyId] ? existing!.apiKey : "****" + existing!.apiKey.slice(-4)}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => toggleShowKey(existing!.keyId)}
                                            className="text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                                        >
                                            {showKeys[existing!.keyId] ? <EyeOff size={13} /> : <Eye size={13} />}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => deleteKey(existing!.keyId, existing!.label)}
                                            className="text-[var(--foreground-muted)] hover:text-red-400 transition-colors"
                                        >
                                            <Trash2 size={13} />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Edit Form */}
                            {isEditing && (
                                <div className="px-5 pb-5 space-y-3 border-t border-[var(--border)] pt-4">
                                    <div>
                                        <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--foreground-muted)] block mb-1.5">
                                            API Key *
                                        </label>
                                        <input
                                            type="password"
                                            value={formKey}
                                            onChange={(e) => setFormKey(e.target.value)}
                                            placeholder={getKeyForProvider(provider) ? "Enter new key to replace..." : "Paste your API key..."}
                                            className="w-full premium-input rounded-xl px-4 py-2.5 text-sm font-mono"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--foreground-muted)] block mb-1.5">
                                                Model
                                            </label>
                                            <input
                                                type="text"
                                                value={formModel}
                                                onChange={(e) => setFormModel(e.target.value)}
                                                placeholder={defaults?.[provider]?.model || "e.g., gpt-4o"}
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--foreground-muted)] block mb-1.5">
                                                Label
                                            </label>
                                            <input
                                                type="text"
                                                value={formLabel}
                                                onChange={(e) => setFormLabel(e.target.value)}
                                                placeholder={defaults?.[provider]?.label || provider}
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                    </div>
                                    {provider === "custom" && (
                                        <div>
                                            <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--foreground-muted)] block mb-1.5">
                                                Base URL
                                            </label>
                                            <input
                                                type="text"
                                                value={formBaseUrl}
                                                onChange={(e) => setFormBaseUrl(e.target.value)}
                                                placeholder="https://your-api-endpoint.com/v1"
                                                className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                                            />
                                        </div>
                                    )}
                                    <div className="flex gap-2 pt-1">
                                        <button
                                            type="button"
                                            onClick={saveKey}
                                            disabled={saving || (!formKey && !getKeyForProvider(provider))}
                                            className="btn-gradient rounded-xl px-5 py-2.5 text-sm font-semibold flex items-center gap-2"
                                        >
                                            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                                            Save {formLabel || provider}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={cancelEdit}
                                            className="btn-secondary rounded-xl px-5 py-2.5 text-sm"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* Info box */}
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-5 space-y-2">
                <h3 className="text-sm font-semibold text-[var(--foreground)]">How Provider Fallback Works</h3>
                <ul className="text-xs text-[var(--foreground-muted)] space-y-1 list-disc list-inside">
                    <li>The system uses the <strong>Groq</strong> provider by default.</li>
                    <li>If Groq hits a rate limit, it automatically falls back to the next configured provider.</li>
                    <li>Priority order: Groq → OpenAI → Gemini → Anthropic → Custom.</li>
                    <li>Configure at least one provider for AI features to work.</li>
                    <li>Keys are stored securely and never exposed in browser console.</li>
                </ul>
            </div>
        </div>
    );
}

export default function SettingsPage() {
    return (
        <SettingsContent />
    );
}
