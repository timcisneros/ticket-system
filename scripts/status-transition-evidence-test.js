#!/usr/bin/env node
'use strict';
// Ticket status transition evidence trail — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contract under test, unchanged from the JSON-era original: every ticket status
// transition leaves an evidence trail that names WHERE IT CAME FROM, WHERE IT WENT,
// WHO moved it and WHEN — and that same trail is reachable from all three operator
// surfaces that claim to show it: the ticket timeline, the logs API, and the logs
// page. A transition recorded in one surface but missing from another is the failure
// this guards, because an operator who checks the surface that lost it concludes the
// transition never happened.
//
// Repaired, not rewritten. Seeding and log/timeline observation now go through the
// store rather than a DATA_DIR the PostgreSQL server no longer reads.
//
// THIS SUITE PREVIOUSLY EXITED 0 WHILE ASSERTING NOTHING — see the A20 entry for the
// unguarded `child.once('exit')` mechanism. Cleanup is now the shared harness plus
// scripts/child-process-settlement.js, and the suite refuses to exit 0 without a
// positive assertion count.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();

async function main() {
  await withHarness('status transition evidence', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `StatusEvidence-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-status' },
      groupIds: [], changedBy: 'status-transition-evidence-test'
    })).agent;

    const now = () => new Date().toISOString();
    const objective = `status transition evidence trail regression ${STAMP}`;
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
        ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
        workflowId: null, workflowInput: null,
        capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
        executionPolicy: {
          mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
          maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null, maxWorkspaceOperations: null,
          allowWorkspaceWrites: true, allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'shared'
        },
        workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
        status: 'open', createdBy: 'seed', changedBy: 'seed',
        changedAt: now(), createdAt: now(), updatedAt: now()
      },
      eventPayload: { source: 'status-transition-evidence-test' }
    })).ticket;

    // An open ticket would be dispatched by the scheduler, which changes status
    // underneath the transitions being measured.
    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const cookie = await server.login();

    const statusLogs = async () => {
      const page = await store.listLogs({ ticketId: ticket.id, types: ['ticket:status_change'], order: 'asc', limit: 100 });
      return page.logs || page;
    };

    const before = (await statusLogs()).length;

    // ── Two transitions, so fromStatus is proved rather than assumed ─────────
    const blocked = await server.request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie, body: { status: 'blocked' }
    });
    assert(blocked.statusCode === 200, `the block transition was accepted (HTTP ${blocked.statusCode}: ${blocked.body})`);
    assert((await store.getTicket(ticket.id)).status === 'blocked', 'the ticket is actually blocked');

    const reopened = await server.request('PATCH', `/api/tickets/${ticket.id}/status`, {
      cookie, body: { status: 'open' }
    });
    assert(reopened.statusCode === 200, `the reopen transition was accepted (HTTP ${reopened.statusCode})`);
    // Reopening synchronously dispatches a run, so the ticket may already have moved
    // on to in_progress by the time this reads it. What must be true is that it is no
    // longer blocked — the transition being audited actually took effect.
    const afterReopen = (await store.getTicket(ticket.id)).status;
    assert(afterReopen !== 'blocked', `the ticket is no longer blocked (got ${afterReopen})`);

    // ── Surface 1: the durable log ──────────────────────────────────────────
    const logs = await statusLogs();
    assert(logs.length === before + 2, `both transitions were logged (got ${logs.length - before})`);

    const openLog = logs[logs.length - 1];
    assert(openLog.fromStatus === 'blocked', `the reopen log records where it came from (got ${openLog.fromStatus})`);
    assert(openLog.toStatus === 'open', `the reopen log records where it went (got ${openLog.toStatus})`);
    assert(openLog.changedBy === 'admin', 'the reopen log names who moved it');
    assert(typeof openLog.changedAt === 'string' && openLog.changedAt.length > 0,
      'the reopen log records when it moved');

    const blockLog = logs[logs.length - 2];
    assert(blockLog.fromStatus === 'open' && blockLog.toStatus === 'blocked',
      'the earlier log records the earlier transition, not a duplicate of the later one');

    // ── Surface 2: the ticket timeline ──────────────────────────────────────
    const timelineResponse = await server.request('GET', `/api/tickets/${ticket.id}/timeline`, { cookie });
    assert(timelineResponse.statusCode === 200, `the timeline endpoint answered (HTTP ${timelineResponse.statusCode})`);
    const timeline = JSON.parse(timelineResponse.body);
    assert(Array.isArray(timeline.entries), 'the timeline returns entries');

    const statusEntry = timeline.entries.find(entry =>
      entry.details && entry.details.fromStatus === 'blocked' && entry.details.toStatus === 'open');
    assert(Boolean(statusEntry), 'the timeline includes the reopen transition');
    assert(statusEntry.summary && statusEntry.summary.includes('blocked') && statusEntry.summary.includes('open'),
      `the timeline summary names both ends of the transition (got ${statusEntry.summary})`);
    assert(statusEntry.details.changedBy === 'admin', 'the timeline entry names who moved it');

    // ── Surface 3: the logs API and page ────────────────────────────────────
    const logsApiResponse = await server.request('GET', `/api/logs?ticketId=${ticket.id}`, { cookie });
    assert(logsApiResponse.statusCode === 200, `the logs API answered (HTTP ${logsApiResponse.statusCode})`);
    const logsApi = JSON.parse(logsApiResponse.body);
    assert(Array.isArray(logsApi.logs), 'the logs API returns a logs array');
    const apiStatusLog = logsApi.logs.find(log =>
      log.type === 'ticket:status_change' && log.fromStatus === 'blocked' && log.toStatus === 'open');
    assert(Boolean(apiStatusLog), 'the logs API includes the reopen transition');
    assert(apiStatusLog.changedBy === 'admin', 'the logs API preserves who moved it');

    const logsPage = await server.request('GET', '/logs', { cookie });
    assert(logsPage.statusCode === 200, `the logs page renders (HTTP ${logsPage.statusCode})`);

    // The point of checking three surfaces is that they AGREE. Asserting each in
    // isolation would pass even if they disagreed about the same transition.
    assert(apiStatusLog.changedAt === openLog.changedAt,
      'the logs API and the durable log describe the same transition instant');
    assert(statusEntry.details.fromStatus === openLog.fromStatus
      && statusEntry.details.toStatus === openLog.toStatus,
      'the timeline and the durable log agree on the transition');

    assertScenariosExecuted({ label: 'status transition evidence', assertions: assert.count(), minAssertions: 20 });
    console.log(`\nPASS: ticket status transition evidence — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'status_transition_evidence' });
}

main().catch(error => {
  console.error(`\nFAIL: ticket status transition evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
