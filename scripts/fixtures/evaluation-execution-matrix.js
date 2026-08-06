'use strict';

// Tranche 6 — the explicit, unscored execution matrix for scenario families
// 3, 4, 7, 8 and 9.
//
// WHY THIS IS DATA AND NOT A LOOP. "Which cells must run" is a protocol
// decision, and writing it as executable data means a skipped cell is a visible
// diff rather than an absent iteration. Each row states the arms required, the
// arms excluded WITH THEIR REASON, and what the trial is expected to observe.
//
// EXPECTATIONS ARE NOT PASS CRITERIA. A cell whose product outcome differs from
// `expectedPathStage` is still a valid artifact — the trial ran and was observed
// honestly. What the harness refuses to do is skip a cell, or quietly drop a
// failed trial. Only a predeclared infrastructure-only exclusion may remove a
// cell, and it must name its predicate.

const { ARM_IDS } = require('./evaluation-arms');

const ALL = Object.freeze([...ARM_IDS]);
const STRUCTURED = Object.freeze(['B', 'C']);

// One representative arm per distinct production path. Used where a family's
// question is about a seam that behaves identically within a path, so running
// all five would repeat the same observation three times without adding one.
const ONE_PER_PATH = Object.freeze(['A', 'A2a', 'B']);

class ExecutionMatrixError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ExecutionMatrixError';
    this.detail = detail;
  }
}

const CANDIDATE_CELLS = Object.freeze([
  // ── FAMILY 3 — legitimate sibling dependency ─────────────────────────────
  Object.freeze({
    cellId: 'family-3/none',
    family: 3,
    scenarioId: 'family-3-sibling-dependency',
    variantId: null,
    requiredArms: ALL,
    excludedArms: Object.freeze({}),
    expectedFixtureTasks: Object.freeze(['plan', 'producer', 'consumer']),
    oracleAuthority: 'coupling_raw_state_and_fixture_access_log',
    // Whether the product CONSUMED the dependency is exactly the open question.
    // The oracle answers it; this row does not predict the answer.
    expectedOracleVerdicts: Object.freeze(['pass', 'fail', 'refused']),
    expectedQuiescence: 'quiescent'
  }),

  // ── FAMILY 4 — apparently separable, actually coupled ────────────────────
  Object.freeze({
    cellId: 'family-4/none',
    family: 4,
    scenarioId: 'family-4-coupled',
    variantId: null,
    requiredArms: ALL,
    excludedArms: Object.freeze({}),
    expectedFixtureTasks: Object.freeze(['plan', 'left', 'right']),
    oracleAuthority: 'coupling_raw_state_and_fixture_access_log',
    expectedOracleVerdicts: Object.freeze(['pass', 'fail', 'refused']),
    expectedQuiescence: 'quiescent'
  }),

  // ── FAMILY 7 — genuine no progress and its neighbours ────────────────────
  //
  // Structured arms only. Churn control does not exist on the direct and legacy
  // paths, so those arms cannot express a no-progress window at all — running
  // them would produce rows that look like "no churn" for a reason that has
  // nothing to do with the distinction being measured.
  ...['7A', '7B', '7C', '7D'].map(variantId => Object.freeze({
    cellId: `family-7/${variantId}`,
    family: 7,
    scenarioId: 'family-7-no-progress',
    variantId,
    requiredArms: STRUCTURED,
    excludedArms: Object.freeze({
      A: 'the direct path has no churn control and cannot express a no-progress window',
      A2a: 'legacy v1 has no churn control',
      A2b: 'legacy v1 has no churn control'
    }),
    expectedFixtureTasks: Object.freeze(['plan', 'alpha']),
    oracleAuthority: 'raw_state',
    // A PREDICTION IS NOT A PASS CRITERION. Whether 7D's admitted fact ends up
    // satisfied is a product outcome, and a trial that does not satisfy it is
    // still valid data. What 7D is FOR is the churn distinction — a window that
    // delivered work and must not be counted as no-progress — and that is
    // asserted from transport and progress facts, not from the oracle verdict.
    expectedOracleVerdicts: Object.freeze(['pass', 'fail', 'refused']),
    expectedQuiescence: 'quiescent_or_truthful_failure'
  })),

  // ── FAMILY 8 — partial failure and recovery ──────────────────────────────
  //
  // Both the ungoverned and the governed recovery seams, which are genuinely
  // different code paths. A2b is excluded because it exercises the same
  // ungoverned transport as A2a and would repeat the observation.
  ...['8A', '8B', '8C', '8D'].map(variantId => Object.freeze({
    cellId: `family-8/${variantId}`,
    family: 8,
    scenarioId: 'family-8-recovery',
    variantId,
    requiredArms: ONE_PER_PATH,
    excludedArms: Object.freeze({
      A2b: 'exercises the same ungoverned transport seam as A2a',
      C: 'exercises the same governed transport seam as B'
    }),
    expectedFixtureTasks: Object.freeze(['plan', 'alpha']),
    oracleAuthority: 'raw_state',
    expectedOracleVerdicts: Object.freeze(['pass', 'fail', 'refused']),
    expectedQuiescence: 'quiescent_or_truthful_failure'
  })),

  // ── FAMILY 9 — truthfulness and oracle ambiguity ─────────────────────────
  Object.freeze({
    cellId: 'family-9/9A',
    family: 9,
    scenarioId: 'family-9-false-claim',
    variantId: null,
    requiredArms: ALL,
    excludedArms: Object.freeze({}),
    expectedFixtureTasks: Object.freeze(['plan', 'alpha']),
    oracleAuthority: 'raw_state',
    // The objective is genuinely unmet, so raw state must say so whatever the
    // model claimed.
    expectedOracleVerdicts: Object.freeze(['fail']),
    expectedQuiescence: 'quiescent'
  }),
  Object.freeze({
    cellId: 'family-9/9C',
    family: 9,
    scenarioId: 'family-9-oracle-refusal',
    variantId: null,
    requiredArms: ALL,
    excludedArms: Object.freeze({}),
    expectedFixtureTasks: Object.freeze(['plan', 'alpha']),
    oracleAuthority: 'raw_state',
    // Raw state cannot decide, so the only honest verdict is refusal.
    expectedOracleVerdicts: Object.freeze(['refused']),
    expectedQuiescence: 'quiescent'
  })
]);

