import AgentStoragePricing, {
    PLAN_AGENT_IDS,
    type IAgentStoragePricing,
} from '../models/AgentStoragePricing';
import OrgSubscription, { type IOrgSubscription } from '../models/OrgSubscription';
import Document from '../models/Document';
import Organization from '../models/Organization';

function id() {
    return `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

export function generatePlanId() {
    return `plan_${id()}`;
}

export function generateRequestId() {
    return `preq_${id()}`;
}

export function generateSubscriptionId() {
    return `sub_${id()}`;
}

export async function getOrCreatePricing(): Promise<IAgentStoragePricing> {
    let doc = await AgentStoragePricing.findOne({ configId: 'default' });
    if (!doc) {
        doc = await AgentStoragePricing.create({
            configId: 'default',
            currency: 'USD',
            agents: PLAN_AGENT_IDS.map((agentId) => ({
                agentId,
                monthlyPrice: agentId === 'other_agent' ? 0 : 29,
                yearlyPrice: agentId === 'other_agent' ? 0 : 290,
                enabled: true,
            })),
            pricePerGbMonthly: 2,
            pricePerGbYearly: 20,
            freeAgentIds: ['other_agent'],
            freeStorageGb: 1,
        });
    } else {
        // Ensure all known agents exist in catalog
        const existing = new Set(doc.agents.map((a) => a.agentId));
        let changed = false;
        for (const agentId of PLAN_AGENT_IDS) {
            if (!existing.has(agentId)) {
                doc.agents.push({
                    agentId,
                    monthlyPrice: 29,
                    yearlyPrice: 290,
                    enabled: true,
                });
                changed = true;
            }
        }
        if (changed) await doc.save();
    }
    return doc;
}

export function quoteFromPricing(
    pricing: IAgentStoragePricing,
    agentIds: string[],
    storageGb: number,
    billingCycle: 'monthly' | 'yearly'
): number {
    const agentSet = new Set(agentIds);
    let total = 0;
    for (const row of pricing.agents) {
        if (!agentSet.has(row.agentId) || !row.enabled) continue;
        total += billingCycle === 'yearly' ? row.yearlyPrice : row.monthlyPrice;
    }
    const perGb = billingCycle === 'yearly' ? pricing.pricePerGbYearly : pricing.pricePerGbMonthly;
    total += Math.max(0, storageGb) * perGb;
    return Math.round(total * 100) / 100;
}

export function addBillingPeriod(from: Date, cycle: 'monthly' | 'yearly'): Date {
    const d = new Date(from);
    if (cycle === 'yearly') {
        d.setFullYear(d.getFullYear() + 1);
    } else {
        d.setMonth(d.getMonth() + 1);
    }
    return d;
}

export async function getActiveSubscription(
    organizationId: string | null | undefined
): Promise<IOrgSubscription | null> {
    if (!organizationId) return null;
    const now = new Date();
    const sub = await OrgSubscription.findOne({
        organizationId,
        status: 'active',
        endsAt: { $gt: now },
    })
        .sort({ endsAt: -1 })
        .lean();

    if (!sub) {
        // Mark expired leftovers
        await OrgSubscription.updateMany(
            { organizationId, status: 'active', endsAt: { $lte: now } },
            { $set: { status: 'expired' } }
        );
        return null;
    }
    return sub as IOrgSubscription;
}

export type OrgEntitlement = {
    agentIds: string[];
    storageGb: number;
    subscription: IOrgSubscription | null;
    planLabel: string;
    isFreeTier: boolean;
};

export async function getOrgEntitlement(
    organizationId: string | null | undefined
): Promise<OrgEntitlement> {
    // Independent lookups — parallelize to cut Atlas round-trip latency.
    const [pricing, sub] = await Promise.all([
        getOrCreatePricing(),
        getActiveSubscription(organizationId),
    ]);
    if (sub) {
        return {
            agentIds: sub.agentIds?.length ? sub.agentIds : [...pricing.freeAgentIds],
            storageGb: sub.storageGb,
            subscription: sub,
            planLabel: sub.planName || 'Custom',
            isFreeTier: false,
        };
    }
    return {
        agentIds: pricing.freeAgentIds?.length ? pricing.freeAgentIds : ['other_agent'],
        storageGb: pricing.freeStorageGb ?? 1,
        subscription: null,
        planLabel: 'free',
        isFreeTier: true,
    };
}

export async function getOrgStorageUsedBytes(organizationId: string): Promise<number> {
    const result = await Document.aggregate([
        { $match: { organizationId } },
        { $group: { _id: null, total: { $sum: '$sizeBytes' } } },
    ]);
    return result[0]?.total || 0;
}

export async function assertStorageAvailable(
    organizationId: string | null | undefined,
    additionalBytes: number
): Promise<{ ok: true } | { ok: false; message: string; usedBytes: number; limitBytes: number }> {
    if (!organizationId) {
        return { ok: false, message: 'Organization required', usedBytes: 0, limitBytes: 0 };
    }
    const entitlement = await getOrgEntitlement(organizationId);
    const limitBytes = entitlement.storageGb * 1024 * 1024 * 1024;
    const usedBytes = await getOrgStorageUsedBytes(organizationId);
    if (usedBytes + additionalBytes > limitBytes) {
        const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
        return {
            ok: false,
            message: `Storage limit exceeded (${usedGb} GB used of ${entitlement.storageGb} GB). Upgrade your plan.`,
            usedBytes,
            limitBytes,
        };
    }
    return { ok: true };
}

export function isAgentAllowed(entitlement: OrgEntitlement, agentId: string | null | undefined): boolean {
    if (!agentId) return true;
    return entitlement.agentIds.includes(agentId);
}

/** Pick a safe agent from the org plan (prefer requested, else other_agent, else first allowed). */
export function clampAgentToEntitlement(
    entitlement: OrgEntitlement,
    agentId: string | null | undefined
): string | undefined {
    if (!agentId) return undefined;
    if (entitlement.agentIds.includes(agentId)) return agentId;
    if (entitlement.agentIds.includes('other_agent')) return 'other_agent';
    return entitlement.agentIds[0];
}

export async function getAllowedAgentsForOrg(
    organizationId: string | null | undefined
): Promise<string[]> {
    const entitlement = await getOrgEntitlement(organizationId);
    return entitlement.agentIds;
}

/**
 * Reject if user (non-superAdmin) requests an agent outside their org plan.
 * Returns entitlement for reuse by callers.
 */
export async function requireAllowedAgent(
    user: { role?: string; organizationId?: string | null },
    agentId: string | null | undefined
): Promise<
    | { ok: true; entitlement: OrgEntitlement; agentId?: string }
    | { ok: false; message: string; entitlement: OrgEntitlement; code: string }
> {
    const entitlement = await getOrgEntitlement(user.organizationId);
    if (user.role === 'superAdmin') {
        return { ok: true, entitlement, agentId: agentId || undefined };
    }
    if (!agentId) {
        return { ok: true, entitlement };
    }
    if (!isAgentAllowed(entitlement, agentId)) {
        return {
            ok: false,
            code: 'AGENT_NOT_IN_PLAN',
            message: `Agent "${agentId}" is not included in your plan. Only plan agents can be used: ${entitlement.agentIds.join(', ') || 'none'}.`,
            entitlement,
        };
    }
    return { ok: true, entitlement, agentId };
}

export async function syncOrgSubscriptionLabel(
    organizationId: string,
    planLabel: string
): Promise<void> {
    await Organization.updateOne(
        { organizationId },
        { $set: { subscriptionPlan: planLabel || 'free' } }
    );
}

export async function activateSubscription(params: {
    organizationId: string;
    planId?: string | null;
    planName?: string | null;
    agentIds: string[];
    storageGb: number;
    billingCycle: 'monthly' | 'yearly';
    price: number;
    activatedBy: string;
    requestId?: string | null;
}): Promise<IOrgSubscription> {
    const now = new Date();
    // Cancel previous active subs
    await OrgSubscription.updateMany(
        { organizationId: params.organizationId, status: 'active' },
        { $set: { status: 'cancelled' } }
    );

    const planLabel = params.planName || 'Custom';
    const sub = await OrgSubscription.create({
        subscriptionId: generateSubscriptionId(),
        organizationId: params.organizationId,
        planId: params.planId || null,
        planName: planLabel,
        agentIds: params.agentIds,
        storageGb: params.storageGb,
        billingCycle: params.billingCycle,
        price: params.price,
        status: 'active',
        startsAt: now,
        endsAt: addBillingPeriod(now, params.billingCycle),
        activatedBy: params.activatedBy,
        requestId: params.requestId || null,
    });

    await syncOrgSubscriptionLabel(params.organizationId, planLabel);
    return sub;
}
