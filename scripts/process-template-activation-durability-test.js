#!/usr/bin/env node
// Durability hardening for process-template version activation (r1.12.2). Activation writes
// the append-only version store FIRST, then re-points the root template in a SEPARATE atomic
// write. A crash in that gap can leave root/store inconsistent. A startup reconciler converges
// the root to the store's single active version — the store is the source of truth (written
// first, immutable history). This test simulates partial-write states directly against temp
// DATA_DIR fixtures and proves the reconciler:
//   - leaves a consistent template unchanged,
//   - repairs a stale root forward to the single active version,
//   - never activates a draft, never demotes a root that is ahead, never picks among
//     multiple actives, and refuses when no active version exists,
//   - is idempotent, never rewrites tickets/runs/ledger, never touches the schedule cursor,
//     and keeps scheduled trigger tokens version-free.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3497';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-durability-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-durability-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function templates() { return readJsonData('process-templates.json'); }
function templateById(id) { return templates().find(t => t.id === id); }
function versions() { return readJsonData('process-template-versions.json'); }
function versionById(id) { return versions().find(v => v.id === id); }
function logsOfType(type) { return readJsonData('logs.json').filter(l => l.type === type); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

// ---- fixture builders (mirror the shapes the server reads/writes) ----
function content(objective) {
  return { objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null,
    capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null,
    ownedOutputPaths: null, executionPolicy: { maxAttempts: null } };
}
function ver(templateId, version, status, objective) {
  return { id: `ptv_${templateId}_${version}`, templateId, version, status, name: `T${templateId}`,
    ticketTemplate: content(objective), executionPolicy: { maxAttempts: null },
    createdBy: 'admin', createdAt: ISO,
    activatedBy: status === 'active' ? 'admin' : null, activatedAt: status === 'active' ? ISO : null,
    supersedesVersionId: null, changeSummary: null };
}
function root(id, currentVersion, currentVersionId, objective, schedule) {
  return { id, name: `T${id}`, version: currentVersion, currentVersion, currentVersionId,
    enabled: true, triggerType: 'manual', schedule: schedule || null, ticketTemplate: content(objective),
    createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null };
}

// A PAUSED schedule with cursor values that reconciliation must leave byte-identical.
const PAUSED_SCHEDULE = { enabled: false, kind: 'interval', everySeconds: 86400, anchor: ISO,
  nextRunAt: null, lastScheduledTriggerAt: '2026-01-15T00:00:00.000Z', timezone: 'UTC', scheduledBy: 'admin' };

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []);
  writeJson('logs.json', []); writeJson('runs.json', []);

  // Templates, each encoding one consistency scenario.
  writeJson('process-templates.json', [
    // 1: CLEAN — root matches the single active v1.
    root(1, 1, 'ptv_1_1', 'c1'),
    // 2: CRASH WINDOW — store already activated v2 (v1 superseded), root still points to v1.
    root(2, 1, 'ptv_2_1', 'c2v1'),
    // 3: ROOT AHEAD — root points to v2 (a draft) but the store's active version is still v1.
    root(3, 2, 'ptv_3_2', 'c3v2'),
    // 4: MULTIPLE ACTIVE — split-brain store with two active records.
    root(4, 2, 'ptv_4_2', 'c4v2'),
    // 5: NO ACTIVE — store has only a superseded v1 + draft v2 (no active record).
    root(5, 1, 'ptv_5_1', 'c5v1'),
    // 6: LEGACY — no version records at all (never versioned).
    root(6, 1, null, 'c6'),
    // 7: CRASH WINDOW + PAUSED SCHEDULE — repair must finish, schedule cursor must be preserved.
    root(7, 1, 'ptv_7_1', 'c7v1', { ...PAUSED_SCHEDULE })
  ]);
  writeJson('process-template-versions.json', [
    ver(1, 1, 'active', 'c1'),
    ver(2, 1, 'superseded', 'c2v1'), ver(2, 2, 'active', 'c2v2'),
    ver(3, 1, 'active', 'c3v1'), ver(3, 2, 'draft', 'c3v2'),
    ver(4, 1, 'active', 'c4v1'), ver(4, 2, 'active', 'c4v2'),
    ver(5, 1, 'superseded', 'c5v1'), ver(5, 2, 'draft', 'c5v2'),
    // (template 6 intentionally has no records)
    ver(7, 1, 'superseded', 'c7v1'), ver(7, 2, 'active', 'c7v2')
  ]);

  // A legacy generated ticket (pre-r1.10, no templateVersion) + an r1.10 versioned ticket —
  // reconciliation must never rewrite either, and never create/run anything.
  writeJson('tickets.json', [
    { id: 50, objective: 'legacy', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
      executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
      executionPolicy: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' },
      status: 'completed', createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
      source: { type: 'process_template', templateId: 2, templateName: 'T2', triggeredBy: 'admin', triggerType: 'manual', triggerRunId: null, triggerToken: 'legacy-50', createdAt: ISO } },
    { id: 51, objective: 'v1 generated', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
      executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
      executionPolicy: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' },
      status: 'completed', createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
      source: { type: 'process_template', templateId: 2, templateName: 'T2', templateVersion: 1, triggeredBy: 'admin', triggerType: 'manual', triggerRunId: null, triggerToken: 'gen-51', createdAt: ISO } }
  ]);
  writeJson('process-template-triggers.json', [
    { triggerToken: 'legacy-50', templateId: 2, templateName: 'T2', ticketId: 50, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO },
    { triggerToken: 'gen-51', templateId: 2, templateName: 'T2', templateVersion: 1, ticketId: 51, triggeredBy: 'admin', triggerType: 'manual', createdAt: ISO,
      ticketTemplateSnapshot: content('c2v1'), executionPolicyUsed: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' } }
  ]);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => { if (server.exitCode !== null) return reject(new Error('server exited early')); http.get(BASE_URL + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); }).on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); };
    setTimeout(poll, 400);
  });
}
function boot() {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = ''; server.stdout.on('data', c => { out += String(c); }); server.stderr.on('data', c => { out += String(c); });
  server._out = () => out;
  return waitForReady();
}
async function kill() { if (server) { server.kill('SIGTERM'); await sleep(300); if (server.exitCode === null) server.kill('SIGKILL'); server = null; } }
async function loginAs(u) { const res = await request('POST', '/login', { form: { username: u, password: 'admin123' } }); assert(res.statusCode === 302, `login ${u} ${res.statusCode}`); return cookieFrom(res); }

