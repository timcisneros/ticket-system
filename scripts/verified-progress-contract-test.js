#!/usr/bin/env node
'use strict';

// Tranche 5 deterministic suite for verified progress and the churn decision.
//
// No database, no server, no provider. Every assertion is about the boundary
// between being busy and advancing: a runtime that cannot tell those apart is
// the runtime that produced the churn this tranche exists to stop.

const assert = require('node:assert/strict');
const {
  NO_PROGRESS_SIGNALS,
  PROGRESS_LEVELS,
  buildVerifiedProgressProjection,
  classifyObservation,
  inventoryDeclaredFacts,
  normalizeVerifiedProgressProjection
} = require('../runtime/verified-progress-contract');
const {
  CHURN_DECISIONS,
  CHURN_STOP_REASONS,
  buildProgressControlPolicy,
  decideChurn,
  normalizeChurnDecision,
  normalizeProgressControlPolicy,
  permitsGovernedRequest
} = require('../runtime/churn-decision-contract');
const { hashCanonical } = require('../runtime/declared-work-contract');

const OUTPUT = { kind: 'text', declaration: 'One findings report' };
const CRITERION = { kind: 'text', declaration: 'Report names a concrete finding' };
const TYPED = {
  kind: 'typed-postcondition',
  criterionType: 'fileExists',
  declaration: '{"type":"fileExists","path":"report.md"}',
  criterionHash: 'c'.repeat(64)
};
const DECLARED = {
  contractHash: 'a'.repeat(64),
  expectedOutputs: [OUTPUT],
  successCriteria: [CRITERION, TYPED],
  evidenceRequirements: [{ kind: 'postcondition-evidence', criterionHash: 'c'.repeat(64),
    evidenceType: 'deterministic-postcondition-result' }]
};

const OUTPUT_ID = hashCanonical(OUTPUT);
const CRITERION_ID = hashCanonical(CRITERION);

function policyOf(overrides = {}) {
  return buildProgressControlPolicy({
    maximumConsecutiveNoProgressWindows: 2,
    maximumRepeatedMutations: 2,
    maximumFailedOperationStreak: 3,
    maximumMutationReversals: 2,
    maximumInspectionOnlyStreak: 3,
    resourceDimensions: ['provider_requests', 'settled_micro_usd'],
    ...overrides
  });
}

function projectionOf(observations, extra = {}) {
  return buildVerifiedProgressProjection({
    ticketId: 7,
    runId: 42,
    declaredWorkSnapshot: DECLARED,
    windowIdentity: 'model-request:agent:1:provider',
    windowKind: 'provider_request',
    observations,
    resources: { providerRequests: 1, ...(extra.resources || {}) },
    sourceCutoff: 100,
    policy: extra.policy || policyOf(),
    previouslySatisfiedFactIdentities: extra.satisfied || [],
    previouslySeenFingerprints: extra.seen || []
  });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    return error.detail && error.detail.reason;
  }
  return assert.fail('expected a refusal');
}

// ── The four levels are distinct ────────────────────────────────────────────

assert.deepEqual([...PROGRESS_LEVELS],
  ['activity', 'candidate_progress', 'verified_progress', 'completion'],
  'the vocabulary keeps all four levels separate');

const facts = inventoryDeclaredFacts(DECLARED);
assert.equal(facts.length, 4, 'every declared obligation becomes a measurable fact');
assert.deepEqual([...new Set(facts.map(f => f.kind))].sort(),
  ['evidence_requirement', 'expected_output', 'success_criterion', 'typed_postcondition']);

// A Run whose authority obliges nothing measurable can never show progress.
// That is truthful, not an error.
assert.deepEqual(
  inventoryDeclaredFacts({ contractHash: 'b'.repeat(64) }), [],
  'an authority with no declared facts yields no measurable obligations');

// ── Activity ────────────────────────────────────────────────────────────────

for (const [label, observation] of [
  ['a failed operation', { operation: 'writeFile', outcome: 'failed' }],
  ['a refused operation', { operation: 'writeFile', outcome: 'refused' }],
  ['a directory listing', { operation: 'listDirectory', outcome: 'succeeded' }],
  ['a file read', { operation: 'readFile', outcome: 'succeeded' }]
]) {
  assert.equal(
    classifyObservation(observation, { declaredFacts: facts }).level, 'activity',
    `${label} is activity, never progress`);
}

