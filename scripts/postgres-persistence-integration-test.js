#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
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
  const store = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const peer = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });

  try {
    const migrationResults = await Promise.all([store.migrate(), peer.migrate()]);
    assert.equal(migrationResults.flat().filter(name => name === '001_runtime_core.sql').length, 1);
    assert.deepEqual(await store.migrate(), []);
    assert.equal(await store.health(), true);

    const ticketOne = await store.createTicket({ status: 'open', title: 'First ticket' });
    const ticketTwo = await store.createTicket({ status: 'open', title: 'Second ticket' });
    assert.notEqual(ticketOne.id, ticketTwo.id);
    assert.equal(ticketOne.revision, 1);

    const runOne = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    const runTwo = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    const runThree = await store.createRun({ ticketId: ticketTwo.id, agentId: 2, status: 'pending' });

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

    console.log('PASS: PostgreSQL integration — migrations, append-only chains, rollback, distributed claims, leases, and hierarchical concurrency');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    await Promise.allSettled([store.close(), peer.close()]);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
