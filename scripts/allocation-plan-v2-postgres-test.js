#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  canonicalJson,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('../runtime/declared-work-contract');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { withHarness } = require('./postgres-test-harness');

const STAMP = `${Date.now()}-${process.pid}`;

function executionPolicy(workspaceScope = 'shared') {
  return {
    mode: 'assisted',
    requireVerification: 'when_declared',
    autoRetry: false,
    maxAttempts: null,
    maxRuntimeMs: null,
    maxModelRequests: null,
    maxWorkspaceOperations: null,
    allowWorkspaceWrites: true,
    allowParallelRuns: false,
    allowChildTickets: false,
    workspaceScope
  };
}

function typedCriterion(postcondition) {
  const declaration = canonicalJson(postcondition);
  return {
    kind: 'typed-postcondition',
    criterionType: postcondition.type,
    declaration,
    criterionHash: hashCanonical(postcondition),
    provenance: 'workflow-defined'
  };
}

function evidenceFor(criterion) {
  return {
    kind: 'postcondition-evidence',
    criterionHash: criterion.criterionHash,
    evidenceType: 'deterministic-postcondition-result',
    provenance: criterion.provenance
  };
}

function parentDeclaredWork() {
  const criterion = typedCriterion({
    id: 'allocated-result',
    type: 'fileExists',
    path: 'alpha/result.txt'
  });
  const withoutHash = {
    version: 1,
    objective: {
      text: `Persist structured allocation authority ${STAMP}`,
      provenance: 'ticket-authored'
    },
    expectedOutputs: [{
      kind: 'workflow-artifact',
      declaration: 'alpha/result.txt',
      provenance: 'workflow-defined'
    }],
    successCriteria: [
      {
        kind: 'text',
        declaration: 'The allocated result must be ready for review.',
        provenance: 'ticket-authored'
      },
      criterion
    ].sort((left, right) =>
      canonicalJson(left) < canonicalJson(right) ? -1 : canonicalJson(left) > canonicalJson(right) ? 1 : 0),
    evidenceRequirements: [evidenceFor(criterion)]
  };
  return normalizeDeclaredWorkSnapshot({
    ...withoutHash,
    contractHash: hashCanonical(withoutHash)
  });
}

