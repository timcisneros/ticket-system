#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonRuntimeBootstrapRepository,
  REQUIRED_RUNTIME_BOOTSTRAP_REPOSITORY_METHODS,
  assertRuntimeBootstrapRepository
} = require('../persistence/json/runtime-bootstrap-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

async function main() {
  assert.deepEqual(REQUIRED_RUNTIME_BOOTSTRAP_REPOSITORY_METHODS, [
    'acquireRuntimeAuthority',
    'prepareRuntimePersistence',
    'refreshRuntimeAuthority',
    'releaseRuntimeAuthority'
  ]);
  assert.equal(
    assertRuntimeBootstrapRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the runtime bootstrap contract'
  );
  assert.throws(() => assertRuntimeBootstrapRepository({}), /must implement acquireRuntimeAuthority/);

  const calls = [];
  const repository = new JsonRuntimeBootstrapRepository({
    acquireAuthority: () => {
      calls.push('acquire');
      return { acquired: true, lock: { pid: 42, dataDir: '/tmp/runtime-data' } };
    },
    startAuthorityHeartbeat: () => { calls.push('heartbeat'); },
    initializeRuntimeData: async () => { calls.push('initialize'); },
    verifyRuntimeIntegrity: async () => {
      calls.push('integrity');
      return { eventCount: 7, runChainCount: 2 };
    },
    refreshAuthority: () => { calls.push('refresh'); },
    releaseAuthority: () => { calls.push('release'); }
  });
  assert.equal(assertRuntimeBootstrapRepository(repository), repository);
  await assert.rejects(repository.prepareRuntimePersistence(), error => {
    return error && error.code === 'RUNTIME_AUTHORITY_REQUIRED';
  });

  const authority = await repository.acquireRuntimeAuthority();
  assert.equal(authority.mode, 'exclusive_writer');
  assert.equal((await repository.acquireRuntimeAuthority()).owner.pid, 42);
  const prepared = await repository.prepareRuntimePersistence();
  assert.deepEqual(prepared, {
    backend: 'json',
    authorityMode: 'exclusive_writer',
    eventCount: 7,
    runChainCount: 2
  });
  await repository.refreshRuntimeAuthority();
  assert.equal(await repository.releaseRuntimeAuthority(), true);
  assert.equal(await repository.releaseRuntimeAuthority(), false);
  assert.deepEqual(calls, ['acquire', 'heartbeat', 'initialize', 'integrity', 'refresh', 'release']);

  const conflictRepository = new JsonRuntimeBootstrapRepository({
    acquireAuthority: () => ({ acquired: false, lock: { pid: 99, dataDir: '/tmp/owned' } }),
    startAuthorityHeartbeat: () => {},
    initializeRuntimeData: () => {},
    verifyRuntimeIntegrity: () => {},
    refreshAuthority: () => {},
    releaseAuthority: () => {}
  });
  await assert.rejects(conflictRepository.acquireRuntimeAuthority(), error => {
    return error && error.code === 'RUNTIME_AUTHORITY_CONFLICT' && error.owner.pid === 99;
  });

  const migrations = fs.readdirSync(path.join(__dirname, '..', 'persistence', 'postgres', 'migrations'))
    .filter(name => name.endsWith('.sql'))
    .sort();
  const postgresQueries = [];
  const client = {
    async query(sql) {
      postgresQueries.push(sql);
      if (sql.includes('unnest($2::text[])')) return { rows: [], rowCount: 0 };
      if (sql.includes('to_regclass')) return { rows: [{ name: 'ticket_system.schema_migrations' }], rowCount: 1 };
      if (sql.includes('SELECT version FROM')) {
        return { rows: migrations.map(version => ({ version })), rowCount: migrations.length };
      }
      if (sql.includes('FROM "ticket_system"."events"')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM "ticket_system"."run_event_chain_tips"')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() { postgresQueries.push('release-client'); }
  };
  const postgres = new PostgresRuntimeStore({
    pool: {
      query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }),
      connect: async () => client
    }
  });
  assert.equal((await postgres.acquireRuntimeAuthority()).mode, 'shared_transactional');
  const postgresPrepared = await postgres.prepareRuntimePersistence();
  assert.equal(postgresPrepared.migrationCount, migrations.length);
  assert.equal(postgresPrepared.checkedRelationCount, 34);
  assert.equal(postgresPrepared.checkedIntegrityArtifactCount, 182);
  assert.equal(postgresPrepared.integrityMode, 'transactional_constraints');
  assert.ok(postgresQueries.includes('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(postgresQueries.includes('COMMIT'));
  assert.equal(postgresQueries.some(sql => String(sql).includes('CREATE SCHEMA')), false,
    'runtime startup must not apply migrations implicitly');
  assert.equal(postgresQueries.some(sql => String(sql).includes('FROM "ticket_system"."events"')), false,
    'each PostgreSQL process startup must not rescan deployment history');

  const driftQueries = [];
  const driftClient = {
    async query(sql) {
      driftQueries.push(sql);
      if (sql.includes('required.trigger_name')) {
        return { rows: [{ trigger_name: 'events_append_only' }], rowCount: 1 };
      }
      if (sql.includes('unnest($2::text[])')) return { rows: [], rowCount: 0 };
      if (sql.includes('to_regclass')) return { rows: [{ name: 'ticket_system.schema_migrations' }], rowCount: 1 };
      if (sql.includes('SELECT version FROM')) {
        return { rows: migrations.map(version => ({ version })), rowCount: migrations.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release() { driftQueries.push('release-client'); }
  };
  const driftedPostgres = new PostgresRuntimeStore({
    pool: {
      query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }),
      connect: async () => driftClient
    }
  });
  await assert.rejects(driftedPostgres.prepareRuntimePersistence(), error => {
    return error && error.code === 'POSTGRES_RUNTIME_INTEGRITY_FAILURE' &&
      error.storeName === 'runtime_schema' && /events_append_only/.test(error.message);
  });
  assert.ok(driftQueries.includes('ROLLBACK'));
  assert.ok(driftQueries.includes('release-client'));

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getRuntimeBootstrapRepository()'));
  assert.ok(serverSource.includes('await bootstrapRepository.acquireRuntimeAuthority()'));
  assert.ok(serverSource.includes('await bootstrapRepository.prepareRuntimePersistence()'));
  assert.ok(serverSource.includes('await getRuntimeBootstrapRepository().refreshRuntimeAuthority()'));
  assert.ok(serverSource.includes('await getRuntimeBootstrapRepository().releaseRuntimeAuthority()'));

  console.log('PASS: startup authority, preparation, integrity verification, reset refresh, and shutdown use one backend-neutral repository contract');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
