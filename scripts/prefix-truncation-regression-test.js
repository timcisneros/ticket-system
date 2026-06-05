#!/usr/bin/env node
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STAMP = Date.now();
const MUTATING_OPS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];
let failures = 0;

function assert(condition, msg) {
  if (!condition) { console.error('FAIL: ' + msg); failures++; }
  else { console.log('  OK: ' + msg); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpReq(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.form
      ? new URLSearchParams(options.form).toString()
      : options.body
        ? JSON.stringify(options.body)
        : null;
    const req = http.request('http://127.0.0.1:' + options.port + urlPath, {
      method,
      headers: {
        ...(body ? { 'Content-Type': options.form ? 'application/x-www-form-urlencoded' : 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
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

async function waitFor(fn, timeoutMs = 45000, intervalMs = 100, label = '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error('Timed out' + (label ? ' (' + label + ')' : ''));
}

function setupDataDir(dataDir, agentId, agentName) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const f of ['users.json', 'agents.json', 'groups.json', 'memberships.json', 'permissions.json', 'workflows.json']) {
    fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dataDir, f));
  }
  for (const f of ['tickets.json', 'runs.json', 'logs.json', 'operation-history.json', 'allocation-plans.json']) {
    fs.writeFileSync(path.join(dataDir, f), '[]');
  }
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), '');
  const agents = JSON.parse(fs.readFileSync(path.join(dataDir, 'agents.json'), 'utf8'));
  agents.push({ id: agentId, name: agentName, provider: 'openai', model: 'fake-model', apiKey: 'fake-key', createdAt: new Date().toISOString(), runtimeConfig: {} });
  fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify(agents, null, 2));
}

function makePreload(stamp, firstMarker, oversizeJSON, secondMarker, compliantJSON) {
  const p = path.join(os.tmpdir(), 'tm3-preload-' + process.pid + '-' + stamp + '.js');
  const src = `
global.__tm3Stamp = '${stamp}';
global.__tm3First = '${firstMarker}';
global.__tm3Second = '${secondMarker}';
global.__tm3Oversize = ${JSON.stringify(oversizeJSON)};
global.__tm3Compliant = ${JSON.stringify(compliantJSON)};
function ok(p) {
  return { ok:true, status:200, headers:new Map([['x-request-id','x']]),
    async text(){return JSON.stringify({output_text:JSON.stringify(p),usage:{input_tokens:1,output_tokens:1,total_tokens:2}});} };
}
global.fetch = async function(u, opts) {
  const body = JSON.parse((opts||{}).body||'{}');
  const combined = (body.input||[]).map(i=>i&&i.content?String(i.content):'').join('\\\\n');
  if (combined.includes(global.__tm3Second)) return ok({message:'c',actions:global.__tm3Compliant,complete:true});
  if (combined.includes(global.__tm3First))  return ok({message:'o',actions:global.__tm3Oversize,complete:false});
  return ok({message:'n',actions:[],complete:true});
};
`;
  fs.writeFileSync(p, src);
  return p;
}

function spawnServer(dataDir, wsDir, preload, port, extraEnv) {
  const s = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port),
      DATA_DIR: dataDir, WORKSPACE_ROOT: wsDir,
      AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE: '2',
      NODE_OPTIONS: '--require ' + preload,
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return s;
}

async function waitLogin(port) {
  return waitFor(async () => {
    try {
      const res = await httpReq('GET', '/login', { port });
      return res.status === 200;
    } catch { return false; }
  }, 15000, 100, 'waitLogin port=' + port);
}

async function login(port) {
  const res = await httpReq('POST', '/login', { port, form: { username: 'admin', password: 'admin123' } });
  if (res.status !== 302) throw new Error('login failed: HTTP ' + res.status);
  const sc = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : String(res.headers['set-cookie'] || '');
  const m = sc.match(/sessionId=([^;]+)/);
  if (!m) throw new Error('no sessionId in cookie');
  return 'sessionId=' + m[1];
}

async function createTicket(dataDir, port, cookie, agentId, objective) {
  const res = await httpReq('POST', '/tickets', { port, cookie, form: {
    objective, assignmentTargetType: 'agent', assignmentTargetId: String(agentId), assignmentMode: 'individual'
  }});
  if (res.status !== 302) throw new Error('ticket create failed: HTTP ' + res.status);
  return waitFor(() => {
    const tickets = JSON.parse(fs.readFileSync(path.join(dataDir, 'tickets.json'), 'utf8'));
    const t = tickets.find(x => x.objective === objective);
    if (!t) return null;
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
    const r = runs.find(x => x.ticketId === t.id);
    return r ? { ticket: t, run: r } : null;
  }, 15000, 100, 'createTicket runId lookup');
}

