#!/usr/bin/env node
'use strict';

const {
  DEVELOPMENT_TARGET_SCHEMA,
  applyLocalEnv,
  disposableDevelopmentTarget,
  safeErrorMessage
} = require('./dev-environment');
const {
  prepareAndMigrateDisposableDevelopmentDatabase
} = require('./dev-database');
const { runDoctor } = require('./dev-doctor');

async function main() {
  process.env.NODE_ENV = 'development';
  // P6-S2: the runner no longer injects its own WORKSPACE_ROOT/ARTIFACT_ROOT
  // defaults. The one canonical default for each effect root is owned by the
  // registry (runtime/environment-config-registry.js) and resolved
  // identically by the server boot surface and the development tooling, so a
  // `pnpm dev` session and an ordinary server cannot disagree about an effect
  // boundary. An explicit WORKSPACE_ROOT/ARTIFACT_ROOT keeps its precedence.
  applyLocalEnv();

  // P6-DEVEX-A: the daily dev command targets the fixed repository-owned
  // disposable development database (collision-guarded, bundled-compose
  // verified, created, and migrated; scripts/dev-environment.js owns the
  // identity, and scripts/dev-database.js owns the verified lifecycle and the
  // single disposable-migration construction site). DATABASE_URL cannot
  // redirect it; the configured DATABASE_URL remains the operational target.
  const prepared = await prepareAndMigrateDisposableDevelopmentDatabase();
  const { devTarget, appliedVersions } = prepared;

  // The disposable migration already happened inside the verified lifecycle
  // (compose ownership proven BEFORE the authority-bearing store was ever
  // constructed). Migrate first so the server starts on a current schema and
  // the doctor below reports the truthful ledger state.
  console.log(appliedVersions.length
    ? `Disposable development database ${devTarget.database} migrated to source head: ${appliedVersions.join(', ')}`
    : `Disposable development database ${devTarget.database} is current.`);

  // Readiness diagnosis against the dev target happens BEFORE the server env
  // override so the informational operational row still describes the
  // configured DATABASE_URL instead of the dev identity about to be countersigned.
  const ready = await runDoctor();
  if (!ready) {
    console.error('Startup stopped before mutation work. Run pnpm dev:setup or pnpm dev:doctor for guidance.');
    process.exit(1);
  }

  // server.js reads DATABASE_URL/POSTGRES_SCHEMA directly from its process
  // environment: the dev session points it at the FIXED development identity.
  // No environment or CLI input can select a different one.
  const target = disposableDevelopmentTarget(process.env);
  process.env.DATABASE_URL = target.databaseUrl;
  process.env.POSTGRES_SCHEMA = DEVELOPMENT_TARGET_SCHEMA;

  require('../server');
}

main().catch(error => {
  console.error(`Development startup failed: ${safeErrorMessage(error)}`);
  process.exit(1);
});
