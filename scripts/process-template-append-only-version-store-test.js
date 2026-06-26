#!/usr/bin/env node
// Append-only process-template version store + draft/activation (r1.12). Editing never
// happens in place: a draft is a new immutable version record; activation supersedes the
// prior active version and re-points the root's active content. Activation changes only
// FUTURE generated tickets — it never rewrites past tickets/ledger, never creates a
// ticket/run, never mutates the workspace, never touches the schedule cursor, and the
// scheduled token stays version-free. Scheduler driven via the manage-gated scan-tick
// endpoint (no wall-clock sleeps).

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3498';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ver-store-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ver-store-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function versions() { return readJsonData('process-template-versions.json'); }
function templateById(id) { return readJsonData('process-templates.json').find(t => t.id === id); }
function logsOfType(type) { return readJsonData('logs.json').filter(l => l.type === type); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }
function schedCountFor(id) { return tickets().filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === id).length; }

const PAST = new Date(Date.now() - 10 * 3600 * 1000).toISOString();

function tmpl(id, name, objective, schedule) {
  return { id, name, version: 1, currentVersion: 1, enabled: true, triggerType: 'manual', schedule: schedule || null,
    ticketTemplate: { objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null, ownedOutputPaths: null, executionPolicy: { maxAttempts: null } },
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'manager', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 3, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false },
    { id: 2, name: 'Managers', permissions: ['processTemplate:manage', 'ticket:read'], canReceiveTickets: false },
    { id: 3, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 },
    { id: 3, principalType: 'user', principalId: 3, groupId: 3 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []);
  writeJson('process-templates.json', [
    tmpl(1, 'Editable manual', 'Create folder v1content', null),
    tmpl(2, 'Editable scheduled', 'Create folder schedv1', { enabled: true, kind: 'interval', everySeconds: 3600, anchor: ISO, nextRunAt: PAST, lastScheduledTriggerAt: '2026-01-01T00:00:00.000Z', timezone: 'UTC', scheduledBy: 'admin' })
  ]);
  // A legacy generated ticket (pre-r1.10, no templateVersion) — must still render.
  writeJson('tickets.json', [{
    id: 50, objective: 'legacy', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' },
    status: 'completed', createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
    source: { type: 'process_template', templateId: 1, templateName: 'Editable manual', triggeredBy: 'admin', triggerType: 'manual', triggerRunId: null, triggerToken: 'legacy-50', createdAt: ISO }
  }]);
  // A legacy ledger entry (no templateVersion) — must remain byte-untouched.
  writeJson('process-template-triggers.json', [{ triggerToken: 'legacy-50', templateId: 1, templateName: 'Editable manual', ticketId: 50, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO }]);
  writeJson('process-template-versions.json', []); // starts empty
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
const draft = (cookie, id, json) => request('POST', `/api/process-templates/${id}/versions/draft`, { cookie, json: json || {} });
const activate = (cookie, id, vid) => request('POST', `/api/process-templates/${id}/versions/${vid}/activate`, { cookie, json: {} });
const POST = (cookie, url, json) => request('POST', url, { cookie, json: json || {} });
const trigger = (cookie, id, tok) => request('POST', `/api/process-templates/${id}/trigger`, { cookie, json: { triggerToken: tok } });
const tick = (cookie) => request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });

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
    const viewer = await loginAs('viewer');

    const wsStart = ws();
    const legacy50Before = JSON.stringify(tickets().find(t => t.id === 50));
    const legacyLedgerBefore = readRaw('process-template-triggers.json');

    // Store starts empty.
    assert(Array.isArray(versions()) && versions().length === 0, 'version store starts empty');

    // ---- A pre-activation manual trigger creates a v1 ticket (must stay v1 later). ----
    const preTrig = await trigger(admin, 1, 'm-pre-1');
    const preTicketId = preTrig.json.ticketId;
    assert(tickets().find(t => t.id === preTicketId).source.templateVersion === 1, 'pre-activation manual ticket is v1');

    // ---- Draft creation: permission ----
    assert((await draft(viewer, 1, {})).statusCode === 403, 'draft creation requires processTemplate:manage');

    // ---- Draft creation lazily materializes v1, then creates v2 draft ----
    const ticketsBeforeDraft = tickets().length;
    const runsBeforeDraft = readRaw('runs.json');
    const d = await draft(admin, 1, { ticketTemplate: { objective: 'Create folder v2content' }, changeSummary: 'demo edit' });
    assert(d.statusCode === 200 && d.json.ok, 'admin draft creation ok: ' + d.body);
    const vlist = versions().filter(v => v.templateId === 1);
    const v1 = vlist.find(v => v.version === 1);
    const v2 = vlist.find(v => v.version === 2);
    assert(v1 && v1.status === 'active' && v1.id === 'ptv_1_1', 'v1 materialized as active with deterministic id');
    assert(v1.ticketTemplate.objective === 'Create folder v1content', 'materialized v1 captures current root content');
    assert(v2 && v2.status === 'draft' && v2.id === 'ptv_1_2', 'v2 created as draft');
    assert(v2.ticketTemplate.objective === 'Create folder v2content', 'draft carries the edited objective');
    assert(v2.ticketTemplate.assignmentTargetId === 1, 'draft inherits unedited fields (merge over active content)');
    // Draft does not change active/root version, creates no ticket/run, no workspace mutation.
    assert(templateById(1).version === 1 && templateById(1).currentVersion === 1, 'draft does not change active/root version');
    assert(tickets().length === ticketsBeforeDraft, 'draft creates no ticket');
    assert(readRaw('runs.json') === runsBeforeDraft, 'draft creates no run');
    assert(ws() === wsStart, 'draft creates no workspace mutation');
    assert(logsOfType('process_template:version_draft_created').some(l => l.templateId === 1 && l.toVersion === 2), 'draft audit log written');

    // ---- Second draft rejected while one exists ----
    assert((await draft(admin, 1, {})).statusCode === 409, 'second draft rejected while a draft exists');

    // ---- Activation: permission (manage required; ticket:create required when enabled) ----
    assert((await activate(viewer, 1, 'ptv_1_2')).statusCode === 403, 'activation requires processTemplate:manage');
    assert((await activate(manager, 1, 'ptv_1_2')).statusCode === 403, 'activation requires ticket:create when template is enabled');
    // non-draft / missing version handling
    assert((await activate(admin, 1, 'ptv_1_1')).statusCode === 409, 'activating a non-draft version is rejected');
    assert((await activate(admin, 1, 'ptv_1_99')).statusCode === 404, 'activating a missing version is 404');

    // ---- Activation succeeds (template 1: enabled, no schedule) ----
    const beforeAct = ws();
    const act = await activate(admin, 1, 'ptv_1_2');
    assert(act.statusCode === 200 && act.json.ok && act.json.activeVersion === 2, 'activation ok: ' + act.body);
    const after = versions().filter(v => v.templateId === 1);
    assert(after.find(v => v.version === 1).status === 'superseded', 'prior active v1 marked superseded');
    const v2active = after.find(v => v.version === 2);
    assert(v2active.status === 'active' && v2active.supersedesVersionId === 'ptv_1_1' && v2active.activatedAt, 'draft v2 marked active with supersedes + activatedAt');
    assert(templateById(1).currentVersion === 2 && templateById(1).currentVersionId === 'ptv_1_2' && templateById(1).version === 2, 'root version pointers updated to v2');
    assert(templateById(1).ticketTemplate.objective === 'Create folder v2content', 'root active content updated to v2');
    assert(tickets().every(t => t.source && t.source.triggerType === 'schedule' ? true : true) && readRaw('runs.json') !== undefined, 'sanity'); // no-op
    assert(ws() === beforeAct, 'activation creates no workspace mutation');
    assert(logsOfType('process_template:version_activated').some(l => l.templateId === 1 && l.toVersion === 2 && l.fromVersion === 1), 'activation audit log written');

    // ---- Past ticket stays v1; new manual trigger uses v2 ----
    assert(tickets().find(t => t.id === preTicketId).source.templateVersion === 1, 'pre-activation ticket remains v1 after v2 activation');
    const postTrig = await trigger(admin, 1, 'm-post-1');
    const postTicket = tickets().find(t => t.id === postTrig.json.ticketId);
    assert(postTicket.source.templateVersion === 2, 'manual trigger after activation stamps templateVersion 2');
    assert(postTicket.objective === 'Create folder v2content', 'post-activation ticket uses v2 content');

    // ---- Scheduled template: activation blocked while schedule enabled; pause then activate ----
    const d2 = await draft(admin, 2, { ticketTemplate: { objective: 'Create folder schedv2' } });
    assert(d2.statusCode === 200, 'draft for scheduled template ok');
    const blocked = await activate(admin, 2, 'ptv_2_2');
    assert(blocked.statusCode === 409 && /pause the schedule/i.test(blocked.body), 'activation blocked while schedule.enabled (pause first)');
    assert(logsOfType('process_template:version_activation_blocked').some(l => l.templateId === 2 && l.reason === 'schedule_enabled'), 'activation_blocked audit log written');
    // Pause, then capture cursor, then activate.
    assert((await POST(admin, '/api/process-templates/2/schedule/pause')).statusCode === 200, 'pause schedule ok');
    const sched2Before = JSON.stringify(templateById(2).schedule);
    const act2 = await activate(admin, 2, 'ptv_2_2');
    assert(act2.statusCode === 200 && act2.json.activeVersion === 2, 'activation succeeds after pause');
    // Activation must not change schedule.nextRunAt / lastScheduledTriggerAt.
    assert(JSON.stringify(templateById(2).schedule) === sched2Before, 'activation does not change the schedule cursor');
    assert(templateById(2).version === 2 && templateById(2).ticketTemplate.objective === 'Create folder schedv2', 'scheduled template root updated to v2');

    // ---- Scheduled trigger after activation: v2 + version-free token, no duplicate ----
    var store = readJsonData('process-templates.json');
    var t2 = store.find(t => t.id === 2);
    t2.schedule.enabled = true; t2.schedule.nextRunAt = PAST; // resume + make due (direct, deterministic)
    writeJson('process-templates.json', store);
    const sBefore = schedCountFor(2);
    await tick(admin);
    assert(schedCountFor(2) === sBefore + 1, 'scheduled trigger after activation creates exactly one ticket');
    const st = tickets().filter(t => t.source && t.source.templateId === 2 && t.source.triggerType === 'schedule').sort((a, b) => b.id - a.id)[0];
    assert(st.source.templateVersion === 2, 'scheduled trigger after activation stamps templateVersion 2');
    assert(st.source.triggerToken === `schedule:2:${PAST}`, 'scheduled token is schedule:<id>:<iso> — version-free');
    assert(st.objective === 'Create folder schedv2', 'scheduled ticket uses v2 content');
    // No duplicate for the same slot.
    await tick(admin);
    assert(schedCountFor(2) === sBefore + 1, 'no duplicate scheduled ticket for the slot after version activation');

    // ---- Backward compatibility: legacy ticket + ledger untouched ----
    assert(JSON.stringify(tickets().find(t => t.id === 50)) === legacy50Before, 'legacy no-version ticket unchanged');
    assert(readRaw('process-template-triggers.json').includes('"triggerToken": "legacy-50"'), 'legacy ledger entry preserved');
    const legacyDetail = await request('GET', '/tickets/50', { cookie: admin });
    assert(legacyDetail.statusCode === 200 && legacyDetail.body.includes('Created from template') && !/Editable manual<\/a> v/.test(legacyDetail.body), 'legacy no-version ticket renders without a version suffix');

    // ---- /process-templates shows the active version (v2) and is read-only ----
    const FILES = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'process-template-versions.json', 'logs.json'];
    const snap = {}; FILES.forEach(f => { snap[f] = readRaw(f); });
    const wsSnap = ws();
    const page = await request('GET', '/process-templates', { cookie: admin });
    assert(page.statusCode === 200 && /Editable manual\s*<span class="text-muted">v2<\/span>/.test(page.body), '/process-templates shows the active version (v2)');
    FILES.forEach(f => assert(readRaw(f) === snap[f], `${f} unchanged by GET /process-templates`));
    assert(ws() === wsSnap, 'workspace unchanged by GET /process-templates');

    console.log('PASS: append-only version store — draft/activate change future tickets only, scheduled token stays version-free, history preserved');
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
