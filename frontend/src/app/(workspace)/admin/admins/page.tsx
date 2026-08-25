"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
    ChevronDown,
    ChevronRight,
    Clock,
    Building2,
    KeyRound,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Shield,
    Trash2,
    UserCheck,
    UserX,
    Users,
    Zap,
    X,
} from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { Badge } from "@/components/ui/Badge";
import { useTheme } from "@/context/ColorContext";
import { apiRequest } from "@/lib/apiClient";

type TeamMember = {
    userId: string;
    fullName: string;
    email: string;
    username?: string;
    contactNumber?: string;
    status: string;
    permissions?: Record<string, boolean>;
    createdAt?: string;
    lastLogin?: string;
    createdBy?: string;
};

type OrganizationInfo = {
    organizationId: string;
    organizationName: string;
    status?: string;
    subscriptionPlan?: string;
    contactEmail?: string;
    hasGroqApiKey?: boolean;
    groqApiKeyMasked?: string | null;
};

type Admin = {
    userId: string;
    fullName: string;
    email: string;
    username?: string;
    contactNumber?: string;
    status: string;
    accountType?: string;
    organizationId?: string | null;
    organization?: OrganizationInfo | null;
    teamMembers?: TeamMember[];
    teamMemberCount?: number;
    createdAt?: string;
    lastLogin?: string;
    emailVerified?: boolean;
};

type AdminFormState = {
    fullName: string;
    email: string;
    password: string;
    contactNumber: string;
    organizationName: string;
    status: "active" | "blocked";
    groqApiKey: string;
};

const EMPTY_CREATE_FORM: AdminFormState = {
    fullName: "",
    email: "",
    password: "",
    contactNumber: "",
    organizationName: "",
    status: "active",
    groqApiKey: "",
};

const AVATAR_COLORS = [
    "bg-rose-500/20 text-rose-400",
    "bg-blue-500/20 text-blue-400",
    "bg-emerald-500/20 text-emerald-400",
    "bg-amber-500/20 text-amber-400",
    "bg-violet-500/20 text-violet-400",
    "bg-blue-500/20 text-(--vb-blue-bright)",
    "bg-pink-500/20 text-pink-400",
    "bg-lime-500/20 text-lime-400",
];

const fieldClass =
    "w-full h-11 px-3.5 rounded-xl text-sm bg-surface-2 border border-border text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-2 focus:ring-[rgba(56,182,255,0.18)] transition-all";

const labelClass = "text-[11px] font-semibold uppercase tracking-wide text-foreground-muted";

function getAvatarColor(name: string) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name: string) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return (parts[0]?.[0] || "?").toUpperCase();
}

function timeAgo(value?: string) {
    if (!value) return null;
    try {
        const diff = Date.now() - new Date(value).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "just now";
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        return `${months}mo ago`;
    } catch {
        return null;
    }
}

function formatDate(value?: string) {
    if (!value) return "—";
    try {
        return new Date(value).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "—";
    }
}

function permCount(permissions?: Record<string, boolean>) {
    if (!permissions) return 0;
    return Object.values(permissions).filter(Boolean).length;
}

function AdminsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const [admins, setAdmins] = useState<Admin[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState("");

    const [showCreate, setShowCreate] = useState(false);
    const [createForm, setCreateForm] = useState<AdminFormState>(EMPTY_CREATE_FORM);
    const [createError, setCreateError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
    const [editForm, setEditForm] = useState<AdminFormState>(EMPTY_CREATE_FORM);
    const [editError, setEditError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);

    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

    // Groq Key Modal state
    const [groqModalOrg, setGroqModalOrg] = useState<{ orgId: string; orgName: string; currentKeyMasked?: string | null } | null>(null);
    const [groqApiKeyInput, setGroqApiKeyInput] = useState("");
    const [groqKeyError, setGroqKeyError] = useState<string | null>(null);
    const [groqKeySuccess, setGroqKeySuccess] = useState<string | null>(null);
    const [groqKeySaving, setGroqKeySaving] = useState(false);
    const [groqKeyDeleting, setGroqKeyDeleting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await apiRequest("/docs/super-admin/admins");
            setAdmins(data?.data?.admins || []);
            setError(null);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const openCreate = () => {
        setCreateForm(EMPTY_CREATE_FORM);
        setCreateError(null);
        setShowCreate(true);
    };

    const closeCreate = () => {
        if (creating) return;
        setShowCreate(false);
        setCreateError(null);
    };

    const openEdit = (admin: Admin) => {
        setEditingAdmin(admin);
        setEditForm({
            fullName: admin.fullName || "",
            email: admin.email || "",
            password: "",
            contactNumber: admin.contactNumber || "",
            organizationName: admin.organization?.organizationName || "",
            status: admin.status === "blocked" ? "blocked" : "active",
            groqApiKey: admin.organization?.groqApiKeyMasked || "",
        });
        setEditError(null);
    };

    const closeEdit = () => {
        if (saving) return;
        setEditingAdmin(null);
        setEditError(null);
    };

    const openGroqModal = (orgId: string, orgName: string, currentKeyMasked?: string | null) => {
        setGroqModalOrg({ orgId, orgName, currentKeyMasked });
        setGroqApiKeyInput("");
        setGroqKeyError(null);
        setGroqKeySuccess(null);
    };

    const closeGroqModal = () => {
        if (groqKeySaving || groqKeyDeleting) return;
        setGroqModalOrg(null);
        setGroqApiKeyInput("");
        setGroqKeyError(null);
        setGroqKeySuccess(null);
    };

    const saveGroqKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!groqModalOrg) return;
        const key = groqApiKeyInput.trim();
        if (!key) {
            setGroqKeyError("Please enter a Groq API key");
            return;
        }
        if (!key.startsWith("gsk_")) {
            setGroqKeyError("Groq API keys usually start with gsk_");
            return;
        }
        setGroqKeySaving(true);
        setGroqKeyError(null);
        setGroqKeySuccess(null);
        try {
            await apiRequest(`/docs/super-admin/organizations/${groqModalOrg.orgId}/groq-key`, {
                method: "POST",
                body: JSON.stringify({ groqApiKey: key }),
            });
            setGroqKeySuccess("Groq API key saved successfully!");
            setGroqApiKeyInput("");
            await load();
            setTimeout(() => {
                setGroqModalOrg(null);
                setGroqKeySuccess(null);
            }, 1200);
        } catch (err: any) {
            setGroqKeyError(err.message || "Failed to update Groq API key");
        } finally {
            setGroqKeySaving(false);
        }
    };

    const deleteGroqKey = async () => {
        if (!groqModalOrg) return;
        if (!confirm(`Delete Groq API key for organization "${groqModalOrg.orgName}"?`)) return;
        setGroqKeyDeleting(true);
        setGroqKeyError(null);
        setGroqKeySuccess(null);
        try {
            await apiRequest(`/docs/super-admin/organizations/${groqModalOrg.orgId}/groq-key`, {
                method: "DELETE",
            });
            setGroqKeySuccess("Groq API key deleted!");
            await load();
            setTimeout(() => {
                setGroqModalOrg(null);
                setGroqKeySuccess(null);
            }, 1200);
        } catch (err: any) {
            setGroqKeyError(err.message || "Failed to delete Groq API key");
        } finally {
            setGroqKeyDeleting(false);
        }
    };

    const createAdmin = async (e: React.FormEvent) => {
        e.preventDefault();
        setCreating(true);
        setCreateError(null);
        try {
            const body: Record<string, string> = {
                fullName: createForm.fullName.trim(),
                email: createForm.email.trim(),
                password: createForm.password,
                organizationName: createForm.organizationName.trim(),
                status: createForm.status,
            };
            if (createForm.contactNumber.trim()) {
                body.contactNumber = createForm.contactNumber.trim();
            }
            if (createForm.groqApiKey.trim()) {
                body.groqApiKey = createForm.groqApiKey.trim();
            }
            await apiRequest("/docs/super-admin/admins", {
                method: "POST",
                body: JSON.stringify(body),
            });
            setShowCreate(false);
            setCreateForm(EMPTY_CREATE_FORM);
            await load();
        } catch (err: any) {
            setCreateError(err.message || "Failed to create admin");
        } finally {
            setCreating(false);
        }
    };

    const saveAdmin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingAdmin) return;
        setSaving(true);
        setEditError(null);
        try {
            const body: Record<string, string> = {
                fullName: editForm.fullName.trim(),
                email: editForm.email.trim(),
                contactNumber: editForm.contactNumber.trim(),
                organizationName: editForm.organizationName.trim(),
                status: editForm.status,
            };
            if (editForm.password.trim()) {
                body.password = editForm.password;
            }
            if (editForm.groqApiKey !== undefined && editForm.groqApiKey !== editForm.groqApiKey.trim()) {
                body.groqApiKey = editForm.groqApiKey.trim();
            } else if (editForm.groqApiKey && editForm.groqApiKey.startsWith("gsk_") && !editForm.groqApiKey.includes("•")) {
                body.groqApiKey = editForm.groqApiKey.trim();
            }
            await apiRequest(`/docs/super-admin/admins/${editingAdmin.userId}`, {
                method: "PUT",
                body: JSON.stringify(body),
            });
            setEditingAdmin(null);
            await load();
        } catch (err: any) {
            setEditError(err.message || "Failed to update admin");
        } finally {
            setSaving(false);
        }
    };

    const toggleStatus = async (userId: string, status: string) => {
        const next = status === "active" ? "blocked" : "active";
        setStatusBusyId(userId);
        setError(null);
        try {
            await apiRequest(`/docs/super-admin/admins/${userId}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: next }),
            });
            await load();
        } catch (err: any) {
            setError(err.message || "Failed to update status");
        } finally {
            setStatusBusyId(null);
        }
    };

    const removeAdmin = async (admin: Admin) => {
        const name = admin.fullName || admin.email;
        if (!confirm(`Delete admin "${name}"? This cannot be undone.`)) return;
        setDeletingId(admin.userId);
        setError(null);
        try {
            await apiRequest(`/docs/super-admin/admins/${admin.userId}`, { method: "DELETE" });
            await load();
        } catch (err: any) {
            setError(err.message || "Failed to delete admin");
        } finally {
            setDeletingId(null);
        }
    };

    const toggleExpand = (userId: string) => {
        setExpanded((prev) => ({ ...prev, [userId]: !prev[userId] }));
    };

    const filtered = useMemo(() => {
        if (!searchQuery.trim()) return admins;
        const q = searchQuery.toLowerCase();
        return admins.filter(
            (a) =>
                a.fullName.toLowerCase().includes(q) ||
                a.email.toLowerCase().includes(q) ||
                (a.organization?.organizationName || "").toLowerCase().includes(q)
        );
    }, [admins, searchQuery]);

    const stats = useMemo(() => {
        const totalAdmins = admins.length;
        const activeAdmins = admins.filter((a) => a.status === "active").length;
        const inactiveAdmins = admins.filter((a) => a.status !== "active").length;
        const totalMembers = admins.reduce((acc, a) => acc + (a.teamMemberCount ?? a.teamMembers?.length ?? 0), 0);
        return { totalAdmins, activeAdmins, inactiveAdmins, totalMembers };
    }, [admins]);

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6 animate-fade-in-up">
            <PageHeader
                title="Super Admin Panel"
                subtitle="Manage all admin accounts, their organizations, and team members"
                actions={
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={load}
                            className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                        >
                            <RefreshCw size={14} /> Refresh
                        </button>
                        <button
                            type="button"
                            onClick={openCreate}
                            className="btn-primary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                        >
                            <Plus size={14} /> Create Admin
                        </button>
                    </div>
                }
            />

            {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                    <X size={14} />
                    {error}
                </div>
            )}

            {/* Stats Cards */}
            {!loading && admins.length > 0 && (
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {[
                        {
                            label: "Total Admins",
                            value: stats.totalAdmins,
                            icon: Shield,
                            color: "text-accent",
                            bg: "bg-accent-muted",
                        },
                        {
                            label: "Active",
                            value: stats.activeAdmins,
                            icon: UserCheck,
                            color: "text-emerald-400",
                            bg: "bg-emerald-500/10",
                        },
                        {
                            label: "Inactive",
                            value: stats.inactiveAdmins,
                            icon: UserX,
                            color: "text-rose-400",
                            bg: "bg-rose-500/10",
                        },
                        {
                            label: "Team Members",
                            value: stats.totalMembers,
                            icon: Users,
                            color: "text-amber-400",
                            bg: "bg-amber-500/10",
                        },
                    ].map((s) => (
                        <div key={s.label} className="surface-card p-4 flex items-center gap-3">
                            <span className={`h-10 w-10 rounded-xl ${s.bg} ${s.color} flex items-center justify-center shrink-0`}>
                                <s.icon className="h-5 w-5" />
                            </span>
                            <div>
                                <p className="text-2xl font-bold tracking-tight text-foreground tabular-nums font-mono">
                                    {s.value}
                                </p>
                                <p className="text-[11px] text-foreground-muted uppercase tracking-wide font-medium">
                                    {s.label}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Search Bar */}
            {!loading && admins.length > 0 && (
                <div className="relative">
                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                    <input
                        type="text"
                        placeholder="Search admins by name, email, or organization..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full h-11 pl-10 pr-10 rounded-xl text-sm bg-surface border border-border text-foreground placeholder:text-foreground-muted outline-none focus:border-accent focus:ring-2 focus:ring-[rgba(56,182,255,0.15)] transition-shadow"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-foreground-muted hover:text-foreground"
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
            )}

            {/* Admin List */}
            <div className="surface-card overflow-hidden">
                {loading ? (
                    <div className={`p-8 text-sm ${colors.textMuted}`}>Loading admins…</div>
                ) : filtered.length === 0 ? (
                    <div className="p-8">
                        <EmptyState
                            icon={<Shield size={28} className="text-accent" />}
                            title={searchQuery ? "No matching admins" : "No admins yet"}
                            description={
                                searchQuery
                                    ? `No admins match "${searchQuery}". Try a different search.`
                                    : "Create Admin to add a company admin account with an organization."
                            }
                        />
                        {!searchQuery && (
                            <div className="flex justify-center mt-4">
                                <button
                                    type="button"
                                    onClick={openCreate}
                                    className="btn-primary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                                >
                                    <Plus size={14} /> Create Admin
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <ul className="divide-y divide-border">
                        {filtered.map((a) => {
                            const open = !!expanded[a.userId];
                            const members = a.teamMembers || [];
                            const memberCount = a.teamMemberCount ?? members.length;
                            const loginAgo = timeAgo(a.lastLogin);
                            const statusBusy = statusBusyId === a.userId;
                            const deleteBusy = deletingId === a.userId;

                            return (
                                <li key={a.userId} className={`${colors.bgHover} transition-colors`}>
                                    <div className="px-4 sm:px-5 py-4">
                                        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                                            {/* Left: Avatar + Info */}
                                            <button
                                                type="button"
                                                onClick={() => toggleExpand(a.userId)}
                                                className="flex items-start gap-3 text-left min-w-0 flex-1"
                                            >
                                                <div
                                                    className={`h-11 w-11 rounded-xl ${getAvatarColor(a.fullName)} flex items-center justify-center shrink-0 font-semibold text-sm`}
                                                >
                                                    {getInitials(a.fullName)}
                                                </div>

                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <p className={`font-semibold text-[15px] ${colors.textPrimary}`}>
                                                            {a.fullName}
                                                        </p>
                                                        <Badge variant={a.status === "active" ? "success" : "error"}>
                                                            {a.status}
                                                        </Badge>
                                                        <Badge variant="accent">Admin</Badge>
                                                        {a.emailVerified && <Badge variant="success">Verified</Badge>}
                                                        {a.organization?.hasGroqApiKey ? (
                                                            <Badge variant="success" className="gap-1">
                                                                <KeyRound size={11} /> Groq Key Set
                                                            </Badge>
                                                        ) : (
                                                            <Badge variant="muted" className="gap-1">
                                                                <KeyRound size={11} opacity={0.6} /> No Groq Key
                                                            </Badge>
                                                        )}
                                                    </div>
                                                    <p className={`text-sm ${colors.textMuted} mt-1 break-words`}>
                                                        {a.email}
                                                        {a.contactNumber ? ` · ${a.contactNumber}` : ""}
                                                    </p>
                                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
                                                        <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                            <Building2 size={12} />
                                                            {a.organization?.organizationName || "No organization"}
                                                        </span>
                                                        <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                            <Users size={12} />
                                                            {memberCount} member{memberCount === 1 ? "" : "s"}
                                                        </span>
                                                        {loginAgo && (
                                                            <span className={`inline-flex items-center gap-1 text-xs ${colors.textMuted}`}>
                                                                <Clock size={12} />
                                                                Active {loginAgo}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </button>

                                            {/* Right: Actions */}
                                            <div className="flex items-center gap-2 shrink-0 flex-wrap">
                                                <span className="text-foreground-muted">
                                                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                                </span>
                                                {a.organization && (
                                                    <button
                                                        type="button"
                                                        onClick={() => openGroqModal(a.organization!.organizationId, a.organization!.organizationName, a.organization!.groqApiKeyMasked)}
                                                        className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 hover:border-[rgba(56,182,255,0.5)] hover:text-(--vb-blue-bright)"
                                                    >
                                                        <KeyRound size={14} className="text-(--vb-blue-bright)" /> Groq Key
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => openEdit(a)}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5"
                                                >
                                                    <Pencil size={14} /> Edit
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => toggleStatus(a.userId, a.status)}
                                                    disabled={statusBusy}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 disabled:opacity-50"
                                                >
                                                    {statusBusy ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : a.status === "active" ? (
                                                        <UserX size={14} />
                                                    ) : (
                                                        <UserCheck size={14} />
                                                    )}
                                                    {a.status === "active" ? "Block" : "Activate"}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => removeAdmin(a)}
                                                    disabled={deleteBusy}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10 inline-flex items-center gap-1.5 text-error hover:bg-error-muted disabled:opacity-50"
                                                >
                                                    {deleteBusy ? (
                                                        <Loader2 size={14} className="animate-spin" />
                                                    ) : (
                                                        <Trash2 size={14} />
                                                    )}
                                                    Delete
                                                </button>
                                            </div>
                                        </div>

                                        {/* Expanded Details */}
                                        {open && (
                                            <div className="mt-4 ml-0 sm:ml-14 space-y-4">
                                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                                    {[
                                                        { label: "Username", value: a.username || "—" },
                                                        { label: "Account", value: a.accountType || "—" },
                                                        { label: "Created", value: formatDate(a.createdAt) },
                                                        { label: "Last Login", value: formatDate(a.lastLogin) },
                                                        { label: "Org Plan", value: a.organization?.subscriptionPlan || "—" },
                                                        { label: "Org Status", value: a.organization?.status || "—" },
                                                        { label: "Org Contact", value: a.organization?.contactEmail || "—" },
                                                        { label: "Groq Key", value: a.organization?.groqApiKeyMasked || "Not configured", mono: true },
                                                        { label: "User ID", value: a.userId, mono: true },
                                                    ].map((d) => (
                                                        <div
                                                            key={d.label}
                                                            className="rounded-xl border border-border px-3 py-2.5 bg-surface-2/60"
                                                        >
                                                            <p className="text-[10px] uppercase tracking-wider font-semibold text-foreground-muted">
                                                                {d.label}
                                                            </p>
                                                            <p
                                                                className={`text-sm mt-0.5 break-all ${colors.textPrimary} ${d.mono ? "font-mono text-xs" : ""}`}
                                                            >
                                                                {d.value}
                                                            </p>
                                                        </div>
                                                    ))}
                                                </div>

                                                <div className="rounded-xl border border-border overflow-hidden">
                                                    <div className="px-4 py-3 border-b border-border bg-surface-2/30 flex items-center gap-2">
                                                        <Users size={14} className="text-accent" />
                                                        <p className={`text-sm font-semibold ${colors.textPrimary}`}>
                                                            Team Members ({members.length})
                                                        </p>
                                                    </div>
                                                    {members.length === 0 ? (
                                                        <div className="px-4 py-8 text-center">
                                                            <Users size={24} className="mx-auto mb-2 text-foreground-muted opacity-40" />
                                                            <p className={`text-sm ${colors.textMuted}`}>
                                                                No team members in this organization yet.
                                                            </p>
                                                        </div>
                                                    ) : (
                                                        <ul className="divide-y divide-border">
                                                            {members.map((m) => (
                                                                <li
                                                                    key={m.userId}
                                                                    className="px-4 py-3 flex items-start gap-3 hover:bg-surface-2/30 transition-colors"
                                                                >
                                                                    <div
                                                                        className={`h-9 w-9 rounded-lg ${getAvatarColor(m.fullName)} flex items-center justify-center shrink-0 font-medium text-xs`}
                                                                    >
                                                                        {getInitials(m.fullName)}
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <div className="flex items-center gap-2 flex-wrap">
                                                                            <p className={`text-sm font-medium ${colors.textPrimary}`}>
                                                                                {m.fullName}
                                                                            </p>
                                                                            <Badge variant={m.status === "active" ? "success" : "error"}>
                                                                                {m.status}
                                                                            </Badge>
                                                                            <Badge variant="muted">Team</Badge>
                                                                            {permCount(m.permissions) > 0 && (
                                                                                <Badge variant="default">
                                                                                    <Zap size={10} />
                                                                                    {permCount(m.permissions)} perms
                                                                                </Badge>
                                                                            )}
                                                                        </div>
                                                                        <p className={`text-xs ${colors.textMuted} mt-1 break-words`}>
                                                                            {m.email}
                                                                            {m.username ? ` · @${m.username}` : ""}
                                                                            {m.contactNumber ? ` · ${m.contactNumber}` : ""}
                                                                        </p>
                                                                        <div className={`flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] ${colors.textMuted}`}>
                                                                            <span>Created {formatDate(m.createdAt)}</span>
                                                                            <span>
                                                                                Last login{" "}
                                                                                {m.lastLogin ? timeAgo(m.lastLogin) || formatDate(m.lastLogin) : "Never"}
                                                                            </span>
                                                                        </div>
                                                                    </div>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            {/* Create Admin Modal — portaled to body so it centers on the full screen */}
            {showCreate &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="create-admin-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeCreate}
                        />
                        <div
                            className="relative z-[1] w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.08)] via-[rgba(56,182,255,0.04)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue-dark) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <Shield size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="create-admin-title" className="text-base font-bold text-foreground tracking-tight">
                                                Create Admin
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5">
                                                New company admin account with organization
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeCreate}
                                        disabled={creating}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={createAdmin} className="px-6 py-5 space-y-4">
                                {createError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {createError}
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Full name</label>
                                        <input
                                            required
                                            value={createForm.fullName}
                                            onChange={(e) => setCreateForm({ ...createForm, fullName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Jane Doe"
                                            autoComplete="name"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Email</label>
                                        <input
                                            required
                                            type="email"
                                            value={createForm.email}
                                            onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
                                            className={fieldClass}
                                            placeholder="admin@company.com"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Password</label>
                                        <input
                                            required
                                            type="password"
                                            minLength={8}
                                            value={createForm.password}
                                            onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Min 8 characters"
                                            autoComplete="new-password"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>
                                            Contact <span className="normal-case font-normal opacity-70">(optional)</span>
                                        </label>
                                        <input
                                            type="tel"
                                            value={createForm.contactNumber}
                                            onChange={(e) => setCreateForm({ ...createForm, contactNumber: e.target.value })}
                                            className={fieldClass}
                                            placeholder="+1 555 000 0000"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Organization</label>
                                        <input
                                            required
                                            value={createForm.organizationName}
                                            onChange={(e) => setCreateForm({ ...createForm, organizationName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Acme Corp"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Status</label>
                                        <select
                                            value={createForm.status}
                                            onChange={(e) =>
                                                setCreateForm({
                                                    ...createForm,
                                                    status: e.target.value as "active" | "blocked",
                                                })
                                            }
                                            className={fieldClass}
                                        >
                                            <option value="active">Active</option>
                                            <option value="blocked">Blocked</option>
                                        </select>
                                    </div>
                                    <div className="space-y-1.5 sm:col-span-2">
                                        <label className={labelClass}>
                                            Groq API Key <span className="normal-case font-normal opacity-70">(gsk_..., optional)</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={createForm.groqApiKey}
                                            onChange={(e) => setCreateForm({ ...createForm, groqApiKey: e.target.value })}
                                            className={fieldClass}
                                            placeholder="gsk_..."
                                            autoComplete="off"
                                        />
                                    </div>
                                </div>

                                <div className="flex justify-end gap-2 pt-4 border-t border-border">
                                    <button
                                        type="button"
                                        onClick={closeCreate}
                                        disabled={creating}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={creating}
                                        className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                    >
                                        {creating && <Loader2 size={14} className="animate-spin" />}
                                        {creating ? "Creating…" : "Create Admin"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}

            {/* Edit Admin Modal — portaled to body so it centers on the full screen */}
            {editingAdmin &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="edit-admin-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeEdit}
                        />
                        <div
                            className="relative z-[1] w-full max-w-2xl rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.08)] via-[rgba(56,182,255,0.04)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue-dark) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <Pencil size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="edit-admin-title" className="text-base font-bold text-foreground tracking-tight">
                                                Edit Admin
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5 truncate">
                                                {editingAdmin.email}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeEdit}
                                        disabled={saving}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={saveAdmin} className="px-6 py-5 space-y-4">
                                {editError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {editError}
                                    </div>
                                )}

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Full name</label>
                                        <input
                                            required
                                            value={editForm.fullName}
                                            onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Jane Doe"
                                            autoComplete="name"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Email</label>
                                        <input
                                            required
                                            type="email"
                                            value={editForm.email}
                                            onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                                            className={fieldClass}
                                            placeholder="admin@company.com"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Contact</label>
                                        <input
                                            type="tel"
                                            value={editForm.contactNumber}
                                            onChange={(e) => setEditForm({ ...editForm, contactNumber: e.target.value })}
                                            className={fieldClass}
                                            placeholder="+1 555 000 0000"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Organization</label>
                                        <input
                                            required
                                            value={editForm.organizationName}
                                            onChange={(e) => setEditForm({ ...editForm, organizationName: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Acme Corp"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>
                                            New password <span className="normal-case font-normal opacity-70">(optional)</span>
                                        </label>
                                        <input
                                            type="password"
                                            minLength={8}
                                            value={editForm.password}
                                            onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                                            className={fieldClass}
                                            placeholder="Leave blank to keep"
                                            autoComplete="new-password"
                                        />
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className={labelClass}>Status</label>
                                        <select
                                            value={editForm.status}
                                            onChange={(e) =>
                                                setEditForm({
                                                    ...editForm,
                                                    status: e.target.value as "active" | "blocked",
                                                })
                                            }
                                            className={fieldClass}
                                        >
                                            <option value="active">Active</option>
                                            <option value="blocked">Blocked</option>
                                        </select>
                                    </div>
                                    <div className="space-y-1.5 sm:col-span-2">
                                        <label className={labelClass}>
                                            Groq API Key <span className="normal-case font-normal opacity-70">(gsk_..., leave blank to clear)</span>
                                        </label>
                                        <input
                                            type="password"
                                            value={editForm.groqApiKey}
                                            onChange={(e) => setEditForm({ ...editForm, groqApiKey: e.target.value })}
                                            className={fieldClass}
                                            placeholder={editingAdmin.organization?.groqApiKeyMasked || "gsk_..."}
                                            autoComplete="off"
                                        />
                                    </div>
                                </div>

                                <div className="flex justify-end gap-2 pt-4 border-t border-border">
                                    <button
                                        type="button"
                                        onClick={closeEdit}
                                        disabled={saving}
                                        className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                    >
                                        {saving && <Loader2 size={14} className="animate-spin" />}
                                        {saving ? "Saving…" : "Save changes"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}

            {/* Groq API Key Modal — portaled to body so it centers on full screen */}
            {groqModalOrg &&
                typeof document !== "undefined" &&
                createPortal(
                    <div
                        className="fixed inset-0 z-[200] flex items-center justify-center p-4 sm:p-6"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="groq-modal-title"
                    >
                        <button
                            type="button"
                            className="absolute inset-0 bg-slate-950/55 backdrop-blur-[6px]"
                            aria-label="Close dialog"
                            onClick={closeGroqModal}
                        />
                        <div
                            className="relative z-[1] w-full max-w-lg rounded-2xl border border-border bg-surface shadow-[0_24px_80px_rgba(15,23,42,0.35)] overflow-hidden animate-scale-in"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative px-6 pt-5 pb-4 border-b border-border bg-linear-to-r from-[rgba(56,182,255,0.1)] via-[rgba(56,182,255,0.05)] to-transparent">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className="h-11 w-11 rounded-xl bg-linear-to-br from-[rgba(56,182,255,0.2)] to-blue-600/10 text-(--vb-blue) border border-[rgba(56,182,255,0.2)] flex items-center justify-center shrink-0">
                                            <KeyRound size={20} />
                                        </div>
                                        <div className="min-w-0">
                                            <h2 id="groq-modal-title" className="text-base font-bold text-foreground tracking-tight">
                                                Company Groq API Key
                                            </h2>
                                            <p className="text-xs text-foreground-muted mt-0.5 truncate">
                                                {groqModalOrg.orgName}
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={closeGroqModal}
                                        disabled={groqKeySaving || groqKeyDeleting}
                                        className="p-2 rounded-xl hover:bg-surface-3 transition-colors disabled:opacity-50"
                                        aria-label="Close"
                                    >
                                        <X size={16} className="text-foreground-muted" />
                                    </button>
                                </div>
                            </div>

                            <form onSubmit={saveGroqKey} className="px-6 py-5 space-y-4">
                                {groqKeyError && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-error-muted border border-[rgba(248,113,113,0.25)] text-sm text-error">
                                        <X size={14} className="shrink-0" />
                                        {groqKeyError}
                                    </div>
                                )}
                                {groqKeySuccess && (
                                    <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-sm text-emerald-400">
                                        <KeyRound size={14} className="shrink-0" />
                                        {groqKeySuccess}
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <label className={labelClass}>Current Key</label>
                                    <div className="h-11 px-3.5 rounded-xl text-sm bg-surface-2 border border-border text-foreground-muted flex items-center font-mono">
                                        {groqModalOrg.currentKeyMasked || "No Groq API Key configured"}
                                    </div>
                                </div>

                                <div className="space-y-2">
                                    <label className={labelClass}>New Groq API Key</label>
                                    <input
                                        type="password"
                                        required
                                        value={groqApiKeyInput}
                                        onChange={(e) => setGroqApiKeyInput(e.target.value)}
                                        className={fieldClass}
                                        placeholder="gsk_..."
                                        autoComplete="off"
                                    />
                                    <p className="text-[11px] text-foreground-muted">
                                        Enter a valid Groq API key (starts with <code className="font-mono text-(--vb-blue-bright)">gsk_</code>).
                                    </p>
                                </div>

                                <div className="flex items-center justify-between gap-3 pt-4 border-t border-border">
                                    {groqModalOrg.currentKeyMasked ? (
                                        <button
                                            type="button"
                                            onClick={deleteGroqKey}
                                            disabled={groqKeySaving || groqKeyDeleting}
                                            className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 text-error hover:bg-error-muted disabled:opacity-50 inline-flex items-center gap-1.5"
                                        >
                                            {groqKeyDeleting ? (
                                                <Loader2 size={14} className="animate-spin" />
                                            ) : (
                                                <Trash2 size={14} />
                                            )}
                                            Delete Key
                                        </button>
                                    ) : (
                                        <div />
                                    )}

                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={closeGroqModal}
                                            disabled={groqKeySaving || groqKeyDeleting}
                                            className="btn-secondary rounded-xl px-4 py-2.5 text-sm min-h-10 disabled:opacity-50"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={groqKeySaving || groqKeyDeleting}
                                            className="btn-primary rounded-xl px-5 py-2.5 text-sm inline-flex items-center gap-2 min-h-10 disabled:opacity-50"
                                        >
                                            {groqKeySaving && <Loader2 size={14} className="animate-spin" />}
                                            {groqKeySaving ? "Saving…" : "Save Groq Key"}
                                        </button>
                                    </div>
                                </div>
                            </form>
                        </div>
                    </div>,
                    document.body
                )}
        </div>
    );
}

export default function AdminsPage() {
    return <AdminsContent />;
}
