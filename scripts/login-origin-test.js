#!/usr/bin/env node
// CSRF origin-gate contract for browser logins (docs/BROWSER_ENVIRONMENT.md,
// "CSRF / Referrer-Policy interaction"). Chromium under a no-referrer policy
// serializes "Origin: null" on same-origin form POSTs; the gate must accept
// that only when the browser-controlled Sec-Fetch-Site header vouches for it,
// while cross-site posts stay rejected. A regression here locks operators out
// of /login entirely — this suite pins the full header matrix.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN_HASH = '$argon2id$v=19$m=65536,t=3,p=4$az+Aa/Vt5AjalPiSGPNdXQ$i+hlbZS1OGPnBIw16HfGY/u0A4VUqXdFkd5Y+JtXh/g';
const T0 = '2026-02-01T00:00:00.000Z';
const PORT = process.env.PORT || '3534';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'login-origin-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'login-origin-ws-'));

function assert(c, m) { if (!c) throw new Error(m); }

function seed() {
  const writeJson = (f, v) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v, null, 2));
  writeJson('users.json', [{ id: 1, username: 'admin', passwordHash: ADMIN_HASH, createdAt: T0, type: 'user' }]);
  writeJson('permissions.json', ['ticket:read']);
  writeJson('groups.json', [{ id: 1, name: 'Admins', permissions: ['ticket:read'], canReceiveTickets: false }]);
  writeJson('memberships.json', [{ id: 1, principalType: 'user', principalId: 1, groupId: 1 }]);
  writeJson('agents.json', []);
  writeJson('logs.json', []);
  fs.writeFileSync(path.join(DATA_DIR, 'events.jsonl'), '');
}

async function main() {
  seed();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' },
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

    const head = await fetch(`${BASE}/login`);
    assert(head.headers.get('referrer-policy') === 'same-origin',
      `Referrer-Policy must be same-origin (no-referrer nulls Origin in Chromium), got ${head.headers.get('referrer-policy')}`);

    const attempt = async headers => (await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ username: 'admin', password: 'admin123' }),
      redirect: 'manual'
    })).status;

    assert(await attempt({}) === 302, 'no Origin header (non-browser clients) must be allowed');
    assert(await attempt({ Origin: BASE }) === 302, 'matching Origin must be allowed');
    assert(await attempt({ Origin: 'null' }) === 403, 'Origin null alone must be rejected');
    assert(await attempt({ Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }) === 302, 'Origin null vouched by Sec-Fetch-Site same-origin must be allowed');
    assert(await attempt({ Origin: 'null', 'Sec-Fetch-Site': 'cross-site' }) === 403, 'Origin null with cross-site Sec-Fetch-Site must be rejected');
    assert(await attempt({ Origin: 'https://evil.example' }) === 403, 'cross-origin must be rejected');
    assert(await attempt({ Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }) === 403, 'cross-origin must be rejected even with forged Sec-Fetch-Site');

    console.log('PASS: login origin gate — same-origin referrer policy, null-Origin Sec-Fetch-Site fallback, cross-site rejection');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
