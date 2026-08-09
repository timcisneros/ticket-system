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
      async listConfiguredAgents() { return { agents: [{ provider: 'openai', model: 'test-model', apiKey: 'stored' }], nextAfterId: null }; },
      async close() { closed = true; }
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
  printChecks(healthy, { write(value) { rendered.push(value); } });
  assert.equal(rendered.join('').includes('stale'), false, 'doctor output must not expose secret values');

  const missingAdmin = await inspectDevelopmentEnvironment({
    env: { ...baseEnv, ADMIN_BOOTSTRAP_PASSWORD: 'long-enough-bootstrap-password' },
    storeFactory: () => ({
      async prepareRuntimePersistence() {},
      async getUserByUsername() { return null; },
      async listConfiguredAgents() { return { agents: [{ provider: 'ollama', model: 'test-model' }], nextAfterId: null }; },
      async close() {}
    })
  });
  assert.equal(missingAdmin.ok, false);
  assert.ok(missingAdmin.checks.some(check => check.status === 'fail' && check.label === 'admin account'));

  const missingAgents = await inspectDevelopmentEnvironment({
    env: baseEnv,
    storeFactory: () => ({
      async prepareRuntimePersistence() {},
      async getUserByUsername() { return existingAdmin; },
      async listConfiguredAgents() { return { agents: [], nextAfterId: null }; },
      async close() {}
    }),
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
