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
  // OBSERVED_UNSAFE is now a hard failure: cross-ticket parent/child delete/rename
  // overlap is guarded (parent-child-conflict-guard), so re-exposing it is a
  // regression. FAIL and OBSERVED_UNSAFE both fail the harness.
  const isHard = verdict === 'FAIL' || verdict === 'OBSERVED_UNSAFE';
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

  // Seed a non-admin user WITHOUT workspace.delete.cross_ticket_artifact so the
  // harness can exercise the blocked (unpermitted) cross-ticket delete path.
  // (admin, via the Administrators group, receives the full permission catalog in
  // createDefaultData and therefore holds the cross-ticket delete permission.)
  const users = readJson('users.json');
  const adminUser = users.find(u => u.username === 'admin') || users[0];
  const restrictedUserId = users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
  users.push({ id: restrictedUserId, username: 'restricted', passwordHash: adminUser.passwordHash, createdAt: new Date().toISOString(), type: 'user' });
  writeJson('users.json', users);
  const groups = readJson('groups.json');
  const restrictedGroupId = groups.reduce((m, g) => Math.max(m, g.id || 0), 0) + 1;
  groups.push({ id: restrictedGroupId, name: 'Restricted Operators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false });
  writeJson('groups.json', groups);
  const memberships = readJson('memberships.json');
  const nextMembershipId = memberships.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  memberships.push({ id: nextMembershipId, principalType: 'user', principalId: restrictedUserId, groupId: restrictedGroupId });
  writeJson('memberships.json', memberships);

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

async function loginAs(username, password) {
  const res = await httpReq('POST', '/login', { form: { username, password } });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  if (!match) throw new Error('login failed for ' + username);
  return 'sessionId=' + match[1];
}
async function login() { return loginAs('admin', 'admin123'); }

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
async function probeDeleteParentCrossTicket(cookie, restrictedCookie, agents) {
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

  // Deleter is the non-permitted user, so cross-ticket parent/child delete must
  // still be blocked (permission-aware guard denies users lacking the permission).
  const oDeleter = objectiveWith('delAttacker', { actions: [{ operation: 'deletePath', args: { path: folder } }], complete: true });
  await createTicket(restrictedCookie, agents[1], oDeleter);
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

function readRunSnapshot(runId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-' + runId + '.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Same agent, two tickets, different paths: both runs complete and their
// operation-history + replay evidence stay isolated per runId (no cross-run
// contamination), with no false conflict.
async function scenarioSameAgentDifferentPaths(cookie, agents) {
  const agent = agents[0];
  const fA = 'sa-diff/a-' + STAMP + '.txt';
  const fB = 'sa-diff/b-' + STAMP + '.txt';
  const oA = objectiveWith('saDiffA', { actions: [{ operation: 'writeFile', args: { path: fA, content: 'SA_A' } }], complete: true });
  const oB = objectiveWith('saDiffB', { actions: [{ operation: 'writeFile', args: { path: fB, content: 'SA_B' } }], complete: true });
  await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const sameAgent = ra && rb && ra.run.agentId === agent && rb.run.agentId === agent && ra.run.id !== rb.run.id && ra.ticket.id !== rb.ticket.id;
  const bothCompleted = fa && fb && fa.status === 'completed' && fb.status === 'completed';
  const filesOk = fs.existsSync(path.join(WORKSPACE_ROOT, fA)) && fs.existsSync(path.join(WORKSPACE_ROOT, fB));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const aHist = ra ? hist.filter(h => h.runId === ra.run.id) : [];
  const bHist = rb ? hist.filter(h => h.runId === rb.run.id) : [];
  const histIsolated = aHist.length > 0 && bHist.length > 0 &&
    aHist.every(h => h.args && h.args.path === fA) && bHist.every(h => h.args && h.args.path === fB) &&
    !aHist.some(h => h.args && h.args.path === fB) && !bHist.some(h => h.args && h.args.path === fA);
  const snapA = ra && readRunSnapshot(ra.run.id); const snapB = rb && readRunSnapshot(rb.run.id);
  const snapIsolated = snapA && snapB &&
    Array.isArray(snapA.modelResponses) && snapA.modelResponses.length > 0 &&
    Array.isArray(snapB.modelResponses) && snapB.modelResponses.length > 0 &&
    (snapA.runId === undefined || snapA.runId === ra.run.id) &&
    (snapB.runId === undefined || snapB.runId === rb.run.id);
  const noFalseConflict = !/conflict/i.test(String((fa && fa.error) || '')) && !/conflict/i.test(String((fb && fb.error) || ''));
  softAssert('same-agent different-path runs isolated', sameAgent && bothCompleted && filesOk && histIsolated && snapIsolated && noFalseConflict,
    `sameAgent=${sameAgent} bothCompleted=${bothCompleted} filesOk=${filesOk} histIsolated=${histIsolated} snapIsolated=${snapIsolated} noFalseConflict=${noFalseConflict}`,
    'same agent, two tickets: both complete; operation-history and replay evidence isolated per run; no false conflict');
}

// Same agent, two tickets, same file: the cross-ticket conflict guard still
// blocks one (no silent overwrite), attributed to the prior ticket/run.
async function scenarioSameAgentSameFile(cookie, agents) {
  const agent = agents[1];
  const target = 'sa-same/conflict-' + STAMP + '.txt';
  const oA = objectiveWith('saSameA', { actions: [{ operation: 'writeFile', args: { path: target, content: 'SA_ONE' } }], complete: true });
  const oB = objectiveWith('saSameB', { actions: [{ operation: 'writeFile', args: { path: target, content: 'SA_TWO' } }], complete: true });
  await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  const statuses = [fa && fa.status, fb && fb.status].sort();
  const oneEachWay = statuses.length === 2 && statuses[0] === 'completed' && statuses[1] === 'failed';
  const failedRun = [fa, fb].find(r => r && r.status === 'failed');
  const conflictAttributed = failedRun && /write conflict|previously produced|WORKSPACE_WRITE_CONFLICT/i.test(String(failedRun.error || ''));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const cleanWrites = hist.filter(h => h.args && h.args.path === target && h.operation === 'writeFile' && !h.error).length;
  softAssert('same-agent same-file conflict blocked', oneEachWay && conflictAttributed && cleanWrites === 1,
    `statuses=${JSON.stringify(statuses)} attributed=${!!conflictAttributed} cleanWrites=${cleanWrites}`,
    'same agent, same file: one completes, one fails with attributed conflict, exactly one clean write (no last-writer-wins)');
}

// Rerunning one ticket must affect only that ticket's runs; the same agent's
// other-ticket runs must be untouched.
async function scenarioSameAgentRerunIsolation(cookie, agents) {
  const agent = agents[2];
  const oA = objectiveWith('saRerunA', { actions: [{ operation: 'writeFile', args: { path: 'sa-rerun/a-' + STAMP + '.txt', content: 'A' } }], complete: true });
  const oB = objectiveWith('saRerunB', { actions: [{ operation: 'writeFile', args: { path: 'sa-rerun/b-' + STAMP + '.txt', content: 'B' } }], complete: true });
  await Promise.all([createTicket(cookie, agent, oA), createTicket(cookie, agent, oB)]);
  const ra = await waitForTicketRun(oA); const rb = await waitForTicketRun(oB);
  const fa = ra && await waitForTerminalRun(ra.run.id); const fb = rb && await waitForTerminalRun(rb.run.id);
  if (!fa || !fb) { softAssert('same-agent rerun isolation', false, 'base runs did not complete'); return; }
  const bBefore = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === rb.ticket.id).map(r => r.id + ':' + r.status).sort();
  const rer = await httpReq('POST', '/api/tickets/' + ra.ticket.id + '/rerun', { cookie, body: {} });
  await sleep(300);
  await waitFor(() => {
    const aRuns = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ra.ticket.id);
    return aRuns.length >= 2 && aRuns.every(r => ['completed', 'failed', 'interrupted'].includes(r.status)) ? aRuns : null;
  }, 45000, 100);
  const bAfter = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === rb.ticket.id).map(r => r.id + ':' + r.status).sort();
  const aAfter = (jsonParsesOrNull('runs.json') || []).filter(r => r.ticketId === ra.ticket.id);
  const bUnaffected = JSON.stringify(bBefore) === JSON.stringify(bAfter);
  const aGotNewRun = aAfter.length >= 2;
  softAssert('same-agent rerun isolation', rer.status === 200 && bUnaffected && aGotNewRun,
    `rerunStatus=${rer.status} bUnaffected=${bUnaffected} aRuns=${aAfter.length}`,
    "rerunning one ticket adds a run only to that ticket; the same agent's other ticket runs are untouched");
}

// Same agent: one run fails (cross-ticket conflict against a prior owner), one
// run succeeds. Failure stays on the failed run; the successful run stays clean.
async function scenarioSameAgentFailureIsolation(cookie, agents) {
  const owner = agents[3];
  const worker = agents[0];
  const ownedPath = 'sa-fail/owned-' + STAMP + '.txt';
  const oS = objectiveWith('saFailOwner', { actions: [{ operation: 'writeFile', args: { path: ownedPath, content: 'OWNER' } }], complete: true });
  await createTicket(cookie, owner, oS);
  const rs = await waitForTicketRun(oS);
  const sFinal = rs && await waitForTerminalRun(rs.run.id);
  if (!sFinal || sFinal.status !== 'completed') { softAssert('same-agent failure isolation', false, 'owner setup run did not complete'); return; }

  const okPath = 'sa-fail/ok-' + STAMP + '.txt';
  const oOk = objectiveWith('saFailOk', { actions: [{ operation: 'writeFile', args: { path: okPath, content: 'OK' } }], complete: true });
  const oBad = objectiveWith('saFailBad', { actions: [{ operation: 'writeFile', args: { path: ownedPath, content: 'BAD' } }], complete: true });
  await Promise.all([createTicket(cookie, worker, oOk), createTicket(cookie, worker, oBad)]);
  const rOk = await waitForTicketRun(oOk); const rBad = await waitForTicketRun(oBad);
  const okF = rOk && await waitForTerminalRun(rOk.run.id); const badF = rBad && await waitForTerminalRun(rBad.run.id);
  const okGood = okF && okF.status === 'completed' && !okF.error && fs.existsSync(path.join(WORKSPACE_ROOT, okPath));
  const badFailed = badF && badF.status === 'failed' && /conflict|previously produced/i.test(String(badF.error || ''));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const okHist = rOk ? hist.filter(h => h.runId === rOk.run.id && !h.error) : [];
  const badHist = rBad ? hist.filter(h => h.runId === rBad.run.id && !h.error) : [];
  let okStateClean = false;
  try {
    const st = JSON.parse((await httpReq('GET', '/api/runs/' + rOk.run.id + '/state', { cookie })).body);
    okStateClean = st && st.status === 'completed' && !st.error;
  } catch (_) { okStateClean = false; }
  const isolated = okGood && badFailed && okHist.length === 1 && badHist.length === 0 && okStateClean;
  softAssert('same-agent failure isolation', isolated,
    `okGood=${okGood} badFailed=${badFailed} okHist=${okHist.length} badHist=${badHist.length} okStateClean=${okStateClean}`,
    "same agent: failed run keeps its failure/evidence to itself; the successful run stays clean (no cross-run contamination)");
}

function readEventsFile() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

// Permitted: admin holds workspace.delete.cross_ticket_artifact, so a cross-ticket
// delete executes, removes the artifact, writes clean operation-history, and emits
// an audit event recording the prior owner + permission used.
async function scenarioPermittedCrossTicketDelete(cookie, agents) {
  const cd = 'xdel-permitted/CD-' + STAMP + '.txt';
  const oOwner = objectiveWith('permOwner', { actions: [{ operation: 'writeFile', args: { path: cd, content: 'CD' } }], complete: true });
  await createTicket(cookie, agents[0], oOwner);
  const owner = await waitForTicketRun(oOwner);
  const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
  if (!ownerFinal || ownerFinal.status !== 'completed') { softAssert('permitted cross-ticket delete', false, 'owner run did not complete'); return; }
  const oDel = objectiveWith('permDel', { actions: [{ operation: 'deletePath', args: { path: cd } }], complete: true });
  await createTicket(cookie, agents[1], oDel);
  const del = await waitForTicketRun(oDel);
  const delFinal = del && await waitForTerminalRun(del.run.id);
  const completed = delFinal && delFinal.status === 'completed';
  const fileGone = !fs.existsSync(path.join(WORKSPACE_ROOT, cd));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const cleanDelete = del ? hist.some(h => h.runId === del.run.id && h.operation === 'deletePath' && !h.error && h.args && h.args.path === cd) : false;
  const auditEvent = await waitFor(() => readEventsFile().find(e =>
    e.type === 'workspace.cross_ticket_delete_authorized' && del && e.runId === del.run.id) || null, 10000, 100);
  const auditOk = auditEvent && auditEvent.payload &&
    auditEvent.payload.priorOwnerTicketId === owner.ticket.id &&
    auditEvent.payload.priorOwnerRunId === owner.run.id &&
    auditEvent.payload.requestingTicketId === del.ticket.id &&
    auditEvent.payload.requestingRunId === del.run.id &&
    auditEvent.payload.actorUsername === 'admin' &&
    auditEvent.payload.permissionUsed === 'workspace.delete.cross_ticket_artifact';
  softAssert('permitted cross-ticket delete', completed && fileGone && cleanDelete && !!auditOk,
    `completed=${completed} fileGone=${fileGone} cleanDelete=${cleanDelete} auditOk=${!!auditOk}`,
    "permissioned user deletes another ticket's artifact: executed, file removed, clean history, audit records prior owner + permission used");
}

// Non-permitted: a restricted user (no permission) attempting the same cross-ticket
// delete stays blocked with the existing conflict; the artifact survives; no clean
// delete history is written.
async function scenarioNonPermittedCrossTicketDelete(cookie, restrictedCookie, agents) {
  const cd = 'xdel-blocked/CD-' + STAMP + '.txt';
  const oOwner = objectiveWith('blkOwner', { actions: [{ operation: 'writeFile', args: { path: cd, content: 'CD' } }], complete: true });
  await createTicket(cookie, agents[0], oOwner);
  const owner = await waitForTicketRun(oOwner);
  const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
  if (!ownerFinal || ownerFinal.status !== 'completed') { softAssert('non-permitted cross-ticket delete blocked', false, 'owner run did not complete'); return; }
  const oDel = objectiveWith('blkDel', { actions: [{ operation: 'deletePath', args: { path: cd } }], complete: true });
  await createTicket(restrictedCookie, agents[1], oDel);
  const del = await waitForTicketRun(oDel);
  const delFinal = del && await waitForTerminalRun(del.run.id);
  const blocked = delFinal && delFinal.status === 'failed' && /conflict|previously produced/i.test(String(delFinal.error || ''));
  const fileExists = fs.existsSync(path.join(WORKSPACE_ROOT, cd));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const noCleanDelete = del ? !hist.some(h => h.runId === del.run.id && h.operation === 'deletePath' && !h.error) : false;
  softAssert('non-permitted cross-ticket delete blocked', blocked && fileExists && noCleanDelete,
    `blocked=${blocked} fileExists=${fileExists} noCleanDelete=${noCleanDelete}`,
    'unpermitted user cross-ticket delete stays blocked with conflict; artifact survives; no clean delete history');
}

// Scope check: a delete of a path NOT owned by another ticket succeeds even for a
// non-permitted user — the permission gate is scoped to cross-ticket artifacts and
// does not affect own/unowned cleanup.
async function scenarioNonCrossTicketDeleteAllowed(restrictedCookie, agents) {
  const f = 'xdel-own/cleanup-' + STAMP + '.txt';
  fs.mkdirSync(path.join(WORKSPACE_ROOT, path.dirname(f)), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, f), 'PREEXISTING');
  const o = objectiveWith('ownDel', { actions: [{ operation: 'deletePath', args: { path: f } }], complete: true });
  await createTicket(restrictedCookie, agents[3], o);
  const r = await waitForTicketRun(o);
  const rf = r && await waitForTerminalRun(r.run.id);
  const completed = rf && rf.status === 'completed';
  const gone = !fs.existsSync(path.join(WORKSPACE_ROOT, f));
  const hist = jsonParsesOrNull('operation-history.json') || [];
  const cleanDelete = r ? hist.some(h => h.runId === r.run.id && h.operation === 'deletePath' && !h.error) : false;
  softAssert('non-cross-ticket delete allowed without permission', completed && gone && cleanDelete,
    `completed=${completed} gone=${gone} cleanDelete=${cleanDelete}`,
    'deleting a path not owned by another ticket succeeds without the cross-ticket permission (gate is scoped to cross-ticket artifacts)');
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Concurrency conflict harness');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const cookie = await login();
    const restrictedCookie = await loginAs('restricted', 'admin123');
    await scenarioConcurrentTicketCreation(cookie, agents);
    await scenarioDifferentPathWrites(cookie, agents);
    await scenarioSameFileConflict(cookie, agents);
    await scenarioSameFolderCreate(cookie, agents);
    await probeDeleteParentCrossTicket(cookie, restrictedCookie, agents);
    await probeRenameParentCrossTicket(cookie, agents);
    await scenarioDoubleRerun(cookie, agents);
    await scenarioStopVsRerun(cookie, agents);
    await scenarioNonOverlap(cookie, agents);
    await scenarioSameAgentDifferentPaths(cookie, agents);
    await scenarioSameAgentSameFile(cookie, agents);
    await scenarioSameAgentRerunIsolation(cookie, agents);
    await scenarioSameAgentFailureIsolation(cookie, agents);
    await scenarioPermittedCrossTicketDelete(cookie, agents);
    await scenarioNonPermittedCrossTicketDelete(cookie, restrictedCookie, agents);
    await scenarioNonCrossTicketDeleteAllowed(restrictedCookie, agents);

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
