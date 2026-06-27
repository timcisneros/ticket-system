#!/usr/bin/env node
// Phase contract alignment regression test (test-only).
//
// Verifies the direct-action prompt and retry contract around planning -> mutation:
// snapshots can satisfy root inspection, destination folders are preserved, a pure
// mutation may transition directly from planning, and a rejected mixed response
// receives deterministic mutation-only correction. Provider-free:
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
const SNAPSHOT_OBJECTIVE = 'in Q1 put a txt with all the top-level folder names.';
const TOP_LEVEL_FOLDERS = ['A', 'B', 'E', 'F', 'Michael Jackson songs 1', 'Michael Jackson songs 2', 'Michael Jackson songs 3', 'Q1', 'Q2'];

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
  let ticketContext = null;
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n');
    for (const item of input) { try { const parsed = JSON.parse(item.content); if (parsed && parsed.ticketObjective) ticketContext = parsed; } catch (_) {} }
  } catch (_) {}
  try { fs.appendFileSync(CAPTURE_FILE, JSON.stringify({ text: combined }) + '\\n'); } catch (_) {}
  if (ticketContext && ticketContext.ticketObjective === ${JSON.stringify(SNAPSHOT_OBJECTIVE)}) {
    const names = (ticketContext.initialWorkspaceSnapshot.entries || []).map(entry => entry.name);
    return okResponse({
      message: 'Created Q1/top_folders.txt from the initial workspace snapshot.',
      actions: [{ operation: 'writeFile', args: { path: 'Q1/top_folders.txt', content: names.join('\\n') + '\\n' } }],
      complete: true
    });
  }
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
// the non-transition operations line.
function phaseOf(text) { const m = text.match(/"currentPhase":\s*"(\w+)"/); return m ? m[1] : null; }
function currentPhaseLine(text) { const m = text.match(/Operations available without transitioning from this phase: ([^\n]*)/); return m ? m[1] : null; }

function readRunEventsFile() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

async function main() {
  for (const folder of TOP_LEVEL_FOLDERS) fs.mkdirSync(path.join(WORKSPACE_ROOT, folder), { recursive: true });
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Phase contract alignment test');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();

    // Run #49 regression: the root snapshot is sufficient, so the model can
    // transition directly from planning with one correctly nested writeFile.
    await createTicket(cookie, agents[0], SNAPSHOT_OBJECTIVE);
    const snapshotCase = await waitForTicketRun(SNAPSHOT_OBJECTIVE);
    const snapshotFinal = snapshotCase && await waitForTerminalRun(snapshotCase.run.id);
    assert('snapshot-sufficient run completed', snapshotFinal && snapshotFinal.status === 'completed', `status=${snapshotFinal && snapshotFinal.status}`);
    const snapshotHistory = (jsonParsesOrNull('operation-history.json') || []).filter(item => snapshotCase && item.runId === snapshotCase.run.id && !item.error);
    assert('snapshot run accepted exactly one workspace operation', snapshotHistory.length === 1, `operations=${snapshotHistory.length}`);
    assert('accepted operation is writeFile', snapshotHistory[0] && snapshotHistory[0].operation === 'writeFile');
    assert('write path is inside Q1', snapshotHistory[0] && String(snapshotHistory[0].args.path).startsWith('Q1/'), `path=${snapshotHistory[0] && snapshotHistory[0].args.path}`);
    assert('snapshot run required no listDirectory', !snapshotHistory.some(item => item.operation === 'listDirectory'));
    const writtenPath = path.join(WORKSPACE_ROOT, 'Q1', 'top_folders.txt');
    const writtenContent = fs.existsSync(writtenPath) ? fs.readFileSync(writtenPath, 'utf8') : '';
    assert('written file contains every initial top-level folder', TOP_LEVEL_FOLDERS.every(folder => writtenContent.split('\n').includes(folder)), writtenContent);
    const snapshotEvents = readRunEventsFile().filter(event => snapshotCase && event.runId === snapshotCase.run.id);
    assert('snapshot run has no phase violation', !snapshotEvents.some(event => event.type === 'execution.phase_violation'));
    assert('snapshot run has no model stall', !snapshotEvents.some(event => event.type === 'model:stalled'));
    assert('snapshot run has no run-limit failure', !snapshotEvents.some(event => event.type === 'run:failed' && /RUN_LIMIT_EXCEEDED/.test(JSON.stringify(event))));

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

    // 1. Planning's non-transition list excludes mutations, while explicit
    // guidance permits mutation-only responses as a forward transition.
    assert('1. planning non-transition list excludes mutating ops',
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
    assert('planning prompt explicitly permits a mutation-only transition',
      !!planningPrompt && /mutation-only response is permitted when runtimeEnvelope.currentPhase is planning/.test(planningPrompt));
    assert('prompt forbids redundant root listing when snapshot is sufficient',
      !!planningPrompt && /snapshot already contains the information needed.*do not request listDirectory/.test(planningPrompt));
    assert('prompt preserves objective destination folder',
      !!planningPrompt && /requires a path inside Q1/.test(planningPrompt));

    // 4. Mixed writeFile + listDirectory in planning is rejected, then corrected.
    const oMixed = objectiveWithSeq('mixed', [
      { actions: [{ operation: 'listDirectory', args: { path: '' } }, { operation: 'writeFile', args: { path: 'Q1/retry-top-folders.txt', content: 'A\\nB\\n' } }], complete: false },
      { actions: [{ operation: 'writeFile', args: { path: 'Q1/retry-top-folders.txt', content: 'A\\nB\\n' } }], complete: true }
    ]);
    await createTicket(cookie, agents[1], oMixed);
    const rm = await waitForTicketRun(oMixed);
    const rmf = rm && await waitForTerminalRun(rm.run.id);
    assert('mixed-phase run reached terminal', !!rmf);
    const violation = await waitFor(() => {
      const evs = readRunEventsFile().filter(e => rm && e.runId === rm.run.id && e.type === 'execution.phase_violation');
      return evs.length > 0 ? evs : null;
    }, 10000, 100);
    assert('4. mixed listDirectory+writeFile in planning is rejected (phase violation recorded)', !!violation,
      'no execution.phase_violation event for the mixed run');
    const mixedCaptures = readCaptured().filter(text => text.includes(oMixed));
    assert('mixed response caused a second model request', mixedCaptures.length >= 2, `requests=${mixedCaptures.length}`);
    const retryPrompt = mixedCaptures[1] || '';
    assert('retry includes deterministic mutation-only writeFile correction',
      /On the next response, emit a mutation-only response containing only writeFile/.test(retryPrompt));
    assert('retry explicitly says not to emit listDirectory again', /Do not emit listDirectory again/.test(retryPrompt));
    const mixedHistory = (jsonParsesOrNull('operation-history.json') || []).filter(item => rm && item.runId === rm.run.id && !item.error);
    assert('retry accepted exactly one writeFile and no listDirectory',
      mixedHistory.length === 1 && mixedHistory[0].operation === 'writeFile' && !mixedHistory.some(item => item.operation === 'listDirectory'),
      JSON.stringify(mixedHistory));

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
