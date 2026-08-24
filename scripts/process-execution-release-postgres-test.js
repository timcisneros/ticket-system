#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');

const { withHarness } = require('./postgres-test-harness');
const {
  buildProcessExecutionReleaseContract
} = require('../runtime/process-execution-release-contract');
const { inspectDatabase } = require('./release-db-preflight');

async function main() {
  await withHarness('process execution release authority PostgreSQL', async ({
    store,
    databaseUrl,
    schema
  }) => {
    // T2 Tranche 5: the migration head is now the five-state cutover (041).
    const migration = await store.getMigrationStatus();
    assert.equal(migration.currentVersion, 41);
    assert.equal(migration.headVersion, 41);
    assert.equal(migration.fullyApplied, true);
    assert.equal(migration.checksumsValid, true);
    assert.equal(migration.unknownMigrations, 0);
    const preflight = await inspectDatabase({
      connectionString: databaseUrl,
      schema
    });
    assert.equal(preflight.currentVersion, 41);
    assert.equal(preflight.fullyApplied, true,
      'production migration preflight accepts the isolated fully migrated schema');

    const initial = await store.getProcessExecutionReleaseState();
    assert.equal(initial.admissionEnabled, false);
    const contract = buildProcessExecutionReleaseContract({
      applicationVersion: '1.1.1',
      sourceRevision: 'a'.repeat(40)
    });
    const enabled = await store.setProcessExecutionAdmission({
      enabled: true,
      releaseContractHash: contract.releaseContractHash,
      sourceRevision: contract.sourceRevision,
      applicationVersion: contract.applicationVersion,
      changedBy: 'release-postgres-test',
      reason: 'validated canary release'
    });
    assert.equal(enabled.changed, true);
    assert.equal(enabled.state.admissionEnabled, true);
    const exact = await store.setProcessExecutionAdmission({
      enabled: true,
      releaseContractHash: contract.releaseContractHash,
      sourceRevision: contract.sourceRevision,
      applicationVersion: contract.applicationVersion,
      changedBy: 'release-postgres-test',
      reason: 'exact retry'
    });
    assert.equal(exact.changed, false);
    const disabled = await store.setProcessExecutionAdmission({
      enabled: false,
      changedBy: 'release-postgres-test',
      reason: 'operational kill switch'
    });
    assert.equal(disabled.state.admissionEnabled, false);
    assert.equal(disabled.state.releaseContractHash, contract.releaseContractHash,
      'kill switch preserves the release generation for recovery');
    assert.equal((await store.getProcessExecutionReleaseState()).admissionEnabled, false,
      'kill switch is restart-durable PostgreSQL authority');

    const logs = await store.pool.query(
      `SELECT type
       FROM ${store.table('diagnostic_logs')}
       WHERE type LIKE 'process_release:%'
       ORDER BY id`
    );
    assert.deepEqual(logs.rows.map(row => row.type), [
      'process_release:admission_enabled',
      'process_release:admission_disabled'
    ]);
    const metrics = await store.getProcessReleaseOperationalMetrics();
    assert.equal(metrics.activeOperations, 0);
    assert.equal(metrics.operationsAwaitingReceipts, 0);

    await store.pool.query(
      `ALTER TABLE ${store.table('schema_migration_identities')}
       DISABLE TRIGGER schema_migration_identities_append_only`
    );
    await store.pool.query(
      `UPDATE ${store.table('schema_migration_identities')}
       SET sha256 = $2
       WHERE version = $1`,
      ['001_runtime_core.sql', '0'.repeat(64)]
    );
    await store.pool.query(
      `ALTER TABLE ${store.table('schema_migration_identities')}
       ENABLE TRIGGER schema_migration_identities_append_only`
    );
    const corrupted = await store.getMigrationStatus();
    assert.equal(corrupted.checksumsValid, false,
      'changed historical migration identity fails closed');
    assert.equal(corrupted.fullyApplied, false);
    await assert.rejects(
      store.prepareRuntimePersistence(),
      error => Boolean(error && error.code === 'POSTGRES_RUNTIME_INTEGRITY_FAILURE'),
      'startup rejects a historical migration checksum mismatch'
    );
  });
}

main().then(() => {
  console.log('PASS: process execution release authority PostgreSQL');
}).catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
