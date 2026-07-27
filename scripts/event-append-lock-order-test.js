#!/usr/bin/env node
'use strict';
// Event-append lock order — PostgreSQL-native
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// THE DEFECT THIS PINS. Two evidence paths used to acquire the same two row locks in
// opposite orders:
//
//   caller-locked path   runs FOR UPDATE .......... then run_event_chain_tips FOR UPDATE
//   standalone append    run_event_chain_tips ..... then runs FOR KEY SHARE
//                        FOR UPDATE                (the events foreign-key check)
//
// `FOR UPDATE` and `FOR KEY SHARE` conflict, so that is a real cycle and PostgreSQL
// resolves it with SQLSTATE 40P01. It was found as an intermittent checkpoint failure
// in `run-diagnostics-bundle-test.js`.
//
// WHY IT MATTERED MORE THAN A LOST TRANSACTION. A deadlock is a routine, retryable
// condition — PostgreSQL expects the loser to try again. This runtime does not retry it,
// and 40P01 arrives as a generic `Error`: not `POSTGRES_RECORD_TOO_LARGE`, not a
// `TypeError`/`RangeError`. So in server-level `appendEvent` it falls past the
// request-scoped branch into the LATCHING one, setting `evidencePersistenceFailure`,
// clearing readiness and stopping both schedulers. One unlucky concurrent append could
// take the whole deployment into fail-closed degraded state until restart.
//
// THE FIX IS ORDERING, NOT RETRYING. `_appendEvent` now takes the run row first, in the
// same `FOR KEY SHARE` mode the foreign key needs anyway, so every evidence writer
// follows one order and a concurrent append WAITS instead of deadlocking. Nothing is
// retried, so no transaction is replayed and no event can be duplicated by a retry that
// partially committed. The containment contract in
// `event-record-limit-containment-test.js` is untouched: a genuine persistence failure
// still latches, because 40P01 is prevented rather than reclassified as harmless.
//
// SCENARIO 1 IS THE POSITIVE CONTROL AND IT IS LOAD-BEARING. It drives the inverted
// order with raw SQL and REQUIRES a deadlock. Without it, scenario 2 would be satisfied
// by a database that never deadlocks, an interleaving that never actually raced, or a
// fixture too weak to collide — and the fix would be unproven.
//
// Requires TEST_DATABASE_URL (or DATABASE_URL).

