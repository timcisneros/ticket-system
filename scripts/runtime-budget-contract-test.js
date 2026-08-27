#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  RUNTIME_BUDGET_DIMENSIONS,
  RUNTIME_BUDGET_FAILURE_CODES,
  RUNTIME_CAPACITY_DOMAINS,
  RuntimeBudgetError,
  buildRuntimeBudgetSnapshot,
  getRunRuntimeBudgetSnapshot,
  normalizeRuntimeBudgetSnapshot
} = require('../runtime/runtime-budget-contract');
const {
  RuntimeBudgetController
} = require('../runtime/runtime-budget-controller');

let assertions = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
  console.log(`  ok ${message}`);
}

const defaults = Object.freeze({
  maxAttempts: 3,
  maxExecutionSteps: 4,
  maxModelRequestsPerRun: 5,
  maxWorkspaceOperationsPerRun: 6,
  maxProcessOperationsPerRun: 7,
  maxBrowserOperationsPerRun: 8,
  maxRuntimeDurationMs: 120_000,
  maxOutputArtifactBytesPerRun: 16_777_216,
  revision: 9
});
const policy = Object.freeze({
  mode: 'assisted',
  requireVerification: 'when_declared',
  autoRetry: false,
  maxAttempts: null,
  maxExecutionSteps: null,
  maxRuntimeMs: null,
  maxModelRequests: null,
  maxWorkspaceOperations: null,
  maxProcessOperations: null,
  maxBrowserOperations: null,
  maxOutputArtifactBytes: null,
  allowWorkspaceWrites: true,
  allowParallelRuns: false,
  allowChildTickets: false,
  workspaceScope: 'shared'
});

const inherited = buildRuntimeBudgetSnapshot({
  runtimeLimits: defaults,
  executionPolicy: policy
});
ok(inherited.version === 1, 'new effective budget snapshots use closed version 1');
ok(inherited.maxAttempts === 3 &&
  inherited.maxExecutionSteps === 4 &&
  inherited.maxModelRequests === 5 &&
  inherited.maxWorkspaceOperations === 6 &&
  inherited.maxProcessOperations === 7 &&
  inherited.maxBrowserOperations === 8 &&
  inherited.maxRuntimeDurationMs === 120_000 &&
  inherited.maxOutputArtifactBytes === 16_777_216,
'null ticket limits resolve to concrete runtime defaults');
ok(inherited.runtimeLimitsRevision === 9 &&
  /^[0-9a-f]{64}$/.test(inherited.executionPolicyHash) &&
  /^[0-9a-f]{64}$/.test(inherited.snapshotHash),
'snapshot binds runtime revision, policy hash, and canonical authority hash');
ok(Object.isFrozen(inherited), 'effective budget snapshot is immutable');

const overridden = buildRuntimeBudgetSnapshot({
  runtimeLimits: defaults,
  executionPolicy: {
    ...policy,
    maxAttempts: 2,
    maxExecutionSteps: 2,
    maxRuntimeMs: 60_000,
    maxModelRequests: 3,
    maxWorkspaceOperations: 4,
    maxProcessOperations: 1,
    maxBrowserOperations: 2,
    maxOutputArtifactBytes: 1024,
    allowParallelRuns: true
  }
});
ok(overridden.maxAttempts === 2 &&
  overridden.maxExecutionSteps === 2 &&
  overridden.maxRuntimeDurationMs === 60_000 &&
  overridden.maxModelRequests === 3 &&
  overridden.maxWorkspaceOperations === 4 &&
  overridden.maxProcessOperations === 1 &&
  overridden.maxBrowserOperations === 2 &&
  overridden.maxOutputArtifactBytes === 1024 &&
  overridden.allowParallelRuns === true,
'explicit ticket limits override runtime defaults exactly');

const mutableDefaults = { ...defaults };
const mutablePolicy = { ...policy };
const admitted = buildRuntimeBudgetSnapshot({
  runtimeLimits: mutableDefaults,
  executionPolicy: mutablePolicy
});
mutableDefaults.maxExecutionSteps = 999;
mutablePolicy.maxExecutionSteps = 999;
ok(admitted.maxExecutionSteps === 4 &&
  normalizeRuntimeBudgetSnapshot(structuredClone(admitted)).snapshotHash ===
    admitted.snapshotHash,
'later runtime or ticket policy mutation cannot alter admitted authority');

for (const mutation of [
  snapshot => { snapshot.maxExecutionSteps = 0; },
  snapshot => { snapshot.maxModelRequests = null; },
  snapshot => { snapshot.snapshotHash = '0'.repeat(64); },
  snapshot => { snapshot.future = true; },
  snapshot => { snapshot.version = 2; },
  snapshot => { snapshot.allowParallelRuns = 'false'; }
]) {
  const malformed = structuredClone(inherited);
  mutation(malformed);
  assert.throws(
    () => normalizeRuntimeBudgetSnapshot(malformed),
    error => error instanceof RuntimeBudgetError &&
      error.code === 'RUN_BUDGET_SNAPSHOT_INVALID'
  );
  assertions += 1;
}
console.log('  ok malformed, incomplete, future, contradictory, and extra-field snapshots fail closed');

