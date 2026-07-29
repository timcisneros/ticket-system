#!/usr/bin/env node
'use strict';

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  ProcessLauncherFoundationClient
} = require('../runtime/process-launcher-foundation-client');
const {
  PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH
} = require('../runtime/process-launcher-foundation-contract');
const {
  compactEligibleLauncherOperations
} = require('../runtime/process-launcher-retention');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const store = new PostgresRuntimeStore({
    connectionString: process.env.DATABASE_URL,
    schema: process.env.POSTGRES_SCHEMA || 'ticket_system'
  });
  const launcher = new ProcessLauncherFoundationClient({
    version: 1,
    socketPath: process.env.PROCESS_LAUNCHER_SOCKET_PATH ||
      PROCESS_LAUNCHER_FOUNDATION_DEFAULT_SOCKET_PATH,
    timeoutMs: 30_000
  });
  try {
    await store.prepareRuntimePersistence();
    const result = await compactEligibleLauncherOperations({
      repository: store,
      launcherClient: launcher,
      limit: 100
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.code || 'PROCESS_LAUNCHER_RETENTION_FAILED'}: ${
    error.message
  }\n`);
  process.exitCode = 1;
});
