#!/usr/bin/env node
'use strict';

// Tranche 4 boundary proof for the leaf-authority slice.
//
// This slice deliberately stops short of dispatch. The property asserted here
// is that it introduced NO second or partial network path: leaf Runs still go
// through the historical worker loop, and the governed leaf seam reaches no
// transport at all. The danger this guards against is a branch that sometimes
// dispatches governed and sometimes ungoverned depending on how complete a
// Run's captured state happens to be.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const store = read('persistence/postgres/store.js');
const runAuthority = read('runtime/governed-run-authority-contract.js');
const server = read('server.js');

// ── The reservation seam contacts no provider ───────────────────────────────

const seamStart = store.indexOf('async prepareAndReserveNextGovernedRunRequest(');
assert.ok(seamStart > 0, 'the request-preparation seam exists');
const seamEnd = store.indexOf('\n  async ', seamStart + 10);
const seam = store.slice(seamStart, seamEnd > 0 ? seamEnd : store.length);

for (const networked of [
  'dispatchGovernedRequest', 'createOpenAiGovernedTransport', 'https.request',
  'callModelProvider', 'transport(', 'fetch('
]) {
  assert.equal(seam.includes(networked), false,
    `the request-preparation seam must not reach ${networked}`);
}
// It must also not start a reservation: preparation reserves, it does not
// dispatch, and starting here would grant dispatch authority nobody asked for.
assert.equal(seam.includes('markEconomicRequestStarted'), false,
  'preparation never starts a request');
assert.equal(seam.includes('startGovernedPlannerRequest'), false,
  'preparation never borrows the planner start transaction');

// It does reserve, under the Run and account locks.
assert.ok(seam.includes('FOR UPDATE'), 'the Run row is locked');
assert.ok(seam.includes('_lockedEconomicAccount'), 'the shared account is locked');
assert.ok(seam.includes('reserveEconomicRequest'), 'the request is reserved');

// ── Leaf admission creates no reservations ──────────────────────────────────

const captureStart = store.indexOf('async _captureGovernedLeafAuthority(');
assert.ok(captureStart > 0, 'the leaf authority capture exists');
const captureEnd = store.indexOf('\n  async ', captureStart + 10);
const capture = store.slice(captureStart, captureEnd > 0 ? captureEnd : store.length);

assert.equal(capture.includes('reserveEconomicRequest'), false,
  'leaf admission creates no provider-request reservation');
assert.equal(capture.includes('prepareGovernedProviderRequest'), false,
  'leaf admission prepares no provider request');
assert.ok(capture.includes('admitTicketEconomicAccount'),
  'leaf admission admits the shared worker account');

// ── The worker loop is untouched by this slice ──────────────────────────────

assert.ok(server.includes('callModelProviderWithRunEvidence('),
  'the historical worker loop still exists and is unchanged by this slice');
for (const governed of [
  'prepareAndReserveNextGovernedRunRequest', 'classifyRunGovernance'
]) {
  assert.equal(server.includes(governed), false,
    `server.js must not yet branch on ${governed}: the worker-loop cutover is a ` +
    'separate commit, and a half-wired branch is the failure mode this test exists ' +
    'to prevent');
}

// ── Partial governed state can never degrade to the historical path ─────────

assert.ok(runAuthority.includes("refuse('governed_run_authority_partial'"),
  'partial governed state refuses');
// `classifyRunGovernance` must throw on a defect rather than returning
// historical, which is the only thing standing between a damaged envelope and
// silent un-governed execution.
const classify = runAuthority.slice(
  runAuthority.indexOf('function classifyRunGovernance('));
assert.equal(/catch\s*\(/.test(classify), false,
  'classification must not swallow a defect into the historical branch');
assert.ok(classify.includes('normalizeGovernedRunAuthority('),
  'classification normalizes rather than shape-testing');

// Age is never used to decide governance.
for (const temporal of ['createdAt', 'admittedAt', 'Date.now', 'new Date(']) {
  assert.equal(classify.includes(temporal), false,
    `governance must not be inferred from ${temporal}`);
}

// ── No production pricing ships in this slice ───────────────────────────────

for (const [label, source] of [
  ['governed-run-authority-contract.js', runAuthority],
  ['store.js', store]
]) {
  assert.equal(/inputMicroUsdPerMillionTokens\s*:/.test(source), false,
    `${label} supplies no implicit production pricing`);
}

console.log('governed leaf slice boundary test passed');
