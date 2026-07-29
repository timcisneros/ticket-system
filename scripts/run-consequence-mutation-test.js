#!/usr/bin/env node
'use strict';
// A16 — mutation consequences at normal terminalization
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, entry A16).
//
// `buildRunConsequence` derives every mutation category solely from its
// `operations` argument. Normal `commitRunTerminalization` did not pass one, so
// ordinary runs persisted `created: []` / `mutations: []` even after committing
// mutations, and both the run surface and the diagnostic bundle reported that the
// run had changed nothing. The terminal-repair path passed operations and was
// therefore correct, which is what proved this a defect rather than a narrower
// intended meaning.
//
// The correction reads the run's canonical receipts on the terminalization
// transaction's own client, so the consequence describes exactly the evidence
// committed under that boundary, and makes the argument mandatory so the omission
// cannot recur silently.
//
// Self-contained on purpose so this fix commits independently of the in-flight
// A10 test-migration tranche.

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
  console.error('FAIL: run-consequence-mutation-test requires TEST_DATABASE_URL (or DATABASE_URL).');
  process.exit(1);
}

const SCHEMA = `a16_consequence_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'a16-ws-'));
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

// One objective per mutation category, plus a non-mutating and a failing case.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `a16-openai-${process.pid}-${STAMP}.js`);
  fs.writeFileSync(preloadPath, `
