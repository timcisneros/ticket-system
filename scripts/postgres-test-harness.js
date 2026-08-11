'use strict';

// Shared PostgreSQL test harness (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// The JSON-era harnesses each carried their own copy of the same ~90 lines:
// a DATA_DIR of seeded JSON files, an HTTP client, a readiness poll, a login
// helper, and a server spawn. The PostgreSQL cutover orphaned all of them at
// once — the server no longer reads DATA_DIR at all, so those tests seeded a
// directory the runtime ignores and then died on a missing DATABASE_URL.
//
// This module is the single bootstrap they migrate onto. It deliberately does
// NOT abstract what each suite asserts; it only removes the duplicated
// scaffolding so a repaired suite is mostly seeding plus assertions.
//
// Guarantees:
//   - explicit test database URL, with a clear failure when absent
//   - one isolated schema per test process, so suites never observe each
//     other's rows or a developer's local data
//   - deterministic schema initialization through the real store migration
//   - deterministic cleanup on success AND failure
//   - stale schemas from interrupted runs are reaped by age, so a killed test
//     never leaves the database permanently dirty
//   - no JSON or in-memory fallback: these suites exercise the PostgreSQL
//     runtime because that is what production uses
//   - no credentials or machine-specific paths baked in

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require(path.join(ROOT, 'persistence/postgres/store'));
const { stopChild } = require('./child-process-settlement');

// Every schema this harness creates carries this prefix so reaping can identify
// its own leftovers and never touch anything else in the database.
const SCHEMA_PREFIX = 'tstharness';
const STALE_SCHEMA_MAX_AGE_MS = 60 * 60 * 1000;

// Deliberately loud. A test that cannot reach PostgreSQL must fail, never skip
// and never silently fall back to another store.
function requireTestDatabaseUrl(suiteName) {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error(
      `FAIL: ${suiteName} requires a PostgreSQL test database.\n` +
      '      Set TEST_DATABASE_URL (preferred) or DATABASE_URL to a database this test may\n' +
      '      create and drop schemas in. This suite exercises the PostgreSQL runtime and has\n' +
      '      no JSON or in-memory fallback.'
    );
    process.exit(1);
  }
  return url;
}

