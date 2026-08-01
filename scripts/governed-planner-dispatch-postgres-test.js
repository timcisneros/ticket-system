#!/usr/bin/env node
'use strict';

// Tranche 4 focused suite for the governed structured-planner path.
//
// Real PostgreSQL, injected deterministic transport. No network, no provider,
// no credentials, and fixture-only prices. Every assertion is about what the
// governed path will and will not do before, during and after the single
// planner provider request.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  buildGovernedExecutionState,
  capturePlannerGovernance,
  derivePlannerSettlementUsage,
  PlannerGovernanceError
} = require('../runtime/structured-planner-governance');
const {
  dispatchGovernedRequest
} = require('../runtime/governed-provider-transport');
const { canonicalJson, hashCanonical } = require('../runtime/declared-work-contract');
const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  createPlanningAttempt
} = require('../runtime/structured-allocation-planning-contract');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

const ACTOR = 'governed-planner-dispatch-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const PLANNER_ROLE = 'structured_planner';
const OPENAI_ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const AT = '2026-08-01T00:00:00.000Z';
const CAP = 2_048;
const ATTEMPT_ID = () => crypto.randomUUID();

// Illustrative fixture rates. NOT production authority.
function catalogValue(overrides = {}) {
  return {
    catalogId: 'fixture-catalog',
    entries: [{
      provider: 'openai',
      model: SNAPSHOT,
      adapterId: OPENAI_ADAPTER,
      chargingUnit: 'token',
      inputMicroUsdPerMillionTokens: 150_000,
      outputMicroUsdPerMillionTokens: 600_000,
      requestMicroUsd: 0,
      boundMethod: 'model_context_window_ceiling',
      ...overrides
    }]
  };
}

// The administrator container: an open legacy body with the three closed
// governed subdocuments inside it.
function policyContainer({
  catalog = catalogValue(), model = SNAPSHOT, omit = null, authorizedMicroUsd = 500_000
} = {}) {
  const built = buildPricingCatalog(catalog);
  const governed = {
    roleRoutingPolicy: {
      policyId: 'planner-routing-1',
      rolePolicies: [{
        role: PLANNER_ROLE,
        primaryRoute: { adapterId: OPENAI_ADAPTER, provider: 'openai', model },
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
      capturedAt: AT
    },
    pricingCatalog: catalog
  };
  if (omit) delete governed[omit];
  return {
    body: {
      name: `Planner policy ${STAMP}`,
      status: 'active',
      // Legacy siblings that governed execution must never read.
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-should-be-ignored',
      allowedProviders: ['anthropic'],
      governedExecution: governed
    }
  };
}

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [{ kind: 'text', declaration: 'Every report records concrete findings' }],
    evidenceRequirements: []
  };
}

function plannerInput() {
  return [{ role: 'user', content: 'Allocate the declared work.' }];
}

function captureOf(overrides = {}) {
  return capturePlannerGovernance({
    ticketId: overrides.ticketId,
    planningAttemptId: overrides.planningAttemptId,
    plannerAgentId: overrides.plannerAgentId,
    policyContainer: overrides.policyContainer || policyContainer(),
    plannerInput: plannerInput(),
    endpointIdentity: ENDPOINT,
    capturedAt: AT
  });
}

function recordingTransport(response = { text: '{"ok":true}', identity: 'resp_planner_1' }) {
  const calls = [];
  const transport = async args => { calls.push(args); return response; };
  transport.calls = calls;
  return transport;
}

function governanceRefusal(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PlannerGovernanceError, 'refusals use the governance error');
    assert.equal(error.code, 'PLANNER_GOVERNANCE_REFUSED');
    return error.detail.reason;
  }
  return assert.fail('expected a planner governance refusal');
}

async function code(promise, expected, why) {
  await assert.rejects(() => promise, error => {
    assert.equal(error.code, expected, `${why} (got ${error.code}: ${error.message})`);
    return true;
  }, why);
}

