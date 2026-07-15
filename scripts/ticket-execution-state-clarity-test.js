// Render-level regression for Ticket execution-state clarity (display-only).
// Seeds tickets/runs/allocation and renders Ticket Detail + Ticket List,
// asserting the new Execution State block, list execution line, rerun wording,
// and current-message source are explicit and not misleading.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const REAL_DATA = path.join(ROOT, 'data');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-exec-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-exec-ws-'));
const PORT = process.env.PORT || '3549';
const BASE = `http://127.0.0.1:${PORT}`;
const now = new Date().toISOString();

const FILES = ['agents.json','allocation-plans.json','groups.json','logs.json','memberships.json','operation-history.json','permissions.json','runs.json','tickets.json','users.json','workflows.json'];
for (const f of FILES) { const src = path.join(REAL_DATA, f); fs.writeFileSync(path.join(DATA_DIR, f), fs.existsSync(src) ? fs.readFileSync(src) : '[]'); }
const readJ = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));

const agents = readJ('agents.json');
const agent = agents[0] || { id: 1, name: 'Agent 1', model: 'gpt-4.1-mini' };

// Ensure a ticket-capable group with >=2 agent members for the group case.
const groups = readJ('groups.json');
let group = groups.find(g => g.canReceiveTickets);
if (!group) { group = { id: Math.max(0, ...groups.map(g => g.id || 0)) + 1, name: 'Exec Test Group', permissions: ['ticket:read'], canReceiveTickets: true }; writeJ('groups.json', [...groups, group]); }
const memberships = readJ('memberships.json');
let mid = Math.max(0, ...memberships.map(m => m.id || 0));
const memberAgents = agents.slice(0, 2);
for (const a of memberAgents) { if (!memberships.some(m => m.principalType === 'agent' && m.principalId === a.id && m.groupId === group.id)) memberships.push({ id: ++mid, principalType: 'agent', principalId: a.id, groupId: group.id }); }
writeJ('memberships.json', memberships);
const expectedMembers = new Set(memberships.filter(m => m.principalType === 'agent' && m.groupId === group.id && agents.some(a => a.id === m.principalId)).map(m => m.principalId)).size;