// A successful operation with no fingerprint and no declared advancement.
assert.equal(
  classifyObservation({ operation: 'writeFile', outcome: 'succeeded' },
    { declaredFacts: facts }).level,
  'activity',
  'a successful operation alone is not progress');

// ── Candidate progress is not verified progress ─────────────────────────────

const novel = classifyObservation(
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'scratch.txt',
    mutationFingerprint: 'f-novel' },
  { declaredFacts: facts });
assert.equal(novel.level, 'candidate_progress',
  'a novel mutation that advances no declared fact is candidate progress only');
assert.deepEqual(novel.satisfies, [],
  'candidate progress satisfies nothing');

// The same fingerprint a second time is not even novel.
assert.equal(
  classifyObservation(
    { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'scratch.txt',
      mutationFingerprint: 'f-novel' },
    { declaredFacts: facts, previouslySeenFingerprints: ['f-novel'] }).level,
  'activity',
  'a repeated fingerprint is not novel and not progress');

// ── Verified progress requires advancing declared authority ─────────────────

const advanced = classifyObservation(
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'report.md',
    mutationFingerprint: 'f-report',
    satisfiesDeclaredFactIdentities: [OUTPUT_ID] },
  { declaredFacts: facts });
assert.equal(advanced.level, 'verified_progress',
  'satisfying a previously unsatisfied expected output is verified progress');
assert.deepEqual(advanced.satisfies, [OUTPUT_ID]);

// Satisfying the SAME fact again is not new progress.
assert.equal(
  classifyObservation(
    { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'report.md',
      mutationFingerprint: 'f-report-2',
      satisfiesDeclaredFactIdentities: [OUTPUT_ID] },
    { declaredFacts: facts, previouslySatisfiedFactIdentities: [OUTPUT_ID] }).level,
  'candidate_progress',
  're-satisfying an already satisfied fact is not new verified progress');

// A claim to satisfy a fact the authority never declared is ignored outright.
assert.equal(
  classifyObservation(
    { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'x.md',
      mutationFingerprint: 'f-x',
      satisfiesDeclaredFactIdentities: ['d'.repeat(64)] },
    { declaredFacts: facts }).level,
  'candidate_progress',
  'satisfying an undeclared fact advances nothing');

// Model prose has no representation at all.
const prose = classifyObservation(
  { operation: 'writeFile', outcome: 'succeeded',
    modelClaim: 'I have completed the report', summary: 'done' },
  { declaredFacts: facts });
assert.equal(prose.level, 'activity',
  'model prose claiming progress is not progress');

// ── Completion stays elsewhere ──────────────────────────────────────────────

const projection = projectionOf([
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'report.md',
    mutationFingerprint: 'f-report', satisfiesDeclaredFactIdentities: [OUTPUT_ID] }
]);
assert.equal(projection.verifiedProgressCount, 1);
for (const forbidden of ['complete', 'completed', 'completionDecision', 'itemStatus']) {
  assert.equal(Object.prototype.hasOwnProperty.call(projection, forbidden), false,
    `the projection must not carry ${forbidden}: completion is owned elsewhere`);
}

// ── Determinism and durable identity ────────────────────────────────────────

const repeatable = projectionOf([
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'report.md',
    mutationFingerprint: 'f-report', satisfiesDeclaredFactIdentities: [OUTPUT_ID] }
]);
assert.equal(repeatable.projectionHash, projection.projectionHash,
  'the same durable facts and cutoff produce the same projection hash');
assert.deepEqual(normalizeVerifiedProgressProjection(projection), projection,
  'a well-formed projection normalizes to itself');

// The window identity is durable, never a process sequence.
assert.equal(projection.windowIdentity, 'model-request:agent:1:provider',
  'the window is identified by the durable logical source');
assert.equal(
  refusalReason(() => buildVerifiedProgressProjection({
    ticketId: 7, runId: 42, declaredWorkSnapshot: DECLARED,
    windowIdentity: '', windowKind: 'provider_request',
    observations: [], resources: {}, sourceCutoff: 1
  })),
  'progress_observation_malformed',
  'an empty window identity refuses');
assert.equal(
  refusalReason(() => buildVerifiedProgressProjection({
    ticketId: 7, runId: 42, declaredWorkSnapshot: DECLARED,
    windowIdentity: 'w', windowKind: 'in_memory_counter',
    observations: [], resources: {}, sourceCutoff: 1
  })),
  'progress_window_identity_missing',
  'a non-durable window kind refuses');

