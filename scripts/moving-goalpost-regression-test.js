// Deterministic regression for the relative-objective anchoring fix.
//
// Reproduces Ticket #2: objective "Create folders with the 3 next letters of the
// alphabet from the ones that are currently there" against an initial workspace
// A/B/C/D. The scripted model emulates an agent that follows the new anchoring
// instruction: it resolves the target from initialWorkspaceSnapshot and stops
// once mutationsByThisRun covers that target. Asserts:
//   - prompt/context separates initial vs current snapshots and run mutations
//   - the initial snapshot stays A/B/C/D and never absorbs E/F/G
//   - the current snapshot does drift (so the separation is load-bearing)
//   - final workspace has E/F/G and NOT H/I/J
//   - the run completes (does not keep mutating)

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA_DIR = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'moving-goalpost-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'moving-goalpost-ws-'));
const PORT = process.env.PORT || '3526';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const CAPTURE_FILE = path.join(os.tmpdir(), `moving-goalpost-capture-${STAMP}.json`);

const DATA_FILES = ['agents.json','allocation-plans.json','groups.json','logs.json','memberships.json','operation-history.json','permissions.json','runs.json','tickets.json','users.json','workflows.json'];
for (const f of DATA_FILES) { const src = path.join(REAL_DATA_DIR, f); fs.writeFileSync(path.join(DATA_DIR, f), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '[]'); }
const readJson = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE_URL}${urlPath}`, { method, headers: { ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) } }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const cookieFrom = r => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function waitForReady() {
  const started = Date.now();
  while (Date.now() - started < 15000) { try { const r = await request('GET', '/health'); if (r.statusCode === 200 && JSON.parse(r.body).ready) return; } catch {} await sleep(100); }
  throw new Error('Timed out waiting for server ready');
}
async function login() { const r = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } }); if (r.statusCode !== 302) throw new Error('login failed ' + r.statusCode); return cookieFrom(r); }

function seedAgent() {
  const agents = readJson('agents.json');
  const agent = { id: Math.max(0, ...agents.map(a => a.id || 0)) + 1, name: `MG-${STAMP}`, type: 'agent', provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-mg', createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(DATA_DIR, 'agents.json'), JSON.stringify([...agents, agent], null, 2));
  return agent;
}

async function createTicket(cookie, agent, objective, acceptanceCriteria) {
  const r = await request('POST', '/tickets', { cookie, form: { objective, acceptanceCriteria, assignmentTargetType: 'agent', assignmentTargetId: String(agent.id) } });
  if (r.statusCode !== 302) throw new Error('ticket create failed ' + r.statusCode + ': ' + r.body);
  return readJson('tickets.json').find(t => t.objective === objective);
}

async function waitForRunTerminal(ticketId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = readJson('runs.json').find(r => r.ticketId === ticketId);
    if (run && ['completed', 'failed', 'interrupted'].includes(run.status)) return run;
    await sleep(100);
  }
  throw new Error('Timed out waiting for terminal run on ticket ' + ticketId);
}

// Fake OpenAI provider: emulates an agent that obeys the anchoring instruction.
function createPreload() {
  const preloadPath = path.join(os.tmpdir(), `mg-openai-${process.pid}-${STAMP}.js`);
  const source = `
