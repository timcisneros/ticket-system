#!/usr/bin/env node
'use strict';

// Tranche 4 deterministic suite for runtime/execution-target-registry.
//
// The registry answers one routing question: does an authorized model reference
// designate ONE immutable artifact the runtime can bind now and re-verify before
// dispatch? It is not an economic contract, and this suite proves that too — a
// target can be immutable and unaffordable, or mutable and free, and neither
// fact may leak into the other.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
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
  resolveImmutableDispatchTarget
} = require('../runtime/execution-target-registry');

const OPENAI_ADAPTER = 'openai.responses.v1';
const OLLAMA_ADAPTER = 'ollama.chat.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';

function resolve(model, adapterId = OPENAI_ADAPTER, provider = 'openai') {
  return resolveImmutableDispatchTarget({ adapterId, provider, model });
}

function refusalReason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ExecutionTargetError, 'refusals use the module error');
    assert.equal(error.code, 'EXECUTION_TARGET_REFUSED');
    assert.equal(TARGET_REFUSALS.includes(error.reason), true,
      `${error.reason} is in the closed vocabulary`);
    return error.reason;
  }
  return assert.fail('expected an execution-target refusal');
}

// ── An exact admitted snapshot resolves to one immutable target ─────────────

const target = resolve(SNAPSHOT);
assert.equal(target.version, EXECUTION_TARGET_VERSION);
assert.equal(target.targetKind, 'provider_model_snapshot');
assert.equal(IMMUTABLE_TARGET_KINDS.includes(target.targetKind), true);
assert.equal(target.adapterId, OPENAI_ADAPTER);
assert.equal(target.provider, 'openai');
assert.equal(target.routeReference, SNAPSHOT);
assert.equal(target.dispatchTarget, SNAPSHOT,
  'an exact snapshot is its own execution target');
assert.match(target.targetEvidenceIdentity, /^provider-snapshot-identifier\//);
assert.match(target.targetEvidenceHash, /^[0-9a-f]{64}$/);
assert.deepEqual(Object.keys(target).sort(), [...TARGET_FIELDS].sort());
assert.equal(Object.isFrozen(target), true);

// Every admitted snapshot resolves.
for (const snapshot of IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER]) {
  const resolved = resolve(snapshot);
  assert.equal(resolved.dispatchTarget, snapshot);
  assert.equal(resolved.targetKind, 'provider_model_snapshot');
}

// ── Determinism and per-target distinctness ────────────────────────────────

assert.equal(resolve(SNAPSHOT).targetEvidenceHash, target.targetEvidenceHash,
  'target evidence is deterministic');
assert.equal(resolve(SNAPSHOT).targetEvidenceIdentity, target.targetEvidenceIdentity);
for (const other of IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER]) {
  if (other === SNAPSHOT) continue;
  assert.notEqual(resolve(other).targetEvidenceHash, target.targetEvidenceHash,
    'each snapshot has a distinct evidence hash');
}

// ── Mutable aliases refuse capture ─────────────────────────────────────────

for (const alias of KNOWN_MUTABLE_REFERENCES[OPENAI_ADAPTER]) {
  assert.equal(refusalReason(() => resolve(alias)), 'route_target_not_immutable',
    `${alias} is a mutable alias and cannot be captured`);
}
// The refusal explains WHY, rather than implying the model does not exist.
try {
  resolve('gpt-4o');
} catch (error) {
  assert.match(error.message, /mutable alias/i);
  assert.match(error.message, /exact snapshot/i);
}

// ── Unregistered exact-looking identifiers refuse ──────────────────────────

for (const unregistered of [
  'gpt-9-preview-2099-01-01',
  'gpt-4o-mini-2024-07-19',
  'gpt-4.1-mini-2025-04-15',
  'o3-2025-04-16'
]) {
  assert.equal(refusalReason(() => resolve(unregistered)), 'route_target_not_immutable',
    `${unregistered} merely LOOKS like a snapshot; it is not admitted`);
}

// ── Ollama: no digest seam, so no capture at any price ─────────────────────

assert.equal(
  Object.prototype.hasOwnProperty.call(ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM, OLLAMA_ADAPTER),
  true,
  'the missing Ollama digest seam is declared, not implied'
);
assert.match(ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM[OLLAMA_ADAPTER].auditNote, /digest/i);
for (const tag of ['llama3', 'llama3:latest', 'some-custom-gguf:q4', 'mistral:7b']) {
  assert.equal(
    refusalReason(() => resolve(tag, OLLAMA_ADAPTER, 'ollama')),
    'route_target_not_immutable',
    `${tag} is a mutable tag with no digest seam`
  );
}
// Zero pricing cannot bypass capture: this module has no notion of price at all,
// so there is no input by which a zero rate could influence the outcome.
assert.equal(
  refusalReason(() => resolveImmutableDispatchTarget({
    adapterId: OLLAMA_ADAPTER, provider: 'ollama', model: 'llama3'
  })),
  'route_target_not_immutable',
  'immutability is not a monetary property'
);

// ── Transplant refusal ─────────────────────────────────────────────────────

assert.equal(refusalReason(() => resolve(SNAPSHOT, OLLAMA_ADAPTER, 'ollama')),
  'route_target_not_immutable',
  'a snapshot admitted for one adapter is not a target on another');
assert.equal(refusalReason(() => resolve(SNAPSHOT, 'anthropic.messages.v1', 'anthropic')),
  'route_target_not_immutable',
  'an adapter with no declared targets refuses');
