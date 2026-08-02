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
  MAXIMUM_EXECUTION_DURATION_CEILING_MS,
  buildProgressControlPolicy,
  decideChurn,
  elapsedExecutionDurationMs,
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
    maximumCumulativeExecutionDurationMs: 900_000,
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
    evaluatedAt: extra.evaluatedAt || '2026-08-01T10:00:00.000Z',
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
  observations: [], resources: {}, sourceCutoff: 101,
  evaluatedAt: '2026-08-01T10:00:00.000Z', policy: policyOf()
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
  evaluatedAt: '2026-08-01T10:00:00.000Z',
  ticketId: 7, runId: 42, progressProjection: productive, policy,
  cumulativeResources: { providerRequests: 3, settledMicroUsd: 900 },
  consecutiveNoProgressWindows: 0
});
assert.equal(permitted.decision, 'continue');
assert.equal(permitted.reason, null);
assert.equal(permitsGovernedRequest(permitted), true,
  'tolerance below threshold permits a further governed request');

const exhausted = decideChurn({
  evaluatedAt: '2026-08-01T10:00:00.000Z',
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
  evaluatedAt: '2026-08-01T10:00:00.000Z',
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
  evaluatedAt: '2026-08-01T10:00:00.000Z',
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
  evaluatedAt: '2026-08-01T10:00:00.000Z',
  ticketId: 7, runId: 42, progressProjection: projectionOf([]), policy,
  cumulativeResources: { providerRequests: 5, settledMicroUsd: 4_000 },
  consecutiveNoProgressWindows: 2
});
assert.equal(again.decisionHash, exhausted.decisionHash,
  'the same durable facts produce the same decision after any restart');

// ── Cumulative execution duration: the hard total bound ─────────────────────
//
// Every other control in this tranche is a TOLERANCE — a bound on a pattern
// that verified progress is allowed to buy back. Duration is not a tolerance,
// it is consumption, and the tests below exist to hold that distinction.

const EPOCH = '2026-08-01T10:00:00.000Z';
const durationPolicy = (limitMs, overrides = {}) => policyOf({
  maximumCumulativeExecutionDurationMs: limitMs, ...overrides });

// Policy: bounded and positive, or refused.
assert.equal(durationPolicy(600_000).maximumCumulativeExecutionDurationMs, 600_000,
  'a bounded positive duration is accepted');
for (const [label, value] of [
  ['zero', 0],
  ['negative', -1],
  ['infinite', Infinity],
  ['NaN', NaN],
  ['fractional', 1.5],
  ['above the ceiling', MAXIMUM_EXECUTION_DURATION_CEILING_MS + 1],
  ['unsafe integer', Number.MAX_SAFE_INTEGER],
  ['string', '600000'],
  ['null', null],
  ['missing', undefined]
]) {
  assert.equal(
    refusalReason(() => policyOf({ maximumCumulativeExecutionDurationMs: value })),
    'churn_tolerance_unbounded',
    `a ${label} duration limit is refused rather than treated as unlimited`);
}

// An unknown policy field is refused, so the schema stays closed.
assert.equal(
  refusalReason(() => normalizeProgressControlPolicy({
    ...durationPolicy(600_000), maximumWallClockMs: 1_000 })),
  'progress_policy_malformed',
  'the progress policy schema remains closed');

// The duration participates in the policy hash: two policies differing only in
// their duration limit are different authority, not the same authority twice.
assert.notEqual(durationPolicy(600_000).policyHash, durationPolicy(600_001).policyHash,
  'changing the duration limit changes the progress-policy hash');
assert.equal(durationPolicy(600_000).policyHash, durationPolicy(600_000).policyHash,
  'an unchanged duration limit produces a stable policy hash');

// ── Elapsed derivation ──────────────────────────────────────────────────────
//
// Queue time is not execution time. A Run that has never been leased has no
// epoch, and its cumulative execution duration is exactly zero — not "unknown",
// not "now minus admission".
assert.equal(
  elapsedExecutionDurationMs({ executionEpochAt: null, evaluatedAt: EPOCH }), 0,
  'a Run that has never begun executing has consumed zero execution duration');
assert.equal(
  elapsedExecutionDurationMs({
    executionEpochAt: null, evaluatedAt: '2026-08-05T10:00:00.000Z' }), 0,
  'four days of scheduler queue time consume no execution duration');
assert.equal(
  elapsedExecutionDurationMs({
    executionEpochAt: EPOCH, evaluatedAt: '2026-08-01T10:05:00.000Z' }), 300_000,
  'elapsed duration is evaluatedAt minus the first lease acquisition');
assert.equal(
  elapsedExecutionDurationMs({ executionEpochAt: EPOCH, evaluatedAt: EPOCH }), 0,
  'an evaluation at the epoch itself is zero, not negative');
for (const [label, epoch, evaluated] of [
  ['evaluation before the epoch', '2026-08-01T10:05:00.000Z', EPOCH],
  ['malformed epoch', 'not-a-timestamp', EPOCH],
  ['malformed evaluation instant', EPOCH, 'not-a-timestamp'],
  ['non-string evaluation instant', EPOCH, 1_700_000_000_000]
]) {
  assert.ok(
    ['churn_accounting_conflict', 'churn_decision_malformed'].includes(
      refusalReason(() => elapsedExecutionDurationMs({
        executionEpochAt: epoch, evaluatedAt: evaluated }))),
    `${label} refuses rather than producing a duration`);
}

// ── Enforcement: >= blocks ──────────────────────────────────────────────────

const durationDecision = (elapsedMs, limitMs, extra = {}) => decideChurn({
  ticketId: 7,
  runId: 42,
  progressProjection: extra.projection || projectionOf([]),
  policy: durationPolicy(limitMs),
  cumulativeResources: {
    providerRequests: 1,
    cumulativeExecutionDurationMs: elapsedMs
  },
  consecutiveNoProgressWindows: extra.consecutive || 0,
  evaluatedAt: EPOCH
});

