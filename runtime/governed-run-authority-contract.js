'use strict';

// Tranche 4 — governed authority captured on a structured leaf Run.
//
// STORAGE DECISION. This is an optional closed envelope inside the existing
// Run JSONB body, not a relational migration. The Run body already carries
// exactly this kind of immutable hash-verified snapshot — `declaredWorkSnapshot`,
// `completionAuthoritySnapshot`, `leafRunBinding` — and reconstruction is a
// spread of the stored body, so a historical Run that omits the key remains
// byte-identical to what it always was. Columns would add no durability the
// body lacks and no fail-closed behaviour a normalizer cannot provide, so the
// authority's importance alone does not justify one.
//
// DEVELOPMENT CUTOVER. Tranche 4 is a cutover, not a compatibility layer.
// Pre-cutover structured execution data is disposable and is removed by the
// canonical development reset. There is no permanent runtime category called
// "historical structured execution".
//
// THE BINDING AND THE AUTHORITY ARE INSEPARABLE. A Run carrying
// `leafRunBinding` is a structured leaf Run, and a structured leaf Run without
// complete governed authority has nothing bounding what it may spend. That is
// an integrity failure, not an older and simpler kind of Run.
//
// Four combinations. Only the first two are supported:
//
//   no binding + no envelope       -> non-structured execution family
//   binding    + complete envelope -> supported structured leaf execution
//   binding    + absent/partial    -> INTEGRITY FAILURE
//   no binding + envelope present  -> INTEGRITY FAILURE
//
// Age is consulted nowhere — not timestamps, not migration numbers, not IDs. A
// record's vintage never excuses a malformed combination: the admission path is
// what guarantees completeness, and a record that missed it is invalid rather
// than grandfathered.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');
const { normalizeRoleRoutingDecision } = require('./role-routing-contract');
const { normalizeEconomicAuthority } = require('./economic-authority-contract');

const GOVERNED_RUN_AUTHORITY_VERSION = 1;
const WORKER_ROLE = 'structured_leaf_executor';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const GOVERNED_RUN_AUTHORITY_FIELDS = Object.freeze([
  'version',
  'role',
  // The three independently hashed administrator documents, as captured.
  'roleRoutingPolicyHash',
  'economicPolicyHash',
  'pricingCatalogHash',
  // The complete immutable decisions, retained rather than merely hashed, so a
  // request can be prepared after a restart without consulting current policy.
  'routingDecision',
  'economicAuthority',
  // The exact rates this Run's requests will be priced and settled against.
  // Retained here for the same reason the reservation retains them: settlement
  // happens later, possibly after the catalog has been re-priced or deleted.
  'pricingEntry',
  // Where this Run's money comes from. Shared with every sibling leaf Run.
  'economicAccountId',
  // Binding to the exact Run and allocation item this authority was captured
  // for, so an envelope cannot be transplanted onto another Run.
  'ticketId',
  'runId',
  'allocationItemId',
  'capturedAt',
  'governedExecutionHash'
]);

const GOVERNED_RUN_REFUSALS = Object.freeze([
  'governed_run_authority_malformed',
  'governed_run_authority_partial',
  // Shape violations rather than content defects: a structured leaf Run with no
  // authority at all, or governed authority on a Run that is not a leaf.
  'governed_run_binding_authority_mismatch',
  'governed_run_role_mismatch',
  'governed_run_binding_mismatch',
  'governed_run_route_mismatch',
  'governed_run_account_mismatch'
]);

class GovernedRunAuthorityError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedRunAuthorityError';
    this.code = code;
    this.detail = detail;
  }
}

