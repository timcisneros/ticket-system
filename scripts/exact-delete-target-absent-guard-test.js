#!/usr/bin/env node
// Exact delete-target / absent-target guard regression test (test-only).
//
// Proves that a simple "Delete <X>" objective respects exact target identity:
//   1. absent exact target -> idempotently completed (no model loop, no mutation),
//   2. present exact target -> normal deletePath still executes,
//   3. a non-exact proposed deletePath (e.g. deletePath C for "Delete CD") is
//      rejected before execution.
// Provider-free: a fake fetch stub returns a per-objective plan sequence read from
// a control file, so objectives stay clean ("Delete CD") and still match the guard.
//
// Touches only temp DATA_DIR / WORKSPACE_ROOT under os.tmpdir(). Never reads or
// writes the real data/ dir, .local-data, provider keys, or seed files in place.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-exactdel-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-exactdel-ws-'));
const PLAN_FILE = path.join(DATA_DIR, 'control-plans.json');
const PORT = String(5160 + Math.floor(Math.random() * 200));
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
let failures = 0;

function assert(name, condition, detail) {
  if (condition) { console.log(`  · ${name}: PASS`); }
  else { failures += 1; console.log(`  ✗ ${name}: FAIL${detail ? ' — ' + detail : ''}`); }
  return condition;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function jsonParsesOrNull(file) { try { return readJson(file); } catch (_) { return null; } }

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seed = ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json'];
  for (const file of seed) fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
  const agents = readJson('agents.json');
  let nextId = agents.reduce((max, a) => Math.max(max, a.id || 0), 0);
  const made = [];
  for (let i = 0; i < 3; i += 1) {
    nextId += 1;
    agents.push({ id: nextId, name: 'ExactDel Agent ' + i, provider: 'openai', model: 'fake-openai-' + i, apiKey: 'fake-key-' + i, createdAt: new Date().toISOString(), runtimeConfig: {} });
    made.push(nextId);
  }
  writeJson('agents.json', agents);
  return made;
}

// Stub: per fetch, find which control objective key appears in the prompt and
// return its next plan in sequence. Plans are read fresh from PLAN_FILE each call.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), 'exactdel-stub-' + process.pid + '-' + STAMP + '.js');
  const src = `
const fs = require('fs');
const PLAN_FILE = ${JSON.stringify(PLAN_FILE)};
const counters = new Map();
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-exactdel']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n'); } catch (_) {}
  let map = {};
  try { map = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')); } catch (_) {}
  const key = Object.keys(map).find(k => combined.includes(k));
  if (!key) return okResponse({ message: 'noop', actions: [], complete: true });
  const seq = Array.isArray(map[key]) ? map[key] : [{ actions: [], complete: true }];
  const idx = counters.get(key) || 0;
  counters.set(key, idx + 1);
  const plan = seq[Math.min(idx, seq.length - 1)] || { actions: [], complete: true };
  return okResponse({ message: plan.message || 'stub', actions: plan.actions || [], complete: plan.complete !== false });
};
`;
  fs.writeFileSync(preloadPath, src);
  return preloadPath;
}