// A tampered count is caught independently of the hash.
assert.equal(
  refusalReason(() => normalizeVerifiedProgressProjection({
    ...projection, verifiedProgressCount: 5
  })),
  'progress_accounting_conflict',
  'a count disagreeing with its own fact list refuses');

// ── No-progress signals ─────────────────────────────────────────────────────

const repeated = projectionOf([
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'f1' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'f1' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'f1' }
]);
assert.ok(repeated.noProgressSignals.includes('repeated_no_op'),
  'writing identical content repeatedly is a no-op signal');

const failing = projectionOf([
  { operation: 'writeFile', outcome: 'failed' },
  { operation: 'writeFile', outcome: 'failed' },
  { operation: 'writeFile', outcome: 'refused' }
]);
assert.ok(failing.noProgressSignals.includes('repeated_failed_operation'),
  'a failed/refused streak is a no-progress signal');

// A reversal is necessarily also a repetition — the path returns to content it
// already held. To observe the reversal signal on its own, tolerate repetition
// generously and keep the reversal bound tight.
const REVERSAL_POLICY = policyOf({ maximumRepeatedMutations: 50 });
const reverted = projectionOf([
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'A' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'B' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'A' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'B' }
], { policy: REVERSAL_POLICY });
assert.ok(reverted.noProgressSignals.includes('mutation_reversal_churn'),
  'A -> B -> A with no declared advancement is reversal churn');
assert.equal(reverted.noProgressSignals.includes('repeated_no_op'), false,
  'the reversal signal is observed on its own under this policy');

const inspecting = projectionOf([
  { operation: 'listDirectory', outcome: 'succeeded' },
  { operation: 'readFile', outcome: 'succeeded' },
  { operation: 'listDirectory', outcome: 'succeeded' }
]);
assert.ok(inspecting.noProgressSignals.includes('inspection_only_streak'),
  'an inspection-only streak is a no-progress signal');

// Resources consumed with nothing to show. A provider request was spent and no
// declared fact advanced — the central Tranche 5 condition.
const spentNothingGained = projectionOf([], {
  resources: { providerRequests: 1, settledMicroUsd: 20_429 }
});
assert.equal(spentNothingGained.verifiedProgressCount, 0);
assert.ok(spentNothingGained.noProgressSignals.includes('resource_growth_without_progress'),
  'resources consumed with no verified progress is a signal in its own right');

// The same window with nothing consumed is not a growth signal: an idle window
// is not churn.
const idle = buildVerifiedProgressProjection({
  ticketId: 7, runId: 42, declaredWorkSnapshot: DECLARED,
  windowIdentity: 'model-request:agent:2:provider', windowKind: 'provider_request',
  observations: [], resources: {}, sourceCutoff: 101, policy: policyOf()
});
assert.equal(idle.noProgressSignals.includes('resource_growth_without_progress'), false,
  'a window that consumed nothing is not resource growth');

// Verified progress clears the signals: the same shapes are not churn when
// something declared actually advanced.
const productive = projectionOf([
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'A' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'B' },
  { operation: 'writeFile', outcome: 'succeeded', workspacePath: 'a.md',
    mutationFingerprint: 'A', satisfiesDeclaredFactIdentities: [CRITERION_ID] }
], { policy: REVERSAL_POLICY });
assert.equal(productive.verifiedProgressCount, 1);
assert.deepEqual(productive.noProgressSignals, [],
  'a reversal that newly satisfies declared authority is not churn');

for (const signal of repeated.noProgressSignals.concat(failing.noProgressSignals)) {
  assert.ok(NO_PROGRESS_SIGNALS.includes(signal),
    `${signal} is in the closed vocabulary`);
}

// ── Tolerance policy ────────────────────────────────────────────────────────

const policy = policyOf();
assert.deepEqual(normalizeProgressControlPolicy(policy), policy);
for (const [field, value, why] of [
  ['maximumConsecutiveNoProgressWindows', 0, 'zero'],
  ['maximumRepeatedMutations', -1, 'negative'],
  ['maximumFailedOperationStreak', null, 'null'],
  ['maximumMutationReversals', Infinity, 'infinite'],
  ['maximumInspectionOnlyStreak', 10_000, 'effectively unbounded']
]) {
  assert.equal(
    refusalReason(() => policyOf({ [field]: value })),
    'churn_tolerance_unbounded',
    `a ${why} ${field} is not a bounded tolerance`);
}
assert.equal(
  refusalReason(() => policyOf({ resourceDimensions: [] })),
  'progress_policy_malformed',
  'a policy naming no resource dimension refuses');
