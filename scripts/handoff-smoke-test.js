#!/usr/bin/env node
// Handoff queue smoke test (r1.24). End-to-end, deterministic, no-provider proof of the full
// human/agent handoff queue loop over the existing r1.23 protocol:
//
//   request → ticket → claim → claim receipt → work → work receipt → ambiguity becomes triage
//   → human resolves on the same ticket → resume needs normal run/rerun → agent proposes handoff
//   → handoff creates a normal ticket with source/evidence refs → recipient claims normally
//   → timeline shows the chain → Work Context visibility reflects it → no hidden work / no new ledger.
//
// It is validation/demo hardening only: it adds no runtime behavior and seeds terminal evidence
// (the established no-provider pattern). The fixtures are TEST/DEMO ONLY — in the real product a
// business connects its own drives/data; these are not final product seed data.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { sealCurrentRunEventChains } = require('./current-event-fixture');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3493';
const BASE_URL = 'http://127.0.0.1:' + PORT;
const SECRET_CONTENT = 'TOP-SECRET-FILE-BODY-smoke-7f3a';
const PROVIDER_BODY = 'PROVIDER-RESPONSE-BODY-smoke-bead';

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-smoke-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-smoke-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function runs() { return readJsonData('runs.json'); }
function dataFiles() { return fs.readdirSync(DATA_DIR).sort().join(','); }
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
const TRIAGE = { required: true, reasonCode: 'authority_blocked', summary: 'needs review', requiredDecision: 'change_scope', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
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
    runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(), verificationContractSnapshot: null, workTypeSnapshot: null, workTypeId: null,
    currentPhase: 'terminalization', leaseOwner: 'smoke-owner', leaseExpiresAt: '2030-01-01T00:00:00.000Z', currentStepId: null, currentWorkflowAction: null,
    lastHeartbeatAt: ISO, status: 'completed', createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO,
    replaySnapshotPath: `replay-snapshots/run-${id}.json`, replaySummary: null, runConsequence: null, triage: null,
    runEvaluation: { effectiveness: { status: 'passed', postconditionsPassed: 1, postconditionsFailed: 0, errors: [] }, efficiency: { durationMs: 100, providerRequests: 1, modelResponses: 1, workspaceOperations: 1, mutationCount: 1, retryCount: 0 }, violations: { status: 'none', items: [] } }, ...extra };
}
function ctx(id, name, status) {
  return { id, name, purpose: name + ' work', status, defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'processTemplate:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'processTemplate:manage'], canReceiveTickets: false },
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
  writeJson('operation-history.json', [{ id: 1, ticketId: 10, runId: 100, operation: 'writeFile', path: 'out/report.md', createdAt: ISO }]);
  writeJson('work-contexts.json', [ctx(1, 'Legal Ops', 'active'), ctx(2, 'Archived', 'archived')]);
  const wcSnap = { id: 1, name: 'Legal Ops', purpose: 'Legal Ops work', status: 'active' };
  writeJson('tickets.json', [
    baseTicket(10, 'source ticket in legal ops', { workContextId: 1, workContextSnapshot: wcSnap }),
    baseTicket(11, 'uncontexted blocked ticket', { status: 'blocked', triage: { ...TRIAGE } })
  ]);
  writeJson('runs.json', [claimedRun(100, 10)]);
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-100.json'), JSON.stringify({
    runId: 100, providerRequests: [{ body: PROVIDER_BODY }], modelResponses: [{ content: PROVIDER_BODY }],
    workspaceOperations: [{ operation: 'writeFile', path: 'out/report.md', content: SECRET_CONTENT }], events: []
  }, null, 2));
  writeJson('process-templates.json', []); writeJson('process-template-triggers.json', []); writeJson('process-template-versions.json', []);
  const ev = { id: 'ev-claim-100', ts: ISO, type: 'run.lease_acquired', ticketId: 10, runId: 100, stepId: null, seq: 0, prevHash: null, payload: { leaseOwner: 'smoke-owner', leaseExpiresAt: '2030-01-01T00:00:00.000Z', claimReceipt: { receiptKind: 'claim_receipt', ticketId: 10, runId: 100 } } };
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

    // Digests for the no-hidden-state proof (Scenario 5).
    const filesBefore = dataFiles();
    const wsBefore = ws();
    const ticket10Before = JSON.stringify(tickets().find(t => t.id === 10));
    const run100Before = JSON.stringify(runs().find(r => r.id === 100));
    const wcStoreBefore = readRaw('work-contexts.json');
    const ptBefore = readRaw('process-templates.json');
    const ptTriggersBefore = readRaw('process-template-triggers.json');
    const ptVersionsBefore = readRaw('process-template-versions.json');
    const eventsBefore = readRaw('events.jsonl');

    // ===== Scenario 1 — basic claim / work / receipt loop =====
    const claim = await request('GET', '/api/runs/100/claim-receipt', { cookie: admin });
    assert(claim.statusCode === 200 && claim.json.claimReceipt.ticketId === 10 && claim.json.claimReceipt.runId === 100, 'S1: claim receipt is visible/derivable');
    assert(claim.json.claimReceipt.leaseOwner === 'smoke-owner' && claim.json.claimReceipt.workContextId === 1 && claim.json.claimReceipt.claimSource === 'run_lease', 'S1: claim receipt carries lease + work context + source');
    const work = await request('GET', '/api/runs/100/work-receipt', { cookie: admin });
    assert(work.statusCode === 200 && work.json.workReceipt.runId === 100 && work.json.workReceipt.verification.result === 'passed', 'S1: work receipt is derived from existing evidence');
    const wrText = JSON.stringify(work.json.workReceipt);
    assert(!wrText.includes(SECRET_CONTENT) && !wrText.includes(PROVIDER_BODY), 'S1: work receipt exposes no file contents or provider bodies');
    const tl10 = await request('GET', '/api/tickets/10/timeline', { cookie: admin });
    assert(tl10.json.entries.some(e => e.type === 'run.lease_acquired') && tl10.json.entries.some(e => e.type === 'run.work_receipt'), 'S1: timeline shows claim + work receipt');
    assert(!tl10.body.includes(SECRET_CONTENT) && !tl10.body.includes(PROVIDER_BODY), 'S1: timeline leaks no content/provider body');
    assert(ws() === wsBefore, 'S1: no workspace mutation from read-only receipt/timeline surfaces');

    // ===== Scenario 2 — ambiguity stops as triage/needs-input (no guessing) =====
    const amb = await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: { objective: 'Create 3 folders each named Michael Jackson songs', toAssignmentTargetId: 2 } });
    assert(amb.statusCode === 200, 'S2: ambiguous handoff still creates a ticket');
    const ambId = amb.json.createdTicketId;
    const ambTicket = tickets().find(t => t.id === ambId);
    assert(ambTicket.status === 'blocked' && ambTicket.triage && ambTicket.triage.reasonCode === 'objective_ambiguous', 'S2: ambiguity is blocked/triaged, not guessed');
    assert(ambTicket.triage.requiredDecision === 'clarify_objective', 'S2: exact required decision is recorded');
    assert(runs().filter(r => r.ticketId === ambId).length === 0, 'S2: no run created for the ambiguous ticket (no guessing)');
    const ambEventsBefore = readRaw('events.jsonl');
    const ambSourceBefore = JSON.stringify(ambTicket.source);
    const resolve = await request('POST', `/api/tickets/${ambId}/triage/resolve`, { cookie: admin, json: { resolution: 'Clarified offline; will recreate with explicit names.' } });
    assert(resolve.statusCode === 200, 'S2: triage resolves through the normal path: ' + resolve.body);
    const ambAfter = tickets().find(t => t.id === ambId);
    assert(ambAfter.triage.required === false && ambAfter.triage.resolvedAt && ambAfter.triage.resolution, 'S2: resolution annotates the same ticket');
    assert(JSON.stringify(ambAfter.source) === ambSourceBefore, 'S2: resolution does not rewrite handoff provenance');
    assert(readRaw('events.jsonl').startsWith(ambEventsBefore.slice(0, 60)), 'S2: resolution does not rewrite prior events (append-only)');
    assert(runs().filter(r => r.ticketId === ambId).length === 0, 'S2: resolution alone creates no run/auto-run (resume needs normal run/rerun)');

    // ===== Scenario 3 — agent-to-agent handoff through normal ticket creation =====
    const ho = await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: {
      objective: 'Prepare the legal packet from the report', toAssignmentTargetType: 'agent', toAssignmentTargetId: 2,
      constraints: 'read-only review', authorityLimits: 'no deletes', stopCondition: 'stop if packet template missing', receiptExpectation: 'work_receipt',
      sourceRefs: ['tickets.json:10', 'runs.json:100'], evidenceRefs: ['operation-history.json:1']
    } });
    assert(ho.statusCode === 200, 'S3: handoff ok');
    const newId = ho.json.createdTicketId;
    const newTicket = tickets().find(t => t.id === newId);
    assert(newTicket && newTicket.source && newTicket.source.type === 'handoff', 'S3: handoff created an ordinary ticket with handoff provenance');
    const hs = newTicket.source;
    assert(hs.fromTicketId === 10 && hs.fromRunId === 100 && hs.fromActor === 'admin' && hs.toAssignee.id === 2, 'S3: handoff receipt carries from/to');
    assert(hs.sourceRefs.includes('runs.json:100') && hs.evidenceRefs.includes('operation-history.json:1'), 'S3: handoff carries source + evidence refs');
    assert(hs.constraints === 'read-only review' && hs.authorityLimits === 'no deletes' && hs.stopCondition && hs.receiptExpectation === 'work_receipt', 'S3: handoff carries constraints/authority-limits/stop-condition/receipt-expectation');
    const newRuns = runs().filter(r => r.ticketId === newId);
    assert(newRuns.length === 1 && newRuns[0].status === 'pending' && newRuns[0].leaseOwner == null, 'S3: recipient ticket is NOT secretly claimed — it has a normal pending run to claim');
    assert(newTicket.executionPolicy && newTicket.executionPolicy.allowChildTickets !== true, 'S3: handoff does not widen authority');
    assert((await request('POST', '/api/tickets/10/handoff', { cookie: viewer, json: { objective: 'x', toAssignmentTargetId: 2 } })).statusCode === 403, 'S3: handoff respects ticket:create (no permission bypass)');
    assert((await request('POST', '/api/tickets/10/handoff', { cookie: admin, json: { objective: 'into archived', toAssignmentTargetId: 2, workContextId: 2 } })).statusCode === 400, 'S3: handoff into archived Work Context rejected (no scope bypass)');
    const tlNew = await request('GET', `/api/tickets/${newId}/timeline`, { cookie: admin });
    assert(tlNew.json.entries.some(e => e.type === 'ticket.handoff' && e.details.fromTicketId === 10), 'S3: created-ticket timeline shows handoff provenance');

    // ===== Scenario 4 — Work Context visibility after handoff =====
    const summary = await request('GET', '/api/work-contexts/1/summary', { cookie: admin });
    const summaryIds = summary.json.tickets.map(t => t.id);
    assert(summary.statusCode === 200 && summaryIds.includes(10) && summaryIds.includes(newId) && summaryIds.includes(ambId), 'S4: Work Context summary includes source + handoff-created tickets');
    const ftk = await request('GET', '/tickets?workContextId=1', { cookie: admin });
    assert(ftk.body.includes('Prepare the legal packet from the report') && !ftk.body.includes('uncontexted blocked ticket'), 'S4: /tickets?workContextId filters to context');
    const ftr = await request('GET', '/inbox?workContextId=1', { cookie: admin });
    assert(!ftr.body.includes('"ticketId":11,'), 'S4: /inbox?workContextId excludes uncontexted ticket 11 when filtered');
    const allTr = await request('GET', '/inbox', { cookie: admin });
    assert(allTr.body.includes('"ticketId":11,'), 'S4: uncontexted/critical triage is NOT hidden by default');
    assert((await request('GET', '/process-templates?workContextId=1', { cookie: admin })).statusCode === 200, 'S4: /process-templates?workContextId unaffected (no templates in fixture)');

    // ===== Scenario 5 — no hidden state / no new ledgers =====
    assert(dataFiles() === filesBefore, 'S5: no unexpected data files created (no handoff/claim/work-receipt/timeline/context-summary ledger)');
    assert(readRaw('work-contexts.json') === wcStoreBefore, 'S5: Work Context store unchanged by handoff/claim/receipt');
    assert(readRaw('process-templates.json') === ptBefore && readRaw('process-template-triggers.json') === ptTriggersBefore && readRaw('process-template-versions.json') === ptVersionsBefore, 'S5: no process-template/version/durability/scheduler-token data changed');
    assert(JSON.stringify(tickets().find(t => t.id === 10)) === ticket10Before, 'S5: source ticket #10 not rewritten');
    assert(JSON.stringify(runs().find(r => r.id === 100)) === run100Before, 'S5: source run #100 not rewritten');
    assert(readRaw('events.jsonl').startsWith(eventsBefore.replace(/\n$/, '')), 'S5: prior events preserved (append-only; only appended to)');
    assert(ws() === wsBefore, 'S5: no workspace mutation (no run executed in the smoke loop)');
    // Every handoff is a visible ordinary ticket — no hidden work.
    assert(tickets().filter(t => t.source && t.source.type === 'handoff').length === 2, 'S5: each handoff is a visible ordinary ticket (no hidden work)');

    console.log('PASS: handoff smoke loop proves claim, receipt, triage, handoff, visibility, and no hidden work');
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
