#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { createRuntimeScheduler } = require('../runtime/scheduler');

function harness({ pendingRuns = [], lease = true, starting = false, reserve = true, prepare = async () => null } = {}) {
  const events = [];
  const started = [];
  const contexts = [];
  const scheduler = createRuntimeScheduler({
    readRuns: () => pendingRuns,
    appendEvent: async event => events.push(event),
    prepareRunStartContext: async runs => {
      const context = await prepare(runs);
      contexts.push(context);
      return context;
    },
    tryReserveRunStart: (_run, context) => reserve ? { runId: _run.id, context } : null,
    acquireRunLease: async id => lease ? pendingRuns.find(run => run.id === id) : null,
    expireStaleRunLeases: async () => {},
    isRunStarting: () => starting,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => { started.push(run.id); return true; } }
  });
  return { scheduler, events, started, contexts };
}

async function main() {
  const idle = harness();
  await idle.scheduler.tick();
  assert.deepEqual(idle.events, [], 'idle ticks must not emit evidence');

  const blockedRun = { id: 1, ticketId: 1, agentId: 1, status: 'pending', createdAt: '2026-01-01T00:00:00Z' };
  const databaseBlocked = harness({ pendingRuns: [blockedRun], lease: false });
  await databaseBlocked.scheduler.tick();
  assert.deepEqual(databaseBlocked.events.map(event => event.type), ['scheduler.tick', 'scheduler.run_skipped']);
  assert.equal(databaseBlocked.events[1].payload.reason, 'lease_not_acquired');

  const alreadyStarting = harness({ pendingRuns: [blockedRun], starting: true });
  await alreadyStarting.scheduler.tick();
  assert.deepEqual(alreadyStarting.events.map(event => event.type), ['scheduler.tick', 'scheduler.run_skipped']);
  assert.equal(alreadyStarting.events[1].payload.reason, 'already_starting');

  const page = [
    blockedRun,
    { id: 2, ticketId: 2, agentId: 2, status: 'pending', createdAt: '2026-01-01T00:00:01Z' }
  ];
  let prepares = 0;
  const shared = { agentById: new Map() };
  const prepared = harness({
    pendingRuns: page,
    reserve: false,
    prepare: async runs => { prepares += 1; assert.equal(runs.length, 2); return shared; }
  });
  await prepared.scheduler.tick();
  assert.equal(prepares, 1);
  assert.equal(prepared.contexts[0], shared);

  console.log('PASS: scheduler observability suppresses idle telemetry and reports Postgres claim skips truthfully');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
