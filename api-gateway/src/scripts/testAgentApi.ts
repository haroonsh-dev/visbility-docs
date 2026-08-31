/**
 * Unit checks for Agent API helpers (token, agent id, partner payload helpers).
 * Run: npm run test:agent-api
 */
import assert from 'assert';
import crypto from 'crypto';
import {
    agentApiTtlHours,
    computeAgentApiExpiresAt,
    normalizeAgentApiAgentId,
} from '../services/agentApiDocumentService';

function generateAgentApiKey(): string {
    return `vdag_${crypto.randomBytes(24).toString('hex')}`;
}

function maskToken(token: string): string {
    const t = String(token || '');
    if (t.length < 12) return '••••';
    return `${t.slice(0, 6)}****${t.slice(-4)}`;
}

const key = generateAgentApiKey();
assert.ok(key.startsWith('vdag_'), 'key prefix');
assert.ok(key.length > 20, 'key length');
const masked = maskToken(key);
assert.ok(masked.includes('****'), 'masked');
assert.ok(!masked.includes(key.slice(10, 20)), 'secret not in mask');

const allowed = ['compliance_agent', 'hr_agent', 'finance_agent'];
assert.strictEqual(normalizeAgentApiAgentId('compliance', allowed), 'compliance_agent');
assert.strictEqual(normalizeAgentApiAgentId('hr_agent', allowed), 'hr_agent');
assert.strictEqual(normalizeAgentApiAgentId('HR-Agent', allowed), 'hr_agent');
assert.strictEqual(normalizeAgentApiAgentId('legal', allowed), 'legal');

assert.ok(agentApiTtlHours() > 0, 'ttl hours');
const expires = computeAgentApiExpiresAt(new Date('2026-01-01T00:00:00.000Z'));
assert.ok(expires.getTime() > Date.parse('2026-01-01T00:00:00.000Z'), 'expires after now');

console.log('OK agent API token + process/ephemeral helper checks passed');
