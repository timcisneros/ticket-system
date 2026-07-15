#!/usr/bin/env node
// Bounded automatic retry v1. Default-off, policy-gated, single-run, bounded by
// maxAttempts, only for the runtime_failed allowlist with mutationCount === 0,
// only inside failAgentRun before triage is persisted. No provider key required:
// failures are induced deterministically by no-model workflows / a keyless agent.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-03-01T09:00:00.000Z';
const PORT = '3505';
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(options.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-retry-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-retry-ws-'));
const writeJson = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));
const readRunsJson = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
const runsFor = id => readRunsJson().filter(r => r.ticketId === id).sort((a, b) => a.id - b.id);
const readLogsJson = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8'));

function ticket(id, objective, executionPolicy, extra) {
  return {
    id, objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy, status: 'completed', createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0,
    ...extra
  };
}
function wfTicket(id, objective, policy, workflowId, extra = {}) {
  return ticket(id, objective, policy, { executionMode: 'workflow', workflowId, capabilityType: 'workflow', capabilityId: workflowId, workflowInput: {}, ...extra });
}
// An unresolved ticket-level triage (required, never resolved).
const blockingTicketTriage = () => ({
  required: true, reasonCode: 'authority_blocked', summary: 'Objective needs writable scope outside granted paths',
  requiredDecision: 'change_scope', evidenceRefs: ['ticket:feasibility'], allowedActions: ['review', 'edit_ticket'],
  prohibitedActions: ['start_run_without_scope_change'], createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
});

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Administrators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [
    { id: 1, name: 'WF Agent', type: 'agent', provider: 'openai', model: 'gpt-x', apiKey: 'demo-key', createdAt: T0, updatedAt: T0 },
    { id: 2, name: 'Keyless Agent', type: 'agent', provider: 'openai', model: 'gpt-x', apiKey: '', createdAt: T0, updatedAt: T0 }
  ]);
  // No-model workflows that fail deterministically without a provider.
  writeJson('workflows.json', [
    { id: 'bad-wf', name: 'Bad', version: '1', enabled: true, inputSchema: {}, actions: [{ id: 'x', action: 'nonexistent_action_type', input: {} }] },                                   // runtime_failed (no mutation)
    { id: 'verify-fail-wf', name: 'VerifyFail', version: '1', enabled: true, inputSchema: {}, actions: [{ id: 'done', action: 'stop', input: {} }], postconditions: [{ id: 'pc', type: 'fileExists', path: 'never-written.txt' }] }, // verification_failed
    // Valid action types (passes workflow validation); the first writeFile mutates
    // the workspace, then a second writeFile to a path outside the workspace fails at
    // RUNTIME — a terminal failure with a workspace mutation already applied.
    { id: 'mutate-fail-wf', name: 'MutateFail', version: '1', enabled: true, inputSchema: {}, actions: [{ id: 'w1', action: 'writeFile', input: { path: 'auto-retry-out.txt', content: 'x' }, next: 'w2' }, { id: 'w2', action: 'writeFile', input: { path: '../../escape.txt', content: 'y' }, next: 'done' }, { id: 'done', action: 'stop', input: {} }] },
    // Single writeFile to a path outside the workspace → authority_blocked/protected
    // class, with NO prior workspace mutation (mutationCount 0).
    { id: 'escape-wf', name: 'Escape', version: '1', enabled: true, inputSchema: {}, actions: [{ id: 'w', action: 'writeFile', input: { path: '../../escape.txt', content: 'z' }, next: 'done' }, { id: 'done', action: 'stop', input: {} }] }
  ]);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('protected-paths.json', []);

  writeJson('tickets.json', [
    wfTicket(1, 'default off (no retry)', { autoRetry: false, maxAttempts: null }, 'bad-wf'),
    wfTicket(2, 'autoRetry true but maxAttempts null (no retry)', { autoRetry: true, maxAttempts: null }, 'bad-wf'),
    wfTicket(3, 'autoRetry true + maxAttempts 2 (bounded retry)', { autoRetry: true, maxAttempts: 2 }, 'bad-wf'),
    wfTicket(4, 'verification failure never retries', { autoRetry: true, maxAttempts: 2 }, 'verify-fail-wf'),
    ticket(5, 'provider failure never retries', { autoRetry: true, maxAttempts: 2 }, { assignmentTargetId: 2 }),
    wfTicket(6, 'runtime failure with mutation never retries', { autoRetry: true, maxAttempts: 2 }, 'mutate-fail-wf'),
    // 7: pre-seeded terminal failed run; startup must NOT auto-retry it.
    wfTicket(7, 'startup must not retry old failed run', { autoRetry: true, maxAttempts: 2 }, 'bad-wf', { status: 'failed' }),
    // 8: unresolved ticket-level triage must block auto-retry even for a runtime_failed
    // run. The run is seeded pending (createRunsForTicket refuses triaged tickets); the
    // scheduler runs it, it fails runtime_failed, and the gate must NOT retry.
    wfTicket(8, 'ticket-level triage blocks auto-retry', { autoRetry: true, maxAttempts: 2 }, 'bad-wf', { status: 'in_progress', triage: blockingTicketTriage() }),
    // 9: authority/protected-path class never retries (no mutation).
    wfTicket(9, 'authority/protected-path never retries', { autoRetry: true, maxAttempts: 2 }, 'escape-wf')
  ]);
  writeJson('runs.json', [
    {
      id: 700, ticketId: 7, agentId: 1, agentName: 'WF Agent', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
      allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], executionMode: 'workflow', workflowId: 'bad-wf', capabilityType: 'workflow', capabilityId: 'bad-wf', workflowInput: {},
      executionPolicySnapshot: { autoRetry: true, maxAttempts: 2, requireVerification: 'when_declared' },
      currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
      status: 'failed', error: 'Workflow definition invalid', createdAt: T0, updatedAt: T0, startedAt: T0, completedAt: T0, replaySnapshotPath: 'replay-snapshots/run-700.json',
      triage: { required: true, reasonCode: 'runtime_failed', summary: 'Workflow definition invalid', requiredDecision: 'review_failure', evidenceRefs: [], allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['automatic_retry'], createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null }
    },
    {
      id: 800, ticketId: 8, agentId: 1, agentName: 'WF Agent', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
      allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], executionMode: 'workflow', workflowId: 'bad-wf', capabilityType: 'workflow', capabilityId: 'bad-wf', workflowInput: {},
      executionPolicySnapshot: { autoRetry: true, maxAttempts: 2, requireVerification: 'when_declared' },
      currentPhase: 'initialization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
      status: 'pending', createdAt: T0, updatedAt: T0, replaySnapshotPath: 'replay-snapshots/run-800.json'
    }
  ]);
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-700.json'), JSON.stringify({ runId: 700, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }));
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-800.json'), JSON.stringify({ runId: 800, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }));
  // A single run.created event makes run 800 safely resumable at startup (an
  // event-less pending run is interrupted instead). The scheduler then runs it.
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'),
    JSON.stringify(sealCurrentRunEventChains([{ type: 'run.created', ticketId: 8, runId: 800, ts: T0, payload: {} }])[0]) + '\n');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (server.exitCode !== null) return reject(new Error('server exited early'));
      http.get(BASE_URL + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); })
        .on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200));
    };
    setTimeout(poll, 400);
  });
}
async function settle(ticketIds, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = readRunsJson();
    const pending = runs.some(r => ticketIds.includes(r.ticketId) && ['pending', 'running'].includes(r.status));
    const everyHasRun = ticketIds.every(id => runs.some(r => r.ticketId === id));
    if (everyHasRun && !pending) return;
    await sleep(300);
  }
}

