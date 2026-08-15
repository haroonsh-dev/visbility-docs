import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Document from '../models/Document';
import { AuthUser } from './accessScope';
import {
    FINANCE_AGENT,
    loadFinanceRecords,
    type FinanceRecord,
    applyPaymentsToInvoices,
    convertFinanceRecordsToCurrency,
    convertRecordsToBase,
    DEFAULT_FX_RATES_TO_USD,
    dedupeFinanceRecords,
    chartAmount,
    isPaymentRecord,
    isSpreadsheetFilename,
    extractDocumentNameTokens,
    matchDocumentIdsByNameTokens,
    resolveFinanceDocumentIdsFromQuestion,
    extractExplicitFilenameFromQuestion,
    detectCurrencyPreference,
} from './financeAnalyticsService';
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
import { getOrgFinanceSettings } from './orgFinanceSettingsService';
import { wantsAgentAnalyticsVisual, wantsAgentTextOnlyExplain } from './agentAnalyticsPolicy';
import {
    cleanAgentMarkdown,
    formatAgentDivider,
    formatAgentFooter,
    formatAgentHeading,
    formatAgentIntro,
    formatDate,
    formatLabeledBullets,
    formatMoney,
    formatSection,
    formatStatusLabel,
} from './agentResponseFormat';

export type FinanceChatCitation = {
    documentId: string;
    filename?: string;
    score?: number;
    documentType?: string;
    phase3Agent?: string;
};

export type FinanceChatActionResult = {
    handled: boolean;
    answer?: string;
    citations?: FinanceChatCitation[];
};

const GENERATED_REPORT_TYPE = 'finance_report';

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

