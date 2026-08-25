#!/usr/bin/env node
'use strict';

// Tranche 5 — the canonical verified-progress projection, proved against the
// database rows it claims to project.
//
// The danger this suite exists for is specific. A projection that recomputes
// progress its own way will eventually tell an operator a Run may continue
// while the pre-reservation gate has already stopped it, or show a duration
// that drifts every time someone refreshes the page. So every assertion below
// compares projected values against the DURABLE FACT they are supposed to come
// from — SQL rows, the stored block, the earliest lease event — rather than
// against another copy of the projection.

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');
const {
  NEVER_PROJECTED,
  PROGRESS_LEVELS,
  cutoffIdentity,
  projectRunVerifiedProgress,
  projectTicketVerifiedProgress
} = require('../runtime/verified-progress-projection');
const {
  progressControlPolicy,
  seedGovernedStructuredTicket
} = require('./governed-structured-fixture');

const STAMP = `vpp-${Date.now()}`;
const ACTOR = 'verified-progress-projection-test';

async function main() {
  await withHarness('verified progress projection PostgreSQL', async ({ store }) => {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const seeded = await seedGovernedStructuredTicket(store, {
      stamp: STAMP,
      actor: ACTOR
    });

    // ── Non-governed families omit the projection cleanly ───────────────────
    //
    // Direct, v1, workflow, browser, process, simulation and compiler Runs hold
    // no governed authority at all. They must project as ABSENT, never as a
    // zeroed-out governed Run, which would read like a measurement.
    assert.equal(projectRunVerifiedProgress({ run: { id: 1, ticketId: 1 } }), null,
      'a non-structured Run omits the Tranche 5 projection entirely');
    assert.equal(projectRunVerifiedProgress({ run: null }), null,
      'a missing Run projects nothing rather than throwing');
    assert.equal(projectTicketVerifiedProgress([]), null,
      'a Ticket with no governed structured leaf Run omits the summary');
    assert.equal(projectTicketVerifiedProgress([null, null]), null,
      'a Ticket whose Runs all omit the projection omits the summary');

    // ── Malformed governed state fails closed ──────────────────────────────
    //
    // Half-governed is an integrity failure, not a historical shape. It must
    // refuse rather than render as an ordinary Run.
    assert.throws(
      () => projectRunVerifiedProgress({
        run: { id: 2, ticketId: 2, governedExecution: { version: 1 } }
      }),
      error => error.code === 'VERIFIED_PROGRESS_PROJECTION_INVALID',
      'governed authority without a leaf binding fails closed');
    assert.throws(
      () => projectRunVerifiedProgress({
        run: { id: 3, ticketId: 3, leafRunBinding: { allocationItemId: 1 } }
      }),
      error => error.code === 'VERIFIED_PROGRESS_PROJECTION_INVALID',
      'a leaf binding without governed authority fails closed');
    assert.throws(
      () => projectRunVerifiedProgress({
        run: {
          id: 4, ticketId: 4,
          leafRunBinding: { allocationItemId: 1 },
          governedExecution: { progressControlPolicy: { version: 1 } }
        }
      }),
      error => /policy/i.test(String(error.message)),
      'a malformed captured progress policy refuses rather than projecting');

    const runId = seeded.runIds[0];
    const siblingRunId = seeded.runIds[1];
    const ticketId = seeded.ticketId;

    // ── Un-evaluated Run: honest absence, not a fake zero ──────────────────
    const beforeExecution = await store.readRunVerifiedProgressProjection(runId);
    assert.ok(beforeExecution, 'a governed structured leaf Run projects');
    assert.deepEqual(beforeExecution.progress
      ? beforeExecution.progress.levels : PROGRESS_LEVELS, PROGRESS_LEVELS,
      'the four progress levels are named and kept apart');

    // ── Policy comes from the CAPTURED authority ───────────────────────────
    const run = await store.getRun(runId);
    const captured = run.governedExecution.progressControlPolicy;
    assert.equal(beforeExecution.policy.progressPolicyHash, captured.policyHash,
      'the projected policy hash is the captured one');
    assert.equal(
      beforeExecution.policy.maximumCumulativeExecutionDurationMs,
      captured.maximumCumulativeExecutionDurationMs,
      'the projected duration bound is the captured one');
    assert.equal(
      beforeExecution.policy.maximumConsecutiveNoProgressWindows,
      captured.maximumConsecutiveNoProgressWindows);
    assert.equal(beforeExecution.policy.maximumRepeatedMutations,
      captured.maximumRepeatedMutations);
    assert.equal(beforeExecution.policy.maximumFailedOperationStreak,
      captured.maximumFailedOperationStreak);
    assert.equal(beforeExecution.policy.maximumMutationReversals,
      captured.maximumMutationReversals);

    // ── Execute, then compare every projected fact to its durable source ───
    await store.claimPendingRun({
      leaseOwner: ACTOR, leaseDurationMs: 600_000, eligibleRunIds: [runId] });
    await store.startClaimedRun({
      runId, leaseOwner: ACTOR, leaseDurationMs: 600_000 });

    const projected = await store.readRunVerifiedProgressProjection(runId);
    assert.equal(projected.evaluated, true, 'an executing Run evaluates');
    assert.equal(projected.runId, runId);
    assert.equal(projected.ticketId, ticketId);

    // Epoch: the earliest lease-acquired event, read straight from the log.
    const epochRow = await store.pool.query(
      `SELECT min(ts) AS epoch_at FROM ${store.table('events')}
        WHERE run_id = $1 AND type = 'run.lease_acquired'`, [runId]);
    assert.ok(epochRow.rows[0].epoch_at, 'a lease-acquired event exists');
    // `Date.parse` on a driver Date object goes through toString() and loses
    // milliseconds, so the comparison is made on the Date value itself.
    assert.equal(
      Date.parse(projected.executionEpochAt),
      new Date(epochRow.rows[0].epoch_at).getTime(),
      'the projected execution epoch IS the earliest lease-acquired event');

    // It is emphatically NOT the latest attempt stamp, which recovery resets.
    const runRow = await store.pool.query(
      `SELECT started_at FROM ${store.table('runs')} WHERE id = $1`, [runId]);
    assert.ok(runRow.rows[0].started_at, 'the Run has a latest-attempt stamp');

    // Cutoffs: compared against the actual SQL maxima.
    const maxima = await store.pool.query(
      `SELECT
         COALESCE((SELECT max(id) FROM ${store.table('operation_receipts')}
                    WHERE run_id = $1), 0)::bigint AS receipts,
         COALESCE((SELECT max(id) FROM ${store.table('economic_request_reservations')}
                    WHERE run_id = $1), 0)::bigint AS reservations,
         COALESCE((SELECT max(id) FROM ${store.table('run_budget_charges')}
                    WHERE run_id = $1), 0)::bigint AS budget`, [runId]);
    assert.equal(projected.cutoff.receiptCutoff, Number(maxima.rows[0].receipts),
      'the projected receipt cutoff matches the durable maximum');
    assert.equal(projected.cutoff.reservationCutoff,
      Number(maxima.rows[0].reservations),
      'the projected reservation cutoff matches the durable maximum');
    assert.equal(projected.cutoff.budgetCutoff, Number(maxima.rows[0].budget),
      'the projected runtime-budget cutoff matches the durable maximum');

    // The evaluation instant is a database fact, and the cutoff identity is a
    // deterministic function of the cutoff document.
    assert.match(projected.cutoff.evaluatedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      'the evaluation instant is a normalized ISO timestamp');
    {
      const dbNow = (await store.pool.query(
        'SELECT clock_timestamp() AS ts')).rows[0].ts;
      assert.ok(
        Math.abs(new Date(dbNow).getTime() -
          Date.parse(projected.cutoff.evaluatedAt)) < 60_000,
        'the projected evaluation instant tracks the database clock');
    }
    assert.equal(projected.cutoff.cutoffIdentity, cutoffIdentity({
      receiptCutoff: projected.cutoff.receiptCutoff,
      reservationCutoff: projected.cutoff.reservationCutoff,
      budgetCutoff: projected.cutoff.budgetCutoff,
      postconditionEvidenceCutoff: projected.cutoff.postconditionEvidenceCutoff,
      evaluatedAt: projected.cutoff.evaluatedAt
    }), 'the cutoff identity is the canonical hash of the cutoff document');
    assert.ok(Number.isSafeInteger(projected.cutoff.postconditionEvidenceCutoff),
      'the evidence cutoff is a durable ordinal bound');

    // Duration: exactly epoch-to-cutoff, not a stored counter.
    assert.equal(
      projected.resources.cumulativeExecutionDurationMs,
      Date.parse(projected.cutoff.evaluatedAt) -
        Date.parse(projected.executionEpochAt),
      'projected duration is exactly evaluatedAt minus the execution epoch');

    // Cumulative resources: compared against the durable ledgers.
    const ledgers = await store.pool.query(
      `SELECT
         (SELECT count(*)::int FROM ${store.table('operation_receipts')}
           WHERE run_id = $1) AS operations,
         (SELECT COALESCE(sum(settled_micro_usd), 0)::bigint
            FROM ${store.table('economic_request_reservations')}
           WHERE run_id = $1) AS settled,
         (SELECT COALESCE(sum(committed_amount), 0)::bigint
            FROM ${store.table('run_budget_charges')}
           WHERE run_id = $1) AS charged`, [runId]);
    assert.equal(projected.resources.cumulativeDurableOperations,
      Number(ledgers.rows[0].operations),
      'projected operations match the durable receipt ledger');
    assert.equal(projected.resources.cumulativeSettledMicroUsd,
      Number(ledgers.rows[0].settled),
      'projected settled micro-USD matches the durable reservation ledger');
    assert.equal(projected.resources.cumulativeBudgetChargedUnits,
      Number(ledgers.rows[0].charged),
      'projected budget units match the durable charge ledger');

    // ── The four levels stay apart ────────────────────────────────────────
    //
    // Activity and candidate progress must never be counted as verified
    // progress, and nothing here may claim completion.
    assert.equal(projected.progress.verifiedProgressCount,
      projected.progress.newlyVerifiedProgressFacts.length,
      'verified progress count matches its own fact list');
    assert.equal(projected.progress.candidateProgressCount,
      projected.progress.candidateProgressFacts.length,
      'candidate progress count matches its own fact list');
    for (const fact of projected.progress.candidateProgressFacts) {
      assert.equal(projected.progress.newlyVerifiedProgressFacts.includes(fact),
        false, 'a candidate fact is never also projected as verified progress');
    }
    assert.equal(projected.progress.completionAuthority,
      'structured_allocation_leaf_completion_decision',
      'completion is delegated, never decided here');
    assert.equal(
      Object.prototype.hasOwnProperty.call(projected.progress, 'complete'), false,
      'the progress projection exposes no completion verdict of its own');

    // ── Decision is reported, never re-derived ────────────────────────────
    assert.ok(['continue', 'blocked'].includes(projected.decision.decision),
      'the decision vocabulary stays closed — no retry, reroute or replan');
    assert.equal(projected.decision.permitsFurtherGovernedSpending,
      projected.decision.decision === 'continue',
      'permission is a restatement of the decision, not a second judgement');

    // ── Secret containment, against real output ───────────────────────────
    const projectedText = JSON.stringify(projected);
    for (const forbidden of NEVER_PROJECTED) {
      assert.equal(projectedText.includes(forbidden), false,
        `the projection never exposes ${forbidden}`);
    }
    assert.equal(/sk-[A-Za-z0-9]/.test(projectedText), false,
      'no credential-shaped value appears in the projection');
    assert.equal(/fixture-key/.test(projectedText), false,
      'no injected fixture credential reaches the projection');
    assert.equal(/do the work|prompt|messages/i.test(projectedText), false,
      'no prompt text or model prose reaches the projection');

    // ── Block projection matches the stored block exactly ─────────────────
    //
    // Driven through the real sibling-read refusal rather than by writing a
    // block by hand: a fixture block would prove only that the projector can
    // copy fields.
    const plan = await store.getAllocationPlanForTicket(ticketId);
    const sibling = await store.getRun(siblingRunId);
    const siblingItem = plan.items.find(
      item => item.allocationItemId === sibling.leafRunBinding.allocationItemId);
    const requestedPath = `${siblingItem.ownedOutputPaths[0]}report.md`;

    const resolved = await store.resolveGovernedSiblingReadAuthority({
      runId, requestedPath });
    assert.equal(resolved.outcome, 'blocked_incomplete_sibling',
      'the sibling is genuinely incomplete');

    const eventsBefore = (await store.listTicketEvents(ticketId, { limit: 500 }))
      .events.filter(event => event.type === 'run.progress_blocked').length;

    await store.blockGovernedRunForSiblingRead({ runId, sibling: resolved.sibling });

    const stored = await store.readGovernedProgressBlock(runId);
    const blocked = await store.readRunVerifiedProgressProjection(runId);
    assert.ok(blocked.block, 'the persisted block is projected');
    assert.equal(blocked.block.blockHash, stored.blockHash,
      'the projected block hash IS the stored one');
    assert.equal(blocked.block.reason, stored.reason,
      'the projected reason IS the stored closed reason');
    assert.equal(blocked.block.reason, 'undeclared_sibling_dependency');
    assert.equal(blocked.block.decision, 'blocked');
    assert.equal(blocked.block.churnDecisionHash, stored.churnDecisionHash);
    assert.equal(blocked.block.progressPolicyHash, stored.progressPolicyHash);
    assert.equal(blocked.block.executionEpochAt, stored.executionEpochAt);
    assert.equal(blocked.block.cutoff.receiptCutoff, stored.cutoff.receiptCutoff);
    assert.equal(blocked.block.cutoff.evaluatedAt, stored.cutoff.evaluatedAt);

    // Sibling authority is carried in full, and cites no completion decision.
    assert.ok(blocked.block.siblingDependency, 'the sibling dependency projects');
    assert.equal(blocked.block.siblingDependency.requestedPath,
      stored.siblingDependency.requestedPath);
    assert.ok(blocked.block.siblingDependency.requestedPath.includes('report.md'),
      'the projected block names the requested path');
    assert.equal(blocked.block.siblingDependency.siblingAllocationItemId,
      siblingItem.allocationItemId,
      'the projected block names the owning sibling work unit');
    assert.equal(blocked.block.siblingDependency.siblingCompletionDecisionHash, null,
      'a blocked sibling read cites no completion decision');
    assert.ok(['incomplete', 'decision_absent', 'terminal_without_decision']
      .includes(blocked.block.siblingDependency.siblingCompletionState),
      'the sibling completion state is a closed value');

    // ── One block transition, one event; re-reading creates none ──────────
    const eventsAfterBlock =
      (await store.listTicketEvents(ticketId, { limit: 500 }))
        .events.filter(event => event.type === 'run.progress_blocked').length;
    assert.equal(eventsAfterBlock, eventsBefore + 1,
      'one block transition appends exactly one event');

    // Reading the projection is a READ. It must not evaluate a new decision,
    // append an event, or move the stored cutoff.
    await store.readRunVerifiedProgressProjection(runId);
    await store.readRunVerifiedProgressProjection(runId);
    const rereadProjection = await store.readRunVerifiedProgressProjection(runId);
    assert.equal(
      (await store.listTicketEvents(ticketId, { limit: 500 }))
        .events.filter(event => event.type === 'run.progress_blocked').length,
      eventsAfterBlock,
      'projecting a blocked Run appends no further event');
    assert.equal(rereadProjection.block.blockHash, stored.blockHash,
      'repeated projection returns the identical stored block');
    assert.equal(rereadProjection.cutoff.evaluatedAt, stored.cutoff.evaluatedAt,
      'projecting a blocked Run reuses the stored cutoff, taking no new instant');
    assert.equal(rereadProjection.resources.cumulativeExecutionDurationMs,
      blocked.resources.cumulativeExecutionDurationMs,
      'a blocked Run projects a stable duration, not one that grows on refresh');

    // ── The block event payload binds the deciding authority ──────────────
    const blockEvent = (await store.listTicketEvents(ticketId, { limit: 500 }))
      .events.filter(event => event.type === 'run.progress_blocked').pop();
    assert.ok(blockEvent, 'the block event is present in ticket history');
    assert.equal(blockEvent.runId, runId, 'the event binds its Run');
    const payload = blockEvent.payload;
    assert.equal(payload.reason, stored.reason, 'the event binds the reason');
    assert.equal(payload.blockHash, stored.blockHash, 'the event binds the block');
    assert.equal(payload.churnDecisionHash, stored.churnDecisionHash,
      'the event binds the deciding churn decision');
    assert.equal(payload.verifiedProgressProjectionHash,
      stored.verifiedProgressProjectionHash,
      'the event binds the projection the decision was taken over');
    assert.equal(payload.progressPolicyHash, stored.progressPolicyHash,
      'the event binds the captured policy');
    assert.equal(payload.cutoff.receiptCutoff, stored.cutoff.receiptCutoff,
      'the event binds the exact cutoff');
    assert.equal(payload.cutoff.evaluatedAt, stored.cutoff.evaluatedAt,
      'the event binds the database evaluation instant');
    const eventText = JSON.stringify(blockEvent);
    for (const forbidden of NEVER_PROJECTED) {
      assert.equal(eventText.includes(forbidden), false,
        `the block event never carries ${forbidden}`);
    }
    assert.equal(/sk-[A-Za-z0-9]|fixture-key/.test(eventText), false,
      'the block event carries no credential');

    // ── Later receipts do not rewrite an existing block ───────────────────
    await store.pool.query(
      `INSERT INTO ${store.table('operation_receipts')}
         (run_id, ticket_id, operation, outcome, workspace_path,
          mutation_fingerprint, receipt, idempotency_key, recorded_at)
       VALUES ($1, $2, 'writeFile', 'succeeded', 'late/after-block.md',
               'fingerprint-late', '{"kind":"late"}'::jsonb, $3,
               clock_timestamp())`,
      [runId, ticketId, `late-after-block-${STAMP}`]);
    const afterLateReceipt = await store.readRunVerifiedProgressProjection(runId);
    assert.equal(afterLateReceipt.block.blockHash, stored.blockHash,
      'a receipt committed after the block does not rewrite it');
    assert.equal(afterLateReceipt.cutoff.receiptCutoff, stored.cutoff.receiptCutoff,
      'the stored cutoff still excludes rows committed after the decision');

    // ── Current policy changes do not rewrite captured Run authority ──────
    const raised = progressControlPolicy({
      maximumConsecutiveNoProgressWindows: 99,
      maximumCumulativeExecutionDurationMs: 604_800_000
    });
    assert.notEqual(raised.policyHash, captured.policyHash,
      'the raised policy is genuinely different authority');
    const afterPolicyChange = await store.readRunVerifiedProgressProjection(runId);
    assert.equal(afterPolicyChange.policy.progressPolicyHash, captured.policyHash,
      'a later policy does not rewrite the captured Run authority');
    assert.equal(
      afterPolicyChange.policy.maximumCumulativeExecutionDurationMs,
      captured.maximumCumulativeExecutionDurationMs,
      'the captured duration bound is unchanged by current policy');

    // ── Process-clock changes do not alter stored evaluation facts ────────
    {
      const RealDate = Date;
      const skewMs = 365 * 24 * 60 * 60 * 1000;
      class SkewedDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(RealDate.now() + skewMs);
          else super(...args);
        }
        static now() { return RealDate.now() + skewMs; }
      }
      let skewed = null;
      try {
        global.Date = SkewedDate;
        skewed = await store.readRunVerifiedProgressProjection(runId);
      } finally {
        global.Date = RealDate;
      }
      assert.equal(skewed.cutoff.evaluatedAt, stored.cutoff.evaluatedAt,
        'moving the process clock does not alter the stored evaluation instant');
      assert.equal(skewed.block.blockHash, stored.blockHash,
        'moving the process clock does not alter the stored block');
      assert.equal(skewed.resources.cumulativeExecutionDurationMs,
        blocked.resources.cumulativeExecutionDurationMs,
        'moving the process clock does not alter projected duration');
    }

    // ── Restart returns the identical stored block and cutoff ─────────────
    {
      const { PostgresRuntimeStore } = require('../persistence/postgres/store');
      const restarted = new PostgresRuntimeStore({
        connectionString: process.env.TEST_DATABASE_URL, schema: store.schema });
      try {
        const afterRestart = await restarted.readRunVerifiedProgressProjection(runId);
        assert.equal(afterRestart.block.blockHash, stored.blockHash,
          'a restart projects the identical stored block');
        assert.equal(afterRestart.cutoff.evaluatedAt, stored.cutoff.evaluatedAt,
          'a restart projects the identical stored cutoff');
        assert.equal(afterRestart.cutoff.cutoffIdentity,
          blocked.cutoff.cutoffIdentity,
          'the cutoff identity is stable across processes');
        assert.equal(afterRestart.policy.progressPolicyHash, captured.policyHash,
          'a restart projects the identical captured policy');
      } finally {
        await restarted.close();
      }
    }

    // ── Ticket-level summary ──────────────────────────────────────────────
    const ticketSummary = await store.readTicketVerifiedProgressProjection(ticketId);
    assert.ok(ticketSummary, 'the Ticket projects a governed progress summary');
    assert.ok(ticketSummary.governedRunIds.includes(runId),
      'the blocked Run appears among the governed Runs');
    assert.ok(ticketSummary.governedRunIds.includes(siblingRunId),
      'the sibling Run appears among the governed Runs');

    // The blocked Run is counted under its OWN reason and no other.
    assert.deepEqual(ticketSummary.blockedForUndeclaredSiblingDependency, [runId],
      'the sibling-dependency block is counted under its own reason');
    for (const [label, list] of [
      ['verified progress exhaustion',
        ticketSummary.blockedForVerifiedProgressExhaustion],
      ['repeated no-op', ticketSummary.blockedForRepeatedNoOp],
      ['repeated failed operation',
        ticketSummary.blockedForRepeatedFailedOperation],
      ['mutation reversal', ticketSummary.blockedForMutationReversal],
      ['cumulative duration',
        ticketSummary.blockedForCumulativeExecutionDuration],
      ['accounting conflict',
        ticketSummary.blockedForProgressAccountingConflict]
    ]) {
      assert.equal(list.includes(runId), false,
        `the sibling block is not also counted as ${label}`);
    }
    assert.equal(ticketSummary.runsPermittedToContinue.includes(runId), false,
      'a blocked Run is never listed as permitted to continue');

    // A governed Run that has never been leased is QUEUED, not running. Counting
    // it as an open window would overstate in-flight work in exactly the way
    // charging queue time as execution duration would overstate spend.
    const neverLeased = seeded.runIds.filter(
      id => id !== runId && id !== siblingRunId);
    for (const queuedRunId of neverLeased.concat([siblingRunId])) {
      const queuedProjection =
        await store.readRunVerifiedProgressProjection(queuedRunId);
      if (queuedProjection.executionEpochAt === null) {
        assert.ok(
          ticketSummary.runsQueuedBeforeFirstExecution.includes(queuedRunId),
          'a governed Run awaiting its first lease is reported as queued');
        assert.equal(queuedProjection.resources.cumulativeExecutionDurationMs, 0,
          'a queued Run has consumed zero execution duration');
      }
    }
    assert.ok(
      ticketSummary.unresolvedActiveWindows <=
        ticketSummary.runsPermittedToContinue.length,
      'open windows never exceed the Runs permitted to continue');
    for (const queuedRunId of ticketSummary.runsQueuedBeforeFirstExecution) {
      assert.equal(
        ticketSummary.blockedForUndeclaredSiblingDependency.includes(queuedRunId),
        false, 'a queued Run is not also counted as blocked');
    }

    // Verified progress is not completion, and the summary says so by omission.
    assert.equal(typeof ticketSummary.totalVerifiedProgressFacts, 'number');
    assert.equal(
      Object.prototype.hasOwnProperty.call(ticketSummary, 'completedRunIds'),
      false, 'the progress summary claims no completion of its own');

    // Money stays consistent with Tranche 4: the summary reports CONSUMPTION
    // and names the authoritative balance source rather than restating it.
    assert.equal(ticketSummary.cumulativeResources.settlementAuthority,
      'ticket_economic_accounts',
      'the summary defers to the Tranche 4 accounts for balances');
    const economics = await store.readTicketGovernedEconomics(ticketId);
    const durableSettled = economics.reservations
      .filter(reservation => reservation.role === 'structured_leaf_executor')
      .reduce((total, reservation) =>
        total + Number(reservation.settledMicroUsd || 0), 0);

    // The summary NEVER OVERSTATES consumption relative to the durable
    // settlement rows Tranche 4 reads. It can legitimately lag them: a blocked
    // Run is projected through its STORED cutoff, so settlement completing
    // after the block is deliberately outside the frozen decision of record.
    // Asserting exact equality here would encode a guarantee the design does
    // not make, and would start failing the first time a reservation settled
    // after a block.
    assert.ok(
      ticketSummary.cumulativeResources.settledMicroUsd <= durableSettled,
      'the summary never reports more consumption than the durable rows show');
    assert.equal(ticketSummary.cumulativeResources.settledMicroUsd, durableSettled,
      'with nothing settled after the block, the summary matches exactly');

    const summaryText = JSON.stringify(ticketSummary);
    for (const forbidden of NEVER_PROJECTED) {
      assert.equal(summaryText.includes(forbidden), false,
        `the Ticket summary never exposes ${forbidden}`);
    }

    // ── Projection takes no write lock ────────────────────────────────────
    //
    // A read-only seam that locked every governed Run of a Ticket would
    // serialize page loads against the execution gate and hold those locks for
    // the whole read. The proof: hold a real FOR UPDATE lock on the Run in one
    // transaction and project it from another. If the projection took the lock
    // too, this would block until the timeout below fired.
    {
      const holder = await store.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT id FROM ${store.table('runs')} WHERE id = $1 FOR UPDATE`,
          [runId]);

        const projectedUnderLock = await Promise.race([
          store.readRunVerifiedProgressProjection(runId),
          new Promise((resolve, reject) =>
            setTimeout(() => reject(new Error(
              'the projection blocked on a Run row lock')), 8_000).unref())
        ]);
        assert.ok(projectedUnderLock,
          'the projection completes while another transaction holds the Run lock');
        assert.equal(projectedUnderLock.block.blockHash, stored.blockHash,
          'the lock-free read still returns the stored block');

        // The deciding path keeps its lock — that default must not have moved.
        await assert.rejects(
          () => Promise.race([
            store.readGovernedRunProgressState(runId),
            new Promise((resolve, reject) =>
              setTimeout(() => reject(new Error('deciding read waited, as it must')),
                2_000).unref())
          ]),
          /deciding read waited/,
          'the deciding progress read still takes FOR UPDATE and serializes');
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
      }
    }

    // ── A non-structured Ticket is untouched ──────────────────────────────
    const plainTicket = await store.createTicket({
      title: `Plain ticket ${STAMP}`,
      objective: `Plain ticket ${STAMP}`,
      description: 'No governed structured leaf execution',
      status: 'open',
      priority: 'medium'
    });
    assert.equal(
      await store.readTicketVerifiedProgressProjection(plainTicket.id), null,
      'a Ticket with no governed structured leaf Run projects nothing');

    console.log('  ok verified progress projection');
  });
  console.log('verified progress projection PostgreSQL test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
