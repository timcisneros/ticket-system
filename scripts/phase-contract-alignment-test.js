#!/usr/bin/env node
// Phase contract alignment regression test (test-only).
//
// Verifies the prompt/runtime envelope is truthful about phase-allowed operations:
// the planning-phase prompt must not present mutating operations as current-phase
// allowed, the mutation-phase prompt must present them, and the validator must
// still reject a mixed inspection+mutation response in planning. Provider-free:
// a fake fetch stub captures each provider request body and returns a per-step
// plan sequence decoded from the ticket objective (#SEQ=<base64url>).
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-phase-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-phase-ws-'));
const CAPTURE_FILE = path.join(DATA_DIR, 'captured-requests.log');
const PORT = String(4760 + Math.floor(Math.random() * 200));
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
  for (let i = 0; i < 2; i += 1) {
    nextId += 1;
    agents.push({ id: nextId, name: 'Phase Agent ' + i, provider: 'openai', model: 'fake-openai-' + i, apiKey: 'fake-key-' + i, createdAt: new Date().toISOString(), runtimeConfig: {} });
    made.push(nextId);
  }
  writeJson('agents.json', agents);
  return made;
}

// Stub: capture each request body to CAPTURE_FILE, and return the next plan from
// the #SEQ=<base64url JSON array of plans> directive in the prompt, keyed per
// objective so sequential steps advance.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), 'phase-stub-' + process.pid + '-' + STAMP + '.js');
  const src = `
const fs = require('fs');
const CAPTURE_FILE = ${JSON.stringify(CAPTURE_FILE)};
const counters = new Map();
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-phase']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n'); } catch (_) {}
  try { fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ text: combined }) + '\\n'); } catch (_) {}
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

function objectiveWithSeq(tag, seq) {
  return `phase ${tag} ${STAMP} #SEQ=${encode(seq)}`;
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

function readCaptured() {
  try {
    return fs.readFileSync(CAPTURE_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l).text; } catch (_) { return ''; } });
  } catch (_) { return []; }
}

// From a captured prompt, extract the embedded runtimeEnvelope currentPhase and
// the "Operations you may use in this phase:" line.
function phaseOf(text) { const m = text.match(/"currentPhase":\s*"(\w+)"/); return m ? m[1] : null; }
function currentPhaseLine(text) { const m = text.match(/Operations you may use in this phase: ([^\n]*)/); return m ? m[1] : null; }

function readRunEventsFile() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Phase contract alignment test');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();

    // Run that goes planning -> (pure mutation) -> mutation phase, so we capture
    // both a planning-phase prompt and a mutation-phase prompt.
    const oMut = objectiveWithSeq('mut', [
      { actions: [{ operation: 'writeFile', args: { path: 'pc-' + STAMP + '.txt', content: 'x' } }], complete: false },
      { actions: [], complete: true }
    ]);
    await createTicket(cookie, agents[0], oMut);
    const r = await waitForTicketRun(oMut);
    const rf = r && await waitForTerminalRun(r.run.id);
    assert('mutation-path run reached terminal', !!rf, `status=${rf && rf.status}`);

    const captures = readCaptured();
    const planningPrompt = captures.find(t => phaseOf(t) === 'planning');
    const mutationPrompt = captures.find(t => phaseOf(t) === 'mutation');
    assert('captured a planning-phase prompt', !!planningPrompt);
    assert('captured a mutation-phase prompt', !!mutationPrompt, 'phases seen: ' + captures.map(phaseOf).join(','));

    const planLine = planningPrompt ? currentPhaseLine(planningPrompt) : '';
    const mutLine = mutationPrompt ? currentPhaseLine(mutationPrompt) : '';

    // 1. Planning current-phase list excludes mutating operations.
    assert('1. planning current-phase excludes mutating ops',
      !!planLine && !/createFolder|writeFile|renamePath|deletePath/.test(planLine), 'line=' + planLine);
    // 2. Planning current-phase includes planning-safe read ops.
    assert('2. planning current-phase includes listDirectory + readFile',
      !!planLine && /listDirectory/.test(planLine) && /readFile/.test(planLine), 'line=' + planLine);
    // 3. Mutation current-phase includes mutating operations.
    assert('3. mutation current-phase includes mutating ops',
      !!mutLine && /createFolder/.test(mutLine) && /writeFile/.test(mutLine) && /renamePath/.test(mutLine) && /deletePath/.test(mutLine), 'line=' + mutLine);
    // Vocabulary/schema still exposes the full operation set, labeled as such.
    assert('schema line labeled vocabulary and lists mutating ops',
      !!planningPrompt && planningPrompt.includes('full operation vocabulary/schema') && /"operation":"[^"]*deletePath/.test(planningPrompt));
    // One-phase rule is present.
    assert('one-phase rule present in planning prompt',
      !!planningPrompt && /single execution phase/.test(planningPrompt) && /Never mix inspection operations .* and mutation operations/.test(planningPrompt));

    // 4. Mixed deletePath + listDirectory in planning is still rejected.
    const oMixed = objectiveWithSeq('mixed', [
      { actions: [{ operation: 'deletePath', args: { path: 'CD' } }, { operation: 'listDirectory', args: { path: '' } }], complete: false },
      { actions: [], complete: true }
    ]);
    await createTicket(cookie, agents[1], oMixed);
    const rm = await waitForTicketRun(oMixed);
    const rmf = rm && await waitForTerminalRun(rm.run.id);
    assert('mixed-phase run reached terminal', !!rmf);
    const violation = await waitFor(() => {
      const evs = readRunEventsFile().filter(e => rm && e.runId === rm.run.id && e.type === 'execution.phase_violation');
      return evs.length > 0 ? evs : null;
    }, 10000, 100);
    assert('4. mixed deletePath+listDirectory in planning is rejected (phase violation recorded)', !!violation,
      'no execution.phase_violation event for the mixed run');

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
