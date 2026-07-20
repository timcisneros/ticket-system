#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRuntimeStateReadRepository,
  REQUIRED_RUNTIME_STATE_READ_REPOSITORY_METHODS,
  assertRuntimeStateReadRepository
} = require('../persistence/json/runtime-state-read-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const tickets = [
  { id: 1, status: 'in_progress', title: 'Active', workContextId: 10, updatedAt: '2026-07-16T12:03:00.000Z' },
  { id: 2, status: 'completed', title: 'Done', workContextId: 10, updatedAt: '2026-07-16T12:02:00.000Z' },
  { id: 3, status: 'open', title: 'Waiting', workContextId: 20, parentTicketId: 1, updatedAt: '2026-07-16T12:02:00.000Z' }
];
const runs = [
  { id: 1, ticketId: 1, agentId: 10, status: 'running', updatedAt: '2026-07-16T11:01:00.000Z' },
  {
    id: 2,
    ticketId: 1,
    agentId: 10,
    status: 'completed',
    runEvaluation: { effectiveness: { status: 'passed' } },
    runConsequence: { verification: { status: 'passed' } },
    completedAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z'
  },
  { id: 3, ticketId: 2, agentId: 20, status: 'failed', updatedAt: '2026-07-16T11:03:00.000Z' },
  { id: 4, ticketId: 2, agentId: 20, status: 'completed', updatedAt: '2026-07-16T11:04:00.000Z' }
];
const events = [
  { id: 'ticket-1', ticketId: 1, runId: null, type: 'ticket.updated', ts: '2026-07-16T11:00:00.000Z' },
  { id: 'run-1-0', ticketId: 1, runId: 1, seq: 0, type: 'run.created', ts: '2026-07-16T11:01:00.000Z' },
  { id: 'run-1-1', ticketId: 1, runId: 1, seq: 1, type: 'run.started', ts: '2026-07-16T11:02:00.000Z' },
  { id: 'run-2-0', ticketId: 1, runId: 2, seq: 0, type: 'run.execution_completed', ts: '2026-07-16T11:03:00.000Z' },
  { id: 'run-3-0', ticketId: 2, runId: 3, seq: 0, type: 'run.execution_failed', ts: '2026-07-16T11:04:00.000Z' },
  { id: 'run-4-0', ticketId: 2, runId: 4, seq: 0, type: 'run.execution_completed', ts: '2026-07-16T11:05:00.000Z' },
  { id: 'run-4-1', ticketId: 2, runId: 4, seq: 1, type: 'replay.snapshot.finalized', ts: '2026-07-16T11:06:00.000Z' },
  { id: 'run-4-2', ticketId: 2, runId: 4, seq: 2, type: 'run.terminalized', ts: '2026-07-16T11:07:00.000Z' }
];
const operations = [
  { id: 1, runId: 1, ticketId: 1, operation: 'writeFile', operationKey: 'one', result: { status: 'written' } },
  { id: 2, runId: 1, ticketId: 1, operation: 'readFile', operationKey: 'two' },
  { id: 3, runId: 2, ticketId: 1, operation: 'createFolder', operationKey: 'three', result: { status: 'created' } },
  { id: 4, runId: 2, ticketId: 1, operation: 'deletePath', operationKey: 'four', error: 'refused' }
];

const clone = value => structuredClone(value);
const repository = new JsonRuntimeStateReadRepository({
  readTickets: () => clone(tickets),
  readRuns: () => clone(runs),
  readRunScopedEvents: runId => clone(events.filter(event => event.runId === runId)),
  getRunEvents: runId => {
    const run = runs.find(candidate => candidate.id === runId);
    return clone(events.filter(event => event.runId === runId ||
      (run && event.runId === null && event.ticketId === run.ticketId)));
  },
  getTicketEvents: ticketId => clone(events.filter(event => event.ticketId === ticketId)),
  readOperationHistory: () => clone(operations),
  maxQueryRows: 2
});

