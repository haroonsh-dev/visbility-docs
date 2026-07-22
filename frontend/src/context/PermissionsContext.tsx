"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import { getStoredUser, setAuthValue } from "@/lib/authSession";
import {
    DEFAULT_TEAM_PERMS,
    getUserPermissions,
    getUserRole,
    hasAppPermission as checkPermission,
    PERMS,
} from "@/lib/permissions";

type PermissionsContextValue = {
    permissions: Record<string, boolean>;
    role: string;
    ready: boolean;
    reload: () => Promise<void>;
    hasPermission: (key: string) => boolean;
    canUpload: () => boolean;
    canViewDocs: () => boolean;
    canDeleteDocs: () => boolean;
    canShareDocs: () => boolean;
    canChat: () => boolean;
};

const PermissionsContext = createContext<PermissionsContextValue | null>(null);

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
    const [permissions, setPermissions] = useState<Record<string, boolean>>(() => getUserPermissions());
    const [role, setRole] = useState(() => getUserRole());
    // Start ready when we already have a cached session so the shell/sidebar
    // never flash-hides while /auth/me refreshes in the background.
    const [ready, setReady] = useState(() => Boolean(getUserRole() || Object.keys(getUserPermissions()).length));

    const reload = useCallback(async () => {
        try {
            const me = await apiRequest("/auth/me");
            const fresh = me?.data?.user;
            if (fresh) {
                const stored = getStoredUser<Record<string, unknown>>() || {};
                const merged = { ...stored, ...fresh };
                setAuthValue("user", JSON.stringify(merged));
                const perms = fresh.permissions || {};
                setPermissions(perms);
                setRole(fresh.role || "team");
                setAuthValue("permissions", JSON.stringify(perms));
            }
        } catch {
            setPermissions(getUserPermissions());
            setRole(getUserRole());
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    const hasPermission = useCallback(
        (key: string) => {
            if (role === "superAdmin" || role === "admin") return true;
            if (key === PERMS.PREVIEW) {
                return permissions[PERMS.PREVIEW] === true || permissions[PERMS.VIEW] === true;
            }
            return permissions[key] === true;
        },
        [permissions, role]
    );

    const value = useMemo<PermissionsContextValue>(
        () => ({
            permissions,
            role,
            ready,
            reload,
            hasPermission,
            canUpload: () => hasPermission(PERMS.UPLOAD),
            canViewDocs: () => hasPermission(PERMS.VIEW),
            canDeleteDocs: () => hasPermission(PERMS.DELETE),
            canShareDocs: () => hasPermission(PERMS.SHARE),
            canChat: () => hasPermission(PERMS.CHAT),
        }),
        [permissions, role, ready, reload, hasPermission]
    );

    return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function usePermissions() {
    const ctx = useContext(PermissionsContext);
    if (!ctx) {
        return {
            permissions: getUserPermissions(),
            role: getUserRole(),
            ready: true,
            reload: async () => {},
            hasPermission: checkPermission,
            canUpload: () => checkPermission(PERMS.UPLOAD),
            canViewDocs: () => checkPermission(PERMS.VIEW),
            canDeleteDocs: () => checkPermission(PERMS.DELETE),
            canShareDocs: () => checkPermission(PERMS.SHARE),
            canChat: () => checkPermission(PERMS.CHAT),
        };
    }
    return ctx;
}

export { DEFAULT_TEAM_PERMS };
