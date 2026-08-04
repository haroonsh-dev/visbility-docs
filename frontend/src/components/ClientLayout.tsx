"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { ToastProvider } from "./Toast";
import { ColorProvider } from "@/context/ColorContext";
import { PermissionsProvider, usePermissions } from "@/context/PermissionsContext";
import { GroqLimitProvider } from "./GroqLimitModal";
import DriveSyncInbox from "./DriveSyncInbox";
import { clearAuthState, hasValidAccessToken, canRefreshSession, getAuthValue } from "@/lib/authSession";

const PAGE_TITLES: Record<string, string> = {
    "/dashboard": "Dashboard",
    "/documents": "Document Vault",
    "/search": "Search",
    "/chat": "AI Assistant",
    "/activity": "System Activity",
    "/profile": "Profile",
    "/admin/departments": "Organization Hub",
    "/admin/admins": "Admins",
    "/admin/plans": "Subscriptions & Billing",
    "/plans": "Subscriptions & Billing",
    "/admin/documents": "Document Vault",
    "/admin/settings": "AI Engine Config",
    "/admin/integrations": "API & Webhooks",
    "/admin/email-reports": "Automated Reports",
};

function resolvePageTitle(pathname: string | null): string {
    if (!pathname) return "Docs AI";
    if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
    if (pathname.startsWith("/documents")) return "Documents";
    if (pathname.startsWith("/search")) return "Search";
    if (pathname.startsWith("/chat")) return "AI Chat";
    if (pathname.startsWith("/activity")) return "Activity";
    if (pathname.startsWith("/departments/") && pathname.includes("/members/")) return "Employee oversight";
    if (pathname.startsWith("/departments/")) return "Department";
    if (pathname.startsWith("/admin/departments")) return "Departments";
    if (pathname.startsWith("/admin")) return "Admin";
    return "Docs AI";
}

function matchesPath(pathname: string, base: string) {
    return pathname === base || pathname.startsWith(`${base}/`);
}

function Shell({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const {
        ready,
        role,
        canAccessPage,
        firstAllowedPath,
    } = usePermissions();
    const [navOpen, setNavOpen] = useState(false);
    const bootedRef = useRef(false);

    const closeNav = useCallback(() => setNavOpen(false), []);

    const ensureAuthed = useCallback(() => {
        const token = getAuthValue("accessToken") || getAuthValue("token");
        if (!token || (!hasValidAccessToken() && !canRefreshSession())) {
            clearAuthState();
            router.replace("/login");
            return false;
        }
        return true;
    }, [router]);

    useEffect(() => {
        ensureAuthed();
    }, [ensureAuthed, ready, pathname]);

    useEffect(() => {
        if (ready && role === "superAdmin" && pathname) {
            const allowedRoutes = [
                "/dashboard",
                "/admin/documents",
                "/search",
                "/chat",
                "/activity",
                "/admin/admins",
                "/admin/plans",
                "/admin/settings",
                "/profile",
            ];
            const isAllowed = allowedRoutes.some(
                (route) => pathname === route || pathname.startsWith(`${route}/`)
            );
            if (!isAllowed) {
                router.replace("/dashboard");
            }
        }
    }, [ready, role, pathname, router]);

    const teamRouteBlocked = useMemo(() => {
        if (!ready || role !== "team" || !pathname) return false;
        if (matchesPath(pathname, "/profile")) return false;

        if (matchesPath(pathname, "/dashboard")) return !canAccessPage("dashboard");
        if (matchesPath(pathname, "/documents")) return !canAccessPage("documents");
        if (matchesPath(pathname, "/chat")) return !canAccessPage("chat");
        if (matchesPath(pathname, "/activity")) return !canAccessPage("activity");
        if (matchesPath(pathname, "/departments")) return !canAccessPage("departments");
        if (matchesPath(pathname, "/plans")) return !canAccessPage("plans");
        if (matchesPath(pathname, "/admin/email-reports")) return !canAccessPage("email_reports");
        if (matchesPath(pathname, "/admin/integrations")) return !canAccessPage("integrations");
        if (matchesPath(pathname, "/admin/settings")) return !canAccessPage("settings");
        if (matchesPath(pathname, "/admin")) return true;
        if (matchesPath(pathname, "/team") || matchesPath(pathname, "/search")) return true;
        return false;
    }, [ready, role, pathname, canAccessPage]);

    useEffect(() => {
        if (!teamRouteBlocked) return;
        router.replace(firstAllowedPath());
    }, [teamRouteBlocked, router, firstAllowedPath]);

    useEffect(() => {
        setNavOpen(false);
    }, [pathname]);

    if (ready) bootedRef.current = true;

    // Only show full-page loader on the very first boot — never hide sidebar on navigations
    if (!ready && !bootedRef.current) {
        return (
            <div className="min-h-screen flex items-center justify-center app-shell text-[var(--foreground-muted)] relative">
                <div className="flex flex-col items-center gap-3 relative z-[1]">
                    <div className="spinner" />
                    <p className="text-sm">Loading workspace...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-screen flex overflow-hidden app-shell text-[var(--foreground)] relative">
            <Sidebar open={navOpen} onClose={closeNav} />
            <div className="flex-1 min-w-0 min-h-0 flex flex-col relative z-[1]">
                <header className="lg:hidden shrink-0 flex items-center gap-3 px-3 sm:px-4 py-2.5 border-b border-[var(--border)] bg-gradient-to-r from-white/90 via-teal-50/80 to-cyan-50/70 backdrop-blur-md">
                    <button
                        type="button"
                        onClick={() => setNavOpen(true)}
                        className="btn-ghost rounded-lg p-2.5 min-h-11 min-w-11 flex items-center justify-center"
                        aria-label="Open menu"
                    >
                        <Menu size={20} />
                    </button>
                    <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold tracking-tight truncate">{resolvePageTitle(pathname)}</p>
                        <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--accent)] font-semibold">
                            Visibility
                        </p>
                    </div>
                </header>
                <main className="flex-1 min-h-0 min-w-0 overflow-y-auto app-main">
                    {teamRouteBlocked ? (
                        <div className="min-h-[40vh] flex items-center justify-center text-sm text-[var(--foreground-muted)]">
                            Redirecting…
                        </div>
                    ) : (
                        children
                    )}
                </main>
            </div>
        </div>
    );
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
    return (
        <ColorProvider>
            <ToastProvider>
                <PermissionsProvider>
                    <GroqLimitProvider>
                        <Shell>{children}</Shell>
                        <DriveSyncInbox />
                    </GroqLimitProvider>
                </PermissionsProvider>
            </ToastProvider>
        </ColorProvider>
    );
}
