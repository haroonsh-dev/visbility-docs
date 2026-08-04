"use client";

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckSquare, Square, Search, X, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentLabel, docTypeLabel, resolveDocAgent } from "@/lib/documentAgents";

export type ChatScope = "all" | "selected";
export type DocStatusFilter = "" | "ready" | "processing" | "failed";

export type ScopeLibraryDoc = {
    documentId: string;
    originalFilename: string;
    status: string;
    pythonDocumentId?: string | null;
    classification?: string | null;
    mimeType?: string;
    metadata?: { phase3Agent?: string; cvScore?: number } | null;
};

type ChatScopePanelProps = {
    open: boolean;
    onClose: () => void;
    anchorRef?: React.RefObject<HTMLElement | null>;
    chatScope: ChatScope;
    onChatScopeChange: (scope: ChatScope) => void;
    filteredDocs: ScopeLibraryDoc[];
    selectedDocIds: string[];
    onToggleDoc: (id: string) => void;
    onToggleFolder?: (ids: string[]) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
    docSearch: string;
    onDocSearchChange: (v: string) => void;
    docStatusFilter: DocStatusFilter;
    onDocStatusFilterChange: (v: DocStatusFilter) => void;
    unprocessedCount: number;
    libraryCount: number;
    selectableCount: number;
    textPrimary: string;
    textMuted: string;
    textSecondary: string;
    bgHover: string;
};

const AGENT_ORDER = [
    "finance_agent",
    "procurement_agent",
    "hr_agent",
    "legal_agent",
    "compliance_agent",
    "other_agent",
];

const DROPDOWN_WIDTH = 380;
const DROPDOWN_GAP = 8;

function FolderCheckbox({
    checked,
    indeterminate,
    onChange,
}: {
    checked: boolean;
    indeterminate: boolean;
    onChange: () => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (ref.current) ref.current.indeterminate = indeterminate;
    }, [indeterminate]);
    return (
        <input
            ref={ref}
            type="checkbox"
            checked={checked}
            onChange={onChange}
            onClick={(e) => e.stopPropagation()}
            className="accent-teal-500 shrink-0 w-3.5 h-3.5 rounded border-border"
        />
    );
}

