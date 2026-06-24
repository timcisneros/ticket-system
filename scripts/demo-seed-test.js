#!/usr/bin/env node
// Proves the deterministic demo seed produces a coherent, no-provider fixture that
// renders the full product loop (verified completion, triage, /triage inbox, budget
// advisory, maxAttempts, resolved triage, audit log) when the app boots against it.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = '3499';
const BASE_URL = 'http://127.0.0.1:' + PORT;

let server = null;
function assert(c, m) { if (!c) throw new Error(m); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(method, urlPath, options = {}) {
  const body = options.form ? new URLSearchParams(options.form).toString() : null;
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + urlPath, {
      method,
      headers: {
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...(options.cookie ? { Cookie: options.cookie } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookieFrom(res) { return (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '); }

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seed-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seed-ws-'));

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

async function main() {
  // 1: seed script runs successfully against an isolated demo directory.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo-data.js')], {
    env: { ...process.env, DEMO_DATA_DIR: DATA_DIR, DEMO_WORKSPACE_ROOT: WORKSPACE_ROOT },
    stdio: 'ignore'
  });

  // 2: expected files were created and are coherent.
  for (const f of ['users.json', 'tickets.json', 'runs.json', 'logs.json', 'events.jsonl', 'workflows.json']) {
    assert(fs.existsSync(path.join(DATA_DIR, f)), `seed should create ${f}`);
  }
  assert(fs.existsSync(path.join(DATA_DIR, 'replay-snapshots', 'run-101.json')), 'seed should create referenced replay snapshots');
  // No provider key anywhere in the fixture (no live provider required).
  assert(!/sk-[A-Za-z0-9]/.test(fs.readFileSync(path.join(DATA_DIR, 'agents.json'), 'utf8')), 'demo agent must not carry a provider key');

  // 3: app boots against the demo DATA_DIR (no OPENAI key in env).
  const env = { ...process.env, NODE_ENV: 'development', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' };
  delete env.OPENAI_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', c => { out += String(c); });
  server.stderr.on('data', c => { out += String(c); });

  try {
    await waitForReady();

    // 4: login works with the demo bootstrap credential.
    const loginRes = await request('POST', '/login', { form: { username: 'admin', password: 'admin123' } });
    assert(loginRes.statusCode === 302, 'demo admin login should succeed, got ' + loginRes.statusCode);
    const cookie = cookieFrom(loginRes);

    // 5: /tickets renders demo tickets.
    const tickets = await request('GET', '/tickets', { cookie });
    assert(tickets.statusCode === 200, '/tickets HTTP ' + tickets.statusCode);
    assert(tickets.body.includes('completed + verified') && tickets.body.includes('manual rerun ceiling'), '/tickets should render demo tickets');

    // 6: /triage contains unresolved ticket-level AND run-level triage, excludes resolved.
    const triage = await request('GET', '/triage', { cookie });
    assert(triage.statusCode === 200, '/triage HTTP ' + triage.statusCode);
    assert(triage.body.includes('authority_blocked') && triage.body.includes('href="/tickets/3"'), '/triage should list ticket-level triage (ticket 3)');
    assert(triage.body.includes('verification_failed') && triage.body.includes('href="/runs/102"'), '/triage should list run-level triage (run 102)');
    assert(!triage.body.includes('No unresolved triage.'), '/triage should not be empty');
    // resolved run-106 triage excluded:
    assert(!triage.body.includes('href="/runs/106"'), '/triage must exclude resolved run triage (run 106)');

    // 7: completed verified case renders verified objective success.
    const run101 = await request('GET', '/runs/101', { cookie });
    assert(run101.body.includes('<strong>Objective Success:</strong> Yes'), '/runs/101 should show verified objective success');

    // 8: budget advisory case renders exceeded advisory.
    const run104 = await request('GET', '/runs/104', { cookie });
    assert(run104.body.includes('Budget (advisory)') && run104.body.includes('exceeded (advisory)'), '/runs/104 should show budget advisory exceeded');
    const ticket4 = await request('GET', '/tickets/4', { cookie });
    assert(ticket4.body.includes('Budget Advisory') && ticket4.body.includes('exceeded (advisory)'), 'ticket 4 detail should show budget rollup exceeded');

    // 9: maxAttempts example renders the explicit ceiling.
    const ticket5 = await request('GET', '/tickets/5', { cookie });
    assert(ticket5.body.includes('2 · enforced for manual rerun-from-start'), 'ticket 5 should show explicit maxAttempts ceiling');

    // 10: resolved triage renders resolved on run detail (and is excluded from /triage, asserted above).
    const run106 = await request('GET', '/runs/106', { cookie });
    assert(run106.body.includes('Triage (resolved)') && run106.body.includes('Acknowledged'), '/runs/106 should show resolved triage with resolution note');

    // 11: logs/audit page renders the demo operator-control audit entries.
    const logs = await request('GET', '/logs', { cookie });
    assert(logs.statusCode === 200, '/logs HTTP ' + logs.statusCode);
    assert(logs.body.includes('ticket:max_attempts_change') && logs.body.includes('run:triage_resolve'), '/logs should render demo audit entries');

    console.log('PASS: deterministic demo seed renders the full product loop with no provider key');
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
