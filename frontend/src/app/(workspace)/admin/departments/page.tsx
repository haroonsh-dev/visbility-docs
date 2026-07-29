"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    Building2,
    Check,
    Eye,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Shield,
    Trash2,
    UserCheck,
    UserX,
    Users,
    FileType,
    ChevronRight,
    X,
} from "lucide-react";
import { useToast } from "@/components/Toast";
import { Badge, Button, EmptyState, PageHeader } from "@/components/ui";
import { apiRequest } from "@/lib/apiClient";
import { cn } from "@/lib/utils";

type Department = {
    departmentId: string;
    name: string;
    slug: string;
    description?: string;
    allowedDocumentTypes: string[];
    memberCount?: number;
};

type OrgRole = {
    roleId: string;
    name: string;
    description?: string;
    isLeader: boolean;
    rank?: number;
    isSystem?: boolean;
    permissions: Record<string, boolean>;
};

type Member = {
    userId: string;
    fullName: string;
    email: string;
    primaryDepartmentId?: string | null;
    orgRoleId?: string | null;
    status?: string;
};

const ROLE_PAGE_LABELS: { key: string; label: string; hint: string }[] = [
    { key: "page.dashboard", label: "Dashboard", hint: "Home overview page" },
    { key: "page.documents", label: "Documents", hint: "Document library page" },
    { key: "page.chat", label: "AI Chat", hint: "Chat page (also needs Chat permission)" },
    { key: "page.activity", label: "Activity", hint: "Activity log page" },
    { key: "page.departments", label: "Department pages", hint: "Department overview under Documents" },
];

const ROLE_FEATURE_LABELS: { key: string; label: string; hint: string }[] = [
    { key: "document.upload", label: "Upload documents", hint: "Add files to the library" },
    { key: "document.view", label: "View documents", hint: "Browse and open files" },
    { key: "document.preview", label: "Preview documents", hint: "Open file previews" },
    { key: "document.delete", label: "Delete documents", hint: "Remove files" },
    { key: "document.share", label: "Share documents", hint: "Allow others to see private leader files" },
    { key: "chat.use", label: "Use AI Chat", hint: "Ask questions about documents" },
    { key: "department.view", label: "View department", hint: "See department info when page is allowed" },
    { key: "department.manage", label: "Manage department", hint: "Add/edit members and department settings" },
    { key: "org.documents.view", label: "View all org documents", hint: "See every document in the organization" },
];

const ROLE_PERM_LABELS = [...ROLE_PAGE_LABELS, ...ROLE_FEATURE_LABELS];

const RANK_OPTIONS = [
    { value: 1, label: "1 — Employee" },
    { value: 2, label: "2 — Leader" },
    { value: 3, label: "3 — Manager" },
    { value: 4, label: "4 — Custom" },
];

function rankBadgeLabel(rank?: number, isLeader?: boolean) {
    if (rank === 3) return "Manager";
    if (rank === 2 || isLeader) return "Leader";
    if (rank === 1) return "Employee";
    if (rank && rank > 3) return `Rank ${rank}`;
    return null;
}

const DOC_TYPE_LABELS: Record<string, string> = {
    resume: "Resume / CV",
    hr_document: "HR document",
    invoice: "Invoice",
    purchase_order: "Purchase order",
    quotation: "Quotation",
    financial_statement: "Financial statement",
    contract: "Contract",
    transcript: "Transcript",
    audit_report: "Audit report",
    quality_report: "Quality report",
    certificate: "Certificate",
    sop: "SOP",
    maintenance_report: "Maintenance report",
    engineering_drawing: "Engineering drawing",
    other: "Other",
};

function typeLabel(t: string) {
    return DOC_TYPE_LABELS[t] || t.replace(/_/g, " ");
}

function defaultPerms(): Record<string, boolean> {
    const off = new Set([
        "document.share",
        "org.documents.view",
        "department.manage",
        "page.activity",
        "page.departments",
    ]);
    return Object.fromEntries(ROLE_PERM_LABELS.map((p) => [p.key, !off.has(p.key)]));
}

function permsFromRole(r: OrgRole): Record<string, boolean> {
    const base = defaultPerms();
    for (const p of ROLE_PERM_LABELS) {
        if (typeof r.permissions?.[p.key] === "boolean") base[p.key] = !!r.permissions[p.key];
    }
    return base;
}