async function waitTerminal(dataDir, runId) {
  return waitFor(() => {
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'runs.json'), 'utf8'));
    const r = runs.find(x => x.id === runId);
    if (!r) return null;
    if (['completed', 'failed', 'interrupted'].includes(r.status)) return r;
    return null;
  }, 45000, 200, 'waitTerminal runId=' + runId);
}

async function testCase(label, dataDir, wsDir, port, extraEnv, agentId, oversize, compliant, secondMarker, assertFn) {
  console.log(`\n=== ${label} ===\n`);
  setupDataDir(dataDir, agentId, label.replace(/[^a-zA-Z0-9]/g, ''));
  const stamp = label + '-' + STAMP;
  const firstMarker = 'FIRST-' + stamp;
  const preload = makePreload(stamp, firstMarker, oversize, secondMarker, compliant);
  const server = spawnServer(dataDir, wsDir, preload, port, extraEnv);
  let serverOutput = '';
  server.stdout.on('data', c => { serverOutput += c; });
  server.stderr.on('data', c => { serverOutput += c; });
  try {
    await waitLogin(port);
    const cookie = await login(port);
    const { ticket, run } = await createTicket(dataDir, port, cookie, agentId, firstMarker);
    console.log('  Run created: runId=' + run.id + ' ticketId=' + ticket.id + ' status=' + run.status);
    const finalRun = await waitTerminal(dataDir, run.id);
    console.log('  Terminal status: ' + finalRun.status);
    await sleep(500);
    const eventsRaw = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8');
    const opsHistory = JSON.parse(fs.readFileSync(path.join(dataDir, 'operation-history.json'), 'utf8'));
    const ourOps = opsHistory.filter(o => o.runId === run.id);
    await assertFn({ ticket, run: finalRun, eventsRaw, ourOps, dataDir });
  } catch (err) {
    console.error('Server output:\n' + serverOutput.slice(-1000));
    throw err;
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (server.exitCode === null) server.kill('SIGKILL');
    await sleep(100);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.unlinkSync(preload); } catch {}
  }
}

