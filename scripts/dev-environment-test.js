#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const {
  applyLocalEnv,
  generateSessionSecret,
  renderLocalEnv,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writeLocalEnv
} = require('./dev-environment');
const { inspectDevelopmentEnvironment, packageManagerCheck, printChecks } = require('./dev-doctor');
const { createInitialAdmin } = require('./dev-setup');
const { parseArgs, rotateUserPassword } = require('./admin-password');

async function main() {
  assert.match(validateDatabaseUrl(''), /required/);
  assert.match(validateDatabaseUrl('https://example.test/db'), /postgres/i);
  assert.equal(validateDatabaseUrl('postgresql://user:pass@localhost/db'), null);
  assert.match(validateSessionSecret('short'), /32/);
  assert.match(validateSessionSecret('replace-with-at-least-32-random-characters'), /placeholder/);
  assert.equal(validateSessionSecret(generateSessionSecret()), null);
  assert.match(validateAdminPassword('short', { required: true }), /12/);
  assert.equal(validateAdminPassword('long-enough-development-password', { required: true }), null);
  assert.equal(safeErrorMessage(new Error('connect postgresql://user:secret@localhost/db failed')).includes('secret'), false);

  assert.equal(packageManagerCheck('pnpm/10.0.0 npm/? node/v24').status, 'fail');
  assert.deepEqual(packageManagerCheck('npm/11.0.0 node/v24'), { status: 'pass', label: 'npm', message: '11; supported script runner' });

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-dev-env-'));
  try {
    const envPath = path.join(temporary, '.env.local');
    const values = {
      databaseUrl: 'postgresql://user:secret@localhost/db',
      postgresSchema: 'ticket_system',
      sessionSecret: 's'.repeat(40),
      adminBootstrapPassword: ''
    };
    writeLocalEnv(values, envPath);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.throws(() => writeLocalEnv(values, envPath), error => error && error.code === 'EEXIST');
    assert.deepEqual(dotenv.parse(renderLocalEnv(values)), {
      DATABASE_URL: values.databaseUrl,
      POSTGRES_SCHEMA: values.postgresSchema,
      SESSION_SECRET: values.sessionSecret
    });

    const explicit = { DATABASE_URL: 'postgresql://explicit:pass@localhost/explicit' };
    applyLocalEnv(explicit, envPath);
    assert.equal(explicit.DATABASE_URL, 'postgresql://explicit:pass@localhost/explicit');
    assert.equal(explicit.SESSION_SECRET, values.sessionSecret);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const baseEnv = {
    DATABASE_URL: 'postgresql://user:secret@localhost/db',
    POSTGRES_SCHEMA: 'ticket_system',
    SESSION_SECRET: 's'.repeat(40),
    WORKSPACE_ROOT: os.tmpdir(),
    ARTIFACT_ROOT: os.tmpdir(),
    npm_config_user_agent: 'pnpm/11.8.0 npm/? node/v24'
  };
  let closed = false;
  const existingAdmin = {
    id: 7,
    username: 'admin',
    passwordHash: 'stored-hash',
    revision: 3,
    groupIds: [2, 4],
    profile: 'preserved'
  };
  const healthy = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'stale' },
    storeFactory: () => ({
      async prepareRuntimePersistence() {},
      async getUserByUsername() { return existingAdmin; },
      async close() { closed = true; }
    }),
    verifyPassword: async (_hash, candidate) => candidate === 'current-password'
  });
  assert.equal(healthy.ok, true, 'warnings must not turn a usable environment into a startup outage');
  assert.equal(closed, true);
  assert.ok(healthy.checks.some(check => check.status === 'warn' && check.label === 'bootstrap password state'));
  const rendered = [];
  printChecks(healthy, { write(value) { rendered.push(value); } });
  assert.equal(rendered.join('').includes('stale'), false, 'doctor output must not expose secret values');

  const missingAdmin = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'long-enough-bootstrap-password' },
    storeFactory: () => ({
      async prepareRuntimePersistence() {},
      async getUserByUsername() { return null; },
      async close() {}
    })
  });
  assert.equal(missingAdmin.ok, false);
  assert.ok(missingAdmin.checks.some(check => check.status === 'fail' && check.label === 'initial admin'));

  let bootstrapCalls = 0;
  const created = await createInitialAdmin({
    store: {
      async getUserByUsername() { return null; },
      async ensureBootstrapAccess(value) {
        bootstrapCalls += 1;
        assert.equal(value.changedBy, 'dev-setup');
        assert.equal(value.passwordHash, 'new-hash');
        return { adminUser: { id: 1, username: 'admin' } };
      }
    },
    password: 'long-enough-password',
    hashPassword: async () => 'new-hash'
  });
  assert.equal(created.created, true);
  assert.equal(bootstrapCalls, 1);

  const preserved = await createInitialAdmin({
    store: { async getUserByUsername() { return existingAdmin; } },
    password: 'long-enough-password',
    hashPassword: async () => { throw new Error('must not hash'); }
  });
  assert.equal(preserved.created, false);

  let update;
  const rotated = await rotateUserPassword({
    store: {
      async getUserByUsername(username) {
        assert.equal(username, 'admin');
        return existingAdmin;
      },
      async updateUser(value) {
        update = value;
        return { user: { ...value.value, revision: 4 } };
      }
    },
    username: 'admin',
    password: 'another-secure-password',
    hashPassword: async () => 'rotated-hash'
  });
  assert.equal(rotated.passwordHash, 'rotated-hash');
  assert.equal(update.expectedRevision, 3);
  assert.deepEqual(update.groupIds, [2, 4]);
  assert.equal(update.value.profile, 'preserved');
  assert.equal(update.changedBy, 'admin-password-cli');
  assert.throws(() => parseArgs(['--password', 'visible-secret']), /cannot be passed/);
  assert.deepEqual(parseArgs(['--username', 'operator']), { help: false, username: 'operator' });
  assert.deepEqual(parseArgs(['--', '--username', 'operator']), { help: false, username: 'operator' });

  const packageJson = require('../package.json');
  assert.match(packageJson.scripts.dev, /scripts\/dev\.js$/);
  assert.match(packageJson.scripts['dev:setup'], /scripts\/dev-setup\.js$/);
  assert.match(packageJson.scripts['dev:doctor'], /scripts\/dev-doctor\.js$/);
  assert.match(packageJson.scripts['admin:password'], /scripts\/admin-password\.js$/);

  console.log('PASS: development setup is non-destructive, diagnosable, and uses audited credential updates');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