const { withHarness, createAsserter } = require('./postgres-test-harness');
const { assertScenariosExecuted } = require('./child-process-settlement');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const STAMP = Date.now();
const assert = createAsserter();
let scenariosRun = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await withHarness('event append lock order', async ({ store }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: `LockOrder-${STAMP}`, provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'k' },
      groupIds: [], changedBy: 'event-append-lock-order-test'
    })).agent;

    const now = () => new Date().toISOString();
    async function makeRun(label) {
      const ticket = (await store.createTicketWithEvent({
        ticket: {
          objective: `lock order ${label} ${STAMP}`, acceptanceCriteria: null,
          assignmentTargetType: 'agent', assignmentTargetId: agent.id, assignmentMode: 'individual',
          ownedOutputPaths: null, targetRef: null, executionMode: 'agent',
          workflowId: null, workflowInput: null,
          capabilityType: 'directAction', capabilityId: 'agent-selected-actions', capabilityInput: null,
          executionPolicy: { mode: 'assisted', requireVerification: 'when_declared' },
          workTypeId: null, workTypeSnapshot: null, workContextId: null, workContextSnapshot: null,
          status: 'in_progress', createdBy: 'admin', changedBy: 'admin',
          changedAt: now(), createdAt: now(), updatedAt: now()
        },
        eventPayload: { source: 'event-append-lock-order-test' }
      })).ticket;
      const run = await store.createRun({
        ticketId: ticket.id, agentId: agent.id, agentName: agent.name,
        runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
        executionPolicySnapshot: {}, status: 'pending'
      });
      // Seed the chain tip so `ON CONFLICT DO NOTHING` is a no-op in both transactions
      // and the interleaving below turns purely on lock ORDER, not on row creation.
      await store.appendEvent({ type: 'lock.seed', ticketId: ticket.id, runId: run.id, payload: {} });
      return { ticket, run };
    }

    // ── 1. POSITIVE CONTROL — the inverted order really does deadlock ───────
    // Raw SQL, deliberately reproducing what the old `_appendEvent` did. If this stops
    // deadlocking, the fixture has gone stale and scenario 2 proves nothing.
    scenariosRun += 1;
    const control = await makeRun('control');
    const a = await store.pool.connect();
    const b = await store.pool.connect();
    let controlError = null;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // A: caller-locked path — run row first.
      await a.query(`SELECT id FROM ${store.table('runs')} WHERE id = $1 FOR UPDATE`, [control.run.id]);
      // B: old standalone-append path — chain tip first.
      await b.query(
        `SELECT next_seq FROM ${store.table('run_event_chain_tips')} WHERE run_id = $1 FOR UPDATE`,
        [control.run.id]);
      // Cross: A wants the chain tip B holds; B wants the run row A holds, via the
      // events foreign key.
      const pendingA = a.query(
        `SELECT next_seq FROM ${store.table('run_event_chain_tips')} WHERE run_id = $1 FOR UPDATE`,
        [control.run.id]);
      await sleep(300);
      const pendingB = b.query(
        `INSERT INTO ${store.table('events')}
           (id, schema_version, ts, type, ticket_id, run_id, seq, prev_hash, hash, payload)
         VALUES (gen_random_uuid(), 1, clock_timestamp(), 'lock.cross', $1, $2, 99999,
                 repeat('a', 64), repeat('b', 64), '{}'::jsonb)`,
        [control.ticket.id, control.run.id]);
      const settled = await Promise.allSettled([pendingA, pendingB]);
      controlError = settled.map(entry => entry.reason).find(reason => reason && reason.code);
    } finally {
      try { await a.query('ROLLBACK'); } catch (_) { /* aborted */ }
      try { await b.query('ROLLBACK'); } catch (_) { /* aborted */ }
      a.release();
      b.release();
    }
    assert(controlError && controlError.code === '40P01',
      `1: the inverted lock order genuinely deadlocks, so the fixture can detect the defect (got ${controlError && controlError.code})`);
    assert(/deadlock/i.test(String(controlError.message)),
      '1: and PostgreSQL reports it as a deadlock rather than a timeout');

    // ── 2. The store's own append does NOT deadlock in that interleaving ────
    // The cycle has to be CLOSED for this to mean anything: the holder must itself go on
    // to append, so it ends up wanting the chain tip while the concurrent append wants
    // the run row. An earlier version of this scenario only held the run row and never
    // appended — that is a plain wait, not a cycle, and the mutation survived it.
    scenariosRun += 1;
    const subject = await makeRun('subject');
    const conflictsBeforeSubject = store.transientConflictRetries;
    const holder = await store.pool.connect();
    let appendError = null;
    let holderError = null;
    let appended = null;
    try {
      await holder.query('BEGIN');
      // Caller-locked path: run row first.
      await holder.query(`SELECT id FROM ${store.table('runs')} WHERE id = $1 FOR UPDATE`, [subject.run.id]);

      // Standalone append on its own connection. Without the ordering fix this grabs the
      // chain tip and then blocks on the events foreign key, which the holder's
      // FOR UPDATE conflicts with.
      const appendPromise = store.appendEvent({
        type: 'lock.concurrent', ticketId: subject.ticket.id, runId: subject.run.id,
        payload: { marker: `concurrent-${STAMP}` }
      }).then(event => { appended = event; }).catch(error => { appendError = error; });

      await sleep(500);

      // Holder now needs the chain tip — closing the cycle.
      const holderPromise = store.appendEvent({
        type: 'lock.holder', ticketId: subject.ticket.id, runId: subject.run.id,
        payload: { marker: `holder-${STAMP}` }
      }, { client: holder }).catch(error => { holderError = error; });

      await holderPromise;
      if (!holderError) await holder.query('COMMIT');
      await appendPromise;
    } finally {
      try { await holder.query('ROLLBACK'); } catch (_) { /* committed or aborted */ }
      holder.release();
    }
    assert(!holderError || holderError.code !== '40P01',
      `2: the caller-locked writer did not deadlock (${holderError && holderError.code})`);
    assert(!appendError || appendError.code !== '40P01',
      `2: the concurrent append did not deadlock (${appendError && appendError.code})`);
    assert(holderError === null,
      `2: the caller-locked append succeeded (${holderError && holderError.message})`);
    assert(appendError === null,
      `2: the concurrent append succeeded once the run row was released (${appendError && appendError.message})`);
    assert(appended && appended.type === 'lock.concurrent',
      '2: and it returned the appended event');
    // THE ORDERING CONTRACT ITSELF, not merely its symptom. The retry added for the
    // liveness fix absorbs deadlocks, so "the append succeeded" no longer proves the
    // locks were taken in a consistent order — it only proves the safety net works.
    // Requiring ZERO absorbed conflicts separates prevention from recovery, and is what
    // makes a lock-order regression detectable again.
    assert(store.transientConflictRetries === conflictsBeforeSubject,
      `2: the correctly ordered interleaving raised NO transaction conflict at all ` +
      `(${store.transientConflictRetries - conflictsBeforeSubject} absorbed by retry)`);

    // ── 3. Nothing lost, nothing duplicated, chain still verifiable ─────────
    scenariosRun += 1;
    const events = (await store.listTicketEvents(subject.ticket.id, { limit: 200 })).events
      .filter(event => event.runId === subject.run.id);
    const markers = events.filter(event => event.type === 'lock.concurrent');
    const holderMarkers = events.filter(event => event.type === 'lock.holder');
    assert(markers.length === 1,
      `3: the concurrent append landed exactly once — not lost, not duplicated (${markers.length})`);
    assert(holderMarkers.length === 1,
      `3: the caller-locked append landed exactly once too (${holderMarkers.length})`);
    const seqs = events.map(event => event.seq);
    assert(new Set(seqs).size === seqs.length,
      `3: run-scoped sequences are unique (${seqs.join(',')})`);
    assert(seqs[seqs.length - 1] - seqs[0] === seqs.length - 1,
      `3: and contiguous, so each contended append consumed exactly one position (${seqs.join(',')})`);
    assert(verifyCurrentRunEventChain(events).chainValid,
      '3: the run event hash chain still verifies after the contended append');

    // ── 4. Concurrent appends to the SAME run all land, correctly ordered ───
    // The ordering fix must not have serialized appends into losing each other, and the
    // weaker run-row lock must still leave the chain tip doing the real serialization.
    scenariosRun += 1;
    const parallel = await makeRun('parallel');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      store.appendEvent({
        type: 'lock.parallel', ticketId: parallel.ticket.id, runId: parallel.run.id,
        payload: { index }
      })));
    const failures = results.filter(entry => entry.status === 'rejected');
    assert(failures.length === 0,
      `4: 12 concurrent appends to one run all succeed (${failures.length} failed: ${failures.map(f => f.reason && f.reason.code).join(',')})`);

    const parallelEvents = (await store.listTicketEvents(parallel.ticket.id, { limit: 200 })).events
      .filter(event => event.runId === parallel.run.id);
    const indexes = parallelEvents.filter(event => event.type === 'lock.parallel')
      .map(event => event.payload.index).sort((x, y) => x - y);
    assert(JSON.stringify(indexes) === JSON.stringify(Array.from({ length: 12 }, (_, i) => i)),
      `4: every concurrent append is present exactly once (${indexes.join(',')})`);
    const parallelSeqs = parallelEvents.map(event => event.seq);
    assert(new Set(parallelSeqs).size === parallelSeqs.length &&
           parallelSeqs[parallelSeqs.length - 1] - parallelSeqs[0] === parallelSeqs.length - 1,
      `4: concurrent appends took distinct contiguous positions (${parallelSeqs.join(',')})`);
    assert(verifyCurrentRunEventChain(parallelEvents).chainValid,
      '4: and the hash chain verifies across all of them');

    // ── 5. A transient deadlock is retried, not surfaced as a persistence failure ──
    // The captured root cause of the runtime liveness incident: a 40P01 on an evidence
    // append reached the server, which cannot classify it as request-scoped, so it
    // latched `evidencePersistenceFailure` and stopped both schedulers. A deadlock is a
    // routine condition PostgreSQL expects the loser to retry.
    //
    // This forces a genuine deadlock with `store.appendEvent` as one participant and
    // requires it to SUCCEED. Scenario 1 already proved this interleaving really does
    // deadlock at the SQL level, so a pass here is a retry, not an absent conflict.
    scenariosRun += 1;
    const victim = await makeRun('victim');
    const conflictsBeforeVictim = store.transientConflictRetries;
    const blocker = await store.pool.connect();
    let victimError = null;
    let victimEvent = null;
    try {
      await blocker.query('BEGIN');
      // Blocker takes the chain tip first — the order the appender needs second.
      await blocker.query(
        `SELECT next_seq FROM ${store.table('run_event_chain_tips')} WHERE run_id = $1 FOR UPDATE`,
        [victim.run.id]);

      // The appender takes the run row, then blocks on the chain tip.
      const appendPromise = store.appendEvent({
        type: 'lock.retried', ticketId: victim.ticket.id, runId: victim.run.id,
        payload: { marker: `retried-${STAMP}` }
      }).then(event => { victimEvent = event; }).catch(error => { victimError = error; });

      await sleep(500);
      // Blocker now wants the run row the appender holds → cycle → PostgreSQL aborts one.
      await blocker.query(
        `SELECT id FROM ${store.table('runs')} WHERE id = $1 FOR UPDATE`, [victim.run.id]
      ).catch(() => { /* the blocker may be the victim; either way the cycle is real */ });
      await blocker.query('COMMIT').catch(() => blocker.query('ROLLBACK').catch(() => {}));
      await appendPromise;
    } finally {
      try { await blocker.query('ROLLBACK'); } catch (_) { /* settled */ }
      blocker.release();
    }
    assert(victimError === null,
      `5: a transient deadlock on an evidence append is retried, not raised ` +
      `(${victimError && victimError.code}: ${victimError && victimError.message})`);
    assert(victimEvent && victimEvent.type === 'lock.retried',
      '5: the retried append returned its event');

    const victimEvents = (await store.listTicketEvents(victim.ticket.id, { limit: 200 })).events
      .filter(event => event.runId === victim.run.id);
    const retried = victimEvents.filter(event => event.type === 'lock.retried');
    assert(retried.length === 1,
      `5: the retry appended the event exactly once — a rolled-back transaction cannot duplicate (${retried.length})`);
    assert(verifyCurrentRunEventChain(victimEvents).chainValid,
      '5: the chain still verifies after a retried append');
    // Proves the success above was a RETRY and not simply an absent conflict — the same
    // observable that makes scenario 2 meaningful, used in the opposite direction.
    assert(store.transientConflictRetries > conflictsBeforeVictim,
      `5: a real transaction conflict was absorbed, so this is recovery rather than luck ` +
      `(${store.transientConflictRetries - conflictsBeforeVictim} retries)`);

    assertScenariosExecuted({
      label: 'event append lock order',
      assertions: assert.count(),
      scenarios: scenariosRun,
      minAssertions: 21,
      minScenarios: 5
    });
    console.log(`\nPASS: event append lock order — ${scenariosRun} scenarios, ${assert.count()} assertions (PostgreSQL-native)`);
  }, { schemaSlug: 'lock_order' });
}

main().catch(error => {
  console.error(`\nFAIL: event append lock order — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
