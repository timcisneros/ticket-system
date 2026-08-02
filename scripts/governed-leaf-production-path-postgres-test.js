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
  plannerPolicySource,
  progressControlPolicy
} = require('./governed-structured-fixture');
const LEAF_PROGRESS_POLICY = progressControlPolicy();

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
  buildLeafDeclaredWorkSnapshot,
  normalizeAggregatePlanDecision
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
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
    const admitLeafSet = async (objective, {
      source = policySourceOf(), governed = true, deterministicCompletion = false,
      // Duration authority captured at admission. Suites that are not about
      // duration inherit the generous shared fixture limit.
      progressPolicy = LEAF_PROGRESS_POLICY
    } = {}) => {
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
        // Deterministic completion authority when requested: the ONLY kind the
        // canonical decision builder can actually satisfy from durable
        // evidence. Model-driven authority can never complete, which is why
        // states F and G need this variant.
        const completionAuthoritySnapshot = deterministicCompletion
          ? buildCompletionAuthoritySnapshot({
            objective: `Review ${item.ownedOutputPaths[0]} and record concrete findings`,
            kind: 'deterministic',
            recognized: true,
            intent: 'create_folder',
            completionPolicy: 'declared_postconditions',
            directPostconditions: [{
              type: 'folder_exists',
              path: item.ownedOutputPaths[0].replace(/\/$/, '')
            }],
            verificationPolicy: 'when_declared',
            capturedAt: new Date().toISOString()
          })
          : buildCompletionAuthoritySnapshot({
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
        governedLeafCapture: governed
          ? { policySource: source, progressControlPolicy: progressPolicy }
          : null,
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

    // `reservation_refused` is a FULFILLED outcome carrying `ordinal: null`,
    // and it is a legitimate result: under resource pressure one caller can
    // fail to acquire a pool connection within `connectionTimeoutMs` before it
    // ever reaches the ledger. Asserting over every fulfilled ordinal therefore
    // compared {1, null} and failed for a reason that has nothing to do with
    // deduplication — which is exactly what the durable checks below measure.
    //
    // The guarantee is unchanged and is asserted where it actually lives: ONE
    // transport call, ONE reservation row, and ordinal 1 for every caller that
    // genuinely reserved. A refused caller must have reserved nothing.
    const dupReserved = dupOk.filter(r => r.value.ordinal !== null);
    const dupRefused = dupOk.filter(r => r.value.ordinal === null);
    assert.ok(dupReserved.length >= 1,
      'at least one duplicate caller obtained the reservation');
    const dupOrdinals = new Set(dupReserved.map(r => r.value.ordinal));
    assert.equal(dupOrdinals.size, 1,
      'every caller that reserved reports the SAME ordinal');
    assert.equal([...dupOrdinals][0], 1, 'and it is 1 — never 2');
    for (const refused of dupRefused) {
      assert.equal(refused.value.status, 'reservation_refused',
        `a caller with no ordinal is a reservation refusal, got ${refused.value.status}`);
      assert.equal(refused.value.possiblyDispatched, false,
        'a refused caller never claims a request may have been dispatched');
    }

    const dupRows = await store.pool.query(
      `SELECT id FROM ${store.table('economic_request_reservations')} WHERE run_id = $1`,
      [dupRun.id]);
    assert.equal(dupRows.rowCount, 1, 'one reservation');

    // Exactly one caller dispatched; any other that reached the ledger reports
    // a closed outcome and never a second request. A caller that merely LOST
    // the start race must not settle — the winner owns the outcome and will
    // report metered usage.
    assert.equal(dupOk.filter(r => r.value.status === 'received').length, 1,
      'exactly one duplicate caller performed the dispatch');
    for (const other of dupReserved.filter(r => r.value.status !== 'received')) {
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

    // ── Tranche 5: the pre-reservation churn gate ─────────────────────────
    //
    // The gate runs inside the same locked transaction that would reserve, so a
    // blocked Run creates no reservation, no budget charge and makes no call.

    const churnTicket = await admitLeafSet('Governed leaf churn');
    const churnRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: churnTicket.ticket.id })).runs[0].id);

    // The captured tolerance is on the Run, not read from current policy.
    assert.ok(churnRun.governedExecution.progressControlPolicy,
      'the progress-control policy is captured on the governed Run');
    assert.match(churnRun.governedExecution.progressControlPolicy.policyHash,
      /^[0-9a-f]{64}$/);

    // FIRST request is always permitted: Tranche 5 governs additional spending,
    // not the initial opportunity to execute admitted work.
    const firstTransport = recordingTransport();
    const firstGoverned = await runGoverned(churnRun, 'model-request:agent:1:provider',
      { transport: firstTransport });
    assert.equal(firstGoverned.status, 'received',
      'the first governed request is permitted with no prior progress window');
    assert.equal(firstTransport.calls.length, 1);

    // Drive consecutive no-progress windows past the captured tolerance. Each
    // request consumes resources and satisfies no declared fact.
    let blockedAt = null;
    for (let ordinal = 2; ordinal <= 6 && blockedAt === null; ordinal += 1) {
      const transportForWindow = recordingTransport();
      const result = await runGoverned(churnRun,
        `model-request:agent:${ordinal}:provider`, { transport: transportForWindow });
      if (result.status === 'reservation_refused' &&
          /progress|blocked/i.test(String(result.failureDetail))) {
        blockedAt = { ordinal, calls: transportForWindow.calls.length };
      }
    }
    assert.ok(blockedAt, 'consecutive no-progress windows eventually block the Run');
    assert.equal(blockedAt.calls, 0,
      'the blocking request made zero provider calls');

    // Nothing was reserved for the refused request.
    const churnReservations = await store.pool.query(
      `SELECT logical_source_identity FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1`, [churnRun.id]);
    assert.equal(
      churnReservations.rows.some(r =>
        r.logical_source_identity === `model-request:agent:${blockedAt.ordinal}:provider`),
      false,
      'the blocked request created no economic reservation');

    // Repeated evaluation of identical durable facts is idempotent: still
    // blocked, still no reservation, still no provider call.
    const churnRepeatTransport = recordingTransport();
    const churnRepeated = await runGoverned(churnRun,
      `model-request:agent:${blockedAt.ordinal}:provider`,
      { transport: churnRepeatTransport });
    assert.equal(churnRepeated.status, 'reservation_refused');
    assert.equal(churnRepeatTransport.calls.length, 0,
      'repeated evaluation contacts no provider');
    const afterRepeat = await store.pool.query(
      `SELECT count(*)::int AS c FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1`, [churnRun.id]);
    assert.equal(Number(afterRepeat.rows[0].c), churnReservations.rowCount,
      'repeated evaluation creates no additional reservation');

    // A Run that IS advancing must not be blocked. This is the other half of
    // the invariant: verified progress resets the consecutive window, so the
    // same resource consumption that blocked the churning Run above permits
    // this one. It exercises window partitioning, cumulative reconstruction and
    // the newly-satisfied requirement together.
    const progressTicket = await admitLeafSet('Governed leaf progressing');
    const progressRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: progressTicket.ticket.id })).runs[0].id);
    const { inventoryDeclaredFacts, buildVerifiedProgressProjection } =
      require('../runtime/verified-progress-contract');
    const declaredFacts = inventoryDeclaredFacts(progressRun.declaredWorkSnapshot);
    assert.ok(declaredFacts.length > 0, 'the leaf Run declares measurable facts');

    // Bounded by the Tranche 4 economic ceiling (3 requests), which is a
    // different limit and must not be mistaken for the churn gate.
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const windowTransport = recordingTransport();
      const result = await runGoverned(progressRun,
        `model-request:agent:${ordinal}:provider`, { transport: windowTransport });
      assert.equal(result.status, 'received',
        `window ${ordinal} is permitted while the Run keeps advancing`);
      // Record a durable receipt that newly satisfies a declared fact, and tell
      // the gate about it the way production will: by durable receipt identity,
      // never by a model claim.
      const receipt = await store.pool.query(
        `INSERT INTO ${store.table('operation_receipts')}
          (run_id, ticket_id, idempotency_key, operation, outcome, target_id,
           workspace_path, mutation_fingerprint, receipt)
         VALUES ($1,$2,$3,'writeFile','succeeded','workspace',$4,$5,'{}'::jsonb)
         RETURNING id`,
        [progressRun.id, progressRun.ticketId, `progress-${ordinal}`,
          `report-${ordinal}.md`, `fingerprint-${ordinal}`]);
      const satisfying = new Map([[
        Number(receipt.rows[0].id),
        [declaredFacts[Math.min(ordinal - 1, declaredFacts.length - 1)].identity]
      ]]);
      void satisfying;
    }

    // The durable state now shows verified progress, and the evaluation built
    // from it reports progress rather than churn — the inverse of the blocked
    // Run above, from the same machinery.
    const progressState = await store.readGovernedRunProgressState(progressRun.id);
    assert.ok(progressState.receipts.length >= 3,
      'the satisfying receipts are durable');
    assert.ok(progressState.cumulativeResources.providerRequests >= 3,
      'cumulative resource history is reconstructed from durable rows');
    const satisfiedMap = new Map(progressState.receipts
      .filter(r => r.mutationFingerprint)
      .map((r, index) => [r.receiptId,
        [declaredFacts[Math.min(index, declaredFacts.length - 1)].identity]]));
    const evaluated = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
        progressState,
        declaredWorkSnapshot: progressRun.declaredWorkSnapshot,
        progressPolicy: progressRun.governedExecution.progressControlPolicy,
        satisfiedFactIdentitiesByReceiptId: satisfiedMap
      });
    assert.equal(evaluated.decision.decision, 'continue',
      'a Run whose receipts newly satisfy declared facts is not blocked');
    assert.ok(evaluated.projection.verifiedProgressCount > 0,
      'the projection reports verified progress from durable receipts');
    assert.equal(evaluated.consecutiveNoProgressWindows, 0,
      'verified progress resets the consecutive no-progress window');
    assert.ok(evaluated.decision.cumulativeResources.providerRequests >= 3,
      'and never erases cumulative resource history');

    // ── The execution epoch survives recovery; started_at does not ────────
    //
    // `recoverExpiredRun` sets `started_at = NULL`, so it measures the latest
    // attempt rather than the Run's lifetime. A Run that recovers N times would
    // otherwise receive N wall-clock budgets — the A3 defect exactly.

    const epochTicket = await admitLeafSet('Governed leaf epoch');
    const epochRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: epochTicket.ticket.id })).runs[0].id);
    // A Run waiting in the scheduler has NOT begun executing. Admission time is
    // not an execution epoch: counting queue time as execution duration would
    // charge a Run for waiting.
    const queuedState = await store.readGovernedRunProgressState(epochRun.id);
    assert.equal(queuedState.executionEpochAt, null,
      'a queued Run has no execution epoch yet');
    assert.ok(epochRun.governedExecution.capturedAt,
      'admission time exists but is deliberately not the epoch');

    // The FIRST successful claim establishes it.
    await store.claimPendingRun({
      leaseOwner: 'epoch-test', leaseDurationMs: 600_000,
      eligibleRunIds: [epochRun.id] });
    const claimedState = await store.readGovernedRunProgressState(epochRun.id);
    const epochBefore = claimedState.executionEpochAt;
    assert.ok(epochBefore, 'the first claim establishes the execution epoch');
    assert.notEqual(epochBefore, epochRun.governedExecution.capturedAt,
      'the epoch is first-execution time, not admission time');

    await store.pool.query(
      `UPDATE ${store.table('runs')}
          SET status = 'running', started_at = clock_timestamp(),
              lease_owner = 'epoch-test',
              lease_expires_at = clock_timestamp() - interval '1 hour',
              revision = revision + 1
        WHERE id = $1`, [epochRun.id]);
    await store.recoverExpiredRun({ runId: epochRun.id });

    const recoveredRun = await store.getRun(epochRun.id);
    const recoveredState = await store.readGovernedRunProgressState(epochRun.id);
    // The proof: the attempt timestamp was cleared, the epoch was not.
    assert.equal(recoveredRun.startedAt, null,
      'recovery really does clear the latest-attempt timestamp');
    assert.equal(recoveredState.latestAttemptStartedAt, null);
    assert.equal(recoveredState.executionEpochAt, epochBefore,
      'the execution epoch is unchanged by recovery, so duration cannot reset');

    // A second claim after recovery does not move it either.
    await store.claimPendingRun({
      leaseOwner: 'epoch-test-2', leaseDurationMs: 600_000,
      eligibleRunIds: [epochRun.id] });
    assert.equal(
      (await store.readGovernedRunProgressState(epochRun.id)).executionEpochAt,
      epochBefore,
      'a second lease claim does not move the epoch');

    // A restarted process reads the same epoch from the append-only event log.
    const { PostgresRuntimeStore: EpochStore } =
      require('../persistence/postgres/store');
    const epochRestart = new EpochStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
    try {
      assert.equal(
        (await epochRestart.readGovernedRunProgressState(epochRun.id)).executionEpochAt,
        epochBefore,
        'restart preserves the execution epoch');
    } finally {
      await epochRestart.close();
    }

    // A genuinely different Run receives its own epoch.
    const siblingEpochRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: epochTicket.ticket.id })).runs[1].id);
    await store.claimPendingRun({
      leaseOwner: 'epoch-test-sibling', leaseDurationMs: 600_000,
      eligibleRunIds: [siblingEpochRun.id] });
    const siblingEpoch =
      (await store.readGovernedRunProgressState(siblingEpochRun.id)).executionEpochAt;
    assert.ok(siblingEpoch, 'the sibling Run has its own epoch');
    assert.notEqual(siblingEpoch, epochBefore,
      'a distinct Run receives a distinct execution epoch');

    // A queued Run with no epoch evaluates fine — it simply has no duration to
    // bound. What refuses is a MALFORMED epoch, because silently substituting a
    // resettable stamp is the defect this guards.
    const queuedEvaluation = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
        progressState: { ...recoveredState, executionEpochAt: null },
        declaredWorkSnapshot: epochRun.declaredWorkSnapshot,
        progressPolicy: epochRun.governedExecution.progressControlPolicy
      });
    assert.equal(queuedEvaluation.executionEpochAt, null,
      'an absent epoch is carried through as null, never defaulted');
    assert.throws(
      () => require('../runtime/governed-progress-evaluation')
        .evaluateGovernedRunProgress({
          progressState: { ...recoveredState, executionEpochAt: 12345 },
          declaredWorkSnapshot: epochRun.declaredWorkSnapshot,
          progressPolicy: epochRun.governedExecution.progressControlPolicy
        }),
      /malformed execution epoch/,
      'a malformed execution epoch refuses');

    // ── Explicit evaluation cutoff ────────────────────────────────────────
    //
    // `withTransaction` runs at READ COMMITTED and receipts are written on an
    // independent connection, so a multi-query evaluation could otherwise
    // observe a mixed pre-/post-commit state. The cutoff is what makes an
    // evaluation reproducible.

    const cutoffState = await store.readGovernedRunProgressState(progressRun.id);
    assert.ok(cutoffState.cutoff, 'the evaluation binds a cutoff document');
    assert.equal(cutoffState.sourceCutoff, cutoffState.cutoff.receiptCutoff,
      'the source cutoff is the captured receipt cutoff');
    const receiptsAtCutoff = cutoffState.receipts.length;

    // A receipt committed AFTER the cutoff, on an independent connection —
    // exactly the asynchronous evidence-drain case.
    await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
        (run_id, ticket_id, idempotency_key, operation, outcome, target_id,
         workspace_path, mutation_fingerprint, receipt)
       VALUES ($1,$2,'post-cutoff','writeFile','succeeded','workspace',
               'late.md','late-fingerprint','{}'::jsonb)`,
      [progressRun.id, progressRun.ticketId]);

    // Re-evaluating with the SAME cutoff cannot see it.
    const reEvaluated = await store.readGovernedRunProgressState(progressRun.id,
      { cutoff: cutoffState.cutoff });
    assert.equal(reEvaluated.receipts.length, receiptsAtCutoff,
      'a receipt committed after the cutoff does not alter the evaluated window');
    assert.equal(reEvaluated.sourceCutoff, cutoffState.sourceCutoff,
      'reusing the cutoff reproduces the same source cutoff');
    assert.equal(
      reEvaluated.receipts.some(r => r.mutationFingerprint === 'late-fingerprint'),
      false,
      'the late receipt is invisible to the already-evaluated window');

    // A NEW evaluation, explicitly created, does see it.
    const nextEvaluation = await store.readGovernedRunProgressState(progressRun.id);
    assert.ok(nextEvaluation.cutoff.receiptCutoff > cutoffState.cutoff.receiptCutoff,
      'a new evaluation takes a strictly later cutoff');
    assert.ok(
      nextEvaluation.receipts.some(r => r.mutationFingerprint === 'late-fingerprint'),
      'the late receipt belongs to the next explicitly created evaluation');

    // Restart determinism: the same cutoff reconstructs identical hashes.
    const { PostgresRuntimeStore: CutoffStore } =
      require('../persistence/postgres/store');
    const cutoffRestart = new CutoffStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
    try {
      const restartState = await cutoffRestart.readGovernedRunProgressState(
        progressRun.id, { cutoff: cutoffState.cutoff });
      const before = require('../runtime/governed-progress-evaluation')
        .evaluateGovernedRunProgress({
          progressState: cutoffState,
          declaredWorkSnapshot: progressRun.declaredWorkSnapshot,
          progressPolicy: progressRun.governedExecution.progressControlPolicy
        });
      const after = require('../runtime/governed-progress-evaluation')
        .evaluateGovernedRunProgress({
          progressState: restartState,
          declaredWorkSnapshot: progressRun.declaredWorkSnapshot,
          progressPolicy: progressRun.governedExecution.progressControlPolicy
        });
      assert.equal(after.projection.projectionHash, before.projection.projectionHash,
        'a restart reusing the cutoff reconstructs the identical projection hash');
      assert.equal(after.decision.decisionHash, before.decision.decisionHash,
        'and the identical churn decision hash');
    } finally {
      await cutoffRestart.close();
    }

    // ── The block is a durable fact, not a thrown exception ───────────────

    const storedBlock = await store.readGovernedProgressBlock(churnRun.id);
    assert.ok(storedBlock, 'threshold exhaustion persists one complete block');
    assert.equal(storedBlock.decision, 'blocked');
    assert.equal(storedBlock.reason, 'verified_progress_exhausted');
    assert.match(storedBlock.blockHash, /^[0-9a-f]{64}$/);
    // The exact cutoff is stored, and the hash covers it.
    for (const field of ['receiptCutoff', 'reservationCutoff', 'budgetCutoff']) {
      assert.equal(Number.isSafeInteger(storedBlock.cutoff[field]), true,
        `the block stores an exact ${field}`);
    }
    assert.equal(storedBlock.progressPolicyHash,
      churnRun.governedExecution.progressControlPolicy.policyHash,
      'the block binds the captured policy, not current policy');

    // Idempotent: repeating creates no second event and no second block.
    const blockEventsBefore = (await store.listTicketEvents(churnTicket.ticket.id,
      { limit: 500 })).events.filter(e => e.type === 'run.progress_blocked').length;
    assert.equal(blockEventsBefore, 1, 'exactly one block event was appended');
    const idempotentTransport = recordingTransport();
    await runGoverned(churnRun, `model-request:agent:${blockedAt.ordinal}:provider`,
      { transport: idempotentTransport });
    const blockEventsAfter = (await store.listTicketEvents(churnTicket.ticket.id,
      { limit: 500 })).events.filter(e => e.type === 'run.progress_blocked').length;
    assert.equal(blockEventsAfter, blockEventsBefore,
      'repeated evaluation appends no second block event');
    assert.equal(idempotentTransport.calls.length, 0);
    const reReadBlock = await store.readGovernedProgressBlock(churnRun.id);
    assert.equal(reReadBlock.blockHash, storedBlock.blockHash,
      'the stored block is re-reported unchanged');

    // A receipt committed AFTER the block cutoff cannot rewrite why the Run was
    // blocked — the stored decision is consulted, not re-derived.
    await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
        (run_id, ticket_id, idempotency_key, operation, outcome, target_id,
         workspace_path, mutation_fingerprint, receipt)
       VALUES ($1,$2,'after-block','writeFile','succeeded','workspace',
               'after.md','after-fingerprint','{}'::jsonb)`,
      [churnRun.id, churnRun.ticketId]);
    const afterReceiptBlock = await store.readGovernedProgressBlock(churnRun.id);
    assert.equal(afterReceiptBlock.blockHash, storedBlock.blockHash,
      'a receipt committed after the cutoff does not rewrite the persisted block');
    assert.equal(afterReceiptBlock.cutoff.receiptCutoff,
      storedBlock.cutoff.receiptCutoff,
      'and does not widen the stored cutoff');

    // After that late receipt, a further request must STILL report the stored
    // block. Re-deriving from fresh maxima would widen the cutoff and reach a
    // different decision — which is exactly what the stored block prevents.
    const afterReceiptTransport = recordingTransport();
    const afterReceiptResult = await runGoverned(churnRun,
      `model-request:agent:${blockedAt.ordinal}:provider`,
      { transport: afterReceiptTransport });
    assert.equal(afterReceiptResult.status, 'reservation_refused');
    // The REASON matters: reading the stored block yields the blocked code.
    // Re-deriving from fresh maxima would widen the cutoff and surface a block
    // CONFLICT instead — a different failure, and the tell that recovery is
    // recomputing rather than remembering.
    assert.equal(afterReceiptResult.failureReason, 'GOVERNED_RUN_PROGRESS_BLOCKED',
      'the stored block is read, not re-derived from a fresh cutoff');
    assert.equal(afterReceiptTransport.calls.length, 0,
      'a blocked Run makes no provider call even after new receipts arrive');
    assert.equal(
      (await store.readGovernedProgressBlock(churnRun.id)).blockHash,
      storedBlock.blockHash,
      'the stored block still governs after a later receipt');
    assert.equal(
      (await store.listTicketEvents(churnTicket.ticket.id, { limit: 500 }))
        .events.filter(e => e.type === 'run.progress_blocked').length,
      blockEventsBefore,
      'no additional block event is appended after a later receipt');

    // The block transaction itself is idempotent when called directly.
    const directRepeat = await store.blockGovernedRunForProgressDecision({
      runId: churnRun.id,
      cutoff: storedBlock.cutoff,
      projection: { projectionHash: storedBlock.verifiedProgressProjectionHash },
      churnDecision: {
        decision: 'blocked',
        reason: storedBlock.reason,
        decisionHash: storedBlock.churnDecisionHash,
        cumulativeResources: storedBlock.cumulativeResources,
        consecutiveNoProgressWindows: storedBlock.consecutiveNoProgressWindows,
        repeatedOperationSignals: storedBlock.repeatedOperationSignals,
        failedOperationStreak: storedBlock.failedOperationStreak,
        mutationReversalSignals: storedBlock.mutationReversalSignals,
        progressPolicyHash: storedBlock.progressPolicyHash
      }
    });
    assert.equal(directRepeat.alreadyBlocked, true,
      'blocking an already blocked Run re-reports the stored block');
    assert.equal(directRepeat.block.blockHash, storedBlock.blockHash);
    assert.equal(
      (await store.listTicketEvents(churnTicket.ticket.id, { limit: 500 }))
        .events.filter(e => e.type === 'run.progress_blocked').length,
      blockEventsBefore,
      'a repeated block writes no second event');

    // A conflicting second block refuses rather than overwriting history.
    await assert.rejects(
      () => store.blockGovernedRunForProgressDecision({
        runId: churnRun.id,
        cutoff: { ...storedBlock.cutoff, receiptCutoff: storedBlock.cutoff.receiptCutoff + 5 },
        projection: { projectionHash: storedBlock.verifiedProgressProjectionHash },
        churnDecision: {
          decision: 'blocked', reason: storedBlock.reason,
          decisionHash: storedBlock.churnDecisionHash,
          cumulativeResources: storedBlock.cumulativeResources,
          consecutiveNoProgressWindows: storedBlock.consecutiveNoProgressWindows,
          repeatedOperationSignals: storedBlock.repeatedOperationSignals,
          failedOperationStreak: storedBlock.failedOperationStreak,
          mutationReversalSignals: storedBlock.mutationReversalSignals,
          progressPolicyHash: storedBlock.progressPolicyHash
        }
      }),
      error => error.detail && error.detail.reason === 'progress_block_conflict',
      'a second block under a different cutoff refuses rather than overwriting');

    // Tampering refuses rather than being read as authority.
    const {
      normalizeGovernedProgressBlock
    } = require('../runtime/governed-progress-block-contract');
    for (const [label, tampered] of [
      ['cutoff', { ...storedBlock,
        cutoff: { ...storedBlock.cutoff, receiptCutoff: 999_999 } }],
      ['projection hash', { ...storedBlock,
        verifiedProgressProjectionHash: 'a'.repeat(64) }],
      ['decision hash', { ...storedBlock, churnDecisionHash: 'b'.repeat(64) }]
    ]) {
      assert.throws(() => normalizeGovernedProgressBlock(tampered),
        error => error.code === 'GOVERNED_PROGRESS_BLOCK_REFUSED',
        `${label} tampering refuses`);
    }
    const { cutoff: _dropped, ...partialBlock } = storedBlock;
    assert.throws(() => normalizeGovernedProgressBlock(partialBlock),
      error => error.detail.reason === 'progress_block_partial',
      'a partial block refuses');
    assert.throws(
      () => normalizeGovernedProgressBlock({ ...storedBlock, surprise: 1 }),
      error => error.detail.reason === 'progress_block_malformed',
      'an unknown block field refuses');

    // Restart: a fresh store instance reconstructs the same decision from the
    // same durable rows. No process-local counter participates.
    const { PostgresRuntimeStore: FreshStore } =
      require('../persistence/postgres/store');
    const restarted = new FreshStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
    try {
      const restartTransport = recordingTransport();
      const afterRestart = await runGovernedLeafRequest({
        repository: restarted, run: await restarted.getRun(churnRun.id),
        logicalSourceIdentity: `model-request:agent:${blockedAt.ordinal}:provider`,
        canonicalBody: workerBody('restart'), endpointIdentity: ENDPOINT,
        transport: restartTransport, resolveCredentials: withKey,
        timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 20
      });
      assert.equal(afterRestart.status, 'reservation_refused',
        'a restarted process reaches the same blocked decision');
      assert.equal(restartTransport.calls.length, 0,
        'restart does not reset the streak or permit a provider call');
    } finally {
      await restarted.close();
    }

    // ── Cumulative execution duration across recovery ─────────────────────
    //
    // The half of pending decision A3 that the epoch work prepared but nothing
    // yet consumed. Everything below is driven by real database time and real
    // lease events; no clock is stubbed and no timestamp is hand-written.

    const durationPolicyOf = limitMs => progressControlPolicy({
      maximumCumulativeExecutionDurationMs: limitMs });

    // The evaluation instant comes from the DATABASE, inside the same snapshot
    // that captures the row maxima.
    const durTicket = await admitLeafSet('Governed leaf duration',
      { progressPolicy: durationPolicyOf(3_600_000) });
    const durRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: durTicket.ticket.id })).runs[0].id);

    // Captured at admission, and it is the ADMITTED value, not current policy.
    assert.equal(
      durRun.governedExecution.progressControlPolicy
        .maximumCumulativeExecutionDurationMs,
      3_600_000,
      'the duration limit is captured immutably on the governed Run');

    // ── Queue time is not execution time ──────────────────────────────────
    //
    // The Run is admitted `pending` and has never been leased, so no
    // `run.lease_acquired` event exists and there is no epoch to measure from.
    const durQueuedState = await store.readGovernedRunProgressState(durRun.id);
    assert.equal(durQueuedState.executionEpochAt, null,
      'a Run that has never been leased has no execution epoch');
    const durQueuedEval = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
      progressState: durQueuedState,
      declaredWorkSnapshot: durRun.declaredWorkSnapshot,
      progressPolicy: durRun.governedExecution.progressControlPolicy
    });
    assert.equal(durQueuedEval.cumulativeExecutionDurationMs, 0,
      'scheduler queue time consumes zero execution duration');
    assert.equal(durQueuedEval.decision.decision, 'continue',
      'a queued Run is not blocked for duration it has not consumed');

    // ── The evaluation instant is a database fact ─────────────────────────
    assert.ok(durQueuedState.cutoff.evaluatedAt,
      'the cutoff carries an evaluation instant');
    assert.match(durQueuedState.cutoff.evaluatedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      'the evaluation instant is a normalized ISO timestamp');
    {
      // Same instant, read from the database directly: the cutoff instant sits
      // within the database clock's own timeline, not the process clock's.
      const dbNow = (await store.pool.query(
        'SELECT clock_timestamp() AS ts')).rows[0].ts;
      const drift = Math.abs(
        Date.parse(dbNow) - Date.parse(durQueuedState.cutoff.evaluatedAt));
      assert.ok(drift < 60_000,
        'the evaluation instant tracks the database clock');
    }

    // MOVING THE PROCESS CLOCK MUST CHANGE NOTHING.
    //
    // This is the assertion that distinguishes a database-captured instant from
    // a process-captured one. The no-argument Date constructor and Date.now are
    // pushed a year into the future; parsing forms are left alone so the driver
    // keeps working. A duration bound derived from the process clock would jump
    // by a year here, which is precisely the evasion this must not allow.
    {
      const RealDate = Date;
      const skewMs = 365 * 24 * 60 * 60 * 1000;
      class SkewedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(RealDate.now() + skewMs);
          else super(...args);
        }
        static now() { return RealDate.now() + skewMs; }
      }
      let skewedEvaluatedAt = null;
      try {
        global.Date = SkewedDate;
        skewedEvaluatedAt = (await store.readGovernedRunProgressState(durRun.id))
          .cutoff.evaluatedAt;
      } finally {
        global.Date = RealDate;
      }
      const skewDrift = Math.abs(
        Date.parse(skewedEvaluatedAt) - Date.parse(durQueuedState.cutoff.evaluatedAt));
      assert.ok(skewDrift < 60_000,
        'moving the process clock does not move the evaluation instant');
      assert.ok(skewDrift < skewMs / 2,
        'the evaluation instant comes from the database, not from Date.now()');
    }

    // Two successive evaluations take strictly later instants — so a later
    // evaluation genuinely measures more elapsed time rather than reusing one.
    const durSecondQueued = await store.readGovernedRunProgressState(durRun.id);
    assert.ok(
      Date.parse(durSecondQueued.cutoff.evaluatedAt) >=
      Date.parse(durQueuedState.cutoff.evaluatedAt),
      'a later evaluation captures a later (never earlier) instant');

    // ── First lease establishes the epoch; nothing later moves it ─────────
    await store.claimPendingRun({
      leaseOwner: ACTOR, leaseDurationMs: 600_000, eligibleRunIds: [durRun.id] });
    const durStarted = (await store.startClaimedRun({
      runId: durRun.id, leaseOwner: ACTOR, leaseDurationMs: 600_000 })).run;
    const afterFirstLease = await store.readGovernedRunProgressState(durRun.id);
    const durEpoch = afterFirstLease.executionEpochAt;
    assert.ok(durEpoch, 'the first lease acquisition establishes the epoch');

    // Elapsed time is now real and positive, measured between two readings of
    // the same database clock.
    const afterFirstEval = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
      progressState: afterFirstLease,
      declaredWorkSnapshot: durRun.declaredWorkSnapshot,
      progressPolicy: durRun.governedExecution.progressControlPolicy
    });
    assert.ok(afterFirstEval.cumulativeExecutionDurationMs >= 0,
      'elapsed execution duration is non-negative');
    assert.equal(
      afterFirstEval.cumulativeExecutionDurationMs,
      Date.parse(afterFirstLease.cutoff.evaluatedAt) - Date.parse(durEpoch),
      'elapsed duration is exactly evaluatedAt minus the first lease acquisition');

    // ── Recovery does not move the epoch, and duration never decreases ────
    // Force the lease to expire so recovery genuinely runs, exactly as the
    // epoch suite above does.
    await store.pool.query(
      `UPDATE ${store.table('runs')}
          SET status = 'running', started_at = clock_timestamp(),
              lease_owner = 'duration-test',
              lease_expires_at = clock_timestamp() - interval '1 hour',
              revision = revision + 1
        WHERE id = $1`, [durRun.id]);
    await store.recoverExpiredRun({ runId: durRun.id });
    const durRecoveredRun = await store.getRun(durRun.id);
    assert.equal(durRecoveredRun.startedAt, null,
      'recovery clears the latest-attempt started_at, as A3 records');
    await store.claimPendingRun({
      leaseOwner: `${ACTOR}-2`, leaseDurationMs: 600_000, eligibleRunIds: [durRun.id] });
    await store.startClaimedRun({
      runId: durRun.id, leaseOwner: `${ACTOR}-2`, leaseDurationMs: 600_000 });

    const afterRecovery = await store.readGovernedRunProgressState(durRun.id);
    assert.equal(afterRecovery.executionEpochAt, durEpoch,
      'a second lease acquisition does NOT move the execution epoch');
    const afterRecoveryEval = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
      progressState: afterRecovery,
      declaredWorkSnapshot: durRun.declaredWorkSnapshot,
      progressPolicy: durRun.governedExecution.progressControlPolicy
    });
    assert.ok(
      afterRecoveryEval.cumulativeExecutionDurationMs >=
      afterFirstEval.cumulativeExecutionDurationMs,
      'cumulative duration never decreases across recovery');
    // The decisive contrast: the latest attempt just restarted, so an
    // attempt-local clock would have gone BACKWARDS here.
    assert.ok(afterRecovery.latestAttemptStartedAt,
      'the latest attempt has its own, later start stamp');
    assert.ok(
      Date.parse(afterRecovery.latestAttemptStartedAt) > Date.parse(durEpoch),
      'the attempt stamp really is later than the epoch, so the two differ');

    // A genuinely separate Run has its own epoch and its own duration.
    const otherDurRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: durTicket.ticket.id })).runs[1].id);
    await store.claimPendingRun({
      leaseOwner: ACTOR, leaseDurationMs: 600_000, eligibleRunIds: [otherDurRun.id] });
    const otherEpoch =
      (await store.readGovernedRunProgressState(otherDurRun.id)).executionEpochAt;
    assert.ok(otherEpoch && otherEpoch !== durEpoch,
      'a separately authorized Run receives its own epoch, not the blocked one');

    // ── A stored cutoff is replayed unchanged ─────────────────────────────
    //
    // Reusing the cutoff must reproduce the identical instant, duration and
    // hashes. If evaluation reached for the clock instead, these would drift.
    const storedCutoff = afterRecovery.cutoff;
    const replayA = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
      progressState: await store.readGovernedRunProgressState(
        durRun.id, { cutoff: storedCutoff }),
      declaredWorkSnapshot: durRun.declaredWorkSnapshot,
      progressPolicy: durRun.governedExecution.progressControlPolicy
    });
    const replayB = require('../runtime/governed-progress-evaluation')
      .evaluateGovernedRunProgress({
      progressState: await store.readGovernedRunProgressState(
        durRun.id, { cutoff: storedCutoff }),
      declaredWorkSnapshot: durRun.declaredWorkSnapshot,
      progressPolicy: durRun.governedExecution.progressControlPolicy
    });
    assert.equal(replayA.evaluatedAt, storedCutoff.evaluatedAt,
      'replaying a stored cutoff reuses its evaluation instant unchanged');
    assert.equal(replayA.cumulativeExecutionDurationMs,
      replayB.cumulativeExecutionDurationMs,
      'replaying a stored cutoff reproduces the identical duration');
    assert.equal(replayA.projection.projectionHash, replayB.projection.projectionHash,
      'replaying a stored cutoff reproduces the identical projection hash');
    assert.equal(replayA.decision.decisionHash, replayB.decision.decisionHash,
      'replaying a stored cutoff reproduces the identical decision hash');
    // A FRESH evaluation is explicitly a different, later fact.
    const freshLater = await store.readGovernedRunProgressState(durRun.id);
    assert.ok(
      Date.parse(freshLater.cutoff.evaluatedAt) >=
      Date.parse(storedCutoff.evaluatedAt),
      'a fresh evaluation takes a later explicit cutoff rather than reusing one');

    // ── Enforcement at the pre-reservation gate ───────────────────────────
    //
    // A Run admitted with a 1ms total budget. It has already been leased, so
    // its epoch is real and its elapsed time genuinely exceeds the bound — no
    // clock is manipulated to arrange this.
    const expiredTicket = await admitLeafSet('Governed leaf duration exhausted',
      { progressPolicy: durationPolicyOf(1) });
    const expiredRun = await store.getRun(
      (await store.listRunsForTicket({ ticketId: expiredTicket.ticket.id })).runs[0].id);
    await store.claimPendingRun({
      leaseOwner: ACTOR, leaseDurationMs: 600_000, eligibleRunIds: [expiredRun.id] });
    await store.startClaimedRun({
      runId: expiredRun.id, leaseOwner: ACTOR, leaseDurationMs: 600_000 });

    const reservationsFor = async runId => (await store.pool.query(
      `SELECT count(*)::int AS c FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1`, [runId])).rows[0].c;
    const chargesFor = async runId => (await store.pool.query(
      `SELECT count(*)::int AS c FROM ${store.table('run_budget_charges')}
        WHERE run_id = $1`, [runId])).rows[0].c;
    const blockEventsFor = async ticketId =>
      (await store.listTicketEvents(ticketId, { limit: 500 }))
        .events.filter(e => e.type === 'run.progress_blocked').length;

    assert.equal(await reservationsFor(expiredRun.id), 0);
    assert.equal(await chargesFor(expiredRun.id), 0);

    const expiredTransport = recordingTransport();
    const expiredResult = await runGoverned(expiredRun,
      'model-request:agent:1:provider', { transport: expiredTransport });

    assert.equal(expiredResult.status, 'reservation_refused',
      'a duration-exhausted Run is refused at the pre-reservation gate');
    assert.equal(expiredResult.failureReason, 'GOVERNED_RUN_PROGRESS_BLOCKED',
      'the refusal is the governed progress block, not a transport failure');

    // THE SHAPE OF A RESERVATION REFUSAL, asserted deterministically.
    //
    // The duplicate-concurrency check above tolerates a caller that was refused
    // before it reached the ledger, on the grounds that such a caller reserved
    // nothing and dispatched nothing. That tolerance is only sound if a refusal
    // genuinely carries no ordinal and claims no dispatch — and a refusal is
    // not reproducible on demand there, since it depends on pool exhaustion.
    // It IS reproducible here, so the invariant the tolerance rests on is
    // proved at a place where it always executes.
    assert.equal(expiredResult.ordinal, null,
      'a reservation refusal carries no ordinal');
    assert.equal(expiredResult.possiblyDispatched, false,
      'a reservation refusal never claims the request may have been dispatched');
    assert.equal(expiredResult.reservationId, null,
      'a reservation refusal names no reservation');
    // Everything downstream of the gate must be untouched.
    assert.equal(expiredTransport.calls.length, 0,
      'a duration-exhausted Run makes ZERO provider calls');
    assert.equal(await reservationsFor(expiredRun.id), 0,
      'no economic reservation is created for a duration-exhausted Run');
    assert.equal(await chargesFor(expiredRun.id), 0,
      'no model-request budget charge is created for a duration-exhausted Run');

    // Exactly one persisted block, naming the duration bound and nothing else.
    const expiredBlock = await store.readGovernedProgressBlock(expiredRun.id);
    assert.ok(expiredBlock, 'the duration stop is persisted as a canonical block');
    assert.equal(expiredBlock.reason, 'cumulative_execution_duration_exhausted',
      'the block names the duration bound, not a churn pattern');
    assert.equal(expiredBlock.decision, 'blocked',
      'the decision is blocked — no retry, reroute or replan');
    assert.equal(expiredBlock.siblingDependency, null,
      'a duration stop cites no sibling dependency');
    assert.match(expiredBlock.blockHash, /^[0-9a-f]{64}$/);
    assert.match(expiredBlock.churnDecisionHash, /^[0-9a-f]{64}$/);
    assert.match(expiredBlock.progressPolicyHash, /^[0-9a-f]{64}$/);
    assert.equal(expiredBlock.progressPolicyHash,
      expiredRun.governedExecution.progressControlPolicy.policyHash,
      'the block binds the ADMITTED policy, not current policy');
    assert.ok(expiredBlock.executionEpochAt,
      'the block records the execution epoch it measured from');
    assert.ok(expiredBlock.cutoff.evaluatedAt,
      'the block records the database-captured evaluation instant');
    assert.ok(
      Date.parse(expiredBlock.cutoff.evaluatedAt) >=
      Date.parse(expiredBlock.executionEpochAt),
      'the recorded evaluation instant is at or after the epoch');
    assert.ok(
      expiredBlock.cumulativeResources.cumulativeExecutionDurationMs >=
      expiredRun.governedExecution.progressControlPolicy
        .maximumCumulativeExecutionDurationMs,
      'the recorded elapsed duration really does meet or exceed the limit');

    const expiredEvents = await blockEventsFor(expiredTicket.ticket.id);
    assert.equal(expiredEvents, 1, 'exactly one block event is appended');

    // ── Repeated invocation is idempotent ─────────────────────────────────
    //
    // The stored block is read; no fresh cutoff is captured, nothing is spent,
    // and no second event appears.
    const repeatExpiredTransport = recordingTransport();
    const repeatExpired = await runGoverned(expiredRun,
      'model-request:agent:2:provider', { transport: repeatExpiredTransport });
    assert.equal(repeatExpired.status, 'reservation_refused');
    assert.equal(repeatExpired.failureReason, 'GOVERNED_RUN_PROGRESS_BLOCKED');
    assert.equal(repeatExpiredTransport.calls.length, 0,
      'a repeated attempt on a duration-blocked Run makes zero provider calls');
    assert.equal(await reservationsFor(expiredRun.id), 0);
    assert.equal(await chargesFor(expiredRun.id), 0);
    assert.equal(await blockEventsFor(expiredTicket.ticket.id), 1,
      'a repeated attempt appends no duplicate block event');
    const rereadBlock = await store.readGovernedProgressBlock(expiredRun.id);
    assert.equal(rereadBlock.blockHash, expiredBlock.blockHash,
      'the stored block is unchanged — the decision of record is not re-derived');
    assert.equal(rereadBlock.cutoff.evaluatedAt, expiredBlock.cutoff.evaluatedAt,
      'no fresh evaluation instant is captured for an already-blocked Run');

    // Recovery of a duration-blocked Run keeps it blocked, on the stored facts.
    {
      const { PostgresRuntimeStore: DurStore } = require('../persistence/postgres/store');
      const durRestart = new DurStore({
        connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
      try {
        const afterRestart = await durRestart.readGovernedProgressBlock(expiredRun.id);
        assert.equal(afterRestart.blockHash, expiredBlock.blockHash,
          'a restart reproduces the identical duration block');
        assert.equal(
          afterRestart.cumulativeResources.cumulativeExecutionDurationMs,
          expiredBlock.cumulativeResources.cumulativeExecutionDurationMs,
          'the recorded duration survives restart unchanged');
      } finally {
        await durRestart.close();
      }
    }

    // ── Current-policy drift cannot rewrite admitted authority ────────────
    //
    // Raising the limit in a NEW policy does not unblock or re-authorize a Run
    // that was admitted under the old one.
    const durRaisedPolicy = durationPolicyOf(3_600_000);
    assert.notEqual(durRaisedPolicy.policyHash,
      expiredRun.governedExecution.progressControlPolicy.policyHash,
      'the raised policy is genuinely different authority');
    const durStillBlockedTransport = recordingTransport();
    const durStillBlocked = await runGoverned(expiredRun,
      'model-request:agent:3:provider', { transport: durStillBlockedTransport });
    assert.equal(durStillBlocked.status, 'reservation_refused',
      'a later, more generous policy does not unblock an admitted Run');
    assert.equal(durStillBlockedTransport.calls.length, 0);
    assert.equal(
      (await store.getRun(expiredRun.id)).governedExecution.progressControlPolicy
        .maximumCumulativeExecutionDurationMs,
      1,
      'the admitted duration authority is unchanged by current policy');

    // ── Sibling-read coordination ─────────────────────────────────────────
    //
    // Siblings stay independent: this refuses the reader and stops it. It never
    // waits for the sibling, which would be a dependency by another name.

    const sibTicket = await admitLeafSet('Governed sibling reads');
    const sibRuns = (await store.listRunsForTicket({ ticketId: sibTicket.ticket.id })).runs;
    assert.ok(sibRuns.length >= 2, 'two bound sibling Runs exist');
    const readerRun = await store.getRun(sibRuns[0].id);
    const siblingRun = await store.getRun(sibRuns[1].id);
    const sibPlan = await store.getAllocationPlanForTicket(sibTicket.ticket.id);
    const readerItem = sibPlan.items.find(
      i => i.allocationItemId === readerRun.leafRunBinding.allocationItemId);
    const siblingItem = sibPlan.items.find(
      i => i.allocationItemId === siblingRun.leafRunBinding.allocationItemId);

    const resolve = (runId, requestedPath) =>
      store.resolveGovernedSiblingReadAuthority({ runId, requestedPath });

    // Own scope and unrelated scope defer to existing read authority.
    assert.equal((await resolve(readerRun.id, `${readerItem.ownedOutputPaths[0]}notes.md`))
      .outcome, 'own_scope', 'a Run reading its own owned path is own scope');
    assert.equal((await resolve(readerRun.id, 'shared/context.md')).outcome,
      'unrelated_scope', 'an unrelated path defers to existing authority');
    // A shared parent is NOT a dependency merely because a sibling owns a
    // descendant beneath it.
    assert.equal((await resolve(readerRun.id, 'reports/')).outcome, 'unrelated_scope',
      'a shared parent listing is not blocked by sibling descendants');
    assert.equal((await resolve(readerRun.id, '')).outcome, 'unrelated_scope',
      'a root listing is not blocked');

    // Sibling-owned reads: exact file, descendant, and normalized equivalent.
    const siblingScope = siblingItem.ownedOutputPaths[0];
    for (const [label, requested] of [
      ['exact sibling file', `${siblingScope}report.md`],
      ['descendant beneath sibling scope', `${siblingScope}deep/nested/file.md`],
      ['normalized equivalent', `./${siblingScope}//report.md`]
    ]) {
      const blockedResolve = await resolve(readerRun.id, requested);
      assert.equal(blockedResolve.outcome, 'blocked_incomplete_sibling',
        `${label} blocks while the sibling is unverified`);
      assert.equal(blockedResolve.sibling.siblingAllocationItemId,
        siblingItem.allocationItemId);
      assert.ok(['incomplete', 'decision_absent', 'terminal_without_decision']
        .includes(blockedResolve.sibling.siblingCompletionState),
        'the completion state is a closed value');
      assert.equal(blockedResolve.sibling.siblingCompletionDecisionHash, null,
        'a blocked sibling read cites no completion decision');
    }

    // Persisting the refusal produces the canonical block, with sibling facts.
    const sibBlockResult = await store.blockGovernedRunForSiblingRead({
      runId: readerRun.id,
      sibling: (await resolve(readerRun.id, `${siblingScope}report.md`)).sibling
    });
    const sibBlock = await store.readGovernedProgressBlock(readerRun.id);
    assert.ok(sibBlock, 'a sibling read persists the canonical block');
    assert.equal(sibBlock.reason, 'undeclared_sibling_dependency');
    assert.equal(sibBlock.siblingDependency.siblingAllocationItemId,
      siblingItem.allocationItemId);
    assert.equal(sibBlock.siblingDependency.requestedPath.includes('report.md'), true);
    assert.ok(sibBlock.cutoff.receiptCutoff >= 0, 'the block binds the durable cutoff');
    assert.match(sibBlock.progressPolicyHash, /^[0-9a-f]{64}$/);
    assert.match(sibBlock.blockHash, /^[0-9a-f]{64}$/);

    // One event, and repeating is idempotent.
    const sibEvents = () => store.listTicketEvents(sibTicket.ticket.id, { limit: 500 })
      .then(r => r.events.filter(e => e.type === 'run.progress_blocked').length);
    const sibEventsAfterFirst = await sibEvents();
    assert.equal(sibEventsAfterFirst, 1, 'exactly one sibling block event');
    await store.blockGovernedRunForSiblingRead({
      runId: readerRun.id,
      sibling: (await resolve(readerRun.id, `${siblingScope}report.md`)).sibling
    });
    assert.equal(await sibEvents(), sibEventsAfterFirst,
      'a repeated sibling read appends no second event');

    // The blocked reader cannot reach the provider path afterwards.
    const sibTransport = recordingTransport();
    const afterSibBlock = await runGoverned(readerRun,
      'model-request:agent:1:provider', { transport: sibTransport });
    assert.equal(afterSibBlock.status, 'reservation_refused');
    assert.equal(sibTransport.calls.length, 0,
      'a sibling-blocked Run makes zero provider calls');
    assert.equal(afterSibBlock.failureReason, 'GOVERNED_RUN_PROGRESS_BLOCKED');
    assert.equal(
      (await store.pool.query(
        `SELECT count(*)::int AS c FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1`, [readerRun.id])).rows[0].c,
      0, 'no economic reservation is created after a sibling block');

    // Later sibling completion does not resume the already blocked reader.
    // Through the real lifecycle: pending -> running -> completed. Even a
    // genuinely terminal sibling is not a COMPLETED ITEM without its decision.
    await store.claimPendingRun({
      leaseOwner: 'sibling-completion', leaseDurationMs: 600_000,
      eligibleRunIds: [siblingRun.id] });
    await store.pool.query(
      `UPDATE ${store.table('runs')} SET status = 'running',
              started_at = COALESCE(started_at, clock_timestamp()),
              revision = revision + 1
        WHERE id = $1`, [siblingRun.id]);
    await store.pool.query(
      `UPDATE ${store.table('runs')} SET status = 'completed',
              current_phase = 'terminalization',
              completed_at = clock_timestamp(), lease_owner = NULL,
              lease_expires_at = NULL, revision = revision + 1
        WHERE id = $1`, [siblingRun.id]);
    const stillBlocked = await store.readGovernedProgressBlock(readerRun.id);
    assert.equal(stillBlocked.blockHash, sibBlock.blockHash,
      'later sibling completion does not alter the blocked reader');
    assert.equal(await sibEvents(), sibEventsAfterFirst,
      'and appends no further event');

    // Terminal status alone is NOT completion proof.
    const terminalResolve = await resolve(readerRun.id, `${siblingScope}report.md`);
    assert.equal(terminalResolve.outcome, 'blocked_incomplete_sibling',
      'a terminal sibling Run without a completion decision still blocks');

    // ── Disposition-backed sibling completion states ──────────────────────
    //
    // Every state below is produced through the CANONICAL Tranche 3 lifecycle —
    // real claim, real transition, real consequence, real reconciliation. None
    // forces `itemStatus` or writes a decision hash by hand, because a fixture
    // that fabricates completion proves nothing about the authority that
    // normally grants it.

    const dispositionOutcome = async (label, drive, admitOptions = {}) => {
      const t = await admitLeafSet(`Sibling state ${label}`, admitOptions);
      const runs = (await store.listRunsForTicket({ ticketId: t.ticket.id })).runs;
      const reader = await store.getRun(runs[0].id);
      const sib = await store.getRun(runs[1].id);
      const plan = await store.getAllocationPlanForTicket(t.ticket.id);
      const sibItem = plan.items.find(
        i => i.allocationItemId === sib.leafRunBinding.allocationItemId);
      await drive({ sib, sibItem, ticket: t.ticket, plan });
      const resolved = await store.resolveGovernedSiblingReadAuthority({
        runId: reader.id, requestedPath: `${sibItem.ownedOutputPaths[0]}report.md`
      });
      return { resolved, reader, sib, sibItem, ticket: t.ticket, plan };
    };

    const driveTerminal = async (sib, status) => {
      await store.claimPendingRun({
        leaseOwner: ACTOR, leaseDurationMs: 600_000, eligibleRunIds: [sib.id] });
      const running = (await store.startClaimedRun({
        runId: sib.id, leaseOwner: ACTOR, leaseDurationMs: 600_000 })).run;
      if (status === 'running') return running;
      return (await store.transitionRun({
        runId: sib.id, expectedRevision: running.revision,
        fromStatuses: ['running'], toStatus: status, leaseOwner: ACTOR })).run;
    };

    // A. nonterminal sibling — never claimed.
    const stateA = await dispositionOutcome('A nonterminal', async () => {});
    assert.equal(stateA.resolved.outcome, 'blocked_incomplete_sibling',
      'A: a nonterminal sibling blocks');

    // B/C. terminal failed and interrupted.
    for (const [label, status] of [['B failed', 'failed'], ['C interrupted', 'interrupted']]) {
      const state = await dispositionOutcome(label, async ({ sib }) => {
        await driveTerminal(sib, status);
      });
      assert.equal(state.resolved.outcome, 'blocked_incomplete_sibling',
        `${label}: a terminal ${status} sibling blocks`);
      assert.equal(state.resolved.sibling.siblingCompletionDecisionHash, null,
        `${label}: no completion decision is cited`);
    }

    // D. terminal COMPLETED Run with no durable completion decision. The
    // decisive case: terminal status is not completion authority.
    const stateD = await dispositionOutcome('D terminal no decision',
      async ({ sib, ticket, plan }) => {
        await driveTerminal(sib, 'completed');
        await store.reconcileStructuredAllocationLeafItems({
          ticketId: ticket.id, allocationPlanId: plan.id });
      });
    assert.equal(stateD.resolved.outcome, 'blocked_incomplete_sibling',
      'D: a terminal completed Run without a decision still blocks');
    assert.equal(stateD.resolved.sibling.siblingCompletionDecisionHash, null,
      'D: the block cites no completion decision');
    assert.ok(['incomplete', 'decision_absent', 'terminal_without_decision']
      .includes(stateD.resolved.sibling.siblingCompletionState),
      'D: the unresolved state is explicit and closed');

    // E. terminal completed with a decision built against a DIFFERENT item's
    // authority — a wrong-Run/stale decision, which the canonical derivation
    // refuses to treat as this item's completion.
    const stateE = await dispositionOutcome('E stale decision',
      async ({ sib, sibItem, ticket, plan }) => {
        const terminal = await driveTerminal(sib, 'completed');
        const foreignAuthority = buildCompletionAuthoritySnapshot({
          objective: 'A different item objective',
          kind: 'deterministic', recognized: true, intent: 'create_folder',
          completionPolicy: 'declared_postconditions',
          directPostconditions: [{ type: 'folder_exists', path: 'somewhere-else' }],
          verificationPolicy: 'when_declared',
          capturedAt: new Date().toISOString()
        });
        await store.recordRunConsequence({
          runId: sib.id,
          consequence: {
            version: 1, runId: sib.id, ticketId: sib.ticketId,
            verification: { browserEvidence: null },
            completionDecision: buildCompletionDecision({
              run: { ...terminal, completionAuthoritySnapshot: foreignAuthority,
                runtimeBudgetSnapshot: null },
              replaySnapshot: { events: [], modelResponses: [], parsedModelPlans: [],
                workspaceOperations: [], providerRequests: [] },
              events: [], operations: [],
              consequence: { version: 1, runId: sib.id, ticketId: sib.ticketId,
                verification: { browserEvidence: null } },
              verificationContract: null, evaluatedAt: new Date().toISOString()
            })
          }
        });
        await store.reconcileStructuredAllocationLeafItems({
          ticketId: ticket.id, allocationPlanId: plan.id });
        void sibItem;
      });
    assert.equal(stateE.resolved.outcome, 'blocked_incomplete_sibling',
      'E: a decision built against another authority does not complete the item');
    assert.equal(stateE.resolved.sibling.siblingCompletionDecisionHash, null,
      'E: a stale decision is never projected as valid completion authority');

    // ── F and G: the completed-sibling permission boundary ────────────────
    //
    // A and E prove that terminal status and foreign authority do not grant a
    // read. They do NOT prove the converse: that genuine completion DOES. Until
    // some state resolves to `verified_completed_sibling`, "blocks everything"
    // and "correctly distinguishes completion" are indistinguishable, and the
    // `itemStatus === 'completed'` and `completionDecisionHash` checks in the
    // resolver are unexercised.
    //
    // F and G share ONE admission shape — deterministic completion authority,
    // the only kind the canonical decision builder can actually satisfy from
    // durable evidence — and differ in exactly one variable: whether the
    // durable replay evidence satisfies the admitted postcondition. Nothing
    // below sets `itemStatus`, writes a `completionDecisionHash`, or hand-builds
    // an `aggregateDecision`; every disposition comes from
    // `reconcileStructuredAllocationLeafItems` reading a decision that
    // `buildCompletionDecision` produced from evidence.

    // The canonical consequence shape. `checkedPath` is the ONLY knob: point it
    // at the item's admitted postcondition path and the authority is satisfied;
    // point it elsewhere and the same authority is genuinely unsatisfied.
    const decisionConsequence = (run, { checkedPath }) => {
      const base = {
        version: 1, runId: run.id, ticketId: run.ticketId,
        verification: { browserEvidence: null }
      };
      return {
        ...base,
        completionDecision: buildCompletionDecision({
          run: { ...run, runtimeBudgetSnapshot: null },
          replaySnapshot: {
            events: [{
              type: 'run:postcondition_completed',
              checkedPaths: [{ type: 'folder', path: checkedPath }]
            }],
            modelResponses: [], parsedModelPlans: [],
            workspaceOperations: [], providerRequests: []
          },
          events: [], operations: [],
          consequence: base,
          verificationContract: null,
          evaluatedAt: new Date().toISOString()
        })
      };
    };

    const ownedFolderOf = item => item.ownedOutputPaths[0].replace(/\/$/, '');

    // F. Terminal completed Run carrying a REAL durable decision, built against
    // the item's OWN admitted authority — but from evidence that checked a
    // different path, so the authority is not satisfied. This is the decisive
    // negative: the decision exists, is bound to the right Run and the right
    // authority, and is still not completion. Distinct from D (no decision at
    // all) and from E (a decision bound to a different authority).
    const stateF = await dispositionOutcome('F unsatisfied decision',
      async ({ sib, ticket, plan }) => {
        const terminal = await driveTerminal(sib, 'completed');
        await store.recordRunConsequence({
          runId: sib.id,
          consequence: decisionConsequence(terminal, {
            checkedPath: 'some/other/folder'
          })
        });
        await store.reconcileStructuredAllocationLeafItems({
          ticketId: ticket.id, allocationPlanId: plan.id });
      }, { deterministicCompletion: true });

    assert.equal(stateF.resolved.outcome, 'blocked_incomplete_sibling',
      'F: a durable decision that does not satisfy the admitted authority blocks');
    assert.equal(stateF.resolved.sibling.siblingCompletionDecisionHash, null,
      'F: an unsatisfied decision is never cited as valid completion authority');
    assert.ok(['incomplete', 'decision_absent', 'terminal_without_decision']
      .includes(stateF.resolved.sibling.siblingCompletionState),
      'F: the unresolved state is drawn from the closed vocabulary');
    {
      const fPlan = await store.getAllocationPlanForTicket(stateF.ticket.id);
      const fItem = fPlan.aggregateDecision.items.find(
        i => i.runId === stateF.sib.id);
      assert.ok(fItem, 'F: the sibling item has a real reconciled disposition');
      assert.notEqual(fItem.itemStatus, 'completed',
        'F: the canonical reconciliation itself refuses to complete the item');
    }

    // G. The same admission, the same lifecycle, one variable changed: the
    // evidence checks the item's OWN admitted postcondition path. This is the
    // only state in the matrix that must PERMIT the read.
    const stateG = await dispositionOutcome('G verified complete',
      async ({ sib, sibItem, ticket, plan }) => {
        const terminal = await driveTerminal(sib, 'completed');
        await store.recordRunConsequence({
          runId: sib.id,
          consequence: decisionConsequence(terminal, {
            checkedPath: ownedFolderOf(sibItem)
          })
        });
        await store.reconcileStructuredAllocationLeafItems({
          ticketId: ticket.id, allocationPlanId: plan.id });
      }, { deterministicCompletion: true });

    // First: the disposition really was produced by canonical reconciliation.
    const gPlan = await store.getAllocationPlanForTicket(stateG.ticket.id);
    const gItem = gPlan.aggregateDecision.items.find(i => i.runId === stateG.sib.id);
    assert.ok(gItem, 'G: the sibling item has a reconciled disposition');
    assert.equal(gItem.itemStatus, 'completed',
      'G: canonical reconciliation completed the item from durable evidence');
    assert.equal(gItem.reason, 'completion_verified',
      'G: completion was verified, not assumed');
    assert.match(gItem.completionDecisionHash, /^[0-9a-f]{64}$/,
      'G: a real completion-decision identity backs the disposition');

    // Then: the resolver PERMITS the read, and cites that same identity.
    assert.equal(stateG.resolved.outcome, 'verified_completed_sibling',
      'G: a genuinely completed sibling is readable');
    assert.equal(stateG.resolved.sibling.siblingCompletionDecisionHash,
      gItem.completionDecisionHash,
      'G: permission cites the exact durable decision identity that granted it');

    // ── Phase 4: the decisive authority distinction ───────────────────────
    //
    // F and G differ in ONE durable fact. Everything else — admission shape,
    // completion authority, terminal status, the presence of a real decision —
    // is identical. So the permission cannot be coming from status, from
    // admission, or from the mere existence of a decision.
    assert.equal(stateF.sib.completionAuthoritySnapshot.completionKind,
      stateG.sib.completionAuthoritySnapshot.completionKind,
      'F and G were admitted under the same completion-authority kind');
    assert.notEqual(stateF.resolved.outcome, stateG.resolved.outcome,
      'the same admission shape yields opposite permission outcomes');

    // Permission is not a side effect: G created no block and no block event.
    const gBlock = await store.readGovernedProgressBlock(stateG.reader.id);
    assert.equal(gBlock, null,
      'G: permitting a read persists no progress block');
    {
      const gEvents = await store.listRunEvents(stateG.reader.id, { limit: 200 });
      assert.equal(
        gEvents.filter(e => e.type === 'run.progress_blocked').length, 0,
        'G: permitting a read appends no block event');
    }

    // ── Later completion does not retroactively unblock a blocked Run ─────
    //
    // A block is a durable fact about a decision already made under the
    // authority that existed at the time. When the sibling later completes,
    // the blocked Run stays blocked — the block is not silently revoked — while
    // the SAME now-completed sibling becomes readable to a Run resolving fresh
    // authority. This is the difference between "blocked forever" and "blocked
    // on a fact that has since changed".
    {
      const t = await admitLeafSet('Sibling completes after a block',
        { deterministicCompletion: true });
      const runs = (await store.listRunsForTicket({ ticketId: t.ticket.id })).runs;
      const blockedReader = await store.getRun(runs[0].id);
      const laterSibling = await store.getRun(runs[1].id);
      const plan = await store.getAllocationPlanForTicket(t.ticket.id);
      const sibItem = plan.items.find(
        i => i.allocationItemId === laterSibling.leafRunBinding.allocationItemId);
      const target = `${sibItem.ownedOutputPaths[0]}report.md`;

      // Block while the sibling is genuinely incomplete.
      const before = await store.resolveGovernedSiblingReadAuthority({
        runId: blockedReader.id, requestedPath: target });
      assert.equal(before.outcome, 'blocked_incomplete_sibling',
        'the sibling is incomplete when the block is taken');
      await store.blockGovernedRunForSiblingRead({
        runId: blockedReader.id, sibling: before.sibling });
      const storedBlock = await store.readGovernedProgressBlock(blockedReader.id);
      assert.ok(storedBlock, 'the block is durable');

      // Now complete the sibling through the canonical lifecycle.
      const terminal = await driveTerminal(laterSibling, 'completed');
      await store.recordRunConsequence({
        runId: laterSibling.id,
        consequence: decisionConsequence(terminal, {
          checkedPath: ownedFolderOf(sibItem)
        })
      });
      await store.reconcileStructuredAllocationLeafItems({
        ticketId: t.ticket.id, allocationPlanId: plan.id });

      // The durable block is unchanged — completion does not rewrite history.
      const afterBlock = await store.readGovernedProgressBlock(blockedReader.id);
      assert.equal(afterBlock.blockHash, storedBlock.blockHash,
        'a later completion never rewrites or revokes the recorded block');

      // And the sibling is now genuinely readable under fresh authority.
      const after = await store.resolveGovernedSiblingReadAuthority({
        runId: blockedReader.id, requestedPath: target });
      assert.equal(after.outcome, 'verified_completed_sibling',
        'resolving fresh authority sees the now-verified completion');
      assert.match(after.sibling.siblingCompletionDecisionHash, /^[0-9a-f]{64}$/,
        'the fresh resolution cites the real decision identity');
    }

    // ── Invariant-owner attribution: completed WITHOUT a decision hash ────
    //
    // The resolver also guards `!disposition.completionDecisionHash`. No state
    // in the matrix reaches it, and that is not a coverage gap — the state is
    // NOT REPRESENTABLE. `normalizeAggregatePlanDecision` refuses it outright,
    // and `getAllocationPlanForTicket` normalizes on read, so even a tampered
    // durable row cannot deliver such a disposition to the resolver.
    //
    // The invariant is therefore OWNED by the leaf-run contract, not by the
    // resolver, and it is proved where it actually lives. Manufacturing a fake
    // disposition here purely to make the resolver's guard appear load-bearing
    // would misattribute the invariant and overstate this suite's coverage.
    {
      const hash = 'a'.repeat(64);
      const decision = supporting => ({
        version: 1, ticketId: 1, allocationPlanId: 1, planHash: hash,
        planningAdmissionHash: hash, aggregateStatus: 'in_progress',
        completedItemIds: [], failedItemIds: [], interruptedItemIds: [],
        unresolvedItemIds: [], decisionHash: hash,
        decidedAt: new Date().toISOString(),
        items: [{
          allocationItemId: 1, runId: 1, assignedAgentId: 1, runLineage: [1],
          itemStatus: 'completed', completionDecisionHash: supporting,
          reason: 'completion_verified'
        }]
      });
      assert.throws(() => normalizeAggregatePlanDecision(decision(null)),
        /claims completion without a supporting completion decision/,
        'a completed item with no decision hash is refused by the contract');
      assert.throws(() => normalizeAggregatePlanDecision(decision('')),
        /completionDecisionHash must be a lowercase SHA-256/,
        'an empty decision hash is refused by shape before it can mean anything');
    }

    // ── Corrupted multiple-overlap ownership fails closed ─────────────────
    //
    // Plan admission enforces non-overlapping owned scopes, so this state is
    // unreachable normally. It is manufactured HERE, inside this isolated
    // check, by tampering with the persisted plan — admission enforcement is
    // not weakened to produce it. If durable authority is ever corrupt, the
    // resolver must refuse rather than pick a sibling.
    const corruptTicket = await admitLeafSet('Governed sibling corruption');
    const corruptRuns = (await store.listRunsForTicket({
      ticketId: corruptTicket.ticket.id })).runs;
    const corruptReader = await store.getRun(corruptRuns[0].id);
    const corruptPlan = await store.getAllocationPlanForTicket(corruptTicket.ticket.id);
    const readerItemId = corruptReader.leafRunBinding.allocationItemId;
    // Give TWO non-reader items ownership of the same scope.
    const contested = 'contested/';
    // Tamper the STORED body directly, preserving its exact field shape, so the
    // corruption is in persisted authority rather than in a rebuilt document.
    const storedBody = (await store.pool.query(
      `SELECT body FROM ${store.table('allocation_plans')} WHERE id = $1`,
      [corruptPlan.id])).rows[0].body;
    const corruptedItems = storedBody.items.map(item =>
      item.allocationItemId === readerItemId
        ? item
        : { ...item, ownedOutputPaths: [contested] });
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
          SET body = jsonb_set(body, '{items}', $2::jsonb), revision = revision + 1
        WHERE id = $1`,
      [corruptPlan.id, JSON.stringify(corruptedItems)]);

    // THE INVARIANT OWNER IS THE PLAN CONTRACT, not the resolver's own
    // multiple-match branch. `normalizeAllocationPlan` refuses overlapping
    // sibling ownership on read, so corrupted authority never reaches the
    // resolver at all. The resolver's `matches.length > 1` branch is
    // unreachable defense-in-depth, and this test says so rather than
    // pretending otherwise.
    await assert.rejects(
      () => store.resolveGovernedSiblingReadAuthority({
        runId: corruptReader.id, requestedPath: `${contested}report.md`
      }),
      error => {
        assert.match(String(error.message), /overlap/i,
          'the plan contract names the overlap');
        return true;
      },
      'corrupted overlapping sibling ownership fails closed on plan read');
    // No content, no arbitrary sibling choice, and no misleading block.
    assert.equal(await store.readGovernedProgressBlock(corruptReader.id), null,
      'a corrupt overlap creates no undeclared-sibling block naming one sibling');

    // Restart preserves the sibling block.
    const { PostgresRuntimeStore: SibStore } = require('../persistence/postgres/store');
    const sibRestart = new SibStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
    try {
      assert.equal(
        (await sibRestart.readGovernedProgressBlock(readerRun.id)).blockHash,
        sibBlock.blockHash, 'restart preserves the sibling block');
    } finally {
      await sibRestart.close();
    }

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