// Schema name encodes creation time so interrupted runs can be reaped by age
// without a registry table.
function createTestSchemaName(suiteSlug) {
  const slug = String(suiteSlug || 'suite').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24);
  return `${SCHEMA_PREFIX}_${slug}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function schemaAgeMs(schemaName) {
  const match = new RegExp(`^${SCHEMA_PREFIX}_[a-z0-9_]*_([a-z0-9]+)_[0-9a-f]{6}$`).exec(schemaName);
  if (!match) return null;
  const created = parseInt(match[1], 36);
  return Number.isFinite(created) ? Date.now() - created : null;
}

// Drop harness schemas left behind by killed runs. Bounded to this harness's own
// prefix and to schemas older than the cutoff, so a concurrently running suite is
// never dropped out from under itself.
async function reapStaleSchemas(store) {
  try {
    const result = await store.pool.query(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1',
      [`${SCHEMA_PREFIX}\\_%`]
    );
    for (const row of result.rows) {
      const age = schemaAgeMs(row.schema_name);
      if (age === null || age < STALE_SCHEMA_MAX_AGE_MS) continue;
      await store.pool.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
    }
  } catch (_) {
    // Reaping is best-effort housekeeping and must never fail a suite.
  }
}

function requestFactory(baseUrl) {
  return function request(method, urlPath, options = {}) {
    const body = options.form
      ? new URLSearchParams(options.form).toString()
      : options.body ? JSON.stringify(options.body) : null;
    return new Promise((resolve, reject) => {
      const req = http.request(`${baseUrl}${urlPath}`, {
        method,
        headers: {
          ...(options.form ? {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
          } : {}),
          ...(options.body ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.headers || {})
        }
      }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require('net').createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The test-server startup contract ────────────────────────────────────────
//
// One closed named-argument shape, validated BEFORE any child process starts.
//
// This exists because the previous contract failed silently rather than loudly.
// A suite wrote `startServer({ env: { NODE_OPTIONS: '--require …' } })` — the
// shape the private spawn function uses — and the positional wrapper took that
// whole object as the environment map. The server started, healthy and green,
// with a child variable named `env` and no `NODE_OPTIONS`. The hermetic preload
// never ran, and every assertion that depended on it was vacuous. Nothing
// crashed, so nothing was noticed.
//
// The lesson is not "read the signature more carefully". Two adjacent contracts
// where one is a superset of the other cannot be told apart by discipline, so
// this refuses everything that is not exactly the supported shape.

const START_ARGUMENT_KEYS = Object.freeze(['env', 'serverOptions', 'spawnEnvObserver']);
const START_SHAPE_ERROR = 'TEST_SERVER_START_ARGUMENT_SHAPE_INVALID';

class TestServerStartArgumentError extends Error {
  constructor(message, detail = {}) {
    super(`${START_SHAPE_ERROR}: ${message}`);
    this.name = 'TestServerStartArgumentError';
    this.code = START_SHAPE_ERROR;
    this.detail = detail;
  }
}

function isPlainObjectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readStartArgument(argument) {
  if (!isPlainObjectValue(argument)) {
    throw new TestServerStartArgumentError(
      'startServer takes one plain object: { env, serverOptions }',
      { received: Array.isArray(argument) ? 'array' : typeof argument });
  }

  // The legacy positional call passed the environment map directly, so its keys
  // are environment variable names. Naming them in the refusal turns a silent
  // misconfiguration into a message that says what to write instead.
  const unknown = Object.keys(argument).filter(key => !START_ARGUMENT_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new TestServerStartArgumentError(
      `unsupported key(s) ${unknown.join(', ')}; the environment map now goes ` +
      `under env, as startServer({ env: { ${unknown[0]}: … } })`,
      { unknown });
  }

  for (const key of START_ARGUMENT_KEYS) {
    // The spawn-boundary observer is a function by design; every other option
    // is a plain map.
    if (key === 'spawnEnvObserver') {
      if (argument[key] !== undefined && typeof argument[key] !== 'function') {
        throw new TestServerStartArgumentError('spawnEnvObserver must be a function',
          { key, received: typeof argument[key] });
      }
      continue;
    }
    if (argument[key] !== undefined && !isPlainObjectValue(argument[key])) {
      throw new TestServerStartArgumentError(`${key} must be a plain object`,
        { key, received: typeof argument[key] });
    }
  }

  const env = argument.env || {};
  // `{ env: { env: … } }` is the original mistake made one level deeper. An
  // environment variable named `env` or `serverOptions` is meaningless to the
  // server, so treating it as a typo rather than a value loses nothing real.
  const nested = START_ARGUMENT_KEYS.filter(key => key in env);
  if (nested.length > 0) {
    throw new TestServerStartArgumentError(
      `env contains the key(s) ${nested.join(', ')}, which names an environment ` +
      'variable rather than a configuration section — the argument is nested ' +
      'one level too deep',
      { nested });
  }

  return {
    env,
    serverOptions: argument.serverOptions || {},
    spawnEnvObserver: argument.spawnEnvObserver || null
  };
}

// Start the real server against the harness schema. Everything the JSON-era
// harnesses configured through DATA_DIR is now configured through the database.
//
// PRIVATE. Suites never call this. It takes `env` as one KEY among several,
// while the function suites are handed took `env` POSITIONALLY — two contracts
// one rename apart, which is exactly how `startServer({ env: { NODE_OPTIONS } })`
// came to mean "set a child environment variable literally named env" and a
// hermetic preload silently never loaded. `startTestServer` below is the only
// supported entry point.
async function spawnTestServer({
  databaseUrl,
  schema,
  workspaceRoot,
  env = {},
  // Test-only. See the spawn-boundary observer below.
  spawnEnvObserver = null,
  adminPassword = 'admin123',
  readyTimeoutMs = 45000
}) {
  const port = String(await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = requestFactory(baseUrl);
  let output = '';

  // NO DEVELOPER CREDENTIAL REACHES A TEST SERVER.
  //
  // A real-server harness once stubbed `global.fetch` and was believed offline.
  // The governed OpenAI transport uses `https.request`, not `fetch`, so the stub
  // intercepted nothing — and because this spawn inherits `process.env`, a
  // developer key loaded from `.env.local` could reach the live API. Stripping
  // here protects every real-server suite, not just the one that noticed.
  //
  // Values are never read or logged; the keys are simply removed.
  const inheritedEnv = { ...process.env };
  for (const credentialKey of [
    'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'
  ]) {
    delete inheritedEnv[credentialKey];
  }
  // Historical structured reconstruction is test-owner authority, not ambient
  // process authority. Only an explicit repository-owned runner configuration
  // may restore this key below; an ordinary server never inherits it merely
  // because its parent happened to run an evaluation earlier.
  delete inheritedEnv.EVALUATION_FIXTURE_NAMESPACE;

  // THE EXACT ENVIRONMENT THE CHILD WILL RECEIVE. Built before spawning so the
  // spawn-boundary observer below can inspect the real thing rather than a
  // reconstruction of it.
  const childEnv = {
    ...inheritedEnv,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    POSTGRES_SCHEMA: schema,
    PORT: port,
    WORKSPACE_ROOT: workspaceRoot,
    SESSION_SECRET: 'postgres-test-harness-secret-0123456789abcdef0123456789abcdef',
    ADMIN_BOOTSTRAP_PASSWORD: adminPassword,
    PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
    // Applied LAST, so an explicit override wins over the stripped inherited
    // environment. That precedence is what lets a real live run restore the
    // credential the strip above removed.
    ...env
  };

  // ── TEST-ONLY SPAWN-BOUNDARY OBSERVER ─────────────────────────────────
  //
  // The credential branch a REAL live run takes cannot be proved through the
  // final-hop capture: that branch supplies a sentinel, which is precisely what
  // hid the defect this seam exists to catch. So a test may observe the exact
  // child environment at the moment before spawn and stop there — the real
  // branch runs, and no child process capable of provider contact is created.
  //
  // It is never set in ordinary operation, and it receives the environment
  // rather than being told about it, so it cannot be satisfied by a summary.
  if (typeof spawnEnvObserver === 'function') {
    spawnEnvObserver(childEnv);
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited during startup (code ${child.exitCode}):\n${output.slice(-3000)}`);
    }
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready) { ready = true; break; }
    } catch (_) { /* not up yet */ }
    await sleep(150);
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`server did not become ready within ${readyTimeoutMs}ms:\n${output.slice(-3000)}`);
  }

  async function login(username = 'admin', password = adminPassword) {
    const response = await request('POST', '/login', { form: { username, password } });
    if (response.statusCode !== 302) {
      throw new Error(`login failed with HTTP ${response.statusCode}`);
    }
    const raw = response.headers['set-cookie'] || [];
    const cookie = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(c => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('login returned no session cookie');
    return cookie;
  }

  // Teardown must WAIT for the child to actually die. The previous implementation sent
  // SIGKILL and returned immediately, so `withHarness` could drop the schema — and the
  // checkpoint could start the next suite — while a killed server was still unwinding
  // its connections and transactions. Across a ~50-suite checkpoint that is an
  // unbounded number of overlapping shutdowns.
  //
  // This is NOT a proven cause of any observed failure; see A20 on the
  // concurrency-conflict incident, which did not reproduce. It is fixed because
  // "signalled" is not "exited", which is the same distinction
  // scripts/child-process-settlement.js was written for.
  async function stop() {
    await stopChild(child, { graceMs: 5000, killMs: 15000 });
  }

  return { baseUrl, port, request, login, stop, child, output: () => output };
}

