'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RuntimeLimitsConflictError,
  assertRuntimeLimitsRepository,
  normalizeRuntimeLimitsConfig
} = require('../persistence/runtime-limits');
const { JsonRuntimeLimitsRepository } = require('../persistence/json/runtime-limits-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const INITIAL = Object.freeze({
  maxExecutionSteps: null,
  maxModelRequestsPerRun: null,
  maxWorkspaceOperationsPerRun: null,
  maxRuntimeDurationMs: null,
  maxActiveRuns: null,
  localModelConcurrency: null,
  revision: 1,
  updatedBy: null,
  updatedAt: null
});
const VALUES = Object.freeze({
  maxExecutionSteps: 8,
  maxModelRequestsPerRun: 6,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 30000,
  maxActiveRuns: 24,
  localModelConcurrency: 4
});

function clone(value) { return structuredClone(value); }

function fixture({ failEvent = false } = {}) {
  let stored = clone(INITIAL);
  const writes = [];
  const events = [];
  const logs = [];
  const repository = new JsonRuntimeLimitsRepository({
    readConfig: () => clone(stored),
    writeConfig: value => {
      stored = clone(value);
      writes.push(clone(value));
    },
    appendEvent: async event => {
      if (failEvent) throw new Error('event admission refused');
      events.push(clone(event));
      return event;
    },
    appendSystemLog: async log => {
      logs.push(clone(log));
      return log;
    },
    now: () => new Date('2026-07-19T12:00:00.000Z')
  });
  return { repository, events, logs, writes, stored: () => clone(stored) };
}

async function main() {
  assert.throws(() => assertRuntimeLimitsRepository({}), /getRuntimeLimitsConfig/);
  assert.ok(
    assertRuntimeLimitsRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    'Postgres store must implement the runtime-limit repository contract'
  );
  assert.throws(
    () => normalizeRuntimeLimitsConfig({ ...INITIAL, revision: undefined }),
    /positive safe integer/
  );
  const missingRevision = clone(INITIAL);
  delete missingRevision.revision;
  assert.throws(() => normalizeRuntimeLimitsConfig(missingRevision), /missing current-format field: revision/);
  assert.throws(
    () => normalizeRuntimeLimitsConfig({ ...INITIAL, updatedBy: 'admin', updatedAt: null }),
    /must both be null or both be set/
  );

  const state = fixture();
  const initial = await state.repository.getRuntimeLimitsConfig();
  assert.deepStrictEqual(initial, INITIAL);
  const result = await state.repository.updateRuntimeLimitsConfig({
    expectedRevision: 1,
    value: VALUES,
    changedBy: 'admin'
  });
  assert.equal(result.config.revision, 2);
  assert.equal(result.config.updatedBy, 'admin');
  assert.equal(result.config.updatedAt, '2026-07-19T12:00:00.000Z');
  assert.deepStrictEqual(
    Object.fromEntries(Object.keys(VALUES).map(key => [key, result.config[key]])),
    VALUES
  );
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'runtime_limits.updated');
  assert.equal(state.events[0].payload.revision, 2);
  assert.deepStrictEqual(state.events[0].payload.oldValues, Object.fromEntries(Object.keys(VALUES).map(key => [key, null])));
  assert.deepStrictEqual(state.events[0].payload.newValues, VALUES);
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0].metadata.actor, 'admin');

  await assert.rejects(
    state.repository.updateRuntimeLimitsConfig({ expectedRevision: 1, value: VALUES, changedBy: 'stale-admin' }),
    error => error instanceof RuntimeLimitsConflictError && error.current.revision === 2
  );
  assert.equal(state.stored().revision, 2, 'stale writes must not change authority');

  const concurrent = fixture();
  const attempts = await Promise.allSettled([
    concurrent.repository.updateRuntimeLimitsConfig({ expectedRevision: 1, value: VALUES, changedBy: 'one' }),
    concurrent.repository.updateRuntimeLimitsConfig({
      expectedRevision: 1,
      value: { ...VALUES, maxExecutionSteps: 9 },
      changedBy: 'two'
    })
  ]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(item => item.status === 'rejected' && item.reason instanceof RuntimeLimitsConflictError).length, 1);
  assert.equal(concurrent.stored().revision, 2);

  const refused = fixture({ failEvent: true });
  await assert.rejects(
    refused.repository.updateRuntimeLimitsConfig({ expectedRevision: 1, value: VALUES, changedBy: 'admin' }),
    /event admission refused/
  );
  assert.deepStrictEqual(refused.stored(), INITIAL, 'evidence refusal must restore JSON policy authority');
  assert.equal(refused.logs.length, 0);

  await assert.rejects(
    fixture().repository.updateRuntimeLimitsConfig({
      expectedRevision: 1,
      value: { ...VALUES, unsupportedLimit: 1 },
      changedBy: 'admin'
    }),
    /Unsupported runtime limits value field: unsupportedLimit/
  );

  await assert.rejects(
    fixture().repository.updateRuntimeLimitsConfig({
      expectedRevision: 1,
      value: { ...VALUES, maxRuntimeDurationMs: 4999 },
      changedBy: 'admin'
    }),
    /must be at least 5000/
  );

  const migration = fs.readFileSync(path.join(ROOT, 'persistence/postgres/migrations/024_runtime_limit_config.sql'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence/postgres/store.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(migration, /CREATE TABLE runtime_limit_config/);
  assert.match(migration, /runtime_limit_config_singleton/);
  assert.match(migration, /runtime_limit_config_revision_guard/);
  assert.match(migration, /no JSON importer or legacy branch/i);
  assert.match(storeSource, /installRuntimeLimitsMethods\(PostgresRuntimeStore\)/);
  assert.match(storeSource, /'runtime_limit_config'/);
  assert.ok(!serverSource.includes('function readRuntimeLimitsConfig('), 'server consumers must not retain direct JSON authority reads');
  assert.match(serverSource, /getRuntimeLimitsRepository\(\)\.getRuntimeLimitsConfig\(\)/);
  assert.match(serverSource, /expectedRevision must be a positive integer/);

  console.log('PASS: runtime-limit policy is strict, revisioned, audited, serialized, and repository-owned');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