function fail(message, code = 'GOVERNED_RUN_AUTHORITY_INVALID', detail = {}) {
  throw new GovernedRunAuthorityError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!GOVERNED_RUN_REFUSALS.includes(reason)) {
    fail(`Unsupported governed run refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_RUN_AUTHORITY_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    refuse('governed_run_authority_malformed', `${label} must be a lowercase SHA-256`);
  }
  return value;
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    refuse('governed_run_authority_malformed', `${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string') {
    refuse('governed_run_authority_malformed', `${label} must be an ISO timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    refuse('governed_run_authority_malformed', `${label} must be a canonical ISO timestamp`);
  }
  return value;
}

// The captured entry is trusted only after it hashes to the identity the
// authority recorded, so a re-priced or substituted entry cannot be stored.
function assertCapturedPricingEntry(pricingEntry, authority) {
  if (!isPlainObject(pricingEntry)) {
    refuse('governed_run_authority_malformed', 'pricingEntry must be an object');
  }
  if (hashCanonical(pricingEntry) !== authority.pricingEntryHash) {
    refuse('governed_run_route_mismatch',
      'the captured pricing entry does not match the authority pricing entry hash');
  }
  return deepFreeze({ ...pricingEntry });
}

function hashEnvelope(fields) {
  const payload = {};
  for (const field of GOVERNED_RUN_AUTHORITY_FIELDS) {
    if (field === 'governedExecutionHash') continue;
    payload[field] = fields[field];
  }
  return hashCanonical(payload);
}

// ── Build ───────────────────────────────────────────────────────────────────

function buildGovernedRunAuthority({
  policySource,
  routingDecision,
  economicAuthority,
  pricingEntry,
  economicAccountId,
  ticketId,
  runId,
  allocationItemId,
  capturedAt
}) {
  const decision = normalizeRoleRoutingDecision(routingDecision);
  const authority = normalizeEconomicAuthority(economicAuthority);

  if (decision.role !== WORKER_ROLE || authority.role !== WORKER_ROLE) {
    refuse('governed_run_role_mismatch',
      `a leaf Run authority must be captured for ${WORKER_ROLE}`);
  }
  // The planner's route is never a worker route, and this is where a
  // substitution would be caught: the planner captures a planning_attempt
  // subject, a worker captures a run subject.
  if (decision.subjectKind !== 'run' || authority.subjectKind !== 'run') {
    refuse('governed_run_role_mismatch',
      'a leaf Run authority must be captured against a run subject');
  }
  if (authority.routingDecisionHash !== decision.decisionHash) {
    refuse('governed_run_route_mismatch',
      'the economic authority does not bind this routing decision');
  }
  if (decision.ticketId !== ticketId || authority.ticketId !== ticketId) {
    refuse('governed_run_binding_mismatch',
      'the captured authority names a different ticket');
  }
  // The routing decision names its subject as (subjectKind, subjectId); the
  // economic authority resolves that into `runId`. Both must name THIS Run.
  if (authority.runId !== runId || Number(decision.subjectId) !== runId) {
    refuse('governed_run_binding_mismatch',
      'the captured authority names a different run');
  }

  const fields = {
    version: GOVERNED_RUN_AUTHORITY_VERSION,
    role: WORKER_ROLE,
    roleRoutingPolicyHash: hash(
      policySource.roleRoutingPolicyHash, 'roleRoutingPolicyHash'),
    economicPolicyHash: hash(policySource.economicPolicyHash, 'economicPolicyHash'),
    pricingCatalogHash: hash(policySource.pricingCatalogHash, 'pricingCatalogHash'),
    routingDecision: decision,
    economicAuthority: authority,
    pricingEntry: assertCapturedPricingEntry(pricingEntry, authority),
    economicAccountId: positiveSafeInteger(economicAccountId, 'economicAccountId'),
    ticketId: positiveSafeInteger(ticketId, 'ticketId'),
    runId: positiveSafeInteger(runId, 'runId'),
    allocationItemId: positiveSafeInteger(allocationItemId, 'allocationItemId'),
    capturedAt: timestamp(capturedAt, 'capturedAt'),
    governedExecutionHash: null
  };
  fields.governedExecutionHash = hashEnvelope(fields);
  return deepFreeze(fields);
}

// ── Normalize ───────────────────────────────────────────────────────────────
//
// The partial case is deliberately indistinguishable from the malformed case in
// outcome: both refuse. What must never happen is a partial envelope being read
// as an absent one.

function normalizeGovernedRunAuthority(value, {
  expectedRunId = null,
  expectedTicketId = null,
  expectedAllocationItemId = null,
  expectedAccountId = null
} = {}) {
  if (!isPlainObject(value)) {
    refuse('governed_run_authority_malformed', 'governedExecution must be an object');
  }
  const unknown = Object.keys(value).filter(
    field => !GOVERNED_RUN_AUTHORITY_FIELDS.includes(field));
  if (unknown.length > 0) {
    refuse('governed_run_authority_malformed',
      `governedExecution contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const missing = GOVERNED_RUN_AUTHORITY_FIELDS.filter(
    field => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    // The whole point of this contract: half an authority is not authority.
    refuse('governed_run_authority_partial',
      `governedExecution is missing field(s): ${missing.join(', ')}`);
  }
  if (value.version !== GOVERNED_RUN_AUTHORITY_VERSION) {
    refuse('governed_run_authority_malformed',
      `unsupported governedExecution version: ${String(value.version)}`);
  }
  if (value.role !== WORKER_ROLE) {
    refuse('governed_run_role_mismatch',
      `governedExecution.role must be ${WORKER_ROLE}`);
  }

  const decision = normalizeRoleRoutingDecision(value.routingDecision);
  const authority = normalizeEconomicAuthority(value.economicAuthority);
  assertCapturedPricingEntry(value.pricingEntry, authority);
  if (authority.routingDecisionHash !== decision.decisionHash) {
    refuse('governed_run_route_mismatch',
      'the stored economic authority does not bind the stored routing decision');
  }
  // The immutable target must still be the one the authority priced.
  if (authority.dispatchTarget !== decision.dispatchTarget ||
      authority.targetEvidenceHash !== decision.targetEvidenceHash) {
    refuse('governed_run_route_mismatch',
      'the stored authority and routing decision name different dispatch targets');
  }

  const normalized = {};
  for (const field of GOVERNED_RUN_AUTHORITY_FIELDS) normalized[field] = value[field];
  normalized.routingDecision = decision;
  normalized.economicAuthority = authority;

  const expectedHash = hashEnvelope(normalized);
  if (value.governedExecutionHash !== expectedHash) {
    refuse('governed_run_authority_malformed',
      'governedExecution does not hash its own captured fields');
  }

  for (const [label, expected, actual] of [
    ['run', expectedRunId, normalized.runId],
    ['ticket', expectedTicketId, normalized.ticketId],
    ['allocation item', expectedAllocationItemId, normalized.allocationItemId],
    ['economic account', expectedAccountId, normalized.economicAccountId]
  ]) {
    if (expected !== null && expected !== undefined && expected !== actual) {
      refuse('governed_run_binding_mismatch',
        `governedExecution names ${label} ${actual}, not ${expected}`);
    }
  }
  if (normalized.economicAuthority.runId !== normalized.runId) {
    refuse('governed_run_binding_mismatch',
      'the stored economic authority names a different run');
  }

  return deepFreeze(normalized);
}

// The one place that decides which of the three states a Run is in. Callers use
// this rather than testing the key themselves, so no path can accidentally read
// a partial envelope as absent.
function classifyRunGovernance(run, options = {}) {
  const hasBinding = Boolean(run && run.leafRunBinding);
  const hasEnvelope = Boolean(run &&
    Object.prototype.hasOwnProperty.call(run, 'governedExecution') &&
    run.governedExecution !== undefined && run.governedExecution !== null);

  if (!hasEnvelope) {
    if (hasBinding) {
      refuse('governed_run_binding_authority_mismatch',
        `run ${run && run.id} carries a leaf binding with no governed authority`);
    }
    // Neither field: an ordinary non-structured Run — direct, v1, workflow,
    // browser, process, simulation or compiler — untouched by Tranche 4.
    return { governed: false, authority: null, structured: false };
  }
  if (!hasBinding) {
    refuse('governed_run_binding_authority_mismatch',
      `run ${run && run.id} carries governed authority with no leaf binding`);
  }
  // Any defect here throws. It does NOT degrade to historical.
  const authority = normalizeGovernedRunAuthority(run.governedExecution, {
    expectedRunId: run.id === undefined ? null : run.id,
    expectedTicketId: run.ticketId === undefined ? null : run.ticketId,
    ...options
  });
  return { governed: true, authority, structured: true };
}

// THE canonical pairing rule. Every authority boundary calls this one function
// so no call site can drift into a slightly different definition of what a
// valid structured Run is.
function assertRunGovernedExecutionPairing(run, label = 'run governed execution') {
  try {
    classifyRunGovernance(run);
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
  return run;
}

module.exports = {
  assertRunGovernedExecutionPairing,
  GOVERNED_RUN_AUTHORITY_FIELDS,
  GOVERNED_RUN_AUTHORITY_VERSION,
  GOVERNED_RUN_REFUSALS,
  GovernedRunAuthorityError,
  WORKER_ROLE,
  buildGovernedRunAuthority,
  classifyRunGovernance,
  normalizeGovernedRunAuthority,
  refuseGovernedRun: refuse
};
