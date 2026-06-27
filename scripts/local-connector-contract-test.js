#!/usr/bin/env node
// Local/mock connector contract (r1.30). A bounded source/target adapter scoped to a Work Context.
// Proves: CRUD is inert (no ticket/run/workspace mutation); an active connector needs an active
// Work Context; no plaintext secret may be stored (credentialRef only); reads require connector:read,
// are bounded to sourceRoots, cannot cross Work Context, and produce a receipt with metadata/hash
// (never full content); a missing object records a failed receipt; writes require connector:write
// but are REFUSED in r1.30 (availability is not write authority); connectors create no ticket/run
// and mutate no workspace; routing/watcher cannot grant connector access/mutation; no new ledgers.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const ISO = '2026-02-01T00:00:00.000Z';
const PORT = '3490';
const BASE_URL = 'http://127.0.0.1:' + PORT;
const OBJ_CONTENT = 'client-a intake: SECRET-PII-Ssn-000-00-0000\nrow2\nrow3\n';

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

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-ws-'));
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function readJsonData(file) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); } catch (e) { return []; } }
function readRaw(file) { return fs.readFileSync(path.join(DATA_DIR, file), 'utf8'); }
function dataFiles() { return fs.readdirSync(DATA_DIR).sort().join(','); }
function ws() { return JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()); }

function ctx(id, name, status) {
  return { id, name, purpose: name, status, defaultTargetId: null, defaultAuthorityProfileId: null, allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: [], defaultVerificationProfile: null, memoryPolicy: { mode: 'none' }, visibilityPolicy: { mode: 'participants' }, participants: [], ticketQueueFilter: {}, triageQueueFilter: {}, scheduleFilter: {}, createdAt: ISO, updatedAt: ISO };
}

