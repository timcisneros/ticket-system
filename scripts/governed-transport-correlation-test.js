#!/usr/bin/env node
'use strict';

// Deterministic contract for governed transport attribution.
//
// WHY THIS EXISTS SEPARATELY FROM THE REAL-SERVER SUITES. The guards it covers
// are timing-sensitive: a foreign request only sometimes reaches the transport
// first, a duplicate dispatch only sometimes happens, settlement is usually
// fast. Mutating those guards in a real-server run therefore SURVIVES most of
// the time — which is indistinguishable from the guard being unnecessary, and
// is how the lifecycle flake lived through three sessions of green retries.
//
// Here the inputs are constructed rather than raced for. Every rule fails in ONE
// run when broken, because the adverse condition is present by construction
// instead of by luck.

const assert = require('node:assert/strict');
const {
  CORRELATION_REFUSALS,
  correlateGovernedTransports,
  hashRequestBody,
  missingTransports,
  transportedOrdinals,
  transportsForRun
} = require('./fixtures/governed-transport-correlation');

const LEAF_RUN = 1;
const SIBLING_RUN = 2;
const TICKET = 7;

// Bodies chosen so ARRIVAL ORDER AND CANONICAL ORDINAL DISAGREE. The planner
// arrives first and is not a leaf request at all; a sibling arrives between the
// leaf's two calls. Any implementation that counts arrivals gets a different
// answer from one that reads authority, which is what makes the mutations below
// deterministic.
const plannerBody = JSON.stringify({ role: 'planner', prompt: 'plan reports/planner' });
const leafOneBody = JSON.stringify({ role: 'leaf', step: 0, prompt: 'reports/planner/alpha' });
const siblingBody = JSON.stringify({ role: 'sibling', step: 0, prompt: 'reports/a/alpha' });
const leafTwoBody = JSON.stringify({ role: 'leaf', step: 1, prompt: 'reports/planner/beta' });

const reservations = [
  {
    reservationId: 11, runId: null, ticketId: TICKET,
    logicalSourceIdentity: 'model-request:planner:0:provider',
    modelRequestOrdinal: 1, exactRequestHash: hashRequestBody(plannerBody)
  },
  {
    reservationId: 12, runId: LEAF_RUN, ticketId: TICKET,
    logicalSourceIdentity: 'model-request:agent:0:provider',
    modelRequestOrdinal: 1, exactRequestHash: hashRequestBody(leafOneBody)
  },
  {
    reservationId: 13, runId: SIBLING_RUN, ticketId: TICKET,
    logicalSourceIdentity: 'model-request:agent:0:provider',
    modelRequestOrdinal: 1, exactRequestHash: hashRequestBody(siblingBody)
  },
  {
    reservationId: 14, runId: LEAF_RUN, ticketId: TICKET,
    logicalSourceIdentity: 'model-request:agent:1:provider',
    modelRequestOrdinal: 2, exactRequestHash: hashRequestBody(leafTwoBody)
  }
];

// Arrival order: planner, leaf-1, sibling, leaf-2.
const captures = [
  { body: plannerBody, responseIdentity: 'fixture-planner' },
  { body: leafOneBody, responseIdentity: 'fixture-leaf-1' },
  { body: siblingBody, responseIdentity: 'fixture-sibling' },
  { body: leafTwoBody, responseIdentity: 'fixture-leaf-2' }
];

// ── A foreign transport arrives FIRST and is not attributed to the leaf ──────
{
  const attributed = correlateGovernedTransports({ captures, reservations });
  assert.equal(attributed.length, 4, 'every captured transport is attributed');

  assert.equal(attributed[0].runId, null, 'capture 0 is the planner, not a Run');
  assert.equal(attributed[0].reservationId, 11);

  const leaf = transportsForRun(attributed, LEAF_RUN);
  assert.equal(leaf.length, 2, 'the leaf transported exactly twice');
  assert.deepEqual(leaf.map(item => item.captureIndex), [1, 3],
    'the leaf owns captures 1 and 3 — NOT 0 and 1');
  assert.equal(transportedOrdinals(attributed, LEAF_RUN), '1,2',
    'by canonical ordinal the leaf made requests 1 and 2');

  // THE POINT OF THE FIXTURE SHAPE: arrival index and ordinal disagree, so an
  // implementation reading arrival order cannot accidentally be right.
  assert.notEqual(leaf[1].captureIndex, leaf[1].ordinal,
    'arrival position and canonical ordinal differ for the leaf second request');

  const sibling = transportsForRun(attributed, SIBLING_RUN);
  assert.equal(sibling.length, 1, 'the sibling is independently identifiable');
  assert.equal(sibling[0].captureIndex, 2);
  assert.equal(transportsForRun(attributed, SIBLING_RUN)[0].runId, SIBLING_RUN);
}