const fs = require('fs');
const captureFile = ${JSON.stringify(CAPTURE_FILE)};
const captures = [];
let callCount = 0;
function nextThree(letters){ const codes = letters.map(l => l.charCodeAt(0)); const max = Math.max.apply(null, codes); return [1,2,3].map(i => String.fromCharCode(max + i)); }
function ok(plan){ return { ok: true, status: 200, headers: new Map([['x-request-id','fake-mg']]), async text(){ return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } }; }
global.fetch = async function(url, options = {}){
  const body = JSON.parse(options.body || '{}');
  const input = Array.isArray(body.input) ? body.input : [];
  const combined = input.map(it => it && it.content ? String(it.content) : '').join('\\n');
  let ctx = null;
  for (const it of input) { if (it && typeof it.content === 'string') { try { const o = JSON.parse(it.content); if (o && o.ticketObjective) { ctx = o; break; } } catch (e) {} } }
  callCount++;
  const initialNames = ctx && ctx.initialWorkspaceSnapshot ? (ctx.initialWorkspaceSnapshot.entries || []).map(e => e.name) : [];
  const currentNames = ctx && ctx.currentWorkspaceSnapshot ? (ctx.currentWorkspaceSnapshot.entries || []).map(e => e.name) : [];
  const mutationPaths = ctx && ctx.mutationsByThisRun ? ctx.mutationsByThisRun.map(m => m.path) : [];
  captures.push({ callCount, initial: initialNames, current: currentNames, mutations: mutationPaths, acceptanceCriteria: ctx && ctx.acceptanceCriteria, anchor: combined.includes('Do not treat files or folders created by this run'), completionDiscipline: combined.includes('Do not continue creating additional files or folders merely because the live workspace has changed'), criteriaDiscipline: combined.includes('If acceptanceCriteria is present in the ticket context') });
  fs.writeFileSync(captureFile, JSON.stringify(captures, null, 2));

  const letters = initialNames.filter(n => /^[A-Z]$/.test(n));
  if (letters.length === 0) return ok({ message: 'No anchor letters; stopping.', actions: [], complete: true });
  const target = nextThree(letters);                       // E,F,G from A,B,C,D
  const created = new Set(mutationPaths);
  const missing = target.filter(t => !created.has(t));
  if (missing.length === 0) return ok({ message: 'Target ' + target.join('/') + ' satisfied.', actions: [], complete: true });
  const batch = missing.slice(0, 2);                       // respect 2 mutations/response
  return ok({ message: 'Creating ' + batch.join('/') + ' (anchored to initial workspace).', actions: batch.map(p => ({ operation: 'createFolder', args: { path: p } })), complete: false });
};
`;
  fs.writeFileSync(preloadPath, source);
  return preloadPath;
}

async function main() {
  for (const name of ['A', 'B', 'C', 'D']) fs.mkdirSync(path.join(WORKSPACE_ROOT, name), { recursive: true });
  const agent = seedAgent();
  const preloadPath = createPreload();
  let server = null;
  let pass = 0;
  const ok = (n, c) => { assert(c, n); pass++; console.log('  ✓ ' + n); };

  try {
    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', PORT, NODE_OPTIONS: `--require ${preloadPath}`, WORKSPACE_ROOT, DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; server.stderr.on('data', d => err += d);
    await waitForReady();
    const cookie = await login();

    const objective = 'Create folders with the 3 next letters of the alphabet from the ones that are currently there';
    const acceptanceCriteria = 'Folders E, F, and G exist and no later alphabet folders are created.';
    const ticket = await createTicket(cookie, agent, objective, acceptanceCriteria);
    const run = await waitForRunTerminal(ticket.id);

    // --- Behavioral outcome ---
    const exists = name => fs.existsSync(path.join(WORKSPACE_ROOT, name));
    ok('E/ created', exists('E'));
    ok('F/ created', exists('F'));
    ok('G/ created', exists('G'));
    ok('H/ NOT created (no moving goalpost)', !exists('H'));
    ok('I/ NOT created', !exists('I'));
    ok('J/ NOT created', !exists('J'));
    ok('run completed (did not continue mutating to a step-limit failure)', run.status === 'completed');

    // --- Prompt/context shape ---
    assert(fs.existsSync(CAPTURE_FILE), 'capture file should exist');
    const caps = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    ok('model was called more than once (multi-step run)', caps.length >= 2);
    ok('every prompt carried the anchoring instruction', caps.every(c => c.anchor));
    ok('every prompt carried the completion-discipline instruction', caps.every(c => c.completionDiscipline));
    ok('every prompt carried the frozen acceptance criteria', caps.every(c => c.acceptanceCriteria === acceptanceCriteria));
    ok('every prompt carried acceptance-criteria completion discipline', caps.every(c => c.criteriaDiscipline));
    ok('initial snapshot is A/B/C/D on first call', JSON.stringify([...caps[0].initial].sort()) === JSON.stringify(['A','B','C','D']));
    ok('initial snapshot stays A/B/C/D on EVERY call (never absorbs E/F/G)', caps.every(c => JSON.stringify([...c.initial].sort()) === JSON.stringify(['A','B','C','D'])));

    const afterMutation = caps.find(c => c.mutations.length > 0);
    ok('a later call shows mutationsByThisRun (E present)', afterMutation && afterMutation.mutations.includes('E'));
    ok('current snapshot DOES drift (includes E after creation)', afterMutation && afterMutation.current.includes('E'));
    // Separation is load-bearing: resolving from current would have drifted off target.
    const initLetters = caps[0].initial.filter(n => /^[A-Z]$/.test(n));
    const curLetters = afterMutation.current.filter(n => /^[A-Z]$/.test(n));
    const n3 = ls => { const m = Math.max(...ls.map(l => l.charCodeAt(0))); return [1,2,3].map(i => String.fromCharCode(m + i)).join(''); };
    ok('initial-anchored target (EFG) differs from current-anchored target (FGH)', n3(initLetters) === 'EFG' && n3(curLetters) !== 'EFG');
    const lastWithMut = [...caps].reverse().find(c => c.mutations.length >= 3);
    ok('mutationsByThisRun eventually lists E/F/G', lastWithMut && ['E','F','G'].every(t => lastWithMut.mutations.includes(t)));

    console.log(`\nPASS: moving-goalpost anchoring regression (${pass} checks)`);
  } catch (e) {
    console.error('FAIL:', e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (server) { server.kill(); await sleep(200); }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(CAPTURE_FILE, { force: true });
    try { fs.rmSync(preloadPath, { force: true }); } catch {}
  }
}

main();
