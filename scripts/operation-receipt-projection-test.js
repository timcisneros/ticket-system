#!/usr/bin/env node
'use strict';
// A14 — redundant-write postcondition completion
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, entry A14).
//
// `checkPostconditionCompletion` completes a run when every proposed mutation is
// redundant against current state. For `writeFile` that decision needs the
// operation's pre-state, which it reads via `getOperation`.
//
// `getOperation` used to return the raw stored receipt document while
// `listRunOperations` returned a projected record. Pre-state survives on the
// prepared INTENT, not on the receipt document, so single-operation reads had no
// `preState` at all and the guard
//
//     if (!historyRecord || !historyRecord.preState) return null;
//
// returned null for every redundant write. The live completion path was silently
// inert since the PostgreSQL cutover.
//
// Both access paths now share one canonical projection. This suite pins that, and
// pins the completion behavior it unblocks.
//
// Self-contained on purpose: it owns its schema bootstrap rather than using
// scripts/postgres-test-harness.js, so this fix commits independently of the A10
// test-migration tranche. It should be migrated onto that harness once A10 lands.

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FAIL: operation-receipt-projection-test requires TEST_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}

const SCHEMA = `a14_projection_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'a14-ws-'));
const STAMP = Date.now();

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  console.log(`  ok ${message}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// Two objectives. The redundant one repeats an identical batch so the second turn
// is entirely no-op; the non-redundant one changes content every turn so the
// shortcut must never fire. Neither ever returns complete:true, so completion can
// only come from the postcondition path.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `a14-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
let redundant = 0;
let changing = 0;
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'a14']]),
    async text() {
      return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const combined = (Array.isArray(body.input) ? body.input : [])
    .map(i => i && i.content ? String(i.content) : '').join('\\n');

  if (combined.includes('a14-redundant')) {
    redundant += 1;
    return ok({
      message: 'same batch again',
      actions: [
        { operation: 'createFolder', args: { path: 'a14-folder' } },
        { operation: 'writeFile', args: { path: 'a14-folder/note.txt', content: 'identical' } }
      ],
      complete: false
    });
  }

  if (combined.includes('a14-changing')) {
    changing += 1;
    return ok({
      message: 'different content each turn',
      actions: [
        { operation: 'writeFile', args: { path: 'a14-changing.txt', content: 'v' + changing } }
      ],
      complete: false
    });
  }

  if (combined.includes('objective compiler')) {
    return ok({ intent: 'model_driven', targetRoot: '', targets: [] });
  }
  return ok({ message: 'idle', actions: [], complete: false });
};
`);
  return preloadPath;
}

function request(baseUrl, method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA });
  await store.migrate();
  const preloadPath = createPreload();
  let server = null;

  try {
    const port = String(await freePort());
    const baseUrl = `http://127.0.0.1:${port}`;
    let out = '';
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL, POSTGRES_SCHEMA: SCHEMA, PORT: port, WORKSPACE_ROOT,
        SESSION_SECRET: 'a14-projection-secret-0123456789abcdef0123456789abcdef',
        ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
        NODE_OPTIONS: `--require ${preloadPath}`,
        AGENT_MAX_EXECUTION_STEPS: '4',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '4',
        AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN: '20',
        AGENT_MAX_RUNTIME_DURATION_MS: '30000',
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', c => { out += c; });
    server.stderr.on('data', c => { out += c; });

    await waitFor(async () => {
      if (server.exitCode !== null) throw new Error('server exited:\n' + out.slice(-2500));
      try {
        const r = await request(baseUrl, 'GET', '/health');
        return r.statusCode === 200 && JSON.parse(r.body).ready;
      } catch (_) { return false; }
    }, 45000, 'server ready');

    const login = await request(baseUrl, 'POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const raw = login.headers['set-cookie'] || [];
    const cookie = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map(c => c.split(';')[0]).join('; ');

    const agent = (await store.createConfiguredAgent({
      value: { name: `A14Agent-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'a14-test'
    })).agent;

    const seen = new Set();
    async function runObjective(objective) {
      const created = await request(baseUrl, 'POST', '/tickets', {
        cookie,
        form: {
          objective, assignmentTargetType: 'agent',
          assignmentTargetId: String(agent.id), assignmentMode: 'individual'
        }
      });
      if (created.statusCode !== 302) throw new Error(`ticket create HTTP ${created.statusCode}`);
      const run = await waitFor(async () => {
        const page = await store.listRuns({ limit: 100 });
        const found = (page.runs || []).find(r => r.agentId === agent.id && !seen.has(r.id));
        if (!found) return null;
        const current = await store.getRun(found.id);
        return current && ['completed', 'failed', 'interrupted'].includes(current.status) ? current : null;
      }, 90000, `terminal run for ${objective}`);
      seen.add(run.id);
      const replay = await store.readRunReplay(run.id);
      return { run, snapshot: replay ? replay.snapshot : null };
    }

    // ── Redundant batch: the shortcut must fire ────────────────────────────
    const redundant = await runObjective(`a14-redundant ${STAMP}`);
    const ops = await store.listRunOperations(redundant.run.id, { limit: 100 });
    const writeOps = ops.filter(o => o.operation === 'writeFile');
    assert(writeOps.length >= 2, `redundant run recorded repeated writeFile receipts (${writeOps.length})`);

    // 1 + 2: pre-state lives on the intent and getOperation now resolves it.
    const secondWrite = writeOps[1];
    const fetched = await store.getOperation(secondWrite.id);
    assert(fetched && fetched.preState,
      'getOperation resolves preState for a prepared operation');
    assert(fetched.preState.existed === true,
      'resolved preState records the file already existed');
    assert(fetched.preState.content === 'identical',
      'resolved preState carries the prior content');

    // 3: the two access paths agree on the canonical fields.
    for (const field of ['preState', 'postState']) {
      assert(JSON.stringify(fetched[field]) === JSON.stringify(secondWrite[field]),
        `getOperation and listRunOperations agree on ${field}`);
    }
    assert(fetched.id === secondWrite.id, 'both paths agree on receipt id');
    assert(fetched.operation === secondWrite.operation, 'both paths agree on operation identity');
    assert(fetched.operationKey === secondWrite.operationKey, 'both paths agree on prepared-intent linkage');
    assert(fetched.outcome === secondWrite.outcome, 'both paths agree on outcome');
    assert(fetched.isRecovery === secondWrite.isRecovery, 'both paths agree on recovery fields');

    // 4 + 5 + 6: completion came from the postcondition path, not complete:true.
    const replayEvents = (redundant.snapshot && redundant.snapshot.events) || [];
    assert(replayEvents.some(e => e.type === 'run:postcondition_completed'),
      'redundant write emitted run:postcondition_completed in replay evidence');
    // Durability surface: recordRunEvent writes the replay snapshot and the run
    // log. This event is deliberately NOT journalled — there is no appendEvent for
    // it anywhere in server.js — so durability is asserted where production
    // actually writes it rather than where a reader might assume.
    const logs = await store.listLogs({ runId: redundant.run.id, limit: 200 });
    const logRows = logs.logs || logs;
    assert(logRows.some(l => l.type === 'run:postcondition_completed'),
      'the postcondition event is durable in run-log evidence');
    assert(redundant.run.status === 'completed', 'redundant run completed');
    const plans = (redundant.snapshot && redundant.snapshot.parsedModelPlans) || [];
    assert(plans.every(p => p.complete !== true),
      'no model response claimed complete:true — completion came only from the postcondition path');

    // 7: operational outcome classification.
    const detail = await request(baseUrl, 'GET', `/runs/${redundant.run.id}`, { cookie });
    assert(detail.statusCode === 200, 'run detail renders for the redundant run');
    assert(/completed_with_verified_postcondition/.test(detail.body),
      'operational outcome is completed_with_verified_postcondition');

    // 9: createFolder redundancy still decided from result.status, unchanged.
    const folderOps = ops.filter(o => o.operation === 'createFolder');
    assert(folderOps.length >= 2, 'redundant run repeated createFolder');
    assert(folderOps[1].result && folderOps[1].result.status === 'already_exists_noop',
      'repeated createFolder still reports already_exists_noop');

    // ── Non-redundant writes must never take the shortcut ──────────────────
    const changing = await runObjective(`a14-changing ${STAMP}`);
    const changingEvents = (changing.snapshot && changing.snapshot.events) || [];
    assert(!changingEvents.some(e => e.type === 'run:postcondition_completed'),
      'a non-redundant write never triggers the postcondition shortcut');

    // ── 10: legacy receipt shape using document.before still normalizes ────
    const legacyKey = `a14-legacy-${STAMP}`;
    await store.pool.query(
      `INSERT INTO ${store.table('target_operation_intents')}
         (run_id, ticket_id, operation_key, operation, target_id, target_kind, target_path, intent)
       VALUES ($1, $2, $3, 'writeFile', 'local-workspace', 'localWorkspace', 'legacy.txt', $4::jsonb)`,
      [redundant.run.id, redundant.run.ticketId, legacyKey,
        JSON.stringify({ args: { path: 'legacy.txt' } })]
    );
    const legacyInsert = await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
         (run_id, ticket_id, idempotency_key, step_id, operation, outcome,
          target_id, target_kind, target_path, receipt)
       VALUES ($1, $2, $3, '0', 'writeFile', 'succeeded',
               'local-workspace', 'localWorkspace', 'legacy.txt', $4::jsonb)
       RETURNING id`,
      [redundant.run.id, redundant.run.ticketId, legacyKey,
        JSON.stringify({ before: { existed: true, content: 'legacy-content' }, after: { existed: true } })]
    );
    const legacy = await store.getOperation(legacyInsert.rows[0].id);
    assert(legacy && legacy.preState && legacy.preState.content === 'legacy-content',
      'a legacy receipt storing pre-state as `before` still normalizes to preState');
    assert(legacy.postState && legacy.postState.existed === true,
      'a legacy receipt storing post-state as `after` still normalizes to postState');

    console.log(`\nPASS: operation-receipt projection / redundant-write postcondition (A14) — ${passed} assertions`);
  } finally {
    if (server) {
      server.kill('SIGTERM');
      for (let i = 0; i < 40 && server.exitCode === null; i++) await sleep(150);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    try { fs.unlinkSync(preloadPath); } catch (_) { /* best effort */ }
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) { /* best effort */ }
    try { await store.close(); } catch (_) { /* best effort */ }
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
