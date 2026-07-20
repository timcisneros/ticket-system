#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRunPhaseRepository,
  REQUIRED_RUN_PHASE_REPOSITORY_METHODS,
  RunPhaseConflictError,
  assertRunPhaseRepository,
  isRunPhaseTransitionAllowed
} = require('../persistence/json/run-phase-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

async function main() {
  assert.deepEqual(REQUIRED_RUN_PHASE_REPOSITORY_METHODS, ['advanceRunPhase']);
  assert.equal(
    assertRunPhaseRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the same run-phase contract'
  );
  assert.throws(() => assertRunPhaseRepository({}), /must implement advanceRunPhase/);
  assert.equal(isRunPhaseTransitionAllowed('planning', 'inspection'), true);
  assert.equal(isRunPhaseTransitionAllowed('inspection', 'planning'), false);

  let records = [{
    id: 1,
    ticketId: 10,
    agentId: 20,
    status: 'running',
    currentPhase: 'planning',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-07-18T12:10:00.000Z',
    updatedAt: '2026-07-18T11:59:00.000Z'
  }, {
    id: 2,
    ticketId: 11,
    agentId: 21,
    status: 'running',
    currentPhase: 'mutation',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-07-18T11:59:00.000Z'
  }, {
    id: 3,
    ticketId: 12,
    agentId: 22,
    status: 'pending',
    currentPhase: 'planning',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-07-18T12:10:00.000Z'
  }, {
    id: 4,
    ticketId: 13,
    agentId: 23,
    status: 'running',
    currentPhase: 'planning',
    leaseOwner: 'worker-a',
    leaseExpiresAt: '2026-07-18T12:10:00.000Z'
  }];
  const events = [];
  const calls = [];
  let failEvent = false;
  const repository = new JsonRunPhaseRepository({
    readRuns: () => structuredClone(records),
    writeRuns: runs => {
      calls.push('write');
      records = structuredClone(runs);
    },
    appendEvent: async event => {
      calls.push('event');
      if (failEvent) throw new Error('simulated phase journal failure');
      const stored = {
        id: `event-${events.length + 1}`,
        ts: '2026-07-18T12:00:00.000Z',
        ...structuredClone(event)
      };
      events.push(stored);
      return stored;
    },
    now: () => new Date('2026-07-18T12:00:00.000Z')
  });
  assert.equal(assertRunPhaseRepository(repository), repository);

  const advanced = await repository.advanceRunPhase({
    runId: 1,
    leaseOwner: 'worker-a',
    fromPhase: 'planning',
    toPhase: 'inspection',
    stepId: '1',
    reason: 'contract transition'
  });
  assert.equal(advanced.changed, true);
  assert.equal(advanced.run.currentPhase, 'inspection');
  assert.equal(advanced.run.updatedAt, '2026-07-18T12:00:00.000Z');
  assert.equal(advanced.event.type, 'execution.phase_transition');
  assert.equal(advanced.event.stepId, '1');
  assert.deepEqual(advanced.event.payload, {
    fromPhase: 'planning',
    toPhase: 'inspection',
    reason: 'contract transition'
  });
  assert.deepEqual(calls, ['event', 'write'], 'JSON must preserve authoritative evidence before its projection');

  const eventCount = events.length;
  const writeCount = calls.filter(call => call === 'write').length;
  const repeated = await repository.advanceRunPhase({
    runId: 1,
    leaseOwner: 'worker-a',
    fromPhase: 'planning',
    toPhase: 'inspection'
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.event, null);
  assert.equal(events.length, eventCount, 'idempotent target projection must not duplicate evidence');
  assert.equal(calls.filter(call => call === 'write').length, writeCount);

  const backward = await repository.advanceRunPhase({
    runId: 1,
    leaseOwner: 'worker-a',
    fromPhase: 'inspection',
    toPhase: 'planning'
  });
  assert.equal(backward.changed, false);
  assert.equal(events.length, eventCount, 'refused backward movement must not append a false transition event');
  assert.equal(records.find(run => run.id === 1).currentPhase, 'inspection');

  await assert.rejects(
    repository.advanceRunPhase({
      runId: 1,
      leaseOwner: 'worker-a',
      fromPhase: 'planning',
      toPhase: 'mutation'
    }),
    error => error instanceof RunPhaseConflictError && error.code === 'RUN_PHASE_CONFLICT'
  );
  assert.equal(await repository.advanceRunPhase({
    runId: 1,
    leaseOwner: 'worker-b',
    fromPhase: 'inspection',
    toPhase: 'mutation'
  }), null, 'wrong-owner phase projection must be fenced');
  assert.equal(await repository.advanceRunPhase({
    runId: 2,
    leaseOwner: 'worker-a',
    fromPhase: 'mutation',
    toPhase: 'verification'
  }), null, 'expired lease phase projection must be fenced');
  assert.equal(await repository.advanceRunPhase({
    runId: 3,
    leaseOwner: 'worker-a',
    fromPhase: 'planning',
    toPhase: 'inspection'
  }), null, 'pending runs cannot project execution progress');

  failEvent = true;
  await assert.rejects(
    repository.advanceRunPhase({
      runId: 4,
      leaseOwner: 'worker-a',
      fromPhase: 'planning',
      toPhase: 'inspection'
    }),
    /simulated phase journal failure/
  );
  assert.equal(records.find(run => run.id === 4).currentPhase, 'planning',
    'journal failure must not expose an unrecorded phase projection');

  const root = path.resolve(__dirname, '..');
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const postgresSource = fs.readFileSync(path.join(root, 'persistence', 'postgres', 'store.js'), 'utf8');
  const migrationSource = fs.readFileSync(
    path.join(root, 'persistence', 'postgres', 'migrations', '013_run_phase_projection.sql'),
    'utf8'
  );
  assert.ok(serverSource.includes('getRunPhaseRepository().advanceRunPhase({'));
  assert.ok(serverSource.includes('await advanceRunPhase(run, phaseCheck.inferredPhase, {'));
  assert.equal(serverSource.includes("advanceRunPhase(run, 'terminalization')"), false,
    'terminalization must remain inside the existing atomic terminal bundle');
  const advanceStart = serverSource.indexOf('async function advanceRunPhase(');
  const reconstructStart = serverSource.indexOf('function reconstructRunPhase(', advanceStart);
  assert.equal(serverSource.slice(advanceStart, reconstructStart).includes('writeRuns('), false,
    'server phase routing must not retain a direct JSON fallback');
  assert.ok(serverSource.includes('terminalPhaseEvent'));
  assert.ok(postgresSource.includes('async advanceRunPhase({'));
  assert.ok(postgresSource.includes("type: 'execution.phase_transition'"));
  assert.ok(postgresSource.includes('lease_expires_at > clock_timestamp()'));
  assert.ok(migrationSource.includes('ADD COLUMN current_phase TEXT NOT NULL'));
  assert.ok(migrationSource.includes('runs_terminal_phase_shape'));

  console.log('PASS: run phase repository contract — lease-fenced forward projection, atomic PostgreSQL evidence, and no false backward events');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
