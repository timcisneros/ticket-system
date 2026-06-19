// Render-level regression for Run Detail evidence clarity (display-only).
// Seeds completed runs with crafted replay snapshots and asserts the
// "Why this run stopped" block and improved empty-events wording.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'run-detail-clarity-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'run-detail-clarity-ws-'));
const PORT = process.env.PORT || '3547';
const BASE = `http://127.0.0.1:${PORT}`;
const now = new Date().toISOString();

const FILES = ['agents.json','allocation-plans.json','groups.json','logs.json','memberships.json','operation-history.json','permissions.json','runs.json','tickets.json','users.json','workflows.json'];
for (const f of FILES) { const src = path.join(REAL_DATA, f); fs.writeFileSync(path.join(DATA_DIR, f), fs.existsSync(src) ? fs.readFileSync(src) : '[]'); }
const readJ = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));

const agents = readJ('agents.json');
const agent = agents[0] || { id: 1, name: 'Agent 1', model: 'gpt-4.1-mini' };

function snapBase(runId, ticketId, extra) {
  return Object.assign({
    version: 1, runId, ticketId, assignedAgentId: agent.id, agentNameSnapshot: agent.name,
    provider: 'openai', model: agent.model || 'gpt-4.1-mini', runtimeEnvelope: {}, ticketObjectiveSnapshot: 'obj',
    systemInstructionSnapshot: 'sys', primitiveContract: {}, workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main', providerRequests: [], modelResponses: [], parsedModelPlans: [], workspaceOperations: [],
    events: [], terminalStatus: 'completed', failureReason: null, mutationCount: 0, mutationOutcome: 'no_mutations', createdAt: now, finalizedAt: now
  }, extra);
}
function mkRun(id, ticketId, snapshot) {
  return { id, ticketId, agentId: agent.id, agentName: agent.name, status: 'completed', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main', ticketOpenedAt: now, createdAt: now, updatedAt: now, startedAt: now, completedAt: now, replaySnapshot: snapshot };
}

const evidence = {
  providerRequests: [{ request: 1, durationMs: 10 }],
  modelResponses: [{ response: 1, durationMs: 8 }],
  workspaceOperations: [{ operation: { operation: 'createFolder' }, result: { status: 'created' }, durationMs: 2 }]
};

const tickets = readJ('tickets.json');
let tid = Math.max(0, ...tickets.map(t => t.id || 0));
let rid = Math.max(0, ...readJ('runs.json').map(r => r.id || 0));
const C = {};

// Case 1: completed via folder-list postcondition with checked paths
C.postcondition = { rid: ++rid, tid: ++tid };
// Case 2/4: completed via modelPlan.complete, evidence present but NO replay events
C.modelComplete = { rid: ++rid, tid: ++tid };
// Case 3: cap truncation event present
C.cap = { rid: ++rid, tid: ++tid };

const newTickets = [
  ...tickets,
  { id: C.postcondition.tid, objective: 'postcondition case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', createdBy: 'admin', createdAt: now, updatedAt: now },
  { id: C.modelComplete.tid, objective: 'model complete case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', createdBy: 'admin', createdAt: now, updatedAt: now },
  { id: C.cap.tid, objective: 'cap case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', createdBy: 'admin', createdAt: now, updatedAt: now }
];
writeJ('tickets.json', newTickets);

const runs = readJ('runs.json');
writeJ('runs.json', [
  ...runs,
  mkRun(C.postcondition.rid, C.postcondition.tid, snapBase(C.postcondition.rid, C.postcondition.tid, {
    ...evidence,
    events: [{ type: 'run:postcondition_completed', message: 'Requested workspace state is already satisfied', step: 1, mutatingActionCount: 0, checkedPaths: [{ type: 'folderExists', path: 'CaseA' }, { type: 'folderExists', path: 'CaseB' }], source: 'pre_model' }]
  })),
  mkRun(C.modelComplete.rid, C.modelComplete.tid, snapBase(C.modelComplete.rid, C.modelComplete.tid, {
    ...evidence, events: [] // evidence present, NO replay events
  })),
  mkRun(C.cap.rid, C.cap.tid, snapBase(C.cap.rid, C.cap.tid, {
    ...evidence,
    events: [
      { type: 'model:mutating_action_truncated', actionCount: 4, mutatingActionCount: 4, maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 2, executedCount: 2, truncatedCount: 2, step: 1 },
      { type: 'run:completion_deferred_truncation', message: 'complete:true not honored', step: 1 }
    ]
  }))
]);

function req(method, p, { cookie } = {}) { return new Promise((res, rej) => { const r = http.request(`${BASE}${p}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}) } }, resp => { const c = []; resp.on('data', d => c.push(d)); resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); r.end(); }); }
function post(p, form) { const body = new URLSearchParams(form).toString(); return new Promise((res, rej) => { const r = http.request(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, resp => { const c = []; resp.on('data', d => c.push(d)); resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(c).toString('utf8') })); }); r.on('error', rej); r.write(body); r.end(); }); }
const cookieOf = r => (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ FAIL: ' + n));

(async () => {
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; server.stderr.on('data', d => err += d);
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) { try { const h = await req('GET', '/health'); if (h.status === 200 && JSON.parse(h.body).ready) { ready = true; break; } } catch {} await sleep(100); }
    ok('server boots', ready); if (!ready) { console.log(err.slice(0, 400)); throw new Error('not ready'); }
    const cookie = cookieOf(await post('/login', { username: 'admin', password: 'admin123' }));

    // Case 1: postcondition completion with checked paths
    const p1 = (await req('GET', `/runs/${C.postcondition.rid}`, { cookie })).body;
    ok('1: shows "Why this run stopped" block', p1.includes('Why this run stopped'));
    ok('1: source is postcondition', p1.includes('<code>postcondition</code>'));
    ok('1: explains postconditions verified', p1.includes('required postconditions verified'));
    ok('1: lists checked paths', p1.includes('CaseA') && p1.includes('CaseB') && p1.includes('Checked paths'));

    // Case 2/4: model_complete with evidence but no replay events
    const p2 = (await req('GET', `/runs/${C.modelComplete.rid}`, { cookie })).body;
    ok('2: source is model_complete', p2.includes('<code>model_complete</code>'));
    ok('2: explanation is evidence-bounded (inferred complete:true, no specific postcondition event)', p2.includes('available run evidence points to a model complete:true completion') && p2.includes('no more specific postcondition event was captured'));
    ok('2/4: empty-events wording clarifies absent replay events != missing evidence', p2.includes('Absent replay events do not mean the other evidence is missing'));
    ok('2/4: does NOT show bare "No replay events captured." when evidence exists', !p2.includes('No replay events captured.'));
    ok('2/4: evidence line shows provider/model/workspace counts', /1 provider request\(s\),\s*1 model response\(s\),\s*1 workspace action\(s\)/.test(p2.replace(/\s+/g, ' ')));

    // Case 3: cap truncation note
    const p3 = (await req('GET', `/runs/${C.cap.rid}`, { cookie })).body;
    ok('3: cap note present with proposed count and limit', p3.includes('Action cap applied: model proposed 4 mutating action(s); runtime limit is 2'));
    ok('3: cap note says truncated and run continued', p3.includes('truncated') && p3.includes('the run continued'));
    ok('3: cap note mentions deferred complete:true', p3.includes('complete:true was not honored for that response'));

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: run-detail evidence clarity (${pass} passed, ${fail} failed)`);
  } catch (e) { console.error('ERROR', e.stack || e.message); fail++; }
  finally { server.kill(); await sleep(200); fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }
})();
