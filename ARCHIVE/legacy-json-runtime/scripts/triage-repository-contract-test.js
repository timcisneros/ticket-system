#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonTriageRepository,
  REQUIRED_TRIAGE_REPOSITORY_METHODS,
  TriageConflictError,
  assertTriageRepository
} = require('../persistence/json/triage-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let tickets = [
  {
    id: 1,
    status: 'blocked',
    objective: 'Resolve ticket blocker',
    updatedAt: '2026-07-16T10:00:00.000Z',
    triage: {
      required: true,
      reasonCode: 'authority_blocked',
      summary: 'Scope is insufficient',
      requiredDecision: 'change_scope',
      evidenceRefs: ['event:authority.denied'],
      allowedActions: ['review'],
      prohibitedActions: ['bypass_authority'],
      createdAt: '2026-07-16T10:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      resolution: null
    }
  },
  { id: 2, status: 'open', objective: 'No blocker', updatedAt: '2026-07-16T10:00:00.000Z', triage: null }
];
let runs = [
  {
    id: 10,
    ticketId: 1,
    agentId: 2,
    status: 'failed',
    updatedAt: '2026-07-16T10:01:00.000Z',
    triage: null
  }
];
const events = [];
const clock = [
  '2026-07-16T11:00:00.000Z',
  '2026-07-16T11:01:00.000Z',
  '2026-07-16T11:02:00.000Z'
];

const clone = value => structuredClone(value);
const repository = new JsonTriageRepository({
  readTickets: () => clone(tickets),
  writeTickets: value => { tickets = clone(value); },
  readRuns: () => clone(runs),
  writeRuns: value => { runs = clone(value); },
  appendEvent: async event => {
    const stored = { id: `event-${events.length + 1}`, ...clone(event) };
    events.push(stored);
    return stored;
  },
  sanitizePayload: clone,
  now: () => new Date(clock.shift()),
  maxQueryRows: 2
});

const runTriage = {
  required: true,
  reasonCode: 'runtime_failed',
  summary: 'Provider failed after terminalization',
  requiredDecision: 'review_failure',
  evidenceRefs: ['event:run.terminalized'],
  allowedActions: ['review'],
  prohibitedActions: ['automatic_retry'],
  createdAt: '2000-01-01T00:00:00.000Z'
};

async function main() {
  assert.deepEqual(REQUIRED_TRIAGE_REPOSITORY_METHODS, [
    'createRunTriage',
    'resolveTicketTriage',
    'resolveRunTriage',
    'getUnresolvedTriageSummary'
  ]);
  assert.equal(assertTriageRepository(repository), repository);
  assert.equal(
    assertTriageRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the triage contract'
  );
  assert.throws(() => assertTriageRepository({}), /must implement createRunTriage/);
  assert.equal(new TriageConflictError('run', 10).code, 'TRIAGE_NOT_REQUIRED');

  assert.equal(await repository.createRunTriage({ runId: 999, triage: runTriage }), null);
  const created = await repository.createRunTriage({ runId: 10, triage: runTriage });
  assert.equal(created.created, true);
  assert.equal(created.triage.createdAt, '2026-07-16T11:00:00.000Z');
  assert.equal(created.triage.required, true);
  assert.equal(created.triage.resolvedAt, null);
  assert.equal(created.event.type, 'run.triage_created');
  assert.equal(runs[0].updatedAt, created.triage.createdAt);
  const duplicate = await repository.createRunTriage({ runId: 10, triage: { ...runTriage, summary: 'different' } });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.triage.summary, runTriage.summary);
  assert.equal(events.filter(event => event.type === 'run.triage_created').length, 1);

  assert.deepEqual(await repository.getUnresolvedTriageSummary({ limit: 2 }), {
    unresolvedTicketCount: 1,
    unresolvedRunCount: 1,
    recentTickets: [{ ticketId: 1, reasonCode: 'authority_blocked' }]
  });
  await assert.rejects(repository.getUnresolvedTriageSummary({ limit: 3 }), /configured maximum/);
  await assert.rejects(
    repository.resolveTicketTriage({ ticketId: 2, resolvedBy: 'admin', resolution: 'nothing to resolve' }),
    error => error && error.code === 'TRIAGE_NOT_REQUIRED'
  );

  const ticketResolution = await repository.resolveTicketTriage({
    ticketId: 1,
    resolvedBy: 'admin',
    resolution: 'Scope was corrected.'
  });
  assert.equal(ticketResolution.triage.required, false);
  assert.equal(ticketResolution.triage.reasonCode, 'authority_blocked');
  assert.deepEqual(ticketResolution.triage.evidenceRefs, ['event:authority.denied']);
  assert.equal(ticketResolution.triage.resolvedAt, '2026-07-16T11:01:00.000Z');
  assert.equal(ticketResolution.event.type, 'ticket.triage_resolved');
  await assert.rejects(
    repository.resolveTicketTriage({ ticketId: 1, resolvedBy: 'admin', resolution: 'again' }),
    error => error && error.code === 'TRIAGE_NOT_REQUIRED'
  );

  const runResolution = await repository.resolveRunTriage({
    runId: 10,
    resolvedBy: 'admin',
    resolution: 'Failure reviewed.'
  });
  assert.equal(runResolution.triage.required, false);
  assert.equal(runResolution.triage.resolvedAt, '2026-07-16T11:02:00.000Z');
  assert.equal(runResolution.event.type, 'run.triage_resolved');
  assert.deepEqual(await repository.getUnresolvedTriageSummary({ limit: 2 }), {
    unresolvedTicketCount: 0,
    unresolvedRunCount: 0,
    recentTickets: []
  });

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getTriageRepository()'));
  assert.ok(serverSource.includes('await getTriageRepository().resolveTicketTriage'));
  assert.ok(serverSource.includes('await getTriageRepository().resolveRunTriage'));
  const summaryStart = serverSource.indexOf('async function buildOperationalSummary(options = {})');
  const summaryEnd = serverSource.indexOf('\nasync function prepareAgentRunDraft(', summaryStart);
  const summarySource = serverSource.slice(summaryStart, summaryEnd);
  assert.ok(summarySource.includes('await Promise.all(['));
  assert.ok(summarySource.includes('getTriageRepository().getUnresolvedTriageSummary({ limit })'));
  assert.ok(serverSource.includes('await applyTicketTriageResolution'));
  assert.ok(serverSource.includes('await applyRunTriageResolution'));
  assert.ok(!serverSource.includes('function resolveTriageRecord('));

  console.log('PASS: triage creation, resolution, event evidence, conflict handling, and operational summary use one backend-neutral authority');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
