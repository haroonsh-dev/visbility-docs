"use client";

import React, { useState } from "react";
import { AGENT_OPTIONS, DOC_TYPE_TO_AGENT, DOC_TYPE_LABELS, agentLabel } from "@/lib/documentAgents";
import { usePlanAgents } from "@/hooks/usePlanAgents";
import { usePermissions } from "@/context/PermissionsContext";
import AgentAccessBlockedNotice from "@/components/AgentAccessBlockedNotice";

type ClassifyDoc = {
    documentId: string;
    pythonDocumentId?: string;
    originalFilename?: string;
    title?: string;
    document_type?: string;
    classification?: string | null;
};

type Props = {
    doc: ClassifyDoc;
    queueLen?: number;
    defaultAgent?: string;
    onConfirm: (documentId: string, documentType: string, phase3Agent: string) => void;
    /** Called when the required agent is not on the user's access — remove the upload. */
    onRejectUpload: (documentId: string, reason: string) => void;
    onDismiss: () => void;
};

export default function ClassifyAgentPopup({
    doc,
    queueLen = 1,
    defaultAgent,
    onConfirm,
    onRejectUpload,
    onDismiss,
}: Props) {
    const rawType = (doc.document_type || doc.classification || "other").toString().trim();
    const docType = rawType.toLowerCase().replace(/\s+/g, "_");
    const typeLabel = DOC_TYPE_LABELS[docType] || docType.replace(/_/g, " ");
    const naturalAgent = DOC_TYPE_TO_AGENT[docType] || "other_agent";
    const suggested = defaultAgent || naturalAgent;
    const { agentOptions, allowedIds, loading, isAgentAllowed } = usePlanAgents();
    const { role } = usePermissions();
    const superAdmin = role === "superAdmin";
    const agents = agentOptions.length
        ? agentOptions
        : superAdmin
          ? AGENT_OPTIONS.filter((o) => o.value)
          : [];
    // Allow save when the detected type's agent is on this user's access
    const naturalOnPlan = superAdmin || (!loading && isAgentAllowed(naturalAgent));
    const canSave = naturalOnPlan;
    const [agent, setAgent] = useState(naturalAgent);
    const [removing, setRemoving] = useState(false);
    const rejectedRef = React.useRef(false);

    React.useEffect(() => {
        if (naturalOnPlan) {
            const next = agents.some((a) => a.value === suggested) ? suggested : naturalAgent;
            setAgent(next);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- agents list identity changes every render
    }, [suggested, doc.documentId, naturalOnPlan, naturalAgent]);

    // Auto-remove upload when required agent is outside the user's access
    React.useEffect(() => {
        if (superAdmin || loading || naturalOnPlan || rejectedRef.current) return;
        rejectedRef.current = true;
        setRemoving(true);
        const reason = `${typeLabel} needs ${agentLabel(naturalAgent)}, which is not on your access`;
        onRejectUpload(doc.documentId, reason);
    }, [superAdmin, loading, naturalOnPlan, doc.documentId, typeLabel, naturalAgent, onRejectUpload]);

    const planLabels = (allowedIds || agents.map((a) => a.value))
        .map((id) => agentLabel(id))
        .join(", ");

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={() => {
                if (!canSave) return;
                onDismiss();
            }}
        >
            <div
                className="surface-card p-4 sm:p-6 space-y-4 border border-border w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
            >
                <div>
                    <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-foreground">Classification result</h3>
                        {queueLen > 1 && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-200">
                                1 of {queueLen}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-foreground-muted mt-1 truncate">
                        {doc.originalFilename || doc.title || "Document"}
                    </p>
                </div>

                <div className="rounded-xl p-4 bg-teal-500/10 border border-teal-500/20">
                    <p className="text-xs font-semibold text-teal-300 uppercase tracking-wider">Detected type</p>
                    <p className="text-lg font-bold text-foreground mt-1">{typeLabel}</p>
                    <p className="text-xs text-foreground-muted mt-1">
                        Required agent: {agentLabel(naturalAgent)}
                    </p>
                </div>

                <div className="rounded-xl p-3 border border-border bg-surface-2/60 space-y-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                        Your agent access
                    </p>
                    <p className="text-xs text-foreground">
                        {loading ? "Loading…" : planLabels || "None"}
                    </p>
                </div>

                {!loading && !naturalOnPlan && role !== "superAdmin" && (
                    <AgentAccessBlockedNotice
                        compact
                        role={role}
                        items={[
                            {
                                filename: doc.originalFilename || doc.title,
                                typeLabel,
                                agentId: naturalAgent,
                            },
                        ]}
                        coveredAgents={allowedIds || agents.map((a) => a.value)}
                    />
                )}

                <div>
                    <label className="text-xs font-semibold text-foreground-muted uppercase tracking-wider block mb-2">
                        Extraction agent
                    </label>
                    <select
                        value={canSave ? agent : naturalAgent}
                        onChange={(e) => setAgent(e.target.value)}
                        disabled={!canSave}
                        className="w-full premium-input rounded-xl px-4 py-2.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {canSave ? (
                            agents.map((t) => (
                                <option key={t.value} value={t.value}>
                                    {t.label}
                                </option>
                            ))
                        ) : (
                            <option value={naturalAgent}>
                                {agentLabel(naturalAgent)} (not on your access)
                            </option>
                        )}
                    </select>
                </div>

                <div className="flex gap-3 pt-1">
                    {canSave ? (
                        <>
                            <button
                                type="button"
                                onClick={onDismiss}
                                className="btn-secondary flex-1 rounded-xl py-2.5 text-sm"
                            >
                                Dismiss
                            </button>
                            <button
                                type="button"
                                disabled={!agent}
                                onClick={() => onConfirm(doc.documentId, docType, agent)}
                                className="btn-gradient flex-1 rounded-xl py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                Save agent
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            disabled
                            className="btn-secondary flex-1 rounded-xl py-2.5 text-sm opacity-50 cursor-not-allowed"
                        >
                            {loading || removing ? "Removing upload…" : "Save disabled"}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
