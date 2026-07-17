#!/usr/bin/env node
// Operator inbox messaging semantics. Blockers and deliverables arrive as
// message threads; agent-attributed message bodies are the model's recorded
// terminal output VERBATIM (never fabricated prose — see docs/OPERATOR_INBOX.md);
// pre-run gates produce system-attributed messages carrying the recorded gate
// text. Reply appends without resolving; resolve performs the triage annotation
// and closes the thread; the legacy resolve API mirrors into the thread;
// deliverable acknowledgement closes its thread. Everything is audit-logged.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-03-01T00:00:00.000Z';
const PORT = process.env.PORT || '3512';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-messaging-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-messaging-ws-'));

const MODEL_BLOCKER_MSG = 'I cannot proceed with the report consolidation: the source folder "reports/" does not exist in the workspace. Please confirm the correct folder name or restore the fixture, then rerun.';
const MODEL_DELIVERY_MSG = 'Consolidation complete. I merged the three quarterly summaries into summary/annual-report.md and archived the originals under archive/. All postconditions passed.';
const GATE_SUMMARY = 'Objective is ambiguous: "tidy things up" names no concrete target. Clarify which folder or files the ticket refers to.';

function assert(c, m) { if (!c) throw new Error(m); }

function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }

const runtimeLimitsSnapshot = { maxExecutionSteps: 10, maxModelRequestsPerRun: 10, maxWorkspaceOperationsPerRun: 50, maxRuntimeDurationMs: 600000, source: null };

function ticket(id, objective, status, extra = {}) {
  return {
    id, objective,
    assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status,
    createdBy: 'admin', changedBy: 'admin', changedAt: T0, createdAt: T0, updatedAt: T0,
    ...extra
  };
}

function run(id, ticketId, status, extra = {}) {
  return {
    id, ticketId, agentId: 1, agentName: 'Docs Agent',
    workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [],
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    runtimeLimitsSnapshot,
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null,
    currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status,
    createdAt: T0, updatedAt: T0, startedAt: T0, completedAt: T0,
    ...extra
  };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'Docs Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: T0, updatedAt: T0 }]);
  writeJson('logs.json', []);

  writeJson('tickets.json', [
    // Pre-run gate: no model ever ran → system-attributed message from gate text
    ticket(1, 'tidy things up', 'blocked', {
      blockedReason: GATE_SUMMARY,
      triage: {
        required: true, reasonCode: 'objective_ambiguous', summary: GATE_SUMMARY,
        requiredDecision: 'clarify_objective', evidenceRefs: ['objective-contract:gate'],
        allowedActions: ['edit_objective', 'clarify_ticket'], prohibitedActions: ['start_run_without_clarification'],
        createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
      }
    }),
    // Failed run with the model's own final message
    ticket(2, 'Consolidate quarterly reports into an annual report', 'failed'),
    // Completed ticket → deliverable thread with model's final report
    ticket(3, 'Merge quarterly summaries into annual report', 'completed')
  ]);

  writeJson('runs.json', [
    run(20, 2, 'failed', {
      error: 'Run failed: readFile reports/ not found',
      triage: {
        required: true, reasonCode: 'runtime_failed', summary: 'Run failed: readFile reports/ not found',
        requiredDecision: 'review_failure', evidenceRefs: ['event:run.execution_completed', 'replay:failure'],
        allowedActions: ['review', 'rerun_from_start'], prohibitedActions: ['automatic_retry'],
        createdAt: T0, resolvedAt: null, resolvedBy: null, resolution: null
      },
      replaySnapshotPath: 'replay-snapshots/run-20.json'
    }),
    run(30, 3, 'completed', {
      replaySnapshotPath: 'replay-snapshots/run-30.json',
      runConsequence: {
        mutations: [{ operation: 'writeFile', path: 'summary/annual-report.md' }],
        created: [{ operation: 'writeFile', path: 'summary/annual-report.md', type: 'file' }],
        updated: [], deleted: [], renamed: [],
        notifications: [], externalEffects: [],
        verification: { postconditionsStatus: 'passed', violationsStatus: 'none' }
      }
    })
  ]);

  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-20.json'), JSON.stringify({
    runId: 20, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [],
    parsedModelPlans: [
      { message: 'Listing the workspace to find the reports folder.', actions: [], complete: false },
      { message: MODEL_BLOCKER_MSG, actions: [], complete: false }
    ]
  }));
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-30.json'), JSON.stringify({
    runId: 30, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [],
    parsedModelPlans: [
      { message: 'Reading the three quarterly summaries.', actions: [], complete: false },
      { message: MODEL_DELIVERY_MSG, actions: [], complete: true }
    ]
  }));
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

async function request(method, urlPath, { cookie, form, json } = {}) {
  const headers = {};
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + urlPath, { method, headers, body, redirect: 'manual' });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: response.status, headers: response.headers, text, data };
}

