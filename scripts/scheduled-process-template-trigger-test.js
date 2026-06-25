#!/usr/bin/env node
// Scheduled process-template triggers (r1.7). A scheduled trigger creates an ordinary
// ticket from a template via the SAME shared helper as the manual trigger
// (triggerProcessTemplate → createTicketFromInput → createRunsForTicket). It never
// executes work, creates runs directly, or mutates the workspace. This test drives the
// scheduler deterministically through the manage-gated scan-tick endpoint (no
// wall-clock sleeps): templates carry a nextRunAt in the past, and a tick scans them.
//
// Both schedulers are neutralized via huge intervals so nothing fires on its own; the
// test calls /api/process-templates/scheduler/tick explicitly.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3494';
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
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(raw); } catch (e) {} resolve({ statusCode: res.statusCode, headers: res.headers, body: raw, json }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ptt-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ptt-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function tickets() { return readJsonData('tickets.json'); }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }
function templateById(id) { return readJsonData('process-templates.json').find(t => t.id === id); }
function workspaceListing() { return fs.readdirSync(WORKSPACE_ROOT).sort(); }

// nextRunAt strings (fixed at seed time → deterministic trigger tokens within this run).
const PAST = new Date(Date.now() - 100 * 3600 * 1000).toISOString();   // long-ago slot (storm test)
const PAST2 = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

