import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    COMPLIANCE_AGENT,
    analyzeMissingComplianceDocs,
    filterAttentionSnapshots,
    loadComplianceDocsForAnalytics,
    loadComplianceSnapshots,
    type ComplianceDocSnapshot,
} from './complianceAnalyticsService';
import {
    applyDocumentTypeStorage,
    ensureUploadDir,
    getDocumentDir,
    resolveOrgFolder,
} from './documentStorage';
import { sanitizeFilename } from '../utils/fileValidation';
import { requireAllowedAgent } from './planService';
import logger from '../utils/logger';
import { generateComplianceReportPdf } from './aiServiceClient';
import { getOrgComplianceSettings } from './orgComplianceSettingsService';

export type ComplianceChatCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type ComplianceChatActionResult = {
    handled: boolean;
    answer?: string;
    citations?: ComplianceChatCitation[];
};

const GENERATED_REPORT_TYPE = 'compliance_report';

export type ComplianceSectionKind = 'certificates' | 'findings' | 'register' | 'status';
export type ComplianceLetterKind = 'ncr' | 'capa' | 'certificate_of_compliance';

function pdfPreviewPath(documentId: string): string {
    return `/documents/${documentId}`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatCertStatus(status: ComplianceDocSnapshot['certStatus']): string {
    return status.replace(/_/g, ' ');
}

function daysLabel(s: ComplianceDocSnapshot): string {
    if (s.daysUntilExpiry == null) return '—';
    return s.daysUntilExpiry < 0
        ? `${Math.abs(s.daysUntilExpiry)}d ago`
        : `${s.daysUntilExpiry}d left`;
}

/** Compliance Agent only — never fire for finance/HR/other agents. */
export function detectComplianceReportCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\s+agent\b/i.test(question)) return false;
    const q = question.toLowerCase().trim();
    if (!q) return false;

    const wantsGenerate =
        /\b(generate|create|make|draft|export|download|prepare|build)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    const wantsReport =
        /\bcompliance\s+report\b/.test(q) ||
        (/\breport\b/.test(q) &&
            !/\b(expense|offer|experience|extraction|email|hr|finance)\s+report\b/.test(q) &&
            (phase3Agent === COMPLIANCE_AGENT || /\bcompliance\b/.test(q)));

    return wantsGenerate && wantsReport;
}

export function detectComplianceSectionPdf(
    question: string,
    phase3Agent?: string
): ComplianceSectionKind | null {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wants =
        /\b(generate|create|export|download|prepare|make|draft)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);
    if (!wants) return null;
    if (/\b(certificate|cert|expiry|expiring)\b/.test(q) && /\b(report|pdf|export|list)\b/.test(q)) {
        return 'certificates';
    }
    if (/\b(finding|findings|ncr|non[- ]?conformance)\b/.test(q) && /\b(report|pdf|export)\b/.test(q)) {
        return 'findings';
    }
    if (/\b(register|inventory|document\s+register|compliance\s+register)\b/.test(q)) {
        return 'register';
    }
    if (/\b(status\s+report|compliance\s+status\s+pdf)\b/.test(q)) return 'status';
    return null;
}

export function detectComplianceLetter(
    question: string,
    phase3Agent?: string
): ComplianceLetterKind | null {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return null;
    const q = question.toLowerCase();
    const wants =
        /\b(generate|create|draft|write|prepare|make|issue|send)\b/.test(q) ||
        (phase3Agent === COMPLIANCE_AGENT && /\bletter\b/.test(q));
    if (!wants && !/\b(ncr|capa|corrective\s+action|non[- ]?conformance)\b/.test(q)) return null;

    if (
        /\b(ncr|non[- ]?conformance)\b/.test(q) &&
        (/\bletter\b/.test(q) || /\bnotice\b/.test(q) || /\b(generate|create|draft|issue)\b/.test(q))
    ) {
        return 'ncr';
    }
    if (
        /\b(capa|corrective\s+action)\b/.test(q) &&
        (/\bletter\b/.test(q) || /\brequest\b/.test(q) || /\b(generate|create|draft|issue)\b/.test(q))
    ) {
        return 'capa';
    }
    if (
        /\bcertificate\s+of\s+compliance\b/.test(q) ||
        (/\bcoc\b/.test(q) && /\b(letter|certificate|generate|draft)\b/.test(q))
    ) {
        return 'certificate_of_compliance';
    }
    return null;
}