function money(n: number, currency: string): string {
    return `${currency} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function moneyPlain(n: number): string {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(part: number, whole: number): string {
    if (!(whole > 0)) return '—';
    return `${((part / whole) * 100).toFixed(1)}%`;
}

function formatAsOf(d: Date): string {
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

type PartyAgg = {
    name: string;
    gross: number;
    paid: number;
    outstanding: number;
    invoices: number;
    oldestDue: Date | null;
};

function aggregatePartyDetailed(
    records: FinanceRecord[],
    party: 'vendor' | 'client',
    currency: string
): PartyAgg[] {
    const map = new Map<
        string,
        { gross: number; paid: number; outstanding: number; docs: Set<string>; oldestDue: Date | null }
    >();
    for (const r of records) {
        if (isPaymentRecord(r)) continue;
        if (r.currency !== currency) continue;
        if (r.recordKind === 'other') continue;
        const name = (party === 'vendor' ? r.vendor : r.client).trim();
        if (!name || (party === 'vendor' && name === 'Unknown vendor')) continue;
        if (party === 'client' && !name) continue;
        const cur = map.get(name) || {
            gross: 0,
            paid: 0,
            outstanding: 0,
            docs: new Set<string>(),
            oldestDue: null as Date | null,
        };
        cur.gross += r.total;
        cur.paid += r.paidApplied ?? 0;
        cur.outstanding += chartAmount(r);
        cur.docs.add(r.documentId);
        if (r.dueDate && (!cur.oldestDue || r.dueDate < cur.oldestDue)) cur.oldestDue = r.dueDate;
        map.set(name, cur);
    }
    return [...map.entries()]
        .map(([name, v]) => ({
            name,
            gross: Math.round(v.gross * 100) / 100,
            paid: Math.round(v.paid * 100) / 100,
            outstanding: Math.round(v.outstanding * 100) / 100,
            invoices: v.docs.size,
            oldestDue: v.oldestDue,
        }))
        .sort((a, b) => b.outstanding - a.outstanding);
}

type AgingRow = { bucket: string; amount: number; count: number };

function agingBucketsDetailed(records: FinanceRecord[], currency: string): AgingRow[] {
    const keys = ['Current (not due)', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const;
    const amounts = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const k of keys) {
        amounts.set(k, 0);
        counts.set(k, 0);
    }
    const now = Date.now();
    for (const r of records) {
        if (isPaymentRecord(r) || r.currency !== currency) continue;
        if (r.recordKind === 'other') continue;
        const amt = chartAmount(r);
        if (!(amt > 0) && (r.outstanding === 0 || r.outstanding === undefined) && r.paidApplied) {
            // fully settled — skip from aging open balance
            if ((r.outstanding ?? r.total) <= 0) continue;
        }
        if (chartAmount(r) <= 0) continue;
        let key: (typeof keys)[number] = 'Current (not due)';
        if (r.dueDate) {
            const due = r.dueDate.getTime();
            if (due < now) {
                const days = Math.floor((now - due) / 86400000);
                if (days <= 30) key = '1–30 days';
                else if (days <= 60) key = '31–60 days';
                else if (days <= 90) key = '61–90 days';
                else key = '90+ days';
            }
        }
        amounts.set(key, (amounts.get(key) || 0) + amt);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    return keys.map((k) => ({
        bucket: k,
        amount: Math.round((amounts.get(k) || 0) * 100) / 100,
        count: counts.get(k) || 0,
    }));
}

function monthlyTrend(records: FinanceRecord[], currency: string) {
    const byMonth = new Map<string, { billed: number; collected: number }>();
    for (const r of records) {
        if (r.currency !== currency) continue;
        if (isPaymentRecord(r)) {
            if (!r.invoiceDate && !r.dueDate) continue;
            const d = r.invoiceDate || r.dueDate!;
            const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
            const cur = byMonth.get(key) || { billed: 0, collected: 0 };
            cur.collected += r.amountPaid ?? r.total;
            byMonth.set(key, cur);
            continue;
        }
        if (r.recordKind === 'other' || !r.invoiceDate) continue;
        const d = r.invoiceDate;
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const cur = byMonth.get(key) || { billed: 0, collected: 0 };
        cur.billed += r.total;
        byMonth.set(key, cur);
    }
    return [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([month, v]) => ({
            month,
            billed: Math.round(v.billed * 100) / 100,
            collected: Math.round(v.collected * 100) / 100,
        }));
}

function topPastDue(
    records: FinanceRecord[],
    currency: string,
    limit = 8
): Array<{
    party: string;
    invoice: string;
    outstanding: number;
    daysPastDue: number;
    dueDate: string;
    filename: string;
}> {
    const now = Date.now();
    const rows: Array<{
        party: string;
        invoice: string;
        outstanding: number;
        daysPastDue: number;
        dueDate: string;
        filename: string;
        sort: number;
    }> = [];
    for (const r of records) {
        if (isPaymentRecord(r) || r.currency !== currency || r.recordKind === 'other') continue;
        if (!r.dueDate) continue;
        const days = Math.floor((now - r.dueDate.getTime()) / 86400000);
        if (days <= 0) continue;
        const out = chartAmount(r);
        if (!(out > 0)) continue;
        rows.push({
            party: r.vendor || r.client || '—',
            invoice: r.invoiceNumber || '—',
            outstanding: Math.round(out * 100) / 100,
            daysPastDue: days,
            dueDate: r.dueDate.toISOString().slice(0, 10),
            filename: r.filename,
            sort: out,
        });
    }
    return rows.sort((a, b) => b.sort - a.sort).slice(0, limit);
}

function buildFinanceReportHtml(params: {
    records: FinanceRecord[];
    orgLabel?: string;
    baseCurrency?: string;
    settlement?: {
        appliedPayments: number;
        unmatchedPayments: number;
        totalPaidApplied: number;
        totalOutstanding: number;
        totalGross: number;
        paymentCount: number;
    };
}): { subject: string; html: string } {
    const { records } = params;
    const generatedAt = new Date();
    const asOf = formatAsOf(generatedAt);
    const dateStamp = generatedAt.toISOString().slice(0, 10);
    const company = params.orgLabel?.trim() || 'Visibility Docs';
    const currency = params.baseCurrency || dominantCurrency(records);
    const settled = (params.settlement?.appliedPayments || 0) > 0;
    const otherCurrency = records.filter(
        (r) => !isPaymentRecord(r) && r.recordKind !== 'other' && r.currency !== currency
    ).length;

    const vendors = aggregatePartyDetailed(records, 'vendor', currency);
    const clients = aggregatePartyDetailed(records, 'client', currency);
    const aging = agingBucketsDetailed(records, currency);
    const trend = monthlyTrend(records, currency);
    const pastDueList = topPastDue(records, currency, 8);

    const apGross = vendors.reduce((s, v) => s + v.gross, 0);
    const apPaid = vendors.reduce((s, v) => s + v.paid, 0);
    const apOut = vendors.reduce((s, v) => s + v.outstanding, 0);
    const arGross = clients.reduce((s, c) => s + c.gross, 0);
    const arPaid = clients.reduce((s, c) => s + c.paid, 0);
    const arOut = clients.reduce((s, c) => s + c.outstanding, 0);
    const overdue = aging
        .filter((b) => b.bucket !== 'Current (not due)')
        .reduce((s, b) => s + b.amount, 0);
    const overdueCount = aging
        .filter((b) => b.bucket !== 'Current (not due)')
        .reduce((s, b) => s + b.count, 0);
    const agingTotal = aging.reduce((s, b) => s + b.amount, 0);
    const uniqueDocs = new Set(
        records.filter((r) => !isPaymentRecord(r)).map((r) => r.documentId)
    ).size;
    const missingVendor = records.filter(
        (r) => !isPaymentRecord(r) && r.recordKind !== 'other' && (!r.vendor || r.vendor === 'Unknown vendor')
    ).length;
    const missingClient = records.filter(
        (r) => !isPaymentRecord(r) && r.recordKind !== 'other' && !r.client.trim()
    ).length;
    const missingDate = records.filter(
        (r) => !isPaymentRecord(r) && r.recordKind !== 'other' && !r.invoiceDate
    ).length;

    const topVendorShare =
        vendors[0] && apOut > 0 ? pct(vendors[0].outstanding, apOut) : null;
    const pastDuePct = apOut > 0 ? pct(overdue, apOut) : pct(overdue, agingTotal);

    const insights: string[] = [];
    insights.push(
        `AP outstanding ${money(apOut, currency)}${settled ? ` (gross ${moneyPlain(apGross)}, payments applied ${moneyPlain(apPaid)})` : ''}.`
    );
    if (arOut > 0 || arGross > 0) {
        insights.push(
            `AR outstanding ${money(arOut, currency)}${settled ? ` (gross ${moneyPlain(arGross)})` : ''}.`
        );
    }
    insights.push(
        overdue > 0
            ? `Past-due AP ${money(overdue, currency)} across ${overdueCount} invoice(s) (${pastDuePct} of open AP aging).`
            : 'No past-due AP balances detected in primary-currency scope.'
    );
    if (settled && params.settlement) {
        insights.push(
            `Payment settlement: ${params.settlement.appliedPayments} receipt(s) matched · ${money(params.settlement.totalPaidApplied, currency)} applied` +
                (params.settlement.unmatchedPayments
                    ? ` · ${params.settlement.unmatchedPayments} unmatched.`
                    : '.')
        );
    } else if (params.settlement?.paymentCount) {
        insights.push(
            `${params.settlement.paymentCount} payment receipt(s) in scope but none matched an invoice number — totals shown gross.`
        );
    }
    if (vendors[0] && topVendorShare) {
        insights.push(
            `Concentration: ${vendors[0].name} holds ${topVendorShare} of AP outstanding.`
        );
    }
    insights.push(`Analysed ${uniqueDocs} finance document(s) in scope · currency ${currency}.`);

    const subject = `Accounts Payable & Receivable Position — ${dateStamp}`;

    const partyTable = (rows: PartyAgg[], totalOut: number, settledMode: boolean) =>
        rows
            .slice(0, 25)
            .map((v, i) => {
                const oldest = v.oldestDue ? v.oldestDue.toISOString().slice(0, 10) : '—';
                if (settledMode) {
                    return `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(v.name)}</td>
  <td class="num">${v.invoices}</td>
  <td class="num">${escapeHtml(moneyPlain(v.gross))}</td>
  <td class="num">${escapeHtml(moneyPlain(v.paid))}</td>
  <td class="num strong">${escapeHtml(moneyPlain(v.outstanding))}</td>
  <td class="num">${escapeHtml(pct(v.outstanding, totalOut))}</td>
  <td class="num">${escapeHtml(oldest)}</td>
</tr>`;
                }
                return `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(v.name)}</td>
  <td class="num">${v.invoices}</td>
  <td class="num strong">${escapeHtml(moneyPlain(v.outstanding))}</td>
  <td class="num">${escapeHtml(pct(v.outstanding, totalOut))}</td>
  <td class="num">${escapeHtml(oldest)}</td>
</tr>`;
            })
            .join('\n');

    const agingRows = aging
        .map(
            (b) => `<tr>
  <td>${escapeHtml(b.bucket)}</td>
  <td class="num">${b.count}</td>
  <td class="num strong">${escapeHtml(moneyPlain(b.amount))}</td>
  <td class="num">${escapeHtml(pct(b.amount, agingTotal))}</td>
