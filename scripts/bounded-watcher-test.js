#!/usr/bin/env node
// Bounded watcher primitive (r1.26). A scoped, MANUAL observer/proposer over a Work Context. Proves:
//   - CRUD creates no ticket/run/workspace mutation; a watcher must belong to an active Work Context;
//   - manual observe reads only the bounded workspace_file source and writes a receipt with
//     hash/metadata (no full file contents); duplicate observation is deterministic; source
//     unavailable records failure (no guess); archived watcher refuses to observe;
//   - a proposal is a draft (no ticket/run); approval creates a NORMAL ticket only through
//     ticket:create, carrying provenance refs; archived context blocks proposals;
//   - no scheduler/token change, no target mutation, no hidden run, no old data rewritten;
//   - Work Context visibility still works after approval and the handoff smoke loop is unaffected.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3492';
const BASE_URL = 'http://127.0.0.1:' + PORT;
const FILE_BODY = 'line-one\nline-two-secret-XYZ\nline-three\n';

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function tickets() { return readJsonData('tickets.json'); }
function runs() { return readJsonData('runs.json'); }
function dataFiles() { return fs.readdirSync(DATA_DIR).sort().join(','); }
function wsList() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

function ctx(id, name, status) {
  return { id, name, purpose: name + ' work', status, defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'legal', 'intake'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE_ROOT, 'legal', 'intake', 'inbox.txt'), FILE_BODY);
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'observer', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'watcher:manage']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:create', 'ticket:read', 'ticket:update', 'workContext:manage', 'watcher:manage'], canReceiveTickets: false },
    { id: 2, name: 'Observers', permissions: ['watcher:manage', 'ticket:read'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [
    { id: 1, principalType: 'user', principalId: 1, groupId: 1 },
    { id: 2, principalType: 'user', principalId: 2, groupId: 2 }
  ]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []);
  writeJson('work-contexts.json', [ctx(1, 'Legal Ops', 'active'), ctx(2, 'Archived', 'archived')]);
  writeJson('tickets.json', []);
  writeJson('process-templates.json', []); writeJson('process-template-triggers.json', []); writeJson('process-template-versions.json', []);
  writeJson('watchers.json', []); writeJson('watcher-observations.json', []); writeJson('watcher-ticket-proposals.json', []);
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

const WATCHER = { name: 'Legal Intake Watcher', workContextId: 1, sourceKind: 'workspace_file', sourceRefs: [{ path: 'legal/intake/inbox.txt' }], actionPolicy: { allowedActions: ['summarize', 'propose_ticket'] } };

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

    const filesBefore = dataFiles();
    const wsBefore = wsList();
    const ticketsBefore = readRaw('tickets.json');
    const runsBefore = readRaw('runs.json');

    // ---- 1: CRUD + scope rules; CRUD creates no ticket/run/workspace mutation. ----
    const created = await request('POST', '/api/watchers', { cookie: admin, json: WATCHER });
    assert(created.statusCode === 200 && created.json.ok && created.json.watcher.id === 1, 'watcher created: ' + created.body);
    assert(created.json.watcher.status === 'active' && created.json.watcher.cadence.mode === 'manual', 'watcher defaults are manual/active');
    assert(tickets().length === 0 && readRaw('runs.json') === runsBefore && wsList() === wsBefore, 'watcher create creates no ticket/run/workspace mutation');
    // Action policy cannot include execution verbs.
    assert((await request('POST', '/api/watchers', { cookie: admin, json: { ...WATCHER, name: 'bad', actionPolicy: { allowedActions: ['mutate_target'] } } })).statusCode === 400, 'execution action verbs rejected');
    // A watcher must belong to an active Work Context.
    assert((await request('POST', '/api/watchers', { cookie: admin, json: { ...WATCHER, name: 'arch', workContextId: 2 } })).statusCode === 400, 'active watcher in archived Work Context rejected');
    assert((await request('POST', '/api/watchers', { cookie: admin, json: { ...WATCHER, name: 'noctx', workContextId: 999 } })).statusCode === 400, 'unknown Work Context rejected');

    // ---- 2: manual observe reads bounded source; receipt has hash/metadata, NO contents. ----
    const obs1 = await request('POST', '/api/watchers/1/observe', { cookie: admin });
    assert(obs1.statusCode === 200 && obs1.json.observation.status === 'changed', 'first observe records changed: ' + obs1.body);
    const o = obs1.json.observation;
    assert(o.currentHash && o.summary && o.summary.lineCount === 4 && o.summary.bytes === Buffer.byteLength(FILE_BODY, 'utf8'), 'observation records hash + metadata');
    assert(!JSON.stringify(o).includes('line-two-secret-XYZ'), 'observation receipt omits full file contents');
    assert(wsList() === wsBefore, 'observe mutates no workspace files');
    assert(tickets().length === 0 && readRaw('runs.json') === runsBefore, 'observe creates no ticket/run');
    // Duplicate observation is deterministic (unchanged).
    const obs2 = await request('POST', '/api/watchers/1/observe', { cookie: admin });
    assert(obs2.json.observation.status === 'unchanged' && obs2.json.observation.currentHash === o.currentHash, 'duplicate observation is deterministic (unchanged, same hash)');
    assert(obs2.json.watcher.revision === 3, 'observation advances the watcher cursor revision');

    // ---- 3: source unavailable records failure (no guess). ----
    const wBad = await request('POST', '/api/watchers', { cookie: admin, json: { ...WATCHER, name: 'Missing source', sourceRefs: [{ path: 'legal/intake/missing.txt' }] } });
    const badId = wBad.json.watcher.id;
    const obsBad = await request('POST', `/api/watchers/${badId}/observe`, { cookie: admin });
    assert(obsBad.json.observation.status === 'failed' && obsBad.json.observation.error, 'missing source records a failed observation (no guess)');

    // ---- 4: archived watcher cannot observe. ----
    const archived = await request('POST', '/api/watchers/1', { cookie: admin, json: { status: 'archived', expectedRevision: obs2.json.watcher.revision } });
    assert(archived.statusCode === 200, 'watcher archived with expected revision');
    const obsArch = await request('POST', '/api/watchers/1/observe', { cookie: admin });
    assert(obsArch.json.observation.status === 'refused', 'archived watcher refuses to observe');
    await request('POST', '/api/watchers/1', { cookie: admin, json: { status: 'active', expectedRevision: archived.json.watcher.revision } });

    // ---- 5: proposal is a draft (no ticket/run); approval creates a normal ticket via ticket:create. ----
    const prop = await request('POST', '/api/watchers/1/proposals', { cookie: admin, json: {
      objective: 'Triage the new legal intake item', observationId: o.id,
      sourceRefs: [{ path: 'legal/intake/inbox.txt' }], evidenceRefs: ['watcher-observations.json:1'],
      constraints: 'read-only', stopCondition: 'stop if intake empty', receiptExpectation: 'work_receipt'
    } });
    assert(prop.statusCode === 200 && prop.json.proposal.status === 'proposed', 'proposal created (draft)');
    const propId = prop.json.proposal.id;
    assert(tickets().length === 0 && readRaw('runs.json') === runsBefore, 'proposal is not execution: no ticket/run created');
    assert(prop.json.proposal.createdTicketId === null, 'proposal has no created ticket yet');

    // Approval requires ticket:create — observer (no ticket:create) is rejected.
    const observer = await loginAs('observer');
    assert((await request('POST', `/api/watcher-proposals/${propId}/approve`, { cookie: observer, json: { assignmentTargetId: 1 } })).statusCode === 403, 'approval requires ticket:create');
    const approve = await request('POST', `/api/watcher-proposals/${propId}/approve`, { cookie: admin, json: { assignmentTargetType: 'agent', assignmentTargetId: 1 } });
    assert(approve.statusCode === 200 && approve.json.createdTicketId, 'approval creates a normal ticket: ' + approve.body);
    const newTicket = tickets().find(t => t.id === approve.json.createdTicketId);
    assert(newTicket && newTicket.source && newTicket.source.type === 'watcher_proposal', 'approved ticket carries watcher_proposal provenance');
    assert(newTicket.source.watcherId === 1 && newTicket.source.proposalId === propId && newTicket.source.observationId === o.id, 'provenance carries watcher/proposal/observation refs');
    assert(newTicket.source.sourceRefs.length && newTicket.source.evidenceRefs.includes('watcher-observations.json:1'), 'provenance carries source + evidence refs');
    assert(newTicket.workContextId === 1, 'approved ticket inherits Work Context scope');
    // Recipient run is a normal pending run (not secretly claimed); no authority widening.
    const newRuns = runs().filter(r => r.ticketId === newTicket.id);
    assert(newRuns.length === 1 && newRuns[0].status === 'pending' && newRuns[0].leaseOwner == null, 'approved ticket gets a normal pending run (not secretly claimed)');
    assert(newTicket.executionPolicy && newTicket.executionPolicy.allowChildTickets !== true, 'approval does not widen authority');
    // A proposal can only be approved once.
    assert((await request('POST', `/api/watcher-proposals/${propId}/approve`, { cookie: admin, json: { assignmentTargetId: 1 } })).statusCode === 409, 'a proposal cannot be approved twice');

    // ---- 6: archived Work Context blocks proposals. ----
    const wArchCtx = await request('POST', '/api/watchers', { cookie: admin, json: { ...WATCHER, name: 'paused for arch', workContextId: 1 } });
    // archive the context out from under it, then attempt a proposal
    await request('POST', '/api/work-contexts/1', { cookie: admin, json: { status: 'archived' } });
    const blocked = await request('POST', `/api/watchers/${wArchCtx.json.watcher.id}/proposals`, { cookie: admin, json: { objective: 'x' } });
    assert(blocked.statusCode === 409, 'archived Work Context blocks new proposals');
    await request('POST', '/api/work-contexts/1', { cookie: admin, json: { status: 'active' } });

    // ---- 7: timeline shows watcher-proposal provenance; Work Context visibility reflects the ticket. ----
    const tl = await request('GET', `/api/tickets/${newTicket.id}/timeline`, { cookie: admin });
    assert(tl.statusCode === 200 && tl.json.entries.some(e => e.type === 'ticket.watcher_proposal' && e.details.watcherId === 1), 'timeline shows watcher-proposal provenance');
    const summary = await request('GET', '/api/work-contexts/1/summary', { cookie: admin });
    assert(summary.json.tickets.some(t => t.id === newTicket.id), 'Work Context visibility includes the approved ticket');

    // ---- 8: no hidden state / no new ledgers / nothing rewritten. ----
    assert(dataFiles() === filesBefore, 'no unexpected data files created (watcher uses the three declared stores only)');
    assert(wsList() === wsBefore, 'no workspace mutation across the whole watcher loop');
    assert(readRaw('process-templates.json') === '[]' && readRaw('process-template-triggers.json') === '[]' && readRaw('process-template-versions.json') === '[]', 'no scheduler/process-template/version data changed');
    assert(ticketsBefore === '[]' && tickets().filter(t => t.source && t.source.type === 'watcher_proposal').length === 1, 'only the approved proposal produced a ticket (no hidden work)');

    console.log('PASS: bounded watcher — manual observe/propose only; receipts without contents, proposal is not execution, approval creates a normal ticket via ticket:create, no hidden work, no new ledger');
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
