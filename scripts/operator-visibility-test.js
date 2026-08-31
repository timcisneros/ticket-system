#!/usr/bin/env node
// Operator visibility surfaces added in the 2026-07 transparency arc
// (docs/OPERATIONAL_TRANSPARENCY.md): the event-journal browser, the admin
// authority/catalog listings, ticket watcher provenance, and the run-page
// evidence sections (lease/phase/heartbeat, recorded consequence, run
// evaluation, parsed model plans, workflow actions, and the
// transparency-by-default catch-all). All server-rendered, so this suite
// asserts against fetched HTML — no browser engine required.
//
// Fixtures are seeded through the PostgreSQL store (postgres-operator-fixture.js)
// — the same authority the runtime writes through. Requires TEST_DATABASE_URL
// (or DATABASE_URL); each run uses an isolated schema that is dropped at the end.

const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { seedOperatorFixture } = require('./postgres-operator-fixture');

const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('TEST_DATABASE_URL (or DATABASE_URL) is required for the operator visibility test');
  process.exit(1);
}

const SCHEMA = `operator_visibility_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const PORT = process.env.PORT || '3533';
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-visibility-ws-'));

function assert(c, m) { if (!c) throw new Error(m); }

async function main() {
  const store = new PostgresRuntimeStore({ connectionString: DATABASE_URL, schema: SCHEMA, disposableMigrations: true });
  await store.migrate();
  fs.mkdirSync(path.join(WORKSPACE_ROOT, 'reports', 'q3'), { recursive: true });

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL,
      POSTGRES_SCHEMA: SCHEMA,
      SESSION_SECRET: 'operator-visibility-session-secret-0123456789abcdef0123456789abcdef',
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

    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'admin123' }),
      redirect: 'manual'
    });
    assert(login.status === 302, `admin login returned HTTP ${login.status}`);
    const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const get = async url => {
      const r = await fetch(BASE + url, { headers: { Cookie: cookie } });
      return { status: r.status, text: await r.text() };
    };

    // ── Tickets list filter chips ──
    // T2 five-state lifecycle: Ticket-level `failed` is retired, so the filter
    // chips enumerate the five valid statuses and run failures surface through
    // the latest-run accent instead of a ticket status class.
    const ticketsPage = await get('/tickets');
    assert(ticketsPage.text.includes('class="filter-chip') && ticketsPage.text.includes('filter-chip__count'), 'tickets page must render status filter chips with counts');
    // Filter-href vocabulary check: every status query param on /tickets comes
    // from the ticket-page href builder, so `status=<vocabulary>` pins the
    // rendered chip set without broad page-text searches (run-level "failed"
    // evidence words elsewhere are legitimate).
    for (const lifecycleStatus of ['open', 'in_progress', 'blocked', 'completed', 'canceled']) {
      assert(ticketsPage.text.includes(`status=${lifecycleStatus}`), `tickets page must expose the ${lifecycleStatus} lifecycle filter`);
    }
    assert(!ticketsPage.text.includes('status=failed'), 'retired Ticket lifecycle filter failed must not be exposed');
    assert(!ticketsPage.text.includes('status=closed'), 'retired Ticket lifecycle filter closed must not be exposed');
    const openFiltered = await get('/tickets?status=open');
    assert(openFiltered.status === 200 && !openFiltered.text.includes('ticket-card--completed'), '?status=open must exclude completed cards');
    assert(openFiltered.text.includes('ticket-card--open'), '?status=open must include open cards');
    assert(ticketsPage.text.includes('is-failed'), 'a failed latest run must still surface as a card failure accent');

    // ── Event journal ──
    const journal = await get('/event-journal');
    assert(journal.status === 200 && journal.text.includes('<h1>Event Journal</h1>'), 'journal page must render');
    assert(journal.text.includes('run.verification_passed') && journal.text.includes('run.verification_failed'), 'journal must show seeded events');
    assert(journal.text.includes(`href="/runs/${fx.verifiedRun.id}"`) && journal.text.includes(`href="/runs/${fx.failedRun.id}"`), 'journal must link to run pages');
    assert(journal.text.includes('href="/event-journal"'), 'nav must include the journal');
    const api = JSON.parse((await get(`/api/event-journal?runId=${fx.failedRun.id}&type=run.verification`)).text);
    assert(api.events.length === 1 && api.events[0].type === 'run.verification_failed', 'journal API must filter by run and type');
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

    // ── Ticket watcher provenance (written by the real approval authority) ──
    const ticketPage = await get(`/tickets/${fx.watcherTicket.id}`);
    assert(ticketPage.text.includes('Created from watcher proposal'), 'watcher provenance row must render');
    assert(ticketPage.text.includes(`href="/watchers/${fx.watcher.id}"`) && ticketPage.text.includes(`proposal #${fx.proposal.id}`) && ticketPage.text.includes(`observation #${fx.observation.id}`), 'provenance must link watcher/proposal/observation');
    assert(ticketPage.text.includes('approved by admin'), 'provenance must show the approver');

    // ── Run page evidence sections ──
    const runPage = await get(`/runs/${fx.verifiedRun.id}`);
    assert(runPage.status === 200, 'run page must render');
    assert(runPage.text.includes('id="run-live-phase"') && runPage.text.includes('terminalization'), 'phase must render in the hero');
    assert(runPage.text.includes('id="run-live-heartbeat"'), 'heartbeat must render in the hero');
    assert(runPage.text.includes('id="run-live-lease"'), 'lease must render in the hero');
    assert(runPage.text.includes('Recorded Consequence') && runPage.text.includes('reports/q3/compliance-summary.md'), 'recorded consequence card must render');
    assert(runPage.text.includes('history #12') && runPage.text.includes('postconditionsStatus'), 'consequence must show history ids and raw record');
    assert(runPage.text.includes('Run Evaluation'), 'run evaluation disclosure must render');
    assert(runPage.text.includes('Parsed Model Plans (1)') && runPage.text.includes('complete: true'), 'parsed model plans must render with complete flag');
    assert(runPage.text.includes('not all proposed actions may have executed'), 'parsed plans must carry the cap caveat');
    assert(runPage.text.includes('Workflow Actions (1)') && runPage.text.includes('read_inputs'), 'workflow actions must render');
    assert(runPage.text.includes('Other Recorded Evidence') && runPage.text.includes('handoffTasks'), 'catch-all must surface undedicated evidence arrays');
    assert(runPage.text.includes(`href="/inbox?ticket=${fx.verifiedTicket.id}"`), 'completed run must link to its inbox thread');
    assert(runPage.text.includes('/workspace?path=reports%2Fq3'), 'owned paths must link into the workspace environment');
    const workspaceLink = await get('/workspace?path=reports%2Fq3');
    assert(workspaceLink.status === 200, 'workspace link must resolve');

    // ── Run decision map ──
    assert(runPage.text.includes(`href="/runs/${fx.verifiedRun.id}/map"`), 'run hero must link to the decision map');
    const mapPage = await get(`/runs/${fx.verifiedRun.id}/map`);
    assert(mapPage.status === 200 && mapPage.text.includes('Decision Map'), 'map page must render');
    assert(mapPage.text.includes('every node cites its evidence'), 'map page must state the projection boundary');
    const graphApi = JSON.parse((await get(`/api/runs/${fx.verifiedRun.id}/decision-graph`)).text);
    assert(JSON.stringify(graphApi.lanes) === JSON.stringify(['model', 'authority', 'target', 'outcome']), 'graph must carry the lane order');
    const planNode = graphApi.nodes.find(n => n.kind === 'parsed_plan');
    assert(planNode && planNode.detail.message === 'Creating the summary file from the three inputs.', 'graph plan node must carry the verbatim model message');
    assert(graphApi.nodes.some(n => n.kind === 'workflow_action'), 'graph must include workflow actions');
    assert(graphApi.nodes.some(n => n.id === 'terminal' && n.status === 'completed'), 'graph must include the terminal outcome');
    assert(graphApi.nodes.every(n => typeof n.evidenceRef === 'string' && n.evidenceRef.length > 0), 'every graph node must cite evidence');
    assert(typeof graphApi.cursor === 'string' && graphApi.cursor.length > 0, 'graph must carry a change-detection cursor');
    assert(graphApi.currentPhase === 'terminalization', 'graph must carry the stored current phase');
    assert(graphApi.nodes.some(n => n.kind === 'evaluation') && graphApi.nodes.some(n => n.kind === 'consequence'), 'graph outcome lane must carry evaluation and consequence records');
    const missingGraph = await get('/api/runs/99999/decision-graph');
    assert(missingGraph.status === 404, 'unknown run must 404');

    // Diagnostics bundle must carry the recovery timeline and the decision
    // graph (same projection).
    assert(runPage.text.includes('## 18. Recovery / Resume History'), 'bundle must have the Recovery / Resume History section');
    assert(runPage.text.includes('Run lease duration:'), 'recovery section must state the lease duration');
    assert(runPage.text.includes('## 19. Decision Graph'), 'bundle must have the Decision Graph section');
    assert(runPage.text.includes('## 20. Redaction Notice'), 'redaction notice must remain the final section');
    assert(runPage.text.includes('model message (verbatim):') && runPage.text.includes('Creating the summary file from the three inputs.'), 'bundle must carry the verbatim plan message');
    assert(runPage.text.includes('[complete:true]'), 'bundle must carry the complete flag');
    assert(runPage.text.includes('read_inputs'), 'bundle must carry workflow actions');

    console.log('PASS: operator visibility — event journal, admin authority/catalog listings, watcher provenance, and run-page evidence sections render truthfully');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1200));
    if (server.exitCode === null) server.kill('SIGKILL');
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await store.close();
    fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
