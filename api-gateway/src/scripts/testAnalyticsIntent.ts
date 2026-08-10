/**
 * Golden-ish intent phrase checks (no DB).
 * Run: npm run test:analytics-intent
 */
import { detectFinanceVisualIntent, wantsVisualization } from '../services/financeChatVisualService';
import {
    questionRefersToSpecificDocument,
    extractDocumentNameTokens,
} from '../services/financeAnalyticsService';

function assert(cond: boolean, msg: string) {
    if (!cond) throw new Error(msg);
}

let passed = 0;
function check(name: string, fn: () => void) {
    try {
        fn();
        passed += 1;
        console.log(`✓ ${name}`);
    } catch (e: any) {
        console.error(`✗ ${name}: ${e?.message || e}`);
        process.exitCode = 1;
    }
}

check('wantsVisualization: chart of digilog', () => {
    assert(wantsVisualization('chart of digilog'), 'expected true');
});

check('wantsVisualization: short me chart of glectronic full', () => {
    assert(wantsVisualization('short me chart of glectronic full'), 'expected true');
});

check('vendor totals intent', () => {
    const i = detectFinanceVisualIntent('vendor totals for scoped invoices', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 3,
    });
    assert(i === 'vendor_spend' || i === 'overview', `got ${i}`);
});

check('aging intent', () => {
    const i = detectFinanceVisualIntent('show aging', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 2,
    });
    assert(i === 'aging' || i === 'overview', `got ${i}`);
});

check('line items intent', () => {
    const i = detectFinanceVisualIntent('show items list and chart', 'finance_agent', {
        hasScopedFinanceDocuments: true,
        scopedFinanceDocCount: 1,
    });
    assert(i === 'line_items', `got ${i}`);
});

check('deictic + name tokens', () => {
    assert(questionRefersToSpecificDocument('give me chart of that'), 'deictic');
    assert(extractDocumentNameTokens('chart of digilog').includes('digilog'), 'digilog token');
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) process.exit(1);
