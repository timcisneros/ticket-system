#!/usr/bin/env node
// RenamePath Conflict Fix Regression Test
// Verifies the carve-out in findConflictingMutation allows valid
// writeFile->renamePath and createFolder->renamePath sequences
// while preserving all other conflict protections.

const fs = require('fs');
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

function assertIsUndefined(value, msg) {
  if (value !== undefined) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: undefined\n  actual:   ${JSON.stringify(value)}`);
  }
}

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

function makeSandbox() {
  const sandbox = { __operationHistory: [] };
  sandbox.readOperationHistory = () => sandbox.__operationHistory || [];
  return sandbox;
}

function installInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
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

function main() {
  const code = loadServerCode();

  // Verify carve-out code is present in source
  const hasCarveOut = code.includes("operation === 'renamePath'") &&
    code.includes("['writeFile', 'createFolder'].includes(h.operation)");
  assert(hasCarveOut, 'findConflictingMutation should contain the renamePath carve-out');

  const conflictCode = extractFunction(code, 'findConflictingMutation');
  assert(conflictCode, 'findConflictingMutation should exist');

  const pathFingerprintCode = extractFunction(code, 'computePathFingerprint');
  assert(pathFingerprintCode, 'computePathFingerprint should exist');

  const fingerprintCode = extractFunction(code, 'computeMutationFingerprint');
  assert(fingerprintCode, 'computeMutationFingerprint should exist');

  const sandbox = makeSandbox();
  installInSandbox(fingerprintCode + '\n' + pathFingerprintCode + '\n' + conflictCode, sandbox);

  // ── Test 1: writeFile -> renamePath (same source) should NOT conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'writeFile', args: { path: 'source.txt' }, id: 'hist-1' }
  ];
  const wfToRename = sandbox.findConflictingMutation(1, 'renamePath', { path: 'source.txt', nextPath: 'final.txt' });
  assertIsUndefined(wfToRename, 'writeFile -> renamePath should NOT be a conflict');
  console.log('  ✓ writeFile -> renamePath: no conflict');

  // ── Test 2: createFolder -> renamePath (same source) should NOT conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'createFolder', args: { path: 'source-dir' }, id: 'hist-2' }
  ];
  const cfToRename = sandbox.findConflictingMutation(1, 'renamePath', { path: 'source-dir', nextPath: 'final-dir' });
  assertIsUndefined(cfToRename, 'createFolder -> renamePath should NOT be a conflict');
  console.log('  ✓ createFolder -> renamePath: no conflict');

  // ── Test 3: writeFile -> deletePath (same path) should STILL conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'writeFile', args: { path: 'a.txt' }, id: 'hist-3' }
  ];
  const wfToDelete = sandbox.findConflictingMutation(1, 'deletePath', { path: 'a.txt' });
  assert(wfToDelete, 'writeFile -> deletePath should STILL be a conflict');
  assertEqual(wfToDelete.id, 'hist-3', 'writeFile -> deletePath should return the conflicting record');
  console.log('  ✓ writeFile -> deletePath: still blocked');

  // ── Test 4: createFolder -> writeFile (same path) should STILL conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'createFolder', args: { path: 'foo' }, id: 'hist-4' }
  ];
  const cfToWrite = sandbox.findConflictingMutation(1, 'writeFile', { path: 'foo' });
  assert(cfToWrite, 'createFolder -> writeFile should STILL be a conflict');
  assertEqual(cfToWrite.id, 'hist-4', 'createFolder -> writeFile should return the conflicting record');
  console.log('  ✓ createFolder -> writeFile: still blocked');

  // ── Test 5: renamePath(source->a) -> renamePath(source->b) should STILL conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'renamePath', args: { path: 'source.txt', nextPath: 'dest-a.txt' }, id: 'hist-5' }
  ];
  const renameToRename = sandbox.findConflictingMutation(1, 'renamePath', { path: 'source.txt', nextPath: 'dest-b.txt' });
  assert(renameToRename, 'renamePath -> renamePath on same source should STILL be a conflict');
  assertEqual(renameToRename.id, 'hist-5', 'renamePath -> renamePath should return the conflicting record');
  console.log('  ✓ renamePath(source->a) -> renamePath(source->b): still blocked');

  // ── Test 6: renamePath -> writeFile on DESTINATION should NOT conflict ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'renamePath', args: { path: 'source.txt', nextPath: 'dest.txt' }, id: 'hist-6' }
  ];
  const renameToWriteDest = sandbox.findConflictingMutation(1, 'writeFile', { path: 'dest.txt' });
  assertIsUndefined(renameToWriteDest, 'renamePath -> writeFile on destination should NOT be a conflict');
  console.log('  ✓ renamePath -> writeFile(destination): no conflict');

  // ── Test 7: Dedup still works (identical renamePath) ──
  sandbox.__operationHistory = [
    { runId: 1, operation: 'renamePath', args: { path: 'a.txt', nextPath: 'b.txt' }, id: 'hist-7' }
  ];
  const renameDedup = sandbox.findConflictingMutation(1, 'renamePath', { path: 'a.txt', nextPath: 'b.txt' });
  assertIsUndefined(renameDedup, 'identical renamePath should NOT be a conflict (dedup)');
  console.log('  ✓ identical renamePath: no conflict (dedup preserved)');

  console.log('\nAll renamePath conflict fix assertions passed.\n');
}

main();