async function main() {
  seed();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (server.exitCode !== null) break;
      try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
    }
    assert(up, 'server did not start:\n' + out.slice(-4000));

    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');

    // Redirect + nav.
    const redirect = await request('GET', '/triage', { cookie });
    assert(redirect.status === 302 && String(redirect.headers.get('location')).startsWith('/inbox'), '/triage must redirect to /inbox');
    const page = await request('GET', '/inbox', { cookie });
    assert(page.status === 200 && page.text.includes('<h1>Inbox</h1>'), 'GET /inbox must render');
    assert(page.text.includes('>Inbox</a>') && !page.text.includes('href="/triage"'), 'nav must show Inbox, not Triage');

    // Threads reconciled from state.
    const threads = (await request('GET', '/api/inbox/threads', { cookie })).data.threads;
    assert(threads.length === 3, `expected 3 threads, got ${threads.length}`);
    const gateThread = threads.find(t => t.ticketId === 1 && t.kind === 'blocker');
    const runThread = threads.find(t => t.runId === 20 && t.kind === 'blocker');
    const deliverableThread = threads.find(t => t.kind === 'deliverable');

    // Verbatim authorship contract.
    assert(gateThread && gateThread.messages[0].author === 'system' && gateThread.messages[0].body === GATE_SUMMARY,
      'pre-run gate thread must carry the recorded gate text, system-attributed');
    assert(runThread && runThread.messages[0].author === 'agent' && runThread.messages[0].authorName === 'Docs Agent' && runThread.messages[0].body === MODEL_BLOCKER_MSG,
      'run blocker thread must carry the model final message verbatim, agent-attributed');
    assert(deliverableThread && deliverableThread.messages[0].author === 'agent' && deliverableThread.messages[0].body === MODEL_DELIVERY_MSG,
      'deliverable thread must carry the model final report verbatim, agent-attributed');
    assert(runThread.reasonCode === 'runtime_failed' && runThread.requiredDecision === 'review_failure' && runThread.allowedActions.includes('rerun_from_start'),
      'blocker thread must carry structured triage facts as metadata');

    // Idempotency.
    const again = (await request('GET', '/api/inbox/threads', { cookie })).data.threads;
    assert(again.length === 3 && again.every(t => t.messages.length === 1), 'reconcile must be idempotent');

    // Reply without resolving.
    const reply = await request('POST', `/api/inbox/threads/${runThread.id}/reply`, { cookie, json: { body: 'Which folder did you expect? I will restore the fixture.' } });
    assert(reply.status === 200 && reply.data.thread.messages.length === 2 && reply.data.thread.status === 'open', 'reply must append and keep the thread open');

    // Resolve blocker via inbox → triage annotated on the run, thread closed.
    const resolve = await request('POST', `/api/inbox/threads/${runThread.id}/resolve`, { cookie, json: { body: 'Restored reports/ fixture; safe to rerun.' } });
    assert(resolve.status === 200 && resolve.data.thread.status === 'closed', 'resolve must close the thread');
    const run20 = readJsonData('runs.json').find(r => r.id === 20);
    assert(run20.triage.required === false && run20.triage.resolvedBy === 'admin' && run20.triage.resolution === 'Restored reports/ fixture; safe to rerun.',
      'resolve must annotate run triage with the reply as resolution note');
    assert(run20.status === 'failed', 'resolve must not change run status');
    assert((await request('POST', `/api/inbox/threads/${runThread.id}/resolve`, { cookie, json: { body: 'again' } })).status === 409,
      'resolving a closed thread must 409');

    // Legacy API resolve mirrors into the thread.
    const legacy = await request('POST', '/api/tickets/1/triage/resolve', { cookie, json: { resolution: 'Objective clarified with requester.' } });
    assert(legacy.status === 200, 'legacy resolve endpoint must still work');
    const gateAfter = (await request('GET', '/api/inbox/threads', { cookie })).data.threads.find(t => t.id === gateThread.id);
    assert(gateAfter.status === 'closed' && gateAfter.messages.some(m => m.kind === 'resolution' && m.body === 'Objective clarified with requester.'),
      'legacy resolve must mirror into the thread');

    // Acknowledge deliverable.
    const ack = await request('POST', `/api/inbox/threads/${deliverableThread.id}/resolve`, { cookie, json: { body: 'Received, thanks.' } });
    assert(ack.status === 200 && ack.data.thread.status === 'closed' && ack.data.thread.messages.some(m => m.kind === 'acknowledgement'),
      'deliverable acknowledgement must close the thread');

    // Detail pages are read-only for triage.
    const ticketPage = await request('GET', '/tickets/2', { cookie });
    assert(!ticketPage.text.includes('triage-resolve') && !ticketPage.text.includes('Resolve triage'), 'ticket page must have no resolve control');
    const runPage = await request('GET', '/runs/20', { cookie });
    assert(!runPage.text.includes('triage-resolve') && !runPage.text.includes('Resolve triage'), 'run page must have no resolve control');

    // Audit trail.
    const logs = readJsonData('logs.json');
    for (const type of ['inbox:reply', 'run:triage_resolve', 'ticket:triage_resolve', 'inbox:deliverable_acknowledged']) {
      assert(logs.some(l => l.type === type), `system log must contain ${type}`);
    }

    console.log('PASS: inbox messaging — verbatim model/system attribution, reply/resolve/acknowledge, legacy mirroring, read-only detail pages, audit');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
