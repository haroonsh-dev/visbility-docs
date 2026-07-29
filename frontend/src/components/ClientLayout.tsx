"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
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
    "/documents": "Documents",
    "/search": "Search",
    "/chat": "AI Chat",
    "/activity": "Activity",
    "/profile": "Profile",
    "/admin/departments": "Departments",
    "/admin/admins": "Admins",
    "/admin/plans": "Plans",
    "/plans": "Plans",
    "/admin/documents": "All Documents",
    "/admin/settings": "AI Settings",
    "/admin/integrations": "Integrations",
    "/admin/email-reports": "Email reports",
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

function Shell({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const { ready, role, canAccessPage, canChat, canViewDocs, canUpload, firstAllowedPath } =
        usePermissions();
    const [navOpen, setNavOpen] = useState(false);
    const bootedRef = useRef(false);

    const closeNav = useCallback(() => setNavOpen(false), []);

    useEffect(() => {
        const token = getAuthValue("accessToken") || getAuthValue("token");
        if (!token || (!hasValidAccessToken() && !canRefreshSession())) {
            clearAuthState();
            router.replace("/login");
        }
    }, [router]);

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

    // Team users: soft-guard pages by page.* permissions
    useEffect(() => {
        if (!ready || role !== "team" || !pathname) return;
        if (pathname === "/profile" || pathname.startsWith("/profile/")) return;

        const blocked =
            (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) &&
            !canAccessPage("dashboard")
                ? true
                : (pathname === "/documents" || pathname.startsWith("/documents/")) &&
                    !(canAccessPage("documents") && (canViewDocs() || canUpload()))
                  ? true
                  : (pathname === "/chat" || pathname.startsWith("/chat/")) &&
                      !(canAccessPage("chat") && canChat())
                    ? true
                    : (pathname === "/activity" || pathname.startsWith("/activity/")) &&
                        !canAccessPage("activity")
                      ? true
                      : pathname.startsWith("/departments/") && !canAccessPage("departments")
                        ? true
                        : pathname.startsWith("/admin/")
                          ? true
                          : false;

        if (blocked) {
            router.replace(firstAllowedPath());
        }
    }, [
        ready,
        role,
        pathname,
        router,
        canAccessPage,
        canChat,
        canViewDocs,
        canUpload,
        firstAllowedPath,
    ]);

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
                <main className="flex-1 min-h-0 min-w-0 overflow-y-auto app-main">{children}</main>
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
