#!/usr/bin/env node
// Execution Semantics Test — verifies resume/retry/reassess/commit boundaries.
//
// Scenarios:
// 1. Resume deduplication: committed mutations are skipped on resume
// 2. Retry no hidden context: default rerun does not inject priorFailureContext
// 3. Reassess explicit evidence: reassess mode injects priorFailureContext
// 4. Commit idempotency: same fingerprint skips, returns prior result
// 5. Conflicting mutation rejection: different operation on same path fails
// 6. Stable fingerprint: computeMutationFingerprint is deterministic

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

// Load server.js as text and extract functions for isolated testing
function loadServerCode() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function extractFunction(code, name) {
  const pattern = new RegExp(`function ${name}\\b[^{]*\\{`);
  const match = code.match(pattern);
  if (!match) return null;
  const start = match.index;
  let depth = 0;
  let i = start + match[0].length - 1;
  while (i < code.length) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
    if (depth === 0) break;
  }
  return code.slice(start, i);
}

// Provide minimal globals the extracted functions may reference
const mockGlobals = {
  __operationHistory: []
};

function makeSandbox() {
  const sandbox = { __operationHistory: [] };
  sandbox.readOperationHistory = () => sandbox.__operationHistory || [];
  return sandbox;
}

function evalInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  // Wrap in parens to turn declaration into expression, then invoke to get the function object
  const fn = new Function(...keys, `return (${fnCode})`);
  return fn(...values);
}

function installInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  // Execute the function declaration in sandbox scope so it binds to sandbox globals
  const wrapper = new Function(...keys, fnCode + `
    const result = {};
    if (typeof computeMutationFingerprint !== 'undefined') result.computeMutationFingerprint = computeMutationFingerprint;
    if (typeof computePathFingerprint !== 'undefined') result.computePathFingerprint = computePathFingerprint;
    if (typeof findCommittedMutation !== 'undefined') result.findCommittedMutation = findCommittedMutation;
    if (typeof findConflictingMutation !== 'undefined') result.findConflictingMutation = findConflictingMutation;
    return result;
  `);
  const result = wrapper(...values);
  Object.assign(sandbox, result);
}

// ── Test 1: Resume deduplication ────────────────────────────────
function testResumeDeduplication() {
  const code = loadServerCode();

  // Verify findCommittedMutation is called for all four mutating operations
  const hasFindCommitted = code.includes('findCommittedMutation(run.id, operation, args)');
  assert(hasFindCommitted, 'findCommittedMutation should be called in executeWorkspaceOperation');

  // Verify skip behavior exists for writeFile
  const writeFileSkip = code.includes('Skipped writeFile on') && code.includes('already committed in run ledger');
  assert(writeFileSkip, 'writeFile should skip when already committed');

  // Verify skip behavior exists for createFolder
  const createFolderSkip = code.includes('Skipped createFolder on') && code.includes('already committed in run ledger');
  assert(createFolderSkip, 'createFolder should skip when already committed');

  // Verify skip behavior exists for renamePath
  const renamePathSkip = code.includes('Skipped renamePath from') && code.includes('already committed in run ledger');
  assert(renamePathSkip, 'renamePath should skip when already committed');

  // Verify skip behavior exists for deletePath
  const deletePathSkip = code.includes('Skipped deletePath on') && code.includes('already committed in run ledger');
  assert(deletePathSkip, 'deletePath should skip when already committed');

  console.log('  ✓ resume-deduplication: all mutating operations skip committed duplicates');
}

// ── Test 2: Retry no hidden context ─────────────────────────────
function testRetryNoHiddenContext() {
  const code = loadServerCode();

  // Verify buildAgentPrompt signature accepts rerunMode
  const promptSig = code.match(/function buildAgentPrompt\([^)]*\)/);
  assert(promptSig, 'buildAgentPrompt should exist');
  assert(promptSig[0].includes('rerunMode'), 'buildAgentPrompt should accept rerunMode parameter');

  // Verify priorFailureContext is gated on rerunMode === 'reassess'
  const gatedContext = code.includes("rerunMode === 'reassess'") &&
    code.includes('buildPriorFailureContext');
  assert(gatedContext, 'priorFailureContext should only be injected when rerunMode is reassess');

  // Verify rerun endpoint defaults to retry
  const rerunEndpoint = code.match(/rerunTicketFromBeginning\(ticketId, changedBy\)/);
  const rerunWithMode = code.match(/rerunTicketFromBeginning\(ticketId, changedBy, mode\)/);
  assert(rerunWithMode, 'rerun endpoint should pass mode to rerunTicketFromBeginning');

  // Verify mode defaults to retry
  const modeDefault = code.includes("mode = 'retry'");
  assert(modeDefault, 'rerun mode should default to retry');

  console.log('  ✓ retry-no-hidden-context: default rerun does not inject failure context');
}