// The provider is part of the captured identity, so a provider swap changes the
// evidence hash and cannot be passed off as the same target.
assert.notEqual(
  buildImmutableTarget({ ...target, provider: 'azure' }).targetEvidenceHash,
  target.targetEvidenceHash
);
for (const field of ['adapterId', 'routeReference', 'dispatchTarget', 'targetEvidenceIdentity']) {
  assert.notEqual(
    buildImmutableTarget({ ...target, [field]: 'transplanted' }).targetEvidenceHash,
    target.targetEvidenceHash,
    `${field} participates in the target evidence hash`
  );
}

// ── Re-verification before dispatch ────────────────────────────────────────

assert.equal(assertDispatchTargetUnchanged(target).dispatchTarget, SNAPSHOT);
assert.equal(refusalReason(() => assertDispatchTargetUnchanged(null)),
  'target_evidence_unavailable');
assert.equal(
  refusalReason(() => assertDispatchTargetUnchanged({ ...target, targetEvidenceHash: '0'.repeat(64) })),
  'target_drift',
  'evidence tampering is caught before dispatch'
);
// The reference now resolving to a DIFFERENT artifact is drift, not success.
const otherSnapshot = IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER]
  .find(candidate => candidate !== SNAPSHOT);
const drifted = buildImmutableTarget({ ...target, routeReference: otherSnapshot });
assert.equal(refusalReason(() => assertDispatchTargetUnchanged(drifted)), 'target_drift',
  'a reference that now names another artifact refuses rather than executing it');
// A reference that has lost immutability entirely refuses too.
assert.throws(
  () => assertDispatchTargetUnchanged(buildImmutableTarget({
    ...target, routeReference: 'gpt-4o', dispatchTarget: 'gpt-4o'
  })),
  error => error.reason === 'route_target_not_immutable' || error.reason === 'target_drift'
);
assert.throws(() => assertDispatchTargetUnchanged({ ...target, extra: 1 }), () => true,
  'an unknown field on a captured target fails closed');

// ── Registry is append-only in semantics ───────────────────────────────────
//
// A captured decision embeds its target evidence hash. Adding NEW entries must
// never change an existing entry's evidence, or historical decisions would stop
// verifying. This is what "append-only" buys.

const historicalEvidence = Object.fromEntries(
  IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER].map(snapshot =>
    [snapshot, resolve(snapshot).targetEvidenceHash])
);
// Re-resolving after any number of reads is stable.
for (let pass = 0; pass < 3; pass += 1) {
  for (const [snapshot, evidenceHash] of Object.entries(historicalEvidence)) {
    assert.equal(resolve(snapshot).targetEvidenceHash, evidenceHash,
      `${snapshot} evidence is stable across reads`);
  }
}
// Entries are deeply frozen, so no in-place rewrite is possible at runtime.
assert.equal(Object.isFrozen(IMMUTABLE_PROVIDER_SNAPSHOTS), true);
assert.equal(Object.isFrozen(IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER]), true);
assert.equal(Object.isFrozen(KNOWN_MUTABLE_REFERENCES), true);
assert.equal(Object.isFrozen(ADAPTERS_WITHOUT_IMMUTABLE_TARGET_SEAM), true);
assert.throws(() => { IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER].push('gpt-5'); }, () => true,
  'the admitted set cannot be extended at runtime');
// A revised artifact must arrive as a NEW identifier, never as a rewrite: the
// evidence identity embeds the exact reference, so two different references can
// never share an evidence hash.
const identities = IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER]
  .map(snapshot => resolve(snapshot).targetEvidenceIdentity);
assert.equal(new Set(identities).size, identities.length,
  'every admitted target has a distinct evidence identity');
assert.equal(
  identities.every(identity =>
    IMMUTABLE_PROVIDER_SNAPSHOTS[OPENAI_ADAPTER].some(s => identity.endsWith(s))),
  true,
  'the evidence identity names the exact reference it describes'
);

// ── No economic, credential or environment dependency ──────────────────────

const source = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'execution-target-registry.js'), 'utf8');
assert.deepEqual(
  [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]),
  ['./declared-work-contract'],
  'the registry depends on closed primitives only'
);
const executable = source.replace(/^\s*\/\/.*$/gm, '');
for (const forbidden of [
  'model-pricing-catalog', 'provider-adapter-capability', 'economic-authority',
  'role-routing-contract', 'MicroUsd', 'budget', 'reservation', 'account',
  'contextWindow', 'apiKey', 'Authorization', 'credential',
  'process.env', 'fetch(', 'require(\'http', 'child_process', 'Math.random', 'Date.now'
]) {
  assert.equal(executable.includes(forbidden), false,
    `the registry must not reference ${forbidden}`);
}
// No live resolution: alias and digest lookup at dispatch would reintroduce the
// drift the immutable target exists to prevent. The module is entirely
// synchronous and has no transport of any kind. (`/api/show` DOES appear in the
// registry, but only inside the string that documents which seam is missing —
// which is the opposite of calling it.)
for (const forbidden of ['await ', 'async ', 'Promise', 'http.', 'https.', 'net.']) {
  assert.equal(executable.includes(forbidden), false,
    `the registry performs no I/O: ${forbidden} must not appear`);
}
assert.equal(/\/api\/(show|tags)/.test(executable.replace(/'[^']*'/g, "''")), false,
  'any /api/ reference exists only inside a documentation string, never in code');

console.log('execution target registry test passed');