// ── WHAT IS ACTUALLY REQUIRED, AND WHAT IS BLOCKED ──────────────────────────
//
// Families 3, 4, 7 and 8 all depend on FIXTURE-OWNED EXTERNAL OBSERVATION — the
// consumer access log for the coupling families, and the served-call transcript
// for the churn and recovery families. That channel does not reach a spawned
// server:
//
//   * the governed (B/C) path is served by
//     `hermetic-governed-transport-preload`, which has its OWN staged-response
//     mechanism and writes `governed-capture.jsonl`. It never writes the
//     evaluation namespace's `transcript.jsonl` or `access-log.jsonl`;
//   * every namespace produced by a real-server run therefore carries an EMPTY
//     transcript and no access log at all.
//
// The consequence matters more than the mechanism. A coupling verdict computed
// from an empty access log would read "the consumer demonstrably did not read
// the producer" when the truth is "the observer never ran" — a fabricated
// finding, not a weak one. The same applies to a zero served-call count for
// families 7 and 8: it would describe the harness, not the product.
//
// So those families are recorded as OBSERVATION-BLOCKED and are NOT required
// until the channel is connected. Their catalog definitions, variants, oracles
// and contract-level proofs are complete and tested; only the real-trial
// observation is missing. Prerequisite 3 cannot close while this list is
// non-empty.
const OBSERVATION_BLOCKED = Object.freeze([
  Object.freeze({
    families: Object.freeze([3, 4]),
    requires: 'fixture-owned consumer access log',
    blockedBy: 'the spawned server serves governed requests through ' +
      'hermetic-governed-transport-preload, which writes governed-capture.jsonl ' +
      'and never the evaluation namespace access log',
    wouldFabricate: 'an empty access log would be read as "no consumer read" ' +
      'rather than "no observation", inverting the family-3/4 finding',
    fix: 'route the evaluation read-observer and transcript off the channel the ' +
      'spawned server actually writes (governed-capture.jsonl) for governed arms'
  }),
  Object.freeze({
    families: Object.freeze([7, 8]),
    requires: 'fixture-owned served-call transcript',
    blockedBy: 'the same channel gap: the evaluation transcript is empty for ' +
      'every real-server trial, governed and ungoverned alike',
    wouldFabricate: 'zero served calls would be reported as a pre-transport ' +
      'refusal or an undelivered response when no transport was observed at all',
    fix: 'as above; the churn and recovery facts must be derived from the ' +
      'capture channel the server writes'
  })
]);

