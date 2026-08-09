#!/usr/bin/env node
'use strict';

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { developmentConfig } = require('./dev-environment');

async function main() {
  const config = developmentConfig(process.env);

  const store = new PostgresRuntimeStore({
    connectionString: config.databaseUrl,
    schema: config.postgresSchema
  });
  try {
    const applied = await store.migrate();
    if (applied.length === 0) {
      console.log(`PostgreSQL schema ${store.schema} is current`);
      return;
    }
    console.log(`Applied ${applied.length} PostgreSQL migration(s) to schema ${store.schema}: ${applied.join(', ')}`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`PostgreSQL migration failed: ${error.message}`);
  process.exit(1);
});