</tr>`
        )
        .join('\n');

    const pastDueRows = pastDueList
        .map(
            (r, i) => `<tr>
  <td class="num">${i + 1}</td>
  <td>${escapeHtml(r.party)}</td>
  <td>${escapeHtml(r.invoice)}</td>
  <td class="num">${escapeHtml(r.dueDate)}</td>
  <td class="num">${r.daysPastDue}d</td>
  <td class="num strong">${escapeHtml(moneyPlain(r.outstanding))}</td>
</tr>`
        )
        .join('\n');

    const trendRows = trend
        .map(
            (t) => `<tr>
  <td>${escapeHtml(t.month)}</td>
  <td class="num">${escapeHtml(moneyPlain(t.billed))}</td>
  <td class="num">${escapeHtml(moneyPlain(t.collected))}</td>
</tr>`
        )
        .join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeHtml(subject)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm 18mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #0f172a;
    margin: 0;
    padding: 0;
    font-size: 9.5pt;
    line-height: 1.4;
  }
  .letterhead {
    border-bottom: 2.5px solid #0f172a;
    padding-bottom: 10px;
    margin-bottom: 14px;
  }
  .company { font-size: 16pt; font-weight: 700; letter-spacing: .02em; color: #0f172a; }
  .doc-title { font-size: 12.5pt; font-weight: 600; margin-top: 4px; color: #1e293b; }
  .meta-row { margin-top: 6px; font-size: 8.5pt; color: #475569; }
  .meta-row span { margin-right: 14px; }
  .badge {
    display: inline-block;
    font-size: 7.5pt;
    letter-spacing: .12em;
    text-transform: uppercase;
    border: 1px solid #94a3b8;
    padding: 2px 6px;
    color: #64748b;
    margin-top: 6px;
  }
  h2 {
    margin: 16px 0 6px;
    font-size: 10.5pt;
    color: #0f172a;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 3px;
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  h3 { margin: 10px 0 4px; font-size: 9.5pt; color: #334155; }
  .exec {
    margin: 10px 0 12px;
    padding: 0;
  }
  .exec ol { margin: 6px 0 0; padding-left: 18px; }
  .exec li { margin: 3px 0; }
  table.summary, table.data {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
  }
  table.summary th, table.summary td,
  table.data th, table.data td {
    padding: 5px 7px;
    border-bottom: 1px solid #e2e8f0;
    font-size: 8.5pt;
    vertical-align: top;
  }
  table.summary th, table.data th {
    text-align: left;
    font-size: 7.5pt;
    text-transform: uppercase;
    letter-spacing: .03em;
    color: #64748b;
    border-bottom: 1.5px solid #94a3b8;
    background: #f8fafc;
  }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.strong { font-weight: 700; }
  tr.total td {
    border-top: 1.5px solid #0f172a;
    font-weight: 700;
    background: #f8fafc;
  }
  .muted { color: #64748b; font-size: 8pt; }
  .appendix { margin-top: 18px; padding-top: 8px; border-top: 1px dashed #cbd5e1; }
  .footer {
    margin-top: 16px;
    padding-top: 8px;
    border-top: 1px solid #cbd5e1;
    font-size: 7.5pt;
    color: #64748b;
  }
  .footer .row { display: flex; justify-content: space-between; gap: 12px; }
</style>
</head>
<body>
  <div class="letterhead">
    <div class="company">${escapeHtml(company)}</div>
    <div class="doc-title">Accounts Payable &amp; Receivable Position</div>
    <div class="meta-row">
      <span><b>As of:</b> ${escapeHtml(asOf)}</span>
      <span><b>Currency:</b> ${escapeHtml(currency)}</span>
      <span><b>Documents:</b> ${uniqueDocs}</span>
      <span><b>Prepared by:</b> Finance Agent</span>
    </div>
    <div class="badge">Confidential · Internal use</div>
  </div>

  <h2>1. Executive summary</h2>
  <div class="exec">
    <ol>
      ${insights.map((i) => `<li>${escapeHtml(i)}</li>`).join('\n')}
    </ol>
  </div>

  <h2>2. Position summary (${escapeHtml(currency)})</h2>
  <table class="summary">
    <thead>
      <tr>
        <th>Metric</th>
        <th class="num">Amount</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>
      <tr><td>AP gross billed</td><td class="num">${escapeHtml(moneyPlain(apGross))}</td><td class="muted">Vendor invoices in scope</td></tr>
      <tr><td>Less: payments applied</td><td class="num">${escapeHtml(moneyPlain(settled ? apPaid : params.settlement?.totalPaidApplied || 0))}</td><td class="muted">${settled ? 'Matched payment receipts' : 'No matched receipts'}</td></tr>
      <tr class="total"><td>AP outstanding</td><td class="num">${escapeHtml(moneyPlain(apOut))}</td><td class="muted">Net payable</td></tr>
      <tr><td>AR gross billed</td><td class="num">${escapeHtml(moneyPlain(arGross))}</td><td class="muted">Client invoices in scope</td></tr>
      <tr><td>Less: payments applied (AR)</td><td class="num">${escapeHtml(moneyPlain(arPaid))}</td><td class="muted">Where receipts match AR invoices</td></tr>
      <tr class="total"><td>AR outstanding</td><td class="num">${escapeHtml(moneyPlain(arOut))}</td><td class="muted">Net receivable</td></tr>
      <tr><td>Past-due (open)</td><td class="num">${escapeHtml(moneyPlain(overdue))}</td><td class="muted">${overdueCount} invoice(s) · ${escapeHtml(pastDuePct)} of AP aging</td></tr>
    </tbody>
  </table>

  <h2>3. Accounts payable — vendor schedule</h2>
  <p class="muted">${settled ? 'Gross / paid / outstanding after payment settlement.' : 'Amounts are extracted invoice totals (gross). Add payment receipts with invoice # to net down.'}</p>
  <table class="data">
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Vendor</th>
        <th class="num">Inv</th>
        ${
            settled
                ? `<th class="num">Gross</th><th class="num">Paid</th><th class="num">Outstanding</th><th class="num">% AP</th><th class="num">Oldest due</th>`
                : `<th class="num">Total</th><th class="num">% AP</th><th class="num">Oldest due</th>`
        }
      </tr>
    </thead>
    <tbody>
      ${
          partyTable(vendors, apOut, settled) ||
          `<tr><td colspan="8" class="muted">No vendor amounts in primary currency.</td></tr>`
      }
      ${
          vendors.length
              ? settled
                  ? `<tr class="total"><td></td><td>Total</td><td class="num">${vendors.reduce((s, v) => s + v.invoices, 0)}</td><td class="num">${escapeHtml(moneyPlain(apGross))}</td><td class="num">${escapeHtml(moneyPlain(apPaid))}</td><td class="num">${escapeHtml(moneyPlain(apOut))}</td><td class="num">100%</td><td></td></tr>`
                  : `<tr class="total"><td></td><td>Total</td><td class="num">${vendors.reduce((s, v) => s + v.invoices, 0)}</td><td class="num">${escapeHtml(moneyPlain(apOut))}</td><td class="num">100%</td><td></td></tr>`
              : ''
      }
    </tbody>
  </table>

  <h2>4. Accounts receivable — client schedule</h2>
  <table class="data">
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Client</th>
        <th class="num">Inv</th>
        ${
            settled
                ? `<th class="num">Gross</th><th class="num">Paid</th><th class="num">Outstanding</th><th class="num">% AR</th><th class="num">Oldest due</th>`
                : `<th class="num">Total</th><th class="num">% AR</th><th class="num">Oldest due</th>`
        }
      </tr>
    </thead>
    <tbody>
      ${
          partyTable(clients, arOut || 1, settled) ||
          `<tr><td colspan="8" class="muted">No client amounts in primary currency.</td></tr>`
      }
    </tbody>
  </table>

  <h2>5. Payables aging analysis</h2>
  <table class="data">
    <thead>
      <tr>
        <th>Bucket</th>
        <th class="num">Count</th>
        <th class="num">Amount (${escapeHtml(currency)})</th>
        <th class="num">% of aging</th>
      </tr>
    </thead>
    <tbody>
      ${agingRows}
      <tr class="total"><td>Total</td><td class="num">${aging.reduce((s, b) => s + b.count, 0)}</td><td class="num">${escapeHtml(moneyPlain(agingTotal))}</td><td class="num">100%</td></tr>
    </tbody>
  </table>

  <h2>6. Priority past-due invoices</h2>
  <p class="muted">Largest open balances past due date — chase list.</p>
  <table class="data">
    <thead>
      <tr>
        <th class="num">#</th>
        <th>Party</th>
        <th>Invoice #</th>
        <th class="num">Due</th>
        <th class="num">Days</th>
        <th class="num">Outstanding</th>
      </tr>
    </thead>
    <tbody>
      ${pastDueRows || `<tr><td colspan="6" class="muted">No past-due open balances with due dates in scope.</td></tr>`}
    </tbody>
  </table>

  <h2>7. Monthly billed vs collected</h2>
  <table class="data">
    <thead>
      <tr>
        <th>Month</th>
        <th class="num">Billed</th>
        <th class="num">Collected (receipts)</th>
      </tr>
    </thead>
    <tbody>
      ${trendRows || `<tr><td colspan="3" class="muted">Insufficient date fields for monthly trend.</td></tr>`}
    </tbody>
  </table>

  <div class="appendix">
    <h2>Appendix A — Data quality</h2>
    <table class="data">
      <tbody>
        <tr><td>Missing vendor on invoice</td><td class="num">${missingVendor}</td></tr>
        <tr><td>Missing client on invoice</td><td class="num">${missingClient}</td></tr>
        <tr><td>Missing invoice date</td><td class="num">${missingDate}</td></tr>
        <tr><td>Other-currency invoices excluded from ${escapeHtml(currency)} totals</td><td class="num">${otherCurrency}</td></tr>
        <tr><td>Unmatched payment receipts</td><td class="num">${params.settlement?.unmatchedPayments ?? 0}</td></tr>
      </tbody>
    </table>
    <p class="muted" style="margin-top:8px;">Configure vendor aliases and FX rates in Admin → Settings → Finance analytics. Figures are derived from Finance Agent extractions of documents in chat scope.</p>
  </div>

  <div class="footer">
    <div class="row">
      <div>Prepared by: Finance Agent · ${escapeHtml(company)}</div>
      <div>Generated ${escapeHtml(generatedAt.toLocaleString())}</div>
    </div>
    <div style="margin-top:4px;">Disclaimer: Based on AI-extracted fields from scoped documents. Validate material balances against the GL before external use. Confidential.</div>
  </div>
</body>
</html>`;

    return { subject, html };
}

