#!/usr/bin/env node
'use strict';
// Event-integrity negative-case matrix — the PostgreSQL-native, fixture-free
// replacement for the retired JSON event-chain-verify-test (which drove the
// event-chain-verify.js CLI over an events.jsonl file). The invariant is not
// JSON-specific: runtime/event-integrity.js is the shared verifier the store
// uses at restart, and its job is to detect every tamper/malformed-envelope
// class in a sealed run-event chain. This exercises that verifier directly
// over in-memory chains — no server, no database, no fixture generator.
//
// Assertion equivalence with event-chain-verify-test's 12 cases is documented
// inline per case so the coverage handoff is auditable.

const assert = require('assert/strict');
const {
  RUN_EVENT_SCHEMA_VERSION,
  validateCurrentEventEnvelope,
  computeRunEventHash,
  verifyCurrentRunEventChain
} = require('../runtime/event-integrity');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok ${name}`);
}

// Build a valid sealed run-event chain: seq 0..n-1, prevHash linkage, real hash.
function sealChain(rawEvents) {
  const sealed = [];
  rawEvents.forEach((raw, index) => {
    const event = {
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      id: raw.id || `evt-${index}`,
      ts: raw.ts || `2026-07-24T00:00:0${index}.000Z`,
      type: raw.type || 'run.event',
      ticketId: raw.ticketId !== undefined ? raw.ticketId : 1,
      runId: raw.runId !== undefined ? raw.runId : 1,
      stepId: raw.stepId !== undefined ? raw.stepId : null,
      seq: index,
      prevHash: index === 0 ? null : sealed[index - 1].hash,
      payload: raw.payload || { n: index }
    };
    event.hash = computeRunEventHash(event);
    sealed.push(event);
  });
  return sealed;
}

const cleanChain = () => sealChain([
  { type: 'run.started', payload: { a: 1 } },
  { type: 'workspace.operation', payload: { b: 2 } },
  { type: 'run.terminalized', payload: { status: 'completed' } }
]);

function hasError(report, type) {
  return report.errors.some(error => error.type === type);
}

// ── Case 1: clean chain passes (event-chain-verify-test #1) ──────────────
test('clean sealed chain verifies', () => {
  const report = verifyCurrentRunEventChain(cleanChain());
  assert.equal(report.chainValid, true, JSON.stringify(report.errors));
  assert.equal(report.errors.length, 0);
  assert.equal(report.lastVerifiedSeq, 2);
});

// ── Case 2 / 9: modified payload fails on stored hash (#2, #9) ────────────
test('modified event payload fails as hash_mismatch', () => {
  const chain = cleanChain();
  chain[1] = { ...chain[1], payload: { b: 999 } }; // hash no longer matches payload
  const report = verifyCurrentRunEventChain(chain);
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'hash_mismatch'));
});

// ── Case 8: modified FINAL event fails against its stored hash (#8) ───────
test('modified final event fails as hash_mismatch', () => {
  const chain = cleanChain();
  chain[chain.length - 1] = { ...chain[chain.length - 1], payload: { status: 'failed' } };
  const report = verifyCurrentRunEventChain(chain);
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'hash_mismatch'));
});

// ── Case 3: deleted middle event fails (#3) ──────────────────────────────
test('deleted middle event breaks seq + prevHash linkage', () => {
  const chain = cleanChain();
  const truncated = [chain[0], chain[2]]; // drop seq 1
  const report = verifyCurrentRunEventChain(truncated);
  assert.equal(report.chainValid, false);
  // seq 2 now sits at index 1 → seq/index mismatch, and its prevHash points at
  // the deleted event's hash, not chain[0].hash.
  assert.ok(hasError(report, 'duplicate_seq') || hasError(report, 'seq_gap'));
  assert.ok(hasError(report, 'prevhash_mismatch'));
});

// ── Case 4: inserted event fails (#4) ────────────────────────────────────
test('inserted event breaks seq contiguity and prevHash', () => {
  const chain = cleanChain();
  const foreign = sealChain([{ type: 'run.injected', payload: { evil: true } }])[0];
  const spliced = [chain[0], foreign, chain[1], chain[2]];
  const report = verifyCurrentRunEventChain(spliced);
  assert.equal(report.chainValid, false);
  assert.ok(report.errors.some(e => ['seq_gap', 'duplicate_seq', 'first_seq', 'prevhash_mismatch'].includes(e.type)));
});

// ── Case 5: reordered events fail (#5) ───────────────────────────────────
test('reordered events fail seq + prevHash', () => {
  const chain = cleanChain();
  const reordered = [chain[1], chain[0], chain[2]];
  const report = verifyCurrentRunEventChain(reordered);
  assert.equal(report.chainValid, false);
  assert.ok(report.errors.some(e => ['first_seq', 'duplicate_seq', 'seq_gap', 'first_prevhash', 'prevhash_mismatch'].includes(e.type)));
});

// ── Case 6: broken prevHash fails (#6) ───────────────────────────────────
test('tampered prevHash fails as prevhash_mismatch', () => {
  const chain = cleanChain();
  chain[2] = { ...chain[2], prevHash: 'deadbeef' };
  const report = verifyCurrentRunEventChain(chain);
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'prevhash_mismatch'));
});

// ── Unsealed event (missing hash) ────────────────────────────────────────
test('unsealed event (missing hash) fails', () => {
  const chain = cleanChain();
  delete chain[1].hash;
  const report = verifyCurrentRunEventChain(chain);
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'missing_hash'));
});

// ── Duplicate id / seq ───────────────────────────────────────────────────
test('duplicate event id is rejected', () => {
  const raw = [
    { id: 'dup', type: 'run.started', payload: { a: 1 } },
    { id: 'dup', type: 'run.terminalized', payload: { status: 'completed' } }
  ];
  const report = verifyCurrentRunEventChain(sealChain(raw));
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'duplicate_id'));
});

// ── Case 10: malformed run identity (#10) — envelope-level ───────────────
test('malformed runId is rejected by envelope validation', () => {
  assert.ok(validateCurrentEventEnvelope({
    schemaVersion: RUN_EVENT_SCHEMA_VERSION, id: 'x', ts: '2026-07-24T00:00:00.000Z',
    type: 'run.started', ticketId: 1, runId: -5, stepId: null, payload: {}
  }).some(e => e.type === 'invalid_run_id'));
});

// ── Case 11: invalid payload shape (#11) ─────────────────────────────────
test('non-object payload is rejected', () => {
  assert.ok(validateCurrentEventEnvelope({
    schemaVersion: RUN_EVENT_SCHEMA_VERSION, id: 'x', ts: '2026-07-24T00:00:00.000Z',
    type: 'run.started', ticketId: 1, runId: 1, stepId: null, payload: 'not-an-object'
  }).some(e => e.type === 'invalid_payload'));
});

// ── Case 12: non-run event must not carry chain fields (#12) ─────────────
test('non-run event carrying chain fields is rejected', () => {
  assert.ok(validateCurrentEventEnvelope({
    schemaVersion: RUN_EVENT_SCHEMA_VERSION, id: 'x', ts: '2026-07-24T00:00:00.000Z',
    type: 'ticket.observed', ticketId: 1, runId: null, stepId: null, payload: {},
    seq: 0, prevHash: null, hash: 'abc'
  }).some(e => e.type === 'unexpected_chain_fields'));
});

// ── Envelope: wrong schema version, missing id, bad timestamp ────────────
test('stale schema version, missing id, and bad timestamp are rejected', () => {
  const errors = validateCurrentEventEnvelope({
    schemaVersion: 99, id: '', ts: 'not-a-timestamp',
    type: 'run.started', ticketId: 1, runId: 1, stepId: null, payload: {}
  });
  assert.ok(errors.some(e => e.type === 'schema_version'));
  assert.ok(errors.some(e => e.type === 'missing_id'));
  assert.ok(errors.some(e => e.type === 'invalid_timestamp'));
});

// ── Parse failure surfaces as a chain error ──────────────────────────────
test('unparseable event surfaces as a parse error', () => {
  const chain = cleanChain();
  chain[1] = { _parseError: true };
  const report = verifyCurrentRunEventChain(chain);
  assert.equal(report.chainValid, false);
  assert.ok(hasError(report, 'parse'));
});

console.log(`\nPASS: event-integrity negative matrix — ${passed} tamper/malformed-envelope classes detected by verifyCurrentRunEventChain (replaces JSON event-chain-verify-test)`);
