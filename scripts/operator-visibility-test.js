#!/usr/bin/env node
// Operator visibility surfaces added in the 2026-07 transparency arc
// (docs/OPERATIONAL_TRANSPARENCY.md): the event-journal browser, the admin
// authority/catalog listings, ticket watcher provenance, and the run-page
// evidence sections (lease/phase/heartbeat, recorded consequence, run
// evaluation, parsed model plans, workflow actions, and the
// transparency-by-default catch-all). All server-rendered, so this suite
// asserts against fetched HTML — no browser engine required.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3533';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-visibility-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-visibility-ws-'));

function assert(c, m) { if (!c) throw new Error(m); }
function readData(name) { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); }
function writeData(name, value) { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2)); }

function seed() {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo-data.js')], {
    env: { ...process.env, DEMO_DATA_DIR: DATA_DIR, DEMO_WORKSPACE_ROOT: WORKSPACE_ROOT }, stdio: 'ignore'
  });

  const groups = readData('groups.json');
  groups[0].permissions.push('ops:read', 'watcher:manage');
  writeData('groups.json', groups);

  writeData('work-types.json', [
    { id: 'meeting-brief', name: 'Meeting Brief', description: 'Summarize a meeting.', status: 'active', allowedTargetKinds: ['workspace'] },
    { id: 'site-audit', name: 'Site Audit', description: 'Read-only page inspection.', status: 'inactive', allowedTargetKinds: ['browser'] }
  ]);

  // Watcher provenance on ticket 4.
  const tickets = readData('tickets.json');
  const ticket4 = tickets.find(t => t.id === 4);
  ticket4.source = { type: 'watcher_proposal', watcherId: 7, proposalId: 12, observationId: 33, createdBy: 'admin', createdAt: ticket4.createdAt };
  writeData('tickets.json', tickets);
  writeData('watchers.json', [{ id: 7, name: 'Demo Watcher', status: 'active', workContextId: null, sourceKind: 'workspace_file', sourceRefs: [], cadenceNote: null, proposalPolicy: 'manual_approval', createdAt: ticket4.createdAt, updatedAt: ticket4.createdAt }]);

  // Enrich run 101: live machinery fields + consequence on the record, plus
  // evidence arrays (dedicated sections + one undedicated key for the catch-all)
  // in the replay snapshot.
  const runs = readData('runs.json');
  const run101 = runs.find(r => r.id === 101);
  run101.ownedOutputPaths = ['reports/q3'];
  run101.lastHeartbeatAt = '2026-03-01T09:00:05.000Z';
  run101.runConsequence = {
    mutations: [{ operation: 'writeFile', path: 'reports/q3/compliance-summary.md', historyId: 12 }],
    created: [{ operation: 'writeFile', path: 'reports/q3/compliance-summary.md', historyId: 12, type: 'file' }],
    updated: [], renamed: [], deleted: [],
    notifications: [], externalEffects: [],
    verification: { postconditionsStatus: 'passed', violationsStatus: 'none' }
  };
  writeData('runs.json', runs);

  const snapPath = path.join(DATA_DIR, 'replay-snapshots', 'run-101.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  snap.parsedModelPlans = [
    { message: 'Creating the summary file from the three inputs.', actions: [{ operation: 'writeFile', args: { path: 'reports/q3/summary.md' } }], complete: true, step: 1 }
  ];
  snap.workflowActions = [
    { workflowId: 'demo-verified-wf', stepId: 'read_inputs', action: 'readFile', input: { path: 'q1.md' }, result: { bytes: 120 }, startedAt: '2026-03-01T09:00:01.000Z', durationMs: 4 }
  ];
  snap.handoffTasks = [{ taskId: 'h1', from: 'planner', to: 'executor', operation: 'writeFile', path: 'out.txt', status: 'validated' }];
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));

  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'reports', 'q3'), { recursive: true });
}

