#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRunRecoveryRepository,
  REQUIRED_RUN_RECOVERY_REPOSITORY_METHODS,
  assertRunRecoveryRepository
} = require('../persistence/json/run-recovery-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let now = new Date('2026-07-16T12:00:00.000Z');
let runs = [
  { id: 1, ticketId: 10, agentId: 1, status: 'pending', updatedAt: now.toISOString() },
  {
    id: 2,
    ticketId: 20,
    agentId: 2,
    status: 'running',
    startedAt: '2026-07-16T11:55:00.000Z',
    leaseOwner: 'old-live-owner',
    leaseExpiresAt: '2026-07-16T12:05:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:59:00.000Z',
    updatedAt: '2026-07-16T11:59:00.000Z'
  },
  {
    id: 3,
    ticketId: 30,
    agentId: 3,
    status: 'running',
    startedAt: '2026-07-16T11:45:00.000Z',
    leaseOwner: 'old-expired-owner',
    leaseExpiresAt: '2026-07-16T11:50:00.000Z',
    lastHeartbeatAt: '2026-07-16T11:49:00.000Z',
    updatedAt: '2026-07-16T11:49:00.000Z'
  },
  {
    id: 4,
    ticketId: 40,
    agentId: 4,
    status: 'running',
    startedAt: '2026-07-16T11:40:00.000Z',
    leaseOwner: null,
    leaseExpiresAt: null,
    lastHeartbeatAt: null,
    updatedAt: '2026-07-16T11:40:00.000Z'
  },
  { id: 5, ticketId: 50, agentId: 5, status: 'completed', completedAt: now.toISOString() }
];
const events = [];
const clone = value => structuredClone(value);

const repository = new JsonRunRecoveryRepository({
  readRuns: () => clone(runs),
  writeRuns: next => { runs = clone(next); },
  appendEvent: async event => {
    const stored = { id: `event-${events.length + 1}`, ...clone(event) };
    events.push(stored);
    return stored;
  },
  hasExclusiveProcessAuthority: () => true,
  now: () => new Date(now),
  maxQueryRows: 2
});

async function main() {
  assert.deepEqual(REQUIRED_RUN_RECOVERY_REPOSITORY_METHODS, [
    'listRecoverableRuns',
    'claimRunRecovery',
    'resumeRecoveredRun',
    'repairRecoveredRunTerminalProjection'
  ]);
  assert.equal(assertRunRecoveryRepository(repository), repository);
  assert.equal(
    assertRunRecoveryRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the run recovery contract'
  );
  assert.throws(() => assertRunRecoveryRepository({}), /must implement listRecoverableRuns/);

  const restartPage = await repository.listRecoverableRuns({
    mode: 'process_restart',
    limit: 2
  });
  assert.deepEqual(restartPage.runs.map(run => run.id), [1, 2]);
  assert.equal(restartPage.nextAfterId, 2);
  const restartNextPage = await repository.listRecoverableRuns({
    mode: 'process_restart',
    afterId: restartPage.nextAfterId,
    limit: 2
  });
  assert.deepEqual(restartNextPage.runs.map(run => run.id), [3, 4]);
  assert.equal(restartNextPage.nextAfterId, null);

  const expiryPage = await repository.listRecoverableRuns({ mode: 'lease_expiry', limit: 2 });
  assert.deepEqual(expiryPage.runs.map(run => run.id), [3, 4]);
  await assert.rejects(repository.listRecoverableRuns({ mode: 'invented', limit: 1 }), /Unsupported/);
  await assert.rejects(repository.listRecoverableRuns({ mode: 'lease_expiry', limit: 3 }), /configured maximum/);

  const restartClaim = await repository.claimRunRecovery({
    runId: 2,
    recoveryOwner: 'current-process',
    leaseDurationMs: 30_000,
    mode: 'process_restart',
    eventPayload: { reason: 'restart' }
  });
  assert.equal(restartClaim.previousLease.leaseOwner, 'old-live-owner');
  assert.equal(restartClaim.run.leaseOwner, 'current-process');
  assert.equal(restartClaim.event.type, 'run.recovery_claimed');
  assert.equal(restartClaim.event.payload.mode, 'process_restart');
  assert.equal(
    await repository.resumeRecoveredRun({ runId: 2, recoveryOwner: 'wrong-owner' }),
    null,
    'a different recovery owner must be fenced'
  );
  const resumed = await repository.resumeRecoveredRun({
    runId: 2,
    recoveryOwner: 'current-process',
    eventPayload: { reason: 'safe evidence' }
  });
  assert.equal(resumed.run.status, 'pending');
  assert.equal(resumed.run.leaseOwner, null);
  assert.equal(resumed.run.startedAt, undefined);
  assert.equal(resumed.event.type, 'run.resumed');

  const expiryClaim = await repository.claimRunRecovery({
    runId: 3,
    recoveryOwner: 'expiry-recovery',
    leaseDurationMs: 30_000,
    mode: 'lease_expiry'
  });
  assert.equal(expiryClaim.run.leaseOwner, 'expiry-recovery');
  assert.equal(
    await repository.claimRunRecovery({
      runId: 1,
      recoveryOwner: 'expiry-recovery',
      leaseDurationMs: 30_000,
      mode: 'lease_expiry'
    }),
    null,
    'normal pending work is not expired-lease recovery work'
  );
  const repaired = await repository.repairRecoveredRunTerminalProjection({
    runId: 3,
    recoveryOwner: 'expiry-recovery',
    status: 'interrupted',
    eventPayload: { terminalEventId: 'prior-terminal' }
  });
  assert.equal(repaired.run.status, 'interrupted');
  assert.equal(repaired.run.leaseOwner, null);
  assert.equal(repaired.event.type, 'run.terminal_projection_repaired');
  assert.equal(repaired.event.payload.previousStatus, 'running');

  now = new Date('2026-07-16T12:01:00.000Z');
  assert.equal(
    await repository.resumeRecoveredRun({ runId: 3, recoveryOwner: 'expiry-recovery' }),
    null,
    'terminal projection repair consumes recovery authority'
  );

  const noRestartAuthority = new JsonRunRecoveryRepository({
    readRuns: () => [],
    writeRuns: () => {},
    appendEvent: async event => event,
    hasExclusiveProcessAuthority: () => false
  });
  await assert.rejects(
    noRestartAuthority.listRecoverableRuns({ mode: 'process_restart' }),
    error => error && error.code === 'RUN_RECOVERY_AUTHORITY_REQUIRED'
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRunRecoveryRepository()'));
  assert.ok(serverSource.includes("readAllRecoverableRuns('lease_expiry')"));
  assert.ok(serverSource.includes("readAllRecoverableRuns('process_restart')"));
  assert.ok(serverSource.includes('claimRunRecovery({'));
  assert.ok(serverSource.includes('resumeRecoveredRun({'));
  assert.ok(serverSource.includes('repairRecoveredRunTerminalProjection({'));

  console.log('PASS: run recovery authority is bounded, backend-aware, lease-fenced, resumable, and projection-repairable');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
