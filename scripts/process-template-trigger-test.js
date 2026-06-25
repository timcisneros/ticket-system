#!/usr/bin/env node
// Manual-trigger process templates (r1.6). A process template stores a reusable
// ticket input and creates ordinary tickets through the shared createTicketFromInput
// path. This test proves: templates store RAW policy (normalized only at trigger),
// triggering creates exactly one ordinary ticket with provenance and a normalized
// policy, all existing gates still apply (ambiguity/triage block, no run beyond the
// normal path), idempotency dedupes double-submits, disabled templates cannot fire,
// permissions are enforced, and the trigger writes a system log + append-only trigger
// log while mutating no workspace.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3493';
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
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON (HTML) */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function tickets() { return readJsonData('tickets.json'); }
function runsForTicket(id) { return readJsonData('runs.json').filter(r => r.ticketId === id); }
function workspaceListing() { return fs.readdirSync(WORKSPACE_ROOT).sort(); }

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 3, username: 'creator', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  // Catalog includes the new management permission.
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage']);
  writeJson('groups.json', [
    // Admin: can manage templates AND create tickets.
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'processTemplate:manage'], canReceiveTickets: false },
    // Viewer: read only — no manage, no create.
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false },
    // Creator: can create tickets (and trigger) but cannot manage templates.
    { id: 3, name: 'Creators', permissions: ['ticket:create', 'ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 },
    { id: 3, principalType: 'user', principalId: 3, groupId: 3 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'PT Agent', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []);
  writeJson('allocation-plans.json', []);
  writeJson('operation-history.json', []);
  writeJson('logs.json', []);
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('process-templates.json', []);
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
async function loginAs(username, password) {
  const res = await request('POST', '/login', { form: { username, password } });
  assert(res.statusCode === 302, `login ${username} failed HTTP ${res.statusCode}`);
  return cookieFrom(res);
}

const createTemplate = (cookie, payload) => request('POST', '/api/process-templates', { cookie, json: payload });
const triggerTemplate = (cookie, id, json) => request('POST', `/api/process-templates/${id}/trigger`, { cookie, json: json || {} });

async function main() {
  seed();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // Huge scheduler interval => pending runs are created but never executed, so the
    // trigger path mutates no workspace and we can count runs deterministically.
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();
    const admin = await loginAs('admin', 'admin123');
    const viewer = await loginAs('viewer', 'admin123');
    const creator = await loginAs('creator', 'admin123');

    const workspaceBefore = JSON.stringify(workspaceListing());

    // ---- Permissions: template management requires processTemplate:manage ----
    const normalTemplatePayload = {
      name: 'Daily status',
      enabled: true,
      ticketTemplate: {
        objective: 'Create folder reports',
        assignmentTargetType: 'agent',
        assignmentTargetId: 1,
        capabilityType: 'directAction',
        // RAW policy: autoRetry true but NO maxAttempts (stays inert), plus a distinctive field.
        executionPolicy: { autoRetry: true, maxRuntimeMs: 5000 }
      }
    };
    const deniedViewer = await createTemplate(viewer, normalTemplatePayload);
    assert(deniedViewer.statusCode === 403, `viewer (no manage) must not create template, got ${deniedViewer.statusCode}`);
    const deniedCreator = await createTemplate(creator, normalTemplatePayload);
    assert(deniedCreator.statusCode === 403, `creator (no manage) must not create template, got ${deniedCreator.statusCode}`);
    assert(readJsonData('process-templates.json').length === 0, 'denied creates must not persist a template');

    // ---- Create (admin) ----
    const created = await createTemplate(admin, normalTemplatePayload);
    assert(created.statusCode === 200 && created.json && created.json.ok, `admin create template should succeed, got ${created.statusCode}: ${created.body}`);
    const normalTemplate = created.json.template;
    assert(normalTemplate.triggerType === 'manual', 'template triggerType must be manual');
    assert(normalTemplate.schedule === null, 'template schedule must be inert null in v1');
    assert(normalTemplate.enabled === true, 'template should be enabled');

    // Stored policy is RAW (normalized only at trigger time): no injected normalizer fields.
    const storedPolicy = normalTemplate.ticketTemplate.executionPolicy;
    assert(storedPolicy && storedPolicy.autoRetry === true && storedPolicy.maxRuntimeMs === 5000, 'stored template policy must be the raw object as provided');
    assert(!('requireVerification' in storedPolicy) && !('workspaceScope' in storedPolicy) && !('mode' in storedPolicy),
      'stored template policy must NOT be normalized (no requireVerification/workspaceScope/mode injected)');

    // ---- Trigger permission: requires ticket:create ----
    const triggerDeniedViewer = await triggerTemplate(viewer, normalTemplate.id, { triggerToken: 'should-not-apply' });
    assert(triggerDeniedViewer.statusCode === 403, `viewer (no ticket:create) must not trigger, got ${triggerDeniedViewer.statusCode}`);
    assert(tickets().length === 0, 'denied trigger must not create a ticket');

    // ---- Manual trigger creates exactly one ordinary ticket (creator has ticket:create) ----
    const ticketsBefore = tickets().length;
    const fired = await triggerTemplate(creator, normalTemplate.id, { triggerToken: 'tok-normal-1' });
    assert(fired.statusCode === 200 && fired.json && fired.json.ok && fired.json.deduped === false, `trigger should create a ticket, got ${fired.statusCode}: ${fired.body}`);
    const ticketId = fired.json.ticketId;
    assert(tickets().length === ticketsBefore + 1, 'manual trigger must create exactly one ticket');
    const generated = tickets().find(t => t.id === ticketId);
    assert(generated, 'generated ticket must be persisted');
    assert(generated.objective === 'Create folder reports', 'generated ticket objective comes from the template');

    // ---- Provenance on the generated ticket ----
    const src = generated.source;
    assert(src && src.type === 'process_template', 'generated ticket must record source.type process_template');
    assert(src.templateId === normalTemplate.id, 'source.templateId must match');
    assert(src.templateName === 'Daily status', 'source.templateName must match');
    assert(src.triggeredBy === 'creator', 'source.triggeredBy must be the acting user');
    assert(src.triggerType === 'manual', 'source.triggerType must be manual');
    assert(src.triggerRunId === null, 'source.triggerRunId must be null in v1');
    assert(src.triggerToken === 'tok-normal-1', 'source.triggerToken must be recorded');

    // ---- Generated ticket uses a NORMALIZED policy; autoRetry true + maxAttempts null = inert ----
    const genPolicy = generated.executionPolicy;
    assert(genPolicy.requireVerification === 'when_declared', 'generated policy must be normalized (requireVerification when_declared)');
    assert(genPolicy.autoRetry === true, 'generated policy autoRetry should reflect template true');
    assert(genPolicy.maxAttempts === null, 'generated policy maxAttempts should be null (autoRetry stays inert)');
    assert(genPolicy.maxRuntimeMs === 5000, 'generated policy should carry the normalized maxRuntimeMs');
    assert(typeof genPolicy.workspaceScope === 'string' && typeof genPolicy.mode === 'string', 'generated policy must be a full normalized object');

    // ---- No run beyond the normal path: a clear agent ticket gets exactly one pending run ----
    const normalRuns = runsForTicket(ticketId);
    assert(normalRuns.length === 1, `clear agent ticket should create exactly one run via the normal path, got ${normalRuns.length}`);
    assert(normalRuns[0].status === 'pending', 'the created run should be pending (scheduler disabled), not executed');

    // ---- autoRetry defaults false when the template policy omits it ----
    const defaultPolicyTemplate = (await createTemplate(admin, {
      name: 'Default policy', enabled: true,
      ticketTemplate: { objective: 'Create folder archive', assignmentTargetType: 'agent', assignmentTargetId: 1, capabilityType: 'directAction' }
    })).json.template;
    const defFired = await triggerTemplate(admin, defaultPolicyTemplate.id, { triggerToken: 'tok-default-1' });
    const defTicket = tickets().find(t => t.id === defFired.json.ticketId);
    assert(defTicket.executionPolicy.autoRetry === false, 'autoRetry must default false when template omits it');
    assert(defTicket.executionPolicy.maxAttempts === null, 'maxAttempts must default null');

    // ---- Ambiguous templated objective is blocked through the existing clarification gate ----
    const ambiguousTemplate = (await createTemplate(admin, {
      name: 'Ambiguous', enabled: true,
      ticketTemplate: { objective: 'Create 5 Michael Jackson songs folders', assignmentTargetType: 'agent', assignmentTargetId: 1, capabilityType: 'directAction' }
    })).json.template;
    const ambFired = await triggerTemplate(admin, ambiguousTemplate.id, { triggerToken: 'tok-amb-1' });
    assert(ambFired.statusCode === 200 && ambFired.json.ok, `ambiguous trigger still creates the ticket object, got ${ambFired.statusCode}: ${ambFired.body}`);
    const ambTicket = tickets().find(t => t.id === ambFired.json.ticketId);
    assert(ambTicket.status === 'blocked', 'ambiguous templated objective must be blocked, not run');
    assert(ambTicket.triage && ambTicket.triage.required === true, 'ambiguous ticket must carry unresolved triage');
    assert(ambTicket.triage.reasonCode === 'objective_ambiguous', 'ambiguous ticket triage reason must be objective_ambiguous');
    // Unresolved triage / blocked objective => no run created through the existing gate.
    assert(runsForTicket(ambTicket.id).length === 0, 'a blocked/ambiguous generated ticket must not create a run');

    // ---- Idempotency: double trigger with the same token returns the existing ticket ----
    const countBeforeDup = tickets().length;
    const dup = await triggerTemplate(creator, normalTemplate.id, { triggerToken: 'tok-normal-1' });
    assert(dup.statusCode === 200 && dup.json.deduped === true, 'repeated triggerToken must be deduped');
    assert(dup.json.ticketId === ticketId, 'deduped trigger must return the original ticket id');
    assert(tickets().length === countBeforeDup, 'deduped trigger must not create a second ticket');

    // ---- Disabled template cannot be triggered ----
    const disabledTemplate = (await createTemplate(admin, {
      name: 'Disabled', enabled: false,
      ticketTemplate: { objective: 'Create folder unused', assignmentTargetType: 'agent', assignmentTargetId: 1, capabilityType: 'directAction' }
    })).json.template;
    assert(disabledTemplate.enabled === false, 'template should persist as disabled');
    const disabledCountBefore = tickets().length;
    const disabledFired = await triggerTemplate(admin, disabledTemplate.id, { triggerToken: 'tok-disabled-1' });
    assert(disabledFired.statusCode === 409, `disabled template must not trigger, got ${disabledFired.statusCode}`);
    assert(tickets().length === disabledCountBefore, 'disabled trigger must not create a ticket');

    // ---- Missing template => 404 ----
    const missing = await triggerTemplate(admin, 99999, { triggerToken: 'tok-missing' });
    assert(missing.statusCode === 404, `unknown template must 404, got ${missing.statusCode}`);

    // ---- System log: process_template:triggered exists with contextTicketId ----
    const logs = readJsonData('logs.json');
    const triggerLog = logs.find(l => l.type === 'process_template:triggered' && l.contextTicketId === ticketId);
    assert(triggerLog, 'a process_template:triggered system log must be written for the created ticket');
    assert(triggerLog.templateId === normalTemplate.id && triggerLog.triggerToken === 'tok-normal-1', 'trigger system log must carry template + token context');

    // ---- Append-only trigger log with snapshot ----
    const triggerEntries = readJsonData('process-template-triggers.json');
    const entry = triggerEntries.find(e => e.triggerToken === 'tok-normal-1');
    assert(entry, 'trigger log must contain the token entry');
    assert(entry.ticketId === ticketId, 'trigger log entry must point at the generated ticket');
    assert(entry.ticketTemplateSnapshot && entry.ticketTemplateSnapshot.objective === 'Create folder reports', 'trigger log must snapshot the ticketTemplate used');
    assert(entry.executionPolicyUsed && entry.executionPolicyUsed.requireVerification === 'when_declared', 'trigger log must record the normalized executionPolicy used');
    // The deduped second submit must NOT append a duplicate entry.
    assert(triggerEntries.filter(e => e.triggerToken === 'tok-normal-1').length === 1, 'deduped trigger must not append a duplicate trigger-log entry');

    // ---- No workspace mutation during any trigger ----
    assert(JSON.stringify(workspaceListing()) === workspaceBefore, 'template triggers must not mutate the workspace');

    // ---- Provenance renders on ticket detail ----
    const detail = await request('GET', '/tickets/' + ticketId, { cookie: admin });
    assert(detail.statusCode === 200, 'ticket detail should render');
    assert(detail.body.includes('Created from template'), 'ticket detail should show process-template provenance');

    // ---- Templates page renders with manage permission and the trigger control ----
    const page = await request('GET', '/process-templates', { cookie: admin });
    assert(page.statusCode === 200, `templates page should render for manager, got ${page.statusCode}`);
    assert(page.body.includes('Create ticket from template'), 'templates page should offer the manual trigger control');
    assert(!/running loop/i.test(page.body), 'templates page must not imply a running loop');
    const pageDenied = await request('GET', '/process-templates', { cookie: viewer });
    assert(pageDenied.statusCode === 403, 'templates page must be denied without processTemplate:manage');

    console.log('PASS: manual process template triggers create gated, provenanced, idempotent tickets with no workspace mutation');
  } catch (error) {
    if (out) process.stderr.write(out);
    throw error;
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await sleep(400);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
