#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeStore
} = require('../persistence/postgres/store');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required for the PostgreSQL integration test');
  process.exit(1);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

async function main() {
  const schema = `ticket_system_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const nonemptyFoundationSchema = `${schema}_nonempty`;
  const store = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const peer = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const smallRecordStore = new PostgresRuntimeStore({
    connectionString,
    schema,
    lockTimeoutMs: 3_000,
    maxJsonRecordBytes: 256
  });
  const singleConnectionStore = new PostgresRuntimeStore({
    connectionString,
    schema,
    lockTimeoutMs: 3_000,
    maxConnections: 1
  });
  const nonemptyFoundationStore = new PostgresRuntimeStore({
    connectionString,
    schema: nonemptyFoundationSchema,
    lockTimeoutMs: 3_000
  });

  try {
    const migrationResults = await Promise.all([store.migrate(), peer.migrate()]);
    assert.equal(migrationResults.flat().filter(name => name === '001_runtime_core.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '002_runtime_evidence.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '003_ticket_run_lifecycle.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '004_non_terminal_evidence.sql').length, 1);
    assert.deepEqual(await store.migrate(), []);
    assert.equal(await store.health(), true);

    const ticketOne = await store.createTicket({ status: 'open', title: 'First ticket' });
    const ticketTwo = await store.createTicket({ status: 'open', title: 'Second ticket' });
    const lifecycleTicket = await store.createTicket({ status: 'open', title: 'Lifecycle ticket' });
    const ticketRaceTicket = await store.createTicket({ status: 'open', title: 'Ticket transition race' });
    const rollbackTicket = await store.createTicket({ status: 'open', title: 'Rollback ticket' });
    const transitionRollbackTicket = await store.createTicket({ status: 'open', title: 'Transition rollback ticket' });
    const composedTicket = await store.createTicket({ status: 'open', title: 'Composed evidence transaction' });
    const composedRollbackTicket = await store.createTicket({ status: 'open', title: 'Composed rollback transaction' });
    const fencedTicket = await store.createTicket({ status: 'open', title: 'Lease fencing transaction' });
    const leaseRepositoryTicket = await store.createTicket({ status: 'open', title: 'Lease repository boundary' });
    const terminalBoundaryTicket = await store.createTicket({ status: 'open', title: 'Terminalization boundary' });
    const terminalRollbackTicket = await store.createTicket({ status: 'open', title: 'Terminalization rollback' });
    const terminalExpiredTicket = await store.createTicket({ status: 'open', title: 'Expired terminal recovery' });
    const nonTerminalEvidenceTicket = await store.createTicket({ status: 'open', title: 'Non-terminal evidence boundary' });
    const lifecycleBoundaryTicket = await store.createTicketWithEvent({
      ticket: {
        status: 'open',
        title: 'Ticket/run lifecycle boundary',
        assignmentTargetType: 'group',
        assignmentTargetId: 20,
        assignmentMode: 'allocated',
        changedAt: '2000-01-01T00:00:00.000Z'
      },
      eventPayload: { source: 'integration' }
    });
    const lifecycleRaceTicket = await store.createTicket({
      status: 'open', title: 'Lifecycle creation race', assignmentTargetType: 'agent', assignmentTargetId: 30
    });
    const retryBoundaryTicket = await store.createTicket({
      status: 'open', title: 'Atomic retry boundary', assignmentTargetType: 'agent', assignmentTargetId: 40,
      assignmentMode: 'individual'
    });
    assert.notEqual(ticketOne.id, ticketTwo.id);
    assert.equal(ticketOne.revision, 1);
    assert.equal(lifecycleBoundaryTicket.ticket.status, 'open');
    assert.notEqual(lifecycleBoundaryTicket.ticket.changedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(lifecycleBoundaryTicket.event.type, 'ticket.created');
    const childTicketRace = await Promise.all([
      store.createTicketWithEvent({
        ticket: { status: 'blocked', assignmentTargetType: 'agent', assignmentTargetId: 99,
          spawnIdempotencyKey: 'integration-child-once' },
        eventPayload: { parentRunId: 999 }
      }),
      peer.createTicketWithEvent({
        ticket: { status: 'blocked', assignmentTargetType: 'agent', assignmentTargetId: 99,
          spawnIdempotencyKey: 'integration-child-once' },
        eventPayload: { parentRunId: 999 }
      })
    ]);
    assert.equal(childTicketRace[0].ticket.id, childTicketRace[1].ticket.id);
    assert.equal(childTicketRace.filter(result => result.created).length, 1,
      'workflow child idempotency must survive multi-process creation races');

    const runOne = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    const runTwo = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    const runThree = await store.createRun({ ticketId: ticketTwo.id, agentId: 2, status: 'pending' });
    const lifecycleRun = await store.createRun({ ticketId: lifecycleTicket.id, agentId: 3, status: 'pending' });
    const rollbackRun = await store.createRun({ ticketId: rollbackTicket.id, agentId: 4, status: 'pending' });
    const replayIntegrityRun = await store.createRun({ ticketId: rollbackTicket.id, agentId: 4, status: 'pending' });
    const composedRun = await store.createRun({ ticketId: composedTicket.id, agentId: 5, status: 'pending' });
    const composedRollbackRun = await store.createRun({
      ticketId: composedRollbackTicket.id, agentId: 6, status: 'pending'
    });
    const fencedRun = await store.createRun({ ticketId: fencedTicket.id, agentId: 7, status: 'pending' });
    const leaseRepositoryRun = await store.createRun({
      ticketId: leaseRepositoryTicket.id, agentId: 8, status: 'pending'
    });
    const terminalBoundaryRun = await store.createRun({
      ticketId: terminalBoundaryTicket.id, agentId: 9, status: 'pending'
    });
    const terminalRollbackRun = await store.createRun({
      ticketId: terminalRollbackTicket.id, agentId: 10, status: 'pending'
    });
    const terminalExpiredRun = await store.createRun({
      ticketId: terminalExpiredTicket.id, agentId: 11, status: 'pending'
    });
    const nonTerminalEvidenceRun = await store.createRun({
      ticketId: nonTerminalEvidenceTicket.id, agentId: 12, status: 'pending'
    });

    const nonTerminalClaim = await store.claimPendingRun({
      leaseOwner: 'evidence-worker', leaseDurationMs: 30_000, eligibleRunIds: [nonTerminalEvidenceRun.id]
    });
    await store.transitionRun({
      runId: nonTerminalEvidenceRun.id,
      expectedRevision: nonTerminalClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'evidence-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: nonTerminalEvidenceRun.id,
      snapshot: { version: 1, authorityChecks: [], workspaceOperations: [] }
    });
    const operationKey = `run:${nonTerminalEvidenceRun.id}:agent:0:0:integration`;
    const operationIntent = {
      operation: 'writeFile',
      args: { path: 'integration/report.txt', content: 'ready' },
      preState: { existed: false },
      authorityDecision: { status: 'allowed' },
      target: {
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt'
      }
    };
    assert.equal((await store.prepareTargetOperation({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      stepId: '0',
      leaseOwner: 'evidence-worker',
      intent: operationIntent
    })).inserted, true);
    assert.equal((await peer.prepareTargetOperation({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      stepId: '0',
      leaseOwner: 'evidence-worker',
      intent: { ...operationIntent, args: { content: 'ready', path: 'integration/report.txt' } }
    })).inserted, false);
    await store.appendRunEvidence({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      evidenceKey: `authority:${operationKey}`,
      replayKey: 'authorityChecks',
      replayItem: { operation: 'writeFile', status: 'allowed' },
      event: { type: 'authority.allowed', payload: { operation: 'writeFile', status: 'allowed' } }
    });
    const targetCompletion = {
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      historyRecord: {
        operation: 'writeFile',
        args: operationIntent.args,
        outcome: 'succeeded'
      },
      receipt: {
        operation: 'writeFile',
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt',
        providerResponse: { path: 'integration/report.txt', size: 5 }
      },
      replayItem: {
        operation: { operation: 'writeFile', args: operationIntent.args },
        result: { path: 'integration/report.txt', size: 5 }
      },
      event: {
        type: 'workspace.operation',
        stepId: '0',
        payload: { operation: 'writeFile', path: 'integration/report.txt', mutating: true }
      }
    };
    const completionRace = await Promise.all([
      store.completeTargetOperation(targetCompletion),
      peer.completeTargetOperation(targetCompletion)
    ]);
    assert.equal(completionRace.filter(result => result.inserted).length, 1,
      'concurrent completion must create one receipt/evidence bundle');
    const targetState = await store.getTargetOperation(nonTerminalEvidenceRun.id, operationKey);
    assert.ok(targetState.intent);
    assert.ok(targetState.receipt);
    assert.deepEqual(targetState.receipt.args, operationIntent.args);
    assert.equal(targetState.receipt.result.path, 'integration/report.txt');
    assert.equal(targetState.receipt.mutationReceipt.targetPath, 'integration/report.txt');
    assert.equal((await store.listOperationReceipts(nonTerminalEvidenceRun.id)).length, 1);
    const targetReplay = await store.getReplaySnapshot(nonTerminalEvidenceRun.id);
    assert.equal(targetReplay.snapshot.authorityChecks.length, 1);
    assert.equal(targetReplay.snapshot.workspaceOperations.length, 1);
    const targetEvents = await store.listRunEvents(nonTerminalEvidenceRun.id);
    assert.ok(targetEvents.some(event => event.type === 'workspace.operation_prepared'));
    assert.ok(targetEvents.some(event => event.type === 'workspace.operation'));
    assert.equal(verifyCurrentRunEventChain(targetEvents).chainValid, true);
    await singleConnectionStore.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, () => singleConnectionStore.appendRunEvidence({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      evidenceKey: `authority:${operationKey}`,
      replayKey: 'authorityChecks',
      replayItem: { operation: 'writeFile', status: 'allowed' },
      event: { type: 'authority.allowed', payload: { operation: 'writeFile', status: 'allowed' } }
    }));
    const targetLockEntered = deferred();
    const releaseTargetLock = deferred();
    let competingTargetLockEntered = false;
    const heldTargetLock = store.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, async () => {
      targetLockEntered.resolve();
      await releaseTargetLock.promise;
    });
    await targetLockEntered.promise;
    const competingTargetLock = peer.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, async () => { competingTargetLockEntered = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(competingTargetLockEntered, false,
      'session target lock must span committed intent, external effect, and completion transactions');
    releaseTargetLock.resolve();
    await Promise.all([heldTargetLock, competingTargetLock]);
    assert.equal(competingTargetLockEntered, true);

    const lifecycleBatch = await store.createRunsAndStartTicket({
      ticketId: lifecycleBoundaryTicket.ticket.id,
      runDrafts: [{
        ticketId: lifecycleBoundaryTicket.ticket.id, agentId: 20, agentName: 'Twenty', status: 'pending',
        executionMode: 'agent'
      }, {
        ticketId: lifecycleBoundaryTicket.ticket.id, agentId: 21, agentName: 'Twenty One', status: 'pending',
        executionMode: 'agent'
      }],
      runEventPayload: run => ({ agentId: run.agentId, agentName: run.agentName })
    });
    assert.equal(lifecycleBatch.ticket.status, 'in_progress');
    assert.equal(lifecycleBatch.ticket.revision, 2);
    assert.equal(lifecycleBatch.runs.length, 2);
    assert.deepEqual(lifecycleBatch.events.map(event => event.type), ['run.created', 'run.created', 'ticket.updated']);
    assert.ok(lifecycleBatch.runs.every(run => run.ticketOpenedAt === lifecycleBoundaryTicket.ticket.updatedAt));
    const failedAllocationMember = await store.transitionRun({
      runId: lifecycleBatch.runs[0].id,
      expectedRevision: lifecycleBatch.runs[0].revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.execution_failed',
      eventPayload: { source: 'lifecycle settlement integration' }
    });
    const failedAllocationSettlement = await store.transitionTicketAfterRun({ runId: failedAllocationMember.run.id });
    assert.equal(failedAllocationSettlement.changed, true);
    assert.equal(failedAllocationSettlement.ticket.status, 'failed');

    const lifecycleCreationRace = await Promise.allSettled([
      store.createRunsAndStartTicket({
        ticketId: lifecycleRaceTicket.id,
        runDrafts: [{ ticketId: lifecycleRaceTicket.id, agentId: 30, status: 'pending', executionMode: 'agent' }]
      }),
      peer.createRunsAndStartTicket({
        ticketId: lifecycleRaceTicket.id,
        runDrafts: [{ ticketId: lifecycleRaceTicket.id, agentId: 30, status: 'pending', executionMode: 'agent' }]
      })
    ]);
    assert.equal(lifecycleCreationRace.filter(result => result.status === 'fulfilled').length, 1);
    const lifecycleRaceCount = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('runs')} WHERE ticket_id = $1`,
      [lifecycleRaceTicket.id]
    );
    assert.equal(lifecycleRaceCount.rows[0].count, 1, 'same-ticket lifecycle creation must not duplicate a run');

    const retryInitial = await store.createRunsAndStartTicket({
      ticketId: retryBoundaryTicket.id,
      runDrafts: [{ ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' }]
    });
    const retryFailed = await store.transitionRun({
      runId: retryInitial.runs[0].id,
      expectedRevision: retryInitial.runs[0].revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.execution_failed',
      eventPayload: { reason: 'retryable integration failure' }
    });
    await assert.rejects(
      smallRecordStore.createRetryRun({
        ticketId: retryBoundaryTicket.id,
        predecessorRunId: retryFailed.run.id,
        runDraft: { ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' },
        runEventPayload: () => ({ padding: 'x'.repeat(300) })
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    assert.equal((await store.getTicket(retryBoundaryTicket.id)).status, 'in_progress',
      'failed retry evidence must roll back ticket reopen');
    const retryCountAfterRollback = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('runs')} WHERE ticket_id = $1`,
      [retryBoundaryTicket.id]
    );
    assert.equal(retryCountAfterRollback.rows[0].count, 1, 'failed retry evidence must roll back the new run');

    const retryCreated = await store.createRetryRun({
      ticketId: retryBoundaryTicket.id,
      predecessorRunId: retryFailed.run.id,
      runDraft: { ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' },
      runEventPayload: run => ({ agentId: run.agentId })
    });
    assert.equal(retryCreated.ticket.status, 'in_progress');
    assert.equal(retryCreated.runs[0].status, 'pending');
    assert.equal(retryCreated.runs[0].rerunMode, 'auto_retry');
    assert.equal((await store.getRun(retryFailed.run.id)).status, 'failed');

    const ticketInProgress = await store.transitionTicket({
      ticketId: ticketRaceTicket.id,
      expectedRevision: ticketRaceTicket.revision,
      fromStatuses: ['open'],
      toStatus: 'in_progress',
      eventPayload: { source: 'integration' }
    });
    assert.equal(ticketInProgress.ticket.revision, 2);
    assert.equal(ticketInProgress.event.payload.previousStatus, 'open');
    const ticketRace = await Promise.allSettled([
      store.transitionTicket({
        ticketId: ticketRaceTicket.id,
        expectedRevision: 2,
        fromStatuses: ['in_progress'],
        toStatus: 'completed'
      }),
      peer.transitionTicket({
        ticketId: ticketRaceTicket.id,
        expectedRevision: 2,
        fromStatuses: ['in_progress'],
        toStatus: 'failed'
      })
    ]);
    assert.equal(ticketRace.filter(result => result.status === 'fulfilled').length, 1);
    const ticketRaceFailure = ticketRace.find(result => result.status === 'rejected');
    assert.ok(ticketRaceFailure.reason instanceof OptimisticConcurrencyError);

    await assert.rejects(
      smallRecordStore.transitionTicket({
        ticketId: transitionRollbackTicket.id,
        expectedRevision: transitionRollbackTicket.revision,
        fromStatuses: ['open'],
        toStatus: 'blocked',
        eventPayload: { padding: 'x'.repeat(220) }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const ticketAfterRollback = await store.getTicket(transitionRollbackTicket.id);
    assert.equal(ticketAfterRollback.status, 'open', 'event failure must roll back ticket state');
    assert.equal(ticketAfterRollback.revision, 1, 'event failure must roll back ticket revision');

    await store.writeReplaySnapshot({
      runId: replayIntegrityRun.id,
      snapshot: { version: 1, integrity: 'original' }
    });
    await store.pool.query(
      `UPDATE ${store.table('replay_snapshots')}
       SET snapshot = '{"version":1,"integrity":"tampered"}'::jsonb,
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE run_id = $1`,
      [replayIntegrityRun.id]
    );
    await assert.rejects(
      store.getReplaySnapshot(replayIntegrityRun.id),
      error => error && error.code === 'POSTGRES_REPLAY_INTEGRITY_FAILURE'
    );

    const lifecycleClaim = await store.claimPendingRun({
      leaseOwner: 'lifecycle-worker', leaseDurationMs: 30_000, eligibleRunIds: [lifecycleRun.id]
    });
    const startedLifecycle = await store.transitionRun({
      runId: lifecycleRun.id,
      expectedRevision: lifecycleClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'lifecycle-worker',
      eventType: 'run.started'
    });
    assert.equal(startedLifecycle.run.status, 'running');
    assert.ok(startedLifecycle.run.startedAt);
    assert.equal(startedLifecycle.run.revision, 3);

    await assert.rejects(
      store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation: { effectiveness: { status: 'unknown' } } }),
      /requires a terminal run/
    );

    const replayCreated = await store.writeReplaySnapshot({
      runId: lifecycleRun.id,
      snapshot: { version: 1, steps: [] }
    });
    assert.equal(replayCreated.record.revision, 1);
    const replayRace = await Promise.allSettled([
      store.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 1,
        snapshot: { version: 1, steps: ['store'] }
      }),
      peer.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 1,
        snapshot: { version: 1, steps: ['peer'] }
      })
    ]);
    assert.equal(replayRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(replayRace.find(result => result.status === 'rejected').reason instanceof OptimisticConcurrencyError);
    const replayWinner = replayRace.find(result => result.status === 'fulfilled').value;
    assert.equal(replayWinner.record.revision, 2);

    const runRace = await Promise.allSettled([
      store.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'lifecycle-worker',
        eventType: 'run.terminalized'
      }),
      peer.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        fromStatuses: ['running'],
        toStatus: 'failed',
        leaseOwner: 'lifecycle-worker',
        eventType: 'run.terminalized'
      })
    ]);
    assert.equal(runRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(runRace.find(result => result.status === 'rejected').reason instanceof OptimisticConcurrencyError);
    const terminalRun = runRace.find(result => result.status === 'fulfilled').value.run;
    assert.ok(terminalRun.completedAt);
    assert.equal(terminalRun.leaseOwner, null);
    assert.equal(terminalRun.revision, 4);
    await assert.rejects(
      store.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: terminalRun.revision,
        fromStatuses: [terminalRun.status],
        toStatus: 'pending'
      }),
      /Unsupported run status transition/
    );
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('runs')}
         SET status = 'pending', revision = revision + 1, completed_at = NULL
         WHERE id = $1`,
        [lifecycleRun.id]
      ),
      /terminal runs cannot be reopened/
    );

    const finalizedReplay = await store.writeReplaySnapshot({
      runId: lifecycleRun.id,
      expectedRevision: replayWinner.record.revision,
      snapshot: { ...replayWinner.record.snapshot, terminalStatus: terminalRun.status },
      finalize: true
    });
    assert.equal(finalizedReplay.record.revision, 3);
    assert.ok(finalizedReplay.record.finalizedAt);
    await assert.rejects(
      store.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        snapshot: { version: 1, tampered: true }
      }),
      error => error instanceof ImmutableEvidenceConflictError
    );

    const evaluation = { effectiveness: { status: terminalRun.status === 'completed' ? 'passed' : 'failed' } };
    const recordedEvaluation = await store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation });
    assert.equal(recordedEvaluation.inserted, true);
    assert.equal((await store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation })).inserted, false);
    await assert.rejects(
      store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation: { effectiveness: { status: 'different' } } }),
      error => error instanceof ImmutableEvidenceConflictError
    );

    const consequence = { mutations: [], verification: { status: evaluation.effectiveness.status } };
    assert.equal((await store.recordRunConsequence({ runId: lifecycleRun.id, consequence })).inserted, true);
    assert.equal((await store.recordRunConsequence({ runId: lifecycleRun.id, consequence })).inserted, false);

    const receiptDocument = {
      targetId: 'local-workspace',
      targetKind: 'workspace',
      targetPath: 'reports/daily.json',
      changedResources: ['reports/daily.json']
    };
    const recordedReceipt = await store.recordOperationReceipt({
      runId: lifecycleRun.id,
      idempotencyKey: 'lifecycle-step-1-write',
      stepId: '1',
      operation: 'writeFile',
      outcome: 'succeeded',
      receipt: receiptDocument
    });
    assert.equal(recordedReceipt.inserted, true);
    assert.equal((await store.recordOperationReceipt({
      runId: lifecycleRun.id,
      idempotencyKey: 'lifecycle-step-1-write',
      stepId: '1',
      operation: 'writeFile',
      outcome: 'succeeded',
      receipt: { changedResources: ['reports/daily.json'], targetPath: 'reports/daily.json', targetKind: 'workspace', targetId: 'local-workspace' }
    })).inserted, false, 'semantically identical JSON must be idempotent regardless of key order');
    await assert.rejects(
      store.recordOperationReceipt({
        runId: lifecycleRun.id,
        idempotencyKey: 'lifecycle-step-1-write',
        stepId: '1',
        operation: 'writeFile',
        outcome: 'failed',
        receipt: receiptDocument
      }),
      error => error instanceof IdempotencyConflictError
    );
    assert.equal((await store.listOperationReceipts(lifecycleRun.id)).length, 1);

    const composedClaim = await store.claimPendingRun({
      leaseOwner: 'composed-worker', leaseDurationMs: 30_000, eligibleRunIds: [composedRun.id]
    });
    const composedStarted = await store.transitionRun({
      runId: composedRun.id,
      expectedRevision: composedClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'composed-worker',
      eventType: 'run.started'
    });
    const composedReplayCreated = await store.writeReplaySnapshot({
      runId: composedRun.id,
      snapshot: { version: 1, steps: [] }
    });
    const composedEvidence = await store.withTransaction(async client => {
      const terminal = await store.transitionRun({
        runId: composedRun.id,
        expectedRevision: composedStarted.run.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'composed-worker',
        eventType: 'run.completed'
      }, { client });
      const replay = await store.writeReplaySnapshot({
        runId: composedRun.id,
        expectedRevision: composedReplayCreated.record.revision,
        snapshot: { version: 1, steps: ['completed'] },
        finalize: true
      }, { client });
      const runEvaluation = await store.recordRunEvaluation({
        runId: composedRun.id,
        evaluation: { effectiveness: { status: 'passed' } }
      }, { client });
      const runConsequence = await store.recordRunConsequence({
        runId: composedRun.id,
        consequence: { mutations: [], verification: { status: 'passed' } }
      }, { client });
      const operationReceipt = await store.recordOperationReceipt({
        runId: composedRun.id,
        idempotencyKey: 'composed-terminal-receipt',
        operation: 'verifyPostconditions',
        outcome: 'succeeded',
        receipt: { checks: 1, passed: 1 }
      }, { client });
      return { terminal, replay, runEvaluation, runConsequence, operationReceipt };
    });
    assert.equal(composedEvidence.terminal.run.status, 'completed');
    assert.ok(composedEvidence.replay.record.finalizedAt);
    assert.equal(composedEvidence.runEvaluation.inserted, true);
    assert.equal(composedEvidence.runConsequence.inserted, true);
    assert.equal(composedEvidence.operationReceipt.inserted, true);
    assert.equal((await store.getRun(composedRun.id)).status, 'completed');
    assert.equal((await store.getReplaySnapshot(composedRun.id)).revision, 2);
    assert.equal((await store.listOperationReceipts(composedRun.id)).length, 1);
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(composedRun.id)).chainValid, true);

    const terminalClaim = await store.claimPendingRun({
      leaseOwner: 'terminal-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalBoundaryRun.id]
    });
    const terminalStarted = await store.transitionRun({
      runId: terminalBoundaryRun.id,
      expectedRevision: terminalClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'terminal-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: terminalBoundaryRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    const terminalBundle = await store.terminalizeRun({
      runId: terminalBoundaryRun.id,
      fromStatuses: ['running'],
      status: 'completed',
      leaseOwner: 'terminal-worker',
      patch: { currentPhase: 'terminalization', browserReport: null },
      replaySnapshot: {
        version: 1,
        steps: ['started', 'completed'],
        terminalStatus: 'completed',
        finalizedAt: '2026-07-16T12:00:00.000Z'
      },
      executionEvent: { type: 'run.execution_completed', payload: { status: 'completed' } },
      beforeReplayEvents: [{ type: 'run.verification_passed', payload: { status: 'passed' } }],
      replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'completed' } },
      beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
      evaluation: context => {
        assert.deepEqual(context.events.map(event => event.type), [
          'run.execution_completed',
          'run.verification_passed',
          'run.snapshot_finalized',
          'run.violations_checked'
        ]);
        assert.ok(context.events.every(event => event.id && Number.isInteger(event.seq)));
        return { effectiveness: { status: 'passed' }, violations: { status: 'none' } };
      },
      consequence: context => ({
        mutations: [],
        verification: { status: context.evaluation.effectiveness.status }
      }),
      terminalEvent: { type: 'run.terminalized', payload: { status: 'completed' } }
    });
    assert.equal(terminalBundle.run.status, 'completed');
    assert.equal(terminalBundle.run.leaseOwner, null);
    assert.equal(terminalBundle.run.lastHeartbeatAt, null);
    assert.equal(terminalBundle.evaluation.effectiveness.status, 'passed');
    assert.equal(terminalBundle.consequence.verification.status, 'passed');
    assert.ok((await store.getReplaySnapshot(terminalBoundaryRun.id)).finalizedAt);
    assert.equal((await store.getRunEvaluation(terminalBoundaryRun.id)).evaluation.effectiveness.status, 'passed');
    assert.equal((await store.getRunConsequence(terminalBoundaryRun.id)).consequence.verification.status, 'passed');
    assert.deepEqual(
      (await store.listRunEvents(terminalBoundaryRun.id)).slice(-7).map(event => event.type),
      [
        'run.execution_completed',
        'run.verification_passed',
        'run.snapshot_finalized',
        'run.violations_checked',
        'run.evaluation_completed',
        'run.consequence_recorded',
        'run.terminalized'
      ]
    );
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(terminalBoundaryRun.id)).chainValid, true);

    const rollbackClaim = await smallRecordStore.claimPendingRun({
      leaseOwner: 'terminal-rollback-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalRollbackRun.id]
    });
    await smallRecordStore.transitionRun({
      runId: terminalRollbackRun.id,
      expectedRevision: rollbackClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'terminal-rollback-worker',
      eventType: 'run.started'
    });
    const rollbackReplay = await smallRecordStore.writeReplaySnapshot({
      runId: terminalRollbackRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    const rollbackEventsBefore = await store.listRunEvents(terminalRollbackRun.id);
    await assert.rejects(
      smallRecordStore.terminalizeRun({
        runId: terminalRollbackRun.id,
        fromStatuses: ['running'],
        status: 'failed',
        leaseOwner: 'terminal-rollback-worker',
        patch: { error: 'rollback' },
        replaySnapshot: { version: 1, terminalStatus: 'failed', finalizedAt: '2026-07-16T12:00:00.000Z' },
        executionEvent: { type: 'run.execution_completed', payload: { status: 'failed' } },
        replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
        evaluation: { effectiveness: { status: 'failed' }, padding: 'x'.repeat(300) },
        consequence: { mutations: [] },
        terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const rollbackRunAfter = await store.getRun(terminalRollbackRun.id);
    assert.equal(rollbackRunAfter.status, 'running');
    assert.equal(rollbackRunAfter.leaseOwner, 'terminal-rollback-worker');
    const rollbackReplayAfter = await store.getReplaySnapshot(terminalRollbackRun.id);
    assert.equal(rollbackReplayAfter.revision, rollbackReplay.record.revision);
    assert.equal(rollbackReplayAfter.finalizedAt, null);
    assert.equal(await store.getRunEvaluation(terminalRollbackRun.id), null);
    assert.equal(await store.getRunConsequence(terminalRollbackRun.id), null);
    assert.deepEqual(await store.listRunEvents(terminalRollbackRun.id), rollbackEventsBefore);

    const expiredClaim = await store.claimPendingRun({
      leaseOwner: 'expired-terminal-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalExpiredRun.id]
    });
    await store.transitionRun({
      runId: terminalExpiredRun.id,
      expectedRevision: expiredClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'expired-terminal-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: terminalExpiredRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [terminalExpiredRun.id]
    );
    const expiredTerminal = await store.terminalizeRun({
      runId: terminalExpiredRun.id,
      fromStatuses: ['running'],
      status: 'interrupted',
      leaseOwner: null,
      allowExpiredLease: true,
      patch: { error: 'lease expired' },
      replaySnapshot: { version: 1, terminalStatus: 'interrupted', finalizedAt: '2026-07-16T12:00:00.000Z' },
      executionEvent: { type: 'run.execution_completed', payload: { status: 'interrupted' } },
      replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'interrupted' } },
      evaluation: { effectiveness: { status: 'unknown' }, violations: { status: 'none' } },
      consequence: { mutations: [], verification: { status: 'unknown' } },
      terminalEvent: { type: 'run.terminalized', payload: { status: 'interrupted' } }
    });
    assert.equal(expiredTerminal.run.status, 'interrupted');
    assert.equal(expiredTerminal.run.leaseOwner, null);
    assert.equal(expiredTerminal.run.lastHeartbeatAt, null);

    await assert.rejects(
      smallRecordStore.withTransaction(async client => {
        await smallRecordStore.transitionRun({
          runId: composedRollbackRun.id,
          expectedRevision: composedRollbackRun.revision,
          fromStatuses: ['pending'],
          toStatus: 'failed',
          eventType: 'run.failed'
        }, { client });
        await smallRecordStore.recordRunEvaluation({
          runId: composedRollbackRun.id,
          evaluation: { effectiveness: { status: 'failed' } },
          eventPayload: { padding: 'x'.repeat(220) }
        }, { client });
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const composedRunAfterRollback = await store.getRun(composedRollbackRun.id);
    assert.equal(composedRunAfterRollback.status, 'pending');
    assert.equal(composedRunAfterRollback.revision, 1);
    assert.equal(await store.getRunEvaluation(composedRollbackRun.id), null);
    assert.deepEqual(await store.listRunEvents(composedRollbackRun.id), []);

    const firstPendingPage = await store.listPendingRuns({ limit: 1 });
    assert.equal(firstPendingPage.runs.length, 1);
    assert.ok(firstPendingPage.nextCursor, 'bounded pending discovery must expose a continuation cursor');
    const secondPendingPage = await store.listPendingRuns({
      limit: 1,
      cursor: firstPendingPage.nextCursor,
      scanEndCursor: firstPendingPage.scanEndCursor
    });
    assert.equal(secondPendingPage.runs.length, 1);
    assert.notEqual(secondPendingPage.runs[0].id, firstPendingPage.runs[0].id);
    assert.ok((await store.listPendingRuns({ limit: 100 })).runs.some(run => run.id === leaseRepositoryRun.id));
    const repositoryClaim = await store.claimPendingRun({
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [leaseRepositoryRun.id],
      claimPayload: run => ({ repositoryBoundary: true, claimedRevision: run.revision })
    });
    assert.equal(repositoryClaim.event.payload.repositoryBoundary, true);
    assert.equal(repositoryClaim.event.payload.claimedRevision, repositoryClaim.run.revision);
    assert.equal((await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker'
    })).id, leaseRepositoryRun.id);
    assert.equal(await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'wrong-worker'
    }), null);
    const repositoryStarted = await store.transitionRun({
      runId: leaseRepositoryRun.id,
      expectedRevision: repositoryClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'repository-worker',
      eventType: 'run.started'
    });
    assert.equal(await store.persistRunWorkflowStep({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'wrong-worker',
      leaseDurationMs: 30_000,
      stepId: 'wrong',
      action: 'writeFile'
    }), null);
    const repositoryStep = await store.persistRunWorkflowStep({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000,
      stepId: 'verify',
      action: 'condition',
      status: 'completed',
      payload: { status: 'forged' }
    });
    assert.equal(repositoryStep.run.currentStepId, 'verify');
    assert.equal(repositoryStep.run.currentWorkflowAction, 'condition');
    assert.equal(repositoryStep.event.payload.status, 'completed');
    assert.equal(repositoryStep.run.revision, repositoryStarted.run.revision + 1);
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [leaseRepositoryRun.id]
    );
    assert.equal(await store.heartbeatRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000
    }), null, 'an expired PostgreSQL lease must not be renewable');
    assert.equal(await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker'
    }), null, 'an expired PostgreSQL lease must not authorize another action');
    assert.ok((await store.listExpiredRunningRuns({ limit: 100 })).some(run => run.id === leaseRepositoryRun.id));
    const repositoryRecovered = await store.recoverExpiredRun({
      runId: leaseRepositoryRun.id,
      eventPayload: { reason: 'safe repository recovery', status: 'forged' }
    });
    assert.equal(repositoryRecovered.run.status, 'pending');
    assert.equal(repositoryRecovered.run.leaseOwner, null);
    assert.equal(repositoryRecovered.run.lastHeartbeatAt, null);
    assert.equal(repositoryRecovered.event.payload.status, 'pending');
    assert.equal(repositoryRecovered.previousLease.leaseOwner, 'repository-worker');
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(leaseRepositoryRun.id)).chainValid, true);

    const fencedClaim = await store.claimPendingRun({
      leaseOwner: 'fenced-worker-old', leaseDurationMs: 30_000, eligibleRunIds: [fencedRun.id]
    });
    const fencedStarted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: fencedClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'fenced-worker-old',
      eventType: 'run.started'
    });
    const expiredLease = await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING revision`,
      [fencedRun.id]
    );
    const expiredRevision = Number(expiredLease.rows[0].revision);
    assert.equal(expiredRevision, fencedStarted.run.revision + 1);
    await assert.rejects(
      store.transitionRun({
        runId: fencedRun.id,
        expectedRevision: expiredRevision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'fenced-worker-old'
      }),
      error => error instanceof LeaseAuthorityError
    );
    const recovered = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: expiredRevision,
      fromStatuses: ['running'],
      toStatus: 'pending',
      eventType: 'run.lease_expired'
    });
    assert.equal(recovered.run.status, 'pending');
    const replacementClaim = await store.claimPendingRun({
      leaseOwner: 'fenced-worker-new', leaseDurationMs: 30_000, eligibleRunIds: [fencedRun.id]
    });
    const replacementStarted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: replacementClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'fenced-worker-new',
      eventType: 'run.started'
    });
    await assert.rejects(
      store.transitionRun({
        runId: fencedRun.id,
        expectedRevision: replacementStarted.run.revision,
        fromStatuses: ['running'],
        toStatus: 'failed',
        leaseOwner: 'fenced-worker-old'
      }),
      error => error instanceof LeaseAuthorityError
    );
    const fencedCompleted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: replacementStarted.run.revision,
      fromStatuses: ['running'],
      toStatus: 'completed',
      leaseOwner: 'fenced-worker-new'
    });
    assert.equal(fencedCompleted.run.status, 'completed');
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(fencedRun.id)).chainValid, true);

    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('run_evaluations')} SET evaluation = '{}'::jsonb WHERE run_id = $1`, [lifecycleRun.id]),
      /append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('operation_receipts')} SET outcome = 'failed' WHERE id = $1`, [recordedReceipt.record.id]),
      /append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('replay_snapshots')} SET revision = revision + 1 WHERE run_id = $1`, [lifecycleRun.id]),
      /finalized replay snapshots are immutable/
    );

    const rollbackTerminalTransition = await store.transitionRun({
      runId: rollbackRun.id,
      expectedRevision: rollbackRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.terminalized'
    });
    assert.equal(rollbackTerminalTransition.run.status, 'failed');
    await assert.rejects(
      smallRecordStore.recordRunEvaluation({
        runId: rollbackRun.id,
        evaluation: { effectiveness: { status: 'failed' } },
        eventPayload: { padding: 'x'.repeat(220) }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    assert.equal(await store.getRunEvaluation(rollbackRun.id), null, 'event failure must roll back evaluation insert');

    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(lifecycleRun.id)).chainValid, true);

    await Promise.all([
      store.appendEvent({ type: 'run.created', ticketId: ticketOne.id, runId: runOne.id, payload: { writer: 'one' } }),
      peer.appendEvent({ type: 'run.observed', ticketId: ticketOne.id, runId: runOne.id, payload: { writer: 'two' } })
    ]);
    let runOneEvents = await store.listRunEvents(runOne.id);
    assert.equal(runOneEvents.length, 2);
    assert.equal(verifyCurrentRunEventChain(runOneEvents).chainValid, true);

    await assert.rejects(
      store.appendEvent({ type: 'run.invalid_ticket', ticketId: ticketTwo.id, runId: runOne.id, payload: {} }),
      /foreign key|violates/i
    );
    const afterRollback = await store.appendEvent({
      type: 'run.after_rollback', ticketId: ticketOne.id, runId: runOne.id, payload: {}
    });
    assert.equal(afterRollback.seq, 2, 'failed append must roll back the chain-tip reservation');
    runOneEvents = await store.listRunEvents(runOne.id);
    assert.equal(verifyCurrentRunEventChain(runOneEvents).chainValid, true);

    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('events')} SET type = 'tampered' WHERE run_id = $1`, [runOne.id]),
      /events are append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('runs')} SET revision = revision + 2 WHERE id = $1`, [runOne.id]),
      /revision must advance exactly once/
    );

    const eligibleRunIds = [runTwo.id, runThree.id];
    const [firstClaim, secondClaim] = await Promise.all([
      store.claimPendingRun({
        leaseOwner: 'worker-a', leaseDurationMs: 30_000, eligibleRunIds,
        claimPayload: { leaseOwner: 'forged', scheduler: 'a' }
      }),
      peer.claimPendingRun({
        leaseOwner: 'worker-b', leaseDurationMs: 30_000, eligibleRunIds,
        claimPayload: { leaseOwner: 'forged', scheduler: 'b' }
      })
    ]);
    assert.ok(firstClaim && secondClaim);
    assert.notEqual(firstClaim.run.id, secondClaim.run.id, 'SKIP LOCKED claims must not duplicate a run');
    assert.equal(firstClaim.event.payload.leaseOwner, firstClaim.run.leaseOwner);
    assert.equal(secondClaim.event.payload.leaseOwner, secondClaim.run.leaseOwner);
    assert.equal(firstClaim.run.revision, 2);
    assert.equal(await store.claimPendingRun({ leaseOwner: 'worker-c', leaseDurationMs: 30_000, eligibleRunIds }), null);

    const workerAClaim = firstClaim.run.leaseOwner === 'worker-a' ? firstClaim : secondClaim;
    assert.equal(await peer.heartbeatRunLease({
      runId: workerAClaim.run.id, leaseOwner: 'wrong-worker', leaseDurationMs: 30_000
    }), null);
    const heartbeat = await store.heartbeatRunLease({
      runId: workerAClaim.run.id,
      leaseOwner: 'worker-a',
      leaseDurationMs: 30_000,
      payload: { leaseOwner: 'forged', source: 'integration' }
    });
    assert.equal(heartbeat.event.payload.leaseOwner, 'worker-a');
    assert.equal(heartbeat.run.revision, 3);
    const released = await store.releaseRunLease({
      runId: workerAClaim.run.id, leaseOwner: 'worker-a', payload: { source: 'integration' }
    });
    assert.equal(released.run.leaseOwner, null);
    assert.equal(released.run.lastHeartbeatAt, null);
    assert.equal(released.event.type, 'run.lease_released');
    assert.equal(released.run.revision, 4);
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(workerAClaim.run.id)).chainValid, true);

    const outerEntered = deferred();
    const releaseOuter = deferred();
    const parentEntered = deferred();
    const unrelatedEntered = deferred();
    let parentWasEntered = false;

    const outer = store.withWorkspaceMutationLocks({ targetId: 'local', paths: ['reports/daily.json'] }, async () => {
      outerEntered.resolve();
      await releaseOuter.promise;
    });
    await outerEntered.promise;

    const parentWaiter = peer.withWorkspaceMutationLocks({ targetId: 'local', paths: ['reports'] }, async () => {
      parentWasEntered = true;
      parentEntered.resolve();
    });
    const unrelated = store.withWorkspaceMutationLocks({ targetId: 'local', paths: ['exports/result.json'] }, async () => {
      unrelatedEntered.resolve();
    });

    await Promise.race([unrelatedEntered.promise, timeout(2_000, 'unrelated path lock was globally serialized')]);
    assert.equal(parentWasEntered, false, 'parent path must wait while a descendant mutation is active');
    await unrelated;
    releaseOuter.resolve();
    await outer;
    await Promise.race([parentEntered.promise, timeout(2_000, 'parent path lock did not resume')]);
    await parentWaiter;

    const foundationClient = await nonemptyFoundationStore.pool.connect();
    try {
      await foundationClient.query(`CREATE SCHEMA ${nonemptyFoundationStore.schemaSql}`);
      await foundationClient.query(`CREATE TABLE ${nonemptyFoundationStore.table('schema_migrations')} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      await foundationClient.query('BEGIN');
      await foundationClient.query(`SET LOCAL search_path TO ${nonemptyFoundationStore.schemaSql}, public`);
      await foundationClient.query(fs.readFileSync(
        path.join(__dirname, '..', 'persistence', 'postgres', 'migrations', '001_runtime_core.sql'),
        'utf8'
      ));
      await foundationClient.query(
        `INSERT INTO ${nonemptyFoundationStore.table('schema_migrations')} (version) VALUES ($1)`,
        ['001_runtime_core.sql']
      );
      await foundationClient.query('COMMIT');
    } catch (error) {
      try { await foundationClient.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      foundationClient.release();
    }
    const foundationTicket = await nonemptyFoundationStore.createTicket({ status: 'open', title: 'Disposable foundation data' });
    const foundationRun = await nonemptyFoundationStore.createRun({
      ticketId: foundationTicket.id, agentId: 1, status: 'pending'
    });
    await nonemptyFoundationStore.appendEvent({
      type: 'run.created',
      ticketId: foundationTicket.id,
      runId: foundationRun.id,
      payload: { orderSensitive: { z: 1, a: 2 } }
    });
    await assert.rejects(
      nonemptyFoundationStore.migrate(),
      /requires an empty development event store/
    );
    const preservedFoundationEvents = await nonemptyFoundationStore.pool.query(
      `SELECT count(*)::int AS count FROM ${nonemptyFoundationStore.table('events')}`
    );
    assert.equal(preservedFoundationEvents.rows[0].count, 1, 'refused migration must preserve development evidence');
    const refusedMigration = await nonemptyFoundationStore.pool.query(
      `SELECT 1 FROM ${nonemptyFoundationStore.table('schema_migrations')} WHERE version = $1`,
      ['002_runtime_evidence.sql']
    );
    assert.equal(refusedMigration.rowCount, 0);

    console.log('PASS: PostgreSQL integration — transactional ticket/run lifecycle, paged lease authority, immutable evidence, replay revisions, idempotent receipts, rollback, claims, and path concurrency');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${nonemptyFoundationStore.schemaSql} CASCADE`); } catch (_) {}
    await Promise.allSettled([
      store.close(),
      peer.close(),
      smallRecordStore.close(),
      singleConnectionStore.close(),
      nonemptyFoundationStore.close()
    ]);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
