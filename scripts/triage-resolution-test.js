#!/usr/bin/env node
// Human triage resolution controls. An operator marks an existing REQUIRED triage
// record resolved/acknowledged with a note. This must NEVER rerun, complete, fail,
// retry, change status, or perform any allowedAction — it only annotates triage.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const PORT = '3495';
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
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-resolve-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-resolve-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function ticketTriage(id) { return readJsonData('tickets.json').find(t => t.id === id).triage; }
function runTriage(id) { return readJsonData('runs.json').find(r => r.id === id).triage; }
function ticketStatus(id) { return readJsonData('tickets.json').find(t => t.id === id).status; }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }
function events() {
  return fs.readFileSync(path.join(DATA_DIR, 'events.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const TICKET_TRIAGE = {
  required: true, reasonCode: 'authority_blocked', summary: 'Missing writable grants',
  requiredDecision: 'change_scope', evidenceRefs: ['event:ticket.blocked', 'ticket:feasibility'],
  allowedActions: ['review', 'edit_ticket'], prohibitedActions: ['start_run_without_scope_change'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};
const RUN_TRIAGE = {
  required: true, reasonCode: 'verification_failed', summary: 'Verification failed: 1 postcondition',
  requiredDecision: 'review_failure', evidenceRefs: ['event:run.verification_failed', 'replay:failure'],
  allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['mark_completed_without_verification'],
  createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
};

function ticket(id, status, triage) {
  return {
    id, objective: `Triage ticket #${id}`,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status, triage: triage || undefined,
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0
  };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'Triage Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }]);
  writeJson('workflows.json', [{ id: 'wf-v', name: 'Verified workflow', version: '1', inputSchema: {}, actions: [{ id: 'done', action: 'stop', input: {} }], postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }] }]);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', [
    ticket(1, 'blocked', { ...TICKET_TRIAGE }),  // ticket-level triage to resolve
    ticket(2, 'failed', null),                    // hosts a FAILED run with run-level triage
    ticket(4, 'open', null),                      // no triage → 409
    // completed workflow run, verification REQUIRED but not passed, plus run triage:
    ticket(5, 'in_progress', null)
  ]);
  writeJson('runs.json', [
    {
      id: 20, ticketId: 2, agentId: 1, agentName: 'Triage Agent',
      workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
      allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
      executionMode: 'agent', workflowId: null, workflowInput: null,
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
      executionPolicySnapshot: { requireVerification: 'when_declared' },
      runtimeLimitsSnapshot: { maxExecutionSteps: 10, maxModelRequestsPerRun: 10, maxWorkspaceOperationsPerRun: 50, maxRuntimeDurationMs: 600000, source: null },
      currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
      currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
      status: 'failed', error: 'boom', triage: { ...RUN_TRIAGE },
      createdAt: T0, updatedAt: T0, startedAt: T0, completedAt: T0,
      replaySnapshotPath: 'replay-snapshots/run-20.json'
    },
    {
      id: 50, ticketId: 5, agentId: 1, agentName: 'Triage Agent',
      workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
      allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
      executionMode: 'workflow', workflowId: 'wf-v', capabilityType: 'workflow', capabilityId: 'wf-v', workflowInput: {},
      executionPolicySnapshot: { requireVerification: 'when_declared' },
      runtimeLimitsSnapshot: { maxExecutionSteps: 10, maxModelRequestsPerRun: 10, maxWorkspaceOperationsPerRun: 50, maxRuntimeDurationMs: 600000, source: null },
      verificationContractSnapshot: { workflowId: 'wf-v', workflowName: 'Verified workflow', workflowVersion: '1', postconditions: [{ id: 'pc', type: 'fileExists', path: 'out.txt' }], verifierContract: null, capturedAt: T0 },
      runEvaluation: { effectiveness: { status: 'unknown' }, efficiency: { durationMs: 100, providerRequests: 1, modelResponses: 1, workspaceOperations: 1, mutationCount: 0, retryCount: 0 }, violations: { status: 'unknown', items: [] }, effectiveRuntimeConfig: null },
      currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
      currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
      status: 'completed', triage: { ...RUN_TRIAGE },
      createdAt: T0, updatedAt: T0, startedAt: T0, completedAt: T0,
      replaySnapshotPath: 'replay-snapshots/run-50.json'
    }
  ]);
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-20.json'), JSON.stringify({ runId: 20, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }));
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-50.json'), JSON.stringify({ runId: 50, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }));
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
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
async function loginAs(username) {
  const res = await request('POST', '/login', { form: { username, password: 'admin123' } });
  assert(res.statusCode === 302, `login ${username} failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}
const resolveTicket = (id, resolution, cookie) => request('POST', `/api/tickets/${id}/triage/resolve`, { cookie, json: { resolution } });
const resolveRun = (id, resolution, cookie) => request('POST', `/api/runs/${id}/triage/resolve`, { cookie, json: { resolution } });
const completeTicket = (id, cookie) => request('PATCH', `/api/tickets/${id}/status`, { cookie, json: { status: 'completed' } });
const errorOf = res => { try { return JSON.parse(res.body).error || ''; } catch (_) { return ''; } };
const sameArr = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const cookie = await loginAs('admin');

    // 12 (unresolved UI): required triage renders read-only with a link to the
    // Inbox (the only resolve surface); the page itself has no resolve input.
    const t1PageBefore = await request('GET', '/tickets/1', { cookie });
    assert(t1PageBefore.body.includes('Ticket-Level Triage'), 'unresolved ticket triage should render');
    assert(t1PageBefore.body.includes('Respond in Inbox'), 'authorized user should see the inbox link');
    assert(!t1PageBefore.body.includes('triage-resolve'), 'ticket page must not embed a resolve control');
    assert(!t1PageBefore.body.includes('Ticket-Level Triage (resolved)'), 'unresolved triage must not show resolved state');

    // 5: blank resolution rejected without mutation.
    const blank = await resolveTicket(1, '   ', cookie);
    assert(blank.statusCode === 400, `blank resolution must be 400, got ${blank.statusCode}`);
    assert(ticketTriage(1).required === true, 'blank resolution must not mutate triage');

    // 6: unauthorized user → 403, nothing changes.
    const viewer = await loginAs('viewer');
    const denied = await resolveTicket(1, 'looks fine', viewer);
    assert(denied.statusCode === 403, `unauthorized resolve must be 403, got ${denied.statusCode}`);
    assert(ticketTriage(1).required === true, 'unauthorized resolve must not mutate triage');

    // 409: nothing-to-resolve cases.
    assert((await resolveTicket(4, 'n/a', cookie)).statusCode === 409, 'ticket without required triage → 409');

    // 1 + 3 + 4 + 8 + 10: resolve ticket-level triage.
    const before1 = ticketTriage(1);
    const r1 = await resolveTicket(1, 'Granted scope manually; acknowledged.', cookie);
    assert(r1.statusCode === 200, `ticket triage resolve should succeed, got ${r1.statusCode}: ${r1.body}`);
    const after1 = ticketTriage(1);
    assert(after1.required === false, 'resolved triage required must be false');
    assert(after1.resolvedAt && after1.resolvedBy === 'admin' && after1.resolution === 'Granted scope manually; acknowledged.', 'resolution fields must be set');
    assert(after1.reasonCode === before1.reasonCode && after1.summary === before1.summary && after1.requiredDecision === before1.requiredDecision, 'reason/summary/decision preserved');
    assert(sameArr(after1.evidenceRefs, before1.evidenceRefs) && sameArr(after1.allowedActions, before1.allowedActions) && sameArr(after1.prohibitedActions, before1.prohibitedActions), 'evidence/allowed/prohibited preserved');
    assert(ticketStatus(1) === 'blocked', 'resolving must not change ticket status (no completion)');
    assert(runsForTicket(1).length === 0, 'resolving ticket triage must not create a run');
    assert(events().filter(event => event.type === 'ticket.triage_resolved' && event.ticketId === 1).length === 1,
      'ticket resolution must append exactly one authoritative event');
    const ticketTimeline = JSON.parse((await request('GET', '/api/tickets/1/timeline', { cookie })).body);
    const ticketResolutionTimeline = ticketTimeline.entries.find(entry =>
      entry.type === 'triage.resolved' && entry.sourceRole === 'live_state'
    );
    assert(ticketResolutionTimeline, 'ticket resolution must appear as authoritative live state in the timeline');
    assert((ticketResolutionTimeline.details.supportingSourceRefs || []).some(ref => ref.startsWith('events.jsonl:')),
      'ticket resolution timeline state must retain its append-only supporting event');

    // 12 (resolved UI): now renders resolved state truthfully.
    const t1PageAfter = await request('GET', '/tickets/1', { cookie });
    assert(t1PageAfter.body.includes('Ticket-Level Triage (resolved)'), 'resolved ticket triage should render resolved state');
    assert(t1PageAfter.body.includes('Granted scope manually; acknowledged.'), 'resolved state should show the resolution note');

    // 2 + 3 + 4 + 7 + 9 + 11: resolve run-level triage.
    const before20 = runTriage(20);
    const r20 = await resolveRun(20, 'Reviewed failure; no rerun needed.', cookie);
    assert(r20.statusCode === 200, `run triage resolve should succeed, got ${r20.statusCode}: ${r20.body}`);
    const after20 = runTriage(20);
    assert(after20.required === false && after20.resolvedBy === 'admin' && after20.resolution === 'Reviewed failure; no rerun needed.', 'run triage resolution fields set');
    assert(after20.reasonCode === before20.reasonCode && sameArr(after20.allowedActions, before20.allowedActions) && sameArr(after20.prohibitedActions, before20.prohibitedActions), 'run triage original fields preserved');
    assert(readJsonData('runs.json').find(r => r.id === 20).status === 'failed', 'resolving must not change run status');
    assert(ticketStatus(2) === 'failed', 'resolving run triage must not change ticket status');
    assert(runsForTicket(2).length === 1, 'resolving run triage must not create/rerun a run (allowedActions not auto-performed)');
    assert(events().filter(event => event.type === 'run.triage_resolved' && event.runId === 20).length === 1,
      'run resolution must append exactly one authoritative event');
    const runTimeline = JSON.parse((await request('GET', '/api/tickets/2/timeline', { cookie })).body);
    const runResolutionTimeline = runTimeline.entries.find(entry =>
      entry.type === 'triage.resolved' && entry.runId === 20 && entry.sourceRole === 'live_state'
    );
    assert(runResolutionTimeline, 'run resolution must appear as authoritative live state in the timeline');
    assert((runResolutionTimeline.details.supportingSourceRefs || []).some(ref => ref.startsWith('events.jsonl:')),
      'run resolution timeline state must retain its append-only supporting event');

    // run-detail renders resolved triage.
    const run20Page = await request('GET', '/runs/20', { cookie });
    assert(run20Page.body.includes('Triage (resolved)'), 'run detail should render resolved triage');
    assert(!run20Page.body.includes('<h2>Triage Required</h2>'), 'resolved run triage must not still say Triage Required');

    // 409: resolving an already-resolved run triage.
    assert((await resolveRun(20, 'again', cookie)).statusCode === 409, 'already-resolved run triage → 409');
    assert(events().filter(event => event.type === 'run.triage_resolved' && event.runId === 20).length === 1,
      'a repeated resolution must not append another event');

    // Completion-gate coverage: resolving run triage must NOT make a failed run
    // completable — the status gate still rejects (not the now-resolved triage gate).
    const complete2 = await completeTicket(2, cookie);
    assert(complete2.statusCode === 409, `completing a failed-run ticket must be rejected, got HTTP ${complete2.statusCode}`);
    assert(errorOf(complete2).includes('latest run is failed'), `rejection must be the status gate, got: ${errorOf(complete2)}`);
    assert(!errorOf(complete2).includes('requires triage'), 'rejection must NOT cite the (now resolved) triage gate');
    assert(ticketStatus(2) === 'failed', 'failed-run ticket must not become completed');
    assert(readJsonData('runs.json').find(r => r.id === 20).status === 'failed', 'run 20 status must not change on completion attempt');
    assert(runsForTicket(2).length === 1, 'completion attempt must create no run');

    // And a verification-required-but-not-passed COMPLETED run: resolve its triage,
    // then the verification gate must still block completion (not the triage gate).
    assert((await resolveRun(50, 'Acknowledged; verification still pending.', cookie)).statusCode === 200, 'resolve run 50 triage should succeed');
    assert(runTriage(50).required === false, 'run 50 triage should be resolved');
    const complete5 = await completeTicket(5, cookie);
    assert(complete5.statusCode === 409, `completing a verification-required-unverified ticket must be rejected, got HTTP ${complete5.statusCode}`);
    assert(errorOf(complete5).includes('no verified objective-success evidence'), `rejection must be the verification gate, got: ${errorOf(complete5)}`);
    assert(!errorOf(complete5).includes('requires triage'), 'rejection must NOT cite the (now resolved) triage gate');
    assert(ticketStatus(5) !== 'completed', 'verification-required-unverified ticket must not become completed');
    assert(readJsonData('runs.json').find(r => r.id === 50).status === 'completed', 'run 50 status must not change on completion attempt');
    assert(runsForTicket(5).length === 1, 'completion attempt must create no run');

    console.log('PASS: human triage resolution annotates only — no rerun, completion, status change, or autonomy');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(400);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
