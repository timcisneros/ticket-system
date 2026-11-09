#!/usr/bin/env node
'use strict';

const argon2 = require('argon2');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  assertDevelopmentTargetUsable,
  applyLocalEnv,
  developmentConfig,
  formatTargetIdentity,
  operationalIdentityFrom,
  promptHidden,
  resolveOperationalChannelAuthority,
  safeErrorMessage,
  targetIdentity,
  validateAdminPassword,
  validateDatabaseUrl
} = require('./dev-environment');

// ADMIN-PASSWORD-DEVEX: the password CLI has exactly two mutually explicit
// target selectors and no caller-selectable database identity at all.
//
// DEFAULT: the fixed repository-owned disposable development target, via the
// same owner (`disposableDevelopmentTarget` / `assertDevelopmentTargetUsable`)
// as `pnpm dev`, `dev:setup`, `dev:doctor`, and `dev:reset`. Only the
// compose-owned TICKET_SYSTEM_POSTGRES_PORT participates (identically to the
// rest of the dev family); DATABASE_URL, POSTGRES_SCHEMA, and PG* libpq
// variables cannot redirect the development target, and the connection string
// is always fully specified so no libpq environment fallback can retarget it.
//
// --operational: the exact operational DATABASE_URL / POSTGRES_SCHEMA channel
// through the canonical operational configuration resolver
// (`developmentConfig`), which keeps every existing runtime-integrity gate.
//
// The selector is a human-error / command-routing guard for the developer at
// the keyboard. It is NOT an OS capability boundary: an unrestricted process
// running as the same Unix account can still target any database directly.
// Adversarial developer-agent isolation remains an OS/account boundary.

function parseArgs(argv) {
  let username = 'admin';
  let usernameSeen = false;
  let operational = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--help') return { help: true, username, operational };
    if (argument === '--operational') {
      if (operational) throw new Error('--operational was already provided');
      operational = true;
      continue;
    }
    if (argument === '--password' || argument.startsWith('--password=')) {
      throw new Error('Passwords cannot be passed on the command line; the secure prompt is required');
    }
    if (argument === '--username') {
      if (usernameSeen) throw new Error('--username was already provided');
      usernameSeen = true;
      const value = String(argv[index + 1] || '').trim();
      if (!value || value.startsWith('--')) {
        throw new Error('--username requires a value');
      }
      username = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, username, operational };
}

// Pure per-channel resolution. The development branch is the fixed dev target
// owner; the operational branch consumes the ONE pre-normalization authority
// decision for both its authorization and its exact target
// (resolveOperationalChannelAuthority). Neither branch re-derives database
// identity from individual parts: both reuse the exported owners in
// scripts/dev-environment.js, and the operational branch never re-reads or
// re-normalizes another source after the decision it was given.
function resolveDevelopmentPasswordTarget(env = process.env) {
  const target = assertDevelopmentTargetUsable(env);
  return {
    channel: 'development',
    identity: targetIdentity(target),
    connectionString: target.databaseUrl,
    schema: target.schema
  };
}

function resolveOperationalPasswordTarget({ authority } = {}) {
  if (!authority || authority.authorized !== true) {
    throw new Error('--operational resolution requires the single pre-normalization authority decision');
  }
  const databaseError = validateDatabaseUrl(authority.databaseUrl);
  if (databaseError) throw new Error(databaseError);
  return {
    channel: 'operational',
    source: authority.source,
    identity: targetIdentity(operationalIdentityFrom({
      databaseUrl: authority.databaseUrl,
      postgresSchema: authority.postgresSchema
    })),
    // The SAME authority decision supplies the connection string: no secondary
    // read or normalization can hold a different operational target.
    connectionString: authority.databaseUrl,
    schema: authority.postgresSchema
  };
}

function resolvePasswordTarget({ operational = false, authority = null, env = process.env } = {}) {
  if (operational) {
    return resolveOperationalPasswordTarget({ authority });
  }
  return resolveDevelopmentPasswordTarget(env);
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

// The operational channel has exactly ONE authority decision, taken from the
// RAW environment plus the local env file BEFORE applyLocalEnv normalizes a
// bundled/development-shaped default into DATABASE_URL. The same frozen
// decision supplies both the authorization and the exact operational
// connection target, so the gate and the resolver can never disagree about
// which database the channel acts on (an explicitly blank DATABASE_URL refuses
// the channel instead of authorizing .env.local — see F1-prc).
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: pnpm admin:password [--operational] [--username <name>]',
      '',
      'Prompts securely and records the change through the audited PostgreSQL user repository.',
      '',
      'Targets:',
      '  default         the fixed repository-owned disposable development database',
      '                  (ticket_system_dev / ticket_system schema on the bundled compose port)',
      '  --operational   the exact operational DATABASE_URL / POSTGRES_SCHEMA channel',
      '',
      'The default never reads DATABASE_URL, POSTGRES_SCHEMA, or PG* libpq variables as',
      'its target authority. The printed target identity never includes credentials.'
    ].join('\n'));
    return;
  }

  const authority = options.operational ? resolveOperationalChannelAuthority() : null;
  if (options.operational && !authority.authorized) {
    throw new Error(
      '--operational refused: ' + authority.reason +
      '; the bundled development default is not the operational channel'
    );
  }

  applyLocalEnv();
  const target = resolvePasswordTarget({ operational: options.operational, authority });
  // Credential-free target identity, printed BEFORE any contact or mutation so
  // the human always knows which state the command acts on.
  console.log(
    options.operational
      ? 'Password target: operational (explicit --operational; DATABASE_URL/POSTGRES_SCHEMA channel); ' +
        formatTargetIdentity(target.identity)
      : 'Password target: development (default; fixed disposable development target); ' +
        formatTargetIdentity(target.identity)
  );

  const store = new PostgresRuntimeStore({
    connectionString: target.connectionString,
    schema: target.schema
  });
  try {
    await store.prepareRuntimePersistence();
    const existing = await store.getUserByUsername(options.username);
    if (!existing) throw new Error(`User does not exist: ${options.username}`);
    const password = await readConfirmedPassword();
    await rotateUserPassword({ store, username: options.username, password });
    console.log(`Password updated for ${options.username}; existing group memberships were preserved and the change was audited.`);
    if (developmentConfig().adminBootstrapPassword) {
      console.warn('ADMIN_BOOTSTRAP_PASSWORD is creation-only. Remove the stale value from .env.local if the initial admin already exists.');
    }
  } finally {
    await store.close();
  }
}

module.exports = { parseArgs, resolvePasswordTarget, rotateUserPassword };

if (require.main === module) {
  main().catch(error => {
    console.error(`Password update failed: ${safeErrorMessage(error)}`);
    process.exit(1);
  });
}