async function main() {
  await withHarness('governed planner dispatch PostgreSQL', async ({ store }) => {
    const group = (await store.createGroup({
      value: { name: `Planner ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const plannerAgent = (await store.createConfiguredAgent({
      value: { name: `PlannerAgent ${STAMP}`, provider: 'openai', model: 'gpt-agent-row-model',
        apiKey: '' },
      groupIds: [group.id],
      changedBy: ACTOR
    })).agent;

    const designated = (await store.updateGroup({
      groupId: group.id,
      expectedRevision: group.revision,
      value: { ...group, plannerAgentId: plannerAgent.id },
      changedBy: ACTOR
    })).group;

    const ticketBody = objective => {
      const now = new Date().toISOString();
      return {
        objective: `${objective} ${STAMP}`,
        acceptanceCriteria: 'Review the explicit reports.',
        assignmentTargetType: 'group',
        assignmentTargetId: group.id,
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
        status: 'open', blockedReason: null,
        createdBy: ACTOR, changedBy: ACTOR, changedAt: now, createdAt: now, updatedAt: now
      };
    };
    // Structured planning authority is a Tranche 2B prerequisite: the attempt
    // writer refuses a ticket that has none, which is exactly the behaviour
    // Tranche 4 must not weaken.
    const newTicket = async objective => {
      const objectiveText = `${objective} ${STAMP}`;
      const catalog = await store.getConfiguredAgentsByIds({ agentIds: [plannerAgent.id] });
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork: declaredWork(objectiveText),
        ticketObjective: objectiveText,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog[0],
        candidateAgents: catalog,
        ownedOutputPaths: { [plannerAgent.id]: 'reports/planner/' }
      });
      return (await store.createTicketWithEvent({
        ticket: ticketBody(objective),
        structuredAllocationAuthorityDraft: authorityDraft,
        eventPayload: { source: ACTOR }
      })).ticket;
    };

    // A governed attempt, built directly so this suite exercises the governed
    // seam rather than re-testing Tranche 2B planner assembly.
    const governedAttempt = (ticket, attemptId, capture, extra = {}) => {
      const created = createPlanningAttempt({
        attemptId,
        ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        createdAt: AT
      });
      const base = { ...created, ...extra };
      if (capture) base.governedExecution = capture;
      const { attemptStateHash, ...rest } = base;
      return { ...rest, attemptStateHash: hashCanonical(rest) };
    };

    // Reserves a planner request and returns everything the path needs.
    const reservePlanner = async (ticket, { container = policyContainer() } = {}) => {
      const attemptId = ATTEMPT_ID();
      const capture = captureOf({
        ticketId: ticket.id, planningAttemptId: attemptId,
        plannerAgentId: plannerAgent.id, policyContainer: container
      });
      const account = await store.admitTicketEconomicAccount({
        ticketId: ticket.id, role: PLANNER_ROLE,
        economicPolicy: capture.source.economicPolicy
      });
      const reservation = await store.reserveEconomicRequest({
        preparedRequest: capture.preparedRequest,
        economicAuthority: capture.economicAuthority,
        pricingEntry: capture.pricingEntry
      });
      const governed = buildGovernedExecutionState({
        capture,
        economicAccountId: Number(account.account.id),
        reservationId: reservation.id,
        economicState: 'reserved'
      });
      return { attemptId, capture, account, reservation, governed, ticket };
    };

    // ── Capture happens entirely before any provider contact ────────────────

    const successTicket = await newTicket('Governed planner success');
    const prepared = await reservePlanner(successTicket);

    assert.equal(prepared.reservation.state, 'reserved',
      'the reservation is committed before any transport exists');
    assert.equal(prepared.capture.preparedRequest.dispatchTarget, SNAPSHOT);
    // The captured model comes from the route, NOT the agent row.
    assert.notEqual(plannerAgent.model, SNAPSHOT,
      'the agent row carries a different model, so this proves the source');
    const bodySent = JSON.parse(prepared.reservation.serializedRequest);
    assert.equal(bodySent.model, SNAPSHOT, 'the captured model is in the bytes');
    assert.equal(bodySent.max_output_tokens, CAP, 'the authorized cap is in the bytes');
    assert.equal(bodySent.truncation, 'disabled', 'truncation is explicitly disabled');

    // The three governed policy hashes are independent and exclude legacy
    // container siblings.
    const { source } = prepared.capture;
    assert.equal(new Set([source.roleRoutingPolicyHash, source.economicPolicyHash,
      source.pricingCatalogHash]).size, 3, 'three independent policy hashes');
    const legacyDrift = policyContainer();
    legacyDrift.body.maxCost = { currency: 'USD', limit: 999 };
    legacyDrift.body.preferredModel = 'gpt-something-else';
    const afterLegacyEdit = captureOf({
      ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
      plannerAgentId: plannerAgent.id, policyContainer: legacyDrift
    });
    assert.equal(afterLegacyEdit.source.roleRoutingPolicyHash, source.roleRoutingPolicyHash,
      'legacy maxCost and preferredModel never enter the governed hashes');
    assert.equal(afterLegacyEdit.source.economicPolicyHash, source.economicPolicyHash);

    // ── Credential preflight happens before start ───────────────────────────

    const credentiallessTicket = await newTicket('Planner missing credentials');
    const credentialless = await reservePlanner(credentiallessTicket);
    const unusedTransport = recordingTransport();
    // The orchestration rule: resolve credentials, and if absent release the
    // still-reserved request WITHOUT starting it.
    const credentials = null;
    assert.equal(credentials, null);
    const releasedRow = await store.releaseUndispatchedEconomicReservation({
      reservationId: credentialless.reservation.id, reason: 'planner_credentials_unavailable'
    });
    assert.equal(releasedRow.state, 'released',
      'missing credentials release the reservation as provably undispatched');
    assert.equal(unusedTransport.calls.length, 0, 'zero provider calls');
    assert.equal(releasedRow.startedAt, null, 'no started reservation is left behind');
    const releasedAccount = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`, [credentiallessTicket.id, PLANNER_ROLE]);
    assert.equal(Number(releasedAccount.rows[0].reserved_micro_usd), 0,
      'the released reservation returns its authority in full');
    assert.equal(Number(releasedAccount.rows[0].settled_micro_usd), 0,
      'a never-dispatched request is never charged');

    // ── Atomic start: one winner, exact bytes ──────────────────────────────

    const attempt = governedAttempt(successTicket, prepared.attemptId, prepared.governed);
    const startedAttempt = {
      ...attempt,
      state: 'request_started',
      requestHash: prepared.capture.preparedRequest.requestHash,
      requestStartedAt: AT,
      requestMetadata: {
        contextVersion: 1,
        contextHash: hashCanonical({ context: successTicket.id }),
        messageCount: 1,
        requestBytes: prepared.reservation.serializedRequestByteCount,
        timeoutMs: 60_000,
        maxResponseBytes: 65_536
      },
      governedExecution: { ...prepared.governed, economicState: 'request_started' }
    };
    const sealedStart = (() => {
      const { attemptStateHash, ...rest } = startedAttempt;
      return { ...rest, attemptStateHash: hashCanonical(rest) };
    })();

    const contenders = await Promise.allSettled([
      store.startGovernedPlannerRequest({
        ticketId: successTicket.id, attempt: sealedStart,
        reservationId: prepared.reservation.id
      }),
      store.startGovernedPlannerRequest({
        ticketId: successTicket.id, attempt: sealedStart,
        reservationId: prepared.reservation.id
      }),
      store.startGovernedPlannerRequest({
        ticketId: successTicket.id, attempt: sealedStart,
        reservationId: prepared.reservation.id
      })
    ]);
    const winners = contenders.filter(r => r.status === 'fulfilled');
    assert.equal(winners.length, 1, 'exactly one start winner under simultaneous orchestration');
    for (const loser of contenders.filter(r => r.status === 'rejected')) {
      assert.equal(loser.reason.code, 'ECONOMIC_REQUEST_ALREADY_STARTED');
      assert.equal(loser.reason.dispatchAuthorized, false,
        'a losing caller is explicitly denied dispatch authority');
      assert.equal(loser.reason.startedNow, false);
    }
    const startResult = winners[0].value;
    assert.equal(startResult.startedNow, true);
    assert.equal(startResult.dispatchAuthorized, true);
    assert.equal(startResult.attempt.state, 'request_started',
      'the planning attempt advanced in the same transaction');
    assert.equal(startResult.attempt.governedExecution.economicState, 'request_started');

    // Both events exist, from one transaction.
    const startEvents = (await store.listTicketEvents(successTicket.id)).events;
    assert.equal(startEvents.filter(e => e.type === 'ticket.economic_request_started').length, 1,
      'exactly one economic start event');
    assert.equal(
      startEvents.filter(e => e.type === 'ticket.structured_planning_attempt_requested').length, 1,
      'exactly one planning-attempt start event');

    // ── Exact-byte dispatch ────────────────────────────────────────────────

    const transport = recordingTransport();
    const dispatched = await dispatchGovernedRequest({
      startResult, transport, resolveCredentials: async () => ({ apiKey: 'fixture-key' })
    });
    assert.equal(dispatched.status, 'received');
    assert.equal(transport.calls.length, 1, 'exactly one provider request');
    assert.equal(transport.calls[0].serializedRequest, prepared.reservation.serializedRequest,
      'the transport receives the exact persisted bytes');
    assert.equal(transport.calls[0].serializedRequest,
      JSON.stringify(JSON.parse(prepared.reservation.serializedRequest)) ===
        prepared.reservation.serializedRequest
        ? prepared.reservation.serializedRequest
        : prepared.reservation.serializedRequest,
      'byte-for-byte, not a re-serialization');
    assert.equal(transport.calls[0].dispatchTarget, SNAPSHOT);

    // Environment model drift cannot change dispatch.
    const priorEnv = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-env-override';
    const envTransport = recordingTransport();
    const envStart = { ...startResult };
    await dispatchGovernedRequest({ startResult: envStart, transport: envTransport });
    assert.equal(JSON.parse(envTransport.calls[0].serializedRequest).model, SNAPSHOT,
      'an environment model default cannot alter the dispatched bytes');
    if (priorEnv === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = priorEnv;

    // The agent row's provider/model is never consulted for dispatch. The row
    // says `gpt-agent-row-model`; the bytes say the captured snapshot, and the
    // reservation is what the transport reads.
    const currentAgent = await store.getConfiguredAgentById(plannerAgent.id);
    assert.notEqual(currentAgent.model, SNAPSHOT,
      'the current agent row genuinely carries a different model');
    const driftTransport = recordingTransport();
    await dispatchGovernedRequest({ startResult, transport: driftTransport });
    const driftBody = JSON.parse(driftTransport.calls[0].serializedRequest);
    assert.equal(driftBody.model, SNAPSHOT,
      'the current agent row cannot alter the dispatched bytes');
    assert.notEqual(driftBody.model, currentAgent.model,
      'dispatch does not read the agent row model');

    // A stored prepared request whose route was tampered with cannot ride a
    // valid reservation to the wire, even though the reservation itself is
    // legitimately started.
    const tamperTicket = await newTicket('Planner route tamper');
    const tampered = await reservePlanner(tamperTicket);
    await store.pool.query(
      `UPDATE ${store.table('economic_request_reservations')}
       SET prepared_request = jsonb_set(prepared_request, '{dispatchTarget}',
             '"gpt-4.1-2025-04-14"'),
           revision = revision + 1
       WHERE id = $1`,
      [tampered.reservation.id]
    );
    const startedTamper = await store.markEconomicRequestStarted({
      reservationId: tampered.reservation.id });
    const tamperTransport = recordingTransport();
    await assert.rejects(
      () => dispatchGovernedRequest({ startResult: startedTamper, transport: tamperTransport }),
      error => {
        assert.equal(error.detail.reason, 'transport_target_drift',
          'a tampered stored route refuses at the transport seam');
        return true;
      },
      'a prepared request pointing elsewhere cannot be dispatched');
    assert.equal(tamperTransport.calls.length, 0,
      'a drifted captured route contacts no transport');

    // ── Atomic response persistence ────────────────────────────────────────

    const responseText = dispatched.text;
    // The attempt's response hash is the SHA-256 of the stored text itself,
    // which is also what binds the reservation to the same response.
    const responseHash = crypto.createHash('sha256').update(responseText, 'utf8').digest('hex');
    const responseAttempt = (() => {
      const base = {
        ...startResult.attempt,
        state: 'response_received',
        responseStatus: 'received',
        responseText,
        responseBytes: Buffer.byteLength(responseText, 'utf8'),
        responseTruncated: false,
        responseHash,
        governedExecution: {
          ...startResult.attempt.governedExecution, economicState: 'response_persisted'
        }
      };
      const { attemptStateHash, ...rest } = base;
      return { ...rest, attemptStateHash: hashCanonical(rest) };
    })();
    const persisted = await store.persistGovernedPlannerResponse({
      ticketId: successTicket.id,
      attempt: responseAttempt,
      reservationId: prepared.reservation.id,
      responseIdentity: dispatched.responseIdentity,
      responseHash,
      expectedAttemptStateHash: startResult.attempt.attemptStateHash
    });
    assert.equal(persisted.reservation.state, 'response_persisted');
    assert.equal(persisted.attempt.state, 'response_received',
      'both response markers exist, from one transaction');
    assert.equal(persisted.attempt.responseText, responseText,
      'the complete response is preserved');

    // Duplicate response persistence is idempotent and issues no provider call.
    const duplicateTransport = recordingTransport();
    const again = await store.persistGovernedPlannerResponse({
      ticketId: successTicket.id,
      attempt: responseAttempt,
      reservationId: prepared.reservation.id,
      responseIdentity: dispatched.responseIdentity,
      responseHash
    });
    assert.equal(again.alreadyPersisted, true,
      'a repeated response persistence is idempotent, not a conflict');
    assert.equal(duplicateTransport.calls.length, 0,
      'duplicate orchestration issues no provider call');

    // ── Settlement from durable captured facts ──────────────────────────────

    const usage = derivePlannerSettlementUsage(dispatched.reportedUsage);
    assert.equal(usage.source, 'authorized_maximum_assumed',
      'a response with no reported usage settles conservatively');
    const settled = await store.settleEconomicRequest({
      reservationId: prepared.reservation.id, usage
    });
    assert.equal(settled.state, 'settled');
    assert.equal(settled.settledMicroUsd, prepared.reservation.reservedMaxMicroUsd,
      'unknown usage settles at the reserved maximum, never zero');

    // Repeated settlement changes nothing.
    const balanceBefore = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`, [successTicket.id, PLANNER_ROLE]);
    await code(
      store.settleEconomicRequest({ reservationId: prepared.reservation.id, usage }),
      'ECONOMIC_RESERVATION_ALREADY_SETTLED',
      'a repeated settlement is refused');
    const balanceAfter = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2`, [successTicket.id, PLANNER_ROLE]);
    assert.deepEqual(balanceAfter.rows[0], balanceBefore.rows[0],
      'a repeated settlement changes no balance');

    // Metered usage prices from the captured entry.
    assert.deepEqual(
      derivePlannerSettlementUsage({ input_tokens: 1_000, output_tokens: 500 }),
      { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 });
    for (const untrustworthy of [
      null, undefined, {}, { input_tokens: 10 }, { output_tokens: 10 },
      { input_tokens: -1, output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 },
      { input_tokens: '10', output_tokens: '5' }, []
    ]) {
      assert.equal(derivePlannerSettlementUsage(untrustworthy).source,
        'authorized_maximum_assumed',
        'absent, partial, malformed or unsupported usage settles at maximum');
    }

    // ── Refusals: all before any provider contact ───────────────────────────

    for (const [omit, expected] of [
      ['roleRoutingPolicy', 'planner_policy_unavailable'],
      ['economicPolicy', 'planner_policy_unavailable'],
      ['pricingCatalog', 'planner_policy_unavailable']
    ]) {
      assert.equal(
        governanceRefusal(() => captureOf({
          ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
          plannerAgentId: plannerAgent.id, policyContainer: policyContainer({ omit })
        })),
        expected,
        `a missing ${omit} refuses before provider contact`);
    }
    assert.equal(
      governanceRefusal(() => captureOf({
        ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
        plannerAgentId: plannerAgent.id, policyContainer: { body: {} }
      })),
      'planner_policy_unavailable',
      'a container with no governed configuration refuses');

    // A mutable alias cannot be captured as a dispatch target.
    assert.equal(
      governanceRefusal(() => captureOf({
        ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
        plannerAgentId: plannerAgent.id,
        policyContainer: policyContainer({ model: 'gpt-4o-mini' })
      })),
      'planner_route_uncapturable',
      'a mutable model alias refuses before provider contact');

    // An unknown field inside a governed subdocument fails closed.
    const polluted = policyContainer();
    polluted.body.governedExecution.economicPolicy.surpriseBudget = 1;
    assert.equal(
      governanceRefusal(() => captureOf({
        ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
        plannerAgentId: plannerAgent.id, policyContainer: polluted
      })),
      'planner_policy_unavailable',
      'an unknown field inside a governed subdocument fails closed');

    const unknownSub = policyContainer();
    unknownSub.body.governedExecution.extraPolicy = {};
    assert.equal(
      governanceRefusal(() => captureOf({
        ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
        plannerAgentId: plannerAgent.id, policyContainer: unknownSub
      })),
      'planner_policy_unavailable',
      'an unrecognized governed subdocument fails closed');

    // Insufficient budget refuses at reservation, still with zero contact.
    // The account is authorized for exactly one planner request, so a second
    // attempt on the same Ticket has nothing left to reserve against.
    const brokeTicket = await newTicket('Planner insufficient budget');
    const perRequest = captureOf({
      ticketId: brokeTicket.id, planningAttemptId: ATTEMPT_ID(),
      plannerAgentId: plannerAgent.id
    }).economicAuthority.maximumPerRequestMicroUsd;
    const tightContainer = policyContainer({ authorizedMicroUsd: perRequest });
    const firstCapture = captureOf({
      ticketId: brokeTicket.id, planningAttemptId: ATTEMPT_ID(),
      plannerAgentId: plannerAgent.id, policyContainer: tightContainer
    });
    await store.admitTicketEconomicAccount({
      ticketId: brokeTicket.id, role: PLANNER_ROLE,
      economicPolicy: firstCapture.source.economicPolicy
    });
    await store.reserveEconomicRequest({
      preparedRequest: firstCapture.preparedRequest,
      economicAuthority: firstCapture.economicAuthority,
      pricingEntry: firstCapture.pricingEntry
    });
    const secondCapture = captureOf({
      ticketId: brokeTicket.id, planningAttemptId: ATTEMPT_ID(),
      plannerAgentId: plannerAgent.id, policyContainer: tightContainer
    });
    const brokeTransport = recordingTransport();
    await code(
      store.reserveEconomicRequest({
        preparedRequest: secondCapture.preparedRequest,
        economicAuthority: secondCapture.economicAuthority,
        pricingEntry: secondCapture.pricingEntry
      }),
      'ECONOMIC_AUTHORITY_EXCEEDED',
      'a planner request beyond the account authority cannot reserve');
    assert.equal(brokeTransport.calls.length, 0, 'a refused reservation contacts no transport');

    // ── Recovery points ────────────────────────────────────────────────────
    //
    // For each durable state, prove whether a FIRST dispatch may still occur.
    // Only a state proven never started may dispatch.

    const recoveryTicket = await newTicket('Planner recovery points');
    const recoveryCases = [];

    // 1. Account only — no reservation exists.
    await store.admitTicketEconomicAccount({
      ticketId: recoveryTicket.id, role: PLANNER_ROLE,
      // The NORMALIZED policy, as captured — not the raw container input.
      economicPolicy: captureOf({
        ticketId: recoveryTicket.id, planningAttemptId: ATTEMPT_ID(),
        plannerAgentId: plannerAgent.id
      }).source.economicPolicy
    });
    const accountOnly = await store.listRecoverableEconomicReservations({
      ticketId: recoveryTicket.id, role: PLANNER_ROLE });
    assert.equal(accountOnly.length, 0,
      'an account with no reservation has no recoverable request');
    recoveryCases.push(['account only', 'no reservation', true]);

    // 2. Reserved, not started — the only state that may dispatch first.
    const reservedOnly = await reservePlanner(recoveryTicket);
    const reservedClass = (await store.listRecoverableEconomicReservations({
      ticketId: recoveryTicket.id })).find(r => r.id === reservedOnly.reservation.id);
    assert.equal(reservedClass.classification, 'never_dispatched');
    assert.equal(reservedClass.releasable, true);
    recoveryCases.push(['reserved, not started', reservedClass.classification, true]);

    // The same persisted request may be started — not a new one.
    const resumeAttempt = (() => {
      const base = {
        ...governedAttempt(recoveryTicket, reservedOnly.attemptId, reservedOnly.governed),
        state: 'request_started',
        requestHash: reservedOnly.capture.preparedRequest.requestHash,
        requestStartedAt: AT,
        requestMetadata: {
          contextVersion: 1, contextHash: hashCanonical({ c: 1 }), messageCount: 1,
          requestBytes: reservedOnly.reservation.serializedRequestByteCount,
          timeoutMs: 60_000, maxResponseBytes: 65_536
        },
        governedExecution: { ...reservedOnly.governed, economicState: 'request_started' }
      };
      const { attemptStateHash, ...rest } = base;
      return { ...rest, attemptStateHash: hashCanonical(rest) };
    })();
    const resumed = await store.startGovernedPlannerRequest({
      ticketId: recoveryTicket.id, attempt: resumeAttempt,
      reservationId: reservedOnly.reservation.id
    });
    assert.equal(resumed.serializedRequest, reservedOnly.reservation.serializedRequest,
      'recovery resumes the SAME persisted request, never a new one');

    // 3. Started, no response — never dispatch again.
    const startedClass = (await store.listRecoverableEconomicReservations({
      ticketId: recoveryTicket.id })).find(r => r.id === reservedOnly.reservation.id);
    assert.equal(startedClass.classification, 'dispatch_uncertain');
    assert.equal(startedClass.releasable, false,
      'a started request is never released as undispatched');
    await code(
      store.startGovernedPlannerRequest({
        ticketId: recoveryTicket.id, attempt: resumeAttempt,
        reservationId: reservedOnly.reservation.id
      }),
      'ECONOMIC_REQUEST_ALREADY_STARTED',
      'no state at or after request_started may dispatch again');
    recoveryCases.push(['started, no response', startedClass.classification, false]);

    // It settles conservatively without any provider call.
    const interruptedTransport = recordingTransport();
    const interruptedSettled = await store.settleEconomicRequest({
      reservationId: reservedOnly.reservation.id,
      usage: { source: 'authorized_maximum_assumed' }
    });
    assert.equal(interruptedSettled.settledMicroUsd,
      reservedOnly.reservation.reservedMaxMicroUsd,
      'an unconfirmed dispatch settles at the reserved maximum');
    assert.equal(interruptedTransport.calls.length, 0, 'settlement contacts no provider');

    // 4. Response persisted, unsettled — settle without dispatch.
    const unsettledTicket = await newTicket('Planner unsettled');
    const unsettled = await reservePlanner(unsettledTicket);
    await store.markEconomicRequestStarted({ reservationId: unsettled.reservation.id });
    await store.markEconomicResponsePersisted({
      reservationId: unsettled.reservation.id,
      responseIdentity: 'resp_recovery', responseHash: hashCanonical({ r: 1 })
    });
    const unsettledClass = (await store.listRecoverableEconomicReservations({
      ticketId: unsettledTicket.id }))[0];
    assert.equal(unsettledClass.classification, 'awaiting_settlement');
    assert.equal(unsettledClass.releasable, false);
    const recoveryTransport = recordingTransport();
    const recoverySettled = await store.settleEconomicRequest({
      reservationId: unsettled.reservation.id,
      usage: { source: 'provider_reported', inputTokens: 1_000, outputTokens: 500 }
    });
    assert.equal(recoverySettled.settledMicroUsd, 450,
      'recovery settles from the captured basis');
    assert.equal(recoveryTransport.calls.length, 0, 'recovery contacts no provider');
    recoveryCases.push(['response persisted, unsettled', unsettledClass.classification, false]);

    // 5/6. Settled and released are not recoverable work at all.
    assert.equal(
      (await store.listRecoverableEconomicReservations({ ticketId: unsettledTicket.id })).length,
      0, 'a settled reservation is not recoverable work');
    assert.equal(
      (await store.listRecoverableEconomicReservations({
        ticketId: credentiallessTicket.id })).length,
      0, 'a released reservation is not recoverable work');
    recoveryCases.push(['settled', 'not recoverable', false]);
    recoveryCases.push(['released', 'not recoverable', false]);

    // Exactly one recovery state permits a first dispatch.
    assert.deepEqual(
      recoveryCases.filter(([, , mayDispatch]) => mayDispatch).map(([label]) => label),
      ['account only', 'reserved, not started'],
      'only states proven never started permit a first dispatch');

    // ── No Runs, no scheduler work ─────────────────────────────────────────

    const runs = await store.listRunsForTicket({ ticketId: successTicket.id });
    assert.equal(runs.runs.length, 0, 'governed planning creates zero Runs');
    const noPlan = await store.getAllocationPlanForTicket(successTicket.id);
    assert.equal(noPlan, null,
      'the governed dispatch path admits no plan and no v1 allocation by itself');

    // ── Provenance ─────────────────────────────────────────────────────────

    const finalReservation = await store.getEconomicReservation(prepared.reservation.id);
    const provenance = startResult.attempt.governedExecution;
    assert.equal(provenance.routingDecisionHash, prepared.capture.routingDecision.decisionHash);
    assert.equal(provenance.economicAuthorityHash,
      prepared.capture.economicAuthority.authorityHash);
    assert.equal(provenance.reservationId, prepared.reservation.id);
    assert.equal(provenance.preparedRequestHash,
      prepared.capture.preparedRequest.preparedRequestHash);
    assert.equal(provenance.exactRequestHash, finalReservation.exactRequestHash);
    assert.equal(finalReservation.settlementReceipt.receiptHash.length, 64,
      'the settlement receipt hash is durable');
    assert.equal(finalReservation.responseHash, responseHash,
      'the response hash is bound to the reservation');
    for (const hashField of ['roleRoutingPolicyHash', 'economicPolicyHash', 'pricingCatalogHash',
      'routingDecisionHash', 'economicAuthorityHash', 'targetEvidenceHash',
      'preparedRequestHash', 'exactRequestHash']) {
      assert.match(provenance[hashField], /^[0-9a-f]{64}$/,
        `provenance binds ${hashField}`);
    }

    // ── Captured state is not rewritten by later policy changes ────────────

    const changedContainer = policyContainer({
      catalog: catalogValue({ outputMicroUsdPerMillionTokens: 6_000_000 })
    });
    const changedCapture = captureOf({
      ticketId: successTicket.id, planningAttemptId: ATTEMPT_ID(),
      plannerAgentId: plannerAgent.id, policyContainer: changedContainer
    });
    assert.notEqual(changedCapture.source.pricingCatalogHash, source.pricingCatalogHash,
      'the current catalog really changed');
    const rereadAttempt = startResult.attempt;
    assert.equal(rereadAttempt.governedExecution.pricingCatalogHash, source.pricingCatalogHash,
      'a current policy change does not rewrite captured attempt state');
    assert.equal(
      (await store.getEconomicReservation(unsettled.reservation.id)).settledMicroUsd, 450,
      'a current catalog change does not alter an already-computed settlement');
  });
  console.log('governed planner dispatch PostgreSQL test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
