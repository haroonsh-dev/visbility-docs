import Document from '../models/Document';
import { AuthUser } from './accessScope';
import { buildDocumentFilter } from './accessScope';
import { getDocumentExtractions, getAiDocument, resolveDocumentAiOrgId, isAiServiceEnabled } from './aiServiceClient';
import type { ChatVisualDataRow, ChatVisualSpec, FinanceAnalyticsCoverage } from '../types/chatVisuals';

export const FINANCE_AGENT = 'finance_agent';

export const FINANCE_DOC_TYPES = new Set([
    'invoice',
    'financial_statement',
    'expense_report',
    'payment_receipt',
    'tax_document',
    'bank_statement',
    'budget',
    'purchase_order',
    'po',
    'receipt',
    'delivery_note',
]);

/** Classifications excluded from automatic library-wide finance analytics (still allowed when explicitly in chat scope). */
export const FINANCE_ANALYTICS_EXCLUDED_CLASSIFICATIONS = new Set([
    'offer_letter',
    'resume',
    'transcript',
    'employment_contract',
    'leave_application',
    'quotation',
]);

export type FinanceRecord = {
    documentId: string;
    filename: string;
    vendor: string;
    client: string;
    total: number;
    currency: string;
    invoiceDate: Date | null;
    dueDate: Date | null;
};

export type LoadFinanceOptions = {
    maxDocs?: number;
    documentIds?: string[];
};

