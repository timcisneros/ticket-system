#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ConnectorConflictError,
  ConnectorIdConflictError,
  ConnectorReferenceError,
  assertConnectorAuthorityRepository
} = require('../persistence/connector-authority');
const { JsonConnectorAuthorityRepository } = require('../persistence/json/connector-authority-repository');

const ROOT = path.resolve(__dirname, '..');
const ISO = '2026-07-19T12:00:00.000Z';

function connectorValue(name, overrides = {}) {
  return {
    name,
    status: 'active',
    kind: 'local_mock',
    workContextId: 10,
    credentialRef: null,
    allowedScopes: ['read'],
    sourceRoots: ['inbox'],
    targetRoots: [],
    readPolicy: { mode: 'bounded' },
    writePolicy: { mode: 'disabled' },
    receiptPolicy: { mode: 'required' },
    syncPolicy: { mode: 'manual' },
    ...overrides
  };
}

function connectorRecord(id, name = `Connector ${id}`, overrides = {}) {
  return {
    id,
    ...connectorValue(name, overrides),
    revision: 1,
    createdBy: 'seed',
    createdAt: ISO,
    updatedBy: 'seed',
    updatedAt: ISO
  };
}

function receiptValue(connectorId, operation = 'read', overrides = {}) {
  const refused = operation !== 'read';
  return {
    connectorId,
    workContextId: 10,
    operation,
    sourceRef: operation === 'write_refused' ? null : 'inbox/item.txt',
    targetRef: operation === 'write_refused' ? 'outbox/item.txt' : null,
    externalObjectId: 'inbox/item.txt',
    ticketId: null,
    runId: null,
    actor: 'operator',
    request: { bounded: true },
    result: refused
      ? { status: 'refused', reason: 'policy' }
      : { status: 'ok', bytes: 7, hash: 'a'.repeat(64) },
    error: refused ? 'policy' : null,
    ...overrides
  };
}

function receiptRecord(id, connectorId, operation = 'read', overrides = {}) {
  return { id, ...receiptValue(connectorId, operation, overrides), timestamp: ISO };
}

function createQueue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function harness({
  connectors: initialConnectors = [],
  receipts: initialReceipts = [],
  workContexts = [{ id: 10, status: 'active' }, { id: 20, status: 'active' }, { id: 30, status: 'archived' }],
  appendSystemLog = async value => value
} = {}) {
  let connectors = structuredClone(initialConnectors);
  let receipts = structuredClone(initialReceipts);
  const repository = assertConnectorAuthorityRepository(new JsonConnectorAuthorityRepository({
    readConnectors: () => structuredClone(connectors),
    writeConnectors: value => { connectors = structuredClone(value); },
    readReceipts: () => structuredClone(receipts),
    writeReceipts: value => { receipts = structuredClone(value); },
    readWorkContexts: () => structuredClone(workContexts),
    appendSystemLog,
    queueMutation: createQueue(),
    now: () => new Date(ISO),
    maxQueryRows: 3
  }));
  return {
    repository,
    connectors: () => structuredClone(connectors),
    receipts: () => structuredClone(receipts)
  };
}

