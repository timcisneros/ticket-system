'use strict';

// Tranche 4 — the exact prepared provider request.
//
// A governed dispatch reserves money against SPECIFIC BYTES. If the bytes that
// reach the provider are not the bytes that were priced and reserved, the
// reservation bounded nothing. This contract exists to make that impossible:
// the body is serialized EXACTLY ONCE, the serialized text is what gets hashed,
// and the transport later sends that stored text verbatim rather than
// re-stringifying an object.
//
// Re-serialization is the whole hazard. `JSON.stringify` is not guaranteed to
// be stable across engine versions or object mutation, and a body rebuilt after
// reservation can differ in field order, in a nested default, or in the output
// cap itself. Normalization therefore re-derives the hash from the stored text
// and re-parses that text back to the stored canonical body, so any divergence
// between "what we priced" and "what we would send" fails closed.
//
// It performs no I/O and issues no dispatch.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical,
  canonicalJson
} = require('./declared-work-contract');
const crypto = require('crypto');
const {
  CANONICAL_ROLES,
  normalizeRoleRoutingDecision
} = require('./role-routing-contract');
const {
  normalizeEconomicAuthority
} = require('./economic-authority-contract');
const {
  assertGovernedOutputCapSerialized
} = require('./provider-adapter-capability');

const PREPARED_REQUEST_VERSION = 1;

const PREPARED_REQUEST_FIELDS = Object.freeze([
  'version',
  'ticketId',
  'role',
  'subjectKind',
  'planningAttemptId',
  'runId',
  'modelRequestOrdinal',
  'routingDecisionHash',
  'economicAuthorityHash',
  'adapterId',
  'provider',
  'dispatchTarget',
  'targetEvidenceHash',
  'endpointIdentity',
  'canonicalBody',
  // The exact text that will be sent. Not a description of it.
  'serializedRequest',
  'serializedByteCount',
  'requestHash',
  'authorizedOutputTokens',
  'truncationMode',
  'adapterCapabilityHash',
  'modelCapabilityHash',
  'pricingEntryHash',
  'maximumLiabilityMicroUsd',
  'preparedAt',
  'preparedRequestHash'
]);

const PREPARED_REQUEST_REFUSALS = Object.freeze([
  'prepared_request_subject_invalid',
  'prepared_request_authority_mismatch',
  'prepared_request_route_mismatch',
  'prepared_request_bytes_mismatch',
  'prepared_request_ordinal_exceeded',
  'prepared_request_output_cap_exceeded',
  'prepared_request_liability_exceeded',
  'prepared_request_output_cap_not_serialized'
]);

