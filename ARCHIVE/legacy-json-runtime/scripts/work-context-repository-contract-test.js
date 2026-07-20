#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonWorkContextRepository,
  REQUIRED_WORK_CONTEXT_REPOSITORY_METHODS,
  WorkContextConflictError,
  assertWorkContextRepository
} = require('../persistence/json/work-context-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const BASE_VALUE = Object.freeze({
  name: 'Legal Ops',
  purpose: 'Bound legal operations',
  status: 'active',
  defaultTargetId: null,
  defaultAuthorityProfileId: null,
  allowedTargetIds: [],
  allowedCapabilities: [],
  allowedProcessTemplateIds: [],
  defaultVerificationProfile: null,
  memoryPolicy: { mode: 'none' },
  visibilityPolicy: { mode: 'participants' },
  participants: [],
  ticketQueueFilter: {},
  triageQueueFilter: {},
  scheduleFilter: {}
});

function context(id, name, status = 'active', revision = 1) {
  return {
    id,
    ...structuredClone(BASE_VALUE),
    name,
    status,
    revision,
    createdBy: 'seed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'seed',
    updatedAt: '2026-07-01T00:00:00.000Z'
  };
}

function createHarness({ appendSystemLog = null, maxQueryRows = 2 } = {}) {
  let records = [context(1, 'Legal Ops'), context(2, 'Finance', 'archived')];
  const logs = [];
  const repository = new JsonWorkContextRepository({
    readWorkContexts: () => structuredClone(records),
    writeWorkContexts: value => { records = structuredClone(value); },
    appendSystemLog: appendSystemLog || (entry => {
      const log = { id: logs.length + 1, ...structuredClone(entry) };
      logs.push(log);
      return log;
    }),
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    maxQueryRows
  });
  return { repository, logs, records: () => structuredClone(records) };
}

async function main() {
  const { repository, logs, records } = createHarness();
  assert.deepEqual(REQUIRED_WORK_CONTEXT_REPOSITORY_METHODS, [
    'listWorkContexts',
    'getWorkContextById',
    'getWorkContextCounts',
    'createWorkContext',
    'updateWorkContext'
  ]);
  assert.equal(assertWorkContextRepository(repository), repository);
  assert.equal(
    assertWorkContextRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the Work Context catalog contract'
  );
  assert.throws(() => assertWorkContextRepository({}), /must implement listWorkContexts/);

  const first = await repository.listWorkContexts({ limit: 1 });
  assert.deepEqual(first.workContexts.map(item => item.id), [1]);
  assert.equal(first.nextAfterId, 1);
  const second = await repository.listWorkContexts({ afterId: first.nextAfterId, limit: 1 });
  assert.deepEqual(second.workContexts.map(item => item.id), [2]);
  assert.equal(second.nextAfterId, null);
  const active = await repository.listWorkContexts({ statuses: ['active'], limit: 2 });
  assert.deepEqual(active.workContexts.map(item => item.id), [1]);
  assert.equal((await repository.getWorkContextById(2)).name, 'Finance');
  assert.equal(await repository.getWorkContextById(999), null);
  assert.deepEqual(await repository.getWorkContextCounts(), { active: 1, archived: 1, total: 2 });
  await assert.rejects(repository.listWorkContexts({ limit: 3 }), /configured maximum/);

  const created = await repository.createWorkContext({ value: BASE_VALUE, changedBy: 'operator' });
  assert.equal(created.workContext.id, 3);
  assert.equal(created.workContext.revision, 1);
  assert.equal(created.workContext.createdAt, '2026-07-18T12:00:00.000Z');
  assert.equal(logs.at(-1).type, 'work_context:created');
  assert.equal(logs.at(-1).metadata.workContextId, 3);

  const updated = await repository.updateWorkContext({
    workContextId: 3,
    expectedRevision: 1,
    value: { ...BASE_VALUE, name: 'Legal Operations', status: 'archived' },
    changedBy: 'operator-2'
  });
  assert.equal(updated.workContext.revision, 2);
  assert.equal(updated.workContext.status, 'archived');
  assert.equal(updated.workContext.createdBy, 'operator');
  assert.equal(logs.at(-1).type, 'work_context:archived');
  await assert.rejects(
    repository.updateWorkContext({
      workContextId: 3,
      expectedRevision: 1,
      value: BASE_VALUE,
      changedBy: 'stale-operator'
    }),
    error => error instanceof WorkContextConflictError && error.current.revision === 2
  );

  const rollback = createHarness({ appendSystemLog: () => { throw new Error('audit unavailable'); } });
  const beforeRollback = rollback.records();
  await assert.rejects(
    rollback.repository.createWorkContext({ value: BASE_VALUE, changedBy: 'operator' }),
    /audit unavailable/
  );
  assert.deepEqual(rollback.records(), beforeRollback, 'JSON adapter restores the catalog if required audit evidence fails');
  assert.equal(records().length, 3);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getWorkContextRepository().listWorkContexts('));
  assert.ok(serverSource.includes('getWorkContextRepository().createWorkContext('));
  assert.ok(serverSource.includes('getWorkContextRepository().updateWorkContext('));
  assert.ok(serverSource.includes('getWorkContextRepository().getWorkContextCounts()'));
  assert.equal(serverSource.includes('function readWorkContexts()'), false);
  assert.equal(serverSource.includes('function writeWorkContexts('), false);
  assert.equal(serverSource.includes('nextId(contexts)'), false);

  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  assert.ok(storeSource.includes('async listWorkContexts({ afterId = 0, statuses = null, limit = 100 } = {})'));
  assert.ok(storeSource.includes("async getWorkContextById(workContextId)"));
  assert.ok(storeSource.includes('async getWorkContextCounts()'));
  assert.ok(storeSource.includes('async createWorkContext({ value, changedBy })'));
  assert.ok(storeSource.includes('async updateWorkContext({ workContextId, expectedRevision, value, changedBy })'));
  assert.ok(storeSource.includes("const auditLog = await this._appendSystemLog(client, {"));
  assert.ok(storeSource.includes("throw new OptimisticConcurrencyError('workContext', id, revision, previous)"));

  const migration = fs.readFileSync(
    path.join(ROOT, 'persistence', 'postgres', 'migrations', '015_work_context_catalog.sql'),
    'utf8'
  );
  assert.ok(migration.includes('CREATE TABLE work_contexts'));
  assert.ok(migration.includes('GENERATED ALWAYS AS IDENTITY'));
  assert.ok(migration.includes('work_contexts_status_id_idx'));
  assert.ok(migration.includes('work_contexts_revision_guard'));

  console.log('PASS: Work Context catalog uses bounded exact/cursor reads, aggregate counts, optimistic mutations, and coupled audit evidence');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
