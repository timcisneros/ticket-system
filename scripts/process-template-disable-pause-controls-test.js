#!/usr/bin/env node
// Template disable/enable + schedule pause/resume controls (r1.9). These are thin
// operator controls over the EXISTING enabled gates: disabling a template makes the
// manual route's 409 and the scheduler's template.enabled skip reachable; pausing a
// schedule is schedule.enabled=false (already skipped by the unchanged due filter);
// resume recomputes nextRunAt forward from now (no catch-up, no immediate ticket).
// They never touch existing tickets/runs/ledger/provenance. The scheduler is driven
// deterministically through the manage-gated scan-tick endpoint (no wall-clock sleeps).

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3496';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ctrl-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ctrl-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function schedTicketCount() { return tickets().filter(t => t.source && t.source.triggerType === 'schedule').length; }
function schedCountFor(id) { return tickets().filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === id).length; }
function templateById(id) { return readJsonData('process-templates.json').find(t => t.id === id); }
function logsOfType(type) { return readJsonData('logs.json').filter(l => l.type === type); }

const PAST = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
const PAST2 = new Date(Date.now() - 5 * 3600 * 1000).toISOString();

function sched(nextRunAt) { return { enabled: true, kind: 'interval', everySeconds: 3600, anchor: ISO, nextRunAt, lastScheduledTriggerAt: '2026-01-01T00:00:00.000Z', timezone: 'UTC', scheduledBy: 'admin' }; }
function tmpl(id, name, schedule) {
  return { id, name, enabled: true, triggerType: 'manual', schedule: schedule || null,
    ticketTemplate: { objective: 'Create folder t' + id, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null, ownedOutputPaths: null, executionPolicy: { maxAttempts: null } },
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'manager', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false },
    { id: 2, name: 'Managers', permissions: ['processTemplate:manage', 'ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []);
  writeJson('process-templates.json', [
    tmpl(1, 'Disable target', sched(PAST)),  // scheduled + due
    tmpl(2, 'Pause target', sched(PAST2)),   // scheduled + due
    tmpl(3, 'No schedule', null)             // unscheduled (for 400 tests)
  ]);
  // A pre-existing generated ticket + run that must remain untouched by controls.
  writeJson('tickets.json', [{
    id: 101, objective: 'prior', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
      allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
    },
    workTypeSnapshot: null, workTypeId: null, triage: null,
    status: 'completed', createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
    source: { type: 'process_template', templateId: 1, templateName: 'Disable target', triggeredBy: 'admin', triggerType: 'manual', triggerRunId: null, triggerToken: 'prior-101', createdAt: ISO }
  }]);
  writeJson('runs.json', [{
    id: 9101, ticketId: 101, agentId: 1, agentName: 'A', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main',
    allocationPlanId: null, allocationItemId: null, ownedOutputPaths: [], allocationSubtask: null,
    executionMode: 'agent', workflowId: null, workflowInput: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicySnapshot: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
      allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
    },
    runtimeLimitsSnapshot: null, verificationContractSnapshot: null, workTypeSnapshot: null, workTypeId: null,
    currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null, currentStepId: null, currentWorkflowAction: null, lastHeartbeatAt: null,
    runEvaluation: null, runConsequence: null, triage: null, replaySnapshotPath: null, replaySummary: null,
    status: 'completed', createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO
  }]);
  writeJson('process-template-triggers.json', [{ triggerToken: 'prior-101', templateId: 1, ticketId: 101, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO }]);
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
const POST = (cookie, url, json) => request('POST', url, { cookie, json: json || {} });
const tick = (cookie) => request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
const trigger = (cookie, id, tok) => request('POST', `/api/process-templates/${id}/trigger`, { cookie, json: { triggerToken: tok } });

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
    const manager = await loginAs('manager');

    const ticket101Before = JSON.stringify(tickets().find(t => t.id === 101));
    const run9101Before = JSON.stringify(readJsonData('runs.json').find(r => r.id === 9101));
    const ledgerBefore = readRaw('process-template-triggers.json');

    // ===== Template DISABLE + Schedule PAUSE, then prove neither fires on a scan =====
    const dis = await POST(admin, '/api/process-templates/1/disable');
    assert(dis.statusCode === 200 && dis.json.enabled === false, 'disable returns ok + enabled false');
    assert(templateById(1).enabled === false, 'template.enabled becomes false');
    assert(logsOfType('process_template:disabled').some(l => l.templateId === 1 && l.changedBy === 'admin'), 'process_template:disabled log written with changedBy');

    const pause = await POST(admin, '/api/process-templates/2/schedule/pause');
    assert(pause.statusCode === 200 && pause.json.schedule.enabled === false, 'pause returns ok + schedule.enabled false');
    const p2 = templateById(2).schedule;
    assert(p2.enabled === false && p2.nextRunAt === null, 'pause sets enabled false + nextRunAt null');
    assert(p2.everySeconds === 3600 && p2.kind === 'interval' && p2.timezone === 'UTC' && p2.scheduledBy === 'admin' && p2.lastScheduledTriggerAt === '2026-01-01T00:00:00.000Z', 'pause preserves everySeconds/kind/timezone/scheduledBy/lastScheduledTriggerAt');
    assert(logsOfType('process_template:schedule_paused').some(l => l.templateId === 2 && l.changedBy === 'admin'), 'process_template:schedule_paused log written');

    // One scan: template 1 (disabled) and template 2 (paused) must BOTH be skipped;
    // template 3 has no schedule. So no scheduled ticket is created at all.
    assert(schedTicketCount() === 0, 'precondition: no scheduled tickets yet');
    await tick(admin);
    assert(schedTicketCount() === 0, 'scheduled scan must not create a ticket for a disabled or paused template');

    // Manual trigger now 409 on the disabled template; still works on the paused one.
    assert((await trigger(admin, 1, 'm1')).statusCode === 409, 'manual trigger on disabled template returns 409');
    const manualWhilePaused = await trigger(admin, 2, 'm2-paused');
    assert(manualWhilePaused.statusCode === 200 && manualWhilePaused.json.ok, 'manual trigger still works while schedule is paused');

    // Existing ticket/run/ledger/provenance unchanged by the controls (the only ledger
    // growth is the m2-paused MANUAL ticket, not any control op).
    assert(JSON.stringify(tickets().find(t => t.id === 101)) === ticket101Before, 'existing generated ticket unchanged by controls');
    assert(JSON.stringify(readJsonData('runs.json').find(r => r.id === 9101)) === run9101Before, 'pre-existing run unchanged by controls (manual trigger may add its own run via the normal path)');
    assert(readJsonData('process-template-triggers.json').filter(e => e.triggerToken === 'm2-paused').length === 1 &&
           !readJsonData('process-template-triggers.json').some(e => /pause|resume|disable|enable/.test(e.triggerType || '')), 'controls do not pollute the trigger ledger');
    void ledgerBefore;

    // 400 when no reusable schedule; idempotent repeats.
    assert((await POST(admin, '/api/process-templates/3/schedule/pause')).statusCode === 400, 'pause with no reusable schedule returns 400');
    assert((await POST(admin, '/api/process-templates/2/schedule/pause')).statusCode === 200, 'repeated pause is safe');
    assert((await POST(admin, '/api/process-templates/1/disable')).statusCode === 200, 'repeated disable is safe');

    // ===== Template ENABLE (manage + ticket:create) =====
    assert((await POST(manager, '/api/process-templates/1/enable')).statusCode === 403, 'enable requires ticket:create (manager 403)');
    const ticketsBeforeEnable = tickets().length;
    const en = await POST(admin, '/api/process-templates/1/enable');
    assert(en.statusCode === 200 && en.json.enabled === true, 'admin enable returns ok');
    assert(templateById(1).enabled === true, 'template.enabled becomes true');
    assert(tickets().length === ticketsBeforeEnable, 'enable must not create a ticket');
    assert(logsOfType('process_template:enabled').some(l => l.templateId === 1 && l.changedBy === 'admin'), 'process_template:enabled log written');
    // Manual trigger works again.
    const reTrig = await trigger(admin, 1, 'm1-after-enable');
    assert(reTrig.statusCode === 200 && reTrig.json.ok, 'manual trigger works after enable');

    // ===== Schedule RESUME (manage + ticket:create) =====
    assert((await POST(manager, '/api/process-templates/2/schedule/resume')).statusCode === 403, 'resume requires ticket:create (manager 403)');
    // Counts are template-2-specific to isolate from template 1's own active schedule.
    const sched2BeforeResume = schedCountFor(2);
    const resume = await POST(admin, '/api/process-templates/2/schedule/resume');
    assert(resume.statusCode === 200 && resume.json.schedule.enabled === true, 'resume returns ok + schedule.enabled true');
    const r2 = templateById(2).schedule;
    assert(Date.parse(r2.nextRunAt) > Date.now(), 'resume recomputes nextRunAt forward from now');
    assert(r2.nextRunAt !== PAST2, 'resume does not preserve the stale overdue nextRunAt');
    assert(r2.everySeconds === 3600 && r2.kind === 'interval' && r2.timezone === 'UTC', 'resume preserves interval config');
    // Immediate scan after resume creates NO ticket for template 2 (nextRunAt is in the future).
    await tick(admin);
    assert(schedCountFor(2) === sched2BeforeResume, 'resume must not create an immediate scheduled ticket');
    assert(logsOfType('process_template:schedule_resumed').some(l => l.templateId === 2 && l.changedBy === 'admin'), 'process_template:schedule_resumed log written');
    // 400 / idempotency.
    assert((await POST(admin, '/api/process-templates/3/schedule/resume')).statusCode === 400, 'resume with no reusable schedule returns 400');
    const reResume = await POST(admin, '/api/process-templates/2/schedule/resume');
    assert(reResume.statusCode === 200, 'repeated resume is safe');
    await tick(admin);
    assert(schedCountFor(2) === sched2BeforeResume, 'repeated resume still creates no immediate ticket');

    // Later due scan: simulate the interval elapsing → exactly one scheduled ticket.
    var store = readJsonData('process-templates.json');
    store.find(t => t.id === 2).schedule.nextRunAt = PAST2; // make it due again
    writeJson('process-templates.json', store);
    await tick(admin);
    assert(schedCountFor(2) === sched2BeforeResume + 1, 'a later due scan creates exactly one ticket through the existing scheduled path');

    // ===== 404 on missing template for every control =====
    for (const url of ['/api/process-templates/9999/disable', '/api/process-templates/9999/enable', '/api/process-templates/9999/schedule/pause', '/api/process-templates/9999/schedule/resume']) {
      assert((await POST(admin, url)).statusCode === 404, `missing template -> 404 for ${url}`);
    }

    // ===== GET /process-templates remains read-only across a render =====
    const FILES = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'logs.json'];
    const snap = {}; FILES.forEach(f => { snap[f] = readRaw(f); });
    const wsSnap = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const page = await request('GET', '/process-templates', { cookie: admin });
    assert(page.statusCode === 200, 'state page renders');
    FILES.forEach(f => assert(readRaw(f) === snap[f], `${f} unchanged by GET /process-templates`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsSnap, 'workspace unchanged by GET');

    // r1.8 state surfaces paused (template 2 is paused at this point? it was resumed; pause template 3 has no schedule).
    // Pause template 1's... actually template 1 has a due schedule + enabled; pause it to show schedule_paused.
    await POST(admin, '/api/process-templates/1/schedule/pause');
    const page2 = await request('GET', '/process-templates', { cookie: admin });
    assert(page2.body.includes('Schedule paused'), 'paused template shows "Schedule paused" due badge');
    assert(page2.body.includes('Resume scheduled ticket creation'), 'paused template offers a Resume control');
    assert(/badge--health-paused/.test(page2.body), 'paused template shows paused health badge');
    assert(!/running loop/i.test(page2.body) && !/autonomous/i.test(page2.body), 'page must not imply autonomy');

    console.log('PASS: template disable/enable + schedule pause/resume stop and resume future tickets safely, with no effect on existing tickets/runs/ledger');
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
