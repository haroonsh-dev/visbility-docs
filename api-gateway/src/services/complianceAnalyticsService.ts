import Document from '../models/Document';
import { AuthUser, buildDocumentFilter } from './accessScope';
import {
    getDocumentExtractions,
    getAiDocument,
    resolveDocumentAiOrgId,
} from './aiServiceClient';
import type { ChatVisualSpec } from '../types/chatVisuals';
import { scalarField } from './financeAnalyticsService';

export const COMPLIANCE_AGENT = 'compliance_agent';

export const COMPLIANCE_DOC_TYPES = new Set([
    'sop',
    'audit_report',
    'quality_report',
    'certificate',
    'maintenance_report',
    'engineering_drawing',
    'inspection_report',
    'safety_manual',
    'iso_document',
    'compliance_form',
    'regulatory_document',
]);

export type LoadComplianceOptions = {
    maxDocs?: number;
    documentIds?: string[];
};

export type ComplianceDocSnapshot = {
    documentId: string;
    filename: string;
    classification: string;
    expiryDate: Date | null;
    certStatus: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNKNOWN';
    daysUntilExpiry: number | null;
    overallStatus: string;
    findings: Array<{ severity: string; description: string }>;
};

export type ComplianceAnalyticsCoverage = {
    documentsInScope: number;
    documentsWithExpiry: number;
    documentsWithFindings: number;
    files?: Array<{
        documentId: string;
        filename: string;
        status: 'in_charts' | 'no_extraction' | 'not_linked';
        detail?: string;
    }>;
};

function parseDate(raw: unknown): Date | null {
    const s = scalarField(raw);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeExtractionPayload(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    const add = data.additional_information;
    if (add && typeof add === 'object' && !Array.isArray(add)) {
        for (const [k, v] of Object.entries(add as Record<string, unknown>)) {
            if (out[k] == null || out[k] === '') out[k] = v;
        }
    }
    return out;
}

function pickExtractionData(extractions: Awaited<ReturnType<typeof getDocumentExtractions>>): Record<string, unknown> {
    if (!extractions?.length) return {};
    const sorted = [...extractions].sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
        return tb - ta;
    });
    const merged: Record<string, unknown> = {};
    for (const ext of [...sorted].reverse()) {
        if (String(ext.extraction_type || '') === 'table_extraction') continue;
        const chunk = (ext.extracted_data || {}) as Record<string, unknown>;
        Object.assign(merged, chunk);
    }
    return normalizeExtractionPayload(merged);
}

async function extractionPayloadForDoc(
    doc: { pythonDocumentId?: string | null; organizationId?: string | null; metadata?: unknown },
    user: AuthUser
): Promise<Record<string, unknown>> {
    if (!doc.pythonDocumentId) return {};
    const orgId = resolveDocumentAiOrgId(doc as { organizationId?: string | null }, user);
    let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
    if (!extractions?.length && orgId) {
        extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
    }
    let data = pickExtractionData(extractions);
    if (!Object.keys(data).length) {
        const aiDoc = await getAiDocument(doc.pythonDocumentId, orgId);
        const meta = aiDoc?.extracted_data;
        if (meta && typeof meta === 'object') {
            data = normalizeExtractionPayload({ ...data, ...(meta as Record<string, unknown>) });
        }
    }
    return data;
}

function daysBetween(from: Date, to: Date): number {
    const ms = to.getTime() - from.getTime();
    return Math.floor(ms / (24 * 60 * 60 * 1000));
}

export function deriveCertStatus(
    expiryDate: Date | null,
    explicitStatus?: string,
    daysUntilFromExtraction?: number | null
): { status: ComplianceDocSnapshot['certStatus']; daysUntilExpiry: number | null } {
    const normalized = (explicitStatus || '').toUpperCase().replace(/\s+/g, '_');
    if (normalized === 'VALID' || normalized === 'EXPIRING_SOON' || normalized === 'EXPIRED') {
        return {
            status: normalized as ComplianceDocSnapshot['certStatus'],
            daysUntilExpiry:
                daysUntilFromExtraction != null && Number.isFinite(daysUntilFromExtraction)
                    ? daysUntilFromExtraction
                    : expiryDate
                      ? daysBetween(new Date(), expiryDate)
                      : null,
        };
    }

    if (expiryDate) {
        const days = daysBetween(new Date(), expiryDate);
        if (days < 0) return { status: 'EXPIRED', daysUntilExpiry: days };
        if (days <= 90) return { status: 'EXPIRING_SOON', daysUntilExpiry: days };
        return { status: 'VALID', daysUntilExpiry: days };
    }

    if (daysUntilFromExtraction != null && Number.isFinite(daysUntilFromExtraction)) {
        const days = daysUntilFromExtraction;
        if (days < 0) return { status: 'EXPIRED', daysUntilExpiry: days };
        if (days <= 90) return { status: 'EXPIRING_SOON', daysUntilExpiry: days };
        return { status: 'VALID', daysUntilExpiry: days };
    }

    return { status: 'UNKNOWN', daysUntilExpiry: null };
}

