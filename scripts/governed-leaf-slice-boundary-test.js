#!/usr/bin/env node
'use strict';

// Tranche 4 cutover boundary proof for structured leaf dispatch.
//
// The property is now the FINAL one:
//
//   structured governed leaf Run -> cannot reach the ungoverned adapter
//
// This replaces the pre-cutover assertion that the worker loop was untouched.
// The danger it guards against is unchanged and is the reason the check exists
// at all: a branch that sometimes dispatches governed and sometimes ungoverned
// depending on how complete a Run's captured state happens to be.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const store = read('persistence/postgres/store.js');
const runAuthority = read('runtime/governed-run-authority-contract.js');
const server = read('server.js');

// ── The reservation seam still contacts no provider ─────────────────────────
//
// Preparation reserves; the ORCHESTRATION dispatches. Keeping them apart is
// what makes "reserved before any provider contact" structural.

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

// ── The cutover: one branch, at the shared seam ─────────────────────────────

const seamStartIndex = server.indexOf('async function callModelProviderWithRunEvidence(');
assert.ok(seamStartIndex > 0, 'the shared provider evidence seam exists');
const seamBody = server.slice(seamStartIndex, seamStartIndex + 4_000);

// The governed decision happens BEFORE anything reaches the adapter, and it is
// the only decision: exactly one call site selects the path.
assert.ok(seamBody.includes('selectRunProviderPath(run)'),
  'the shared seam selects the provider path');
assert.equal(server.split('selectRunProviderPath(run)').length - 1, 1,
  'exactly one call site selects the provider path — two would be two policies');
assert.ok(seamBody.includes("providerPath.path === 'governed'"),
  'a governed Run takes the governed branch');
assert.ok(seamBody.includes('return await dispatchGovernedLeafModelRequest('),
  'the governed branch RETURNS, so it can never fall through to the adapter');

// The branch must sit ahead of the ungoverned call in the same function.
const governedAt = server.indexOf('dispatchGovernedLeafModelRequest({', seamStartIndex);
const ungovernedAt = server.indexOf('callModelProviderWithRunTimeout(', seamStartIndex);
assert.ok(governedAt > 0 && ungovernedAt > 0 && governedAt < ungovernedAt,
  'the governed branch precedes the ungoverned provider call');

// The governed dispatch helper must not reach an ungoverned adapter itself.
const helperStart = server.indexOf('async function dispatchGovernedLeafModelRequest(');
const helperEnd = server.indexOf('\nasync function callModelProviderWithRunEvidence(', helperStart);
const helper = server.slice(helperStart, helperEnd > 0 ? helperEnd : helperStart + 6_000);
for (const ungoverned of ['callModelProvider(', 'callOpenAI(', 'callOllama(',
  'callModelProviderWithRunTimeout(']) {
  assert.equal(helper.includes(ungoverned), false,
    `governed leaf dispatch must not reach ${ungoverned}`);
}
// It hands the orchestration a prompt and a captured cap, never a model of its
// own choosing.
assert.ok(helper.includes('run.governedExecution.economicAuthority.dispatchTarget'),
  'the governed body uses the captured dispatch target');
for (const forbidden of ['OPENAI_MODEL', 'OLLAMA_MODEL', 'agent.model', 'agent.provider']) {
  assert.equal(helper.includes(forbidden), false,
    `governed leaf dispatch must not read ${forbidden}`);
}
// One identity for both ledgers.
assert.ok(helper.includes('logicalSourceIdentity: budgetSourceIdentity'),
  'the economic reservation and the runtime budget share one source identity');

// ── No feature flag selects between two structured leaf paths ───────────────

const orchestration = read('runtime/governed-leaf-orchestration.js');
for (const flag of ['process.env.GOVERNED', 'featureFlag', 'ENABLE_GOVERNED', 'useGoverned']) {
  assert.equal(server.includes(flag) || orchestration.includes(flag), false,
    `no ${flag} may select between structured leaf paths`);
}

// ── Path selection is total and fails closed ────────────────────────────────

const select = orchestration.slice(
  orchestration.indexOf('function selectRunProviderPath('),
  orchestration.indexOf('// ── One provider-request opportunity'));
assert.ok(select.includes("path: 'historical'"), 'historical Runs keep the old path');
assert.ok(select.includes("path: 'governed'"), 'governed Runs take the governed path');
assert.ok(select.includes("refuse('governed_leaf_authority_invalid'"),
  'damaged governed authority refuses rather than selecting a path');
// A defect must never be swallowed into the historical branch.
assert.equal(/catch\s*\(error\)\s*\{\s*return/.test(select), false,
  'path selection never converts a defect into a historical Run');
for (const temporal of ['createdAt', 'admittedAt', 'Date.now', 'new Date(']) {
  assert.equal(select.includes(temporal), false,
    `path selection must not use ${temporal} to distinguish historical records`);
}

// ── Historical and unrelated paths still reach the adapter ──────────────────

assert.ok(server.includes('callModelProviderWithRunTimeout(run, agent, input'),
  'the historical provider path remains for ungoverned Runs');
// The compiler, workflow, browser and simulation call sites are unchanged: they
// all pass through the same seam, and the seam only diverts governed leaf Runs.
for (const site of ["slot: 'contract-compile:0'", 'simulation: true']) {
  assert.ok(server.includes(site), `${site} remains present and unchanged`);
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
