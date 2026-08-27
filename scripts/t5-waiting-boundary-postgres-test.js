#!/usr/bin/env node
'use strict';

// T5 waiting/time/fairness/backpressure — cross-boundary semantic owner.
//
// The T5 semantic freeze (docs/ARCHITECTURAL_DECISIONS_PENDING.md) defines the
// boundaries for temporary Run deferral and related capacity conditions. The
// runtime-budget suites own the capacity MACHINERY; this suite owns only the
// load-bearing T5 CROSS-BOUNDARY truths that require real PostgreSQL:
//
//   A. attempt-member deferral — a pending Run is already an admitted member of
//      its existing T2 attempt; pre-lease dispatch deferral creates no new
//      attempt, no settlement, no membership change, no lifecycle mutation.
//   B. UNKNOWN without evidence — pending + no lease does NOT establish a
//      capacity cause; the read seam represents absence as capacityWait: null.
//   C. coherent evidence may support cause — a real wait through the production
//      writer produces a wait row, capacity.waiting evidence, and active=true
//      while genuinely waiting (evidence coherence, not new semantic authority).
//   D. next_eligible_at is not an eligibility gate — a truthful wait row whose
//      next_eligible_at lies in the future does not block a claim that the
//      predecessor capacity conditions otherwise permit.
//   E. restart truthfulness — durable wait evidence remains readable through a
//      fresh independent store connection; absence remains absence; no
//      process-local timer reconstructs durable truth.
//   F. two-phase non-conflation — pre-lease dispatch deferral (no execution
//      lease, queue time outside governed duration) is distinguishable from
//      in-lease resource-capacity waiting (lease exists, one execution epoch,
//      duration authority untouched) using only existing Run/lease/evidence
//      authority and no new state field.
//
// Deliberately NOT owned here (canonical owners exist): every T2 blocker class,
// the full runtime-budget contract, lease recovery, scheduler behavior,
// provider behavior, and T4 relationships. Ordering/fairness is asserted
// NOWHERE: T5-I6 freezes no FIFO, fairness, or starvation semantics.

const assert = require('assert/strict');
const {
  PostgresRuntimeStore
} = require('../persistence/postgres/store');
const {
  buildRuntimeBudgetSnapshot
} = require('../runtime/runtime-budget-contract');
const {
  withHarness,
  createAsserter
} = require('./postgres-test-harness');

const check = createAsserter();

const defaults = Object.freeze({
  maxAttempts: 4,
  maxExecutionSteps: 4,
  maxModelRequestsPerRun: 4,
  maxWorkspaceOperationsPerRun: 4,
  maxProcessOperationsPerRun: 2,
  maxBrowserOperationsPerRun: 4,
  maxRuntimeDurationMs: 120_000,
  maxOutputArtifactBytesPerRun: 100,
  revision: 1
});

function policy(overrides = {}) {
  return {
    mode: 'assisted',
    requireVerification: 'when_declared',
    autoRetry: false,
    maxAttempts: null,
    maxExecutionSteps: null,
    maxRuntimeMs: null,
    maxModelRequests: null,
    maxWorkspaceOperations: null,
    maxProcessOperations: null,
    maxBrowserOperations: null,
    maxOutputArtifactBytes: null,
    allowWorkspaceWrites: true,
    allowParallelRuns: true,
    allowChildTickets: false,
    workspaceScope: 'shared',
    ...overrides
  };
}

function budget(overrides = {}) {
  return buildRuntimeBudgetSnapshot({
    runtimeLimits: { ...defaults, ...(overrides.runtimeLimits || {}) },
    executionPolicy: policy(overrides.executionPolicy)
  });
}

async function createAgent(store, label) {
  return (await store.createConfiguredAgent({
    value: {
      name: `${label} ${Date.now()} ${Math.random().toString(16).slice(2)}`,
      provider: 'openai',
      model: 'gpt-test',
      apiKey: ''
    },
    groupIds: [],
    changedBy: 't5-waiting-boundary-postgres-test'
  })).agent;
}

async function createTicket(store, agent, label) {
  return (await store.createTicketWithEvent({
    ticket: {
      objective: 'Fixture requested outcome',
      status: 'open',
      title: label,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    }
  })).ticket;
}

async function admitRuns(store, ticket, agent, snapshot, memberCount) {
  return store.createRunsAndStartTicket({
    ticketId: ticket.id,
    runDrafts: Array.from({ length: memberCount }, () => ({
      ticketId: ticket.id,
      agentId: agent.id,
      status: 'pending',
      executionMode: 'agent',
      runtimeBudgetSnapshot: snapshot
    }))
  });
}

