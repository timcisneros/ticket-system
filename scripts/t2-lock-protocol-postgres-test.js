#!/usr/bin/env node
'use strict';

// Tranche 1 deterministic concurrency suite for the Ticket-level lock protocol.
//
// CORRECTED GLOBAL LOCK ORDER (see persistence/postgres/store.js,
// transitionTicketAfterRun):
//
//   allocation_plans -> runs (members ORDER BY id) -> ticket_attempts -> tickets
//
// The Ticket FOR UPDATE is ALWAYS taken last among row locks. This is forced
// by the schema itself, not by taste: every run-evidence writer (claim, start,
// terminalization, evidence append) locks its run row first and then inserts
// an event whose foreign key (events.ticket_id REFERENCES tickets(id)) takes
// tickets FOR KEY SHARE. FOR KEY SHARE conflicts with FOR UPDATE, so any
// writer holding tickets FOR UPDATE while waiting for a run/attempt lock
// forms a genuine wait-for cycle with any concurrent run-evidence writer.
//
// The original Tranche 1 handoff froze the opposite direction
// (Ticket -> attempt -> Runs) and its falsification produced a real
// PostgreSQL 40P01:
//
//   Process A (settlement)  SELECT * FROM runs WHERE ticket_attempt_id = $1
//                          ORDER BY id FOR UPDATE
//     holds tickets FOR UPDATE + ticket_attempts FOR UPDATE + first member
//     run FOR UPDATE; waits for the second member run tuple.
//   Process B (run evidence) INSERT INTO events (... ticket_id ...)
//     holds the second member run FOR UPDATE (claim/start/terminalization);
//     waits for tickets FOR KEY SHARE (events FK), blocked by A.
//
// FOUND BY FALSIFICATION -> DIAGNOSED -> FIXED (Ticket lock moved last) ->
// ORIGINAL CONCURRENT CASE NOW PASSES. The failure history is retained here
// deliberately; do not weaken these cases back into sequential execution.
//
// Required concurrency coverage (each must complete boundedly, without 40P01
// or hang, and must land in the source-authoritative final state):
//
//   A. settlement(R1) || settlement(R2), same two-member attempt, both Runs
//      durably terminal BEFORE the two concurrent transitionTicketAfterRun
//      calls (isolates the settlement protocol itself).
//   B. the same scenario with both routing directions independently biased
//      (lower-id routed starts first; higher-id routed starts first).
//   C. settlement || reopenTicket (both live writers).
//   D. settlement || predecessor-based attempt admission
//      (createRunsAndStartTicket with afterTerminalRunId).
//   E. settlement || the REAL structured-allocation leaf admission path
//      (admitStructuredAllocationLeafRuns), plus the concurrent duplicate
//      first-admission pair.
//   F. stale-attempt routing under a genuinely concurrent newer admission
//      through the real createRetryRun composition.
//   plus the ORIGINAL concurrent falsification: two full pipelines
//      (claim -> start -> terminalize -> settle) for both members of the
//      same attempt executed concurrently — the exact shape that produced
//      40P01 before the correction.
//
// A 40P01 in ANY case is a FAILURE of this suite. There is no retry, no
// status widening, and no serialization of the concurrent writers.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { withHarness } = require('./postgres-test-harness');

