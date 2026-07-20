#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const {
  MIN_ADMIN_PASSWORD_LENGTH,
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
const {
  DEFAULT_OPENAI_MODEL,
  agentReadiness,
  ensureInitialAgent,
  promptProviderConfig,
  providerConfigFromEnvironment
} = require('./dev-agent-config');
const { selectComposeRuntime, startDevelopmentDatabase } = require('./dev-database');
const { createInitialAdmin } = require('./dev-setup');
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
  const startedRuntime = startDevelopmentDatabase({
    runtime: podmanRuntime,
    composeFile: '/repo/compose.dev.yml',
    spawn(command, args, options) {
      composeCalls.push({ command, args, options });
      return { status: 0 };
    }
  });
  assert.equal(startedRuntime, podmanRuntime);
  assert.equal(composeCalls[0].command, 'podman');
  assert.deepEqual(composeCalls[0].args, [
    'compose', '-f', '/repo/compose.dev.yml', 'up', '-d', '--wait'
  ]);
  assert.throws(
    () => startDevelopmentDatabase({ runtime: null, spawn: () => ({ status: 1 }) }),
    /Docker Compose or Podman Compose is required/
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
