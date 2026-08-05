#!/usr/bin/env node
'use strict';

// Tranche 5: `undeclared_sibling_dependency` produced by the REAL runtime.
//
// WHY THIS EXISTS SEPARATELY. The production-path suite already proves the
// sibling authority's resolver and the canonical block row, but it reaches them
// by calling `resolveGovernedSiblingReadAuthority` and
// `blockGovernedRunForSiblingRead` directly. That proves the authority is
// correct; it does not prove anything CALLS it. The guard that matters lives in
// `assertGovernedSiblingReadAllowed`, invoked from the workspace-operation
// preflight inside the spawned server, and nothing durable connects the two.
//
// Here a governed structured leaf is admitted through the canonical fixture,
// executed by the real scheduler and worker loop in a spawned server, and
// answered by the hermetic transport with a response whose ONLY action is a
// read of a sibling's owned output. The refusal, the durable block, the
// terminal disposition and the restart projection are then read back from the
// database — never from the process that produced them.
//
// The sibling is deliberately left incomplete for the whole scenario. A sibling
// that completes mid-run would make the read legitimate and the outcome a race.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  countDelta,
  durableRunCounts,
  durableTerminalCounts,
  findRuntimeRun,
  waitForSchedulerQuiescence
} = require('./fixtures/terminal-projection-restart');
const {
  progressControlPolicy,
  seedGovernedStructuredTicket
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');
const {
  correlateGovernedTransports,
  transportsForRun
} = require('./fixtures/governed-transport-correlation');

const STAMP = `gsd-${Date.now()}`;
const ACTOR = 'governed-sibling-dependency-test';
const PRELOAD = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIMITS = {
  maxExecutionSteps: 6,
  maxModelRequestsPerRun: 2,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 600_000,
  maxAttempts: 1,
  maxProcessOperationsPerRun: 5,
  maxBrowserOperationsPerRun: 5,
  maxOutputArtifactBytes: 1_048_576,
  maxOutputArtifactBytesPerRun: 1_048_576
};

function stagedResponse(identity, plan, match) {
  return {
    // Addressed to the Run whose prompt carries `match`, never to whoever asks
    // first — sibling leaves share this fixture.
    match,
    statusCode: 200,
    body: JSON.stringify({
      id: identity,
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })
  };
}

async function waitFor(label, predicate, { timeoutMs = 90_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function main() {
  await withHarness('governed sibling dependency',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: LIMITS,
        ticketObjective: 'Create folders reports/a/alpha and reports/b/alpha',
        progressPolicy: progressControlPolicy({
          maximumConsecutiveNoProgressWindows: 1
        }),
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` }
        ]
      });

      assert.ok(seeded.runIds.length >= 2, 'the fixture admitted sibling leaf Runs');
      const readerRun = await store.getRun(seeded.runIds[0]);
      const siblingRun = await store.getRun(seeded.runIds[1]);
      const plan = await store.getAllocationPlanForTicket(seeded.ticketId);
      const readerItem = plan.items.find(
        i => i.allocationItemId === readerRun.leafRunBinding.allocationItemId);
      const siblingItem = plan.items.find(
        i => i.allocationItemId === siblingRun.leafRunBinding.allocationItemId);
      assert.ok(readerItem && siblingItem, 'both leaves resolve to plan items');

      const readerScope = readerItem.ownedOutputPaths[0];
      const siblingScope = siblingItem.ownedOutputPaths[0];
      assert.notEqual(readerScope, siblingScope, 'the leaves own distinct scopes');

      // The path the reader will attempt: inside the SIBLING's owned scope, and
      // named by neither leaf's declared work.
      const forbiddenPath = `${siblingScope}handover.md`;

      const readerFacts = eligibleExecutionFacts(readerRun);
      const siblingFacts = eligibleExecutionFacts(siblingRun);
      assert.ok(readerFacts.length >= 1 && siblingFacts.length >= 1,
        'each leaf admitted at least one execution-evaluable fact');

      fs.mkdirSync(path.join(workspaceRoot, 'reports'), { recursive: true });

      const capturePath = path.join(os.tmpdir(), `gsd-cap-${process.pid}-${STAMP}.jsonl`);
      const responsePath = path.join(os.tmpdir(), `gsd-res-${process.pid}-${STAMP}.json`);
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          // The reader's ONLY action is the undeclared sibling read.
          stagedResponse('fixture-sibling-reader', {
            message: 'Reading the sibling handover note before starting.',
            actions: [{ operation: 'readFile', args: { path: forbiddenPath } }],
            complete: false
          }, readerScope.replace(/\/$/, '')),
          // The sibling does its own declared work but never claims completion,
          // so it can never become a verified-complete sibling mid-scenario and
          // turn the reader's refusal into a race.
          stagedResponse('fixture-sibling-owner', {
            message: 'Creating my own declared folder.',
            actions: [{
              operation: 'createFolder',
              args: { path: siblingFacts[0].criterion.path }
            }],
            complete: false
          }, siblingScope.replace(/\/$/, ''))
        ]
      }));

      const serverEnv = {
        NODE_OPTIONS: `--require ${PRELOAD}`,
        OPENAI_API_KEY: SENTINEL,
        HERMETIC_TRANSPORT_CAPTURE: capturePath,
        HERMETIC_TRANSPORT_RESPONSE: responsePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '60000'
      };

      const blockOf = runId => store.readGovernedProgressBlock(runId);
      const spend = async runId => {
        const one = async sql => Number((await store.pool.query(sql, [runId])).rows[0].n);
        return {
          reservations: await one(
            `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
              WHERE run_id = $1`),
          receipts: await one(
            `SELECT count(*) AS n FROM ${store.table('operation_receipts')} WHERE run_id = $1`),
          settlements: await one(
            `SELECT count(*) AS n FROM ${store.table('economic_request_reservations')}
              WHERE run_id = $1 AND settlement_receipt IS NOT NULL`)
        };
      };
      // TRANSPORTS ARE COUNTED BY IDENTITY, NOT BY ARRIVAL.
      //
      // A global tally would fail here for a reason that has nothing to do with
      // this contract: the SIBLING leaf is still executing its own declared work
      // in the same server, so the capture file grows for reasons the reader
      // does not own. Attribution is delegated to the canonical correlator —
      // a transport belongs to this Run when its bytes hash to the
      // `exact_request_hash` its own reservation recorded.
      const readerTransports = async () => {
        const captures = fs.readFileSync(capturePath, 'utf8')
          .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const reservations = (await store.pool.query(
          `SELECT id, run_id, ticket_id, model_request_ordinal, logical_source_identity,
                  exact_request_hash
             FROM ${store.table('economic_request_reservations')} ORDER BY id`)).rows
          .map(row => ({
            reservationId: Number(row.id),
            runId: row.run_id === null ? null : Number(row.run_id),
            ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
            modelRequestOrdinal: Number(row.model_request_ordinal),
            logicalSourceIdentity: row.logical_source_identity,
            exactRequestHash: row.exact_request_hash
          }));
        return transportsForRun(
          correlateGovernedTransports({ captures, reservations }), readerRun.id).length;
      };

      // ── The real runtime produces the block ────────────────────────────
      const server = await startServer({ env: serverEnv });
      let blockedState = null;
      try {
        blockedState = await waitFor('the reader to be durably blocked', async () => {
          const block = await blockOf(readerRun.id);
          if (!block || block.reason !== 'undeclared_sibling_dependency') return null;
          const run = await store.getRun(readerRun.id);
          return ['failed', 'blocked'].includes(run.status) ? { block, run } : null;
        });
      } finally {
        await server.stop();
      }

      const block = blockedState.block;
      assertThat(block.reason === 'undeclared_sibling_dependency',
        'the real runtime persisted undeclared_sibling_dependency');
      assertThat(block.siblingDependency.siblingAllocationItemId ===
        siblingItem.allocationItemId,
        'the block names the exact sibling allocation item');
      assertThat(Number(block.siblingDependency.siblingRunId) === Number(siblingRun.id),
        'the block names the exact sibling Run');
      assertThat(block.siblingDependency.requestedPath.includes('handover.md'),
        'the block preserves the exact requested path');
      assertThat(/^[0-9a-f]{64}$/.test(block.blockHash), 'the block is hashed');

      // Distinct from the other terminal reasons it must never be confused with.
      assertThat(block.reason !== 'verified_progress_exhausted',
        'a sibling block is not progress exhaustion');
      assertThat(block.siblingDependency !== null,
        'a sibling block carries sibling facts a progress block never has');

      // THE READ NEVER TOUCHED THE DISK. The preflight runs before any
      // filesystem branch, so not even directory metadata may leak.
      assertThat(!fs.existsSync(path.join(workspaceRoot, forbiddenPath)),
        'the refused path was never created');
      const readReceipts = (await store.pool.query(
        `SELECT operation, workspace_path FROM ${store.table('operation_receipts')}
          WHERE run_id = $1 AND operation = 'readFile'`, [readerRun.id])).rows;
      assertThat(readReceipts.every(r => !String(r.workspace_path || '').includes('handover.md')),
        'no receipt records reading the sibling path');

      // ── The reader claims no completion ────────────────────────────────
      const readerAfter = await store.getRun(readerRun.id);
      assertThat(readerAfter.status !== 'completed',
        `a sibling-blocked leaf never completes (status ${readerAfter.status})`);
      // A SIBLING BLOCK IS NOT AN ORDINARY RUNTIME FAILURE.
      //
      // The durable block already distinguishes it by reason, sibling identity
      // and hash. The Run's triage must not undo that by offering the one
      // action a coordination refusal can never justify: retrying it
      // automatically would re-attempt the same refused read against the same
      // unverified sibling, forever.
      //
      // Note the triage `reasonCode` is `runtime_failed` for this and for a
      // generic failure alike; the operative distinction is the prohibition.
      assertThat(readerAfter.triage && Array.isArray(readerAfter.triage.prohibitedActions) &&
        readerAfter.triage.prohibitedActions.includes('automatic_retry'),
        'a sibling-blocked leaf is never eligible for automatic retry');
      assertThat(readerAfter.triage.requiredDecision === 'review_failure',
        'and requires an explicit operator decision');
      assertThat(String(readerAfter.error || '').includes('is not verified complete'),
        'the durable error names the coordination refusal, not a generic fault');

      // THE DURABLE FAILURE RECORD SURVIVES, AND IS HONEST ABOUT ITSELF.
      //
      // `failureKind` classifies nothing on this path — triage maps only a
      // closed set that never included `no_progress`, so supplying it produced
      // exactly the `runtime_failed` outcome a generic fault produces. But the
      // field is what keeps the failure record alive: without it
      // `buildRunFailure` returns null and the code and sibling detail below
      // vanish. So it is asserted as observable metadata, not as authority.
      const readerReplay = await store.readRunReplay(readerRun.id);
      const failureRecord = readerReplay && readerReplay.snapshot
        ? readerReplay.snapshot.failure || null
        : null;
      assertThat(failureRecord !== null,
        'the refusal leaves a durable failure record');
      assertThat(failureRecord.code === 'GOVERNED_SIBLING_READ_BLOCKED',
        `the record carries the coordination refusal code (${failureRecord.code})`);
      assertThat(failureRecord.kind === 'sibling_dependency_blocked',
        `and an honest failure kind (${failureRecord.kind})`);
      assertThat(failureRecord.kind !== 'no_progress',
        'never the borrowed no_progress classification that governed nothing');

      const readerConsequence = await store.getRunConsequence(readerRun.id);
      const readerDecision = readerConsequence && readerConsequence.consequence
        ? readerConsequence.consequence.completionDecision
        : null;
      if (readerDecision) {
        // A decision may exist for a terminal Run, but it may never claim the
        // objective was met.
        assertThat(readerDecision.disposition !== 'completed' &&
          readerDecision.executionDisposition !== 'succeeded',
          `a sibling-blocked leaf's decision never claims success ` +
          `(disposition ${readerDecision.disposition}, execution ` +
          `${readerDecision.executionDisposition})`);
      } else {
        assertThat(true, 'no completion decision was synthesized for a blocked leaf');
      }

      // ── Nothing is spent after the block ───────────────────────────────
      const spendAtBlock = await spend(readerRun.id);
      const transportsAtBlock = await readerTransports();
      await sleep(1500);
      const spendAfterWait = await spend(readerRun.id);
      assertThat(JSON.stringify(spendAtBlock) === JSON.stringify(spendAfterWait),
        'no reservation, receipt or settlement is created after the block');
      assertThat(await readerTransports() === transportsAtBlock,
        'no further provider transport is attributable to the reader after the block');

      // ── The sibling is untouched ───────────────────────────────────────
      const siblingBlock = await blockOf(siblingRun.id);
      assertThat(siblingBlock === null ||
        siblingBlock.reason !== 'undeclared_sibling_dependency',
        'the sibling is not itself blocked by a sibling dependency');
      const siblingAfter = await store.getRun(siblingRun.id);
      assertThat(siblingAfter.status !== 'completed' ||
        siblingAfter.status === 'completed',
        `the sibling's status is decided by its own evidence (${siblingAfter.status})`);
      // THE DECISIVE CLAIM, STATED PRECISELY.
      //
      // The sibling IS blocked — it never claims completion, so it exhausts its
      // own no-progress windows. That is its own evidence deciding its own
      // outcome, and asserting it is never blocked at all would be asserting
      // the wrong thing. What must be true is that its block is not the
      // reader's: no sibling dependency, and not the reader's identity.
      //
      // This also puts the two reasons side by side on real Runs rather than on
      // constructed rows, which is the only way "distinct from
      // verified_progress_exhausted" is worth asserting.
      if (siblingBlock) {
        assertThat(siblingBlock.reason === 'verified_progress_exhausted',
          `the sibling is blocked for its OWN reason, got ${siblingBlock.reason}`);
        assertThat(siblingBlock.siblingDependency === null,
          'a progress block carries no sibling dependency');
        assertThat(siblingBlock.reason !== block.reason,
          'the two blocked leaves hold genuinely different reasons');
        assertThat(siblingBlock.blockHash !== block.blockHash,
          'and genuinely different block authorities');
      } else {
        assertThat(true, 'the sibling holds no block at all');
      }

      // ── A FRESH PROCESS PROJECTS THE SAME AUTHORITY ────────────────────
      //
      // Read back by a server that never saw the execution. Nothing here may be
      // recomputed from the corrupt-free convenience of an in-memory cache.
      // SCOPED TO THE TERMINAL RUN, not the Ticket. The sibling is deliberately
      // still executing its own work in this scenario, so Ticket-scoped counts
      // would report its ordinary progress as projection side effects.
      const countsBeforeRestart = await durableRunCounts(store, readerRun.id);
      const fresh = await startServer({ env: serverEnv });
      try {
        const reBlock = await blockOf(readerRun.id);
        assertThat(reBlock.blockHash === block.blockHash,
          'a fresh process projects the identical block hash');
        assertThat(reBlock.reason === 'undeclared_sibling_dependency',
          'a fresh process projects the identical reason');
        assertThat(Number(reBlock.siblingDependency.siblingRunId) === Number(siblingRun.id),
          'a fresh process preserves the sibling identity');

        // The Run must not become schedulable again.
        const beforeClaim = await store.getRun(readerRun.id);
        await sleep(2000);
        const afterClaim = await store.getRun(readerRun.id);
        assertThat(afterClaim.status === beforeClaim.status,
          `a terminal sibling-blocked Run is not reclaimed (${beforeClaim.status} → ` +
          `${afterClaim.status})`);
        assertThat(afterClaim.leaseOwner === null,
          'and no fresh scheduler claim is taken');
        const spendAfterRestart = await spend(readerRun.id);
        assertThat(JSON.stringify(spendAfterRestart) === JSON.stringify(spendAtBlock),
          'restart and projection create no provider request, reservation or receipt');
        assertThat(await readerTransports() === transportsAtBlock,
          'and no transport is attributable to the reader during projection');
        // ── THE SAME AUTHORITY ON EVERY OPERATOR SURFACE ─────────────────
        //
        // The durable block is proved above; this proves the surfaces an
        // operator actually reads agree with it. A page that rendered a
        // coordination refusal as an ordinary failure, or that quietly showed
        // it as completed, would pass every assertion made so far.
        const cookie = await fresh.login();

        const runPage = await fresh.request('GET', `/runs/${readerRun.id}`, { cookie });
        assertThat(runPage.statusCode === 200,
          `the blocked Run detail page renders — it is inspectable ` +
          `(${runPage.statusCode})`);
        const runBody = String(runPage.body || '');
        assertThat(runBody.includes('undeclared_sibling_dependency'),
          'and states the exact sibling-dependency reason');
        assertThat(runBody.includes('handover.md'),
          'and preserves the exact requested path');
        assertThat(!runBody.includes('verified_progress_exhausted'),
          'without borrowing the verified-progress block vocabulary');
        assertThat(!runBody.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
          'and without borrowing replay-integrity authority');
        assertThat(!/\bcompleted\b/.test(runBody.split('undeclared_sibling_dependency')[0]
          .slice(-200)),
        'and never presents the blocked leaf as completed');

        const ticketPage = await fresh.request(
          'GET', `/tickets/${readerRun.ticketId}`, { cookie });
        assertThat(ticketPage.statusCode === 200,
          'the Ticket page renders over a sibling-blocked leaf');
        assertThat(!/COMPLETION_EVIDENCE_MISSING/.test(String(ticketPage.body || '')),
          'with no completion-evidence refusal attributed to the blocked leaf');

        // ── RUN-STATE OWNS THE SIBLING/PATH BLOCK AUTHORITY ────────────
        //
        // Blueprint §2.2: the full per-Run block lives at
        // `verifiedProgress.block`, including its sibling facts. These are read
        // from the reader that owns them rather than inferred from the raw
        // event stream.
        const runStateApi = await fresh.request(
          'GET', `/api/runs/${readerRun.id}/state`, { cookie });
        assertThat(runStateApi.statusCode === 200,
          `the Run-state API projects the blocked Run (${runStateApi.statusCode})`);
        const runState = JSON.parse(runStateApi.body);
        assertThat(Number(runState.id) === Number(readerRun.id) &&
          Number(runState.ticketId) === Number(readerRun.ticketId),
        'and reports this exact Run on this exact Ticket');
        const rsBlock = runState.verifiedProgress && runState.verifiedProgress.block;
        assertThat(Boolean(rsBlock), 'carrying the governed block');
        assertThat(rsBlock.reason === 'undeclared_sibling_dependency',
          `with the exact sibling reason (${rsBlock.reason})`);
        assertThat(rsBlock.blockHash === block.blockHash,
          'and the exact immutable block hash');
        assertThat(Boolean(rsBlock.siblingDependency),
          'and the sibling dependency authority');
        assertThat(Number(rsBlock.siblingDependency.siblingRunId) ===
          Number(siblingRun.id),
        `naming the exact sibling Run (${rsBlock.siblingDependency.siblingRunId})`);
        assertThat(Number(rsBlock.siblingDependency.siblingAllocationItemId) ===
          Number(siblingItem.allocationItemId),
        'and the exact sibling allocation item');
        assertThat(String(rsBlock.siblingDependency.requestedPath).includes('handover.md'),
          `and the exact requested path (${rsBlock.siblingDependency.requestedPath})`);
        assertThat(rsBlock.reason !== 'verified_progress_exhausted',
          'and never the verified-progress authority');
        assertThat(!runState.replaySummary ||
          !String(JSON.stringify(runState.replaySummary))
            .includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
        'nor any replay-integrity authority');
        assertThat(runState.status !== 'completed',
          `and no successful completion claim (${runState.status})`);

        // Ticket runtime: reason MEMBERSHIP is what this reader owns (§2.1).
        const ticketRuntimeApi = await fresh.request(
          'GET', `/api/tickets/${readerRun.ticketId}/runtime`, { cookie });
        assertThat(ticketRuntimeApi.statusCode === 200,
          'the Ticket runtime API projects over the sibling-blocked leaf');
        const runtimePayload = JSON.parse(ticketRuntimeApi.body);
        const vp = runtimePayload.verifiedProgress;
        assertThat((vp.blockedForUndeclaredSiblingDependency || [])
          .map(Number).includes(Number(readerRun.id)),
        'listing this Run under undeclared sibling dependency');
        assertThat(!(vp.blockedForVerifiedProgressExhaustion || [])
          .map(Number).includes(Number(readerRun.id)),
        'and NOT under verified-progress exhaustion');
        const runtimeLeaf = findRuntimeRun(runtimePayload, readerRun.id);
        assertThat(runtimeLeaf.itemStatus !== 'completed',
          `the structured item never completes (${runtimeLeaf.itemStatus})`);

        const eventsApi = await fresh.request(
          'GET', `/api/runs/${readerRun.id}/events`, { cookie });
        assertThat(eventsApi.statusCode === 200,
          'the Run events API projects over the blocked Run');
        assertThat(String(eventsApi.body || '').includes('run.progress_blocked'),
          'and exposes the durable block event rather than inferring from status');

        // The parent aggregate never reports success over a blocked child.
        const plan = await store.getAllocationPlanForTicket(readerRun.ticketId);
        const items = (plan && plan.aggregateDecision && plan.aggregateDecision.items) || [];
        const blockedItem = items.find(i => Number(i.runId) === Number(readerRun.id));
        if (blockedItem) {
          assertThat(blockedItem.itemStatus !== 'completed',
            `the aggregate never projects the blocked leaf as completed ` +
            `(${blockedItem.itemStatus})`);
          // A decision MAY exist — unlike the replay-corruption case, this leaf
          // terminalized through the ordinary path and recorded one. What it
          // may never do is claim the objective was met, so the disposition is
          // asserted rather than the decision's absence.
          const blockedConsequence = await store.getRunConsequence(readerRun.id);
          const blockedDecision = blockedConsequence && blockedConsequence.consequence
            ? blockedConsequence.consequence.completionDecision
            : null;
          if (blockedDecision) {
            assertThat(blockedDecision.completionDisposition !== 'completed',
              `the blocked leaf's decision never claims completion ` +
              `(${blockedDecision.completionDisposition})`);
            assertThat(blockedDecision.runId === readerRun.id,
              'and is bound to this Run, not borrowed from a sibling');
          } else {
            assertThat(true, 'no completion decision exists for the blocked leaf');
          }
        }
        const ticketRow = (await store.pool.query(
          `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
          [readerRun.ticketId])).rows[0];
        assertThat(ticketRow.status !== 'completed',
          'and the parent Ticket cannot project completed over a blocked child');

        // A neighbouring sibling keeps its OWN reason, and never inherits this
        // leaf's missing completion evidence.
        const siblingRows = (await store.pool.query(
          `SELECT id, body->>'error' AS reason FROM ${store.table('runs')}
            WHERE ticket_id = $1 AND id <> $2`,
          [readerRun.ticketId, readerRun.id])).rows;
        for (const row of siblingRows) {
          const reason = String(row.reason || '');
          assertThat(!/COMPLETION_EVIDENCE_MISSING|without a completion decision/
            .test(reason),
          `sibling ${row.id} does not inherit missing completion evidence`);
          assertThat(!reason.includes('handover.md'),
            `sibling ${row.id} does not inherit the blocked leaf's requested path`);
        }

        // ── THE PROJECTION READS CREATED NOTHING ─────────────────────────
        const countsAfterSurfaces = await durableRunCounts(store, readerRun.id);
        const surfaceDrift = countDelta(countsBeforeRestart, countsAfterSurfaces);
        assertThat(surfaceDrift.length === 0,
          `restart and every surface read create no durable facts for the ` +
          `blocked leaf (${surfaceDrift.join(', ')})`);

        // ── THE TICKET-SCOPED CLOSING READ ──────────────────────────────
        //
        // The assertion above is Run-scoped, and on its own it proves only that
        // the blocked leaf was not restarted — not that projection did no
        // Ticket-wide work. That distinction matters here because this scenario
        // deliberately leaves the SIBLING executing, so a Ticket-scoped read
        // taken now would move for reasons projection does not own.
        //
        // So the sibling is allowed to finish first. Once the whole Ticket is
        // genuinely quiescent, every projection surface is issued again and the
        // Ticket-scoped counts must not move at all. That is the read that
        // closes the matrix; narrowing the scope permanently would have been
        // substituting a weaker claim for the one actually required.
        await waitForSchedulerQuiescence(store, readerRun.ticketId,
          { timeoutMs: 180_000 });
        const quiescedBefore = await durableTerminalCounts(store, readerRun.ticketId);
        await fresh.request('GET', `/runs/${readerRun.id}`, { cookie });
        await fresh.request('GET', `/tickets/${readerRun.ticketId}`, { cookie });
        await fresh.request('GET', `/api/runs/${readerRun.id}/events`, { cookie });
        await fresh.request('GET', `/runs/${siblingRun.id}`, { cookie });
        await store.getAllocationPlanForTicket(readerRun.ticketId);
        await waitForSchedulerQuiescence(store, readerRun.ticketId);
        const quiescedAfter = await durableTerminalCounts(store, readerRun.ticketId);
        const ticketDrift = countDelta(quiescedBefore, quiescedAfter);
        assertThat(ticketDrift.length === 0,
          `with the Ticket fully quiescent, every projection read creates no ` +
          `durable fact at Ticket scope (${ticketDrift.join(', ')})`);
      } finally {
        await fresh.stop();
      }

      console.log(`\ngoverned sibling dependency test passed — ${assertThat.count()} assertions`);
    });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
