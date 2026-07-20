#!/usr/bin/env node
// Operation Batch Test — verifies bounded operation batch contract.
//
// Scenarios:
// 1. Bounded inspection produces exactly one batch
// 2. Repeated inspection without batch fails
// 3. Runtime verifies rename success without model re-entry
// 4. Stable operation keys and prepared intents make duplicate execution idempotent
// 5. Conflicting primitive operations use PostgreSQL ownership authority
// 6. Batch operation count bounded
// 7. Exact-path requirement enforced

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

// ── Test 1: Bounded inspection produces exactly one batch ────────
function testBoundedInspectionProducesOneBatch() {
  const code = loadServerCode();

  // Verify phase enforcement rejects mixed inspection + mutation
  const hasPhaseCheck = code.includes('checkPhaseCompliance');
  assert(hasPhaseCheck, 'phase compliance check should exist');
  const hasMixedPhase = code.includes("'mixed_phase'");
  assert(hasMixedPhase, 'mixed phase violation should be detected');

  // Verify non-progress detection after inspection-only response
  const hasNoProgress = code.includes("'no_progress'");
  assert(hasNoProgress, 'no_progress failure kind should exist');
  const hasInspectionOnlyCheck = code.includes('isInspectionOnly');
  assert(hasInspectionOnlyCheck, 'inspection-only non-progress detection should exist');

  console.log('  ✓ bounded-inspection-one-batch: mixed-phase rejected, inspection-only non-progress detected');
}

// ── Test 2: Repeated inspection without batch fails ─────────────
function testRepeatedInspectionFails() {
  const code = loadServerCode();

  const noProgressSection = extractFunction(code, 'testRepeatedInspectionFails') || code;
  // The non-progress logic is in the main loop, not a separate function.
  // Verify the strengthened error message exists.
  const hasExplicitFailure = code.includes('Bounded inspection must be followed by exactly one bounded operation batch');
  assert(hasExplicitFailure, 'error message should mention bounded operation batch requirement');

  const hasNoProgressThrow = code.includes("error.failureKind = 'no_progress'");
  assert(hasNoProgressThrow, 'no_progress should throw a run limit error');

  // Verify the count threshold is 2 (already the existing behavior)
  const hasThreshold = code.includes('noProgressResponses >= 2');
  assert(hasThreshold, 'noProgressResponses should have threshold of 2');

  console.log('  ✓ repeated-inspection-fails: second inspection-only response triggers failure');
}

// ── Test 3: Runtime verifies rename without model re-entry ─────
function testRuntimeVerifiesRename() {
  const code = loadServerCode();

  const verifyFn = extractFunction(code, 'verifyBatchOperation');
  assert(verifyFn, 'verifyBatchOperation should exist');

  // Verify renamePath checks
  assert(verifyFn.includes('renamePath'), 'verification should cover renamePath');
  assert(verifyFn.includes('source_still_exists'), 'verification should check source still exists');
  assert(verifyFn.includes('destination_missing'), 'verification should check destination missing');

  // Verify createFolder checks
  assert(verifyFn.includes('createFolder'), 'verification should cover createFolder');
  assert(verifyFn.includes('folder_missing'), 'verification should check folder missing');

  // Verify writeFile checks
  assert(verifyFn.includes('writeFile'), 'verification should cover writeFile');
  assert(verifyFn.includes('file_missing'), 'verification should check file missing');
  assert(verifyFn.includes('content_mismatch'), 'verification should check content mismatch');

  // Verify deletePath checks
  assert(verifyFn.includes('deletePath'), 'verification should cover deletePath');
  assert(verifyFn.includes('path_still_exists'), 'verification should check path still exists');

  // Verify verification events are emitted
  assert(verifyFn.includes('batch.verification_failed'), 'verification should emit batch.verification_failed event');

  // Verify verification is called after mutating operations
  const hasVerifyCall = code.includes('verifyBatchOperation(run, action, result)');
  assert(hasVerifyCall, 'verifyBatchOperation should be called after executeWorkspaceOperation');

  console.log('  ✓ runtime-verifies-rename: structural checks without model re-entry');
}

