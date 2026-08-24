#!/usr/bin/env node
'use strict';

// T2 Tranche 5 — rerun admission LOCK-ORDER falsification suite.
//
// Frozen protocol: allocation_plans -> runs (ORDER BY id) -> ticket_attempts
// -> tickets LAST. Every Run-row lock this transaction will ever request must
// be acquired BEFORE the Ticket FOR UPDATE, because run-evidence writers take
// runs -> tickets FOR KEY SHARE (events FK): a writer holding tickets FOR
// UPDATE while waiting on a run row forms a real 40P01 wait-for cycle
// (reproduced historically in scripts/t2-lock-protocol-postgres-test.js).
//
// THE REGRESSION THIS SUITE KILLS: rerunAdmitRuns composes
// createRunsAndStartTicket({ afterTerminalRunId }) inside its own transaction,
// AFTER taking tickets FOR UPDATE. If the terminal predecessor Run were first
// locked there, a stale/foreign predecessor would invert the protocol:
//
//   A (rerunAdmitRuns)   holds tickets FOR UPDATE -> waits predecessor run
//   B (evidence writer)  holds predecessor run   -> waits tickets KEY SHARE
//   -> 40P01
//
// The correction locks the predecessor inside the RUNS PHASE of
// rerunAdmitRuns itself, bound to THIS Ticket by identity, before any attempt
// or Ticket lock. Scenario 1 is a live interleaving against a real concurrent
// evidence-writer session holding the foreign predecessor: under the inverted
// order it deadlocks (suite fails); under the frozen order both writers
// complete boundedly and the stale input is refused cleanly.
//
// Requires TEST_DATABASE_URL pointing at an isolated synthetic database.

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 't2-tranche5-rerun-lock-order';
const CONCURRENCY_DEADLINE_MS = 45000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function boundedAll(label, operations) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${label}: concurrent writers did not complete within ${CONCURRENCY_DEADLINE_MS}ms`);
      error.code = 'CONCURRENCY_DEADLINE_EXCEEDED';
      reject(error);
    }, CONCURRENCY_DEADLINE_MS);
  });
  const work = Promise.all(operations);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
  }
}

async function main() {
  await withHarness('t2 tranche5 rerun lock order', async ({ store }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };

    const agent = (await store.createConfiguredAgent({
      value: { name: `${ACTOR} agent`, provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;

    const makeTicket = label => store.createTicket({
      objective: `${ACTOR} ${label}`,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent'
    });
    const draft = ticketId => ({
      ticketId, agentId: agent.id, status: 'pending', executionMode: 'agent'
    });
    const admitOne = async ticket => store.createRunsAndStartTicket({
      ticketId: ticket.id,
      runDrafts: [draft(ticket.id)],
      runEventPayload: () => ({ source: ACTOR })
    });
    const failRun = async run => {
      const fresh = await store.getRun(run.id);
      await store.transitionRun({
        runId: run.id,
        expectedRevision: fresh.revision,
        fromStatuses: ['pending'],
        toStatus: 'failed',
        patch: { error: 'fixture failure' },
        eventType: 'run.execution_failed',
        eventPayload: { status: 'failed' }
      });
      return store.getRun(run.id);
    };

    // ── Scenario 1: foreign predecessor vs live evidence writer ──────────
    // Ticket with TWO settled attempts. P belongs to the OLDER attempt;
    // the current attempt is the second one. Feeding P as afterTerminalRunId
    // is exactly the stale/foreign input that used to invert the protocol.
    console.log('foreign predecessor never inverts tickets-before-runs');
    let refusedCode = null;
    {
      const ticket = await makeTicket('two settled attempts');
      const first = await admitOne(ticket);
      await failRun(first.runs[0]);
      await store.transitionTicketAfterRun({ runId: first.runs[0].id }); // demotes to open
      const second = await admitOne(ticket);
      await failRun(second.runs[0]);
      await store.transitionTicketAfterRun({ runId: second.runs[0].id }); // demotes to open

      const currentAttempt = await store.getCurrentTicketAttempt(ticket.id);
      ok(currentAttempt && currentAttempt.id !== first.attempt.id,
        'fixture: the second attempt is current');
      const stalePredecessor = first.runs[0];
      ok(stalePredecessor.ticketAttemptId === first.attempt.id,
        'fixture: the stale predecessor belongs to the older attempt');
      ok((await store.getTicket(ticket.id)).status === 'open',
        'fixture: settled-failed Ticket demoted to open between attempts');

      // Session B simulates the canonical run-evidence writer shape: it holds
      // the STALE predecessor run row FOR UPDATE, then inserts an event whose
      // foreign key takes tickets FOR KEY SHARE.
      const clientB = await store.pool.connect();
      try {
        await clientB.query('BEGIN');
        await clientB.query(
          `SELECT * FROM ${store.table('runs')} WHERE id = $1 FOR UPDATE`,
          [stalePredecessor.id]);

        const rerunWork = store.rerunAdmitRuns({
          ticketId: ticket.id,
          runDrafts: [draft(ticket.id)],
          admissionIntent: 'retry_auto',
          afterTerminalRunId: stalePredecessor.id
        }).then(
          () => ({ kind: 'admitted' }),
          error => ({ kind: 'refused', error })
        );

        const evidenceWriterWork = (async () => {
          // Give the rerun transaction time to reach its predecessor-lock
          // request BEFORE the evidence writer asks for the ticket share lock.
          await sleep(250);
          await clientB.query(
            `INSERT INTO ${store.table('events')}
               (id, schema_version, ts, type, ticket_id, run_id, payload)
             VALUES (gen_random_uuid(), 1, clock_timestamp(), $2, $1, $3, $4::jsonb)`,
            [ticket.id, 'run.evidence_probe', stalePredecessor.id,
              JSON.stringify({ source: ACTOR })]);
          await sleep(150);
          await clientB.query('COMMIT');
          return { kind: 'committed' };
        })();

        const [rerun, writer] = await boundedAll(
          'stale predecessor || evidence writer', [rerunWork, evidenceWriterWork]);

        ok(writer.kind === 'committed',
          'the concurrent evidence writer committed without deadlock');
        ok(rerun.kind === 'refused',
          'the stale/foreign predecessor was REFUSED, not honored');
        if (rerun.kind === 'refused') {
          refusedCode = rerun.error.code || null;
          ok(!/40P01|deadlock/i.test(String(rerun.error.message)),
            `the refusal carried no deadlock trace (${rerun.error.message.slice(0, 120)})`);
        }
        ok(refusedCode === 'STATE_TRANSITION_CONFLICT' ||
           refusedCode === 'TICKET_ATTEMPT_PREDECESSOR_UNSETTLED',
          `the stale predecessor refused through predecessor identity/membership ` +
          `validation (${refusedCode})`);

        const probe = await store.pool.query(
          `SELECT COUNT(*)::int AS n FROM ${store.table('events')}
           WHERE type = 'run.evidence_probe' AND ticket_id = $1`,
          [ticket.id]);
        ok(probe.rows[0].n === 1, 'the evidence-writer event durably landed exactly once');

        const finalTicket = await store.getTicket(ticket.id);
        ok(finalTicket.status === 'open', 'the refused rerun left the truthful lifecycle');
        const attempts = await store.listTicketAttempts({ ticketId: ticket.id });
        ok(attempts.attempts.length === 2,
          'the refused rerun admitted NO new attempt (no partial state)');
        const runsNow = await store.pool.query(
          `SELECT COUNT(*)::int AS n FROM ${store.table('runs')} WHERE ticket_id = $1`,
          [ticket.id]);
        ok(runsNow.rows[0].n === 2, 'and created no new Run rows');
      } finally {
        await clientB.query('ROLLBACK').catch(() => {});
        clientB.release();
      }
    }

    // ── Scenario 2: cross-ticket predecessor refuses before any mutation ──
    console.log('cross-ticket predecessor refuses by identity');
    {
      const ticketA = await makeTicket('owner ticket');
      const other = await makeTicket('other ticket');
      const otherAttempt = await admitOne(other);
      const foreignRun = otherAttempt.runs[0];
      await failRun(foreignRun);

      let code = null;
      try {
        await store.rerunAdmitRuns({
          ticketId: ticketA.id,
          runDrafts: [draft(ticketA.id)],
          admissionIntent: 'retry_auto',
          afterTerminalRunId: foreignRun.id
        });
      } catch (error) {
        code = error.code || null;
      }
      ok(code === 'STATE_TRANSITION_CONFLICT',
        `a predecessor owned by another Ticket refuses on identity (${code})`);
      const attemptsA = await store.listTicketAttempts({ ticketId: ticketA.id });
      ok(attemptsA.attempts.length === 0,
        'the cross-ticket refusal mutated nothing on the owning ticket');
    }

    // ── Scenario 3: the LEGITIMATE auto-retry still works end-to-end ──────
    console.log('legitimate predecessor-in-current-attempt auto-retry');
    {
      const ticket = await makeTicket('legitimate auto retry');
      const attempt = await admitOne(ticket);

      // Complete the member through the real lease lifecycle, settle, and
      // land COMPLETED (settlement-only completion authority).
      const claimed = await store.claimPendingRun({
        leaseOwner: ACTOR, leaseDurationMs: 60000,
        eligibleRunIds: [attempt.runs[0].id]
      });
      ok(claimed && claimed.run && claimed.run.id === attempt.runs[0].id,
        'fixture claim acquired the lease');
      await store.startClaimedRun({
        runId: attempt.runs[0].id,
        leaseOwner: ACTOR,
        leaseDurationMs: 60000
      });
      let fresh = await store.getRun(attempt.runs[0].id);
      const completed = await store.transitionRun({
        runId: attempt.runs[0].id,
        expectedRevision: fresh.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: ACTOR,
        patch: { completedAt: new Date().toISOString() },
        eventType: 'run.completed',
        eventPayload: { status: 'completed' }
      });
      ok(completed.run.status === 'completed', 'fixture run terminalized completed');
      const settled = await store.transitionTicketAfterRun({ runId: attempt.runs[0].id });
      ok(settled.ticket.status === 'completed',
        'fixture: settled completion projects COMPLETED');
      ok(settled.attempt.disposition === 'completed', 'fixture: attempt disposition completed');

      // The production auto-retry composition (createRetryRun ->
      // rerunAdmitRuns with afterTerminalRunId IN the current attempt).
      const retried = await store.createRetryRun({
        ticketId: ticket.id,
        predecessorRunId: attempt.runs[0].id,
        runDraft: draft(ticket.id),
        runEventPayload: () => ({ source: ACTOR })
      });
      ok(Array.isArray(retried.runs) && retried.runs.length === 1,
        'the legitimate auto-retry admitted exactly one run');
      ok(retried.ticket.status === 'in_progress',
        'the retried Ticket went straight back to IN_PROGRESS (no OPEN waypoint)');
      ok((await store.getCurrentTicketAttempt(ticket.id)).disposition === null,
        'the new attempt is the unsettled current authority');
      const attemptsAfter = await store.listTicketAttempts({ ticketId: ticket.id });
      ok(attemptsAfter.attempts.length === 2, 'exactly one new attempt was admitted');

      const events = (await store.listTicketEvents(ticket.id, { limit: 200 })).events;
      const admittedEvent = [...events].reverse()
        .find(event => event.type === 'ticket.attempt_admitted');
      ok(Boolean(admittedEvent), 'the attempt-admission evidence is recorded');
      // The intent token and superseded authority live on the canonical
      // Ticket transition event (the one that carries previousStatus/status).
      const transitionEvent = [...events].reverse()
        .find(event => event.type === 'ticket.updated' &&
          event.payload && event.payload.admissionIntent !== undefined);
      ok(Boolean(transitionEvent) &&
          transitionEvent.payload.admissionIntent === 'retry_auto',
        'the admission transition records the retry_auto intent');
      ok(transitionEvent && transitionEvent.payload.supersededBlocker === null,
        'an unblocked retry supersedes nothing');
    }

    console.log(`\nPASS: T2 Tranche 5 rerun lock order — ${assertions} assertions`);
  }, { schemaSlug: 't2_tranche5_rerun_lock_order' });
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
