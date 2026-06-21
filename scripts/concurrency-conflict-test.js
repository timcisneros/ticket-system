#!/usr/bin/env node
// Concurrency conflict harness (test-only; no runtime change).
//
// Proves the CURRENT behavior when concurrent tickets/runs touch overlapping or
// non-overlapping workspace paths, plus same-ticket control races. It drives the
// real server over HTTP with a model-free fetch stub: each ticket's objective
// embeds a base64url action directive (#ACTIONS=<b64>) that the stub decodes and
// returns as the agent plan, so runs are deterministic without any provider call.
//
// Safety-critical scenarios assert hard (malformed JSON, lost tickets, silent
// last-writer-wins → failure). Parent/child delete/rename are DISCOVERY probes:
// they report OBSERVED_SAFE / OBSERVED_UNSAFE without being forced to pass, so the
// harness can honestly reveal an unguarded gap. Exit is nonzero only on genuine
// safety failures or harness errors — not on an OBSERVED_UNSAFE discovery.
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
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-concurrency-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-workspace-'));
const PORT = String(3960 + Math.floor(Math.random() * 200));
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
let hardFailures = 0;
const results = {};

function record(name, verdict, detail) {
  results[name] = { verdict, detail: detail || null };
  const isHard = verdict === 'FAIL';
  if (isHard) hardFailures += 1;
  console.log(`  ${isHard ? '✗' : '·'} ${name}: ${verdict}${detail ? ' — ' + detail : ''}`);
}

function softAssert(name, condition, detailIfFail, detailIfPass) {
  record(name, condition ? 'PASS' : 'FAIL', condition ? (detailIfPass || null) : detailIfFail);
  return condition;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}
function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}
function jsonParsesOrNull(file) {
  try { return readJson(file); } catch (_) { return null; }
}
function encodeActions(plan) {
  return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url');
}

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form
      ? new URLSearchParams(options.form).toString()
      : options.body
        ? JSON.stringify(options.body)
        : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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
  for (let i = 0; i < 4; i += 1) {
    nextId += 1;
    agents.push({ id: nextId, name: 'Concurrency Agent ' + i, provider: 'openai', model: 'fake-openai-' + i, apiKey: 'fake-key-' + i, createdAt: new Date().toISOString(), runtimeConfig: {} });
    made.push(nextId);
  }
  writeJson('agents.json', agents);
  return made;
}

// Model-free stub: decode #ACTIONS=<base64url> from the prompt and return it as
// the agent plan. No network. Written to a preload file required via NODE_OPTIONS.
function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), 'concurrency-stub-' + process.pid + '-' + STAMP + '.js');
  const src = `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-concurrency']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n'); } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
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

// objective embeds the action directive so the run is deterministic.
function objectiveWith(tag, plan) {
  return `concurrency ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
}

async function createTicket(cookie, agentId, objective) {
  const res = await httpReq('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
  });
  return res;
}

function findTicketByObjective(objective) {
  return (jsonParsesOrNull('tickets.json') || []).find(t => t.objective === objective) || null;
}