export function detectComplianceExpiryAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return false;
    const q = question.toLowerCase();
    return (
        /\b(expir\w*|renewal|validit\w*)\b/.test(q) &&
        /\b(soon|next|within|list|show|what|which|alert|attention)\b/.test(q)
    );
}

export function detectComplianceMissingDocsAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== COMPLIANCE_AGENT && !/\bcompliance\b/i.test(question)) return false;
    const q = question.toLowerCase();
    return (
        /\b(missing\s+doc|missing\s+compliance|incomplete\s+packet|required\s+docs?|packet\s+completeness)\b/.test(
            q
        ) ||
        /\bwhat\b.{0,40}\b(docs?|documents?)\b.{0,20}\bmissing\b/.test(q) ||
        /\bmissing\b.{0,30}\b(docs?|documents?|certificate|sop|audit|inspection|regulatory)\b/.test(q)
    );
}

function parseField(question: string, keys: string[]): string {
    for (const key of keys) {
        const re = new RegExp(`${key}\\s*[:=]?\\s*([^,\\n]+)`, 'i');
        const m = question.match(re);
        if (m?.[1]?.trim()) return m[1].trim().replace(/[.]+$/, '');
    }
    return '';
}

function parsePartyName(question: string): string | null {
    const patterns = [
        /(?:ncr|capa|non[- ]?conformance|corrective\s+action|certificate\s+of\s+compliance)\s+(?:letter|notice|request)?\s*(?:for|to|of)\s+([^,\n.]+)/i,
        /\b(?:for|to|of)\s+([A-Za-z][A-Za-z0-9\s.'-]{1,60}?)(?:\s*[,.]|\s+company\b|\s+regarding\b|$)/i,
    ];
    for (const re of patterns) {
        const m = question.match(re);
        const raw = m?.[1]?.trim();
        if (raw && raw.length >= 2 && !/^(top|the|a|an)$/i.test(raw)) {
            return raw.replace(/\b(company|regarding|reason|standard)\b.*$/i, '').trim();
        }
    }
    return null;
}

function buildComplianceReportHtml(params: {
    snapshots: ComplianceDocSnapshot[];
    orgLabel?: string;
    title?: string;
    section?: ComplianceSectionKind | 'full';
}): { subject: string; html: string } {
    const { snapshots } = params;
    const section = params.section || 'full';
    const generatedAt = new Date();
    const dateLabel = generatedAt.toISOString().slice(0, 10);
    const title =
        params.title ||
        (section === 'certificates'
            ? 'Certificate & expiry report'
            : section === 'findings'
              ? 'Findings & NCR report'
              : section === 'register'
                ? 'Compliance document register'
                : section === 'status'
                  ? 'Compliance status summary'
                  : 'Compliance report');
    const subject = `${title} — ${dateLabel}`;

    const valid = snapshots.filter((s) => s.certStatus === 'VALID').length;
    const expiring = snapshots.filter((s) => s.certStatus === 'EXPIRING_SOON').length;
    const expired = snapshots.filter((s) => s.certStatus === 'EXPIRED').length;
    const unknown = snapshots.filter((s) => s.certStatus === 'UNKNOWN').length;
    const findingCount = snapshots.reduce((n, s) => n + s.findings.length, 0);
    const severityBuckets = snapshots.reduce(
        (acc, s) => {
            for (const f of s.findings || []) {
                const sev = String(f.severity || '').toUpperCase();
                acc[sev] = (acc[sev] || 0) + 1;
            }
            return acc;
        },
        {} as Record<string, number>
    );
    const criticalCount = severityBuckets.CRITICAL || 0;
    const majorCount = severityBuckets.MAJOR || 0;
    const minorCount = severityBuckets.MINOR || 0;
    const observationCount = severityBuckets.OBSERVATION || severityBuckets.INFO || 0;
    const attention = filterAttentionSnapshots(snapshots);
    const nonCompliant = snapshots.filter((s) => s.normalizedStatus === 'non_compliant').length;

    const insights: string[] = [];
    if (expired) insights.push(`${expired} document(s) already expired — renew immediately.`);
    if (expiring) insights.push(`${expiring} document(s) expiring within the warning window.`);
    if (criticalCount) insights.push(`${criticalCount} critical finding(s) require CAPA.`);
    if (nonCompliant) insights.push(`${nonCompliant} document(s) marked non-compliant.`);
    if (!insights.length) insights.push('No urgent expiry or critical finding signals in current scope.');

    let bodyRows = snapshots;
    if (section === 'certificates') {
        bodyRows = snapshots.filter((s) => s.expiryDate != null || s.certStatus !== 'UNKNOWN');
    } else if (section === 'findings') {
        bodyRows = snapshots.filter((s) => s.findings.length > 0);
    }

    const rows = bodyRows
        .map((s, idx) => {
            const expiry = s.expiryDate != null ? s.expiryDate.toISOString().slice(0, 10) : '—';
            const findings =
                s.findings.length > 0
                    ? s.findings
                          .slice(0, 5)
                          .map((f) => `${escapeHtml(f.severity)}: ${escapeHtml(f.description)}`)
                          .join('<br>')
                    : '—';
            return `<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${idx + 1}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(s.filename)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(s.classification)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(s.certificateNumber || '—')}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(formatCertStatus(s.certStatus))}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(expiry)}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(daysLabel(s))}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(s.overallStatus || s.normalizedStatus || '—')}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${escapeHtml(s.standardOrRegulation || '—')}</td>
  <td style="padding:8px 10px;border-bottom:1px solid #e2e8f0;font-size:12px;">${findings}</td>
</tr>`;
        })
        .join('\n');

    const attentionBlock =
        attention.length > 0 && section !== 'findings'
            ? `<div style="margin:18px 0;padding:14px 16px;border-radius:10px;background:#fff1f2;border:1px solid #fecdd3;">
  <h2 style="margin:0 0 8px;font-size:14px;color:#9f1239;">Attention — expiring or expired</h2>
  <ul style="margin:0;padding-left:18px;font-size:13px;color:#881337;">
    ${attention
        .slice(0, 20)
        .map(
            (s) =>
                `<li><strong>${escapeHtml(s.filename)}</strong> — ${escapeHtml(formatCertStatus(s.certStatus))} (${escapeHtml(daysLabel(s))})${s.standardOrRegulation ? ` · ${escapeHtml(s.standardOrRegulation)}` : ''}</li>`
        )
        .join('')}
  </ul>
</div>`
            : '';

    const insightBlock = `<div style="margin:14px 0;padding:12px 14px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;">
  <h2 style="margin:0 0 8px;font-size:14px;color:#1e293b;">Executive insights</h2>
  <ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;">
    ${insights.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}
  </ul>
</div>`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(subject)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #0f172a; background: #f1f5f9; margin: 0; padding: 28px; }
  .wrap { max-width: 1100px; margin: 0 auto; background: #fff; border: 1px solid #cbd5e1; border-radius: 4px; padding: 32px 36px; }
  .brand { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: #64748b; }
  h1 { margin: 6px 0 6px; font-size: 24px; color: #0f172a; }
  .meta { color: #64748b; font-size: 12px; margin-bottom: 18px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin: 16px 0 8px; }
  .card { border: 1px solid #e2e8f0; border-radius: 4px; padding: 12px 14px; background: #f8fafc; }
  .card .label { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; font-family: ui-sans-serif, system-ui, sans-serif; }
  .card .value { font-size: 22px; font-weight: 700; margin-top: 4px; font-family: ui-sans-serif, system-ui, sans-serif; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-family: ui-sans-serif, system-ui, sans-serif; }
  th { text-align: left; padding: 8px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: #64748b; border-bottom: 2px solid #e2e8f0; background: #f8fafc; }
  @media print { body { background: #fff; padding: 0; } .wrap { border: none; } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">Visibility Docs · Compliance Agent</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">Generated ${escapeHtml(generatedAt.toLocaleString())}${
        params.orgLabel ? ` · ${escapeHtml(params.orgLabel)}` : ''
    } · ${snapshots.length} document(s) analysed</div>
    ${section === 'full' || section === 'status' ? insightBlock : ''}
    <div class="cards">
      <div class="card"><div class="label">Documents</div><div class="value">${snapshots.length}</div></div>
      <div class="card"><div class="label">Valid</div><div class="value" style="color:#15803d;">${valid}</div></div>
      <div class="card"><div class="label">Expiring soon</div><div class="value" style="color:#b45309;">${expiring}</div></div>
      <div class="card"><div class="label">Expired</div><div class="value" style="color:#b91c1c;">${expired}</div></div>
      <div class="card"><div class="label">Unknown expiry</div><div class="value">${unknown}</div></div>
      <div class="card"><div class="label">Findings</div><div class="value" style="color:#7c3aed;">${findingCount}</div></div>
      <div class="card"><div class="label">Critical</div><div class="value" style="color:#b91c1c;">${criticalCount}</div></div>
      <div class="card"><div class="label">Major</div><div class="value" style="color:#f97316;">${majorCount}</div></div>
      <div class="card"><div class="label">Minor</div><div class="value" style="color:#0ea5e9;">${minorCount}</div></div>
      <div class="card"><div class="label">Observation</div><div class="value" style="color:#7c3aed;">${observationCount}</div></div>
    </div>
    ${attentionBlock}
    <h2 style="margin:22px 0 8px;font-size:15px;font-family:ui-sans-serif,system-ui,sans-serif;">Document detail</h2>
    <table>
      <thead>
        <tr>
          <th>#</th><th>File</th><th>Type</th><th>Ref #</th><th>Cert status</th><th>Expiry</th><th>Days</th><th>Overall</th><th>Standard</th><th>Findings</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="10" style="padding:12px;color:#94a3b8;">No matching compliance documents in scope.</td></tr>`}
      </tbody>
    </table>
    <p style="margin-top:20px;font-size:11px;color:#94a3b8;font-family:ui-sans-serif,system-ui,sans-serif;">Built from Compliance Agent extractions after upload analysis (expiry, status, standards, findings). Reprocess documents if fields are missing.</p>
  </div>
</body>
</html>`;

    return { subject, html };
}

function buildComplianceLetterHtml(params: {
    kind: ComplianceLetterKind;
    partyName: string;
    company: string;
    standard?: string;
    finding?: string;
    dueDate?: string;
    reference?: string;
}): { subject: string; html: string; classification: string } {
    const today = new Date().toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
    });
    const ref =
        params.reference ||
        `COMP/${params.kind.toUpperCase()}/${new Date().getFullYear()}/${Math.floor(Math.random() * 900 + 100)}`;

    const labels: Record<ComplianceLetterKind, string> = {
        ncr: 'Non-Conformance Notice (NCR)',
        capa: 'Corrective Action Request (CAPA)',
        certificate_of_compliance: 'Certificate of Compliance',
    };
    const classificationMap: Record<ComplianceLetterKind, string> = {
        ncr: 'ncr_letter',
        capa: 'capa_letter',
        certificate_of_compliance: 'certificate_of_compliance',
    };

    let body = '';
    if (params.kind === 'ncr') {
        body = `
<p>Dear <b>${escapeHtml(params.partyName)}</b>,</p>
<p>This notice records a non-conformance identified against <b>${escapeHtml(params.standard || 'applicable compliance requirements')}</b>.</p>
<p><b>Finding / deviation:</b> ${escapeHtml(params.finding || 'As discussed / documented in the referenced audit or inspection.')}</p>
<p>You are required to acknowledge this NCR and submit a proposed corrective action plan${params.dueDate ? ` by <b>${escapeHtml(params.dueDate)}</b>` : ''}.</p>
<p>Please treat this as an official compliance record.</p>`;
    } else if (params.kind === 'capa') {
        body = `
<p>Dear <b>${escapeHtml(params.partyName)}</b>,</p>
<p>Please initiate a Corrective and Preventive Action (CAPA) for the following issue under <b>${escapeHtml(params.standard || 'the applicable standard')}</b>.</p>
<p><b>Issue:</b> ${escapeHtml(params.finding || 'As identified in the compliance review.')}</p>
<p>Your CAPA response should include root cause analysis, containment, corrective action, and verification of effectiveness${params.dueDate ? `, due <b>${escapeHtml(params.dueDate)}</b>` : ''}.</p>`;
    } else {
        body = `
<div style="text-align:center;margin:24px 0 16px;">
  <div style="font-size:11pt;letter-spacing:.16em;text-transform:uppercase;color:#64748b;">Certificate of Compliance</div>
  <div style="font-size:18pt;font-weight:700;margin-top:8px;">${escapeHtml(params.company)}</div>
</div>
<p style="text-align:center;">This certifies that <b>${escapeHtml(params.partyName)}</b> has demonstrated compliance with
<b>${escapeHtml(params.standard || 'the stated requirements')}</b>${params.reference ? ` (ref ${escapeHtml(params.reference)})` : ''}.</p>
<p style="text-align:center;color:#475569;font-size:10pt;">Issued for official use. Validity is subject to ongoing conformance and supporting documentation on file.</p>`;
    }

    const subject = `${labels[params.kind]} — ${params.partyName}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(subject)}</title>
<style>
  body{font-family:Georgia,"Times New Roman",serif;padding:48px 56px;color:#0f172a;line-height:1.55;font-size:11.5pt;}
  .header{border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:18px;}
  .company{font-size:18pt;font-weight:700;}
  .sub{color:#64748b;font-size:9pt;margin-top:4px;}
  .ref{margin:14px 0 22px;font-size:9.5pt;color:#475569;}
  .sign{margin-top:48px;}
  .sign-line{margin-top:36px;border-top:1px solid #94a3b8;width:240px;padding-top:6px;font-size:10pt;}
</style></head><body>
<div class="header">
  <div class="company">${escapeHtml(params.company)}</div>
  <div class="sub">Compliance · Official correspondence</div>
</div>
<div class="ref">Ref: ${escapeHtml(ref)} &nbsp;|&nbsp; Date: ${escapeHtml(today)} &nbsp;|&nbsp; ${escapeHtml(labels[params.kind])}</div>
${body}
<div class="sign">
  <p>Yours sincerely,</p>
  <div class="sign-line"><b>Compliance Officer</b><br/>${escapeHtml(params.company)}</div>
</div>
</body></html>`;

    return { subject, html, classification: classificationMap[params.kind] };
}

async function saveGeneratedCompliancePdf(
    user: AuthUser,
    pdfBase64: string,
    filenameBase: string,
    classification: string,
    sourceDocumentIds: string[]
): Promise<InstanceType<typeof Document>> {
    ensureUploadDir();
    const buf = Buffer.from(pdfBase64, 'base64');
    const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `compliance_${uuidv4()}.pdf`);
    fs.writeFileSync(tmpPath, buf);

    const documentId = `doc_${uuidv4()}`;
    const orgFolder = resolveOrgFolder(user.organizationId, user.userId);
    const destDir = getDocumentDir(orgFolder, documentId, { inbox: true });
    fs.mkdirSync(destDir, { recursive: true });

    const originalFilename = sanitizeFilename(`${filenameBase}.pdf`);
    const storedFilename = originalFilename;
    const storagePath = path.join(destDir, storedFilename);
    fs.renameSync(tmpPath, storagePath);

    const contentHash = crypto.createHash('sha256').update(buf).digest('hex');

    const doc = await Document.create({
        documentId,
        organizationId: user.organizationId || null,
        uploadedBy: user.userId,
        openRemoteUserId: (user as { openRemoteUserId?: string | null }).openRemoteUserId || null,
        originalFilename,
        storedFilename,
        mimeType: 'application/pdf',
        sizeBytes: buf.length,
        storagePath,
        contentHash,
        pythonDocumentId: null,
        aiProcessingStatus: null,
        aiErrorMessage: null,
        status: 'ready',
        classification,
        metadata: {
            source: 'compliance_chat',
            phase3Agent: COMPLIANCE_AGENT,
            generatedVia: 'compliance_chat',
            generatedFromDocumentIds: sourceDocumentIds.slice(0, 80),
            storageLayout: 'by-type',
            storageType: 'inbox',
            aiSynced: false,
        },
    });

    try {
        const { applyDocumentVisibilityScope } = await import('./documentVisibility');
        await applyDocumentVisibilityScope(doc, null);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Compliance PDF visibility failed for ${doc.documentId}: ${e?.message || e}`);
    }

    try {
        await applyDocumentTypeStorage(doc, classification);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Compliance PDF storage relocate failed for ${doc.documentId}: ${e?.message || e}`);
    }

    return doc;
}

async function resolveSourceIds(
    user: AuthUser,
    documentIds?: string[]
): Promise<{ sourceIds: string[]; sourceDocs: Array<{ documentId: string; originalFilename: string; classification?: string | null }> }> {
    const scopedIds =
        documentIds?.length && documentIds.filter(Boolean).length
            ? documentIds.filter(Boolean)
            : undefined;
    const docs = await loadComplianceDocsForAnalytics(user, {
        documentIds: scopedIds,
        maxDocs: 80,
    });
    const sourceDocs = docs.filter((d) => String(d.classification || '') !== GENERATED_REPORT_TYPE);
    return { sourceIds: sourceDocs.map((d) => d.documentId), sourceDocs };
}

export async function tryComplianceReportCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceReportCommand(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: [
                'No ready **compliance** documents in scope to report on.',
                'Upload certificates, audits, inspections, or SOPs, wait until status is **ready**, select them in Document scope, then say: `Generate compliance report`.',
            ].join('\n'),
        };
    }

    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const { html } = buildComplianceReportHtml({ snapshots, section: 'full' });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `Compliance_Report_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Compliance PDF generation failed (pdf_base64 missing).');
    }

    const reportDoc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        `Compliance_Report_${stamp}`,
        GENERATED_REPORT_TYPE,
        sourceIds
    );

    const pathLink = pdfPreviewPath(reportDoc.documentId);
    const attention = filterAttentionSnapshots(snapshots).length;
    const findings = snapshots.reduce((n, s) => n + s.findings.length, 0);

    return {
        handled: true,
        answer: [
            `**Compliance report generated** from **${sourceIds.length}** analysed file(s).`,
            '',
            `- [${reportDoc.originalFilename.replace(/\.pdf$/i, '')}](${pathLink})`,
            '',
            `Summary: **${snapshots.length}** docs · **${attention}** need expiry attention · **${findings}** findings.`,
            '',
            '_Tip: ask `Generate certificate report`, `Generate findings report`, or `What is expiring soon?` for focused outputs._',
        ].join('\n'),
        citations: [
            {
                documentId: reportDoc.documentId,
                filename: reportDoc.originalFilename,
                documentType: GENERATED_REPORT_TYPE,
                phase3Agent: COMPLIANCE_AGENT,
            },
            ...sourceDocs.slice(0, 8).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        ],
    };
}

export async function tryComplianceSectionPdfCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    const section = detectComplianceSectionPdf(params.question, params.phase3Agent);
    if (!section) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: 'No ready compliance documents in scope. Upload & wait for **ready**, then retry.',
        };
    }

    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const titles: Record<ComplianceSectionKind, string> = {
        certificates: 'Certificate & expiry report',
        findings: 'Findings & NCR report',
        register: 'Compliance document register',
        status: 'Compliance status summary',
    };
    const { html } = buildComplianceReportHtml({
        snapshots,
        section,
        title: titles[section],
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const base = `Compliance_${section}_${stamp}`;
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `${base}.pdf`,
    });
    if (!generatedPdf.pdf_base64) throw new Error('Section PDF generation failed.');

    const doc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        base,
        GENERATED_REPORT_TYPE,
        sourceIds
    );

    return {
        handled: true,
        answer: [
            `**${titles[section]}** ready (${sourceIds.length} source file(s)).`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: GENERATED_REPORT_TYPE,
                phase3Agent: COMPLIANCE_AGENT,
            },
            ...sourceDocs.slice(0, 6).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        ],
    };
}

export async function tryComplianceLetterCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    const kind = detectComplianceLetter(params.question, params.phase3Agent);
    if (!kind) return { handled: false };

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const party =
        parsePartyName(params.question) ||
        parseField(params.question, ['party', 'vendor', 'supplier', 'entity', 'to']);
    const company =
        parseField(params.question, ['company', 'organisation', 'organization']) ||
        'Visibility Docs';
    const standard = parseField(params.question, ['standard', 'regulation', 'iso']);
    const finding = parseField(params.question, ['finding', 'reason', 'regarding', 'issue']);
    const dueDate = parseField(params.question, ['due', 'deadline', 'by']);

    if (!party) {
        const examples: Record<ComplianceLetterKind, string> = {
            ncr: '`Generate NCR letter for Acme Vendor. Company Visibility Bots, standard ISO 9001, finding missing calibration records, due 2026-09-01`',
            capa: '`Generate CAPA letter for Production Line 2. standard ISO 14001, issue effluent exceedance, due 2026-09-15`',
            certificate_of_compliance:
                '`Generate certificate of compliance for Acme Vendor. Company Visibility Bots, standard ISO 9001:2015`',
        };
        return {
            handled: true,
            answer: [
                `I can draft a professional **${kind.replace(/_/g, ' ')}**, but need the party / entity name.`,
                '',
                `Example: ${examples[kind]}`,
                '',
                '_Tip: select related audit/inspection docs in scope so findings can be referenced._',
            ].join('\n'),
        };
    }

    const { sourceIds } = await resolveSourceIds(params.user, params.documentIds);
    let prefillFinding = finding;
    let prefillStandard = standard;
    if (sourceIds.length) {
        const snaps = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
        if (!prefillFinding) {
            const withFindings = snaps.find((s) => s.findings.length);
            if (withFindings?.findings[0]) {
                prefillFinding = `${withFindings.findings[0].severity}: ${withFindings.findings[0].description}`;
            }
        }
        if (!prefillStandard) {
            prefillStandard = snaps.find((s) => s.standardOrRegulation)?.standardOrRegulation || '';
        }
    }

    const { html, classification } = buildComplianceLetterHtml({
        kind,
        partyName: party,
        company,
        standard: prefillStandard || undefined,
        finding: prefillFinding || undefined,
        dueDate: dueDate || undefined,
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `${kind}_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) throw new Error('Compliance letter PDF generation failed.');

    const doc = await saveGeneratedCompliancePdf(
        params.user,
        generatedPdf.pdf_base64,
        `${kind}_${party.replace(/\s+/g, '_')}_${stamp}`,
        classification,
        sourceIds
    );

    return {
        handled: true,
        answer: [
            `**${kind.replace(/_/g, ' ')}** ready for **${party}**.`,
            '',
            `[${doc.originalFilename.replace(/\.pdf$/i, '')}](${pdfPreviewPath(doc.documentId)})`,
            sourceIds.length
                ? `_Prefill used ${sourceIds.length} scoped compliance document(s)._`
                : '_Tip: select audit/inspection docs in scope for finding/standard prefill._',
        ].join('\n'),
        citations: [
            {
                documentId: doc.documentId,
                filename: doc.originalFilename,
                documentType: classification,
                phase3Agent: COMPLIANCE_AGENT,
            },
        ],
    };
}

export async function tryComplianceExpiryAlertCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceExpiryAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    if (!sourceIds.length) {
        return {
            handled: true,
            answer: 'No ready compliance documents in scope to check expiry.',
        };
    }

    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const snapshots = await loadComplianceSnapshots(params.user, { documentIds: sourceIds });
    const attention = filterAttentionSnapshots(snapshots).sort(
        (a, b) => (a.daysUntilExpiry ?? 9999) - (b.daysUntilExpiry ?? 9999)
    );

    if (!attention.length) {
        return {
            handled: true,
            answer: [
                `No certificates / licences marked **expired** or **expiring soon** (warning window: **${settings.expiryWarningDays || 90}** days).`,
                '',
                `_${snapshots.length} document(s) analysed. Ask \`Generate certificate report\` for a printable PDF._`,
            ].join('\n'),
            citations: sourceDocs.slice(0, 6).map((d) => ({
                documentId: d.documentId,
                filename: d.originalFilename,
                documentType: d.classification || 'compliance',
                phase3Agent: COMPLIANCE_AGENT,
            })),
        };
    }

    const lines = attention.slice(0, 15).map((s, i) => {
        const std = s.standardOrRegulation ? ` · ${s.standardOrRegulation}` : '';
        const num = s.certificateNumber ? ` (${s.certificateNumber})` : '';
        return `${i + 1}. **${s.filename}**${num} — ${formatCertStatus(s.certStatus)} · ${daysLabel(s)}${std}`;
    });

    return {
        handled: true,
        answer: [
            `**Expiry attention** — ${attention.length} document(s) (warning ≤ **${settings.expiryWarningDays || 90}** days):`,
            '',
            ...lines,
            '',
            '_Ask `Generate certificate report` for a printable PDF of this list._',
        ].join('\n'),
        citations: attention.slice(0, 10).map((s) => ({
            documentId: s.documentId,
            filename: s.filename,
            documentType: s.classification,
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}

export async function tryComplianceMissingDocsCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<ComplianceChatActionResult> {
    if (!detectComplianceMissingDocsAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }
    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, COMPLIANCE_AGENT);
        if (!check.ok) return { handled: true, answer: check.message };
    }

    const { sourceIds, sourceDocs } = await resolveSourceIds(params.user, params.documentIds);
    const settings = await getOrgComplianceSettings(params.user.organizationId);
    const snapshots = sourceIds.length
        ? await loadComplianceSnapshots(params.user, { documentIds: sourceIds })
        : [];
    const analysis = analyzeMissingComplianceDocs(snapshots, settings.requiredDocTypes);

    const presentLines = analysis.present.map(
        (t) => `- ✅ **${t.replace(/_/g, ' ')}** (${analysis.presentByType[t] || 0})`
    );
    const missingLines = analysis.missing.map((t) => `- ❌ **${t.replace(/_/g, ' ')}** — not in scope`);

    return {
        handled: true,
        answer: [
            '**Compliance packet completeness** (required types vs scoped documents):',
            '',
            presentLines.length ? '**Present:**' : '**Present:** _(none of the required types)_',
            ...(presentLines.length ? presentLines : []),
            '',
            missingLines.length ? '**Missing:**' : '**Missing:** none — packet looks complete for configured types.',
            ...(missingLines.length ? missingLines : []),
            '',
            `_Required types configurable via org compliance settings (default: ${analysis.required.join(', ')})._`,
            sourceIds.length
                ? `_Analysed ${sourceIds.length} ready compliance file(s)._`
                : '_No ready compliance files in scope yet — upload & wait for **ready**._',
        ].join('\n'),
        citations: sourceDocs.slice(0, 8).map((d) => ({
            documentId: d.documentId,
            filename: d.originalFilename,
            documentType: d.classification || 'compliance',
            phase3Agent: COMPLIANCE_AGENT,
        })),
    };
}
