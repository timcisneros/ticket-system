'use strict';

// T3 — Objective-revision kernel contract.
//
// SINGLE repository-owned authority for Ticket requested-outcome revision
// identity. It owns:
//
//   - canonical normalization of the requested-outcome content pair
//     {objective, acceptanceCriteria};
//   - the content hash that BINDS stored canonical content (a hash never
//     recovers unstored content — events/snapshots STORE content);
//   - provenance-specific validation of `ticket.objective_revised` events;
//   - the projection-pointer shape materialized in Ticket state;
//   - the pure revision-guard decision;
//   - the canonical identity register distinguishing this hash from the
//     declared-work / completion / generic-entity identities.
//
// Frozen semantics (T3 contract):
//   - objective: string -> trim -> non-empty. NO kernel maximum length;
//     subsystem limits (structured allocation, workflow-child proposals,
//     declared-work bounded text) remain subsystem-specific.
//   - acceptanceCriteria: absent ≡ null ≡ "" ≡ whitespace-only -> null;
//     otherwise trimmed string.
//   - provenances are mutually exclusive authorities:
//       creation               — the authorized Ticket-creation path itself
//       t3_activation_baseline — the one-time T3 activation migration
//       revision               — authenticated operator revision authority
//     Creation/baseline establish revision 1; only `revision` moves N -> N+1.

const crypto = require('node:crypto');
const {
  hashCanonical
} = require('./declared-work-contract');

const EVENT_TYPE = 'ticket.objective_revised';

const PROVENANCES = Object.freeze([
  'creation',
  't3_activation_baseline',
  'revision'
]);

const REASON_CODES = Object.freeze([
  'creation',
  'legacy_baseline',
  'clarification',
  'correction',
  'scope_note',
  'operator_directive'
]);

const ADMISSION_INTEGRITY_ERROR_CODE = 'TICKET_OBJECTIVE_REVISION_INTEGRITY';
const NOOP_ERROR_CODE = 'TICKET_OBJECTIVE_REVISION_NOOP';
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function boundedText(value, label, maximum) {
  if (typeof value !== 'string') fail('T3_OBJECTIVE_REVISION_INVALID', `${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail('T3_OBJECTIVE_REVISION_INVALID', `${label} must not be empty`);
  if (normalized.length > maximum) fail('T3_OBJECTIVE_REVISION_INVALID', `${label} exceeds ${maximum} characters`);
  return normalized;
}

// General Ticket-authority objective normalization: trim + non-empty.
// Deliberately NO maximum length here — general operator Ticket creation has
// none, and subsystem-specific limits stay in their subsystems.
function canonicalObjective(value) {
  if (typeof value !== 'string') {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'ticket objective must be a string');
  }
  const normalized = value.trim();
  if (!normalized) fail('T3_OBJECTIVE_REVISION_INVALID', 'ticket objective must not be empty');
  return normalized;
}

// Repository rule preserved exactly: absent ≡ null ≡ "" ≡ whitespace -> null
// (agent-run-draft admission capture and declared-work successCriteria both
// collapse these states today).
function canonicalAcceptanceCriteria(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'ticket acceptanceCriteria must be a string or null');
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function canonicalRevisionContent(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fail('T3_OBJECTIVE_REVISION_INVALID', 'revision content must be an object');
  return Object.freeze({
    objective: canonicalObjective(source.objective),
    acceptanceCriteria: canonicalAcceptanceCriteria(source.acceptanceCriteria)
  });
}

// Binds the canonical STORED content. Deterministic across key order.
function revisionContentHash(content) {
  return hashCanonical(canonicalRevisionContent(content));
}

function canonicalTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    fail('T3_OBJECTIVE_REVISION_INVALID', `${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function validatePointer(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fail('T3_OBJECTIVE_REVISION_INVALID', 'objectiveRevision pointer must be an object');
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== 'hash,number') {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'objectiveRevision pointer must hold exactly {number, hash}');
  }
  const number = source.number;
  if (!Number.isSafeInteger(number) || number < 1) {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'objectiveRevision pointer.number must be a positive safe integer');
  }
  if (typeof source.hash !== 'string' || !HASH_PATTERN.test(source.hash)) {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'objectiveRevision pointer.hash must be a lowercase SHA-256');
  }
  return Object.freeze({ number, hash: source.hash });
}

function validatePreviousPrevious(value, expectedNumber) {
  if (value === null || value === undefined) {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'revision events require a previous pointer');
  }
  const previous = validatePointer(value);
  if (previous.number !== expectedNumber) {
    fail('T3_OBJECTIVE_REVISION_INVALID',
      `revision previous.number must be ${expectedNumber}`);
  }
  return previous;
}

