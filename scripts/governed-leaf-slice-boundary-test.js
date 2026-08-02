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
// Development cutover vocabulary: a Run with neither field is `ungoverned`
// (an ordinary non-structured product path), NOT `historical`. There is no
// permanent historical-structured category to select.
assert.ok(select.includes("path: 'ungoverned'"),
  'non-structured Runs keep the existing provider path');
assert.equal(select.includes("path: 'historical'"), false,
  'no historical-structured path remains to be selected');
assert.ok(select.includes("path: 'governed'"), 'governed Runs take the governed path');
assert.ok(select.includes("refuse('governed_leaf_authority_invalid'"),
  'damaged or unpaired governed authority refuses rather than selecting a path');
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

// ── The binding and the authority are inseparable ───────────────────────────

assert.ok(runAuthority.includes("refuse('governed_run_binding_authority_mismatch'"),
  'a leaf binding without authority, and authority without a binding, both refuse');
assert.ok(store.includes('assertRunGovernedExecutionPairing(run,'),
  'the canonical pairing rule is enforced in the store');
// Enforced on both write and read, so malformed state can neither enter nor
// leave the runtime.
// One import plus two enforcement sites: creation and reconstruction. Every
// other read path inherits it through reconstruction.
// Two enforcement sites: creation and reconstruction. Every other read path —
// scheduler, recovery, retry, projection — inherits it through reconstruction.
assert.equal(store.split('assertRunGovernedExecutionPairing(').length - 1, 2,
  'the pairing rule guards creation and reconstruction');
// Leaf admission has no ungoverned route.
assert.ok(store.includes('GOVERNED_LEAF_CAPTURE_REQUIRED'),
  'structured leaf admission requires governed capture');

// ── Partial governed state can never degrade to the ungoverned path ─────────

assert.ok(runAuthority.includes("refuse('governed_run_authority_partial'"),
  'partial governed state refuses');
// `classifyRunGovernance` must throw on a defect rather than returning a
// non-structured result — the only thing standing between a damaged envelope
// and silent ungoverned execution. Scoped to that function alone: the pairing
// helper below it legitimately catches to re-label and rethrow.
const classifyStart = runAuthority.indexOf('function classifyRunGovernance(');
const classify = runAuthority.slice(classifyStart,
  runAuthority.indexOf('\nfunction ', classifyStart + 10));
