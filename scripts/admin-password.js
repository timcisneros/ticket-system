#!/usr/bin/env node
'use strict';

const argon2 = require('argon2');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  applyLocalEnv,
  developmentConfig,
  promptHidden,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl
} = require('./dev-environment');

function parseArgs(argv) {
  let username = 'admin';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help') return { help: true, username };
    if (argument === '--password' || argument.startsWith('--password=')) {
      throw new Error('Passwords cannot be passed on the command line; the secure prompt is required');
    }
    if (argument === '--username') {
      username = String(argv[index + 1] || '').trim();
      index += 1;
      if (!username) throw new Error('--username requires a value');
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, username };
}

async function rotateUserPassword({ store, username, password, hashPassword = argon2.hash }) {
  const passwordError = validateAdminPassword(password, { required: true });
  if (passwordError) throw new Error(passwordError);
  const user = await store.getUserByUsername(username);
  if (!user) throw new Error(`User does not exist: ${username}`);
  const passwordHash = await hashPassword(password);
  const result = await store.updateUser({
    userId: user.id,
    expectedRevision: user.revision,
    value: { ...user, passwordHash },
    groupIds: user.groupIds,
    changedBy: 'admin-password-cli'
  });
  if (!result) throw new Error(`User disappeared while updating: ${username}`);
  return result.user;
}

async function readConfirmedPassword() {
  const first = await promptHidden('New password');
  const second = await promptHidden('Confirm new password');
  if (first !== second) throw new Error('Password confirmation did not match');
  return first;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: pnpm admin:password [--username <name>]\n\nPrompts securely and records the change through the audited PostgreSQL user repository.');
    return;
  }

  applyLocalEnv();
  const config = developmentConfig();
  const databaseError = validateDatabaseUrl(config.databaseUrl);
  if (databaseError) throw new Error(databaseError);

  const store = new PostgresRuntimeStore({
    connectionString: config.databaseUrl,
    schema: config.postgresSchema
  });
  try {
    await store.prepareRuntimePersistence();
    const existing = await store.getUserByUsername(options.username);
    if (!existing) throw new Error(`User does not exist: ${options.username}`);
    const password = await readConfirmedPassword();
    await rotateUserPassword({ store, username: options.username, password });
    console.log(`Password updated for ${options.username}; existing group memberships were preserved and the change was audited.`);
    if (config.adminBootstrapPassword) {
      console.warn('ADMIN_BOOTSTRAP_PASSWORD is creation-only. Remove the stale value from .env.local if the initial admin already exists.');
    }
  } finally {
    await store.close();
  }
}

module.exports = { parseArgs, rotateUserPassword };

if (require.main === module) {
  main().catch(error => {
    console.error(`Password update failed: ${safeErrorMessage(error)}`);
    process.exit(1);
  });
}