/** Finance Agent only — never fire for compliance/HR/other agents. */
export function detectFinanceReportCommand(question: string, phase3Agent?: string): boolean {
    if (phase3Agent !== FINANCE_AGENT) return false;
    const q = question.toLowerCase().trim();
    if (!q) return false;

    const wantsGenerate =
        /\b(generate|create|make|draft|export|download|prepare|build)\b/.test(q) ||
        /\b(give\s+me|get\s+me)\b/.test(q);

    const wantsReport =
        /\bfinance\s+report\b/.test(q) ||
        /\b(ap|ar|payables?|receivables?)\s+report\b/.test(q) ||
        /\baging\s+report\b/.test(q) ||
        /\bvendor\s+(spend\s+)?report\b/.test(q) ||
        (/\breport\b/.test(q) &&
            !/\b(compliance|expense|offer|experience|extraction|email)\s+report\b/.test(q));

    return wantsGenerate && wantsReport;
}

function dominantCurrency(records: FinanceRecord[]): string {
    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.currency, (counts.get(r.currency) || 0) + 1);
    let best = 'USD';
    let max = 0;
    for (const [c, n] of counts) {
        if (n > max) {
            max = n;
            best = c;
        }
    }
    return best;
}

async function saveFinanceReportDocument(
    user: AuthUser,
    pdfBase64: string,
    filenameBase: string,
    sourceDocumentIds: string[]
): Promise<InstanceType<typeof Document>> {
    ensureUploadDir();
    const buf = Buffer.from(pdfBase64, 'base64');
    const tmpDir = path.join(process.cwd(), 'uploads', '_tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `finance_report_${uuidv4()}.pdf`);
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
        classification: GENERATED_REPORT_TYPE,
        metadata: {
            source: 'finance_chat',
            phase3Agent: FINANCE_AGENT,
            generatedVia: 'finance_chat',
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
        logger.warn(`Finance report visibility failed for ${doc.documentId}: ${e?.message || e}`);
    }

    try {
        await applyDocumentTypeStorage(doc, GENERATED_REPORT_TYPE);
        await doc.save();
    } catch (e: any) {
        logger.warn(`Finance report storage relocate failed for ${doc.documentId}: ${e?.message || e}`);
    }

    return doc;
}

export async function tryFinanceReportCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceChatActionResult> {
    if (!detectFinanceReportCommand(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    if (params.user.role !== 'superAdmin') {
        const check = await requireAllowedAgent(params.user, FINANCE_AGENT);
        if (!check.ok) {
            return { handled: true, answer: check.message };
        }
    }

    const scopedIds =
        params.documentIds?.length && params.documentIds.filter(Boolean).length
            ? params.documentIds.filter(Boolean)
            : undefined;

    const orgFin = await getOrgFinanceSettings(params.user.organizationId);
    const loaded = await loadFinanceRecords(params.user, {
        documentIds: scopedIds,
        maxDocs: 200,
        vendorAliases: orgFin.vendorAliases,
        baseCurrency: orgFin.baseCurrency,
    });
    const fx = convertRecordsToBase(loaded, {
        baseCurrency: orgFin.baseCurrency,
        fxRates: orgFin.fxRates,
    });
    const deduped = dedupeFinanceRecords(fx.records);
    const settlement = applyPaymentsToInvoices(deduped.records);
    const records = [...settlement.records, ...settlement.payments];

    // Exclude previously generated finance reports if they somehow appear.
    const sourceIds = [...new Set(records.map((r) => r.documentId))];

    if (!sourceIds.length) {
        return {
            handled: true,
            answer: [
                'No ready **finance** documents with extractable amounts in scope.',
                'Upload invoices / POs, wait until **ready**, select them in Document scope, then say: `Generate finance report`.',
            ].join('\n'),
        };
    }

    let orgLabel: string | undefined;
    if (params.user.organizationId) {
        try {
            const Organization = (await import('../models/Organization')).default;
            const org = await Organization.findOne({ organizationId: params.user.organizationId })
                .select('organizationName')
                .lean();
            orgLabel = org?.organizationName || undefined;
        } catch {
            /* ignore */
        }
    }

    const { html } = buildFinanceReportHtml({
        records,
        orgLabel,
        baseCurrency: orgFin.baseCurrency,
        settlement: {
            appliedPayments: settlement.appliedPayments,
            unmatchedPayments: settlement.unmatchedPayments,
            totalPaidApplied: settlement.totalPaidApplied,
            totalOutstanding: settlement.totalOutstanding,
            totalGross: settlement.totalGross,
            paymentCount: settlement.payments.length,
        },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const generatedPdf = await generateComplianceReportPdf({
        html,
        filename: `Finance_Position_${stamp}.pdf`,
    });
    if (!generatedPdf.pdf_base64) {
        throw new Error('Finance PDF generation failed (pdf_base64 missing).');
    }

    const reportDoc = await saveFinanceReportDocument(
        params.user,
        generatedPdf.pdf_base64,
        `Finance_Position_${stamp}`,
        sourceIds
    );

    const pathLink = pdfPreviewPath(reportDoc.documentId);
    const currency = orgFin.baseCurrency || dominantCurrency(records);
    const apTotal = aggregatePartyDetailed(records, 'vendor', currency).reduce((s, v) => s + v.outstanding, 0);
    const arTotal = aggregatePartyDetailed(records, 'client', currency).reduce((s, c) => s + c.outstanding, 0);
    const scopeNote = scopedIds?.length
        ? ` from **${sourceIds.length}** scoped file(s)`
        : ` across **${sourceIds.length}** finance file(s)`;

    return {
        handled: true,
        answer: [
            `**AP & AR Position pack** ready${scopeNote}.`,
            '',
            `[Accounts Payable & Receivable Position — ${stamp}](${pathLink})`,
            '',
            `Summary (${currency}): **AP outstanding** ${money(apTotal, currency)} · **AR outstanding** ${money(arTotal, currency)}` +
                (settlement.appliedPayments
                    ? ` · **${settlement.appliedPayments}** payment(s) settled`
                    : ''),
            '',
            '_Executive summary, position table, vendor/client schedules, aging, past-due chase list, and data quality appendix._',
        ].join('\n'),
        citations: [
            {
                documentId: reportDoc.documentId,
                filename: reportDoc.originalFilename,
                documentType: GENERATED_REPORT_TYPE,
                phase3Agent: FINANCE_AGENT,
            },
            ...sourceIds.slice(0, 8).map((id) => {
                const rec = records.find((r) => r.documentId === id);
                return {
                    documentId: id,
                    filename: rec?.filename,
                    documentType: rec?.classification || 'invoice',
                    phase3Agent: FINANCE_AGENT,
                };
            }),
        ],
    };
}

export function detectFinanceReconciliation(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    const q = question.toLowerCase();
    return (
        q.includes('reconcil') ||
        q.includes('duplicate invoice') ||
        q.includes('duplicate') ||
        q.includes('ap audit') ||
        q.includes('audit invoice') ||
        q.includes('discrepancy')
    );
}

export function detectFinanceCashOutflow(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    const q = question.toLowerCase();
    return (
        q.includes('cash outflow') ||
        q.includes('outflow') ||
        q.includes('cash forecast') ||
        q.includes('upcoming payment') ||
        q.includes('what do we owe') ||
        q.includes('payable forecast')
    );
}

export function detectFinanceSpreadsheetTotalAsk(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    if (wantsAgentAnalyticsVisual(question, FINANCE_AGENT)) return false;
    const q = question
        .toLowerCase()
        .replace(/\bgran\b/g, 'grand')
        .replace(/\btotoals?\b/g, 'total');
    if (/\bpkr\b/.test(q) && /\b(not|no)\b/.test(q) && /\b(inr|usd|rupee|dollar|₹)\b/.test(q)) {
        return true;
    }
    if (
        /\b(total sum|sum of all|grand totals?|exact sum|precise total|exact total|combined total|aggregate(?:d)? total|vendor.?related|financial exposure)\b/.test(
            q
        )
    ) {
        return true;
    }
    if (/\b(aggregat|grand totals?|vendor totals?|total.*vendors?|vendors?.*total)\b/.test(q)) {
        return true;
    }
    if (/\bonly\s+(the\s+)?(grand\s+)?totals?\b/.test(q)) {
        return true;
    }
    if (/\btotal\s+amounts?\b/.test(q)) {
        return true;
    }
    if (/\b(total|sum)\b/.test(q) && /\b(all|every)\b/.test(q) && /\b(invoice|amount|pkr|usd|client|vendor)\b/.test(q)) {
        return true;
    }
    if (/\b(how much|what is the total|what's the total)\b/.test(q) && /\b(invoice|spreadsheet|xlsx|csv)\b/.test(q)) {
        return true;
    }
    if (/\b(total|sum)\b/.test(q) && /\b(clients?|customers?|vendors?|invoices?)\b/.test(q)) {
        return true;
    }
    if (/\bin pkr\b/.test(q) && /\b(total|sum|amount|invoice|vendor|client)\b/.test(q)) {
        return true;
    }
    return false;
}

export function detectFinanceDocumentExplain(question: string, phase3Agent?: string): boolean {
    if (phase3Agent && phase3Agent !== FINANCE_AGENT) return false;
    if (detectFinanceSpreadsheetTotalAsk(question, phase3Agent)) return false;
    if (wantsAgentAnalyticsVisual(question, FINANCE_AGENT)) return false;
    if (detectFinanceReconciliation(question, phase3Agent)) return false;
    if (detectFinanceCashOutflow(question, phase3Agent)) return false;
    if (!wantsAgentTextOnlyExplain(question, FINANCE_AGENT)) return false;
    return /\b(invoice|vendor|client|payable|receivable|expense|finance|payment|bill|po)\b/i.test(
        question
    );
}

function formatFinanceRecordExplain(rec: FinanceRecord): string {
    const out = rec.outstanding != null ? rec.outstanding : rec.total;
    const paid = getRecordPaymentStatus(rec);
    const statusLabel =
        paid === 'PAID' ? 'Paid' : paid === 'PARTIAL' ? 'Partially paid' : 'Unpaid';

    const meta = formatLabeledBullets([
        { label: 'Vendor', value: rec.vendor || 'Not specified' },
        { label: 'Client', value: rec.client || 'Not specified' },
        { label: 'Total', value: formatMoney(rec.total, rec.currency) },
        { label: 'Outstanding', value: formatMoney(out, rec.currency) },
        { label: 'Invoice date', value: formatDate(rec.invoiceDate) },
        { label: 'Due date', value: formatDate(rec.dueDate) },
        { label: 'Payment status', value: statusLabel },
        { label: 'Invoice number', value: rec.invoiceNumber || 'Not specified' },
        { label: 'PO number', value: rec.poNumber || 'Not specified' },
        { label: 'Document type', value: formatStatusLabel(rec.classification || 'invoice') },
    ]);

    let md = `${formatAgentHeading(rec.filename, 3)}\n\n${meta}`;

    const summaryParts: string[] = [];
    if (rec.paidApplied && rec.paidApplied > 0) {
        summaryParts.push(
            `${formatMoney(rec.paidApplied, rec.currency)} applied in matched payments.`
        );
    }
    if (out > 0) {
        summaryParts.push(`${formatMoney(out, rec.currency)} remains outstanding.`);
    } else if (rec.total > 0) {
        summaryParts.push('This record appears fully settled based on matched payments.');
    }
    if (summaryParts.length) {
        md += `\n\n${formatSection('Summary', summaryParts.join(' '))}`;
    }

    return md;
}

function markdownMoneyTable(headers: [string, string], rows: Array<[string, string]>): string {
    const head = `| ${headers[0]} | ${headers[1]} |`;
    const sep = `| --- | ---: |`;
    const body = rows.map(([name, amount]) => `| ${name.replace(/\|/g, '\\|')} | ${amount} |`);
    return [head, sep, ...body].join('\n');
}

function totalsAskFocus(question: string): {
    onlyTotal: boolean;
    wantClients: boolean;
    wantVendors: boolean;
    wantStatus: boolean;
} {
    const q = question
        .toLowerCase()
        .replace(/\bgran\b/g, 'grand')
        .replace(/\btotoals?\b/g, 'total');
    const wantClients = /\b(clients?|customers?)\b/.test(q);
    const wantVendors = /\b(vendors?|suppliers?)\b/.test(q);
    const wantStatus = /\b(status|paid|pending|overdue|cancelled|canceled)\b/.test(q);
    const onlyTotal =
        /\bonly\b/.test(q) ||
        (/^\s*(the\s+)?(grand\s+)?totals?\s*[.?!]*\s*$/.test(q) && !wantClients && !wantVendors);
    return {
        onlyTotal,
        wantClients,
        wantVendors,
        wantStatus: wantStatus || (!onlyTotal && !wantClients && !wantVendors),
    };
}

function buildComputedFinanceTotalsAnswer(
    records: FinanceRecord[],
    sourceLabel: string,
    question = ''
): string {
    const { records: deduped } = dedupeFinanceRecords(records);
    const rows = deduped.filter((r) => r.recordKind !== 'payment' && r.total > 0);
    if (!rows.length) {
        return `I couldn't find invoice amounts in ${sourceLabel}. Reprocess the file if extraction is still running.`;
    }

    const currency = rows[0]?.currency || 'PKR';
    const grand = rows.reduce((s, r) => s + r.total, 0);
    const grandLabel = formatMoney(grand, currency);
    const focus = totalsAskFocus(question);

    const byStatus = new Map<string, number>();
    const byVendor = new Map<string, number>();
    const byClient = new Map<string, number>();
    for (const r of rows) {
        const status = formatStatusLabel(r.paymentStatus || 'Unknown');
        byStatus.set(status, (byStatus.get(status) || 0) + r.total);
        const vendor = r.vendor.trim() || 'Unknown vendor';
        byVendor.set(vendor, (byVendor.get(vendor) || 0) + r.total);
        const client = r.client.trim() || 'Unknown client';
        byClient.set(client, (byClient.get(client) || 0) + r.total);
    }

    const knownClients = [...byClient.keys()].filter((k) => !/^unknown/i.test(k));
    const knownVendors = [...byVendor.keys()].filter((k) => !/^unknown/i.test(k));

    const lead = `The grand total in ${sourceLabel} is **${grandLabel}** across **${rows.length}** invoice row(s).`;
    if (focus.onlyTotal) {
        return cleanAgentMarkdown(lead);
    }

    const parts: string[] = [lead];

    const showClients = focus.wantClients && knownClients.length > 0;
    const showVendors = focus.wantVendors && knownVendors.length > 0;
    const showStatus = focus.wantStatus && byStatus.size > 0;

    if (showStatus) {
        const statusRows = [...byStatus.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([status, total]) => [status, formatMoney(total, currency)] as [string, string]);
        parts.push('', '**By status**', '', markdownMoneyTable(['Status', 'Total'], statusRows));
    }

    if (showVendors) {
        const vendorRows = [...byVendor.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([vendor, total]) => [vendor, formatMoney(total, currency)] as [string, string]);
        parts.push('', '**By vendor**', '', markdownMoneyTable(['Vendor', 'Total'], vendorRows));
    }

    if (showClients) {
        const clientRows = [...byClient.entries()]
            .sort((a, b) => b[1] - a[1])
            .filter(([name]) => !/^unknown/i.test(name) || knownClients.length === 0)
            .slice(0, 50)
            .map(([client, total]) => [client, formatMoney(total, currency)] as [string, string]);
        parts.push('', '**By client**', '', markdownMoneyTable(['Client', 'Total'], clientRows));
    }

    if (showClients && knownClients.length === 0) {
        parts.push('', '_No client names were extracted on these rows._');
    }

    return cleanAgentMarkdown(parts.join('\n'));
}

export async function tryFinanceSpreadsheetTotalCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceChatActionResult> {
    if (!detectFinanceSpreadsheetTotalAsk(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    let scopedDocIds = params.documentIds;
    const explicitName = extractExplicitFilenameFromQuestion(params.question);
    if (explicitName) {
        const named = await resolveFinanceDocumentIdsFromQuestion(params.user, params.question, {
            preferIds: params.documentIds,
        });
        if (named?.length) scopedDocIds = named.slice(0, 1);
    }

    let records = await loadFinanceRecords(params.user, { documentIds: scopedDocIds });
    if (!records.length) {
        return {
            handled: true,
            answer:
                'No finance rows in scope. Select your spreadsheet or invoices in Document scope, then ask again for the total.',
            citations: [],
        };
    }

    const preferred = detectCurrencyPreference(params.question);
    let convertNote = '';
    if (preferred === 'PKR') {
        const conv = convertFinanceRecordsToCurrency(records, 'PKR', DEFAULT_FX_RATES_TO_USD);
        records = conv.records.filter((r) => (r.currency || '').toUpperCase() === 'PKR');
        if (conv.converted > 0) {
            convertNote = `USD amounts converted to PKR at 1 USD = ${DEFAULT_FX_RATES_TO_USD.PKR} PKR. INR/₹ is not used.`;
        } else {
            convertNote = 'All amounts shown in PKR as recorded in the files. INR/₹ is not used.';
        }
    } else if (preferred === 'USD') {
        const conv = convertFinanceRecordsToCurrency(records, 'USD', DEFAULT_FX_RATES_TO_USD);
        records = conv.records.filter((r) => (r.currency || '').toUpperCase() === 'USD');
    }

    const fileIds = [...new Set(records.map((r) => r.documentId))];
    const sourceNames = [...new Set(records.map((r) => r.filename))];
    const sourceLabel =
        sourceNames.length === 1
            ? `\`${sourceNames[0]}\``
            : `**${fileIds.length}** scoped finance file(s)`;

    let answer = buildComputedFinanceTotalsAnswer(records, sourceLabel, params.question);
    if (convertNote) {
        answer += `\n\n_${convertNote}_`;
    }
    answer = answer.replace(/₹/g, 'PKR ').replace(/\bINR\b/g, 'PKR');
    const citations = [...new Map(records.map((r) => [r.documentId, r])).values()]
        .slice(0, 12)
        .map((r) => ({
            documentId: r.documentId,
            filename: r.filename,
            documentType: r.classification,
            phase3Agent: FINANCE_AGENT,
        }));

    return { handled: true, answer, citations };
}

export async function tryFinanceDocumentExplainCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceChatActionResult> {
    if (!detectFinanceDocumentExplain(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const records = await loadFinanceRecords(params.user, { documentIds: params.documentIds });
    if (!records.length) {
        return {
            handled: true,
            answer:
                'No finance documents in scope. Select invoices or financial files in Document scope, then ask again.',
            citations: [],
        };
    }

    let targets = records;
    const nameTokens = extractDocumentNameTokens(params.question);
    if (nameTokens.length) {
        const matchedIds = matchDocumentIdsByNameTokens(
            records.map((r) => ({ documentId: r.documentId, originalFilename: r.filename })),
            params.question
        );
        if (matchedIds.length) {
            const idSet = new Set(matchedIds);
            targets = records.filter((r) => idSet.has(r.documentId));
        }
    }

    const q = params.question.toLowerCase();
    const vendorNeedle = targets.length > 1 ? q.match(/\bvendor\s+([a-z0-9\s.-]{2,40})/i)?.[1]?.trim() : '';
    if (vendorNeedle) {
        const filtered = targets.filter((r) => r.vendor.toLowerCase().includes(vendorNeedle));
        if (filtered.length) targets = filtered;
    }

    if (targets.length > 1 && nameTokens.length === 0 && !vendorNeedle) {
        const preview = targets.slice(0, 5).map((r, i) => {
            const out = r.outstanding != null ? r.outstanding : r.total;
            return `${i + 1}. **${r.filename}** — ${r.vendor || 'Unknown vendor'} · ${formatMoney(out, r.currency)} outstanding`;
        });
        return {
            handled: true,
            answer: cleanAgentMarkdown(
                [
                    formatAgentHeading('Finance overview', 2),
                    '',
                    `You have **${targets.length}** finance record(s) in scope. Name a file or vendor to focus on one record.`,
                    '',
                    ...preview,
                    formatAgentFooter(
                        'Example: “explain invoice for Acme Corp” or “overview of vendor spend for TechSupply”.'
                    ),
                ].join('\n')
            ),
            citations: targets.slice(0, 5).map((r) => ({
                documentId: r.documentId,
                filename: r.filename,
                documentType: r.classification,
                phase3Agent: FINANCE_AGENT,
            })),
        };
    }

    const chosen = targets.slice(0, 3);
    let md = formatAgentIntro([
        formatAgentHeading('Finance overview', 2),
        chosen.length === 1
            ? 'Here is an overview of the finance record in your scope:'
            : `Here is an overview of **${chosen.length}** finance record(s) in your scope:`,
        formatAgentDivider(),
    ]);

    chosen.forEach((rec, i) => {
        md += `\n\n${formatFinanceRecordExplain(rec)}`;
        if (i < chosen.length - 1) md += `\n\n${formatAgentDivider()}`;
    });

    md += formatAgentFooter(
        'Ask for a chart (vendor spend, aging, monthly trend) or say “reconciliation audit” for a full AP review.'
    );

    return {
        handled: true,
        answer: cleanAgentMarkdown(md),
        citations: chosen.map((r) => ({
            documentId: r.documentId,
            filename: r.filename,
            documentType: r.classification,
            phase3Agent: FINANCE_AGENT,
        })),
    };
}

function getRecordPaymentStatus(r: FinanceRecord): 'PAID' | 'PARTIAL' | 'UNPAID' {
    const out = r.outstanding != null ? r.outstanding : r.total;
    if (out <= 0) return 'PAID';
    if (r.paidApplied && r.paidApplied > 0) return 'PARTIAL';
    return 'UNPAID';
}

export async function tryFinanceReconciliationCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceChatActionResult> {
    if (!detectFinanceReconciliation(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const records = await loadFinanceRecords(params.user, { documentIds: params.documentIds });
    if (!records.length) {
        return {
            handled: true,
            answer: 'No financial records found in your library to audit or reconcile.',
            citations: [],
        };
    }

    const invoiceNumberMap = new Map<string, FinanceRecord[]>();
    const amountMap = new Map<number, FinanceRecord[]>();
    const flaggedDuplicates: { record: FinanceRecord; reason: string }[] = [];

    for (const rec of records) {
        if (rec.invoiceNumber) {
            const list = invoiceNumberMap.get(rec.invoiceNumber) || [];
            list.push(rec);
            invoiceNumberMap.set(rec.invoiceNumber, list);
        }
        if (rec.total && rec.total > 0) {
            const list = amountMap.get(rec.total) || [];
            list.push(rec);
            amountMap.set(rec.total, list);
        }
    }

    // Flag duplicates
    for (const [invNum, list] of invoiceNumberMap.entries()) {
        if (list.length > 1) {
            for (const r of list) {
                flaggedDuplicates.push({ record: r, reason: `Duplicate Invoice Number (#${invNum})` });
            }
        }
    }

    for (const [amt, list] of amountMap.entries()) {
        if (list.length > 1) {
            for (const r of list) {
                if (!flaggedDuplicates.some((d) => d.record.documentId === r.documentId)) {
                    flaggedDuplicates.push({ record: r, reason: `Matching Duplicate Amount (${r.currency || 'USD'} ${amt})` });
                }
            }
        }
    }

    let markdown = `${formatAgentHeading('AP reconciliation audit', 2)}\n\n`;
    markdown += `Scanned **${records.length}** financial document(s):\n\n`;
    markdown += `- **Flagged discrepancies / duplicates:** ${flaggedDuplicates.length}\n`;
    markdown += `- **Clean records:** ${records.length - flaggedDuplicates.length}\n\n`;

    if (flaggedDuplicates.length) {
        markdown += `**Flagged items**\n\n`;
        markdown += `| Document | Invoice # | Party | Amount | Warning |\n`;
        markdown += `| --- | --- | --- | --- | --- |\n`;
        for (const flag of flaggedDuplicates) {
            const r = flag.record;
            markdown += `| **${r.filename}** | ${r.invoiceNumber || 'N/A'} | ${r.vendor || r.client || 'N/A'} | ${formatMoney(r.total || 0, r.currency || 'USD')} | ${flag.reason} |\n`;
        }
        markdown += `\n`;
    } else {
        markdown += `No duplicate invoice numbers or identical amount mismatches detected.\n\n`;
    }

    markdown += `**AP settlement summary**\n\n`;
    markdown += `| Document | Invoice date | Vendor | Status | Outstanding |\n`;
    markdown += `| --- | --- | --- | --- | --- |\n`;
    for (const r of records.slice(0, 15)) {
        const pStatus = getRecordPaymentStatus(r);
        const statusBadge =
            pStatus === 'PAID' ? 'Paid' : pStatus === 'PARTIAL' ? 'Partially paid' : 'Unpaid';
        markdown += `| **${r.filename}** | ${formatDate(r.invoiceDate)} | ${r.vendor || 'N/A'} | ${statusBadge} | ${formatMoney(r.outstanding != null ? r.outstanding : r.total || 0, r.currency || 'USD')} |\n`;
    }

    const citations = records.map((r: FinanceRecord) => ({
        documentId: r.documentId,
        filename: r.filename,
        documentType: r.classification || 'invoice',
        phase3Agent: FINANCE_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

export async function tryFinanceCashOutflowCommand(params: {
    user: AuthUser;
    question: string;
    phase3Agent?: string;
    documentIds?: string[];
}): Promise<FinanceChatActionResult> {
    if (!detectFinanceCashOutflow(params.question, params.phase3Agent)) {
        return { handled: false };
    }

    const records = await loadFinanceRecords(params.user, { documentIds: params.documentIds });
    if (!records.length) {
        return {
            handled: true,
            answer: 'No financial records found in your library to project cash outflows.',
            citations: [],
        };
    }

    const now = new Date();
    let dueNext7 = 0;
    let dueNext30 = 0;
    let dueNext60 = 0;
    let dueLater = 0;
    let overdue = 0;
    let currency = 'USD';

    for (const r of records) {
        if (getRecordPaymentStatus(r) === 'PAID') continue;
        const dueAmt = r.outstanding != null ? r.outstanding : r.total || 0;
        if (!dueAmt) continue;

        if (r.currency) currency = r.currency;

        if (r.dueDate) {
            const due = new Date(r.dueDate);
            const diffDays = Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
            if (diffDays < 0) {
                overdue += dueAmt;
            } else if (diffDays <= 7) {
                dueNext7 += dueAmt;
            } else if (diffDays <= 30) {
                dueNext30 += dueAmt;
            } else if (diffDays <= 60) {
                dueNext60 += dueAmt;
            } else {
                dueLater += dueAmt;
            }
        } else {
            dueNext30 += dueAmt;
        }
    }

    const totalOutflow = overdue + dueNext7 + dueNext30 + dueNext60 + dueLater;

    let markdown = `${formatAgentHeading(`Cash outflow forecast (${currency})`, 2)}\n\n`;
    markdown += `Total projected payable outflow: **${formatMoney(totalOutflow, currency)}**\n\n`;

    markdown += `| Time window | Due amount | Priority |\n`;
    markdown += `| --- | --- | --- |\n`;
    markdown += `| **Past due / overdue** | ${formatMoney(overdue, currency)} | Immediate attention |\n`;
    markdown += `| **Next 7 days** | ${formatMoney(dueNext7, currency)} | High priority |\n`;
    markdown += `| **Next 30 days** | ${formatMoney(dueNext30, currency)} | Scheduled |\n`;
    markdown += `| **31–60 days** | ${formatMoney(dueNext60, currency)} | Upcoming |\n`;
    markdown += `| **Beyond 60 days** | ${formatMoney(dueLater, currency)} | Long-term |\n`;

    const citations = records.map((r: FinanceRecord) => ({
        documentId: r.documentId,
        filename: r.filename,
        documentType: r.classification || 'invoice',
        phase3Agent: FINANCE_AGENT,
    }));

    return {
        handled: true,
        answer: markdown,
        citations,
    };
}