// ── An unattributable transport refuses ─────────────────────────────────────
{
  const stray = [...captures, { body: JSON.stringify({ role: 'unknown' }) }];
  assert.throws(
    () => correlateGovernedTransports({ captures: stray, reservations }),
    error => error.reason === 'transport_unattributable',
    'a transport matching no reservation is refused, never ignored');
}

// ── A duplicate dispatch refuses, and is not collapsed ───────────────────────
{
  const duplicated = [...captures, { body: leafTwoBody, responseIdentity: 'again' }];
  let refusal = null;
  try {
    correlateGovernedTransports({ captures: duplicated, reservations });
  } catch (error) {
    refusal = error;
  }
  assert.ok(refusal, 'a second transport of one dispatch authority is refused');
  assert.equal(refusal.reason, 'transport_duplicate_dispatch');
  assert.deepEqual(refusal.detail.captures, [3, 4],
    'and it names BOTH captures rather than deduplicating them away');
}

// ── An omitted transport is visible ─────────────────────────────────────────
{
  const withoutSecond = captures.filter(capture => capture.body !== leafTwoBody);
  const attributed = correlateGovernedTransports({
    captures: withoutSecond, reservations
  });
  assert.equal(transportedOrdinals(attributed, LEAF_RUN), '1',
    'only request 1 transported');
  const missing = missingTransports(attributed, reservations, LEAF_RUN);
  assert.equal(missing.length, 1, 'the omission is detected');
  assert.equal(missing[0].ordinal, 2);
  assert.equal(missing[0].reservationId, 14);
  assert.equal(missing[0].logicalSourceIdentity, 'model-request:agent:1:provider',
    'and reports the exact reservation identity that never reached transport');

  // A count of what DID arrive cannot see this: two reservations, one call.
  assert.notEqual(
    transportsForRun(attributed, LEAF_RUN).length,
    reservations.filter(r => r.runId === LEAF_RUN).length,
    'an omission is invisible to any assertion phrased as a count of arrivals');
}

// ── Ambiguous authority refuses ─────────────────────────────────────────────
{
  const ambiguous = [...reservations, {
    reservationId: 15, runId: SIBLING_RUN, ticketId: TICKET,
    logicalSourceIdentity: 'model-request:agent:9:provider',
    modelRequestOrdinal: 9, exactRequestHash: hashRequestBody(leafTwoBody)
  }];
  assert.throws(
    () => correlateGovernedTransports({ captures, reservations: ambiguous }),
    error => error.reason === 'reservation_hash_ambiguous',
    'two reservations claiming one request hash refuse rather than pick one');
}

// ── The refusal vocabulary is closed ────────────────────────────────────────
assert.deepEqual([...CORRELATION_REFUSALS],
  ['transport_unattributable', 'transport_duplicate_dispatch',
    'reservation_hash_ambiguous'],
  'the correlation refusal vocabulary is closed');

// ── The helper is pure ──────────────────────────────────────────────────────
{
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures',
      'governed-transport-correlation.js'), 'utf8');
  const executable = source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const [label, pattern] of [
    ['clock', /Date\.now\s*\(|new Date\(/],
    ['filesystem', /readFileSync|writeFileSync|appendFileSync/],
    ['database', /pool\.|query\(/],
    ['arrival order', /requestOrdinal|fixtureRequestCount/]
  ]) {
    assert.equal(pattern.test(executable), false,
      `correlation reads no ${label} — attribution is identity, not circumstance`);
  }
}

// ── The fixture's semantic controls are content-owned ───────────────────────
//
// `fixtureRequestCount` counts every call the transport saw, including refused
// ones, so it can never stand for a Run's ordinal. It may appear in diagnostics
// — the capture record and the x-request-id — but no response ownership, crash
// boundary or refusal may be selected by it. Pinned in source because the
// failure it caused was invisible in ordinary runs.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const preload = fs.readFileSync(path.join(__dirname, 'fixtures',
    'hermetic-governed-transport-preload.js'), 'utf8');
  const executable = preload.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  assert.equal(/CRASH_BEFORE_ORDINAL|CRASH_AFTER_ORDINAL/.test(executable), false,
    'crash boundaries are not selected by an arrival ordinal');

  // The counter may be incremented and reported; it may not be compared.
  const comparisons = executable.match(/fixtureRequestCount\s*(===|==|>=|<=|>|<)/g) || [];
  assert.deepEqual(comparisons, [],
    'fixtureRequestCount is never compared — it decides nothing');

  for (const owned of ['crashBeforeTransport', 'crashAfterTransport']) {
    assert.ok(executable.includes(`candidate.${owned}`),
      `the ${owned} boundary is carried by the staged response that owns the request`);
  }
}

console.log('governed transport correlation test passed');