function ok(plan) {
  return {
    ok: true, status: 200,
    headers: new Map([['x-request-id', 'a16']]),
    async text() {
      return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    }
  };
}
global.fetch = async function(_url, options = {}) {
  const body = JSON.parse(options.body || '{}');
  const c = (Array.isArray(body.input) ? body.input : [])
    .map(i => i && i.content ? String(i.content) : '').join('\\n');

  if (c.includes('objective compiler')) return ok({ intent: 'model_driven', targetRoot: '', targets: [] });

  if (c.includes('a16-createfolder')) {
    return ok({ message: 'folder', actions: [{ operation: 'createFolder', args: { path: 'a16-dir' } }], complete: true });
  }
  if (c.includes('a16-writefile')) {
    return ok({ message: 'write', actions: [{ operation: 'writeFile', args: { path: 'a16-new.txt', content: 'fresh' } }], complete: true });
  }
  if (c.includes('a16-rename')) {
    return ok({ message: 'rename', actions: [{ operation: 'renamePath', args: { path: 'a16-src.txt', nextPath: 'a16-dst.txt' } }], complete: true });
  }
  if (c.includes('a16-delete')) {
    return ok({ message: 'delete', actions: [{ operation: 'deletePath', args: { path: 'a16-doomed.txt' } }], complete: true });
  }
  if (c.includes('a16-failing')) {
    // Path outside the workspace: the operation is refused, never committed.
    return ok({ message: 'bad', actions: [{ operation: 'writeFile', args: { path: '../escape.txt', content: 'no' } }], complete: true });
  }
  if (c.includes('a16-inert')) {
    return ok({ message: 'nothing', actions: [], complete: true });
  }
  return ok({ message: 'idle', actions: [], complete: true });
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
    const v = await fn();
    if (v) return v;
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
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'a16-src.txt'), 'move me');
    fs.writeFileSync(path.join(WORKSPACE_ROOT, 'a16-doomed.txt'), 'delete me');

    const port = String(await freePort());
    const baseUrl = `http://127.0.0.1:${port}`;
    let out = '';
    server = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL, POSTGRES_SCHEMA: SCHEMA, PORT: port, WORKSPACE_ROOT,
        SESSION_SECRET: 'a16-consequence-secret-0123456789abcdef0123456789abcdef',
        ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
        NODE_OPTIONS: `--require ${preloadPath}`,
        AGENT_MAX_EXECUTION_STEPS: '3',
        AGENT_MAX_MODEL_REQUESTS_PER_RUN: '3',
        AGENT_MAX_RUNTIME_DURATION_MS: '25000',
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
      value: { name: `A16Agent-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'a16-test'
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
        const page = await store.listRuns({ limit: 200 });
        const found = (page.runs || []).find(r => r.agentId === agent.id && !seen.has(r.id));
        if (!found) return null;
        const cur = await store.getRun(found.id);
        return cur && ['completed', 'failed', 'interrupted'].includes(cur.status) ? cur : null;
      }, 90000, `terminal run for ${objective}`);
      seen.add(run.id);
      const row = await store.getRunConsequence(run.id);
      return {
        run,
        consequence: row ? row.consequence : null,
        operations: await store.listRunOperations(run.id, { limit: 100 })
      };
    }

    const paths = c => (Array.isArray(c) ? c : []).map(i => i.path);

    // ── Each successful mutation category is recorded truthfully ────────────
    const folder = await runObjective(`a16-createfolder ${STAMP}`);
    assert(paths(folder.consequence.created).includes('a16-dir'),
      'createFolder is recorded in consequence.created');
    assert(paths(folder.consequence.mutations).includes('a16-dir'),
      'createFolder is recorded in consequence.mutations');

    const write = await runObjective(`a16-writefile ${STAMP}`);
    assert(paths(write.consequence.created).includes('a16-new.txt'),
      'a writeFile creating a new file is recorded in consequence.created');
    assert(paths(write.consequence.mutations).includes('a16-new.txt'),
      'writeFile is recorded in consequence.mutations');

    const rename = await runObjective(`a16-rename ${STAMP}`);
    assert(paths(rename.consequence.renamed).includes('a16-src.txt'),
      'renamePath is recorded in consequence.renamed');

    const del = await runObjective(`a16-delete ${STAMP}`);
    assert(paths(del.consequence.deleted).includes('a16-doomed.txt'),
      'deletePath is recorded in consequence.deleted');

    // ── A failed operation is never reported as a successful mutation ───────
    const failing = await runObjective(`a16-failing ${STAMP}`);
    const failedCommitted = ['created', 'updated', 'deleted', 'renamed']
      .flatMap(k => paths(failing.consequence[k]));
    assert(failedCommitted.length === 0,
      `a refused operation is recorded in no completed-mutation category (${JSON.stringify(failedCommitted)})`);

    // ── A genuinely non-mutating run stays empty ────────────────────────────
    const inert = await runObjective(`a16-inert ${STAMP}`);
    assert(paths(inert.consequence.created).length === 0
      && paths(inert.consequence.mutations).length === 0,
      'a non-mutating run persists an empty mutation consequence');
    assert(inert.consequence.mutationConsequenceSource === undefined,
      'a non-mutating run is not falsely marked as reconstructed');

    // ── Normal terminalization matches what the receipts say ───────────────
    const succeededWrites = write.operations.filter(o => o.outcome === 'succeeded' && o.operation === 'writeFile');
    assert(succeededWrites.length === paths(write.consequence.mutations).length,
      'the persisted consequence matches the succeeded receipts one-for-one');

    // ── Omission fails loudly ──────────────────────────────────────────────
    // Reaching the builder in-process is not possible (server.js self-starts), so
    // the guard is asserted at the source it protects.
    const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert(/buildRunConsequence requires an explicit operations array/.test(serverSource),
      'buildRunConsequence rejects a missing operations argument rather than defaulting to []');
    const consequenceSignature = serverSource.match(
      /function buildRunConsequence\(run,\s*\{([\s\S]*?)\}\s*=\s*\{\}\)\s*\{/
    );
    assert(Boolean(consequenceSignature) &&
      !/suppliedOperations\s*=\s*\[\]/.test(consequenceSignature[1]),
    'the consequence builder signature has no silent operations default');
    assert(/operations: await this\._listRunOperationsOn\(client, id/.test(
      fs.readFileSync(path.join(ROOT, 'persistence/postgres/store.js'), 'utf8')),
      'terminalization reads receipts on its own transaction client');

    // ── Historical compatibility: empty consequence + succeeded receipts ────
    // run_consequences is append-only, so the pre-fix state cannot be faked by
    // UPDATE. It is constructed the only way it can legitimately exist: a run whose
    // persisted consequence is empty, which later has succeeded mutating receipts
    // attached. The inert run supplies the empty consequence.

    // First prove the negative, while the inert run still has no receipts.
    const inertBefore = await request(baseUrl, 'GET', `/runs/${inert.run.id}`, { cookie });
    assert(inertBefore.statusCode === 200, 'run detail renders for the non-mutating run');
    assert(!/Reconstructed, not originally persisted/.test(inertBefore.body),
      'a run with an empty consequence and no succeeded mutations is never marked reconstructed');

    // Attach a succeeded mutating receipt, reproducing the historical shape.
    const histKey = `a16-historical-${STAMP}`;
    await store.pool.query(
      `INSERT INTO ${store.table('target_operation_intents')}
         (run_id, ticket_id, operation_key, operation, target_id, target_kind, target_path, intent)
       VALUES ($1, $2, $3, 'writeFile', 'local-workspace', 'localWorkspace', 'a16-historical.txt', $4::jsonb)`,
      [inert.run.id, inert.run.ticketId, histKey,
        JSON.stringify({ args: { path: 'a16-historical.txt' }, preState: { existed: false } })]
    );
    await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
         (run_id, ticket_id, idempotency_key, step_id, operation, outcome,
          target_id, target_kind, target_path, receipt)
       VALUES ($1, $2, $3, '0', 'writeFile', 'succeeded',
               'local-workspace', 'localWorkspace', 'a16-historical.txt', $4::jsonb)`,
      [inert.run.id, inert.run.ticketId, histKey,
        JSON.stringify({ args: { path: 'a16-historical.txt' }, result: { path: 'a16-historical.txt' }, after: { existed: true } })]
    );

    // Distinct URL: run-detail responses are cached per (user, template, url) for
    // PAGE_RENDER_CACHE_TTL_MS, and the receipts above were inserted directly, so
    // an identical URL would be served the pre-insert render.
    const historical = await request(baseUrl, 'GET', `/runs/${inert.run.id}?a16=historical`, { cookie });
    assert(historical.statusCode === 200, 'run detail renders for the historical run');
    assert(/a16-historical\.txt/.test(historical.body),
      'a historical empty consequence is reconstructed from succeeded receipts on read');
    assert(/Reconstructed, not originally persisted/.test(historical.body),
      'run detail marks reconstructed data as not the originally persisted record');

    const afterRead = await store.getRunConsequence(inert.run.id);
    assert(paths(afterRead.consequence.created).length === 0,
      'reading did not write back — stored evidence is unchanged by reconstruction');

    // An already-correct persisted consequence is preserved, never replaced.
    const folderDetail = await request(baseUrl, 'GET', `/runs/${folder.run.id}?a16=preserved`, { cookie });
    assert(folderDetail.statusCode === 200, 'run detail renders for a correctly-recorded run');
    assert(!/Reconstructed, not originally persisted/.test(folderDetail.body),
      'a non-empty persisted consequence is preserved rather than reconstructed');
    assert(/a16-dir/.test(folderDetail.body),
      'the correctly-recorded run still shows its own persisted mutation');

    // ── Non-mutation fields survive reconstruction ─────────────────────────
    const reconstructedRow = await store.getRunConsequence(inert.run.id);
    const persistedInert = reconstructedRow.consequence;
    const historicalJson = await request(baseUrl, 'GET', `/runs/${inert.run.id}?a16=fields`, { cookie });
    assert(historicalJson.statusCode === 200, 'historical run re-renders for field checks');
    assert(persistedInert.verification !== undefined,
      'the persisted consequence carries non-mutation fields to preserve');
    assert(/Reconstructed, not originally persisted/.test(historicalJson.body),
      'provenance is stable across repeated presentation reads');

    // ── Provenance and derived categories reach the diagnostic bundle ───────
    const bundleMatch = historicalJson.body.match(/<textarea id="run-diagnostics-bundle"[^>]*>([\s\S]*?)<\/textarea>/);
    assert(Boolean(bundleMatch), 'the diagnostic bundle is present on the historical run');
    const bundle = bundleMatch[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert(/Consequence provenance: RECONSTRUCTED on read/.test(bundle),
      'the diagnostic bundle states the consequence was reconstructed');
    assert(/NOT the terminal record written at the time/.test(bundle),
      'the bundle does not present reconstructed data as the original terminal record');
    assert(/a16-historical\.txt/.test(bundle),
      'the reconstructed mutation reaches the diagnostic bundle');

    // ── All presentation surfaces agree ────────────────────────────────────
    const decisionMap = await request(baseUrl, 'GET', `/runs/${inert.run.id}/map`, { cookie });
    assert(decisionMap.statusCode === 200, 'decision map renders for the historical run');
    const ticketPage = await request(baseUrl, 'GET', `/tickets/${inert.run.ticketId}?a16=surface`, { cookie });
    assert(ticketPage.statusCode === 200, 'ticket surface renders for the historical run');
    assert(/a16-historical\.txt/.test(historicalJson.body) && /a16-historical\.txt/.test(bundle),
      'run detail and diagnostic bundle agree on the reconstructed mutation');

    // ── Idempotent no-op follows existing builder semantics ─────────────────
    // A repeated createFolder resolves as already_exists_noop, which the builder
    // deliberately does not classify as a created folder.
    const repeat = await runObjective(`a16-createfolder ${STAMP} again`);
    const repeatFolderOps = repeat.operations.filter(o => o.operation === 'createFolder');
    if (repeatFolderOps.length > 0 && repeatFolderOps[0].result
        && repeatFolderOps[0].result.status === 'already_exists_noop') {
      assert(!paths(repeat.consequence.created).includes('a16-dir'),
        'an already_exists_noop createFolder is not reported as a newly created folder');
    } else {
      assert(paths(repeat.consequence.created).includes('a16-dir'),
        'a re-created folder is reported per existing builder semantics');
    }

    console.log(`\nPASS: run consequence mutations at terminalization (A16) — ${passed} assertions`);
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