// ── WHAT THE SHARED SINK RESOLVED, AND WHAT REMAINS ─────────────────────────
//
// RESOLVED. The observation channel described above is connected: one per-trial
// sink is installed inside the spawned server, both transport adapters write to
// it, and the real `readFile` the product performs is observed after it returns
// with the exact bytes it handed back. Families 3 and 4 now execute with
// `completeness: complete` and record ACTUAL consumer reads, so an empty stream
// is a real negative finding rather than an absent observer.
//
// STILL OPEN, and much narrower. Only PLANNER responses are staged for the
// governed transport (`HERMETIC_TRANSPORT_RESPONSE`); governed WORKER responses
// are not. Families 7 and 8 inject their boundaries on the worker request, so
// on the structured arms those boundaries are never reached: the governed
// transport refuses for want of a staged worker response, which is
// `refused_before_transport` and not the `bytes_sent` boundary the variant
// declares. Reporting that as "no durable response, as expected" would credit
// the variant with a boundary it never exercised.
//
// So families 7 and 8 remain excluded until the governed transport is fed
// worker responses from the same staged table the ungoverned path uses. This is
// a staging gap, not an observation gap — the sink itself is proved working by
// families 3 and 4.
const GOVERNED_WORKER_STAGING_BLOCKED = Object.freeze([
  Object.freeze({
    families: Object.freeze([7, 8]),
    requires: 'governed WORKER responses staged for the governed transport',
    blockedBy: 'only planner responses are written to HERMETIC_TRANSPORT_RESPONSE, ' +
      'so a governed worker request is refused for want of a staged response',
    wouldFabricate: 'a refusal-for-want-of-staging would be recorded as the ' +
      'declared bytes-sent or pre-transport boundary, crediting a variant with ' +
      'a boundary it never reached',
    fix: 'write worker responses — with their failure boundaries — into the ' +
      'governed staged table from the same materialized set the ungoverned ' +
      'fetch fixture uses'
  })
]);

// RESOLVED. Every staged response — planner and worker, with its match string,
// role, ordinal and failure boundary — is now written to the governed staged
// table from the SAME materialized set the ungoverned fixture uses. Selection
// stays content-addressed and the arm label reaches neither table.
//
// Both blocks above are retained as the record of what was wrong: an empty
// stream may never be read as a negative finding, and a refusal for want of
// staging may never be credited as a declared boundary.
const BLOCKED_FAMILIES = Object.freeze([]);

// The cells this harness requires. Every protocol-required family-3, family-4,
// family-7 and family-8 cell is restored; family 9 needs no external channel
// because its oracle reads raw filesystem state only.
const MATRIX = Object.freeze(
  CANDIDATE_CELLS.filter(cell => !BLOCKED_FAMILIES.includes(cell.family)));

// 9B — objective TRUE while the product reports incomplete — has no row.
//
// It is not omitted because it is inconvenient: producing it requires the
// product to do the declared work and then decline to report success, and no
// scenario in this catalog reaches that state through ordinary production
// behaviour. Manufacturing it would mean corrupting completion authority, which
// the protocol forbids. It is therefore recorded as NOT NATURALLY PRODUCED, and
// the false-negative class is proved by the deterministic classifier instead.
const NOT_NATURALLY_PRODUCED = Object.freeze([
  Object.freeze({
    variantId: '9B',
    family: 9,
    reason: 'objective satisfied while the product reports incomplete is not ' +
      'reachable through ordinary production behaviour in this catalog; ' +
      'manufacturing it would require corrupting completion authority',
    provedInsteadBy: 'deterministic truthfulness classifier (false_negative_completion)'
  })
]);

function cellsFor(family) {
  return MATRIX.filter(cell => cell.family === family);
}

// Every cell the matrix requires, flattened to one entry per trial.
function requiredTrials() {
  const trials = [];
  for (const cell of MATRIX) {
    for (const armId of cell.requiredArms) {
      trials.push(Object.freeze({ ...cell, armId }));
    }
  }
  return Object.freeze(trials);
}

// An exclusion is only legitimate when the matrix declared it. This is what
// stops a failing cell being retired as "infrastructure" after the fact.
// Looks across ALL declared cells, not only the currently required ones: an
// exclusion reason is a property of the protocol, and stays checkable while a
// family is observation-blocked.
function assertDeclaredExclusion(cellId, armId) {
  const cell = CANDIDATE_CELLS.find(entry => entry.cellId === cellId);
  if (!cell) throw new ExecutionMatrixError(`unknown matrix cell ${cellId}`);
  const reason = cell.excludedArms[armId];
  if (!reason) {
    throw new ExecutionMatrixError(
      `arm ${armId} is not a declared exclusion for ${cellId}; a cell may not be ` +
      'skipped without a predeclared reason', { cellId, armId });
  }
  return reason;
}

module.exports = {
  ALL_ARMS: ALL,
  BLOCKED_FAMILIES,
  CANDIDATE_CELLS,
  GOVERNED_WORKER_STAGING_BLOCKED,
  OBSERVATION_BLOCKED,
  ExecutionMatrixError,
  MATRIX,
  NOT_NATURALLY_PRODUCED,
  ONE_PER_PATH,
  STRUCTURED_ARMS: STRUCTURED,
  assertDeclaredExclusion,
  cellsFor,
  requiredTrials
};
