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
  const env = { ...process.env, NODE_ENV: 'development', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' };
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
    assert(templatesStore.every(t => t.triggerType === 'manual'), 'all demo templates keep triggerType manual (the schedule object governs scheduling)');
    assert(templatesStore.some(t => t.enabled === true), 'at least one demo template must be enabled');
    const safeTemplate = templatesStore.find(t => t.name === 'Weekly status report');
    const ambiguousTemplate = templatesStore.find(t => t.name === 'Ad-hoc folder batch');
    // The two manual-story templates stay schedule-null; the scheduled story is template 3 (section 14).
    assert(safeTemplate && safeTemplate.schedule === null && ambiguousTemplate && ambiguousTemplate.schedule === null, 'manual demo templates must remain schedule null');
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

    // 14: scheduled process template (r1.7) — interval/UTC, due, fired by a scan tick.
    const schedTemplate = templatesStore.find(t => t.name === 'Daily compliance digest');
    assert(schedTemplate, 'demo must include a scheduled process template');
    assert(schedTemplate.schedule && schedTemplate.schedule.enabled === true, 'demo scheduled template must have schedule.enabled true');
    assert(schedTemplate.schedule.kind === 'interval', 'demo schedule must be kind interval');
    assert(schedTemplate.schedule.timezone === 'UTC', 'demo schedule must be timezone UTC');
    assert(Number.isInteger(schedTemplate.schedule.everySeconds) && schedTemplate.schedule.everySeconds >= 60, 'demo schedule everySeconds must be a valid integer >= minimum');

    // Templates page renders schedule status with safe copy.
    const schedPage = await request('GET', '/process-templates', { cookie });
    assert(schedPage.body.includes('Daily compliance digest'), 'templates page should render the scheduled template');
    assert(schedPage.body.includes('Schedule ticket creation'), 'templates page must say "Schedule ticket creation"');
    assert(/Creates a ticket every/.test(schedPage.body), 'templates page must show interval schedule status');
    assert(!/running loop/i.test(schedPage.body), 'templates page must not say "running loop"');

    // Fixture for the ambiguous-scheduled case: give the existing ambiguous template a
    // due interval schedule (kept out of the seed to avoid demo noise).
    var ptStore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    var ambTmpl = ptStore.find(t => t.name === 'Ad-hoc folder batch');
    ambTmpl.schedule = { enabled: true, kind: 'interval', everySeconds: 86400, anchor: schedTemplate.schedule.anchor, nextRunAt: schedTemplate.schedule.nextRunAt, lastScheduledTriggerAt: null, timezone: 'UTC', scheduledBy: 'admin' };
    fs.writeFileSync(path.join(DATA_DIR, 'process-templates.json'), JSON.stringify(ptStore, null, 2));

    const wsBeforeScan = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const ticketCountBeforeScan = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).length;

    // Run one scheduled scan: both due templates (3 safe, 2 ambiguous fixture) fire once.
    const scan = await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(scan.statusCode === 200, 'scheduler tick HTTP ' + scan.statusCode + ': ' + scan.body);

    const afterScan = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'));
    const schedTicket = afterScan.find(t => t.source && t.source.templateId === schedTemplate.id && t.source.triggerType === 'schedule');
    assert(schedTicket, 'scheduled scan must create one ordinary ticket for the due scheduled template');
    assert(afterScan.filter(t => t.source && t.source.templateId === schedTemplate.id && t.source.triggerType === 'schedule').length === 1, 'exactly one scheduled ticket for the safe template');

    // Scheduled provenance.
    const s = schedTicket.source;
    assert(s.type === 'process_template', 'scheduled ticket source.type process_template');
    assert(s.triggerType === 'schedule', 'scheduled ticket source.triggerType must be schedule');
    assert(s.triggeredBy === 'system', 'scheduled ticket source.triggeredBy must be system');
    assert(typeof s.scheduledFor === 'string' && s.scheduledFor, 'scheduled ticket source.scheduledFor present');
    assert(typeof s.triggerToken === 'string' && s.triggerToken.indexOf('schedule:') === 0, 'scheduled ticket triggerToken begins with schedule:');

    // One pending run via the normal path; no workspace mutation.
    const schedRuns = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).filter(r => r.ticketId === schedTicket.id);
    assert(schedRuns.length === 1 && schedRuns[0].status === 'pending', 'scheduled clear ticket creates exactly one pending run via the normal path');

    // Trigger log + system log for the scheduled trigger.
    const schedLedger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-template-triggers.json'), 'utf8'));
    assert(schedLedger.some(e => e.ticketId === schedTicket.id && e.triggerType === 'schedule' && e.triggerToken === s.triggerToken), 'trigger log records the scheduled trigger');
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')).some(l => l.type === 'process_template:triggered' && l.contextTicketId === schedTicket.id && l.triggerType === 'schedule'), 'process_template:triggered system log for scheduled trigger');

    // Provenance renders on the generated scheduled ticket detail.
    const schedDetail = await request('GET', '/tickets/' + schedTicket.id, { cookie });
    assert(schedDetail.statusCode === 200 && schedDetail.body.includes('Created from template'), 'scheduled ticket detail should show provenance');

    // Ambiguous scheduled (fixture) → blocked with objective_ambiguous, no run.
    const ambSchedTicket = afterScan.find(t => t.source && t.source.templateId === ambTmpl.id && t.source.triggerType === 'schedule');
    assert(ambSchedTicket && ambSchedTicket.status === 'blocked', 'ambiguous scheduled ticket must be blocked');
    assert(ambSchedTicket.triage && ambSchedTicket.triage.reasonCode === 'objective_ambiguous', 'ambiguous scheduled ticket must carry objective_ambiguous triage');
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).filter(r => r.ticketId === ambSchedTicket.id).length === 0, 'ambiguous scheduled ticket must create no run');

    // No historical storm: each due template produced exactly one ticket this scan.
    assert(afterScan.length === ticketCountBeforeScan + 2, 'one scan created exactly one ticket per due template (no storm)');

    // Repeated scan does not duplicate (cursor advanced forward; ledger/source dedupe).
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).length === afterScan.length, 'repeated scheduled scan must not duplicate tickets');

    // No workspace mutation during the scheduled trigger itself.
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBeforeScan, 'scheduled triggers must not mutate the workspace');

    // 15: r1.9 template controls — a DISABLED template and a PAUSED scheduled template.
    const schedFor = (id) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === id).length;
    const ctrlPage = await request('GET', '/process-templates', { cookie });
    assert(ctrlPage.statusCode === 200, '/process-templates renders for controls');
    assert(ctrlPage.body.includes('Archived intake digest') && ctrlPage.body.includes('Template disabled'), 'disabled template shows "Template disabled" state');
    assert(ctrlPage.body.includes('Paused weekly export') && ctrlPage.body.includes('Schedule paused'), 'paused scheduled template shows "Schedule paused" state');
    assert(/badge--health-paused/.test(ctrlPage.body), 'paused template shows the paused health badge');
    assert(ctrlPage.body.includes('Disable template') && ctrlPage.body.includes('Enable template'), 'page shows Disable (enabled) and Enable (disabled) controls');
    assert(ctrlPage.body.includes('Pause scheduled ticket creation') && ctrlPage.body.includes('Resume scheduled ticket creation'), 'page shows Pause (active) and Resume (paused) controls');
    assert(ctrlPage.body.includes('Paused schedules do not create tickets.'), 'page shows paused explanatory copy');
    assert(ctrlPage.body.includes('/tickets/8'), 'disabled template still lists its prior generated ticket (history/provenance intact)');

    const wsCtrlBefore = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());

    // Disabled template (4): manual trigger blocked by the existing 409.
    assert((await request('POST', '/api/process-templates/4/trigger', { cookie, json: { triggerToken: 'demo-dis-1' } })).statusCode === 409, 'disabled template manual trigger returns 409');

    // Neither the disabled template (4, has a due schedule) nor the paused template (5)
    // creates a scheduled ticket on a scan.
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(schedFor(4) === 0, 'disabled template creates no scheduled ticket on a scan');
    assert(schedFor(5) === 0, 'paused template creates no scheduled ticket on a scan');

    // Paused template (5): manual trigger still works; interval config preserved.
    const pausedManual = await request('POST', '/api/process-templates/5/trigger', { cookie, json: { triggerToken: 'demo-paused-manual-1' } });
    assert(pausedManual.statusCode === 200 && JSON.parse(pausedManual.body).ok, 'paused template still allows manual trigger');
    const t5 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8')).find(t => t.id === 5);
    assert(t5.schedule.enabled === false && t5.schedule.nextRunAt === null && t5.schedule.kind === 'interval' && t5.schedule.everySeconds === 86400 && t5.schedule.timezone === 'UTC', 'pause preserves the reusable interval config');

    // Resume (5): recompute forward, no immediate ticket; a later due scan creates one.
    const resume5 = await request('POST', '/api/process-templates/5/schedule/resume', { cookie, json: {} });
    const resume5body = JSON.parse(resume5.body);
    assert(resume5.statusCode === 200 && resume5body.schedule.enabled === true, 'resume returns ok');
    assert(Date.parse(resume5body.schedule.nextRunAt) > Date.now(), 'resume recomputes nextRunAt forward from now');
    const sched5Before = schedFor(5);
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(schedFor(5) === sched5Before, 'immediate scan after resume creates no ticket (no catch-up)');
    var s5store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    s5store.find(t => t.id === 5).schedule.nextRunAt = '2020-01-01T00:00:00.000Z'; // simulate the interval elapsing
    fs.writeFileSync(path.join(DATA_DIR, 'process-templates.json'), JSON.stringify(s5store, null, 2));
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    assert(schedFor(5) === sched5Before + 1, 'a later due scan creates exactly one scheduled ticket (no storm)');

    // Controls never write to the trigger ledger; the prior generated ticket survives.
    assert(!JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-template-triggers.json'), 'utf8')).some(e => /pause|resume|disable|enable/.test(e.triggerType || '')), 'control ops do not pollute the trigger ledger');
    const t8 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8')).find(t => t.id === 8);
    assert(t8 && t8.status === 'completed' && t8.source && t8.source.templateId === 4, 'pre-existing generated ticket + provenance intact after controls');

    // GET /process-templates remains read-only.
    const ctrlFiles = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'logs.json'];
    const ctrlSnap = {}; ctrlFiles.forEach(f => { ctrlSnap[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8'); });
    const wsSnap = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    await request('GET', '/process-templates', { cookie });
    ctrlFiles.forEach(f => assert(fs.readFileSync(path.join(DATA_DIR, f), 'utf8') === ctrlSnap[f], `${f} unchanged by GET /process-templates`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsSnap && JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsCtrlBefore, 'no workspace mutation during the control demo checks');

    // 16: r1.10 template version provenance — demo readiness.
    const verTemplates = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    assert(verTemplates.some(t => t.version === 1), 'demo includes at least one template with version 1');
    const verPage = await request('GET', '/process-templates', { cookie });
    assert(/Weekly status report\s*<span class="text-muted">v1<\/span>/.test(verPage.body), '/process-templates renders the active version (v1)');

    // Versioned generated ticket (#9) shows "Created from template <name> v1".
    const verTicketDetail = await request('GET', '/tickets/9', { cookie });
    assert(verTicketDetail.statusCode === 200, 'versioned generated ticket detail renders');
    assert(/Weekly status report<\/a> v1/.test(verTicketDetail.body), 'versioned ticket detail shows "Created from template … v1"');
    // Legacy generated ticket (#8, no templateVersion) still renders safely — unlabeled.
    const legacyTicketDetail = await request('GET', '/tickets/8', { cookie });
    assert(legacyTicketDetail.statusCode === 200 && legacyTicketDetail.body.includes('Created from template'), 'legacy (no-version) generated ticket still renders');
    assert(!/Archived intake digest<\/a> v/.test(legacyTicketDetail.body), 'legacy ticket shows no version suffix');

    // Ledger: r1.10 entry (#9) records templateVersion AND keeps the immutable snapshot+policy.
    const verLedger = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-template-triggers.json'), 'utf8'));
    const v9 = verLedger.find(e => e.ticketId === 9);
    assert(v9 && v9.templateVersion === 1, 'ledger entry records templateVersion');
    assert(v9.ticketTemplateSnapshot && v9.executionPolicyUsed, 'ledger entry still includes ticketTemplateSnapshot + executionPolicyUsed');

    // A LIVE scheduled trigger stamps templateVersion and keeps a version-free token.
    var vstore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    vstore.find(t => t.id === 3).schedule.nextRunAt = '2020-01-01T00:00:00.000Z'; // make template 3 due
    fs.writeFileSync(path.join(DATA_DIR, 'process-templates.json'), JSON.stringify(vstore, null, 2));
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    const liveSched = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tickets.json'), 'utf8'))
      .filter(t => t.source && t.source.templateId === 3 && t.source.triggerType === 'schedule')
      .sort((a, b) => b.id - a.id)[0];
    assert(liveSched && liveSched.source.templateVersion === 1, 'scheduled trigger stamps templateVersion: 1');
    assert(liveSched.source.triggerToken === 'schedule:3:2020-01-01T00:00:00.000Z', 'scheduled token is schedule:<id>:<iso> — version-free');

    // r1.12: the append-only version store now exists (seeded with a v1/v2 story, exercised
    // in section 17). The templates page still exposes no in-place edit / replay-old-version UI.
    assert(fs.existsSync(path.join(DATA_DIR, 'process-template-versions.json')), 'append-only version store exists (r1.12)');
    assert(!/edit template|version history editor|replay old version/i.test(verPage.body), 'templates page implies no editing');

    // GET /process-templates remains read-only across these checks.
    const vFiles = ['runs.json'];
    const vSnap = {}; vFiles.forEach(f => { vSnap[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8'); });
    const vWs = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    await request('GET', '/process-templates', { cookie });
    vFiles.forEach(f => assert(fs.readFileSync(path.join(DATA_DIR, f), 'utf8') === vSnap[f], `${f} unchanged by GET /process-templates`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === vWs, 'no workspace mutation during version-provenance demo checks');

    // 17: r1.12.1 — append-only template version draft/activation lifecycle (demo readiness).
    // The seed ships template 1 ("Weekly status report") with a v1 active record AND a pending
    // v2 draft. A draft is harmless until activated: the root is still v1, ticket #9 is still a
    // v1 generated ticket, and no v2 ticket exists yet. This section drives the live lifecycle
    // from that seeded starting point and proves activation changes FUTURE tickets only.
    const ticketsPath = path.join(DATA_DIR, 'tickets.json');
    const runsPath = path.join(DATA_DIR, 'runs.json');
    const versionsPath = path.join(DATA_DIR, 'process-template-versions.json');
    const ledgerPath = path.join(DATA_DIR, 'process-template-triggers.json');

    // Seeded store: v1 active + v2 draft for template 1; append-only and coherent.
    const verStore = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
    const seededV1 = verStore.find(v => v.id === 'ptv_1_1');
    const seededV2 = verStore.find(v => v.id === 'ptv_1_2');
    assert(seededV1 && seededV1.templateId === 1 && seededV1.version === 1 && seededV1.status === 'active', 'seeded v1 is the active version of template 1');
    assert(seededV2 && seededV2.templateId === 1 && seededV2.version === 2 && seededV2.status === 'draft', 'seeded v2 is a draft of template 1');
    assert(verStore.filter(v => v.templateId === 1 && v.status === 'active').length === 1, 'exactly one active version for template 1');
    assert(verStore.filter(v => v.templateId === 1 && v.status === 'draft').length === 1, 'exactly one draft for template 1 (one-draft rule)');
    assert(!verStore.some(v => v.templateId === 1 && v.status === 'superseded'), 'seeded store has no superseded record yet (no activation seeded)');
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8')).find(t => t.id === 1).currentVersion === 1, 'root template stays on v1 while a draft exists (a draft is harmless until activated)');

    // Old v1 generated ticket #9 (seeded): provenance + ledger retained.
    const t9seed = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).find(t => t.id === 9);
    assert(t9seed.source.templateVersion === 1, 'seeded generated ticket #9 carries source.templateVersion 1');
    const seedLedger9 = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).find(e => e.ticketId === 9);
    assert(seedLedger9 && seedLedger9.templateVersion === 1 && seedLedger9.ticketTemplateSnapshot && seedLedger9.executionPolicyUsed, 'v1 ledger entry keeps templateVersion + ticketTemplateSnapshot + executionPolicyUsed');

    // ---- Live activation of the seeded draft (template 1 is enabled + unscheduled → safe). ----
    const wsBeforeVer = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const ticketsBeforeAct = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length;
    const runsBeforeAct = fs.readFileSync(runsPath, 'utf8');

    // One-draft-per-template: a second draft is rejected while a draft exists.
    assert((await request('POST', '/api/process-templates/1/versions/draft', { cookie, json: {} })).statusCode === 409, 'second draft rejected while a draft exists');

    const act1 = await request('POST', '/api/process-templates/1/versions/ptv_1_2/activate', { cookie, json: {} });
    assert(act1.statusCode === 200 && JSON.parse(act1.body).activeVersion === 2, 'seeded draft activates to v2: ' + act1.body);
    // Activation by itself creates no ticket, no run, and mutates no workspace files.
    assert(JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length === ticketsBeforeAct, 'activation alone creates no ticket');
    assert(fs.readFileSync(runsPath, 'utf8') === runsBeforeAct, 'activation alone creates no run');
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBeforeVer, 'activation alone mutates no workspace files');
    // Append-only store transition: v1 superseded, v2 active with supersedes + activatedAt.
    const afterStore = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
    assert(afterStore.find(v => v.id === 'ptv_1_1').status === 'superseded', 'prior active v1 marked superseded (old record kept, not deleted)');
    const v2after = afterStore.find(v => v.id === 'ptv_1_2');
    assert(v2after.status === 'active' && v2after.supersedesVersionId === 'ptv_1_1' && v2after.activatedAt, 'v2 active, supersedes v1, activatedAt stamped');
    // Root re-points to v2; page renders the active version.
    const t1after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8')).find(t => t.id === 1);
    assert(t1after.currentVersion === 2 && t1after.version === 2, 'root template re-points to active v2');
    const verPageV2 = await request('GET', '/process-templates', { cookie });
    assert(/Weekly status report\s*<span class="text-muted">v2<\/span>/.test(verPageV2.body), '/process-templates shows the active version (v2) after activation');

    // Old generated ticket #9 stays v1 — activation never rewrites past tickets/ledger.
    const t9after = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).find(t => t.id === 9);
    assert(t9after.source.templateVersion === 1, 'old generated ticket #9 remains v1 after activation');
    const t9detail = await request('GET', '/tickets/9', { cookie });
    assert(t9detail.statusCode === 200 && /Weekly status report<\/a> v1/.test(t9detail.body), 'old ticket detail still renders v1 after activation');

    // New manual trigger after activation → a v2 generated ticket (future tickets only).
    const postTrig = await request('POST', '/api/process-templates/1/trigger', { cookie, json: { triggerToken: 'demo-weekly-v2' } });
    assert(postTrig.statusCode === 200, 'post-activation manual trigger ok: ' + postTrig.body);
    const postId = JSON.parse(postTrig.body).ticketId;
    const postTicket = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).find(t => t.id === postId);
    assert(postTicket.source.templateVersion === 2, 'new generated ticket after activation is v2');
    assert(postTicket.objective === 'Create folder reports (v2 draft: add an executive summary)', 'new generated ticket uses v2 content');
    const postDetail = await request('GET', '/tickets/' + postId, { cookie });
    assert(postDetail.statusCode === 200 && /Weekly status report<\/a> v2/.test(postDetail.body), 'new ticket detail renders v2');
    const ledgerAfter = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const v2Ledger = ledgerAfter.find(e => e.ticketId === postId);
    assert(v2Ledger && v2Ledger.templateVersion === 2 && v2Ledger.ticketTemplateSnapshot && v2Ledger.executionPolicyUsed, 'v2 ledger entry records templateVersion 2 + ticketTemplateSnapshot + executionPolicyUsed');
    // The seeded v1 ledger entry is left byte-intact (append-only history).
    assert(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).find(e => e.ticketId === 9).templateVersion === 1, 'old v1 ledger entry unchanged after activation');

    // ---- Scheduled template (3): draft is harmless; activation requires PAUSE first; token stays version-free. ----
    const wsBeforeSched = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const ticketsBeforeSchedDraft = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length;
    const runsBeforeSchedDraft = fs.readFileSync(runsPath, 'utf8');
    const d3 = await request('POST', '/api/process-templates/3/versions/draft', { cookie, json: { ticketTemplate: { objective: 'Create folder compliance (v2)' }, changeSummary: 'Draft v2' } });
    assert(d3.statusCode === 200 && JSON.parse(d3.body).ok, 'draft for scheduled template ok: ' + d3.body);
    // Draft alone creates no ticket, no run, and mutates no workspace files.
    assert(JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length === ticketsBeforeSchedDraft, 'draft alone creates no ticket');
    assert(fs.readFileSync(runsPath, 'utf8') === runsBeforeSchedDraft, 'draft alone creates no run');
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBeforeSched, 'draft alone mutates no workspace files');

    // Activation blocked while schedule.enabled === true — pause the schedule first.
    const blocked = await request('POST', '/api/process-templates/3/versions/ptv_3_2/activate', { cookie, json: {} });
    assert(blocked.statusCode === 409 && /pause the schedule/i.test(blocked.body), 'activation blocked while schedule enabled (pause first)');
    assert(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'logs.json'), 'utf8')).some(l => l.type === 'process_template:version_activation_blocked' && l.templateId === 3), 'activation_blocked audit log written');

    // Pause, then activate.
    assert((await request('POST', '/api/process-templates/3/schedule/pause', { cookie, json: {} })).statusCode === 200, 'pause schedule ok');
    const sched3Before = JSON.stringify(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8')).find(t => t.id === 3).schedule);
    const wsBeforeSchedAct = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    const ticketsBeforeSchedAct = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length;
    const act3 = await request('POST', '/api/process-templates/3/versions/ptv_3_2/activate', { cookie, json: {} });
    assert(act3.statusCode === 200 && JSON.parse(act3.body).activeVersion === 2, 'activation succeeds after pause: ' + act3.body);
    // Activation does not touch the schedule cursor and creates no ticket/workspace mutation.
    assert(JSON.stringify(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8')).find(t => t.id === 3).schedule) === sched3Before, 'activation does not change the schedule cursor');
    assert(JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).length === ticketsBeforeSchedAct, 'scheduled-template activation alone creates no ticket');
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === wsBeforeSchedAct, 'scheduled-template activation alone mutates no workspace files');

    // A scheduled trigger after activation stamps v2 AND keeps a version-free token.
    const SLOT = '2020-06-01T00:00:00.000Z';
    var schedStore = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'process-templates.json'), 'utf8'));
    var t3 = schedStore.find(t => t.id === 3);
    t3.schedule.enabled = true; t3.schedule.nextRunAt = SLOT; // resume + make due (direct, deterministic)
    fs.writeFileSync(path.join(DATA_DIR, 'process-templates.json'), JSON.stringify(schedStore, null, 2));
    const sched3CountBefore = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 3).length;
    await request('POST', '/api/process-templates/scheduler/tick', { cookie, json: {} });
    const sched3Tickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf8')).filter(t => t.source && t.source.triggerType === 'schedule' && t.source.templateId === 3);
    assert(sched3Tickets.length === sched3CountBefore + 1, 'scheduled scan after activation creates exactly one ticket');
    const newSched = sched3Tickets.sort((a, b) => b.id - a.id)[0];
    assert(newSched.source.templateVersion === 2, 'scheduled ticket after activation stamps templateVersion 2');
    assert(newSched.source.triggerToken === 'schedule:3:' + SLOT, 'scheduled token is schedule:<templateId>:<scheduledForIso> — version-free');
    assert(!/version|versionId|ptv_/i.test(newSched.source.triggerToken), 'scheduled token includes no version/versionId');

    // No old-version replay / rich-edit / workflow-builder UI or copy is exposed.
    const verUiPage = await request('GET', '/process-templates', { cookie });
    assert(!/replay old version|old-version replay|version history editor|workflow builder/i.test(verUiPage.body), 'templates page exposes no old-version replay / rich-edit / workflow-builder copy');

    // GET /process-templates remains read-only across the r1.12.1 checks.
    const verFiles = ['tickets.json', 'runs.json', 'process-templates.json', 'process-template-triggers.json', 'process-template-versions.json', 'logs.json'];
    const verSnap = {}; verFiles.forEach(f => { verSnap[f] = fs.readFileSync(path.join(DATA_DIR, f), 'utf8'); });
    const verWs = JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort());
    await request('GET', '/process-templates', { cookie });
    verFiles.forEach(f => assert(fs.readFileSync(path.join(DATA_DIR, f), 'utf8') === verSnap[f], `${f} unchanged by GET /process-templates`));
    assert(JSON.stringify(fs.readdirSync(WORKSPACE_ROOT).sort()) === verWs, 'no workspace mutation during r1.12.1 demo checks');

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
