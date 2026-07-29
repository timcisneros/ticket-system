#!/usr/bin/env node
'use strict';

const {
  PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION
} = require('../runtime/process-execution-release-contract');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

async function inspectDatabase({
  connectionString = process.env.DATABASE_URL,
  schema = process.env.POSTGRES_SCHEMA || 'ticket_system'
} = {}) {
  if (typeof connectionString !== 'string' || !connectionString.trim()) {
    throw new Error('PROCESS_RELEASE_DATABASE_UNAVAILABLE: DATABASE_URL is required');
  }
  const store = new PostgresRuntimeStore({ connectionString, schema });
  try {
    const status = await store.getMigrationStatus();
    if (status.headVersion !== PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION ||
        status.fullyApplied !== true ||
        status.checksumsValid !== true ||
        status.partial !== false ||
        status.pendingMigrations !== 0 ||
        status.unknownMigrations !== 0) {
      const error = new Error(
        'PROCESS_RELEASE_SCHEMA_INCOMPATIBLE: migration preflight failed'
      );
      error.status = status;
      throw error;
    }
    await store.prepareRuntimePersistence();
    return status;
  } finally {
    await store.close();
  }
}

async function main() {
  const status = await inspectDatabase();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: process.env.POSTGRES_SCHEMA || 'ticket_system',
    status
  })}\n`);
}

module.exports = { inspectDatabase };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    if (error.status) process.stderr.write(`${JSON.stringify(error.status)}\n`);
    process.exitCode = 1;
  });
}
