"use client";

import React from "react";
import ChatAgentVisuals from "@/components/ChatAgentVisuals";
import type { ChatVisualSpec } from "@/types/chatVisuals";
import { cn } from "@/lib/utils";

type Props = {
    visuals: ChatVisualSpec[];
    maxCharts?: number;
    onOpenCharts?: () => void;
    hideHeader?: boolean;
    /** Single-column full-width stack — best for command center main column */
    layout?: "grid" | "stack";
    /** Tighter chart headers and heights for dashboard previews */
    compact?: boolean;
};

export default function AgentChartPreviews({
    visuals,
    maxCharts = 2,
    onOpenCharts,
    hideHeader,
    layout = "grid",
    compact = false,
}: Props) {
    const preview = visuals.slice(0, maxCharts);
    if (!preview.length) return null;

    const isStack = layout === "stack";

    return (
        <section className={hideHeader ? "" : "space-y-3"}>
            {!hideHeader && (
                <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">
                        Live chart preview
                    </p>
                    {onOpenCharts && (
                        <button
                            type="button"
                            onClick={onOpenCharts}
                            className="text-[10px] font-medium text-accent hover:underline"
                        >
                            {visuals.length > maxCharts
                                ? `Open all ${visuals.length} charts →`
                                : "Open analytics →"}
                        </button>
                    )}
                </div>
            )}
            <div
                className={cn(
                    "gap-3",
                    isStack ? "flex flex-col" : "grid grid-cols-1 lg:grid-cols-2"
                )}
            >
                {preview.map((spec) => (
                    <div
                        key={spec.id}
                        role={onOpenCharts ? "button" : undefined}
                        tabIndex={onOpenCharts ? 0 : undefined}
                        onClick={onOpenCharts}
                        onKeyDown={
                            onOpenCharts
                                ? (e) => {
                                      if (e.key === "Enter" || e.key === " ") {
                                          e.preventDefault();
                                          onOpenCharts();
                                      }
                                  }
                                : undefined
                        }
                        className={cn(
                            "overflow-hidden",
                            isStack ? "rounded-xl" : "rounded-2xl",
                            onOpenCharts
                                ? "text-left border border-border bg-surface/50 hover:border-accent/40 hover:shadow-md transition-all cursor-pointer"
                                : "border border-border bg-surface/50"
                        )}
                    >
                        <ChatAgentVisuals visuals={[spec]} embedded compact={compact} />
                    </div>
                ))}
            </div>
        </section>
    );
}
