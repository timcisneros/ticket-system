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
}, {
  id: 6,
  ticketId: 15,
  agentId: 25,
  status: 'running',
  leaseOwner: 'recovery-worker',
  leaseExpiresAt: '2026-07-16T12:05:00.000Z',
  lastHeartbeatAt: '2026-07-16T12:00:00.000Z',
  startedAt: '2026-07-16T11:59:00.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}, {
  id: 7,
  ticketId: 16,
  agentId: 26,
  status: 'failed',
  completedAt: '2026-07-16T12:00:20.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}, {
  id: 8,
  ticketId: 17,
  agentId: 27,
  status: 'failed',
  completedAt: '2026-07-16T12:00:20.000Z',
  createdAt: '2026-07-16T11:58:00.000Z'
}, {
  id: 9,
  ticketId: 18,
  agentId: 28,
  status: 'failed',
  completedAt: '2026-07-16T12:00:20.000Z',
  runEvaluation: { effectiveness: { status: 'failed' } },
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
  readRunEvents: runId => events.filter(event => event.runId === runId).map(event => ({ ...event })),
  readReplaySnapshot: run => replayFiles.get(run.id) || null,
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
  assert.deepEqual(REQUIRED_RUN_TERMINALIZATION_REPOSITORY_METHODS, [
    'terminalizeRun',
    'repairRunTerminalization'
  ]);
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

  events.push({
    id: `event-${events.length + 1}`,
    seq: events.length,
    type: 'run.execution_completed',
    ticketId: 15,
    runId: 6,
    payload: { status: 'failed', completedAt: '2026-07-16T12:00:20.000Z' }
  });
  const repairRequest = {
    runId: 6,
    status: 'failed',
    recoveryOwner: 'recovery-worker',
    completedAt: '2026-07-16T12:00:30.000Z',
    patch: { currentPhase: 'terminalization', error: 'recovered failure' },
    replaySnapshot: {
      version: 1,
      terminalStatus: 'failed',
      failureReason: 'recovered failure',
      finalizedAt: '2026-07-16T12:00:30.000Z'
    },
    beforeReplayEvents: [{ type: 'run.triage_created', payload: { triage: { required: true } } }],
    replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
    beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
    evaluation: context => ({
      effectiveness: { status: 'failed' },
      violations: { status: context.events.some(event => event.type === 'run.violations_checked') ? 'none' : 'unknown' }
    }),
    consequence: context => ({
      mutations: [],
      verification: { status: context.evaluation.effectiveness.status }
    }),
    terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
  };
  const repaired = await repository.repairRunTerminalization(repairRequest);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.run.status, 'failed');
  assert.equal(repaired.run.leaseOwner, null);
  assert.equal(repaired.run.runEvaluation.effectiveness.status, 'failed');
  assert.deepEqual(events.filter(event => event.runId === 6).map(event => event.type), [
    'run.execution_completed',
    'run.triage_created',
    'run.snapshot_finalized',
    'run.violations_checked',
    'run.evaluation_completed',
    'run.consequence_recorded',
    'run.terminalized'
  ]);
  const repairedEventCount = events.length;
  const repeatedRepair = await repository.repairRunTerminalization({
    ...repairRequest,
    recoveryOwner: null,
    patch: {},
    replaySnapshot: replayFiles.get(6),
    beforeReplayEvents: [],
    replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
    beforeEvaluationEvents: [],
    evaluation: repaired.evaluation,
    consequence: repaired.consequence,
    terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
  });
  assert.equal(repeatedRepair.repaired, false);
  assert.equal(events.length, repairedEventCount, 'a completed repair must be idempotent');

  events.push({
    id: `event-${events.length + 1}`,
    seq: events.length,
    type: 'run.terminalized',
    ticketId: 16,
    runId: 7,
    payload: { status: 'completed' }
  });
  await assert.rejects(
    repository.repairRunTerminalization({ ...repairRequest, runId: 7, recoveryOwner: null }),
    error => error && error.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE'
  );

  events.push({
    id: `event-${events.length + 1}`,
    seq: events.length,
    type: 'run.execution_failed',
    ticketId: 17,
    runId: 8,
    payload: { status: 'failed' }
  }, {
    id: `event-${events.length + 2}`,
    seq: events.length + 1,
    type: 'run.snapshot_finalized',
    ticketId: 17,
    runId: 8,
    payload: { status: 'failed' }
  });
  await assert.rejects(
    repository.repairRunTerminalization({ ...repairRequest, runId: 8, recoveryOwner: null }),
    error => error && error.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE'
  );

  replayFiles.set(9, { version: 1, terminalStatus: 'failed', finalizedAt: '2026-07-16T12:00:20.000Z' });
  events.push({
    id: `event-${events.length + 1}`,
    seq: events.length,
    type: 'run.execution_failed',
    ticketId: 18,
    runId: 9,
    payload: { status: 'failed' }
  }, {
    id: `event-${events.length + 2}`,
    seq: events.length + 1,
    type: 'run.snapshot_finalized',
    ticketId: 18,
    runId: 9,
    payload: { status: 'failed' }
  }, {
    id: `event-${events.length + 3}`,
    seq: events.length + 2,
    type: 'run.evaluation_completed',
    ticketId: 18,
    runId: 9,
    payload: { evaluation: { effectiveness: { status: 'passed' } } }
  });
  await assert.rejects(
    repository.repairRunTerminalization({ ...repairRequest, runId: 9, recoveryOwner: null }),
    error => error && error.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE'
  );

  await assert.rejects(
    repository.terminalizeRun(bundle(3, {
      fromStatuses: ['pending'],
      leaseOwner: null
    })),
    /Only a running run can complete/
  );

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRunTerminalizationRepository().terminalizeRun({'));
  assert.ok(serverSource.includes('getRunTerminalizationRepository().repairRunTerminalization({'));
  assert.ok(serverSource.includes("type: 'run.execution_completed'"));
  assert.ok(serverSource.includes("type: 'run.snapshot_finalized'"));
  assert.ok(serverSource.includes("type: 'run.terminalized'"));

  console.log('PASS: run terminalization repository commits normal and repaired status, lease clear, replay, evaluation, consequence, and ordered terminal evidence through one boundary');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
