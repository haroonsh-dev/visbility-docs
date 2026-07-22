"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    ChevronDown,
    ChevronRight,
    Clock,
    Mail,
    Phone,
    Building2,
    RefreshCw,
    Search,
    Shield,
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

const AVATAR_COLORS = [
    "bg-rose-500/20 text-rose-400",
    "bg-blue-500/20 text-blue-400",
    "bg-emerald-500/20 text-emerald-400",
    "bg-amber-500/20 text-amber-400",
    "bg-violet-500/20 text-violet-400",
    "bg-cyan-500/20 text-cyan-400",
    "bg-pink-500/20 text-pink-400",
    "bg-lime-500/20 text-lime-400",
];

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

function permSummary(permissions?: Record<string, boolean>) {
    if (!permissions) return [];
    return Object.entries(permissions)
        .filter(([, v]) => v)
        .map(([k]) => k.replace(/^document\./, "").replace(/^chat\./, "chat ").replace(/^team\./, "team ").replace(/^org\./, "org "));
}

function AdminsContent() {
    const { theme } = useTheme();
    const colors = theme.colors;
    const [admins, setAdmins] = useState<Admin[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [searchQuery, setSearchQuery] = useState("");

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

    const toggleStatus = async (userId: string, status: string) => {
        const next = status === "active" ? "blocked" : "active";
        await apiRequest(`/docs/super-admin/admins/${userId}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: next }),
        });
        await load();
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
                    <button
                        type="button"
                        onClick={load}
                        className="btn-secondary rounded-xl px-4 py-2 text-sm inline-flex items-center gap-2 min-h-10"
                    >
                        <RefreshCw size={14} /> Refresh
                    </button>
                }
            />

            {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-[var(--error-muted)] border border-[rgba(248,113,113,0.25)] text-sm text-[var(--error)]">
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
                            color: "text-[var(--accent)]",
                            bg: "bg-[var(--accent-muted)]",
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
                                <p className="text-2xl font-bold tracking-tight text-[var(--foreground)] tabular-nums font-mono">
                                    {s.value}
                                </p>
                                <p className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wide font-medium">
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
                    <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)]" />
                    <input
                        type="text"
                        placeholder="Search admins by name, email, or organization..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full h-11 pl-10 pr-10 rounded-xl text-sm bg-[var(--surface)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(45,212,191,0.15)] transition-shadow"
                    />
                    {searchQuery && (
                        <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
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
                            icon={<Shield size={28} className="text-[var(--accent)]" />}
                            title={searchQuery ? "No matching admins" : "No admins yet"}
                            description={
                                searchQuery
                                    ? `No admins match "${searchQuery}". Try a different search.`
                                    : "Company admins will appear here with their team details."
                            }
                        />
                    </div>
                ) : (
                    <ul className="divide-y divide-[var(--border)]">
                        {filtered.map((a) => {
                            const open = !!expanded[a.userId];
                            const members = a.teamMembers || [];
                            const memberCount = a.teamMemberCount ?? members.length;
                            const perms = permSummary(a.teamMembers?.[0]?.permissions);
                            const loginAgo = timeAgo(a.lastLogin);

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
                                                {/* Avatar */}
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
                                            <div className="flex items-center gap-2 shrink-0">
                                                <span className="text-[var(--foreground-muted)]">
                                                    {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => toggleStatus(a.userId, a.status)}
                                                    className="btn-secondary rounded-lg px-3 py-2 text-sm min-h-10"
                                                >
                                                    {a.status === "active" ? (
                                                        <>
                                                            <UserX size={14} className="inline" /> Block
                                                        </>
                                                    ) : (
                                                        <>
                                                            <UserCheck size={14} className="inline" /> Activate
                                                        </>
                                                    )}
                                                </button>
                                            </div>
                                        </div>

                                        {/* Expanded Details */}
                                        {open && (
                                            <div className="mt-4 ml-0 sm:ml-14 space-y-4">
                                                {/* Detail Grid */}
                                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                                                    {[
                                                        { label: "Username", value: a.username || "—" },
                                                        { label: "Account", value: a.accountType || "—" },
                                                        { label: "Created", value: formatDate(a.createdAt) },
                                                        { label: "Last Login", value: formatDate(a.lastLogin) },
                                                        { label: "Org Plan", value: a.organization?.subscriptionPlan || "—" },
                                                        { label: "Org Status", value: a.organization?.status || "—" },
                                                        { label: "Org Contact", value: a.organization?.contactEmail || "—" },
                                                        { label: "User ID", value: a.userId, mono: true },
                                                    ].map((d) => (
                                                        <div
                                                            key={d.label}
                                                            className="rounded-xl border border-[var(--border)] px-3 py-2.5 bg-[var(--surface-2)]/60"
                                                        >
                                                            <p className="text-[10px] uppercase tracking-wider font-semibold text-[var(--foreground-muted)]">
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

                                                {/* Team Members */}
                                                <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                                                    <div className="px-4 py-3 border-b border-[var(--border)] bg-[var(--surface-2)]/30 flex items-center gap-2">
                                                        <Users size={14} className="text-[var(--accent)]" />
                                                        <p className={`text-sm font-semibold ${colors.textPrimary}`}>
                                                            Team Members ({members.length})
                                                        </p>
                                                    </div>
                                                    {members.length === 0 ? (
                                                        <div className="px-4 py-8 text-center">
                                                            <Users size={24} className="mx-auto mb-2 text-[var(--foreground-muted)] opacity-40" />
                                                            <p className={`text-sm ${colors.textMuted}`}>
                                                                No team members in this organization yet.
                                                            </p>
                                                        </div>
                                                    ) : (
                                                        <ul className="divide-y divide-[var(--border)]">
                                                            {members.map((m) => (
                                                                <li
                                                                    key={m.userId}
                                                                    className="px-4 py-3 flex items-start gap-3 hover:bg-[var(--surface-2)]/30 transition-colors"
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
        </div>
    );
}

export default function AdminsPage() {
    return (
        <AdminsContent />
    );
}