function parseNumber(raw: unknown): number | null {
    if (raw == null) return null;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    const s = String(raw).replace(/,/g, '').replace(/[^\d.-]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function parseDate(raw: unknown): Date | null {
    const s = scalarField(raw);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** Unwrap plain strings or grounding objects like { source_text: "..." }. */
export function scalarField(raw: unknown): string {
    if (raw == null) return '';
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    if (typeof raw === 'object' && raw !== null) {
        const o = raw as Record<string, unknown>;
        if (typeof o.source_text === 'string') return o.source_text.trim();
        if (typeof o.value === 'string') return o.value.trim();
    }
    return '';
}

function pickClient(data: Record<string, unknown>): string {
    const client =
        scalarField(data.customer_name) ||
        scalarField(data.bill_to) ||
        scalarField(data.client_name) ||
        scalarField(data.buyer_name) ||
        scalarField(data.ship_to);
    return client || '';
}

function pickVendor(
    data: Record<string, unknown>,
    filenameHint?: string
): string {
    let vendor =
        scalarField(data.vendor_name) ||
        scalarField(data['Vendor Name']) ||
        scalarField(data.vendor) ||
        scalarField(data.supplier_name) ||
        scalarField(data.merchant_name) ||
        scalarField(data.payee) ||
        scalarField(data.seller_name);
    if (!vendor) {
        const vn = data.vendor_name;
        if (vn && typeof vn === 'object' && vn !== null) {
            vendor = scalarField((vn as Record<string, unknown>).name);
        }
    }
    const name = `${vendor || ''} ${filenameHint || ''}`.toLowerCase();
    // Digilog logo OCR often becomes NIGILOG / GLECTRONICS / CLECTRONICS / GLECTRONIC
    if (
        /digilog|nigilog|glectronic|clectronic|dialog\s*electronics/i.test(name) ||
        /digilog/i.test(filenameHint || '')
    ) {
        return 'Digilog Electronics';
    }
    if (vendor) return vendor;
    return 'Unknown vendor';
}

/** "that / this / it" → prefer focus docs from prior chat turn, not the whole scope. */
export function questionRefersToSpecificDocument(question: string): boolean {
    const q = question.toLowerCase().trim();
    if (
        /\b(this|that|the)\s+(invoice|document|file|pdf|one|bill|receipt)\b/.test(q) ||
        /\b(chart|graph|visual|show|give|list)\b.*\b(that|this|it)\b/.test(q) ||
        /\b(that|this|it)\b.*\b(chart|graph|visual|breakdown|items?|totals?)\b/.test(q)
    ) {
        return true;
    }
    // Short follow-ups: "give me chart of that", "chart it", "for that"
    if (/\b(of|for|about)\s+(that|this|it)\b/.test(q)) return true;
    if (/^(chart|graph|visualize|show)\s+(that|this|it)\b/.test(q)) return true;
    return false;
}

/**
 * Narrow scoped IDs when the user names a file or points at one ("that").
 * Named file always wins — other scoped documents are excluded from the chart.
 */
export async function narrowFinanceDocumentIds(params: {
    user: AuthUser;
    question: string;
    scopedIds?: string[];
    focusIds?: string[];
}): Promise<string[] | undefined> {
    const scoped = (params.scopedIds || []).filter(Boolean);
    const focus = (params.focusIds || []).filter(Boolean);
    const q = params.question;

    // 1) Name in the message → only that file (never the rest of the scope)
    const fromName = await resolveFinanceDocumentIdsFromQuestion(params.user, q, {
        preferIds: scoped.length ? scoped : undefined,
    });
    if (fromName?.length) {
        return fromName.slice(0, 1);
    }

    // 2) "that / this / it" → last discussed focus doc
    if (questionRefersToSpecificDocument(q)) {
        if (focus.length && scoped.length) {
            const scopedSet = new Set(scoped);
            const hit = focus.filter((id) => scopedSet.has(id));
            if (hit.length) return hit.slice(0, 1);
        }
        if (focus.length) return focus.slice(0, 1);
        if (scoped.length === 1) return scoped;
        // Ambiguous "that" with several files → caller clarifies
        if (scoped.length > 1) return undefined;
    }

    // 3) No name / no deictic → full scope (portfolio charts)
    return scoped.length ? scoped : undefined;
}

function normalizePartyKey(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, ' ');
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

function inferDocumentTotal(data: Record<string, unknown>): number | null {
    const direct =
        parseNumber(data.total_amount) ??
        parseNumber(data['Total Amount (PKR)']) ??
        parseNumber(data['Total Amount']) ??
        parseNumber(data.total) ??
        parseNumber(data.amount) ??
        parseNumber(data.grand_total) ??
        parseNumber(data.net_amount) ??
        parseNumber(data.invoice_total) ??
        parseNumber(data.balance_due);
    if (direct != null && direct > 0) return direct;

    const subtotal = parseNumber(data.subtotal);
    if (subtotal != null && subtotal > 0) {
        const tax = parseNumber(data.tax_amount) ?? 0;
        const ship = parseNumber(data.shipping_charges) ?? 0;
        const disc = parseNumber(data.discount) ?? 0;
        return subtotal + tax + ship - disc;
    }
    return null;
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
    const orgId = resolveDocumentAiOrgId(doc as any, user);
    let extractions = await getDocumentExtractions(doc.pythonDocumentId, orgId);
    if (!extractions?.length && orgId) {
        extractions = await getDocumentExtractions(doc.pythonDocumentId, '');
    }
    let data = pickExtractionData(extractions);
    if (!Object.keys(data).length || inferDocumentTotal(data) == null) {
        const aiDoc = await getAiDocument(doc.pythonDocumentId, orgId);
        const meta = aiDoc?.extracted_data;
        if (meta && typeof meta === 'object') {
            data = normalizeExtractionPayload({
                ...data,
                ...(meta as Record<string, unknown>),
            });
        }
    }
    return preferPrintedInvoiceTotal(normalizeExtractionPayload(data));
}

/** Prefer printed total_amount when line_items sum disagrees (common OCR/LLM failure). */
function preferPrintedInvoiceTotal(data: Record<string, unknown>): Record<string, unknown> {
    const items = data.line_items;
    if (!Array.isArray(items) || !items.length) return data;
    let lineSum = 0;
    let n = 0;
    for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        const row = raw as Record<string, unknown>;
        const t =
            parseNumber(row.total_price) ??
            parseNumber(row.total) ??
            parseNumber(row.amount) ??
            parseNumber(row.line_total);
        if (t != null) {
            lineSum += t;
            n += 1;
        }
    }
    const printed =
        parseNumber(data.total_amount) ??
        parseNumber(data.grand_total) ??
        parseNumber(data['Total Amount']);
    if (printed != null && n > 0 && Math.abs(lineSum - printed) > Math.max(1, 0.02 * printed)) {
        return {
            ...data,
            total_amount: printed,
            _line_items_sum: Math.round(lineSum * 100) / 100,
            _line_items_total_mismatch: true,
        };
    }
    return data;
}

function makeRecord(
    doc: { documentId: string; originalFilename: string },
    vendor: string,
    client: string,
    total: number,
    currency: string,
    data: Record<string, unknown>
): FinanceRecord {
    const cur = (currency || scalarField(data.currency) || 'USD').toUpperCase().slice(0, 3);
    return {
        documentId: doc.documentId,
        filename: doc.originalFilename,
        vendor: vendor.trim() || 'Unknown vendor',
        client: client.trim(),
        total,
        currency: cur,
        invoiceDate: parseDate(data.invoice_date || data.document_date || data.date),
        dueDate: parseDate(data.due_date || data.payment_due_date),
    };
}

function isStandardInvoiceExtraction(
    data: Record<string, unknown>,
    doc?: { originalFilename?: string }
): boolean {
    const inv =
        scalarField(data.invoice_number) ||
        scalarField(data.invoice_no) ||
        scalarField(data.invoice_id);
    const total = inferDocumentTotal(data);
    const vendor = pickVendor(data, doc?.originalFilename);
    return Boolean(inv && total != null && total > 0 && vendor !== 'Unknown vendor');
}

/**
 * Build finance rows for one document. Prefer one row per invoice (vendor + total_amount).
 * Avoids LLM-hallucinated vendor_breakdown on single invoices and line-item double counting.
 */
function recordsFromExtraction(
    doc: { documentId: string; originalFilename: string },
    data: Record<string, unknown>
): FinanceRecord[] {
    const currency = scalarField(data.currency) || 'USD';
    const client = pickClient(data);
    const defaultVendor = pickVendor(data, doc.originalFilename);
    const invoiceDate = parseDate(data.invoice_date || data.document_date || data.date);
    const dueDate = parseDate(data.due_date || data.payment_due_date);

    if (isStandardInvoiceExtraction(data, doc)) {
        const total = inferDocumentTotal(data)!;
        return [
            makeRecord(doc, defaultVendor, client, total, currency, {
                ...data,
                invoice_date: invoiceDate,
                due_date: dueDate,
            }),
        ];
    }

    const records: FinanceRecord[] = [];

    const docType = scalarField(data.document_type).toLowerCase();
    const allowVendorBreakdown =
        /expense|summary|report|rollup|aggregate/.test(docType) ||
        (!scalarField(data.invoice_number) && !scalarField(data.invoice_no));

    const vb = data.vendor_breakdown;
    if (
        allowVendorBreakdown &&
        vb &&
        typeof vb === 'object' &&
        !Array.isArray(vb) &&
        Object.keys(vb as object).length > 0
    ) {
        for (const [vendorKey, amount] of Object.entries(vb as Record<string, unknown>)) {
            const total = parseNumber(amount);
            if (total != null && total > 0) {
                records.push(
                    makeRecord(doc, vendorKey, client, total, currency, {
                        ...data,
                        invoice_date: data.invoice_date,
                        due_date: data.due_date,
                    })
                );
            }
        }
        if (records.length) return records;
    }

    const categories = data.expense_categories;
    if (Array.isArray(categories) && allowVendorBreakdown) {
        for (const cat of categories) {
            if (!cat || typeof cat !== 'object') continue;
            const c = cat as Record<string, unknown>;
            const items = c.line_items;
            if (!Array.isArray(items)) continue;
            for (const item of items) {
                if (!item || typeof item !== 'object') continue;
                const row = item as Record<string, unknown>;
                const total = parseNumber(row.amount) ?? parseNumber(row.total);
                if (total == null || total <= 0) continue;
                const vendor = scalarField(row.vendor) || scalarField(row.merchant) || defaultVendor;
                records.push(makeRecord(doc, vendor, client, total, currency, data));
            }
        }
        if (records.length) return records;
    }

    const lineItems = data.line_items;
    const lineRecords: FinanceRecord[] = [];
    if (Array.isArray(lineItems)) {
        for (const item of lineItems) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            const total =
                parseNumber(row.total) ??
                parseNumber(row.amount) ??
                (parseNumber(row.quantity) != null && parseNumber(row.unit_price) != null
                    ? Number(row.quantity) * Number(row.unit_price)
                    : null);
            if (total == null || total <= 0) continue;
            const vendor =
                scalarField(row.vendor) ||
                scalarField(row.vendor_name) ||
                scalarField(row.supplier) ||
                defaultVendor;
            lineRecords.push(makeRecord(doc, vendor, client, total, currency, data));
        }
    }

    const docTotal = inferDocumentTotal(data);
    if (docTotal != null && docTotal > 0 && defaultVendor !== 'Unknown vendor') {
        const lineSum = lineRecords.reduce((s, r) => s + r.total, 0);
        const tolerance = Math.max(1, docTotal * 0.02);
        if (lineRecords.length === 0 || Math.abs(lineSum - docTotal) > tolerance) {
            return [
                makeRecord(doc, defaultVendor, client, docTotal, currency, {
                    ...data,
                    invoice_date: invoiceDate,
                    due_date: dueDate,
                }),
            ];
        }
    }

    if (lineRecords.length > 0) {
        return lineRecords;
    }

    if (!records.length && docTotal != null && docTotal > 0) {
        records.push(
            makeRecord(doc, defaultVendor, client, docTotal, currency, {
                ...data,
                invoice_date: invoiceDate,
                due_date: dueDate,
            })
        );
    }

    return records;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = [];
    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await fn(items[idx]);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function buildFinanceScopeQuery(filter: Record<string, unknown>, documentIds?: string[]): Record<string, unknown> {
    const query: Record<string, unknown> = {
        ...filter,
        status: 'ready',
        pythonDocumentId: { $exists: true, $nin: [null, ''] },
        classification: { $nin: [...FINANCE_ANALYTICS_EXCLUDED_CLASSIFICATIONS] },
        $or: [
            { classification: { $in: [...FINANCE_DOC_TYPES] } },
            { 'metadata.phase3Agent': FINANCE_AGENT },
            {
                originalFilename: {
                    $regex: /invoice|inv[_\-.]|bill|receipt|expense|statement/i,
                },
            },
        ],
    };
    if (documentIds?.length) {
        delete query.classification;
        query.documentId = { $in: documentIds };
    }
    return query;
}

export type FinanceFileCoverage = {
    documentId: string;
    filename: string;
    status: 'in_charts' | 'missing_amount' | 'no_extraction' | 'not_linked';
    detail?: string;
};

export async function buildFinanceFileCoverage(
    user: AuthUser,
    records: FinanceRecord[],
    options: LoadFinanceOptions = {}
): Promise<FinanceFileCoverage[]> {
    const maxDocs = options.maxDocs ?? 200;
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);
    const docs = await Document.find(query)
        .select('documentId originalFilename pythonDocumentId classification metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();

    const inCharts = new Set(records.map((r) => r.documentId));
    const report: FinanceFileCoverage[] = [];

    for (const doc of docs) {
        if (inCharts.has(doc.documentId)) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'in_charts',
            });
            continue;
        }
        if (!doc.pythonDocumentId) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'not_linked',
                detail: 'Not linked to AI processing—re-upload or reprocess.',
            });
            continue;
        }
        const data = await extractionPayloadForDoc(doc, user);
        const keys = Object.keys(data).filter((k) => !k.startsWith('_'));
        if (!keys.length) {
            report.push({
                documentId: doc.documentId,
                filename: doc.originalFilename,
                status: 'no_extraction',
                detail: 'No extraction stored yet—open document and run reprocess.',
            });
            continue;
        }
        const total = inferDocumentTotal(data);
        const vendor = pickVendor(data, doc.originalFilename);
        const hints: string[] = [];
        if (total == null) hints.push('no total_amount/subtotal');
        if (vendor === 'Unknown vendor') hints.push('no vendor_name');
        report.push({
            documentId: doc.documentId,
            filename: doc.originalFilename,
            status: 'missing_amount',
            detail:
                hints.length > 0
                    ? `Extraction ran but ${hints.join(' and ')}. Fields found: ${keys.slice(0, 6).join(', ')}${keys.length > 6 ? '…' : ''}.`
                    : `Extraction present but could not build a chart row (${keys.slice(0, 6).join(', ')}).`,
        });
    }
    return report;
}

