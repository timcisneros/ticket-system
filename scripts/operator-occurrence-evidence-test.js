#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { createTempWorkspaceRoot, removeTempWorkspaceRoot } = require('./test-workspace');
const { allocateTestPort } = require('./test-port');

const ROOT = path.resolve(__dirname, '..');
const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL is required for the operator occurrence-evidence test');
  process.exit(1);
}

const SCHEMA = `operator_occ_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const WORKSPACE_ROOT = createTempWorkspaceRoot('operator-occurrence-evidence');
let PORT = null;
let BASE_URL = null;
const SESSION_SECRET = 'operator-occurrence-evidence-session-secret-0123456789abcdef0123456789';
const EVENT_TYPE = 'workspace.operator_mutation';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function request(method, urlPath, options = {}) {
  const jsonBody = options.body === undefined ? null : JSON.stringify(options.body);
  const formBody = options.form === undefined ? null : options.form;
  const payload = formBody !== null ? formBody : jsonBody;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, {
      method,
      headers: {
        ...(payload === null ? {} : {
          'Content-Type': formBody !== null ? 'application/x-www-form-urlencoded' : 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Origin: BASE_URL
        }),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function cookieFrom(response) {
  return (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function waitForReady() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    try {
      const response = await request('GET', '/health');
      if (response.statusCode === 200 && JSON.parse(response.body).ready === true) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for operator occurrence-evidence server readiness');
}

async function login() {
  const form = new URLSearchParams({ username: 'admin', password: 'admin123' }).toString();
  const response = await request('POST', '/login', { form });
  assert(response.statusCode === 302, `Admin login returned HTTP ${response.statusCode}`);
  const cookie = cookieFrom(response);
  assert(cookie, 'Admin login did not return a session cookie');
  return cookie;
}

async function operatorEvents(store) {
  const result = await store.pool.query(
    `SELECT position, id, ts, type, ticket_id, run_id, step_id, seq, prev_hash, hash, payload
     FROM ${store.table('events')} WHERE type = $1 ORDER BY position ASC`,
    [EVENT_TYPE]
  );
  return result.rows;
}

function assertOccurrenceShape(row, expected) {
  assert(row.ticket_id === null && row.run_id === null,
    'operator occurrence event must not bind a Run or Ticket');
  assert(row.step_id === null, 'operator occurrence event must not bind a run step');
  assert(row.seq === null && row.prev_hash === null && row.hash === null,
    'non-run occurrence event must carry no run-chain fields');
  assert(row.ts instanceof Date && !Number.isNaN(row.ts.getTime()),
    'occurrence event must carry the canonical durable timestamp');
  const payload = row.payload;
  assert(payload && typeof payload === 'object' && !Array.isArray(payload),
    'occurrence event payload must be an object');
  assert(payload.act === expected.act, `occurrence act mismatch: ${payload.act} !== ${expected.act}`);
  assert(JSON.stringify(payload.paths) === JSON.stringify(expected.paths),
    `occurrence paths mismatch: ${JSON.stringify(payload.paths)} !== ${JSON.stringify(expected.paths)}`);
  assert(payload.actor === expected.actor, `occurrence actor mismatch: ${payload.actor}`);
  assert(payload.outcome === 'succeeded', `occurrence outcome must be succeeded, got ${payload.outcome}`);
  assert(payload.target && payload.target.id === 'local-workspace' && payload.target.kind === 'localWorkspace',
    'occurrence target must identify the local workspace target');
  if (expected.fixtureId !== undefined) {
    assert(payload.fixtureId === expected.fixtureId, 'fixture occurrence must record the fixtureId');
  }
  return payload;
}

async function main() {
  PORT = String(await allocateTestPort());
  BASE_URL = `http://127.0.0.1:${PORT}`;
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  let server = null;
  try {
    await store.migrate();
    const serverEnv = {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET,
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
      PORT,
      WORKSPACE_ROOT,
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '60000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '60000'
    };
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', chunk => process.stdout.write(String(chunk)));
    server.stderr.on('data', chunk => process.stderr.write(String(chunk)));
    await waitForReady();
    const cookie = await login();

    const mutations = [
      { act: 'createFolder', method: 'POST', url: '/api/workspace/folder', body: { path: 'occ' }, paths: ['occ'] },
      { act: 'createFile', method: 'POST', url: '/api/workspace/file', body: { path: 'occ/a.txt' }, paths: ['occ/a.txt'] },
      { act: 'writeFile', method: 'PATCH', url: '/api/workspace/file', body: { path: 'occ/a.txt', content: 'occurrence evidence' }, paths: ['occ/a.txt'] },
      { act: 'renamePath', method: 'PATCH', url: '/api/workspace/rename', body: { path: 'occ/a.txt', nextPath: 'occ/b.txt' }, paths: ['occ/a.txt', 'occ/b.txt'] },
      { act: 'deletePath', method: 'DELETE', url: '/api/workspace', body: { path: 'occ/b.txt' }, paths: ['occ/b.txt'] },
      { act: 'resetWorkspaceFixture', method: 'POST', url: '/api/workspace/fixture', body: { fixtureId: 'empty' }, paths: [''] }
    ];
    let expectedCount = 0;
    for (const mutation of mutations) {
      const response = await request(mutation.method, mutation.url, { cookie, body: mutation.body });
      assert(response.statusCode === 200,
        `${mutation.act} returned HTTP ${response.statusCode}: ${response.body}`);
      expectedCount += 1;
      const rows = await operatorEvents(store);
      assert(rows.length === expectedCount,
        `${mutation.act} must record exactly one occurrence event, saw ${rows.length}`);
      assertOccurrenceShape(rows[rows.length - 1], {
        act: mutation.act,
        paths: mutation.paths,
        actor: 'admin'
      });
    }
    const rows = await operatorEvents(store);
    assertOccurrenceShape(rows[5], { act: 'resetWorkspaceFixture', paths: [''], actor: 'admin', fixtureId: 'empty' });

    const refused = await request('PATCH', '/api/workspace/rename', { cookie, body: { path: 'missing-source.txt', nextPath: 'renamed-target.txt' } });
    assert(refused.statusCode === 400, `failed rename returned HTTP ${refused.statusCode}: ${refused.body}`);
    assert((await operatorEvents(store)).length === expectedCount,
      'a failed mutation must record no occurrence event');

    const faultFunction = `${store.schemaSql}.t8_fault_block_operator_mutation_event`;
    await store.pool.query(
      `CREATE FUNCTION ${faultFunction}() RETURNS trigger LANGUAGE plpgsql AS
       $fn$ BEGIN RAISE EXCEPTION 'T8 occurrence-evidence fault: operator mutation event write blocked'; END;
       $fn$`
    );
    await store.pool.query(
      `CREATE TRIGGER t8_fault_block_operator_mutation_event
       BEFORE INSERT ON ${store.table('events')}
       FOR EACH ROW WHEN (NEW.type = '${EVENT_TYPE}')
       EXECUTE FUNCTION ${faultFunction}()`
    );

    const faultPath = 'occ-post-fault.txt';
    const faultResponse = await request('POST', '/api/workspace/file', { cookie, body: { path: faultPath } });
    assert(faultResponse.statusCode === 500,
      `post-effect evidence failure must not return success, got HTTP ${faultResponse.statusCode}`);
    const faultBody = JSON.parse(faultResponse.body);
    assert(faultBody.mutation && faultBody.mutation.occurred === true,
      'the truthful response must report that the mutation occurred');
    assert(faultBody.occurrenceEvidence && faultBody.occurrenceEvidence.committed === false,
      'the truthful response must report that occurrence evidence was not committed');
    assert(/occurred, but its canonical occurrence evidence could not be committed/.test(faultBody.error),
      'the truthful response must state occurrence without evidence, not an unqualified failure');
    assert(!/Workspace operation failed/.test(faultBody.error),
      'the truthful response must not report that the filesystem mutation failed');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, faultPath)),
      'the filesystem mutation must have occurred despite the evidence failure');
    assert((await operatorEvents(store)).length === expectedCount,
      'the failed occurrence write must not have committed a partial event');

    const retainedLog = await store.pool.query(
      `SELECT body FROM ${store.table('diagnostic_logs')}
       WHERE type = 'workspace:operator_mutation'
         AND body->'workspaceAction'->>'operation' = 'createFile'
         AND body->'workspaceAction'->'args'->>'path' = $1
       ORDER BY id DESC LIMIT 1`,
      [faultPath]
    );
    assert(retainedLog.rowCount === 1,
      'the diagnostic operator-mutation log must be retained');
    assert(retainedLog.rows[0].body.occurrenceEvidenceCommitted === false,
      'the retained diagnostic log must record that occurrence evidence was not committed');

    const health = await request('GET', '/health');
    const healthBody = JSON.parse(health.body);
    assert(healthBody.ready === false && healthBody.status === 'degraded',
      'evidence persistence failure must fail the server closed (degraded, not ready)');

    const latchedMutation = await request('POST', '/api/workspace/file', { cookie, body: { path: 'while-latched.txt' } });
    assert(latchedMutation.statusCode === 503,
      `a mutation request while latched must be refused, got HTTP ${latchedMutation.statusCode}`);
    assert(/event persistence failed/.test(JSON.parse(latchedMutation.body).error),
      'the latched refusal must name the evidence persistence failure');
    assert(!fs.existsSync(path.join(WORKSPACE_ROOT, 'while-latched.txt')),
      'a refused mutation must create no unrecorded filesystem effect');
    const latchedFixture = await request('POST', '/api/workspace/fixture', { cookie, body: { fixtureId: 'empty' } });
    assert(latchedFixture.statusCode === 503,
      `fixture reset while latched must be refused, got HTTP ${latchedFixture.statusCode}`);
    assert((await operatorEvents(store)).length === expectedCount,
      'no further occurrence events may be recorded while evidence persistence is latched');

    console.log('PASS: operator occurrence evidence — one non-run-scoped canonical event per successful operator mutation and fixture reset with minimum occurrence truth, none for refusals, truthful occurred-but-unrecorded response on evidence persistence failure, and latched fail-closed refusal of further operator mutations');
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await waitForExit(server);
    }
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    removeTempWorkspaceRoot(WORKSPACE_ROOT);
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