async function main() {
  seed();
  const fixtureVersions = readRaw('process-template-versions.json');
  const fixtureLedger = readRaw('process-template-triggers.json');
  const wsStart = ws();

  // ===== Boot 1: reconciliation runs at startup, before listen =====
  await boot();
  try {
    // --- 1: CLEAN consistent template is untouched (no repair, no log). ---
    const t1 = templateById(1);
    assert(t1.currentVersion === 1 && t1.currentVersionId === 'ptv_1_1' && t1.version === 1 && t1.ticketTemplate.objective === 'c1', 'clean template 1 unchanged');
    assert(!logsOfType('process_template:version_consistency_repaired').some(l => l.templateId === 1), 'clean template 1 produced no repair log');

    // --- 2: CRASH WINDOW — stale root repaired forward to the single active v2. ---
    const t2 = templateById(2);
    assert(t2.currentVersion === 2 && t2.currentVersionId === 'ptv_2_2' && t2.version === 2, 'template 2 root repaired to active v2');
    assert(t2.ticketTemplate.objective === 'c2v2', 'template 2 root content repaired to v2');
    assert(t2.updatedBy === 'system', 'repair stamps updatedBy system');
    assert(logsOfType('process_template:version_consistency_repaired').some(l => l.templateId === 2 && l.toVersion === 2 && l.fromVersion === 1), 'template 2 repair audit log written');
    // The version records themselves are never rewritten by reconciliation.
    assert(versionById('ptv_2_1').status === 'superseded' && versionById('ptv_2_2').status === 'active', 'template 2 version records unchanged by reconciliation');

    // --- 3: ROOT AHEAD — root points to a draft v2 while active is v1: refuse, never activate the draft. ---
    const t3 = templateById(3);
    assert(t3.currentVersion === 2 && t3.currentVersionId === 'ptv_3_2', 'template 3 root left unchanged (ambiguous, root ahead)');
    assert(versionById('ptv_3_2').status === 'draft', 'template 3 draft v2 is NOT activated by reconciliation');
    assert(versionById('ptv_3_1').status === 'active', 'template 3 active v1 unchanged');
    assert(logsOfType('process_template:version_consistency_unresolved').some(l => l.templateId === 3 && l.reason === 'root_ahead_of_store'), 'template 3 unresolved (root_ahead_of_store) logged');

    // --- 4: MULTIPLE ACTIVE — refuse repair, change nothing. ---
    const t4 = templateById(4);
    assert(t4.currentVersion === 2 && t4.currentVersionId === 'ptv_4_2', 'template 4 root left unchanged (multiple active)');
    assert(versionById('ptv_4_1').status === 'active' && versionById('ptv_4_2').status === 'active', 'template 4 both active records left intact (no guessing)');
    assert(logsOfType('process_template:version_consistency_unresolved').some(l => l.templateId === 4 && l.reason === 'multiple_active_versions'), 'template 4 unresolved (multiple_active_versions) logged');

    // --- 5: NO ACTIVE — refuse repair, draft stays draft. ---
    const t5 = templateById(5);
    assert(t5.currentVersion === 1 && t5.currentVersionId === 'ptv_5_1', 'template 5 root left unchanged (no active version)');
    assert(versionById('ptv_5_2').status === 'draft', 'template 5 draft v2 is NOT activated');
    assert(logsOfType('process_template:version_consistency_unresolved').some(l => l.templateId === 5 && l.reason === 'no_active_version'), 'template 5 unresolved (no_active_version) logged');

    // --- 6: LEGACY — no version records: preserved exactly, no reconciliation log. ---
    const t6 = templateById(6);
    assert(t6.currentVersion === 1 && t6.currentVersionId === null && t6.ticketTemplate.objective === 'c6', 'legacy template 6 unchanged');
    assert(!logsOfType('process_template:version_consistency_repaired').some(l => l.templateId === 6) &&
           !logsOfType('process_template:version_consistency_unresolved').some(l => l.templateId === 6), 'legacy template 6 produced no consistency log');

    // --- 7: CRASH WINDOW + PAUSED SCHEDULE — repaired to v2, schedule cursor byte-identical. ---
    const t7 = templateById(7);
    assert(t7.currentVersion === 2 && t7.currentVersionId === 'ptv_7_2' && t7.ticketTemplate.objective === 'c7v2', 'template 7 root repaired to v2');
    assert(JSON.stringify(t7.schedule) === JSON.stringify(PAUSED_SCHEDULE), 'template 7 schedule cursor (nextRunAt/lastScheduledTriggerAt) is unchanged by repair');

    // --- Global invariants: the version store is never written; tickets/runs/ledger/workspace untouched. ---
    assert(readRaw('process-template-versions.json') === fixtureVersions, 'version store is never rewritten by reconciliation (byte-identical)');
    assert(readRaw('process-template-triggers.json') === fixtureLedger, 'trigger ledger is never rewritten by reconciliation (byte-identical)');
    const allTickets = readJsonData('tickets.json');
    assert(allTickets.length === 2, 'reconciliation creates no ticket');
    assert(readJsonData('runs.json').length === 0, 'reconciliation creates no run');
    assert(ws() === wsStart, 'reconciliation mutates no workspace files');
    // Old generated tickets keep their provenance / templateVersion.
    const tk50 = allTickets.find(t => t.id === 50); const tk51 = allTickets.find(t => t.id === 51);
    assert(tk50.source.triggerToken === 'legacy-50' && tk50.source.templateVersion === undefined, 'legacy ticket #50 provenance unchanged (no version)');
    assert(tk51.source.templateVersion === 1 && tk51.source.triggerToken === 'gen-51', 'v1 generated ticket #51 retains source.templateVersion 1');

    // Ticket detail still renders (timeline behavior unaffected by reconciliation).
    const cookie = await loginAs('admin');
    const detail51 = await request('GET', '/tickets/51', { cookie });
    assert(detail51.statusCode === 200, 'ticket detail still renders after reconciliation');

    var P1 = readRaw('process-templates.json'); // post-repair snapshot for idempotency.
  } catch (error) {
    process.stderr.write(server._out());
    throw error;
  } finally {
    await kill();
  }

  // ===== Boot 2: reconciliation is idempotent — a re-run makes no change =====
  await boot();
  try {
    assert(readRaw('process-templates.json') === P1, 'reconciliation is idempotent: second boot makes no further change to the root store');
    assert(readRaw('process-template-versions.json') === fixtureVersions, 'second boot still never rewrites the version store');

    // ---- Scheduled trigger after a repaired activation keeps a VERSION-FREE token + v2 content. ----
    const cookie = await loginAs('admin');
    const SLOT = '2020-06-01T00:00:00.000Z';
    var store = templates();
    var s7 = store.find(t => t.id === 7);
    s7.schedule.enabled = true; s7.schedule.nextRunAt = SLOT; // resume + make due (direct, deterministic)
    writeJson('process-templates.json', store);
    const before = readJsonData('tickets.json').filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 7).length;
    const tick = await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(tick.statusCode === 200, 'scheduler tick ok: ' + tick.body);
    const sched = readJsonData('tickets.json').filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 7).sort((a, b) => b.id - a.id)[0];
    assert(sched && before === 0, 'one scheduled ticket created for the repaired template');
    assert(sched.source.templateVersion === 2, 'scheduled ticket after repair uses the active v2 (root drives future tickets)');
    assert(sched.objective === 'c7v2', 'scheduled ticket uses repaired v2 content');
    assert(sched.source.triggerToken === `schedule:7:${SLOT}`, 'scheduled token is schedule:<templateId>:<scheduledForIso> — version-free');
    assert(!/version|versionId|ptv_/i.test(sched.source.triggerToken), 'scheduled token includes no version/versionId');
  } catch (error) {
    process.stderr.write(server._out());
    throw error;
  } finally {
    await kill();
  }

  console.log('PASS: activation durability — root reconciles to the single active version, refuses ambiguous states, never activates drafts, idempotent, ledger/schedules/tokens preserved');
}

main()
  .then(() => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); })
  .catch(error => { fs.rmSync(DATA_DIR, { recursive: true, force: true }); fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true }); console.error(error.stack || error.message); process.exit(1); });
