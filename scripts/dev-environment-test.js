#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const {
  DEFAULT_BUNDLED_POSTGRES_PORT,
  DEFAULT_DATABASE_URL,
  MIN_ADMIN_PASSWORD_LENGTH,
  applyLocalEnv,
  bundledDatabaseUrl,
  developmentConfig,
  generateSessionSecret,
  renderLocalEnv,
  resolveDevelopmentDatabaseTarget,
  safeErrorMessage,
  validateAdminPassword,
  validateDatabaseUrl,
  validateSessionSecret,
  writeLocalEnv
} = require('./dev-environment');
const { inspectDevelopmentEnvironment, packageManagerCheck, printChecks } = require('./dev-doctor');
const { validateEnvironment } = require('../runtime/environment-config-registry');
const {
  DEFAULT_OPENAI_MODEL,
  agentReadiness,
  ensureInitialAgent,
  promptProviderConfig,
  providerConfigFromEnvironment
} = require('./dev-agent-config');
const {
  selectComposeRuntime,
  startDevelopmentDatabase,
  verifyConfiguredDatabase
} = require('./dev-database');
const { DEFAULT_DATABASE_URL: SETUP_DEFAULT_DATABASE_URL, createInitialAdmin } = require('./dev-setup');
const { parseArgs, rotateUserPassword } = require('./admin-password');
const { parseArgs: parseSmokeArgs, runSmoke, SMOKE_OBJECTIVE } = require('./dev-smoke');