// Provenance-specific validation of one objective-revision event payload.
// Returns the normalized frozen payload. Hashes are verified AGAINST the
// stored canonical content (binding property).
function normalizeRevisionEventPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : fail('T3_OBJECTIVE_REVISION_INVALID', 'objective-revision event payload must be an object');
  const allowed = ['number', 'provenance', 'content', 'contentHash', 'previous', 'actor', 'reasonCode', 'reason', 'capturedAt'];
  const keys = Object.keys(source).sort();
  if (keys.join(',') !== [...allowed].sort().join(',')) {
    fail('T3_OBJECTIVE_REVISION_INVALID',
      `objective-revision event payload must hold exactly ${allowed.join(', ')}`);
  }
  const provenance = source.provenance;
  if (!PROVENANCES.includes(provenance)) {
    fail('T3_OBJECTIVE_REVISION_INVALID', `unknown objective-revision provenance: ${String(provenance)}`);
  }
  const content = canonicalRevisionContent(source.content);
  const contentHash = typeof source.contentHash === 'string' && HASH_PATTERN.test(source.contentHash)
    ? source.contentHash
    : fail('T3_OBJECTIVE_REVISION_INVALID', 'contentHash must be a lowercase SHA-256');
  if (contentHash !== revisionContentHash(content)) {
    fail('T3_OBJECTIVE_REVISION_INVALID', 'contentHash does not bind the stored canonical content');
  }
  const capturedAt = canonicalTimestamp(source.capturedAt, 'capturedAt');
  let number;
  let previous;
  if (provenance === 'creation' || provenance === 't3_activation_baseline') {
    number = source.number;
    if (!Number.isSafeInteger(number) || number !== 1) {
      fail('T3_OBJECTIVE_REVISION_INVALID', `${provenance} establishes revision 1`);
    }
    if (source.previous !== null && source.previous !== undefined) {
      fail('T3_OBJECTIVE_REVISION_INVALID', `${provenance} must not claim a previous revision`);
    }
    previous = null;
  } else {
    number = source.number;
    if (!Number.isSafeInteger(number) || number < 2) {
      fail('T3_OBJECTIVE_REVISION_INVALID', 'revision events start at number 2');
    }
    previous = validatePreviousPrevious(source.previous, number - 1);
  }
  const actor = boundedText(source.actor, 'actor', 200);
  let reasonCode;
  let reason;
  if (provenance === 'creation') {
    reasonCode = source.reasonCode === undefined || source.reasonCode === null
      ? 'creation'
      : source.reasonCode;
    if (reasonCode !== 'creation') {
      fail('T3_OBJECTIVE_REVISION_INVALID', 'creation events use reasonCode creation');
    }
    if (source.reason !== null && source.reason !== undefined) {
      fail('T3_OBJECTIVE_REVISION_INVALID', 'creation events must not fabricate a human reason');
    }
    reason = null;
  } else if (provenance === 't3_activation_baseline') {
    if (source.reasonCode !== 'legacy_baseline') {
      fail('T3_OBJECTIVE_REVISION_INVALID', 'baseline events use reasonCode legacy_baseline');
    }
    reasonCode = source.reasonCode;
    if (source.reason !== null && source.reason !== undefined) {
      fail('T3_OBJECTIVE_REVISION_INVALID', 'baseline events must not fabricate a human reason');
    }
    reason = null;
  } else {
    reasonCode = boundedText(source.reasonCode, 'reasonCode', 64);
    if (!REASON_CODES.includes(reasonCode)) {
      fail('T3_OBJECTIVE_REVISION_INVALID', `unsupported revision reasonCode: ${reasonCode}`);
    }
    reason = boundedText(source.reason, 'reason', 2000);
  }
  return Object.freeze({
    number,
    provenance,
    content,
    contentHash,
    previous,
    actor,
    reasonCode,
    reason,
    capturedAt
  });
}

function rejectUnexpectedBuilderKeys(source, allowed) {
  const keys = Object.keys(source || {}).filter(key => !allowed.includes(key));
  if (keys.length > 0) {
    fail('T3_OBJECTIVE_REVISION_INVALID',
      `unexpected objective-revision builder input: ${keys.join(', ')}`);
  }
}

function buildCreationRevisionPayload(source = {}) {
  rejectUnexpectedBuilderKeys(source, [
    'objective', 'acceptanceCriteria', 'actor', 'capturedAt'
  ]);
  return normalizeRevisionEventPayload({
    number: 1,
    provenance: 'creation',
    content: canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    }),
    contentHash: revisionContentHash(canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    })),
    previous: null,
    actor: source.actor,
    reasonCode: 'creation',
    reason: null,
    capturedAt: source.capturedAt
  });
}

function buildActivationBaselinePayload(source = {}) {
  rejectUnexpectedBuilderKeys(source, [
    'objective', 'acceptanceCriteria', 'actor', 'capturedAt'
  ]);
  return normalizeRevisionEventPayload({
    number: 1,
    provenance: 't3_activation_baseline',
    content: canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    }),
    contentHash: revisionContentHash(canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    })),
    previous: null,
    actor: source.actor,
    reasonCode: 'legacy_baseline',
    reason: null,
    capturedAt: source.capturedAt
  });
}

