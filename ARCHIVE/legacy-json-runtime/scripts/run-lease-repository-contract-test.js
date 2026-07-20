#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRunLeaseRepository,
  REQUIRED_RUN_LEASE_REPOSITORY_METHODS,
  RunLeaseLostError,
  assertRunLeaseRepository
} = require('../persistence/json/run-lease-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { createRuntimeScheduler } = require('../runtime/scheduler');

const startMs = Date.parse('2026-07-16T12:00:00.000Z');
let clockMs = startMs;
let records = [
  { id: 1, ticketId: 1, agentId: 1, status: 'pending', createdAt: '2026-07-16T11:00:00.000Z' },
  {
    id: 2,
    ticketId: 2,
    agentId: 2,
    status: 'running',
    createdAt: '2026-07-16T11:01:00.000Z',
    startedAt: '2026-07-16T11:59:00.000Z',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-07-16T12:01:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:59:30.000Z'
  },
  {
    id: 3,
    ticketId: 3,
    agentId: 3,
    status: 'running',
    createdAt: '2026-07-16T11:02:00.000Z',
    startedAt: '2026-07-16T11:58:00.000Z',
    leaseOwner: 'worker-old',
    leaseExpiresAt: '2026-07-16T11:59:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:58:30.000Z'
  },
  {
    id: 4,
    ticketId: 4,
    agentId: 4,
    status: 'pending',
    createdAt: '2026-07-16T11:03:00.000Z',
    leaseOwner: 'worker-other',
    leaseExpiresAt: '2026-07-16T12:05:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:59:30.000Z'
  }
];
const events = [];
let writes = 0;

const repository = new JsonRunLeaseRepository({
  readRuns: () => records,
  writeRuns: next => {
    records = next.map(run => ({ ...run }));
    writes += 1;
  },
  appendEvent: async event => {
    const stored = { ...event, payload: { ...event.payload } };
    events.push(stored);
    return stored;
  },
  now: () => new Date(clockMs),
  sanitizePayload: value => ({ ...value }),
  maxQueryRows: 4,
  maxEligibleRunIds: 4
});

async function main() {
  assert.equal(assertRunLeaseRepository(repository), repository);
  assert.equal(
    assertRunLeaseRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the same run-lease repository contract'
  );
  assert.deepEqual(REQUIRED_RUN_LEASE_REPOSITORY_METHODS, [
    'getRun',
    'verifyRunLease',
    'listPendingRuns',
    'listExpiredRunningRuns',
    'claimPendingRun',
    'startClaimedRun',
    'heartbeatRunLease',
    'releaseRunLease',
    'persistRunWorkflowStep',
    'recoverExpiredRun'
  ]);
  assert.throws(() => assertRunLeaseRepository({}), /must implement getRun/);
  assert.equal(new RunLeaseLostError(1, 'worker-a').code, 'RUN_LEASE_LOST');
  await assert.rejects(repository.listPendingRuns({ limit: 5 }), /configured maximum/);

  const firstPendingPage = await repository.listPendingRuns({ limit: 1 });
  assert.deepEqual(firstPendingPage.runs.map(run => run.id), [1]);
  assert.deepEqual(firstPendingPage.nextCursor, { createdAt: records[0].createdAt, id: 1 });
  assert.deepEqual(firstPendingPage.scanEndCursor, { createdAt: records[3].createdAt, id: 4 });
  records.push({
    id: 5,
    ticketId: 5,
    agentId: 5,
    status: 'pending',
    createdAt: '2026-07-16T11:04:00.000Z'
  });
  const secondPendingPage = await repository.listPendingRuns({
    limit: 1,
    cursor: firstPendingPage.nextCursor,
    scanEndCursor: firstPendingPage.scanEndCursor
  });
  assert.deepEqual(secondPendingPage.runs.map(run => run.id), [4]);
  assert.equal(secondPendingPage.nextCursor, null);
  assert.deepEqual((await repository.listPendingRuns({ limit: 4 })).runs.map(run => run.id), [1, 4, 5]);
  records = records.filter(run => run.id !== 5);
  assert.deepEqual((await repository.listPendingRuns({ limit: 4 })).runs.map(run => run.id), [1, 4]);
  assert.deepEqual((await repository.listExpiredRunningRuns({ limit: 4 })).map(run => run.id), [3]);

  const claim = await repository.claimPendingRun({
    leaseOwner: 'worker-a',
    leaseDurationMs: 60_000,
    eligibleRunIds: [1],
    claimPayload: run => ({
      leaseOwner: 'forged',
      claimReceipt: { runId: run.id, leaseExpiresAt: run.leaseExpiresAt }
    })
  });
  assert.equal(claim.run.leaseOwner, 'worker-a');
  assert.equal(claim.run.updatedAt, '2026-07-16T12:00:00.000Z');
  assert.equal(claim.event.payload.leaseOwner, 'worker-a', 'authority fields must override caller payload');
  assert.equal(claim.event.payload.claimReceipt.runId, 1);
  assert.equal((await repository.verifyRunLease({ runId: 1, leaseOwner: 'worker-a' })).id, 1);
  assert.equal(await repository.verifyRunLease({ runId: 1, leaseOwner: 'worker-b' }), null);
  assert.equal(await repository.claimPendingRun({
    leaseOwner: 'worker-b', leaseDurationMs: 60_000, eligibleRunIds: [1]
  }), null, 'a live pending lease must not be stolen');
  assert.equal(await repository.claimPendingRun({
    leaseOwner: 'worker-a', leaseDurationMs: 60_000, eligibleRunIds: [4]
  }), null, 'another live pending lease must not be stolen');

  const writesBeforeWrongOwnerStart = writes;
  const eventsBeforeWrongOwnerStart = events.length;
  assert.equal(await repository.startClaimedRun({
    runId: 1,
    leaseOwner: 'worker-b',
    leaseDurationMs: 60_000
  }), null, 'a wrong-owner worker must not start a claimed run');
  assert.equal(writes, writesBeforeWrongOwnerStart, 'wrong-owner start must not mutate state');
  assert.equal(events.length, eventsBeforeWrongOwnerStart, 'wrong-owner start must not append evidence');

  records.push({
    id: 6,
    ticketId: 6,
    agentId: 6,
    agentName: 'Expired Agent',
    status: 'pending',
    createdAt: '2026-07-16T11:05:00.000Z',
    leaseOwner: 'worker-expired',
    leaseExpiresAt: '2026-07-16T11:59:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:58:30.000Z'
  });
  const writesBeforeExpiredStart = writes;
  const eventsBeforeExpiredStart = events.length;
  assert.equal(await repository.startClaimedRun({
    runId: 6,
    leaseOwner: 'worker-expired',
    leaseDurationMs: 60_000
  }), null, 'an expired owner must not start its claimed run');
  assert.equal(writes, writesBeforeExpiredStart, 'expired-owner start must not mutate state');
  assert.equal(events.length, eventsBeforeExpiredStart, 'expired-owner start must not append evidence');
  records = records.filter(run => run.id !== 6);

  clockMs += 10_000;
  const startedClaim = await repository.startClaimedRun({
    runId: 1,
    leaseOwner: 'worker-a',
    leaseDurationMs: 60_000,
    eventPayload: {
      status: 'forged',
      leaseOwner: 'forged',
      startedAt: '2000-01-01T00:00:00.000Z',
      phase: 'run_started'
    }
  });
  assert.equal(startedClaim.run.status, 'running');
  assert.equal(startedClaim.previousStatus, 'pending');
  assert.equal(startedClaim.run.startedAt, '2026-07-16T12:00:10.000Z');
  assert.equal(startedClaim.run.updatedAt, '2026-07-16T12:00:10.000Z');
  assert.equal(startedClaim.run.lastHeartbeatAt, '2026-07-16T12:00:10.000Z');
  assert.equal(startedClaim.run.leaseExpiresAt, '2026-07-16T12:01:10.000Z');
  assert.equal(startedClaim.event.type, 'run.started');
  assert.equal(startedClaim.event.payload.status, 'running');
  assert.equal(startedClaim.event.payload.leaseOwner, 'worker-a');
  assert.equal(startedClaim.event.payload.startedAt, startedClaim.run.startedAt);
  assert.equal(startedClaim.event.payload.phase, 'run_started');

  const writesBeforeWrongOwner = writes;
  assert.equal(await repository.heartbeatRunLease({
    runId: 1, leaseOwner: 'worker-b', leaseDurationMs: 60_000
  }), null);
  assert.equal(writes, writesBeforeWrongOwner, 'wrong-owner heartbeat must not mutate state');
  const heartbeat = await repository.heartbeatRunLease({
    runId: 1,
    leaseOwner: 'worker-a',
    leaseDurationMs: 60_000,
    payload: { leaseOwner: 'forged', phase: 'running' }
  });
  assert.equal(heartbeat.event.payload.leaseOwner, 'worker-a');
  assert.equal(heartbeat.event.payload.phase, 'running');

  const step = await repository.persistRunWorkflowStep({
    runId: 2,
    leaseOwner: 'worker-a',
    leaseDurationMs: 60_000,
    stepId: 'verify',
    action: 'condition',
    status: 'completed',
    payload: { status: 'forged' }
  });
  assert.equal(step.run.currentStepId, 'verify');
  assert.equal(step.run.currentWorkflowAction, 'condition');
  assert.equal(step.event.payload.status, 'completed');
  assert.equal(step.event.stepId, 'verify');

  const recovered = await repository.recoverExpiredRun({
    runId: 3,
    eventPayload: { reason: 'safe deterministic recovery', status: 'forged' }
  });
  assert.equal(recovered.run.status, 'pending');
  assert.equal(recovered.run.leaseOwner, null);
  assert.equal(recovered.run.lastHeartbeatAt, null);
  assert.equal(recovered.run.startedAt, undefined);
  assert.equal(recovered.event.payload.status, 'pending');
  assert.equal(recovered.previousLease.leaseOwner, 'worker-old');

  const released = await repository.releaseRunLease({
    runId: 1, leaseOwner: 'worker-a', payload: { leaseOwner: 'forged' }
  });
  assert.equal(released.run.leaseOwner, null);
  assert.equal(released.event.payload.leaseOwner, 'worker-a');

  clockMs += 120_000;
  const writesBeforeExpiredHeartbeat = writes;
  assert.equal(await repository.heartbeatRunLease({
    runId: 2, leaseOwner: 'worker-a', leaseDurationMs: 60_000
  }), null, 'an expired owner must not renew its authority');
  assert.equal(writes, writesBeforeExpiredHeartbeat);

  let asyncListCalls = 0;
  const schedulerEvents = [];
  const started = [];
  const candidate = { id: 10, ticketId: 10, agentId: 1, status: 'pending', createdAt: '2026-07-16T12:00:00.000Z' };
  const scheduler = createRuntimeScheduler({
    readRuns: () => { throw new Error('synchronous readRuns fallback should not run'); },
    listPendingRuns: async () => {
      asyncListCalls += 1;
      return [candidate];
    },
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async event => { schedulerEvents.push(event); },
    canStartRunNow: () => true,
    acquireRunLease: async () => candidate,
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => { started.push(run.id); return true; } }
  });
  await scheduler.tick();
  assert.equal(asyncListCalls, 1);
  assert.deepEqual(started, [10]);
  assert.ok(schedulerEvents.some(event => event.type === 'scheduler.run_selected'));

  const refusedReleases = [];
  const refusedScheduler = createRuntimeScheduler({
    readRuns: () => [],
    listPendingRuns: async () => [candidate],
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async () => {},
    canStartRunNow: () => true,
    acquireRunLease: async () => candidate,
    releaseRunLease: async (runId, payload) => { refusedReleases.push({ runId, payload }); },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: () => false }
  });
  await refusedScheduler.tick();
  assert.deepEqual(refusedReleases, [{ runId: 10, payload: { reason: 'runner_start_refused' } }]);

  const blockedCandidate = {
    id: 20, ticketId: 20, agentId: 1, status: 'pending', createdAt: '2026-07-16T12:00:00.000Z'
  };
  const runnableCandidate = {
    id: 21, ticketId: 21, agentId: 2, status: 'pending', createdAt: '2026-07-16T12:00:01.000Z'
  };
  const pageCursor = { createdAt: blockedCandidate.createdAt, id: blockedCandidate.id };
  const pagedStarts = [];
  const pagedScheduler = createRuntimeScheduler({
    readRuns: () => { throw new Error('paged scheduler must use repository discovery'); },
    listPendingRuns: async ({ cursor, scanEndCursor }) => cursor === null
      ? { runs: [blockedCandidate], nextCursor: pageCursor, scanEndCursor: pageCursor }
      : { runs: [runnableCandidate], nextCursor: null },
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async () => {},
    canStartRunNow: run => run.id === runnableCandidate.id,
    getRunStartBlockReason: run => run.id === blockedCandidate.id ? 'provider_concurrency_limit' : null,
    acquireRunLease: async runId => runId === runnableCandidate.id ? runnableCandidate : null,
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => { pagedStarts.push(run.id); return true; } }
  });
  await pagedScheduler.tick();
  assert.deepEqual(pagedStarts, []);
  await pagedScheduler.tick();
  assert.deepEqual(pagedStarts, [21], 'bounded page rotation must not starve work behind a blocked prefix');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const providerFenceIndex = serverSource.indexOf("phase: 'provider_response_received'");
  const responseEvidenceIndex = serverSource.lastIndexOf(
    'const providerCall = await callModelProviderWithRunEvidence',
    providerFenceIndex
  );
  const parseIndex = serverSource.indexOf('const modelPlan = parseModelActions(modelText)', providerFenceIndex);
  const actionFenceIndex = serverSource.indexOf('await assertLiveRunLease(run.id)', parseIndex);
  assert.ok(responseEvidenceIndex >= 0 && responseEvidenceIndex < providerFenceIndex,
    'provider response evidence must commit before the lease fence and plan parsing');
  assert.ok(providerFenceIndex < parseIndex, 'provider response must renew ownership before plan execution');
  assert.ok(actionFenceIndex > parseIndex, 'each parsed action must revalidate ownership before target execution');
  assert.ok(serverSource.includes("error.code === 'RUN_LEASE_LOST'"));
  assert.ok(serverSource.includes("outcome: 'execution_stopped_for_recovery'"));
  assert.ok(serverSource.includes('listPendingRuns: ({ cursor = null, scanEndCursor = null } = {})'));
  const runAgentTicketStart = serverSource.indexOf('async function runAgentTicket(runId)');
  const runAgentTicketEnd = serverSource.indexOf('// ==================== WORKSPACE PROVIDER ====================', runAgentTicketStart);
  const runAgentTicketSource = serverSource.slice(runAgentTicketStart, runAgentTicketEnd);
  assert.ok(runAgentTicketStart >= 0 && runAgentTicketEnd > runAgentTicketStart);
  assert.ok(runAgentTicketSource.includes('await getRunLeaseRepository().startClaimedRun({'),
    'runAgentTicket must start its claimed run through the lease repository');
  assert.ok(!runAgentTicketSource.includes("updateRunStatus(runId, 'running')"),
    'runAgentTicket must not rewrite the run projection directly at start');
  assert.ok(!runAgentTicketSource.includes("type: 'run.started'"),
    'runAgentTicket must not append start evidence outside the repository boundary');

  assert.deepEqual(
    events.map(event => event.type),
    ['run.lease_acquired', 'run.started', 'run.heartbeat', 'workflow.step.persisted', 'run.resumed', 'run.lease_released']
  );
  console.log('PASS: asynchronous run-lease repository contract — bounded discovery, claim, lease-fenced start, renewal, workflow progress, release, expiry fencing, and recovery');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
