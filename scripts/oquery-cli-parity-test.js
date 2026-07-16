#!/usr/bin/env node
// CLI/UI parity test — verifies the headless operator-action commands added to
// oquery (agents, stop, retry, rerun) drive the existing API routes and produce
// honest, human-readable output. Uses an isolated temp DATA_DIR/WORKSPACE_ROOT
// and never touches the tracked data store.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-ws-'));
const COOKIE = path.join(DATA_DIR, '.opercookie');
const PORT = process.env.PORT || '3548';
const URL = `http://127.0.0.1:${PORT}`;
const now = new Date().toISOString();

const FILES = ['agents.json','allocation-plans.json','groups.json','logs.json','memberships.json','operation-history.json','permissions.json','runs.json','tickets.json','users.json','workflows.json','protected-paths.json'];
for (const f of FILES) { const src = path.join(REAL_DATA, f); fs.writeFileSync(path.join(DATA_DIR, f), fs.existsSync(src) ? fs.readFileSync(src) : '[]'); }
fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
const readJ = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));

const agents = readJ('agents.json');
const agent = agents[0] || { id: 1, name: 'Agent 1', model: 'gpt-4.1-mini' };

// Seed a failed terminal run on a ticket so retry/rerun have a target.
const TID = 9001, RID = 9001;
writeJ('tickets.json', [...readJ('tickets.json'), {
  id: TID, objective: 'parity failed case', assignmentTargetType: 'agent', assignmentTargetId: agent.id,
  assignmentMode: 'individual', status: 'failed', createdBy: 'admin', createdAt: now, updatedAt: now
}]);
writeJ('runs.json', [...readJ('runs.json'), {
  id: RID, ticketId: TID, agentId: agent.id, agentName: agent.name, status: 'failed',
  workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
  runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
  ticketOpenedAt: now, createdAt: now, updatedAt: now, startedAt: now, completedAt: now, error: 'seeded failure',
  replaySnapshot: { version: 1, runId: RID, ticketId: TID, assignedAgentId: agent.id, provider: 'openai',
    model: agent.model || 'gpt-4.1-mini', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT,
    providerRequests: [], modelResponses: [], parsedModelPlans: [], workspaceOperations: [], events: [],
    terminalStatus: 'failed', failureReason: 'seeded failure', mutationCount: 0, mutationOutcome: 'no_mutations',
    createdAt: now, finalizedAt: now }
}]);

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ FAIL: ' + n));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(method, p) {
  return new Promise((res, rej) => {
    const r = http.request(`${URL}${p}`, { method }, resp => { let c = ''; resp.on('data', d => c += d); resp.on('end', () => res({ status: resp.statusCode, body: c })); });
    r.on('error', rej); r.end();
  });
}

function oquery(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'oquery.js'), ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATA_DIR, WORKSPACE_ROOT, OPERC_URL: URL, OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123', OPERC_COOKIE_PATH: COOKIE }
    });
    let out = '';
    child.stdout.on('data', c => out += c.toString());
    child.stderr.on('data', c => out += c.toString());
    child.on('close', () => resolve(out));
  });
}
// Strip ANSI for stable substring assertions.
const plain = s => s.replace(/\[[0-9;]*m/g, '');

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; server.stderr.on('data', d => err += d);
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { const h = await req('GET', '/health'); if (h.status === 200 && JSON.parse(h.body).ready) { ready = true; break; } } catch {} await sleep(100); }
    ok('server boots', ready); if (!ready) { console.log(err.slice(0, 400)); throw new Error('not ready'); }

    // agents: human-readable, lists seeded agents, no API key shown
    const a = plain(await oquery(['agents']));
    ok('agents lists seeded agents in human-readable form', a.includes('Agent 1') && a.includes('Mike') && a.includes('ollama/gemma3:latest'));
    ok('agents output does not leak an apiKey', !/apiKey/i.test(a) && !/sk-/.test(a));

    // login caches a session
    const login = plain(await oquery(['login']));
    ok('login succeeds and caches a session', /Login successful/.test(login) && fs.existsSync(COOKIE));

    // stop on a terminal run: must call the route and report truthfully (not invent success)
    const stop = plain(await oquery(['stop', String(RID)]));
    ok('stop on a terminal run reports honestly (no invented success)', /Only pending or running runs can be stopped/.test(stop) && !/Stop requested/.test(stop));

    // retry a failed run: calls /api/runs/:id/retry, reopens the ticket
    const retry = plain(await oquery(['retry', String(RID)]));
    ok('retry calls the retry route and reports the reopened ticket', /Retry requested for Run #9001/.test(retry) && /Ticket #9001/.test(retry));
    ok('retry reflects the route effect (ticket reopened, new run started)', /reopened and a new run started/.test(retry) && /Next: oquery runs --ticket 9001/.test(retry));

    // rerun the ticket: calls /api/tickets/:id/rerun
    const rerun = plain(await oquery(['rerun', String(TID)]));
    ok('rerun calls the rerun route and confirms for the ticket', /Rerun requested for Ticket #9001/.test(rerun));

    // unauthenticated guard: removing the cookie makes an action report not-logged-in
    fs.rmSync(COOKIE, { force: true });
    const noauth = plain(await oquery(['rerun', String(TID)]));
    ok('action without a session reports not logged in (no silent success)', /Not logged in/.test(noauth));

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: oquery CLI parity (${pass} passed, ${fail} failed)`);
  } catch (e) {
    console.error('ERROR', e.stack || e.message); fail++;
  } finally {
    server.kill(); await sleep(200);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    process.exit(fail ? 1 : 0);
  }
})();
