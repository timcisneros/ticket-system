#!/usr/bin/env node
'use strict';

// FALSIFICATION REPRODUCTION (diagnostic evidence capture, NOT a pass/fail
// suite — the pass/fail owner is scripts/t2-lock-protocol-postgres-test.js).
//
// Restores the original Tranche 1 concurrency falsification that was weakened
// into sequential settlement: two members of the SAME Ticket attempt,
// both settled through the full production pipeline
// (claimPendingRun -> startClaimedRun -> transitionRun(completed)
//  -> transitionTicketAfterRun) CONCURRENTLY through different member ids.
//
// This script loops the race with staggered starts until PostgreSQL reports
// 40P01 (or a bound is reached), then prints the COMPLETE deadlock detail
// from the server error fields (process identities, waited-for locks,
// held locks, and the statement each process was executing).
//
// Exit code: 1 when a 40P01 is captured (the lock-protocol defect is
// present — this script can never be used to claim green-by-retry), 0 when
// the bound is reached without a deadlock (absence of evidence only; the
// suite above is the actual concurrency proof).

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 't2-deadlock-repro';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function printDeadlockDetail(error, iteration) {
  console.log('=== 40P01 DEADLOCK CAPTURED ===');
  console.log(`iteration: ${iteration}`);
  console.log(`code:    ${error.code}`);
  console.log(`message: ${error.message}`);
  console.log('--- detail (PostgreSQL deadlock graph) ---');
  console.log(error.detail || '(no detail)');
  console.log('--- detail2 ---');
  console.log(error.detail2 || '(none)');
  console.log('--- hint ---');
  console.log(error.hint || '(no hint)');
  console.log('--- where (statement each process was executing) ---');
  console.log(error.where || '(no where)');
  console.log('--- schema ---');
  console.log(error.schema || '(none)');
  console.log(`--- table: ${error.table || '(none)'} constraint: ${error.constraint || '(none)'}`);
}

async function main() {
  await withHarness('t2 deadlock repro', async ({ store }) => {
    const agent = (await store.createConfiguredAgent({
      value: { name: 'Repro Agent A', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const peerAgent = (await store.createConfiguredAgent({
      value: { name: 'Repro Agent B', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;

    async function settleAsCompleted(run, agentId, leaseOwner) {
      const claim = await store.claimPendingRun({
        runId: run.id,
        leaseOwner,
        leaseDurationMs: 60000,
        eligibleRunIds: [run.id]
      });
      await store.startClaimedRun({
        runId: run.id,
        leaseOwner,
        leaseDurationMs: 60000
      });
      await store.transitionRun({
        runId: run.id,
        expectedRevision: claim.run.revision + 1,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner,
        allowExpiredLease: true,
        eventType: 'run.completed',
        eventPayload: { source: ACTOR, runId: run.id }
      });
      await store.transitionTicketAfterRun({ runId: run.id });
    }

    const MAX_ITERATIONS = 60;
    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      const ticket = await store.createTicket({
        objective: `deadlock repro ${iteration}`,
        status: 'open',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual',
        executionMode: 'agent'
      });
      const attempt = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [
          { ticketId: ticket.id, agentId: agent.id, status: 'pending', executionMode: 'agent' },
          { ticketId: ticket.id, agentId: peerAgent.id, status: 'pending', executionMode: 'agent' }
        ],
        runEventPayload: () => ({ source: ACTOR })
      });
      const [r1, r2] = attempt.runs;
      const stagger = (iteration % 10) * 3;
      let deadlock = null;
      const results = await Promise.allSettled([
        (async () => { await sleep(stagger); return settleAsCompleted(r1, agent.id, `${ACTOR}-a`); })(),
        (async () => { await sleep(stagger); return settleAsCompleted(r2, peerAgent.id, `${ACTOR}-b`); })()
      ]);
      for (const outcome of results) {
        let e = outcome.status === 'rejected' ? outcome.reason : null;
        // Unwrap aggregate causes if any
        while (e && e.code !== '40P01' && e.errors && e.errors.length) e = e.errors[0];
        if (e && (e.code === '40P01' || /deadlock/i.test(String(e.message)))) {
          deadlock = e;
          break;
        }
        if (outcome.status === 'rejected') {
          // Surface non-deadlock failures too: they are evidence.
          console.log(`iteration ${iteration}: non-deadlock failure:`);
          console.log(outcome.reason && outcome.reason.stack
            ? outcome.reason.stack
            : String(outcome.reason));
        }
      }
      if (deadlock) {
        printDeadlockDetail(deadlock, iteration);
        process.exitCode = 1;
        return;
      }
      const finalTicket = await store.getTicket(ticket.id);
      console.log(`iteration ${iteration}: no deadlock (ticket=${finalTicket.status})`);
    }
    console.log(`NO DEADLOCK REPRODUCED in ${MAX_ITERATIONS} iterations`);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
