#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  WatcherConflictError,
  WatcherIdConflictError,
  WatcherReferenceError,
  WatcherStateConflictError,
  assertWatcherAuthorityRepository
} = require('../persistence/watcher-authority');
const { JsonWatcherAuthorityRepository } = require('../persistence/json/watcher-authority-repository');

const ROOT = path.resolve(__dirname, '..');
const ISO = '2026-07-19T12:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function watcherValue(name, overrides = {}) {
  return {
    name,
    status: 'active',
    workContextId: 10,
    sourceKind: 'workspace_file',
    sourceRefs: [{ path: 'inbox/item.txt' }],
    cadence: { mode: 'manual' },
    triggerPolicy: { mode: 'manual' },
    deltaPolicy: { mode: 'hash' },
    actionPolicy: { allowedActions: ['summarize', 'propose_ticket'] },
    triagePolicy: { mode: 'manual' },
    ticketProposalPolicy: { enabled: true },
    notificationPolicy: { mode: 'none' },
    ...overrides
  };
}

function watcherRecord(id, overrides = {}) {
  return {
    id,
    ...watcherValue(`Watcher ${id}`, overrides),
    lastObservedAt: null,
    lastObservationHash: null,
    revision: 1,
    createdBy: 'seed',
    createdAt: ISO,
    updatedBy: 'seed',
    updatedAt: ISO
  };
}

function observationValue(watcherId, overrides = {}) {
  return {
    watcherId,
    workContextId: 10,
    status: 'changed',
    sourceKind: 'workspace_file',
    sourceRefs: [{ path: 'inbox/item.txt' }],
    previousHash: null,
    currentHash: HASH_A,
    summary: { bytes: 4, lineCount: 1 },
    actionTaken: 'summarized',
    ticketProposalId: null,
    error: null,
    ...overrides
  };
}

function observationRecord(id, watcherId, overrides = {}) {
  return { id, ...observationValue(watcherId, overrides), observedAt: ISO };
}

function proposalValue(watcherId, overrides = {}) {
  return {
    watcherId,
    workContextId: 10,
    observationId: null,
    objective: 'Triage bounded intake',
    sourceRefs: [{ path: 'inbox/item.txt' }],
    evidenceRefs: [],
    constraints: null,
    authorityLimits: null,
    stopCondition: null,
    receiptExpectation: 'work_receipt',
    ...overrides
  };
}

function proposalRecord(id, watcherId, overrides = {}) {
  return {
    id,
    ...proposalValue(watcherId, overrides),
    status: 'proposed',
    createdTicketId: null,
    approvedAt: null,
    rejectedAt: null,
    revision: 1,
    createdBy: 'seed',
    createdAt: ISO,
    updatedBy: 'seed',
    updatedAt: ISO,
    ...overrides
  };
}

function queue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function harness({
  watchers: initialWatchers = [],
  observations: initialObservations = [],
  proposals: initialProposals = [],
  tickets: initialTickets = [],
  contexts = [{ id: 10, status: 'active' }, { id: 20, status: 'active' }, { id: 30, status: 'archived' }],
  appendSystemLog = async value => value,
  appendEvent = async value => value
} = {}) {
  let watchers = structuredClone(initialWatchers);
  let observations = structuredClone(initialObservations);
  let proposals = structuredClone(initialProposals);
  let tickets = structuredClone(initialTickets);
  const repository = assertWatcherAuthorityRepository(new JsonWatcherAuthorityRepository({
    readWatchers: () => structuredClone(watchers),
    writeWatchers: value => { watchers = structuredClone(value); },
    readObservations: () => structuredClone(observations),
    writeObservations: value => { observations = structuredClone(value); },
    readProposals: () => structuredClone(proposals),
    writeProposals: value => { proposals = structuredClone(value); },
    readWorkContexts: () => structuredClone(contexts),
    readTickets: () => structuredClone(tickets),
    appendEvent,
    appendSystemLog,
    queueMutation: queue(),
    now: () => new Date(ISO),
    maxQueryRows: 3
  }));
  return {
    repository,
    watchers: () => structuredClone(watchers),
    observations: () => structuredClone(observations),
    proposals: () => structuredClone(proposals),
    tickets: () => structuredClone(tickets),
    addTicket: ticket => { tickets.push(structuredClone(ticket)); }
  };
}

