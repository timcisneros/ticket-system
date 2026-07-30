#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BROWSER_OPERATIONS,
  WORKSPACE_OPERATIONS,
  buildBrowserConsequences,
  deriveOperationFamilyCounts,
  summarizeTypedOperationConsequences
} = require('../runtime/typed-evidence-projection');

const ROOT = path.resolve(__dirname, '..');
const screenshotHash = 'a'.repeat(64);

function browserReceipt(overrides = {}) {
  return {
    id: 41,
    operationKey: 'browser-operation:stable-screenshot',
    operation: 'screenshot',
    outcome: 'succeeded',
    targetId: 'browser:research',
    targetKind: 'browser',
    metadata: {
      artifactPath: 'browser/run-7/step-2-1.png',
      bytes: 321,
      sha256: screenshotHash,
      pageStateHash: 'page-state-hash',
      unrestrictedPageContent: 'must not project',
      credentials: 'must not project'
    },
    partial: false,
    truncated: false,
    rawScreenshotBytes: 'must not project',
    selector: '#private',
    sessionState: { cookie: 'secret' },
    ...overrides
  };
}

const screenshot = browserReceipt();
const navigate = browserReceipt({
  id: 40,
  operationKey: 'browser-operation:stable-navigate',
  operation: 'navigate',
  metadata: {
    requestedUrl: 'https://user:pass@example.test/private?token=secret',
    finalUrl: 'https://example.test/private',
    status: 200,
    pageStateHash: 'navigate-page-state'
  },
  partial: false,
  truncated: false
});
const first = buildBrowserConsequences([screenshot, navigate]);
const replay = buildBrowserConsequences([navigate, screenshot]);
assert.deepEqual(replay, first, 'browser consequence ordering must be deterministic');
assert.deepEqual(first.map(item => item.operation), ['navigate', 'screenshot']);
assert.deepEqual(first[1].artifact, {
  id: 'browser/run-7/step-2-1.png',
  kind: 'screenshot',
  byteCount: 321,
  sha256: screenshotHash
});
assert.equal(first[1].evidence.receiptId, 'operation:41');
assert.equal(first[1].targetId, 'browser:research');

const serialized = JSON.stringify(first);
for (const forbidden of [
  'must not project',
  'user:pass',
  'token=secret',
  '#private',
  '"cookie"',
  'rawScreenshotBytes',
  'unrestrictedPageContent'
]) {
  assert.equal(serialized.includes(forbidden), false, `browser projection leaked ${forbidden}`);
}

assert.deepEqual(
  buildBrowserConsequences([screenshot, { ...screenshot }]),
  buildBrowserConsequences([screenshot]),
  'an exact duplicate receipt reference must be removed deterministically'
);
assert.throws(
  () => buildBrowserConsequences([
    screenshot,
    { ...screenshot, outcome: 'failed' }
  ]),
  error => error && error.code === 'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
  'contradictory durable browser receipts must fail closed'
);
assert.throws(
  () => buildBrowserConsequences([
    {
      ...screenshot,
      receipt: {
        operation: 'navigate',
        targetId: screenshot.targetId,
        outcome: screenshot.outcome
      }
    }
  ]),
  error => error && error.code === 'BROWSER_CONSEQUENCE_RECEIPT_CONFLICT',
  'a browser receipt that contradicts its durable envelope must fail closed'
);

const counts = deriveOperationFamilyCounts([
  { operation: 'readFile', targetKind: 'localWorkspace', outcome: 'succeeded' },
  { operation: 'writeFile', targetKind: 'localWorkspace', outcome: 'succeeded' },
  navigate,
  screenshot,
  { operation: 'runProcess', targetKind: 'process', outcome: 'succeeded' }
]);
assert.deepEqual(counts, {
  workspaceOperations: 2,
  workspaceMutations: 1,
  browserOperations: 2,
  processOperations: 1
});

const browserSummary = summarizeTypedOperationConsequences({
  browserOperations: first
});
assert.match(browserSummary.lines.join('\n'), /Browser operations \(2\):/);
assert.doesNotMatch(browserSummary.lines.join('\n'), /workspace mutation/i);
const processSummary = summarizeTypedOperationConsequences({
  processOperations: [{
    profileId: 'syntax-check',
    terminalOutcome: 'completed'
  }]
});
assert.match(processSummary.lines.join('\n'), /Process operations \(1\): syntax-check completed/);

assert.deepEqual(BROWSER_OPERATIONS, ['navigate', 'observe', 'readPageText', 'screenshot', 'wait']);
assert.deepEqual(WORKSPACE_OPERATIONS, [
  'listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath'
]);
const productionSources = [
  fs.readFileSync(path.join(ROOT, 'runtime', 'typed-evidence-projection.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
].join('\n');
assert.equal(
  fs.readFileSync(path.join(ROOT, 'runtime', 'typed-evidence-projection.js'), 'utf8')
    .includes('localeCompare'),
  false,
  'typed receipt ordering must not depend on the host locale'
);
// `target.read` is an established timeline event label in two places, not a
// dispatch operation. Pin that historical count and forbid any new generic
// write/execute vocabulary.
assert.equal((productionSources.match(/type: 'target\.read'/g) || []).length, 2,
  'the two historical target.read timeline labels must remain terminology only');
for (const forbiddenOperation of ['target.write', 'target.execute']) {
  assert.equal(productionSources.includes(forbiddenOperation), false,
    `universal operation ${forbiddenOperation} must not be introduced`);
}
assert.equal(
  fs.readFileSync(path.join(ROOT, 'runtime', 'typed-evidence-projection.js'), 'utf8').includes('target.read'),
  false,
  'the new projection helper must not introduce a generic target operation'
);
for (const rejectedPath of [
  'runtime/target-contract.js',
  'runtime/target-registry.js'
]) {
  assert.equal(fs.existsSync(path.join(ROOT, rejectedPath)), false,
    `${rejectedPath} must remain absent`);
}
assert.equal(
  fs.readdirSync(path.join(ROOT, 'persistence', 'postgres', 'migrations'))
    .some(name => /typed|work_definition|target_contract/i.test(name)),
  false,
  'projection parity must not add a database migration'
);

console.log('PASS: typed evidence projection parity');
