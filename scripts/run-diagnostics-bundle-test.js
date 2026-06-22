#!/usr/bin/env node
// Run Diagnostics copyable bundle regression test (test-only).
//
// Drives the real server over HTTP with a model-free fetch stub (same #ACTIONS=
// directive pattern as the concurrency harness). Proves the Run Detail Diagnostics
// section exists, the diagnostic bundle is generated server-side with the required
// header/sections/fields for both a permissioned cross-ticket delete run and a
// blocked cross-ticket delete run, and that secrets are redacted.
//
// Touches only temp DATA_DIR / WORKSPACE_ROOT under os.tmpdir(). Never reads or
// writes the real data/ dir, .local-data, provider keys, or seed files in place.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-diag-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-diag-ws-'));
const PORT = String(4560 + Math.floor(Math.random() * 200));
const BASE_URL = 'http://127.0.0.1:' + PORT;
const FAKE_KEY = 'fake-key-diag-' + STAMP;

let server = null;
let failures = 0;

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  · ${name}: PASS`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}: FAIL${detail ? ' — ' + detail : ''}`);
  }
  return condition;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2)); }
function jsonParsesOrNull(file) { try { return readJson(file); } catch (_) { return null; } }
function encodeActions(plan) { return Buffer.from(JSON.stringify(plan), 'utf8').toString('base64url'); }

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form ? new URLSearchParams(options.form).toString() : null;
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += String(chunk); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 30000, intervalMs = 80) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  return null;
}

function seedData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seed = ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json'];
  for (const file of seed) fs.copyFileSync(path.join(ROOT, 'data', file), path.join(DATA_DIR, file));
  writeJson('tickets.json', []);
  writeJson('runs.json', []);
  writeJson('logs.json', []);
  writeJson('operation-history.json', []);
  writeJson('allocation-plans.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');

  const agents = readJson('agents.json');
  let nextId = agents.reduce((max, a) => Math.max(max, a.id || 0), 0);
  const made = [];
  for (let i = 0; i < 2; i += 1) {
    nextId += 1;
    // A recognizable fake provider key so the redaction assertion is meaningful.
    agents.push({ id: nextId, name: 'Diag Agent ' + i, provider: 'openai', model: 'fake-openai-' + i, apiKey: FAKE_KEY, createdAt: new Date().toISOString(), runtimeConfig: {} });
    made.push(nextId);
  }
  writeJson('agents.json', agents);

  // Non-admin user WITHOUT workspace.delete.cross_ticket_artifact (blocked case).
  const users = readJson('users.json');
  const adminUser = users.find(u => u.username === 'admin') || users[0];
  const restrictedUserId = users.reduce((m, u) => Math.max(m, u.id || 0), 0) + 1;
  users.push({ id: restrictedUserId, username: 'restricted', passwordHash: adminUser.passwordHash, createdAt: new Date().toISOString(), type: 'user' });
  writeJson('users.json', users);
  const groups = readJson('groups.json');
  const restrictedGroupId = groups.reduce((m, g) => Math.max(m, g.id || 0), 0) + 1;
  groups.push({ id: restrictedGroupId, name: 'Restricted Operators', permissions: ['ticket:create', 'ticket:read', 'ticket:update'], canReceiveTickets: false });
  writeJson('groups.json', groups);
  const memberships = readJson('memberships.json');
  const nextMembershipId = memberships.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
  memberships.push({ id: nextMembershipId, principalType: 'user', principalId: restrictedUserId, groupId: restrictedGroupId });
  writeJson('memberships.json', memberships);

  return made;
}

function createFetchStub() {
  const preloadPath = path.join(os.tmpdir(), 'diag-stub-' + process.pid + '-' + STAMP + '.js');
  const src = `
function okResponse(plan) {
  return { ok: true, status: 200, headers: new Map([['x-request-id', 'fake-diag']]),
    async text() { return JSON.stringify({ output_text: JSON.stringify(plan), usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }); } };
}
global.fetch = async function(_url, options = {}) {
  let combined = '';
  try { const body = JSON.parse(options.body || '{}'); const input = Array.isArray(body.input) ? body.input : [];
    combined = input.map(i => i && i.content ? String(i.content) : '').join('\\n'); } catch (_) {}
  const m = combined.match(/#ACTIONS=([A-Za-z0-9_-]+=*)/);
  if (!m) return okResponse({ message: 'noop', actions: [], complete: true });
  let plan;
  try { plan = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch (_) { plan = { actions: [], complete: true }; }
  return okResponse({ message: plan.message || 'stubbed', actions: plan.actions || [], complete: plan.complete !== false });
};
`;
  fs.writeFileSync(preloadPath, src);
  return preloadPath;
}

