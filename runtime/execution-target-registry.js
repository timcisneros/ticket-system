'use strict';

// Tranche 4 — immutable execution targets.
//
// A routing policy authorizes a MODEL REFERENCE. That reference is not always an
// execution target: `gpt-4o` and an Ollama tag like `llama3:latest` both name
// something whose underlying artifact can be replaced without the identifier
// changing. Capturing such a reference into an immutable routing decision would
// produce a decision that looks fixed while executing something else later.
//
// This module answers exactly one routing question:
//
//   Does this authorized reference designate ONE immutable artifact that the
//   runtime can bind now and re-verify before dispatch?
//
// It is a ROUTING primitive. It imports no pricing catalog, no model economic
// capability, no economic authority and no account persistence: a target can be
// immutable and unaffordable, or mutable and free, and those are different
// questions answered by different contracts.
//
// It performs no I/O. Alias resolution and digest lookup are deliberately NOT
// done at dispatch: a live lookup would reintroduce exactly the drift the
// immutable target exists to prevent.

const {
  compareCanonicalText,
  deepFreeze,
  hashCanonical
} = require('./declared-work-contract');

const EXECUTION_TARGET_VERSION = 1;

// The only kinds of immutable artifact identity this tranche can bind.
//
//   provider_model_snapshot — a dated provider snapshot identifier that itself
//     designates one immutable artifact, so no external resolution is required.
//   local_model_digest — a content digest for a locally executed model. Declared
//     for completeness; nothing can currently produce one (see below).
const IMMUTABLE_TARGET_KINDS = Object.freeze([
  'provider_model_snapshot',
  'local_model_digest'
]);

const TARGET_REFUSALS = Object.freeze([
  'route_target_not_immutable',
  'target_evidence_unavailable',
  'target_drift'
]);

// Exact provider snapshots admitted as immutable execution targets. Each
// identifier designates one frozen artifact for the life of that identifier, so
// the identifier IS the evidence and no lookup is needed.
//
// Membership is an administrator-reviewed runtime fact, exactly like the model
// capability registry — but a separate one, because "is this artifact fixed" and
// "what does it cost" are different questions with different answers.
const IMMUTABLE_PROVIDER_SNAPSHOTS = deepFreeze({
  'openai.responses.v1': Object.freeze([
    'gpt-4.1-2025-04-14',
    'gpt-4.1-mini-2025-04-14',
    'gpt-4o-mini-2024-07-18'
  ])
});

// References known to be mutable. Listing them is not required for the refusal —
// anything not admitted above refuses anyway — but naming them makes the refusal
// message honest about WHY, rather than implying the model does not exist.
const KNOWN_MUTABLE_REFERENCES = deepFreeze({
  'openai.responses.v1': Object.freeze([
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-latest',
    'chatgpt-4o-latest'
  ])
});

// Adapters for which the runtime has NO canonical immutable-artifact seam.
//
// Ollama is here on audit evidence, not assumption: this repository contains no
// `/api/tags`, no `/api/show`, no modelfile or model_info read, and no digest
// resolution of any kind — every `digest` occurrence in server.js is
// `crypto.createHash(...).digest('hex')`. A tag such as `llama3:latest` can be
// repointed at a different artifact at any time, and being local or
// zero-priced proves nothing about immutability.
//
// So an Ollama route stays policy-authorizable and, when explicitly zero-priced,
// economically admissible — but it cannot be CAPTURED as a governed execution
// target until a real digest seam exists. Inventing one would manufacture the
// runtime fact this tranche must not manufacture.
const ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM = deepFreeze({
  'ollama.chat.v1': {
    adapterId: 'ollama.chat.v1',
    missingSeam: 'local model digest resolution (/api/show or equivalent)',
    auditNote:
      'server.js contains no Ollama model metadata read; every digest occurrence ' +
      'is a crypto hash. A tag is not an immutable artifact identity.'
  }
});

class ExecutionTargetError extends TypeError {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'ExecutionTargetError';
    this.code = code;
    this.reason = detail.reason || null;
  }
}

function fail(message, code = 'EXECUTION_TARGET_INVALID', detail = {}) {
  throw new ExecutionTargetError(code, message, detail);
}

function refuse(reason, message = null) {
  if (!TARGET_REFUSALS.includes(reason)) {
    fail(`Unsupported execution-target refusal reason: ${String(reason)}`);
  }
  fail(message || reason, 'EXECUTION_TARGET_REFUSED', { reason });
}

function requiredText(value, label, maximum = 256) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  const text = value.trim();
  if (!text) fail(`${label} must not be empty`);
  if (text.length > maximum) fail(`${label} exceeds ${maximum} characters`);
  return text;
}

const TARGET_FIELDS = Object.freeze([
  'version',
  'targetKind',
  'adapterId',
  'provider',
  // What the policy authorized. May be an alias or a tag.
  'routeReference',
  // What will actually execute. For an exact snapshot these coincide; for a
  // mutable reference they never can, which is why both are recorded.
  'dispatchTarget',
  'targetEvidenceIdentity',
  'targetEvidenceHash'
]);

