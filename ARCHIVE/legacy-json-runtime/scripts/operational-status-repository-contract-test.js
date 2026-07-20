#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonOperationalStatusRepository,
  REQUIRED_OPERATIONAL_STATUS_REPOSITORY_METHODS,
  assertOperationalStatusRepository
} = require('../persistence/json/operational-status-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const tickets = [
  { id: 1, status: 'open' },
  { id: 2, status: 'in_progress' },
  { id: 3, status: 'blocked' },
  { id: 4, status: 'completed' },
  { id: 5, status: 'failed' },
  { id: 6, status: 'closed' }
];
const runs = [
  { id: 1, ticketId: 1, agentId: 10, status: 'pending' },
  { id: 2, ticketId: 1, agentId: 10, status: 'running', leaseOwner: 'worker', leaseExpiresAt: '2026-07-16T13:00:00.000Z' },
  { id: 3, ticketId: 2, agentId: 20, status: 'running', leaseOwner: 'worker', leaseExpiresAt: '2026-07-16T11:00:00.000Z' },
  { id: 4, ticketId: 2, agentId: 20, status: 'running', leaseOwner: null, leaseExpiresAt: null },
  { id: 5, ticketId: 3, agentId: 10, status: 'completed' },
  { id: 6, ticketId: 4, agentId: 10, status: 'failed' },
  { id: 7, ticketId: 5, agentId: 20, status: 'failed' },
  { id: 8, ticketId: 6, agentId: 20, status: 'interrupted' }
];

const clone = value => structuredClone(value);
const repository = new JsonOperationalStatusRepository({
  readTickets: () => clone(tickets),
  readRuns: () => clone(runs),
  now: () => new Date('2026-07-16T12:00:00.000Z'),
  maxQueryRows: 2
});

async function main() {
  assert.deepEqual(REQUIRED_OPERATIONAL_STATUS_REPOSITORY_METHODS, ['getRuntimeOperationalSummary']);
  assert.equal(assertOperationalStatusRepository(repository), repository);
  assert.equal(
    assertOperationalStatusRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the operational status contract'
  );
  assert.throws(() => assertOperationalStatusRepository({}), /must implement getRuntimeOperationalSummary/);

  assert.deepEqual(await repository.getRuntimeOperationalSummary({ limit: 2 }), {
    tickets: { total: 6, open: 2, blocked: 1, completed: 1, failed: 1 },
    runs: {
      total: 8,
      active: 4,
      pending: 1,
      running: 3,
      completed: 1,
      failed: 2,
      interrupted: 1,
      expiredLeases: 2,
      expiredLeasesTruncated: false
    },
    recentFailedRuns: [
      { runId: 7, ticketId: 5 },
      { runId: 6, ticketId: 4 }
    ]
  });
  const narrowRepository = new JsonOperationalStatusRepository({
    readTickets: () => clone(tickets),
    readRuns: () => clone(runs),
    now: () => new Date('2026-07-16T12:00:00.000Z'),
    maxQueryRows: 1
  });
  const narrowSummary = await narrowRepository.getRuntimeOperationalSummary({ limit: 1 });
  assert.equal(narrowSummary.runs.expiredLeases, 1);
  assert.equal(narrowSummary.runs.expiredLeasesTruncated, true);
  await assert.rejects(repository.getRuntimeOperationalSummary({ limit: 3 }), /configured maximum/);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getOperationalStatusRepository()'));
  assert.ok(serverSource.includes('getRuntimeOperationalSummary({ limit })'));
  assert.ok(serverSource.includes("repository.listRuns({\n    statuses: ['pending', 'running']"));
  assert.ok(serverSource.includes('repository.getRunAttemptPositions({ runIds })'));
  const runtimeStatusStart = serverSource.indexOf('async function getRuntimeStatusSnapshot(');
  const runtimeStatusEnd = serverSource.indexOf('\nfunction compareRunsNewestFirst(', runtimeStatusStart);
  const runtimeStatusSource = serverSource.slice(runtimeStatusStart, runtimeStatusEnd);
  assert.ok(runtimeStatusSource.includes('serializeRunOperationalStatus('));
  assert.ok(!runtimeStatusSource.includes('hydrateRunReplaySnapshots('));
  assert.ok(!runtimeStatusSource.includes('readAllRunTimelineEvents('));
  assert.ok(!runtimeStatusSource.includes('readAllRunOperations('));
  const opsStart = serverSource.indexOf('async function buildOperationalSummary(options = {})');
  const opsEnd = serverSource.indexOf('\nasync function prepareAgentRunDraft(', opsStart);
  const opsSource = serverSource.slice(opsStart, opsEnd);
  assert.ok(!opsSource.includes('readTickets()'));
  assert.ok(!opsSource.includes('readRuns()'));

  console.log('PASS: operational counts and active lifecycle detail use bounded backend-neutral authorities without collection-wide evidence hydration');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
