#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonPerformanceAnalyticsRepository,
  REQUIRED_PERFORMANCE_ANALYTICS_REPOSITORY_METHODS,
  assertPerformanceAnalyticsRepository
} = require('../persistence/json/performance-analytics-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const clone = value => structuredClone(value);
const tickets = [
  { id: 10, status: 'completed', objective: 'Write reports/one.txt' },
  { id: 20, status: 'in_progress', objective: 'Inspect reports' }
];
const runs = [
  { id: 1, ticketId: 10, agentId: 100, status: 'completed' },
  { id: 2, ticketId: 20, agentId: 100, status: 'running' },
  { id: 3, ticketId: 10, agentId: 200, status: 'failed' }
];
const operations = [
  { id: 1, runId: 1, operation: 'writeFile', args: { path: 'reports/one.txt' }, result: { path: 'reports/one.txt' }, outcome: 'succeeded' },
  { id: 2, runId: 1, operation: 'readFile', args: { path: 'reports/one.txt' }, outcome: 'succeeded' },
  { id: 3, runId: 2, operation: 'createFolder', args: { path: 'reports' }, result: { status: 'created', path: 'reports' }, outcome: 'succeeded' },
  { id: 4, runId: 2, operation: 'deletePath', args: { path: 'reports' }, error: 'refused', outcome: 'refused' },
  { id: 5, runId: 3, operation: 'renamePath', args: { path: 'a', nextPath: 'b' }, result: { path: 'b' }, outcome: 'succeeded' }
];
const replays = new Map([
  [1, { model: 'model-a', artifactPrediction: { artifacts: [{ type: 'file', artifact: 'reports/one.txt' }] } }],
  [2, { model: 'model-a' }]
]);
const metrics = new Map([
  [1, { runId: 1, totalTokensUsed: 7, totalWorkspaceActions: 1 }],
  [2, { runId: 2, totalTokensUsed: 0, totalWorkspaceActions: 1 }],
  [3, { runId: 3, totalTokensUsed: 2, totalWorkspaceActions: 1 }]
]);

function createRepository(overrides = {}) {
  return new JsonPerformanceAnalyticsRepository({
    readRuns: () => clone(runs),
    readTickets: () => clone(tickets),
    readOperationHistory: () => clone(operations),
    readReplaySnapshot: run => clone(replays.get(run.id) || null),
    getRunLogMetrics: async ({ runIds }) => runIds.map(runId => clone(metrics.get(runId))),
    maxQueryRows: 2,
    maxEvidenceRowsPerRun: 2,
    ...overrides
  });
}

async function main() {
  const repository = createRepository();
  assert.deepEqual(REQUIRED_PERFORMANCE_ANALYTICS_REPOSITORY_METHODS, [
    'listPerformanceRunEvidence'
  ]);
  assert.equal(assertPerformanceAnalyticsRepository(repository), repository);
  assert.equal(
    assertPerformanceAnalyticsRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the performance analytics contract'
  );
  assert.throws(() => assertPerformanceAnalyticsRepository({}), /must implement listPerformanceRunEvidence/);

  const first = await repository.listPerformanceRunEvidence({ limit: 2 });
  assert.deepEqual(first.evidence.map(item => item.run.id), [1, 2]);
  assert.equal(first.nextAfterRunId, 2);
  assert.equal(first.throughRunId, 3);
  assert.equal(first.evidence[0].ticket.objective, 'Write reports/one.txt');
  assert.equal(first.evidence[0].replaySnapshot.model, 'model-a');
  assert.deepEqual(first.evidence[0].operationHistory.map(item => item.id), [1]);
  assert.deepEqual(first.evidence[1].operationHistory.map(item => item.id), [3]);
  assert.equal(first.evidence[0].logMetrics.totalTokensUsed, 7);

  runs.push({ id: 4, ticketId: 10, agentId: 300, status: 'pending' });
  const second = await repository.listPerformanceRunEvidence({
    afterRunId: first.nextAfterRunId,
    throughRunId: first.throughRunId,
    limit: 2
  });
  assert.deepEqual(second.evidence.map(item => item.run.id), [3]);
  assert.equal(second.nextAfterRunId, null);
  assert.equal(second.evidence[0].replaySnapshot, null);
  assert.equal(second.throughRunId, first.throughRunId);
  runs.pop();
  await assert.rejects(repository.listPerformanceRunEvidence({ limit: 3 }), /configured maximum/);

  const overflowing = createRepository({
    readRuns: () => [clone(runs[0])],
    readOperationHistory: () => [clone(operations[0]), { ...clone(operations[0]), id: 6 }],
    maxEvidenceRowsPerRun: 1
  });
  await assert.rejects(
    overflowing.listPerformanceRunEvidence({ limit: 1 }),
    /performance operation evidence exceeds the configured maximum/
  );

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const metricStart = serverSource.indexOf('async function getPerformanceMetrics(');
  const metricEnd = serverSource.indexOf('\nasync function getTicketAssignableGroups(', metricStart);
  const metricSource = serverSource.slice(metricStart, metricEnd);
  for (const forbidden of [
    'readRuns()',
    'readTickets()',
    'readOperationHistory()',
    'readWorkflows()',
    'hydrateRunReplaySnapshots('
  ]) {
    assert.equal(metricSource.includes(forbidden), false, `metrics must not directly call ${forbidden}`);
  }
  assert.ok(serverSource.includes('getPerformanceAnalyticsRepository()'));
  assert.ok(serverSource.includes('repository.listPerformanceRunEvidence({ afterRunId, throughRunId, limit })'));
  assert.ok(serverSource.includes('getPerformanceMetrics(await listConfiguredAgentOptions())'));
  assert.equal(serverSource.includes('getPerformanceMetrics(readAgents())'), false);
  assert.equal(serverSource.includes('evidence.push(...page.evidence)'), false);
  assert.ok(serverSource.includes('run.routingSnapshot.selectedModel'));

  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  assert.ok(storeSource.includes('async listPerformanceRunEvidence({ afterRunId = 0, throughRunId = null, limit = 100 } = {})'));
  assert.ok(storeSource.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(storeSource.includes('CROSS JOIN LATERAL'));
  assert.ok(storeSource.includes('performance operation evidence exceeds the configured maximum'));
  assert.ok(storeSource.includes('COALESCE(MAX(id), 0)::bigint AS through_run_id'));
  assert.ok(storeSource.includes("LEFT JOIN ${this.table('run_evaluations')} AS evaluation"));
  const migration = fs.readFileSync(
    path.join(ROOT, 'persistence', 'postgres', 'migrations', '014_performance_analytics_reads.sql'),
    'utf8'
  );
  assert.ok(migration.includes('operation_receipts_run_performance_evidence_idx'));
  assert.ok(migration.includes("WHERE outcome = 'succeeded'"));

  console.log('PASS: performance analytics uses one bounded run/ticket/replay/operation/log evidence authority');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
