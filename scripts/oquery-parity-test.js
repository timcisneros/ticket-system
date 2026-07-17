#!/usr/bin/env node
// Operator-surface parity for the oquery CLI (docs/OPERATIONAL_TRANSPARENCY.md,
// "Operator surface parity"): the inbox, event-journal, and admin-listing
// surfaces added alongside the UI must stay reachable headlessly. Drives the
// real CLI binary against a live server seeded with the demo fixture:
// inbox list/read (verbatim messages + triage facts), reply, resolve (annotates
// run triage without touching run status), journal filters + truncation flag,
// work-types (including the catalog-invalid path), authority-paths (equality
// with the shared definition), browser-status, and help coverage.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || '3532';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-data-'));
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-ws-'));
const COOKIE_PATH = path.join(DATA_DIR, '.opercookie');

function assert(c, m) { if (!c) throw new Error(m); }

function oquery(argv) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'oquery.js'), ...argv], {
    env: {
      ...process.env, DATA_DIR,
      OPERC_URL: BASE, OPERC_COOKIE_PATH: COOKIE_PATH,
      OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123'
    },
    encoding: 'utf8'
  });
}

async function main() {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo-data.js')], {
    env: { ...process.env, DEMO_DATA_DIR: DATA_DIR, DEMO_WORKSPACE_ROOT: WORKSPACE_ROOT }, stdio: 'ignore'
  });
  const groups = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'groups.json'), 'utf8'));
  groups[0].permissions.push('ops:read', 'browser:read');
  fs.writeFileSync(path.join(DATA_DIR, 'groups.json'), JSON.stringify(groups, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, 'work-types.json'), JSON.stringify([
    { id: 'meeting-brief', name: 'Meeting Brief', description: 'Summarize a meeting.', status: 'active', allowedTargetKinds: ['workspace'] },
    { id: 'site-audit', name: 'Site Audit', description: 'Read-only page inspection.', status: 'inactive', allowedTargetKinds: ['browser'] }
  ], null, 2));

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

    assert(oquery(['login']).includes('Session cached'), 'login must cache a session');

    const inboxJson = JSON.parse(oquery(['inbox', '--json']));
    assert(inboxJson.length >= 3, `inbox must list demo threads, got ${inboxJson.length}`);
    const blocker = inboxJson.find(t => t.kind === 'blocker' && t.status === 'open' && t.runId === 102);
    assert(blocker, 'run-102 blocker thread must be present');
    const openOnly = JSON.parse(oquery(['inbox', '--status', 'open', '--json']));
    assert(openOnly.every(t => t.status === 'open'), '--status open must filter');

    const threadOut = oquery(['inbox-thread', String(blocker.id)]);
    assert(threadOut.includes(blocker.messages[0].body.split('\n')[0]), 'thread must print the message body verbatim');
    assert(threadOut.includes('verification_failed') && threadOut.includes('review_failure'), 'thread must show triage facts');

    assert(oquery(['inbox-reply', String(blocker.id), '--message', 'Checked the evidence; restoring fixture.']).includes('Reply added'), 'reply must append');
    const resolveOut = oquery(['inbox-resolve', String(blocker.id), '--message', 'Fixture restored; safe to rerun.']);
    assert(resolveOut.includes('triage resolved'), 'resolve must report triage resolution');
    const run102 = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'runs.json'), 'utf8')).find(r => r.id === 102);
    assert(run102.triage.required === false && run102.triage.resolution === 'Fixture restored; safe to rerun.', 'resolve must annotate run triage with the message');
    assert(run102.status === 'failed', 'resolve must not change run status');

    const journal = JSON.parse(oquery(['journal', '--json']));
    assert(journal.events.length >= 2, 'journal must return seeded events');
    // Resolution itself appends run.triage_resolved — the journal shows live reality.
    const journalRun = JSON.parse(oquery(['journal', '--run', '102', '--json']));
    assert(journalRun.events.every(e => e.runId === 102)
      && journalRun.events.some(e => e.type === 'run.verification_failed')
      && journalRun.events.some(e => e.type === 'run.triage_resolved'), 'journal --run must filter and include the resolution event');
    const journalTrunc = JSON.parse(oquery(['journal', '--type', 'run.verification', '--limit', '1', '--json']));
    assert(journalTrunc.events.length === 1 && journalTrunc.truncated === true, 'journal must flag truncation');

    const wt = oquery(['work-types']);
    assert(wt.includes('meeting-brief') && wt.includes('site-audit') && wt.includes('grants no target access'), 'work-types must list catalog with boundary');
    fs.writeFileSync(path.join(DATA_DIR, 'work-types.json'), '{ broken');
    assert(oquery(['work-types']).includes('Catalog invalid'), 'work-types must surface an invalid catalog truthfully');

    const ap = JSON.parse(oquery(['authority-paths', '--json']));
    const configured = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'protected-paths.json'), 'utf8'));
    assert(JSON.stringify(ap.protectedWorkspacePaths) === JSON.stringify(configured) && ap.protectedPathsSource === 'config/protected-paths.json',
      'authority-paths must match the shared config definition');
    assert(ap.sensitiveApplicationPaths.includes('server.js') && ap.sensitiveApplicationPaths.includes('data'), 'sensitive paths must come from the shared module');

    const bs = oquery(['browser-status']);
    assert(bs.includes('Browser engine'), 'browser-status must report engine state');
    assert(bs.includes('No operator browser session'), 'browser-status must report absent session truthfully');

    const helpOut = oquery(['--help']);
    for (const c of ['inbox', 'inbox-thread', 'inbox-resolve', 'journal', 'work-types', 'authority-paths', 'browser-status']) {
      assert(helpOut.includes(c), `help must document ${c}`);
    }

    console.log('PASS: oquery parity — inbox read/reply/resolve, journal filters, catalog/authority listings, and browser status reachable headlessly');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
