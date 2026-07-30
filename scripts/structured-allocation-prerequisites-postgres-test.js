#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PostgresRuntimeStore, OptimisticConcurrencyError } = require('../persistence/postgres/store');
const { buildStructuredAllocationAuthorityDraft } = require('../runtime/structured-allocation-prerequisites-contract');
const { withHarness } = require('./postgres-test-harness');

const STAMP = `${Date.now()}-${process.pid}`;

function declaredWork(objective) {
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [{ kind: 'text', declaration: 'Every report contains findings and recommendations' }],
    evidenceRequirements: []
  };
}

function ticketBody(group, objective, ownedOutputPaths) {
  const now = new Date().toISOString();
  return {
    objective,
    acceptanceCriteria: 'Review the explicit reports.',
    assignmentTargetType: 'group',
    assignmentTargetId: group.id,
    assignmentMode: 'allocated',
    ownedOutputPaths,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
      maxWorkspaceOperations: null, allowWorkspaceWrites: true,
      allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
    },
    status: 'blocked',
    blockedReason: 'Tranche 2A projection fixture; no worker run is admitted.',
    createdBy: 'structured-allocation-prerequisites-postgres-test',
    changedBy: 'structured-allocation-prerequisites-postgres-test',
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

async function main() {
  await withHarness('structured allocation prerequisites PostgreSQL', async ({
    store, schema, databaseUrl, workspaceRoot, startServer
  }) => {
    const historicalGroup = (await store.createGroup({
      value: { name: `Historical Planner Null ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: 'prerequisite-pg-test'
    })).group;
    assert.equal(historicalGroup.plannerAgentId, null);

    const group = (await store.createGroup({
      value: { name: `Structured Planning ${STAMP}`, permissions: [], canReceiveTickets: true },
      changedBy: 'prerequisite-pg-test'
    })).group;
    const planner = (await store.createConfiguredAgent({
      value: { name: `Planner ${STAMP}`, provider: 'openai', model: 'gpt-planner-test', apiKey: '' },
      groupIds: [group.id],
      changedBy: 'prerequisite-pg-test'
    })).agent;
    const worker = (await store.createConfiguredAgent({
      value: { name: `Worker ${STAMP}`, provider: 'ollama', model: 'worker-test', apiKey: '' },
      groupIds: [group.id],
      changedBy: 'prerequisite-pg-test'
    })).agent;
    const outsider = (await store.createConfiguredAgent({
      value: { name: `Outsider ${STAMP}`, provider: 'openai', model: 'outsider-test', apiKey: '' },
      groupIds: [],
      changedBy: 'prerequisite-pg-test'
    })).agent;

    await assert.rejects(
      store.updateGroup({
        groupId: group.id,
        expectedRevision: group.revision,
        value: { ...group, plannerAgentId: outsider.id },
        changedBy: 'prerequisite-pg-test'
      }),
      error => error.code === 'GROUP_PLANNER_MEMBERSHIP_REQUIRED'
    );
    await assert.rejects(
      store.updateGroup({
        groupId: group.id,
        expectedRevision: group.revision,
        value: { ...group, plannerAgentId: 999999999 },
        changedBy: 'prerequisite-pg-test'
      }),
      error => error.code === 'GROUP_PLANNER_MEMBERSHIP_REQUIRED'
    );

    const designatedResult = await store.updateGroup({
      groupId: group.id,
      expectedRevision: group.revision,
      value: { ...group, plannerAgentId: planner.id },
      changedBy: 'prerequisite-pg-test'
    });
    const designated = designatedResult.group;
    assert.equal(designated.plannerAgentId, planner.id);
    assert.equal(designated.revision, group.revision + 1);
    assert.equal(designatedResult.auditLog.plannerAgentId, planner.id);

    await assert.rejects(
      store.updateGroup({
        groupId: designated.id,
        expectedRevision: designated.revision,
        value: { ...designated, unsupportedPlanningRole: true },
        changedBy: 'prerequisite-pg-test'
      }),
      /unknown group field/
    );

    await assert.rejects(
      store.updateConfiguredAgent({
        agentId: planner.id,
        expectedRevision: planner.revision,
        value: planner,
        groupIds: [],
        changedBy: 'prerequisite-pg-test'
      }),
      error => error.code === 'GROUP_PLANNER_MEMBERSHIP_REQUIRED'
    );
    await assert.rejects(
      store.deleteConfiguredAgent({
        agentId: planner.id,
        expectedRevision: planner.revision,
        changedBy: 'prerequisite-pg-test'
      }),
      error => error.code === 'GROUP_PLANNER_MEMBERSHIP_REQUIRED'
    );

    const rawDelete = await store.pool.connect();
    try {
      await rawDelete.query('BEGIN');
      await rawDelete.query(
        `DELETE FROM ${store.table('agent_group_memberships')} WHERE agent_id = $1 AND group_id = $2`,
        [planner.id, group.id]
      );
      await assert.rejects(
        rawDelete.query('SET CONSTRAINTS ALL IMMEDIATE'),
        error => error.constraint === 'access_groups_planner_membership_required'
      );
      await rawDelete.query('ROLLBACK');
    } finally {
      rawDelete.release();
    }

    const objective = `Persist explicit parent work ${STAMP}`;
    const ownedOutputPaths = { [planner.id]: 'reports/planner/', [worker.id]: 'reports/worker/' };
    const authorityDraft = buildStructuredAllocationAuthorityDraft({
      declaredWork: declaredWork(objective),
      assignmentTargetType: 'group',
      assignmentMode: 'allocated',
      assignmentGroup: designated,
      plannerAgent: planner,
      candidateAgents: [worker, planner],
      ownedOutputPaths
    });
    assert.equal(authorityDraft.structuredAllocationEligibility.eligible, true);

    const createdResult = await store.createTicketWithEvent({
      ticket: ticketBody(designated, objective, ownedOutputPaths),
      structuredAllocationAuthorityDraft: authorityDraft,
      eventPayload: { source: 'structured-allocation-prerequisites-postgres-test' }
    });
    const ticket = createdResult.ticket;
    const authority = ticket.structuredAllocationAuthority;
    assert(authority);
    assert.equal(authority.planningAuthoritySnapshot.ticketId, ticket.id);
    assert.equal(authority.planningAuthoritySnapshot.planner.agentId, planner.id);
    assert.equal(authority.planningAuthoritySnapshot.planner.model, 'gpt-planner-test');
    assert.equal(authority.parentDeclaredWorkSnapshot.objective.text, objective);
    assert.equal(Object.isFrozen(authority), true);
    assert.equal(Object.isFrozen(authority.planningAuthoritySnapshot.candidates[0]), true);

    await assert.rejects(
      store.createTicket({
        id: ticket.id + 1000000,
        status: 'blocked',
        structuredAllocationAuthority: authority
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_AUTHORITY_ADMISSION_REQUIRED'
    );

    const rawTicket = (await store.pool.query(
      `SELECT body FROM ${store.table('tickets')} WHERE id = $1`, [ticket.id]
    )).rows[0].body;
    assert.equal(rawTicket.structuredAllocationAuthority.authorityHash, authority.authorityHash);
    assert.equal(Object.prototype.hasOwnProperty.call(rawTicket, 'id'), false);
    const { events } = await store.listTicketEvents(ticket.id, { limit: 20 });
    const createdEvent = events.find(event => event.type === 'ticket.created');
    assert(createdEvent);
    assert.equal(createdEvent.payload.parentDeclaredWorkHash, authority.parentDeclaredWorkSnapshot.contractHash);
    assert.equal(createdEvent.payload.planningAuthoritySnapshotHash, authority.planningAuthoritySnapshot.snapshotHash);

    assert.deepEqual((await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs, []);
    assert.deepEqual((await store.listAllocationPlans({ ticketId: ticket.id, limit: 20 })).plans, []);

    const historicalTicket = await store.createTicket({
      status: 'blocked', objective: `Historical ticket ${STAMP}`
    });
    assert.equal(Object.prototype.hasOwnProperty.call(historicalTicket, 'structuredAllocationAuthority'), false);

    await assert.rejects(
      store.updateGroup({
        groupId: designated.id,
        expectedRevision: group.revision,
        value: { ...designated, plannerAgentId: worker.id },
        changedBy: 'stale-prerequisite-pg-test'
      }),
      error => error instanceof OptimisticConcurrencyError
    );
    const changedGroup = (await store.updateGroup({
      groupId: designated.id,
      expectedRevision: designated.revision,
      value: { ...designated, plannerAgentId: worker.id },
      changedBy: 'prerequisite-pg-test'
    })).group;
    assert.equal(changedGroup.plannerAgentId, worker.id);
    const afterPlannerChange = await store.getTicket(ticket.id);
    assert.equal(afterPlannerChange.structuredAllocationAuthority.authorityHash, authority.authorityHash);
    assert.equal(afterPlannerChange.structuredAllocationAuthority.planningAuthoritySnapshot.planner.agentId, planner.id);
    assert.equal(Object.prototype.hasOwnProperty.call(await store.getTicket(historicalTicket.id), 'structuredAllocationAuthority'), false);

    const reopened = (await store.transitionTicketState({
      ticketId: ticket.id,
      fromStatuses: ['blocked'],
      toStatus: 'open',
      patch: { changedAt: new Date().toISOString(), blockedReason: null },
      eventType: 'ticket.reopened',
      eventPayload: { source: 'structured-allocation-prerequisites-postgres-test' }
    })).ticket;
    assert.equal(reopened.structuredAllocationAuthority.authorityHash, authority.authorityHash);
    assert.equal(reopened.structuredAllocationAuthority.parentDeclaredWorkSnapshot.contractHash, authority.parentDeclaredWorkSnapshot.contractHash);
    await assert.rejects(
      store.transitionTicketState({
        ticketId: ticket.id,
        fromStatuses: ['open'],
        toStatus: 'blocked',
        patch: { structuredAllocationAuthority: null },
        eventType: 'ticket.blocked'
      }),
      error => error.code === 'STRUCTURED_ALLOCATION_AUTHORITY_IMMUTABLE'
    );

    const peer = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });
    try {
      assert.deepEqual(await peer.migrate(), []);
      const peerTicket = await peer.getTicket(ticket.id);
      assert.deepEqual(peerTicket.structuredAllocationAuthority, reopened.structuredAllocationAuthority);
      assert.equal(Object.isFrozen(peerTicket.structuredAllocationAuthority), true);
    } finally {
      await peer.close();
    }

    const rollbackObjective = `Rollback structured authority ${STAMP}`;
    const rollbackDraft = buildStructuredAllocationAuthorityDraft({
      declaredWork: declaredWork(rollbackObjective),
      assignmentTargetType: 'group',
      assignmentMode: 'allocated',
      assignmentGroup: changedGroup,
      plannerAgent: worker,
      candidateAgents: [worker, planner],
      ownedOutputPaths
    });
    const appendEvent = store._appendEvent;
    store._appendEvent = async () => { throw new Error('injected ticket-created event failure'); };
    try {
      await assert.rejects(
        store.createTicketWithEvent({
          ticket: ticketBody(changedGroup, rollbackObjective, ownedOutputPaths),
          structuredAllocationAuthorityDraft: rollbackDraft
        }),
        /injected ticket-created event failure/
      );
    } finally {
      store._appendEvent = appendEvent;
    }
    assert.equal(
      (await store.listTickets({ limit: 500 })).tickets.some(item => item.objective === rollbackObjective),
      false
    );

    const tamperClient = await store.pool.connect();
    try {
      await tamperClient.query('BEGIN');
      await tamperClient.query(
        `UPDATE ${store.table('tickets')}
         SET body = jsonb_set(body, '{structuredAllocationAuthority,planningAuthoritySnapshot,planner,model}', to_jsonb($2::text)),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [ticket.id, 'tampered-model']
      );
      await assert.rejects(
        tamperClient.query(`SELECT * FROM ${store.table('tickets')} WHERE id = $1`, [ticket.id])
          .then(result => require('../runtime/structured-allocation-prerequisites-contract')
            .normalizeStructuredAllocationAuthority(
              result.rows[0].body.structuredAllocationAuthority,
              { expectedTicketId: ticket.id }
            )),
        /snapshotHash/
      );
      await tamperClient.query('ROLLBACK');
    } finally {
      tamperClient.release();
    }

    const server = await startServer({
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    });
    const cookie = await server.login();

    fs.mkdirSync(path.join(workspaceRoot, 'reports', 'planner'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, 'reports', 'worker'), { recursive: true });
    const liveObjective = `Create review reports ${STAMP}`;
    const liveResponse = await server.request('POST', '/tickets', {
      cookie,
      form: {
        objective: liveObjective,
        acceptanceCriteria: 'Legacy review prose does not supply output authority.',
        declaredWork: JSON.stringify(declaredWork(liveObjective)),
        assignmentTargetType: 'group',
        assignmentTargetId: String(changedGroup.id),
        assignmentMode: 'allocated',
        capabilityType: 'directAction',
        executionTargetKind: 'workspace',
        ownedOutputPaths: JSON.stringify(ownedOutputPaths)
      }
    });
    assert.equal(liveResponse.statusCode, 302, liveResponse.body.slice(0, 1000));
    const liveTicket = (await store.listTickets({ limit: 500 })).tickets
      .find(candidate => candidate.objective === liveObjective);
    assert(liveTicket);
    assert.equal(liveTicket.structuredAllocationAuthority.structuredAllocationEligibility.eligible, true);
    assert.equal(liveTicket.structuredAllocationAuthority.planningAuthoritySnapshot.planner.agentId, worker.id);
    const livePlans = (await store.listAllocationPlans({ ticketId: liveTicket.id, limit: 20 })).plans;
    assert.equal(livePlans.length, 1, 'existing v1 allocation remains operational');
    assert.equal(Object.prototype.hasOwnProperty.call(livePlans[0], 'version'), false,
      'Tranche 2A does not admit Allocation Plan v2');
    assert.equal((await store.listRunsForTicket({ ticketId: liveTicket.id, limit: 20 })).runs.length, 2,
      'existing v1 run creation remains unchanged');

    const api = await server.request('GET', `/api/tickets/${ticket.id}/runtime`, { cookie });
    assert.equal(api.statusCode, 200);
    const apiTicket = JSON.parse(api.body).ticket;
    assert.equal(apiTicket.structuredAllocationAuthority.authorityHash, authority.authorityHash);
    const page = await server.request('GET', `/tickets/${ticket.id}`, { cookie });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Structured Allocation Authority/);
    assert.match(page.body, new RegExp(authority.parentDeclaredWorkSnapshot.contractHash));
    assert.match(page.body, /Planner|planning principal|Recorded route/i);

    const cookieToken = /sessionId=([^;]+)/.exec(cookie)?.[1];
    assert(cookieToken);
    const cookieFile = path.join(os.tmpdir(), `oquery-prerequisite-${STAMP}.cookie`);
    fs.writeFileSync(cookieFile, cookieToken);
    try {
      const cli = execFileSync(process.execPath, [
        path.join(__dirname, 'oquery.js'), 'ticket', String(ticket.id), '--url', server.baseUrl
      ], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, OPERC_COOKIE_PATH: cookieFile },
        encoding: 'utf8'
      });
      assert.match(cli, /parent declared work/);
      assert.match(cli, new RegExp(authority.authorityHash));
      assert.match(cli, /planning principal/);
    } finally {
      fs.rmSync(cookieFile, { force: true });
    }

    console.log('structured allocation prerequisites PostgreSQL tests passed');
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
