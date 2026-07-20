#!/usr/bin/env node
'use strict';

const { applyLocalEnv, safeErrorMessage } = require('./dev-environment');
const { runDoctor } = require('./dev-doctor');

async function main() {
  process.env.NODE_ENV = 'development';
  process.env.WORKSPACE_ROOT ||= '.local-workspace';
  process.env.ARTIFACT_ROOT ||= '.local-artifacts';
  applyLocalEnv();

  const ready = await runDoctor();
  if (!ready) {
    console.error('Startup stopped before mutation work. Run pnpm dev:setup or pnpm dev:doctor for guidance.');
    process.exit(1);
  }

  require('../server');
}

main().catch(error => {
  console.error(`Development startup failed: ${safeErrorMessage(error)}`);
  process.exit(1);
});
