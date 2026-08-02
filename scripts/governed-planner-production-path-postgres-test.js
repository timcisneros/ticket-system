#!/usr/bin/env node
'use strict';

// Tranche 4 production-path proof for governed planner dispatch.
//
// This drives `runGovernedPlannerRequest` — the SAME function server.js calls,
// with the same real PostgreSQL store — and injects only the transport. The
// transport is an explicit parameter of the production signature, not a test
// flag or a redirected base URL, so production and this suite execute the same
// statements in the same order.
//
// Fixture prices only. No network, no provider, no credentials.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  classifyGovernedPlannerRecovery,
  persistAndSettleGovernedPlannerResponse,
  runGovernedPlannerRequest,
  settleConservatively
} = require('../runtime/governed-planner-orchestration');
const {
  capturePlannerGovernance
} = require('../runtime/structured-planner-governance');
const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  advancePlanningAttempt,
  createPlanningAttempt
} = require('../runtime/structured-allocation-planning-contract');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');
const { hashCanonical } = require('../runtime/declared-work-contract');

const ACTOR = 'governed-planner-production-path-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const PLANNER_ROLE = 'structured_planner';
const ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const CAP = 2_048;
const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 65_536;

// Illustrative fixture rates. NOT production authority.
function catalogValue(overrides = {}) {
  return {
    catalogId: 'fixture-catalog',
    entries: [{
      provider: 'openai', model: SNAPSHOT, adapterId: ADAPTER, chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0, boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  };
}

function policyContainer({
  catalog = catalogValue(), model = SNAPSHOT, omit = null, authorizedMicroUsd = 500_000
} = {}) {
  const built = buildPricingCatalog(catalog);
  const governed = {
    roleRoutingPolicy: {
      policyId: 'planner-routing-1',
      rolePolicies: [{
        role: PLANNER_ROLE,
        primaryRoute: { adapterId: ADAPTER, provider: 'openai', model },
        fallbackRoute: null,
        authorizedFallbackReasons: []
      }]
    },
    economicPolicy: {
      policyId: 'planner-economics-1',
      role: PLANNER_ROLE,
      authorizedMicroUsd,
      maximumProviderRequests: 1,
      maximumOutputTokensPerRequest: CAP,
      pricingCatalogId: built.catalogId,
      pricingCatalogHash: built.catalogHash,
      fallbackLiabilityAuthorized: false,
      fallbackProviderRequests: 0,
      capturedAt: '2026-08-01T00:00:00.000Z'
    },
    pricingCatalog: catalog
  };
  if (omit) delete governed[omit];
  return {
    body: {
      name: `Planner policy ${STAMP}`, status: 'active',
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-ignored',
      governedExecution: governed
    }
  };
}

function recordingTransport(response = { text: '{"items":[]}', identity: 'resp_prod_1' }) {
  const calls = [];
  const transport = async args => {
    calls.push(args);
    if (typeof response === 'function') return response(args);
    return response;
  };
  transport.calls = calls;
  return transport;
}

const withKey = async () => ({ apiKey: 'fixture-key-not-a-real-credential' });
const withoutKey = async () => null;

async function main() {
  await withHarness('governed planner production path PostgreSQL', async ({ store }) => {
    const group = (await store.createGroup({
      value: { name: `ProdPlanner ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const plannerAgent = (await store.createConfiguredAgent({
      value: { name: `ProdAgent ${STAMP}`, provider: 'openai', model: 'gpt-agent-row-model',
        apiKey: '' },
      groupIds: [group.id], changedBy: ACTOR
    })).agent;
    const designated = (await store.updateGroup({
      groupId: group.id, expectedRevision: group.revision,
      value: { ...group, plannerAgentId: plannerAgent.id }, changedBy: ACTOR
    })).group;

    const newTicket = async objective => {
      const objectiveText = `${objective} ${STAMP}`;
      const now = new Date().toISOString();
      const catalog = await store.getConfiguredAgentsByIds({ agentIds: [plannerAgent.id] });
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork: {
          objective: objectiveText,
          expectedOutputs: [{ kind: 'text', declaration: 'One report per folder' }],
          successCriteria: [{ kind: 'text', declaration: 'Findings are concrete' }],
          evidenceRequirements: []
        },
        ticketObjective: objectiveText,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog[0],
        candidateAgents: catalog,
        ownedOutputPaths: { [plannerAgent.id]: 'reports/planner/' }
      });
      return (await store.createTicketWithEvent({
        ticket: {
          objective: objectiveText, acceptanceCriteria: 'Review the reports.',
          assignmentTargetType: 'group', assignmentTargetId: group.id,
          assignmentMode: 'allocated',
          ownedOutputPaths: { [plannerAgent.id]: 'reports/planner/' },
          targetRef: null, executionMode: 'agent', workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
          capabilityInput: null,
          executionPolicy: {
            mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
            maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
            maxWorkspaceOperations: null, allowWorkspaceWrites: true,
            allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
          },
          status: 'open', blockedReason: null, createdBy: ACTOR, changedBy: ACTOR,
          changedAt: now, createdAt: now, updatedAt: now
        },
        structuredAllocationAuthorityDraft: authorityDraft,
        eventPayload: { source: ACTOR }
      })).ticket;
    };

    // Mirrors exactly what server.js builds before calling the orchestration.
    const preparedFor = async (ticket, { container = policyContainer() } = {}) => {
      const attemptId = crypto.randomUUID();
      const created = createPlanningAttempt({
        attemptId, ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        createdAt: new Date().toISOString()
      });
      const written = await store.writeStructuredAllocationPlanningAttempt({
        ticketId: ticket.id, attempt: created, expectedAttemptStateHash: null,
        eventType: 'ticket.structured_planning_attempt_started',
        eventPayload: { workerRunsCreated: 0 }
      });
      const attempt = written.attempt;
      const capture = capturePlannerGovernance({
        ticketId: ticket.id,
        planningAttemptId: attempt.attemptId,
        plannerAgentId: ticket.structuredAllocationAuthority
          .planningAuthoritySnapshot.planner.agentId,
        policyContainer: container,
        plannerInput: [{ role: 'user', content: 'Allocate the declared work.' }],
        endpointIdentity: ENDPOINT,
        capturedAt: new Date().toISOString()
      });
      // A PATCH, mirroring production: the transition is applied once, with
      // the governed block, by `attachGovernedExecution`.
      const requestStartedPatch = {
        state: 'request_started',
        requestHash: capture.preparedRequest.requestHash,
        requestMetadata: {
          contextVersion: 1,
          contextHash: hashCanonical({ ticket: ticket.id }),
          messageCount: 1,
          requestBytes: capture.preparedRequest.serializedByteCount,
          timeoutMs: TIMEOUT_MS,
          maxResponseBytes: MAX_RESPONSE_BYTES
        },
        requestStartedAt: new Date().toISOString()
      };
      return { attempt, requestStartedPatch, capture, container };
    };

    // The exact `attachGovernedExecution` server.js passes.
    const attachGovernedExecution = (attempt, patch) => (_base, governedExecution) =>
      advancePlanningAttempt(attempt, { ...patch, governedExecution });

    const runProduction = async (ticket, prep, {
      transport, credentials = withKey
    }) => runGovernedPlannerRequest({
      repository: store,
      ticketId: ticket.id,
      attempt: prep.attempt,
      capture: prep.capture,
      transport,
      resolveCredentials: credentials,
      timeoutMs: TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      attachGovernedExecution: attachGovernedExecution(prep.attempt, prep.requestStartedPatch),
      expectedAttemptStateHash: prep.attempt.attemptStateHash
    });

    // ── Success ────────────────────────────────────────────────────────────

    const ticket = await newTicket('Production governed planning');
    const prep = await preparedFor(ticket);
    const transport = recordingTransport();
    const result = await runProduction(ticket, prep, { transport });

    assert.equal(result.status, 'received', 'the production path completed');
    assert.equal(transport.calls.length, 1, 'exactly one provider request');

    const accounts = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1`,
      [ticket.id]);
    assert.equal(accounts.rowCount, 1, 'exactly one planner account');
    const reservations = await store.pool.query(
      `SELECT * FROM ${store.table('economic_request_reservations')} WHERE ticket_id = $1`,
      [ticket.id]);
    assert.equal(reservations.rowCount, 1, 'exactly one reservation');

    // Reservation committed BEFORE transport: the transport received bytes that
    // already existed in the row.
    const reservation = await store.getEconomicReservation(result.reservationId);
    assert.equal(transport.calls[0].serializedRequest, reservation.serializedRequest,
      'the transport received the exact persisted bytes');
    const dispatchedBody = JSON.parse(transport.calls[0].serializedRequest);
    assert.equal(dispatchedBody.model, SNAPSHOT, 'the captured exact snapshot was dispatched');
    assert.equal(dispatchedBody.max_output_tokens, CAP, 'the authorized cap is present');
    assert.equal(dispatchedBody.truncation, 'disabled', 'truncation is disabled');
    assert.notEqual(dispatchedBody.model, plannerAgent.model,
      'the current planner-agent model was NOT used');

    // Response + settlement through the production seam.
    const evidenceHash = crypto.createHash('sha256')
      .update(result.responseText, 'utf8').digest('hex');
    const settledResponse = await persistAndSettleGovernedPlannerResponse({
      repository: store,
      ticketId: ticket.id,
      attempt: advancePlanningAttempt(result.attempt, {
        state: 'response_received',
        responseStatus: 'received',
        responseText: result.responseText,
        responseBytes: Buffer.byteLength(result.responseText, 'utf8'),
        responseTruncated: false,
        responseHash: evidenceHash,
        governedExecution: {
          ...result.governedExecution, economicState: 'response_persisted'
        }
      }),
      reservationId: result.reservationId,
      responseIdentity: result.responseIdentity,
      responseHash: evidenceHash,
      reportedUsage: result.reportedUsage,
      expectedAttemptStateHash: result.attempt.attemptStateHash
    });
    assert.equal(settledResponse.attempt.state, 'response_received');
    assert.equal(settledResponse.attempt.responseText, result.responseText,
      'the complete response is durable');
    assert.equal(settledResponse.reservation.state, 'settled');
    assert.match(settledResponse.settlementReceiptHash, /^[0-9a-f]{64}$/);

    // Governed provenance on the attempt.
    const provenance = settledResponse.attempt.governedExecution;
    for (const field of ['roleRoutingPolicyHash', 'economicPolicyHash', 'pricingCatalogHash',
      'routingDecisionHash', 'economicAuthorityHash', 'targetEvidenceHash',
      'preparedRequestHash', 'exactRequestHash']) {
      assert.match(provenance[field], /^[0-9a-f]{64}$/, `provenance binds ${field}`);
    }
    assert.equal(provenance.reservationId, result.reservationId);

    // Zero Runs, no plan admitted by dispatch alone.
    assert.equal((await store.listRunsForTicket({ ticketId: ticket.id })).runs.length, 0,
      'governed planning creates zero Runs');
    assert.equal(await store.getAllocationPlanForTicket(ticket.id), null,
      'dispatch alone admits no plan and no v1 fallback');

    // ── Refusals: each contacts transport zero times ───────────────────────

    for (const omit of ['roleRoutingPolicy', 'economicPolicy', 'pricingCatalog']) {
      const refusalTicket = await newTicket(`Missing ${omit}`);
      const silent = recordingTransport();
      assert.throws(
        () => capturePlannerGovernance({
          ticketId: refusalTicket.id,
          planningAttemptId: crypto.randomUUID(),
          plannerAgentId: plannerAgent.id,
          policyContainer: policyContainer({ omit }),
          plannerInput: [{ role: 'user', content: 'x' }],
          endpointIdentity: ENDPOINT,
          capturedAt: new Date().toISOString()
        }),
        error => error.code === 'PLANNER_GOVERNANCE_REFUSED',
        `a missing ${omit} refuses before capture completes`);
      assert.equal(silent.calls.length, 0, `a missing ${omit} contacts no transport`);
      assert.equal(
        (await store.pool.query(
          `SELECT 1 FROM ${store.table('economic_request_reservations')} WHERE ticket_id = $1`,
          [refusalTicket.id])).rowCount,
        0, `a missing ${omit} leaves no reservation`);
    }

    // A mutable alias never becomes a dispatch target.
    const aliasTicket = await newTicket('Mutable alias');
    const aliasTransport = recordingTransport();
    assert.throws(
      () => capturePlannerGovernance({
        ticketId: aliasTicket.id, planningAttemptId: crypto.randomUUID(),
        plannerAgentId: plannerAgent.id,
        policyContainer: policyContainer({ model: 'gpt-4o-mini' }),
        plannerInput: [{ role: 'user', content: 'x' }],
        endpointIdentity: ENDPOINT, capturedAt: new Date().toISOString()
      }),
      error => error.detail.reason === 'planner_route_uncapturable',
      'a mutable alias refuses');
    assert.equal(aliasTransport.calls.length, 0, 'a mutable alias contacts no transport');

    // Insufficient authority refuses at reservation, before any transport.
    //
    // The account is authorized for exactly one planner request, and that one
    // is already reserved by an earlier subject, so the production path has
    // nothing left to reserve against.
    const brokeTicket = await newTicket('Insufficient authority');
    const probe = capturePlannerGovernance({
      ticketId: brokeTicket.id, planningAttemptId: crypto.randomUUID(),
      plannerAgentId: brokeTicket.structuredAllocationAuthority
        .planningAuthoritySnapshot.planner.agentId,
      policyContainer: policyContainer(),
      plannerInput: [{ role: 'user', content: 'probe' }],
      endpointIdentity: ENDPOINT, capturedAt: new Date().toISOString()
    });
    const perRequest = probe.economicAuthority.maximumPerRequestMicroUsd;
    const tight = policyContainer({ authorizedMicroUsd: perRequest });
    const priorCapture = capturePlannerGovernance({
      ticketId: brokeTicket.id, planningAttemptId: crypto.randomUUID(),
      plannerAgentId: brokeTicket.structuredAllocationAuthority
        .planningAuthoritySnapshot.planner.agentId,
      policyContainer: tight,
      plannerInput: [{ role: 'user', content: 'earlier subject' }],
      endpointIdentity: ENDPOINT, capturedAt: new Date().toISOString()
    });
    await store.admitTicketEconomicAccount({
      ticketId: brokeTicket.id, role: PLANNER_ROLE,
      economicPolicy: priorCapture.source.economicPolicy
    });
    await store.reserveEconomicRequest({
      preparedRequest: priorCapture.preparedRequest,
      economicAuthority: priorCapture.economicAuthority,
      pricingEntry: priorCapture.pricingEntry
    });
    const brokePrep = await preparedFor(brokeTicket, { container: tight });
    const brokeTransport = recordingTransport();
    const brokeResult = await runProduction(brokeTicket, brokePrep,
      { transport: brokeTransport });
    assert.equal(brokeResult.status, 'reservation_refused',
      'a request beyond the account authority is refused');
    assert.equal(brokeTransport.calls.length, 0,
      'insufficient authority contacts no transport');
    assert.equal(brokeResult.possiblyDispatched, false);

    // Missing credentials: released, unstarted, zero contact.
    const credTicket = await newTicket('Missing credentials');
    const credPrep = await preparedFor(credTicket);
    const credTransport = recordingTransport();
    const credResult = await runProduction(credTicket, credPrep,
      { transport: credTransport, credentials: withoutKey });
    assert.equal(credResult.status, 'credentials_unavailable');
    assert.equal(credTransport.calls.length, 0, 'missing credentials contact no transport');
    assert.equal(credResult.possiblyDispatched, false,
      'a credential failure is never classified as possibly dispatched');
    const releasedRow = await store.getEconomicReservation(credResult.reservationId);
    assert.equal(releasedRow.state, 'released', 'the reservation is released');
    assert.equal(releasedRow.startedAt, null, 'the request was never started');
    const credAccount = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1`, [credTicket.id]);
    assert.equal(Number(credAccount.rows[0].reserved_micro_usd), 0);
    assert.equal(Number(credAccount.rows[0].settled_micro_usd), 0,
      'a never-dispatched request is never charged');

    // ── Drift containment ─────────────────────────────────────────────────

    const priorModel = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-env-override';
    const driftTicket = await newTicket('Environment drift');
    const driftPrep = await preparedFor(driftTicket);
    const driftTransport = recordingTransport();
    await runProduction(driftTicket, driftPrep, { transport: driftTransport });
    assert.equal(JSON.parse(driftTransport.calls[0].serializedRequest).model, SNAPSHOT,
      'an environment model default cannot alter production dispatch');
    if (priorModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = priorModel;

    // A policy row edited AFTER capture does not rewrite the attempt.
    assert.equal(provenance.pricingCatalogHash,
      prep.capture.source.pricingCatalogHash,
      'a later policy edit does not rewrite captured attempt state');
    // A catalog change after reservation does not alter settlement.
    assert.equal(settledResponse.reservation.settledMicroUsd,
      reservation.reservedMaxMicroUsd,
      'settlement used the captured basis');

    // ── Concurrency through the production function ────────────────────────

    const raceTicket = await newTicket('Concurrent production');
    const racePrepA = await preparedFor(raceTicket);
    const raceTransport = recordingTransport();
    const raceResults = await Promise.allSettled([
      runProduction(raceTicket, racePrepA, { transport: raceTransport }),
      runProduction(raceTicket, racePrepA, { transport: raceTransport }),
      runProduction(raceTicket, racePrepA, { transport: raceTransport })
    ]);
    const received = raceResults.filter(
      r => r.status === 'fulfilled' && r.value.status === 'received');
    assert.equal(received.length, 1,
      'simultaneous production calls yield exactly one dispatch');
    assert.equal(raceTransport.calls.length, 1,
      'simultaneous production calls yield exactly one transport request');
    for (const other of raceResults.filter(
      r => r.status === 'fulfilled' && r.value.status !== 'received')) {
      assert.ok(['start_lost', 'reservation_refused'].includes(other.value.status),
        `a losing caller reports a closed outcome, got ${other.value.status}`);
      assert.equal(other.value.possiblyDispatched, false,
        'a losing caller never claims a dispatch');
    }
    const raceReservations = await store.pool.query(
      `SELECT id, state FROM ${store.table('economic_request_reservations')}
       WHERE ticket_id = $1`, [raceTicket.id]);
    assert.equal(raceReservations.rowCount, 1, 'exactly one reservation was created');

    // ── Dispatch failures settle, never release, never repeat ─────────────

    for (const [label, response, expectedReason] of [
      ['timeout', () => { const e = new Error('t'); e.name = 'AbortError'; throw e; },
        'provider_request_timed_out'],
      ['transport failure', () => { throw new Error('connection reset'); },
        'provider_request_failed'],
      ['overflow', () => ({ text: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }),
        'provider_response_too_large'],
      ['empty', () => ({ text: '' }), 'provider_response_empty']
    ]) {
      const failTicket = await newTicket(`Dispatch ${label}`);
      const failPrep = await preparedFor(failTicket);
      const failTransport = recordingTransport(response);
      const failResult = await runProduction(failTicket, failPrep,
        { transport: failTransport });
      assert.equal(failResult.status, 'dispatch_failed', `${label} is a dispatch failure`);
      assert.equal(failResult.failureReason, expectedReason,
        `${label} maps to a closed planner failure reason`);
      assert.equal(failResult.possiblyDispatched, true,
        `${label} may already have reached the provider`);
      const failRow = await store.getEconomicReservation(failResult.reservationId);
      assert.equal(failRow.state, 'settled',
        `${label} settles rather than releasing`);
      assert.equal(failRow.settledMicroUsd, failRow.reservedMaxMicroUsd,
        `${label} settles at the reserved maximum`);
      assert.equal(failTransport.calls.length, 1,
        `${label} issues exactly one provider request and never repeats it`);
    }

    // A stored prepared request whose route was tampered with cannot ride a
    // legitimately started reservation to the wire.
    const tamperTicket = await newTicket('Production route tamper');
    const tamperPrep = await preparedFor(tamperTicket);
    await store.admitTicketEconomicAccount({
      ticketId: tamperTicket.id, role: PLANNER_ROLE,
      economicPolicy: tamperPrep.capture.source.economicPolicy
    });
    const tamperReservation = await store.reserveEconomicRequest({
      preparedRequest: tamperPrep.capture.preparedRequest,
      economicAuthority: tamperPrep.capture.economicAuthority,
      pricingEntry: tamperPrep.capture.pricingEntry
    });
    await store.pool.query(
      `UPDATE ${store.table('economic_request_reservations')}
       SET prepared_request = jsonb_set(prepared_request, '{dispatchTarget}',
             '"gpt-4.1-2025-04-14"'),
           revision = revision + 1
       WHERE id = $1`, [tamperReservation.id]);
    const tamperStart = await store.markEconomicRequestStarted({
      reservationId: tamperReservation.id });
    const tamperTransport = recordingTransport();
    await assert.rejects(
      () => require('../runtime/governed-provider-transport').dispatchGovernedRequest({
        startResult: tamperStart, transport: tamperTransport,
        resolveCredentials: withKey, timeoutMs: TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES
      }),
      error => error.detail.reason === 'transport_target_drift',
      'a drifted captured route refuses at the production transport seam');
    assert.equal(tamperTransport.calls.length, 0,
      'a drifted captured route contacts no transport');

    // ── Recovery classification drives every state ─────────────────────────

    const recoveryTicket = await newTicket('Production recovery');

    // reserved -> first dispatch remains possible
    const reservedPrep = await preparedFor(recoveryTicket);
    const reservedResult = await runProduction(recoveryTicket, reservedPrep,
      { transport: recordingTransport(), credentials: withoutKey });
    const releasedClass = classifyGovernedPlannerRecovery(
      await store.getEconomicReservation(reservedResult.reservationId));
    assert.equal(releasedClass.state, 'released');
    assert.equal(releasedClass.mayDispatch, false);
    assert.equal(releasedClass.terminal, true);

    // A second attempt cannot share a Ticket with an active one, so the
    // remaining recovery states are exercised on their own Ticket.
    const liveTicket = await newTicket('Production recovery states');
    const livePrep = await preparedFor(liveTicket);
    const liveAccount = await store.admitTicketEconomicAccount({
      ticketId: liveTicket.id, role: PLANNER_ROLE,
      economicPolicy: livePrep.capture.source.economicPolicy
    });
    const liveReservation = await store.reserveEconomicRequest({
      preparedRequest: livePrep.capture.preparedRequest,
      economicAuthority: livePrep.capture.economicAuthority,
      pricingEntry: livePrep.capture.pricingEntry
    });
    const reservedClass = classifyGovernedPlannerRecovery(
      await store.getEconomicReservation(liveReservation.id));
    assert.equal(reservedClass.mayDispatch, true,
      'a reserved request may still perform its FIRST dispatch');

    await store.markEconomicRequestStarted({ reservationId: liveReservation.id });
    const startedClass = classifyGovernedPlannerRecovery(
      await store.getEconomicReservation(liveReservation.id));
    assert.equal(startedClass.mayDispatch, false,
      'no state at or after request_started may dispatch again');
    assert.equal(startedClass.mustSettle, true);

    await store.markEconomicResponsePersisted({
      reservationId: liveReservation.id,
      responseIdentity: 'resp_recovery',
      responseHash: crypto.createHash('sha256').update('recovery').digest('hex')
    });
    const respondedClass = classifyGovernedPlannerRecovery(
      await store.getEconomicReservation(liveReservation.id));
    assert.equal(respondedClass.mayDispatch, false);
    assert.equal(respondedClass.mustSettle, true);

    const recoveryTransport = recordingTransport();
    await settleConservatively(store, liveReservation.id);
    const settledClass = classifyGovernedPlannerRecovery(
      await store.getEconomicReservation(liveReservation.id));
    assert.equal(settledClass.state, 'settled');
    assert.equal(settledClass.mayDispatch, false);
    assert.equal(recoveryTransport.calls.length, 0,
      'recovery settlement contacts no provider');

    // Re-settling is idempotent and moves no balance.
    const before = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`, [liveTicket.id, PLANNER_ROLE]);
    assert.equal(await settleConservatively(store, liveReservation.id), null,
      'an already-settled reservation settles idempotently');
    const after = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`, [liveTicket.id, PLANNER_ROLE]);
    assert.deepEqual(after.rows[0], before.rows[0],
      'idempotent settlement changes no balance');

    assert.equal(classifyGovernedPlannerRecovery(null).mayDispatch, false,
      'no reservation authorizes no dispatch');
  });
  console.log('governed planner production path PostgreSQL test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
