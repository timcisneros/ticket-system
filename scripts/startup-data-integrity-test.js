#!/usr/bin/env node
'use strict';
// Startup data integrity — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A10).
//
// REPLACEMENT, not a repair. The original drove 15 scenarios that wrote corrupt
// JSON into DATA_DIR and asserted the server refused to start. DATA_DIR is retired
// and read nowhere, so every one of those scenarios exercised a mechanism that no
// longer exists. Porting them literally would assert nothing about the runtime.
//
// The BEHAVIORAL CONTRACT survives the cutover and is what this suite preserves:
// when persistent state is unusable, the server must REFUSE TO START rather than
// mistake it for an empty first-run store. Proceeding is the dangerous outcome,
// because first-run bootstrap creates a default administrator — which would turn a
// storage fault into an authentication bypass.
//
// THE POSITIVE CONTROL IS LOAD-BEARING. A suite that only asserts "exit code is
// non-zero" cannot tell a storage-integrity refusal apart from a server that died
// for an unrelated reason, so every scenario would pass even if the contract were
// gone. Scenario 0 therefore starts the SAME server with the SAME environment
// against an intact schema and requires it to become ready and announce the
// bootstrap admin. Only the injected fault differs between scenario 0 and the
// refusal scenarios, so each refusal is attributable to that fault.
//
// Assertions preserved from the original, re-expressed against PostgreSQL:
//   * a non-zero exit (refusal), not a running server
//   * the refusal names the integrity failure rather than an unrelated crash
//   * no default admin is created from unusable state
//   * no bootstrap password appears in the output
//   * the failed start does not rewrite or "repair" the underlying state
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the startup data integrity test');
  process.exit(1);
}

