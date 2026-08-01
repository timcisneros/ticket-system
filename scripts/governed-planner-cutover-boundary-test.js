#!/usr/bin/env node
'use strict';

// Tranche 4 cutover boundary proof.
//
// One property, asserted against the real source: a newly started structured
// planner request CANNOT reach a provider except through governed dispatch.
//
// This is a call-graph test rather than a behavioural one because the property
// is an absence — "there is no other branch" — and an absence cannot be
// demonstrated by exercising the branches that do exist.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverPath = path.join(__dirname, '..', 'server.js');
const server = fs.readFileSync(serverPath, 'utf8');

// ── The ungoverned planner call path is gone ────────────────────────────────

assert.equal(/callPlannerProviderOnce/.test(server), false,
  'the ungoverned planner helper is removed, not merely unreferenced — leaving ' +
  'two planner implementations selectable by an accidental condition is exactly ' +
  'the failure this cutover exists to prevent');

// The structured planning orchestrator must not reach a raw adapter directly.
const orchestratorStart = server.indexOf('async function runStructuredAllocationPlanning(');
assert.ok(orchestratorStart > 0, 'the structured planning orchestrator is present');
const orchestratorEnd = server.indexOf('\n}\n', server.indexOf(
  'admitStructuredAllocationPlan', orchestratorStart));
const orchestrator = server.slice(orchestratorStart,
  orchestratorEnd > 0 ? orchestratorEnd : server.length);

for (const ungoverned of ['callModelProvider(', 'callOpenAI(', 'callOllama(']) {
  assert.equal(orchestrator.includes(ungoverned), false,
    `structured planning must not reach ${ungoverned} directly`);
}

// ── Governed dispatch is the only route to the wire ─────────────────────────

for (const required of [
  'capturePlannerGovernance(',
  'runGovernedPlannerRequest(',
  'persistAndSettleGovernedPlannerResponse('
]) {
  assert.ok(orchestrator.includes(required),
    `structured planning performs ${required}`);
}

// Transport is reached only with a start result. If the orchestration ever
// called the transport with a caller-built body, this would catch it.
const orchestrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'governed-planner-orchestration.js'), 'utf8');
assert.ok(orchestrationSource.includes('startResult,'),
  'the transport is invoked with the start result');
assert.equal(/serializedRequest\s*:/.test(orchestrationSource), false,
  'the orchestration never hands the transport a request body of its own');
assert.equal(/JSON\.stringify/.test(orchestrationSource), false,
  'the orchestration never re-serializes a request');

// ── No configurable OpenAI base URL was introduced for tests ────────────────

const transportSource = fs.readFileSync(
  path.join(__dirname, '..', 'runtime', 'governed-openai-transport.js'), 'utf8');
assert.ok(transportSource.includes("'https://api.openai.com/v1/responses'"),
  'the production endpoint is the fixed official one');
for (const configurable of ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'baseUrl']) {
  assert.equal(transportSource.includes(configurable), false,
    `no ${configurable} may redirect a governed request`);
}
// The endpoint is verified per request, not merely defaulted.
assert.ok(transportSource.includes('governed OpenAI dispatch refuses endpoint'),
  'a captured request naming another endpoint is refused');

// ── Dispatch reads no current model or provider ─────────────────────────────

for (const forbidden of ['OPENAI_MODEL', 'OLLAMA_MODEL']) {
  assert.equal(orchestrationSource.includes(forbidden), false,
    `governed dispatch never reads ${forbidden}`);
  assert.equal(transportSource.includes(forbidden), false,
    `the governed transport never reads ${forbidden}`);
}
assert.equal(/\bmodel\b\s*:/.test(transportSource), false,
  'the governed transport has no model parameter to choose from');

// ── Credential resolution cannot select a route ─────────────────────────────

const credentialFn = server.slice(
  server.indexOf('async function resolveGovernedPlannerCredentials('),
  server.indexOf('function getGovernedPlannerDispatchRepository('));
assert.ok(credentialFn.includes("provider !== 'openai'"),
  'credential resolution reads only the captured provider');
for (const forbidden of ['dispatchTarget', 'routingDecision', 'model']) {
  assert.equal(credentialFn.includes(forbidden), false,
    `credential resolution must not touch ${forbidden}`);
}

// ── The governed policy container is unambiguous ────────────────────────────

const loader = server.slice(
  server.indexOf('async function loadGovernedPlannerPolicyContainer('),
  server.indexOf('let governedPlannerTransport'));
assert.ok(loader.includes('GOVERNED_PLANNER_POLICY_ABSENT'),
  'no governed policy refuses');
assert.ok(loader.includes('GOVERNED_PLANNER_POLICY_AMBIGUOUS'),
  'more than one governed policy refuses rather than picking one');

// ── No production pricing ships anywhere in the governed path ───────────────

for (const [label, source] of [
  ['server.js', server],
  ['governed-planner-orchestration.js', orchestrationSource],
  ['governed-openai-transport.js', transportSource]
]) {
  assert.equal(/inputMicroUsdPerMillionTokens\s*:/.test(source), false,
    `${label} supplies no implicit production pricing`);
}

console.log('governed planner cutover boundary test passed');