// ── Test 3: Reassess explicit evidence ──────────────────────────
function testReassessExplicitEvidence() {
  const code = loadServerCode();

  // Verify reassess mode is accepted
  const modeCheck = code.includes("mode === 'reassess'");
  assert(modeCheck, 'rerun endpoint should accept reassess mode');

  // Verify rerunMode is stored on ticket and copied to run
  const ticketMode = code.includes('ticket.rerunMode = rerunMode') || code.includes('ticket.rerunMode');
  assert(ticketMode, 'rerunMode should be stored on ticket');

  const runMode = code.includes('rerunMode: ticket.rerunMode');
  assert(runMode, 'rerunMode should be copied from ticket to run');

  // Verify buildPriorFailureContext fields are meaningful
  const failureContextFields = [
    'priorRunId',
    'status',
    'reason',
    'lastAction',
    'mutations',
    'inspectedFiles'
  ];
  const buildContextFn = extractFunction(code, 'buildPriorFailureContext');
  assert(buildContextFn, 'buildPriorFailureContext should exist');
  for (const field of failureContextFields) {
    assert(buildContextFn.includes(field), `buildPriorFailureContext should include ${field}`);
  }

  console.log('  ✓ reassess-explicit-evidence: reassess mode injects structured failure context');
}

// ── Test 4: Commit idempotency ────────────────────────────────────
function testCommitIdempotency() {
  const code = loadServerCode();

  // Extract and test computeMutationFingerprint
  const fingerprintCode = extractFunction(code, 'computeMutationFingerprint');
  assert(fingerprintCode, 'computeMutationFingerprint should exist');

  const sandbox = makeSandbox();
  const findCommittedCode = extractFunction(code, 'findCommittedMutation');
  assert(findCommittedCode, 'findCommittedMutation should exist');
  installInSandbox(fingerprintCode + '\n' + findCommittedCode + '\n' + extractFunction(code, 'computePathFingerprint'), sandbox);
  const fingerprint = sandbox.computeMutationFingerprint;

  assertEqual(fingerprint('writeFile', { path: 'a.txt' }), 'writeFile:a.txt', 'writeFile fingerprint');
  assertEqual(fingerprint('createFolder', { path: 'dir' }), 'createFolder:dir', 'createFolder fingerprint');
  assertEqual(fingerprint('renamePath', { path: 'a.txt', nextPath: 'b.txt' }), 'renamePath:a.txt->b.txt', 'renamePath fingerprint');
  assertEqual(fingerprint('deletePath', { path: 'a.txt' }), 'deletePath:a.txt', 'deletePath fingerprint');
  assertEqual(fingerprint('readFile', { path: 'a.txt' }), null, 'readFile fingerprint should be null');

  // Test findCommittedMutation behavior with mock history
  sandbox.__operationHistory = [
    { runId: 1, operation: 'writeFile', args: { path: 'a.txt' }, id: 'hist-1', result: { path: 'a.txt' } }
  ];

  const committed = sandbox.findCommittedMutation(1, 'writeFile', { path: 'a.txt' });
  assert(committed, 'findCommittedMutation should find exact match');
  assertEqual(committed.id, 'hist-1', 'findCommittedMutation should return correct history record');

  const notCommitted = sandbox.findCommittedMutation(1, 'writeFile', { path: 'b.txt' });
  assertEqual(notCommitted, undefined, 'findCommittedMutation should not match different args');

  const differentRun = sandbox.findCommittedMutation(2, 'writeFile', { path: 'a.txt' });
  assertEqual(differentRun, undefined, 'findCommittedMutation should not match different runId');

  console.log('  ✓ commit-idempotency: fingerprint-based deduplication works for all operations');
}

