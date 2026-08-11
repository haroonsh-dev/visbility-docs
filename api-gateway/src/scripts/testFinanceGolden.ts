/**
 * Golden extraction fixtures (no DB / no AI).
 * Run: npm run test:finance-golden
 */
import {
    buildFinanceRecordsFromExtraction,
    buildVendorSpendVisual,
    findDuplicateInvoiceWarnings,
    dedupeFinanceRecords,
    pairPurchaseOrdersWithInvoices,
    convertRecordsToBase,
    type FinanceRecord,
} from '../services/financeAnalyticsService';
import { canonicalizePartyName, partyRollupKey } from '../services/financePartyNormalize';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (e: unknown) {
        const err = e as { message?: string };
        console.error(`✗ ${name}: ${err?.message || e}`);
        process.exitCode = 1;
    }
}

check('canonicalize: M/s Digilog Pvt Ltd = DIGILOG', () => {
    const a = canonicalizePartyName('M/s Digilog Pvt. Ltd.');
    const b = canonicalizePartyName('DIGILOG');
    assert(a === b, `${a} !== ${b}`);
});

check('fixture: standard invoice → one row + total', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'd1', originalFilename: '246910_digilog_invoice.pdf' },
        {
            invoice_number: '246910',
            vendor_name: 'M/s Digilog Electronics Pvt. Ltd.',
            total_amount: 125_000,
            currency: 'PKR',
            customer_name: 'Metro Cash & Carry',
            invoice_date: '2024-06-15',
        }
    );
    assert(rows.length === 1, `rows=${rows.length}`);
    assert(rows[0].total === 125_000, `total=${rows[0].total}`);
    assert(/digilog/i.test(rows[0].vendor), rows[0].vendor);
    assert(rows[0].client.includes('Metro'), rows[0].client);
});

check('fixture: line items sum fallback when no invoice_number', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'd2', originalFilename: 'misc_bill.pdf' },
        {
            vendor_name: 'Acme Supplies',
            line_items: [
                { description: 'Widget', total: 50 },
                { description: 'Gadget', total: 75 },
            ],
            currency: 'USD',
        }
    );
    assert(rows.length >= 1, 'expected rows');
    const sum = rows.reduce((s, r) => s + r.total, 0);
    assert(sum === 125, `sum=${sum}`);
});

check('vendor chart merges alias vendor names', () => {
    const r1 = buildFinanceRecordsFromExtraction(
        { documentId: 'a', originalFilename: 'a.pdf' },
        {
            invoice_number: '1',
            vendor_name: 'DIGILOG',
            total_amount: 100,
            currency: 'PKR',
        }
    );
    const r2 = buildFinanceRecordsFromExtraction(
        { documentId: 'b', originalFilename: 'b.pdf' },
        {
            invoice_number: '2',
            vendor_name: 'M/s Digilog Pvt Ltd',
            total_amount: 200,
            currency: 'PKR',
        }
    );
    const viz = buildVendorSpendVisual([...r1, ...r2]);
    assert(viz.data.length === 1, `bars=${viz.data.length}`);
    assert(Number(viz.data[0].amount) === 300, `amount=${viz.data[0].amount}`);
});

check('duplicate warnings when same vendor amount date', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'x1', originalFilename: 'inv_a.pdf' },
            {
                invoice_number: 'A',
                vendor_name: 'Digilog',
                total_amount: 500,
                currency: 'PKR',
                invoice_date: '2024-01-10',
            }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'x2', originalFilename: 'inv_b.pdf' },
            {
                invoice_number: 'B',
                vendor_name: 'M/s Digilog Pvt Ltd',
                total_amount: 500,
                currency: 'PKR',
                invoice_date: '2024-01-10',
            }
        ),
    ];
    const w = findDuplicateInvoiceWarnings(rows);
    assert(w.length === 1, `warnings=${w.length}`);
});