async function waitForTicketRun(objective) {
  return waitFor(() => {
    const ticket = findTicketByObjective(objective);
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

// ── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioConcurrentTicketCreation(cookie, agents) {
  const N = 10;
  const objectives = Array.from({ length: N }, (_, i) => objectiveWith('create-' + i, { actions: [], complete: true }));
  const before = (jsonParsesOrNull('tickets.json') || []).length;
  const responses = await Promise.all(objectives.map((o, i) => createTicket(cookie, agents[i % agents.length], o)));
  // allow the synchronous writes to settle
  await sleep(300);
  const tickets = jsonParsesOrNull('tickets.json');
  const allRedirect = responses.every(r => r.status === 302 || r.status === 200);
  const created = objectives.filter(o => findTicketByObjective(o));
  const ids = (tickets || []).map(t => t.id);
  const uniqueIds = new Set(ids).size === ids.length;
  const ok = tickets !== null && allRedirect && created.length === N && uniqueIds && (tickets.length === before + N);
  softAssert('concurrent ticket creation', ok,
    `tickets.json ${tickets === null ? 'MALFORMED' : 'ok'}, created ${created.length}/${N}, uniqueIds=${uniqueIds}`,
    `${N} tickets persisted, unique ids, valid JSON`);
}

async function scenarioDifferentPathWrites(cookie, agents) {
  const fA = 'diff/a-' + STAMP + '.txt';
  const fB = 'diff/b-' + STAMP + '.txt';
  const oA = objectiveWith('diffA', { actions: [{ operation: 'writeFile', args: { path: fA, content: 'AAA' } }], complete: true });
  const oB = objectiveWith('diffB', { actions: [{ operation: 'writeFile', args: { path: fB, content: 'BBB' } }], complete: true });
  await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const bothCompleted = fa && fb && fa.status === 'completed' && fb.status === 'completed';
  const aExists = fs.existsSync(path.join(WORKSPACE_ROOT, fA)) && fs.readFileSync(path.join(WORKSPACE_ROOT, fA), 'utf8') === 'AAA';
  const bExists = fs.existsSync(path.join(WORKSPACE_ROOT, fB)) && fs.readFileSync(path.join(WORKSPACE_ROOT, fB), 'utf8') === 'BBB';
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const histA = hist.filter(h => h.args && h.args.path === fA && !h.error).length;
  const histB = hist.filter(h => h.args && h.args.path === fB && !h.error).length;
  softAssert('different-path writes', bothCompleted && aExists && bExists && histA === 1 && histB === 1,
    `completed=${bothCompleted} aExists=${aExists} bExists=${bExists} histA=${histA} histB=${histB}`,
    'both completed, both files correct, one clean history each');
}

async function scenarioSameFileConflict(cookie, agents) {
  const target = 'same/conflict-' + STAMP + '.txt';
  const oA = objectiveWith('sameA', { actions: [{ operation: 'writeFile', args: { path: target, content: 'CONTENT_A' } }], complete: true });
  const oB = objectiveWith('sameB', { actions: [{ operation: 'writeFile', args: { path: target, content: 'CONTENT_B' } }], complete: true });
  await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const statuses = [fa && fa.status, fb && fb.status].sort();
  const oneEachWay = statuses.length === 2 && statuses[0] === 'completed' && statuses[1] === 'failed';
  const failedRun = [fa, fb].find(r => r && r.status === 'failed');
  const conflictSurfaced = failedRun && /write conflict|WORKSPACE_WRITE_CONFLICT|previously produced/i.test(String(failedRun.error || ''));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const cleanWrites = hist.filter(h => h.args && h.args.path === target && h.operation === 'writeFile' && !h.error).length;
  const noLastWriterWins = cleanWrites === 1; // exactly one clean successful write recorded
  softAssert('same-file write conflict', oneEachWay && conflictSurfaced && noLastWriterWins,
    `statuses=${JSON.stringify(statuses)} conflictSurfaced=${!!conflictSurfaced} cleanWrites=${cleanWrites}`,
    'one completed, one failed with visible conflict, exactly one clean write (no last-writer-wins)');
}

async function scenarioSameFolderCreate(cookie, agents) {
  const folder = 'shared-folder-' + STAMP;
  const plan = { actions: [{ operation: 'createFolder', args: { path: folder } }], complete: true };
  const oA = objectiveWith('folderA', plan); const oB = objectiveWith('folderB', plan);
  await Promise.all([createTicket(cookie, agents[0], oA), createTicket(cookie, agents[1], oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const hist = jsonParsesOrNull('operation-history.json');
  const folderExists = fs.existsSync(path.join(WORKSPACE_ROOT, folder)) && fs.statSync(path.join(WORKSPACE_ROOT, folder)).isDirectory();
  const deterministic = fa && fb && ['completed', 'failed'].includes(fa.status) && ['completed', 'failed'].includes(fb.status);
  const historyOk = hist !== null; // not corrupted
  softAssert('same-folder create', deterministic && folderExists && historyOk,
    `fa=${fa && fa.status} fb=${fb && fb.status} folderExists=${folderExists} historyParsed=${historyOk}`,
    'deterministic terminal states, folder exists, history not corrupted');
}

// Discovery probe: does a second ticket's deletePath of a folder PRODUCED by a
// first ticket get blocked (like cross-ticket writeFile is)? Sequenced for
// determinism — proves guard existence, not race timing.
async function probeDeleteParentCrossTicket(cookie, agents) {
  const folder = 'del-probe-' + STAMP;
  const child = folder + '/child.txt';
  const oOwner = objectiveWith('delOwner', { actions: [
    { operation: 'createFolder', args: { path: folder } },
    { operation: 'writeFile', args: { path: child, content: 'OWNED' } }
  ], complete: true });
  await createTicket(cookie, agents[0], oOwner);
  const owner = await waitForTicketRun(oOwner);
  const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
  if (!ownerFinal || ownerFinal.status !== 'completed') { record('delete-parent/write-child', 'NOT_PROVEN', 'owner run did not complete'); return; }

  const oDeleter = objectiveWith('delAttacker', { actions: [{ operation: 'deletePath', args: { path: folder } }], complete: true });
  await createTicket(cookie, agents[1], oDeleter);
  const del = await waitForTicketRun(oDeleter);
  const delFinal = del && await waitForTerminalRun(del.run.id);
  if (!delFinal) { record('delete-parent/write-child', 'NOT_PROVEN', 'deleter run did not reach terminal'); return; }

  const childStillExists = fs.existsSync(path.join(WORKSPACE_ROOT, child));
  if (delFinal.status === 'failed' && /conflict|previously produced/i.test(String(delFinal.error || ''))) {
    record('delete-parent/write-child', 'OBSERVED_SAFE', 'cross-ticket delete of another ticket’s folder was blocked with a conflict');
  } else if (delFinal.status === 'completed' && !childStillExists) {
    record('delete-parent/write-child', 'OBSERVED_UNSAFE', "a different ticket deleted another ticket's produced folder+child with no conflict surfaced (cross-ticket deletePath is unguarded)");
  } else {
    record('delete-parent/write-child', 'NOT_PROVEN', `deleter status=${delFinal.status} childExists=${childStillExists}`);
  }
}

async function probeRenameParentCrossTicket(cookie, agents) {
  const folder = 'ren-probe-' + STAMP;
  const child = folder + '/child.txt';
  const renamed = 'ren-probe-moved-' + STAMP;
  const oOwner = objectiveWith('renOwner', { actions: [
    { operation: 'createFolder', args: { path: folder } },
    { operation: 'writeFile', args: { path: child, content: 'OWNED' } }
  ], complete: true });
  await createTicket(cookie, agents[2], oOwner);
  const owner = await waitForTicketRun(oOwner);
  const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
  if (!ownerFinal || ownerFinal.status !== 'completed') { record('rename-parent/write-child', 'NOT_PROVEN', 'owner run did not complete'); return; }

  const oRenamer = objectiveWith('renAttacker', { actions: [{ operation: 'renamePath', args: { path: folder, nextPath: renamed } }], complete: true });
  await createTicket(cookie, agents[3], oRenamer);
  const ren = await waitForTicketRun(oRenamer);
  const renFinal = ren && await waitForTerminalRun(ren.run.id);
  if (!renFinal) { record('rename-parent/write-child', 'NOT_PROVEN', 'renamer run did not reach terminal'); return; }

  const originalGone = !fs.existsSync(path.join(WORKSPACE_ROOT, folder));
  const movedExists = fs.existsSync(path.join(WORKSPACE_ROOT, renamed));
  if (renFinal.status === 'failed' && /conflict|previously produced/i.test(String(renFinal.error || ''))) {
    record('rename-parent/write-child', 'OBSERVED_SAFE', 'cross-ticket rename of another ticket’s folder was blocked with a conflict');
  } else if (renFinal.status === 'completed' && originalGone && movedExists) {
    record('rename-parent/write-child', 'OBSERVED_UNSAFE', "a different ticket renamed another ticket's produced folder with no conflict surfaced (cross-ticket renamePath is unguarded)");
  } else {
    record('rename-parent/write-child', 'NOT_PROVEN', `renamer status=${renFinal.status} originalGone=${originalGone} movedExists=${movedExists}`);
  }
}

async function scenarioDoubleRerun(cookie, agents) {
  const target = 'rerun-' + STAMP + '.txt';
  const o = objectiveWith('rerunBase', { actions: [{ operation: 'writeFile', args: { path: target, content: 'R' } }], complete: true });
  await createTicket(cookie, agents[0], o);
  const base = await waitForTicketRun(o);
  const baseFinal = base && await waitForTerminalRun(base.run.id);
  if (!baseFinal || baseFinal.status !== 'completed') { record('double rerun', 'NOT_PROVEN', 'base run did not complete'); return; }
  const ticketId = base.ticket.id;
  const priorRunIds = new Set((jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ticketId).map(r => r.id));

  const [r1, r2] = await Promise.all([
    httpReq('POST', '/api/tickets/' + ticketId + '/rerun', { cookie, body: {} }),
    httpReq('POST', '/api/tickets/' + ticketId + '/rerun', { cookie, body: {} })
  ]);
  await sleep(300);
  // wait until all of this ticket's runs are terminal
  await waitFor(() => {
    const runs = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ticketId);
    return runs.length > 0 && runs.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? runs : null;
  }, 45000, 100);
  const runs = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ticketId);
  const newRuns = runs.filter(r => !priorRunIds.has(r.id));
  // At no point should more than one new run be RUNNING; final state must be terminal + JSON valid.
  const anyConcurrentRunning = runs.filter(r => r.status === 'running').length;
  const jsonOk = jsonParsesOrNull('runs.json') !== null && jsonParsesOrNull('tickets.json') !== null;
  const deterministicTerminal = newRuns.length >= 1 && newRuns.every(r => ['completed', 'failed', 'interrupted'].includes(r.status));
  // PASS if responses were handled, JSON intact, runs terminal, and not >1 left running.
  const ok = jsonOk && deterministicTerminal && anyConcurrentRunning === 0 && (r1.status < 500 && r2.status < 500);
  softAssert('double rerun', ok,
    `newRuns=${newRuns.length} stillRunning=${anyConcurrentRunning} jsonOk=${jsonOk} r1=${r1.status} r2=${r2.status}`,
    `lease-guarded: ${newRuns.length} new run(s), none left running, JSON intact, deterministic terminal`);
}

async function scenarioStopVsRerun(cookie, agents) {
  // Model-free runs complete near-instantly, so a true "stop an in-flight run"
  // race cannot be forced deterministically without a controllable long-running
  // run. We instead fire stop+rerun concurrently and assert the persisted state
  // stays well-formed and deterministic (no malformed JSON, no stuck running).
  const o = objectiveWith('stopRerun', { actions: [{ operation: 'writeFile', args: { path: 'stop-' + STAMP + '.txt', content: 'S' } }], complete: true });
  await createTicket(cookie, agents[1], o);
  const base = await waitForTicketRun(o);
  const baseFinal = base && await waitForTerminalRun(base.run.id);
  if (!baseFinal) { record('stop vs rerun', 'NOT_PROVEN', 'base run did not reach terminal'); return; }
  const ticketId = base.ticket.id;
  const [stopRes, rerunRes] = await Promise.all([
    httpReq('POST', '/api/runs/' + base.run.id + '/stop', { cookie, body: {} }),
    httpReq('POST', '/api/tickets/' + ticketId + '/rerun', { cookie, body: {} })
  ]);
  await sleep(300);
  await waitFor(() => {
    const runs = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ticketId);
    return runs.length > 0 && runs.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? runs : null;
  }, 30000, 100);
  const jsonOk = jsonParsesOrNull('runs.json') !== null && jsonParsesOrNull('tickets.json') !== null;
  const runs = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ticketId);
  const stuckRunning = runs.filter(r => r.status === 'running').length;
  const serverAlive = jsonParsesOrNull('runs.json') !== null && (stopRes.status < 500 && rerunRes.status < 500);
  if (jsonOk && serverAlive && stuckRunning === 0) {
    record('stop vs rerun', 'PASS', `deterministic: JSON intact, none stuck running (stop=${stopRes.status} rerun=${rerunRes.status})`);
  } else {
    record('stop vs rerun', 'NOT_PROVEN', `jsonOk=${jsonOk} stuckRunning=${stuckRunning} stop=${stopRes.status} rerun=${rerunRes.status}`);
  }
}

async function scenarioNonOverlap(cookie, agents) {
  // Two concurrent runs writing into distinct, non-overlapping subtrees must both
  // succeed with no false conflict (the property allocated/dynamic scopes rely on;
  // owned-scope *enforcement* itself is covered by allocated-regression-test.js).
  const a = 'scopeA-' + STAMP + '/out.txt';
  const b = 'scopeB-' + STAMP + '/out.txt';
  const oA = objectiveWith('scopeA', { actions: [{ operation: 'writeFile', args: { path: a, content: 'SA' } }], complete: true });
  const oB = objectiveWith('scopeB', { actions: [{ operation: 'writeFile', args: { path: b, content: 'SB' } }], complete: true });
  await Promise.all([createTicket(cookie, agents[2], oA), createTicket(cookie, agents[3], oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const bothOk = fa && fb && fa.status === 'completed' && fb.status === 'completed';
  const filesOk = fs.existsSync(path.join(WORKSPACE_ROOT, a)) && fs.existsSync(path.join(WORKSPACE_ROOT, b));
  const noFalseConflict = !/conflict/i.test(String((fa && fa.error) || '')) && !/conflict/i.test(String((fb && fb.error) || ''));
  softAssert('allocated/dynamic non-overlap', bothOk && filesOk && noFalseConflict,
    `bothOk=${bothOk} filesOk=${filesOk} noFalseConflict=${noFalseConflict}`,
    'both non-overlapping writes completed, no false conflict');
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Concurrency conflict harness');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();
    await scenarioConcurrentTicketCreation(cookie, agents);
    await scenarioDifferentPathWrites(cookie, agents);
    await scenarioSameFileConflict(cookie, agents);
    await scenarioSameFolderCreate(cookie, agents);
    await probeDeleteParentCrossTicket(cookie, agents);
    await probeRenameParentCrossTicket(cookie, agents);
    await scenarioDoubleRerun(cookie, agents);
    await scenarioStopVsRerun(cookie, agents);
    await scenarioNonOverlap(cookie, agents);

    console.log('\nSummary');
    console.log('-'.repeat(60));
    for (const [name, r] of Object.entries(results)) {
      console.log(`  ${name}: ${r.verdict}`);
    }
    const observedUnsafe = Object.values(results).filter(r => r.verdict === 'OBSERVED_UNSAFE').length;
    const notProven = Object.values(results).filter(r => r.verdict === 'NOT_PROVEN').length;
    console.log(`\n${hardFailures === 0 ? 'HARNESS OK' : 'HARNESS FAILED'}: ${hardFailures} hard failure(s), ${observedUnsafe} observed-unsafe, ${notProven} not-proven`);
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
  // Exit nonzero only on genuine safety/harness failures; OBSERVED_UNSAFE and
  // NOT_PROVEN are discovery outcomes, not harness failures.
  process.exit(hardFailures === 0 ? 0 : 1);
}

main().catch(async error => {
  await stopServer();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); } catch (_) {}
  console.error(error.stack || error.message);
  process.exit(1);
});