async function main() {
  const catalog = harness({
    watchers: [
      watcherRecord(4, { status: 'paused', workContextId: 20 }),
      watcherRecord(1),
      watcherRecord(3, { status: 'archived' }),
      watcherRecord(2)
    ],
    observations: [
      observationRecord(1, 1),
      observationRecord(2, 1, { status: 'refused', currentHash: null, summary: null, actionTaken: null, error: 'paused' }),
      observationRecord(3, 2, { status: 'failed', currentHash: null, summary: null, actionTaken: null, error: 'missing' })
    ]
  });
  const first = await catalog.repository.listWatchers({ limit: 2 });
  assert.deepEqual(first.watchers.map(item => item.id), [1, 2]);
  assert.equal(first.nextAfterId, 2);
  const second = await catalog.repository.listWatchers({ afterId: 2, statuses: ['active', 'archived'], workContextId: 10, limit: 2 });
  assert.deepEqual(second.watchers.map(item => item.id), [3]);
  const observationPage = await catalog.repository.listWatcherObservations({ watcherId: 1, limit: 1 });
  assert.deepEqual(observationPage.observations.map(item => item.id), [2]);
  assert.equal(observationPage.nextBeforeId, 2);
  const summary = await catalog.repository.getWatcherOperationalSummary({ limit: 2 });
  assert.deepEqual(
    { active: summary.active, paused: summary.paused, archived: summary.archived, total: summary.total },
    { active: 2, paused: 1, archived: 1, total: 4 }
  );
  assert.deepEqual(summary.recentFailures.map(item => item.id), [3, 2]);
  assert.equal(summary.hasFailures, true);

  const mutations = harness({ watchers: [watcherRecord(1)] });
  const created = await mutations.repository.createWatcher({
    value: watcherValue('Created'),
    changedBy: 'operator',
    audit: { type: 'watcher:created', message: 'created', metadata: {} }
  });
  assert.equal(created.watcher.id, 2);
  assert.equal(created.watcher.revision, 1);
  const updated = await mutations.repository.updateWatcher({
    watcherId: 2,
    expectedRevision: 1,
    value: watcherValue('Paused', { status: 'paused' }),
    changedBy: 'reviewer'
  });
  assert.equal(updated.watcher.revision, 2);
  await assert.rejects(
    mutations.repository.updateWatcher({ watcherId: 2, expectedRevision: 1, value: watcherValue('Stale'), changedBy: 'stale' }),
    error => error instanceof WatcherConflictError && error.current.revision === 2
  );
  await assert.rejects(
    mutations.repository.createWatcher({ value: watcherValue('Archived context', { workContextId: 30 }), changedBy: 'operator' }),
    error => error instanceof WatcherReferenceError && error.code === 'WORK_CONTEXT_NOT_ACTIVE'
  );

  const observed = await mutations.repository.recordWatcherObservation({
    watcherId: 1,
    expectedRevision: 1,
    value: observationValue(1),
    changedBy: 'observer',
    advanceCursor: true,
    audit: { type: 'watcher:observed', message: 'observed', metadata: {} }
  });
  assert.equal(observed.observation.id, 1);
  assert.equal(observed.watcher.lastObservationHash, HASH_A);
  assert.equal(observed.watcher.revision, 2);
  await assert.rejects(
    mutations.repository.recordWatcherObservation({
      watcherId: 1,
      expectedRevision: 1,
      value: observationValue(1, { previousHash: HASH_A, currentHash: HASH_B }),
      changedBy: 'stale',
      advanceCursor: true
    }),
    error => error instanceof WatcherConflictError
  );
  await assert.rejects(
    mutations.repository.recordWatcherObservation({
      watcherId: 1,
      expectedRevision: 2,
      value: observationValue(1, { workContextId: 20 }),
      changedBy: 'wrong',
      advanceCursor: true
    }),
    error => error instanceof WatcherReferenceError && error.code === 'WATCHER_OBSERVATION_MISMATCH'
  );
  await assert.rejects(
    mutations.repository.recordWatcherObservation({
      watcherId: 1,
      expectedRevision: 2,
      value: observationValue(1, { summary: { bytes: 4, lineCount: 1, content: 'secret' } }),
      changedBy: 'wrong',
      advanceCursor: true
    }),
    /only bytes and lineCount/
  );
  await assert.rejects(
    mutations.repository.recordWatcherObservation({
      watcherId: 1,
      expectedRevision: 2,
      value: observationValue(1, { sourceRefs: [{ path: 'outside/other.txt' }] }),
      changedBy: 'wrong',
      advanceCursor: true
    }),
    error => error instanceof WatcherReferenceError && error.code === 'WATCHER_OBSERVATION_MISMATCH'
  );

  await assert.rejects(
    mutations.repository.createWatcherProposal({
      watcherId: 1,
      value: proposalValue(1, { sourceRefs: [{ path: 'outside/other.txt' }] }),
      changedBy: 'wrong'
    }),
    error => error instanceof WatcherReferenceError && error.code === 'WATCHER_PROPOSAL_MISMATCH'
  );

  const drafted = await mutations.repository.createWatcherProposal({
    watcherId: 1,
    value: proposalValue(1, { observationId: 1, evidenceRefs: ['watcher-observations.json:1'] }),
    changedBy: 'proposer',
    audit: { type: 'watcher:proposal_created', message: 'drafted', metadata: {} }
  });
  assert.equal(drafted.proposal.status, 'proposed');
  assert.equal(mutations.tickets().length, 0);
  let ticketId = 0;
  const approve = await mutations.repository.approveWatcherProposal({
    proposalId: drafted.proposal.id,
    changedBy: 'approver',
    createTicket: async ({ proposal, source }) => {
      const ticket = { id: ++ticketId, objective: proposal.objective, workContextId: proposal.workContextId, source };
      mutations.addTicket(ticket);
      return { ok: true, ticket };
    }
  });
  assert.equal(approve.proposal.status, 'approved');
  assert.equal(approve.proposal.createdTicketId, 1);
  assert.equal(approve.proposal.revision, 2);
  assert.equal(approve.ticket.source.proposalId, drafted.proposal.id);
  assert.equal((await mutations.repository.getWatcherProposalById(drafted.proposal.id)).status, 'approved');
  await assert.rejects(
    mutations.repository.approveWatcherProposal({ proposalId: drafted.proposal.id, changedBy: 'again', createTicket: async () => null }),
    error => error instanceof WatcherStateConflictError
  );

  const rejectedDraft = await mutations.repository.createWatcherProposal({
    watcherId: 1,
    value: proposalValue(1),
    changedBy: 'proposer'
  });
  const rejected = await mutations.repository.rejectWatcherProposal({
    proposalId: rejectedDraft.proposal.id,
    changedBy: 'reviewer'
  });
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.proposal.rejectedAt, ISO);

  const concurrent = harness({ watchers: [watcherRecord(1)], proposals: [proposalRecord(1, 1)] });
  const race = await Promise.allSettled([
    concurrent.repository.rejectWatcherProposal({ proposalId: 1, changedBy: 'one' }),
    concurrent.repository.rejectWatcherProposal({ proposalId: 1, changedBy: 'two' })
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter(item => item.status === 'rejected').length, 1);

  const rollback = harness({
    watchers: [watcherRecord(1)],
    appendSystemLog: async () => { throw new Error('audit unavailable'); }
  });
  await assert.rejects(
    rollback.repository.createWatcherProposal({
      watcherId: 1,
      value: proposalValue(1),
      changedBy: 'operator',
      audit: { type: 'watcher:proposal_created', message: 'drafted', metadata: {} }
    }),
    /audit unavailable/
  );
  assert.equal(rollback.proposals().length, 0);

  await assert.rejects(harness({ watchers: [watcherRecord(1), watcherRecord(1)] }).repository.listWatchers({ limit: 1 }), error => error instanceof WatcherIdConflictError);
  await assert.rejects(harness({ watchers: [{ id: 1, name: 'Old shape' }] }).repository.listWatchers({ limit: 1 }), /missing current-format field/);
  await assert.rejects(
    harness({ watchers: [watcherRecord(1)], observations: [{ id: 1, watcherId: 1, status: 'changed' }] }).repository.listWatcherObservations({ limit: 1 }),
    /missing current-format field/
  );
  await assert.rejects(
    harness({ watchers: [watcherRecord(1)], proposals: [{ id: 1, watcherId: 1, status: 'proposed' }] }).repository.listWatcherProposals({ limit: 1 }),
    /missing current-format field/
  );
  await assert.rejects(
    harness({
      watchers: [watcherRecord(1)],
      tickets: [{ id: 1, source: { type: 'watcher_proposal', watcherId: 1, workContextId: 10, proposalId: 99, observationId: null } }]
    }).repository.listWatcherProposals({ limit: 1 }),
    error => error instanceof WatcherReferenceError && error.code === 'WATCHER_TICKET_PROVENANCE_MISMATCH'
  );
  await assert.rejects(catalog.repository.listWatchers({ limit: 4 }), /configured maximum/);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  const methodSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'watcher-authority-methods.js'), 'utf8');
  const migrationSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'migrations', '023_watcher_authority.sql'), 'utf8');
  assert.equal(serverSource.includes('function readWatchers()'), false);
  assert.equal(serverSource.includes('function writeWatchers('), false);
  assert.equal(serverSource.includes('function readWatcherObservations()'), false);
  assert.equal(serverSource.includes('function readWatcherProposals()'), false);
  assert.ok(serverSource.includes('getWatcherOperationalSummary({ limit })'));
  assert.ok(serverSource.includes('expectedRevision ?? request.body.revision'));
  assert.ok(storeSource.includes('installWatcherAuthorityMethods(PostgresRuntimeStore'));
  assert.ok(methodSource.includes("WHERE id = $1 FOR UPDATE"));
  assert.ok(methodSource.includes('persistence: { client }'));
  assert.ok(methodSource.includes("type: 'watcher.proposal_approved'"));
  assert.ok(methodSource.includes("this.table('watcher_status_counts')"));
  assert.ok(migrationSource.includes('CREATE TABLE watchers'));
  assert.ok(migrationSource.includes('CREATE TABLE watcher_status_counts'));
  assert.ok(migrationSource.includes('CREATE TABLE watcher_observations'));
  assert.ok(migrationSource.includes('CREATE TRIGGER watcher_observations_append_only'));
  assert.ok(migrationSource.includes('CREATE TABLE watcher_ticket_proposals'));
  assert.ok(migrationSource.includes('CONSTRAINT watcher_ticket_proposals_disposition_shape'));
  assert.ok(migrationSource.includes('CONSTRAINT tickets_watcher_proposal_fk'));
  assert.ok(migrationSource.includes('no JSON importer or legacy branch is provided'));

  console.log('PASS: watcher authority repository — strict current-format manual watchers, bounded pages, transactional receipt/cursor semantics, proposal disposition, and PostgreSQL ticket/event approval coupling');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