async function main() {
  seed();
  // Real scheduler ON so retried runs execute; no provider key in env.
  const env = { ...process.env, NODE_ENV: 'development', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '250' };
  delete env.OPENAI_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', c => { out += String(c); }); server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(login.statusCode === 302, 'login failed');
    const cookie = cookieFrom(login);

    // 17: startup did not auto-retry the pre-seeded failed run for ticket 7.
    await sleep(1500);
    assert(runsFor(7).length === 1, `startup must not auto-retry old failures (ticket 7 has ${runsFor(7).length} runs)`);

    // Trigger live runs for tickets 1-6 and 9 (completed → open creates a run).
    // Ticket 8 already has a seeded pending run (createRunsForTicket refuses triaged
    // tickets), which the scheduler picks up on its own.
    for (const id of [1, 2, 3, 4, 5, 6, 9]) {
      const r = await request('PATCH', `/api/tickets/${id}/status`, { cookie, json: { status: 'open' } });
      assert(r.statusCode === 200, `open ticket ${id} HTTP ${r.statusCode}`);
    }
    await settle([1, 2, 3, 4, 5, 6, 8, 9]);

    const reason = runs => (runs[runs.length - 1].triage || {}).reasonCode;

    // 1: default autoRetry false → exactly one failed run, triage, no retry.
    const t1 = runsFor(1);
    assert(t1.length === 1 && t1[0].status === 'failed', `T1 should have 1 failed run, got ${t1.length}`);
    assert(t1[0].triage && t1[0].triage.required === true, 'T1 failed run should be triaged');

    // 2: autoRetry true + maxAttempts null → no retry.
    const t2 = runsFor(2);
    assert(t2.length === 1 && t2[0].triage && t2[0].triage.required, 'T2 must not retry without a finite maxAttempts');

    // 3,4,5,6,7,8,15,16,18: bounded retry on runtime failure.
    const t3 = runsFor(3);
    assert(t3.length === 2, `T3 must produce exactly 2 runs (one retry), got ${t3.length}`); // 16: bounded, no infinite loop
    assert(t3[0].status === 'failed' && (t3[0].triage === null || t3[0].triage === undefined), 'T3 first failed run skips triage because a retry was created'); // 5
    assert(t3[0].error && /invalid|Unknown/.test(t3[0].error), 'T3 first run keeps its failure evidence'); // 4
    assert(t3[1].delegatedPermissionSource === 'auto_retry', 'T3 retry run records auto_retry actor'); // 7
    assert(t3[1].executionPolicySnapshot && t3[1].executionPolicySnapshot.autoRetry === true, 'T3 retry run snapshot includes autoRetry:true'); // 6
    assert(t3[1].status === 'failed' && t3[1].triage && t3[1].triage.required === true, 'T3 final (exhausted) run stops into triage'); // 15
    const autoLogs = readLogsJson().filter(l => l.type === 'ticket:auto_retry' && l.contextTicketId === 3);
    assert(autoLogs.length === 1, `T3 should record exactly one auto_retry audit entry, got ${autoLogs.length}`); // 8

    // 10: verification failure never retries.
    const t4 = runsFor(4);
    assert(t4.length === 1 && reason(t4) === 'verification_failed', `T4 verification failure must not retry (runs=${t4.length}, reason=${reason(t4)})`);

    // 14: provider failure never retries.
    const t5 = runsFor(5);
    assert(t5.length === 1 && reason(t5) === 'provider_failed', `T5 provider failure must not retry (runs=${t5.length}, reason=${reason(t5)})`);

    // 12: a run that mutated the workspace is never auto-retried.
    const t6 = runsFor(6);
    assert(t6.length === 1, `T6 mutating failure must not retry (runs=${t6.length})`);
    assert(t6[0].triage && t6[0].triage.required === true, 'T6 mutating failure must fall to triage');
    assert(fs.existsSync(path.join(WORKSPACE_ROOT, 'auto-retry-out.txt')), 'T6 should have mutated the workspace before failing (proving a mutated run is not retried)');

    // 18: the ONLY workspace entry is T6's deliberate mutation; auto-retry creation
    // (T3) and every other path wrote nothing to the workspace.
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === JSON.stringify(['auto-retry-out.txt']),
      'auto-retry run creation must not mutate the workspace (only T6 deliberate write present), got: ' + fs.readdirSync(WORKSPACE_ROOT).join(','));

    // 9 (exclusion): unresolved ticket-level triage blocks auto-retry.
    const t8 = runsFor(8);
    assert(t8.length === 1, `T8 ticket-triage must block auto-retry (no new run); got ${t8.length} runs`);
    assert(t8[0].id === 800 && t8[0].status === 'failed', 'T8 seeded run should run and fail (runtime_failed)');
    assert(reason(t8) === 'runtime_failed', `T8 run should be runtime_failed (otherwise retryable), got ${reason(t8)}`);
    assert(t8[0].triage && t8[0].triage.required === true, 'T8 failed run must persist run triage (no retry)');
    assert(readLogsJson().filter(l => l.type === 'ticket:auto_retry' && l.contextTicketId === 8).length === 0, 'T8 must not write a ticket:auto_retry log');

    // 11 (exclusion): authority/protected-path class never retries (no mutation).
    const t9 = runsFor(9);
    assert(t9.length === 1, `T9 authority/protected failure must not retry; got ${t9.length} runs`);
    assert(reason(t9) === 'authority_blocked', `T9 should classify as authority_blocked, got ${reason(t9)}`);
    assert(t9[0].triage && t9[0].triage.required === true, 'T9 failed run must persist run triage');
    assert(readLogsJson().filter(l => l.type === 'ticket:auto_retry' && l.contextTicketId === 9).length === 0, 'T9 must not write a ticket:auto_retry log');
    // T9 mutated nothing inside the workspace (escape write is blocked); the only entry
    // remains T6's deliberate file, re-asserting no spurious workspace writes.
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === JSON.stringify(['auto-retry-out.txt']),
      'T9 authority/protected failure must not mutate the workspace, got: ' + fs.readdirSync(WORKSPACE_ROOT).join(','));

    console.log('PASS: bounded automatic retry v1 — default-off, policy-gated, runtime-only, bounded, audited, no startup/provider/mutation retry');
    console.log('PASS: auto-retry exclusions — ticket-level triage, authority/protected-path');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (server) { server.kill('SIGTERM'); await sleep(500); if (server.exitCode === null) server.kill('SIGKILL'); }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