function buildImmutableTarget({
  targetKind,
  adapterId,
  provider,
  routeReference,
  dispatchTarget,
  targetEvidenceIdentity
}) {
  if (!IMMUTABLE_TARGET_KINDS.includes(targetKind)) {
    fail(`executionTarget.targetKind is unsupported: ${String(targetKind)}`);
  }
  const withoutHash = {
    version: EXECUTION_TARGET_VERSION,
    targetKind,
    adapterId: requiredText(adapterId, 'executionTarget.adapterId', 128),
    provider: requiredText(provider, 'executionTarget.provider', 64),
    routeReference: requiredText(routeReference, 'executionTarget.routeReference', 256),
    dispatchTarget: requiredText(dispatchTarget, 'executionTarget.dispatchTarget', 256),
    targetEvidenceIdentity: requiredText(
      targetEvidenceIdentity,
      'executionTarget.targetEvidenceIdentity',
      256
    )
  };
  return deepFreeze({ ...withoutHash, targetEvidenceHash: hashCanonical(withoutHash) });
}

// The capture gate. No I/O, no alias resolution at dispatch, no invented digest.
function resolveImmutableDispatchTarget({ adapterId, provider, model }) {
  const wantedAdapter = requiredText(adapterId, 'adapterId', 128);
  const wantedProvider = requiredText(provider, 'provider', 64);
  const reference = requiredText(model, 'model', 256);

  const missing = ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM[wantedAdapter] || null;
  if (missing) {
    refuse('route_target_not_immutable',
      `${wantedAdapter} has no canonical immutable-artifact seam ` +
      `(${missing.missingSeam}); ${reference} cannot be captured as a governed target`);
  }

  const snapshots = IMMUTABLE_PROVIDER_SNAPSHOTS[wantedAdapter] || null;
  if (!snapshots) {
    refuse('route_target_not_immutable',
      `${wantedAdapter} declares no immutable execution targets`);
  }
  if (!snapshots.includes(reference)) {
    const mutable = (KNOWN_MUTABLE_REFERENCES[wantedAdapter] || []).includes(reference);
    refuse('route_target_not_immutable',
      mutable
        ? `${reference} is a mutable alias and no canonical mapping resolves it to a ` +
          'snapshot; authorize an exact snapshot instead'
        : `${reference} is not an admitted immutable execution target for ${wantedAdapter}`);
  }
  return buildImmutableTarget({
    targetKind: 'provider_model_snapshot',
    adapterId: wantedAdapter,
    provider: wantedProvider,
    routeReference: reference,
    // An exact snapshot IS its own execution target.
    dispatchTarget: reference,
    targetEvidenceIdentity: `provider-snapshot-identifier/${wantedAdapter}/${reference}`
  });
}

// Re-verification immediately before dispatch. The captured target must still
// resolve from the reference it was captured from, and must still be the same
// artifact. A replaced alias or repointed tag refuses rather than silently
// executing the replacement.
function assertDispatchTargetUnchanged(capturedTarget) {
  if (!capturedTarget || typeof capturedTarget !== 'object') {
    refuse('target_evidence_unavailable', 'no captured execution target to verify');
  }
  const unknown = Object.keys(capturedTarget).filter(field => !TARGET_FIELDS.includes(field));
  if (unknown.length > 0) {
    fail(`executionTarget contains unknown field(s): ${unknown.sort(compareCanonicalText).join(', ')}`);
  }
  const rebuilt = buildImmutableTarget(capturedTarget);
  if (rebuilt.targetEvidenceHash !== capturedTarget.targetEvidenceHash) {
    refuse('target_drift', 'captured execution target does not match its own evidence hash');
  }
  // Re-resolve from the ORIGINAL reference and require the same artifact.
  const current = resolveImmutableDispatchTarget({
    adapterId: capturedTarget.adapterId,
    provider: capturedTarget.provider,
    model: capturedTarget.routeReference
  });
  if (current.dispatchTarget !== capturedTarget.dispatchTarget ||
      current.targetEvidenceHash !== capturedTarget.targetEvidenceHash) {
    refuse('target_drift',
      `${capturedTarget.routeReference} now resolves to ${current.dispatchTarget}, ` +
      `not the captured ${capturedTarget.dispatchTarget}`);
  }
  return rebuilt;
}

module.exports = {
  ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM,
  EXECUTION_TARGET_VERSION,
  ExecutionTargetError,
  IMMUTABLE_PROVIDER_SNAPSHOTS,
  IMMUTABLE_TARGET_KINDS,
  KNOWN_MUTABLE_REFERENCES,
  TARGET_FIELDS,
  TARGET_REFUSALS,
  assertDispatchTargetUnchanged,
  buildImmutableTarget,
  refuseExecutionTarget: refuse,
  resolveImmutableDispatchTarget
};
