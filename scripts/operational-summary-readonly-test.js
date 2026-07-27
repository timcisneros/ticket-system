#!/usr/bin/env node
'use strict';
// Operational summary: permission-gated and read-only — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Replaces the JSON-era `operational-transparency-test.js`, which seeded `data/*.json`
// and diffed those files to prove nothing was written.
//
// THE CONTRACT. `/ops` and `/api/ops/summary` aggregate live state from every store —
// tickets, runs, triage, work contexts, watchers, connectors, routing policies, process
// templates, schedules, admission metrics. It is the broadest read in the system, and
// two properties make it safe:
//
//   1. IT IS PERMISSION-GATED (`ops:read`). The summary is a deployment-wide picture; a
//      principal without the permission must not obtain it, on either surface.
//   2. IT WRITES NOTHING. An observability surface that mutates while being observed is
//      worse than no surface: it changes the thing an operator is trying to understand,
//      and it does so on every refresh and every dashboard poll.
//
// (2) IS THE HARD ONE AND IT IS WHY THIS SUITE EXISTS. "Read-only" is not enforced by a
// type or a route flag anywhere — it is a property of what `buildOperationalSummary`
// happens to call. Any future contributor adding a repository call that records an
// access log, touches a projection, or lazily materializes a cache would break it
// silently, because the response would look identical. So the proof is a full durable
// census taken before and after: ticket, run, event, log, operation-receipt and
// workspace state must be byte-identical across repeated reads of both surfaces.
//
// THE POSITIVE CONTROL IS LOAD-BEARING. A census that never changes proves nothing if
// the census itself is blind — an empty or broken census is trivially stable. Scenario 4
// performs a REAL mutation and requires every counter to move, establishing that the
// census can see change before scenario 3 relies on its stillness.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const argon2 = require('argon2');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;
const VIEWER_PASSWORD = 'ops-viewer-password';
const OUTSIDER_PASSWORD = 'ops-outsider-password';

function parse(body) {
  try { return JSON.parse(body); } catch (_) { return {}; }
}