check('org vendor alias merges glectronic → Digilog', () => {
    const aliases = { glectronic: 'Digilog' };
    const r1 = buildFinanceRecordsFromExtraction(
        { documentId: 'a', originalFilename: 'a.pdf' },
        {
            invoice_number: '1',
            vendor_name: 'glectronic',
            total_amount: 100,
            currency: 'PKR',
        },
        aliases
    );
    const r2 = buildFinanceRecordsFromExtraction(
        { documentId: 'b', originalFilename: 'b.pdf' },
        {
            invoice_number: '2',
            vendor_name: 'Digilog',
            total_amount: 200,
            currency: 'PKR',
        },
        aliases
    );
    assert(r1[0].vendor === 'Digilog', r1[0].vendor);
    const viz = buildVendorSpendVisual([...r1, ...r2], { vendorAliases: aliases });
    assert(viz.data.length === 1, `bars=${viz.data.length}`);
    assert(Number(viz.data[0].amount) === 300, `amount=${viz.data[0].amount}`);
});

check('partyRollupKey alias', () => {
    assert(
        partyRollupKey('Glectronic', { glectronic: 'Digilog' }) === canonicalizePartyName('Digilog'),
        'rollup'
    );
});

check('dedupe drops second copy with same invoice_number + vendor', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'd1', originalFilename: 'inv_a.pdf' },
            { invoice_number: 'INV-100', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR' }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'd2', originalFilename: 'inv_a_copy.pdf' },
            { invoice_number: 'INV-100', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR' }
        ),
    ];
    const { records, droppedDocumentIds } = dedupeFinanceRecords(rows);
    assert(records.length === 1, `kept=${records.length}`);
    assert(droppedDocumentIds.length === 1, `dropped=${droppedDocumentIds.length}`);
    assert(droppedDocumentIds[0] === 'd2', droppedDocumentIds[0]);
});

check('dedupe keeps distinct invoice numbers with same amount', () => {
    const rows = [
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'a', originalFilename: 'a.pdf' },
            { invoice_number: 'A1', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR', invoice_date: '2024-01-01' }
        ),
        ...buildFinanceRecordsFromExtraction(
            { documentId: 'b', originalFilename: 'b.pdf' },
            { invoice_number: 'A2', vendor_name: 'Digilog', total_amount: 500, currency: 'PKR', invoice_date: '2024-01-01' }
        ),
    ];
    const { records } = dedupeFinanceRecords(rows);
    assert(records.length === 2, `kept=${records.length}`);
});

check('PO pairing: matched when PO and invoice share po_number', () => {
    const poRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'po1', originalFilename: 'PO-500.pdf' },
        { po_number: 'PO-500', vendor_name: 'Digilog', total_amount: 1000, currency: 'PKR' }
    ).map((r) => ({ ...r, classification: 'purchase_order' }));
    const invRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'inv1', originalFilename: 'inv_500.pdf' },
        { invoice_number: 'INV-500', po_number: 'PO-500', vendor_name: 'Digilog', total_amount: 1000, currency: 'PKR' }
    ).map((r) => ({ ...r, classification: 'invoice' }));
    const pairs = pairPurchaseOrdersWithInvoices([...poRecord, ...invRecord]);
    assert(pairs.length === 1, `pairs=${pairs.length}`);
    assert(pairs[0].status === 'matched', `status=${pairs[0].status}`);
    assert(pairs[0].variance === 0, `variance=${pairs[0].variance}`);
});

check('spreadsheet: client name + spend amount columns', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet3', originalFilename: 'vendor_client_test_data.xlsx' },
        {
            rows: [
                { 'Client Name': 'Metro Cash & Carry', 'Vendor Name': 'Bata Pakistan', 'Spend Amount': 100000, Currency: 'PKR' },
                { 'Client Name': 'K-Mart', 'Vendor Name': 'Digilog Electronics', 'Spend Amount': 50000, Currency: 'PKR' },
                { 'Client Name': 'Hyperstar', 'Vendor Name': 'Bata Pakistan', 'Spend Amount': 75000, Currency: 'PKR' },
            ],
        }
    );
    assert(rows.length === 3, `rows=${rows.length}`);
    const clients = new Set(rows.map((r) => r.client));
    assert(clients.size === 3, `clients=${clients.size}`);
});

