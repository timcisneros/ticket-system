#!/usr/bin/env node
'use strict';

// Tranche 6 — the DURABLE PROVIDER-TRANSPORT OBSERVATION.
//
// THE FACT THAT DID NOT EXIST. The durable record proved a provider request was
// authorized (`provider.request.persisted`) and that a response came back
// (`provider.response.persisted`). Between them there was nothing, so a Run with
// a request and no response was indistinguishable from three different
// histories: production never reached its transport, production invoked it and
// died mid-flight, or the provider answered and the response could not be
// stored. After an ephemeral evaluation database is gone, "was the provider
// actually called?" had no durable answer at all.
//
// `provider.request.persisted` CANNOT BE THAT ANSWER, and the first assertions
// below are about exactly that: it is written after admission and after dispatch
// authority is won but BEFORE any byte leaves, so projecting it as a transport
// attempt would state something production never observed.
//
// WHAT IS PROVED HERE:
//
//   1. the observation is recorded by the ACTUAL transport owners, and by
//      nothing above them;
//   2. it is recorded AFTER the platform call, so it can never claim an
//      invocation that did not happen;
//   3. it is durably ordered between the request and response facts;
//   4. it exists for all three roles, on both production transports;
//   5. an economic reservation can never masquerade as one, in either
//      direction;
//   6. it carries no credential material.
//
// ZERO EXTERNAL CALLS: the final network hop is replaced throughout.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const {
  FORBIDDEN_PAYLOAD_KEYS,
  PROVIDER_TRANSPORT_INVOKED_EVENT,
  PROVIDER_TRANSPORT_INVOKED_STRENGTH,
  TRANSPORT_INVOCATION_ROLES,
  TRANSPORT_OWNERS,
  buildProviderTransportInvocationPayload
} = require('../runtime/provider-transport-observation');
const {
  createOpenAiGovernedTransport, GOVERNED_OPENAI_ENDPOINT
} = require('../runtime/governed-openai-transport');
const {
  dispatchGovernedRequest
} = require('../runtime/governed-provider-transport');
const liveManifest = require('../config/structured-allocation-evaluation-live-v3.json');

const CONTROLS = Object.freeze({
  temperature: liveManifest.sampling.temperature,
  topP: liveManifest.sampling.topP,
  maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
});

// ── PART 1 — the contract and the transport owners, hermetically ────────────
//
// No database and no server. These prove the properties that make the durable
// fact trustworthy, at the modules that own them.

function hermeticPart(assertThat) {
  // THE NAME IS NOT A CLAIM ABOUT DELIVERY. Application code cannot prove that
  // bytes reached a network by invoking fetch, so the contract says so as data
  // rather than as prose that can drift away from the code.
  assertThat(PROVIDER_TRANSPORT_INVOKED_EVENT === 'provider.transport_invoked',
    'the durable fact is provider.transport_invoked');
  assertThat(PROVIDER_TRANSPORT_INVOKED_STRENGTH.recordedRelativeToInvocation === 'after',
    'the contract states it is recorded AFTER the platform call, not before it');
  assertThat(/UNKNOWN/.test(PROVIDER_TRANSPORT_INVOKED_STRENGTH.absenceMeans),
    'and that ABSENCE means UNKNOWN, never proof of non-invocation');
  for (const claim of ['reached the network', 'provider received']) {
    assertThat(PROVIDER_TRANSPORT_INVOKED_STRENGTH.doesNotProve
      .some(statement => statement.includes(claim)),
    `the contract explicitly disclaims "${claim}"`);
  }

  // THE OWNER IS DERIVED FROM THE ROLE, NEVER SUPPLIED. A caller that could
  // name its own transport owner could record a high-level dispatch site as
  // though it were the wire.
  const claimed = buildProviderTransportInvocationPayload({
    role: 'governed_leaf_worker', evidenceKey: 'k',
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
    transportOwner: 'some-dispatch-helper'
  });
  assertThat(claimed.transportOwner === TRANSPORT_OWNERS.governed_leaf_worker,
    'a caller cannot substitute its own transportOwner');
  assertThat(TRANSPORT_INVOCATION_ROLES.length === 3,
    'three roles, one per production request path');

  // NO CREDENTIAL MATERIAL, refused at the input rather than dropped silently.
  for (const key of ['Authorization', 'apiKey', 'credentialHash', 'headers']) {
    let refusal = null;
    try {
      buildProviderTransportInvocationPayload({
        role: 'ungoverned_worker', evidenceKey: 'k',
        endpointIdentity: GOVERNED_OPENAI_ENDPOINT, [key]: 'x'
      });
    } catch (error) { refusal = error; }
    assertThat(refusal !== null &&
      refusal.code === 'PROVIDER_TRANSPORT_OBSERVATION_CREDENTIAL_MATERIAL',
    `a payload carrying ${key} is REFUSED, not quietly dropped`);
  }
  assertThat(FORBIDDEN_PAYLOAD_KEYS.includes('authorization') &&
    FORBIDDEN_PAYLOAD_KEYS.includes('body'),
  'the refused-key list covers the credential header and the request body');

  return { claimed };
}

