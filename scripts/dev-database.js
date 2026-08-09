#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const {
  applyLocalEnv,
  resolveDevelopmentDatabaseTarget,
  safeErrorMessage,
} = require('./dev-environment');

const ROOT = path.resolve(__dirname, '..');
const COMPOSE_FILE = path.join(ROOT, 'compose.dev.yml');
const COMPOSE_RUNTIMES = Object.freeze([
  { command: 'docker', prefix: ['compose'], label: 'Docker Compose' },
  { command: 'podman', prefix: ['compose'], label: 'Podman Compose' },
  { command: 'docker-compose', prefix: [], label: 'Docker Compose' },
  { command: 'podman-compose', prefix: [], label: 'Podman Compose' }
]);

function commandSucceeded(result) {
  return Boolean(result) && !result.error && result.status === 0;
}

function selectComposeRuntime({ spawn = spawnSync } = {}) {
  for (const runtime of COMPOSE_RUNTIMES) {
    const result = spawn(runtime.command, [...runtime.prefix, 'version'], {
      encoding: 'utf8',
      stdio: 'pipe'
    });
    if (commandSucceeded(result)) return runtime;
  }
  return null;
}

async function verifyConfiguredDatabase({
  databaseTarget,
  clientFactory = config => new Client(config)
} = {}) {
  if (!databaseTarget || !databaseTarget.databaseUrl) {
    throw new Error('A resolved development database target is required for host readiness');
  }

  const client = clientFactory({
    connectionString: databaseTarget.databaseUrl,
    connectionTimeoutMillis: 3000,
    query_timeout: 3000,
    application_name: 'ticket-system-dev-database-readiness'
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch (error) {
    const subject = databaseTarget.kind === 'external'
      ? 'The configured external DATABASE_URL'
      : 'Compose reports PostgreSQL healthy, but the configured DATABASE_URL';
    throw new Error(
      subject + ' cannot complete a host-side PostgreSQL query: ' + safeErrorMessage(error)
    );
  } finally {
    try { await client.end(); } catch (_) {}
  }
  return databaseTarget;
}

async function startDevelopmentDatabase({
  spawn = spawnSync,
  runtime,
  composeFile = COMPOSE_FILE,
  env = process.env,
  applyEnv = applyLocalEnv,
  resolveTarget = resolveDevelopmentDatabaseTarget,
  verifyDatabase = verifyConfiguredDatabase
} = {}) {
  applyEnv(env);
  const databaseTarget = resolveTarget(env);

  if (databaseTarget.kind === 'external') {
    await verifyDatabase({ databaseTarget });
    return Object.freeze({ databaseTarget, runtime: null });
  }

  const selectedRuntime = runtime === undefined
    ? selectComposeRuntime({ spawn })
    : runtime;
  if (!selectedRuntime) {
    throw new Error(
      'Docker Compose or Podman Compose is required to provision local PostgreSQL. ' +
      'Install one, or configure DATABASE_URL for an existing PostgreSQL 17 instance.'
    );
  }
  const args = [...selectedRuntime.prefix, '-f', composeFile, 'up', '-d', '--wait'];
  const result = spawn(selectedRuntime.command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...env, TICKET_SYSTEM_POSTGRES_PORT: String(databaseTarget.composePort) }
  });
  if (!commandSucceeded(result)) {
    throw result && result.error
      ? result.error
      : new Error(selectedRuntime.label + ' exited with status ' + String(result && result.status));
  }
  await verifyDatabase({ databaseTarget });
  return Object.freeze({ databaseTarget, runtime: selectedRuntime });
}

function printHelp() {
  console.log(
    'Usage: pnpm dev:db\n\n' +
    'Starts the bundled PostgreSQL 17 service and verifies the configured host endpoint.\n' +
    'When DATABASE_URL names an external database, Compose is not started and only that endpoint is verified.\n' +
    'Existing volumes and databases are preserved.'
  );
}

async function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:db does not accept arguments');
  const result = await startDevelopmentDatabase();
  if (result.databaseTarget.kind === 'external') {
    console.log('Configured external PostgreSQL is reachable; bundled Compose was not started. Run pnpm dev:setup.');
  } else {
    console.log('Development PostgreSQL is ready through ' + result.runtime.label + '. Run pnpm dev:setup.');
  }
}

module.exports = {
  COMPOSE_FILE,
  COMPOSE_RUNTIMES,
  commandSucceeded,
  selectComposeRuntime,
  startDevelopmentDatabase,
  verifyConfiguredDatabase
};

if (require.main === module) {
  main().catch(error => {
    console.error('Development database setup failed: ' + safeErrorMessage(error));
    process.exit(1);
  });
}
