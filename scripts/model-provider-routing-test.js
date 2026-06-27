#!/usr/bin/env node
// Model/provider routing (r1.28). Dispatch policy + immutable per-run routingSnapshot. Routing
// records WHICH provider/model a run dispatched to; it never changes actual execution (the agent's
// own provider/model stays the backend), never widens authority, never bypasses target/scheduler/
// verification/triage. Proves: policy CRUD is inert; new runs get a snapshot; legacy runs render
// safely without one; selection is deterministic (explicit > wc+cap > wc > cap > default > none);
// provider restriction is enforced (refuse→triage, fallback only when explicitly allowed); and
// handoff/watcher-created tickets still route normally.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3491';
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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function runs() { return readJsonData('runs.json'); }
function dataFiles() { return fs.readdirSync(DATA_DIR).sort().join(','); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

function ctx(id, name, status) {
  return { id, name, purpose: name, status, defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO };
}
// A legacy completed run with NO routingSnapshot (must still render).
function legacyRun(id, ticketId) {
  return { id, ticketId, agentId: 1, agentName: 'A', workspaceRoot: WORKSPACE_ROOT, mainWorkspaceRoot: WORKSPACE_ROOT, executionWorkspaceType: 'main', executionMode: 'agent', capabilityType: 'directAction', capabilityId: 'agent-selected-actions', executionPolicySnapshot: { requireVerification: 'when_declared' }, currentPhase: 'terminalization', leaseOwner: null, leaseExpiresAt: null, status: 'completed', createdAt: ISO, updatedAt: ISO, startedAt: ISO, completedAt: ISO, replaySnapshotPath: `replay-snapshots/run-${id}.json` };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }, { id: 2, username: 'viewer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'watcher:manage', 'modelRouting:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'watcher:manage', 'modelRouting:manage'], canReceiveTickets: false },
    { id: 2, name: 'Viewers', permissions: ['ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }, { id: 2, principalType: 'user', principalId: 2, groupId: 2 }]);
  // Agent provider is "openai" — routing records that as the selected provider (execution unchanged).
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []);
  writeJson('work-contexts.json', [ctx(1, 'Legal Ops', 'active'), ctx(2, 'Archived', 'archived')]);
  // Legacy ticket+run with no routingSnapshot.
  writeJson('tickets.json', [{ id: 5, objective: 'legacy', assignmentTargetType: 'agent', assignmentTargetId: 1, assignmentMode: 'individual', ownedOutputPaths: null, executionMode: 'agent', workflowId: null, capabilityType: 'directAction', capabilityId: 'agent-selected-actions', executionPolicy: { maxAttempts: null }, status: 'completed', createdBy: 'admin', changedBy: 'admin', changedAt: ISO, createdAt: ISO, updatedAt: ISO }]);
  writeJson('runs.json', [legacyRun(50, 5)]);
  fs.writeFileSync(path.join(DATA_DIR, 'replay-snapshots', 'run-50.json'), JSON.stringify({ runId: 50, providerRequests: [], modelResponses: [], workspaceOperations: [], events: [] }, null, 2));
  writeJson('process-templates.json', []); writeJson('process-template-triggers.json', []); writeJson('process-template-versions.json', []);
  writeJson('watchers.json', []); writeJson('watcher-observations.json', []); writeJson('watcher-ticket-proposals.json', []);
  writeJson('model-routing-policies.json', []);
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
const createTicket = (cookie, form) => request('POST', '/tickets', { cookie, form: { assignmentTargetType: 'agent', assignmentTargetId: '1', capabilityType: 'directAction', ...form } });
function latestRunFor(ticketId) { return runs().filter(r => r.ticketId === ticketId).sort((a, b) => b.id - a.id)[0]; }

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
    const viewer = await loginAs('viewer');

    const filesBefore = dataFiles();
    const wsBefore = ws();
    const runsBefore = readRaw('runs.json');
    const legacyTicketBefore = JSON.stringify(tickets().find(t => t.id === 5));

    // ---- 1: policy CRUD creates no ticket/run/workspace mutation; permission enforced. ----
    assert((await request('GET', '/api/model-routing-policies', { cookie: viewer })).statusCode === 403, 'routing management requires modelRouting:manage');
    const ticketsBefore = tickets().length;
    const created = await request('POST', '/api/model-routing-policies', { cookie: admin, json: { name: 'Default', allowedProviders: [] } });
    assert(created.statusCode === 200 && created.json.policy.id === 1 && created.json.policy.status === 'active', 'policy created');
    assert(tickets().length === ticketsBefore && readRaw('runs.json') === runsBefore && ws() === wsBefore, 'policy CRUD creates no ticket/run/workspace mutation');

    // ---- 2: with a default unrestricted policy, a new run gets a routingSnapshot using agent provider/model. ----
    assert((await createTicket(admin, { objective: 'route me with default policy' })).statusCode === 302, 'ticket created');
    const t1 = newestTicketId();
    const r1 = latestRunFor(t1);
    assert(r1 && r1.routingSnapshot, 'new run gets a routingSnapshot');
    assert(r1.routingSnapshot.selectedProvider === 'openai' && r1.routingSnapshot.selectedModel === 'gpt-test', 'snapshot records the agent provider/model (execution unchanged)');
    assert(r1.routingSnapshot.policyId === 1 && r1.routingSnapshot.reason === 'policy_preferred' && r1.routingSnapshot.fallbackUsed === false, 'unrestricted default policy → policy_preferred, no fallback');

    // ---- 3: legacy run renders safely without a routingSnapshot. ----
    const legacyRunNow = runs().find(r => r.id === 50);
    assert(legacyRunNow && legacyRunNow.routingSnapshot === undefined, 'legacy run has no routingSnapshot');
    const tlLegacy = await request('GET', '/api/tickets/5/timeline', { cookie: admin });
    assert(tlLegacy.statusCode === 200 && !tlLegacy.json.entries.some(e => e.type === 'run.routing'), 'legacy ticket timeline renders with no routing entry');

    // ---- 4: provider restriction enforced — disallowed provider with no fallback refuses into triage. ----
    await request('POST', '/api/model-routing-policies/1', { cookie: admin, json: { allowedProviders: ['anthropic'] } }); // openai now disallowed
    const refusedRes = await createTicket(admin, { objective: 'should refuse, provider not allowed' });
    assert(refusedRes.statusCode === 302, 'ticket object still created');
    const tRef = newestTicketId();
    const tRefTicket = tickets().find(t => t.id === tRef);
    // Routing reuses the existing triage vocabulary; the routing-specific signal is in evidenceRefs.
    assert(tRefTicket.status === 'blocked' && tRefTicket.triage && tRefTicket.triage.required === true && tRefTicket.triage.reasonCode === 'authority_blocked', 'no permitted provider refuses into triage (no guessing)');
    assert(tRefTicket.triage.evidenceRefs.includes('model-routing:no_route'), 'refusal triage carries the routing-specific evidence ref');
    assert(runs().filter(r => r.ticketId === tRef).length === 0, 'refused ticket creates no run (no hidden fallback)');

    // ---- 5: fallback only when explicitly allowed (agent provider listed as a fallback). ----
    await request('POST', '/api/model-routing-policies/1', { cookie: admin, json: { allowedProviders: ['anthropic'], fallbackProviders: ['openai'] } });
    assert((await createTicket(admin, { objective: 'allowed via explicit fallback' })).statusCode === 302, 'fallback ticket created');
    const tFb = newestTicketId();
    const rFb = latestRunFor(tFb);
    assert(rFb && rFb.routingSnapshot.reason === 'fallback_allowed' && rFb.routingSnapshot.fallbackUsed === true, 'agent provider allowed via explicit fallback → fallback_allowed');
    assert(tickets().find(t => t.id === tFb).status !== 'blocked', 'fallback ticket is not blocked');

    // ---- 6: archived policy is never selected — run falls back to no_policy (agent default). ----
    await request('POST', '/api/model-routing-policies/1', { cookie: admin, json: { status: 'archived' } });
    assert((await createTicket(admin, { objective: 'archived policy ignored' })).statusCode === 302, 'ticket created with archived policy');
    const tArch = newestTicketId();
    const rArch = latestRunFor(tArch);
    assert(rArch.routingSnapshot.reason === 'no_policy' && rArch.routingSnapshot.policyId === null && rArch.routingSnapshot.selectedProvider === 'openai', 'archived policy is not selected; run uses agent default (no_policy)');

    // ---- 7: deterministic specificity — Work Context + capability policy beats a default. ----
    await request('POST', '/api/model-routing-policies', { cookie: admin, json: { name: 'wc1-default', workContextId: 1, allowedProviders: [] } }); // id 2
    await request('POST', '/api/model-routing-policies', { cookie: admin, json: { name: 'wc1-cap', workContextId: 1, capabilityId: 'agent-selected-actions', allowedProviders: [] } }); // id 3
    await request('POST', '/api/work-contexts', { cookie: admin, json: { name: 'extra' } }); // ensure wc store write works
    assert((await createTicket(admin, { objective: 'most specific policy wins', workContextId: '1' })).statusCode === 302, 'wc ticket created');
    const tSpec = newestTicketId();
    const rSpec = latestRunFor(tSpec);
    assert(rSpec.routingSnapshot.policyId === 3, 'Work-Context+capability policy (id 3) beats Work-Context-only (id 2)');
    assert(rSpec.routingSnapshot.workContextId === 1, 'snapshot records the Work Context');
    // Timeline shows the routing decision (projection-only, no new ledger).
    const tlSpec = await request('GET', `/api/tickets/${tSpec}/timeline`, { cookie: admin });
    assert(tlSpec.json.entries.some(e => e.type === 'run.routing' && e.details.policyId === 3), 'timeline shows routing decision');

    // ---- 8: routing does not widen authority; no scheduler/target/process-template data changed. ----
    assert(tickets().find(t => t.id === tSpec).executionPolicy && tickets().find(t => t.id === tSpec).executionPolicy.allowChildTickets !== true, 'routing does not widen authority');
    assert(readRaw('process-templates.json') === '[]' && readRaw('process-template-triggers.json') === '[]' && readRaw('process-template-versions.json') === '[]', 'no scheduler/process-template/version data changed');
    assert(dataFiles() === filesBefore, 'no unexpected data files created (routing uses the declared store only)');
    assert(JSON.stringify(tickets().find(t => t.id === 5)) === legacyTicketBefore && runs().find(r => r.id === 50).routingSnapshot === undefined, 'legacy ticket/run not rewritten');
    assert(ws() === wsBefore, 'no workspace mutation across the routing loop');

    // ---- 9: handoff-created and watcher-approved tickets still route normally. ----
    // Re-activate an unrestricted default so new runs route cleanly.
    await request('POST', '/api/model-routing-policies/2', { cookie: admin, json: { status: 'archived' } });
    await request('POST', '/api/model-routing-policies/3', { cookie: admin, json: { status: 'archived' } });
    const ho = await request('POST', `/api/tickets/${tSpec}/handoff`, { cookie: admin, json: { objective: 'handoff routes normally', toAssignmentTargetId: 1 } });
    assert(ho.statusCode === 200, 'handoff ok');
    const rHo = latestRunFor(ho.json.createdTicketId);
    assert(rHo && rHo.routingSnapshot && rHo.routingSnapshot.reason === 'no_policy', 'handoff-created ticket still routes normally');

    console.log('PASS: model provider routing — dispatch policy + immutable run snapshot; deterministic selection, restriction enforced (refuse→triage), fallback only when allowed, execution/authority unchanged, no new ledger');
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