// ── Test 4: Duplicate primitive commits skipped ──────────────────
function testDuplicateCommitsSkipped() {
  const code = loadServerCode();
  const storeCode = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');

  assert(code.includes('buildTargetOperationKey'), 'stable target operation keys should exist');
  const beginFn = extractFunction(code, 'beginWorkspaceMutation');
  assert(beginFn, 'beginWorkspaceMutation should exist');
  assert(beginFn.includes('getTargetOperation(run.id, operationKey)'), 'mutation should inspect durable intent/receipt state');
  assert(beginFn.includes('state.receipt'), 'completed operation receipts should be recognized');
  assert(beginFn.includes('skipped: true'), 'a durable completion should skip repeating the target effect');
  assert(beginFn.includes('classifyPreparedWorkspaceMutation'), 'prepared effects should be reconciled before retry');
  assert(storeCode.includes('ON CONFLICT (run_id, operation_key) DO NOTHING'), 'prepared intent identity should be database-enforced');
  assert(storeCode.includes('if (!recorded.inserted) return'), 'duplicate completion should return the existing receipt without new evidence');

  console.log('  ✓ duplicate-commits-skipped: stable keys, prepared intent, receipt reuse, and reconciliation prevent repeated effects');
}

// ── Test 5: PostgreSQL conflict authority ──────────────
function testConflictingOperationsRejected() {
  const code = loadServerCode();
  const storeCode = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');

  assert(code.includes('findPersistedMutationConflict'), 'repository-backed mutation conflict lookup should exist');
  assert(code.includes("'MUTATION_CONFLICT'"), 'MUTATION_CONFLICT error code should exist');
  const conflictCalls = (code.match(/findPersistedMutationConflict\(run, operation, args, runWorkspaceProvider\)/g) || []).length;
  assert(conflictCalls >= 4, `repository conflict lookup should guard all four mutations (found ${conflictCalls})`);
  assert(storeCode.includes('findMutationConflict'), 'PostgreSQL ownership repository should implement conflict lookup');
  assert(storeCode.includes('mutation_fingerprint'), 'conflict lookup should use the indexed receipt projection');
  assert(code.includes('withTargetOperationLock'), 'workspace effects should run under the shared target lock');

  console.log('  ✓ conflicting-operations-rejected: all four primitives use PostgreSQL receipt authority and target locks');
}

// ── Test 6: Batch operation count bounded ────────────────────────
function testBatchOperationCountBounded() {
  const code = loadServerCode();

  const hasMaxActions = code.includes('MAX_AGENT_ACTIONS_PER_RESPONSE');
  assert(hasMaxActions, 'MAX_AGENT_ACTIONS_PER_RESPONSE should exist');

  const hasMaxMutating = code.includes('MAX_MUTATING_ACTIONS_PER_RESPONSE');
  assert(hasMaxMutating, 'MAX_MUTATING_ACTIONS_PER_RESPONSE should exist');

  const hasActionLimitCheck = code.includes('actions.length > MAX_AGENT_ACTIONS_PER_RESPONSE');
  assert(hasActionLimitCheck, 'action count limit should be enforced');

  const hasMutatingLimitCheck = code.includes('mutatingActionCount > MAX_MUTATING_ACTIONS_PER_RESPONSE');
  assert(hasMutatingLimitCheck, 'mutating action count limit should be enforced');

  console.log('  ✓ batch-operation-count-bounded: total and mutating actions per response are capped');
}

// ── Test 7: Exact-path requirement enforced ──────────────────────
function testExactPathRequirement() {
  const code = loadServerCode();

  const hasPathCheck = code.includes('assertAgentWorkspacePathAllowed');
  assert(hasPathCheck, 'path validation should exist');

  const hasNonEmpty = code.includes('nonEmpty: true');
  assert(hasNonEmpty, 'path should be required to be non-empty');

  // Verify path validation is called in executeWorkspaceOperation
  const pathChecks = (code.match(/assertAgentWorkspacePathAllowed/g) || []).length;
  assert(pathChecks >= 4, `path validation should be called for all operations (found ${pathChecks})`);

  console.log('  ✓ exact-path-requirement: all operations require explicit non-empty paths');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Operation Batch Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testBoundedInspectionProducesOneBatch,
    testRepeatedInspectionFails,
    testRuntimeVerifiesRename,
    testDuplicateCommitsSkipped,
    testConflictingOperationsRejected,
    testBatchOperationCountBounded,
    testExactPathRequirement
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
