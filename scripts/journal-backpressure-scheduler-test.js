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

async function main() {
  await testRuntimeSchedulerPausesAndResumes();
  await testRuntimeSchedulerReservesBeforeLease();
  await testTemplateSchedulerPausesAndResumes();
  console.log('PASS: runtime and template schedulers pause during journal pressure and resume automatically');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
