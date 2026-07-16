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
  const nonemptyFoundationStore = new PostgresRuntimeStore({
    connectionString,
    schema: nonemptyFoundationSchema,
    lockTimeoutMs: 3_000
  });

  try {
    const migrationResults = await Promise.all([store.migrate(), peer.migrate()]);
    assert.equal(migrationResults.flat().filter(name => name === '001_runtime_core.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '002_runtime_evidence.sql').length, 1);
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
    assert.notEqual(ticketOne.id, ticketTwo.id);
    assert.equal(ticketOne.revision, 1);

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

    const terminalRollbackRun = await store.transitionRun({
      runId: rollbackRun.id,
      expectedRevision: rollbackRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.terminalized'
    });
    assert.equal(terminalRollbackRun.run.status, 'failed');
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

    console.log('PASS: PostgreSQL integration — optimistic lifecycle, lease fencing, immutable evidence, replay revisions, idempotent receipts, rollback, claims, and path concurrency');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${nonemptyFoundationStore.schemaSql} CASCADE`); } catch (_) {}
    await Promise.allSettled([store.close(), peer.close(), smallRecordStore.close(), nonemptyFoundationStore.close()]);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
