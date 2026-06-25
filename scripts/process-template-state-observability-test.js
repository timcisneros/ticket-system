#!/usr/bin/env node
// Process-template state observability (r1.8). GET /process-templates derives operator
// state (due/health badges, generated-ticket rollup, recent generated tickets) purely
// from existing stores. This test proves the render is a PURE READ: it asserts the
// derived output is correct AND that tickets/runs/templates/trigger-log/logs/workspace
// are byte-identical before and after the GET (no trigger, no ticket/run creation, no
// scheduler tick, no mutation). No wall-clock sleeps drive any scheduler.

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

let server = null;
function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-state-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-state-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }

const PAST = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

function sched(nextRunAt, extra = {}) { return { enabled: true, kind: 'interval', everySeconds: 3600, anchor: ISO, nextRunAt, lastScheduledTriggerAt: null, timezone: 'UTC', scheduledBy: 'admin', ...extra }; }
function tmpl(id, name, schedule) {
  return { id, name, enabled: true, triggerType: 'manual', schedule: schedule || null,
    ticketTemplate: { objective: 'Create folder t' + id, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null, ownedOutputPaths: null, executionPolicy: { maxAttempts: null } },
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null };
}
// Generated ticket with process_template provenance.
function gTicket(id, templateId, triggerType, status, opts = {}) {
  const t = {
    id, objective: 'Generated ' + id, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual',
    ownedOutputPaths: null, executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' },
    status, createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
    source: { type: 'process_template', templateId, templateName: 'T' + templateId, triggeredBy: triggerType === 'schedule' ? 'system' : 'admin', triggerType, triggerRunId: null, triggerToken: opts.token || (triggerType + ':' + templateId + ':' + id), createdAt: opts.createdAt || ISO }
  };
  if (triggerType === 'schedule') t.source.scheduledFor = opts.scheduledFor || PAST;
  if (opts.triage) t.triage = { required: true, reasonCode: opts.triage, summary: 'x', requiredDecision: 'clarify_objective', evidenceRefs: [], allowedActions: [], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
  return t;
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []);
  writeJson('process-templates.json', [
    tmpl(1, 'Manual only', null),
    tmpl(2, 'Scheduled due', sched(PAST)),
    tmpl(3, 'Scheduled paused', sched(PAST, { enabled: false, nextRunAt: null })),
    tmpl(4, 'Invalid schedule', sched('not-a-date')),
    tmpl(5, 'Scheduled not due', sched(FUTURE)),
    tmpl(6, 'Attention blocked', null),
    tmpl(7, 'Attention failed', null),
    tmpl(8, 'Pending counts', null)
  ]);
  writeJson('tickets.json', [
    gTicket(101, 1, 'manual', 'completed', { token: 'manual-tok-SECRET-101' }),
    gTicket(102, 1, 'manual', 'open'),
    gTicket(201, 2, 'schedule', 'completed', { scheduledFor: PAST, token: 'schedule:2:' + PAST }),
    gTicket(601, 6, 'manual', 'blocked', { triage: 'objective_ambiguous' }),
    gTicket(701, 7, 'manual', 'failed'),
    gTicket(702, 7, 'manual', 'completed', { createdAt: '2026-02-01T01:00:00.000Z' }),
    gTicket(801, 8, 'manual', 'open'),
    gTicket(802, 8, 'manual', 'in_progress', { createdAt: '2026-02-01T01:00:00.000Z' })
  ]);
  // Ledger has a DUPLICATE entry for ticket 101 — counts must derive from tickets, not
  // ledger entries, so this must NOT inflate template 1's generated-ticket count.
  writeJson('process-template-triggers.json', [
    { triggerToken: 'manual-tok-SECRET-101', templateId: 1, ticketId: 101, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO },
    { triggerToken: 'manual-tok-SECRET-101-dup', templateId: 1, ticketId: 101, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO }
  ]);
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
    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const cookie = cookieFrom(login);

    // Snapshot every store + workspace AFTER boot (post startup normalization).
    const FILES = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'logs.json'];
    const before = {}; FILES.forEach(f => { before[f] = readRaw(f); });
    const wsBefore = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());

    // Render the state page (twice — repeated reads must also be inert).
    const page = await request('GET', '/process-templates', { cookie });
    assert(page.statusCode === 200, '/process-templates HTTP ' + page.statusCode);
    await request('GET', '/process-templates', { cookie });

    // ---- READ-ONLY INVARIANT: nothing changed ----
    FILES.forEach(f => assert(readRaw(f) === before[f], `${f} must be byte-identical after GET /process-templates (pure read)`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBefore, 'workspace must be unchanged after GET');
    // No ticket/run creation: counts on disk unchanged.
    assert(JSON.parse(before['tickets.json']).length === 8, 'precondition: 8 generated tickets seeded');
    assert(JSON.parse(readRaw('tickets.json')).length === 8, 'GET must not create tickets');
    assert(JSON.parse(readRaw('runs.json')).length === 0, 'GET must not create runs');
    // Scheduled "due" template 2: its nextRunAt must be unchanged (no scheduler tick occurred).
    assert(JSON.parse(readRaw('process-templates.json')).find(t => t.id === 2).schedule.nextRunAt === PAST, 'due template cursor must not advance during a render (no tick)');

    const b = page.body;
    const bn = b.replace(/\s+/g, ' '); // whitespace-normalized for prose copy checks
    // ---- Derived correctness in the rendered page ----
    // dueStatus surfacing.
    assert(b.includes('Due for ticket creation'), 'due scheduled template (2) shows due');
    assert(b.includes('Not due'), 'not-due scheduled template (5) shows not_due');
    assert(b.includes('Schedule paused'), 'a disabled-but-reusable schedule (3) shows schedule_paused');
    assert(b.includes('Invalid schedule'), 'invalid schedule template (4) shows invalid_schedule');
    assert(b.includes('Not scheduled'), 'manual-only template (1) shows unscheduled');
    assert(bn.includes('this template will not create scheduled tickets'), 'invalid schedule shows inline warning');
    assert(bn.includes('missed intervals are not backfilled'), 'due copy explains no catch-up');
    // No-catch-up / read-only copy present.
    assert(bn.includes('Schedules create tickets only.'), 'page states schedules create tickets only');
    assert(bn.includes('viewing it never creates a ticket'), 'page states the view is read-only');
    // healthStatus surfacing.
    assert(b.includes('Needs operator attention'), 'blocked/failed templates surface attention_needed');
    assert((b.match(/Needs operator attention/g) || []).length >= 2, 'both blocked (6) and failed (7) templates show attention');
    // Generated-ticket rollup + recent links with status.
    assert(b.includes('<a href="/tickets/101">#101</a>') && b.includes('<a href="/tickets/201">#201</a>'), 'recent generated tickets link to tickets');
    assert(/#601<\/a>\s*\(manual\)\s*—\s*blocked\s*·\s*objective_ambiguous/.test(b.replace(/\s+/g, ' ')), 'blocked generated ticket shows status + triage reason');
    assert(/for\s+/.test(b) && b.includes('(scheduled)'), 'scheduled recent entry shows scheduledFor and scheduled tag');

    // ---- Dedupe-proof counts: template 1 has 2 tickets despite a duplicate ledger entry ----
    // The page shows "2 total" for template 1's generated tickets, not 3.
    assert(/Manual only[\s\S]*?2 total/.test(b), 'template 1 generated count must be 2 tickets (ledger duplicate must not inflate)');
    // Pending / in-progress counts surface for template 8.
    assert(/Pending counts[\s\S]*?1 pending · 1 in progress/.test(b), 'template 8 shows pending + in-progress counts');

    // ---- Raw trigger tokens must not be prominent in the row ----
    assert(!b.includes('SECRET'), 'raw trigger tokens must not be rendered in the row');

    // ---- No autonomy/loop copy ----
    assert(!/running loop/i.test(b) && !/autonomous/i.test(b) && !/self-running/i.test(b), 'page must not imply autonomy');

    console.log('PASS: process-template state observability is correct and rendering is a pure read (no trigger, no mutation)');
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