async function main() {
  console.log('Prefix Truncation Regression Test');
  console.log('================================\n');

  // Test 1: DISABLED flag → suppression behavior
  // Model always returns oversize (4 mutating). No compliant retry marker
  // → repeated violation + termination.
  await testCase(
    'SUPPRESSION-DISABLED',
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-dis-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-ws-dis-')),
    4610 + Math.floor(Math.random() * 200),
    { ENABLE_PREFIX_TRUNCATION: 'false' },
    1001,
    [
      { operation: 'createFolder', args: { path: 's-target' } },
      { operation: 'writeFile', args: { path: 's-target/a.txt', content: 'a' } },
      { operation: 'writeFile', args: { path: 's-target/b.txt', content: 'b' } },
      { operation: 'writeFile', args: { path: 's-target/c.txt', content: 'c' } }
    ],
    [],
    'NEVER-MATCH-' + STAMP, // never triggered — model always returns oversize
    async ({ run, eventsRaw, ourOps }) => {
      assert(run.status === 'failed', 'suppression run terminates (status=' + run.status + ')');
      const suppressed = (eventsRaw.match(/action\.suppressed/g) || []).length;
      assert(suppressed >= 1, 'action.suppressed event emitted (count=' + suppressed + ')');
      const truncated = (eventsRaw.match(/action\.truncated/g) || []).length;
      assert(truncated === 0, 'no action.truncated events under suppression');
      assert(ourOps.length === 0, 'no workspace operations committed under suppression (got ' + ourOps.length + ')');
      console.log('  PASS');
    }
  );

  // Test 2: ENABLED flag → truncation behavior
  // Use all-mutating batch (phase-compliant). First N=2 actions execute, rest dropped.
  await testCase(
    'TRUNCATION-ENABLED',
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-en-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-ws-en-')),
    4830 + Math.floor(Math.random() * 200),
    { ENABLE_PREFIX_TRUNCATION: 'true' },
    2001,
    [
      { operation: 'createFolder', args: { path: 't-target' } },
      { operation: 'writeFile', args: { path: 't-target/a.txt', content: 'a' } },
      { operation: 'writeFile', args: { path: 't-target/b.txt', content: 'b' } },
      { operation: 'writeFile', args: { path: 't-target/c.txt', content: 'c' } }
    ],
    [
      { operation: 'writeFile', args: { path: 't-target/d.txt', content: 'd' } },
      { operation: 'writeFile', args: { path: 't-target/e.txt', content: 'e' } }
    ],
    'model:mutating_action_limit', // second call: warning in prompt → compliant retry
    async ({ run, eventsRaw, ourOps }) => {
      assert(run.status === 'completed', 'truncation run completes (status=' + run.status + ')');
      const truncated = (eventsRaw.match(/action\.truncated/g) || []).length;
      assert(truncated >= 1, 'action.truncated event emitted (count=' + truncated + ')');
      const suppressed = (eventsRaw.match(/action\.suppressed/g) || []).length;
      assert(suppressed === 0, 'no action.suppressed events under truncation');
      // First N=2 mutating actions executed: createFolder + writeFile(a.txt)
      const createOps = ourOps.filter(o => o.operation === 'createFolder');
      assert(createOps.length === 1, 'first mutating createFolder executed (count=' + createOps.length + ')');
      const writeOps = ourOps.filter(o => o.operation === 'writeFile');
      // a.txt from truncation + d.txt,e.txt from compliant retry = 3
      assert(writeOps.length === 3, 'writeFiles: a.txt (truncated) + d.txt,e.txt (retry) (count=' + writeOps.length + ')');
      console.log('  PASS');
    }
  );

  // Test 3: ENABLED flag, all mutating (no non-mutating) → first N executed
  await testCase(
    'TRUNCATION-ALL-MUTATING',
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-am-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-ws-am-')),
    5050 + Math.floor(Math.random() * 200),
    { ENABLE_PREFIX_TRUNCATION: 'true' },
    3001,
    [
      { operation: 'createFolder', args: { path: 'am-target' } },
      { operation: 'writeFile', args: { path: 'am-target/1.txt', content: '1' } },
      { operation: 'writeFile', args: { path: 'am-target/2.txt', content: '2' } },
      { operation: 'writeFile', args: { path: 'am-target/3.txt', content: '3' } }
    ],
    [
      { operation: 'writeFile', args: { path: 'am-target/4.txt', content: '4' } },
      { operation: 'writeFile', args: { path: 'am-target/5.txt', content: '5' } }
    ],
    'model:mutating_action_limit',
    async ({ run, eventsRaw, ourOps }) => {
      assert(run.status === 'completed', 'all-mutating truncation run completes (status=' + run.status + ')');
      const truncated = (eventsRaw.match(/action\.truncated/g) || []).length;
      assert(truncated >= 1, 'action.truncated event emitted');
      // First 2 mutating: createFolder + writeFile 1.txt = 2 operations
      // Then compliant retry adds 2 more writeFiles = 2 operations
      assert(ourOps.length >= 3, 'mutating operations executed (count=' + ourOps.length + ')');
      console.log('  PASS');
    }
  );

  // Test 4: ENABLED flag, under limit → no truncation
  await testCase(
    'TRUNCATION-UNDER-LIMIT',
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-ul-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'tm3-ws-ul-')),
    5270 + Math.floor(Math.random() * 200),
    { ENABLE_PREFIX_TRUNCATION: 'true' },
    4001,
    [
      { operation: 'createFolder', args: { path: 'ul-target' } },
      { operation: 'writeFile', args: { path: 'ul-target/a.txt', content: 'a' } }
    ],
    [],
    'model:mutating_action_limit',
    async ({ run, eventsRaw, ourOps }) => {
      assert(run.status === 'completed', 'under-limit run completes (status=' + run.status + ')');
      const truncated = (eventsRaw.match(/action\.truncated/g) || []).length;
      assert(truncated === 0, 'no truncation under limit');
      const suppressed = (eventsRaw.match(/action\.suppressed/g) || []).length;
      assert(suppressed === 0, 'no suppression under limit');
      assert(ourOps.length === 2, 'all actions executed under limit (count=' + ourOps.length + ')');
      console.log('  PASS');
    }
  );

  console.log('\n' + (failures === 0 ? 'All tests passed.' : failures + ' test(s) failed.'));
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
