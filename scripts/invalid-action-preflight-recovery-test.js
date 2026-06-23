#!/usr/bin/env node
// Invalid-action preflight + recovery regression test (test-only).
//
// Proves the runtime validates the whole model action batch before executing any
// action: a batch with invalid args is rejected before execution (nothing runs),
// a structured workspace.invalid_action_args event is recorded, the model is warned
// and can retry within budget, invalid mutation batches commit nothing, and the
// v0.1.22 mixed-phase rejection is unchanged. Provider-free: a fake fetch stub
// returns a per-step plan sequence decoded from the objective (#SEQ=<base64url>).
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-preflight-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-preflight-ws-'));
const PORT = String(4960 + Math.floor(Math.random() * 200));
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
function encode(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url'); }

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
    agents.push({ id: nextId, name: 'Preflight Agent ' + i, provider: 'openai', model: 'fake-openai-' + i, apiKey: 'fake-key-' + i, createdAt: new Date().toISOString(), runtimeConfig: {} });
    made.push(nextId);
  }
  writeJson('agents.json', agents);
  return made;
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), 'preflight-stub-' + process.pid + '-' + STAMP + '.js');
  const src = `
const counters = new Map();
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-preflight']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n'); } catch (_) {}
  const sm = combined.match(/#SEQ=([A-Za-z0-9_-]+=*)/);
  if (!sm) return okResponse({ message: 'noop', actions: [], complete: true });
  let seq;
  try { seq = JSON.parse(Buffer.from(sm[1], 'base64url').toString('utf8')); } catch (_) { seq = [{ actions: [], complete: true }]; }
  const key = sm[1];
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

function objectiveWithSeq(tag, seq) { return `preflight ${tag} ${STAMP} #SEQ=${encode(seq)}`; }

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

function readSnapshot(runId) {
  const run = (jsonParsesOrNull('runs.json') || []).find(r => r.id === runId);
  if (run && run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  const rel = run && run.replaySnapshotPath ? run.replaySnapshotPath : path.join('replay-snapshots', 'run-' + runId + '.json');
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), 'utf8')); } catch (_) { return null; }
}

async function waitForRunEvent(runId, type, timeoutMs = 10000) {
  return waitFor(() => {
    const evs = readEventsForRun(runId).filter(e => e.type === type);
    return evs.length > 0 ? evs : null;
  }, timeoutMs, 100);
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Invalid-action preflight + recovery test');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();

    // 1+2. Invalid inspection batch rejected before execution, then valid retry.
    const oInspect = objectiveWithSeq('inspect', [
      { actions: [{ operation: 'listDirectory', args: { path: '' } }, { operation: 'readFile', args: { path: '' } }], complete: false },
      { actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false },
      { actions: [], complete: true }
    ]);
    await createTicket(cookie, agents[0], oInspect);
    const r1 = await waitForTicketRun(oInspect);
    const r1f = r1 && await waitForTerminalRun(r1.run.id);
    const inv1 = await waitForRunEvent(r1.run.id, 'workspace.invalid_action_args');
    assert('1. invalid inspection batch recorded invalid_action_args event', !!inv1);
    assert('1. event marks rejectedBatch + executed:false + operation readFile',
      !!inv1 && inv1.some(e => (e.payload || e).rejectedBatch === true && (e.payload || e).executed === false && (e.payload || e).operation === 'readFile'),
      JSON.stringify(inv1 && inv1[0]));
    assert('1. run did not terminal-fail on blank arg (completed)', r1f && r1f.status === 'completed', 'status=' + (r1f && r1f.status) + ' error=' + (r1f && r1f.error));
    const snap1 = readSnapshot(r1.run.id);
    const ops1 = snap1 && Array.isArray(snap1.workspaceOperations) ? JSON.stringify(snap1.workspaceOperations) : '';
    assert('2. valid retry executed (listDirectory present in workspace operations)', /listDirectory/.test(ops1), ops1.slice(0, 200));
    assert('1. readFile was never executed (no readFile in workspace operations)', !/readFile/.test(ops1), ops1.slice(0, 200));
    const hist1 = (jsonParsesOrNull('operation-history.json') || []).filter(h => h.runId === r1.run.id);
    assert('1. operationHistory unchanged for rejected batch (no mutations)', hist1.length === 0, 'history=' + hist1.length);

    // 3. Invalid mutation batch (single-phase) executes no mutation.
    const safe = 'safe-' + STAMP + '.txt';
    const oMut = objectiveWithSeq('mut', [
      { actions: [{ operation: 'writeFile', args: { path: safe, content: 'should-not-write' } }, { operation: 'deletePath', args: { path: '' } }], complete: false },
      { actions: [], complete: true }
    ]);
    await createTicket(cookie, agents[1], oMut);
    const r2 = await waitForTicketRun(oMut);
    const r2f = r2 && await waitForTerminalRun(r2.run.id);
    const inv2 = await waitForRunEvent(r2.run.id, 'workspace.invalid_action_args');
    assert('3. invalid mutation batch recorded invalid_action_args event', !!inv2);
    assert('3. safe.txt was NOT written', !fs.existsSync(path.join(WORKSPACE_ROOT, safe)));
    const hist2 = (jsonParsesOrNull('operation-history.json') || []).filter(h => h.runId === r2.run.id);
    assert('3. operationHistory has no write for safe.txt (mutationCount 0)',
      !hist2.some(h => h.operation === 'writeFile' && !h.error), 'history=' + JSON.stringify(hist2.map(h => h.operation)));
    assert('3. run terminal', !!r2f);

    // 4. Mixed deletePath + listDirectory in planning still rejected (v0.1.22).
    const oMixed = objectiveWithSeq('mixed', [
      { actions: [{ operation: 'deletePath', args: { path: 'CD' } }, { operation: 'listDirectory', args: { path: '' } }], complete: false },
      { actions: [], complete: true }
    ]);
    await createTicket(cookie, agents[2], oMixed);
    const r3 = await waitForTicketRun(oMixed);
    const r3f = r3 && await waitForTerminalRun(r3.run.id);
    assert('4. mixed-phase run terminal', !!r3f);
    const pv = await waitForRunEvent(r3.run.id, 'execution.phase_violation');
    assert('4. mixed deletePath+listDirectory still records execution.phase_violation', !!pv);
    const hist3 = (jsonParsesOrNull('operation-history.json') || []).filter(h => h.runId === r3.run.id && !h.error);
    assert('4. mixed batch executed no workspace mutation', hist3.length === 0, 'history=' + hist3.length);

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