function startServer(preloadPath) {
  const env = { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, NODE_OPTIONS: '--require ' + preloadPath };
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', c => { output += String(c); });
  server.stderr.on('data', c => { output += String(c); });
  return waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error('server exited during startup: ' + output.slice(-800));
    try { const res = await httpReq('GET', '/login'); return res.status === 200; } catch (_) { return false; }
  }, 15000, 100);
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(400);
  if (server && server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

async function login() {
  const res = await httpReq('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  if (!match) throw new Error('login failed');
  return 'sessionId=' + match[1];
}

async function createTicket(cookie, agentId, objective) {
  return httpReq('POST', '/tickets', { cookie, form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' } });
}

async function waitForTicketRun(objective) {
  return waitFor(() => {
    const ticket = (jsonParsesOrNull('tickets.json') || []).find(t => t.objective === objective);
    if (!ticket) return null;
    const run = (jsonParsesOrNull('runs.json') || []).find(r => r.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  }, 20000, 80);
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = (jsonParsesOrNull('runs.json') || []).find(r => r.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 80);
}

function readEventsForRun(runId) {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
      .filter(e => e.runId === runId);
  } catch (_) { return []; }
}
async function waitForRunEvent(runId, type, timeoutMs = 10000) {
  return waitFor(() => {
    const evs = readEventsForRun(runId).filter(e => e.type === type);
    return evs.length > 0 ? evs : null;
  }, timeoutMs, 100);
}
function historyForRun(runId) {
  return (jsonParsesOrNull('operation-history.json') || []).filter(h => h.runId === runId);
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  // Workspace: A,B,C,D,E,F (no CD); EF present; GH and G present.
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'EF', 'GH', 'G']) {
    fs.writeFileSync(path.join(WORKSPACE_ROOT, name), 'seed-' + name);
  }
  // Control plans (objective -> per-step plan sequence).
  fs.writeFileSync(PLAN_FILE, JSON.stringify({
    'Delete EF': [{ actions: [{ operation: 'deletePath', args: { path: 'EF' } }], complete: true }],
    'Delete GH': [
      { actions: [{ operation: 'deletePath', args: { path: 'G' } }], complete: false },
      { actions: [], complete: true }
    ]
  }, null, 2));

  console.log('Exact delete-target / absent-target guard test');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();

    // 1. Absent exact target -> idempotently completed, no mutation, no model loop.
    await createTicket(cookie, agents[0], 'Delete CD');
    const r1 = await waitForTicketRun('Delete CD');
    const r1f = r1 && await waitForTerminalRun(r1.run.id);
    assert('1. absent-target run completed (not failed)', r1f && r1f.status === 'completed', 'status=' + (r1f && r1f.status));
    const absentEvt = await waitForRunEvent(r1.run.id, 'workspace.delete_target_already_absent');
    assert('1. records workspace.delete_target_already_absent for CD', !!absentEvt &&
      absentEvt.some(e => (e.payload && Array.isArray(e.payload.paths) && e.payload.paths.includes('CD'))));
    const r1events = readEventsForRun(r1.run.id);
    assert('1. no workspace.operation executed (no deletePath C/D)',
      r1events.filter(e => e.type === 'workspace.operation').length === 0);
    assert('1. mutationCount 0 / operationHistory 0', historyForRun(r1.run.id).length === 0);
    assert('1. no run:step_limit', !r1events.some(e => e.type === 'run:step_limit'));
    assert('1. no phase_violation', !r1events.some(e => e.type === 'execution.phase_violation'));
    assert('1. C and D preserved', fs.existsSync(path.join(WORKSPACE_ROOT, 'C')) && fs.existsSync(path.join(WORKSPACE_ROOT, 'D')));
    assert('1. completion evidence says target already absent',
      !!absentEvt && absentEvt.some(e => /already absent/i.test(String(e.payload && e.payload.reason || ''))));

    // 2. Present exact target -> deletePath executes normally.
    await createTicket(cookie, agents[1], 'Delete EF');
    const r2 = await waitForTicketRun('Delete EF');
    const r2f = r2 && await waitForTerminalRun(r2.run.id);
    assert('2. present-target run completed', r2f && r2f.status === 'completed', 'status=' + (r2f && r2f.status));
    const h2 = historyForRun(r2.run.id).filter(h => h.operation === 'deletePath' && !h.error);
    assert('2. operationHistory has deletePath path=EF (mutationCount 1)',
      h2.length === 1 && (h2[0].args && h2[0].args.path === 'EF'), JSON.stringify(h2.map(h => h.args)));
    assert('2. EF removed from workspace', !fs.existsSync(path.join(WORKSPACE_ROOT, 'EF')));

    // 3. Non-exact proposed deletePath is rejected before execution.
    await createTicket(cookie, agents[2], 'Delete GH');
    const r3 = await waitForTicketRun('Delete GH');
    const r3f = r3 && await waitForTerminalRun(r3.run.id);
    assert('3. mismatch run reached terminal', !!r3f);
    const mismatchEvt = await waitForRunEvent(r3.run.id, 'workspace.delete_target_mismatch_rejected');
    assert('3. records workspace.delete_target_mismatch_rejected (proposed G)', !!mismatchEvt &&
      mismatchEvt.some(e => (e.payload && e.payload.proposedPath === 'G')));
    assert('3. G preserved (not deleted)', fs.existsSync(path.join(WORKSPACE_ROOT, 'G')));
    assert('3. GH preserved (not deleted)', fs.existsSync(path.join(WORKSPACE_ROOT, 'GH')));
    assert('3. no clean delete committed (operationHistory has no successful deletePath)',
      historyForRun(r3.run.id).filter(h => h.operation === 'deletePath' && !h.error).length === 0);

    console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + `: ${failures} failure(s)`);
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