async function main() {
  seed();
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', PORT, DATA_DIR, WORKSPACE_ROOT, RUNTIME_SCHEDULER_INTERVAL_MS: '3600000', PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000' },
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

    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'admin123' }),
      redirect: 'manual'
    });
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const get = async url => {
      const r = await fetch(BASE + url, { headers: { Cookie: cookie } });
      return { status: r.status, text: await r.text() };
    };

    // ── Event journal ──
    const journal = await get('/event-journal');
    assert(journal.status === 200 && journal.text.includes('<h1>Event Journal</h1>'), 'journal page must render');
    assert(journal.text.includes('run.verification_passed') && journal.text.includes('run.verification_failed'), 'journal must show seeded events');
    assert(journal.text.includes('href="/runs/101"') && journal.text.includes('href="/runs/102"'), 'journal must link to run pages');
    assert(journal.text.includes('href="/event-journal"'), 'nav must include the journal');
    const api = JSON.parse((await get('/api/event-journal?runId=102')).text);
    assert(api.events.length === 1 && api.events[0].type === 'run.verification_failed', 'journal API must filter by run');
    const trunc = JSON.parse((await get('/api/event-journal?type=run.verification&limit=1')).text);
    assert(trunc.events.length === 1 && trunc.truncated === true, 'journal API must flag truncation');
    const ops = await get('/ops');
    assert(ops.text.includes('href="/event-journal"'), '/ops must link to the journal');

    // ── Admin listings ──
    const admin = await get('/admin');
    assert(admin.status === 200, '/admin must render');
    assert(admin.text.includes('Workspace Authority Boundaries'), 'authority boundaries section must render');
    const configured = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'protected-paths.json'), 'utf8'));
    for (const p of configured) assert(admin.text.includes(`<code class="owned-path">${p}</code>`), `protected pattern ${p} must be listed`);
    assert(admin.text.includes('config/protected-paths.json') && !admin.text.includes('missing or unreadable'), 'protected-paths source must be truthful');
    for (const p of ['data', 'server.js', 'views/admin']) assert(admin.text.includes(`<code class="owned-path">${p}</code>`), `sensitive path ${p} must be listed`);
    assert(admin.text.includes('WORKSPACE_PROTECTED_PATH') && admin.text.includes('WORKSPACE_SENSITIVE_PATH'), 'error codes must be referenced');
    assert(admin.text.includes('Work Type Catalog'), 'work-type catalog section must render');
    assert(admin.text.includes('meeting-brief') && admin.text.includes('site-audit') && admin.text.includes('status-inactive'), 'catalog must include inactive entries');
    assert(admin.text.includes('do not grant target access or operations'), 'catalog authority boundary must be stated');

    // Catalog corrupted while running renders a visible error, not a 500.
    fs.writeFileSync(path.join(DATA_DIR, 'work-types.json'), '{ not valid');
    const adminBroken = await get('/admin');
    assert(adminBroken.status === 200 && adminBroken.text.includes('Catalog invalid:'), 'broken catalog must render as a visible error');

    // ── Ticket watcher provenance ──
    const ticketPage = await get('/tickets/4');
    assert(ticketPage.text.includes('Created from watcher proposal'), 'watcher provenance row must render');
    assert(ticketPage.text.includes('href="/watchers/7"') && ticketPage.text.includes('proposal #12') && ticketPage.text.includes('observation #33'), 'provenance must link watcher/proposal/observation');
    assert(ticketPage.text.includes('approved by admin'), 'provenance must show the approver');

    // ── Run page evidence sections ──
    const runPage = await get('/runs/101');
    assert(runPage.status === 200, 'run page must render');
    assert(runPage.text.includes('id="run-live-phase"') && runPage.text.includes('terminalization'), 'phase must render in the hero');
    assert(runPage.text.includes('id="run-live-heartbeat"') && runPage.text.includes('2026-03-01T09:00:05.000Z'), 'heartbeat must render in the hero');
    assert(runPage.text.includes('id="run-live-lease"'), 'lease must render in the hero');
    assert(runPage.text.includes('Recorded Consequence') && runPage.text.includes('reports/q3/compliance-summary.md'), 'recorded consequence card must render');
    assert(runPage.text.includes('history #12') && runPage.text.includes('postconditionsStatus'), 'consequence must show history ids and raw record');
    assert(runPage.text.includes('Run Evaluation'), 'run evaluation disclosure must render');
    assert(runPage.text.includes('Parsed Model Plans (1)') && runPage.text.includes('complete: true'), 'parsed model plans must render with complete flag');
    assert(runPage.text.includes('not all proposed actions may have executed'), 'parsed plans must carry the cap caveat');
    assert(runPage.text.includes('Workflow Actions (1)') && runPage.text.includes('read_inputs'), 'workflow actions must render');
    assert(runPage.text.includes('Other Recorded Evidence') && runPage.text.includes('handoffTasks'), 'catch-all must surface undedicated evidence arrays');
    assert(runPage.text.includes('href="/inbox?ticket=1"'), 'completed run must link to its inbox thread');
    assert(runPage.text.includes('/workspace?path=reports%2Fq3'), 'owned paths must link into the workspace environment');
    const workspaceLink = await get('/workspace?path=reports%2Fq3');
    assert(workspaceLink.status === 200, 'workspace link must resolve');

    console.log('PASS: operator visibility — event journal, admin authority/catalog listings, watcher provenance, and run-page evidence sections render truthfully');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