async function main() {
  assert.deepEqual(REQUIRED_RUNTIME_STATE_READ_REPOSITORY_METHODS, [
    'getTicket',
    'getRun',
    'listTickets',
    'listTicketPage',
    'countTicketsByStatus',
    'listRuns',
    'listRunsForTicket',
    'listRunsForTickets',
    'listLatestRunsForTickets',
    'getRunAttemptPositions',
    'listChildTickets',
    'listRunsNeedingTerminalReconciliation',
    'listRunEvents',
    'listRunTimelineEvents',
    'listTicketEvents',
    'getRunEvaluation',
    'getRunConsequence',
    'listRunOperations',
    'listTicketOperations',
    'countRunMutations'
  ]);
  assert.equal(assertRuntimeStateReadRepository(repository), repository);
  assert.equal(
    assertRuntimeStateReadRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the runtime state read contract'
  );
  assert.throws(() => assertRuntimeStateReadRepository({}), /must implement getTicket/);

  assert.equal((await repository.getTicket(1)).title, 'Active');
  assert.equal((await repository.getRun(2)).status, 'completed');
  assert.equal(await repository.getRun(99), null);

  const ticketPage = await repository.listTickets({ statuses: ['in_progress', 'open'], limit: 2 });
  assert.deepEqual(ticketPage.tickets.map(ticket => ticket.id), [1, 3]);
  assert.equal(ticketPage.nextAfterId, null);
  const newestTickets = await repository.listTicketPage({ limit: 2 });
  assert.deepEqual(newestTickets.tickets.map(ticket => ticket.id), [1, 2]);
  assert.equal(newestTickets.hasPrevious, false);
  assert.equal(newestTickets.hasNext, true);
  const olderTickets = await repository.listTicketPage({
    cursorUpdatedAt: newestTickets.tickets[1].updatedAt,
    cursorId: newestTickets.tickets[1].id,
    direction: 'next',
    limit: 2
  });
  assert.deepEqual(olderTickets.tickets.map(ticket => ticket.id), [3]);
  assert.equal(olderTickets.hasPrevious, true);
  assert.equal(olderTickets.hasNext, false);
  const previousTickets = await repository.listTicketPage({
    cursorUpdatedAt: olderTickets.tickets[0].updatedAt,
    cursorId: olderTickets.tickets[0].id,
    direction: 'previous',
    limit: 2
  });
  assert.deepEqual(previousTickets.tickets.map(ticket => ticket.id), [1, 2]);
  assert.deepEqual(await repository.countTicketsByStatus({ workContextId: 10 }), {
    all: 2,
    open: 0,
    in_progress: 1,
    completed: 1,
    failed: 0,
    blocked: 0,
    closed: 0
  });
  const runPage = await repository.listRuns({ afterId: 0, limit: 2 });
  assert.deepEqual(runPage.runs.map(run => run.id), [1, 2]);
  assert.equal(runPage.nextAfterId, 2);
  const nextRunPage = await repository.listRuns({ afterId: runPage.nextAfterId, limit: 2 });
  assert.deepEqual(nextRunPage.runs.map(run => run.id), [3, 4]);
  assert.deepEqual(
    (await repository.listRunsForTicket({ ticketId: 1, limit: 2 })).runs.map(run => run.id),
    [1, 2]
  );
  assert.deepEqual(
    (await repository.listRunsForTickets({ ticketIds: [1, 2], statuses: ['running'], limit: 2 })).runs.map(run => run.id),
    [1]
  );
  assert.deepEqual(
    (await repository.listLatestRunsForTickets({ ticketIds: [1, 2] })).map(run => run.id),
    [2, 4]
  );
  assert.deepEqual(await repository.getRunAttemptPositions({ runIds: [1, 4] }), [
    { runId: 1, attemptNumber: 1, attemptCount: 2 },
    { runId: 4, attemptNumber: 2, attemptCount: 2 }
  ]);
  assert.deepEqual(
    (await repository.listChildTickets({ parentTicketId: 1, limit: 2 })).tickets.map(ticket => ticket.id),
    [3]
  );
  await assert.rejects(repository.listRuns({ limit: 3 }), /configured maximum/);
  await assert.rejects(repository.listTickets({ statuses: ['invented'], limit: 1 }), /Unsupported ticket status/);

  const reconciliation = await repository.listRunsNeedingTerminalReconciliation({ limit: 2 });
  assert.deepEqual(reconciliation.runs.map(run => run.id), [2, 3]);
  assert.equal(reconciliation.nextAfterId, null);

  assert.deepEqual(
    (await repository.listRunEvents(1, { limit: 1 })).map(event => event.seq),
    [0]
  );
  assert.deepEqual(
    (await repository.listRunEvents(1, { afterSeq: 0, limit: 2 })).map(event => event.seq),
    [1]
  );
  const timelinePage = await repository.listRunTimelineEvents(1, { limit: 2 });
  assert.deepEqual(timelinePage.events.map(event => event.id), ['ticket-1', 'run-1-0']);
  assert.equal(timelinePage.nextPosition, 2);
  assert.deepEqual(
    (await repository.listRunTimelineEvents(1, { afterPosition: 2, limit: 2 })).events.map(event => event.id),
    ['run-1-1']
  );
  const ticketTimelinePage = await repository.listTicketEvents(1, { limit: 2 });
  assert.deepEqual(ticketTimelinePage.events.map(event => event.id), ['ticket-1', 'run-1-0']);
  assert.equal(ticketTimelinePage.nextPosition, 2);

  assert.equal((await repository.getRunEvaluation(2)).evaluation.effectiveness.status, 'passed');
  assert.equal((await repository.getRunConsequence(2)).consequence.verification.status, 'passed');
  assert.equal(await repository.getRunEvaluation(1), null);
  assert.deepEqual(
    (await repository.listRunOperations(1, { limit: 2 })).map(operation => operation.id),
    [1, 2]
  );
  assert.deepEqual(
    (await repository.listTicketOperations(1, { afterId: 2, limit: 2 })).map(operation => operation.id),
    [3, 4]
  );
  assert.deepEqual(await repository.countRunMutations({ runIds: [1, 2] }), [
    { runId: 1, count: 1 },
    { runId: 2, count: 1 }
  ]);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRuntimeStateReadRepository()'));
  assert.ok(serverSource.includes("readRunsNeedingTerminalReconciliation()"));
  assert.ok(serverSource.includes("readAllRuntimeTickets({ statuses: ['in_progress'] })"));
  assert.ok(serverSource.includes('await readAllRunScopedEvents(run.id)'));
  assert.ok(serverSource.includes('await readRuntimeRunAuthority(runId)'));
  assert.ok(serverSource.includes('await readAllRunTimelineEvents(runId)'));
  assert.ok(serverSource.includes('await readAllRunOperations(runId)'));
  assert.ok(serverSource.includes('repository.listTicketPage({'));
  assert.ok(serverSource.includes('repository.countTicketsByStatus({'));
  assert.ok(serverSource.includes('await readAllTicketEvents(parsedTicketId)'));
  assert.ok(serverSource.includes('await readAllTicketOperations(parsedTicketId)'));
  assert.ok(serverSource.includes('readLatestRunsForTickets(rawChildTickets.map(child => child.id))'));

  console.log('PASS: runtime state reads use bounded ticket/operator, run, recovery, event, evaluation, consequence, and operation authority queries');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
