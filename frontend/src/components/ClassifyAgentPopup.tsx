"use client";

import React, { useState } from "react";
import { AGENT_OPTIONS, DOC_TYPE_TO_AGENT, agentLabel } from "@/lib/documentAgents";
import { usePlanAgents } from "@/hooks/usePlanAgents";

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
    onDismiss: () => void;
};

export default function ClassifyAgentPopup({ doc, queueLen = 1, defaultAgent, onConfirm, onDismiss }: Props) {
    const docType = doc.document_type || doc.classification || "other";
    const suggested = defaultAgent || DOC_TYPE_TO_AGENT[docType] || "other_agent";
    const { agentOptions } = usePlanAgents();
    const agents = agentOptions.length ? agentOptions : AGENT_OPTIONS.filter((o) => o.value);
    const safeSuggested = agents.some((a) => a.value === suggested)
        ? suggested
        : agents[0]?.value || "other_agent";
    const [agent, setAgent] = useState(safeSuggested);

    React.useEffect(() => {
        setAgent(safeSuggested);
    }, [safeSuggested, doc.documentId]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
            onClick={onDismiss}
        >
            <div
                className="surface-card p-4 sm:p-6 space-y-4 border border-[var(--border)] w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
            >
                <div>
                    <div className="flex items-center gap-2">
                        <h3 className="text-lg font-bold text-[var(--foreground)]">Classification result</h3>
                        {queueLen > 1 && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-teal-500/20 text-teal-200">
                                1 of {queueLen}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-[var(--foreground-muted)] mt-1 truncate">
                        {doc.originalFilename || doc.title || "Document"}
                    </p>
                </div>

                <div className="rounded-xl p-4 bg-teal-500/10 border border-teal-500/20">
                    <p className="text-xs font-semibold text-teal-300 uppercase tracking-wider">Detected type</p>
                    <p className="text-lg font-bold text-[var(--foreground)] mt-1">{docType}</p>
                    <p className="text-xs text-[var(--foreground-muted)] mt-1">Suggested agent: {agentLabel(suggested)}</p>
                </div>

                <div>
                    <label className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wider block mb-2">
                        Extraction agent
                    </label>
                    <select
                        value={agent}
                        onChange={(e) => setAgent(e.target.value)}
                        className="w-full premium-input rounded-xl px-4 py-2.5 text-sm"
                    >
                        {agents.map((t) => (
                            <option key={t.value} value={t.value}>
                                {t.label}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex gap-3 pt-1">
                    <button type="button" onClick={onDismiss} className="btn-secondary flex-1 rounded-xl py-2.5 text-sm">
                        Dismiss
                    </button>
                    <button
                        type="button"
                        onClick={() => onConfirm(doc.documentId, docType, agent)}
                        className="btn-gradient flex-1 rounded-xl py-2.5 text-sm"
                    >
                        Save agent
                    </button>
                </div>
            </div>
        </div>
    );
}
