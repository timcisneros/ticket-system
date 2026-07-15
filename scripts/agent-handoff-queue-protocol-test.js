#!/usr/bin/env node
// Agent handoff/queue protocol (r1.23). Formalizes claim/work/handoff receipts over the EXISTING
// ticket, run, lease, evidence, triage, timeline, and Work Context primitives. Proves:
//   - a Claim Receipt is derivable from the existing run lease (and carries it on lease_acquired);
//   - a Work Receipt is derived from existing evidence, with NO file contents or provider bodies;
//   - a handoff creates an ORDINARY ticket through the normal authorized path (no bypass), with a
//     Handoff Receipt on provenance; the recipient claims normally;
//   - ambiguous work becomes triage/blocked rather than guessed; resolution doesn't rewrite history;
//   - the timeline shows claim, work receipt, and handoff receipt; no hidden work, no new ledger.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3494';
const BASE_URL = 'http://127.0.0.1:' + PORT;
const SECRET_CONTENT = 'TOP-SECRET-FILE-BODY-9c1f';
const PROVIDER_BODY = 'PROVIDER-RESPONSE-BODY-deadbeef';

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
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ statusCode: res.statusCode, headers: res.headers, body: raw, json }); }); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function runs() { return readJsonData('runs.json'); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

function baseTicket(id, objective, extra) {
  return { id, objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
      allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
    },
    workTypeSnapshot: null, workTypeId: null, triage: null,
    status: 'completed', createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO, ...extra };
}
// A CLAIMED, terminal run with rich evidence (lease + triage + replay with secret content/provider body).
function claimedRun(id, ticketId, extra) {
  return { id, ticketId, agentId: 1, agentName: 'Planner', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], allocationSubtask: null,
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
      allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
    },
    runtimeLimitsSnapshot: null, verificationContractSnapshot: null, workTypeSnapshot: null, workTypeId: null,
    currentPhase: 'terminalization', leaseOwner: 'proc-test-owner', leaseExpiresAt: '2030-01-01T00:00:00.000Z', currentStepId: null, currentWorkflowAction: null,
    lastHeartbeatAt: ISO, status: 'completed', createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO,
    replaySnapshotPath: `replay-snapshots/run-${id}.json`, replaySummary: null, runConsequence: null, triage: null,
    runEvaluation: { effectiveness: { status: 'passed', postconditionsPassed: 1, postconditionsFailed: 0, errors: [] }, efficiency: { durationMs: 100, providerRequests: 1, modelResponses: 1, workspaceOperations: 1, mutationCount: 1, retryCount: 0 }, violations: { status: 'none', items: [] } }, ...extra };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage'], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  writeJson('agents.json', [
    { id: 1, name: 'Planner', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO },
    { id: 2, name: 'Executor', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }
  ]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('logs.json', []);
  writeJson('operation-history.json', [
    { id: 1, ticketId: 10, runId: 100, operation: 'writeFile', path: 'out/report.md', createdAt: ISO }
  ]);
  // Work Context: 1 active, 2 archived.
  writeJson('work-contexts.json', [
    { id: 1, name: 'Legal Ops', purpose: 'legal', status: 'active', defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO },
    { id: 2, name: 'Archived', purpose: 'old', status: 'archived', defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO }
  ]);
  writeJson('tickets.json', [
    baseTicket(10, 'source ticket in legal ops', { workContextId: 1, workContextSnapshot: { id: 1, name: 'Legal Ops', purpose: 'legal', status: 'active' } })
  ]);
  writeJson('runs.json', [claimedRun(100, 10)]);
  // Replay snapshot intentionally carries file content + provider body — the work receipt must NOT leak these.
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-100.json'), JSON.stringify({
    runId: 100, providerRequests: [{ body: PROVIDER_BODY }], modelResponses: [{ content: PROVIDER_BODY }],
    workspaceOperations: [{ operation: 'writeFile', path: 'out/report.md', content: SECRET_CONTENT }], events: []
  }, null, 2));
  writeJson('process-template-triggers.json', []); writeJson('process-templates.json', []); writeJson('process-template-versions.json', []);
  // Seed a lease_acquired event so the timeline shows the claim (mirrors live acquireRunLease shape).
  const ev = { id: 'ev-claim-100', ts: ISO, type: 'run.lease_acquired', ticketId: 10, runId: 100, stepId: null, seq: 0, prevHash: null, payload: { leaseOwner: 'proc-test-owner', leaseExpiresAt: '2030-01-01T00:00:00.000Z', claimReceipt: { receiptKind: 'claim_receipt', ticketId: 10, runId: 100 } } };
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), JSON.stringify(sealCurrentRunEventChains([ev])[0]) + '\n');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => { if (server.exitCode !== null) return reject(new Error('server exited early')); http.get(BASE_URL + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); }).on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); };
    setTimeout(poll, 400);
  });
}
async function loginAs(u) { const res = await request('POST', '/login', { form: { username: u, password: 'admin123' } }); assert(res.statusCode === 302, `login ${u} ${res.statusCode}`); return cookieFrom(res); }
function newestTicketId() { return tickets().reduce((m, t) => Math.max(m, t.id), 0); }

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; server.stdout.on('data', c => { out += String(c); }); server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const admin = await loginAs('admin');
    const viewer = await loginAs('viewer');

    const beforeTickets = readRaw('tickets.json');
    const beforeRuns = readRaw('runs.json');
    const beforeHistory = readRaw('operation-history.json');
    const wsStart = ws();

    // ---- 1: Claim Receipt is derivable from the existing lease; contains required fields. ----
    const claim = await request('GET', '/api/runs/100/claim-receipt', { cookie: admin });
    assert(claim.statusCode === 200 && claim.json.ok, 'claim-receipt endpoint ok');
    const cr = claim.json.claimReceipt;
    assert(cr.ticketId === 10 && cr.runId === 100 && cr.actorAgentId === 1, 'claim receipt carries ticketId/runId/actor');
    assert(cr.leaseOwner === 'proc-test-owner' && cr.leaseExpiresAt === '2030-01-01T00:00:00.000Z', 'claim receipt carries the lease window');
    assert(cr.workContextId === 1 && cr.claimSource === 'run_lease', 'claim receipt carries workContextId + claim source');
    // Claiming/reading produces no target or workspace mutation.
    assert(readRaw('operation-history.json') === beforeHistory && ws() === wsStart, 'claim/read creates no target or workspace mutation');

    // ---- 2: Work Receipt derived from existing evidence; NO file contents or provider bodies. ----
    const wr = await request('GET', '/api/runs/100/work-receipt', { cookie: admin });
    assert(wr.statusCode === 200 && wr.json.ok, 'work-receipt endpoint ok');
    const w = wr.json.workReceipt;
    assert(w.runId === 100 && w.ticketId === 10 && w.status === 'completed', 'work receipt identifies run/ticket/status');
    assert(Array.isArray(w.targetOperationsPerformed) && w.targetOperationsPerformed.some(op => op.path === 'out/report.md'), 'work receipt lists target operations (paths only)');
    assert(w.verification.result === 'passed' && w.authorityDecisions, 'work receipt carries verification result + authority decisions');
    const wrText = JSON.stringify(w);
    assert(!wrText.includes(SECRET_CONTENT), 'work receipt omits full file contents');
    assert(!wrText.includes(PROVIDER_BODY), 'work receipt omits provider response bodies');

    // ---- 3: Handoff creates an ORDINARY ticket through normal ticket creation, with a receipt. ----
    const handoff = await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: {
      objective: 'Prepare the legal packet from the report', toAssignmentTargetType: 'agent', toAssignmentTargetId: 2,
      constraints: 'read-only review', stopCondition: 'stop if packet template missing', receiptExpectation: 'work_receipt',
      sourceRefs: ['tickets.json:10', 'runs.json:100'], evidenceRefs: ['operation-history.json:1']
    } });
    assert(handoff.statusCode === 200 && handoff.json.ok, 'handoff ok: ' + handoff.body);
    const newId = handoff.json.createdTicketId;
    const newTicket = tickets().find(t => t.id === newId);
    assert(newTicket && newTicket.status !== undefined, 'handoff created an ordinary ticket');
    assert(newTicket.source && newTicket.source.type === 'handoff', 'new ticket carries handoff provenance');
    const hs = newTicket.source;
    assert(hs.fromTicketId === 10 && hs.fromRunId === 100 && hs.fromActor === 'admin', 'handoff receipt carries from-ticket/run/actor');
    assert(hs.toAssignee.type === 'agent' && hs.toAssignee.id === 2, 'handoff receipt carries recipient');
    assert(hs.workContextId === 1, 'handoff inherits Work Context scope');
    assert(Array.isArray(hs.sourceRefs) && hs.sourceRefs.includes('runs.json:100') && Array.isArray(hs.evidenceRefs) && hs.evidenceRefs.includes('operation-history.json:1'), 'handoff carries source + evidence refs');
    assert(hs.constraints === 'read-only review' && hs.stopCondition && hs.receiptExpectation === 'work_receipt' && hs.status === 'created', 'handoff carries constraints/stop-condition/receipt-expectation/status');
    // Recipient must claim normally: the new ticket got a normal pending run (no special privilege).
    const newRuns = runs().filter(r => r.ticketId === newId);
    assert(newRuns.length === 1 && newRuns[0].status === 'pending' && newRuns[0].leaseOwner == null, 'recipient ticket has a normal pending run to be claimed normally (no pre-granted lease)');
    // Handoff did not widen authority: executionPolicy is the normal default, not elevated.
    assert(newTicket.executionPolicy && newTicket.executionPolicy.allowChildTickets !== true, 'handoff does not widen authority (no child-ticket grant)');

    // ---- 4: Handoff does not bypass permissions / Work Context scope. ----
    assert((await request('POST', '/api/tickets/10/handoff', { cookie: viewer, json: { objective: 'x', toAssignmentTargetId: 2 } })).statusCode === 403, 'handoff requires ticket:create (no permission bypass)');
    const archHandoff = await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: { objective: 'into archived', toAssignmentTargetId: 2, workContextId: 2 } });
    assert(archHandoff.statusCode === 400, 'handoff into an archived Work Context is rejected (no scope bypass)');

    // ---- 5: Ambiguous work becomes triage/blocked rather than guessed. ----
    const ambHandoff = await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: { objective: 'Create 3 folders each named Michael Jackson songs', toAssignmentTargetId: 2 } });
    assert(ambHandoff.statusCode === 200, 'ambiguous handoff still creates a ticket');
    const ambTicket = tickets().find(t => t.id === ambHandoff.json.createdTicketId);
    assert(ambTicket.status === 'blocked' && ambTicket.triage && ambTicket.triage.reasonCode === 'objective_ambiguous', 'ambiguous handoff is blocked via the existing gate, not guessed');
    assert(runs().filter(r => r.ticketId === ambTicket.id).length === 0, 'ambiguous handoff ticket creates no run (no guessing)');

    // ---- 6: Human resolution does not rewrite history. ----
    const ambSourceBefore = JSON.stringify(ambTicket.source);
    const eventsBefore = readRaw('events.jsonl');
    await request('POST', `/api/tickets/${ambTicket.id}/triage/resolve`, { cookie: admin, json: { resolution: 'clarified: skip' } }).catch(() => ({}));
    assert(JSON.stringify(tickets().find(t => t.id === ambTicket.id).source) === ambSourceBefore, 'triage resolution does not rewrite the handoff provenance');
    assert(readRaw('events.jsonl').startsWith(eventsBefore.slice(0, 40)), 'triage resolution does not rewrite prior events (append-only)');

    // ---- 7: Timeline shows claim, work receipt, and handoff receipt. ----
    const tl10 = await request('GET', '/api/tickets/10/timeline', { cookie: admin });
    assert(tl10.statusCode === 200, 'source ticket timeline ok');
    assert(tl10.json.entries.some(e => e.type === 'run.lease_acquired'), 'timeline shows the claim (lease acquired)');
    assert(tl10.json.entries.some(e => e.type === 'run.work_receipt' && e.runId === 100), 'timeline shows the work receipt');
    const tlNew = await request('GET', `/api/tickets/${newId}/timeline`, { cookie: admin });
    assert(tlNew.json.entries.some(e => e.type === 'ticket.handoff' && e.details.fromTicketId === 10), 'timeline shows the handoff receipt on the created ticket');
    // Timeline still leaks no file content / provider body.
    assert(!tl10.body.includes(SECRET_CONTENT) && !tl10.body.includes(PROVIDER_BODY), 'timeline leaks no file content or provider body');

    // ---- 8: No hidden work, no private channel, no new ledger, source ticket/run untouched. ----
    assert(JSON.stringify(tickets().find(t => t.id === 10)) === JSON.stringify(JSON.parse(beforeTickets).find(t => t.id === 10)), 'source ticket #10 is not rewritten');
    assert(readRaw('runs.json').includes('"id": 100'), 'source run #100 preserved');
    const files = fs.readdirSync(DATA_DIR);
    assert(!files.some(f => /handoff-ledger|claim-ledger|work-receipt|timeline/i.test(f)), 'no new handoff/claim/work-receipt/timeline ledger file is created');
    // Every created handoff is a visible ordinary ticket (no hidden work).
    assert(tickets().filter(t => t.source && t.source.type === 'handoff').length === 2, 'each handoff is a visible ordinary ticket (2 created: packet + ambiguous)');

    console.log('PASS: agent handoff queue protocol — claim/work/handoff receipts over existing primitives; normal ticket creation, no authority bypass, ambiguity→triage, no hidden work, no new ledger');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (server) { server.kill('SIGTERM'); await sleep(400); if (server.exitCode === null) server.kill('SIGKILL'); }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