// Full lifecycle wrapper. Cleanup runs on success and on failure, including when
// the body throws, so a failing suite never leaves a schema or workspace behind.
async function withHarness(suiteName, body, options = {}) {
  const databaseUrl = requireTestDatabaseUrl(suiteName);
  const schema = createTestSchemaName(options.schemaSlug || suiteName);
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${SCHEMA_PREFIX}-ws-`));
  const store = new PostgresRuntimeStore({ connectionString: databaseUrl, schema });

  let servers = [];
  try {
    try {
      await store.migrate();
    } catch (error) {
      console.error(
        `FAIL: ${suiteName} could not initialize its PostgreSQL test schema.\n` +
        `      ${error && error.message ? error.message : error}\n` +
        '      This suite requires a reachable PostgreSQL database and does not fall back.'
      );
      process.exit(1);
    }
    await reapStaleSchemas(store);

    const startTestServer = async (argument = {}) => {
      const { env, serverOptions, spawnEnvObserver } = readStartArgument(argument);
      const server = await spawnTestServer({
        databaseUrl, schema, workspaceRoot, env, spawnEnvObserver, ...serverOptions
      });
      servers.push(server);
      return server;
    };

    return await body({ store, schema, databaseUrl, workspaceRoot, startServer: startTestServer });
  } finally {
    for (const server of servers) {
      try { await server.stop(); } catch (_) { /* best effort */ }
    }
    try { await store.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch (_) { /* best effort */ }
    try { await store.close(); } catch (_) { /* best effort */ }
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

// Small assertion helper so repaired suites report a count rather than only a
// pass/fail, making "the suite reached its assertions" observable.
function createAsserter() {
  const state = { passed: 0 };
  function assert(condition, message) {
    if (!condition) throw new Error(message);
    state.passed += 1;
    console.log(`  ok ${message}`);
  }
  assert.count = () => state.passed;
  return assert;
}

module.exports = {
  SCHEMA_PREFIX,
  requireTestDatabaseUrl,
  createTestSchemaName,
  schemaAgeMs,
  // `spawnTestServer` is deliberately NOT exported. Exporting both it and the
  // validated wrapper would restore the two-contract ambiguity this replaced.
  START_SHAPE_ERROR,
  TestServerStartArgumentError,
  readStartArgument,
  withHarness,
  createAsserter,
  freePort,
  sleep
};
