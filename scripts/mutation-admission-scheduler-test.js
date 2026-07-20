#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const { createRuntimeScheduler } = require('../runtime/scheduler');
const { createTemplateScheduler } = require('../runtime/template-scheduler');

function run(id) {
  return { id, ticketId: id, agentId: 1, status: 'pending', createdAt: `2026-01-01T00:00:0${id}.000Z` };
}

async function testRuntimePausesAndResumes() {
  const candidate = run(1);
  const events = [];
  const started = [];
  let paused = true;
  let expirations = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => [candidate],
    appendEvent: async event => events.push(event),
    tryReserveRunStart: selected => ({ runId: selected.id }),
    acquireRunLease: async () => candidate,
    expireStaleRunLeases: async () => { expirations += 1; },
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    isAdmissionPaused: () => paused,
    runner: { startRun: selected => { started.push(selected.id); return true; } }
  });
  await scheduler.tick();
  assert.deepEqual(events, []);
  assert.deepEqual(started, []);
  assert.equal(expirations, 0);
  paused = false;
  await scheduler.tick();
  assert.equal(events.some(event => event.type === 'scheduler.run_selected'), true);
  assert.deepEqual(started, [candidate.id]);
  assert.equal(expirations, 1);
}

async function testSelectionAdmissionPrecedesLease() {
  const candidate = run(2);
  let token = null;
  let leaseAttempts = 0;
  let releases = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => [candidate],
    appendEvent: async () => {},
    tryReserveRunStart: selected => ({ runId: selected.id }),
    acquireRunAdmission: () => token,
    releaseRunAdmission: () => { releases += 1; },
    runWithAdmission: (_token, operation) => operation(),
    acquireRunLease: async () => { leaseAttempts += 1; return candidate; },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: () => { assert.equal(releases, 1); return true; } }
  });
  await scheduler.tick();
  assert.equal(leaseAttempts, 0, 'lease must not be attempted without mutation admission');
  token = { id: 'admitted' };
  await scheduler.tick();
  assert.equal(leaseAttempts, 1);
  assert.equal(releases, 1);
}

async function testSelectionsLaunchConcurrently() {
  const candidates = [run(3), run(4), run(5)];
  let waiting = 0;
  let releaseBarrier;
  const barrier = new Promise(resolve => { releaseBarrier = resolve; });
  const started = [];
  const scheduler = createRuntimeScheduler({
    readRuns: () => candidates,
    appendEvent: async () => {},
    tryReserveRunStart: selected => ({ runId: selected.id }),
    acquireRunAdmission: selected => ({ runId: selected.id }),
    releaseRunAdmission: () => {},
    runWithAdmission: (_token, operation) => operation(),
    acquireRunLease: async id => {
      waiting += 1;
      if (waiting === candidates.length) releaseBarrier();
      await barrier;
      return candidates.find(candidate => candidate.id === id);
    },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: selected => { started.push(selected.id); return true; } }
  });
  await Promise.race([
    scheduler.tick(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('selection remained serial')), 1_000))
  ]);
  assert.equal(waiting, candidates.length);
  assert.equal(started.length, candidates.length);
}

async function testLocalReservationIsNotADeploymentPolicy() {
  const candidates = [run(6), run(7), run(8)];
  const leased = [];
  let reserved = 0;
  const scheduler = createRuntimeScheduler({
    readRuns: () => candidates,
    appendEvent: async () => {},
    tryReserveRunStart: selected => {
      if (reserved >= 2) return null;
      reserved += 1;
      return { runId: selected.id };
    },
    releaseRunStartReservation: () => { reserved -= 1; },
    acquireRunAdmission: selected => ({ runId: selected.id }),
    releaseRunAdmission: () => {},
    runWithAdmission: (_token, operation) => operation(),
    acquireRunLease: async id => { leased.push(id); return candidates.find(candidate => candidate.id === id); },
    expireStaleRunLeases: async () => {},
    isRunStarting: () => false,
    isRunActiveInMemory: () => false,
    runner: { startRun: () => true }
  });
  await scheduler.tick();
  assert.deepEqual(leased, [6, 7]);
  assert.equal(reserved, 2, 'runner owns successful reservations until settlement');
}

async function testTemplatePausesAndResumes() {
  let paused = true;
  let triggers = 0;
  const scheduler = createTemplateScheduler({
    listDueProcessTemplates: async () => [{
      id: 1,
      enabled: true,
      schedule: { enabled: true, kind: 'interval', everySeconds: 60, nextRunAt: '2026-01-01T00:00:00.000Z' }
    }],
    triggerDueTemplate: async () => ({ ok: true, ticketId: ++triggers }),
    isAdmissionPaused: () => paused,
    now: () => new Date('2026-01-01T00:01:00.000Z')
  });
  assert.deepEqual(await scheduler.tick(), []);
  paused = false;
  assert.equal((await scheduler.tick())[0].action, 'created');
  assert.equal(triggers, 1);
}

async function main() {
  await testRuntimePausesAndResumes();
  await testSelectionAdmissionPrecedesLease();
  await testSelectionsLaunchConcurrently();
  await testLocalReservationIsNotADeploymentPolicy();
  await testTemplatePausesAndResumes();
  console.log('PASS: scheduler mutation admission pauses, resumes, and preserves concurrent Postgres claims');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