function normalizeSeverity(raw: string): string {
    const s = raw.trim().toUpperCase();
    if (!s) return 'UNSPECIFIED';
    if (/CRITICAL|SEVERE|HIGH/.test(s)) return 'CRITICAL';
    if (/MAJOR/.test(s)) return 'MAJOR';
    if (/MINOR|LOW/.test(s)) return 'MINOR';
    if (/OBSERVATION|INFO/.test(s)) return 'OBSERVATION';
    return s.length > 24 ? `${s.slice(0, 22)}…` : s;
}

export function extractComplianceFindings(data: Record<string, unknown>): Array<{ severity: string; description: string }> {
    const out: Array<{ severity: string; description: string }> = [];

    const structured = data.audit_findings;
    if (Array.isArray(structured)) {
        for (const row of structured) {
            if (!row || typeof row !== 'object') continue;
            const r = row as Record<string, unknown>;
            const desc =
                scalarField(r.description) ||
                scalarField(r.finding) ||
                scalarField(r.summary) ||
                scalarField(r.corrective_action_required) ||
                'Finding';
            const sev = normalizeSeverity(scalarField(r.severity) || 'UNSPECIFIED');
            out.push({ severity: sev, description: desc });
        }
    }

    const legacy = data.findings;
    if (Array.isArray(legacy)) {
        for (const item of legacy) {
            if (typeof item === 'string' && item.trim()) {
                out.push({ severity: 'UNSPECIFIED', description: item.trim() });
            } else if (item && typeof item === 'object') {
                const r = item as Record<string, unknown>;
                out.push({
                    severity: normalizeSeverity(scalarField(r.severity) || 'UNSPECIFIED'),
                    description:
                        scalarField(r.description) || scalarField(r.text) || scalarField(r.finding) || 'Finding',
                });
            }
        }
    }

    return out;
}

function buildComplianceScopeQuery(filter: Record<string, unknown>, documentIds?: string[]): Record<string, unknown> {
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
        $or: [
            { classification: { $in: [...COMPLIANCE_DOC_TYPES] } },
            { 'metadata.phase3Agent': COMPLIANCE_AGENT },
        ],
    };
    if (documentIds?.length) {
        delete query.$or;
        query.documentId = { $in: documentIds };
    }
    return query;
}

export async function loadComplianceDocsForAnalytics(
    user: AuthUser,
    options: LoadComplianceOptions = {}
) {
    const maxDocs = options.maxDocs ?? 80;
    const filter = await buildDocumentFilter(user, {});
    const query = buildComplianceScopeQuery(filter, options.documentIds);
    return Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();
}

export async function loadComplianceSnapshots(
    user: AuthUser,
    options: LoadComplianceOptions = {}
): Promise<ComplianceDocSnapshot[]> {
    const docs = await loadComplianceDocsForAnalytics(user, options);
    const snapshots: ComplianceDocSnapshot[] = [];

    for (const doc of docs) {
        const data = await extractionPayloadForDoc(doc, user);
        const expiryDate = parseDate(data.expiry_date);
        const daysRaw = data.days_until_expiry;
        const daysNum =
            typeof daysRaw === 'number' && Number.isFinite(daysRaw)
                ? daysRaw
                : parseInt(String(daysRaw ?? ''), 10);
        const { status, daysUntilExpiry } = deriveCertStatus(
            expiryDate,
            scalarField(data.status),
            Number.isFinite(daysNum) ? daysNum : null
        );

        snapshots.push({
            documentId: doc.documentId,
            filename: doc.originalFilename,
            classification: String(doc.classification || 'other'),
            expiryDate,
            certStatus: status,
            daysUntilExpiry,
            overallStatus:
                scalarField(data.overall_compliance_status) ||
                scalarField(data.compliance_status) ||
                scalarField(data.result) ||
                '',
            findings: extractComplianceFindings(data),
        });
    }

    return snapshots;
}

function truncateLabel(text: string, max = 28): string {
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
}

function docIdsField(ids: Set<string>): string {
    return [...ids].join(',');
}

