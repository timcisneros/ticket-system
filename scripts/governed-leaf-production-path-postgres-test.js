#!/usr/bin/env node
'use strict';

// Tranche 4 production-path proof for governed structured leaf dispatch.
//
// This drives `runGovernedLeafRequest` — the SAME function the worker provider
// seam calls — against a real PostgreSQL store, with only the transport and the
// credential resolver injected. Fixture prices only; no network.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  governedAttemptState,
  plannerPolicySource
} = require('./governed-structured-fixture');

// Tranche 4 cutover: a planning attempt becomes request-capable only with
// complete governed authority.
const PLANNER_POLICY = plannerPolicySource();
const { readGovernedPolicySource } = require('../runtime/governed-policy-source');
const {
  runGovernedLeafRequest,
  selectRunProviderPath
} = require('../runtime/governed-leaf-orchestration');
const {
  classifyRunGovernance,
  normalizeGovernedRunAuthority
} = require('../runtime/governed-run-authority-contract');
const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');
const { canonicalJson, hashCanonical } = require('../runtime/declared-work-contract');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');
const {
  advancePlanningAttempt,
  buildPlannerRequestContext,
  buildPlannerRequestMessages,
  createPlanningAttempt,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  plannerRequestHash
} = require('../runtime/structured-allocation-planning-contract');
const {
  buildLeafDeclaredWorkSnapshot
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');

const ACTOR = 'governed-leaf-production-path-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const WORKER_ROLE = 'structured_leaf_executor';
const PLANNER_ROLE = 'structured_planner';
const ADAPTER = 'openai.responses.v1';
const SNAPSHOT = 'gpt-4o-mini-2024-07-18';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const CAP = 2_048;

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

function policySourceOf({
  catalog = catalogValue(), model = SNAPSHOT,
  authorizedMicroUsd = 500_000, maximumProviderRequests = 3
} = {}) {
  const built = buildPricingCatalog(catalog);
  return readGovernedPolicySource({
    body: {
      maxCost: { currency: 'USD', limit: 5 },
      preferredModel: 'gpt-legacy-ignored',
      governedExecution: {
        roleRoutingPolicy: {
          policyId: 'worker-routing-1',
          rolePolicies: [{
            role: WORKER_ROLE,
            primaryRoute: { adapterId: ADAPTER, provider: 'openai', model },
            fallbackRoute: null,
            authorizedFallbackReasons: []
          }]
        },
        economicPolicy: {
          policyId: 'worker-economics-1',
          role: WORKER_ROLE,
          authorizedMicroUsd,
          maximumProviderRequests,
          maximumOutputTokensPerRequest: CAP,
          pricingCatalogId: built.catalogId,
          pricingCatalogHash: built.catalogHash,
          fallbackLiabilityAuthorized: false,
          fallbackProviderRequests: 0,
          capturedAt: '2026-08-01T00:00:00.000Z'
        },
        pricingCatalog: catalog
      }
    }
  }, { role: WORKER_ROLE });
}

function workerBody(prompt = 'do the work') {
  return buildOpenAiResponsesBody({
    model: SNAPSHOT,
    input: [{ role: 'user', content: prompt }],
    options: { governed: true, maxOutputTokens: CAP }
  });
}

async function code(promise, expected, why) {
  await assert.rejects(() => promise, error => {
    assert.equal(error.code, expected, `${why} (got ${error.code}: ${error.message})`);
    return true;
  }, why);
}

async function main() {
  await withHarness('governed leaf authority PostgreSQL', async ({ store }) => {
    const group = (await store.createGroup({
      value: { name: `LeafAuth ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: ACTOR
    })).group;
    const mkAgent = async name => (await store.createConfiguredAgent({
      value: { name: `${name} ${STAMP}`, provider: 'openai', model: 'gpt-agent-row-model',
        apiKey: '' },
      groupIds: [group.id], changedBy: ACTOR
    })).agent;
    const planner = await mkAgent('Planner');
    const workerA = await mkAgent('WorkerA');
    const workerB = await mkAgent('WorkerB');
    const designated = (await store.updateGroup({
      groupId: group.id, expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id }, changedBy: ACTOR
    })).group;
    const ownedOutputPaths = {
      [planner.id]: 'reports/planner/',
      [workerA.id]: 'reports/a/',
      [workerB.id]: 'reports/b/'
    };

    // Reuses the Tranche 3 admission fixture shape so this suite exercises the
    // real leaf-admission transaction rather than a parallel one.
    const admitLeafSet = async (objective, { source = policySourceOf(), governed = true } = {}) => {
      const objectiveText = `${objective} ${STAMP}`;
      const catalog = await store.getConfiguredAgentsByIds({
        agentIds: [planner.id, workerA.id, workerB.id] });
      const declaredWork = {
        objective: objectiveText,
        expectedOutputs: [{ kind: 'text', declaration: 'One report per folder' }],
        successCriteria: [{ kind: 'text', declaration: 'Findings are concrete' }],
        evidenceRequirements: []
      };
      const authorityDraft = buildStructuredAllocationAuthorityDraft({
        declaredWork,
        ticketObjective: objectiveText,
        assignmentTargetType: 'group',
        assignmentMode: 'allocated',
        assignmentGroup: designated,
        plannerAgent: catalog.find(a => a.id === planner.id),
        candidateAgents: catalog,
        ownedOutputPaths
      });
      const now = new Date().toISOString();
      const ticket = (await store.createTicketWithEvent({
        ticket: {
          objective: objectiveText, acceptanceCriteria: 'Review the reports.',
          assignmentTargetType: 'group', assignmentTargetId: group.id,
          assignmentMode: 'allocated', ownedOutputPaths,
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
      // Drive the real planning attempt to a validated proposal, then admit the
      // v2 plan, exactly as Tranche 2B/3 do.
      const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
      const proposalDoc = {
        version: 1,
        sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
        items: planning.candidates.map(candidate => ({
          assignedAgentId: candidate.agentId,
          objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
          expectedOutputs: [{ kind: 'text',
            declaration: `Findings report for ${candidate.ownedOutputPaths[0]}` }],
          successCriteria: [{ kind: 'text', declaration: 'Report names at least one finding' }],
          evidenceRequirements: []
        }))
      };
      const responseText = JSON.stringify(proposalDoc);
      const proposal = normalizePlannerProposal(JSON.parse(responseText));
      const planDraft = lowerPlannerProposalToAllocationPlanDraft({
        ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        proposal
      });

      const context = buildPlannerRequestContext(
        ticket.structuredAllocationAuthority, { ticketId: ticket.id });
      const messages = buildPlannerRequestMessages(context);
      let attempt = createPlanningAttempt({
        attemptId: crypto.randomUUID(), ticketId: ticket.id,
        authority: ticket.structuredAllocationAuthority,
        createdAt: new Date().toISOString()
      });
      attempt = (await store.writeStructuredAllocationPlanningAttempt({
        ticketId: ticket.id, attempt, expectedAttemptStateHash: null,
        eventType: 'ticket.structured_planning_started'
      })).attempt;
      const { governedExecution: plannerGoverned } = await governedAttemptState(store, {
        ticketId: ticket.id,
        attemptId: attempt.attemptId,
        plannerAgentId: planning.planner.agentId,
        policy: PLANNER_POLICY
      });
      const advance = async patch => {
        attempt = (await store.writeStructuredAllocationPlanningAttempt({
          ticketId: ticket.id,
          attempt: advancePlanningAttempt(attempt, patch),
          expectedAttemptStateHash: attempt.attemptStateHash,
          eventType: 'ticket.structured_planning_step'
        })).attempt;
      };
      await advance({
        state: 'request_started',
        governedExecution: plannerGoverned,
        requestHash: plannerRequestHash({
          provider: planning.planner.provider, model: planning.planner.model, messages }),
        requestMetadata: {
          contextVersion: context.version, contextHash: context.contextHash,
          messageCount: messages.length,
          requestBytes: messages.reduce((t, m) => t + m.content.length, 0),
          timeoutMs: 120_000, maxResponseBytes: 262_144
        },
        requestStartedAt: new Date().toISOString()
      });
      await advance({
        state: 'response_received', responseStatus: 'received', responseText,
        responseBytes: Buffer.byteLength(responseText, 'utf8'), responseTruncated: false,
        responseHash: crypto.createHash('sha256').update(responseText).digest('hex')
      });
      await advance({
        state: 'proposal_validated', parseStatus: 'ok', validationStatus: 'ok',
        proposalHash: proposal.proposalHash
      });
      const admission = await store.admitStructuredAllocationPlan({
        ticketId: ticket.id, attempt, allocationPlanDraft: planDraft,
        plannerCredentialsAvailable: true, eventPayload: { source: ACTOR }
      });
      assert.equal(admission.admitted, true, 'the v2 plan is admitted');
      const plan = admission.plan;
      const refreshed = await store.getTicket(ticket.id);

      const agentById = new Map([[planner.id, planner], [workerA.id, workerA],
        [workerB.id, workerB]]);
      const leafDrafts = plan.items.map(item => {
        const agent = agentById.get(item.assignedAgentId);
        const completionAuthoritySnapshot = buildCompletionAuthoritySnapshot({
          objective: refreshed.objective, kind: 'unrecognized', recognized: false,
          intent: 'model_driven', completionPolicy: 'explicit_evidence_required',
          directPostconditions: [], verificationPolicy: 'when_declared',
          capturedAt: new Date().toISOString()
        });
        return {
          allocationItemId: item.allocationItemId,
          run: {
            ticketId: refreshed.id, agentId: agent.id, agentName: agent.name,
            targetRef: null, workspaceRoot: '/tmp', mainWorkspaceRoot: '/tmp',
            executionWorkspaceType: 'main_owned_paths',
            executionPolicySnapshot: refreshed.executionPolicy,
            completionAuthoritySnapshot,
            declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
              sharedConstraints: plan.sharedConstraints, completionAuthoritySnapshot
            }),
            acceptanceCriteriaSnapshot: null,
            allocationPlanId: plan.id, allocationItemId: item.allocationItemId,
            allocationSubtask: null, ownedOutputPaths: [...item.ownedOutputPaths],
            executionMode: 'agent', capabilityType: 'directAction',
            capabilityId: 'agent-selected-actions', currentPhase: 'planning',
            status: 'pending'
          }
        };
      });

      const admitted = await store.admitStructuredAllocationLeafRuns({
        ticketId: refreshed.id,
        allocationPlanId: plan.id,
        leafDrafts,
        governedLeafCapture: governed ? { policySource: source } : null,
        eventPayload: { source: ACTOR }
      });
      return { ticket: refreshed, plan, admission: admitted, source };
    };


    // ── Injected transport, exactly as production shapes it ────────────────

    const recordingTransport = (response = { text: '{"ok":true}', identity: 'resp_leaf_1' }) => {
      const calls = [];
      const transport = async args => {
        calls.push(args);
        return typeof response === 'function' ? response(args) : response;
      };
      transport.calls = calls;
      return transport;
    };
    const withKey = async () => ({ apiKey: 'fixture-key-not-a-real-credential' });
    const withoutKey = async () => null;

    const runGoverned = (run, logicalSourceIdentity, {
      transport, credentials = withKey, runtimeMaximum = 8, prompt = 'do the work'
    }) => runGovernedLeafRequest({
      repository: store,
      run,
      logicalSourceIdentity,
      canonicalBody: workerBody(prompt),
      endpointIdentity: ENDPOINT,
      transport,
      resolveCredentials: credentials,
      timeoutMs: 60_000,
      maxResponseBytes: 65_536,
      runtimeModelRequestMaximum: runtimeMaximum
    });

    // ── Success ────────────────────────────────────────────────────────────

    const admitted = await admitLeafSet('Governed leaf production');
    const runs = (await store.listRunsForTicket({ ticketId: admitted.ticket.id })).runs;
    assert.ok(runs.length >= 2, 'sibling governed Runs were admitted');
    const run = await store.getRun(runs[0].id);

    assert.equal(selectRunProviderPath(run).path, 'governed',
      'a complete governed leaf Run selects the governed path');

    const transport = recordingTransport();
    const first = await runGoverned(run, 'model-request:agent:1:provider', { transport });

    assert.equal(first.status, 'received');
    assert.equal(first.ordinal, 1, 'the first opportunity is ordinal 1');
    assert.equal(transport.calls.length, 1, 'exactly one transport call');

    const reservation = await store.getEconomicReservation(first.reservationId);
    assert.equal(transport.calls[0].serializedRequest, reservation.serializedRequest,
      'the transport received the exact persisted bytes');
    const dispatchedBody = JSON.parse(transport.calls[0].serializedRequest);
    assert.equal(dispatchedBody.model, SNAPSHOT, 'the captured snapshot was dispatched');
    assert.notEqual(dispatchedBody.model, workerA.model, 'not the current agent row model');
    assert.equal(dispatchedBody.max_output_tokens, CAP);
    assert.equal(dispatchedBody.truncation, 'disabled');
    assert.equal(reservation.state, 'settled', 'the request settled');
    assert.match(first.settlementReceiptHash, /^[0-9a-f]{64}$/);
    assert.equal(reservation.logicalSourceIdentity, 'model-request:agent:1:provider');
    assert.equal(first.text, '{"ok":true}', 'the response returns to the worker loop');

    // Settlement touched only the worker account.
    const workerAccount = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')}
        WHERE ticket_id = $1 AND role = $2`, [admitted.ticket.id, WORKER_ROLE]);
    assert.equal(Number(workerAccount.rows[0].settled_micro_usd) > 0, true,
      'settlement charged the worker account');
    // The planner account exists (governed planning admitted it) and worker
    // settlement must leave it completely alone.
    const plannerAccount = await store.pool.query(
      `SELECT settled_micro_usd, reserved_micro_usd
         FROM ${store.table('ticket_economic_accounts')}
        WHERE ticket_id = $1 AND role = $2`, [admitted.ticket.id, PLANNER_ROLE]);
    assert.equal(plannerAccount.rowCount, 1, 'the planner account is separate');
    assert.equal(Number(plannerAccount.rows[0].settled_micro_usd), 0,
      'worker settlement never charges the planner account');

    // ── Duplicate concurrency ──────────────────────────────────────────────

    const dupRun = await store.getRun(runs[1].id);
    const dupTransport = recordingTransport();
    const duplicated = await Promise.allSettled([
      runGoverned(dupRun, 'model-request:agent:1:provider', { transport: dupTransport }),
      runGoverned(dupRun, 'model-request:agent:1:provider', { transport: dupTransport })
    ]);
    const dupOk = duplicated.filter(r => r.status === 'fulfilled');
    assert.equal(dupTransport.calls.length, 1,
      'duplicate orchestration of one logical request makes ONE transport call');
    const dupOrdinals = new Set(dupOk.map(r => r.value.ordinal));
    assert.equal(dupOrdinals.size, 1, 'one ordinal');
    assert.equal([...dupOrdinals][0], 1, 'and it is 1 — never 2');
    const dupRows = await store.pool.query(
      `SELECT id FROM ${store.table('economic_request_reservations')} WHERE run_id = $1`,
      [dupRun.id]);
    assert.equal(dupRows.rowCount, 1, 'one reservation');

    // Exactly one caller dispatched; the other reports a closed outcome and
    // never a second request. A caller that merely LOST the start race must not
    // settle — the winner owns the outcome and will report metered usage.
    assert.equal(dupOk.filter(r => r.value.status === 'received').length, 1,
      'exactly one duplicate caller performed the dispatch');
    for (const other of dupOk.filter(r => r.value.status !== 'received')) {
      assert.ok(
        ['reused_durable_response', 'already_dispatched_unresolved']
          .includes(other.value.status),
        `a duplicate caller reports a closed outcome, got ${other.value.status}`);
      assert.equal(other.value.possiblyDispatched, true,
        'a duplicate caller never claims the request was undispatched');
    }
    const dupFinal = await store.getEconomicReservation(dupRows.rows[0].id);
    assert.equal(dupFinal.state, 'settled',
      'the winner settled the single reservation');
    assert.equal(dupFinal.settledMicroUsd < dupFinal.reservedMaxMicroUsd ||
      dupFinal.settlementReceipt.usageSource === 'authorized_maximum_assumed', true,
      'settlement came from the winner, not from a losing caller guessing');

    // ── Multi-request sequencing ───────────────────────────────────────────

    const secondTransport = recordingTransport();
    const second = await runGoverned(run, 'model-request:agent:2:provider',
      { transport: secondTransport });
    assert.equal(second.status, 'received');
    assert.equal(second.ordinal, 2, 'a distinct logical request receives ordinal 2');
    assert.notEqual(second.reservationId, first.reservationId);

    // Duplicate orchestration of opportunity 2 cannot become ordinal 3.
    const thirdTransport = recordingTransport();
    const repeatSecond = await runGoverned(run, 'model-request:agent:2:provider',
      { transport: thirdTransport });
    assert.equal(repeatSecond.ordinal, 2, 'repeating opportunity 2 stays ordinal 2');
    assert.equal(thirdTransport.calls.length, 0,
      'repeating a settled request makes no provider call');
    assert.equal(repeatSecond.status, 'reused_durable_response');

    // The economic request ceiling is enforced. The fixture authorizes three
    // requests, so ordinal 3 is admitted and ordinal 4 is refused.
    const thirdOk = await runGoverned(run, 'model-request:agent:3:provider',
      { transport: recordingTransport() });
    assert.equal(thirdOk.ordinal, 3, 'the third authorized request is admitted');
    const ceilingTransport = recordingTransport();
    const ceiling = await runGoverned(run, 'model-request:agent:4:provider',
      { transport: ceilingTransport });
    assert.equal(ceiling.status, 'reservation_refused',
      'the economic request ceiling refuses a further opportunity');
    assert.equal(ceilingTransport.calls.length, 0, 'a refused request contacts no provider');

    // The existing runtime-budget ceiling refuses independently.
    const budgetRun = await store.getRun(runs[1].id);
    const budgetTransport = recordingTransport();
    const budgetRefused = await runGoverned(budgetRun, 'model-request:agent:9:provider',
      { transport: budgetTransport, runtimeMaximum: 1 });
    assert.equal(budgetRefused.status, 'reservation_refused',
      'the runtime model-request maximum refuses independently');
    assert.equal(budgetTransport.calls.length, 0);

    // ── Credentials ────────────────────────────────────────────────────────

    const credTicket = await admitLeafSet('Governed leaf credentials');
    const credRuns = (await store.listRunsForTicket({ ticketId: credTicket.ticket.id })).runs;
    const credRun = await store.getRun(credRuns[0].id);
    const credTransport = recordingTransport();
    const credResult = await runGoverned(credRun, 'model-request:agent:1:provider',
      { transport: credTransport, credentials: withoutKey });
    assert.equal(credResult.status, 'credentials_unavailable');
    assert.equal(credTransport.calls.length, 0, 'missing credentials contact no provider');
    assert.equal(credResult.possiblyDispatched, false);
    const released = await store.getEconomicReservation(credResult.reservationId);
    assert.equal(released.state, 'released', 'the reservation is released');
    assert.equal(released.startedAt, null, 'it was never started');
    const credAccount = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd FROM ${store.table('ticket_economic_accounts')}
        WHERE ticket_id = $1 AND role = $2`, [credTicket.ticket.id, WORKER_ROLE]);
    assert.equal(Number(credAccount.rows[0].reserved_micro_usd), 0);
    assert.equal(Number(credAccount.rows[0].settled_micro_usd), 0,
      'a never-dispatched request is never charged');
    // Sibling Runs are untouched.
    assert.equal((await store.getRun(credRuns[1].id)).status, 'pending',
      'sibling Runs are preserved');

    // ── Dispatch failures settle, never release, never repeat ─────────────

    for (const [label, response, expected] of [
      ['timeout', () => { const e = new Error('t'); e.name = 'AbortError'; throw e; }, 'timeout'],
      ['transport failure', () => { throw new Error('reset'); }, 'transport_refused'],
      ['overflow', () => ({ text: 'x'.repeat(70_000) }), 'response_too_large'],
      ['empty', () => ({ text: '' }), 'response_empty']
    ]) {
      const failTicket = await admitLeafSet(`Governed leaf ${label}`);
      const failRun = await store.getRun(
        (await store.listRunsForTicket({ ticketId: failTicket.ticket.id })).runs[0].id);
      const failTransport = recordingTransport(response);
      const failed = await runGoverned(failRun, 'model-request:agent:1:provider',
        { transport: failTransport });
      assert.equal(failed.status, 'dispatch_failed', `${label} is a dispatch failure`);
      assert.equal(failed.failureReason, expected, `${label} is classified truthfully`);
      assert.equal(failTransport.calls.length, 1, `${label} makes exactly one call`);
      const failRow = await store.getEconomicReservation(failed.reservationId);
      assert.equal(failRow.state, 'settled', `${label} settles rather than releasing`);
      assert.equal(failRow.settledMicroUsd, failRow.reservedMaxMicroUsd,
        `${label} settles at the reserved maximum`);

      // Re-running the SAME logical request never dispatches again.
      const retryTransport = recordingTransport();
      const retried = await runGoverned(failRun, 'model-request:agent:1:provider',
        { transport: retryTransport });
      assert.equal(retryTransport.calls.length, 0,
        `${label} is never automatically repeated`);
      assert.equal(retried.status, 'reused_durable_response');
    }

    // ── Recovery states ────────────────────────────────────────────────────

    const recTicket = await admitLeafSet('Governed leaf recovery');
    const recRuns = (await store.listRunsForTicket({ ticketId: recTicket.ticket.id })).runs;
    const recRun = await store.getRun(recRuns[0].id);
    const recSource = 'model-request:agent:1:provider';

    // 1. No reservation: a first dispatch may occur.
    assert.equal(
      (await store.pool.query(
        `SELECT 1 FROM ${store.table('economic_request_reservations')} WHERE run_id = $1`,
        [recRun.id])).rowCount, 0, 'no reservation yet');

    // 2. Reserved, not started: still the only state that may dispatch first.
    const reservedOnly = await store.prepareAndReserveNextGovernedRunRequest({
      runId: recRun.id, logicalSourceIdentity: recSource,
      canonicalBody: workerBody('recovery'), endpointIdentity: ENDPOINT
    });
    assert.equal(reservedOnly.reservation.state, 'reserved');
    const resumeTransport = recordingTransport();
    const resumed = await runGoverned(recRun, recSource, { transport: resumeTransport });
    assert.equal(resumed.status, 'received', 'a reserved request may perform its first start');
    assert.equal(resumeTransport.calls.length, 1);
    assert.equal(resumed.ordinal, reservedOnly.ordinal,
      'recovery reuses the reserved ordinal, never a new one');

    // 3/4/5. Started, response persisted, settled: no further dispatch, ever.
    const afterTransport = recordingTransport();
    const after = await runGoverned(recRun, recSource, { transport: afterTransport });
    assert.equal(afterTransport.calls.length, 0,
      'no state at or after request_started dispatches again');
    assert.equal(after.status, 'reused_durable_response');

    // A started-but-unresolved request settles conservatively without dispatch.
    const stuckTicket = await admitLeafSet('Governed leaf stuck');
    const stuckRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: stuckTicket.ticket.id })).runs[0].id);
    const stuck = await store.prepareAndReserveNextGovernedRunRequest({
      runId: stuckRun.id, logicalSourceIdentity: recSource,
      canonicalBody: workerBody('stuck'), endpointIdentity: ENDPOINT
    });
    await store.markEconomicRequestStarted({ reservationId: stuck.reservation.id });
    const stuckTransport = recordingTransport();
    const stuckResult = await runGoverned(stuckRun, recSource, { transport: stuckTransport });
    assert.equal(stuckResult.status, 'already_dispatched_unresolved');
    assert.equal(stuckTransport.calls.length, 0, 'a started request is never re-dispatched');
    const stuckRow = await store.getEconomicReservation(stuck.reservation.id);
    assert.equal(stuckRow.state, 'settled');
    assert.equal(stuckRow.settledMicroUsd, stuckRow.reservedMaxMicroUsd,
      'an unresolved dispatch settles at the reserved maximum');

    // 6. Released: terminal, cannot execute.
    const relTicket = await admitLeafSet('Governed leaf released');
    const relRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: relTicket.ticket.id })).runs[0].id);
    const rel = await store.prepareAndReserveNextGovernedRunRequest({
      runId: relRun.id, logicalSourceIdentity: recSource,
      canonicalBody: workerBody('released'), endpointIdentity: ENDPOINT
    });
    await store.releaseUndispatchedEconomicReservation({
      reservationId: rel.reservation.id, reason: 'operator_cancelled' });
    const relTransport = recordingTransport();
    const relResult = await runGoverned(relRun, recSource, { transport: relTransport });
    assert.equal(relResult.status, 'request_released');
    assert.equal(relTransport.calls.length, 0, 'a released request cannot execute');

    // ── Drift containment ──────────────────────────────────────────────────

    const priorEnv = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-env-override';
    const driftTicket = await admitLeafSet('Governed leaf drift');
    const driftRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: driftTicket.ticket.id })).runs[0].id);
    const driftTransport = recordingTransport();
    const drifted = await runGoverned(driftRun, 'model-request:agent:1:provider',
      { transport: driftTransport });
    assert.equal(JSON.parse(driftTransport.calls[0].serializedRequest).model, SNAPSHOT,
      'environment model drift cannot alter dispatch');
    const driftReservation = await store.getEconomicReservation(drifted.reservationId);
    assert.equal(driftReservation.settledMicroUsd,
      driftReservation.reservedMaxMicroUsd, 'settlement used captured facts');
    if (priorEnv === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = priorEnv;

    // A stored prepared request whose route was tampered with cannot ride a
    // legitimately reserved request to the wire.
    const tamperTicket = await admitLeafSet('Governed leaf route tamper');
    const tamperRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: tamperTicket.ticket.id })).runs[0].id);
    const tampered = await store.prepareAndReserveNextGovernedRunRequest({
      runId: tamperRun.id, logicalSourceIdentity: 'model-request:agent:1:provider',
      canonicalBody: workerBody('tamper'), endpointIdentity: ENDPOINT
    });
    await store.pool.query(
      `UPDATE ${store.table('economic_request_reservations')}
         SET prepared_request = jsonb_set(prepared_request, '{dispatchTarget}',
               '"gpt-4.1-2025-04-14"'),
             revision = revision + 1
       WHERE id = $1`, [tampered.reservation.id]);
    const tamperTransport = recordingTransport();
    await assert.rejects(
      () => runGoverned(tamperRun, 'model-request:agent:1:provider',
        { transport: tamperTransport }),
      error => {
        assert.equal(error.detail.reason, 'transport_target_drift',
          'a drifted captured route refuses at the transport seam');
        return true;
      },
      'a prepared request pointing elsewhere cannot be dispatched');
    assert.equal(tamperTransport.calls.length, 0,
      'a drifted captured route contacts no provider');

    // ── Active transport must not be prematurely settled ───────────────────
    //
    // The winner blocks inside the injected transport while a duplicate caller
    // arrives. The duplicate must observe an ACTIVE executor, dispatch nothing,
    // settle nothing, and leave the account reserved — then the winner returns
    // and performs the single response persistence and settlement.

    const flightTicket = await admitLeafSet('Governed leaf in flight');
    const flightRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: flightTicket.ticket.id })).runs[0].id);
    // Claim the Run through the real lease lifecycle, so the executor is alive
    // by the same authority recovery uses to decide it is not.
    const claimed = await store.claimPendingRun({
      leaseOwner: 'governed-leaf-in-flight-test',
      leaseDurationMs: 600_000,
      eligibleRunIds: [flightRun.id]
    });
    assert.ok(claimed && claimed.run && claimed.run.id === flightRun.id,
      'the Run is leased by a live executor');
    const leasedRun = await store.getRun(flightRun.id);

    let releaseTransport;
    const blocked = new Promise(resolve => { releaseTransport = resolve; });
    let transportEntered;
    const enteredTransport = new Promise(resolve => { transportEntered = resolve; });
    const flightCalls = [];
    const blockingTransport = async args => {
      flightCalls.push(args);
      transportEntered();
      await blocked;
      return { text: '{"ok":true}', identity: 'resp_in_flight',
        usage: { input_tokens: 1_000, output_tokens: 500 } };
    };
    const duplicateCalls = [];
    const duplicateTransport = async args => { duplicateCalls.push(args); return { text: '{}' }; };

    const flightSource = 'model-request:agent:1:provider';
    const winner = runGovernedLeafRequest({
      repository: store, run: leasedRun, logicalSourceIdentity: flightSource,
      canonicalBody: workerBody('in flight'), endpointIdentity: ENDPOINT,
      transport: blockingTransport, resolveCredentials: withKey,
      timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 8
    });
    await enteredTransport;

    // 1-6. While the winner is inside the transport, a duplicate arrives.
    const reservationBefore = await store.pool.query(
      `SELECT r.state, a.reserved_micro_usd, a.settled_micro_usd
         FROM ${store.table('economic_request_reservations')} r
         JOIN ${store.table('ticket_economic_accounts')} a ON a.id = r.account_id
        WHERE r.run_id = $1`, [leasedRun.id]);
    assert.equal(reservationBefore.rows[0].state, 'request_started');
    assert.ok(Number(reservationBefore.rows[0].reserved_micro_usd) > 0,
      'the account is reserved while transport is active');

    const duplicate = await runGovernedLeafRequest({
      repository: store, run: leasedRun, logicalSourceIdentity: flightSource,
      canonicalBody: workerBody('in flight'), endpointIdentity: ENDPOINT,
      transport: duplicateTransport, resolveCredentials: withKey,
      timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 8
    });
    assert.equal(duplicate.status, 'request_in_flight',
      'a duplicate observes the active winner rather than settling it');
    assert.equal(duplicateCalls.length, 0, 'the duplicate makes zero transport calls');
    assert.equal(duplicate.settlementReceiptHash, null,
      'the duplicate performs zero settlement');

    const midFlight = await store.pool.query(
      `SELECT r.state, r.settled_micro_usd, a.reserved_micro_usd, a.settled_micro_usd
              AS account_settled
         FROM ${store.table('economic_request_reservations')} r
         JOIN ${store.table('ticket_economic_accounts')} a ON a.id = r.account_id
        WHERE r.run_id = $1`, [leasedRun.id]);
    assert.equal(midFlight.rows[0].state, 'request_started',
      'the reservation remains request_started');
    assert.equal(midFlight.rows[0].settled_micro_usd, null,
      'nothing was settled while the winner was in flight');
    assert.equal(
      Number(midFlight.rows[0].reserved_micro_usd),
      Number(reservationBefore.rows[0].reserved_micro_usd),
      'the account remains reserved, unchanged, while transport is active');

    // 7-8. The winner returns and performs the single settlement.
    releaseTransport();
    const winnerResult = await winner;
    assert.equal(winnerResult.status, 'received');
    assert.equal(flightCalls.length, 1, 'exactly one transport call was made');
    const flightFinal = await store.getEconomicReservation(winnerResult.reservationId);
    assert.equal(flightFinal.state, 'settled');
    // The winner's METERED usage was preserved, not replaced by the maximum a
    // premature settlement would have charged.
    assert.equal(flightFinal.settlementReceipt.usageSource, 'provider_reported',
      'the winner settled from its own reported usage');
    assert.ok(flightFinal.settledMicroUsd < flightFinal.reservedMaxMicroUsd,
      'metered settlement is strictly less than the conservative maximum');
    const receipts = await store.pool.query(
      `SELECT settlement_receipt FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1 AND settlement_receipt IS NOT NULL`, [leasedRun.id]);
    assert.equal(receipts.rowCount, 1, 'exactly one settlement receipt exists');

    // ── Abandoned recovery settles conservatively, exactly once ────────────

    const lostTicket = await admitLeafSet('Governed leaf abandoned');
    const lostRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: lostTicket.ticket.id })).runs[0].id);
    const lostClaim = await store.claimPendingRun({
      leaseOwner: 'governed-leaf-abandoned-test',
      leaseDurationMs: 600_000,
      eligibleRunIds: [lostRun.id]
    });
    assert.ok(lostClaim && lostClaim.run, 'the abandoned Run was leased');
    const lostLeased = await store.getRun(lostRun.id);
    const lostReserved = await store.prepareAndReserveNextGovernedRunRequest({
      runId: lostLeased.id, logicalSourceIdentity: flightSource,
      canonicalBody: workerBody('abandoned'), endpointIdentity: ENDPOINT
    });
    await store.markEconomicRequestStarted({ reservationId: lostReserved.reservation.id });

    // Durably lose the executor: expire the lease exactly as an executor death
    // presents to the canonical recovery path.
    await store.pool.query(
      `UPDATE ${store.table('runs')}
          SET lease_expires_at = clock_timestamp() - interval '1 minute',
              revision = revision + 1
        WHERE id = $1`, [lostLeased.id]);
    const executorState = await store.isRunExecutorActive(lostLeased.id);
    assert.equal(executorState.active, false,
      'the executor is durably gone by the canonical lease predicate');

    const recoveryTransport = recordingTransport();
    const recovered = await runGovernedLeafRequest({
      repository: store, run: await store.getRun(lostLeased.id),
      logicalSourceIdentity: flightSource,
      canonicalBody: workerBody('abandoned'), endpointIdentity: ENDPOINT,
      transport: recoveryTransport, resolveCredentials: withKey,
      timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 8
    });
    assert.equal(recovered.status, 'already_dispatched_unresolved');
    assert.equal(recoveryTransport.calls.length, 0, 'recovery makes zero provider calls');
    const recoveredRow = await store.getEconomicReservation(lostReserved.reservation.id);
    assert.equal(recoveredRow.state, 'settled');
    assert.equal(recoveredRow.settledMicroUsd, recoveredRow.reservedMaxMicroUsd,
      'abandoned recovery settles conservatively at the reserved maximum');

    // Repeated recovery is idempotent.
    const balanceBeforeRepeat = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd
         FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1 AND role = $2`,
      [lostTicket.ticket.id, WORKER_ROLE]);
    const repeatTransport = recordingTransport();
    const repeated = await runGovernedLeafRequest({
      repository: store, run: await store.getRun(lostLeased.id),
      logicalSourceIdentity: flightSource,
      canonicalBody: workerBody('abandoned'), endpointIdentity: ENDPOINT,
      transport: repeatTransport, resolveCredentials: withKey,
      timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 8
    });
    assert.equal(repeatTransport.calls.length, 0, 'repeated recovery contacts no provider');
    assert.equal(repeated.status, 'reused_durable_response');
    const balanceAfterRepeat = await store.pool.query(
      `SELECT reserved_micro_usd, settled_micro_usd
         FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1 AND role = $2`,
      [lostTicket.ticket.id, WORKER_ROLE]);
    assert.deepEqual(balanceAfterRepeat.rows[0], balanceBeforeRepeat.rows[0],
      'repeated recovery changes no balance');

    // ── Historical and malformed Runs ──────────────────────────────────────

    // A Run with neither field is an ordinary non-structured Run and keeps the
    // existing provider path.
    assert.equal(
      selectRunProviderPath({ id: 1, ticketId: 1 }).path, 'ungoverned',
      'a non-structured Run keeps the existing provider path');
    // Tranche 4 cutover: a leaf binding without complete governed authority is
    // an integrity failure. It reaches NEITHER provider path.
    assert.throws(
      () => selectRunProviderPath({
        id: run.id, ticketId: run.ticketId, leafRunBinding: run.leafRunBinding
      }),
      error => error.code === 'GOVERNED_LEAF_REFUSED',
      'a structured Run without complete governed authority refuses');
    assert.throws(
      () => selectRunProviderPath({
        id: run.id, ticketId: run.ticketId,
        governedExecution: run.governedExecution
      }),
      error => error.code === 'GOVERNED_LEAF_REFUSED',
      'governed authority without a leaf binding refuses');
    assert.throws(
      () => selectRunProviderPath({
        id: run.id, ticketId: run.ticketId, leafRunBinding: run.leafRunBinding,
        governedExecution: { version: 1, role: WORKER_ROLE }
      }),
      error => error.code === 'GOVERNED_LEAF_REFUSED',
      'partial governed state refuses rather than selecting either path');

    console.log('  ok governed leaf production path');
  });
  finished = true;
  console.log('governed leaf production path PostgreSQL test passed');
}

let finished = false;
process.on('exit', exitCode => {
  if (exitCode === 0 && !finished) {
    console.error('governed leaf production path test did not run to completion');
    process.exitCode = 1;
  }
});

main().catch(error => {
  console.error(error);
  process.exit(1);
});