assert.equal(
  refusalReason(() => policyOf({ resourceDimensions: ['wall_clock_guess'] })),
  'progress_policy_malformed',
  'an unknown resource dimension refuses');
assert.equal(
  refusalReason(() => normalizeProgressControlPolicy({ ...policy, surprise: 1 })),
  'progress_policy_malformed',
  'an unknown policy field refuses');

// ── The churn decision ──────────────────────────────────────────────────────

assert.deepEqual([...CHURN_DECISIONS], ['continue', 'blocked'],
  'exactly two decisions: no retry, reroute, replan or remediation');

const permitted = decideChurn({
  ticketId: 7, runId: 42, progressProjection: productive, policy,
  cumulativeResources: { providerRequests: 3, settledMicroUsd: 900 },
  consecutiveNoProgressWindows: 0
});
assert.equal(permitted.decision, 'continue');
assert.equal(permitted.reason, null);
assert.equal(permitsGovernedRequest(permitted), true,
  'tolerance below threshold permits a further governed request');

const exhausted = decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]), policy,
  cumulativeResources: { providerRequests: 5, settledMicroUsd: 4_000 },
  consecutiveNoProgressWindows: 2
});
assert.equal(exhausted.decision, 'blocked');
assert.equal(exhausted.reason, 'verified_progress_exhausted');
assert.equal(permitsGovernedRequest(exhausted), false,
  'an exhausted tolerance forbids a further governed request');

// Each durable signal produces its own closed reason.
for (const [projectionUnderTest, expected, decisionPolicy] of [
  [repeated, 'repeated_no_op', policy],
  [failing, 'repeated_failed_operation', policy],
  [reverted, 'mutation_reversal_churn', REVERSAL_POLICY]
]) {
  const decided = decideChurn({
    ticketId: 7, runId: 42, progressProjection: projectionUnderTest,
    policy: decisionPolicy,
    cumulativeResources: { providerRequests: 1 },
    consecutiveNoProgressWindows: 0
  });
  assert.equal(decided.decision, 'blocked');
  assert.equal(decided.reason, expected, `${expected} produces its own closed reason`);
  assert.ok(CHURN_STOP_REASONS.includes(decided.reason));
}

// A sibling dependency blocks, and is reported as coordination rather than churn.
const sibling = decideChurn({
  ticketId: 7, runId: 42, progressProjection: productive, policy,
  cumulativeResources: { providerRequests: 1 },
  consecutiveNoProgressWindows: 0,
  siblingDependencyBlocked: true
});
assert.equal(sibling.decision, 'blocked');
assert.equal(sibling.reason, 'undeclared_sibling_dependency',
  'an incomplete sibling read is coordination, not churn');

// Verified progress resets the consecutive window but never erases the
// cumulative resource history.
assert.equal(permitted.cumulativeResources.providerRequests, 3,
  'cumulative resource history survives a productive window');
assert.equal(permitted.consecutiveNoProgressWindows, 0);
assert.equal(exhausted.cumulativeResources.settledMicroUsd, 4_000,
  'cumulative settled micro-USD is carried into the decision');

// ── Decision integrity ──────────────────────────────────────────────────────

assert.deepEqual(normalizeChurnDecision(exhausted), exhausted);
assert.equal(
  refusalReason(() => normalizeChurnDecision({ ...exhausted, decision: 'retry' })),
  'churn_decision_malformed',
  'no third decision exists');
assert.equal(
  refusalReason(() => normalizeChurnDecision({ ...exhausted, reason: 'because' })),
  'churn_decision_malformed',
  'a blocked decision must carry a closed stop reason');
assert.equal(
  refusalReason(() => normalizeChurnDecision({ ...permitted, reason: 'repeated_no_op' })),
  'churn_decision_malformed',
  'a continue decision carries no stop reason');
assert.equal(
  refusalReason(() => normalizeChurnDecision({
    ...exhausted, consecutiveNoProgressWindows: 0
  })),
  'churn_decision_malformed',
  'an edited decision no longer matches its own hash');

// Determinism: identical durable inputs, identical decision hash.
const again = decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]), policy,
  cumulativeResources: { providerRequests: 5, settledMicroUsd: 4_000 },
  consecutiveNoProgressWindows: 2
});
assert.equal(again.decisionHash, exhausted.decisionHash,
  'the same durable facts produce the same decision after any restart');

console.log('verified progress and churn decision contract test passed');