// The governed transport owner, driven directly with an injected `https.request`
// so the ORDER of the platform call and the observation can be observed.
async function governedTransportOrdering(assertThat) {
  const order = [];
  const httpsRequest = (options, onResponse) => {
    const request = {
      on() { return request; },
      end() {
        order.push('https.request:end');
        setImmediate(() => onResponse({
          statusCode: 200,
          on(event, handler) {
            if (event === 'data') handler(Buffer.from(JSON.stringify({
              id: 'resp_1',
              output: [{ content: [{ type: 'output_text', text: 'ok' }] }]
            })));
            if (event === 'end') handler();
            return this;
          }
        }));
        return request;
      }
    };
    order.push('https.request:invoked');
    return request;
  };

  const transport = createOpenAiGovernedTransport({ httpsRequest });
  let observed = null;
  const result = await transport({
    endpointIdentity: GOVERNED_OPENAI_ENDPOINT,
    serializedRequest: '{"model":"m"}',
    credentials: { apiKey: 'test-only-not-a-real-key' },
    timeoutMs: 1000,
    maxResponseBytes: 65_536,
    observeTransportInvocation: payload => {
      order.push('observation');
      observed = payload;
      return null;
    },
    transportInvocationIdentity: {
      role: 'governed_leaf_worker', evidenceKey: 'probe-key'
    }
  });

  assertThat(result.text === 'ok', 'the governed transport still returns its response');
  assertThat(order[0] === 'https.request:invoked' && order[1] === 'https.request:end',
    'the platform call happens first, with the payload already handed to it');
  assertThat(order.indexOf('observation') > order.indexOf('https.request:end'),
    'THE OBSERVATION IS RECORDED AFTER THE PLATFORM CALL, so it can never ' +
    'claim an invocation that did not happen');
  assertThat(observed && observed.transportOwner === TRANSPORT_OWNERS.governed_leaf_worker &&
    observed.requestByteCount === Buffer.byteLength('{"model":"m"}', 'utf8'),
  'and it names the real transport owner and the exact byte count');

  // NOTHING IS RECORDED WHEN THE TRANSPORT IS NEVER REACHED. This is the
  // property that stops an authorized-but-undispatched request from looking
  // dispatched: the observer lives BELOW every refusal, not above them.
  let refusedObservations = 0;
  const refused = await dispatchGovernedRequest({
    startResult: {
      reservation: {
        id: 7, state: 'request_started', serializedRequest: '{"model":"m"}',
        modelRequestOrdinal: 1,
        preparedRequest: {
          adapterId: 'openai.responses.v1', provider: 'openai',
          dispatchTarget: 'gpt-4o-mini-2024-07-18', targetEvidenceHash: 'hash',
          endpointIdentity: GOVERNED_OPENAI_ENDPOINT, requestHash: 'other-hash'
        },
        economicAuthority: {
          adapterId: 'openai.responses.v1', provider: 'openai',
          dispatchTarget: 'gpt-4o-mini-2024-07-18', targetEvidenceHash: 'hash'
        },
        exactRequestHash: 'authorized-hash'
      },
      serializedRequest: '{"model":"m"}'
    },
    transport,
    observeTransportInvocation: () => { refusedObservations += 1; },
    transportInvocationIdentity: { role: 'governed_leaf_worker', evidenceKey: 'k' }
  }).catch(error => error);
  assertThat(refused && refused.code === 'GOVERNED_TRANSPORT_REFUSED',
    'a request whose bytes disagree with its authorization is refused at dispatch');
  assertThat(refusedObservations === 0,
    'and NO transport observation is recorded — the refusal never reached the wire');
}