function startServer(preloadPath) {
  const env = { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, NODE_OPTIONS: '--require ' + preloadPath };
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', c => { output += String(c); });
  server.stderr.on('data', c => { output += String(c); });
  return waitFor(async () => {
    if (server && server.exitCode !== null) throw new Error('server exited during startup: ' + output.slice(-800));
    try { const res = await httpReq('GET', '/login'); return res.status === 200; } catch (_) { return false; }
  }, 15000, 100);
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await sleep(400);
  if (server && server.exitCode === null) server.kill('SIGKILL');
  server = null;
}

async function loginAs(username, password) {
  const res = await httpReq('POST', '/login', { form: { username, password } });
  const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
  const match = String(setCookie || '').match(/sessionId=([^;]+)/);
  if (!match) throw new Error('login failed for ' + username);
  return 'sessionId=' + match[1];
}

function objectiveWith(tag, plan) {
  return `diag ${tag} ${STAMP} #ACTIONS=${encodeActions(plan)}`;
}

async function createTicket(cookie, agentId, objective) {
  return httpReq('POST', '/tickets', {
    cookie,
    form: { objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual' }
  });
}

function findTicketByObjective(objective) {
  return (jsonParsesOrNull('tickets.json') || []).find(t => t.objective === objective) || null;
}

async function waitForTicketRun(objective) {
  return waitFor(() => {
    const ticket = findTicketByObjective(objective);
    if (!ticket) return null;
    const run = (jsonParsesOrNull('runs.json') || []).find(r => r.ticketId === ticket.id);
    return run ? { ticket, run } : null;
  }, 20000, 80);
}

async function waitForTerminalRun(runId) {
  return waitFor(() => {
    const run = (jsonParsesOrNull('runs.json') || []).find(r => r.id === runId);
    return run && ['completed', 'failed', 'interrupted'].includes(run.status) ? run : null;
  }, 45000, 80);
}

async function runDeleteFlow(adminCookie, deleterCookie, agents, target, tag) {
  const oOwner = objectiveWith(tag + 'Owner', { actions: [{ operation: 'writeFile', args: { path: target, content: 'CD' } }], complete: true });
  await createTicket(adminCookie, agents[0], oOwner);
  const owner = await waitForTicketRun(oOwner);
  const ownerFinal = owner && await waitForTerminalRun(owner.run.id);
  if (!ownerFinal || ownerFinal.status !== 'completed') throw new Error(tag + ' owner run did not complete');
  const oDel = objectiveWith(tag + 'Del', { actions: [{ operation: 'deletePath', args: { path: target } }], complete: true });
  await createTicket(deleterCookie, agents[1], oDel);
  const deleter = await waitForTicketRun(oDel);
  const deleterFinal = deleter && await waitForTerminalRun(deleter.run.id);
  return { owner, ownerFinal, deleter, deleterFinal };
}

async function getRunPage(cookie, runId, mustContain) {
  return waitFor(async () => {
    const page = await httpReq('GET', '/runs/' + runId, { cookie });
    if (page.status !== 200) return null;
    if (mustContain && !page.body.includes(mustContain)) return null;
    return page;
  }, 10000, 100);
}

// Extract the diagnostic bundle text from the readonly textarea on the page.
function extractBundle(pageBody) {
  const m = pageBody.match(/<textarea id="run-diagnostics-bundle"[^>]*>([\s\S]*?)<\/textarea>/);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'");
}

async function main() {
  const agents = seedData();
  const preloadPath = createFetchStub();
  console.log('Run Diagnostics bundle test');
  console.log('='.repeat(60));
  try {
    await startServer(preloadPath);
    const adminCookie = await loginAs('admin', 'admin123');
    const restrictedCookie = await loginAs('restricted', 'admin123');

    // --- Permissioned delete run ---
    const permitted = await runDeleteFlow(adminCookie, adminCookie, agents, 'diag-permit/CD-' + STAMP + '.txt', 'permit');
    assert('permitted delete run completed', permitted.deleterFinal && permitted.deleterFinal.status === 'completed',
      `status=${permitted.deleterFinal && permitted.deleterFinal.status}`);
    const permPage = await getRunPage(adminCookie, permitted.deleter.run.id, 'id="run-diagnostics"');
    const permBody = permPage ? permPage.body : '';
    assert('1. Run Detail contains a Diagnostics section', permBody.includes('id="run-diagnostics"') && permBody.includes('<h2>Diagnostics</h2>'));
    assert('2. page has a read-only diagnostics textarea', /<textarea id="run-diagnostics-bundle"[^>]*\breadonly\b/.test(permBody));
    assert('3. page has a copy diagnostics button', permBody.includes('data-copy-diagnostics'));

    const permBundle = extractBundle(permBody) || '';
    assert('4. bundle starts with the required header', permBundle.trimStart().startsWith('# Ticket System Diagnostic Bundle'));
    assert('5. bundle includes ticket id and run id',
      permBundle.includes('Ticket: #' + permitted.deleter.ticket.id) && permBundle.includes('Run: #' + permitted.deleter.run.id));
    assert('6. bundle includes delegated authority fields',
      permBundle.includes('run.delegatedUserId:') && permBundle.includes('run.delegatedUsername:') && permBundle.includes('run.delegatedPermissionSource:'));
    assert('7. bundle includes permission check result',
      permBundle.includes('workspace.delete.cross_ticket_artifact') &&
      /Delegated user has "workspace\.delete\.cross_ticket_artifact": yes/.test(permBundle));
    assert('9. permissioned bundle includes audit section + fields',
      permBundle.includes('## 10. Permissioned Cross-Ticket Delete Audit') &&
      permBundle.includes('permissionUsed: workspace.delete.cross_ticket_artifact') &&
      permBundle.includes('priorOwnerTicketId: ' + permitted.owner.ticket.id) &&
      permBundle.includes('actorUsername: admin'));
    assert('10. bundle includes the redaction notice',
      permBundle.includes('Provider keys, session cookies, password hashes, auth tokens, and environment secrets are excluded from this diagnostic bundle.'));
    assert('11. bundle does not include passwordHash', !permBundle.includes('passwordHash'));
    assert('12. bundle does not include sessionId', !permBundle.includes('sessionId'));
    assert('13. bundle does not include provider API key', !permBundle.includes(FAKE_KEY));

    // --- Blocked delete run ---
    const blocked = await runDeleteFlow(adminCookie, restrictedCookie, agents, 'diag-block/CD-' + STAMP + '.txt', 'block');
    assert('blocked delete run failed with conflict',
      blocked.deleterFinal && blocked.deleterFinal.status === 'failed' && /conflict|previously produced/i.test(String(blocked.deleterFinal.error || '')),
      `status=${blocked.deleterFinal && blocked.deleterFinal.status}`);
    const blockedPage = await getRunPage(adminCookie, blocked.deleter.run.id, 'id="run-diagnostics"');
    const blockedBundle = extractBundle(blockedPage ? blockedPage.body : '') || '';
    assert('8a. blocked bundle includes deletePath + path', blockedBundle.includes('deletePath') && blockedBundle.includes('diag-block/CD-' + STAMP + '.txt'));
    assert('8b. blocked bundle includes conflicting owner ticket/run',
      blockedBundle.includes('conflictingTicketId: ' + blocked.owner.ticket.id) && blockedBundle.includes('conflictingRunId: ' + blocked.owner.run.id));
    assert('8c. blocked bundle includes attempted + committed counts',
      /Workspace actions attempted before failure: \d+/.test(blockedBundle) && /Mutations committed before failure: 0/.test(blockedBundle));
    assert('8d. blocked bundle states no mutation committed',
      blockedBundle.includes('No operation-history mutation was committed for this run.') || blockedBundle.includes('mutation committed: no'));
    assert('blocked bundle redaction intact (no key/hash/cookie)',
      !blockedBundle.includes(FAKE_KEY) && !blockedBundle.includes('passwordHash') && !blockedBundle.includes('sessionId'));

    console.log('\n' + (failures === 0 ? 'PASS' : 'FAIL') + `: ${failures} failure(s)`);
  } finally {
    await stopServer();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    try { fs.unlinkSync(preloadPath); } catch (_) {}
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
