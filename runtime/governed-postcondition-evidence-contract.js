'use strict';

// Tranche 5 — the canonical durable record that an admitted declared-work fact
// was deterministically evaluated against one committed operation receipt.
//
// WHY THIS EXISTS. Verified progress means a previously unsatisfied ADMITTED
// declared-work fact is now satisfied. Deciding that needs durable proof, and
// the runtime had none: postcondition results lived only in `replay_snapshots`,
// a mutable per-run document stamped by the process clock with no per-item
// identity. Production consequently credited nothing, and a Run that genuinely
// advanced could still be stopped and told `verified_progress_exhausted`.
//
// WHAT THIS IS NOT:
//
//   * NOT a second postcondition evaluator. The verdict must come from the
//     canonical evaluator; this contract records and binds it, and refuses
//     anything that did not come from a recognized evaluator at a supported
//     version.
//   * NOT a progress ledger. It states one fact about one receipt. Streaks,
//     tolerances and decisions stay in the churn contract.
//   * NOT a completion authority. The same durable evidence may independently
//     satisfy a declared fact and a completion postcondition, but completion is
//     decided only by the completion-decision and aggregate-decision contracts.
//
// WHAT MAY NEVER CREATE A RECORD: a model claim, `complete: true`, an operation
// succeeding, a file existing without canonical evaluation, replay-snapshot
// prose, a caller-supplied `satisfied`, or current (rather than captured)
// completion policy. Each is refused explicitly rather than by omission.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');

const GOVERNED_POSTCONDITION_EVIDENCE_VERSION = 1;

// The evaluators whose verdicts may be recorded, and the versions supported.
// `objective_contract` is the canonical direct-postcondition evaluator that the
// completion decision already uses (`directPostconditionResult`). Adding an
// entry here is a deliberate act; an unrecognized evaluator fails closed.
const SUPPORTED_EVALUATORS = Object.freeze({
  objective_contract: Object.freeze([1])
});

// The typed criterion classes this evidence may describe. These are exactly the
// direct postcondition types the canonical evaluator can decide deterministically
// from durable evidence — no more, so an unsupported class cannot be silently
// recorded as unsatisfied.
const SUPPORTED_CRITERION_TYPES = Object.freeze([
  'folder_exists',
  'path_absent',
  'file_content_equals'
]);

const EVIDENCE_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'runId',
  'allocationPlanId',
  'allocationItemId',
  // The authority the evidence was produced under, as captured on the Run.
  'governedAuthorityHash',
  'completionAuthorityHash',
  // The admitted fact. For a typed postcondition these are equal by
  // construction — the verified-progress contract uses `criterionHash` as the
  // declared-fact identity — and the contract asserts that rather than assuming.
  'declaredFactIdentity',
  'criterionHash',
  'criterionType',
  'evaluatorIdentity',
  'evaluatorVersion',
  // THE BOUNDARY. Not a causal claim.
  //
  // `throughOperationReceiptId` says only "the evaluation occurred after this
  // committed receipt of this batch". The execution-time check reads cumulative
  // workspace state, so state from many receipts across many earlier windows
  // contributes to one verdict; naming any single receipt as the cause would be
  // false. It is NULL for a batch that committed no qualifying receipt, because
  // borrowing an unrelated earlier receipt as an anchor would be worse.
  //
  // Membership is validated relationally by `batchStepId` + `runId`, never by a
  // receipt id range: receipt ids are global and interleave across concurrent
  // Runs, so an ordered pair is not a batch.
  // baseline = the state before the first governed request; post_batch = a
  // deterministic evaluation after a committed batch. A baseline exists so a
  // later satisfied reading can be recognized as a TRANSITION rather than a
  // condition that was already true. It is never verified progress.
  'evaluationKind',
  'throughOperationReceiptId',
  'requestSourceIdentity',
  'batchStepId',
  'evaluatedReceiptCount',
  'logicalSourceIdentity',
  'observedEvidence',
  'satisfied',
  'evidenceHash'
]);

// Fields covered by the hash. `evidenceHash` excludes itself; `evidenceId` and
// `evaluatedAt` are assigned by the DATABASE and are therefore not part of the
// content identity — two evaluations of the same fact against the same receipt
// are the same evidence whatever their row id or instant.
const HASHED_FIELDS = Object.freeze(
  EVIDENCE_FIELDS.filter(field => field !== 'evidenceHash'));

const EVALUATION_KINDS = Object.freeze(['baseline', 'post_batch']);