function schedule(nextRunAt, extra = {}) {
  return { enabled: true, kind: 'interval', everySeconds: 3600, anchor: ISO, nextRunAt, lastScheduledTriggerAt: null, timezone: 'UTC', scheduledBy: 'admin', ...extra };
}
function template(id, name, objective, opts = {}) {
  return {
    id, name, enabled: opts.enabled === false ? false : true, triggerType: 'manual',
    schedule: opts.schedule !== undefined ? opts.schedule : null,
    ticketTemplate: {
      objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null,
      capabilityType: 'directAction', capabilityId: 'agent-selected-actions',
      workflowId: null, workflowInput: null, ownedOutputPaths: null,
      executionPolicy: opts.executionPolicy !== undefined ? opts.executionPolicy : { maxAttempts: null }
    },
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null
  };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 3, username: 'creator', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 4, username: 'manager', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false },
    { id: 3, name: 'Creators', permissions: ['ticket:create', 'ticket:read'], canReceiveTickets: false },
    { id: 4, name: 'Managers', permissions: ['processTemplate:manage', 'ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 },
    { id: 3, principalType: 'user', principalId: 3, groupId: 3 },
    { id: 4, principalType: 'user', principalId: 4, groupId: 4 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'Sched Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('process-templates.json', [
    template(1, 'Scheduled status', 'Create folder reports', { schedule: schedule(PAST) }),                       // due → 1 ticket
    template(2, 'Scheduled ambiguous', 'Create 3 folders each named Michael Jackson songs', { schedule: schedule(PAST2) }), // due → blocked, 0 runs
    template(3, 'Disabled template', 'Create folder unused', { enabled: false, schedule: schedule(PAST) }),       // template disabled → never
    template(4, 'Schedule off', 'Create folder off', { schedule: schedule(PAST, { enabled: false }) }),           // schedule.enabled false → never
    template(5, 'Not yet due', 'Create folder later', { schedule: schedule(FUTURE) }),                            // future → inert
    template(6, 'Invalid schedule', 'Create folder invalid', { schedule: schedule('not-a-date') }),              // invalid → skipped safely
    template(7, 'AutoRetry inert', 'Create folder retryable', { schedule: schedule(PAST), executionPolicy: { autoRetry: true } }) // autoRetry true + no maxAttempts
  ]);
  writeJson('process-template-triggers.json', []);
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
async function loginAs(u) { const res = await request('POST', '/login', { form: { username: u, password: 'admin123' } }); assert(res.statusCode === 302, `login ${u} failed ${res.statusCode}`); return cookieFrom(res); }
const tick = (cookie) => request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // Both schedulers neutralized: nothing fires on its own; the test drives the tick.
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const admin = await loginAs('admin');
    const viewer = await loginAs('viewer');
    const creator = await loginAs('creator');
    const manager = await loginAs('manager');

    const wsBefore = JSON.stringify(workspaceListing());

    // Inert until enabled: nothing triggered before any tick.
    assert(tickets().length === 0, 'no tickets before any scheduler tick');

    // Permissions on the scan-tick endpoint: requires processTemplate:manage.
    assert((await tick(creator)).statusCode === 403, 'creator (no manage) must not run scheduler tick');
    assert((await tick(viewer)).statusCode === 403, 'viewer must not run scheduler tick');
    assert(tickets().length === 0, 'denied ticks create nothing');

    // ---- First scan tick (as admin) ----
    const first = await tick(admin);
    assert(first.statusCode === 200 && first.json && first.json.ok, 'admin scheduler tick should succeed: ' + first.body);

    const afterFirst = tickets();
    // Due, enabled, valid templates: 1 (safe), 2 (ambiguous), 7 (autoRetry). NOT 3/4/5/6.
    const t1 = afterFirst.find(t => t.source && t.source.templateId === 1);
    const t2 = afterFirst.find(t => t.source && t.source.templateId === 2);
    const t7 = afterFirst.find(t => t.source && t.source.templateId === 7);
    assert(t1 && t2 && t7, 'due scheduled templates (1,2,7) must each create exactly one ticket');
    assert(!afterFirst.some(t => t.source && [3, 4, 5, 6].includes(t.source.templateId)), 'disabled/off/future/invalid templates must not trigger');
    assert(afterFirst.length === 3, `exactly 3 tickets after first tick, got ${afterFirst.length}`);

    // Provenance on the safe scheduled ticket.
    const src = t1.source;
    assert(src.type === 'process_template', 'source.type process_template');
    assert(src.triggerType === 'schedule', 'source.triggerType must be schedule');
    assert(src.triggeredBy === 'system', 'source.triggeredBy must be system');
    assert(src.triggerRunId === null, 'source.triggerRunId null');
    assert(src.scheduledFor === PAST, 'source.scheduledFor must be the slot boundary');
    assert(src.triggerToken === `schedule:1:${PAST}`, `deterministic token schedule:1:<iso>, got ${src.triggerToken}`);

    // Normalized policy on generated ticket; autoRetry inert for template 7.
    assert(t1.executionPolicy.requireVerification === 'when_declared', 'generated ticket policy must be normalized');
    assert(t1.executionPolicy.autoRetry === false, 'autoRetry defaults false when template omits it');
    assert(t7.executionPolicy.autoRetry === true && t7.executionPolicy.maxAttempts === null, 'autoRetry true + maxAttempts null stays inert');

    // Safe template → exactly one pending run via the normal path; ambiguous → blocked, no run.
    assert(runsForTicket(t1.id).length === 1 && runsForTicket(t1.id)[0].status === 'pending', 'clear scheduled ticket creates exactly one pending run via normal path');
    assert(t2.status === 'blocked' && t2.triage && t2.triage.reasonCode === 'objective_ambiguous', 'ambiguous scheduled ticket must block via clarification gate');
    assert(runsForTicket(t2.id).length === 0, 'ambiguous scheduled ticket must create no run');

    // Cursor advanced forward (no storm): template 1 nextRunAt now in the future.
    assert(Date.parse(templateById(1).schedule.nextRunAt) > Date.now(), 'nextRunAt must advance forward from now after trigger');
    assert(templateById(1).schedule.lastScheduledTriggerAt, 'lastScheduledTriggerAt recorded');

    // Trigger log + system log written for scheduled trigger.
    const ledger = readJsonData('process-template-triggers.json');
    const entry1 = ledger.find(e => e.triggerToken === `schedule:1:${PAST}`);
    assert(entry1 && entry1.triggerType === 'schedule' && entry1.triggeredBy === 'system', 'trigger log records scheduled trigger');
    assert(entry1.ticketTemplateSnapshot && entry1.executionPolicyUsed && entry1.scheduledFor === PAST, 'trigger log carries snapshot + scheduledFor (same helper as manual)');
    assert(readJsonData('logs.json').some(l => l.type === 'process_template:triggered' && l.contextTicketId === t1.id && l.triggerType === 'schedule'), 'process_template:triggered system log for scheduled trigger');

    // ---- No duplicate on repeated tick (nextRunAt already advanced to the future) ----
    await tick(admin);
    assert(tickets().length === 3, 'repeated tick must not create duplicates (cursor advanced)');

    // ---- Stale nextRunAt + ledger token → no duplicate (crash that lost cursor update) ----
    let store = readJsonData('process-templates.json');
    store.find(t => t.id === 1).schedule.nextRunAt = PAST; // rewind to the already-handled slot
    writeJson('process-templates.json', store);
    const staleTick = await tick(admin);
    assert(tickets().length === 3, 'stale nextRunAt with ledger token must not duplicate');
    assert(staleTick.json.results.some(r => r.templateId === 1 && r.action === 'deduped'), 'stale slot must be deduped via ledger');
    assert(Date.parse(templateById(1).schedule.nextRunAt) > Date.now(), 'deduped scheduled re-entry must advance cursor forward');

    // ---- ticket.source token dedupes even if the ledger entry is missing ----
    let ledger2 = readJsonData('process-template-triggers.json').filter(e => e.triggerToken !== `schedule:1:${PAST}`);
    writeJson('process-template-triggers.json', ledger2);
    store = readJsonData('process-templates.json');
    store.find(t => t.id === 1).schedule.nextRunAt = PAST; // rewind again
    writeJson('process-templates.json', store);
    await tick(admin);
    assert(tickets().length === 3, 'existing ticket.source.triggerToken must dedupe even with the ledger entry removed');

    // ---- No historical storm: template 1 was 100 intervals stale → still one ticket total ----
    assert(afterFirst.filter(t => t.source.templateId === 1).length === 1, 'long downtime produced exactly one ticket (no storm)');

    // ---- Schedule management API permissions ----
    assert((await request('POST', '/api/process-templates/5/schedule', { cookie: viewer, json: { enabled: false } })).statusCode === 403, 'viewer cannot manage schedule');
    // Manager has manage but not ticket:create → may disable, but enabling is forbidden.
    assert((await request('POST', '/api/process-templates/5/schedule', { cookie: manager, json: { enabled: true, kind: 'interval', everySeconds: 3600 } })).statusCode === 403, 'enabling a schedule requires ticket:create');
    assert((await request('POST', '/api/process-templates/5/schedule', { cookie: manager, json: { enabled: false } })).statusCode === 200, 'manager may disable a schedule');
    // everySeconds below the safe minimum is rejected.
    assert((await request('POST', '/api/process-templates/5/schedule', { cookie: admin, json: { enabled: true, kind: 'interval', everySeconds: 5 } })).statusCode === 400, 'sub-minimum everySeconds rejected');
    // Enable recomputes nextRunAt forward from now.
    const setRes = await request('POST', '/api/process-templates/5/schedule', { cookie: admin, json: { enabled: true, kind: 'interval', everySeconds: 3600 } });
    assert(setRes.statusCode === 200 && setRes.json.schedule.enabled === true, 'admin can enable interval schedule');
    assert(Date.parse(setRes.json.schedule.nextRunAt) > Date.now(), 're-enable computes nextRunAt forward from now (no stale immediate fire)');

    // ---- Manual trigger still works and shares the helper (coexistence) ----
    const manual = await request('POST', '/api/process-templates/1/trigger', { cookie: admin, json: { triggerToken: 'manual-coexist-1' } });
    assert(manual.statusCode === 200 && manual.json.ok && manual.json.deduped === false, 'manual trigger still works');
    const manualTicket = tickets().find(t => t.id === manual.json.ticketId);
    assert(manualTicket.source.triggerType === 'manual' && manualTicket.source.triggeredBy === 'admin', 'manual trigger provenance unchanged');

    // ---- No workspace mutation during any scheduled trigger ----
    assert(JSON.stringify(workspaceListing()) === wsBefore, 'scheduled triggers must not mutate the workspace');

    // ---- Templates page renders schedule status with safe copy ----
    const page = await request('GET', '/process-templates', { cookie: admin });
    assert(page.statusCode === 200 && page.body.includes('Schedule ticket creation'), 'templates page shows schedule control');
    assert(/Creates a ticket every/.test(page.body), 'templates page shows interval schedule status');
    assert(!/running loop/i.test(page.body) && !/autonomous/i.test(page.body), 'templates page must not imply autonomy');

    console.log('PASS: scheduled process template triggers create gated, provenanced, idempotent, storm-free tickets with no workspace mutation');
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