function snap(runId, ticketId, extra) {
  return Object.assign({ version: 1, runId, ticketId, assignedAgentId: agent.id, agentNameSnapshot: agent.name, provider: 'openai', model: agent.model || 'gpt-4.1-mini', runtimeEnvelope: {}, ticketObjectiveSnapshot: 'obj', systemInstructionSnapshot: 'sys', primitiveContract: {}, workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main', providerRequests: [{ r: 1 }], modelResponses: [{ r: 1 }], parsedModelPlans: [{ message: 'Created the requested folders.', actions: [], complete: true, step: 1 }], workspaceOperations: [], events: [], terminalStatus: 'completed', mutationCount: 4, createdAt: now, finalizedAt: now }, extra);
}
function mkRun(id, ticketId, status, extra) {
  return Object.assign({ id, ticketId, agentId: agent.id, agentName: agent.name, status, workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main', ticketOpenedAt: now, createdAt: now, updatedAt: now, startedAt: now, completedAt: status === 'completed' ? now : null, replaySnapshot: snap(id, ticketId, { terminalStatus: status }) }, extra);
}

const tickets = readJ('tickets.json');
let tid = Math.max(0, ...tickets.map(t => t.id || 0));
let rid = Math.max(0, ...readJ('runs.json').map(r => r.id || 0));
const C = {
  agentDone: { tid: ++tid, rid: ++rid },
  openStopped: { tid: ++tid, rid: ++rid },
  blocked: { tid: ++tid },
  group: { tid: ++tid, rid: ++rid },
  failed: { tid: ++tid, rid: ++rid },
  postcond: { tid: ++tid, rid: ++rid },
  review: { tid: ++tid, rid: ++rid },
  plan: 9001
};

const newTickets = [
  ...tickets,
  // 1 + 4: agent-assigned, completed run with model-response message
  { id: C.agentDone.tid, objective: 'agent done case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', currentMessage: 'Created the requested folders.', createdBy: 'admin', createdAt: now, updatedAt: now },
  // 6: open ticket with historical stopped run must not claim no run exists
  { id: C.openStopped.tid, objective: 'open stopped case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'open', createdBy: 'admin', createdAt: now, updatedAt: now },
  // 2: blocked with feasibility reason
  { id: C.blocked.tid, objective: 'blocked case', assignmentTargetType: 'group', assignmentTargetId: group.id, assignmentMode: 'allocated', status: 'blocked', createdBy: 'admin', createdAt: now, updatedAt: now, blockedReason: 'Ticket objective requires paths not granted by authority:\nQ3/\nQ4/', feasibility: { status: 'blocked', reason: 'Ticket objective requires paths not granted by authority:\nQ3/\nQ4/', code: 'TICKET_FEASIBILITY_ERROR', kind: 'impossible_authority_scope', requiredWritableRoots: ['Q1/','Q2/','Q3/','Q4/'], grantedWritableRoots: ['Q1/','Q2/'], missingAuthorityGrants: ['Q3/','Q4/'] } },
  // 3: group-assigned with allocation plan / work units
  { id: C.group.tid, objective: 'group case', assignmentTargetType: 'group', assignmentTargetId: group.id, assignmentMode: 'allocated', status: 'in_progress', createdBy: 'admin', createdAt: now, updatedAt: now },
  // failed agent ticket: the list card must surface the failure reason, not just "failed — retry available"
  { id: C.failed.tid, objective: 'failed reason case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'failed', createdBy: 'admin', createdAt: now, updatedAt: now },
  // hydration-independence: completed run with postcondition + mutations, rendered on the
  // un-hydrated ticket-list path (replaySummary only, no replaySnapshot/snapshot file).
  { id: C.postcond.tid, objective: 'postcondition hydration case', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', createdBy: 'admin', createdAt: now, updatedAt: now },
  // review-status: completed run with evidence warnings (objective coverage not scored,
  // artifact accuracy < 100%, missing + unexpected artifacts) must show completed execution
  // AND a separate "needs review" status.
  { id: C.review.tid, objective: 'produce the review output', assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual', status: 'completed', createdBy: 'admin', createdAt: now, updatedAt: now }
];
writeJ('tickets.json', newTickets);

// Note: only seed terminal runs. A seeded pending/running run would be
// interrupted on startup, which would rewrite allocation item statuses and the
// ticket status. The group case relies on the seeded allocation plan only.
writeJ('runs.json', [
  ...readJ('runs.json'),
  mkRun(C.agentDone.rid, C.agentDone.tid, 'completed'),
  mkRun(C.openStopped.rid, C.openStopped.tid, 'interrupted', {
    error: 'process restarted before run completed',
    replaySnapshot: snap(C.openStopped.rid, C.openStopped.tid, {
      terminalStatus: 'interrupted',
      failureReason: 'process restarted before run completed',
      failure: { code: 'RUN_INTERRUPTED', kind: 'interrupted', detail: { reason: 'process restarted before run completed' } },
      mutationCount: 0,
      mutationOutcome: 'no_mutations'
    })
  }),
  mkRun(C.failed.rid, C.failed.tid, 'failed', {
    completedAt: now,
    error: 'Agent API key is missing',
    replaySnapshot: snap(C.failed.rid, C.failed.tid, {
      terminalStatus: 'failed',
      failureReason: 'Agent API key is missing',
      mutationCount: 0,
      mutationOutcome: 'no_mutations'
    })
  }),
  // Un-hydrated completed run: replaySummary carries the postcondition flag and a
  // mutation count, but there is no inlined replaySnapshot and no snapshot file on
  // disk, so the ticket-list path must classify from replaySummary alone.
  {
    id: C.postcond.rid, ticketId: C.postcond.tid, agentId: agent.id, agentName: agent.name,
    status: 'completed', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT,
    executionWorkspaceType: 'main', createdAt: now, updatedAt: now, startedAt: now, completedAt: now,
    mutationCount: 2,
    replaySummary: { hasPostconditionCompleted: true, hasCompletedNoop: false, hasBlockedOrRejected: false, mutationCount: 2, mutationOutcome: 'all_intended', terminalStatus: 'completed' }
  },
  // review-status run: predicts one artifact, but actual evidence (operation history)
  // writes a different path → accuracy < 100%, missing + unexpected; objective has no
  // path token → coverage not scored. Postcondition event present (completed).
  mkRun(C.review.rid, C.review.tid, 'completed', {
    replaySnapshot: snap(C.review.rid, C.review.tid, {
      artifactPrediction: { artifacts: [{ type: 'file', artifact: 'review/expected.txt' }] },
      events: [{ type: 'run:postcondition_completed', message: 'Requested workspace state is already satisfied' }]
    })
  })
]);

// Actual artifact evidence for the review-status run: a writeFile to a different
// path than predicted, producing a missing + unexpected mismatch.
writeJ('operation-history.json', [
  ...readJ('operation-history.json'),
  { id: 90001, runId: C.review.rid, ticketId: C.review.tid, agentId: agent.id, operation: 'writeFile', args: { path: 'review/other.txt' }, result: { path: 'review/other.txt', status: 'written' }, timestamp: now }
]);

// Seed a failed run.terminalized event so recentEventSummary().latestError surfaces the
// reason (the same source Ticket Detail / Run Detail use). Written before the
// server starts; the server's writeMissingFile leaves an existing log intact.
fs.writeFileSync(
  path.join(DATA_DIR, 'events.jsonl'),
  JSON.stringify(sealCurrentRunEventChains([{ id: 'evt-failed-reason', ts: now, type: 'run.terminalized', ticketId: C.failed.tid, runId: C.failed.rid, stepId: null, payload: { status: 'failed', error: 'Agent API key is missing' } }])[0]) + '\n'
);

writeJ('allocation-plans.json', [
  ...readJ('allocation-plans.json'),
  { id: C.plan, ticketId: C.group.tid, status: 'running', createdAt: now, ticketOpenedAt: now, items: [
    { allocationItemId: 1, assignedAgentId: memberAgents[0].id, status: 'completed', allocationSubtask: 's1', ownedOutputPaths: ['Q1/'] },
    { allocationItemId: 2, assignedAgentId: (memberAgents[1] || memberAgents[0]).id, status: 'running', allocationSubtask: 's2', ownedOutputPaths: ['Q2/'] }
  ] }
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

    // Case 1 + 4: agent-assigned completed ticket
    const d1 = (await req('GET', `/tickets/${C.agentDone.tid}`, { cookie })).body;
    ok('1: At a glance runtime block present', d1.includes('At a glance'));
    ok('1: assigned-to shows agent name', d1.includes('Agent: ' + agent.name));
    ok('1: auto-run says terminal/use rerun', d1.includes('Use Rerun to start a new run'));
    ok('1: latest run linked with status', d1.includes(`Run #${C.agentDone.rid}</a>`) && d1.includes('status-completed') && d1.includes('>completed<'));
    ok('4: current message shows model response text', d1.includes('Created the requested folders.'));
    ok('5: rerun wording describes actual behavior', d1.includes('interrupts any active run, reopens this ticket, and starts a new run'));

    // Case 2: blocked ticket
    const d2 = (await req('GET', `/tickets/${C.blocked.tid}`, { cookie })).body;
    ok('2: auto-run says blocked', d2.includes('Blocked — will not run until the blocking reason is resolved.'));
    ok('2: blocked reason shown in execution state', d2.includes('requires paths not granted by authority'));

    // Case 3: group ticket with allocation
    const d3 = (await req('GET', `/tickets/${C.group.tid}`, { cookie })).body;
    ok('3: assigned-to shows group name', d3.includes('Group: ' + group.name));
    ok('3: assignment mode shown', d3.includes('allocated (manual folder scopes)'));
    ok('3: group fan-out summary with work units', d3.includes('work units: 2 generated, 1 completed') && d3.includes(expectedMembers + ' member'));
    ok('3: rerun wording mentions group allocation regeneration', d3.includes('regenerates the work-unit allocation'));

    // List view
    const list = (await req('GET', '/tickets?limit=100', { cookie })).body;
    ok('list: shows "Execution: completed — rerun available" for completed ticket', list.includes('Execution: completed — rerun available'));
    ok('list: shows "Execution: blocked" for blocked ticket', list.includes('Execution: blocked'));
    ok('list: shows "Assigned to:" prefix', list.includes('Assigned to: ' + agent.name));
    const stoppedIndex = list.indexOf('open stopped case');
    const blockedIndex = list.indexOf('blocked case');
    const stoppedCard = stoppedIndex === -1 ? '' : list.slice(stoppedIndex, blockedIndex === -1 ? stoppedIndex + 1200 : blockedIndex);
    ok('list: open ticket with stopped latest run shows latest run status', stoppedCard.includes('latest run:') && stoppedCard.includes('stopped'));
    ok('list: open ticket with stopped latest run does not claim no run exists', !stoppedCard.includes('No run has been created yet'));
    const failedIndex = list.indexOf('failed reason case');
    const failedCard = failedIndex === -1 ? '' : list.slice(failedIndex, failedIndex + 1200);
    ok('list: failed ticket shows "failed — retry available"', failedCard.includes('Execution: failed — retry available'));
    ok('list: failed ticket surfaces the failure reason on the card', failedCard.includes('Agent API key is missing'));

    // Hydration-independent outcome: an un-hydrated completed run with a postcondition
    // event AND mutations must classify as postconditions checked (the completion
    // criterion), not changes applied — same as the hydrated run-detail surface.
    // Only this seeded run carries replaySummary.hasPostconditionCompleted, so the
    // "postconditions checked" label can come from no other card. Without the
    // hydration-independent fix the un-hydrated run would render "changes applied".
    ok('list: un-hydrated postcondition run classifies as postconditions checked (hydration-independent)', list.includes('latest run: completed — postconditions checked'));

    // Review status: a completed run with evidence warnings shows completed execution AND needs-review.
    const dReview = (await req('GET', `/tickets/${C.review.tid}`, { cookie })).body;
    ok('review: execution still shows completed (terminal/use rerun)', dReview.includes('Use Rerun to start a new run'));
    ok('review: review status flags needs review', dReview.includes('Review status') && dReview.includes('Needs review'));
    ok('review: lists objective-not-independently-verified reason', dReview.includes('The full ticket objective was not independently verified.'));
    ok('review: lists objective path coverage not scored', dReview.includes('Objective path coverage was not scored.'));
    ok('review: lists unexpected artifact warning', dReview.includes('Unexpected artifact'));

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: ticket execution-state clarity (${pass} passed, ${fail} failed)`);
  } catch (e) { console.error('ERROR', e.stack || e.message); fail++; }
  finally { server.kill(); await sleep(200); fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }
})();
