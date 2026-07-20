#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { safeErrorMessage } = require('./dev-environment');

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

function startDevelopmentDatabase({
  spawn = spawnSync,
  runtime = selectComposeRuntime({ spawn }),
  composeFile = COMPOSE_FILE
} = {}) {
  if (!runtime) {
    throw new Error(
      'Docker Compose or Podman Compose is required to provision local PostgreSQL. ' +
      'Install one, or configure DATABASE_URL for an existing PostgreSQL 17 instance.'
    );
  }
  const args = [...runtime.prefix, '-f', composeFile, 'up', '-d', '--wait'];
  const result = spawn(runtime.command, args, { cwd: ROOT, stdio: 'inherit' });
  if (!commandSucceeded(result)) {
    throw result && result.error
      ? result.error
      : new Error(runtime.label + ' exited with status ' + String(result && result.status));
  }
  return runtime;
}

function printHelp() {
  console.log(
    'Usage: pnpm dev:db\n\n' +
    'Starts the repository PostgreSQL 17 service with Docker Compose or Podman Compose and waits for health.\n' +
    'Existing volumes and databases are preserved. Set DATABASE_URL instead when using external PostgreSQL.'
  );
}

function main() {
  if (process.argv.includes('--help')) {
    printHelp();
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:db does not accept arguments');
  const runtime = startDevelopmentDatabase();
  console.log('Development PostgreSQL is ready through ' + runtime.label + '. Run pnpm dev:setup.');
}

module.exports = {
  COMPOSE_FILE,
  COMPOSE_RUNTIMES,
  commandSucceeded,
  selectComposeRuntime,
  startDevelopmentDatabase
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('Development database setup failed: ' + safeErrorMessage(error));
    process.exit(1);
  }
}
