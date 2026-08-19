"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    AlertCircle,
    CheckCircle2,
    Eye,
    Loader2,
    Mail,
    RefreshCw,
    Send,
    Settings2,
} from "lucide-react";
import { useHrCandidates, type HrCandidateOutreachRow, type OutreachTemplateId } from "@/hooks/useHrCandidates";
import { cn } from "@/lib/utils";

const TEMPLATES: Array<{ id: OutreachTemplateId; label: string; hint: string }> = [
    { id: "interview_invite", label: "Interview invitation", hint: "Invite top candidates to schedule an interview" },
    { id: "screening_next_steps", label: "Passed screening", hint: "Notify that they cleared initial review" },
    { id: "rejection", label: "Polite rejection", hint: "Close the loop professionally" },
];

type Props = {
    accent: string;
    accentMuted: string;
    onRunInChat?: (prompt: string) => void;
};

function scoreTone(score: number): string {
    if (score >= 80) return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
    if (score >= 60) return "text-amber-700 dark:text-amber-400 bg-amber-500/10";
    return "text-foreground-muted bg-surface-2";
}

function stripHtml(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function CandidateRow({
    row,
    accent,
    checked,
    sending,
    draftEmail,
    onToggle,
    onDraftEmail,
    onSaveEmail,
    savingEmail,
}: {
    row: HrCandidateOutreachRow;
    accent: string;
    checked: boolean;
    sending: boolean;
    draftEmail?: string;
    onToggle: () => void;
    onDraftEmail: (value: string) => void;
    onSaveEmail: () => void;
    savingEmail: boolean;
}) {
    const hasEmail = Boolean(row.email);
    const canSelect = hasEmail || Boolean(draftEmail?.trim());

    return (
        <tr
            className={cn(
                "border-b border-border/50 last:border-0",
                canSelect ? "hover:bg-surface-2/50" : "opacity-70"
            )}
        >
            <td className="px-3 py-2 align-top">
                <input
                    type="checkbox"
                    checked={checked}
                    disabled={!canSelect || sending}
                    onChange={onToggle}
                    className="rounded border-border mt-1"
                />
            </td>
            <td className="px-3 py-2 align-top">
                <p className="font-medium text-foreground">
                    <Link href={`/documents/${row.documentId}/details`} className="hover:underline">
                        {row.candidateName}
                    </Link>
                </p>
                <p className="text-[10px] text-foreground-muted mt-0.5 truncate max-w-[220px]">{row.filename}</p>
                {row.lastOutreachAt && (
                    <p className="text-[10px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                        Emailed {new Date(row.lastOutreachAt).toLocaleDateString()}
                    </p>
                )}
            </td>
            <td className="px-3 py-2 align-top min-w-[180px]">
                {hasEmail ? (
                    <span className="text-foreground-muted break-all">{row.email}</span>
                ) : (
                    <div className="space-y-1.5">
                        <input
                            type="email"
                            value={draftEmail || ""}
                            onChange={(e) => onDraftEmail(e.target.value)}
                            placeholder="Add email manually"
                            className="w-full rounded-lg border border-amber-500/30 bg-surface px-2 py-1 text-[11px]"
                        />
                        <button
                            type="button"
                            onClick={onSaveEmail}
                            disabled={savingEmail || !draftEmail?.trim()}
                            className="text-[10px] font-semibold hover:underline disabled:opacity-50"
                            style={{ color: accent }}
                        >
                            {savingEmail ? "Saving…" : "Save to CV"}
                        </button>
                    </div>
                )}
            </td>
            <td className="px-3 py-2 text-right align-top">
                <span
                    className={cn(
                        "inline-flex rounded-md px-2 py-0.5 font-bold tabular-nums",
                        scoreTone(row.cvScore)
                    )}
                >
                    {Number.isFinite(row.cvScore) ? Math.round(row.cvScore) : "—"}
                </span>
            </td>
        </tr>
    );
}

export default function AgentHrOutreachPanel({ accent, accentMuted, onRunInChat }: Props) {
    const {
        candidates,
        emailConfigured,
        withEmail,
        loading,
        sending,
        lastResult,
        refresh,
        saveCandidateEmail,
        previewOutreach,
        sendOutreach,
    } = useHrCandidates(true);

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [emailDrafts, setEmailDrafts] = useState<Record<string, string>>({});
    const [savingId, setSavingId] = useState<string | null>(null);
    const [template, setTemplate] = useState<OutreachTemplateId>("interview_invite");
    const [companyName, setCompanyName] = useState("Visibility Bots");
    const [senderName, setSenderName] = useState("HR Team");
    const [interviewDetails, setInterviewDetails] = useState(
        "We would like to invite you to an interview. Please reply with your availability for next week."
    );
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<{ subject: string; body: string; name: string } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const readyCandidates = useMemo(
        () => candidates.filter((c) => c.email || emailDrafts[c.documentId]?.trim()),
        [candidates, emailDrafts]
    );

    const needsEmail = useMemo(() => candidates.filter((c) => !c.email), [candidates]);

    const toggle = (id: string) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const selectTop = (n: number) => {
        const ids = readyCandidates.slice(0, n).map((c) => c.documentId);
        setSelected(new Set(ids));
    };

    const handleSaveEmail = async (documentId: string) => {
        const email = emailDrafts[documentId]?.trim();
        if (!email) return;
        setSavingId(documentId);
        setError(null);
        try {
            await saveCandidateEmail(documentId, email);
            setEmailDrafts((prev) => {
                const next = { ...prev };
                delete next[documentId];
                return next;
            });
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Could not save email");
        } finally {
            setSavingId(null);
        }
    };

    const loadPreview = async () => {
        const firstId = [...selected][0];
        if (!firstId) return;
        setPreviewLoading(true);
        const result = await previewOutreach({
            documentId: firstId,
            template,
            companyName,
            senderName,
            interviewDetails: template === "interview_invite" ? interviewDetails : undefined,
            emailOverride: emailDrafts[firstId],
        });
        if (result) {
            setPreview({
                subject: result.subject,
                body: stripHtml(result.html),
                name: result.candidateName,
            });
        }
        setPreviewLoading(false);
    };

    useEffect(() => {
        if (!selected.size) {
            setPreview(null);
            return;
        }
        void loadPreview();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selected, template, companyName, senderName, interviewDetails]);

    const handleSend = async () => {
        setError(null);
        const ids = [...selected];
        if (!ids.length) {
            setError("Select at least one candidate.");
            return;
        }
        if (!emailConfigured) {
            setError("Outreach email is not set up yet. Ask your admin to configure SMTP on the server.");
            return;
        }

        const overrides: Record<string, string> = {};
        for (const id of ids) {
            const row = candidates.find((c) => c.documentId === id);
            if (row && !row.email && emailDrafts[id]?.trim()) {
                overrides[id] = emailDrafts[id].trim();
            }
        }

        try {
            await sendOutreach({
                documentIds: ids,
                template,
                companyName,
                senderName,
                interviewDetails: template === "interview_invite" ? interviewDetails : undefined,
                emailOverrides: Object.keys(overrides).length ? overrides : undefined,
            });
            setSelected(new Set());
            setPreview(null);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : "Failed to send emails");
        }
    };

    const sendDisabled = sending || !selected.size || !emailConfigured;

    return (
        <section className="rounded-2xl border border-border overflow-hidden bg-surface/50">
            <div
                className="px-4 py-4 border-b border-border flex flex-wrap items-start justify-between gap-3"
                style={{ backgroundColor: accentMuted }}
            >
                <div>
                    <p className="text-sm font-bold text-foreground flex items-center gap-2">
                        <Mail size={16} style={{ color: accent }} />
                        Candidate outreach
                    </p>
                    <p className="text-xs text-foreground-muted mt-1 max-w-xl">
                        Email your ranked shortlist — interview invites, screening updates, or rejections. Only scored CVs appear here.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className={cn(
                            "text-[10px] font-bold uppercase tracking-wider rounded-full px-2.5 py-1",
                            emailConfigured
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        )}
                    >
                        {emailConfigured ? "Ready to send" : "Setup required"}
                    </span>
                    <button
                        type="button"
                        onClick={() => void refresh()}
                        disabled={loading}
                        className="btn-secondary rounded-lg px-2.5 py-1.5 text-xs inline-flex items-center gap-1"
                    >
                        <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
                    </button>
                </div>
            </div>

            {!emailConfigured && (
                <div className="px-4 py-3 border-b border-amber-500/20 bg-amber-500/5 flex flex-wrap items-start gap-3">
                    <Settings2 size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-xs text-foreground-muted flex-1 min-w-0">
                        <p className="font-semibold text-foreground">Email service not connected</p>
                        <p className="mt-0.5">
                            You can still review candidates and preview messages. To send, your admin must add SMTP credentials to
                            the api-gateway environment (<span className="font-mono text-[10px]">EMAIL_USERNAME</span>,{" "}
                            <span className="font-mono text-[10px]">EMAIL_PASSWORD</span>).
                        </p>
                    </div>
                </div>
            )}

            <div className="px-4 py-3 border-b border-border bg-surface-2/20 flex flex-wrap items-center gap-3 text-xs">
                <span className="text-foreground-muted">
                    <strong className="text-foreground">{candidates.length}</strong> scored CVs
                </span>
                <span className="text-foreground-muted">
                    <strong className="text-foreground">{withEmail}</strong> with email
                </span>
                {needsEmail.length > 0 && (
                    <span className="text-amber-700 dark:text-amber-400">
                        <strong>{needsEmail.length}</strong> need email
                    </span>
                )}
                <span className="text-foreground-muted">
                    <strong className="text-foreground">{selected.size}</strong> selected
                </span>
                <div className="flex flex-wrap gap-2 ml-auto">
                    <button
                        type="button"
                        onClick={() => selectTop(5)}
                        disabled={!readyCandidates.length}
                        className="btn-secondary rounded-lg px-2.5 py-1 text-[11px] disabled:opacity-50"
                    >
                        Select top 5 ready
                    </button>
                    {onRunInChat && emailConfigured && (
                        <button
                            type="button"
                            onClick={() => onRunInChat("Email top 5 candidates interview invite")}
                            className="rounded-lg px-2.5 py-1 text-[11px] font-semibold border border-border hover:bg-surface-2"
                        >
                            Or send via chat
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-0 lg:divide-x divide-border">
                <div className="lg:col-span-3 overflow-x-auto max-h-[380px] overflow-y-auto">
                    {loading ? (
                        <div className="py-16 flex justify-center text-foreground-muted">
                            <Loader2 size={24} className="animate-spin" />
                        </div>
                    ) : !candidates.length ? (
                        <div className="py-12 px-4 text-center text-sm text-foreground-muted space-y-2">
                            <p>No scored CVs yet.</p>
                            <p className="text-xs">Upload resumes, wait until they are processed, then return here.</p>
                        </div>
                    ) : (
                        <table className="w-full text-left text-xs">
                            <thead className="sticky top-0 bg-surface z-10">
                                <tr className="text-[10px] uppercase tracking-wider text-foreground-muted border-b border-border">
                                    <th className="px-3 py-2 w-10" />
                                    <th className="px-3 py-2 font-semibold">Candidate</th>
                                    <th className="px-3 py-2 font-semibold">Email</th>
                                    <th className="px-3 py-2 font-semibold text-right w-20">Score</th>
                                </tr>
                            </thead>
                            <tbody>
                                {candidates.map((row) => (
                                    <CandidateRow
                                        key={row.documentId}
                                        row={row}
                                        accent={accent}
                                        checked={selected.has(row.documentId)}
                                        sending={sending}
                                        draftEmail={emailDrafts[row.documentId]}
                                        onToggle={() => toggle(row.documentId)}
                                        onDraftEmail={(v) =>
                                            setEmailDrafts((prev) => ({ ...prev, [row.documentId]: v }))
                                        }
                                        onSaveEmail={() => void handleSaveEmail(row.documentId)}
                                        savingEmail={savingId === row.documentId}
                                    />
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>

                <div className="lg:col-span-2 p-4 space-y-4">
                    <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted mb-2">
                            Template
                        </p>
                        <div className="space-y-2">
                            {TEMPLATES.map((t) => (
                                <label
                                    key={t.id}
                                    className={cn(
                                        "flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer transition-colors",
                                        template === t.id
                                            ? "border-accent bg-accent-muted"
                                            : "border-border hover:bg-surface-2/50"
                                    )}
                                >
                                    <input
                                        type="radio"
                                        name="outreach-template"
                                        checked={template === t.id}
                                        onChange={() => setTemplate(t.id)}
                                        className="mt-0.5"
                                    />
                                    <span>
                                        <span className="text-xs font-semibold block">{t.label}</span>
                                        <span className="text-[10px] text-foreground-muted">{t.hint}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                            Company
                            <input
                                value={companyName}
                                onChange={(e) => setCompanyName(e.target.value)}
                                className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        <label className="block text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                            Sender name
                            <input
                                value={senderName}
                                onChange={(e) => setSenderName(e.target.value)}
                                className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-normal"
                            />
                        </label>
                        {template === "interview_invite" && (
                            <label className="block text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                                Interview details
                                <textarea
                                    value={interviewDetails}
                                    onChange={(e) => setInterviewDetails(e.target.value)}
                                    rows={3}
                                    className="mt-1 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-normal resize-none"
                                />
                            </label>
                        )}
                    </div>

                    {selected.size > 0 && (
                        <div className="rounded-xl border border-border bg-surface-2/30 px-3 py-2.5 space-y-2">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted flex items-center gap-1">
                                <Eye size={12} /> Preview
                                {previewLoading && <Loader2 size={12} className="animate-spin" />}
                            </p>
                            {preview ? (
                                <>
                                    <p className="text-[11px] font-semibold text-foreground truncate">{preview.subject}</p>
                                    <p className="text-[10px] text-foreground-muted">To: {preview.name}</p>
                                    <pre className="text-[10px] text-foreground-muted whitespace-pre-wrap font-sans max-h-32 overflow-y-auto">
                                        {preview.body}
                                    </pre>
                                </>
                            ) : (
                                <p className="text-[10px] text-foreground-muted">Select a candidate to preview the email.</p>
                            )}
                        </div>
                    )}

                    {error && (
                        <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
                            <AlertCircle size={14} className="shrink-0 mt-0.5" /> {error}
                        </p>
                    )}

                    {lastResult && (
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs space-y-1">
                            <p className="font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
                                <CheckCircle2 size={14} /> Sent {lastResult.sent.length}
                                {lastResult.skipped.length > 0 && ` · skipped ${lastResult.skipped.length}`}
                                {lastResult.failed.length > 0 && ` · failed ${lastResult.failed.length}`}
                            </p>
                            {lastResult.sent.slice(0, 3).map((s) => (
                                <p key={s.documentId} className="text-foreground-muted">
                                    {s.candidateName} → {s.email}
                                </p>
                            ))}
                        </div>
                    )}

                    <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={sendDisabled}
                        className={cn(
                            "w-full rounded-xl px-4 py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-2 transition-opacity",
                            sendDisabled ? "bg-surface-2 text-foreground-muted cursor-not-allowed" : "text-white"
                        )}
                        style={sendDisabled ? undefined : { backgroundColor: accent }}
                    >
                        {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                        {!emailConfigured
                            ? "Connect email to send"
                            : `Send to ${selected.size || "…"} candidate${selected.size === 1 ? "" : "s"}`}
                    </button>
                </div>
            </div>
        </section>
    );
}