function fieldClass() {
    return "w-full h-11 px-3.5 rounded-[var(--radius-md)] text-sm bg-[var(--surface-2)] border border-[var(--border)] text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[rgba(45,212,191,0.2)] transition-shadow";
}

function DocTypePicker({
    knownTypes,
    selected,
    onToggle,
}: {
    knownTypes: string[];
    selected: string[];
    onToggle: (t: string) => void;
}) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-56 overflow-y-auto pr-1">
            {knownTypes.map((t) => {
                const on = selected.includes(t);
                return (
                    <button
                        key={t}
                        type="button"
                        onClick={() => onToggle(t)}
                        className={cn(
                            "flex items-center gap-2 text-left px-3 py-2.5 rounded-[var(--radius-md)] border text-xs font-medium transition-colors",
                            on
                                ? "border-[rgba(45,212,191,0.4)] bg-[var(--accent-muted)] text-[var(--accent)]"
                                : "border-[var(--border)] bg-[var(--surface-2)] text-[var(--foreground-secondary)] hover:border-[var(--border-strong)]"
                        )}
                    >
                        <span
                            className={cn(
                                "h-4 w-4 rounded shrink-0 flex items-center justify-center border",
                                on ? "bg-[var(--accent)] border-[var(--accent)] text-[#042f2e]" : "border-[var(--border-strong)]"
                            )}
                        >
                            {on && <Check className="h-3 w-3" strokeWidth={3} />}
                        </span>
                        <span className="truncate">{typeLabel(t)}</span>
                    </button>
                );
            })}
        </div>
    );
}

function PermPicker({
    labels,
    permissions,
    onChange,
}: {
    labels: { key: string; label: string; hint: string }[];
    permissions: Record<string, boolean>;
    onChange: (next: Record<string, boolean>) => void;
}) {
    return (
        <div className="grid sm:grid-cols-2 gap-2">
            {labels.map((p) => (
                <label
                    key={p.key}
                    className={cn(
                        "flex items-start gap-3 p-3 rounded-[var(--radius-md)] border cursor-pointer transition-colors",
                        permissions[p.key]
                            ? "border-[rgba(45,212,191,0.35)] bg-[var(--accent-muted)]"
                            : "border-[var(--border)] bg-[var(--surface-2)] hover:border-[var(--border-strong)]"
                    )}
                >
                    <input
                        type="checkbox"
                        className="mt-0.5 accent-[var(--accent)]"
                        checked={!!permissions[p.key]}
                        onChange={(e) =>
                            onChange({
                                ...permissions,
                                [p.key]: e.target.checked,
                                ...(p.key === "document.view" ? { "document.preview": e.target.checked } : {}),
                            })
                        }
                    />
                    <span>
                        <span className="block text-xs font-semibold text-[var(--foreground)]">{p.label}</span>
                        <span className="block text-[10px] text-[var(--foreground-muted)] mt-0.5">{p.hint}</span>
                    </span>
                </label>
            ))}
        </div>
    );
}