const EVIDENCE_REFUSALS = Object.freeze([
  'postcondition_evidence_malformed',
  'postcondition_evidence_unsupported_evaluator',
  'postcondition_evidence_unsupported_criterion',
  'postcondition_evidence_identity_mismatch',
  'postcondition_evidence_boundary_invalid',
  'postcondition_evidence_batch_identity_missing',
  'postcondition_evidence_conflict',
  'postcondition_evidence_not_canonical'
]);

class GovernedPostconditionEvidenceError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedPostconditionEvidenceError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'GOVERNED_POSTCONDITION_EVIDENCE_INVALID', detail = {}) {
  throw new GovernedPostconditionEvidenceError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!EVIDENCE_REFUSALS.includes(reason)) {
    fail(`Unsupported evidence refusal: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_POSTCONDITION_EVIDENCE_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function requiredHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    refuse('postcondition_evidence_malformed',
      `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuse('postcondition_evidence_malformed',
      `${label} must be a positive safe integer`);
  }
  return value;
}

function boundedText(value, label, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    refuse('postcondition_evidence_malformed',
      `${label} must be a bounded non-empty string`);
  }
  return value;
}

// ── The canonical verdict ───────────────────────────────────────────────────
//
// A verdict is admissible only if it came from a recognized evaluator at a
// supported version AND states a boolean outcome. `passed: null` — which the
// canonical evaluator returns when it had no evidence to read — is NOT
// recordable: absence of evidence is absence of a row, which is a different and
// truthful statement from "unsatisfied".

function assertCanonicalVerdict(verdict, { evaluatorIdentity, evaluatorVersion }) {
  if (!isPlainObject(verdict)) {
    refuse('postcondition_evidence_not_canonical',
      'a canonical evaluator verdict object is required');
  }
  const supported = Object.prototype.hasOwnProperty.call(
    SUPPORTED_EVALUATORS, evaluatorIdentity)
    ? SUPPORTED_EVALUATORS[evaluatorIdentity]
    : null;
  if (!supported) {
    refuse('postcondition_evidence_unsupported_evaluator',
      `unrecognized evaluator: ${String(evaluatorIdentity)}`);
  }
  if (!supported.includes(evaluatorVersion)) {
    refuse('postcondition_evidence_unsupported_evaluator',
      `evaluator ${evaluatorIdentity} version ${String(evaluatorVersion)} is not supported`);
  }
  // The canonical evaluator names the authority it decided under. A verdict
  // that does not is not the canonical evaluator's output.
  if (verdict.authority !== evaluatorIdentity) {
    refuse('postcondition_evidence_not_canonical',
      'the verdict does not name the canonical evaluator authority');
  }
  if (typeof verdict.passed !== 'boolean') {
    refuse('postcondition_evidence_not_canonical',
      'a verdict without a boolean outcome is not evidence — ' +
      'absence of evidence must be absence of a row');
  }
  return verdict.passed;
}

// ── Build ───────────────────────────────────────────────────────────────────

