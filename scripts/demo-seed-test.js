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
  const body = options.form ? new URLSearchParams(options.form).toString()
    : options.json !== undefined ? JSON.stringify(options.json) : null;
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
  for (const f of ['users.json', 'tickets.json', 'runs.json', 'logs.json', 'events.jsonl', 'workflows.json', 'process-templates.json', 'process-template-triggers.json']) {
    assert(fs.existsSync(path.join(DATA_DIR, f)), `seed should create ${f}`);
  }
  assert(fs.existsSync(path.join(DATA_DIR, 'replay-snapshots', 'run-101.json')), 'seed should create referenced replay snapshots');
  // No provider key anywhere in the fixture (no live provider required).
  assert(!/sk-[A-Za-z0-9]/.test(fs.readFileSync(path.join(DATA_DIR, 'agents.json'), 'utf8')), 'demo agent must not carry a provider key');

  // Idempotent + deterministic: re-running over an existing demo dir succeeds and
  // produces byte-identical fixture content.
  const firstTickets = fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo-data.js')], {
    env: { ...process.env, DEMO_DATA_DIR: DATA_DIR, DEMO_WORKSPACE_ROOT: WORKSPACE_ROOT }, stdio: 'ignore'
  });
  assert(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8') === firstTickets, 're-seed should be deterministic/idempotent');

  // Safety guard: refuses to target the repo data/ or normal .local-data (would not wipe them).
  let refused = false;
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo-data.js')], {
      env: { ...process.env, DEMO_DATA_DIR: path.join(ROOT, '.local-data') }, stdio: 'ignore'
    });
  } catch (_) { refused = true; }
  assert(refused, 'seed must refuse to target .local-data');

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
    assert(triage.body.includes('authority_blocked') && triage.body.includes('href="/tickets/3"'), '/triage should list authority_blocked triage (ticket 3)');
    assert(triage.body.includes('objective_ambiguous') && triage.body.includes('href="/tickets/7"'), '/triage should list objective_ambiguous triage (ticket 7)');
    assert(triage.body.includes('verification_failed') && triage.body.includes('href="/runs/102"'), '/triage should list run-level triage (run 102)');
    assert(!triage.body.includes('No unresolved triage.'), '/triage should not be empty');
    // resolved run-106 triage excluded:
    assert(!triage.body.includes('href="/runs/106"'), '/triage must exclude resolved run triage (run 106)');

    // 7: objective_ambiguous ticket 7 has no run, no operation-history, and no workspace artifacts.
    const ticketsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const ambiguousTicket = ticketsJson.find(t => t.id === 7);
    assert(ambiguousTicket, 'ticket 7 must exist in seeded data');
    assert(ambiguousTicket.status === 'blocked', 'ticket 7 must be blocked');
    assert(ambiguousTicket.triage && ambiguousTicket.triage.required === true, 'ticket 7 must have required triage');
    assert(ambiguousTicket.triage.reasonCode === 'objective_ambiguous', 'ticket 7 triage reasonCode must be objective_ambiguous');
    assert(ambiguousTicket.triage.requiredDecision === 'clarify_objective', 'ticket 7 requiredDecision must be clarify_objective');

    const runsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8'));
    assert(runsJson.filter(r => r.ticketId === 7).length === 0, 'no run must exist for ambiguous ticket 7');

    const opsJson = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'operation-history.json'), 'utf8'));
    assert(opsJson.filter(e => e.ticketId === 7).length === 0, 'no operation-history entries for ambiguous ticket 7');

    const wsEntries = fs.readdirSync(WORKSPACE_ROOT);
    assert(!wsEntries.some(e => /michael/i.test(e)), 'workspace must not contain Michael Jackson songs folders');

    const ticketPage7 = await request('GET', '/tickets/7', { cookie });
    assert(ticketPage7.statusCode === 200, '/tickets/7 HTTP ' + ticketPage7.statusCode);
    assert(ticketPage7.body.includes('Ticket-Level Triage'), 'ticket 7 must show ticket-level triage');
    assert(ticketPage7.body.includes('objective_ambiguous'), 'ticket 7 must show objective_ambiguous');

    // 8: completed verified case renders verified objective success.
    const run101 = await request('GET', '/runs/101', { cookie });
    assert(run101.body.includes('<strong>Objective Success:</strong> Yes'), '/runs/101 should show verified objective success');

    // 9: budget advisory case renders exceeded advisory.
    const run104 = await request('GET', '/runs/104', { cookie });
    assert(run104.body.includes('Budget (advisory)') && run104.body.includes('exceeded (advisory)'), '/runs/104 should show budget advisory exceeded');
    const ticket4 = await request('GET', '/tickets/4', { cookie });
    assert(ticket4.body.includes('Budget Advisory') && ticket4.body.includes('exceeded (advisory)'), 'ticket 4 detail should show budget rollup exceeded');

    // 10: maxAttempts example renders the explicit ceiling.
    const ticket5 = await request('GET', '/tickets/5', { cookie });
    assert(ticket5.body.includes('2 · enforced for manual rerun-from-start'), 'ticket 5 should show explicit maxAttempts ceiling');

    // 11: resolved triage renders resolved on run detail (and is excluded from /triage, asserted above).
    const run106 = await request('GET', '/runs/106', { cookie });
    assert(run106.body.includes('Triage (resolved)') && run106.body.includes('Acknowledged'), '/runs/106 should show resolved triage with resolution note');

    // 12: logs/audit page renders the demo operator-control audit entries.
    const logs = await request('GET', '/logs', { cookie });
    assert(logs.statusCode === 200, '/logs HTTP ' + logs.statusCode);
    assert(logs.body.includes('ticket:max_attempts_change') && logs.body.includes('run:triage_resolve'), '/logs should render demo audit entries');

    // 13: process templates (r1.6) appear in the demo and the manual trigger story works.
    const templatesStore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    assert(Array.isArray(templatesStore) && templatesStore.length >= 2, 'demo seed must include the process template store with templates');
    assert(templatesStore.every(t => t.triggerType === 'manual'), 'all demo templates must be manual triggerType');
    assert(templatesStore.every(t => t.schedule === null), 'all demo templates must have schedule null (no scheduled execution)');
    assert(templatesStore.some(t => t.enabled === true), 'at least one demo template must be enabled');
    const safeTemplate = templatesStore.find(t => t.name === 'Weekly status report');
    const ambiguousTemplate = templatesStore.find(t => t.name === 'Ad-hoc folder batch');
    assert(safeTemplate && ambiguousTemplate, 'demo must include the safe and ambiguous templates');

    // Templates page renders the seeded templates with manual-only copy.
    const templatesPage = await request('GET', '/process-templates', { cookie });
    assert(templatesPage.statusCode === 200, '/process-templates HTTP ' + templatesPage.statusCode);
    assert(templatesPage.body.includes('Weekly status report') && templatesPage.body.includes('Ad-hoc folder batch'), 'templates page should render the seeded templates');
    assert(templatesPage.body.includes('Create ticket from template'), 'templates page must offer the manual trigger control');
    assert(!/running loop/i.test(templatesPage.body), 'templates page must not imply a running loop');

    const wsBeforeTriggers = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const ticketCountBefore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).length;

    // Safe template → exactly one ordinary ticket with provenance + a normal pending run.
    const safeTrigger = await request('POST', `/api/process-templates/${safeTemplate.id}/trigger`, { cookie, json: { triggerToken: 'demo-safe-1' } });
    assert(safeTrigger.statusCode === 200, 'safe trigger HTTP ' + safeTrigger.statusCode + ': ' + safeTrigger.body);
    const safeResult = JSON.parse(safeTrigger.body);
    assert(safeResult.ok && safeResult.deduped === false && safeResult.ticketId, 'safe trigger should create a ticket');
    const ticketsAfterSafe = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    assert(ticketsAfterSafe.length === ticketCountBefore + 1, 'safe trigger must create exactly one ticket');
    const safeTicket = ticketsAfterSafe.find(t => t.id === safeResult.ticketId);
    assert(safeTicket && safeTicket.source && safeTicket.source.type === 'process_template', 'generated ticket must record process_template provenance');
    ['templateId', 'templateName', 'triggeredBy', 'triggerType', 'triggerToken'].forEach(k =>
      assert(safeTicket.source[k] !== undefined && safeTicket.source[k] !== null, `provenance must include ${k}`));
    assert(safeTicket.source.triggerType === 'manual' && safeTicket.source.triggeredBy === 'admin', 'provenance must be manual + acting user');

    const safeRuns = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).filter(r => r.ticketId === safeTicket.id);
    assert(safeRuns.length === 1 && safeRuns[0].status === 'pending', 'clear generated ticket should create exactly one pending run via the normal path');

    // Trigger log + system log written.
    const triggerLog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-template-triggers.json'), 'utf8'));
    assert(triggerLog.some(e => e.triggerToken === 'demo-safe-1' && e.ticketId === safeTicket.id && e.ticketTemplateSnapshot), 'trigger log must record the demo trigger with a snapshot');
    const logsStore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8'));
    assert(logsStore.some(l => l.type === 'process_template:triggered' && l.contextTicketId === safeTicket.id), 'process_template:triggered system log must be written');

    // Provenance renders on generated ticket detail.
    const safeTicketPage = await request('GET', '/tickets/' + safeTicket.id, { cookie });
    assert(safeTicketPage.statusCode === 200 && safeTicketPage.body.includes('Created from template'), 'generated ticket detail should show provenance');

    // Ambiguous template → blocked/triaged generated ticket through the existing gate, no run.
    const ambTrigger = await request('POST', `/api/process-templates/${ambiguousTemplate.id}/trigger`, { cookie, json: { triggerToken: 'demo-amb-1' } });
    assert(ambTrigger.statusCode === 200, 'ambiguous trigger HTTP ' + ambTrigger.statusCode + ': ' + ambTrigger.body);
    const ambResult = JSON.parse(ambTrigger.body);
    assert(ambResult.ok && ambResult.ticketId, 'ambiguous trigger should still create the ticket object');
    const ambTicket = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).find(t => t.id === ambResult.ticketId);
    assert(ambTicket.status === 'blocked', 'ambiguous generated ticket must be blocked through the existing gate');
    assert(ambTicket.triage && ambTicket.triage.required === true && ambTicket.triage.reasonCode === 'objective_ambiguous', 'ambiguous generated ticket must carry objective_ambiguous triage');
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).filter(r => r.ticketId === ambTicket.id).length === 0, 'ambiguous generated ticket must create no run');

    // No workspace mutation occurred during either manual trigger.
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBeforeTriggers, 'template triggers must not mutate the workspace');

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
