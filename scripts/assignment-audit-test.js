#!/usr/bin/env node
'use strict';
// Ticket assignment audit trail — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Contract under test, unchanged from the JSON-era original: reassigning a ticket
// records WHO changed it, WHEN, and FROM WHAT TO WHAT — and a no-op reassignment
// records nothing at all. The negative half is the one that matters: an audit trail
// that logs a change every time the endpoint is called, whether or not anything
// changed, cannot be used to answer "when did this actually move?".
//
// Repaired, not rewritten. What changed is seeding and observation: the agent and
// ticket come from the store, and the audit log and events are read through it
// instead of from a DATA_DIR the PostgreSQL server no longer reads.
//
// THIS SUITE PREVIOUSLY EXITED 0 WHILE ASSERTING NOTHING. Its cleanup awaited
// `child.once('exit')` on a server that had already died at startup, so the promise
// never settled, the `.catch()` never ran, and node exited 0 with no output at all —
// 15 seconds of silence reported as success. Cleanup now goes through
// scripts/child-process-settlement.js, and the suite refuses to exit 0 without a
// positive assertion count.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');

const STAMP = Date.now();
const assert = createAsserter();

async function main() {
  await withHarness('assignment audit', async ({ store, startServer }) => {
    const fromAgent = (await store.createConfiguredAgent({
      value: { name: `AssignFrom-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-assign-from' },
      groupIds: [], changedBy: 'assignment-audit-test'
    })).agent;
    const toAgent = (await store.createConfiguredAgent({
      value: { name: `AssignTo-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'test-key-assign-to' },
      groupIds: [], changedBy: 'assignment-audit-test'
    })).agent;

    const now = () => new Date().toISOString();
    const objective = `assignment audit trail regression ${STAMP}`;
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        objective, acceptanceCriteria: null,
        assignmentTargetType: 'agent', assignmentTargetId: fromAgent.id, assignmentMode: 'individual',
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
      eventPayload: { source: 'assignment-audit-test' }
    })).ticket;

    // The scheduler would dispatch a run for an open ticket and mutate the very
    // fields under test, so it is parked for the duration.
    const server = await startServer({ env: { RUNTIME_SCHEDULER_INTERVAL_MS: '3600000' } });
    const cookie = await server.login();

    const assignmentLogs = async () => {
      const page = await store.listLogs({ ticketId: ticket.id, types: ['ticket:assignment_change'], limit: 100 });
      return page.logs || page;
    };
    const ticketEvents = async () => (await store.listTicketEvents(ticket.id, { afterPosition: 0, limit: 200 })).events;

    const logsBefore = (await assignmentLogs()).length;
    const updatedEventsBefore = (await ticketEvents()).filter(e => e.type === 'ticket.updated').length;

    // ── A real reassignment is recorded ──────────────────────────────────────
    const response = await server.request('PATCH', `/api/tickets/${ticket.id}/assignment`, {
      cookie, body: { agentId: toAgent.id }
    });
    assert(response.statusCode === 200, `reassignment returned HTTP ${response.statusCode}: ${response.body}`);

    const reassigned = await store.getTicket(ticket.id);
    // The assertion that exposed A21. The endpoint used to answer 200 and write an
    // audit record claiming the assignment moved while the ticket still targeted the
    // old agent, because the target lives in COLUMNS that the shared ticket transition
    // never wrote. An audit trail that contradicts the state it describes is worse
    // than no audit trail.
    assert(reassigned.assignmentTargetId === toAgent.id,
      `the ticket actually targets the new agent (got ${reassigned.assignmentTargetId}, expected ${toAgent.id})`);
    assert(reassigned.assignmentTargetType === 'agent' && reassigned.assignmentMode === 'individual',
      'the authoritative assignment fields stay internally consistent');
    // The HTTP body is what an operator and every API client sees. It must describe
    // the row that was written, not the request that was made.
    assert(JSON.parse(response.body).ticket.assignmentTargetId === reassigned.assignmentTargetId,
      'the returned ticket reflects the persisted assignment');
    assert(reassigned.changedBy === 'admin', 'the reassignment records who changed it');
    assert(typeof reassigned.changedAt === 'string' && reassigned.changedAt.length > 0,
      'the reassignment records when it changed');

    const logs = await assignmentLogs();
    assert(logs.length === logsBefore + 1, `exactly one assignment change log was appended (got ${logs.length - logsBefore})`);
    const auditLog = logs[logs.length - 1];
    assert(auditLog.changedBy === 'admin', 'the audit log names the operator who reassigned');
    assert(auditLog.changedAt === reassigned.changedAt,
      'the audit log timestamp matches the ticket it describes');
    assert(auditLog.previousAssignment && auditLog.previousAssignment.assignmentTargetId === fromAgent.id,
      'the audit log records what the assignment was');
    assert(auditLog.nextAssignment && auditLog.nextAssignment.assignmentTargetId === toAgent.id,
      'the audit log records what the assignment became');
    assert(auditLog.nextAssignment.assignmentTargetId === reassigned.assignmentTargetId,
      'the audit log agrees with the ticket it describes');

    // ── The event must agree with the row too ───────────────────────────────
    // Selected by its previousAssignment marker, not by being last: dispatching a run
    // emits its own ticket.updated immediately afterwards, so "the latest one" is the
    // dispatch event rather than the reassignment.
    const assignmentEvent = (await ticketEvents())
      .filter(e => e.type === 'ticket.updated' && (e.payload || {}).previousAssignment)
      .pop();
    assert(Boolean(assignmentEvent), 'the reassignment emitted its own ticket.updated event');
    const eventPayload = assignmentEvent.payload || assignmentEvent;
    assert(eventPayload.assignmentTargetId === reassigned.assignmentTargetId,
      'the ticket.updated event agrees with the persisted assignment');
    assert(eventPayload.previousAssignment
      && eventPayload.previousAssignment.assignmentTargetId === fromAgent.id,
      'the event records the assignment it moved away from');
    // The revision the REASSIGNMENT produced, not the ticket's current one: dispatching
    // a run advances it again immediately afterwards.
    assert(eventPayload.revision === ticket.revision + 1,
      `the event is stamped with the revision the reassignment produced (got ${eventPayload.revision}, expected ${ticket.revision + 1})`);

    // ── The dispatched run follows the NEW assignment ───────────────────────
    // Reassigning an open ticket dispatches a run. Before A21 the ticket never moved,
    // so the run went to the original agent while the audit trail credited the new
    // one — the most consequential form of the defect.
    const dispatched = (await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs;
    assert(dispatched.length >= 1, `the reassignment dispatched a run (got ${dispatched.length})`);
    assert(dispatched.every(run => run.agentId === toAgent.id),
      `every dispatched run targets the newly assigned agent (got ${dispatched.map(r => r.agentId).join(',')})`);
    assert(!dispatched.some(run => run.agentId === fromAgent.id),
      'no run was dispatched to the agent the ticket was moved away from');

    // ── A stale writer cannot overwrite a newer assignment ──────────────────
    // Asserted at the store boundary because the optimistic guard lives there; the
    // endpoint reads the current revision on every call and so cannot express it.
    let staleRejected = false;
    try {
      await store.reassignTicket({
        ticketId: ticket.id,
        expectedRevision: reassigned.revision - 1,
        fromStatuses: [reassigned.status],
        assignmentTargetType: 'agent', assignmentTargetId: fromAgent.id,
        assignmentMode: 'individual', changedBy: 'stale-writer'
      });
    } catch (_) {
      staleRejected = true;
    }
    assert(staleRejected, 'a reassignment against a stale revision is rejected');
    assert((await store.getTicket(ticket.id)).assignmentTargetId === toAgent.id,
      'the rejected stale write did not move the ticket back');
    assert((await assignmentLogs()).length === logs.length,
      'the rejected stale write left no audit evidence behind');

    // ── A no-op reassignment records nothing ────────────────────────────────
    // Without this, an implementation that logged every request would pass every
    // assertion above while making the trail useless.
    const beforeNoop = await store.getTicket(ticket.id);
    const logsBeforeNoop = (await assignmentLogs()).length;
    const eventsBeforeNoop = (await ticketEvents()).filter(e => e.type === 'ticket.updated').length;

    const noop = await server.request('PATCH', `/api/tickets/${ticket.id}/assignment`, {
      cookie, body: { agentId: toAgent.id }
    });
    assert(noop.statusCode === 200, `the no-op reassignment was accepted (HTTP ${noop.statusCode})`);

    const afterNoop = await store.getTicket(ticket.id);
    assert(afterNoop.changedBy === beforeNoop.changedBy, 'a no-op does not rewrite changedBy');
    assert(afterNoop.changedAt === beforeNoop.changedAt, 'a no-op does not rewrite changedAt');
    assert(afterNoop.updatedAt === beforeNoop.updatedAt, 'a no-op does not rewrite updatedAt');
    assert((await assignmentLogs()).length === logsBeforeNoop,
      'a no-op appends no assignment change log');
    assert((await ticketEvents()).filter(e => e.type === 'ticket.updated').length === eventsBeforeNoop,
      'a no-op appends no ticket.updated event');
    assert((await ticketEvents()).filter(e => e.type === 'ticket.updated').length > updatedEventsBefore,
      'the real reassignment did emit a ticket.updated event, so the no-op check is meaningful');
    assert(afterNoop.revision === beforeNoop.revision, 'a no-op does not advance the revision');
    assert((await store.listRunsForTicket({ ticketId: ticket.id, limit: 20 })).runs.length === dispatched.length,
      'a no-op dispatches no additional run');

    assertScenariosExecuted({ label: 'assignment audit', assertions: assert.count(), minAssertions: 28 });
    console.log(`\nPASS: ticket assignment audit trail — ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'assignment_audit' });
}

main().catch(error => {
  console.error(`\nFAIL: ticket assignment audit trail — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
