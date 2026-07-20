#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonTicketRunLifecycleRepository,
  REQUIRED_TICKET_RUN_LIFECYCLE_REPOSITORY_METHODS,
  assertTicketRunLifecycleRepository
} = require('../persistence/json/ticket-run-lifecycle-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let tickets = [];
let runs = [];
const events = [];
let clockTick = 0;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const repository = new JsonTicketRunLifecycleRepository({
  readTickets: () => clone(tickets),
  writeTickets: records => { tickets = clone(records); },
  readGroups: () => [{ id: 9, canReceiveTickets: true }, { id: 10, canReceiveTickets: false }],
  readRuns: () => clone(runs),
  writeRuns: records => { runs = clone(records); },
  appendEvent: async event => {
    const stored = { ...clone(event), id: `event-${events.length + 1}` };
    events.push(stored);
    return stored;
  },
  sanitizePayload: clone,
  now: () => new Date(Date.parse('2026-07-16T12:00:00.000Z') + (clockTick++ * 1000))
});

function runDraft(ticketId, agentId, extra = {}) {
  return {
    ticketId,
    agentId,
    agentName: `Agent ${agentId}`,
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    status: 'pending',
    ...extra
  };
}

function runEventPayload(run) {
  return { agentId: run.agentId, agentName: run.agentName, executionMode: run.executionMode };
}

async function main() {
  assert.deepEqual(REQUIRED_TICKET_RUN_LIFECYCLE_REPOSITORY_METHODS, [
    'createTicketWithEvent',
    'transitionTicketState',
    'createRunsAndStartTicket',
    'transitionTicketAfterRun',
    'reopenTicket',
    'createRetryRun'
  ]);
  assert.equal(assertTicketRunLifecycleRepository(repository), repository);
  assert.equal(
    assertTicketRunLifecycleRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the ticket/run lifecycle repository contract'
  );
  assert.throws(() => assertTicketRunLifecycleRepository({}), /must implement createTicketWithEvent/);

  const created = await repository.createTicketWithEvent({
    ticket: {
      status: 'open',
      assignmentTargetType: 'group',
      assignmentTargetId: 9,
      assignmentMode: 'allocated',
      changedAt: 'application-time-must-not-win'
    },
    eventPayload: { assignmentMode: 'allocated' }
  });
  assert.equal(created.ticket.id, 1);
  assert.equal(created.ticket.createdAt, '2026-07-16T12:00:00.000Z');
  assert.equal(created.ticket.changedAt, created.ticket.createdAt);
  assert.equal(events[0].type, 'ticket.created');
  await assert.rejects(
    repository.createTicketWithEvent({
      ticket: { status: 'open', assignmentTargetType: 'group', assignmentTargetId: 999 }
    }),
    error => error && error.code === 'GROUP_NOT_FOUND'
  );
  await assert.rejects(
    repository.createTicketWithEvent({
      ticket: { status: 'open', assignmentTargetType: 'group', assignmentTargetId: 10 }
    }),
    error => error && error.code === 'GROUP_NOT_TICKET_CAPABLE'
  );

  const stateTicket = await repository.createTicketWithEvent({
    ticket: { status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 8, changedAt: 'old' }
  });
  const blockedState = await repository.transitionTicketState({
    ticketId: stateTicket.ticket.id,
    fromStatuses: ['open'],
    toStatus: 'blocked',
    patch: { blockedReason: 'deterministic gate', changedAt: 'application-time-must-not-win' },
    eventType: 'ticket.blocked',
    eventPayload: { reasonCode: 'test_gate', changedAt: 'application-time-must-not-win' }
  });
  assert.equal(blockedState.ticket.status, 'blocked');
  assert.equal(blockedState.ticket.blockedReason, 'deterministic gate');
  assert.equal(blockedState.event.payload.changedAt, blockedState.ticket.changedAt);

  const eventsBeforeBatch = events.length;
  const batch = await repository.createRunsAndStartTicket({
    ticketId: created.ticket.id,
    runDrafts: [runDraft(1, 11), runDraft(1, 12)],
    runEventPayload
  });
  assert.equal(batch.ticket.status, 'in_progress');
  assert.deepEqual(batch.runs.map(run => run.id), [1, 2]);
  assert.ok(batch.runs.every(run => run.ticketOpenedAt === created.ticket.updatedAt));
  assert.deepEqual(events.slice(eventsBeforeBatch).map(event => event.type), [
    'run.created',
    'run.created',
    'ticket.updated'
  ]);

  runs.find(run => run.id === 1).status = 'completed';
  let settlement = await repository.transitionTicketAfterRun({ runId: 1 });
  assert.equal(settlement.changed, false, 'one completed allocation member must not finalize its ticket');
  assert.equal(settlement.ticket.status, 'in_progress');

  runs.find(run => run.id === 2).status = 'completed';
  settlement = await repository.transitionTicketAfterRun({ runId: 2 });
  assert.equal(settlement.changed, true);
  assert.equal(settlement.ticket.status, 'completed');

  const retryTicket = await repository.createTicketWithEvent({
    ticket: {
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: 21,
      assignmentMode: 'individual'
    }
  });
  const initial = await repository.createRunsAndStartTicket({
    ticketId: retryTicket.ticket.id,
    runDrafts: [runDraft(retryTicket.ticket.id, 21)],
    runEventPayload
  });
  const failed = runs.find(run => run.id === initial.runs[0].id);
  failed.status = 'failed';
  failed.completedAt = '2026-07-16T12:10:00.000Z';
  const retried = await repository.createRetryRun({
    ticketId: retryTicket.ticket.id,
    predecessorRunId: failed.id,
    runDraft: runDraft(retryTicket.ticket.id, 21),
    runEventPayload
  });
  assert.equal(retried.ticket.status, 'in_progress');
  assert.equal(retried.runs.length, 1);
  assert.notEqual(retried.runs[0].id, failed.id);
  assert.equal(retried.runs[0].rerunMode, 'auto_retry');
  assert.equal(runs.find(run => run.id === failed.id).status, 'failed');

  await assert.rejects(
    repository.createRunsAndStartTicket({
      ticketId: retryTicket.ticket.id,
      runDrafts: [runDraft(retryTicket.ticket.id, 21)],
      runEventPayload
    }),
    error => error && error.code === 'LIFECYCLE_CONFLICT'
  );

  const interrupted = runs.find(run => run.id === retried.runs[0].id);
  interrupted.status = 'interrupted';
  interrupted.completedAt = '2026-07-16T12:11:00.000Z';
  settlement = await repository.transitionTicketAfterRun({ runId: interrupted.id });
  assert.equal(settlement.ticket.status, 'open');

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getTicketRunLifecycleRepository().createTicketWithEvent({'));
  assert.ok(serverSource.includes('getTicketRunLifecycleRepository().createRunsAndStartTicket({'));
  assert.ok(serverSource.includes('getTicketRunLifecycleRepository().createRetryRun({'));
  assert.ok(serverSource.includes('getTicketRunLifecycleRepository().transitionTicketAfterRun({'));

  console.log('PASS: ticket/run lifecycle repository owns identity, batch creation, ticket settlement, and ordered retry creation');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