// ── PART 2 — the durable record, across all three roles ─────────────────────

async function durablePart(assertThat, { store, workspaceRoot, startServer }) {
  const root = path.join('/tmp', `ticket-system-transport-observation-${process.pid}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'fixture'), { recursive: true });
  const budgetRoot = path.join(root, 'budget');
  fs.mkdirSync(budgetRoot, { recursive: true });

  const liveBudget = {
    runRoot: budgetRoot,
    ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
    perRequestMicroUsd: liveManifest.economics.liability.perRequestMicroUsd,
    runtimeMaxModelRequestsPerRun:
      liveManifest.economics.liability.runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests
  };

  const ticketsByArm = {};
  const runArm = async (label, armId, { observationFault = null } = {}) => {
    const before = Number((await store.pool.query(
      `SELECT COALESCE(max(id), 0) AS id FROM ${store.table('tickets')}`)).rows[0].id);
    try {
      await runTrial({
        store, startServer, workspaceRoot,
        scenario: getScenario('family-1-simple'), arm: ARMS[armId],
        repetition: 1, seed: `transport-observation-${label}`,
        outputPath: path.join(root, 'fixture', `${label}.json`),
        commit: 'transport-observation-proof', smokeRoot: root,
        namespaceRoot: path.join(root, `ns-${label}`),
        mode: 'live',
        liveRequestControls: CONTROLS,
        liveTransportCapture: path.join(root, `capture-${label}.jsonl`),
        liveProviderTransportObservationFault: observationFault,
        liveBudget
      });
    } catch (_) { /* the product outcome is not what this suite measures */ }
    ticketsByArm[label] = (await store.pool.query(
      `SELECT id FROM ${store.table('tickets')} WHERE id > $1 ORDER BY id`,
      [before])).rows.map(row => Number(row.id));
    return ticketsByArm[label];
  };

  for (const armId of ['A', 'B']) await runArm(armId, armId);

  const allTicketIds = [...ticketsByArm.A, ...ticketsByArm.B];
  const events = (await store.pool.query(
    `SELECT type, ticket_id, run_id, seq, payload FROM ${store.table('events')}
      WHERE ticket_id = ANY($1::bigint[]) ORDER BY seq`, [allTicketIds])).rows;
  const invocations = events.filter(event =>
    event.type === PROVIDER_TRANSPORT_INVOKED_EVENT);

  // ── ALL THREE ROLES, ON BOTH PRODUCTION TRANSPORTS ──────────────────────
  const byRole = {};
  for (const role of TRANSPORT_INVOCATION_ROLES) {
    byRole[role] = invocations.filter(event => event.payload.role === role).length;
    assertThat(byRole[role] >= 1,
      `${role}: a durable transport-invocation observation exists (${byRole[role]})`);
  }
  assertThat(invocations.every(event =>
    event.payload.transportOwner === TRANSPORT_OWNERS[event.payload.role]),
  'every observation names the production function that made the platform call');
  assertThat(invocations.some(event =>
    event.payload.transportOwner.includes('callOpenAI:global-fetch')) &&
    invocations.some(event =>
      event.payload.transportOwner.includes('governed-openai-transport.js:https.request')),
  'both production transports are represented — fetch and https.request');

  // ── DURABLY ORDERED BETWEEN THE TWO EXISTING PROVIDER FACTS ─────────────
  //
  // Read from the append-only sequence, per Run, so this is the record's own
  // ordering rather than the order the test happened to write assertions in.
  const runIds = [...new Set(invocations.map(event => event.run_id).filter(Boolean))];
  assertThat(runIds.length >= 1, 'Run-scoped observations exist to order');
  let orderedRuns = 0;
  for (const runId of runIds) {
    const chain = events.filter(event => event.run_id === runId);
    const request = chain.find(event => event.type === 'provider.request.persisted');
    const invoked = chain.find(event => event.type === PROVIDER_TRANSPORT_INVOKED_EVENT);
    const response = chain.find(event => event.type === 'provider.response.persisted');
    if (!request || !invoked || !response) continue;
    assertThat(Number(request.seq) < Number(invoked.seq),
      `run ${runId}: the request evidence is durable BEFORE transport is invoked`);
    assertThat(Number(invoked.seq) < Number(response.seq),
      `run ${runId}: transport is invoked BEFORE the response becomes durable`);
    orderedRuns += 1;
  }
  assertThat(orderedRuns >= 1,
    `the three provider facts are durably ordered on ${orderedRuns} Run(s)`);

  // ── THE PLANNER'S OBSERVATION IS TICKET-SCOPED ──────────────────────────
  const planner = invocations.filter(event => event.payload.role === 'structured_planner');
  assertThat(planner.every(event => event.run_id === null),
    'the structured planner binds its Ticket, because a planning attempt has no Run');
  assertThat(planner.every(event => Number.isInteger(event.payload.reservationId) &&
    event.payload.reservationId > 0),
  'and binds the economic reservation that is its canonical request identity');

  // ── AN ECONOMIC RESERVATION IS NOT A TRANSPORT ATTEMPT ──────────────────
  //
  // Both directions of the confusion are refused here.
  //
  // FORWARD: `provider.request.persisted` is a different event with a different
  // payload, and it exists for requests whose transport observation does not.
  assertThat(events.some(event => event.type === 'provider.request.persisted') &&
    !events.some(event => event.type === 'provider.request.persisted' &&
      event.payload.transportOwner !== undefined),
  'provider.request.persisted carries no transport-owner fact and is not the ' +
  'transport observation');

  // REVERSE: arm A holds ZERO governed economic reservations while its
  // transport WAS invoked. A projection that read reservation counts as
  // transport attempts would report zero calls for a Run that made one.
  const armAReservations = Number((await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = ANY($1::bigint[])`, [ticketsByArm.A])).rows[0].n);
  const armAInvocations = invocations.filter(event =>
    ticketsByArm.A.includes(Number(event.ticket_id))).length;
  assertThat(armAReservations === 0 && armAInvocations >= 1,
    `arm A: ${armAReservations} economic reservations and ${armAInvocations} ` +
    'transport invocation(s) — a reservation count can never stand in for a ' +
    'transport count');

  // ── NO CREDENTIAL MATERIAL IN THE DURABLE RECORD ────────────────────────
  const serialized = JSON.stringify(invocations.map(event => event.payload));
  for (const forbidden of FORBIDDEN_PAYLOAD_KEYS) {
    assertThat(!new RegExp(`"${forbidden}"`, 'i').test(serialized),
      `no durable observation carries a ${forbidden} field`);
  }
  assertThat(!/sk-[A-Za-z0-9]{8}/.test(serialized),
    'and no credential value appears in any observation');

  // ── THE OBSERVATION BINDS A CANONICAL IDENTITY ──────────────────────────
  assertThat(invocations.every(event =>
    typeof event.payload.evidenceKey === 'string' &&
    event.payload.evidenceKey.startsWith('provider-transport:')),
  'every observation carries its canonical evidence key');
  assertThat(invocations.filter(event => event.run_id !== null).every(event =>
    typeof event.payload.providerRequestEvidenceKey === 'string' &&
    event.payload.providerRequestEvidenceKey.startsWith('provider-request:')),
  'a Run-scoped observation names the provider request it belongs to');
  assertThat(invocations.every(event =>
    event.payload.endpoint === GOVERNED_OPENAI_ENDPOINT &&
    event.payload.method === 'POST' &&
    Number.isInteger(event.payload.requestByteCount) &&
    event.payload.requestByteCount > 0),
  'and the endpoint, method and bounded byte count it was invoked with');
  assertThat(invocations.every(event =>
    event.payload.recordedRelativeToInvocation === 'after'),
  'each carries its own strength — recorded AFTER the platform call');

  // ── AN OBSERVATION THAT DOES NOT PERSIST CHANGES NOTHING ────────────────
  //
  // THE GOVERNED TRANSPORT, UNDER A FAILED EVIDENCE WRITE. Arm B is the only
  // configuration that drives `https.request` through a real planner, a real
  // admitted plan and real governed leaf Runs, so it is where the governed half
  // of the invariant has to be proved.
  //
  // The fault is armed at the store method that writes the observation, so the
  // seam, the transport owner, the dispatch contract and both orchestrations all
  // run as production. If a failed write could still cancel a provider result,
  // arm B would lose its plan, its leaf Runs, or its settlement.
  await runArm('B-observation-write-fails', 'B',
    { observationFault: path.join(root, 'governed-observation-fault.log') });

  const faultedTickets = ticketsByArm['B-observation-write-fails'];
  const faultedEvents = (await store.pool.query(
    `SELECT type, run_id, payload FROM ${store.table('events')}
      WHERE ticket_id = ANY($1::bigint[]) ORDER BY seq`, [faultedTickets])).rows;
  const countOf = (rows, type) => rows.filter(event => event.type === type).length;

  assertThat(fs.existsSync(path.join(root, 'governed-observation-fault.log')),
    'governed observation fault: the durable observation write really did fail');
  assertThat(countOf(faultedEvents, PROVIDER_TRANSPORT_INVOKED_EVENT) === 0,
    'governed observation fault: NO transport-invocation event is durable');

  // The governed chain still happened, in full.
  const baseline = events.filter(event => ticketsByArm.B.includes(Number(event.ticket_id)));
  for (const type of ['provider.request.persisted', 'provider.response.persisted',
    'ticket.economic_request_started']) {
    assertThat(countOf(faultedEvents, type) === countOf(baseline, type) &&
      countOf(faultedEvents, type) > 0,
    `governed observation fault: ${type} count is unchanged ` +
    `(${countOf(faultedEvents, type)})`);
  }
  const leafRuns = async ticketIds => Number((await store.pool.query(
    `SELECT count(*)::int AS n FROM ${store.table('runs')}
      WHERE ticket_id = ANY($1::bigint[]) AND body ? 'leafRunBinding'`,
    [ticketIds])).rows[0].n);
  assertThat(await leafRuns(faultedTickets) === await leafRuns(ticketsByArm.B) &&
    await leafRuns(faultedTickets) > 0,
  `governed observation fault: the planner's answer still produced the same ` +
  `number of real leaf Runs (${await leafRuns(faultedTickets)})`);

  // NO RETRY, NO DUPLICATE REQUEST, NO ECONOMIC DIFFERENCE.
  const capturedFor = label => {
    const file = path.join(root, `capture-${label}.jsonl`);
    return fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
  };
  assertThat(capturedFor('B-observation-write-fails') === capturedFor('B'),
    `governed observation fault: exactly the same number of outbound provider ` +
    `requests (${capturedFor('B-observation-write-fails')}) — no retry, no duplicate`);
  const settlementFor = async ticketIds => (await store.pool.query(
    `SELECT state, count(*)::int AS n FROM ${store.table('economic_request_reservations')}
      WHERE ticket_id = ANY($1::bigint[]) GROUP BY state ORDER BY state`,
    [ticketIds])).rows;
  assertThat(JSON.stringify(await settlementFor(faultedTickets)) ===
    JSON.stringify(await settlementFor(ticketsByArm.B)),
  'governed observation fault: identical reservation states — settlement is ' +
  'unchanged, so nothing was closed at the authorized maximum that would not ' +
  'have been');

  console.log('  observations by role:');
  for (const role of TRANSPORT_INVOCATION_ROLES) {
    console.log(`    ${role.padEnd(22)} ${byRole[role]}`);
  }
}

async function main() {
  console.log('provider transport invocation observation');
  const assertThat = createAsserter();
  hermeticPart(assertThat);
  await governedTransportOrdering(assertThat);

  await withHarness('provider transport invocation observation',
    async context => { await durablePart(assertThat, context); },
    { timeoutMs: 900_000 });

  assert.equal(typeof assertThat.count(), 'number');
  console.log(`\n  (${assertThat.count()} transport observation assertions)`);
  console.log('  EXTERNAL PROVIDER CALLS MADE: 0');
  console.log('provider transport invocation PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
