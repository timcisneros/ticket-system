#!/usr/bin/env node
'use strict';

const fs = require('fs');
const argon2 = require('argon2');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  LOCAL_ENV_PATH,
  applyLocalEnv,
  developmentConfig,
  generateSessionSecret,
  promptHidden,
  promptVisible,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writeLocalEnv
} = require('./dev-environment');
const { postgresHelp } = require('./dev-doctor');

const DEFAULT_DATABASE_URL = 'postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system';

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
  const first = await promptHidden('Initial admin password');
  const second = await promptHidden('Confirm initial admin password');
  if (first !== second) throw new Error('Admin password confirmation did not match');
  return first;
}

async function prepareLocalEnv(env = process.env) {
  if (fs.existsSync(LOCAL_ENV_PATH)) {
    applyLocalEnv(env);
    console.log('.env.local already exists; preserved without changes.');
    return;
  }

  const databaseUrl = env.DATABASE_URL || await promptVisible('PostgreSQL URL', { defaultValue: DEFAULT_DATABASE_URL });
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

async function runSetup({ env = process.env, storeFactory = config => new PostgresRuntimeStore(config) } = {}) {
  await prepareLocalEnv(env);
  const config = developmentConfig(env);
  const databaseError = validateDatabaseUrl(config.databaseUrl);
  if (databaseError) throw new Error(databaseError);
  const sessionError = validateSessionSecret(config.sessionSecret);
  if (sessionError) throw new Error(sessionError);

  const store = storeFactory({ connectionString: config.databaseUrl, schema: config.postgresSchema });
  try {
    const applied = await store.migrate();
    console.log(applied.length
      ? `Applied ${applied.length} PostgreSQL migration(s): ${applied.join(', ')}`
      : `PostgreSQL schema ${config.postgresSchema} is current.`);

    const existing = await store.getUserByUsername('admin');
    if (existing) {
      console.log('Admin account already exists; credentials were preserved.');
      if (config.adminBootstrapPassword) {
        console.warn('ADMIN_BOOTSTRAP_PASSWORD is creation-only and is ignored after bootstrap. Use pnpm admin:password to rotate the current password.');
      }
    } else {
      const password = await passwordForInitialAdmin(env);
      const result = await createInitialAdmin({ store, password });
      if (result.created) console.log('Created the initial admin account through the audited PostgreSQL access repository.');
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
    console.log('Usage: pnpm dev:setup\n\nCreates .env.local only when absent, runs migrations, and creates the first admin only when absent.');
    return;
  }
  if (process.argv.length > 2) throw new Error('dev:setup does not accept arguments');
  await runSetup();
}

module.exports = { DEFAULT_DATABASE_URL, createInitialAdmin, prepareLocalEnv, runSetup };

if (require.main === module) {
  main().catch(error => {
    console.error(`Development setup failed: ${safeErrorMessage(error)}`);
    if (/connect|database|ECONNREFUSED|PostgreSQL/i.test(String(error.message || error))) {
      console.error(postgresHelp());
    }
    process.exit(1);
  });
}
