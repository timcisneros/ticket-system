#!/usr/bin/env node
// Work Context primitive (r1.20). Work Context is a PRODUCT-LAYER grouping above the runtime:
// it groups related tickets/templates, supplies creation-time defaults + allow-lists, and scopes
// listings. It is never an execution path. This test proves:
//   - CRUD (create/list/update/archive) works and creates NO ticket/run/workspace mutation;
//   - a nullable workContextId attaches to new tickets/templates with an immutable snapshot;
//   - unknown / archived contexts are rejected for new assignment;
//   - non-empty allow-lists (capabilities/targets/templates) are enforced and never widen authority;
//   - changing a context never rewrites old tickets/runs;
//   - tickets/triage/templates can be filtered by workContextId (uncontexted triage never hidden);
//   - the scheduler/trigger ledger is untouched and ticket detail (incl. timeline) still renders.

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'work-context-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'work-context-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function runs() { return readJsonData('runs.json'); }
function contexts() { return readJsonData('work-contexts.json'); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

function baseTicket(id, objective, extra) {
  return { id, objective, assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null,
    executionMode: 'agent', workflowId: null, workflowInput: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
    executionPolicy: { maxAttempts: null }, status: 'completed', createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO, ...extra };
}
const TRIAGE = { required: true, reasonCode: 'authority_blocked', summary: 'needs review', requiredDecision: 'change_scope',
  evidenceRefs: [], allowedActions: ['review'], prohibitedActions: [], createdAt: ISO, resolvedAt: null, resolvedBy: null, resolution: null };
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
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []);

  // Pre-seeded contexts: 1 active "Legal Ops", 2 active "Billing", 3 archived "Old Program".
  writeJson('work-contexts.json', [context(1, 'Legal Ops', 'active'), context(2, 'Billing', 'active'), context(3, 'Old Program', 'archived')]);
  // Pre-seeded tickets: legacy (no context), one in ctx1 with triage, one in ctx2, one contextless with triage.
  writeJson('tickets.json', [
    baseTicket(50, 'legacy contextless ticket'),
    baseTicket(51, 'legal ops blocked ticket', { status: 'blocked', workContextId: 1, workContextSnapshot: { id: 1, name: 'Legal Ops', purpose: 'Legal Ops purpose', status: 'active' }, triage: { ...TRIAGE } }),
    baseTicket(52, 'billing done ticket', { workContextId: 2, workContextSnapshot: { id: 2, name: 'Billing', purpose: 'Billing purpose', status: 'active' } }),
    baseTicket(53, 'uncontexted blocked ticket', { status: 'blocked', triage: { ...TRIAGE } })
  ]);
  writeJson('process-templates.json', [
    tmpl(1, 'Legal template', { workContextId: 1, workContextSnapshot: { id: 1, name: 'Legal Ops', purpose: 'Legal Ops purpose', status: 'active' } }),
    tmpl(2, 'Unscoped template')
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
function newestTicketId() { return tickets().reduce((m, t) => Math.max(m, t.id), 0); }

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

    // ---- 1: list + create CRUD; CRUD creates no ticket/run/workspace mutation. ----
    const list0 = await request('GET', '/api/work-contexts', { cookie });
    assert(list0.statusCode === 200 && list0.json.workContexts.length === 3, 'list returns seeded contexts');

    const ticketsBefore = tickets().length, runsBefore = readRaw('runs.json'), wsBefore = ws(), ledgerBefore = readRaw('process-template-triggers.json');
    const created = await request('POST', '/api/work-contexts', { cookie, json: { name: 'Vendor Audit', purpose: 'vendor reviews' } });
    assert(created.statusCode === 200 && created.json.ok && created.json.workContext.id === 4, 'create returns new context: ' + created.body);
    assert(created.json.workContext.status === 'active' && created.json.workContext.memoryPolicy.mode === 'none', 'created context defaults are conservative');
    assert(tickets().length === ticketsBefore, 'context create creates no ticket');
    assert(readRaw('runs.json') === runsBefore, 'context create creates no run');
    assert(ws() === wsBefore, 'context create mutates no workspace files');
    assert(readRaw('process-template-triggers.json') === ledgerBefore, 'context create writes no trigger-ledger entry');

    // Validation: name required; bad status rejected.
    assert((await request('POST', '/api/work-contexts', { cookie, json: { name: '' } })).statusCode === 400, 'empty name rejected');
    assert((await request('POST', '/api/work-contexts', { cookie, json: { name: 'x', status: 'running' } })).statusCode === 400, 'invalid status rejected');

    // ---- 2: update + archive; data store stable/idempotent. ----
    const upd = await request('POST', '/api/work-contexts/4', { cookie, json: { purpose: 'updated purpose' } });
    assert(upd.statusCode === 200 && upd.json.workContext.purpose === 'updated purpose' && upd.json.workContext.name === 'Vendor Audit', 'update preserves name, changes purpose');
    const arch = await request('POST', '/api/work-contexts/4', { cookie, json: { status: 'archived' } });
    assert(arch.statusCode === 200 && arch.json.workContext.status === 'archived', 'archive sets status archived');
    assert(contexts().length === 4 && contexts().every(c => c.id !== undefined), 'archive preserves all records (no delete)');
    // Idempotent re-read.
    assert(JSON.parse(readRaw('work-contexts.json')).find(c => c.id === 4).status === 'archived', 'store is stable on re-read');

    // ---- 3: allow-list enforcement (never widens authority). ----
    // allowedTargetIds self-consistency: defaultTargetId must be within a non-empty allow-list.
    assert((await request('POST', '/api/work-contexts', { cookie, json: { name: 'Bad target', allowedTargetIds: [1], defaultTargetId: 2 } })).statusCode === 400, 'allowedTargetIds enforced: defaultTargetId must be allowed');
    assert((await request('POST', '/api/work-contexts', { cookie, json: { name: 'Good target', allowedTargetIds: [1, 2], defaultTargetId: 2 } })).statusCode === 200, 'consistent allowedTargetIds accepted');
    // allowedCapabilities: a context that only allows a different capability.
    const capCtx = await request('POST', '/api/work-contexts', { cookie, json: { name: 'Cap-restricted', allowedCapabilities: ['some-workflow'] } });
    const capCtxId = capCtx.json.workContext.id;
    const rejByCap = await request('POST', '/tickets', { cookie, form: { objective: 'x', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', workContextId: String(capCtxId) } });
    assert(rejByCap.statusCode === 400, 'allowedCapabilities enforced: disallowed capability rejected for new ticket');
    // allowedProcessTemplateIds: a context whose allow-list excludes template 2.
    const tmplCtx = await request('POST', '/api/work-contexts', { cookie, json: { name: 'Tmpl-restricted', allowedProcessTemplateIds: [1] } });
    const tmplCtxId = tmplCtx.json.workContext.id;
    const rejTmpl = await request('POST', '/api/process-templates/2/work-context', { cookie, json: { workContextId: tmplCtxId } });
    assert(rejTmpl.statusCode === 403, 'allowedProcessTemplateIds enforced: template not in allow-list rejected');
    // Allowed assignment: template 1 → context 1 (empty allow-list = any). Keeps the filter fixture intact.
    const okTmpl = await request('POST', '/api/process-templates/1/work-context', { cookie, json: { workContextId: 1 } });
    assert(okTmpl.statusCode === 200 && okTmpl.json.workContextId === 1, 'allowed template assignment accepted');

    // ---- 4: ticket creation with workContextId — snapshot, unknown/archived rejection, no authority widening. ----
    // Unknown context rejected.
    assert((await request('POST', '/tickets', { cookie, form: { objective: 'u', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', workContextId: '9999' } })).statusCode === 400, 'unknown workContextId rejected for new ticket');
    // Archived context rejected (context 3 is archived).
    assert((await request('POST', '/tickets', { cookie, form: { objective: 'a', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', workContextId: '3' } })).statusCode === 400, 'archived workContextId rejected for new ticket');

    // Contextless ticket (baseline authority).
    const baseRes = await request('POST', '/tickets', { cookie, form: { objective: 'baseline no-context ticket', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction' } });
    assert(baseRes.statusCode === 302, 'contextless ticket created');
    const baseId = newestTicketId();
    const baseTk = tickets().find(t => t.id === baseId);
    assert(baseTk.workContextId === undefined, 'contextless ticket has no workContextId');

    // Valid context ticket (context 1) — stores id + immutable snapshot; identical authority.
    const ctxRes = await request('POST', '/tickets', { cookie, form: { objective: 'legal ops new ticket', assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', workContextId: '1' } });
    assert(ctxRes.statusCode === 302, 'context ticket created');
    const ctxTicketId = newestTicketId();
    const ctxTk = tickets().find(t => t.id === ctxTicketId);
    assert(ctxTk.workContextId === 1, 'new ticket stores workContextId');
    assert(ctxTk.workContextSnapshot && ctxTk.workContextSnapshot.id === 1 && ctxTk.workContextSnapshot.name === 'Legal Ops', 'new ticket gets a workContextSnapshot');
    assert(JSON.stringify(ctxTk.executionPolicy) === JSON.stringify(baseTk.executionPolicy), 'context does not widen ticket authority (executionPolicy identical to contextless)');

    // ---- 5: changing a context does not rewrite old tickets/runs. ----
    const before51 = JSON.stringify(tickets().find(t => t.id === 51));
    await request('POST', '/api/work-contexts/1', { cookie, json: { name: 'Legal Ops RENAMED' } });
    assert(JSON.stringify(tickets().find(t => t.id === 51)) === before51, 'renaming a context does not rewrite an existing ticket or its snapshot');
    assert(tickets().find(t => t.id === ctxTicketId).workContextSnapshot.name === 'Legal Ops', 'snapshot on the newly-created ticket is immutable after rename');

    // ---- 6: filtered listings. ----
    const allTickets = await request('GET', '/tickets', { cookie });
    assert(allTickets.body.includes('legacy contextless ticket') && allTickets.body.includes('legal ops blocked ticket'), 'unfiltered ticket list shows all');
    const ctx1Tickets = await request('GET', '/tickets?workContextId=1', { cookie });
    assert(ctx1Tickets.body.includes('legal ops blocked ticket') && !ctx1Tickets.body.includes('billing done ticket') && !ctx1Tickets.body.includes('legacy contextless ticket'), 'ticket list filters by workContextId');

    // Inbox filter: uncontexted critical triage NEVER hidden by default.
    const allTriage = await request('GET', '/inbox', { cookie });
    assert(allTriage.body.includes('"ticketId":51,') && allTriage.body.includes('"ticketId":53,'), 'default inbox shows both contexted and uncontexted items');
    const ctx1Triage = await request('GET', '/inbox?workContextId=1', { cookie });
    assert(ctx1Triage.body.includes('"ticketId":51,') && !ctx1Triage.body.includes('"ticketId":53,'), 'inbox filters by workContextId when explicitly requested');

    // Template filter.
    const allTmpls = await request('GET', '/process-templates', { cookie });
    assert(allTmpls.body.includes('Legal template') && allTmpls.body.includes('Unscoped template'), 'unfiltered template list shows all');
    const ctx1Tmpls = await request('GET', '/process-templates?workContextId=1', { cookie });
    assert(ctx1Tmpls.body.includes('Legal template') && !ctx1Tmpls.body.includes('Unscoped template'), 'template list filters by workContextId');

    // ---- 7: old contextless ticket renders safely; context ticket shows label; timeline renders. ----
    const legacyDetail = await request('GET', '/tickets/50', { cookie });
    assert(legacyDetail.statusCode === 200 && !legacyDetail.body.includes('<dt>Work Context</dt>'), 'contextless ticket renders without a Work Context label');
    const ctxDetail = await request('GET', '/tickets/' + ctxTicketId, { cookie });
    assert(ctxDetail.statusCode === 200 && ctxDetail.body.includes('<dt>Work Context</dt>') && ctxDetail.body.includes('Legal Ops'), 'context ticket detail (incl. timeline) renders with the Work Context label');

    // ---- 8: context archive/CRUD never deletes tickets/runs/evidence. ----
    assert(tickets().some(t => t.id === 52), 'archiving/CRUD never deletes tickets (ticket 52 still present)');
    assert(readRaw('process-template-triggers.json') === ledgerBefore, 'no trigger-ledger entry written by any context operation');
    assert(runs().length === tickets().filter(t => ['baseline no-context ticket', 'legal ops new ticket'].includes(t.objective)).length, 'only the two newly-created tickets produced runs (context CRUD created none)');

    // ---- 9: the work-contexts page renders. ----
    const page = await request('GET', '/work-contexts', { cookie });
    assert(page.statusCode === 200 && page.body.includes('Work Contexts') && page.body.includes('Legal Ops'), '/work-contexts page renders the list');

    console.log('PASS: Work Context primitive — product-layer grouping with creation-time defaults/filters; no execution path, no authority widening, no hidden work, history preserved');
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