assert.equal(/catch\s*\(/.test(classify), false,
  'classification must not swallow a defect into the non-structured branch');
assert.ok(classify.includes('normalizeGovernedRunAuthority('),
  'classification normalizes rather than shape-testing');

// Age is never used to decide governance.
for (const temporal of ['createdAt', 'admittedAt', 'Date.now', 'new Date(']) {
  assert.equal(classify.includes(temporal), false,
    `governance must not be inferred from ${temporal}`);
}

// ── Tranche 5 (A3): the governed path consults no resettable counter ────────
//
// `stalledResponses` and the inspection-no-progress counter reset on recovery —
// `server.js` still carries "We don't track stalled across restarts". A model
// could evade them indefinitely by crashing, which is exactly what pending
// decision A3 records. They may remain for the intentionally unsupported
// historical paths, but the GOVERNED leaf decision must never read them.

const governedHelperStart = server.indexOf(
  'async function dispatchGovernedLeafModelRequest(');
const governedHelperEnd = server.indexOf(
  '\nasync function callModelProviderWithRunEvidence(', governedHelperStart);
const governedHelper = server.slice(governedHelperStart, governedHelperEnd);
for (const resettable of [
  'stalledResponses', 'noProgressResponses',
  'INSPECTION_NO_PROGRESS_THRESHOLD', 'inspectionNoProgress'
]) {
  assert.equal(governedHelper.includes(resettable), false,
    `governed leaf dispatch must not consult ${resettable}: it resets on recovery`);
}

// The durable authority does the deciding instead.
const progressEvaluation = read('runtime/governed-progress-evaluation.js');
for (const resettable of ['stalledResponses', 'noProgressResponses']) {
  assert.equal(progressEvaluation.includes(resettable), false,
    `the durable progress evaluation must not reference ${resettable}`);
}
// And it reads no clock: every input is an ordered durable row.
assert.equal(/Date\.now\(\)/.test(progressEvaluation), false,
  'progress evaluation never reads process time');

// The pre-reservation gate is the governed authority, and it is durable.
assert.ok(store.includes('readGovernedRunProgressState('),
  'the store reconstructs progress from durable rows');
assert.ok(store.includes('permitsGovernedRequest(evaluated.decision)'),
  'the pre-reservation gate consults the durable churn decision');
// The cutoff is captured in ONE statement and every query filters to it.
assert.ok(store.includes('receipt_cutoff'),
  'the evaluation captures an explicit receipt cutoff');
assert.ok(store.includes('AND id <= $2'),
  'queries filter to the captured cutoff');

// ── Tranche 5: the sibling-read preflight precedes every filesystem branch ──
//
// A post-read check would already have leaked sibling content, so position is
// the property that matters, not merely presence.

const readFnStart = server.indexOf(
  'async function executeWorkspaceOperationUnlocked(');
assert.ok(readFnStart > 0, 'the workspace read seam exists');
const readFn = server.slice(readFnStart, readFnStart + 8_000);
const preflightAt = readFn.indexOf('assertGovernedSiblingReadAllowed(run, args');
assert.ok(preflightAt > 0, 'the read seam performs the sibling preflight');
// The guard must be REACHABLE, not merely present: a disabled condition leaves
// the call in the source while never running it.
assert.ok(readFn.includes('if (AGENT_READ_OPERATIONS.includes(operation)) {'),
  'the preflight is guarded by the read-operation condition, not disabled');
for (const branch of ["if (operation === 'listDirectory')", "if (operation === 'readFile')"]) {
  const branchAt = readFn.indexOf(branch);
  if (branchAt > 0) {
    assert.ok(preflightAt < branchAt,
      `the preflight precedes the ${branch} filesystem branch`);
  }
}
// It guards reads only. Mutations are already confined by admitted ownership.
assert.ok(server.includes(
  "const AGENT_READ_OPERATIONS = Object.freeze(['listDirectory', 'readFile'])"),
'the guard applies to read operations');

// Blocking persists BEFORE it throws — the rollback trap the churn gate found.
const guardStart = server.indexOf('async function assertGovernedSiblingReadAllowed(');
const guard = server.slice(guardStart, readFnStart);
const persistAt = guard.indexOf('blockGovernedRunForSiblingRead');
const throwAt = guard.indexOf("error.code = 'GOVERNED_SIBLING_READ_BLOCKED'");
assert.ok(persistAt > 0 && throwAt > 0 && persistAt < throwAt,
  'the block is persisted before the refusal is raised');
// Terminal for the execution, not an ordinary tool error the loop can continue past.
assert.ok(guard.includes("error.failureKind = 'no_progress'"),
  'a sibling block stops the worker execution');
// Non-structured Runs return before any resolution happens.
assert.ok(guard.includes('!run.leafRunBinding || !run.governedExecution) return;'),
  'historical and non-structured Runs are untouched by the guard');
// One resolver, one block authority, no second path matcher.
assert.equal(guard.includes('normalizeWorkspaceRelativePath'), false,
  'the guard does not implement its own path normalization');

// ── No production pricing ships in this slice ───────────────────────────────

for (const [label, source] of [
  ['governed-run-authority-contract.js', runAuthority],
  ['store.js', store]
]) {
  assert.equal(/inputMicroUsdPerMillionTokens\s*:/.test(source), false,
    `${label} supplies no implicit production pricing`);
}

console.log('governed leaf slice boundary test passed');