export default function ChatScopePanel({
    open,
    onClose,
    anchorRef,
    chatScope,
    onChatScopeChange,
    filteredDocs,
    selectedDocIds,
    onToggleDoc,
    onToggleFolder,
    onSelectAll,
    onClearSelection,
    docSearch,
    onDocSearchChange,
    docStatusFilter,
    onDocStatusFilterChange,
    unprocessedCount,
    libraryCount,
    selectableCount,
    textPrimary,
    textMuted,
    textSecondary,
    bgHover,
}: ChatScopePanelProps) {
    const panelRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

    useLayoutEffect(() => {
        if (!open) {
            setPos(null);
            return;
        }

        const place = () => {
            const anchor = anchorRef?.current;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const width = Math.min(DROPDOWN_WIDTH, vw - 16);

            if (!anchor) {
                setPos({
                    top: 72,
                    left: Math.max(8, vw - width - 16),
                    maxHeight: Math.min(480, vh - 96),
                });
                return;
            }

            const rect = anchor.getBoundingClientRect();
            let left = rect.left;
            if (left + width > vw - 8) left = Math.max(8, vw - width - 8);
            if (left < 8) left = 8;

            const spaceBelow = vh - rect.bottom - DROPDOWN_GAP - 8;
            const spaceAbove = rect.top - DROPDOWN_GAP - 8;
            const preferBelow = spaceBelow >= 280 || spaceBelow >= spaceAbove;
            const maxHeight = Math.min(480, preferBelow ? spaceBelow : spaceAbove);
            const top = preferBelow
                ? rect.bottom + DROPDOWN_GAP
                : Math.max(8, rect.top - DROPDOWN_GAP - maxHeight);

            setPos({ top, left, maxHeight: Math.max(220, maxHeight) });
        };

        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [open, anchorRef]);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        const onPointerDown = (e: MouseEvent) => {
            const target = e.target as Node;
            if (panelRef.current?.contains(target)) return;
            if (anchorRef?.current?.contains(target)) return;
            onClose();
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("mousedown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("mousedown", onPointerDown);
        };
    }, [open, onClose, anchorRef]);

    if (!open || !pos) return null;

    const selectedSet = new Set(selectedDocIds);

    const folderState = (arr: ScopeLibraryDoc[]) => {
        const c = arr.filter((d) => selectedSet.has(d.documentId)).length;
        return { checked: arr.length > 0 && c === arr.length, indeterminate: c > 0 && c < arr.length };
    };

    const toggleFolder = (docs: ScopeLibraryDoc[]) => {
        const ids = docs.map((d) => d.documentId);
        if (onToggleFolder) {
            onToggleFolder(ids);
            return;
        }
        const allSelected = ids.every((id) => selectedSet.has(id));
        if (allSelected) {
            ids.forEach((id) => {
                if (selectedSet.has(id)) onToggleDoc(id);
            });
        } else {
            ids.forEach((id) => {
                if (!selectedSet.has(id)) onToggleDoc(id);
            });
        }
    };

    const tree: Record<string, Record<string, ScopeLibraryDoc[]>> = {};
    for (const d of filteredDocs) {
        const agent = resolveDocAgent(d);
        const type = d.classification || "unclassified";
        (tree[agent] ||= {})[type] ||= [];
        tree[agent][type].push(d);
    }

    const visibleAgents = AGENT_ORDER.filter((a) => tree[a] && Object.keys(tree[a]).length > 0);
    for (const a of Object.keys(tree)) {
        if (!visibleAgents.includes(a)) visibleAgents.push(a);
    }

    const width = Math.min(DROPDOWN_WIDTH, typeof window !== "undefined" ? window.innerWidth - 16 : DROPDOWN_WIDTH);

    return (
        <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-scope-title"
            className={cn(
                "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl",
                "animate-fade-in-up"
            )}
            style={{
                top: pos.top,
                left: pos.left,
                width,
                maxHeight: pos.maxHeight,
            }}
        >
            <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-3 shrink-0">
                <div className="min-w-0">
                    <h2 id="chat-scope-title" className={`text-sm font-semibold ${textPrimary}`}>
                        Document scope
                    </h2>
                    <p className={`text-[11px] mt-0.5 ${textMuted}`}>
                        Choose which files this chat can use.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="btn-ghost rounded-lg p-1.5 shrink-0"
                    aria-label="Close"
                >
                    <X size={14} />
                </button>
            </div>

            <div className="px-4 py-3 space-y-2.5 border-b border-border shrink-0">
                <label className="flex items-center gap-2.5 cursor-pointer text-sm">
                    <input
                        type="radio"
                        name="chatScopePanel"
                        checked={chatScope === "all"}
                        onChange={() => onChatScopeChange("all")}
                        className="accent-teal-500"
                    />
                    <span className={textPrimary}>
                        All documents
                        <span className={`block text-[11px] ${textMuted}`}>{libraryCount} in library</span>
                    </span>
                </label>
                <label className="flex items-center gap-2.5 cursor-pointer text-sm">
                    <input
                        type="radio"
                        name="chatScopePanel"
                        checked={chatScope === "selected"}
                        onChange={() => onChatScopeChange("selected")}
                        className="accent-teal-500"
                    />
                    <span className={textPrimary}>
                        Selected only
                        <span className={`block text-[11px] ${textMuted}`}>
                            {selectedDocIds.length} of {selectableCount} processed
                        </span>
                    </span>
                </label>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
                {chatScope === "all" ? (
                    <p className={`text-sm ${textMuted} leading-relaxed`}>
                        Answers will search across all processed documents. Switch to{" "}
                        <span className={textPrimary}>Selected only</span> to narrow the set.
                    </p>
                ) : (
                    <>
                        <div className="relative">
                            <Search size={14} className={`absolute left-3 top-1/2 -translate-y-1/2 ${textMuted}`} />
                            <input
                                value={docSearch}
                                onChange={(e) => onDocSearchChange(e.target.value)}
                                placeholder="Search filename…"
                                className="w-full premium-input rounded-xl py-2 pl-9 pr-3 text-sm"
                            />
                        </div>
                        <select
                            value={docStatusFilter}
                            onChange={(e) => onDocStatusFilterChange(e.target.value as DocStatusFilter)}
                            className="w-full premium-input rounded-xl py-2 px-3 text-sm"
                        >
                            <option value="">All statuses</option>
                            <option value="ready">Ready</option>
                            <option value="processing">Processing</option>
                            <option value="failed">Failed</option>
                        </select>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={onSelectAll}
                                className="btn-secondary rounded-xl px-3 py-1.5 text-xs flex-1"
                            >
                                Select all ({filteredDocs.length})
                            </button>
                            <button
                                type="button"
                                onClick={onClearSelection}
                                className="btn-ghost rounded-xl px-3 py-1.5 text-xs flex-1"
                            >
                                Clear
                            </button>
                        </div>
                        <p className={`text-[11px] ${textMuted}`}>
                            {selectedDocIds.length} of {filteredDocs.length} shown selected
                        </p>

                        {filteredDocs.length === 0 ? (
                            <p className={`text-sm ${textMuted}`}>No matching processed documents.</p>
                        ) : (
                            <div className="space-y-1.5">
                                {visibleAgents.map((agent) => {
                                    const types = Object.keys(tree[agent]).sort((a, b) => {
                                        if (a === "unclassified") return 1;
                                        if (b === "unclassified") return -1;
                                        return a.localeCompare(b);
                                    });
                                    const agentDocs = types.flatMap((t) => tree[agent][t]);
                                    const ag = folderState(agentDocs);
                                    return (
                                        <details
                                            key={agent}
                                            className="rounded-xl border border-border overflow-hidden bg-surface"
                                            open
                                        >
                                            <summary
                                                className={cn(
                                                    "px-2.5 py-2 cursor-pointer transition-colors flex items-center gap-2 text-sm font-semibold list-none",
                                                    textPrimary,
                                                    bgHover
                                                )}
                                            >
                                                <FolderCheckbox
                                                    checked={ag.checked}
                                                    indeterminate={ag.indeterminate}
                                                    onChange={() => toggleFolder(agentDocs)}
                                                />
                                                <Folder size={13} className="text-teal-400 shrink-0" />
                                                <span className="flex-1 truncate">{agentLabel(agent)}</span>
                                                <span className={`text-[10px] font-semibold ${textMuted}`}>
                                                    {agentDocs.length}
                                                </span>
                                            </summary>
                                            <div className="px-2 pb-2 space-y-1">
                                                {types.map((type) => {
                                                    const typeDocs = tree[agent][type]
                                                        .slice()
                                                        .sort((a, b) => {
                                                            const isResume =
                                                                type === "resume" ||
                                                                type === "cv" ||
                                                                a.classification === "resume";
                                                            if (isResume) {
                                                                const sa = a.metadata?.cvScore ?? -1;
                                                                const sb = b.metadata?.cvScore ?? -1;
                                                                if (sa !== sb) return sb - sa;
                                                            }
                                                            return a.originalFilename.localeCompare(b.originalFilename);
                                                        });
                                                    const ty = folderState(typeDocs);
                                                    return (
                                                        <details
                                                            key={type}
                                                            className="rounded-lg border border-border overflow-hidden bg-white/2"
                                                            open
                                                        >
                                                            <summary
                                                                className={cn(
                                                                    "px-2 py-1.5 cursor-pointer transition-colors flex items-center gap-2 text-xs font-medium list-none",
                                                                    textSecondary,
                                                                    bgHover
                                                                )}
                                                            >
                                                                <FolderCheckbox
                                                                    checked={ty.checked}
                                                                    indeterminate={ty.indeterminate}
                                                                    onChange={() => toggleFolder(typeDocs)}
                                                                />
                                                                <span className="flex-1 truncate">{docTypeLabel(type)}</span>
                                                                <span className={`text-[10px] ${textMuted}`}>
                                                                    {typeDocs.length}
                                                                </span>
                                                            </summary>
                                                            <div className="px-1.5 pb-1.5 space-y-0.5">
                                                                {typeDocs.map((doc) => {
                                                                    const checked = selectedSet.has(doc.documentId);
                                                                    return (
                                                                        <button
                                                                            key={doc.documentId}
                                                                            type="button"
                                                                            onClick={() => onToggleDoc(doc.documentId)}
                                                                            className={cn(
                                                                                "w-full flex items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm border border-transparent",
                                                                                checked
                                                                                    ? "bg-accent-muted border-[rgba(45,212,191,0.25)]"
                                                                                    : bgHover
                                                                            )}
                                                                        >
                                                                            {checked ? (
                                                                                <CheckSquare size={14} className="text-teal-400 shrink-0 mt-0.5" />
                                                                            ) : (
                                                                                <Square size={14} className={`${textMuted} shrink-0 mt-0.5`} />
                                                                            )}
                                                                            <span className={`${textSecondary} line-clamp-2 flex-1 min-w-0`}>
                                                                                {doc.originalFilename}
                                                                                <span className={`block text-[11px] mt-0.5 ${textMuted}`}>
                                                                                    {doc.status}
                                                                                    {doc.metadata?.cvScore != null &&
                                                                                        ` · ${doc.metadata.cvScore}`}
                                                                                </span>
                                                                            </span>
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        </details>
                                                    );
                                                })}
                                            </div>
                                        </details>
                                    );
                                })}
                            </div>
                        )}

                        {unprocessedCount > 0 && (
                            <p className={`text-[11px] ${textMuted} pt-1`}>
                                {unprocessedCount} document(s) not yet processed by AI are hidden.
                            </p>
                        )}
                    </>
                )}
            </div>

            <div className="px-4 py-3 border-t border-border shrink-0">
                <button type="button" onClick={onClose} className="btn-gradient w-full rounded-xl py-2 text-sm">
                    Done
                </button>
            </div>
        </div>
    );
}
