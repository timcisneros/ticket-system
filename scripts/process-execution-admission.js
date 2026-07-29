#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  buildProcessExecutionReleaseContract
} = require('../runtime/process-execution-release-contract');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

function parseArguments(argv) {
  const options = {
    enabled: null,
    actor: null,
    reason: null,
    sourceRevision: process.env.PROCESS_EXECUTION_SOURCE_REVISION || null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--enable') options.enabled = true;
    else if (argument === '--disable') options.enabled = false;
    else if (argument === '--actor') options.actor = argv[++index];
    else if (argument === '--reason') options.reason = argv[++index];
    else if (argument === '--source-revision') {
      options.sourceRevision = argv[++index];
    } else {
      throw new Error(`Unknown process admission argument: ${argument}`);
    }
  }
  if (options.enabled === null) throw new Error('Use exactly one of --enable or --disable');
  if (!options.actor) throw new Error('--actor is required for audited admission changes');
  if (!options.reason) throw new Error('--reason is required for audited admission changes');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'package.json'),
    'utf8'
  ));
  let contract = null;
  if (options.enabled) {
    contract = buildProcessExecutionReleaseContract({
      applicationVersion: packageJson.version,
      sourceRevision: options.sourceRevision
    });
  }
  const store = new PostgresRuntimeStore({
    connectionString,
    schema: process.env.POSTGRES_SCHEMA || 'ticket_system'
  });
  try {
    const migration = await store.getMigrationStatus();
    if (!migration.fullyApplied || !migration.checksumsValid) {
      throw new Error(
        'PROCESS_RELEASE_SCHEMA_INCOMPATIBLE: admission change refused'
      );
    }
    const result = await store.setProcessExecutionAdmission({
      enabled: options.enabled,
      releaseContractHash: contract && contract.releaseContractHash,
      sourceRevision: contract && contract.sourceRevision,
      applicationVersion: contract && contract.applicationVersion,
      changedBy: options.actor,
      reason: options.reason
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      changed: result.changed,
      state: result.state
    })}\n`);
  } finally {
    await store.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
