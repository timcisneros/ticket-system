#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonDiagnosticLogRepository,
  REQUIRED_DIAGNOSTIC_LOG_REPOSITORY_METHODS,
  assertDiagnosticLogRepository
} = require('../persistence/json/diagnostic-log-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let logs = [];
let tick = 0;
const clone = value => structuredClone(value);
const repository = new JsonDiagnosticLogRepository({
  readLogs: () => clone(logs),
  writeLogs: records => { logs = clone(records); },
  now: () => `2026-07-17T12:00:0${tick++}.000Z`,
  maxQueryRows: 3
});
const runOne = { id: 1, ticketId: 10, agentId: 100, agentName: 'Agent One' };
const runTwo = { id: 2, ticketId: 20, agentId: 200, agentName: 'Agent Two' };

async function main() {
  assert.deepEqual(REQUIRED_DIAGNOSTIC_LOG_REPOSITORY_METHODS, [
    'appendRunLog',
    'appendSystemLog',
    'listLogs',
    'listLogsForRuns',
    'hasRunLogType',
    'getRunLogMetrics',
    'resetLogs'
  ]);
  assert.equal(assertDiagnosticLogRepository(repository), repository);
  assert.equal(
    assertDiagnosticLogRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the diagnostic log contract'
  );
  assert.throws(() => assertDiagnosticLogRepository({}), /must implement appendRunLog/);

  const request = repository.appendRunLog({
    run: runOne,
    type: 'model:request',
    message: 'request',
    metadata: { usage: { prompt_tokens: 2, completion_tokens: 3 }, runId: 999 }
  });
  const write = repository.appendRunLog({
    run: runOne,
    type: 'workspace:write',
    message: 'write',
    workspaceAction: { kind: 'file', path: 'report.md' }
  });
  repository.appendRunLog({ run: runTwo, type: 'run:created', message: 'created' });
  const system = repository.appendSystemLog({
    type: 'ticket:status_change',
    message: 'changed',
    metadata: { ticketId: runOne.ticketId, runId: runOne.id, changedBy: 'operator', agentId: 999 }
  });

  assert.equal(request.id, 1);
  assert.equal(request.runId, runOne.id, 'metadata must not replace authoritative run identity');
  assert.equal(write.id, 2);
  assert.equal(system.runId, null);
  assert.equal(system.ticketId, null);
  assert.equal(system.contextRunId, runOne.id);
  assert.equal(system.contextTicketId, runOne.ticketId);
  assert.equal(system.agentId, null);

  const newest = repository.listLogs({ limit: 2 });
  assert.deepEqual(newest.logs.map(log => log.id), [4, 3]);
  assert.equal(newest.nextBeforeId, 3);
  const older = repository.listLogs({ beforeId: newest.nextBeforeId, limit: 2 });
  assert.deepEqual(older.logs.map(log => log.id), [2, 1]);
  assert.equal(older.nextBeforeId, null);
  const ascending = repository.listLogs({ afterId: 0, order: 'asc', limit: 2 });
  assert.deepEqual(ascending.logs.map(log => log.id), [1, 2]);
  assert.equal(ascending.nextAfterId, 2);
  const ticketLogs = repository.listLogs({ ticketId: runOne.ticketId, limit: 3 });
  assert.deepEqual(ticketLogs.logs.map(log => log.id), [4, 2, 1]);
  const batched = repository.listLogsForRuns({ runIds: [runOne.id, runTwo.id], limitPerRun: 1 });
  assert.deepEqual(batched.map(log => log.id), [2, 3]);
  assert.equal(repository.hasRunLogType({ runId: runOne.id, type: 'model:request' }), true);
  assert.equal(repository.hasRunLogType({ runId: runTwo.id, type: 'model:request' }), false);

  const [firstMetric, secondMetric] = repository.getRunLogMetrics({ runIds: [runOne.id, runTwo.id] });
  assert.equal(firstMetric.totalTokensUsed, 5);
  assert.equal(firstMetric.totalModelRequests, 1);
  assert.equal(firstMetric.totalWorkspaceWrites, 1);
  assert.equal(firstMetric.totalWorkspaceActions, 1);
  assert.equal(secondMetric.totalModelRequests, 0);
  assert.throws(() => repository.listLogs({ limit: 4 }), /configured maximum/);
  assert.throws(() => repository.listLogs({ beforeId: 2, afterId: 1, limit: 1 }), /mutually exclusive/);

  repository.resetLogs();
  assert.deepEqual(logs, []);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getDiagnosticLogRepository().appendRunLog({'));
  assert.ok(serverSource.includes('getDiagnosticLogRepository().appendSystemLog({'));
  assert.ok(serverSource.includes('getDiagnosticLogRepository().listLogsForRuns({'));
  assert.ok(serverSource.includes('getRunLogMetrics: options => getDiagnosticLogRepository().getRunLogMetrics(options)'));
  const logPageStart = serverSource.indexOf('async function getPaginatedLogs(');
  const logPageEnd = serverSource.indexOf("\nfastify.get('/logs'", logPageStart);
  const logPageSource = serverSource.slice(logPageStart, logPageEnd);
  assert.ok(logPageSource.includes("order: 'desc'"));
  assert.ok(logPageSource.includes('beforeId'));
  assert.ok(!logPageSource.includes('readLogs()'));
  assert.ok(!logPageSource.includes('total'));

  console.log('PASS: diagnostic logs use append-only authority, bounded keyset reads, scoped batch projections, and aggregate metrics');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