const ACTOR = 't2-lock-protocol-postgres-test';
const STAMP = `${Date.now()}-${process.pid}`;
const CONCURRENCY_DEADLINE_MS = 45000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Bounded concurrency: resolve with the settled outcomes, or fail the suite if
// the racing writers do not complete within the deadline. Rejections are NOT
// swallowed — they propagate and fail the suite (40P01 included).
async function boundedAll(label, operations) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}: concurrent writers did not complete within ${CONCURRENCY_DEADLINE_MS}ms`);
      error.code = 'CONCURRENCY_DEADLINE_EXCEEDED';
      reject(error);
    }, CONCURRENCY_DEADLINE_MS);
  });
  const work = Promise.all(operations);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    // If the deadline fired, keep the late rejection from becoming an
    // unhandled one; the suite has already failed on the timeout.
    work.catch(() => {});
  }
}

async function main() {
  await withHarness('t2 lock protocol', async ({ store }) => {
    let assertions = 0;
    const ok = (condition, message) => {
      assert.ok(condition, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };
    const equal = (actual, expected, message) => {
      assert.deepEqual(actual, expected, message);
      assertions += 1;
      console.log(`  ok ${message}`);
    };

    const agent = (await store.createConfiguredAgent({
      value: { name: 'T2 Lock Protocol Agent', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;
    const peerAgent = (await store.createConfiguredAgent({
      value: { name: 'T2 Lock Protocol Peer', provider: 'openai', model: 'fixture', apiKey: '' },
      changedBy: ACTOR
    })).agent;

    const makeTicket = objective => store.createTicket({
      objective,
      status: 'open',
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual',
      executionMode: 'agent'
    });
    const draft = (ticketId, agentId) => ({
      ticketId,
      agentId,
      status: 'pending',
      executionMode: 'agent'
    });
    const admitTwoMemberAttempt = async objective => {
      const ticket = await makeTicket(objective);
      const attempt = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [draft(ticket.id, agent.id), draft(ticket.id, peerAgent.id)],
        runEventPayload: () => ({ source: ACTOR })
      });
      assert.equal(attempt.attempt.memberCount, 2, 'two-member attempt fixture');
      assert.ok(attempt.runs[0].id < attempt.runs[1].id, 'fixture runs have deterministic id order');
      return { ticket, attempt };
    };

    // Terminalize one Run through the real lease lifecycle. This is FIXTURE
    // PREPARATION for the isolated settlement races: it is sequential by
    // design and runs to COMMIT before the concurrent writers launch.
    async function terminalize(runId, toStatus, leaseOwner) {
      // A concurrent settlement transaction legitimately locks EVERY member
      // of the attempt, and claimPendingRun admits with
      // FOR UPDATE ... SKIP LOCKED — so a claim racing that settlement is
      // legitimately refused and the Run stays pending: exactly the
      // production admission-pressure outcome the scheduler re-polls. Retry
      // the claim boundedly, mirroring that re-poll. This tolerates only the
      // documented SKIP LOCKED refusal; a 40P01, a deadline or any other
      // failure still fails the suite.
      let claim = null;
      for (let claimAttempt = 0; claim === null && claimAttempt < 80; claimAttempt += 1) {
        claim = await store.claimPendingRun({
          runId,
          leaseOwner,
          leaseDurationMs: 60000,
          eligibleRunIds: [runId]
        });
        if (claim === null) await sleep(25);
      }
      assert.ok(claim && claim.run && claim.run.id === runId,
        `run ${runId} could not be claimed for terminalization`);
      const started = await store.startClaimedRun({
        runId,
        leaseOwner,
        leaseDurationMs: 60000
      });
      assert.ok(started && started.run,
        `run ${runId} could not be started after claiming`);
      return (await store.transitionRun({
        runId,
        expectedRevision: started.run.revision,
        fromStatuses: ['running'],
        toStatus,
        leaseOwner,
        allowExpiredLease: true,
        eventType: `run.${toStatus}`,
        eventPayload: { source: ACTOR, runId }
      })).run;
    }

    // ── ORIGINAL FALSIFICATION (restored): concurrent full pipelines ──────
    // Both members of the same two-member attempt are claimed, started,
    // terminalized and settled CONCURRENTLY through different member ids.
    // This is the exact shape that produced 40P01 before the Ticket lock was
    // moved last; claim/start/terminalization transactions race settlement
    // transactions here. No part of it may be sequentialized.
    {
      const { ticket, attempt } = await admitTwoMemberAttempt('original falsification: concurrent pipelines');
      const [r1, r2] = attempt.runs;
      const pipelines = await boundedAll('concurrent full pipelines', [
        (async () => {
          await terminalize(r1.id, 'completed', `${ACTOR}-a`);
          return store.transitionTicketAfterRun({ runId: r1.id });
        })(),
        (async () => {
          await terminalize(r2.id, 'completed', `${ACTOR}-b`);
          return store.transitionTicketAfterRun({ runId: r2.id });
        })()
      ]);
      const settledCount = pipelines.filter(result => result.changed).length;
      equal(settledCount, 1, 'concurrent pipelines: exactly one settlement changed the Ticket');
      const finalTicket = await store.getTicket(ticket.id);
      equal(finalTicket.status, 'completed',
        'concurrent pipelines settle the two-member attempt to completed');
      const finalAttempt = await store.getCurrentTicketAttempt(ticket.id);
      equal(finalAttempt.disposition, 'completed',
        'concurrent pipelines settle the attempt disposition exactly once');
    }

    // ── A/B: isolated concurrent settlement, both routing directions ──────
    // Both members are durably terminal BEFORE the two settlements launch,
    // isolating the settlement protocol itself (no claim/start/terminalize
    // transaction overlaps). Both routing directions are exercised: the
    // lower-id member routed first, then the higher-id member routed first.
    for (const { label, first, second } of [
      { label: 'lower-id routed settlement first', first: 0, second: 1 },
      { label: 'higher-id routed settlement first', first: 1, second: 0 }
    ]) {
      const { ticket, attempt } = await admitTwoMemberAttempt(`isolated settlement: ${label}`);
      const runs = [attempt.runs[0], attempt.runs[1]];
      await terminalize(runs[0].id, 'completed', `${ACTOR}-prep-a`);
      await terminalize(runs[1].id, 'completed', `${ACTOR}-prep-b`);
      const before = await store.getTicket(ticket.id);
      equal(before.status, 'in_progress',
        `${label}: both members terminal, attempt not yet settled`);
      const settlements = await boundedAll(`isolated settlement (${label})`, [
        store.transitionTicketAfterRun({ runId: runs[first].id }),
        store.transitionTicketAfterRun({ runId: runs[second].id })
      ]);
      const changed = settlements.filter(result => result.changed).length;
      equal(changed, 1, `${label}: exactly one concurrent settlement changed the Ticket`);
      const finalTicket = await store.getTicket(ticket.id);
      equal(finalTicket.status, 'completed', `${label}: settled Ticket status is completed`);
      const finalAttempt = await store.getCurrentTicketAttempt(ticket.id);
      equal(finalAttempt.disposition, 'completed', `${label}: attempt disposition is completed`);
      equal(finalAttempt.settledAt !== null, true, `${label}: attempt carries settlement authority`);
    }

    // ── C: settlement || reopenTicket (both live writers) ─────────────────
    // One member, terminally completed, attempt still unsettled. The race has
    // exactly two source-authoritative interleavings, each paired with its
    // exclusive observable cause:
    //   (a) reopen locks the unsettled attempt first -> refuses
    //       TICKET_ATTEMPT_UNSETTLED; settlement then completes the Ticket.
    //   (b) settlement settles first -> reopen proceeds and reopens.
    {
      const ticket = await makeTicket('settlement vs reopenTicket');
      const attempt = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [draft(ticket.id, agent.id)],
        runEventPayload: () => ({ source: ACTOR })
      });
      await terminalize(attempt.runs[0].id, 'completed', `${ACTOR}-c`);
      let reopenRefused = false;
      const outcomes = await boundedAll('settlement vs reopenTicket', [
        store.transitionTicketAfterRun({ runId: attempt.runs[0].id }),
        store.reopenTicket({ ticketId: ticket.id, rerunMode: 'rerun' }).catch(error => {
          if (error && error.code === 'TICKET_ATTEMPT_UNSETTLED') {
            reopenRefused = true;
            return null;
          }
          throw error;
        })
      ]);
      ok(outcomes.length === 2, 'settlement vs reopenTicket: both writers completed boundedly');
      const finalTicket = await store.getTicket(ticket.id);
      const finalAttempt = await store.getCurrentTicketAttempt(ticket.id);
      equal(finalAttempt.disposition, 'completed',
        'settlement vs reopenTicket: attempt settled completed in every interleaving');
      if (reopenRefused) {
        equal(finalTicket.status, 'completed',
          'reopen refusal pairs with the settlement completing the Ticket');
      } else {
        equal(finalTicket.status, 'open',
          'reopen success pairs with the Ticket reopened after settlement');
      }
    }

    // ── D: settlement || predecessor-based attempt admission ──────────────
    // A terminal-interrupted attempt leaves the Ticket 'open' with settled
    // authority, which is exactly the state predecessor-based admission
    // requires. The stale settlement and the admission are both live writers
    // and both take the predecessor Run lock first. Every interleaving lands
    // in the same source-authoritative final state:
    //   - settlement wins the Ticket first: its recomputed target status for
    //     an interrupted attempt is 'open', the Ticket is already 'open', so
    //     it is a no-op; admission then creates attempt 2.
    //   - admission wins first: attempt 2 becomes current and the stale
    //     settlement stale-routes to a no-op.
    {
      const ticket = await makeTicket('settlement vs predecessor admission');
      const attempt = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [draft(ticket.id, agent.id)],
        runEventPayload: () => ({ source: ACTOR })
      });
      await terminalize(attempt.runs[0].id, 'interrupted', `${ACTOR}-d`);
      const settled = await store.transitionTicketAfterRun({ runId: attempt.runs[0].id });
      equal(settled.changed, true, 'interrupted singleton attempt settles');
      equal((await store.getTicket(ticket.id)).status, 'open',
        'interrupted attempt projects the Ticket back to open');
      const outcomes = await boundedAll('settlement vs predecessor admission', [
        store.transitionTicketAfterRun({ runId: attempt.runs[0].id }),
        store.createRunsAndStartTicket({
          ticketId: ticket.id,
          runDrafts: [draft(ticket.id, agent.id)],
          afterTerminalRunId: attempt.runs[0].id,
          runEventPayload: () => ({ source: ACTOR, attempt: 2 }),
          ticketEventPayload: { source: ACTOR, attempt: 2 }
        })
      ]);
      equal(outcomes[0].changed, false,
        'stale settlement is a no-op in every interleaving');
      const finalTicket = await store.getTicket(ticket.id);
      const finalAttempt = await store.getCurrentTicketAttempt(ticket.id);
      equal(finalTicket.status, 'in_progress', 'predecessor admission starts the retry attempt');
      equal(finalAttempt.ordinal, 2, 'the newer attempt is ordinal 2');
      equal(finalAttempt.disposition, null, 'the newer attempt is unsettled');
      equal(finalAttempt.memberCount, 1, 'the retry attempt has exactly one member');
    }

    // ── E: settlement || the REAL structured-allocation leaf admission ────
    // admitStructuredAllocationLeafRuns takes allocation_plans -> runs ->
    // tickets; settlement takes allocation_plans -> members -> attempt ->
    // tickets. The two genuinely contend on the same rows of one v2 Ticket
    // when a duplicate leaf admission (the real production re-delivery path,
    // which re-reports the committed leaf set) races settlement. First the
    // concurrent duplicate FIRST admission pair proves exactly-once under
    // contention.
    {
      const group = (await store.createGroup({
        value: { name: `T2 Lock Structured ${STAMP}`, permissions: [], canReceiveTickets: true },
        changedBy: ACTOR
      })).group;
      const planner = (await store.createConfiguredAgent({
        value: { name: `T2 Lock Planner ${STAMP}`, provider: 'openai', model: 'fixture-planner', apiKey: '' },
        groupIds: [group.id],
        changedBy: ACTOR
      })).agent;
      const worker = (await store.createConfiguredAgent({
        value: { name: `T2 Lock Worker ${STAMP}`, provider: 'openai', model: 'fixture-worker', apiKey: '' },
        groupIds: [group.id],
        changedBy: ACTOR
      })).agent;
      const designated = (await store.updateGroup({
        groupId: group.id,
        expectedRevision: group.revision,
        value: { ...group, plannerAgentId: planner.id },
        changedBy: ACTOR
      })).group;
      const ownedOutputPaths = {
        [planner.id]: 'reports/planner/',
        [worker.id]: 'reports/worker/'
      };
      const agentById = new Map([[planner.id, planner], [worker.id, worker]]);

      const admitPlan = async objective => {
        const catalog = await store.getConfiguredAgentsByIds({ agentIds: [planner.id, worker.id] });
        const authorityDraft = buildStructuredAllocationAuthorityDraft({
          declaredWork: declaredWork(objective),
          ticketObjective: objective,
          assignmentTargetType: 'group',
          assignmentMode: 'allocated',
          assignmentGroup: designated,
          plannerAgent: catalog.find(candidate => candidate.id === planner.id),
          candidateAgents: catalog,
          ownedOutputPaths
        });
        const created = await store.createTicketWithEvent({
          ticket: structuredTicketBody(designated, objective, ownedOutputPaths),
          structuredAllocationAuthorityDraft: authorityDraft,
          eventPayload: { source: ACTOR }
        });
        const ticket = created.ticket;
        const planning = ticket.structuredAllocationAuthority.planningAuthoritySnapshot;
        const responseText = JSON.stringify(proposalFor(planning.candidates));
        const proposal = normalizePlannerProposal(JSON.parse(responseText));
        const planDraft = lowerPlannerProposalToAllocationPlanDraft({
          ticketId: ticket.id,
          authority: ticket.structuredAllocationAuthority,
          proposal
        });
        const attempt = await validatedPlanningAttempt(store, ticket, responseText, proposal);
        const admission = await store.admitStructuredAllocationPlan({
          ticketId: ticket.id,
          attempt,
          allocationPlanDraft: planDraft,
          plannerCredentialsAvailable: true,
          eventPayload: { source: ACTOR }
        });
        assert.equal(admission.admitted, true, 'v2 plan admission fixture');
        return { ticket: await store.getTicket(ticket.id), plan: admission.plan };
      };
      const leafDraftsFor = (ticket, plan) => plan.items.map(item => ({
        allocationItemId: item.allocationItemId,
        run: leafRunDraft(ticket, plan, item, agentById.get(item.assignedAgentId))
      }));

      // E1: two concurrent FIRST leaf admissions — exactly one admits.
      const firstRace = await admitPlan('T2 lock: concurrent first leaf admission');
      const firstAdmissions = await boundedAll('concurrent first leaf admissions', [
        store.admitStructuredAllocationLeafRuns({
          ticketId: firstRace.ticket.id,
          allocationPlanId: firstRace.plan.id,
          governedLeafCapture: {
            policySource: LEAF_WORKER_POLICY.source,
            progressControlPolicy: LEAF_PROGRESS_POLICY
          },
          leafDrafts: leafDraftsFor(firstRace.ticket, firstRace.plan),
          eventPayload: { source: ACTOR }
        }),
        store.admitStructuredAllocationLeafRuns({
          ticketId: firstRace.ticket.id,
          allocationPlanId: firstRace.plan.id,
          governedLeafCapture: {
            policySource: LEAF_WORKER_POLICY.source,
            progressControlPolicy: LEAF_PROGRESS_POLICY
          },
          leafDrafts: leafDraftsFor(firstRace.ticket, firstRace.plan),
          eventPayload: { source: ACTOR }
        })
      ]);
      equal(firstAdmissions.filter(admission => admission.admitted).length, 1,
        'exactly one concurrent first leaf admission admits');

      // E2: settlement || duplicate leaf admission on a settled-leaf v2 ticket.
      // The pair has exactly TWO source-legitimate interleavings, each paired
      // below with its exclusive observable cause:
      //   (a) the duplicate admission reads the plan while still `pending`
      //       (settlement not yet committed) -> it re-reports the committed
      //       leaf set: admitted=false, no refusal;
      //   (b) settlement commits first -> its reconciliation materializes the
      //       interrupted aggregate and moves the plan off `pending` -> the
      //       duplicate admission refuses plan_not_pending (the second
      //       mechanical no-extension layer of the canonical authority).
      // The refusal happens AFTER the admission has taken its plan/runs/ticket
      // locks, so the lock-order falsification value is identical in both
      // interleavings. Both branches must leave the same durable state, which
      // the invariant assertions below prove.
      const settleRace = await admitPlan('T2 lock: settlement vs leaf admission');
      const settleAdmission = await store.admitStructuredAllocationLeafRuns({
        ticketId: settleRace.ticket.id,
        allocationPlanId: settleRace.plan.id,
        governedLeafCapture: {
          policySource: LEAF_WORKER_POLICY.source,
          progressControlPolicy: LEAF_PROGRESS_POLICY
        },
        leafDrafts: leafDraftsFor(settleRace.ticket, settleRace.plan),
        eventPayload: { source: ACTOR }
      });
      assert.equal(settleAdmission.admitted, true, 'leaf admission fixture');
      for (const leafRun of settleAdmission.runs) {
        await terminalize(leafRun.id, 'interrupted', `${ACTOR}-e`);
      }
      let admissionSawSettledPlan = false;
      const raceOutcome = await boundedAll('settlement vs leaf admission', [
        store.transitionTicketAfterRun({ runId: settleAdmission.runs[0].id }),
        store.admitStructuredAllocationLeafRuns({
          ticketId: settleRace.ticket.id,
          allocationPlanId: settleRace.plan.id,
          governedLeafCapture: {
            policySource: LEAF_WORKER_POLICY.source,
            progressControlPolicy: LEAF_PROGRESS_POLICY
          },
          leafDrafts: leafDraftsFor(settleRace.ticket, settleRace.plan),
          eventPayload: { source: ACTOR }
        }).catch(error => {
          // Outcome classification, not error masking: plan_not_pending is the
          // source-legitimate refusal this race produces when settlement
          // commits first. Any other failure still fails the suite.
          if (error && error.code === 'STRUCTURED_ALLOCATION_LEAF_ADMISSION_REFUSED' &&
              error.reason === 'plan_not_pending') {
            admissionSawSettledPlan = true;
            return { admitted: false, refusedPlanNotPending: true };
          }
          throw error;
        })
      ]);
      equal(raceOutcome[0].changed, true, 'v2 settlement settles the interrupted leaf attempt');
      equal(raceOutcome[1].admitted, false,
        'duplicate leaf admission never extends the committed leaf set');
      if (admissionSawSettledPlan) {
        equal(raceOutcome[1].refusedPlanNotPending, true,
          'plan_not_pending refusal pairs with settlement having committed first');
      } else {
        equal(raceOutcome[1].refusedPlanNotPending, undefined,
          'the re-report outcome pairs with the plan still pending at admission time');
      }
      const finalTicket = await store.getTicket(settleRace.ticket.id);
      equal(finalTicket.status, 'open',
        'interrupted v2 attempt projects the Ticket back to open in both interleavings');
      const finalAttempt = await store.getCurrentTicketAttempt(settleRace.ticket.id);
      equal(finalAttempt.disposition, 'interrupted', 'v2 attempt disposition is interrupted');
      const finalRuns = (await store.listRunsForTicket({
        ticketId: settleRace.ticket.id, limit: 20
      })).runs;
      equal(finalRuns.length, settleAdmission.runs.length,
        'the race admitted no additional Run in either interleaving');
      const finalPlan = await store.getAllocationPlan(settleRace.plan.id);
      equal(finalPlan.aggregateDecision.aggregateStatus, 'interrupted',
        'settlement materialized the interrupted aggregate in either interleaving');
    }

    // ── F: stale-attempt routing under a concurrent newer admission ───────
    // The REAL createRetryRun composition (reopen + predecessor admission in
    // one transaction) races a stale settlement of the older attempt's Run.
    // Both lock the predecessor Run first, so the pair fully serializes; every
    // interleaving leaves the newer attempt authoritative and the stale
    // settlement a no-op.
    {
      const ticket = await makeTicket('stale routing under concurrent retry admission');
      const attempt = await store.createRunsAndStartTicket({
        ticketId: ticket.id,
        runDrafts: [draft(ticket.id, agent.id)],
        runEventPayload: () => ({ source: ACTOR })
      });
      await terminalize(attempt.runs[0].id, 'interrupted', `${ACTOR}-f`);
      const firstSettlement = await store.transitionTicketAfterRun({ runId: attempt.runs[0].id });
      equal(firstSettlement.changed, true, 'first attempt settles interrupted');
      const outcomes = await boundedAll('stale settlement vs createRetryRun', [
        store.transitionTicketAfterRun({ runId: attempt.runs[0].id }),
        store.createRetryRun({
          ticketId: ticket.id,
          predecessorRunId: attempt.runs[0].id,
          runDraft: draft(ticket.id, agent.id),
          runEventPayload: () => ({ source: ACTOR, attempt: 2 })
        })
      ]);
      equal(outcomes[0].changed, false,
        'stale settlement under newer admission is a no-op');
      ok(outcomes[1] !== null && outcomes[1].runs.length === 1,
        'concurrent retry admission created exactly one retry Run');
      const finalTicket = await store.getTicket(ticket.id);
      const finalAttempt = await store.getCurrentTicketAttempt(ticket.id);
      equal(finalTicket.status, 'in_progress', 'Ticket reflects the newer attempt');
      equal(finalAttempt.ordinal, 2, 'the newer attempt is ordinal 2');
      equal(finalAttempt.disposition, null, 'the newer attempt is unsettled');
    }

    console.log(`  ${assertions} assertions passed`);
  });
}

// ── structured-allocation fixture helpers ───────────────────────────────────
// Reuses the production builders and the battle-tested fixture shape from
// scripts/structured-allocation-leaf-run-postgres-test.js. No hand-built
// authority: the plan, provenance, bindings and admission all flow through
// the canonical contracts.

const {
  buildStructuredAllocationAuthorityDraft
} = require('../runtime/structured-allocation-prerequisites-contract');
const {
  advancePlanningAttempt,
  createPlanningAttempt,
  buildPlannerRequestContext,
  buildPlannerRequestMessages,
  lowerPlannerProposalToAllocationPlanDraft,
  normalizePlannerProposal,
  plannerRequestHash
} = require('../runtime/structured-allocation-planning-contract');
const {
  buildLeafDeclaredWorkSnapshot
} = require('../runtime/structured-allocation-leaf-run-contract');
const {
  buildCompletionAuthoritySnapshot
} = require('../runtime/completion-decision-contract');
const {
  governedAttemptState,
  zeroPricePlannerPolicySource,
  zeroPriceWorkerPolicySource,
  progressControlPolicy
} = require('./governed-structured-fixture');

const LEAF_PROGRESS_POLICY = progressControlPolicy();
const LEAF_PLANNER_POLICY = zeroPricePlannerPolicySource();
const LEAF_WORKER_POLICY = zeroPriceWorkerPolicySource();

function declaredWork(objective) {
  const postcondition = { id: 'parent-report', type: 'fileExists', path: 'reports/report.md' };
  return {
    objective,
    expectedOutputs: [{ kind: 'text', declaration: 'One review report per assigned folder' }],
    successCriteria: [
      { kind: 'text', declaration: 'Every report records concrete findings' }
    ],
    evidenceRequirements: []
  };
}

function structuredTicketBody(group, objective, ownedOutputPaths, status = 'open') {
  const now = new Date().toISOString();
  return {
    objective,
    acceptanceCriteria: 'Review the explicit reports.',
    assignmentTargetType: 'group',
    assignmentTargetId: group.id,
    assignmentMode: 'allocated',
    ownedOutputPaths,
    targetRef: null,
    executionMode: 'agent',
    workflowId: null,
    workflowInput: null,
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    capabilityInput: null,
    executionPolicy: {
      mode: 'assisted', requireVerification: 'when_declared', autoRetry: false,
      maxAttempts: null, maxRuntimeMs: null, maxModelRequests: null,
      maxWorkspaceOperations: null, allowWorkspaceWrites: true,
      allowParallelRuns: false, allowChildTickets: false, workspaceScope: 'owned_paths'
    },
    status,
    blockedReason: null,
    createdBy: ACTOR,
    changedBy: ACTOR,
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
}

function proposalFor(candidates) {
  return {
    version: 1,
    sharedConstraints: [{ kind: 'text', declaration: 'Stay inside your own folder' }],
    items: candidates.map(candidate => ({
      assignedAgentId: candidate.agentId,
      objective: `Review ${candidate.ownedOutputPaths[0]} and record concrete findings`,
      expectedOutputs: [{
        kind: 'text',
        declaration: `Findings report for ${candidate.ownedOutputPaths[0]}`
      }],
      successCriteria: [
        { kind: 'text', declaration: 'Report names at least one finding' }
      ],
      evidenceRequirements: []
    }))
  };
}

async function validatedPlanningAttempt(store, ticket, responseText, proposal) {
  const authority = ticket.structuredAllocationAuthority;
  const planning = authority.planningAuthoritySnapshot;
  const context = buildPlannerRequestContext(authority, { ticketId: ticket.id });
  const messages = buildPlannerRequestMessages(context);
  const requestHash = plannerRequestHash({
    provider: planning.planner.provider,
    model: planning.planner.model,
    messages
  });
  const responseHash = crypto.createHash('sha256').update(responseText).digest('hex');
  let attempt = createPlanningAttempt({
    attemptId: crypto.randomUUID(),
    ticketId: ticket.id,
    authority,
    createdAt: new Date().toISOString()
  });
  const write = async (patch, eventType) => {
    attempt = (await store.writeStructuredAllocationPlanningAttempt({
      ticketId: ticket.id,
      attempt: advancePlanningAttempt(attempt, patch),
      expectedAttemptStateHash: attempt.attemptStateHash,
      eventType
    })).attempt;
  };
  attempt = (await store.writeStructuredAllocationPlanningAttempt({
    ticketId: ticket.id,
    attempt,
    expectedAttemptStateHash: null,
    eventType: 'ticket.structured_planning_started'
  })).attempt;
  const { governedExecution: leafPlannerGoverned } = await governedAttemptState(store, {
    ticketId: ticket.id,
    attemptId: attempt.attemptId,
    plannerAgentId: planning.planner.agentId,
    policy: LEAF_PLANNER_POLICY
  });
  await write({
    state: 'request_started',
    governedExecution: leafPlannerGoverned,
    requestHash,
    requestMetadata: {
      contextVersion: context.version,
      contextHash: context.contextHash,
      messageCount: messages.length,
      requestBytes: messages.reduce((total, message) => total + message.content.length, 0),
      timeoutMs: 120_000,
      maxResponseBytes: 262_144
    },
    requestStartedAt: new Date().toISOString()
  }, 'ticket.structured_planning_requested');
  await write({
    state: 'response_received',
    responseStatus: 'received',
    responseText,
    responseBytes: responseText.length,
    responseTruncated: false,
    responseHash
  }, 'ticket.structured_planning_responded');
  await write({
    state: 'proposal_validated',
    parseStatus: 'ok',
    validationStatus: 'ok',
    proposalHash: proposal.proposalHash
  }, 'ticket.structured_planning_validated');
  return attempt;
}

function leafRunDraft(ticket, plan, item, agent) {
  const completionAuthoritySnapshot = buildCompletionAuthoritySnapshot({
    objective: `Create folder ${item.ownedOutputPaths[0].replace(/\/$/, '')}`,
    kind: 'deterministic',
    recognized: true,
    intent: 'create_folder',
    completionPolicy: 'declared_postconditions',
    directPostconditions: [{
      type: 'folder_exists',
      path: item.ownedOutputPaths[0].replace(/\/$/, '')
    }],
    verificationPolicy: 'when_declared',
    capturedAt: new Date().toISOString()
  });
  return {
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    targetRef: null,
    workspaceRoot: '/tmp',
    mainWorkspaceRoot: '/tmp',
    executionWorkspaceType: 'main_owned_paths',
    executionPolicySnapshot: ticket.executionPolicy,
    completionAuthoritySnapshot,
    declaredWorkSnapshot: buildLeafDeclaredWorkSnapshot(item, {
      sharedConstraints: plan.sharedConstraints,
      completionAuthoritySnapshot
    }),
    acceptanceCriteriaSnapshot: null,
    allocationPlanId: plan.id,
    allocationItemId: item.allocationItemId,
    allocationSubtask: null,
    ownedOutputPaths: [...item.ownedOutputPaths],
    executionMode: 'agent',
    capabilityType: 'directAction',
    capabilityId: 'agent-selected-actions',
    currentPhase: 'planning',
    status: 'pending'
  };
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