function buildRevisionPayload(source = {}) {
  rejectUnexpectedBuilderKeys(source, [
    'number', 'previous', 'objective', 'acceptanceCriteria',
    'actor', 'reasonCode', 'reason', 'capturedAt'
  ]);
  return normalizeRevisionEventPayload({
    number: source.number,
    provenance: 'revision',
    content: canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    }),
    contentHash: revisionContentHash(canonicalRevisionContent({
      objective: source.objective,
      acceptanceCriteria: source.acceptanceCriteria
    })),
    previous: source.previous,
    actor: source.actor,
    reasonCode: source.reasonCode,
    reason: source.reason,
    capturedAt: source.capturedAt
  });
}

// Pure guard decision for N -> N+1 revision. The store supplies database
// facts; this function owns the frozen policy so tests can exhaust it.
// Lifecycle status is NEVER changed by revision; blockers are NEVER cleared.
function evaluateRevisionGuards({
  status,
  hasUnsettledAttempt,
  cancellationCommitted,
  hasStructuredAllocationAuthority,
  expectedGenericRevisionMatches,
  chainCoherent,
  canonicalNoOp
}) {
  if (!expectedGenericRevisionMatches) {
    return Object.freeze({ ok: false, code: 'TICKET_TRANSITION_CONFLICT' });
  }
  if (cancellationCommitted) {
    return Object.freeze({ ok: false, code: 'TICKET_CANCELLATION_COMMITTED' });
  }
  // The unsettled-attempt refusal is reported BEFORE the status refusal so
  // the specific cause (an in-flight attempt spans the revision) is visible
  // even though such a Ticket is necessarily non-open/blocked.
  if (hasUnsettledAttempt) {
    return Object.freeze({ ok: false, code: 'TICKET_ATTEMPT_UNSETTLED' });
  }
  if (!['open', 'blocked'].includes(status)) {
    return Object.freeze({ ok: false, code: 'TICKET_OBJECTIVE_REVISION_STATE_INVALID' });
  }
  if (hasStructuredAllocationAuthority) {
    return Object.freeze({ ok: false, code: 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE' });
  }
  if (!chainCoherent) {
    return Object.freeze({ ok: false, code: ADMISSION_INTEGRITY_ERROR_CODE });
  }
  if (canonicalNoOp) {
    return Object.freeze({ ok: false, code: NOOP_ERROR_CODE });
  }
  return Object.freeze({ ok: true });
}

// Canonical distinction register. These identities represent REAL, DISTINCT
// concepts; they must never be merged nor silently redefined.
const IDENTITY_REGISTER = Object.freeze({
  OBJECTIVE_REVISION_CONTENT_HASH: Object.freeze({
    binds: 'canonical Ticket requested-outcome content {objective, acceptanceCriteria}',
    scope: 'Ticket-level intent-history identity',
    owner: 'runtime/ticket-objective-revision-contract.js'
  }),
  DECLARED_WORK_CONTRACT_HASH: Object.freeze({
    binds: 'admitted Run declared-work structure (objective text, expected outputs, success criteria, evidence requirements)',
    scope: 'Run execution-work contract identity',
    owner: 'runtime/declared-work-contract.js'
  }),
  COMPLETION_OBJECTIVE_HASH: Object.freeze({
    binds: 'sha256 of the raw objective string captured in the Run completion-authority objectiveContract',
    scope: 'existing completion-contract identity — semantics PRESERVED, never redefined by T3',
    owner: 'runtime/completion-decision-contract.js'
  }),
  GENERIC_TICKET_REVISION: Object.freeze({
    binds: 'nothing semantic — generic optimistic/write-serialization counter advanced by lifecycle-visible Ticket transitions',
    scope: 'NOT an objective identity',
    owner: 'persistence/postgres/store.js'
  }),
  TICKET_ATTEMPT_IDENTITY: Object.freeze({
    binds: 'execution-attempt membership/ordinal identity',
    scope: 'NOT an objective identity',
    owner: 'persistence/postgres/store.js'
  }),
  ALLOCATION_PLAN_IDENTITY: Object.freeze({
    binds: 'planning/delegation artifact identity (plan id / planHash / version)',
    scope: 'structured allocation artifact identity',
    owner: 'runtime/allocation-plan-contract.js'
  })
});

module.exports = {
  EVENT_TYPE,
  PROVENANCES,
  REASON_CODES,
  ADMISSION_INTEGRITY_ERROR_CODE,
  NOOP_ERROR_CODE,
  canonicalObjective,
  canonicalAcceptanceCriteria,
  canonicalRevisionContent,
  revisionContentHash,
  normalizeRevisionEventPayload,
  buildCreationRevisionPayload,
  buildActivationBaselinePayload,
  buildRevisionPayload,
  validatePointer,
  evaluateRevisionGuards,
  IDENTITY_REGISTER,
  hashCanonical
};
