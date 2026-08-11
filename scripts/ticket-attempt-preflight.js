#!/usr/bin/env node
'use strict';

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  inspectTicketAttemptBackfill
} = require('../persistence/postgres/ticket-attempt-backfill');
const { developmentConfig } = require('./dev-environment');

async function main() {
  const config = developmentConfig(process.env);
  const store = new PostgresRuntimeStore({
    connectionString: config.databaseUrl,
    schema: config.postgresSchema,
    maxConnections: 1
  });
  try {
    const result = await store.withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return inspectTicketAttemptBackfill(store, { client });
    });
    console.log('Ticket-attempt historical preflight PASS');
    console.log(`  Runs: ${result.runCount}`);
    console.log(`  legacy attempts: ${result.legacyAttemptCount}`);
    console.log(`  projected attempts: ${result.attemptCount}`);
    console.log(`  singleton non-plan: ${result.classifications.singleton_non_plan}`);
    console.log(`  v1 plan: ${result.classifications.v1_plan}`);
    console.log(`  historical v2 leaf-set: ${result.classifications.historical_v2_leaf_set}`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(`Ticket-attempt historical preflight REFUSED: ${error.code || error.name}: ${error.message}`);
  process.exit(1);
});
