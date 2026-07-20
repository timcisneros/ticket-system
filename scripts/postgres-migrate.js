#!/usr/bin/env node
'use strict';

const { PostgresRuntimeStore } = require('../persistence/postgres/store');

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const store = new PostgresRuntimeStore({
    connectionString,
    schema: process.env.POSTGRES_SCHEMA || 'ticket_system'
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