async function main() {
  const catalog = harness({
    connectors: [
      connectorRecord(4, 'Paused other', { status: 'paused', workContextId: 20 }),
      connectorRecord(1, 'Active first'),
      connectorRecord(3, 'Archived', { status: 'archived' }),
      connectorRecord(2, 'Active second')
    ],
    receipts: [
      receiptRecord(1, 1),
      receiptRecord(2, 1, 'write_refused'),
      receiptRecord(3, 2, 'read', {
        result: { status: 'failed', reason: 'missing' }, error: 'missing'
      }),
      receiptRecord(4, 1, 'read_refused')
    ]
  });

  const firstPage = await catalog.repository.listConnectors({ limit: 2 });
  assert.deepEqual(firstPage.connectors.map(item => item.id), [1, 2]);
  assert.equal(firstPage.nextAfterId, 2);
  const contextPage = await catalog.repository.listConnectors({
    afterId: firstPage.nextAfterId,
    statuses: ['active', 'archived'],
    workContextId: 10,
    limit: 2
  });
  assert.deepEqual(contextPage.connectors.map(item => item.id), [3]);
  assert.equal(contextPage.nextAfterId, null);
  assert.equal((await catalog.repository.getConnectorById(4)).name, 'Paused other');

  const receiptPage = await catalog.repository.listConnectorReceipts({ connectorId: 1, limit: 2 });
  assert.deepEqual(receiptPage.receipts.map(item => item.id), [4, 2]);
  assert.equal(receiptPage.nextBeforeId, 2);
  const olderReceipts = await catalog.repository.listConnectorReceipts({
    connectorId: 1,
    beforeId: receiptPage.nextBeforeId,
    limit: 2
  });
  assert.deepEqual(olderReceipts.receipts.map(item => item.id), [1]);
  assert.equal(olderReceipts.nextBeforeId, null);

  const summary = await catalog.repository.getConnectorOperationalSummary({ limit: 2 });
  assert.deepEqual(
    { active: summary.active, paused: summary.paused, archived: summary.archived, total: summary.total },
    { active: 2, paused: 1, archived: 1, total: 4 }
  );
  assert.deepEqual(summary.recentReceipts.map(item => item.id), [4, 3]);
  assert.deepEqual(summary.recentRefusals.map(item => item.id), [4, 3]);
  assert.equal(summary.hasReadRefusals, true);

  const mutations = harness({ connectors: [connectorRecord(1, 'Existing')] });
  const created = await mutations.repository.createConnector({
    value: connectorValue('Created'),
    changedBy: 'operator',
    audit: { type: 'connector:created', message: 'created', metadata: {} }
  });
  assert.equal(created.connector.id, 2);
  assert.equal(created.connector.revision, 1);
  assert.equal(created.auditLog.metadata.connectorId, 2);
  const updated = await mutations.repository.updateConnector({
    connectorId: 2,
    expectedRevision: 1,
    value: connectorValue('Paused', { status: 'paused' }),
    changedBy: 'reviewer',
    audit: { type: 'connector:updated', message: 'updated', metadata: {} }
  });
  assert.equal(updated.connector.revision, 2);
  assert.equal(updated.connector.createdBy, 'operator');
  assert.equal(updated.connector.updatedBy, 'reviewer');
  await assert.rejects(
    mutations.repository.updateConnector({
      connectorId: 2,
      expectedRevision: 1,
      value: connectorValue('Stale'),
      changedBy: 'stale'
    }),
    error => error instanceof ConnectorConflictError && error.current.revision === 2
  );

  const appended = await mutations.repository.appendConnectorReceipt({
    value: receiptValue(2, 'write_refused'),
    audit: { type: 'connector:write_refused', message: 'refused', metadata: {} }
  });
  assert.equal(appended.receipt.id, 1);
  assert.equal(appended.receipt.timestamp, ISO);
  assert.equal(appended.auditLog.metadata.receiptId, 1);

  await assert.rejects(
    mutations.repository.createConnector({
      value: connectorValue('Inactive context', { workContextId: 30 }),
      changedBy: 'operator'
    }),
    error => error instanceof ConnectorReferenceError && error.code === 'WORK_CONTEXT_NOT_ACTIVE'
  );
  await assert.rejects(
    mutations.repository.appendConnectorReceipt({
      value: receiptValue(2, 'read', { workContextId: 20 })
    }),
    error => error instanceof ConnectorReferenceError && error.code === 'CONNECTOR_WORK_CONTEXT_MISMATCH'
  );
  await assert.rejects(
    mutations.repository.appendConnectorReceipt({ value: receiptValue(999) }),
    error => error instanceof ConnectorReferenceError && error.code === 'CONNECTOR_NOT_FOUND'
  );
  await assert.rejects(
    mutations.repository.appendConnectorReceipt({
      value: receiptValue(2, 'read', { request: { bounded: true, content: 'secret' } })
    }),
    /content is not allowed/
  );

  const catalogRollback = harness({
    connectors: [connectorRecord(1, 'Rollback')],
    appendSystemLog: async () => { throw new Error('audit unavailable'); }
  });
  await assert.rejects(
    catalogRollback.repository.updateConnector({
      connectorId: 1,
      expectedRevision: 1,
      value: connectorValue('Should roll back'),
      changedBy: 'operator',
      audit: { type: 'connector:updated', message: 'updated', metadata: {} }
    }),
    /audit unavailable/
  );
  assert.equal(catalogRollback.connectors()[0].name, 'Rollback');
  assert.equal(catalogRollback.connectors()[0].revision, 1);

  const receiptRollback = harness({
    connectors: [connectorRecord(1)],
    receipts: [receiptRecord(1, 1)],
    appendSystemLog: async () => { throw new Error('receipt audit unavailable'); }
  });
  await assert.rejects(
    receiptRollback.repository.appendConnectorReceipt({
      value: receiptValue(1, 'read_refused'),
      audit: { type: 'connector:read_refused', message: 'refused', metadata: {} }
    }),
    /receipt audit unavailable/
  );
  assert.deepEqual(receiptRollback.receipts().map(item => item.id), [1]);

  const concurrent = harness({ connectors: [connectorRecord(1, 'Concurrent')] });
  const race = await Promise.allSettled([
    concurrent.repository.updateConnector({
      connectorId: 1, expectedRevision: 1, value: connectorValue('Winner one'), changedBy: 'one'
    }),
    concurrent.repository.updateConnector({
      connectorId: 1, expectedRevision: 1, value: connectorValue('Winner two'), changedBy: 'two'
    })
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter(item => item.status === 'rejected').length, 1);

  const duplicateConnector = harness({ connectors: [connectorRecord(1), connectorRecord(1, 'Duplicate')] });
  await assert.rejects(
    duplicateConnector.repository.listConnectors({ limit: 1 }),
    error => error instanceof ConnectorIdConflictError && error.entity === 'connector'
  );
  const duplicateReceipt = harness({
    connectors: [connectorRecord(1)],
    receipts: [receiptRecord(1, 1), receiptRecord(1, 1)]
  });
  await assert.rejects(
    duplicateReceipt.repository.listConnectorReceipts({ limit: 1 }),
    error => error instanceof ConnectorIdConflictError && error.entity === 'connector receipt'
  );
  const incompleteConnector = harness({ connectors: [{ id: 1, name: 'Old shape', status: 'active' }] });
  await assert.rejects(
    incompleteConnector.repository.listConnectors({ limit: 1 }),
    /missing current-format field/
  );
  const incompleteReceipt = harness({
    connectors: [connectorRecord(1)],
    receipts: [{ id: 1, connectorId: 1, operation: 'read' }]
  });
  await assert.rejects(
    incompleteReceipt.repository.listConnectorReceipts({ limit: 1 }),
    /missing current-format field/
  );
  await assert.rejects(catalog.repository.listConnectors({ limit: 4 }), /configured maximum/);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const cliSource = fs.readFileSync(path.join(ROOT, 'scripts', 'oquery.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  const methodSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'connector-authority-methods.js'), 'utf8');
  const migrationSource = fs.readFileSync(
    path.join(ROOT, 'persistence', 'postgres', 'migrations', '022_connector_authority.sql'),
    'utf8'
  );
  assert.equal(serverSource.includes('function readConnectors()'), false);
  assert.equal(serverSource.includes('function writeConnectors('), false);
  assert.equal(serverSource.includes('function appendConnectorReceipt('), false);
  assert.ok(serverSource.includes('getConnectorOperationalSummary({'));
  assert.ok(serverSource.includes('expectedRevision ?? request.body.revision'));
  assert.ok(cliSource.includes('Connector API returned a non-advancing cursor'));
  assert.ok(cliSource.includes('const body = { expectedRevision: current.revision };'));
  assert.ok(storeSource.includes('installConnectorAuthorityMethods(PostgresRuntimeStore'));
  assert.ok(methodSource.includes("WHERE id = $1 FOR UPDATE"));
  assert.ok(methodSource.includes('WHERE id = $1 FOR SHARE'));
  assert.ok(methodSource.includes('this._appendSystemLog(client'));
  assert.ok(methodSource.includes("this.table('connector_status_counts')"));
  assert.ok(migrationSource.includes('CREATE TABLE connectors'));
  assert.ok(migrationSource.includes('CREATE TABLE connector_status_counts'));
  assert.ok(migrationSource.includes('CONSTRAINT connector_status_counts_identity'));
  assert.ok(migrationSource.includes('CREATE TRIGGER connectors_status_count'));
  assert.ok(migrationSource.includes('CREATE TABLE connector_receipts'));
  assert.ok(migrationSource.includes('CREATE INDEX connector_receipts_refusal_id_desc_idx'));
  assert.ok(migrationSource.includes('CONSTRAINT connector_receipts_connector_context_fk'));
  assert.ok(migrationSource.includes('CREATE TRIGGER connector_receipts_append_only'));
  assert.ok(migrationSource.includes('no JSON importer or legacy branch is provided'));

  console.log('PASS: connector authority repository — strict current-format catalog and receipts, bounded indexed reads, fixed-work PostgreSQL counts, optimistic audited mutations, append-only evidence, and Work Context references');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
