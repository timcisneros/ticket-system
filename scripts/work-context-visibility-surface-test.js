#!/usr/bin/env node
// Work Context shared visibility surface (r1.21). A READ-ONLY detail/summary view over the r1.20
// Work Context primitive: it shows the related tickets, triage, process templates, and recent
// runs for one context, derived live from the existing stores. It must create no ticket/run/
// workspace mutation, write no log/event, and introduce no new source of truth.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3495';
const BASE_URL = 'http://127.0.0.1:' + PORT;
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-vis-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-vis-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

const snap = { id: 1, name: 'Legal Ops', purpose: 'Legal Ops purpose', status: 'active' };
function baseTicket(id, objective, extra) {
  return { id, objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status: 'completed', createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO, ...extra };
}
const TRIAGE = { required: true, reasonCode: 'authority_blocked', summary: 'needs review', requiredDecision: 'change_scope', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
const RUN_TRIAGE = { required: true, reasonCode: 'verification_failed', summary: 'verify failed', requiredDecision: 'review_failure', evidenceRefs: [], allowedActions: ['review'], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
function run(id, ticketId, status, extra) {
  return { id, ticketId, agentId: 1, agentName: 'A', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null, executionPolicySnapshot: { requireVerification: 'when_declared' },
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    status, createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO, replaySnapshotPath: `replay-snapshots/run-${id}.json`, ...extra };
}
function context(id, name, status, extra) {
  return { id, name, purpose: name + ' purpose', status, defaultTargetId: null, defaultAuthorityProfileId: null,
    allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null,
    memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [],
    ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdBy: 'admin', createdAt: ISO, updatedBy: 'admin', updatedAt: ISO, ...extra };
}
function tmpl(id, name, extra) {
  return { id, name, version: 1, currentVersion: 1, enabled: true, triggerType: 'manual', schedule: null,
    ticketTemplate: { objective: 'obj ' + name, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null, ownedOutputPaths: null, executionPolicy: { maxAttempts: null } },
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null, ...extra };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage', 'workContext:manage']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage', 'workContext:manage'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []);
  writeJson('work-contexts.json', [context(1, 'Legal Ops', 'active'), context(2, 'Billing', 'active'), context(3, 'Archived Prog', 'archived')]);
  writeJson('tickets.json', [
    baseTicket(50, 'contextless done ticket'),
    baseTicket(51, 'legal ops blocked ticket', { status: 'blocked', workContextId: 1, workContextSnapshot: snap, triage: { ...TRIAGE } }),
    baseTicket(52, 'legal ops open ticket', { status: 'open', workContextId: 1, workContextSnapshot: snap }),
    baseTicket(53, 'billing done ticket', { workContextId: 2, workContextSnapshot: { id: 2, name: 'Billing', purpose: 'Billing purpose', status: 'active' } }),
    baseTicket(54, 'contextless blocked ticket', { status: 'blocked', triage: { ...TRIAGE } })
  ]);
  writeJson('runs.json', [
    run(101, 51, 'completed'),
    run(102, 51, 'failed', { triage: { ...RUN_TRIAGE }, error: 'verify failed' })
  ]);
  [101, 102].forEach(id => fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', `run-${id}.json`), JSON.stringify({ runId: id, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }, null, 2)));
  writeJson('process-templates.json', [
    tmpl(1, 'Legal template', { workContextId: 1, workContextSnapshot: snap, schedule: { enabled: true, kind: 'interval', everySeconds: 86400, anchor: ISO, nextRunAt: PAST, lastScheduledTriggerAt: null, timezone: 'UTC', scheduledBy: 'admin' } }),
    tmpl(2, 'Billing template', { workContextId: 2 }),
    tmpl(3, 'Unscoped template')
  ]);
  writeJson('process-template-triggers.json', []);
  writeJson('process-template-versions.json', []);
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
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; server.stdout.on('data', c => { out += String(c); }); server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const cookie = await loginAs('admin');

    // ---- r1.20 CRUD still works. ----
    const created = await request('POST', '/api/work-contexts', { cookie, json: { name: 'New Ops' } });
    assert(created.statusCode === 200 && created.json.ok, 'r1.20 Work Context create still works');

    // ---- List page lists contexts + links detail pages. ----
    const listPage = await request('GET', '/work-contexts', { cookie });
    assert(listPage.statusCode === 200 && listPage.body.includes('Legal Ops') && listPage.body.includes('href="/work-contexts/1"'), 'list page links to detail pages');
    assert(listPage.body.includes('Archived Prog'), 'archived contexts are shown (not hidden)');

    // ---- Detail page renders for an active context. ----
    const detail = await request('GET', '/work-contexts/1', { cookie });
    assert(detail.statusCode === 200 && detail.body.includes('Legal Ops') && /product-layer grouping/i.test(detail.body), 'detail page renders with product-layer-grouping note');

    // Missing context → 404.
    assert((await request('GET', '/work-contexts/9999', { cookie })).statusCode === 404, 'missing context detail returns 404');

    // Archived context renders (200) and creates no hidden work (assignment still rejected).
    const archDetail = await request('GET', '/work-contexts/3', { cookie });
    assert(archDetail.statusCode === 200 && archDetail.body.includes('archived'), 'archived context detail renders');
    assert((await request('POST', '/tickets', { cookie, form: { objective: 'x', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', workContextId: '3' } })).statusCode === 400, 'archived context still cannot create work');

    // ---- Detail shows ONLY this context's tickets / triage / templates. ----
    assert(detail.body.includes('legal ops blocked ticket') && detail.body.includes('legal ops open ticket'), 'detail shows context tickets');
    assert(!detail.body.includes('billing done ticket') && !detail.body.includes('contextless done ticket'), 'detail excludes other-context and contextless tickets');
    assert(detail.body.includes('/runs/102') && detail.body.includes('/tickets/51'), 'detail shows context triage (ticket 51 + run 102)');
    assert(!detail.body.includes('/tickets/54') && !detail.body.includes('contextless blocked ticket'), 'detail excludes contextless triage (ticket 54)');
    assert(detail.body.includes('Legal template') && !detail.body.includes('Billing template') && !detail.body.includes('Unscoped template'), 'detail shows only context templates');
    assert(detail.body.includes('/runs/101'), 'detail shows recent runs with run links');

    // ---- Summary API: deterministic + exact counts. ----
    const s1 = await request('GET', '/api/work-contexts/1/summary', { cookie });
    const s2 = await request('GET', '/api/work-contexts/1/summary', { cookie });
    assert(s1.statusCode === 200 && s1.json.ok, 'summary API ok');
    assert(JSON.stringify(s1.json) === JSON.stringify(s2.json), 'summary is deterministic across calls');
    const c = s1.json.counts;
    assert(c.ticketCount === 2 && c.openTicketCount === 1 && c.blockedTicketCount === 1, 'ticket counts correct');
    assert(c.unresolvedTriageCount === 2, 'unresolved triage count = ticket(1) + run(1)');
    assert(c.processTemplateCount === 1 && c.scheduledTemplateCount === 1, 'template counts correct');
    assert(c.recentRunCount === 2, 'recent run count correct');
    assert(s1.json.tickets.map(t => t.id).join(',') === '52,51', 'tickets ordered deterministically (id desc)');
    assert((await request('GET', '/api/work-contexts/9999/summary', { cookie })).statusCode === 404, 'summary for missing context returns 404');

    // ---- Existing filters still work. ----
    const ft = await request('GET', '/tickets?workContextId=1', { cookie });
    assert(ft.body.includes('legal ops blocked ticket') && !ft.body.includes('billing done ticket') && !ft.body.includes('contextless done ticket'), '/tickets?workContextId filters');
    const fr = await request('GET', '/triage?workContextId=1', { cookie });
    assert(fr.body.includes('/tickets/51') && !fr.body.includes('/tickets/54'), '/triage?workContextId filters (uncontexted excluded only when filtered)');
    const allTriage = await request('GET', '/triage', { cookie });
    assert(allTriage.body.includes('/tickets/51') && allTriage.body.includes('/tickets/54'), 'unfiltered triage still shows uncontexted items');
    const fp = await request('GET', '/process-templates?workContextId=1', { cookie });
    assert(fp.body.includes('Legal template') && !fp.body.includes('Unscoped template'), '/process-templates?workContextId filters');

    // ---- Links resolve (ticket / run / template pages). ----
    assert((await request('GET', '/tickets/51', { cookie })).statusCode === 200, 'ticket link resolves');
    assert((await request('GET', '/runs/101', { cookie })).statusCode === 200, 'run/timeline link resolves');

    // ---- Read-only: visibility routes write NOTHING (no ticket/run/workspace/log/event mutation). ----
    const before = { tickets: readRaw('tickets.json'), runs: readRaw('runs.json'), wc: readRaw('work-contexts.json'), logs: readRaw('logs.json'), events: readRaw('events.jsonl'), templates: readRaw('process-templates.json'), ledger: readRaw('process-template-triggers.json') };
    const wsBefore = ws();
    for (const url of ['/work-contexts', '/work-contexts/1', '/work-contexts/3', '/api/work-contexts/1/summary', '/tickets?workContextId=1', '/triage?workContextId=1', '/process-templates?workContextId=1']) {
      await request('GET', url, { cookie });
    }
    assert(readRaw('tickets.json') === before.tickets, 'visibility reads never mutate tickets');
    assert(readRaw('runs.json') === before.runs, 'visibility reads never mutate runs');
    assert(readRaw('work-contexts.json') === before.wc, 'visibility reads never mutate the work-context store');
    assert(readRaw('logs.json') === before.logs, 'visibility reads write no logs');
    assert(readRaw('events.jsonl') === before.events, 'visibility reads write no events');
    assert(readRaw('process-templates.json') === before.templates, 'visibility reads never mutate templates');
    assert(readRaw('process-template-triggers.json') === before.ledger, 'visibility reads write no trigger-ledger entry');
    assert(ws() === wsBefore, 'visibility reads mutate no workspace files');

    // No new persisted summary/timeline ledger file is created.
    const files = fs.readdirSync(DATA_DIR);
    assert(!files.some(f => /summary|context-timeline|work-context-summary/i.test(f)), 'no new context summary/timeline ledger file is created');

    console.log('PASS: Work Context visibility surface — read-only detail/summary over existing stores; deterministic, context-scoped, no hidden work, no new source of truth');
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