ok(getRunRuntimeBudgetSnapshot({ id: 1 }) === null &&
  getRunRuntimeBudgetSnapshot({ id: 2, runtimeBudgetSnapshot: null }) === null,
'historical runs without the new snapshot retain explicit compatibility behavior');
ok(RUNTIME_BUDGET_DIMENSIONS.join(',') ===
  'execution_step,model_request,workspace_operation,process_operation,browser_operation,output_artifact_bytes',
'one frozen dimension catalog covers every consumable operation class');
ok(RUNTIME_CAPACITY_DOMAINS.join(',') ===
  'global_run,model_provider,target,process_launcher',
'one frozen capacity-domain catalog covers shared scheduling authority');
for (const code of [
  'RUN_BUDGET_SNAPSHOT_INVALID',
  'RUN_BUDGET_EXHAUSTED',
  'RUN_BUDGET_RESERVATION_CONFLICT',
  'RUN_BUDGET_RECONCILIATION_FAILED',
  'RUN_RUNTIME_DURATION_EXCEEDED',
  'RUN_FEASIBILITY_REJECTED',
  'RUNTIME_CAPACITY_UNAVAILABLE',
  'RUNTIME_CAPACITY_LEASE_CONFLICT',
  'RUNTIME_CAPACITY_RECONCILIATION_FAILED',
  'TARGET_CAPACITY_UNAVAILABLE',
  'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE'
]) {
  ok(RUNTIME_BUDGET_FAILURE_CODES.includes(code), `typed failure is frozen: ${code}`);
}

// T5-I7 vocabulary guard: the failureKind strings are non-canonical mechanism
// vocabulary. 'capacity_backpressure' covers capacity-machinery errors and
// target/launcher capacity refusals — it must never be reinterpreted as
// canonical ordinary-capacity-occupancy or budget-exhaustion semantics.
for (const [code, expectedKind] of [
  ['RUN_BUDGET_EXHAUSTED', 'runtime_budget_exhausted'],
  ['RUN_RUNTIME_DURATION_EXCEEDED', 'runtime_duration_exhausted'],
  ['RUN_FEASIBILITY_REJECTED', 'deterministic_infeasibility'],
  ['RUNTIME_CAPACITY_UNAVAILABLE', 'capacity_backpressure'],
  ['RUNTIME_CAPACITY_LEASE_CONFLICT', 'capacity_backpressure'],
  ['RUNTIME_CAPACITY_RECONCILIATION_FAILED', 'capacity_backpressure'],
  ['TARGET_CAPACITY_UNAVAILABLE', 'capacity_backpressure'],
  ['PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE', 'capacity_backpressure']
]) {
  const error = new RuntimeBudgetError('vocabulary guard', code);
  ok(error.failureKind === expectedKind,
    `${code} maps to the frozen non-canonical failureKind ${expectedKind}`);
}

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const storeSource = fs.readFileSync(
  path.join(__dirname, '..', 'persistence/postgres/runtime-budget-methods.js'),
  'utf8'
);
ok(!/(runtimeBudget|budgetUsage|capacitySlots)\w*\s*=\s*new Map\(/.test(serverSource),
'production runtime has no process-local budget counter authority');
ok(/claimPendingRun/.test(serverSource) &&
  !/setInterval\([^)]*schedulePendingRuns/s.test(serverSource),
'Tranche 5 extends the canonical scheduler rather than adding another scheduler loop');
ok(/pg_advisory_xact_lock/.test(storeSource) &&
  /run_budget_charges/.test(storeSource) &&
  /runtime_capacity_slots/.test(storeSource),
'budget and capacity authority is PostgreSQL-coordinated');
ok(/appendRunEvidenceWithRunBudgetCharge/.test(serverSource) &&
  /heartbeatRunLeaseWithRunBudgetCharge/.test(serverSource) &&
  /prepareTargetOperationWithRunBudgetReservation/.test(serverSource) &&
  /completeTargetOperationWithRunBudgetCommit/.test(serverSource),
'budget lifecycles share only their corresponding durable product boundaries');
ok(/error\.code\.startsWith\('RUN_BUDGET_'\)/.test(serverSource),
'a durable budget refusal is not retried by generic workspace error accounting');
ok(/budgetCompletionBoundaryAttempted/.test(serverSource) &&
  /!operationContext\.budgetCompletionBoundaryAttempted/.test(serverSource),
'failed atomic workspace completion remains reserved for truthful recovery');

const repository = Object.fromEntries([
  'reserveRunBudget',
  'commitRunBudget',
  'releaseRunBudget',
  'listRunBudgetCharges',
  'acquireRuntimeCapacity',
  'renewRuntimeCapacity',
  'releaseRuntimeCapacity'
].map(method => [method, async () => {
  throw new Error(`${method} is not used by this duration contract test`);
}]));
const controller = new RuntimeBudgetController({
  repository,
  leaseOwner: 'runtime-budget-contract-test'
});
const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
const durationRun = {
  id: 44,
  runtimeBudgetSnapshot: inherited,
  runtimeBudgetStartedAt: new Date(startedAt).toISOString()
};
assert.doesNotThrow(() => controller.assertDuration(
  durationRun,
  startedAt + inherited.maxRuntimeDurationMs - 1
));
assert.throws(
  () => controller.assertDuration(durationRun, startedAt + inherited.maxRuntimeDurationMs),
  error => error instanceof RuntimeBudgetError &&
    error.code === 'RUN_RUNTIME_DURATION_EXCEEDED'
);
assertions += 2;
console.log('  ok durable elapsed runtime permits below-limit work and rejects the exact limit');

console.log(`PASS: runtime budget contract (${assertions} assertions)`);