function buildGovernedPostconditionEvidence({
  ticketId,
  runId,
  allocationPlanId,
  allocationItemId,
  governedAuthorityHash,
  completionAuthorityHash,
  declaredFactIdentity,
  criterionHash,
  criterionType,
  evaluatorIdentity,
  evaluatorVersion,
  evaluationKind = 'post_batch',
  throughOperationReceiptId = null,
  requestSourceIdentity = null,
  batchStepId = null,
  evaluatedReceiptCount = 0,
  logicalSourceIdentity = null,
  observedEvidence,
  // The verdict object produced by the canonical evaluator. There is
  // deliberately no `satisfied` parameter: a caller cannot assert satisfaction.
  verdict
}) {
  if (!SUPPORTED_CRITERION_TYPES.includes(criterionType)) {
    refuse('postcondition_evidence_unsupported_criterion',
      `criterion type ${String(criterionType)} cannot be deterministically evaluated`);
  }
  const identity = requiredHash(declaredFactIdentity, 'declaredFactIdentity');
  const criterion = requiredHash(criterionHash, 'criterionHash');
  // For a typed postcondition the verified-progress contract uses the criterion
  // hash AS the declared-fact identity. If those ever disagree the mapping
  // between the two authorities has drifted, and crediting progress against the
  // wrong identity is exactly the silent error to refuse.
  if (identity !== criterion) {
    refuse('postcondition_evidence_identity_mismatch',
      'the declared-fact identity must be the typed criterion hash');
  }
  if (!isPlainObject(observedEvidence)) {
    refuse('postcondition_evidence_malformed',
      'observedEvidence must be a normalized object');
  }
  const satisfied = assertCanonicalVerdict(verdict, {
    evaluatorIdentity, evaluatorVersion
  });
  const isBaseline = evaluationKind === 'baseline';
  if (isBaseline && (throughOperationReceiptId !== null || evaluatedReceiptCount !== 0 ||
      requestSourceIdentity !== null || batchStepId !== null)) {
    refuse('postcondition_evidence_boundary_invalid',
      'a baseline evaluation precedes every governed request and every receipt, ' +
      'so it carries no request, step, anchor or receipt count');
  }

  const fields = {
    version: GOVERNED_POSTCONDITION_EVIDENCE_VERSION,
    ticketId: positiveInteger(ticketId, 'ticketId'),
    runId: positiveInteger(runId, 'runId'),
    allocationPlanId: positiveInteger(allocationPlanId, 'allocationPlanId'),
    allocationItemId: positiveInteger(allocationItemId, 'allocationItemId'),
    governedAuthorityHash: requiredHash(governedAuthorityHash, 'governedAuthorityHash'),
    completionAuthorityHash: requiredHash(
      completionAuthorityHash, 'completionAuthorityHash'),
    declaredFactIdentity: identity,
    criterionHash: criterion,
    criterionType,
    evaluatorIdentity: boundedText(evaluatorIdentity, 'evaluatorIdentity', 128),
    evaluatorVersion: positiveInteger(evaluatorVersion, 'evaluatorVersion'),
    evaluationKind: (() => {
      if (!EVALUATION_KINDS.includes(evaluationKind)) {
        refuse('postcondition_evidence_malformed',
          `unsupported evaluation kind: ${String(evaluationKind)}`);
      }
      return evaluationKind;
    })(),
    // The ordering anchor. Absent for a baseline, which precedes every receipt.
    throughOperationReceiptId: throughOperationReceiptId === null ||
      throughOperationReceiptId === undefined
      ? null
      : positiveInteger(throughOperationReceiptId, 'throughOperationReceiptId'),
    // The batch identity. Required for a post-batch evaluation — evidence that
    // cannot say which governed request it belongs to cannot be assigned to an
    // observation window — and necessarily absent for a baseline, which happens
    // before any governed request exists.
    requestSourceIdentity: isBaseline
      ? null
      : boundedText(requestSourceIdentity, 'requestSourceIdentity'),
    batchStepId: isBaseline ? null : boundedText(batchStepId, 'batchStepId', 128),
    evaluatedReceiptCount: (() => {
      if (!Number.isSafeInteger(evaluatedReceiptCount) || evaluatedReceiptCount < 0) {
        refuse('postcondition_evidence_boundary_invalid',
          'evaluatedReceiptCount must be a non-negative safe integer');
      }
      return evaluatedReceiptCount;
    })(),
    logicalSourceIdentity: logicalSourceIdentity === null ||
      logicalSourceIdentity === undefined
      ? null
      : boundedText(logicalSourceIdentity, 'logicalSourceIdentity'),
    observedEvidence: deepFreeze(observedEvidence),
    satisfied,
    evidenceHash: null
  };
  // BOUNDARY COHERENCE, checked here as well as on read. The builder must not
  // be able to produce a record the normalizer would later refuse: an anchor
  // with no receipts, or receipts with no anchor, is a boundary that cannot be
  // validated against the durable rows it claims to follow.
  if (!isBaseline && (fields.throughOperationReceiptId !== null) !==
      (fields.evaluatedReceiptCount > 0)) {
    refuse('postcondition_evidence_boundary_invalid',
      'the through-receipt anchor and the evaluated receipt count disagree');
  }
  const withoutHash = {};
  for (const field of HASHED_FIELDS) withoutHash[field] = fields[field];
  fields.evidenceHash = hashCanonical(withoutHash);
  return deepFreeze(fields);
}