check('spreadsheet: parses markdown table rows into records', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet1', originalFilename: 'vendor_client_data.xlsx' },
        {
            _raw_text: [
                '## Sheet: Sales',
                '| Vendor | Customer | Amount | Date |',
                '| --- | --- | --- | --- |',
                '| Acme | Metro | 100 | 2024-01-05 |',
                '| Bata | K-Mart | 250 | 2024-01-06 |',
                '| Digilog | Metro | 75 | 2024-01-07 |',
            ].join('\n'),
        }
    );
    assert(rows.length === 3, `rows=${rows.length}`);
    const total = rows.reduce((s, r) => s + r.total, 0);
    assert(total === 425, `total=${total}`);
});

check('spreadsheet: uses table_extraction "tables" payload when present', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'sheet2', originalFilename: 'inv.csv' },
        {
            _tables: [
                {
                    headers: ['Vendor', 'Amount', 'Currency'],
                    rows: [
                        ['Acme', '500', 'USD'],
                        ['Bata', '1000', 'USD'],
                    ],
                },
            ],
        }
    );
    assert(rows.length === 2, `rows=${rows.length}`);
    assert(rows.every((r) => r.currency === 'USD'), 'currency');
});

check('client heuristic: parses "Bill To:" from raw_text', () => {
    const rows = buildFinanceRecordsFromExtraction(
        { documentId: 'inv3', originalFilename: 'invoice_x.pdf' },
        {
            invoice_number: '999',
            vendor_name: 'Digilog',
            total_amount: 500,
            currency: 'PKR',
            _raw_text: 'Invoice #999\nVendor: Digilog\nBill To: Metro Cash & Carry\nAmount Due 500',
        }
    );
    assert(rows.length === 1, `rows=${rows.length}`);
    assert(/metro/i.test(rows[0].client), `client=${rows[0].client}`);
});

check('FX conversion: USD → PKR via org rate', () => {
    const rows: FinanceRecord[] = [
        {
            documentId: 'a',
            filename: 'a.pdf',
            vendor: 'Acme',
            client: '',
            total: 100,
            currency: 'USD',
            invoiceDate: null,
            dueDate: null,
        },
        {
            documentId: 'b',
            filename: 'b.pdf',
            vendor: 'Digilog',
            client: '',
            total: 5000,
            currency: 'PKR',
            invoiceDate: null,
            dueDate: null,
        },
    ];
    const out = convertRecordsToBase(rows, { baseCurrency: 'PKR', fxRates: { USD: 280 } });
    assert(out.converted === 1, `converted=${out.converted}`);
    assert(out.records[0].currency === 'PKR', out.records[0].currency);
    assert(Math.round(out.records[0].total) === Math.round(100 / 280), `usd→pkr=${out.records[0].total}`);
});

check('FX conversion: no rate leaves record + reports unconverted', () => {
    const rows: FinanceRecord[] = [
        {
            documentId: 'a',
            filename: 'a.pdf',
            vendor: 'X',
            client: '',
            total: 100,
            currency: 'EUR',
            invoiceDate: null,
            dueDate: null,
        },
    ];
    const out = convertRecordsToBase(rows, { baseCurrency: 'PKR', fxRates: { USD: 280 } });
    assert(out.converted === 0, 'converted');
    assert(out.unconvertedCurrencies.includes('EUR'), 'EUR reported');
    assert(out.records[0].currency === 'EUR', 'kept EUR');
});

check('PO pairing: over-invoiced when invoice > PO', () => {
    const poRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'po2', originalFilename: 'PO-501.pdf' },
        { po_number: 'PO-501', vendor_name: 'Acme', total_amount: 1000, currency: 'USD' }
    ).map((r) => ({ ...r, classification: 'purchase_order' }));
    const invRecord: FinanceRecord[] = buildFinanceRecordsFromExtraction(
        { documentId: 'inv2', originalFilename: 'inv_501.pdf' },
        { invoice_number: 'INV-501', po_number: 'PO-501', vendor_name: 'Acme', total_amount: 1200, currency: 'USD' }
    ).map((r) => ({ ...r, classification: 'invoice' }));
    const pairs = pairPurchaseOrdersWithInvoices([...poRecord, ...invRecord]);
    assert(pairs[0].status === 'over_invoiced', `status=${pairs[0].status}`);
    assert(pairs[0].variance === 200, `variance=${pairs[0].variance}`);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
