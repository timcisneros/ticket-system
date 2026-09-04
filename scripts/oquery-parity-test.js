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

function oquery(argv, extraEnv = {}) {
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'oquery.js'), ...argv], {
    env: {
      ...process.env,
      OPERC_URL: BASE, OPERC_COOKIE_PATH: COOKIE_PATH,
      OPERC_USERNAME: 'admin', OPERC_PASSWORD: 'admin123',
      ...extraEnv
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
    for (const c of ['inbox', 'inbox-thread', 'inbox-resolve', 'journal', 'work-types', 'authority-paths', 'browser-status', 'run-graph', 'token issue', 'token list', 'token revoke', '--token-file', 'TTS_TOKEN']) {
      assert(helpOut.includes(c), `help must document ${c}`);
    }

    // ── P1 governed programmatic access: session-backed token bootstrap ────
    // Issue the FIRST token through the cached session (oquery login), with
    // raw-once display, an explicit cannot-be-retrieved warning, and no digest.
    const hexDigestPattern = /\b[0-9a-f]{64}\b/i;
    const issueOut = oquery(['token', 'issue', '--label', 'parity bootstrap token']);
    assert(issueOut.includes('tts_'), 'issue must display the raw tts_ token');
    assert(issueOut.includes('ONCE') && issueOut.includes('cannot be retrieved again'),
      'issue must warn the raw token cannot be retrieved again');
    const rawToken = (issueOut.match(/tts_[A-Za-z0-9_-]{43}/) || [])[0];
    assert(rawToken, 'issue must display exactly one well-formed raw token');
    assert(!hexDigestPattern.test(issueOut), 'issue output must never contain a digest');
    assert(issueOut.includes('--token-file') && issueOut.includes('TTS_TOKEN'),
      'issue must recommend --token-file/TTS_TOKEN over history-exposed literals');

    const issuedList = JSON.parse(oquery(['token', 'list', '--json']));
    assert(Array.isArray(issuedList.tokens) && issuedList.tokens.length >= 1, 'token list must return own tokens');
    const listed = issuedList.tokens.find(token => token.label === 'parity bootstrap token');
    assert(listed && listed.revokedAt === null, 'the issued token is listed active');
    assert(JSON.stringify(Object.keys(listed).sort()) === JSON.stringify(['createdAt', 'id', 'label', 'revokedAt'].sort()),
      'list projections carry exactly id/label/createdAt/revokedAt');
    assert(!hexDigestPattern.test(oquery(['token', 'list'])), 'list output must never contain a digest');
    assert(!/tts_[A-Za-z0-9_-]{43}/.test(oquery(['token', 'list'])), 'list output must never re-display a raw token');

    // Bearer consumption, no session at all: --token-file owns authentication.
    // A stale objective identical to a SEEDED ticket proves the returned
    // identity is the canonical created ticket, not an objective match.
    const duplicatedObjective = 'Generate Q3 compliance summary (completed + verified)';
    const tokenFile = path.join(COOKIE_DIR, 'parity-token');
    fs.writeFileSync(tokenFile, rawToken, 'utf8');
    const noCookiePath = path.join(COOKIE_DIR, 'no-such-cookie-file');
    const created = JSON.parse(oquery(
      ['create-ticket', '--token-file', tokenFile, '--json', duplicatedObjective],
      { OPERC_COOKIE_PATH: noCookiePath }
    ));
    assert(created.ticketId > 0, 'create-ticket with --token-file must return the canonical created ticket id');
    assert(!hexDigestPattern.test(JSON.stringify(created)), 'create-ticket output must never contain a digest');
    // The canonical id resolves the EXACT new ticket (never the seeded
    // lookalike that shares the objective), and the objective string is never
    // used to look the ticket up.
    const runtimeOfCreated = await (async () => {
      const res = await fetch(`${BASE}/api/tickets/${created.ticketId}/runtime`, {
        headers: { Authorization: `Bearer ${rawToken}` }
      });
      assert(res.status === 200, 'the returned canonical ticket id must resolve the created ticket for the bearer');
      return res.json();
    })();
    assert(runtimeOfCreated.ticket.objective === duplicatedObjective, 'the created ticket carries the requested objective');
    assert(runtimeOfCreated.ticket.id === created.ticketId, 'runtime lookup by returned id is the created ticket');
    const seededWithSameObjective = (await store.pool.query(
      `SELECT MIN(id)::int AS id FROM ${store.table('tickets')} WHERE body->>'objective' = $1`,
      [duplicatedObjective]
    )).rows[0].id;
    assert(seededWithSameObjective < created.ticketId,
      'the canonical id is the freshly created ticket, not the pre-existing objective match');

    // A bearer token cannot issue another bearer token: the token plane is
    // session-only, so a bearer-only CLI invocation must fail authentication.
    const bearerIssueOut = oquery(['token', 'issue', '--label', 'must fail', '--json'], {
      OPERC_COOKIE_PATH: noCookiePath,
      TTS_TOKEN: rawToken
    });
    assert(bearerIssueOut.includes('not_authenticated'),
      'bearer-only token issue must fail authentication (never mint credentials)');
    assert(!/tts_[A-Za-z0-9_-]{43}/.test(bearerIssueOut), 'the failed issue must not mint or display any token');

    // TTS_TOKEN consumption on create-ticket (no session file either).
    const envCreated = JSON.parse(oquery(
      ['create-ticket', '--json', 'Parity TTS_TOKEN objective'],
      { OPERC_COOKIE_PATH: noCookiePath, TTS_TOKEN: rawToken }
    ));
    assert(envCreated.ticketId > 0, 'create-ticket must consume TTS_TOKEN');

    // Revoke through the session-backed CLI; the bearer stops authenticating.
    const revokeOut = oquery(['token', 'revoke', String(listed.id)]);
    assert(revokeOut.includes('revoked'), 'revoke must report success');
    const revokeAgain = oquery(['token', 'revoke', String(listed.id), '--json']);
    assert(revokeAgain.includes('not_found'), 'revoking an already-revoked token answers 404, no oracle');
    assert(!hexDigestPattern.test(revokeOut + revokeAgain), 'revoke output must never contain a digest');
    // The revoked bearer must not create anything: the CLI reports failure
    // (agent resolution and POST both 401) and the server persists no ticket.
    const revokedCreateOut = oquery(['create-ticket', '--token-file', tokenFile, '--json', 'must not run after revoke'], {
      OPERC_COOKIE_PATH: noCookiePath
    });
    assert(!revokedCreateOut.includes('ticketId'),
      'a revoked bearer must not produce a creation summary');
    assert(!hexDigestPattern.test(revokedCreateOut), 'refused create-ticket output must never contain a digest');
    const refusedTicketCount = (await store.pool.query(
      `SELECT COUNT(*)::int AS count FROM ${store.table('tickets')} WHERE body->>'objective' = 'must not run after revoke'`
    )).rows[0].count;
    assert(refusedTicketCount === 0, 'a revoked bearer creates no ticket');

    const listAfterRevoke = JSON.parse(oquery(['token', 'list', '--json']));
    const revokedListed = listAfterRevoke.tokens.find(token => token.id === listed.id);
    assert(revokedListed && revokedListed.revokedAt, 'the revoked token remains listed as revoked (permanent)');

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