function DepartmentsAdminContent() {
    const { showToast } = useToast();
    const [tab, setTab] = useState<"departments" | "roles" | "members">("departments");
    const [departments, setDepartments] = useState<Department[]>([]);
    const [roles, setRoles] = useState<OrgRole[]>([]);
    const [teamMembers, setTeamMembers] = useState<Member[]>([]);
    const [knownTypes, setKnownTypes] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [editingDeptId, setEditingDeptId] = useState<string | null>(null);
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
    const [editingMemberId, setEditingMemberId] = useState<string | null>(null);

    const [deptForm, setDeptForm] = useState({ name: "", description: "", types: [] as string[] });
    const [roleForm, setRoleForm] = useState({
        name: "",
        description: "",
        isLeader: false,
        rank: 1,
        permissions: defaultPerms(),
    });
    const [memberForm, setMemberForm] = useState({
        fullName: "",
        email: "",
        password: "",
        departmentId: "",
        orgRoleId: "",
    });

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const [deptRes, roleRes, teamRes] = await Promise.all([
                apiRequest("/docs/departments"),
                apiRequest("/docs/departments/roles"),
                apiRequest("/docs/team/members").catch(() => ({ data: { members: [] } })),
            ]);
            setDepartments(deptRes?.data?.departments || []);
            setKnownTypes(deptRes?.data?.knownDocumentTypes || []);
            setRoles(roleRes?.data?.roles || []);
            setTeamMembers(teamRes?.data?.members || []);
        } catch (e: any) {
            showToast(e.message || "Failed to load", "error");
        } finally {
            setLoading(false);
        }
    }, [showToast]);

    useEffect(() => {
        load();
    }, [load]);

    const deptNameById = useMemo(
        () => Object.fromEntries(departments.map((d) => [d.departmentId, d.name])),
        [departments]
    );
    const roleNameById = useMemo(
        () => Object.fromEntries(roles.map((r) => [r.roleId, r.name])),
        [roles]
    );

    const resetDeptForm = () => {
        setEditingDeptId(null);
        setDeptForm({ name: "", description: "", types: [] });
    };
    const resetRoleForm = () => {
        setEditingRoleId(null);
        setRoleForm({ name: "", description: "", isLeader: false, rank: 1, permissions: defaultPerms() });
    };
    const resetMemberForm = () => {
        setEditingMemberId(null);
        setMemberForm({ fullName: "", email: "", password: "", departmentId: "", orgRoleId: "" });
    };

    const startEditDept = (d: Department) => {
        setEditingDeptId(d.departmentId);
        setDeptForm({
            name: d.name,
            description: d.description || "",
            types: [...(d.allowedDocumentTypes || [])],
        });
        setTab("departments");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const startEditRole = (r: OrgRole) => {
        setEditingRoleId(r.roleId);
        setRoleForm({
            name: r.name,
            description: r.description || "",
            isLeader: !!r.isLeader,
            rank: typeof r.rank === "number" && r.rank >= 1 ? r.rank : r.isLeader ? 2 : 1,
            permissions: permsFromRole(r),
        });
        setTab("roles");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const startEditMember = (m: Member) => {
        setEditingMemberId(m.userId);
        setMemberForm({
            fullName: m.fullName,
            email: m.email,
            password: "",
            departmentId: m.primaryDepartmentId || "",
            orgRoleId: m.orgRoleId || "",
        });
        setTab("members");
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const saveDepartment = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!deptForm.types.length) {
            showToast("Select at least one document type this department manages", "error");
            return;
        }
        setSaving(true);
        try {
            const body = {
                name: deptForm.name,
                description: deptForm.description,
                allowedDocumentTypes: deptForm.types,
            };
            if (editingDeptId) {
                await apiRequest(`/docs/departments/${editingDeptId}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Department updated", "success");
            } else {
                await apiRequest("/docs/departments", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Department created", "success");
            }
            resetDeptForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const deleteDepartment = async (id: string) => {
        if (!confirm("Delete this department and unassign its members?")) return;
        try {
            await apiRequest(`/docs/departments/${id}`, { method: "DELETE" });
            if (editingDeptId === id) resetDeptForm();
            showToast("Department deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const saveRole = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        try {
            const permissions = { ...roleForm.permissions };
            permissions["document.preview"] = permissions["document.view"] === true;
            const body = {
                name: roleForm.name,
                description: roleForm.description,
                isLeader: roleForm.isLeader,
                rank: roleForm.rank,
                permissions,
            };
            if (editingRoleId) {
                await apiRequest(`/docs/departments/roles/${editingRoleId}`, {
                    method: "PATCH",
                    body: JSON.stringify(body),
                });
                showToast("Role updated — permissions synced to members", "success");
            } else {
                await apiRequest("/docs/departments/roles", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                showToast("Role created", "success");
            }
            resetRoleForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const deleteRole = async (id: string) => {
        if (!confirm("Delete this role? Members using it must be reassigned first.")) return;
        try {
            await apiRequest(`/docs/departments/roles/${id}`, { method: "DELETE" });
            if (editingRoleId === id) resetRoleForm();
            showToast("Role deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const saveMember = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!memberForm.departmentId || !memberForm.orgRoleId) {
            showToast("Select department and role", "error");
            return;
        }
        setSaving(true);
        try {
            if (editingMemberId) {
                await apiRequest(`/docs/team/members/${editingMemberId}`, {
                    method: "PUT",
                    body: JSON.stringify({
                        fullName: memberForm.fullName,
                        email: memberForm.email,
                        ...(memberForm.password ? { password: memberForm.password } : {}),
                    }),
                });
                await apiRequest(`/docs/departments/${memberForm.departmentId}/members`, {
                    method: "POST",
                    body: JSON.stringify({
                        userId: editingMemberId,
                        orgRoleId: memberForm.orgRoleId,
                    }),
                });
                showToast("Member updated", "success");
            } else {
                if (!memberForm.password || memberForm.password.length < 6) {
                    showToast("Password must be at least 6 characters", "error");
                    setSaving(false);
                    return;
                }
                const created = await apiRequest("/docs/team/members", {
                    method: "POST",
                    body: JSON.stringify({
                        fullName: memberForm.fullName,
                        email: memberForm.email,
                        password: memberForm.password,
                    }),
                });
                const userId =
                    created?.data?.member?.userId ||
                    created?.data?.user?.userId ||
                    created?.data?.userId;
                if (!userId) throw new Error("Member created but userId missing");
                await apiRequest(`/docs/departments/${memberForm.departmentId}/members`, {
                    method: "POST",
                    body: JSON.stringify({
                        userId,
                        orgRoleId: memberForm.orgRoleId,
                    }),
                });
                showToast("Team member added", "success");
            }
            resetMemberForm();
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        } finally {
            setSaving(false);
        }
    };

    const removeFromDepartment = async (m: Member) => {
        if (!m.primaryDepartmentId) return;
        if (!confirm(`Remove ${m.fullName} from ${deptNameById[m.primaryDepartmentId] || "department"}?`)) return;
        try {
            await apiRequest(`/docs/departments/${m.primaryDepartmentId}/members/${m.userId}`, {
                method: "DELETE",
            });
            if (editingMemberId === m.userId) resetMemberForm();
            showToast("Removed from department", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const toggleMemberStatus = async (m: Member) => {
        const next = m.status === "active" ? "blocked" : "active";
        try {
            await apiRequest(`/docs/team/members/${m.userId}/status`, {
                method: "PATCH",
                body: JSON.stringify({ status: next }),
            });
            showToast(next === "blocked" ? "Member blocked" : "Member activated", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const deleteMember = async (m: Member) => {
        if (!confirm(`Permanently delete ${m.fullName}? Their account will be removed.`)) return;
        try {
            if (m.primaryDepartmentId) {
                await apiRequest(`/docs/departments/${m.primaryDepartmentId}/members/${m.userId}`, {
                    method: "DELETE",
                }).catch(() => null);
            }
            await apiRequest(`/docs/team/members/${m.userId}`, { method: "DELETE" });
            if (editingMemberId === m.userId) resetMemberForm();
            showToast("Member deleted", "success");
            await load();
        } catch (err: any) {
            showToast(err.message || "Failed", "error");
        }
    };

    const toggleType = (t: string) => {
        setDeptForm((f) => ({
            ...f,
            types: f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t],
        }));
    };

    const tabs = [
        { id: "departments" as const, label: "Departments", icon: Building2, desc: "Units & document types" },
        { id: "roles" as const, label: "Roles", icon: Shield, desc: "Permissions" },
        { id: "members" as const, label: "Members", icon: Users, desc: "People & assignments" },
    ];

    return (
        <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto">
            <PageHeader
                title="Departments"
                subtitle="Create departments, define roles with permissions, and manage team members — including edit, block, and remove."
                actions={
                    <Button variant="secondary" onClick={load} disabled={loading}>
                        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                        Refresh
                    </Button>
                }
            />

            <div className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3">
                {tabs.map((t) => {
                    const active = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            onClick={() => setTab(t.id)}
                            className={cn(
                                "text-left rounded-[var(--radius-xl)] border p-4 transition-all duration-200",
                                active
                                    ? "border-[rgba(45,212,191,0.45)] bg-[var(--accent-muted)] shadow-[0_0_0_1px_rgba(45,212,191,0.15)]"
                                    : "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]"
                            )}
                        >
                            <div className="flex items-center gap-3">
                                <span
                                    className={cn(
                                        "h-10 w-10 rounded-[var(--radius-md)] flex items-center justify-center",
                                        active
                                            ? "bg-[var(--accent)] text-[#042f2e]"
                                            : "bg-[var(--surface-3)] text-[var(--foreground-muted)]"
                                    )}
                                >
                                    <t.icon className="h-4 w-4" />
                                </span>
                                <div>
                                    <p className="text-sm font-semibold text-[var(--foreground)]">{t.label}</p>
                                    <p className="text-[11px] text-[var(--foreground-muted)] mt-0.5">{t.desc}</p>
                                </div>
                            </div>
                        </button>
                    );
                })}
            </div>

            {loading ? (
                <div className="flex justify-center py-24">
                    <Loader2 className="h-8 w-8 animate-spin text-[var(--accent)]" />
                </div>
            ) : (
                <div className="mt-8">
                    {tab === "departments" && (
                        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
                            <form onSubmit={saveDepartment} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-[var(--foreground)]">
                                            {editingDeptId ? "Update department" : "Create department"}
                                        </h3>
                                        <p className="text-xs text-[var(--foreground-muted)] mt-1">
                                            Choose which document types this department manages. Other types go to personal vault.
                                        </p>
                                    </div>
                                    {editingDeptId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetDeptForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Name</label>
                                    <input
                                        required
                                        placeholder="e.g. HR, Finance, Legal"
                                        value={deptForm.name}
                                        onChange={(e) => setDeptForm({ ...deptForm, name: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Description</label>
                                    <textarea
                                        placeholder="Optional short description"
                                        value={deptForm.description}
                                        onChange={(e) => setDeptForm({ ...deptForm, description: e.target.value })}
                                        className={cn(fieldClass(), "h-24 py-3 resize-none")}
                                    />
                                </div>

                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <FileType className="h-3.5 w-3.5 text-[var(--accent)]" />
                                        <label className="text-xs font-medium text-[var(--foreground-secondary)]">
                                            Document types managed
                                        </label>
                                    </div>
                                    <DocTypePicker knownTypes={knownTypes} selected={deptForm.types} onToggle={toggleType} />
                                </div>

                                <Button type="submit" disabled={saving} className="w-full sm:w-auto">
                                    {editingDeptId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save changes
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Create department
                                        </>
                                    )}
                                </Button>
                            </form>

                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-[var(--foreground)] px-1">
                                    Your departments ({departments.length})
                                </h3>
                                {!departments.length ? (
                                    <EmptyState
                                        icon={<Building2 size={20} />}
                                        title="No departments yet"
                                        description="Create HR, Finance, or any unit and pick the document types it manages."
                                    />
                                ) : (
                                    departments.map((d) => (
                                        <div key={d.departmentId} className="surface-card p-4 flex gap-3 items-start group">
                                            <div className="h-10 w-10 rounded-[var(--radius-md)] bg-[var(--accent-muted)] text-[var(--accent)] flex items-center justify-center shrink-0">
                                                <Building2 className="h-4 w-4" />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-start justify-between gap-2">
                                                    <div>
                                                        <Link
                                                            href={`/departments/${d.departmentId}`}
                                                            className="font-semibold text-[var(--foreground)] hover:text-[var(--accent)] inline-flex items-center gap-1"
                                                        >
                                                            {d.name}
                                                            <ChevronRight className="h-3.5 w-3.5 opacity-50" />
                                                        </Link>
                                                        <p className="text-[11px] text-[var(--foreground-muted)] mt-0.5">
                                                            {d.memberCount || 0} members
                                                            {editingDeptId === d.departmentId ? " · editing" : ""}
                                                        </p>
                                                    </div>
                                                    <div className="flex items-center gap-0.5 shrink-0">
                                                        <button
                                                            type="button"
                                                            onClick={() => startEditDept(d)}
                                                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-muted)]"
                                                            aria-label="Edit department"
                                                        >
                                                            <Pencil className="h-4 w-4" />
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => deleteDepartment(d.departmentId)}
                                                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--error)] hover:bg-[var(--error-muted)]"
                                                            aria-label="Delete department"
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </button>
                                                    </div>
                                                </div>
                                                <div className="flex flex-wrap gap-1.5 mt-3">
                                                    {(d.allowedDocumentTypes || []).length ? (
                                                        d.allowedDocumentTypes.map((t) => (
                                                            <Badge key={t} variant="accent">
                                                                {typeLabel(t)}
                                                            </Badge>
                                                        ))
                                                    ) : (
                                                        <Badge variant="muted">No types</Badge>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    )}

                    {tab === "roles" && (
                        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
                            <form onSubmit={saveRole} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-[var(--foreground)]">
                                            {editingRoleId ? "Update role" : "Create role"}
                                        </h3>
                                        <p className="text-xs text-[var(--foreground-muted)] mt-1">
                                            Set permissions for this role. Updates sync to members already using it.
                                        </p>
                                    </div>
                                    {editingRoleId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetRoleForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Role name</label>
                                    <input
                                        required
                                        placeholder="e.g. Team Lead, Recruiter"
                                        value={roleForm.name}
                                        onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Description</label>
                                    <input
                                        placeholder="Optional"
                                        value={roleForm.description}
                                        onChange={(e) => setRoleForm({ ...roleForm, description: e.target.value })}
                                        className={fieldClass()}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">
                                        Hierarchy rank
                                    </label>
                                    <select
                                        value={roleForm.rank}
                                        onChange={(e) => {
                                            const rank = Number(e.target.value) || 1;
                                            setRoleForm({
                                                ...roleForm,
                                                rank,
                                                isLeader: rank === 2 ? true : rank === 1 ? false : roleForm.isLeader,
                                            });
                                        }}
                                        className={fieldClass()}
                                    >
                                        {RANK_OPTIONS.map((o) => (
                                            <option key={o.value} value={o.value}>
                                                {o.label}
                                            </option>
                                        ))}
                                    </select>
                                    <p className="text-[10px] text-[var(--foreground-muted)]">
                                        Employee (1) → Leader (2) → Manager (3). Higher ranks can get broader page access.
                                    </p>
                                </div>

                                <label className="flex items-start gap-3 p-3.5 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-2)] cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="mt-1 accent-[var(--accent)]"
                                        checked={roleForm.isLeader}
                                        onChange={(e) => setRoleForm({ ...roleForm, isLeader: e.target.checked })}
                                    />
                                    <span>
                                        <span className="block text-sm font-medium text-[var(--foreground)]">Leader role</span>
                                        <span className="block text-[11px] text-[var(--foreground-muted)] mt-0.5">
                                            Department files stay private to peers until the leader shares them.
                                        </span>
                                    </span>
                                </label>

                                <div>
                                    <p className="text-xs font-medium text-[var(--foreground-secondary)] mb-3">
                                        Pages this role can open
                                    </p>
                                    <PermPicker
                                        labels={ROLE_PAGE_LABELS}
                                        permissions={roleForm.permissions}
                                        onChange={(permissions) => setRoleForm({ ...roleForm, permissions })}
                                    />
                                </div>

                                <div>
                                    <p className="text-xs font-medium text-[var(--foreground-secondary)] mb-3">
                                        Feature permissions
                                    </p>
                                    <PermPicker
                                        labels={ROLE_FEATURE_LABELS}
                                        permissions={roleForm.permissions}
                                        onChange={(permissions) => setRoleForm({ ...roleForm, permissions })}
                                    />
                                </div>

                                <Button type="submit" disabled={saving}>
                                    {editingRoleId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save role
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Create role
                                        </>
                                    )}
                                </Button>
                            </form>

                            <div className="space-y-3">
                                <h3 className="text-sm font-semibold text-[var(--foreground)] px-1">
                                    Roles ({roles.length})
                                </h3>
                                {roles.map((r) => (
                                    <div key={r.roleId} className="surface-card p-4">
                                        <div className="flex items-start justify-between gap-2">
                                            <div>
                                                <div className="flex items-center gap-2 flex-wrap">
                                                    <span className="font-semibold text-[var(--foreground)]">{r.name}</span>
                                                    {rankBadgeLabel(r.rank, r.isLeader) && (
                                                        <Badge variant="accent">
                                                            {rankBadgeLabel(r.rank, r.isLeader)}
                                                        </Badge>
                                                    )}
                                                    {r.isLeader && r.rank !== 2 && (
                                                        <Badge variant="warning">Leader flag</Badge>
                                                    )}
                                                    {r.isSystem && <Badge variant="muted">Default</Badge>}
                                                    {editingRoleId === r.roleId && <Badge variant="warning">Editing</Badge>}
                                                </div>
                                                <p className="text-[11px] text-[var(--foreground-muted)] mt-1">
                                                    {r.description || "No description"}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-0.5 shrink-0">
                                                <button
                                                    type="button"
                                                    onClick={() => startEditRole(r)}
                                                    className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-muted)]"
                                                    aria-label="Edit role"
                                                >
                                                    <Pencil className="h-4 w-4" />
                                                </button>
                                                {!r.isSystem && (
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteRole(r.roleId)}
                                                        className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--error)] hover:bg-[var(--error-muted)]"
                                                        aria-label="Delete role"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5 mt-3">
                                            {ROLE_PERM_LABELS.filter((p) => r.permissions?.[p.key]).map((p) => (
                                                <Badge key={p.key} variant="default">
                                                    {p.label}
                                                </Badge>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {tab === "members" && (
                        <div className="grid gap-6 lg:grid-cols-2">
                            <form onSubmit={saveMember} className="surface-card p-6 space-y-5">
                                <div className="flex items-start justify-between gap-3">
                                    <div>
                                        <h3 className="text-base font-semibold text-[var(--foreground)]">
                                            {editingMemberId ? "Update member" : "Add team member"}
                                        </h3>
                                        <p className="text-xs text-[var(--foreground-muted)] mt-1">
                                            {editingMemberId
                                                ? "Change details, department, role, or password."
                                                : "Create a person and assign department + role."}
                                        </p>
                                    </div>
                                    {editingMemberId && (
                                        <Button type="button" variant="ghost" size="sm" onClick={resetMemberForm}>
                                            <X className="h-4 w-4" />
                                            Cancel
                                        </Button>
                                    )}
                                </div>

                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Full name</label>
                                    <input
                                        required
                                        value={memberForm.fullName}
                                        onChange={(e) => setMemberForm({ ...memberForm, fullName: e.target.value })}
                                        className={fieldClass()}
                                        placeholder="Full name"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">Email</label>
                                    <input
                                        required
                                        type="email"
                                        value={memberForm.email}
                                        onChange={(e) => setMemberForm({ ...memberForm, email: e.target.value })}
                                        className={fieldClass()}
                                        placeholder="name@company.com"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <label className="text-xs font-medium text-[var(--foreground-secondary)]">
                                        {editingMemberId ? "New password (optional)" : "Password"}
                                    </label>
                                    <input
                                        type="password"
                                        minLength={editingMemberId ? undefined : 6}
                                        required={!editingMemberId}
                                        value={memberForm.password}
                                        onChange={(e) => setMemberForm({ ...memberForm, password: e.target.value })}
                                        className={fieldClass()}
                                        placeholder={editingMemberId ? "Leave blank to keep current" : "Min 6 characters"}
                                    />
                                </div>
                                <div className="grid sm:grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-[var(--foreground-secondary)]">Department</label>
                                        <select
                                            required
                                            value={memberForm.departmentId}
                                            onChange={(e) => setMemberForm({ ...memberForm, departmentId: e.target.value })}
                                            className={fieldClass()}
                                        >
                                            <option value="">Select…</option>
                                            {departments.map((d) => (
                                                <option key={d.departmentId} value={d.departmentId}>
                                                    {d.name}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="space-y-1.5">
                                        <label className="text-xs font-medium text-[var(--foreground-secondary)]">Role</label>
                                        <select
                                            required
                                            value={memberForm.orgRoleId}
                                            onChange={(e) => setMemberForm({ ...memberForm, orgRoleId: e.target.value })}
                                            className={fieldClass()}
                                        >
                                            <option value="">Select…</option>
                                            {roles.map((r) => (
                                                <option key={r.roleId} value={r.roleId}>
                                                    {r.name}
                                                    {r.isLeader ? " (Leader)" : ""}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <Button type="submit" disabled={saving || !departments.length || !roles.length}>
                                    {editingMemberId ? (
                                        <>
                                            <Check className="h-4 w-4" />
                                            Save member
                                        </>
                                    ) : (
                                        <>
                                            <Plus className="h-4 w-4" />
                                            Add member
                                        </>
                                    )}
                                </Button>
                                {(!departments.length || !roles.length) && (
                                    <p className="text-[11px] text-[var(--warning)]">
                                        Create at least one department and role first.
                                    </p>
                                )}
                            </form>

                            <div>
                                <div className="flex items-center justify-between px-1 mb-3">
                                    <h3 className="text-sm font-semibold text-[var(--foreground)]">
                                        Current members ({teamMembers.length})
                                    </h3>
                                    {teamMembers.length > 0 && (
                                        <div className="flex items-center gap-2 text-[11px] text-[var(--foreground-muted)]">
                                            <span className="inline-flex items-center gap-1">
                                                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                                                {teamMembers.filter((m) => m.status === "active").length} active
                                            </span>
                                            <span className="inline-flex items-center gap-1">
                                                <span className="w-2 h-2 rounded-full bg-rose-400" />
                                                {teamMembers.filter((m) => m.status === "blocked").length} blocked
                                            </span>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    {teamMembers.map((m) => {
                                        const avatarColors = [
                                            "bg-rose-500/20 text-rose-400",
                                            "bg-blue-500/20 text-blue-400",
                                            "bg-emerald-500/20 text-emerald-400",
                                            "bg-amber-500/20 text-amber-400",
                                            "bg-violet-500/20 text-violet-400",
                                            "bg-cyan-500/20 text-cyan-400",
                                        ];
                                        let hash = 0;
                                        for (let i = 0; i < m.fullName.length; i++) hash = m.fullName.charCodeAt(i) + ((hash << 5) - hash);
                                        const colorClass = avatarColors[Math.abs(hash) % avatarColors.length];
                                        const initials = m.fullName.trim().split(/\s+/).length >= 2
                                            ? (m.fullName.trim().split(/\s+/)[0][0] + m.fullName.trim().split(/\s+/)[1][0]).toUpperCase()
                                            : (m.fullName.trim()[0] || "?").toUpperCase();

                                        return (
                                            <div key={m.userId} className="surface-card px-4 py-3 flex items-start gap-3 hover:border-[var(--border-strong)] transition-colors">
                                                <div className={`h-10 w-10 rounded-xl ${colorClass} flex items-center justify-center shrink-0 font-semibold text-sm`}>
                                                    {initials}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <p className="text-sm font-medium text-[var(--foreground)] truncate">
                                                            {m.fullName}
                                                        </p>
                                                        {m.status === "blocked" && <Badge variant="error">Blocked</Badge>}
                                                        {editingMemberId === m.userId && (
                                                            <Badge variant="warning">Editing</Badge>
                                                        )}
                                                    </div>
                                                    <p className="text-[11px] text-[var(--foreground-muted)] truncate">{m.email}</p>
                                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                                        <Badge variant={m.primaryDepartmentId ? "accent" : "muted"}>
                                                            <Building2 size={10} />
                                                            {m.primaryDepartmentId
                                                                ? deptNameById[m.primaryDepartmentId] || "Assigned"
                                                                : "No department"}
                                                        </Badge>
                                                        {m.orgRoleId && (
                                                            <Badge variant={roles.find((r) => r.roleId === m.orgRoleId)?.isLeader ? "warning" : "default"}>
                                                                {roleNameById[m.orgRoleId] || "Role"}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-0.5 shrink-0">
                                                    {m.primaryDepartmentId && (
                                                        <Link
                                                            href={`/departments/${m.primaryDepartmentId}/members/${m.userId}`}
                                                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-muted)]"
                                                            title="View employee details"
                                                        >
                                                            <Eye className="h-4 w-4" />
                                                        </Link>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => startEditMember(m)}
                                                        className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent)] hover:bg-[var(--accent-muted)]"
                                                        title="Edit"
                                                    >
                                                        <Pencil className="h-4 w-4" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => toggleMemberStatus(m)}
                                                        className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--warning)] hover:bg-[var(--warning-muted)]"
                                                        title={m.status === "blocked" ? "Activate" : "Block"}
                                                    >
                                                        {m.status === "blocked" ? (
                                                            <UserCheck className="h-4 w-4" />
                                                        ) : (
                                                            <UserX className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                    {m.primaryDepartmentId && (
                                                        <button
                                                            type="button"
                                                            onClick={() => removeFromDepartment(m)}
                                                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface-3)]"
                                                            title="Remove from department"
                                                        >
                                                            <Building2 className="h-4 w-4" />
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => deleteMember(m)}
                                                        className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--error)] hover:bg-[var(--error-muted)]"
                                                        title="Delete member"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                    {!teamMembers.length && (
                                        <EmptyState
                                            icon={<Users size={24} className="text-[var(--accent)]" />}
                                            title="No members yet"
                                            description="Add team members above to populate this list."
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default function DepartmentsAdminPage() {
    return (
        <DepartmentsAdminContent />
    );
}
