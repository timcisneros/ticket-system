#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRunTerminalizationRepository,
  REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS,
  assertRunTerminalizationRepository
} = require('../persistence/json/run-terminalization-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let records = [{
  id: 1,
  ticketId: 10,
  agentId: 20,
  status: 'running',
  leaseOwner: 'worker-a',
  leaseExpiresAt: '2026-07-16T12:05:00.000Z',
  lastHeartbeatAt: '2026-07-16T12:00:00.000Z',
  startedAt: '2026-07-16T11:59:00.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}, {
  id: 2,
  ticketId: 11,
  agentId: 21,
  status: 'running',
  leaseOwner: 'worker-old',
  leaseExpiresAt: '2026-07-16T11:59:00.000Z',
  lastHeartbeatAt: '2026-07-16T11:58:00.000Z',
  startedAt: '2026-07-16T11:57:00.000Z',
  createdAt: '2026-07-16T11:56:00.000Z'
}, {
  id: 3,
  ticketId: 12,
  agentId: 22,
  status: 'pending',
  createdAt: '2026-07-16T11:55:00.000Z'
}, {
  id: 4,
  ticketId: 13,
  agentId: 23,
  status: 'running',
  leaseOwner: 'worker-a',
  leaseExpiresAt: '2026-07-16T12:05:00.000Z',
  lastHeartbeatAt: '2026-07-16T12:00:00.000Z',
  startedAt: '2026-07-16T11:59:00.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}, {
  id: 5,
  ticketId: 14,
  agentId: 24,
  status: 'running',
  leaseOwner: 'worker-a',
  leaseExpiresAt: '2026-07-16T12:05:00.000Z',
  lastHeartbeatAt: '2026-07-16T12:00:00.000Z',
  startedAt: '2026-07-16T11:59:00.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}];
const replayFiles = new Map();
const events = [];
let writes = 0;

const repository = new JsonRunTerminalizationRepository({
  // Match the file-backed store: every read parses a distinct object graph.
  readRuns: () => records.map(run => ({ ...run })),
  writeRuns: next => {
    records = next.map(run => ({ ...run }));
    writes += 1;
  },
  writeReplaySnapshotFile: (runId, snapshot) => replayFiles.set(runId, { ...snapshot }),
  attachReplayMetadata: (run, snapshot) => {
    run.replaySnapshotPath = `replay-snapshots/run-${run.id}.json`;
    run.replaySummary = {
      terminalStatus: snapshot.terminalStatus,
      finalizedAt: snapshot.finalizedAt
    };
    return run;
  },
  appendEvent: async event => {
    const stored = { ...event, id: `event-${events.length + 1}`, seq: events.length };
    events.push(stored);
    return stored;
  },
  sanitizePayload: value => JSON.parse(JSON.stringify(value)),
  now: () => new Date('2026-07-16T12:00:30.000Z')
});

function bundle(runId, overrides = {}) {
  return {
    runId,
    fromStatuses: ['running'],
    status: 'completed',
    leaseOwner: 'worker-a',
    completedAt: '2026-07-16T12:00:30.000Z',
    patch: { currentPhase: 'terminalization', browserReport: null },
    replaySnapshot: { version: 1, terminalStatus: 'completed', finalizedAt: '2026-07-16T12:00:30.000Z' },
    executionEvent: { type: 'run.execution_completed', payload: { status: 'completed' } },
    beforeReplayEvents: [{ type: 'run.verification_passed', payload: { status: 'passed' } }],
    replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'completed' } },
    beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
    evaluation: context => {
      assert.deepEqual(context.events.map(event => event.type), [
        'run.execution_completed',
        'run.verification_passed',
        'run.snapshot_finalized',
        'run.violations_checked'
      ]);
      assert.ok(context.events.every(event => event.id));
      return { effectiveness: { status: 'passed' }, violations: { status: 'none' } };
    },
    consequence: context => ({
      mutations: [],
      verification: {
        status: context.evaluation.effectiveness.status,
        eventCount: context.events.length
      }
    }),
    terminalEvent: { type: 'run.terminalized', payload: { status: 'completed' } },
    ...overrides
  };
}

async function main() {
  assert.deepEqual(REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS, ['terminalizeRun']);
  assert.equal(assertRunTerminalizationRepository(repository), repository);
  assert.equal(
    assertRunTerminalizationRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the terminalization repository contract'
  );
  assert.throws(() => assertRunTerminalizationRepository({}), /must implement terminalizeRun/);

  const wrongOwnerWrites = writes;
  assert.equal(await repository.terminalizeRun(bundle(1, { leaseOwner: 'worker-b' })), null);
  assert.equal(writes, wrongOwnerWrites);
  assert.equal(events.length, 0);

  const terminalized = await repository.terminalizeRun(bundle(1));
  assert.equal(terminalized.run.status, 'completed');
  assert.equal(terminalized.run.leaseOwner, null);
  assert.equal(terminalized.run.leaseExpiresAt, null);
  assert.equal(terminalized.run.lastHeartbeatAt, null);
  assert.equal(terminalized.run.runEvaluation.effectiveness.status, 'passed');
  assert.equal(terminalized.run.runConsequence.verification.status, 'passed');
  assert.equal(replayFiles.get(1).terminalStatus, 'completed');
  assert.deepEqual(events.map(event => event.type), [
    'run.execution_completed',
    'run.verification_passed',
    'run.snapshot_finalized',
    'run.violations_checked',
    'run.evaluation_completed',
    'run.consequence_recorded',
    'run.terminalized'
  ]);

  const recovered = await repository.terminalizeRun(bundle(2, {
    status: 'interrupted',
    leaseOwner: null,
    allowExpiredLease: true,
    patch: { error: 'worker disappeared' },
    replaySnapshot: { version: 1, terminalStatus: 'interrupted', finalizedAt: '2026-07-16T12:00:30.000Z' },
    beforeReplayEvents: [],
    evaluation: { effectiveness: { status: 'unknown' }, violations: { status: 'none' } },
    consequence: { mutations: [], verification: { status: 'unknown' } },
    terminalEvent: { type: 'run.terminalized', payload: { status: 'interrupted' } }
  }));
  assert.equal(recovered.run.status, 'interrupted');
  assert.equal(recovered.run.error, 'worker disappeared');

  const concurrent = await Promise.all([
    repository.terminalizeRun(bundle(4)),
    repository.terminalizeRun(bundle(5))
  ]);
  assert.ok(concurrent.every(result => result && result.run.status === 'completed'));
  assert.equal(records.find(run => run.id === 4).status, 'completed', 'cross-ticket commit must retain run 4');
  assert.equal(records.find(run => run.id === 5).status, 'completed', 'cross-ticket commit must retain run 5');

  await assert.rejects(
    repository.terminalizeRun(bundle(3, {
      fromStatuses: ['pending'],
      leaseOwner: null
    })),
    /Only a running run can complete/
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRunTerminalizationRepository().terminalizeRun({'));
  assert.ok(serverSource.includes("type: 'run.execution_completed'"));
  assert.ok(serverSource.includes("type: 'run.snapshot_finalized'"));
  assert.ok(serverSource.includes("type: 'run.terminalized'"));

  console.log('PASS: run terminalization repository commits status, lease clear, replay, evaluation, consequence, and ordered terminal evidence through one boundary');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