// ── Test 5: Conflicting mutation rejection ────────────────────────
function testConflictingMutationRejection() {
  const code = loadServerCode();

  // Extract findConflictingMutation
  const conflictCode = extractFunction(code, 'findConflictingMutation');
  assert(conflictCode, 'findConflictingMutation should exist');

  // Extract computePathFingerprint
  const pathFingerprintCode = extractFunction(code, 'computePathFingerprint');
  assert(pathFingerprintCode, 'computePathFingerprint should exist');

  const fingerprintCode = extractFunction(code, 'computeMutationFingerprint');
  assert(fingerprintCode, 'computeMutationFingerprint should exist');

  const sandbox = makeSandbox();
  installInSandbox(fingerprintCode + '\n' + pathFingerprintCode + '\n' + conflictCode, sandbox);

  sandbox.__operationHistory = [
    { runId: 1, operation: 'writeFile', args: { path: 'a.txt' }, id: 'hist-1' }
  ];

  const conflict = sandbox.findConflictingMutation(1, 'deletePath', { path: 'a.txt' });
  assert(conflict, 'findConflictingMutation should detect writeFile vs deletePath on same path');
  assertEqual(conflict.id, 'hist-1', 'findConflictingMutation should return the conflicting record');

  const noConflict = sandbox.findConflictingMutation(1, 'writeFile', { path: 'a.txt' });
  assertEqual(noConflict, undefined, 'findConflictingMutation should not flag identical operation as conflict');

  const differentPath = sandbox.findConflictingMutation(1, 'writeFile', { path: 'b.txt' });
  assertEqual(differentPath, undefined, 'findConflictingMutation should not flag different path as conflict');

  // Verify MUTATION_CONFLICT is thrown in executeWorkspaceOperation
  const hasConflictCheck = code.includes('findConflictingMutation(run.id, operation, args)') &&
    code.includes("'MUTATION_CONFLICT'");
  assert(hasConflictCheck, 'executeWorkspaceOperation should reject conflicting mutations with MUTATION_CONFLICT');

  console.log('  ✓ conflicting-mutation-rejection: same-path different-op is rejected');
}

// ── Test 6: Stable fingerprint ──────────────────────────────────
function testStableFingerprint() {
  const code = loadServerCode();

  const fingerprintCode = extractFunction(code, 'computeMutationFingerprint');
  assert(fingerprintCode, 'computeMutationFingerprint should exist');

  const sandbox = makeSandbox();
  installInSandbox(fingerprintCode, sandbox);
  const fingerprint = sandbox.computeMutationFingerprint;

  // Same inputs must produce same output every time
  const f1 = fingerprint('writeFile', { path: 'docs/report.md' });
  const f2 = fingerprint('writeFile', { path: 'docs/report.md' });
  assertEqual(f1, f2, 'fingerprint must be stable for identical inputs');

  // Different paths must produce different fingerprints
  const f3 = fingerprint('writeFile', { path: 'docs/other.md' });
  assert(f1 !== f3, 'fingerprint must differ for different paths');

  // renamePath must include both paths
  const r1 = fingerprint('renamePath', { path: 'a.md', nextPath: 'b.md' });
  const r2 = fingerprint('renamePath', { path: 'a.md', nextPath: 'c.md' });
  assert(r1 !== r2, 'renamePath fingerprint must differ for different nextPath');

  // Empty or non-mutating operations return null
  assertEqual(fingerprint('readFile', { path: 'a.md' }), null, 'readFile returns null');
  assertEqual(fingerprint('listDirectory', { path: '' }), null, 'listDirectory returns null');

  console.log('  ✓ stable-fingerprint: computeMutationFingerprint is deterministic and discriminating');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Execution Semantics Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testResumeDeduplication,
    testRetryNoHiddenContext,
    testReassessExplicitEvidence,
    testCommitIdempotency,
    testConflictingMutationRejection,
    testStableFingerprint
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${test.name}: ${err.message}`);
    }
  }

  console.log('='.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