function normalizeGovernedPostconditionEvidence(value) {
  if (!isPlainObject(value)) {
    refuse('postcondition_evidence_malformed', 'evidence must be an object');
  }
  const unknown = Object.keys(value).filter(field => !EVIDENCE_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('postcondition_evidence_malformed',
      `evidence contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = EVIDENCE_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    refuse('postcondition_evidence_malformed',
      `evidence is missing field(s): ${missing.join(', ')}`);
  }
  if (value.version !== GOVERNED_POSTCONDITION_EVIDENCE_VERSION) {
    refuse('postcondition_evidence_malformed',
      `unsupported evidence version: ${String(value.version)}`);
  }
  if (typeof value.satisfied !== 'boolean') {
    refuse('postcondition_evidence_malformed', 'satisfied must be a boolean');
  }
  if (!SUPPORTED_CRITERION_TYPES.includes(value.criterionType)) {
    refuse('postcondition_evidence_unsupported_criterion',
      `unsupported criterion type: ${String(value.criterionType)}`);
  }
  const supported = Object.prototype.hasOwnProperty.call(
    SUPPORTED_EVALUATORS, value.evaluatorIdentity)
    ? SUPPORTED_EVALUATORS[value.evaluatorIdentity]
    : null;
  if (!supported || !supported.includes(value.evaluatorVersion)) {
    refuse('postcondition_evidence_unsupported_evaluator',
      `unsupported evaluator ${String(value.evaluatorIdentity)} ` +
      `version ${String(value.evaluatorVersion)}`);
  }
  if (value.declaredFactIdentity !== value.criterionHash) {
    refuse('postcondition_evidence_identity_mismatch',
      'the declared-fact identity must be the typed criterion hash');
  }
  if (!EVALUATION_KINDS.includes(value.evaluationKind)) {
    refuse('postcondition_evidence_malformed',
      `unsupported evaluation kind: ${String(value.evaluationKind)}`);
  }
  const baseline = value.evaluationKind === 'baseline';
  if (baseline) {
    // A baseline precedes every governed request and every receipt. Anything
    // else on it would be a claim about work that had not happened.
    if (value.requestSourceIdentity !== null || value.batchStepId !== null ||
        value.throughOperationReceiptId !== null || value.evaluatedReceiptCount !== 0) {
      refuse('postcondition_evidence_boundary_invalid',
        'a baseline carries no request, step, anchor or receipt count');
    }
    const withoutBaselineHash = {};
    for (const field of HASHED_FIELDS) withoutBaselineHash[field] = value[field];
    if (value.evidenceHash !== hashCanonical(withoutBaselineHash)) {
      refuse('postcondition_evidence_malformed',
        'the evidence hash does not cover its own fields');
    }
    const normalizedBaseline = {};
    for (const field of EVIDENCE_FIELDS) normalizedBaseline[field] = value[field];
    return deepFreeze(normalizedBaseline);
  }

  // BOUNDARY COHERENCE. The anchor and the count must tell the same story: an
  // anchor with no receipts, or receipts with no anchor, is a boundary that
  // cannot be checked against the durable rows it claims to follow.
  const hasAnchor = value.throughOperationReceiptId !== null &&
    value.throughOperationReceiptId !== undefined;
  if (hasAnchor &&
      (!Number.isSafeInteger(value.throughOperationReceiptId) ||
       value.throughOperationReceiptId < 1)) {
    refuse('postcondition_evidence_boundary_invalid',
      'the through-receipt anchor must be a positive receipt identity or absent');
  }
  if (!Number.isSafeInteger(value.evaluatedReceiptCount) ||
      value.evaluatedReceiptCount < 0) {
    refuse('postcondition_evidence_boundary_invalid',
      'evaluatedReceiptCount must be a non-negative safe integer');
  }
  if (hasAnchor !== (value.evaluatedReceiptCount > 0)) {
    refuse('postcondition_evidence_boundary_invalid',
      'the through-receipt anchor and the evaluated receipt count disagree');
  }
  // The batch identity is what assigns evidence to exactly one observation
  // window. Without it the row cannot be attributed at all.
  if (typeof value.requestSourceIdentity !== 'string' ||
      value.requestSourceIdentity.length === 0) {
    refuse('postcondition_evidence_batch_identity_missing',
      'evidence must name the governed request its evaluation belongs to');
  }
  if (typeof value.batchStepId !== 'string' || value.batchStepId.length === 0) {
    refuse('postcondition_evidence_batch_identity_missing',
      'evidence must name the execution step of the evaluated batch');
  }
  const withoutHash = {};
  for (const field of HASHED_FIELDS) withoutHash[field] = value[field];
  if (value.evidenceHash !== hashCanonical(withoutHash)) {
    refuse('postcondition_evidence_malformed',
      'the evidence hash does not cover its own fields');
  }
  const normalized = {};
  for (const field of EVIDENCE_FIELDS) normalized[field] = value[field];
  return deepFreeze(normalized);
}

// Two rows for the same (run, receipt, fact) must be the same evidence. A
// differing hash is a genuine conflict — one of them is wrong — and is refused
// rather than kept as a second opinion.
function assertEvidenceAgrees(stored, candidate) {
  const left = normalizeGovernedPostconditionEvidence(stored);
  const right = normalizeGovernedPostconditionEvidence(candidate);
  if (left.evidenceHash !== right.evidenceHash) {
    refuse('postcondition_evidence_conflict',
      `run ${left.runId} already holds different evidence for fact ` +
      `${left.declaredFactIdentity} in batch ${left.batchStepId}`);
  }
  return left;
}

// ── Satisfied-fact mapping ──────────────────────────────────────────────────
//
// Turns ordered evidence rows into the receipt-keyed mapping the progress
// evaluator consumes. Only SATISFIED evidence contributes; an unsatisfied
// evaluation is a durable fact that the work did not advance, not progress.
//
// Foreign evidence — another Run, item, or authority — is dropped here rather
// than credited. It is dropped rather than thrown because a Run legitimately
// shares a Ticket with siblings whose evidence it must simply not count.
// The store returns each row as `{ evidenceId, evaluatedAt, ...record }`. Those
// two are assigned by the DATABASE and are deliberately outside the hashed
// content record, so they are separated here rather than the closed schema being
// widened to tolerate them. Any OTHER unknown field still fails closed.
const DATABASE_ASSIGNED_FIELDS = Object.freeze(['evidenceId', 'evaluatedAt']);

function contentRecordOf(row) {
  if (!isPlainObject(row)) {
    refuse('postcondition_evidence_malformed', 'evidence row must be an object');
  }
  const record = {};
  for (const [key, value] of Object.entries(row)) {
    if (DATABASE_ASSIGNED_FIELDS.includes(key)) continue;
    record[key] = value;
  }
  return normalizeGovernedPostconditionEvidence(record);
}

function satisfiedFactIdentitiesByBatch(evidenceRows, {
  runId,
  allocationItemId,
  governedAuthorityHash,
  completionAuthorityHash
}) {
  const mapping = new Map();
  for (const row of evidenceRows || []) {
    const evidence = contentRecordOf(row);
    if (evidence.runId !== runId) continue;
    if (allocationItemId !== null && allocationItemId !== undefined &&
        evidence.allocationItemId !== allocationItemId) continue;
    if (governedAuthorityHash && evidence.governedAuthorityHash !== governedAuthorityHash) {
      continue;
    }
    if (completionAuthorityHash &&
        evidence.completionAuthorityHash !== completionAuthorityHash) {
      continue;
    }
    // A BASELINE IS NEVER PROGRESS. It records what was already true before the
    // Run did anything, which is the opposite of an advancement.
    if (evidence.evaluationKind === 'baseline') continue;
    if (!evidence.satisfied) continue;
    // Keyed by the BATCH, because that is what the evaluation was about. The
    // through-receipt anchor locates the batch in the receipt ordering; it is
    // not the thing the fact is attributed to.
    const key = evidence.batchStepId;
    const existing = mapping.get(key) || new Set();
    existing.add(evidence.declaredFactIdentity);
    mapping.set(key, existing);
  }
  const frozen = new Map();
  for (const [batchStepId, identities] of mapping) {
    frozen.set(batchStepId, deepFreeze([...identities].sort(compareCanonicalText)));
  }
  return frozen;
}

// The facts that were ALREADY satisfied before the Run did anything. A later
// satisfied reading of one of these is not a transition and must never be
// credited as verified progress.
function baselineSatisfiedFactIdentities(evidenceRows, { runId }) {
  const identities = new Set();
  for (const row of evidenceRows || []) {
    const evidence = contentRecordOf(row);
    if (evidence.runId !== runId) continue;
    if (evidence.evaluationKind !== 'baseline') continue;
    if (evidence.satisfied) identities.add(evidence.declaredFactIdentity);
  }
  return deepFreeze([...identities].sort(compareCanonicalText));
}

module.exports = {
  baselineSatisfiedFactIdentities,
  EVIDENCE_FIELDS,
  EVALUATION_KINDS,
  EVIDENCE_REFUSALS,
  GOVERNED_POSTCONDITION_EVIDENCE_VERSION,
  GovernedPostconditionEvidenceError,
  SUPPORTED_CRITERION_TYPES,
  SUPPORTED_EVALUATORS,
  DATABASE_ASSIGNED_FIELDS,
  assertEvidenceAgrees,
  buildGovernedPostconditionEvidence,
  contentRecordOf,
  normalizeGovernedPostconditionEvidence,
  refuseGovernedPostconditionEvidence: refuse,
  satisfiedFactIdentitiesByBatch
};
