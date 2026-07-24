"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import { AGENT_OPTIONS } from "@/lib/documentAgents";
import { usePermissions } from "@/context/PermissionsContext";

export type PlanAgentOption = { value: string; label: string };

const ALL_AGENTS: PlanAgentOption[] = AGENT_OPTIONS.filter((o) => o.value);

/**
 * Agents the current org may use (from active/free plan).
 * Super Admin sees all agents. Until loaded, returns all to avoid empty UI flash —
 * backend still enforces.
 */
export function usePlanAgents() {
    const { role } = usePermissions();
    const [allowedIds, setAllowedIds] = useState<string[] | null>(null);
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        if (role === "superAdmin") {
            setAllowedIds(ALL_AGENTS.map((a) => a.value));
            setLoading(false);
            return;
        }
        setLoading(true);
        try {
            const data = await apiRequest("/docs/plans/subscription");
            const ids: string[] = data?.data?.entitlement?.agentIds || [];
            setAllowedIds(ids.length ? ids : ["other_agent"]);
        } catch {
            setAllowedIds(["other_agent"]);
        } finally {
            setLoading(false);
        }
    }, [role]);

    useEffect(() => {
        reload();
    }, [reload]);

    const agentOptions: PlanAgentOption[] =
        role === "superAdmin" || !allowedIds
            ? ALL_AGENTS
            : ALL_AGENTS.filter((a) => allowedIds.includes(a.value));

    const isAgentAllowed = (agentId: string) => {
        if (role === "superAdmin") return true;
        if (!allowedIds) return true;
        return allowedIds.includes(agentId);
    };

    return { agentOptions, allowedIds, loading, reload, isAgentAllowed };
}