const SUBJECT_KINDS = Object.freeze(['planning_attempt', 'run']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class GovernedRequestError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'GovernedRequestError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'GOVERNED_REQUEST_INVALID', detail = {}) {
  throw new GovernedRequestError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!PREPARED_REQUEST_REFUSALS.includes(reason)) {
    fail(`Unsupported prepared-request refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'GOVERNED_REQUEST_REFUSED', { reason });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactFields(value, fields, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(field => !fields.includes(field));
  const missing = fields.filter(field => !Object.prototype.hasOwnProperty.call(value, field));
  if (unknown.length > 0) {
    fail(`${label} contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  if (missing.length > 0) fail(`${label} is missing field(s): ${missing.join(', ')}`);
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requiredText(value, label, maximum = 512) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (!text) fail(`${label} must not be empty`);
  if (text.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return text;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function nullableHash(value, label) {
  return value === null ? null : hash(value, label);
}

function timestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be an ISO timestamp`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

// The hash of the EXACT bytes, computed from the serialized text rather than
// from an object, so it describes what will actually be transmitted.
function hashSerializedRequest(serializedRequest) {
  return crypto.createHash('sha256')
    .update(Buffer.from(serializedRequest, 'utf8'))
    .digest('hex');
}

// ── Preparation ─────────────────────────────────────────────────────────────

function prepareGovernedProviderRequest({
  routingDecision,
  economicAuthority,
  modelRequestOrdinal,
  endpointIdentity,
  canonicalBody,
  authorizedOutputTokens,
  truncationMode = null,
  pricingEntryHash,
  maximumLiabilityMicroUsd,
  preparedAt
}) {
  const decision = normalizeRoleRoutingDecision(routingDecision);
  const authority = normalizeEconomicAuthority(economicAuthority);

  // The authority must describe THIS route. A prepared request assembled from a
  // mismatched pair would price one route and dispatch another.
  if (authority.routingDecisionHash !== decision.decisionHash) {
    refuse('prepared_request_authority_mismatch',
      'economic authority does not bind this routing decision');
  }
  for (const field of ['ticketId', 'role', 'provider', 'adapterId', 'dispatchTarget',
    'targetEvidenceHash']) {
    if (authority[field] !== decision[field]) {
      refuse('prepared_request_route_mismatch',
        `economic authority ${field} disagrees with its routing decision`);
    }
  }
  if (!CANONICAL_ROLES.includes(decision.role)) {
    refuse('prepared_request_subject_invalid', `unsupported role ${String(decision.role)}`);
  }

  // Exactly one subject, matching the role, and matching the authority.
  const subjectKind = decision.subjectKind;
  if (!SUBJECT_KINDS.includes(subjectKind)) {
    refuse('prepared_request_subject_invalid', 'unsupported subject kind');
  }
  const expectedKind = decision.role === 'structured_planner' ? 'planning_attempt' : 'run';
  if (subjectKind !== expectedKind || authority.subjectKind !== expectedKind) {
    refuse('prepared_request_subject_invalid',
      `${decision.role} requires a ${expectedKind} subject`);
  }
  const planningAttemptId = subjectKind === 'planning_attempt'
    ? (UUID_PATTERN.test(String(authority.planningAttemptId))
      ? String(authority.planningAttemptId)
      : refuse('prepared_request_subject_invalid', 'planningAttemptId must be a lowercase UUID'))
    : null;
  const runId = subjectKind === 'run'
    ? positiveSafeInteger(authority.runId, 'preparedRequest.runId')
    : null;

  const ordinal = positiveSafeInteger(modelRequestOrdinal, 'preparedRequest.modelRequestOrdinal');
  // A request beyond the authorized count has no authority behind it.
  if (ordinal > authority.maximumProviderRequests) {
    refuse('prepared_request_ordinal_exceeded',
      `request ordinal ${ordinal} exceeds the authorized ` +
      `${authority.maximumProviderRequests} provider requests`);
  }
  const outputTokens = positiveSafeInteger(
    authorizedOutputTokens,
    'preparedRequest.authorizedOutputTokens'
  );
  if (outputTokens > authority.maximumOutputTokensPerRequest) {
    refuse('prepared_request_output_cap_exceeded',
      `output cap ${outputTokens} exceeds the authorized ` +
      `${authority.maximumOutputTokensPerRequest}`);
  }
  const liability = nonNegativeSafeInteger(
    maximumLiabilityMicroUsd,
    'preparedRequest.maximumLiabilityMicroUsd'
  );
  if (liability > authority.maximumPerRequestMicroUsd) {
    refuse('prepared_request_liability_exceeded',
      `request liability ${liability} exceeds the authorized per-request ` +
      `${authority.maximumPerRequestMicroUsd}`);
  }
  if (liability > authority.maximumTotalMicroUsd) {
    refuse('prepared_request_liability_exceeded',
      'request liability exceeds the total authorization');
  }

  if (!isPlainObject(canonicalBody)) fail('preparedRequest.canonicalBody must be an object');
  // The body must carry the authorized cap, physically, before it is frozen.
  // A zero-priced route is held to exactly the same standard: its liability is
  // zero, but its bytes and ceilings are still governed.
  assertGovernedOutputCapSerialized(decision.adapterId, canonicalBody, outputTokens);

  // SERIALIZE EXACTLY ONCE. Everything downstream derives from this string.
  const serializedRequest = canonicalJson(canonicalBody);
  const serializedByteCount = Buffer.byteLength(serializedRequest, 'utf8');
  const requestHash = hashSerializedRequest(serializedRequest);

  const withoutHash = {
    version: PREPARED_REQUEST_VERSION,
    ticketId: positiveSafeInteger(decision.ticketId, 'preparedRequest.ticketId'),
    role: decision.role,
    subjectKind,
    planningAttemptId,
    runId,
    modelRequestOrdinal: ordinal,
    routingDecisionHash: decision.decisionHash,
    economicAuthorityHash: authority.authorityHash,
    adapterId: decision.adapterId,
    provider: decision.provider,
    dispatchTarget: decision.dispatchTarget,
    targetEvidenceHash: decision.targetEvidenceHash,
    endpointIdentity: requiredText(endpointIdentity, 'preparedRequest.endpointIdentity'),
    canonicalBody: JSON.parse(serializedRequest),
    serializedRequest,
    serializedByteCount,
    requestHash,
    authorizedOutputTokens: outputTokens,
    truncationMode: truncationMode === null
      ? null
      : requiredText(truncationMode, 'preparedRequest.truncationMode', 64),
    adapterCapabilityHash: authority.adapterCapabilityHash,
    modelCapabilityHash: nullableHash(
      authority.modelCapabilityHash,
      'preparedRequest.modelCapabilityHash'
    ),
    pricingEntryHash: hash(pricingEntryHash, 'preparedRequest.pricingEntryHash'),
    maximumLiabilityMicroUsd: liability,
    preparedAt: timestamp(preparedAt, 'preparedRequest.preparedAt')
  };
  return deepFreeze({ ...withoutHash, preparedRequestHash: hashCanonical(withoutHash) });
}

// Re-verification. This is what a reservation and a dispatch both call, and it
// is deliberately paranoid about the one thing that matters: the stored text.
function normalizeGovernedProviderRequest(value, {
  expectedRoutingDecisionHash = null,
  expectedEconomicAuthorityHash = null,
  expectedRequestHash = null
} = {}) {
  exactFields(value, PREPARED_REQUEST_FIELDS, 'preparedRequest');
  if (value.version !== PREPARED_REQUEST_VERSION) {
    fail(`preparedRequest.version must be ${PREPARED_REQUEST_VERSION}`);
  }
  const preparedRequestHash = hash(value.preparedRequestHash, 'preparedRequest.preparedRequestHash');
  const withoutHash = Object.fromEntries(
    PREPARED_REQUEST_FIELDS.filter(field => field !== 'preparedRequestHash')
      .map(field => [field, value[field]])
  );
  if (hashCanonical(withoutHash) !== preparedRequestHash) {
    fail('preparedRequest.preparedRequestHash does not match its captured facts',
      'GOVERNED_REQUEST_CONFLICT');
  }

  // The stored text is the authority. Both directions are checked: the bytes
  // must hash to the stored request hash, AND must parse back to the stored
  // canonical body. Either check alone would leave a gap.
  const serializedRequest = value.serializedRequest;
  if (typeof serializedRequest !== 'string' || serializedRequest.length === 0) {
    refuse('prepared_request_bytes_mismatch', 'preparedRequest.serializedRequest is missing');
  }
  if (hashSerializedRequest(serializedRequest) !== value.requestHash) {
    refuse('prepared_request_bytes_mismatch',
      'the serialized request does not hash to its recorded request hash');
  }
  if (Buffer.byteLength(serializedRequest, 'utf8') !== value.serializedByteCount) {
    refuse('prepared_request_bytes_mismatch',
      'the serialized request byte count does not match');
  }
  let parsed;
  try {
    parsed = JSON.parse(serializedRequest);
  } catch (_) {
    refuse('prepared_request_bytes_mismatch', 'the serialized request is not valid JSON');
  }
  if (canonicalJson(parsed) !== canonicalJson(value.canonicalBody)) {
    refuse('prepared_request_bytes_mismatch',
      'the serialized request does not parse to its recorded canonical body');
  }
  // The cap and target inside the bytes must still be the governed ones, so a
  // body edited after preparation cannot be dispatched.
  assertGovernedOutputCapSerialized(value.adapterId, parsed, value.authorizedOutputTokens);
  if (parsed.model !== value.dispatchTarget) {
    refuse('prepared_request_bytes_mismatch',
      `the serialized request targets ${String(parsed.model)}, not ${value.dispatchTarget}`);
  }

  const expectations = [
    ['routingDecisionHash', expectedRoutingDecisionHash],
    ['economicAuthorityHash', expectedEconomicAuthorityHash],
    ['requestHash', expectedRequestHash]
  ];
  for (const [field, expected] of expectations) {
    if (expected === null) continue;
    if (value[field] !== expected) {
      refuse('prepared_request_authority_mismatch',
        `preparedRequest.${field} does not identify its authority`);
    }
  }
  return deepFreeze({ ...withoutHash, preparedRequestHash });
}

// The bytes a governed transport must send. Deliberately the ONLY accessor, so
// no caller can reach for the object and re-stringify it.
function governedRequestBytes(preparedRequest) {
  const verified = normalizeGovernedProviderRequest(preparedRequest);
  return deepFreeze({
    endpointIdentity: verified.endpointIdentity,
    adapterId: verified.adapterId,
    provider: verified.provider,
    model: verified.dispatchTarget,
    serializedRequest: verified.serializedRequest,
    byteCount: verified.serializedByteCount,
    requestHash: verified.requestHash
  });
}

module.exports = {
  GovernedRequestError,
  PREPARED_REQUEST_FIELDS,
  PREPARED_REQUEST_REFUSALS,
  PREPARED_REQUEST_VERSION,
  SUBJECT_KINDS,
  governedRequestBytes,
  hashSerializedRequest,
  normalizeGovernedProviderRequest,
  prepareGovernedProviderRequest,
  refuseGovernedRequest: refuse
};