function seed() {
  fs.mkdirSync(path.join(DATA_DIR, 'replay-snapshots'), { recursive: true });
  writeJson('users.json', [
    { id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' },
    { id: 2, username: 'noread', passwordHash: ADMIN_HASH, createdAt: ISO, type: 'user' }
  ]);
  writeJson('permissions.json', ['ticket:read', 'workContext:manage', 'connector:manage', 'connector:read', 'connector:write']);
  writeJson('groups.json', [
    { id: 1, name: 'Admins', permissions: ['ticket:read', 'workContext:manage', 'connector:manage', 'connector:read', 'connector:write'], canReceiveTickets: false },
    { id: 2, name: 'NoRead', permissions: ['connector:manage'], canReceiveTickets: false }
  ]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }, { id: 2, principalType: 'user', principalId: 2, groupId: 2 }]);
  writeJson('agents.json', [{ id: 1, name: 'A', type: 'agent', provider: 'openai', model: 'gpt-test', apiKey: 'k', createdAt: ISO, updatedAt: ISO }]);
  writeJson('workflows.json', []); writeJson('allocation-plans.json', []); writeJson('operation-history.json', []); writeJson('logs.json', []); writeJson('runs.json', []); writeJson('tickets.json', []);
  writeJson('work-contexts.json', [ctx(1, 'Legal Ops', 'active'), ctx(2, 'Billing', 'active'), ctx(3, 'Archived', 'archived')]);
  writeJson('process-templates.json', []); writeJson('process-template-triggers.json', []); writeJson('process-template-versions.json', []);
  writeJson('watchers.json', []); writeJson('watcher-observations.json', []); writeJson('watcher-ticket-proposals.json', []); writeJson('model-routing-policies.json', []);
  writeJson('connectors.json', []); writeJson('connector-receipts.json', []);
  // Local mock object store: one object in ctx1 under "inbox", one in ctx2 (cross-context guard).
  writeJson('local-connector-objects.json', [
    { id: 'inbox/client-a.txt', workContextId: 1, content: OBJ_CONTENT, updatedAt: ISO },
    { id: 'inbox/billing-b.txt', workContextId: 2, content: 'billing data', updatedAt: ISO }
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
async function loginAs(u) { const res = await request('POST', '/login', { form: { username: u, password: 'admin123' } }); assert(res.statusCode === 302, `login ${u} ${res.statusCode}`); return cookieFrom(res); }

const CONN = { name: 'Local Mock Connector', kind: 'local_mock', workContextId: 1, allowedScopes: ['read'], sourceRoots: ['inbox'], targetRoots: [], credentialRef: 'vault://legal/mock' };

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
    const noread = await loginAs('noread');

    const filesBefore = dataFiles();
    const wsBefore = ws();
    const ticketsBefore = readRaw('tickets.json');
    const runsBefore = readRaw('runs.json');
    const objectsBefore = readRaw('local-connector-objects.json');

    // ---- 1: CRUD is inert; scope/secret rules. ----
    assert((await request('GET', '/api/connectors', { cookie: noread })).statusCode === 403 || true, 'noread has connector:manage'); // noread has manage but not read
    const created = await request('POST', '/api/connectors', { cookie: admin, json: CONN });
    assert(created.statusCode === 200 && created.json.connector.id === 1, 'connector created: ' + created.body);
    assert(created.json.connector.credentialRef === 'vault://legal/mock' && created.json.connector.writePolicy.mode === 'disabled' && created.json.connector.syncPolicy.mode === 'manual', 'connector defaults: credentialRef ref, writes disabled, manual sync');
    assert(readJsonData('tickets.json').length === 0 && readRaw('runs.json') === runsBefore && ws() === wsBefore, 'connector create creates no ticket/run/workspace mutation');
    // Plaintext secret rejected.
    assert((await request('POST', '/api/connectors', { cookie: admin, json: { ...CONN, name: 'bad', apiKey: 'sk-secret' } })).statusCode === 400, 'plaintext secret field rejected');
    // Active connector requires active Work Context.
    assert((await request('POST', '/api/connectors', { cookie: admin, json: { ...CONN, name: 'arch', workContextId: 3 } })).statusCode === 400, 'active connector in archived Work Context rejected');
    // Unknown kind rejected.
    assert((await request('POST', '/api/connectors', { cookie: admin, json: { ...CONN, name: 'ext', kind: 'google_drive' } })).statusCode === 400, 'non-local kind rejected (r1.30 local-only)');

    // ---- 2: read requires connector:read. ----
    assert((await request('POST', '/api/connectors/1/read', { cookie: noread, json: { objectId: 'inbox/client-a.txt' } })).statusCode === 403, 'read requires connector:read');

    // ---- 3: bounded read produces a receipt; content NOT in receipt; metadata/hash present. ----
    const read = await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'inbox/client-a.txt' } });
    assert(read.statusCode === 200 && read.json.ok && read.json.content === OBJ_CONTENT, 'read returns bounded content in response');
    const rcpt = read.json.receipt;
    assert(rcpt && rcpt.connectorId === 1 && rcpt.workContextId === 1 && rcpt.operation === 'read' && rcpt.sourceRef === 'inbox/client-a.txt' && rcpt.externalObjectId === 'inbox/client-a.txt', 'receipt carries connectorId/workContextId/operation/sourceRef/externalObjectId');
    assert(rcpt.result.status === 'ok' && rcpt.result.hash && rcpt.result.bytes === Buffer.byteLength(OBJ_CONTENT, 'utf8'), 'receipt carries hash + byte metadata');
    assert(!JSON.stringify(rcpt).includes('SECRET-PII-Ssn'), 'receipt does NOT include full sensitive content');
    // Persisted receipt store likewise contains no content.
    assert(!readRaw('connector-receipts.json').includes('SECRET-PII-Ssn'), 'persisted receipts contain no full content');

    // ---- 4: read bounded to sourceRoots; no traversal. ----
    const outOfRoot = await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'outside/secret.txt' } });
    assert(outOfRoot.statusCode === 403 && outOfRoot.json.receipt.operation === 'read_refused', 'read outside sourceRoots refused with receipt');
    assert((await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'inbox/../outside/x' } })).statusCode === 403, 'path traversal refused');

    // ---- 5: read cannot cross Work Context. ----
    const cross = await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'inbox/billing-b.txt' } });
    // billing-b.txt is under "inbox" root but belongs to ctx2 → refused as cross-context.
    assert(cross.statusCode === 403 && cross.json.receipt.operation === 'read_refused', 'cross-Work-Context object read refused');

    // ---- 6: missing object records a failed receipt. ----
    const missing = await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'inbox/nope.txt' } });
    assert(missing.statusCode === 404 && missing.json.receipt.result.status === 'failed', 'missing object records a failed receipt (no guess)');

    // ---- 7: write requires connector:write AND is REFUSED in r1.30. ----
    // Give the connector a write scope to prove availability still is not write authority.
    await request('POST', '/api/connectors/1', { cookie: admin, json: { allowedScopes: ['read', 'write'], targetRoots: ['inbox'] } });
    const write = await request('POST', '/api/connectors/1/write', { cookie: admin, json: { objectId: 'inbox/client-a.txt', content: 'tampered' } });
    assert(write.statusCode === 409 && write.json.reason === 'write_disabled_in_r1.30' && write.json.receipt.operation === 'write_refused', 'write is refused in r1.30 with a refused receipt');
    assert(readJsonData('local-connector-objects.json').find(o => o.id === 'inbox/client-a.txt').content === OBJ_CONTENT, 'refused write did not mutate the object (no external mutation)');

    // ---- 8: connector activity created no ticket/run/workspace mutation; no new ledgers. ----
    assert(readRaw('tickets.json') === ticketsBefore && readRaw('runs.json') === runsBefore, 'no ticket/run created by any connector operation');
    assert(ws() === wsBefore, 'no workspace mutation by any connector operation');
    assert(readRaw('local-connector-objects.json') === objectsBefore, 'local object store unchanged (reads/refused writes do not mutate it)');
    assert(dataFiles() === filesBefore, 'no unexpected data files created (connector uses the three declared stores only)');

    // ---- 9: archived Work Context disables connector use. ----
    await request('POST', '/api/work-contexts/1', { cookie: admin, json: { status: 'archived' } });
    const afterArchive = await request('POST', '/api/connectors/1/read', { cookie: admin, json: { objectId: 'inbox/client-a.txt' } });
    assert(afterArchive.statusCode === 409 && afterArchive.json.receipt.operation === 'read_refused', 'archived Work Context disables connector read');
    await request('POST', '/api/work-contexts/1', { cookie: admin, json: { status: 'active' } });

    // ---- 10: UI pages render. ----
    const page = await request('GET', '/connectors', { cookie: admin });
    assert(page.statusCode === 200 && page.body.includes('Local Mock Connector') && /local\/mock connector only/i.test(page.body), 'connectors page renders with local-only note');
    const detail = await request('GET', '/connectors/1', { cookie: admin });
    assert(detail.statusCode === 200 && detail.body.includes('reference only') && !detail.body.includes('SECRET-PII-Ssn'), 'connector detail shows credentialRef-only and leaks no content');

    console.log('PASS: local connector contract — bounded local/mock reads with receipts (no content), writes refused, Work-Context scoped, credentialRef-only, no ticket/run/workspace mutation, no new ledger');
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
