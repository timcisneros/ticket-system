#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { PostgresRuntimeStore, OptimisticConcurrencyError } = require('../persistence/postgres/store');
const { PostgresSessionStore } = require('../persistence/postgres/session-store');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required for the PostgreSQL runtime cutover test');
  process.exit(1);
}

function sessionCall(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

async function main() {
  const schema = `ticket_system_cutover_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const store = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const peer = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });

  try {
    await store.migrate();
    assert.deepEqual(await peer.migrate(), []);
    assert.equal((await store.acquireRuntimeAuthority()).mode, 'shared_transactional');
    await assert.rejects(
      store.createTicket({
        status: 'open',
        title: 'Invalid retired template provenance',
        source: { type: 'process_template', templateId: 1 }
      }),
      error => error && error.code === '23514'
    );


    const context = (await store.createWorkContext({
      value: { name: 'Cutover context', purpose: 'Postgres runtime coverage', status: 'active' },
      changedBy: 'cutover-test'
    })).workContext;
    const openAiAgent = (await store.createConfiguredAgent({
      value: { name: 'Cutover OpenAI', provider: 'openai', model: 'test', apiKey: '' },
      groupIds: [],
      changedBy: 'cutover-test'
    })).agent;
    const localAgent = (await store.createConfiguredAgent({
      value: { name: 'Cutover local', provider: 'ollama', model: 'test', apiKey: '' },
      groupIds: [],
      changedBy: 'cutover-test'
    })).agent;

    const browserTarget = await store.createBrowserTarget({
      target: { id: 'cutover-browser', name: 'Cutover browser', status: 'active', baseUrl: 'https://example.test' },
      changedBy: 'cutover-test'
    });
    assert.equal(browserTarget.revision, 1);
    const staleBrowserRevision = browserTarget.revision;
    const updatedBrowser = await peer.updateBrowserTarget({
      targetId: browserTarget.id,
      expectedRevision: browserTarget.revision,
      target: { ...browserTarget, name: 'Updated browser', status: 'inactive' },
      changedBy: 'cutover-peer'
    });
    assert.equal(updatedBrowser.revision, 2);
    await assert.rejects(
      store.updateBrowserTarget({
        targetId: browserTarget.id,
        expectedRevision: staleBrowserRevision,
        target: { ...browserTarget, name: 'Stale browser', status: 'active' },
        changedBy: 'cutover-test'
      }),
      error => error instanceof OptimisticConcurrencyError && error.entity === 'browser target'
    );
    assert.deepEqual((await store.listBrowserTargets({ limit: 1 })).targets.map(target => target.id), ['cutover-browser']);

    await store.pool.query(
      `INSERT INTO ${store.table('work_types')} (id, status, body) VALUES ($1, 'active', $2::jsonb)`,
      ['cutover-work', { name: 'Cutover work', description: 'Semantic context', allowedTargetKinds: ['workspace'] }]
    );
    assert.equal((await peer.getWorkType('cutover-work')).name, 'Cutover work');
    assert.deepEqual((await store.listWorkTypes({ limit: 1 })).workTypes.map(workType => workType.id), ['cutover-work']);

    const connectorObject = await store.createLocalConnectorObject({
      object: { id: 'inbox/cutover.txt', workContextId: context.id, content: 'one', metadata: { source: 'test' } }
    });
    const connectorUpdate = await peer.updateLocalConnectorObject({
      objectId: connectorObject.id,
      expectedRevision: connectorObject.revision,
      object: { ...connectorObject, content: 'two' }
    });
    assert.equal(connectorUpdate.content, 'two');
    assert.equal(connectorUpdate.revision, 2);
    await assert.rejects(
      store.updateLocalConnectorObject({
        objectId: connectorObject.id,
        expectedRevision: connectorObject.revision,
        object: { ...connectorObject, content: 'stale' }
      }),
      error => error instanceof OptimisticConcurrencyError && error.entity === 'local connector object'
    );

    const ticket = await store.createTicket({ status: 'open', title: 'Application-state ticket', workContextId: context.id });
    const run = await store.createRun({ ticketId: ticket.id, agentId: openAiAgent.id, status: 'pending' });
    const plan = await store.createAllocationPlan({
      plan: {
        ticketId: ticket.id,
        status: 'pending',
        mode: 'allocated',
        items: [{ assignedAgentId: openAiAgent.id, allocationSubtask: 'Verify cutover' }]
      }
    });
    assert.equal((await peer.getAllocationPlanForTicket(ticket.id)).id, plan.id);
    const allocationUpdate = await store.updateAllocationItemStatus({
      planId: plan.id,
      allocationItemId: plan.items[0].allocationItemId,
      status: 'completed'
    });
    assert.equal(allocationUpdate.plan.status, 'completed');

    const threadDraft = {
      key: `run:${run.id}:deliverable`,
      kind: 'deliverable',
      ticketId: ticket.id,
      runId: run.id,
      workContextId: context.id,
      subject: 'Cutover result'
    };
    const initialMessage = { author: 'agent', authorName: 'Cutover agent', kind: 'deliverable', body: 'Ready' };
    const threadRace = await Promise.all([
      store.createMessageThreadIfAbsent({ thread: threadDraft, initialMessage }),
      peer.createMessageThreadIfAbsent({ thread: threadDraft, initialMessage })
    ]);
    assert.equal(threadRace.filter(result => result.created).length, 1);
    assert.equal(threadRace[0].thread.id, threadRace[1].thread.id);
    const threadId = threadRace[0].thread.id;
    const messageRace = await Promise.all([
      store.appendMessageThreadMessage({
        threadId,
        message: { author: 'operator', authorName: 'One', kind: 'reply', body: 'one' }
      }),
      peer.appendMessageThreadMessage({
        threadId,
        message: { author: 'operator', authorName: 'Two', kind: 'reply', body: 'two' }
      })
    ]);
    assert.deepEqual(messageRace.map(result => result.message.id).sort((a, b) => a - b), [2, 3]);
    const resolved = await store.resolveMessageThread({ threadId, closedBy: 'operator' });
    assert.equal(resolved.changed, true);
    assert.equal((await peer.resolveMessageThread({ threadId, closedBy: 'operator' })).changed, false);
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('message_thread_messages')} SET body = 'changed' WHERE thread_id = $1`, [threadId]),
      /append-only/i
    );

    const sessionStore = new PostgresSessionStore(store, { defaultTtlMs: 60_000 });
    await sessionCall(sessionStore, 'set', 'cutover-session', { userId: 7, cookie: {} });
    assert.equal((await sessionCall(new PostgresSessionStore(peer), 'get', 'cutover-session')).userId, 7);
    await sessionCall(sessionStore, 'touch', 'cutover-session', { cookie: { expires: new Date(Date.now() + 120_000) } });
    await sessionCall(sessionStore, 'destroy', 'cutover-session');
    assert.equal(await sessionCall(sessionStore, 'get', 'cutover-session'), null);
    await store.setHttpSession({ sid: 'expired-session', session: { userId: 8 }, expiresAt: new Date(Date.now() - 1_000) });
    assert.equal(await store.purgeExpiredHttpSessions(), 1);

    const limits = await store.getRuntimeLimitsConfig();
    const boundedPolicy = {
      maxExecutionSteps: 8,
      maxModelRequestsPerRun: 6,
      maxWorkspaceOperationsPerRun: 40,
      maxRuntimeDurationMs: 30_000,
      maxActiveRuns: 1,
      localModelConcurrency: 1
    };
    const bounded = await store.updateRuntimeLimitsConfig({
      expectedRevision: limits.revision,
      value: boundedPolicy,
      changedBy: 'cutover-test'
    });
    const capacityTicket = await store.createTicket({ status: 'open', title: 'Deployment admission' });
    const capacityRunOne = await store.createRun({ ticketId: capacityTicket.id, agentId: openAiAgent.id, status: 'pending' });
    const capacityRunTwo = await store.createRun({ ticketId: capacityTicket.id, agentId: openAiAgent.id, status: 'pending' });
    const capacityClaims = await Promise.all([
      store.claimPendingRun({ leaseOwner: 'cutover-a', leaseDurationMs: 30_000, eligibleRunIds: [capacityRunOne.id, capacityRunTwo.id] }),
      peer.claimPendingRun({ leaseOwner: 'cutover-b', leaseDurationMs: 30_000, eligibleRunIds: [capacityRunOne.id, capacityRunTwo.id] })
    ]);
    assert.equal(capacityClaims.filter(Boolean).length, 1, 'deployment maxActiveRuns must hold across store instances');
    const admitted = capacityClaims.find(Boolean);
    const blockedRunId = admitted.run.id === capacityRunOne.id ? capacityRunTwo.id : capacityRunOne.id;
    assert.equal(await peer.claimPendingRun({ leaseOwner: 'cutover-c', leaseDurationMs: 30_000, eligibleRunIds: [blockedRunId] }), null);
    await store.releaseRunLease({ runId: admitted.run.id, leaseOwner: admitted.run.leaseOwner });
    assert.equal((await peer.claimPendingRun({ leaseOwner: 'cutover-c', leaseDurationMs: 30_000, eligibleRunIds: [blockedRunId] })).run.id, blockedRunId,
      'admission must reopen automatically after deployment capacity is released');

    const expanded = await store.updateRuntimeLimitsConfig({
      expectedRevision: bounded.config.revision,
      value: { ...boundedPolicy, maxActiveRuns: 4 },
      changedBy: 'cutover-test'
    });
    assert.equal(expanded.config.maxActiveRuns, 4);
    const localTicket = await store.createTicket({ status: 'open', title: 'Provider admission' });
    const localRunOne = await store.createRun({ ticketId: localTicket.id, agentId: localAgent.id, status: 'pending' });
    const localRunTwo = await store.createRun({ ticketId: localTicket.id, agentId: localAgent.id, status: 'pending' });
    const localClaim = await store.claimPendingRun({ leaseOwner: 'local-a', leaseDurationMs: 30_000, eligibleRunIds: [localRunOne.id] });
    assert.ok(localClaim);
    assert.equal(await peer.claimPendingRun({ leaseOwner: 'local-b', leaseDurationMs: 30_000, eligibleRunIds: [localRunTwo.id] }), null,
      'local-model deployment policy must hold across store instances');
    await store.releaseRunLease({ runId: localClaim.run.id, leaseOwner: 'local-a' });
    assert.equal((await peer.claimPendingRun({ leaseOwner: 'local-b', leaseDurationMs: 30_000, eligibleRunIds: [localRunTwo.id] })).run.id, localRunTwo.id);

    const reset = await store.resetDevelopmentState({ changedBy: 'cutover-test' });
    assert.equal(reset.reset, true);
    assert.equal((await store.listTickets({ limit: 1 })).tickets.length, 0);
    assert.equal((await store.listRuns({ limit: 1 })).runs.length, 0);
    assert.equal((await store.listMessageThreads({ limit: 1 })).threads.length, 0);
    assert.equal((await store.listAllocationPlans({ limit: 1 })).plans.length, 0);
    assert.equal((await store.getBrowserTarget('cutover-browser')).id, 'cutover-browser', 'reset must preserve control catalogs');

    console.log('PASS: PostgreSQL runtime cutover — application state, sessions, deployment admission, provider admission, recovery, and reset');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await Promise.allSettled([store.close(), peer.close()]);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