// Phase 2 (isolated server): the interrupt terminalization path must never auto-retry.
// interruptStaleRunsOnStartup runs BEFORE the scheduler starts and interrupts an
// event-less pending run via the SAME interruptAgentRun used by manual stop
// (POST /api/runs/:id/stop). That path does not call runAutoRetryAfterFailureIfPolicyAllows, so an
// autoRetry+finite-maxAttempts ticket whose run is interrupted gets no retry. This is
// the deterministic way to exercise interruptAgentRun (the scheduler's immediate first
// tick would otherwise start any parked run).
async function interruptPhase() {
  const PORT2 = '3507';
  const BASE2 = 'http://127.0.0.1:' + PORT2;
  const DD = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-retry-int-data-'));
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-retry-int-ws-'));
  const wj = (f, v) => fs.writeFileSync(path.join(DD, f), JSON.stringify(v, null, 2));
  let srv = null;

  const ready = (timeoutMs = 12000) => { const dl = Date.now() + timeoutMs; return new Promise((resolve, reject) => { const poll = () => { if (srv.exitCode !== null) return reject(new Error('server exited early')); http.get(BASE2 + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > dl ? reject(new Error('timeout')) : setTimeout(poll, 200)); }).on('error', () => Date.now() > dl ? reject(new Error('timeout')) : setTimeout(poll, 200)); }; setTimeout(poll, 400); }); };
  const runsJson = () => JSON.parse(fs.readFileSync(path.join(DD, 'runs.json'), 'utf8'));
  const logsJson = () => JSON.parse(fs.readFileSync(path.join(DD, 'logs.json'), 'utf8'));

  fs.mkdirSync(path.join(DD, 'replay-snapshots'), { recursive: true });
  wj('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  wj('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  wj('groups.json', [{ id: 1, name: 'Administrators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  wj('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  wj('agents.json', [{ id: 1, name: 'WF Agent', type: 'agent', provider: 'openai', model: 'gpt-x', apiKey: 'demo-key', createdAt: T0, updatedAt: T0 }]);
  wj('workflows.json', []);
  wj('allocation-plans.json', []); wj('operation-history.json', []); wj('logs.json', []); wj('protected-paths.json', []);
  wj('tickets.json', [ticket(10, 'manual stop never retries', { autoRetry: true, maxAttempts: 2 }, { status: 'in_progress' })]);
  wj('runs.json', [{
    id: 1000, ticketId: 10, agentId: 1, agentName: 'WF Agent', workspaceRoot: WS, mainWorkspaceRoot: WS, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], executionMode: 'agent',
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { autoRetry: true, maxAttempts: 2, requireVerification: 'when_declared' },
    currentPhase: 'initialization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status: 'pending', createdAt: T0, updatedAt: T0, replaySnapshotPath: 'replay-snapshots/run-1000.json'
  }]);
  fs.writeFileSync(path.join(DD, 'replay-snapshots', 'run-1000.json'), JSON.stringify({ runId: 1000, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }));
  // Event-less pending run: not safely resumable → interruptStaleRunsOnStartup
  // terminalizes it via interruptAgentRun before the scheduler can start it.
  fs.writeFileSync(path.join(DD, 'events.jsonl'), '');

  const env = { ...process.env, NODE_ENV: 'development', PORT: PORT2, DATA_DIR: DD, WORKSPACE_ROOT: WS, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' };
  delete env.OPENAI_API_KEY;
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; srv.stdout.on('data', c => { out += String(c); }); srv.stderr.on('data', c => { out += String(c); });

  try {
    await ready();
    // Startup stale-interrupt runs before listen(); give it a moment to settle.
    await sleep(1000);

    // 13: interrupt terminalization (same interruptAgentRun as manual stop) never retries.
    const t10 = runsJson().filter(r => r.ticketId === 10);
    assert(t10.length === 1, `interrupt must not create a retry run; got ${t10.length} runs`);
    assert(t10[0].status === 'interrupted', `run 1000 should be interrupted, got ${t10[0].status}`);
    assert(logsJson().filter(l => l.type === 'ticket:auto_retry').length === 0, 'interrupt must not write a ticket:auto_retry log');

    console.log('PASS: auto-retry exclusions — interrupted run never retries');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (srv) { srv.kill('SIGTERM'); await sleep(500); if (srv.exitCode === null) srv.kill('SIGKILL'); }
    fs.rmSync(DD, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

main()
  .then(interruptPhase)
  .catch(error => { console.error(error.stack || error.message); process.exit(1); });