export function buildCertStatusVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const counts = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        if (s.expiryDate == null && s.certStatus === 'UNKNOWN') continue;
        const key = s.certStatus;
        const bucket = counts.get(key) || { count: 0, docs: new Set<string>() };
        bucket.count += 1;
        bucket.docs.add(s.documentId);
        counts.set(key, bucket);
    }

    const order = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'UNKNOWN'];
    const rows = order
        .filter((k) => counts.has(k))
        .map((k) => {
            const b = counts.get(k)!;
            return {
                status: k.replace(/_/g, ' '),
                count: b.count,
                _documentIds: docIdsField(b.docs),
            };
        });

    return {
        id: `comp_cert_status_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'pie',
        title: 'Certificate validity',
        subtitle: 'From expiry dates & status fields',
        categoryKey: 'status',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows.length ? rows : [{ status: 'No expiry data', count: 0 }],
        footer: 'VALID · EXPIRING_SOON (≤90d) · EXPIRED from extraction.',
    };
}

export function buildExpiryTimelineVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const withExpiry = snapshots
        .filter((s) => s.daysUntilExpiry != null)
        .sort((a, b) => (a.daysUntilExpiry ?? 0) - (b.daysUntilExpiry ?? 0))
        .slice(0, 12);

    return {
        id: `comp_expiry_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'bar',
        title: 'Days until certificate expiry',
        subtitle: 'Negative = already expired',
        categoryKey: 'certificate',
        series: [{ key: 'days', label: 'Days until expiry', color: '#e11d48' }],
        data: withExpiry.map((s) => ({
            certificate: truncateLabel(s.filename),
            days: s.daysUntilExpiry as number,
            _documentIds: s.documentId,
        })),
        footer: 'Sorted by soonest expiry. Based on extracted expiry_date.',
    };
}

export function buildFindingsSeverityVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const buckets = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        for (const f of s.findings) {
            const key = f.severity;
            const b = buckets.get(key) || { count: 0, docs: new Set<string>() };
            b.count += 1;
            b.docs.add(s.documentId);
            buckets.set(key, b);
        }
    }

    const rows = [...buckets.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([severity, b]) => ({
            severity,
            count: b.count,
            _documentIds: docIdsField(b.docs),
        }));

    return {
        id: `comp_findings_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'bar',
        title: 'Audit findings by severity',
        subtitle: 'Across scoped compliance documents',
        categoryKey: 'severity',
        series: [{ key: 'count', label: 'Findings', color: '#7c3aed' }],
        data: rows,
        footer: 'From audit_findings[] and findings[] in extractions.',
    };
}

export function buildComplianceStatusVisual(snapshots: ComplianceDocSnapshot[]): ChatVisualSpec {
    const buckets = new Map<string, { count: number; docs: Set<string> }>();
    for (const s of snapshots) {
        const key = s.overallStatus.trim() || 'Not specified';
        const b = buckets.get(key) || { count: 0, docs: new Set<string>() };
        b.count += 1;
        b.docs.add(s.documentId);
        buckets.set(key, b);
    }

    const rows = [...buckets.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([status, b]) => ({
            status: truncateLabel(status, 32),
            count: b.count,
            _documentIds: docIdsField(b.docs),
        }));

    return {
        id: `comp_status_mix_${Date.now()}`,
        agentId: COMPLIANCE_AGENT,
        kind: 'pie',
        title: 'Overall compliance status',
        subtitle: 'Audit / inspection summaries',
        categoryKey: 'status',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows,
        footer: 'From overall_compliance_status and related fields.',
    };
}

export function computeComplianceCoverage(
    snapshots: ComplianceDocSnapshot[],
    docsInScope: number
): ComplianceAnalyticsCoverage {
    const withExpiry = snapshots.filter((s) => s.expiryDate != null || s.certStatus !== 'UNKNOWN').length;
    const withFindings = snapshots.filter((s) => s.findings.length > 0).length;
    return {
        documentsInScope: docsInScope,
        documentsWithExpiry: withExpiry,
        documentsWithFindings: withFindings,
    };
}

export async function buildComplianceFileCoverage(
    user: AuthUser,
    snapshots: ComplianceDocSnapshot[],
    options: LoadComplianceOptions = {}
): Promise<NonNullable<ComplianceAnalyticsCoverage['files']>> {
    const docs = await loadComplianceDocsForAnalytics(user, options);
    const snapById = new Map(snapshots.map((s) => [s.documentId, s]));
    return docs.map((d) => {
        const snap = snapById.get(d.documentId);
        if (!d.pythonDocumentId) {
            return {
                documentId: d.documentId,
                filename: d.originalFilename,
                status: 'not_linked' as const,
                detail: 'Not linked to AI processing yet.',
            };
        }
        if (!snap) {
            return {
                documentId: d.documentId,
                filename: d.originalFilename,
                status: 'no_extraction' as const,
                detail: 'No extraction payload found.',
            };
        }
        const inCharts =
            snap.findings.length > 0 ||
            snap.expiryDate != null ||
            snap.certStatus !== 'UNKNOWN' ||
            Boolean(snap.overallStatus);
        return {
            documentId: d.documentId,
            filename: d.originalFilename,
            status: inCharts ? ('in_charts' as const) : ('no_extraction' as const),
            detail: inCharts ? undefined : 'Reprocess with Compliance Agent for expiry/findings fields.',
        };
    });
}