// A distinctive bootstrap password so the leak assertion is about THIS run's
// secret rather than the historical 'admin123' literal, which no longer applies
// once ADMIN_BOOTSTRAP_PASSWORD is supplied.
const BOOTSTRAP_PASSWORD = `startup-integrity-pw-${crypto.randomBytes(6).toString('hex')}`;
const SESSION_SECRET = `startup-integrity-secret-${crypto.randomBytes(16).toString('hex')}`;

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ok ${message}`);
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

// The one environment every scenario shares. Only the database state differs.
function serverEnv({ schema, port, workspaceRoot }) {
  return {
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL,
    POSTGRES_SCHEMA: schema,
    WORKSPACE_ROOT: workspaceRoot,
    SESSION_SECRET,
    ADMIN_BOOTSTRAP_PASSWORD: BOOTSTRAP_PASSWORD,
    PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
  };
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const state = { output: '' };
  child.stdout.on('data', c => { state.output += String(c); });
  child.stderr.on('data', c => { state.output += String(c); });
  return { child, state };
}

function waitForExit({ child, state }, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(
        `server did not refuse unusable state within ${timeoutMs}ms; output=${state.output.slice(-800)}`
      ));
    }, timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output: state.output }); });
  });
}

function health(port) {
  return new Promise(resolve => {
    const req = http.request(`http://127.0.0.1:${port}/health`, { method: 'GET' }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function waitForReady(server, port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`server exited (code ${server.child.exitCode}) instead of becoming ready:\n${server.state.output.slice(-800)}`);
    }
    const response = await health(port);
    if (response && response.statusCode === 200) {
      try { if (JSON.parse(response.body).ready) return; } catch (_) { /* not ready yet */ }
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms:\n${server.state.output.slice(-800)}`);
}

async function stopServer({ child }) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null; i += 1) {
    await new Promise(r => setTimeout(r, 100));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

// Shared refusal shape. `expectedCause` keeps a refusal from passing when the
// process died for a reason that has nothing to do with persistent state.
function assertRefusal(name, code, output, expectedCause) {
  assert(code !== 0, `${name}: the server refused to start (exit ${code})`);
  assert(expectedCause.test(output),
    `${name}: the refusal names the storage fault, not an unrelated crash`);
  assert(!/Default admin user created/i.test(output),
    `${name}: unusable state was not treated as an empty first-run store`);
  assert(!output.includes(BOOTSTRAP_PASSWORD),
    `${name}: no bootstrap password leaked during the refusal`);
}

async function main() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-integrity-ws-'));
  const suffix = `${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const controlSchema = `startup_integrity_ok_${suffix}`;
  const brokenSchema = `startup_integrity_broken_${suffix}`;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const { PostgresRuntimeStore } = require('../persistence/postgres/store');

  try {
    // ── 0. Positive control ──────────────────────────────────────────────────
    // Same binary, same environment, intact schema. Without this, every refusal
    // assertion below would also pass against a server that could never start at
    // all — which is exactly how this suite previously passed while asserting
    // nothing (it omitted SESSION_SECRET, so both scenarios died on a missing
    // secret rather than on a storage fault).
    {
      const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: controlSchema, disposableMigrations: true });
      await store.migrate();
      await store.close();

      const port = await freePort();
      const server = spawnServer(serverEnv({ schema: controlSchema, port, workspaceRoot }));
      try {
        await waitForReady(server, port);
        const live = await health(port);
        assert(Boolean(live) && live.statusCode === 200 && JSON.parse(live.body).ready === true,
          'control: an intact store lets the same server reach ready');
        assert(/Default admin user created/i.test(server.state.output),
          'control: first-run bootstrap does create the default administrator');
        assert(!server.state.output.includes(BOOTSTRAP_PASSWORD),
          'control: a successful bootstrap does not print the bootstrap password either');
      } finally {
        await stopServer(server);
      }
    }

    // ── 1. Unreachable database ──────────────────────────────────────────────
    // The most basic unusable state. A server that starts anyway would be running
    // with no persistence authority at all.
    {
      const port = await freePort();
      const server = spawnServer({
        ...serverEnv({ schema: controlSchema, port, workspaceRoot }),
        DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/does_not_exist'
      });
      const { code, output } = await waitForExit(server);
      assertRefusal('unreachable database', code, output, /ECONNREFUSED|could not connect|connect ECONNREFUSED|Postgre/i);
    }

    // ── 2. Reachable database, structurally unusable schema ──────────────────
    // The direct analogue of the original corrupt-users-file scenario: the store
    // is present but cannot answer the question bootstrap depends on.
    {
      const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: brokenSchema, disposableMigrations: true });
      await store.migrate();
      await store.close();

      const { rows: before } = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`, [brokenSchema]
      );
      assert(before[0].n > 0, 'the fixture schema migrated before corruption was introduced');
      await pool.query(`DROP TABLE "${brokenSchema}".access_users CASCADE`);

      const port = await freePort();
      const server = spawnServer(serverEnv({ schema: brokenSchema, port, workspaceRoot }));
      const { code, output } = await waitForExit(server);
      assertRefusal('structurally unusable schema', code, output, /integrity check failed[\s\S]*access_users/i);

      const { rows: after } = await pool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = 'access_users'`, [brokenSchema]
      );
      assert(after[0].n === 0, 'the refused start did not silently recreate the missing table');

      // The refusal must not have quietly bootstrapped an administrator elsewhere
      // in the schema either — the authentication-bypass risk is the whole point.
      const { rows: groups } = await pool.query(
        `SELECT count(*)::int AS n FROM "${brokenSchema}".access_groups WHERE name = 'Administrators'`
      );
      assert(groups[0].n === 0, 'the refused start created no administrator group in the broken schema');
    }

    console.log(`\nPASS: startup data integrity — ${passed} assertions (PostgreSQL-native)`);
  } finally {
    for (const schema of [controlSchema, brokenSchema]) {
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } catch (_) { /* best effort */ }
    }
    try { await pool.end(); } catch (_) { /* best effort */ }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`\nFAIL: startup data integrity — ${error && error.message ? error.message : error}`);
  process.exit(1);
});
