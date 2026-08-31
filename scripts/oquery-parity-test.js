#!/usr/bin/env node
// Operator-surface parity for the oquery CLI (docs/OPERATIONAL_TRANSPARENCY.md,
// "Operator surface parity"): the inbox, event-journal, and admin-listing
// surfaces added alongside the UI must stay reachable headlessly. Drives the
// real CLI binary against a live server: inbox list/read (verbatim messages +
// triage facts), reply, resolve (annotates run triage without touching run
// status), journal filters + truncation flag, work-types, authority-paths
// (equality with the shared definition), browser-status, run-graph, and help
// coverage.
//
// Fixtures are seeded through the PostgreSQL store (postgres-operator-fixture.js)
// — the same authority the runtime writes through. Requires TEST_DATABASE_URL
// (or DATABASE_URL); each run uses an isolated schema that is dropped at the end.

const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { seedOperatorFixture } = require('./postgres-operator-fixture');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the oquery parity test');
  process.exit(1);
}

const SCHEMA = `oquery_parity_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const PORT = process.env.PORT || '3532';
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-ws-'));
const COOKIE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oquery-parity-cookie-'));
const COOKIE_PATH = path.join(COOKIE_DIR, '.opercookie');

function assert(c, m) { if (!c) throw new Error(m); }

function oquery(argv) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'oquery.js'), ...argv], {
    env: {
      ...process.env,
      OPERC_URL: BASE, OPERC_COOKIE_PATH: COOKIE_PATH,
      OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123'
    },
    encoding: 'utf8'
  });
}

async function main() {
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'oquery-parity-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_BOOTSTRAP_PASSWORD: 'admin123',
      PORT,
      WORKSPACE_ROOT,
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000',
      PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS: '3600000'
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

    const fx = await seedOperatorFixture(store);

    assert(oquery(['login']).includes('Session cached'), 'login must cache a session');

    const inboxJson = JSON.parse(oquery(['inbox', '--json']));
    assert(inboxJson.length >= 3, `inbox must list seeded threads, got ${inboxJson.length}`);
    const blocker = inboxJson.find(t => t.kind === 'blocker' && t.status === 'open' && t.runId === fx.failedRun.id);
    assert(blocker, 'failed-run blocker thread must be present');
    const openOnly = JSON.parse(oquery(['inbox', '--status', 'open', '--json']));
    assert(openOnly.every(t => t.status === 'open'), '--status open must filter');

    const threadOut = oquery(['inbox-thread', String(blocker.id)]);
    assert(threadOut.includes(blocker.messages[0].body.split('\n')[0]), 'thread must print the message body verbatim');
    assert(threadOut.includes('verification_failed') && threadOut.includes('review_failure'), 'thread must show triage facts');

    assert(oquery(['inbox-reply', String(blocker.id), '--message', 'Checked the evidence; restoring fixture.']).includes('Reply added'), 'reply must append');
    const resolveOut = oquery(['inbox-resolve', String(blocker.id), '--message', 'Fixture restored; safe to rerun.']);
    assert(resolveOut.includes('triage resolved'), 'resolve must report triage resolution');
    const resolvedRun = await store.getRun(fx.failedRun.id);
    assert(resolvedRun.triage.required === false && resolvedRun.triage.resolution === 'Fixture restored; safe to rerun.', 'resolve must annotate run triage with the message');
    assert(resolvedRun.status === 'failed', 'resolve must not change run status');

    const journal = JSON.parse(oquery(['journal', '--json']));
    assert(journal.events.length >= 2, 'journal must return seeded events');
    // Resolution itself appends run.triage_resolved — the journal shows live reality.
    const journalRun = JSON.parse(oquery(['journal', '--run', String(fx.failedRun.id), '--json']));
    assert(journalRun.events.every(e => e.runId === fx.failedRun.id)
      && journalRun.events.some(e => e.type === 'run.verification_failed')
      && journalRun.events.some(e => e.type === 'run.triage_resolved'), 'journal --run must filter and include the resolution event');
    const journalTrunc = JSON.parse(oquery(['journal', '--type', 'run.verification', '--limit', '1', '--json']));
    assert(journalTrunc.events.length === 1 && journalTrunc.truncated === true, 'journal must flag truncation');

    const wt = oquery(['work-types']);
    assert(wt.includes('meeting-brief') && wt.includes('site-audit') && wt.includes('grants no target access'), 'work-types must list catalog with boundary');

    const ap = JSON.parse(oquery(['authority-paths', '--json']));
    const configured = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'protected-paths.json'), 'utf8'));
    assert(JSON.stringify(ap.protectedWorkspacePaths) === JSON.stringify(configured) && ap.protectedPathsSource === 'config/protected-paths.json',
      'authority-paths must match the shared config definition');
    assert(ap.sensitiveApplicationPaths.includes('server.js') && ap.sensitiveApplicationPaths.includes('data'), 'sensitive paths must come from the shared module');

    const bs = oquery(['browser-status']);
    assert(bs.includes('Browser engine'), 'browser-status must report engine state');
    assert(bs.includes('No operator browser session'), 'browser-status must report absent session truthfully');

    const graphOut = oquery(['run-graph', String(fx.failedRun.id)]);
    assert(graphOut.includes('decision graph'), 'run-graph must render the graph header');
    assert(graphOut.includes('run failed'), 'run-graph must show the terminal outcome');
    assert(graphOut.includes('phase'), 'run-graph must show the execution phase');
    const graphJson = JSON.parse(oquery(['run-graph', String(fx.failedRun.id), '--json']));
    assert(Array.isArray(graphJson.nodes) && graphJson.nodes.some(n => n.id === 'terminal'), 'run-graph --json must emit the projection');
    assert(graphJson.currentPhase === 'terminalization', 'run-graph --json must carry the current phase');

    const helpOut = oquery(['--help']);
    for (const c of ['inbox', 'inbox-thread', 'inbox-resolve', 'journal', 'work-types', 'authority-paths', 'browser-status', 'run-graph']) {
      assert(helpOut.includes(c), `help must document ${c}`);
    }

    console.log('PASS: oquery parity — inbox read/reply/resolve, journal filters, catalog/authority listings, and browser status reachable headlessly');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
    fs.rmSync(COOKIE_DIR, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