async function main() {
  assert.match(validateDatabaseUrl(''), /required/);
  assert.match(validateDatabaseUrl('https://example.test/db'), /postgres/i);
  assert.equal(validateDatabaseUrl('postgresql://user:pass@localhost/db'), null);
  assert.match(validateSessionSecret('short'), /32/);
  assert.match(validateSessionSecret('replace-with-at-least-32-random-characters'), /placeholder/);
  assert.equal(validateSessionSecret(generateSessionSecret()), null);
  assert.match(validateAdminPassword('short', { required: true }), new RegExp(String(MIN_ADMIN_PASSWORD_LENGTH)));
  assert.equal(validateAdminPassword('long-enough-development-password', { required: true }), null);
  assert.equal(safeErrorMessage(new Error('connect postgresql://user:secret@localhost/db failed')).includes('secret'), false);

  const defaultDatabaseTarget = resolveDevelopmentDatabaseTarget({});
  assert.deepEqual(defaultDatabaseTarget, {
    kind: 'bundled',
    databaseUrl: DEFAULT_DATABASE_URL,
    composePort: DEFAULT_BUNDLED_POSTGRES_PORT,
    source: 'default'
  });
  assert.equal(SETUP_DEFAULT_DATABASE_URL, DEFAULT_DATABASE_URL);
  assert.equal(developmentConfig({}).databaseUrl, DEFAULT_DATABASE_URL);
  const customBundledUrl = bundledDatabaseUrl(55432);
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ TICKET_SYSTEM_POSTGRES_PORT: '55432' }), {
    kind: 'bundled',
    databaseUrl: customBundledUrl,
    composePort: 55432,
    source: 'bundled-port'
  });
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ DATABASE_URL: customBundledUrl }), {
    kind: 'bundled',
    databaseUrl: customBundledUrl,
    composePort: 55432,
    source: 'database-url'
  });
  assert.deepEqual(
    resolveDevelopmentDatabaseTarget({
      DATABASE_URL: DEFAULT_DATABASE_URL,
      TICKET_SYSTEM_POSTGRES_PORT: '55432'
    }),
    {
      kind: 'bundled',
      databaseUrl: customBundledUrl,
      composePort: 55432,
      source: 'bundled-port'
    }
  );
  const externalDatabaseUrl = 'postgresql://external:test-only-password@db.example.test:6543/external';
  assert.deepEqual(resolveDevelopmentDatabaseTarget({ DATABASE_URL: externalDatabaseUrl }), {
    kind: 'external',
    databaseUrl: externalDatabaseUrl,
    composePort: null,
    source: 'database-url'
  });
  assert.throws(
    () => resolveDevelopmentDatabaseTarget({
      DATABASE_URL: externalDatabaseUrl,
      TICKET_SYSTEM_POSTGRES_PORT: '55432'
    }),
    /cannot be combined/
  );

  // TICKET_SYSTEM_POSTGRES_PORT — STRICT owner parity (configures the BUNDLED
  // development database). The real owner seam (resolveDevelopmentDatabaseTarget)
  // reads `String(env.TICKET_SYSTEM_POSTGRES_PORT || '').trim()` and requires
  // the WHOLE trimmed value to be decimal digits forming a safe integer within
  // [1, 65535]; it throws the canonical message otherwise. Surrounding
  // whitespace is consumed by the owner before the rule (' 5432 ' configures
  // port 5432) and a whitespace-only value is unset (the bundled default),
  // exactly like absence. The canonical registry (doctor context validates the
  // development settings) must agree with the owner on every value class — a
  // partial numeric prefix ('5432junk', '12abc') is never an accepted port for
  // either, and the suite fails if registry and owner drift.
  const TSPP_EXPECTED_MESSAGE = 'TICKET_SYSTEM_POSTGRES_PORT must be an integer from 1 through 65535';
  const TSPP_CLASS_EXPECTATIONS = Object.freeze([
    // [configured value, accepted, expected owner composePort when accepted]
    ['5432', true, 5432],
    [' 5432 ', true, 5432],               // the owner trims before the digits rule
    ['05432', true, 5432],                // leading zero digits: same integer value
    ['65535', true, 65535],               // range boundary
    ['1', true, 1],                       // range boundary
    ['5432junk', false, null],            // trailing junk is never a partial prefix
    ['12abc', false, null],
    ['5432.5', false, null],              // non-integer decimal text
    ['+5432', false, null],               // sign notation the owner refuses
    ['-5432', false, null],
    ['0', false, null],                   // bundled ports start at 1
    ['65536', false, null],               // above the range
    ['9999999999999999999', false, null], // digits-only but not a safe integer
    ['junk', false, null],
    ['   ', true, null]                   // whitespace-only is UNSET: bundled default
  ]);
  for (const [value, shouldAccept, expectedPort] of TSPP_CLASS_EXPECTATIONS) {
    const configured = { TICKET_SYSTEM_POSTGRES_PORT: value };
    let ownerPort = null;
    try {
      ownerPort = resolveDevelopmentDatabaseTarget(configured).composePort;
    } catch (_) {
      ownerPort = null; // the owner throws → the value is refused
    }
    assert.equal(
      ownerPort !== null,
      shouldAccept,
      `the bundled owner accepts TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)} exactly when declared`
    );
    const registryFailures = validateEnvironment(configured, { context: 'doctor' }).failures
      .filter((failure) => failure.name === 'TICKET_SYSTEM_POSTGRES_PORT');
    assert.equal(
      registryFailures.length === 0,
      shouldAccept,
      `the canonical registry and the bundled owner agree for TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)}`
    );
    if (!shouldAccept) {
      assert.equal(registryFailures[0].code, 'invalid_port_range');
      assert.equal(
        registryFailures[0].message,
        TSPP_EXPECTED_MESSAGE,
        'the registry failure names the setting and renders no value'
      );
    } else if (expectedPort !== null) {
      assert.equal(
        ownerPort,
        expectedPort,
        `the bundled owner binds TICKET_SYSTEM_POSTGRES_PORT=${JSON.stringify(value)} as port ${expectedPort}`
      );
    }
  }
  // The owner throw and the registry failure are ONE canonical sentence; this
  // must fail if registry and owner drift.
  try {
    resolveDevelopmentDatabaseTarget({ TICKET_SYSTEM_POSTGRES_PORT: '5432junk' });
    assert.ok(false, 'the bundled owner must throw for a partial-prefix port value');
  } catch (error) {
    const registryFailure = validateEnvironment(
      {
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
        SESSION_SECRET: 'x'.repeat(64),
        TICKET_SYSTEM_POSTGRES_PORT: '5432junk'
      },
      { context: 'doctor' }
    ).failures.filter((failure) => failure.name === 'TICKET_SYSTEM_POSTGRES_PORT')[0];
    assert.ok(registryFailure, 'the canonical registry refuses the same partial-prefix port value');
    assert.equal(
      registryFailure.message,
      error.message,
      'registry failure text and owner throw text are one canonical sentence'
    );
  }
  // bundledDatabaseUrl — the owner's URL builder — holds the exact boundaries.
  assert.equal(bundledDatabaseUrl(1), 'postgresql://ticket_system:ticket_system@127.0.0.1:1/ticket_system');
  assert.equal(bundledDatabaseUrl(65535), 'postgresql://ticket_system:ticket_system@127.0.0.1:65535/ticket_system');
  assert.equal(
    bundledDatabaseUrl('05432'),
    'postgresql://ticket_system:ticket_system@127.0.0.1:5432/ticket_system'
  );
  for (const refused of [0, '0', -1, '-5432', 65536, '65536', '5432junk', '12abc', '5432.5', '9999999999999999999']) {
    assert.throws(
      () => bundledDatabaseUrl(refused),
      (error) => error.message === TSPP_EXPECTED_MESSAGE,
      `bundledDatabaseUrl(${JSON.stringify(refused)}) is refused with the canonical owner message`
    );
  }

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

    const customBundled = {
      DATABASE_URL: DEFAULT_DATABASE_URL,
      TICKET_SYSTEM_POSTGRES_PORT: '55432'
    };
    applyLocalEnv(customBundled, path.join(temporary, 'absent.env'));
    assert.equal(customBundled.DATABASE_URL, bundledDatabaseUrl(55432));
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
  // P6-S2: the doctor reads the canonical migration facts
  // (`getMigrationStatus` plus the read-only observation) instead of the old
  // prepareRuntimePersistence() latch. This stub answers those calls with a
  // fully-current ledger derived from the canonical enumeration.
  function fullyCurrentStoreStub({ adminUser, agents, onClose }) {
    const { migrationFiles, migrationChecksum } = require('../persistence/postgres/store');
    const versions = migrationFiles();
    return {
      async getMigrationStatus() {
        return {
          fullyApplied: true,
          checksumsValid: true,
          partial: false,
          currentVersion: Number(versions[versions.length - 1].slice(0, 3)),
          headVersion: Number(versions[versions.length - 1].slice(0, 3)),
          pendingMigrations: 0,
          unknownMigrations: 0
        };
      },
      async withTransaction(operation) {
        return operation({
          async query(sql) {
            if (sql.includes('current_database()')) return { rows: [{ name: 'stubdb' }] };
            if (sql.includes('pg_namespace')) return { rowCount: 1, rows: [] };
            if (sql.includes('to_regclass')) return { rows: [{ name: 'stub' }] };
            if (sql.includes('schema_migration_identities')) {
              return { rows: versions.map(version => ({ version, sha256: migrationChecksum(version) })) };
            }
            if (sql.includes('schema_migrations')) {
              return { rows: versions.map(version => ({ version })) };
            }
            return { rows: [], rowCount: 0 };
          }
        });
      },
      async getUserByUsername() { return adminUser; },
      async listConfiguredAgents() { return { agents, nextAfterId: null }; },
      async close() { if (onClose) onClose(); }
    };
  }
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
    storeFactory: () => fullyCurrentStoreStub({
      adminUser: existingAdmin,
      agents: [{ provider: 'openai', model: 'test-model', apiKey: 'stored' }],
      onClose: () => { closed = true; }
    }),
    verifyPassword: async (_hash, candidate) => candidate === 'admin123'
  });
  assert.equal(healthy.ok, true, 'warnings must not turn a usable environment into a startup outage');
  assert.equal(closed, true);
  assert.equal(healthy.checks.some(check => check.label === 'ADMIN_BOOTSTRAP_PASSWORD'), false);
  const passwordWarning = healthy.checks.find(
    check => check.status === 'warn' && check.label === 'admin password'
  );
  assert.ok(passwordWarning);
  assert.match(passwordWarning.message, /predictable default/);
  assert.doesNotMatch(passwordWarning.message, /legacy|initial/i);
  const rendered = [];
  printChecks(healthy, { write(value) { rendered.push(value) } });
  assert.equal(rendered.join('').includes('stale'), false, 'doctor output must not expose secret values');
  const doctorMigrationRow = healthy.checks.find(check => check.label === 'PostgreSQL migrations');
  assert.ok(doctorMigrationRow, 'doctor renders one canonical migration-ledger row');
  assert.equal(doctorMigrationRow.status, 'pass', 'a fully-current ledger is reported CURRENT');
  assert.match(doctorMigrationRow.message, /current/, 'the CURRENT guidance states the ledger truth');
  assert.equal(
    developmentConfig({}).workspaceRoot,
    path.resolve(path.join(__dirname, '..'), 'workspace-root'),
    'the development workspace default is the one canonical default the server also uses'
  );

  // P6-S2 defect-B effect-root semantics inside the doctor: a path that exists
  // but is not a directory, and a missing path under an unusable parent, fail
  // the check with the honest corrected messages (never "usable").
  const { writablePathStatus } = require('./dev-environment');
  const pathCheckTemporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-env-path-'));
  try {
    const fileRoot = path.join(pathCheckTemporary, 'root-as-file');
    fs.writeFileSync(fileRoot, 'regular file');
    const fileStatus = writablePathStatus(fileRoot);
    assert.equal(fileStatus.ok, false, 'a regular file is not a usable effect root');
    assert.match(fileStatus.message, /not a directory/);

    const usableDir = path.join(pathCheckTemporary, 'usable-root');
    fs.mkdirSync(usableDir);
    assert.equal(writablePathStatus(usableDir).ok, true);
    assert.equal(writablePathStatus(path.join(usableDir, 'missing-root')).ok, true, 'creatable under a usable parent');
    assert.match(writablePathStatus(path.join(usableDir, 'missing-root')).message, /will be created/);

    const parentFile = path.join(pathCheckTemporary, 'parent-file');
    fs.writeFileSync(parentFile, 'regular file');
    const underFile = writablePathStatus(path.join(parentFile, 'child'));
    assert.equal(underFile.ok, false, 'a missing root under a file parent is unusable');
    assert.match(underFile.message, /not a directory/);
  } finally {
    fs.rmSync(pathCheckTemporary, { recursive: true, force: true });
  }
  console.log('  ok the doctor effect-root check uses the corrected directory-boundary semantics');

  const missingAdmin = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'long-enough-bootstrap-password' },
    storeFactory: () => fullyCurrentStoreStub({ adminUser: null, agents: [{ provider: 'ollama', model: 'test-model' }] })
  });
  assert.equal(missingAdmin.ok, false);
  assert.ok(missingAdmin.checks.some(check => check.status === 'fail' && check.label === 'admin account'));

  const missingAgents = await inspectDevelopmentEnvironment({
    env: baseEnv,
    storeFactory: () => fullyCurrentStoreStub({ adminUser: existingAdmin, agents: [] }),
    verifyPassword: async () => false
  });
  assert.equal(missingAgents.ok, false);
  assert.ok(missingAgents.checks.some(check => check.status === 'fail' && check.label === 'configured agents'));
  assert.equal(agentReadiness({ provider: 'openai', model: 'gpt-test' }, {}).ready, false);
  assert.equal(agentReadiness({ provider: 'openai', model: 'gpt-test' }, { OPENAI_API_KEY: 'set' }).ready, true);
  assert.equal(agentReadiness({ provider: 'ollama', model: 'local-test' }, {}).ready, true);
  assert.equal(providerConfigFromEnvironment({ OPENAI_API_KEY: 'key', OPENAI_MODEL: 'model' }).provider, 'openai');
  assert.equal(providerConfigFromEnvironment({ OLLAMA_MODEL: 'local' }).provider, 'ollama');

  const promptedOpenAI = await promptProviderConfig({
    env: { DEV_AGENT_PROVIDER: 'openai' },
    visiblePrompt: async (_message, { defaultValue }) => defaultValue,
    hiddenPrompt: async () => 'hidden-test-key'
  });
  assert.equal(promptedOpenAI.model, DEFAULT_OPENAI_MODEL);
  assert.equal(promptedOpenAI.apiKey, 'hidden-test-key');

  const podmanRuntime = selectComposeRuntime({
    spawn(command, args) {
      assert.deepEqual(args, ['compose', 'version']);
      return { status: command === 'podman' ? 0 : 1 };
    }
  });
  assert.equal(podmanRuntime.label, 'Podman Compose');
  const standaloneRuntime = selectComposeRuntime({
    spawn(command, args) {
      if (command === 'podman-compose') assert.deepEqual(args, ['version']);
      return { status: command === 'podman-compose' ? 0 : 1 };
    }
  });
  assert.equal(standaloneRuntime.command, 'podman-compose');
  const composeCalls = [];
  const verifiedTargets = [];
  const started = await startDevelopmentDatabase({
    runtime: podmanRuntime,
    composeFile: '/repo/compose.dev.yml',
    env: {},
    applyEnv() {},
    spawn(command, args, options) {
      composeCalls.push({ command, args, options });
      return { status: 0 };
    },
    async verifyDatabase({ databaseTarget }) { verifiedTargets.push(databaseTarget); }
  });
  assert.equal(started.runtime, podmanRuntime);
  assert.equal(started.databaseTarget.databaseUrl, DEFAULT_DATABASE_URL);
  assert.deepEqual(verifiedTargets, [defaultDatabaseTarget]);
  assert.equal(composeCalls[0].command, 'podman');
  assert.deepEqual(composeCalls[0].args, [
    'compose', '-f', '/repo/compose.dev.yml', 'up', '-d', '--wait'
  ]);
  assert.equal(composeCalls[0].options.env.TICKET_SYSTEM_POSTGRES_PORT, '5432');
  await assert.rejects(
    startDevelopmentDatabase({
      runtime: null,
      env: {},
      applyEnv() {},
      spawn: () => ({ status: 1 })
    }),
    /Docker Compose or Podman Compose is required/
  );
  await assert.rejects(
    startDevelopmentDatabase({
      runtime: podmanRuntime,
      composeFile: '/repo/compose.dev.yml',
      env: {},
      applyEnv() {},
      spawn: () => ({ status: 0 }),
      async verifyDatabase() { throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }); }
    }),
    /connect refused/
  );

  let readinessConfig;
  const verifiedTarget = await verifyConfiguredDatabase({
    databaseTarget: defaultDatabaseTarget,
    clientFactory(config) {
      readinessConfig = config;
      return {
        async connect() {},
        async query(sql) { assert.equal(sql, 'SELECT 1'); },
        async end() {}
      };
    }
  });
  assert.equal(verifiedTarget, defaultDatabaseTarget);
  assert.equal(readinessConfig.connectionString, DEFAULT_DATABASE_URL);
  assert.equal(readinessConfig.connectionTimeoutMillis, 3000);
  await assert.rejects(
    verifyConfiguredDatabase({
      databaseTarget: {
        kind: 'external',
        databaseUrl: 'postgresql://user:test-only-password@127.0.0.1:55432/db'
      },
      clientFactory() {
        return {
          async connect() {
            throw new Error(
              'connect postgresql://user:test-only-password@127.0.0.1:55432/db failed'
            );
          },
          async end() {}
        };
      }
    }),
    error => {
      assert.match(error.message, /cannot complete a host-side PostgreSQL query/);
      assert.match(error.message, /external DATABASE_URL/);
      assert.equal(error.message.includes('test-only-password'), false);
      return true;
    }
  );

  let externalSpawnCalls = 0;
  let verifiedExternalTarget = null;
  const external = await startDevelopmentDatabase({
    env: { DATABASE_URL: externalDatabaseUrl },
    applyEnv() {},
    spawn() { externalSpawnCalls += 1; return { status: 0 }; },
    async verifyDatabase({ databaseTarget }) { verifiedExternalTarget = databaseTarget; }
  });
  assert.equal(external.runtime, null);
  assert.equal(external.databaseTarget.kind, 'external');
  assert.equal(verifiedExternalTarget.databaseUrl, externalDatabaseUrl);
  assert.equal(externalSpawnCalls, 0);

  let failedExternalSpawnCalls = 0;
  await assert.rejects(
    startDevelopmentDatabase({
      env: { DATABASE_URL: externalDatabaseUrl },
      applyEnv() {},
      spawn() { failedExternalSpawnCalls += 1; return { status: 0 }; },
      async verifyDatabase({ databaseTarget }) {
        return verifyConfiguredDatabase({
          databaseTarget,
          clientFactory() {
            return {
              async connect() { throw new Error('external connectivity failed'); },
              async end() {}
            };
          }
        });
      }
    }),
    /configured external DATABASE_URL.*external connectivity failed/
  );
  assert.equal(failedExternalSpawnCalls, 0);

  const customComposeCalls = [];
  let customVerifiedTarget = null;
  await startDevelopmentDatabase({
    runtime: podmanRuntime,
    composeFile: '/repo/compose.dev.yml',
    env: {
      DATABASE_URL: DEFAULT_DATABASE_URL,
      TICKET_SYSTEM_POSTGRES_PORT: '55432'
    },
    applyEnv() {},
    spawn(command, args, options) {
      customComposeCalls.push({ command, args, options });
      return { status: 0 };
    },
    async verifyDatabase({ databaseTarget }) { customVerifiedTarget = databaseTarget; }
  });
  assert.equal(customComposeCalls[0].options.env.TICKET_SYSTEM_POSTGRES_PORT, '55432');
  assert.equal(new URL(customVerifiedTarget.databaseUrl).port, '55432');

  let repeatedComposeStarts = 0;
  let repeatedHostChecks = 0;
  for (let index = 0; index < 2; index += 1) {
    await startDevelopmentDatabase({
      runtime: podmanRuntime,
      env: {},
      applyEnv() {},
      spawn() { repeatedComposeStarts += 1; return { status: 0 }; },
      async verifyDatabase() { repeatedHostChecks += 1; }
    });
  }
  assert.equal(repeatedComposeStarts, 2);
  assert.equal(repeatedHostChecks, 2);

  for (const file of ['dev-database.js', 'dev-setup.js', 'dev-doctor.js', 'postgres-migrate.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.equal(
      source.includes(DEFAULT_DATABASE_URL),
      false,
      `${file} must consume the shared development database authority rather than duplicate its URL`
    );
  }
  assert.match(
    fs.readFileSync(path.join(__dirname, 'dev-doctor.js'), 'utf8'),
    /developmentConfig\(env\)/,
    'dev:doctor must resolve its database through the shared development configuration'
  );
  const migrationSource = fs.readFileSync(path.join(__dirname, 'postgres-migrate.js'), 'utf8');
  assert.match(migrationSource, /developmentConfig\(process\.env\)/);
  assert.doesNotMatch(migrationSource, /process\.env\.DATABASE_URL/);
  const developmentStartupSource = fs.readFileSync(path.join(__dirname, 'dev.js'), 'utf8');
  assert.ok(
    developmentStartupSource.indexOf('applyLocalEnv()') < developmentStartupSource.indexOf("require('../server')"),
    'dev startup must normalize DATABASE_URL before loading the server that consumes it directly'
  );

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

  let createdAgentInput;
  const initialAgent = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() { return { agents: [], nextAfterId: null }; },
      async listGroups() { return { groups: [{ id: 9, name: 'Agent Support' }] }; },
      async createConfiguredAgent(input) {
        createdAgentInput = input;
        return { agent: { id: 11, ...input.value, groupIds: input.groupIds } };
      }
    },
    env: { OLLAMA_MODEL: 'local-test-model' },
    interactive: false
  });
  assert.equal(initialAgent.created, true);
  assert.equal(createdAgentInput.changedBy, 'dev-setup');
  assert.deepEqual(createdAgentInput.groupIds, [9]);
  assert.equal(createdAgentInput.value.provider, 'ollama');
  assert.equal(createdAgentInput.value.model, 'local-test-model');

  const existingAgent = { id: 12, name: 'Existing', provider: 'openai', model: 'existing-model', apiKey: 'stored' };
  const preservedAgent = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() { return { agents: [existingAgent], nextAfterId: null }; },
      async listGroups() { throw new Error('must not inspect groups'); },
      async createConfiguredAgent() { throw new Error('must not create'); }
    },
    env: {},
    interactive: false
  });
  assert.equal(preservedAgent.created, false);
  assert.equal(preservedAgent.agent, existingAgent);

  let repairInput;
  const repairedCatalog = await ensureInitialAgent({
    store: {
      async listConfiguredAgents() {
        return { agents: [{ id: 13, name: 'Developer Agent', provider: 'openai', model: '' }], nextAfterId: null };
      },
      async listGroups() { return { groups: [{ id: 9, name: 'Agent Support' }] }; },
      async createConfiguredAgent(input) {
        repairInput = input;
        return { agent: { id: 14, ...input.value, groupIds: input.groupIds } };
      }
    },
    env: { OLLAMA_MODEL: 'repair-model' },
    interactive: false
  });
  assert.equal(repairedCatalog.created, true);
  assert.equal(repairInput.value.name, 'Developer Agent 2');
  assert.equal(repairInput.value.provider, 'ollama');

  await assert.rejects(
    ensureInitialAgent({
      store: { async listConfiguredAgents() { return { agents: [], nextAfterId: null }; } },
      env: {},
      interactive: false
    }),
    /No runnable configured agent exists/
  );

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
  assert.throws(() => parseSmokeArgs(['--password', 'visible-secret']), /cannot be passed/);

  let smokeTicketCreated = false;
  const smokeOutput = [];
  const smokeResult = await runSmoke({
    options: parseSmokeArgs(['--timeout-ms', '1000']),
    env: { DEV_SMOKE_PASSWORD: 'hidden-test-password' },
    output: { write(value) { smokeOutput.push(value); } },
    sleep: async () => {},
    request: async (method, url, requestOptions = {}) => {
      if (url.endsWith('/health')) {
        assert.equal(method, 'GET');
        return { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', ready: true }) };
      }
      if (url.endsWith('/login')) {
        assert.equal(method, 'POST');
        assert.match(requestOptions.body, /username=admin/);
        assert.match(requestOptions.body, /password=hidden-test-password/);
        return { status: 302, headers: { 'set-cookie': ['sessionId=test-cookie; Path=/'] }, body: '' };
      }
      if (url.includes('/api/configured-agents/resolve')) {
        return { status: 200, headers: {}, body: JSON.stringify({ agent: { id: 5, name: 'Developer Agent' } }) };
      }
      if (url.endsWith('/tickets') && method === 'POST') {
        assert.equal(new URLSearchParams(requestOptions.body).get('objective'), SMOKE_OBJECTIVE);
        smokeTicketCreated = true;
        return { status: 302, headers: {}, body: '' };
      }
      if (url.includes('/api/tickets/3/runtime')) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            ticket: { id: 3, objective: SMOKE_OBJECTIVE, status: 'completed' },
            latestRun: { id: 4, status: 'completed' }
          })
        };
      }
      if (url.includes('/api/workspace/list')) {
        return { status: 200, headers: {}, body: JSON.stringify({ entries: [] }) };
      }
      if (url.endsWith('/api/tickets')) {
        const tickets = smokeTicketCreated
          ? [{ id: 3, objective: SMOKE_OBJECTIVE }]
          : [{ id: 2, objective: 'existing' }];
        return { status: 200, headers: {}, body: JSON.stringify({ tickets }) };
      }
      throw new Error('Unexpected smoke request: ' + method + ' ' + url);
    }
  });
  assert.equal(smokeResult.workspaceVerified, true);
  assert.match(smokeOutput.join(''), /ticket #3, run #4/);

  const packageJson = require('../package.json');
  assert.match(packageJson.scripts.dev, /scripts\/dev\.js$/);
  assert.match(packageJson.scripts['dev:db'], /scripts\/dev-database\.js$/);
  assert.match(packageJson.scripts['dev:smoke'], /scripts\/dev-smoke\.js$/);
  assert.match(packageJson.scripts['dev:setup'], /scripts\/dev-setup\.js$/);
  assert.match(packageJson.scripts['dev:doctor'], /scripts\/dev-doctor\.js$/);
  assert.match(packageJson.scripts['admin:password'], /scripts\/admin-password\.js$/);

  console.log('PASS: development setup is non-destructive, diagnosable, and uses audited credential updates');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