async function claim(store, run, owner, duration = 30_000) {
  const result = await store.claimPendingRun({
    leaseOwner: owner,
    leaseDurationMs: duration,
    eligibleRunIds: [run.id],
    claimPayload: { source: 't5-waiting-boundary-postgres-test' }
  });
  return result && result.run;
}

async function main() {
  await withHarness('t5 waiting boundary PostgreSQL', async ({
    store,
    databaseUrl,
    schema
  }) => {
    const peer = new PostgresRuntimeStore({
      connectionString: databaseUrl,
      schema,
      lockTimeoutMs: 5_000
    });
    try {
      const agent = await createAgent(store, 'T5 boundary agent');

      // ── A. Attempt-member deferral ──────────────────────────────────────
      // One two-member T2 attempt (repository-owned admission writer). The
      // second member is dispatched into a pre-lease deferral: its dispatch
      // claim is refused by the live sibling-serialization capacity condition,
      // and the production deferral writer records the durable wait.
      const serialSnapshot = budget({
        executionPolicy: { allowParallelRuns: false }
      });
      const deferralTicket = await createTicket(store, agent, 'T5 deferral');
      const deferralAdmission = await admitRuns(
        store, deferralTicket, agent, serialSnapshot, 2);
      const [holderRun, deferredRun] = deferralAdmission.runs;
      const attempt = deferralAdmission.attempt;
      const deferralTicketStatusAfterAdmission =
        (await store.getTicket(deferralTicket.id)).status;
      check(deferredRun.status === 'pending' && deferredRun.leaseOwner === null,
        'an admitted but unclaimed member is a pending Run with no execution lease');
      check(deferredRun.ticketAttemptId === attempt.id &&
        holderRun.ticketAttemptId === attempt.id &&
        attempt.memberCount === 2 &&
        (await store.countTicketAttempts(deferralTicket.id)) === 1,
      'deferral target is already an admitted member of the existing attempt');

      check(Boolean(await claim(store, holderRun, 't5-holder-one')),
        'dispatch claim grants the first member its execution lease');
      check((await claim(store, deferredRun, 't5-deferred-one')) === null,
        'dispatch claim of the serialized member is deferred by live capacity');

      const firstWait = await store.recordPendingRunCapacityWait({
        runId: deferredRun.id,
        retryMs: 60_000
      });
      check(Boolean(firstWait),
        'the production deferral writer records the pre-lease capacity wait');

      check((await store.getRun(deferredRun.id)).ticketAttemptId === attempt.id &&
        attempt.id === (await store.getCurrentTicketAttempt(deferralTicket.id)).id &&
        (await store.countTicketAttempts(deferralTicket.id)) === 1,
      'pre-lease deferral creates no new Ticket attempt');
      const attemptAfterDeferral =
        await store.getCurrentTicketAttempt(deferralTicket.id);
      check(attemptAfterDeferral.disposition === null &&
        attemptAfterDeferral.settledAt === null,
      'pre-lease deferral settles no attempt and changes no disposition');
      check((await store.getTicket(deferralTicket.id)).status ===
        deferralTicketStatusAfterAdmission,
      'capacity deferral performs no Ticket lifecycle mutation');

      // ── F (phase 1 pins). Pre-lease dispatch deferral ───────────────────
      const deferredAfterDeferral = await store.getRun(deferredRun.id);
      check(deferredAfterDeferral.status === 'pending' &&
        deferredAfterDeferral.leaseOwner === null,
      'phase 1 deferral leaves the Run pending with no execution lease');
      const deferredEventsBefore = await store.listRunEvents(deferredRun.id);
      check(deferredEventsBefore.filter(event =>
        event.type === 'run.lease_acquired').length === 0,
      'phase 1 has no execution epoch: queue time is outside governed duration');

      // ── C. Coherent evidence may support cause ──────────────────────────
      const waitRow = (await store.pool.query(
        `SELECT capacity_domain, resource_key, reason, active, revision
         FROM ${store.table('run_capacity_waits')} WHERE run_id = $1`,
        [deferredRun.id]
      )).rows[0];
      check(waitRow && waitRow.active === true &&
        waitRow.capacity_domain === 'global_run' &&
        waitRow.resource_key === `ticket:${deferralTicket.id}` &&
        typeof waitRow.reason === 'string' && waitRow.reason.length > 0,
      'the durable wait row carries domain, resource, and reason while waiting');
      const waitingEvents = deferredEventsBefore.filter(event =>
        event.type === 'capacity.waiting');
      check(waitingEvents.length === 1 &&
        waitingEvents[0].payload.sourceIdentity === `scheduler:${deferredRun.id}` &&
        waitingEvents[0].payload.capacityDomain === 'global_run',
      'one truthful capacity.waiting event records the production deferral');
      const waitState = await store.getRunBudgetState(deferredRun.id);
      check(waitState.capacityWait && waitState.capacityWait.active === true &&
        waitState.capacityWait.capacityDomain === 'global_run',
      'getRunBudgetState exposes coherent active wait evidence for the Run');

      // ── D. next_eligible_at is not an eligibility gate ──────────────────
      // The production writer just stamped next_eligible_at = now + 60s. That
      // is still in the future, yet once the real capacity condition clears,
      // the dispatch claim succeeds immediately.
      const storedWaitRow = (await store.pool.query(
        `SELECT next_eligible_at FROM ${store.table('run_capacity_waits')}
         WHERE run_id = $1`,
        [deferredRun.id]
      )).rows[0];
      check(storedWaitRow.next_eligible_at.getTime() > Date.now(),
        'the wait row next_eligible_at lies in the future');
      await store.releaseRunLease({
        runId: holderRun.id,
        leaseOwner: 't5-holder-one',
        payload: { reason: 't5 eligibility-gate fixture' }
      });
      const gatedClaim = await claim(store, deferredRun, 't5-deferred-two');
      check(Boolean(gatedClaim),
        'a future next_eligible_at does not gate a claim the capacity conditions permit');
      check((await store.getRun(deferredRun.id)).leaseOwner === 't5-deferred-two',
        'the claimed Run now holds the execution lease its deferral lacked');

      // ── F (phase 2 pins). In-lease resource-capacity waiting ────────────
      // A second attempt supplies an occupied target slot held across its own
      // live lease, so the now-leased member genuinely waits IN lease.
      const slotTicket = await createTicket(store, agent, 'T5 slot holder');
      const slotWave = await admitRuns(store, slotTicket, agent, budget(), 2);
      const [slotHolderRun, noEvidenceRun] = slotWave.runs;
      check(Boolean(await claim(store, slotHolderRun, 't5-slot-holder')),
        'the slot-holder claims its lease');
      await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:t5-shared',
        limit: 1,
        leaseOwner: 't5-slot-holder',
        runId: slotHolderRun.id,
        operationIdentity: `t5-slot-holder:${slotHolderRun.id}`,
        leaseDurationMs: 30_000,
        sourceIdentity: `t5-slot-holder:${slotHolderRun.id}`
      });
      check(Boolean(await claim(store, noEvidenceRun, 't5-no-evidence')),
        'the sibling member claims its lease under a parallel policy');
      check((await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:t5-shared',
        limit: 1,
        leaseOwner: 't5-deferred-two',
        runId: deferredRun.id,
        operationIdentity: `t5-phase2:${deferredRun.id}`,
        leaseDurationMs: 30_000,
        sourceIdentity: `t5-phase2:${deferredRun.id}`
      })).acquired === false,
      'in-lease resource-capacity acquisition waits on the occupied target slot');

      const phaseTwoRun = await store.getRun(deferredRun.id);
      const phaseTwoEvents = await store.listRunEvents(deferredRun.id);
      const phaseTwoWaitRow = (await store.pool.query(
        `SELECT capacity_domain, resource_key, source_identity, reason,
                active, revision
         FROM ${store.table('run_capacity_waits')} WHERE run_id = $1`,
        [deferredRun.id]
      )).rows[0];
      check(phaseTwoRun.status === 'pending' &&
        phaseTwoRun.leaseOwner === 't5-deferred-two',
      'phase 2 waiting keeps the same Run with its execution lease held');
      check(phaseTwoRun.ticketAttemptId === attempt.id &&
        (await store.countTicketAttempts(deferralTicket.id)) === 1 &&
        (await store.getCurrentTicketAttempt(deferralTicket.id)).disposition === null,
      'in-lease waiting preserves attempt identity, count, and unsettled disposition');
      check(phaseTwoWaitRow.active === true,
        'the same Run now waits in lease with an active wait row');
      check(phaseTwoWaitRow.capacity_domain === 'target' &&
        phaseTwoWaitRow.resource_key === 'browser:t5-shared' &&
        phaseTwoWaitRow.source_identity === `t5-phase2:${deferredRun.id}` &&
        phaseTwoWaitRow.reason === 'Capacity target/browser:t5-shared is occupied',
      'the durable row describes the CURRENT in-lease wait, not the prior episode');
      check(phaseTwoEvents.filter(event =>
        event.type === 'run.lease_acquired').length === 1,
      'in-lease waiting creates no second execution epoch');
      check(phaseTwoRun.runtimeBudgetSnapshot.snapshotHash ===
        serialSnapshot.snapshotHash,
      'in-lease waiting leaves the immutable duration/budget authority unchanged');
      const phaseTwoWaitingEvents = phaseTwoEvents.filter(event =>
        event.type === 'capacity.waiting');
      check(phaseTwoWaitingEvents.length === 2 &&
        phaseTwoWaitingEvents[1].payload.sourceIdentity ===
          `t5-phase2:${deferredRun.id}` &&
        phaseTwoWaitingEvents[1].payload.capacityDomain === 'target' &&
        phaseTwoWaitingEvents[1].payload.resourceKey === 'browser:t5-shared',
      'phase 2 emits its own capacity.waiting evidence from the in-lease writer');
      check(phaseTwoWaitRow.source_identity ===
          phaseTwoWaitingEvents[1].payload.sourceIdentity &&
        phaseTwoWaitRow.reason === phaseTwoWaitingEvents[1].payload.reason,
      'the durable row matches the current capacity.waiting evidence it accompanies');

      // Narrow cross-boundary idempotence: repeating the SAME phase-2 wait
      // through the production writer must not churn durable current-wait
      // evidence. The full revision/event lifecycle is owned by
      // runtime-budget-postgres-test.js.
      await store.acquireRuntimeCapacity({
        capacityDomain: 'target',
        resourceKey: 'browser:t5-shared',
        limit: 1,
        leaseOwner: 't5-deferred-two',
        runId: deferredRun.id,
        operationIdentity: `t5-phase2:${deferredRun.id}`,
        leaseDurationMs: 30_000,
        sourceIdentity: `t5-phase2:${deferredRun.id}`
      });
      const phaseTwoRowAfterPoll = (await store.pool.query(
        `SELECT capacity_domain, resource_key, source_identity, reason,
                active, revision
         FROM ${store.table('run_capacity_waits')} WHERE run_id = $1`,
        [deferredRun.id]
      )).rows[0];
      check(phaseTwoRowAfterPoll.revision === phaseTwoWaitRow.revision &&
        phaseTwoRowAfterPoll.capacity_domain === 'target' &&
        phaseTwoRowAfterPoll.resource_key === 'browser:t5-shared' &&
        phaseTwoRowAfterPoll.active === true,
      'repeating the SAME in-lease wait does not churn the durable row');
      check((await store.listRunEvents(deferredRun.id)).filter(event =>
        event.type === 'capacity.waiting').length === 2,
      'repeating the SAME in-lease wait emits no duplicate capacity.waiting event');

      // ── B. UNKNOWN without evidence ─────────────────────────────────────
      check(noEvidenceRun.status === 'pending' && noEvidenceRun.leaseOwner === null,
        'the no-evidence fixture is a pending Run with no lease');
      check((await store.getRunBudgetState(noEvidenceRun.id)).capacityWait === null,
        'pending + no lease with no durable wait evidence reads capacityWait null');
      check((await store.listRunEvents(noEvidenceRun.id)).filter(event =>
        event.type === 'capacity.waiting').length === 0,
      'no capacity.waiting evidence exists for the never-deferred Run');

      // ── E. Restart truthfulness ─────────────────────────────────────────
      // A fresh independent store instance reads the same durable truth with
      // no process-local state and no timers.
      const restartedWaitState = await peer.getRunBudgetState(deferredRun.id);
      check(restartedWaitState.capacityWait &&
        restartedWaitState.capacityWait.active === true &&
        restartedWaitState.capacityWait.capacityDomain === 'target' &&
        restartedWaitState.capacityWait.resourceKey === 'browser:t5-shared' &&
        restartedWaitState.capacityWait.sourceIdentity ===
          `t5-phase2:${deferredRun.id}` &&
        restartedWaitState.capacityWait.reason ===
          'Capacity target/browser:t5-shared is occupied',
      'restart recovery reads the CURRENT phase-2 wait identity, not merely a true active bit');
      check((await peer.listRunEvents(deferredRun.id)).filter(event =>
        event.type === 'capacity.waiting').length === 2,
      'both phases of capacity.waiting evidence remain readable after restart');
      check((await peer.getRunBudgetState(noEvidenceRun.id)).capacityWait === null,
        'absence of cause evidence remains absence/UNKNOWN after restart');
      check((await peer.countTicketAttempts(deferralTicket.id)) === 1 &&
        (await peer.getCurrentTicketAttempt(deferralTicket.id)).disposition === null,
      'attempt truth is reconstructed from durable authority, not process state');

      await peer.close();
      console.log(
        `PASS: T5 waiting boundary PostgreSQL (${check.count()} assertions)`);
    } catch (error) {
      try { await peer.close(); } catch (_) { /* best effort */ }
      throw error;
    }
  }, { schemaSlug: 't5_waiting_boundary' });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
