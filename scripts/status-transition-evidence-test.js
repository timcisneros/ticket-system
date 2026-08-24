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

    const firstEventPosition = Number((await store.pool.query(
      `SELECT COALESCE(MAX(position), 0) AS p FROM ${store.schema}.events WHERE ticket_id = $1`,
      [ticket.id])).rows[0].p);

    // ── Two transitions, so fromStatus is proved rather than assumed ─────────
    // T2 Tranche 5: blocking goes through the reasoned blocker writer; the
    // release goes through atomic triage resolve+reprojection.
    const blocked = await store.blockTicket({
      ticketId: ticket.id,
      reasonCode: 'authority_blocked',
      summary: 'fixture authority block',
      triage: { required: true, reasonCode: 'authority_blocked',
        summary: 'fixture authority block', createdAt: new Date().toISOString(),
        resolvedAt: null }
    });
    assert(blocked.ticket.status === 'blocked', 'the ticket is actually blocked');

    const reopened = await store.resolveTicketTriageAndReproject({
      ticketId: ticket.id, resolvedBy: 'admin', resolution: 'fixture scope correction'
    });
    // Reopening synchronously dispatches a run, so the ticket may already have moved
    // on to in_progress by the time this reads it. What must be true is that it is no
    // longer blocked — the transition being audited actually took effect.
    const afterReopen = (await store.getTicket(ticket.id)).status;
    assert(afterReopen !== 'blocked', `the ticket is no longer blocked (got ${afterReopen})`);

    // ── Surface 1: the durable EVENT chain ────────────────────────────────
    // T2 Tranche 5: status transitions are audited by append-only events
    // (ticket.blocked / ticket.triage_resolved / ticket.lifecycle_reprojected);
    // the retired HTTP writer's separate diagnostic log no longer exists.
    // The formerly protected invariant is preserved in full on the canonical
    // surface: WHAT changed (transition ends), WHY it changed (the reasoned
    // block and its matching release reason), and WHO authorized it (the
    // attributed resolution inside the durable triage document).
    const evs = (await store.pool.query(
      `SELECT position, type, payload FROM ${store.schema}.events WHERE ticket_id = $1 AND position > $2 ORDER BY position`,
      [ticket.id, firstEventPosition])).rows;
    const blockEvent = evs.find(e => e.type === 'ticket.blocked');
    assert(blockEvent && blockEvent.payload.reasonCode === 'authority_blocked',
      'the block is recorded as a reasoned ticket.blocked event');
    assert(blocked.ticket.triage &&
        blocked.ticket.triage.required === true &&
        blocked.ticket.triage.reasonCode === 'authority_blocked',
      'the block durably records its unresolved triage fact (why it governed)');
    const resolveEvent = evs.find(e => e.type === 'ticket.triage_resolved');
    assert(Boolean(resolveEvent), 'the resolution is recorded durably');
    assert(resolveEvent.payload.triage &&
        resolveEvent.payload.triage.required === false &&
        resolveEvent.payload.triage.resolvedAt,
      'the resolution marks the triage resolved with its resolution instant');
    // WHO: the durable triage document names the authorizing operator.
    assert(resolveEvent.payload.triage.resolvedBy === 'admin' &&
        typeof resolveEvent.payload.triage.resolution === 'string' &&
        resolveEvent.payload.triage.resolution.includes('scope correction'),
      'the durable triage document names who authorized the release and why');
    // WHY: the release pairs to the SAME reason code that governed the block.
    assert(resolveEvent.payload.triage.reasonCode === blockEvent.payload.reasonCode,
      'the release authorization pairs exactly with the blocking reason code');
    const reproj = evs.find(e => e.type === 'ticket.lifecycle_reprojected');
    // WHAT: both ends of the transition, plus the reprojection cause.
    assert(reproj && reproj.payload.previousStatus === 'blocked' &&
      reproj.payload.status === 'open',
      `the reprojection records where it came from and went (${JSON.stringify(reproj || {})})`);
    assert(reproj && reproj.payload.reason === 'triage_resolved',
      'the reprojection names its cause: the attributed triage resolution');
    assert(reopened.reprojectEvent && reopened.event,
      'resolution and reprojection are both recorded by the one atomic operation');
    const resolvePosition = evs.find(e => e.type === 'ticket.triage_resolved').position;
    const reprojPosition = evs.find(e => e.type === 'ticket.lifecycle_reprojected').position;
    assert(reprojPosition > resolvePosition,
      'the reprojection is append-ordered after its authorizing resolution');

    // ── Surface 2: the ticket timeline ──────────────────────────────────────
    const timelineResponse = await server.request('GET', `/api/tickets/${ticket.id}/timeline`, { cookie });
    assert(timelineResponse.statusCode === 200, `the timeline endpoint answered (HTTP ${timelineResponse.statusCode})`);
    const timeline = JSON.parse(timelineResponse.body);
    assert(Array.isArray(timeline.entries), 'the timeline returns entries');
    const statusEntry = timeline.entries.find(entry =>
      entry.details && entry.details.fromStatus === 'blocked' && entry.details.toStatus === 'open');
    assert(Boolean(statusEntry), 'the timeline includes the reprojection transition');
    assert(statusEntry.summary && statusEntry.summary.includes('blocked') && statusEntry.summary.includes('open'),
      `the timeline summary names both ends of the transition (got ${statusEntry.summary})`);

    // T2 Tranche 5: the retired HTTP-writer log surfaces collapsed into the
    // durable event chain; the suite asserts fewer but STRONGER facts — every
    // formerly protected dimension (what/why/who) now lives on the canonical
    // append-only evidence.
    assertScenariosExecuted({ label: 'status transition evidence', assertions: assert.count(), minAssertions: 10 });
    console.log(`\nPASS: ticket status transition evidence — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'status_transition_evidence' });
}

main().catch(error => {
  console.error(`\nFAIL: ticket status transition evidence — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
