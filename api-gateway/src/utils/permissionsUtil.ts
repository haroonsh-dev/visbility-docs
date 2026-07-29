import {
    ALL_PERMISSIONS,
    DEFAULT_TEAM_PERMISSIONS,
    PERMISSIONS,
    PermissionKey,
    TEAM_MEMBER_EDITABLE_PERMISSIONS,
} from '../types/permissions';

/** Read flat key or legacy nested shape (permissions.chat.use from bad $set). */
function readPermissionValue(obj: Record<string, unknown>, key: string): boolean | undefined {
    if (typeof obj[key] === 'boolean') return obj[key];

    const segments = key.split('.');
    let cur: unknown = obj;
    for (const seg of segments) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return typeof cur === 'boolean' ? cur : undefined;
}

export function permissionsToPlain(perms: unknown): Record<string, boolean> {
    if (!perms || typeof perms !== 'object') return {};
    const obj = perms as Record<string, unknown> & { toObject?: () => Record<string, boolean> };
    const source = typeof obj.toObject === 'function' ? obj.toObject() : obj;
    const out: Record<string, boolean> = {};
    for (const key of ALL_PERMISSIONS) {
        const val = readPermissionValue(source, key);
        if (typeof val === 'boolean') out[key] = val;
    }
    return out;
}

/** Fill missing keys with team defaults; sync preview with view. */
export function normalizeTeamPermissions(perms: unknown): Record<PermissionKey, boolean> {
    const plain = permissionsToPlain(perms);
    const out = { ...DEFAULT_TEAM_PERMISSIONS };
    for (const key of ALL_PERMISSIONS) {
        if (typeof plain[key] === 'boolean') {
            out[key] = plain[key];
        }
    }
    out[PERMISSIONS.DOCUMENT_PREVIEW] = out[PERMISSIONS.DOCUMENT_VIEW];
    // Team accounts never get full org team admin; Managers use department.manage instead
    out[PERMISSIONS.TEAM_MANAGE] = false;
    return out;
}

export function pickEditableTeamPermissions(perms: unknown): Record<string, boolean> {
    const normalized = normalizeTeamPermissions(perms);
    const picked: Record<string, boolean> = {};
    for (const key of TEAM_MEMBER_EDITABLE_PERMISSIONS) {
        picked[key] = normalized[key];
    }
    return picked;
}

/** Flat permissions object for MongoDB (literal keys like "chat.use"). */
export function buildFlatPermissionsDocument(perms: Record<PermissionKey, boolean>): Record<string, boolean> {
    const doc: Record<string, boolean> = {};
    for (const key of ALL_PERMISSIONS) {
        doc[key] = perms[key];
    }
    return doc;
}