export async function loadFinanceRecords(user: AuthUser, options: LoadFinanceOptions = {}): Promise<FinanceRecord[]> {
    const maxDocs = options.maxDocs ?? 200;
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);

    const docs = await Document.find(query)
        .select('documentId originalFilename classification pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();

    if (!docs.length || !isAiServiceEnabled()) return [];

    const nested = await mapPool(docs, 6, async (doc) => {
        try {
            const data = await extractionPayloadForDoc(doc, user);
            return recordsFromExtraction(doc, data);
        } catch {
            return [] as FinanceRecord[];
        }
    });

    return nested.flat();
}

function dominantCurrency(records: FinanceRecord[]): string {
    const counts = new Map<string, number>();
    for (const r of records) {
        counts.set(r.currency, (counts.get(r.currency) || 0) + 1);
    }
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

function docIdsField(ids: Set<string>): string {
    return [...ids].join(',');
}

export function computeFinanceCoverage(
    records: FinanceRecord[],
    documentsInScope: number,
    files?: FinanceFileCoverage[]
): FinanceAnalyticsCoverage {
    const withAmount = new Set(records.map((r) => r.documentId));
    const withClient = new Set(records.filter((r) => r.client.trim()).map((r) => r.documentId));
    const withVendor = new Set(
        records.filter((r) => r.vendor && r.vendor !== 'Unknown vendor').map((r) => r.documentId)
    );
    return {
        documentsInScope,
        documentsWithAmount: withAmount.size,
        documentsWithClient: withClient.size,
        documentsWithVendor: withVendor.size,
        files,
    };
}

function aggregateByParty(
    records: FinanceRecord[],
    party: 'vendor' | 'client',
    maxBars = 20
): { rows: ChatVisualDataRow[]; currency: string; docCount: number } {
    const groups = new Map<string, { label: string; amount: number; currency: string; docs: Set<string> }>();

    for (const r of records) {
        const raw = party === 'vendor' ? r.vendor : r.client;
        if (!raw?.trim()) continue;
        const key = `${normalizePartyKey(raw)}::${r.currency}`;
        const existing = groups.get(key);
        if (existing) {
            existing.amount += r.total;
            existing.docs.add(r.documentId);
        } else {
            groups.set(key, {
                label: raw.trim(),
                amount: r.total,
                currency: r.currency,
                docs: new Set([r.documentId]),
            });
        }
    }

    const sorted = [...groups.values()].sort((a, b) => b.amount - a.amount).slice(0, maxBars);
    const currency = dominantCurrency(records);
    const categoryKey = party === 'vendor' ? 'vendor' : 'client';
    const rows: ChatVisualDataRow[] = sorted.map((g) => ({
        [categoryKey]:
            g.label.length > 32
                ? `${g.label.slice(0, 30)}…${g.currency !== currency ? ` (${g.currency})` : ''}`
                : g.label + (g.currency !== currency ? ` (${g.currency})` : ''),
        amount: Math.round(g.amount * 100) / 100,
        _documentIds: docIdsField(g.docs),
    }));

    const docCount = new Set(records.map((r) => r.documentId)).size;
    return { rows, currency, docCount };
}

export function formatVendorSpendTable(records: FinanceRecord[], maxRows = 25): string {
    const { rows, currency, docCount } = aggregateByParty(records, 'vendor', maxRows);
    if (!rows.length) return '_No vendor totals could be computed from extractions._';
    const lines = [
        `| Vendor | Total (${currency}) | Invoices |`,
        `| --- | ---: | ---: |`,
        ...rows.map((r) => {
            const vendor = String(r.vendor ?? '');
            const amount = Number(r.amount ?? 0);
            const ids = String(r._documentIds || '');
            const invCount = ids ? ids.split(',').filter(Boolean).length : 0;
            return `| ${vendor.replace(/\|/g, '\\|')} | ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | ${invCount || '—'} |`;
        }),
    ];
    const totalsByCurrency = sumTotalsByCurrency(records);
    const grand = totalsByCurrency.get(currency) ?? [...totalsByCurrency.values()].reduce((a, b) => a + b, 0);
    lines.push('');
    lines.push(
        `**Grand total (${currency}):** ${grand.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} across **${docCount}** invoice document(s).`
    );
    return lines.join('\n');
}

export function buildVendorSpendVisual(records: FinanceRecord[]): ChatVisualSpec {
    const { rows, currency, docCount } = aggregateByParty(records, 'vendor', 20);
    const withVendor = records.filter((r) => r.vendor && r.vendor !== 'Unknown vendor');
    const sourceDocumentIds = [...new Set(records.map((r) => r.documentId))];
    const unknown = records.filter((r) => !r.vendor || r.vendor === 'Unknown vendor').length;
    const warnings: string[] = [];
    if (unknown) warnings.push(`${unknown} document(s) missing vendor_name — reprocess if labels look wrong.`);
    if (sourceDocumentIds.length === 1) {
        warnings.push(`Scoped to 1 file: ${records[0]?.filename || 'invoice'}.`);
    }

    return {
        id: `fin_vendor_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: sourceDocumentIds.length === 1 ? 'Spend for this invoice' : 'Spend by vendor',
        subtitle: `${rows.length} vendor(s) · ${docCount} document(s) with amounts · primary ${currency}`,
        currency,
        categoryKey: 'vendor',
        series: [{ key: 'amount', label: `Amount (${currency})`, color: '#2563eb' }],
        data: rows.length ? rows : [{ vendor: 'No vendor on file', amount: 0 }],
        sourceDocumentIds,
        dataQuality: {
            level: unknown ? 'medium' : 'high',
            warnings: warnings.length ? warnings : undefined,
        },
        footer: withVendor.length
            ? `Sum of one extracted total_amount per invoice (not LLM estimates). Files: ${sourceDocumentIds.length}. Reprocess if a vendor looks wrong.`
            : 'Add vendor_name on invoices or line items with vendor to populate this chart.',
    };
}

export function buildClientSpendVisual(records: FinanceRecord[]): ChatVisualSpec {
    const clientRecords = records.filter((r) => r.client.trim());
    const { rows, currency, docCount } = aggregateByParty(clientRecords, 'client', 20);

    return {
        id: `fin_client_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: 'Revenue / spend by client',
        subtitle: `${rows.length} client(s) · ${docCount} document(s) · primary ${currency}`,
        currency,
        categoryKey: 'client',
        series: [{ key: 'amount', label: `Amount (${currency})`, color: '#4f46e5' }],
        data: rows.length ? rows : [{ client: 'No client on file', amount: 0 }],
        footer: 'Grouped by customer_name, bill_to, or client_name from extractions.',
    };
}

export function buildMonthlyTrendVisual(records: FinanceRecord[]): ChatVisualSpec {
    const currency = dominantCurrency(records);
    const filtered = records.filter((r) => r.currency === currency && r.invoiceDate);
    const byMonth = new Map<string, { amount: number; docs: Set<string> }>();
    for (const r of filtered) {
        const d = r.invoiceDate!;
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const cur = byMonth.get(key);
        if (cur) {
            cur.amount += r.total;
            cur.docs.add(r.documentId);
        } else {
            byMonth.set(key, { amount: r.total, docs: new Set([r.documentId]) });
        }
    }
    const rows: ChatVisualDataRow[] = [...byMonth.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(-12)
        .map(([month, v]) => ({
            month,
            amount: Math.round(v.amount * 100) / 100,
            _documentIds: docIdsField(v.docs),
        }));

    return {
        id: `fin_trend_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'area',
        title: 'Invoice volume over time',
        subtitle: `Monthly totals · ${currency}${filtered.length < records.length ? ' (primary currency)' : ''}`,
        currency,
        categoryKey: 'month',
        series: [{ key: 'amount', label: `Total (${currency})`, color: '#0d9488' }],
        data: rows,
        footer: 'Grouped by invoice date from extracted metadata.',
    };
}

export function buildAgingVisual(records: FinanceRecord[]): ChatVisualSpec {
    const currency = dominantCurrency(records);
    const filtered = records.filter((r) => r.currency === currency);
    const now = Date.now();
    const bucketKeys = ['Current (not due)', '1–30 days', '31–60 days', '61–90 days', '90+ days'] as const;
    const buckets = new Map<string, { amount: number; docs: Set<string> }>();
    for (const k of bucketKeys) buckets.set(k, { amount: 0, docs: new Set() });

    for (const r of filtered) {
        let key: (typeof bucketKeys)[number] = 'Current (not due)';
        if (!r.dueDate) {
            key = 'Current (not due)';
        } else {
            const due = r.dueDate.getTime();
            if (due >= now) {
                key = 'Current (not due)';
            } else {
                const days = Math.floor((now - due) / (86400 * 1000));
                if (days <= 30) key = '1–30 days';
                else if (days <= 60) key = '31–60 days';
                else if (days <= 90) key = '61–90 days';
                else key = '90+ days';
            }
        }
        const b = buckets.get(key)!;
        b.amount += r.total;
        b.docs.add(r.documentId);
    }

    const rows: ChatVisualDataRow[] = bucketKeys.map((bucket) => {
        const b = buckets.get(bucket)!;
        return {
            bucket,
            amount: Math.round(b.amount * 100) / 100,
            _documentIds: docIdsField(b.docs),
        };
    });

    return {
        id: `fin_aging_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: 'Payables aging',
        subtitle: `By due date · ${currency}`,
        currency,
        categoryKey: 'bucket',
        series: [{ key: 'amount', label: `Outstanding (${currency})`, color: '#d97706' }],
        data: rows,
        footer: 'Based on due dates and totals from finance documents.',
    };
}

export function buildDocTypeMixVisual(counts: Array<{ type: string; count: number }>): ChatVisualSpec {
    const rows = counts.map((c) => ({
        type: c.type.replace(/_/g, ' '),
        count: c.count,
    }));
    return {
        id: `fin_mix_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'pie',
        title: 'Finance documents by type',
        subtitle: 'Your library mix',
        categoryKey: 'type',
        series: [{ key: 'count', label: 'Documents' }],
        data: rows,
        footer: 'Classification counts for finance-related files.',
    };
}

export function sumTotalsByCurrency(records: FinanceRecord[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const r of records) {
        map.set(r.currency, (map.get(r.currency) || 0) + r.total);
    }
    return map;
}

const QUESTION_STOP_WORDS = new Set([
    'give',
    'show',
    'short', // typo for "show"
    'visual',
    'chart',
    'graph',
    'plot',
    'please',
    'invoice',
    'invoices',
    'document',
    'documents',
    'file',
    'files',
    'pdf',
    'items',
    'item',
    'each',
    'also',
    'with',
    'from',
    'that',
    'this',
    'them',
    'those',
    'these',
    'your',
    'have',
    'only',
    'just',
    'about',
    'full',
    'complete',
    'price',
    'quantity',
    'subtotal',
    'total',
    'totals',
    'amount',
    'amounts',
    'line',
    'lines',
    'spend',
    'vendor',
    'vendors',
    'client',
    'clients',
    'breakdown',
    'analytics',
    'overview',
    'electronics', // too generic alone; digilog/bata still match
]);

/** Known OCR / typo aliases → canonical filename token. */
const NAME_ALIASES: Record<string, string> = {
    dialong: 'digilog',
    dialog: 'digilog',
    dialogs: 'digilog',
    glectronics: 'digilog',
    glectronic: 'digilog',
    nigilog: 'digilog',
    nigilogic: 'digilog',
    clectronics: 'digilog',
    clectronic: 'digilog',
};

const OCR_FAMILY_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
    { re: /^(glectroni|nigilog|clectroni|digilog|dialog)/i, canonical: 'digilog' },
];

function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const prev = new Array(b.length + 1);
    const cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        cur[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

/** Expand a raw token with aliases + fuzzy OCR family (glectronic → digilog). */
export function expandNameToken(token: string): string[] {
    const w = token.toLowerCase().trim();
    if (!w) return [];
    const out = new Set<string>([w]);
    if (NAME_ALIASES[w]) out.add(NAME_ALIASES[w]);
    for (const [k, v] of Object.entries(NAME_ALIASES)) {
        if (w === k || w.startsWith(k) || k.startsWith(w)) out.add(v);
        else if (w.length >= 5 && k.length >= 5 && editDistance(w, k) <= 2) out.add(v);
    }
    for (const { re, canonical } of OCR_FAMILY_PATTERNS) {
        if (re.test(w)) out.add(canonical);
    }
    return [...out];
}

/** Tokens from the question that might be a filename / vendor / invoice #. */
export function extractDocumentNameTokens(question: string): string[] {
    const normalized = question.toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ');
    const words = normalized
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 3 && !QUESTION_STOP_WORDS.has(w));

    const expanded = new Set<string>();
    for (const w of words) {
        for (const t of expandNameToken(w)) expanded.add(t);
    }
    for (const m of question.match(/\d{4,}/g) || []) {
        expanded.add(m);
    }
    return [...expanded];
}

export type NameMatchDoc = {
    documentId: string;
    originalFilename: string;
    /** Extra haystack: vendor, client, invoice #, OCR aliases */
    searchText?: string;
};

/**
 * Score scoped docs against name tokens in the question.
 * Returns only the best match(es) — never the whole scope.
 */
export function matchDocumentIdsByNameTokens(docs: NameMatchDoc[], question: string): string[] {
    const tokens = extractDocumentNameTokens(question);
    if (!tokens.length || !docs.length) return [];

    const scored = docs
        .map((d) => {
            const name = (d.originalFilename || '').toLowerCase();
            const stem = name.replace(/\.[a-z0-9]+$/i, '');
            const compact = stem.replace(/[^a-z0-9]+/g, '');
            const extra = (d.searchText || '').toLowerCase();
            const hay = `${stem} ${compact} ${name} ${extra}`;
            let score = 0;
            for (const w of tokens) {
                if (!w) continue;
                const wc = w.replace(/[^a-z0-9]/g, '');
                if (stem === w || compact === w) score += 12;
                else if (stem.includes(w) || compact.includes(wc)) score += 6;
                else if (extra.includes(w) || (wc && extra.includes(wc))) score += 8; // vendor / OCR label
                else if (name.includes(w) || hay.includes(w)) score += 4;
                else if (stem.split(/[^a-z0-9]+/).some((p) => p === w || p.startsWith(w))) score += 5;
            }
            // Digilog OCR family: filename has digilog OR searchText has glectronic*
            if (
                tokens.includes('digilog') &&
                (/digilog|nigilog|glectronic|clectronic/i.test(hay) || /digilog/i.test(name))
            ) {
                score += 10;
            }
            return { documentId: d.documentId, score, filename: d.originalFilename };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

    if (!scored.length) return [];
    const top = scored[0].score;
    return scored.filter((s) => s.score === top).map((s) => s.documentId);
}

/** Attach Digilog OCR synonyms into searchText when filename/vendor hints Digilog. */
export function enrichSearchTextForDoc(filename: string, vendorOrExtra = ''): string {
    const base = `${filename} ${vendorOrExtra}`.toLowerCase();
    const bits = [vendorOrExtra];
    if (/digilog|nigilog|glectronic|clectronic|dialog/i.test(base)) {
        bits.push('digilog', 'glectronics', 'glectronic', 'nigilog', 'digilog electronics');
    }
    return bits.filter(Boolean).join(' ');
}

export type LineItemRow = {
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
};

export function extractLineItemRows(data: Record<string, unknown>): LineItemRow[] {
    const items = data.line_items;
    if (!Array.isArray(items)) return [];
    const rows: LineItemRow[] = [];
    for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const desc =
            scalarField(row.description) ||
            scalarField(row.item) ||
            scalarField(row.product_name) ||
            scalarField(row.name) ||
            'Item';
        const sku = scalarField(row.sku);
        const label = sku ? `${desc} (${sku})` : desc;

        let qty = parseNumber(row.quantity) ?? parseNumber(row.qty);
        let unit =
            parseNumber(row.unit_price) ??
            parseNumber(row.price) ??
            parseNumber(row.rate) ??
            parseNumber(row.unit_rate);
        let total =
            parseNumber(row.total_price) ??
            parseNumber(row.total) ??
            parseNumber(row.amount) ??
            parseNumber(row.line_total) ??
            parseNumber(row.line_amount);

        // Fill missing third value
        if (qty != null && unit != null && (total == null || total <= 0)) {
            total = qty * unit;
        } else if (qty != null && qty > 0 && total != null && (unit == null || unit <= 0)) {
            unit = total / qty;
        } else if (unit != null && unit > 0 && total != null && (qty == null || qty <= 0)) {
            const q = total / unit;
            qty = Math.abs(q - Math.round(q)) < 0.05 ? Math.round(q) : q;
        }

        qty = qty ?? 1;
        if (total == null || total <= 0) continue;

        // Prefer printed total; fix qty/unit when product mismatches
        if (unit != null && unit > 0 && Math.abs(qty * unit - total) > Math.max(1, 0.02 * total)) {
            const qFromUnit = total / unit;
            if (Math.abs(qFromUnit - Math.round(qFromUnit)) < 0.05 && Math.round(qFromUnit) >= 1) {
                qty = Math.round(qFromUnit);
            } else if (qty > 0) {
                unit = total / qty;
            }
        }

        rows.push({
            description: label,
            quantity: qty,
            unitPrice: unit != null && unit > 0 ? unit : total / qty,
            total,
        });
    }
    return rows;
}

function truncateLabel(text: string, max = 36): string {
    const t = text.trim();
    if (t.length <= max) return t;
    return `${t.slice(0, max - 1)}…`;
}

export function buildLineItemsVisual(
    doc: { documentId: string; originalFilename: string },
    data: Record<string, unknown>
): ChatVisualSpec | null {
    const rows = extractLineItemRows(data);
    if (!rows.length) return null;

    const currency = (scalarField(data.currency) || 'PKR').toUpperCase().slice(0, 3);
    const vendor = pickVendor(data, doc.originalFilename);
    const shortName =
        doc.originalFilename.length > 40
            ? `${doc.originalFilename.slice(0, 38)}…`
            : doc.originalFilename;
    const mismatch = Boolean(data._line_items_total_mismatch);
    const printed =
        parseNumber(data.total_amount) ?? parseNumber(data.grand_total);
    const warnings: string[] = [];
    if (mismatch) {
        warnings.push(
            printed != null
                ? `Line sum differs from printed total (${currency} ${printed}). Chart uses line amounts; trust printed total for the invoice.`
                : 'Line item arithmetic looks inconsistent — reprocess recommended.'
        );
    }

    return {
        id: `fin_lines_${doc.documentId}_${Date.now()}`,
        agentId: FINANCE_AGENT,
        kind: 'bar',
        title: `Invoice line items`,
        subtitle: `${shortName} · ${vendor} · ${rows.length} item(s) · ${currency}`,
        currency,
        categoryKey: 'item',
        series: [{ key: 'amount', label: `Line total (${currency})`, color: '#2563eb' }],
        data: rows.map((r) => ({
            item: truncateLabel(r.description),
            amount: Math.round(r.total * 100) / 100,
            quantity: r.quantity,
            unit_price: Math.round(r.unitPrice * 100) / 100,
            _documentIds: doc.documentId,
        })),
        sourceDocumentIds: [doc.documentId],
        dataQuality: {
            level: mismatch ? 'medium' : 'high',
            warnings: warnings.length ? warnings : undefined,
        },
        actions: mismatch
            ? [
                  {
                      label: 'Reprocess invoice',
                      kind: 'reprocess' as const,
                      documentId: doc.documentId,
                  },
                  {
                      label: 'Open document',
                      kind: 'open_document' as const,
                      documentId: doc.documentId,
                  },
              ]
            : [
                  {
                      label: 'Open document',
                      kind: 'open_document' as const,
                      documentId: doc.documentId,
                  },
              ],
        footer: mismatch
            ? `Data quality: medium · ${warnings[0]} · File: ${shortName}`
            : `Qty & unit price from extraction · ${rows.length} line(s) · File: ${shortName} · ${vendor}`,
    };
}

export async function loadFinanceDocsForAnalytics(
    user: AuthUser,
    options: LoadFinanceOptions = {}
): Promise<
    Array<{
        documentId: string;
        originalFilename: string;
        pythonDocumentId?: string | null;
        organizationId?: string | null;
        metadata?: unknown;
    }>
> {
    const maxDocs = options.maxDocs ?? 50;
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, options.documentIds);
    return Document.find(query)
        .select('documentId originalFilename pythonDocumentId organizationId metadata')
        .sort({ createdAt: -1 })
        .limit(maxDocs)
        .lean();
}

export async function resolveFinanceDocumentIdsFromQuestion(
    user: AuthUser,
    question: string,
    options?: string[] | { preferIds?: string[]; seedIds?: string[] }
): Promise<string[] | undefined> {
    // Back-compat: third arg used to be seedIds: string[]
    const opts = Array.isArray(options) ? { seedIds: options } : options || {};
    if (opts.seedIds?.length) return opts.seedIds;

    const tokens = extractDocumentNameTokens(question);
    if (!tokens.length) return undefined;

    const filter = await buildDocumentFilter(user, {});
    const prefer = (opts.preferIds || []).filter(Boolean);

    // Prefer matching inside chat scope first (only the named file in selection)
    if (prefer.length) {
        const scopedDocs = await Document.find(buildFinanceScopeQuery(filter, prefer))
            .select('documentId originalFilename')
            .lean();
        const hit = matchDocumentIdsByNameTokens(
            scopedDocs.map((d) => ({
                documentId: d.documentId,
                originalFilename: d.originalFilename,
                searchText: enrichSearchTextForDoc(d.originalFilename),
            })),
            question
        );
        if (hit.length) return hit.slice(0, 1);
    }

    const docs = await Document.find(buildFinanceScopeQuery(filter))
        .select('documentId originalFilename')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();

    const hit = matchDocumentIdsByNameTokens(
        docs.map((d) => ({
            documentId: d.documentId,
            originalFilename: d.originalFilename,
            searchText: enrichSearchTextForDoc(d.originalFilename),
        })),
        question
    );
    if (!hit.length) return undefined;
    return hit.slice(0, 1);
}

export async function executeLineItemAnalytics(
    user: AuthUser,
    loadOpts: LoadFinanceOptions = {}
): Promise<{
    visuals: ChatVisualSpec[];
    citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }>;
    answer: string;
    documentCount: number;
    coverage?: import('../types/chatVisuals').FinanceAnalyticsCoverage;
}> {
    const docs = await loadFinanceDocsForAnalytics(user, loadOpts);
    const docsInScope = docs.length;

    if (!docs.length) {
        return {
            visuals: [],
            citations: [],
            documentCount: 0,
            answer:
                'No invoice documents in scope. Select the invoice in chat scope or mention its filename (e.g. digilog) in your message.',
        };
    }

    const visuals: ChatVisualSpec[] = [];
    const citations: Array<{
        documentId: string;
        filename: string;
        documentType: string;
        phase3Agent: string;
    }> = [];
    const answerParts: string[] = ['Here are the line items from your scoped documents (from extraction):', ''];

    for (const doc of docs) {
        const data = await extractionPayloadForDoc(doc, user);
        const visual = buildLineItemsVisual(doc, data);
        const rows = extractLineItemRows(data);
        const currency = (scalarField(data.currency) || 'PKR').toUpperCase().slice(0, 3);
        const printedTotal =
            parseNumber(data.total_amount) ?? parseNumber(data.grand_total);
        const mismatch = Boolean(data._line_items_total_mismatch);

        citations.push({
            documentId: doc.documentId,
            filename: doc.originalFilename,
            documentType: 'invoice',
            phase3Agent: FINANCE_AGENT,
        });

        if (rows.length) {
            if (visual) visuals.push(visual);
            answerParts.push(`### ${doc.originalFilename}`);
            answerParts.push('| Item | Qty | Unit price | Line total |');
            answerParts.push('| --- | ---: | ---: | ---: |');
            for (const r of rows) {
                answerParts.push(
                    `| ${r.description.replace(/\|/g, '/')} | ${r.quantity} | ${currency} ${Math.round(r.unitPrice * 100) / 100} | ${currency} ${Math.round(r.total * 100) / 100} |`
                );
            }
            const sub =
                parseNumber(data.subtotal) ??
                rows.reduce((s, r) => s + r.total, 0);
            answerParts.push('');
            answerParts.push(
                `Lines sum: **${currency} ${Math.round(Number(sub) * 100) / 100}**`
            );
            if (printedTotal != null) {
                answerParts.push(
                    `Invoice total (printed): **${currency} ${Math.round(printedTotal * 100) / 100}**`
                );
            }
            if (mismatch) {
                answerParts.push(
                    `_Note: line-item qty/rate may still be wrong in storage — printed invoice total is preferred. Open the document → **Reclassify with AI** after restarting ai-backend to re-extract._`
                );
            }
            answerParts.push('');
        } else {
            answerParts.push(`- **${doc.originalFilename}** — no \`line_items\` in extraction yet (reprocess as invoice).`);
        }
    }

    const records = await loadFinanceRecords(user, loadOpts);
    const fileReport = await buildFinanceFileCoverage(user, records, loadOpts);
    const coverage = computeFinanceCoverage(records, docsInScope, fileReport);

    if (!visuals.length) {
        answerParts.push('');
        answerParts.push(
            'No line-item arrays found. Open each document → reprocess with **Finance Agent** / invoice type so `line_items` are extracted.'
        );
    } else {
        answerParts.push('Charts in the analytics panel show **quantity** and **line total** per item.');
    }

    return {
        visuals,
        citations,
        documentCount: new Set(visuals.map((v) => v.id.split('_')[2])).size || docs.length,
        coverage,
        answer: answerParts.join('\n'),
    };
}

export async function countFinanceDocumentsInScope(
    user: AuthUser,
    documentIds?: string[]
): Promise<number> {
    const filter = await buildDocumentFilter(user, {});
    const query = buildFinanceScopeQuery(filter, documentIds);
    return Document.countDocuments(query);
}
