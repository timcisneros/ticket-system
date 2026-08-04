#!/usr/bin/env node
'use strict';

// Deterministic contract for governed request-recovery classification.
//
// WHY IT IS A SEPARATE, PURE TEST. The rule this covers decides whether a
// started request belongs to the claim now running the Run or to an earlier
// one. Getting that wrong is expensive in both directions: a duplicate told its
// request may have been lost, or a recovering caller told a live winner owns
// work whose initiator is gone.
//
// The dangerous inputs cannot be staged against the database. Three separate
// integrity mechanisms refuse to build them — the event chain constraint
// rejects a synthetic `run.lease_acquired`, `position` is generated and cannot
// be supplied, and the reservation rejects a rewritten `started_at`. That
// resistance is exactly why claim identity is trustworthy, and it is also why
// the previous timestamp comparison passed every real run while being wrong in
// principle. Supplying the values directly is the only way to prove the rule.

const assert = require('node:assert/strict');
const {
  GOVERNED_RECOVERY_CLASSIFICATIONS,
  classifyGovernedRequestRecovery
} = require('../runtime/governed-leaf-orchestration');

const started = overrides => classifyGovernedRequestRecovery({
  durableResponsePresent: false,
  requestStarted: true,
  currentExecutorLive: true,
  ...overrides
});

// ── A durable response outranks every claim question ────────────────────────
assert.equal(
  classifyGovernedRequestRecovery({
    durableResponsePresent: true, requestStarted: true,
    startedClaimEventPosition: 10, currentClaimEventPosition: 11
  }),
  'reused_durable_response',
  'a durable response is reused even though the claim changed');

// ── Same claim, live executor: a duplicate racing a winner ──────────────────
assert.equal(
  started({ startedClaimEventPosition: 11, currentClaimEventPosition: 11 }),
  'request_in_flight',
  'a request started under the CURRENT claim is owned by a live winner');

// ── Different claim: recovery, whatever the clock said ──────────────────────
//
// These are the cases the database will not let a test construct. The
// timestamps named in each comment are the ones that would have fooled the old
// comparison; they are NOT parameters here, which is the point.
{
  // request instant == claim instant (same millisecond, later claim)
  assert.equal(
    started({ startedClaimEventPosition: 10, currentClaimEventPosition: 11 }),
    'request_delivery_uncertain',
    'equal instants do not make an earlier claim current');

  // request instant AFTER the claim instant (clock adjustment, reordering)
  assert.equal(
    started({ startedClaimEventPosition: 10, currentClaimEventPosition: 11 }),
    'request_delivery_uncertain',
    'reordered instants do not make an earlier claim current');

  // many claims later
  assert.equal(
    started({ startedClaimEventPosition: 1, currentClaimEventPosition: 987 }),
    'request_delivery_uncertain');
}

// ── Same identity is same identity, whatever the clock said ─────────────────
assert.equal(
  started({ startedClaimEventPosition: 987, currentClaimEventPosition: 987 }),
  'request_in_flight',
  'identity equality decides, and no timestamp can override it');

// ── A claim with no live executor is not "in flight" ────────────────────────
assert.equal(
  started({
    startedClaimEventPosition: 11, currentClaimEventPosition: 11,
    currentExecutorLive: false
  }),
  null,
  'with no live executor the existing settlement path decides, not this rule');

// ── Legacy rows are treated conservatively ──────────────────────────────────
assert.equal(
  started({ startedClaimEventPosition: null, currentClaimEventPosition: 11 }),
  'request_delivery_uncertain',
  'a request with no binding predates the rule and is not assumed current');
assert.equal(
  started({
    startedClaimEventPosition: 11, currentClaimEventPosition: 11,
    legacyUnbound: true
  }),
  'request_delivery_uncertain',
  'an explicitly legacy row is conservative even when positions coincide');

// ── Malformed or unresolvable authority is an integrity problem ─────────────
for (const [label, overrides] of [
  ['a non-integer position', { startedClaimEventPosition: 1.5, currentClaimEventPosition: 11 }],
  ['a zero position', { startedClaimEventPosition: 0, currentClaimEventPosition: 11 }],
  ['a negative position', { startedClaimEventPosition: -3, currentClaimEventPosition: 11 }],
  ['an unresolvable current claim', { startedClaimEventPosition: 10, currentClaimEventPosition: null }]
]) {
  assert.equal(started(overrides), 'request_authority_integrity_failure',
    `${label} is an authority integrity failure, not a recovery decision`);
}

// ── An unstarted reservation is not a delivery question at all ──────────────
assert.equal(
  classifyGovernedRequestRecovery({ requestStarted: false }),
  null,
  'a reservation that never started invents no delivery uncertainty');

// ── The vocabulary is closed ────────────────────────────────────────────────
assert.deepEqual([...GOVERNED_RECOVERY_CLASSIFICATIONS],
  ['reused_durable_response', 'request_in_flight', 'request_delivery_uncertain',
    'request_authority_integrity_failure'],
  'the classification vocabulary is closed');

// ── THE CLASSIFIER CANNOT SEE A CLOCK ───────────────────────────────────────
//
// Pinned in source. Accepting a timestamp would reopen the possibility of
// deciding claim ownership by clock order, which is the defect this replaced.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'runtime',
    'governed-leaf-orchestration.js'), 'utf8');
  const start = source.indexOf('function classifyGovernedRequestRecovery(');
  assert.ok(start > 0, 'the classifier exists');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  const executable = body.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const [label, pattern] of [
    ['a start timestamp', /startedAt/],
    ['a claim timestamp', /claimAt|claimedAt/],
    ['date arithmetic', /new Date\(|Date\.now/],
    ['a lease owner', /leaseOwner/]
  ]) {
    assert.equal(pattern.test(executable), false,
      `the classifier never reads ${label} — ownership is identity, not timing`);
  }
}

console.log('governed request claim classification test passed');