// T2 Tranche 5: Ticket-level `failed` is retired; fixtures hold 'open'.
function currentTicket(agent, objective, status = 'open') {
  const now = new Date().toISOString();
  return {
    objective,
    acceptanceCriteria: 'The structured allocation remains inspectable.',
    assignmentTargetType: 'agent',
    assignmentTargetId: agent.id,
    assignmentMode: 'individual',
    ownedOutputPaths: null,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: executionPolicy(),
    workTypeId: null,
    workTypeSnapshot: null,
    workContextId: null,
    workContextSnapshot: null,
    status,
    createdBy: 'allocation-plan-v2-test',
    changedBy: 'allocation-plan-v2-test',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function replaySnapshot(run, agent, workspaceRoot, objective) {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    assignedAgentId: agent.id,
    agentNameSnapshot: agent.name,
    provider: 'ollama',
    model: 'allocation-plan-v2-test',
    runtimeEnvelope: {
      maxExecutionSteps: 1,
      allowedOperations: ['listDirectory', 'readFile']
    },
    ticketObjectiveSnapshot: objective,
    systemInstructionSnapshot: 'Allocation projection fixture.',
    primitiveContract: {},
    workspaceRoot,
    mainWorkspaceRoot: workspaceRoot,
    executionWorkspaceType: 'main_owned_paths',
    runtimeLimits: {
      maxExecutionSteps: 1,
      maxModelRequestsPerRun: 1,
      maxWorkspaceOperationsPerRun: 1
    },
    allocationPlanId: run.allocationPlanId,
    allocationItemId: run.allocationItemId,
    allocationItem: {
      allocationItemId: run.allocationItemId,
      assignedAgentId: run.agentId,
      allocationSubtask: null,
      ownedOutputPaths: run.ownedOutputPaths
    },
    allocationSubtask: null,
    ownedOutputPaths: run.ownedOutputPaths,
    providerRequests: [],
    modelResponses: [],
    parsedModelPlans: [],
    workspaceOperations: [],
    events: [],
    terminalStatus: 'failed',
    failureReason: 'Projection fixture only.',
    mutationCount: 0,
    mutationOutcome: 'no_mutations',
    createdAt: now,
    finalizedAt: now
  };
}

async function main() {
  await withHarness('allocation plan v2 PostgreSQL', async ({
    store,
    schema,
    databaseUrl,
    workspaceRoot,
    startServer
  }) => {
    const agent = (await store.createConfiguredAgent({
      value: {
        name: `Allocation Plan V2 ${STAMP}`,
        provider: 'ollama',
        model: 'allocation-plan-v2-test',
        apiKey: ''
      },
      groupIds: [],
      changedBy: 'allocation-plan-v2-test'
    })).agent;
    const peerAgent = (await store.createConfiguredAgent({
      value: {
        name: `Allocation Plan V2 Peer ${STAMP}`,
        provider: 'ollama',
        model: 'allocation-plan-v2-test',
        apiKey: ''
      },
      groupIds: [],
      changedBy: 'allocation-plan-v2-test'
    })).agent;

    const v1Ticket = await store.createTicket({
      status: 'open',
      title: `Historical allocation v1 ${STAMP}`,
      objective: `Historical allocation v1 ${STAMP}`
    });
    const v1 = await store.createAllocationPlan({
      plan: {
        ticketId: v1Ticket.id,
        ticketOpenedAt: '2026-07-01T00:00:00.000Z',
        mode: 'owned_paths',
        status: 'pending',
        items: [{
          assignedAgentId: agent.id,
          allocationSubtask: 'Historical v1 subtask.',
          ownedOutputPaths: ['historical/']
        }]
      }
    });
    const rawV1Before = (await store.pool.query(
      `SELECT body FROM ${store.table('allocation_plans')} WHERE id = $1`,
      [v1.id]
    )).rows[0].body;
    assert.equal(Object.prototype.hasOwnProperty.call(v1, 'version'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(v1, 'planHash'), false);
    assert.equal(v1.items[0].allocationSubtask, 'Historical v1 subtask.');

    await store.transitionTicket({
      ticketId: v1Ticket.id,
      expectedRevision: v1Ticket.revision,
      fromStatuses: ['open'],
      toStatus: 'blocked',
      patch: {
        objective: `Changed live ticket state ${STAMP}`,
        blockedReason: 'Historical reconstruction fixture.'
      },
      eventType: 'ticket.blocked',
      eventPayload: { source: 'allocation-plan-v2-test' }
    });
    const rereadV1 = await store.getAllocationPlan(v1.id);
    const rawV1After = (await store.pool.query(
      `SELECT body FROM ${store.table('allocation_plans')} WHERE id = $1`,
      [v1.id]
    )).rows[0].body;
    assert.deepEqual(rereadV1, v1,
      'current ticket state must not upgrade or reinterpret a stored v1 plan');
    assert.deepEqual(rawV1After, rawV1Before,
      'reading v1 and changing live ticket state must not rewrite its JSONB');

    const objective = `Structured allocation projection ${STAMP}`;
    const v2Ticket = (await store.createTicketWithEvent({
      ticket: currentTicket(agent, objective),
      eventPayload: { source: 'allocation-plan-v2-test' }
    })).ticket;
    const parent = parentDeclaredWork();
    const itemCriterion = typedCriterion({
      id: 'allocated-alpha-result',
      type: 'fileExists',
      path: 'alpha/result.txt'
    });
    const peerItemCriterion = typedCriterion({
      id: 'allocated-beta-result',
      type: 'fileExists',
      path: 'beta/result.txt'
    });
    const v2 = await store.createAllocationPlan({
      plan: {
        version: 2,
        ticketId: v2Ticket.id,
        mode: 'owned_paths',
        status: 'pending',
        parentDeclaredWorkSnapshot: parent,
        sharedConstraints: [{
          kind: 'text',
          declaration: `Keep sibling allocations isolated ${STAMP}.`,
          provenance: 'validated-model-contract'
        }],
        items: [{
          assignedAgentId: agent.id,
          ownedOutputPaths: ['alpha'],
          objective: {
            text: `Produce the Alpha structured output ${STAMP}.`,
            provenance: 'validated-model-contract'
          },
          expectedOutputs: [{
            kind: 'workflow-artifact',
            declaration: 'alpha/result.txt',
            provenance: 'workflow-defined'
          }],
          successCriteria: [
            {
              kind: 'text',
              declaration: 'The allocated result must be ready for review.',
              provenance: 'ticket-authored'
            },
            itemCriterion
          ],
          evidenceRequirements: [evidenceFor(itemCriterion)]
        }, {
          assignedAgentId: peerAgent.id,
          ownedOutputPaths: ['beta'],
          objective: {
            text: `Produce the Beta structured output ${STAMP}.`,
            provenance: 'validated-model-contract'
          },
          expectedOutputs: [{
            kind: 'workflow-artifact',
            declaration: 'beta/result.txt',
            provenance: 'workflow-defined'
          }],
          successCriteria: [
            {
              kind: 'text',
              declaration: 'The allocated result must be ready for review.',
              provenance: 'ticket-authored'
            },
            peerItemCriterion
          ],
          evidenceRequirements: [evidenceFor(peerItemCriterion)]
        }]
      }
    });
    assert.equal(v2.version, 2);
    assert.equal(Object.isFrozen(v2), true);
    assert.equal(Object.isFrozen(v2.items[0]), true);
    assert.equal(v2.parentDeclaredWorkSnapshot.contractHash, parent.contractHash);
    assert.match(v2.planHash, /^[0-9a-f]{64}$/);
    assert.equal(v2.items[0].status, 'pending');

    const rawV2 = (await store.pool.query(
      `SELECT body FROM ${store.table('allocation_plans')} WHERE id = $1`,
      [v2.id]
    )).rows[0].body;
    assert.equal(rawV2.version, 2);
    assert.equal(rawV2.planHash, v2.planHash);
    assert.equal(Object.prototype.hasOwnProperty.call(rawV2.items[0], 'status'), false,
      'item status must not be embedded in hashed item authority');
    assert.deepEqual(rawV2.itemStatuses.map(item => item.status), ['pending', 'pending']);

    const peer = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      assert.deepEqual(await peer.migrate(), []);
      assert.deepEqual(await peer.getAllocationPlan(v1.id), v1);
      assert.deepEqual(await peer.getAllocationPlan(v2.id), v2,
        'a separate store instance reconstructs v2 deterministically');
      assert.deepEqual(
        (await peer.listAllocationPlans({ ticketId: v2Ticket.id, limit: 10 })).plans,
        [v2]
      );
    } finally {
      await peer.close();
    }

    const immutableItemsBefore = v2.items.map(item => {
      const { status: itemStatus, createdAt: itemCreatedAt, ...authority } = item;
      void itemStatus;
      void itemCreatedAt;
      return authority;
    });
    const statusUpdates = await Promise.all(v2.items.map(item =>
      store.updateAllocationItemStatus({
        planId: v2.id,
        allocationItemId: item.allocationItemId,
        status: 'completed'
      })));
    assert(statusUpdates.every(result => result.item.status === 'completed'));
    const updatedPlan = await store.getAllocationPlan(v2.id);
    assert.equal(updatedPlan.status, 'completed');
    assert.equal(updatedPlan.planHash, v2.planHash,
      'mutable execution status must not alter plan authority');
    assert.equal(updatedPlan.revision, v2.revision + 2,
      'concurrent item status updates serialize and preserve every revision');
    assert.deepEqual(updatedPlan.items.map(item => item.status), ['completed', 'completed']);
    assert.deepEqual(updatedPlan.items.map(item => {
      const { status: itemStatus, createdAt: itemCreatedAt, ...authority } = item;
      void itemStatus;
      void itemCreatedAt;
      return authority;
    }), immutableItemsBefore,
    'updating one item status cannot rewrite either item authority');
    const rawUpdatedV2 = (await store.pool.query(
      `SELECT body FROM ${store.table('allocation_plans')} WHERE id = $1`,
      [v2.id]
    )).rows[0].body;
    assert.equal(rawUpdatedV2.planHash, v2.planHash);
    assert.deepEqual(rawUpdatedV2.itemStatuses.map(item => item.status),
      ['completed', 'completed']);
    assert(rawUpdatedV2.items.every(item =>
      !Object.prototype.hasOwnProperty.call(item, 'status')));

    const restartStore = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      assert.deepEqual(await restartStore.migrate(), []);
      assert.deepEqual(await restartStore.getAllocationPlan(v1.id), v1);
      assert.deepEqual(await restartStore.getAllocationPlan(v2.id), updatedPlan,
        'restart reconstruction preserves exact v1 and v2 meanings');
    } finally {
      await restartStore.close();
    }

    const tamperClient = await store.pool.connect();
    try {
      await tamperClient.query('BEGIN');
      await tamperClient.query(
        `UPDATE ${store.table('allocation_plans')}
         SET body = jsonb_set(body, '{items,0,objective,text}', to_jsonb($2::text)),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [v2.id, 'Tampered after plan hash generation']
      );
      await assert.rejects(
        tamperClient.query(
          `SELECT * FROM ${store.table('allocation_plans')} WHERE id = $1`,
          [v2.id]
        ).then(result => {
          const row = result.rows[0];
          return require('../runtime/allocation-plan-contract').normalizeStoredAllocationPlanV2({
            id: Number(row.id),
            ticketId: Number(row.ticket_id),
            status: row.status,
            revision: Number(row.revision),
            createdAt: new Date(row.created_at).toISOString(),
            updatedAt: new Date(row.updated_at).toISOString(),
            body: row.body
          });
        }),
        error => error.code === 'ALLOCATION_PLAN_V2_HASH_MISMATCH'
      );
    } finally {
      await tamperClient.query('ROLLBACK');
      tamperClient.release();
    }

    const createdRun = await store.createRun({
      ticketId: v2Ticket.id,
      agentId: agent.id,
      agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: executionPolicy('owned_paths'),
      allocationPlanId: v2.id,
      allocationItemId: v2.items[0].allocationItemId,
      allocationSubtask: null,
      ownedOutputPaths: ['alpha/'],
      executionWorkspaceType: 'main_owned_paths',
      status: 'pending'
    });
    const failedRun = (await store.transitionRun({
      runId: createdRun.id,
      expectedRevision: createdRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.execution_failed',
      eventPayload: { source: 'allocation-plan-v2-test' }
    })).run;
    await store.initializeRunReplay({
      runId: failedRun.id,
      ticketId: v2Ticket.id,
      snapshot: replaySnapshot(failedRun, agent, workspaceRoot, objective)
    });

    const server = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    } });
    const cookie = await server.login();
    const exportResponse = await server.request(
      'GET',
      '/api/export?domain=plans&limit=100',
      { cookie }
    );
    assert.equal(exportResponse.statusCode, 200);
    const exported = JSON.parse(exportResponse.body).items.find(plan => plan.id === v2.id);
    assert(exported);
    assert.equal(exported.version, 2);
    assert.equal(exported.planHash, v2.planHash);
    assert.equal(exported.parentDeclaredWorkSnapshot.contractHash, parent.contractHash);
    assert.equal(exported.items[0].objective.text,
      `Produce the Alpha structured output ${STAMP}.`);
    assert.equal(exported.items[0].evidenceRequirements[0].criterionHash,
      itemCriterion.criterionHash);

    const ticketPage = await server.request('GET', `/tickets/${v2Ticket.id}`, { cookie });
    assert.equal(ticketPage.statusCode, 200, ticketPage.body.slice(0, 1000));
    for (const expected of [
      'Plan version',
      v2.planHash,
      parent.contractHash,
      `Produce the Alpha structured output ${STAMP}.`,
      'alpha/result.txt',
      itemCriterion.criterionHash,
      `Keep sibling allocations isolated ${STAMP}.`
    ]) {
      assert(ticketPage.body.includes(expected), `Ticket Detail must show ${expected}`);
    }

    const runPage = await server.request('GET', `/runs/${failedRun.id}`, { cookie });
    assert.equal(runPage.statusCode, 200, runPage.body.slice(0, 1000));
    for (const expected of [
      'Allocation plan version',
      v2.planHash,
      parent.contractHash,
      `Produce the Alpha structured output ${STAMP}.`,
      'alpha/result.txt',
      itemCriterion.criterionHash,
      `Keep sibling allocations isolated ${STAMP}.`
    ]) {
      assert(runPage.body.includes(expected), `Run Detail must show ${expected}`);
    }

    const cookieFile = path.join(
      os.tmpdir(),
      `allocation-plan-v2-cookie-${process.pid}-${Date.now()}`
    );
    const cliEnv = {
      ...process.env,
      OPERC_URL: server.baseUrl,
      OPERC_COOKIE_PATH: cookieFile,
      OPERC_USERNAME: 'admin',
      OPERC_PASSWORD: 'admin123'
    };
    try {
      execFileSync(process.execPath, [path.join(__dirname, 'oquery.js'), 'login'], {
        cwd: path.join(__dirname, '..'),
        env: cliEnv,
        encoding: 'utf8'
      });
      const cli = execFileSync(
        process.execPath,
        [path.join(__dirname, 'oquery.js'), 'replay', String(failedRun.id)],
        {
          cwd: path.join(__dirname, '..'),
          env: cliEnv,
          encoding: 'utf8'
        }
      );
      const cliText = cli.replace(/\u001b\[[0-9;]*m/g, '');
      for (const expected of [
        'Allocation context',
        'version 2',
        v2.planHash,
        parent.contractHash,
        `Produce the Alpha structured output ${STAMP}.`,
        'alpha/result.txt',
        itemCriterion.criterionHash,
        `Keep sibling allocations isolated ${STAMP}.`
      ]) {
        assert(cliText.includes(expected), `oquery replay must show ${expected}`);
      }
    } finally {
      try { fs.unlinkSync(cookieFile); } catch (_) {}
    }

    const historicalDraft = {
      ticketId: v1Ticket.id,
      ticketOpenedAt: '2026-07-01T00:00:00.000Z',
      mode: 'owned_paths',
      status: 'pending',
      items: [{
        assignedAgentId: agent.id,
        allocationSubtask: 'Version discriminator fixture.',
        ownedOutputPaths: ['historical/']
      }]
    };
    await assert.rejects(
      store.createAllocationPlan({
        plan: { ...historicalDraft, version: 1 }
      }),
      /Unsupported allocation plan version: 1/,
      'present non-v2 versions must not enter historical creation'
    );

    const malformedVersionPlan = await store.createAllocationPlan({
      plan: historicalDraft
    });
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{version}', to_jsonb($2::int)),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [malformedVersionPlan.id, 1]
    );
    await assert.rejects(
      store.getAllocationPlan(malformedVersionPlan.id),
      /Unsupported allocation plan version: 1/,
      'a present malformed version must not reconstruct as historical v1'
    );

    const partiallyVersionedPlan = await store.createAllocationPlan({
      plan: {
        ...historicalDraft,
        items: [{
          ...historicalDraft.items[0],
          assignedAgentId: peerAgent.id,
          ownedOutputPaths: ['partial/']
        }]
      }
    });
    await store.pool.query(
      `UPDATE ${store.table('allocation_plans')}
       SET body = jsonb_set(body, '{version}', to_jsonb($2::int)),
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [partiallyVersionedPlan.id, 2]
    );
    await assert.rejects(
      store.getAllocationPlan(partiallyVersionedPlan.id),
      error => error.code === 'ALLOCATION_PLAN_V2_INVALID' &&
        /(unknown field|missing field)/.test(error.message),
      'a partial v2 body must fail closed rather than fall back to v1'
    );
  });

  console.log('PASS: Allocation Plan v1/v2 PostgreSQL persistence, restart, API, page, and CLI projections are deterministic');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
