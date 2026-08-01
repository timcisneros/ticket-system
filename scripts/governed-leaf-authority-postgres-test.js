#!/usr/bin/env node
'use strict';

// Tranche 4 focused suite for governed structured-leaf authority capture and
// the no-network next-request reservation seam.
//
// Real PostgreSQL. NO transport of any kind is constructed here, because this
// slice does not dispatch: it ends with a committed reservation and the exact
// bytes a later cutover will send. Fixture prices only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const { readGovernedPolicySource } = require('../runtime/governed-policy-source');
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

const ACTOR = 'governed-leaf-authority-postgres-test';
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

    // ── The Run-body envelope is the storage seam ──────────────────────────
    //
    // Historical Runs simply omit the key, so their reconstruction is exactly
    // what it always was.

    // A plain ticket with no structured authority: the historical path.
    const plainNow = new Date().toISOString();
    const plainTicket = (await store.createTicketWithEvent({
      ticket: {
        objective: `Historical run ${STAMP}`, acceptanceCriteria: 'Do it.',
        assignmentTargetType: 'agent', assignmentTargetId: workerA.id,
        assignmentMode: 'direct', ownedOutputPaths: {},
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
        changedAt: plainNow, createdAt: plainNow, updatedAt: plainNow
      },
      eventPayload: { source: ACTOR }
    })).ticket;
    const historical = await store.createRunsAndStartTicket({
      ticketId: plainTicket.id,
      runDrafts: [{ ticketId: plainTicket.id, agentId: workerA.id }]
    });
    const historicalRun = await store.getRun(historical.runs[0].id);
    assert.equal(Object.prototype.hasOwnProperty.call(historicalRun, 'governedExecution'),
      false, 'a historical Run carries no governed envelope at all');
    const historicalClass = classifyRunGovernance(historicalRun);
    assert.equal(historicalClass.governed, false);
    assert.equal(historicalClass.historical, true,
      'an absent envelope is historical, never partial');
    await code(
      store.prepareAndReserveNextGovernedRunRequest({
        runId: historicalRun.id, logicalSourceIdentity: 'model-request:agent:x:provider',
      canonicalBody: workerBody(), endpointIdentity: ENDPOINT
      }),
      'GOVERNED_RUN_NOT_LEAF',
      'a historical Run cannot prepare a governed request');

    // ── Partial governed state fails closed ────────────────────────────────

    const source = policySourceOf();
    const complete = {
      version: 1, role: WORKER_ROLE,
      roleRoutingPolicyHash: source.roleRoutingPolicyHash,
      economicPolicyHash: source.economicPolicyHash,
      pricingCatalogHash: source.pricingCatalogHash,
      routingDecision: {}, economicAuthority: {}, pricingEntry: {},
      economicAccountId: 1, ticketId: 1, runId: 1, allocationItemId: 1,
      capturedAt: '2026-08-01T00:00:00.000Z', governedExecutionHash: 'a'.repeat(64)
    };
    for (const omitted of ['routingDecision', 'economicAuthority', 'pricingEntry',
      'economicAccountId', 'governedExecutionHash']) {
      const partial = { ...complete };
      delete partial[omitted];
      assert.throws(
        () => classifyRunGovernance({ id: 1, ticketId: 1, governedExecution: partial }),
        error => {
          assert.equal(error.detail.reason, 'governed_run_authority_partial',
            `a missing ${omitted} is partial state`);
          return true;
        },
        `a governed envelope missing ${omitted} fails closed`);
    }
    assert.throws(
      () => classifyRunGovernance({
        id: 1, ticketId: 1, governedExecution: { ...complete, surprise: 1 } }),
      error => error.detail.reason === 'governed_run_authority_malformed',
      'an unknown field fails closed');

    console.log('  ok run-body envelope and fail-closed classification');

    // ── Atomic sibling authority capture ───────────────────────────────────

    const admitted = await admitLeafSet('Governed leaf admission');
    const runs = (await store.listRunsForTicket({ ticketId: admitted.ticket.id })).runs;
    assert.equal(runs.length, admitted.plan.items.length,
      'one Run per allocation item');
    assert.ok(runs.length >= 2, 'the fixture admits sibling Runs');

    const authorities = runs.map(run => normalizeGovernedRunAuthority(run.governedExecution, {
      expectedRunId: run.id, expectedTicketId: admitted.ticket.id
    }));
    assert.equal(new Set(authorities.map(a => a.routingDecision.decisionHash)).size, runs.length,
      'one distinct routing decision per Run');
    assert.equal(new Set(authorities.map(a => a.economicAuthority.authorityHash)).size, runs.length,
      'one distinct economic authority per Run');
    for (const [index, authority] of authorities.entries()) {
      assert.equal(authority.role, WORKER_ROLE);
      assert.equal(authority.runId, runs[index].id, 'the envelope binds its own Run');
      assert.equal(authority.economicAuthority.dispatchTarget, SNAPSHOT,
        'the captured target is the exact admitted snapshot');
      assert.equal(authority.routingDecision.subjectKind, 'run',
        'a worker authority is captured against a run subject, never a planning attempt');
      assert.equal(authority.allocationItemId, runs[index].allocationItemId);
    }

    // Exactly one shared worker account, and no planner account.
    const accounts = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1`,
      [admitted.ticket.id]);
    assert.equal(accounts.rowCount, 1, 'exactly one economic account for the ticket');
    assert.equal(accounts.rows[0].role, WORKER_ROLE, 'it is the worker-role account');
    const accountId = Number(accounts.rows[0].id);
    for (const authority of authorities) {
      assert.equal(authority.economicAccountId, accountId,
        'every sibling Run names the one shared account');
    }
    assert.equal(
      (await store.pool.query(
        `SELECT 1 FROM ${store.table('ticket_economic_accounts')}
         WHERE ticket_id = $1 AND role = $2`, [admitted.ticket.id, PLANNER_ROLE])).rowCount,
      0, 'leaf admission admits no planner account');

    // ZERO reservations at admission: admission establishes what may be spent,
    // not a claim on it.
    assert.equal(
      (await store.pool.query(
        `SELECT 1 FROM ${store.table('economic_request_reservations')} WHERE ticket_id = $1`,
        [admitted.ticket.id])).rowCount,
      0, 'leaf admission creates zero provider-request reservations');
    assert.equal(Number(accounts.rows[0].reserved_micro_usd), 0);
    assert.equal(Number(accounts.rows[0].settled_micro_usd), 0);

    // All siblings visible together.
    assert.equal(runs.every(run => run.status === 'pending'), true,
      'every sibling Run is scheduler-visible together');

    // ── One invalid sibling rolls back the whole leaf set ──────────────────

    const mutableRoute = policySourceOf({ model: 'gpt-4o-mini' });
    await assert.rejects(
      () => admitLeafSet('Mutable worker route', { source: mutableRoute }),
      () => true,
      'a mutable worker target refuses the whole admission');
    const rolledBack = await store.pool.query(
      `SELECT t.id FROM ${store.table('tickets')} t
        WHERE t.body->>'objective' LIKE $1`, [`Mutable worker route ${STAMP}%`]);
    if (rolledBack.rowCount === 1) {
      const rolledTicket = Number(rolledBack.rows[0].id);
      assert.equal(
        (await store.listRunsForTicket({ ticketId: rolledTicket })).runs.length, 0,
        'a refused capture leaves zero Runs');
      assert.equal(
        (await store.pool.query(
          `SELECT 1 FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1`,
          [rolledTicket])).rowCount,
        0, 'a refused capture leaves no account behind');
    }

    // ── Drift after admission cannot rewrite captured authority ────────────

    const priorEnv = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-env-override';
    const afterDrift = await store.getRun(runs[0].id);
    const driftAuthority = normalizeGovernedRunAuthority(afterDrift.governedExecution, {
      expectedRunId: runs[0].id });
    assert.equal(driftAuthority.governedExecutionHash,
      authorities[0].governedExecutionHash,
      'environment drift cannot rewrite captured Run authority');
    if (priorEnv === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = priorEnv;
    assert.notEqual(workerA.model, SNAPSHOT,
      'the agent row model differs from the captured target');

    // ── Durable ordinals from the reservation ledger ───────────────────────

    const runId = runs[0].id;
    const first = await store.prepareAndReserveNextGovernedRunRequest({
      runId, logicalSourceIdentity: 'model-request:agent:first:provider',
      canonicalBody: workerBody('first'), endpointIdentity: ENDPOINT
    });
    assert.equal(first.ordinal, 1, 'the first request receives ordinal 1');
    assert.equal(first.reservation.modelRequestOrdinal, 1,
      'the returned ordinal is the one persisted');
    assert.equal(first.reservation.state, 'reserved');
    assert.equal(first.reservation.runId, runId);

    const second = await store.prepareAndReserveNextGovernedRunRequest({
      runId, logicalSourceIdentity: 'model-request:agent:second:provider',
      canonicalBody: workerBody('second'), endpointIdentity: ENDPOINT
    });
    assert.equal(second.ordinal, 2, 'the second request receives ordinal 2');
    assert.notEqual(second.reservation.id, first.reservation.id,
      'each ordinal has its own reservation');

    // A fresh store instance derives the same next ordinal from durable facts.
    const { PostgresRuntimeStore } = require('../persistence/postgres/store');
    const restarted = new PostgresRuntimeStore({
      connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
    try {
      const third = await restarted.prepareAndReserveNextGovernedRunRequest({
        runId, logicalSourceIdentity: 'model-request:agent:third:provider',
      canonicalBody: workerBody('third'), endpointIdentity: ENDPOINT
      });
      assert.equal(third.ordinal, 3,
        'a restarted process derives the next ordinal with no process memory');
    } finally {
      await restarted.close();
    }

    // The economic maximum request count refuses the next ordinal.
    await code(
      store.prepareAndReserveNextGovernedRunRequest({
        runId, logicalSourceIdentity: 'model-request:agent:fourth:provider',
      canonicalBody: workerBody('fourth'), endpointIdentity: ENDPOINT
      }),
      'GOVERNED_RUN_REQUEST_COUNT_EXCEEDED',
      'the economic authority request ceiling refuses the next ordinal');

    // The existing runtime model-request budget refuses independently.
    const siblingRunId = runs[1].id;
    await code(
      store.prepareAndReserveNextGovernedRunRequest({
        runId: siblingRunId, logicalSourceIdentity: 'model-request:agent:budget:provider',
        canonicalBody: workerBody('budget'),
        endpointIdentity: ENDPOINT, runtimeModelRequestMaximum: 4,
        // Claims five prior requests while the durable ledger holds none.
        runtimeModelRequestsUsed: 5
      }),
      'GOVERNED_RUN_BUDGET_DISAGREEMENT',
      'a runtime/economic ledger disagreement is an integrity refusal');

    const sibling = await store.prepareAndReserveNextGovernedRunRequest({
      runId: siblingRunId, logicalSourceIdentity: 'model-request:agent:sibling:provider',
      canonicalBody: workerBody('sibling'),
      endpointIdentity: ENDPOINT, runtimeModelRequestMaximum: 4,
      runtimeModelRequestsUsed: 0
    });
    assert.equal(sibling.ordinal, 1,
      'ordinals are per-Run, so a sibling starts at 1');

    // ── The exact request ──────────────────────────────────────────────────

    const bytes = first.reservation.serializedRequest;
    const body = JSON.parse(bytes);
    assert.equal(body.model, SNAPSHOT, 'the captured model is in the persisted bytes');
    assert.notEqual(body.model, workerA.model, 'the current agent row model is not');
    assert.equal(body.max_output_tokens, CAP, 'the authorized output cap is present');
    assert.equal(body.truncation, 'disabled', 'truncation is disabled');
    assert.equal(
      crypto.createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex'),
      first.reservation.exactRequestHash,
      'the persisted bytes hash to the reserved request hash');
    assert.equal(first.reservation.preparedRequestHash,
      first.preparedRequest.preparedRequestHash);

    // ── Duplicate logical request cannot become a second ordinal ──────────
    //
    // THE INVARIANT THIS PROVES. Account locking serializes two concurrent
    // callers, but serialization alone would hand the second the NEXT ordinal —
    // turning duplicate execution of one logical request into two charged
    // requests. The canonical source identity is what makes the second an
    // idempotent re-report instead.

    const raceRunId = runs[1].id;
    const sameLogicalRequest = 'model-request:agent:7:provider';
    const raced = await Promise.allSettled([
      store.prepareAndReserveNextGovernedRunRequest({
        runId: raceRunId, logicalSourceIdentity: sameLogicalRequest,
        canonicalBody: workerBody('race'), endpointIdentity: ENDPOINT }),
      store.prepareAndReserveNextGovernedRunRequest({
        runId: raceRunId, logicalSourceIdentity: sameLogicalRequest,
        canonicalBody: workerBody('race'), endpointIdentity: ENDPOINT })
    ]);
    for (const lost of raced.filter(r => r.status === 'rejected')) {
      assert.equal(lost.reason.code, 'ECONOMIC_LOGICAL_REQUEST_DUPLICATE',
        `a losing duplicate must be a closed concurrency refusal: ${lost.reason.message}`);
    }
    const racedWon = raced.filter(r => r.status === 'fulfilled');
    assert.ok(racedWon.length >= 1, 'at least one caller reserves the logical request');
    const racedOrdinals = new Set(racedWon.map(r => r.value.ordinal));
    assert.equal(racedOrdinals.size, 1,
      'duplicate execution of one logical request yields exactly one ordinal');
    const racedReservations = new Set(racedWon.map(r => r.value.reservation.id));
    assert.equal(racedReservations.size, 1,
      'duplicate execution of one logical request yields exactly one reservation');
    if (racedWon.length === 2) {
      assert.equal(racedWon.filter(r => r.value.alreadyReserved === true).length, 1,
        'exactly one caller is told the reservation already existed');
    }

    const raceRows = await store.pool.query(
      `SELECT model_request_ordinal, logical_source_identity
         FROM ${store.table('economic_request_reservations')}
        WHERE run_id = $1 AND logical_source_identity = $2`,
      [raceRunId, sameLogicalRequest]);
    assert.equal(raceRows.rowCount, 1,
      'the durable ledger holds exactly one reservation for the logical request');

    // Sequential re-invocation of the SAME logical request is also idempotent.
    const repeated = await store.prepareAndReserveNextGovernedRunRequest({
      runId: raceRunId, logicalSourceIdentity: sameLogicalRequest,
      canonicalBody: workerBody('race'), endpointIdentity: ENDPOINT });
    assert.equal(repeated.alreadyReserved, true,
      'repeating a logical request re-reports rather than reserving again');
    assert.equal(repeated.reservation.id, [...racedReservations][0]);

    // A DIFFERENT logical request legitimately receives the next ordinal.
    const laterOrdinal = repeated.ordinal + 1;
    const later = await store.prepareAndReserveNextGovernedRunRequest({
      runId: raceRunId, logicalSourceIdentity: 'model-request:agent:8:provider',
      canonicalBody: workerBody('later'), endpointIdentity: ENDPOINT });
    assert.equal(later.alreadyReserved, false,
      'a distinct logical request is a new reservation');
    assert.equal(later.ordinal, laterOrdinal,
      'a legitimate later request receives the next durable ordinal');
    assert.notEqual(later.reservation.id, repeated.reservation.id);

    // ── Shared-account concurrency ─────────────────────────────────────────

    const account = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')} WHERE id = $1`, [accountId]);
    const reserved = Number(account.rows[0].reserved_micro_usd);
    const settled = Number(account.rows[0].settled_micro_usd);
    const authorized = Number(account.rows[0].authorized_micro_usd);
    assert.ok(reserved >= 0 && settled >= 0, 'no negative balance');
    assert.ok(reserved + settled <= authorized,
      'sibling Runs sharing one account never overspend it');
    assert.ok(reserved > 0, 'sibling reservations really charged the shared account');

    // Exact-boundary shared account: two sibling Runs, room for exactly one more
    // request. The overflow must be a GOVERNED refusal read from the locked
    // balance, not a constraint violation discovered after the work was done.
    const boundaryPerRequest =
      authorities[0].economicAuthority.maximumPerRequestMicroUsd;
    const boundary = await admitLeafSet('Exact boundary account', {
      source: policySourceOf({
        authorizedMicroUsd: boundaryPerRequest, maximumProviderRequests: 1 })
    });
    const boundaryRuns = (await store.listRunsForTicket({
      ticketId: boundary.ticket.id })).runs;
    assert.ok(boundaryRuns.length >= 2, 'the boundary fixture has sibling Runs');
    const boundaryRaced = await Promise.allSettled(boundaryRuns.map(run =>
      store.prepareAndReserveNextGovernedRunRequest({
        runId: run.id, logicalSourceIdentity: 'model-request:agent:boundary:provider',
      canonicalBody: workerBody('boundary'), endpointIdentity: ENDPOINT
      })));
    const boundaryWon = boundaryRaced.filter(r => r.status === 'fulfilled');
    assert.equal(boundaryWon.length, 1,
      'the shared account admits exactly what fits, no matter how many siblings ask');
    for (const refused of boundaryRaced.filter(r => r.status === 'rejected')) {
      assert.equal(refused.reason.code, 'ECONOMIC_AUTHORITY_EXCEEDED',
        'an over-authority sibling is a governed refusal from the locked balance, ' +
        'not a constraint violation');
    }
    const boundaryAccount = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')}
        WHERE ticket_id = $1 AND role = $2`, [boundary.ticket.id, WORKER_ROLE]);
    assert.equal(Number(boundaryAccount.rows[0].reserved_micro_usd), boundaryPerRequest,
      'the account is exactly fully reserved');
    assert.ok(
      Number(boundaryAccount.rows[0].reserved_micro_usd) +
      Number(boundaryAccount.rows[0].settled_micro_usd) <=
      Number(boundaryAccount.rows[0].authorized_micro_usd),
      'reserved plus settled never exceeds authorized');

    // Another Ticket's account cannot be used.
    const otherTicket = await admitLeafSet('Other ticket account');
    const otherAccounts = await store.pool.query(
      `SELECT id FROM ${store.table('ticket_economic_accounts')} WHERE ticket_id = $1`,
      [otherTicket.ticket.id]);
    assert.notEqual(Number(otherAccounts.rows[0].id), accountId,
      'each Ticket has its own worker account');
  });
  finished = true;
  console.log('governed leaf authority PostgreSQL test passed');
}

// A promise that never settles would let Node exit 0 and report an unfinished
// suite as a passing one.
let finished = false;
process.on('exit', exitCode => {
  if (exitCode === 0 && !finished) {
    console.error('governed leaf authority test did not run to completion');
    process.exitCode = 1;
  }
});

main().catch(error => {
  console.error(error);
  process.exit(1);
});
