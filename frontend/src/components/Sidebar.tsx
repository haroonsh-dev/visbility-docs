"use client";

import React, { useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import {
    FileText, MessageSquare, LogOut, Shield, FolderOpen, Activity,
    X, Building2, ChevronDown, Settings, LayoutDashboard, User,
    CreditCard, Plug, Mail,
} from "lucide-react";
import { useTheme } from "@/context/ColorContext";
import { usePermissions } from "@/context/PermissionsContext";
import { clearAuthState, getStoredUser } from "@/lib/authSession";
import { apiRequest } from "@/lib/apiClient";
import SiteLogo from "@/assets/Logo/dark_bg_VB.png";
import { cn } from "@/lib/utils";

type StoredUser = { fullName?: string; email?: string; username?: string; role?: string };
type DeptNav = { departmentId: string; name: string };
type SidebarProps = { open?: boolean; onClose?: () => void };

export default function Sidebar({ open = false, onClose }: SidebarProps) {
    const pathname = usePathname();
    const router = useRouter();
    const { theme } = useTheme();
    const {
        role: permRole,
        canAccessPage,
        ready,
    } = usePermissions();
    // Avoid reading localStorage during SSR/first paint (hydration mismatch)
    const [user, setUser] = React.useState<StoredUser | null>(null);
    const [mounted, setMounted] = React.useState(false);

    React.useEffect(() => {
        setMounted(true);
        setUser(getStoredUser<StoredUser>());
    }, []);

    const role = permRole || user?.role || "team";

    const [deptOpen, setDeptOpen] = React.useState(true);
    const [departments, setDepartments] = React.useState<DeptNav[]>([]);

    useEffect(() => {
        if (!mounted || !ready) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await apiRequest("/docs/departments");
                if (!cancelled) setDepartments(res?.data?.departments || []);
            } catch { if (!cancelled) setDepartments([]); }
        })();
        return () => { cancelled = true; };
    }, [role, mounted, ready]);

    const isSuperAdmin = role === "superAdmin";
    const canSeeDepts =
        role === "admin" ||
        isSuperAdmin ||
        canAccessPage("departments");

    const nav: { href: string; label: string; icon: React.ElementType; roles: string[]; allow?: () => boolean }[] = [
        {
            href: "/dashboard",
            label: "Dashboard",
            icon: LayoutDashboard,
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("dashboard"),
        },
        {
            href: departments[0] ? `/departments/${departments[0].departmentId}` : "/documents",
            label: "Department",
            icon: Building2,
            roles: ["team"],
            allow: () =>
                !canAccessPage("documents") &&
                canAccessPage("departments") &&
                departments.length > 0,
        },
        {
            href: "/documents",
            label: "Documents",
            icon: FileText,
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("documents"),
        },
        { href: "/admin/documents", label: "All Documents", icon: FolderOpen, roles: ["superAdmin"] },
        {
            href: "/chat",
            label: "AI Chat",
            icon: MessageSquare,
            roles: ["superAdmin", "admin", "team", "service_account"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("chat"),
        },
        {
            href: "/admin/departments",
            label: "Departments",
            icon: Building2,
            roles: ["admin", "superAdmin"],
        },
        { href: "/admin/admins", label: "Admins", icon: Shield, roles: ["superAdmin"] },
        { href: "/admin/plans", label: "Plans", icon: CreditCard, roles: ["superAdmin"] },
        { href: "/plans", label: "Plans", icon: CreditCard, roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("plans") },
        { href: "/admin/email-reports", label: "Email reports", icon: Mail, roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("email_reports") },
        { href: "/admin/integrations", label: "Integrations", icon: Plug, roles: ["admin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("integrations") },
        { href: "/admin/settings", label: "AI Settings", icon: Settings, roles: ["admin", "superAdmin", "team"], allow: () => role === "admin" || role === "superAdmin" || canAccessPage("settings") },
        {
            href: "/activity",
            label: "Activity",
            icon: Activity,
            roles: ["superAdmin", "admin", "team"],
            allow: () => role === "admin" || role === "superAdmin" || canAccessPage("activity"),
        },
    ];

    // Until client has hydrated auth, render a stable baseline nav (no permission gates)
    // so server HTML and first client paint match.
    const visibleNav = (!mounted || !ready
        ? nav.filter((n) => n.roles.includes("team") && !n.allow)
        : nav
            .filter((n) => n.roles.includes(role) && (n.allow ? n.allow() : true))
            .filter((n) => !isSuperAdmin || ["/dashboard", "/admin/documents", "/search", "/chat", "/activity", "/admin/admins", "/admin/plans", "/admin/settings"].includes(n.href))
    );
    const logout = () => { clearAuthState(); router.replace("/login"); };

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose?.(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [open, onClose]);

    return (
        <>
            <button type="button"
                className={cn("lg:hidden fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity", open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none")}
                aria-label="Close menu" onClick={onClose} tabIndex={open ? 0 : -1}
            />

            <aside className={cn(
                "w-[220px] h-full app-sidebar flex flex-col overflow-hidden",
                "shadow-[8px_0_32px_rgba(8,20,30,0.45)] relative",
                "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out",
                "lg:static lg:z-10 lg:translate-x-0 lg:shrink-0",
                open ? "translate-x-0" : "-translate-x-full"
            )}>
                {/* Logo */}
                <div className="px-2 py-2 border-b border-white/[0.07] relative z-[1] flex items-center justify-between bg-gradient-to-r from-teal-500/[0.08] via-transparent to-cyan-500/[0.05]">
                    <Link href="/dashboard" className="flex-1 flex items-center justify-center">
                        <Image src={SiteLogo} alt="Visibility Bots" className="h-16 w-auto" priority />
                    </Link>
                    <button type="button" onClick={onClose}
                        className="lg:hidden rounded-lg p-2 min-h-9 min-w-9 flex items-center justify-center shrink-0 text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                        aria-label="Close menu">
                        <X size={16} />
                    </button>
                </div>

                {/* Navigation */}
                <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto relative z-[1]">
                    {visibleNav.map(({ href, label, icon: Icon }) => {
                        const active = pathname === href || pathname?.startsWith(`${href}/`);
                        const showDeptDropdown = href === "/documents" && canSeeDepts && departments.length > 0;
                        return (
                            <div key={href}>
                                <div className="flex items-center gap-1">
                                    <Link href={href} onClick={() => onClose?.()}
                                        className={cn("sidebar-nav-item flex-1", active && !pathname?.startsWith("/departments/") ? "active" : "")}>
                                        <span className={cn("sidebar-icon", active && !pathname?.startsWith("/departments/") ? "active" : "inactive")}>
                                            <Icon size={14} />
                                        </span>
                                        {label}
                                    </Link>
                                    {showDeptDropdown && (
                                        <button type="button" onClick={() => setDeptOpen((o) => !o)}
                                            className="p-1.5 rounded-lg min-h-8 min-w-8 flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
                                            aria-label="Toggle departments">
                                            <ChevronDown size={14} className={cn("transition-transform", deptOpen ? "rotate-180" : "")} />
                                        </button>
                                    )}
                                </div>
                                {showDeptDropdown && deptOpen && (
                                    <div className="ml-4 pl-3 border-l border-white/[0.06] space-y-0.5 mb-1 mt-0.5">
                                        {departments.map((d) => {
                                            const dActive = pathname === `/departments/${d.departmentId}`;
                                            return (
                                                <Link key={d.departmentId} href={`/departments/${d.departmentId}`} onClick={() => onClose?.()}
                                                    className={cn("flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[11px] font-medium text-slate-400 hover:text-white hover:bg-white/5 transition-colors", dActive && "text-teal-400 bg-teal-500/10")}>
                                                    <Building2 size={11} className="shrink-0 opacity-60" />
                                                    <span className="truncate">{d.name}</span>
                                                </Link>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </nav>

                {/* Bottom */}
                <div className="px-3 py-3 border-t border-white/[0.06] space-y-0.5 relative z-[1]">
                    <Link href="/profile" onClick={() => onClose?.()}
                        className={cn("sidebar-nav-item w-full", pathname === "/profile" ? "active" : "")}>
                        <span className={cn("sidebar-icon", pathname === "/profile" ? "active" : "inactive")}>
                            <User size={14} />
                        </span>
                        Profile
                    </Link>
                    <button type="button" onClick={logout}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-rose-400/80 hover:text-rose-400 hover:bg-rose-500/10 transition-colors min-h-10">
                        <LogOut size={14} />
                        Sign out
                    </button>
                </div>
            </aside>
        </>
    );
}
