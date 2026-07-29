#!/usr/bin/env node
'use strict';

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { inspectDatabase } = require('./release-db-preflight');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('PROCESS_RELEASE_DATABASE_UNAVAILABLE: DATABASE_URL is required');
  }
  const schema = process.env.POSTGRES_SCHEMA || 'ticket_system';
  const store = new PostgresRuntimeStore({ connectionString, schema });
  let applied;
  try {
    applied = await store.migrate();
  } finally {
    await store.close();
  }
  const status = await inspectDatabase({ connectionString, schema });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema,
    applied,
    status
  })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
