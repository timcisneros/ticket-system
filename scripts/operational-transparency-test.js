#!/usr/bin/env node
// Operational transparency surface (r1.31). A READ-ONLY operational summary derived live from every
// existing store. Proves: it is permission-gated; counts (tickets/runs/triage/work-contexts/
// watchers/connectors/routing/templates/schedules) are correct; warning flags reflect state; recent
// lists are bounded; and reading the summary/page writes NOTHING (no ticket/run/log/event/receipt/
// workspace mutation, no new summary file).

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3489';
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
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ statusCode: res.statusCode, headers: res.headers, body: raw, json }); }); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function dataFiles() { return fs.readdirSync(DATA_DIR).sort().join(','); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

const TRIAGE = { required: true, reasonCode: 'authority_blocked', summary: 'needs review', requiredDecision: 'change_scope', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
function ticket(id, status, extra) {
  return { id, objective: 'obj ' + id, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null, executionMode: 'agent', workflowId: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', executionPolicy: { maxAttempts: null }, status, createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO, ...extra };
}
function run(id, ticketId, status) { return { id, ticketId, agentId: 1, agentName: 'A', status, runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(), createdAt: ISO, updatedAt: ISO }; }
function ctx(id, status) { return { id, name: 'C' + id, purpose: 'p', status, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO }; }

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }, { id: 2, username: 'plain', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:read', 'ops:read']);
  writeJson('groups.json', [{ id: 1, name: 'Ops', permissions: ['ticket:read', 'ops:read'], canReceiveTickets: false }, { id: 2, name: 'Plain', permissions: ['ticket:read'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }, { id: 2, principalType: 'user', principalId: 2, groupId: 2 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []);
  writeJson('logs.json', [{ id: 1, timestamp: ISO, runId: null, ticketId: null, type: 'ticket:no_model_route', message: 'no permitted provider for run' }]);
  // 2 open, 1 blocked(+triage), 1 completed, 1 failed.
  writeJson('tickets.json', [ticket(1, 'open'), ticket(2, 'open'), ticket(3, 'blocked', { triage: { ...TRIAGE } }), ticket(4, 'completed'), ticket(5, 'failed')]);
  writeJson('runs.json', [run(10, 4, 'completed'), run(11, 5, 'failed'), run(12, 1, 'interrupted')]);
  writeJson('work-contexts.json', [ctx(1, 'active'), ctx(2, 'archived')]);
  writeJson('watchers.json', [{ id: 1, name: 'W', status: 'active', workContextId: 1, sourceKind: 'workspace_file', sourceRefs: [{ path: 'a' }], actionPolicy: { allowedActions: ['summarize'] }, createdAt: ISO, updatedAt: ISO }]);
  writeJson('watcher-observations.json', [{ id: 1, watcherId: 1, status: 'failed', error: 'source unavailable', observedAt: ISO }, { id: 2, watcherId: 1, status: 'changed', observedAt: ISO }]);
  writeJson('watcher-ticket-proposals.json', []);
  writeJson('model-routing-policies.json', [{ id: 1, name: 'P', status: 'active', createdAt: ISO, updatedAt: ISO }]);
  writeJson('connectors.json', [{ id: 1, name: 'Conn', status: 'active', kind: 'local_mock', workContextId: 1, allowedScopes: ['read'], sourceRoots: ['inbox'], createdAt: ISO, updatedAt: ISO }]);
  writeJson('connector-receipts.json', [{ id: 1, connectorId: 1, operation: 'read_refused', result: { status: 'refused', reason: 'out of bounds' }, timestamp: ISO }, { id: 2, connectorId: 1, operation: 'read', result: { status: 'ok', bytes: 5, hash: 'abc' }, timestamp: ISO }]);
  writeJson('local-connector-objects.json', []);
  writeJson('process-templates.json', [
    { id: 1, name: 'T1', version: 1, enabled: true, triggerType: 'manual', schedule: null, ticketTemplate: {}, createdAt: ISO, updatedAt: ISO },
    { id: 2, name: 'T2', version: 1, enabled: true, triggerType: 'manual', schedule: { enabled: true, kind: 'interval', everySeconds: 86400, nextRunAt: ISO, timezone: 'UTC' }, ticketTemplate: {}, createdAt: ISO, updatedAt: ISO },
    { id: 3, name: 'T3', version: 1, enabled: false, triggerType: 'manual', schedule: { enabled: false, kind: 'interval', everySeconds: 86400, nextRunAt: null, timezone: 'UTC' }, ticketTemplate: {}, createdAt: ISO, updatedAt: ISO }
  ]);
  writeJson('process-template-triggers.json', []); writeJson('process-template-versions.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
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
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT,
      DATA_DIR,
      WORKSPACE_ROOT,
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000',
      EVENT_JOURNAL_MAX_RECORD_BYTES: '2048',
      EVENT_JOURNAL_MAX_BATCH_ENTRIES: '16',
      EVENT_JOURNAL_MAX_BATCH_BYTES: '4096',
      EVENT_JOURNAL_MAX_OUTSTANDING_ENTRIES: '64',
      EVENT_JOURNAL_MAX_OUTSTANDING_BYTES: '8192'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; server.stdout.on('data', c => { out += String(c); }); server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const admin = await loginAs('admin');
    const plain = await loginAs('plain');

    // ---- 1: permission gating. ----
    assert((await request('GET', '/api/ops/summary', { cookie: plain })).statusCode === 403, '/api/ops/summary requires ops:read');
    assert((await request('GET', '/ops', { cookie: plain })).statusCode === 403, '/ops requires ops:read');

    const before = { tickets: readRaw('tickets.json'), runs: readRaw('runs.json'), logs: readRaw('logs.json'), events: readRaw('events.jsonl'), receipts: readRaw('connector-receipts.json'), observations: readRaw('watcher-observations.json') };
    const filesBefore = dataFiles();
    const wsBefore = ws();

    // ---- 2: summary counts derive correctly. ----
    const res = await request('GET', '/api/ops/summary', { cookie: admin });
    assert(res.statusCode === 200 && res.json.ok, '/api/ops/summary ok');
    const s = res.json.summary;
    assert(s.tickets.total === 5 && s.tickets.open === 2 && s.tickets.blocked === 1 && s.tickets.completed === 1 && s.tickets.failed === 1, 'ticket counts correct');
    assert(s.runs.total === 3 && s.runs.running === 0 && s.runs.completed === 1 && s.runs.failed === 1 && s.runs.interrupted === 1, 'run counts correct');
    assert(s.triage.unresolvedTicketCount === 1, 'unresolved ticket triage count correct');
    assert(s.workContexts.active === 1 && s.workContexts.archived === 1, 'work context counts correct');
    assert(s.watchers.active === 1 && s.watchers.recentFailures.length === 1 && s.watchers.recentFailures[0].status === 'failed', 'watcher failed observation surfaced');
    assert(s.connectors.active === 1 && s.connectors.recentRefusals.some(r => r.operation === 'read_refused'), 'connector refusal surfaced');
    assert(s.modelRoutingPolicies.active === 1, 'routing policy count correct');
    assert(s.processTemplates.total === 3 && s.processTemplates.enabled === 2 && s.processTemplates.disabled === 1 && s.processTemplates.scheduled === 1, 'process-template counts correct');
    assert(s.schedules.enabled === 1, 'schedule counts correct');
    assert(s.eventJournal && s.eventJournal.config.maxRecordBytes === 2048, 'journal record capacity override surfaced');
    assert(s.eventJournal.config.maxOutstandingEntries === 64 && s.eventJournal.config.maxOutstandingBytes === 8192, 'journal outstanding capacity overrides surfaced');
    assert(Number.isFinite(s.eventJournal.current.utilization) && s.eventJournal.totals.backpressureRejections === 0, 'journal pressure metrics surfaced');

    // ---- 3: warning flags reflect state. ----
    assert(s.warnings.unresolvedTriageExists === true && s.warnings.blockedTicketsExist === true && s.warnings.failedRunsExist === true, 'state warnings set');
    assert(s.warnings.connectorReadRefusalsExist === true && s.warnings.watcherFailedOrRefusedExist === true, 'refusal warnings set');
    assert(s.warnings.noActiveWorkContexts === false && s.warnings.noRoutingPolicies === false && s.warnings.noConnectors === false, 'presence warnings false when present');
    assert(s.warnings.eventJournalPressureExists === false, 'healthy journal should not raise a pressure warning');

    // ---- 4: recent lists are bounded + deterministic. ----
    assert(Array.isArray(s.recentFailedRuns) && s.recentFailedRuns.length <= 10 && s.recentAuthorityDenials.some(d => d.type === 'ticket:no_model_route'), 'recent lists bounded; authority/refusal signal surfaced');
    const res2 = await request('GET', '/api/ops/summary', { cookie: admin });
    const s2 = res2.json.summary; const strip = o => { const c = JSON.parse(JSON.stringify(o)); delete c.generatedAt; return c; };
    assert(JSON.stringify(strip(s)) === JSON.stringify(strip(s2)), 'summary is deterministic (excluding generatedAt)');

    // ---- 5: reads write NOTHING; no new file; UI renders. ----
    await request('GET', '/ops', { cookie: admin });
    await request('GET', '/api/ops/summary', { cookie: admin });
    assert(readRaw('tickets.json') === before.tickets && readRaw('runs.json') === before.runs, 'ops reads never mutate tickets/runs');
    assert(readRaw('logs.json') === before.logs && readRaw('events.jsonl') === before.events, 'ops reads write no logs/events');
    assert(readRaw('connector-receipts.json') === before.receipts && readRaw('watcher-observations.json') === before.observations, 'ops reads write no receipts/observations');
    assert(ws() === wsBefore, 'ops reads mutate no workspace');
    assert(dataFiles() === filesBefore, 'no new ops summary file created');
    const page = await request('GET', '/ops', { cookie: admin });
    assert(page.statusCode === 200 && /Operational Transparency/.test(page.body) && page.body.includes('/triage') && page.body.includes('/connectors'), '/ops page renders with links');
    assert(page.body.includes('Event journal capacity') && page.body.includes('2048'), '/ops page renders journal capacity');

    console.log('PASS: operational transparency — read-only derived summary; correct counts/warnings, bounded deterministic lists, no writes, no new ledger');
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
