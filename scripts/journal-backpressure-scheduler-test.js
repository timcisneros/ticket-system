#!/usr/bin/env node
'use strict';

const { createRuntimeScheduler } = require('../runtime/scheduler');
const { createTemplateScheduler } = require('../runtime/template-scheduler');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function testRuntimeSchedulerPausesAndResumes() {
  const run = { id: 1, ticketId: 1, agentId: 1, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' };
  const events = [];
  const started = [];
  let paused = true;
  let leaseExpirations = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => [run],
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async event => { events.push(event); },
    canStartRunNow: () => true,
    acquireRunLease: async () => run,
    expireStaleRunLeases: async () => { leaseExpirations += 1; },
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    isAdmissionPaused: () => paused,
    runner: { startRun: selected => started.push(selected) }
  });

  await scheduler.tick();
  assert(events.length === 0 && started.length === 0, 'runtime scheduler admitted work while journal pressure was active');
  assert(leaseExpirations === 0, 'runtime scheduler mutated lease state while journal pressure was active');

  paused = false;
  await scheduler.tick();
  assert(events.some(event => event.type === 'scheduler.run_selected'), 'runtime scheduler did not resume after pressure cleared');
  assert(started.length === 1 && leaseExpirations === 1, 'runtime scheduler did not resume its normal work exactly once');
}

async function testTemplateSchedulerPausesAndResumes() {
  let paused = true;
  let triggers = 0;
  const template = {
    id: 1,
    enabled: true,
    schedule: {
      enabled: true,
      kind: 'interval',
      everySeconds: 60,
      nextRunAt: '2026-01-01T00:00:00.000Z'
    }
  };
  const scheduler = createTemplateScheduler({
    readProcessTemplates: () => [template],
    triggerDueTemplate: async () => { triggers += 1; return { ok: true, ticketId: triggers }; },
    isAdmissionPaused: () => paused,
    now: () => new Date('2026-01-01T00:01:00.000Z')
  });

  const pausedResults = await scheduler.tick();
  assert(pausedResults.length === 0 && triggers === 0, 'template scheduler created work while journal pressure was active');

  paused = false;
  const resumedResults = await scheduler.tick();
  assert(triggers === 1 && resumedResults[0].action === 'created', 'template scheduler did not resume after pressure cleared');
}

async function testRuntimeSchedulerReservesBeforeLease() {
  const run = { id: 2, ticketId: 2, agentId: 1, status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' };
  let admission = null;
  let leaseAcquisitions = 0;
  let starts = 0;
  let releases = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => [run],
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async () => {},
    canStartRunNow: () => true,
    acquireRunAdmission: () => admission,
    releaseRunAdmission: () => { releases += 1; },
    runWithAdmission: (_token, operation) => operation(),
    acquireRunLease: async () => { leaseAcquisitions += 1; return run; },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: {
      startRun: (_run, token) => {
        assert(token === undefined, 'scheduler leaked its selection admission into run execution');
        assert(releases === 1, 'scheduler dispatched the run before releasing selection admission');
        starts += 1;
        return true;
      }
    }
  });

  await scheduler.tick();
  assert(leaseAcquisitions === 0 && starts === 0, 'scheduler leased or dispatched work without journal producer capacity');

  admission = { id: 'admitted' };
  await scheduler.tick();
  assert(leaseAcquisitions === 1 && starts === 1, 'scheduler did not resume after producer capacity became available');
  assert(releases === 1, 'scheduler did not release admission after recording run selection');
}

async function testRuntimeSchedulerBatchesBoundedSelections() {
  const runs = [1, 2, 3].map(id => ({
    id,
    ticketId: id,
    agentId: 1,
    status: 'pending',
    createdAt: `2026-01-01T00:00:0${id}.000Z`
  }));
  const started = [];
  const insideAdmission = new Set();
  let leasesWaiting = 0;
  let releaseLeaseBarrier;
  const leaseBarrier = new Promise(resolve => { releaseLeaseBarrier = resolve; });

  const scheduler = createRuntimeScheduler({
    readRuns: () => runs,
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async event => {
      if (event.runId && ['run.lease_acquired', 'scheduler.run_selected'].includes(event.type)) {
        assert(insideAdmission.has(event.runId), `${event.type} escaped its selection admission`);
      }
    },
    canStartRunNow: () => true,
    acquireRunAdmission: run => ({ runId: run.id }),
    releaseRunAdmission: () => {},
    runWithAdmission: async (token, operation) => {
      insideAdmission.add(token.runId);
      try {
        return await operation();
      } finally {
        insideAdmission.delete(token.runId);
      }
    },
    acquireRunLease: async runId => {
      leasesWaiting += 1;
      if (leasesWaiting === runs.length) releaseLeaseBarrier();
      await leaseBarrier;
      await Promise.resolve();
      return runs.find(run => run.id === runId);
    },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => { started.push(run.id); return true; } }
  });

  await Promise.race([
    scheduler.tick(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('selection remained serial')), 1000))
  ]);
  assert(leasesWaiting === 3, 'scheduler did not place all bounded selections in flight');
  assert(started.length === 3, 'scheduler did not dispatch every selected run');
}

async function testProcessCapacityBoundsSelectionBatch() {
  const runs = [1, 2, 3].map(id => ({ id, ticketId: id, agentId: 1, status: 'pending', createdAt: String(id) }));
  const events = [];
  const leased = [];
  const started = [];
  let reserved = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => runs,
    readLogs: () => [],
    appendRunLog: () => {},
    appendEvent: async event => { events.push(event); },
    canStartRunNow: () => reserved < 2,
    getRunStartBlockReason: () => reserved >= 2 ? 'process_concurrency_limit' : null,
    tryReserveRunStart: run => {
      if (reserved >= 2) return null;
      reserved += 1;
      return { runId: run.id };
    },
    releaseRunStartReservation: () => { reserved -= 1; },
    acquireRunAdmission: run => ({ runId: run.id }),
    releaseRunAdmission: () => {},
    runWithAdmission: (_token, operation) => operation(),
    acquireRunLease: async runId => {
      leased.push(runId);
      return runs.find(run => run.id === runId);
    },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: run => { started.push(run.id); return true; } }
  });

  await scheduler.tick();
  assert(leased.length === 2 && started.length === 2, 'process capacity did not bound selected work');
  const blocked = events.find(event => event.type === 'scheduler.capacity_blocked');
  assert(blocked && blocked.runId === 3, 'first non-admitted run did not retain capacity evidence');
}

async function main() {
  await testRuntimeSchedulerPausesAndResumes();
  await testRuntimeSchedulerReservesBeforeLease();
  await testRuntimeSchedulerBatchesBoundedSelections();
  await testProcessCapacityBoundsSelectionBatch();
  await testTemplateSchedulerPausesAndResumes();
  console.log('PASS: schedulers recover from pressure and runtime selection is bounded and batched');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
