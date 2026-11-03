#!/usr/bin/env node
'use strict';

const { applyLocalEnv, safeErrorMessage } = require('./dev-environment');
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
