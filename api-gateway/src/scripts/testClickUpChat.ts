/**
 * ClickUp chat query fixtures (no HTTP).
 * Run: npx tsx --tsconfig tsconfig.json src/scripts/testClickUpChat.ts
 */
import {
    detectClickUpTaskAsk,
    formatClickUpAssignees,
    parseClickUpTaskFromDoc,
} from '../services/clickupChatActionService';

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

check('detect: what are clickup tasks', () => {
    assert(detectClickUpTaskAsk('check what are clickup task'), 'detect');
    assert(detectClickUpTaskAsk('Show ClickUp tasks and assignees'), 'detect2');
});

check('detect: negative generic HR', () => {
    assert(!detectClickUpTaskAsk('Generate offer letter for Ali'), 'no false positive');
});

check('format assignees array', () => {
    const s = formatClickUpAssignees([
        { username: 'Ahmed', email: 'a@test.com' },
        { username: 'Sara' },
    ]);
    assert(s.includes('Ahmed') && s.includes('Sara'), s);
});

check('parse task from doc metadata', () => {
    const row = parseClickUpTaskFromDoc({
        documentId: 'doc_1',
        originalFilename: 'Fix login bug.json',
        metadata: {
            source: 'clickup',
            ingestKind: 'structured_record',
            structuredData: {
                taskId: 'abc123',
                name: 'Fix login bug',
                status: 'in progress',
                assignees: [{ username: 'Dev', email: 'dev@co.com' }],
                due_date: 1735689600000,
                list: { name: 'Engineering' },
            },
            integrationExternalRef: { clickupTaskId: 'abc123' },
        },
    });
    assert(row?.name === 'Fix login bug', 'name');
    assert(Boolean(row?.assignees?.includes('Dev')), 'assignee');
    assert(row?.listName === 'Engineering', 'list');
});

console.log(`\n${passed} checks passed`);
