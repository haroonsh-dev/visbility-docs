/**
 * In-memory chat focus: last document(s) the user discussed for "chart of that".
 * Survives across requests for a session without requiring AI-backend schema migration.
 */
type FocusEntry = {
    documentIds: string[];
    updatedAt: number;
};

const focusBySession = new Map<string, FocusEntry>();
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

function prune() {
    const now = Date.now();
    for (const [k, v] of focusBySession) {
        if (now - v.updatedAt > TTL_MS) focusBySession.delete(k);
    }
}

export function setSessionFocusDocumentIds(sessionId: string | undefined, documentIds: string[]) {
    if (!sessionId || !documentIds.length) return;
    prune();
    focusBySession.set(sessionId, {
        documentIds: [...new Set(documentIds.filter(Boolean))].slice(0, 5),
        updatedAt: Date.now(),
    });
}

export function getSessionFocusDocumentIds(sessionId: string | undefined): string[] {
    if (!sessionId) return [];
    prune();
    const hit = focusBySession.get(sessionId);
    if (!hit) return [];
    if (Date.now() - hit.updatedAt > TTL_MS) {
        focusBySession.delete(sessionId);
        return [];
    }
    return [...hit.documentIds];
}
