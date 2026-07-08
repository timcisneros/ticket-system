#!/usr/bin/env node
// Process-template version provenance (r1.10 groundwork). Every generated ticket and
// trigger-ledger entry records the ACTIVE template version used (absent version → 1,
// lazy backward-compat). The scheduled idempotency token stays version-free, so a
// version change before a due slot cannot mint a duplicate ticket for that slot — the
// created ticket simply records whichever version was active at trigger time. No edit
// route, no versions store, no token-shape change. Scheduler driven via the manage-
// gated scan-tick endpoint (no wall-clock sleeps).

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ver-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-ver-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function ledger() { return readJsonData('process-template-triggers.json'); }
function ticketBySource(templateId, triggerType) { return tickets().find(t => t.source && t.source.templateId === templateId && t.source.triggerType === triggerType); }

const PAST = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
const PAST2 = new Date(Date.now() - 5 * 3600 * 1000).toISOString();

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []);
  const baseTicketTemplate = { objective: 'Create folder x', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', workflowId: null, workflowInput: null, ownedOutputPaths: null, executionPolicy: { maxAttempts: null } };
  writeJson('process-templates.json', [
    // Template 2: LEGACY — no `version` field at all (must be treated as v1 lazily).
    { id: 2, name: 'Legacy manual', enabled: true, triggerType: 'manual', schedule: null, ticketTemplate: { ...baseTicketTemplate, objective: 'Create folder legacy' }, createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null },
    // Template 3: versioned scheduled, due. Starts at version 2.
    { id: 3, name: 'Versioned scheduled', version: 2, enabled: true, triggerType: 'manual',
      schedule: { enabled: true, kind: 'interval', everySeconds: 3600, anchor: ISO, nextRunAt: PAST, lastScheduledTriggerAt: null, timezone: 'UTC', scheduledBy: 'admin' },
      ticketTemplate: { ...baseTicketTemplate, objective: 'Create folder sched' }, createdBy: 'admin', createdAt: ISO, updatedAt: ISO, lastTriggeredAt: null }
  ]);
  // A LEGACY generated ticket whose source predates r1.10 (no templateVersion) — must
  // still render on ticket detail without error and without a version suffix.
  writeJson('tickets.json', [{
    id: 50, objective: 'legacy generated', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { mode: 'assisted', requireVerification: 'when_declared', maxAttempts: null, allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared' },
    status: 'completed', createdBy: 'system', changedBy: 'system', changedAt: ISO, createdAt: ISO, updatedAt: ISO,
    source: { type: 'process_template', templateId: 2, templateName: 'Legacy manual', triggeredBy: 'admin', triggerType: 'manual', triggerRunId: null, triggerToken: 'legacy-50', createdAt: ISO }
  }]);
  writeJson('process-template-triggers.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

function waitForReady(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => { if (server.exitCode !== null) return reject(new Error('server exited early')); http.get(BASE_URL + '/api/health', res => { res.resume(); res.statusCode === 200 ? resolve() : (Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); }).on('error', () => Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(poll, 200)); };
    setTimeout(poll, 400);
  });
}
async function login() { const res = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } }); return cookieFrom(res); }
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
    const cookie = await login();

    // 1: a template created through the API gets version 1.
    const created = await request('POST', '/api/process-templates', { cookie, json: { name: 'Fresh', ticketTemplate: { objective: 'Create folder fresh', assignmentTargetType: 'agent', assignmentTargetId: 1, capabilityType: 'directAction' } } });
    assert(created.statusCode === 200 && created.json.template.version === 1, 'API-created template gets version 1');
    const freshId = created.json.template.id;

    // 2: manual trigger stamps version on ticket.source AND the ledger; fresh template = v1.
    const freshTrig = await request('POST', `/api/process-templates/${freshId}/trigger`, { cookie, json: { triggerToken: 'm-fresh-1' } });
    assert(freshTrig.statusCode === 200 && freshTrig.json.ok, 'fresh manual trigger ok');
    const freshTicket = tickets().find(t => t.id === freshTrig.json.ticketId);
    assert(freshTicket.source.templateVersion === 1, 'manual trigger stamps ticket.source.templateVersion = 1');
    const freshLedger = ledger().find(e => e.triggerToken === 'm-fresh-1');
    assert(freshLedger && freshLedger.templateVersion === 1, 'manual trigger stamps ledger.templateVersion = 1');
    assert(freshLedger.ticketTemplateSnapshot && freshLedger.executionPolicyUsed, 'ledger still includes ticketTemplateSnapshot + executionPolicyUsed');

    // 3: LEGACY template (no version field) → lazily treated as version 1.
    const legacyTrig = await request('POST', '/api/process-templates/2/trigger', { cookie, json: { triggerToken: 'm-legacy-1' } });
    assert(legacyTrig.statusCode === 200, 'legacy template manual trigger ok');
    assert(tickets().find(t => t.id === legacyTrig.json.ticketId).source.templateVersion === 1, 'legacy (no version) template stamps templateVersion = 1');
    assert(ledger().find(e => e.triggerToken === 'm-legacy-1').templateVersion === 1, 'legacy template ledger templateVersion = 1');

    // 4: scheduled trigger stamps version; token stays version-free.
    await tick(cookie);
    const schedTicket = ticketBySource(3, 'schedule');
    assert(schedTicket, 'scheduled trigger created a ticket for template 3');
    assert(schedTicket.source.templateVersion === 2, 'scheduled trigger stamps ticket.source.templateVersion = 2 (active version)');
    assert(schedTicket.source.triggerToken === `schedule:3:${PAST}`, 'scheduled token is schedule:<id>:<iso> — version-free');
    const schedLedger = ledger().find(e => e.triggerToken === `schedule:3:${PAST}`);
    assert(schedLedger && schedLedger.templateVersion === 2, 'scheduled ledger entry records templateVersion = 2');
    assert(schedLedger.ticketTemplateSnapshot && schedLedger.executionPolicyUsed, 'scheduled ledger still snapshots content + policy');

    // 5: a VERSION CHANGE before a re-scan of the SAME slot must not duplicate the ticket.
    //    Simulate an edit (version 2 → 3) and rewind nextRunAt to the already-handled slot.
    var store = readJsonData('process-templates.json');
    var t3 = store.find(t => t.id === 3);
    t3.version = 3;
    t3.schedule.nextRunAt = PAST; // same slot as before
    writeJson('process-templates.json', store);
    const schedCountBefore = tickets().filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 3).length;
    await tick(cookie);
    assert(tickets().filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 3).length === schedCountBefore, 'version change before a re-scan of the same slot does not create a duplicate ticket');
    // The original slot's ticket still records the version that was active when it fired (2).
    assert(ticketBySource(3, 'schedule').source.templateVersion === 2, 'the already-created slot ticket keeps the version used when it fired (2)');

    // 6: a NEW due slot after the version change records the then-active version (3).
    store = readJsonData('process-templates.json');
    store.find(t => t.id === 3).schedule.nextRunAt = PAST2; // a different, later slot
    writeJson('process-templates.json', store);
    await tick(cookie);
    const newSlotTicket = tickets().find(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 3 && t.source.scheduledFor === PAST2);
    assert(newSlotTicket && newSlotTicket.source.templateVersion === 3, 'a new due slot after the edit records the then-active version (3)');
    assert(newSlotTicket.source.triggerToken === `schedule:3:${PAST2}`, 'the new slot token is still version-free');

    // 7: legacy generated ticket (no templateVersion) still renders ticket detail safely.
    const legacyDetail = await request('GET', '/tickets/50', { cookie });
    assert(legacyDetail.statusCode === 200, 'legacy generated ticket detail renders (HTTP 200)');
    assert(legacyDetail.body.includes('Created from template') && legacyDetail.body.includes('Legacy manual'), 'legacy ticket shows provenance without error');
    assert(!/Legacy manual<\/a> v/.test(legacyDetail.body), 'legacy ticket shows no version suffix (unlabeled)');

    // 8: a versioned generated ticket shows "Created from template <name> vN".
    const schedDetail = await request('GET', '/tickets/' + schedTicket.id, { cookie });
    assert(/Versioned scheduled<\/a> v2/.test(schedDetail.body.replace(/\s+/g, ' ')) || schedDetail.body.includes('Versioned scheduled</a> v2'), 'versioned ticket detail shows "… vN"');

    // 9: /process-templates shows the active version.
    const FILES = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'logs.json'];
    const snap = {}; FILES.forEach(f => { snap[f] = readRaw(f); });
    const wsSnap = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const page = await request('GET', '/process-templates', { cookie });
    assert(page.statusCode === 200 && /Versioned scheduled<\/td>/.test(page.body.replace(/\s+v\d+\s*<\/span>/, '</td>')) === false, 'templates page renders'); // sanity
    assert(/Versioned scheduled\s*<\/a>\s*<span class="text-muted">v3<\/span>/.test(page.body), 'templates page shows the active version (v3) next to the name');
    assert(/Legacy manual\s*<\/a>\s*<span class="text-muted">v1<\/span>/.test(page.body), 'legacy (no-version) template renders as v1 on the page');

    // 10: GET /process-templates remains read-only.
    FILES.forEach(f => assert(readRaw(f) === snap[f], `${f} unchanged by GET /process-templates`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsSnap, 'workspace unchanged by GET /process-templates');

    console.log('PASS: template version provenance is stamped on tickets + ledger, token stays version-free, and legacy data renders safely');
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
