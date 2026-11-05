#!/usr/bin/env node
'use strict';

const fs = require('fs');
const argon2 = require('argon2');
const {
  DEVELOPMENT_TARGET_SCHEMA,
  DEFAULT_BUNDLED_POSTGRES_PORT,
  DEFAULT_DATABASE_URL,
  LOCAL_ENV_PATH,
  applyLocalEnv,
  bundledDatabaseUrl,
  createGuardedDevelopmentStore,
  generateSessionSecret,
  promptHidden,
  promptVisible,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writeLocalEnv
} = require('./dev-environment');
const {
  prepareAndMigrateDisposableDevelopmentDatabase
} = require('./dev-database');
const { ensureInitialAgent } = require('./dev-agent-config');
const { postgresHelp } = require('./dev-doctor');

const { MigrationExecutionAuthorityError } = require('../persistence/postgres/migration-authority');

// The migration execution authority gate (T10) refuses unauthorized
// transitions BEFORE any mutation. Setup never weakens that gate; the only
// honest guidance is the governed authorization procedure itself.
function migrationAuthorityHelp() {
  return (
    'the schema is behind and this pending migration transition is NOT authorized: ' +
    '`pnpm dev:setup` cannot bypass migration execution authority. ' +
    'Authorize the transition only through the governed bootstrap/upgrade procedure ' +
    '(config/migration-execution-authorization.json; docs/DEPLOYMENT_CONTRACT.md §9), ' +
    'then apply it with the canonical migration command (`npm run db:migrate`).'
  );
}

async function createInitialAdmin({ store, password, hashPassword = argon2.hash }) {
  const existing = await store.getUserByUsername('admin');
  if (existing) return { created: false, user: existing };
  const passwordError = validateAdminPassword(password, { required: true });
  if (passwordError) throw new Error(passwordError);
  const passwordHash = await hashPassword(password);
  const result = await store.ensureBootstrapAccess({
    adminUsername: 'admin',
    passwordHash,
    changedBy: 'dev-setup'
  });
  return { created: true, user: result.adminUser };
}

async function passwordForInitialAdmin(env = process.env) {
  if (env.ADMIN_BOOTSTRAP_PASSWORD) return env.ADMIN_BOOTSTRAP_PASSWORD;
  const first = await promptHidden('Admin password');
  const second = await promptHidden('Confirm admin password');
  if (first !== second) throw new Error('Admin password confirmation did not match');
  return first;
}

async function prepareLocalEnv(env = process.env) {
  if (fs.existsSync(LOCAL_ENV_PATH)) {
    applyLocalEnv(env);
    console.log('.env.local already exists; preserved without changes.');
    return;
  }

  const defaultDatabaseUrl = bundledDatabaseUrl(
    env.TICKET_SYSTEM_POSTGRES_PORT || DEFAULT_BUNDLED_POSTGRES_PORT
  );
  // This URL names the OPERATIONAL/persistent target (T10-protected). The
  // daily dev command targets the fixed disposable development database and
  // cannot be redirected by it.
  const databaseUrl = env.DATABASE_URL || await promptVisible('Operational PostgreSQL URL (persistent state)', { defaultValue: defaultDatabaseUrl });
  const sessionSecret = env.SESSION_SECRET || generateSessionSecret();
  const databaseError = validateDatabaseUrl(databaseUrl);
  if (databaseError) throw new Error(databaseError);
  const sessionError = validateSessionSecret(sessionSecret);
  if (sessionError) throw new Error(sessionError);

  writeLocalEnv({
    databaseUrl,
    postgresSchema: env.POSTGRES_SCHEMA || 'ticket_system',
    sessionSecret,
    adminBootstrapPassword: ''
  });
  env.DATABASE_URL = databaseUrl;
  env.POSTGRES_SCHEMA ||= 'ticket_system';
  env.SESSION_SECRET = sessionSecret;
  console.log('Created ignored .env.local with mode 0600. Existing files are never overwritten.');
}

async function runSetup({ env = process.env } = {}) {
  await prepareLocalEnv(env);
  // P6-DEVEX-A: dev:setup is the one-time setup path for the DEVELOPMENT
  // target. DB mutations target ONLY the fixed disposable development
  // database through the verified bundled-compose lifecycle (called with NO
  // arguments: the lifecycle owns every proof mechanism internally):
  // collision guard → bundled compose start/verification → create → migrate
  // under the code-declared disposable authority (the canonical
  // migration-execution authorization record is untouched; `npm run
  // db:migrate` remains the governed operational command).
  const prepared = await prepareAndMigrateDisposableDevelopmentDatabase();
  const appliedVersions = prepared.appliedVersions;
  // Post-migration provisioning (admin/agent) uses the ordinary GUARDED
  // development seam: it carries no disposable migration authority and
  // cannot migrate anything; the migration already happened inside the
  // verified lifecycle above.
  const store = createGuardedDevelopmentStore(env);
  try {
    console.log(appliedVersions.length
      ? `Applied ${appliedVersions.length} PostgreSQL migration(s) to the disposable development database: ${appliedVersions.join(', ')}`
      : `Disposable development database is current (schema ${DEVELOPMENT_TARGET_SCHEMA}).`);

    const existing = await store.getUserByUsername('admin');
    if (existing) {
      console.log('Admin account already exists; credentials were preserved.');
    } else {
      const password = await passwordForInitialAdmin(env);
      const result = await createInitialAdmin({ store, password });
      if (result.created) console.log('Created the admin account through the audited PostgreSQL access repository.');
    }

    const agentSetup = await ensureInitialAgent({ store, env });
    if (agentSetup.created) {
      console.log(`Created agent "${agentSetup.agent.name}" with ${agentSetup.agent.provider} through the audited PostgreSQL agent repository.`);
    } else {
      console.log(`Configured agents already exist; preserved "${agentSetup.agent.name}" and all existing agent records.`);
    }

    if (agentSetup.agent.provider === 'ollama') {
      console.log(
        `Ollama must be running with model "${agentSetup.agent.model}" installed. ` +
        'Confirm it with `ollama list`, then validate the live path with pnpm dev:smoke.'
      );
    } else {
      console.log(`OpenAI model "${agentSetup.agent.model}" is configured. Validate the live path with pnpm dev:smoke.`);
    }
    await store.prepareRuntimePersistence();
    console.log('Development setup is complete. Run pnpm dev.');
    return true;
  } finally {
    await store.close();
  }
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: pnpm dev:setup\n\nCreates local config only when absent, prepares and migrates the fixed disposable development database, and creates an admin when absent and an agent when no runnable agent exists. It never migrates the operational DATABASE_URL target.');
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:setup does not accept arguments');
  await runSetup();
}

module.exports = { DEFAULT_DATABASE_URL, createInitialAdmin, migrationAuthorityHelp, prepareLocalEnv, runSetup };

if (require.main === module) {
  main().catch(error => {
    console.error(`Development setup failed: ${safeErrorMessage(error)}`);
    if (error instanceof MigrationExecutionAuthorityError) {
      console.error(migrationAuthorityHelp());
    } else if (/connect|database|ECONNREFUSED|PostgreSQL/i.test(String(error.message || error))) {
      console.error(postgresHelp());
    }
    process.exit(1);
  });
}