const below = durationDecision(599_999, 600_000);
assert.equal(below.decision, 'continue',
  'below the duration limit the Run continues');
assert.equal(below.reason, null);
assert.equal(below.cumulativeExecutionDurationMs, 599_999,
  'the decision records the duration it was taken against');
assert.equal(permitsGovernedRequest(below), true);

const exact = durationDecision(600_000, 600_000);
assert.equal(exact.decision, 'blocked',
  'reaching the limit exactly blocks: the rule is >=, not >');
assert.equal(exact.reason, 'cumulative_execution_duration_exhausted');
assert.equal(permitsGovernedRequest(exact), false);

const above = durationDecision(600_001, 600_000);
assert.equal(above.decision, 'blocked', 'above the limit blocks');
assert.equal(above.reason, 'cumulative_execution_duration_exhausted');

assert.ok(CHURN_STOP_REASONS.includes('cumulative_execution_duration_exhausted'),
  'the duration stop reason is part of the closed vocabulary');
assert.ok(CHURN_DECISIONS.includes(exact.decision),
  'the decision stays inside the two-value vocabulary — no retry, no reroute');

// The reason must be its own. Mislabeling a hard duration stop as a churn
// pattern would invite someone to "fix the loop" and retry into the same wall.
for (const wrong of ['repeated_no_op', 'verified_progress_exhausted',
  'repeated_failed_operation', 'mutation_reversal_churn']) {
  assert.notEqual(above.reason, wrong,
    `a duration stop is never reported as ${wrong}`);
}

// ── Verified progress does not buy back duration ────────────────────────────
//
// The decisive property. A window with genuine verified progress resets the
// consecutive no-progress streak — and changes nothing about duration.
const progressed = buildVerifiedProgressProjection({
  ticketId: 7, runId: 42, declaredWorkSnapshot: DECLARED,
  windowIdentity: 'model-request:agent:9:provider', windowKind: 'provider_request',
  observations: [{
    operation: 'writeFile', outcome: 'succeeded',
    workspacePath: 'report.md', mutationFingerprint: 'fp-progress',
    satisfiesDeclaredFactIdentities: [OUTPUT_ID]
  }],
  resources: { providerRequests: 1 },
  sourceCutoff: 400, evaluatedAt: EPOCH, policy: durationPolicy(600_000)
});
assert.ok(progressed.verifiedProgressCount > 0,
  'the window really did verify progress');

const progressedButExpired = durationDecision(600_000, 600_000, {
  projection: progressed, consecutive: 0
});
assert.equal(progressedButExpired.decision, 'blocked',
  'verified progress does not reset cumulative execution duration');
assert.equal(progressedButExpired.reason, 'cumulative_execution_duration_exhausted',
  'the duration bound is reported even in a window that made real progress');

// The converse still holds: duration well under the limit leaves the ordinary
// churn controls in charge, so this did not become a duration-only system.
const churnFirst = durationDecision(1_000, 600_000, { consecutive: 2 });
assert.equal(churnFirst.decision, 'blocked');
assert.equal(churnFirst.reason, 'verified_progress_exhausted',
  'a no-progress stop is still reported as such when duration is not exhausted');

// ── The decision hash covers duration and the evaluation instant ────────────

const at10 = decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]),
  policy: durationPolicy(600_000),
  cumulativeResources: { providerRequests: 1, cumulativeExecutionDurationMs: 1_000 },
  consecutiveNoProgressWindows: 0, evaluatedAt: EPOCH
});
const at11 = decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]),
  policy: durationPolicy(600_000),
  cumulativeResources: { providerRequests: 1, cumulativeExecutionDurationMs: 1_000 },
  consecutiveNoProgressWindows: 0, evaluatedAt: '2026-08-01T11:00:00.000Z'
});
assert.notEqual(at10.decisionHash, at11.decisionHash,
  'the evaluation instant participates in the decision hash');
const at10Longer = decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]),
  policy: durationPolicy(600_000),
  cumulativeResources: { providerRequests: 1, cumulativeExecutionDurationMs: 2_000 },
  consecutiveNoProgressWindows: 0, evaluatedAt: EPOCH
});
assert.notEqual(at10.decisionHash, at10Longer.decisionHash,
  'cumulative duration participates in the decision hash');
assert.equal(at10.decisionHash, decideChurn({
  ticketId: 7, runId: 42, progressProjection: projectionOf([]),
  policy: durationPolicy(600_000),
  cumulativeResources: { providerRequests: 1, cumulativeExecutionDurationMs: 1_000 },
  consecutiveNoProgressWindows: 0, evaluatedAt: EPOCH
}).decisionHash, 'identical durable facts reproduce the identical decision hash');

// The projection hash covers the evaluation instant too, so a projection
// cannot be silently reused as though it were taken now.
assert.notEqual(
  projectionOf([]).projectionHash,
  projectionOf([], { evaluatedAt: '2026-08-01T11:00:00.000Z' }).projectionHash,
  'the evaluation instant participates in the projection hash');

// A projection with no evaluation instant is refused: it cannot support a
// duration decision, and defaulting one would invent authority.
assert.equal(
  refusalReason(() => buildVerifiedProgressProjection({
    ticketId: 7, runId: 42, declaredWorkSnapshot: DECLARED,
    windowIdentity: 'model-request:agent:1:provider',
    windowKind: 'provider_request', observations: [], resources: {},
    sourceCutoff: 1, policy: policyOf()
  })),
  'progress_observation_malformed',
  'a projection without a database-captured evaluation instant is refused');

console.log('verified progress and churn decision contract test passed');
