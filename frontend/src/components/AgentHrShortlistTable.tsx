"use client";

import React from "react";
import Link from "next/link";
import type { CvShortlistRow } from "@/lib/agentWorkspaceHr";
import { cn } from "@/lib/utils";

type Props = {
    rows: CvShortlistRow[];
    accent: string;
    maxRows?: number;
    onAsk?: (prompt: string) => void;
    onOpenOutreach?: () => void;
    compact?: boolean;
};

function scoreTone(score: number): string {
    if (score >= 80) return "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10";
    if (score >= 60) return "text-amber-700 dark:text-amber-400 bg-amber-500/10";
    return "text-foreground-muted bg-surface-2";
}

export default function AgentHrShortlistTable({ rows, accent, maxRows = 8, onAsk, onOpenOutreach, compact }: Props) {
    const shown = rows.slice(0, maxRows);
    if (!shown.length) return null;

    return (
        <section className={cn("rounded-2xl border border-border overflow-hidden", compact ? "bg-surface/30" : "bg-surface/50")}>
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-surface-2/30">
                <div>
                    <p className="text-xs font-bold text-foreground">Candidate shortlist</p>
                    {!compact && (
                        <p className="text-[10px] text-foreground-muted mt-0.5">Ranked by CV score from your portfolio</p>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {onOpenOutreach && (
                        <button
                            type="button"
                            onClick={onOpenOutreach}
                            className="text-[10px] font-semibold hover:underline"
                            style={{ color: accent }}
                        >
                            Email candidates →
                        </button>
                    )}
                    {onAsk && (
                        <button
                            type="button"
                            onClick={() => onAsk("Export shortlist top 10 candidates")}
                            className="text-[10px] font-semibold hover:underline"
                            style={{ color: accent }}
                        >
                            Export PDF →
                        </button>
                    )}
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                    <thead>
                        <tr className="text-[10px] uppercase tracking-wider text-foreground-muted border-b border-border">
                            <th className="px-4 py-2 font-semibold w-10">#</th>
                            <th className="px-4 py-2 font-semibold">Candidate</th>
                            <th className="px-4 py-2 font-semibold text-right w-24">Score</th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((row) => (
                            <tr key={`${row.rank}-${row.name}`} className="border-b border-border/50 last:border-0 hover:bg-surface-2/50">
                                <td className="px-4 py-2.5 tabular-nums text-foreground-muted font-medium">{row.rank}</td>
                                <td className="px-4 py-2.5 font-medium text-foreground">
                                    {row.documentId ? (
                                        <Link href={`/documents/${row.documentId}/details`} className="hover:underline">
                                            {row.name}
                                        </Link>
                                    ) : (
                                        row.name
                                    )}
                                </td>
                                <td className="px-4 py-2.5 text-right">
                                    <span
                                        className={cn(
                                            "inline-flex rounded-md px-2 py-0.5 font-bold tabular-nums",
                                            scoreTone(row.score)
                                        )}
                                    >
                                        {Math.round(row.score)}
                                    </span>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
