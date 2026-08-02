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
  // The causal binding: evidence is about ONE committed receipt.
  'operationReceiptId',
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

const EVIDENCE_REFUSALS = Object.freeze([
  'postcondition_evidence_malformed',
  'postcondition_evidence_unsupported_evaluator',
  'postcondition_evidence_unsupported_criterion',
  'postcondition_evidence_identity_mismatch',
  'postcondition_evidence_causal_binding_missing',
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
  operationReceiptId,
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
    // Causal binding is required, never optional: evidence about no receipt is
    // evidence about nothing that happened.
    operationReceiptId: positiveInteger(operationReceiptId, 'operationReceiptId'),
    logicalSourceIdentity: logicalSourceIdentity === null ||
      logicalSourceIdentity === undefined
      ? null
      : boundedText(logicalSourceIdentity, 'logicalSourceIdentity'),
    observedEvidence: deepFreeze(observedEvidence),
    satisfied,
    evidenceHash: null
  };
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
  if (!Number.isSafeInteger(value.operationReceiptId) || value.operationReceiptId < 1) {
    refuse('postcondition_evidence_causal_binding_missing',
      'evidence must cite the committed operation receipt it is about');
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
      `${left.declaredFactIdentity} on receipt ${left.operationReceiptId}`);
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

function satisfiedFactIdentitiesByReceiptId(evidenceRows, {
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
    if (!evidence.satisfied) continue;
    const existing = mapping.get(evidence.operationReceiptId) || new Set();
    existing.add(evidence.declaredFactIdentity);
    mapping.set(evidence.operationReceiptId, existing);
  }
  const frozen = new Map();
  for (const [receiptId, identities] of mapping) {
    frozen.set(receiptId, deepFreeze([...identities].sort(compareCanonicalText)));
  }
  return frozen;
}

module.exports = {
  EVIDENCE_FIELDS,
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
  satisfiedFactIdentitiesByReceiptId
};