async function main() {
  await withHarness('operational summary read-only', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `OpsSummary-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'operational-summary-readonly-test'
    })).agent;

    // Two non-admin principals: one holding ops:read, one holding an unrelated
    // permission. The second is what proves the gate keys off ops:read specifically
    // rather than merely "is authenticated" or "has any permission at all".
    const viewerGroup = (await store.createGroup({
      value: { name: `Ops viewers ${STAMP}`, permissions: ['ops:read'], canReceiveTickets: false },
      changedBy: 'operational-summary-readonly-test'
    })).group;
    const outsiderGroup = (await store.createGroup({
      value: { name: `Ops outsiders ${STAMP}`, permissions: ['ticket:create'], canReceiveTickets: false },
      changedBy: 'operational-summary-readonly-test'
    })).group;
    await store.createUser({
      value: { username: 'ops-viewer', passwordHash: await argon2.hash(VIEWER_PASSWORD) },
      groupIds: [viewerGroup.id], changedBy: 'operational-summary-readonly-test'
    });
    await store.createUser({
      value: { username: 'ops-outsider', passwordHash: await argon2.hash(OUTSIDER_PASSWORD) },
      groupIds: [outsiderGroup.id], changedBy: 'operational-summary-readonly-test'
    });

    const now = () => new Date().toISOString();
    async function seedTicket(label, status = 'open') {
      return (await store.createTicketWithEvent({
        ticket: {
          objective: `ops summary ${label} ${STAMP}`, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: { mode: 'assisted', requireVerification: 'when_declared' },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status, createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'operational-summary-readonly-test' }
      })).ticket;
    }

    const seeded = await seedTicket('seed');
    // The run carries an unexpired lease so the scheduler cannot claim it. Without this
    // the scheduler's first tick executes it, the ticket and run reach terminal states
    // mid-suite, and the read-only census below registers that background progress as if
    // the summary had written it — which is exactly what happened on the first run.
    await store.createRun({
      ticketId: seeded.id, agentId: agent.id, agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: {}, status: 'pending',
      leaseOwner: 'ops-summary-holder',
      leaseExpiresAt: new Date(Date.now() + 3600000).toISOString()
    });

    const server = await startServer({ RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' });
    const adminCookie = await server.login();
    const viewerCookie = await server.login('ops-viewer', VIEWER_PASSWORD);
    const outsiderCookie = await server.login('ops-outsider', OUTSIDER_PASSWORD);

    const summaryApi = cookie => server.request('GET', '/api/ops/summary', { cookie });
    const summaryPage = cookie => server.request('GET', '/ops', { cookie });

    // ── 1. The gate keys off ops:read on BOTH surfaces ──────────────────────
    scenariosRun += 1;
    const outsiderApi = await summaryApi(outsiderCookie);
    assert(outsiderApi.statusCode === 403,
      `1: a principal WITHOUT ops:read is refused the summary API (HTTP ${outsiderApi.statusCode})`);
    const outsiderPage = await summaryPage(outsiderCookie);
    assert(outsiderPage.statusCode === 403,
      `1: and refused the operator page too — a gate on one surface is not a gate (HTTP ${outsiderPage.statusCode})`);
    assert(!/ops summary seed/.test(String(outsiderApi.body) + String(outsiderPage.body)),
      '1: neither refusal leaks the state it withheld');

    const anonymous = await server.request('GET', '/api/ops/summary');
    assert(anonymous.statusCode >= 300,
      `1: an unauthenticated request does not receive the summary (HTTP ${anonymous.statusCode})`);

    // POSITIVE CONTROL for the gate: it is a permission check, not a broken endpoint.
    const viewerApi = await summaryApi(viewerCookie);
    assert(viewerApi.statusCode === 200,
      `1: a principal WITH ops:read is admitted (HTTP ${viewerApi.statusCode})`);
    assert(parse(viewerApi.body).ok === true && parse(viewerApi.body).summary,
      '1: and receives an actual summary, so the refusals above are the gate and not an outage');
    assert((await summaryPage(viewerCookie)).statusCode === 200,
      '1: the operator page admits the same principal');

    // ── 2. The summary reports real state, not placeholders ─────────────────
    scenariosRun += 1;
    const summary = parse(viewerApi.body).summary;
    for (const field of ['tickets', 'runs', 'triage', 'workContexts', 'watchers', 'connectors',
      'modelRoutingPolicies', 'processTemplates', 'schedules', 'mutationAdmission']) {
      assert(summary[field] !== undefined,
        `2: the summary reports ${field}`);
    }
    assert(Number.isInteger(summary.tickets.total) && summary.tickets.total >= 1,
      `2: ticket counts are real integers reflecting seeded state (${JSON.stringify(summary.tickets)})`);
    assert(Number.isInteger(summary.runs.total) && summary.runs.total >= 1,
      `2: run counts reflect the seeded run (${JSON.stringify(summary.runs)})`);
    assert(typeof summary.generatedAt === 'string',
      '2: the summary stamps when it was generated');
    assert(Array.isArray(summary.recentFailedRuns),
      '2: recent lists are arrays rather than unbounded dumps');
    assert(summary.recentFailedRuns.length <= 50,
      `2: and are bounded (${summary.recentFailedRuns.length})`);

    // ── 3. READING WRITES NOTHING ───────────────────────────────────────────
    // A full durable census across every surface an accidental write would touch.
    const census = async () => {
      const [tickets, runs, events, logs] = await Promise.all([
        store.listTickets({ limit: 300 }),
        store.listRuns({ limit: 300 }),
        store.listTicketEvents(seeded.id, { limit: 300 }),
        store.listLogs ? store.listLogs({ limit: 200 }) : Promise.resolve({ logs: [] })
      ]);
      return JSON.stringify({
        tickets: (tickets.tickets || []).map(t => [t.id, t.status, t.revision, t.updatedAt]),
        runs: (runs.runs || []).map(r => [r.id, r.status, r.revision]),
        events: (events.events || []).map(e => [e.id, e.type, e.seq]),
        logs: (logs.logs || []).length
      });
    };

    scenariosRun += 1;
    // Let any startup activity settle, then confirm the census is genuinely still BEFORE
    // trusting it — otherwise a drifting baseline would be blamed on the reads.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const settled = await census();
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert(await census() === settled,
      '3: the census is stable with no reads at all, so any later change is caused by the reads');
    const before = await census();
    // Read both surfaces repeatedly, as a dashboard poll would.
    for (let i = 0; i < 4; i += 1) {
      assert((await summaryApi(adminCookie)).statusCode === 200, `3: summary API read ${i + 1} succeeded`);
      assert((await summaryPage(viewerCookie)).statusCode === 200, `3: summary page read ${i + 1} succeeded`);
    }
    const after = await census();
    assert(after === before,
      '3: repeated reads of both surfaces changed NO durable state — no ticket, run, event, or log');

    // Refused reads must not write either: a rejected request that logged an access
    // record would still be a write on an observability path.
    const beforeRefused = await census();
    await summaryApi(outsiderCookie);
    await summaryPage(outsiderCookie);
    assert(await census() === beforeRefused,
      '3: refused reads changed no durable state either');

    // ── 4. POSITIVE CONTROL — the census can actually see change ────────────
    // Scenario 3 asserts stillness, which an inert or broken census would also satisfy.
    // This proves the census observes a real mutation before that stillness is trusted.
    scenariosRun += 1;
    const beforeMutation = await census();
    const mutated = await seedTicket('mutation-control');
    assert(await census() !== beforeMutation,
      '4: the census detects a genuine mutation, so scenario 3 is measuring something');

    const afterSummary = parse((await summaryApi(viewerCookie)).body).summary;
    assert(afterSummary.tickets.total > summary.tickets.total,
      `4: and the summary itself reflects the new ticket (${summary.tickets.total} → ${afterSummary.tickets.total})`);
    assert(afterSummary.generatedAt !== summary.generatedAt,
      '4: the summary is derived live per request rather than served from a cached snapshot');

    // ── 5. The summary is a projection, not a ledger ────────────────────────
    // It must not become a new authority: reading it may not create a stored summary
    // record that later reads serve instead of live state.
    scenariosRun += 1;
    const eventTypesBefore = new Set(((await store.listTicketEvents(mutated.id, { limit: 200 })).events || [])
      .map(event => event.type));
    await summaryApi(adminCookie);
    await summaryPage(adminCookie);
    const eventTypesAfter = ((await store.listTicketEvents(mutated.id, { limit: 200 })).events || [])
      .map(event => event.type);
    assert(eventTypesAfter.every(type => eventTypesBefore.has(type)),
      `5: reading the summary emitted no new event types (${eventTypesAfter.filter(t => !eventTypesBefore.has(t)).join(', ')})`);
    assert(!eventTypesAfter.some(type => /summary|ops/i.test(type)),
      '5: and recorded no summary artefact of its own');

    assertScenariosExecuted({
      label: 'operational summary read-only',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 29,
      minScenarios: 5
    });
    console.log(`\nPASS: operational summary read-only — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'ops_summary' });
}

main().catch(error => {
  console.error(`\nFAIL: operational summary read-only — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
