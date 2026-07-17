#!/usr/bin/env node
// Operator browser environment at /browser (docs/BROWSER_ENVIRONMENT.md).
// Proves: Environments nav menu, target-scoped session lifecycle (one session
// per operator, duplicate open 409), all five Phase 1 operations against a live
// local origin, origin-allowlist rejection, wait capped at the target limit,
// unsupported operations refused, and a workspace-grade audit trail
// (browser:operator_session_opened/_closed, browser:operator_operation with
// pre/post page state, screenshot sha256, no base64 in logs).
// Live-engine checks are skipped when no Chromium executable is available.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-03-01T00:00:00.000Z';
const APP_PORT = process.env.PORT || '3513';
const SITE_PORT = process.env.SITE_PORT || '3514';
const BASE = `http://127.0.0.1:${APP_PORT}`;
const ORIGIN = `http://127.0.0.1:${SITE_PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-env-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-env-ws-'));

function assert(c, m) { if (!c) throw new Error(m); }

function findEngineExecutable() {
  const candidates = [
    process.env.BROWSER_ENGINE_EXECUTABLE,
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/snap/bin/chromium'
  ].filter(Boolean);
  return candidates.find(candidate => {
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch (_) { return false; }
  }) || null;
}

function seed() {
  const writeJson = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:read', 'user:read', 'browser:read', 'browser:operate']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:read', 'user:read', 'browser:read', 'browser:operate'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('browser-targets.json', [{
    id: 'env-local', name: 'Env Local Site', status: 'active',
    allowedOrigins: [ORIGIN], startUrl: `${ORIGIN}/`,
    limits: { maxNavigationsPerRun: 3, maxActionsPerRun: 10, navTimeoutMs: 15000, waitTimeoutMsCap: 2000, maxPageTextBytes: 20000, maxScreenshotsPerRun: 2 }
  }]);
  writeJson('logs.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

async function request(method, urlPath, { cookie, form, json } = {}) {
  const headers = {};
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(BASE + urlPath, { method, headers, body, redirect: 'manual' });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) {}
  return { status: response.status, headers: response.headers, text, data };
}

async function main() {
  const executable = findEngineExecutable();
  seed();

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Env Target</title></head><body><h1>Browser Env Test</h1><a href="/next">next page</a><button>Press me</button><p>Some readable body text for the operator.</p></body></html>');
  });
  await new Promise(resolve => site.listen(SITE_PORT, '127.0.0.1', resolve));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: APP_PORT, DATA_DIR, WORKSPACE_ROOT,
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      ...(executable ? { BROWSER_ENGINE_EXECUTABLE: executable } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  server.stdout.on('data', c => { out += c; });
  server.stderr.on('data', c => { out += c; });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      if (server.exitCode !== null) break;
      try { if ((await fetch(`${BASE}/login`)).status === 200) { up = true; break; } } catch (_) {}
      await new Promise(r => setTimeout(r, 400));
    }
    assert(up, 'server did not start:\n' + out.slice(-4000));

    const login = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');

    // Nav + page render.
    const page = await request('GET', '/browser', { cookie });
    assert(page.status === 200 && page.text.includes('<h1>Browser</h1>'), 'GET /browser must render');
    assert(page.text.includes('>Environments<'), 'nav must contain the Environments menu');
    assert(page.text.includes('href="/browser"'), 'Environments menu must link to /browser');
    assert(page.text.includes('Env Local Site'), 'page must list the active target');

    if (!executable) {
      assert(page.text.includes('unavailable'), 'engine status must render unavailable without an executable');
      const refused = await request('POST', '/api/browser/session', { cookie, json: { targetId: 'env-local' } });
      assert(refused.status === 400, 'session open without an engine must fail');
      console.log('SKIP live browser environment checks: no executable BROWSER_ENGINE_EXECUTABLE or system Chromium found');
      console.log('PASS: browser environment (engine-unavailable path)');
      return;
    }

    // Session lifecycle.
    const opened = await request('POST', '/api/browser/session', { cookie, json: { targetId: 'env-local' } });
    assert(opened.status === 200 && opened.data.session.target.id === 'env-local', 'session open failed: ' + opened.text.slice(0, 200));
    assert((await request('POST', '/api/browser/session', { cookie, json: { targetId: 'env-local' } })).status === 409, 'duplicate session open must 409');

    const op = (operation, args = {}) => request('POST', '/api/browser/operation', { cookie, json: { operation, args } });

    // navigate + counters.
    const nav = await op('navigate', { url: `${ORIGIN}/` });
    assert(nav.status === 200 && nav.data.receipt.metadata.status === 200, 'navigate failed: ' + nav.text.slice(0, 300));
    assert(nav.data.session.counters.actions === 1 && nav.data.session.counters.navigations === 1, 'session counters must track operations');

    // Origin allowlist.
    const blocked = await op('navigate', { url: 'https://example.com/' });
    assert(blocked.status === 400 && blocked.data.code === 'BROWSER_ORIGIN_BLOCKED', 'off-allowlist navigation must be refused');

    // observe / readPageText / screenshot / wait.
    const obs = await op('observe');
    assert(obs.status === 200 && obs.data.result.elements.length >= 2, 'observe must return the element inventory');
    const text = await op('readPageText');
    assert(text.status === 200 && text.data.result.text.includes('readable body text'), 'readPageText must return page text');
    const shot = await op('screenshot');
    assert(shot.status === 200 && String(shot.data.result.dataUrl || '').startsWith('data:image/png;base64,'), 'screenshot must return a png preview');
    assert(fs.existsSync(path.join(DATA_DIR, shot.data.result.artifactPath)), 'screenshot artifact must persist under DATA_DIR');
    const wait = await op('wait', { forMs: 5000 });
    assert(wait.status === 200 && wait.data.result.waitedMs === 2000 && wait.data.receipt.truncated === true, 'wait must cap at waitTimeoutMsCap');

    // Unsupported operation (Phase 1 boundary).
    const bad = await op('click');
    assert(bad.status === 400 && bad.data.code === 'BROWSER_OPERATION_UNSUPPORTED', 'non-Phase-1 operations must be refused');

    // Close.
    const closed = await request('DELETE', '/api/browser/session', { cookie });
    assert(closed.status === 200 && closed.data.closed === true, 'session close failed');

    // Audit trail.
    const logs = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8'));
    assert(logs.filter(l => l.type === 'browser:operator_session_opened').length === 1, 'session open must be audit-logged');
    const closedLogs = logs.filter(l => l.type === 'browser:operator_session_closed');
    assert(closedLogs.length === 1 && closedLogs[0].reason === 'operator_close', 'session close must be audit-logged with reason');
    const ops = logs.filter(l => l.type === 'browser:operator_operation');
    assert(ops.length === 6, `expected 6 operation logs (5 ok + 1 blocked), got ${ops.length}`);
    const navLog = ops.find(l => l.workspaceAction && l.workspaceAction.operation === 'navigate' && !l.error);
    assert(navLog && navLog.postState && navLog.postState.url && navLog.postState.titleHash, 'operation logs must capture post-state page evidence');
    assert(navLog.requestedBy === 'admin', 'operation logs must record requestedBy');
    const shotLog = ops.find(l => l.workspaceAction && l.workspaceAction.operation === 'screenshot');
    assert(shotLog && shotLog.receipt && shotLog.receipt.metadata.sha256 && shotLog.receipt.metadata.artifactPath, 'screenshot receipt must carry sha256 + artifact path');
    assert(!JSON.stringify(logs).includes('base64'), 'screenshot base64 preview must never reach the logs');
    assert(ops.some(l => l.errorCode === 'BROWSER_ORIGIN_BLOCKED'), 'blocked navigation must be audit-logged with its error code');

    console.log('PASS: browser environment — target-scoped audited operator sessions with Phase 1 operations, limits, and origin allowlist');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    site.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
