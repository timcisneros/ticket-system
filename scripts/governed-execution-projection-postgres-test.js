#!/usr/bin/env node
'use strict';

// Tranche 4 projection suite.
//
// Every assertion compares projected output against the DURABLE SQL ROW it
// claims to describe. A projection that agrees with itself but not with the
// database is exactly the failure this suite exists to catch.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');
const {
  governedAttemptState,
  plannerPolicySource,
  progressControlPolicy,
  seedGovernedBaselineEvidence
} = require('./governed-structured-fixture');
const LEAF_PROGRESS_POLICY = progressControlPolicy();

// Tranche 4 cutover: a planning attempt becomes request-capable only with
// complete governed authority.
const PLANNER_POLICY = plannerPolicySource();
const { readGovernedPolicySource } = require('../runtime/governed-policy-source');
const {
  NEVER_PROJECTED,
  RESERVATION_LIFECYCLE,
  projectRunGovernedExecution,
  projectTicketGovernedEconomics
} = require('../runtime/governed-execution-projection');
const {
  runGovernedLeafRequest
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

const ACTOR = 'governed-execution-projection-postgres-test';
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
      // Persistent row identity, as the production loader supplies it. A
      // container without it cannot bind a parent policy revision, and that
      // binding is refused rather than faked.
      id: 1,
      revision: 1,
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
          objective: `Create folder ${item.ownedOutputPaths[0].replace(/\/$/, '')}`,
          kind: 'deterministic', recognized: true,
          intent: 'create_folder', completionPolicy: 'declared_postconditions',
          directPostconditions: [{
            type: 'folder_exists',
            path: item.ownedOutputPaths[0].replace(/\/$/, '')
          }],
          verificationPolicy: 'when_declared',
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
          ? { policySource: source, progressControlPolicy: LEAF_PROGRESS_POLICY }
          : null,
        eventPayload: { source: ACTOR }
      });
      // Baselines, as the real execution loop writes before a Run's first
      // governed request; this suite drives the reservation gate directly.
      for (const admittedRun of admitted.runs) {
        await seedGovernedBaselineEvidence(store, admittedRun.id);
      }
      return { ticket: refreshed, plan, admission: admitted, source };
    };


    const recordingTransport = (response = {
      text: '{"ok":true}', identity: 'resp_proj_1',
      usage: { input_tokens: 1_000, output_tokens: 500 }
    }) => {
      const calls = [];
      const transport = async args => { calls.push(args); return response; };
      transport.calls = calls;
      return transport;
    };
    const withKey = async () => ({ apiKey: 'super-secret-fixture-key-ABC123' });

    // ── A Ticket with real governed activity ───────────────────────────────

    const admitted = await admitLeafSet('Projection ticket');
    const runs = (await store.listRunsForTicket({ ticketId: admitted.ticket.id })).runs;
    const runOne = await store.getRun(runs[0].id);
    const runTwo = await store.getRun(runs[1].id);

    const transport = recordingTransport();
    const settledRequest = await runGovernedLeafRequest({
      repository: store, run: runOne,
      logicalSourceIdentity: 'model-request:agent:1:provider',
      canonicalBody: workerBody('projection'), endpointIdentity: ENDPOINT,
      transport, resolveCredentials: withKey,
      timeoutMs: 60_000, maxResponseBytes: 65_536, runtimeModelRequestMaximum: 8
    });
    assert.equal(settledRequest.status, 'received');

    // A second Run leaves a request in `request_started`, so the "unresolved"
    // projection has something real to report.
    const startedReservation = await store.prepareAndReserveNextGovernedRunRequest({
      runId: runTwo.id, logicalSourceIdentity: 'model-request:agent:1:provider',
      canonicalBody: workerBody('started'), endpointIdentity: ENDPOINT
    });
    await store.markEconomicRequestStarted({ reservationId: startedReservation.reservation.id });

    // ── Ticket projection agrees with durable rows ─────────────────────────

    const rows = await store.readTicketGovernedEconomics(admitted.ticket.id);
    const ticketProjection = projectTicketGovernedEconomics(rows);
    assert.ok(ticketProjection, 'a governed ticket projects');

    const sqlAccounts = await store.pool.query(
      `SELECT * FROM ${store.table('ticket_economic_accounts')}
        WHERE ticket_id = $1 ORDER BY role`, [admitted.ticket.id]);
    assert.equal(ticketProjection.accounts.length, sqlAccounts.rowCount,
      'one projected account per durable row');
    for (const projected of ticketProjection.accounts) {
      const row = sqlAccounts.rows.find(r => r.role === projected.role);
      assert.ok(row, `a durable row exists for ${projected.role}`);
      assert.equal(projected.accountId, Number(row.id));
      assert.equal(projected.authorizedMicroUsd, Number(row.authorized_micro_usd));
      assert.equal(projected.reservedMicroUsd, Number(row.reserved_micro_usd));
      assert.equal(projected.settledMicroUsd, Number(row.settled_micro_usd));
      // Remaining is the row's own arithmetic, never a running total.
      assert.equal(projected.remainingMicroUsd,
        Number(row.authorized_micro_usd) - Number(row.reserved_micro_usd) -
        Number(row.settled_micro_usd),
        'remaining is derived from the durable row');
      assert.equal(projected.revision, Number(row.revision));
      assert.equal(projected.economicPolicyHash, row.economic_policy_hash);
    }

    // Planner and worker stay visibly distinct — the whole point of role-scoped
    // accounts. Both exist here because governed planning admitted the plan and
    // governed leaf execution ran the work.
    const roles = ticketProjection.accounts.map(a => a.role).sort();
    assert.deepEqual(roles, [PLANNER_ROLE, WORKER_ROLE].sort(),
      'planner and worker accounts appear separately');
    assert.equal(new Set(ticketProjection.accounts.map(a => a.accountId)).size, 2,
      'they are distinct accounts, never merged into one total');
    assert.ok(ticketProjection.planner, 'the planner summary is present');
    assert.ok(ticketProjection.structuredLeaf, 'the worker summary is present');

    const leaf = ticketProjection.structuredLeaf;
    assert.deepEqual([...leaf.governedRunIds].sort((a, b) => a - b),
      [runOne.id, runTwo.id].sort((a, b) => a - b),
      'both governed Runs are listed');
    assert.deepEqual(leaf.unresolvedStartedReservationIds,
      [startedReservation.reservation.id],
      'the unresolved started request is visible');
    assert.equal(leaf.reservationCountsByLifecycle.settled, 1);
    assert.equal(leaf.reservationCountsByLifecycle.request_started, 1);
    assert.equal(leaf.totalReservedMicroUsd,
      Number(sqlAccounts.rows[0].reserved_micro_usd),
      'totals come from the account row');
    assert.equal(leaf.totalSettledMicroUsd,
      Number(sqlAccounts.rows[0].settled_micro_usd));

    // A response-persisted-but-unsettled request is separately visible.
    const awaitingReservation = await store.prepareAndReserveNextGovernedRunRequest({
      runId: runTwo.id, logicalSourceIdentity: 'model-request:agent:2:provider',
      canonicalBody: workerBody('awaiting'), endpointIdentity: ENDPOINT
    });
    await store.markEconomicRequestStarted({ reservationId: awaitingReservation.reservation.id });
    await store.markEconomicResponsePersisted({
      reservationId: awaitingReservation.reservation.id,
      responseIdentity: 'resp_awaiting',
      responseHash: crypto.createHash('sha256').update('awaiting').digest('hex')
    });
    const awaitingProjection = projectTicketGovernedEconomics(
      await store.readTicketGovernedEconomics(admitted.ticket.id));
    assert.deepEqual(awaitingProjection.structuredLeaf.awaitingSettlementReservationIds,
      [awaitingReservation.reservation.id],
      'a durable response awaiting settlement is visible');

    // ── Run projection agrees with the envelope and the reservations ───────

    const runProjection = projectRunGovernedExecution(runOne, rows.reservations);
    const envelope = runOne.governedExecution;
    assert.equal(runProjection.role, WORKER_ROLE);
    assert.equal(runProjection.immutableDispatchTarget,
      envelope.economicAuthority.dispatchTarget, 'the captured target is projected');
    assert.equal(runProjection.routingDecisionHash,
      envelope.routingDecision.decisionHash);
    assert.equal(runProjection.economicAuthorityHash,
      envelope.economicAuthority.authorityHash);
    assert.equal(runProjection.targetEvidenceHash,
      envelope.routingDecision.targetEvidenceHash);
    assert.equal(runProjection.workerAccountId, envelope.economicAccountId);
    assert.equal(runProjection.maximumProviderRequests,
      envelope.economicAuthority.maximumProviderRequests);
    assert.equal(runProjection.authorizedOutputTokens,
      envelope.economicAuthority.maximumOutputTokensPerRequest);
    // Authorization and capture are separate facts and both are shown.
    assert.ok(runProjection.authorizedRouteReference,
      'the policy-authorized route reference is projected');
    assert.ok(runProjection.immutableDispatchTarget,
      'the immutable captured target is projected');

    assert.equal(runProjection.requests.length, 1, 'one request for this Run');
    const projectedRequest = runProjection.requests[0];
    const sqlReservation = (await store.pool.query(
      `SELECT * FROM ${store.table('economic_request_reservations')} WHERE id = $1`,
      [settledRequest.reservationId])).rows[0];
    assert.equal(projectedRequest.reservationId, Number(sqlReservation.id));
    assert.equal(projectedRequest.modelRequestOrdinal,
      Number(sqlReservation.model_request_ordinal));
    assert.equal(projectedRequest.logicalSourceIdentity,
      sqlReservation.logical_source_identity);
    assert.equal(projectedRequest.lifecycle, sqlReservation.state,
      'the projected lifecycle is the durable state, verbatim');
    assert.ok(RESERVATION_LIFECYCLE.includes(projectedRequest.lifecycle));
    assert.equal(projectedRequest.exactRequestHash, sqlReservation.exact_request_hash);
    assert.equal(projectedRequest.preparedRequestHash, sqlReservation.prepared_request_hash);
    assert.equal(projectedRequest.responseHash, sqlReservation.response_hash);
    assert.equal(projectedRequest.settlementReceiptHash,
      sqlReservation.settlement_receipt.receiptHash);
    assert.equal(projectedRequest.usageSource, sqlReservation.settlement_receipt.usageSource);
    assert.equal(projectedRequest.settledMicroUsd, Number(sqlReservation.settled_micro_usd));
    assert.equal(projectedRequest.reservedMicroUsd,
      Number(sqlReservation.reserved_max_micro_usd));
    assert.equal(projectedRequest.releasedMicroUsd, null,
      'a settled request has no released amount');

    // Hashes appear only when the underlying fact exists.
    const startedProjection = projectRunGovernedExecution(runTwo,
      (await store.readTicketGovernedEconomics(admitted.ticket.id)).reservations);
    const startedOnly = startedProjection.requests.find(
      r => r.reservationId === startedReservation.reservation.id);
    assert.equal(startedOnly.responseHash, null,
      'no response hash before a response exists');
    assert.equal(startedOnly.settlementReceiptHash, null,
      'no receipt hash before settlement');
    assert.equal(startedOnly.usageSource, null);

    // A released request reports its released amount.
    const relRun = await store.getRun(runs[0].id);
    const relReservation = await store.prepareAndReserveNextGovernedRunRequest({
      runId: relRun.id, logicalSourceIdentity: 'model-request:agent:9:provider',
      canonicalBody: workerBody('released'), endpointIdentity: ENDPOINT
    });
    await store.releaseUndispatchedEconomicReservation({
      reservationId: relReservation.reservation.id, reason: 'operator_cancelled' });
    const relProjection = projectRunGovernedExecution(relRun,
      (await store.readTicketGovernedEconomics(admitted.ticket.id)).reservations);
    const relRequest = relProjection.requests.find(
      r => r.reservationId === relReservation.reservation.id);
    assert.equal(relRequest.lifecycle, 'released');
    assert.equal(relRequest.releasedMicroUsd, relRequest.reservedMicroUsd,
      'a released request reports the reserve it handed back');

    // ── No overloaded boolean ──────────────────────────────────────────────

    for (const overloaded of ['governed', 'available', 'ok', 'ready']) {
      assert.equal(Object.prototype.hasOwnProperty.call(runProjection, overloaded), false,
        `the projection must not collapse distinct facts into "${overloaded}"`);
      assert.equal(Object.prototype.hasOwnProperty.call(ticketProjection, overloaded), false,
        `the ticket projection must not expose "${overloaded}"`);
    }

    // ── Secret containment ─────────────────────────────────────────────────

    const serialized = JSON.stringify({ ticketProjection, runProjection, relProjection });
    for (const secret of ['super-secret-fixture-key-ABC123', 'Bearer', 'apiKey',
      'authorization', 'Authorization']) {
      assert.equal(serialized.includes(secret), false,
        `projected output must never contain ${secret}`);
    }
    // The serialized request bytes stay in the database.
    assert.equal(serialized.includes('max_output_tokens'), false,
      'projected output never contains the serialized provider request');
    for (const field of NEVER_PROJECTED) {
      assert.equal(serialized.includes(`"${field}"`), false,
        `projected output must not contain a ${field} field`);
    }

    // ── Drift containment ──────────────────────────────────────────────────

    const before = JSON.stringify(projectRunGovernedExecution(runOne, rows.reservations));
    const priorEnv = process.env.OPENAI_MODEL;
    process.env.OPENAI_MODEL = 'gpt-env-override';
    await store.updateGroup({
      groupId: designated.id, expectedRevision: designated.revision,
      value: { ...designated, name: `${designated.name} drifted` }, changedBy: ACTOR
    });
    const after = JSON.stringify(projectRunGovernedExecution(
      await store.getRun(runOne.id),
      (await store.readTicketGovernedEconomics(admitted.ticket.id)).reservations
        .filter(r => r.runId === runOne.id && r.state === 'settled')));
    assert.ok(after.includes(envelope.economicAuthority.dispatchTarget),
      'the captured target survives current drift');
    assert.equal(JSON.parse(before).immutableDispatchTarget,
      JSON.parse(after).immutableDispatchTarget,
      'current policy and environment drift do not rewrite captured projections');
    if (priorEnv === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = priorEnv;

    // ── Historical compatibility ───────────────────────────────────────────

    assert.equal(projectRunGovernedExecution({ id: 1, ticketId: 1 }, []), null,
      'a historical Run projects nothing');
    assert.equal(
      projectTicketGovernedEconomics({ accounts: [], reservations: [] }), null,
      'a ticket that never used governed execution projects nothing');
    // A plain ticket that never used governed execution.
    const plainNow = new Date().toISOString();
    const plainTicket = (await store.createTicketWithEvent({
      ticket: {
        objective: `Historical projection ${STAMP}`, acceptanceCriteria: 'Do it.',
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
    const historicalRows = await store.readTicketGovernedEconomics(plainTicket.id);
    assert.deepEqual(historicalRows.accounts, [],
      'a historical ticket has no accounts synthesized for it');
    assert.equal(projectTicketGovernedEconomics(historicalRows), null);

    // Partial governed state refuses rather than projecting as historical.
    assert.throws(
      () => projectRunGovernedExecution({
        id: runOne.id, ticketId: runOne.ticketId,
        governedExecution: { version: 1, role: WORKER_ROLE }
      }, []),
      error => error.detail.reason === 'governed_run_authority_partial',
      'partial governed state fails closed');

    // ── Event behavior ─────────────────────────────────────────────────────

    const events = (await store.listTicketEvents(admitted.ticket.id, { limit: 500 })).events;
    const governedTypes = events.map(e => e.type).filter(t => t.startsWith('ticket.economic_'));
    // One admission event per ROLE account, and no more: re-admitting the same
    // policy is a no-op that appends nothing.
    assert.equal(
      governedTypes.filter(t => t === 'ticket.economic_account_admitted').length, 2,
      'exactly one admission event per role account');
    assert.ok(governedTypes.includes('ticket.economic_request_reserved'));
    assert.ok(governedTypes.includes('ticket.economic_request_started'));
    assert.ok(governedTypes.includes('ticket.economic_response_persisted'));
    assert.ok(governedTypes.includes('ticket.economic_request_settled'));
    assert.ok(governedTypes.includes('ticket.economic_reservation_released'));

    // Idempotent re-reporting creates no duplicate event.
    const settledEventsBefore = governedTypes
      .filter(t => t === 'ticket.economic_request_settled').length;
    await store.prepareAndReserveNextGovernedRunRequest({
      runId: runOne.id, logicalSourceIdentity: 'model-request:agent:1:provider',
      canonicalBody: workerBody('projection'), endpointIdentity: ENDPOINT
    });
    const settledEventsAfter = (await store.listTicketEvents(admitted.ticket.id, { limit: 500 }))
      .events.map(e => e.type).filter(t => t === 'ticket.economic_request_settled').length;
    assert.equal(settledEventsAfter, settledEventsBefore,
      'an idempotent re-report appends no duplicate event');

    // Event payloads carry identities and hashes, never credentials.
    for (const event of events.filter(e => e.type.startsWith('ticket.economic_'))) {
      const payload = JSON.stringify(event.payload);
      for (const secret of ['apiKey', 'Bearer', 'authorization',
        'super-secret-fixture-key-ABC123', 'serializedRequest']) {
        assert.equal(payload.includes(secret), false,
          `event ${event.type} must not contain ${secret}`);
      }
    }

    // Replay order reflects the durable lifecycle.
    const runEventOrder = events
      .filter(e => ['ticket.economic_request_reserved', 'ticket.economic_request_started',
        'ticket.economic_response_persisted', 'ticket.economic_request_settled']
        .includes(e.type))
      .map(e => e.type);
    const firstReserved = runEventOrder.indexOf('ticket.economic_request_reserved');
    const firstStarted = runEventOrder.indexOf('ticket.economic_request_started');
    const firstSettled = runEventOrder.indexOf('ticket.economic_request_settled');
    assert.ok(firstReserved < firstStarted,
      'reservation is journalled before its start');
    assert.ok(firstStarted < firstSettled,
      'a start is journalled before its settlement');

    console.log('  ok governed execution projection');
  });
  finished = true;
  console.log('governed execution projection PostgreSQL test passed');
}

let finished = false;
process.on('exit', exitCode => {
  if (exitCode === 0 && !finished) {
    console.error('governed execution projection test did not run to completion');
    process.exitCode = 1;
  }
});

main().catch(error => {
  console.error(error);
  process.exit(1);
});
