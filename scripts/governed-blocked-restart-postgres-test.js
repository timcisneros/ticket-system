#!/usr/bin/env node
'use strict';

// Tranche 5 — a persisted progress block is a HISTORICAL STOP, not a cached
// opinion to be recomputed.
//
// The withholding suite proves a Run stops when it earns no verified progress.
// This proves the stop survives the machine dying: after a crash, the recovered
// process must read the decision that actually stopped the Run rather than
// forming a new one, and must spend nothing further doing so.
//
// WHY RE-DERIVING WOULD BE WRONG, NOT MERELY WASTEFUL. A block is bound to a
// durable cutoff — the exact rows visible when the decision was taken. Evaluate
// it again later and the inputs have moved: sibling Runs have committed work,
// the workspace has changed, the operator may have edited progress policy. A
// recomputed answer would be an answer to a different question, and if it came
// out "continue" the Run would resume spending against tolerance it had already
// exhausted. The block's own hashes are what make "the same stop" checkable.
//
// The interruption fires after the block commits and before the worker returns,
// so the crash lands in the narrow window where a block exists but nothing has
// acted on it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  countDelta,
  durableRunCounts,
  findRuntimeRun,
  durableTerminalCounts,
  waitForSchedulerQuiescence
} = require('./fixtures/terminal-projection-restart');
const {
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

const STAMP = `gbr-${Date.now()}`;
const ACTOR = 'governed-blocked-restart-test';
const HERMETIC = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const FAULT = path.join(__dirname, 'fixtures', 'governed-fault-injection-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';
// DISCRIMINATE THE LEAF, NOT THE FOLDER. The planner Run's own governed request
// also names `reports/planner` — it is that item's owned output path — so
// matching the root alone lets a planner request be counted as this Run's
// transport, and lets the planner consume a response staged for the leaf. The
// leaf's declared postcondition path appears only in the leaf's prompt.
const OWNED_ROOT = 'reports/planner';
const LEAF_MARKER = 'reports/planner/alpha';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIMITS = {
  maxExecutionSteps: 6,
  // Two permitted, so withholding is the progress gate's doing and not the
  // request ceiling's.
  maxModelRequestsPerRun: 2,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 600_000,
  maxAttempts: 3,
  maxProcessOperationsPerRun: 5,
  maxBrowserOperationsPerRun: 5,
  maxOutputArtifactBytes: 1_048_576,
  maxOutputArtifactBytesPerRun: 1_048_576
};

function staged(identity, plan) {
  return {
    match: LEAF_MARKER,
    statusCode: 200,
    body: JSON.stringify({
      id: identity,
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })
  };
}

async function main() {
  await withHarness('governed blocked restart',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: LIMITS,
        progressPolicy: progressControlPolicy({
          maximumConsecutiveNoProgressWindows: 1
        }),
        leafPostconditions: (item, owned) => [
          { type: 'folder_exists', path: `${owned}/alpha` },
          { type: 'folder_exists', path: `${owned}/beta` }
        ]
      });
      const runId = seeded.runIds[0];
      const run = await store.getRun(runId);
      const facts = eligibleExecutionFacts(run);
      const factA = facts.find(f => f.criterion.path.endsWith('/alpha'));
      fs.mkdirSync(path.join(workspaceRoot, OWNED_ROOT), { recursive: true });

      const tmp = suffix => path.join(os.tmpdir(), `gbr-${suffix}-${process.pid}-${STAMP}`);
      const capturePath = tmp('cap');
      const responsePath = tmp('res');
      const markerPath = tmp('marker');
      const statePath = tmp('state');
      const servedPath = tmp('served');
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(markerPath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          // Real, permitted work that satisfies NO admitted fact.
          staged('fixture-blocked-response-1', {
            message: 'Creating a scratch folder.',
            actions: [{ operation: 'createFolder', args: { path: `${OWNED_ROOT}/gamma` } }],
            complete: false
          }),
          // Staged so a Run that wrongly resumed would SUCCEED in getting an
          // answer. Refusing here would look like a transport fault instead of
          // the authority failure it would actually be.
          staged('fixture-blocked-response-2-must-not-be-served', {
            message: 'This must never be requested.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          })
        ]
      }));

      const env = {
        NODE_OPTIONS: `--require ${HERMETIC} --require ${FAULT}`,
        OPENAI_API_KEY: SENTINEL,
        HERMETIC_TRANSPORT_CAPTURE: capturePath,
        HERMETIC_TRANSPORT_RESPONSE: responsePath,
        HERMETIC_TRANSPORT_SERVED: servedPath,
        GOVERNED_FAULT_MARKER: markerPath,
        GOVERNED_FAULT_STATE: statePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        RUN_LEASE_DURATION_MS: '4000'
      };

      const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => String(entry.body || '').includes(LEAF_MARKER));
      const chargesOf = async () => (await store.pool.query(
        `SELECT source_identity FROM ${store.table('run_budget_charges')}
          WHERE run_id = $1 AND dimension = 'model_request' ORDER BY id`, [runId])).rows;
      const economicOf = async () => (await store.pool.query(
        `SELECT logical_source_identity, model_request_ordinal
           FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;
      const receiptsOf = async () => (await store.pool.query(
        `SELECT id, workspace_path FROM ${store.table('operation_receipts')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;
      const blockEventsOf = async () => (await store.pool.query(
        `SELECT id FROM ${store.table('events')}
          WHERE run_id = $1 AND type = 'run.progress_blocked' ORDER BY id`, [runId])).rows;

      // ── Server 1: crash immediately after the block commits ─────────────
      const first = await startServer({
        env: { ...env, GOVERNED_FAULT_BOUNDARY: 'after_progress_block_commit' }
      });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_C_REACHED')) break;
          await sleep(500);
        }
        assertThat(fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_C_REACHED'),
          'the EXACT boundary was reached: the block committed, the worker never returned');
        await sleep(2000);
      } finally {
        try { await first.stop(); } catch (_) { /* crashed at the boundary */ }
      }

      // ── The block as it was written ─────────────────────────────────────
      const before = await store.getRun(runId);
      const blockBefore = before.governedProgressBlock;
      assertThat(Boolean(blockBefore), 'a canonical progress block persisted before the crash');
      assertThat(blockBefore.reason === 'verified_progress_exhausted',
        'the stored reason is verified_progress_exhausted');
      const chargesBefore = await chargesOf();
      const economicBefore = await economicOf();
      const receiptsBefore = await receiptsOf();
      const evidenceBefore = await store.readGovernedPostconditionEvidence(runId);
      const blockEventsBefore = await blockEventsOf();
      const capturesBefore = capturesForRun();
      const replayBefore = (await store.readRunReplay(runId) || {}).snapshot || {};

      // ── Server 2: restart. The stop is read, not retaken ────────────────
      const countsBeforeRestart = await durableTerminalCounts(store, run.ticketId);
      const leafBeforeRestart = await durableRunCounts(store, runId);
      const second = await startServer({ env });
      try {
        // DURABLE QUIESCENCE, NOT A FIXED SLEEP. A sleep asserts that nothing
        // happened during an arbitrary interval, which is the one thing it
        // cannot know; this waits until no Run on the Ticket holds a lease or
        // is pending/running across consecutive independent reads.
        await waitForSchedulerQuiescence(store, run.ticketId);

        const after = await store.getRun(runId);
        const blockAfter = after.governedProgressBlock;
        assertThat(Boolean(blockAfter), 'the block is still present after restart');

        // Every identifying field of the historical decision, unchanged.
        assertThat(blockAfter.blockHash === blockBefore.blockHash,
          'the exact block hash is retained');
        assertThat(blockAfter.verifiedProgressProjectionHash ===
          blockBefore.verifiedProgressProjectionHash,
        'the exact projection hash is retained');
        assertThat(blockAfter.churnDecisionHash === blockBefore.churnDecisionHash,
          'the exact churn-decision hash is retained');
        assertThat(blockAfter.reason === blockBefore.reason,
          'the closed reason is retained');
        assertThat(JSON.stringify(blockAfter.cutoff) === JSON.stringify(blockBefore.cutoff),
          'the exact cutoff document is retained — NO fresh cutoff was captured');
        assertThat(blockAfter.cutoff.evaluatedAt === blockBefore.cutoff.evaluatedAt,
          'evaluatedAt is retained — the decision keeps its own instant');
        assertThat(JSON.stringify(blockAfter.cumulativeResources) ===
          JSON.stringify(blockBefore.cumulativeResources),
        'cumulative totals are retained');
        assertThat(blockAfter.consecutiveNoProgressWindows ===
          blockBefore.consecutiveNoProgressWindows,
        'the no-progress count is retained');
        assertThat(blockAfter.blockedAt === blockBefore.blockedAt,
          'the block keeps its original blockedAt');
        assertThat(blockAfter.executionEpochAt === blockBefore.executionEpochAt,
          'the immutable execution epoch is retained');
        assertThat(blockAfter.progressPolicyHash === blockBefore.progressPolicyHash,
          'the block still names the policy captured at admission');

        // ── EACH TERMINAL STATE KEEPS ITS OWN AUTHORITY ──────────────────
        //
        // Four non-success outcomes exist and none may borrow another's
        // evidence: successful completion answers to a completion decision, a
        // progress block to governedProgressBlock, a sibling-dependency block
        // to its own sibling/path authority, and a replay-integrity failure to
        // the relational integrity disposition. Collapsing them would let a Run
        // stopped for churn be explained as a corrupt transcript, or the
        // reverse — and an operator would have no way to tell.
        assertThat(blockAfter.siblingDependency === null ||
          blockAfter.siblingDependency === undefined,
        'a progress block carries NO sibling dependency — that is a different authority');
        assertThat(!after.integrityFailureCode,
          'and no integrity-failure disposition — this Run is blocked, not corrupt');
        const blockedDecisions = (await store.pool.query(
          `SELECT consequence FROM ${store.table('run_consequences')}
            WHERE run_id = $1`, [runId])).rows
          .filter(row => row.consequence && row.consequence.completionDecision);
        // A blocked leaf DOES receive a completion decision — with disposition
        // `blocked`, which the contract maps to `completion_blocked`. What it
        // must never receive is a decision claiming success, and the churn
        // reason lives in the progress block rather than in that decision.
        assertThat(blockedDecisions.every(row =>
          row.consequence.completionDecision.completionDisposition !== 'completed'),
        'no completion decision claims success for a blocked leaf');
        assertThat(blockedDecisions.every(row =>
          !String(JSON.stringify(row.consequence.completionDecision))
            .includes('verified_progress_exhausted')),
        'the churn reason lives in the progress block, not in the completion decision');
        const blockedPlan = await store.getAllocationPlanForTicket(run.ticketId);
        const blockedItems = (blockedPlan && blockedPlan.aggregateDecision &&
          blockedPlan.aggregateDecision.items) || [];
        const blockedItem = blockedItems.find(item =>
          Number(item.runId) === Number(runId));
        assertThat(!blockedItem || blockedItem.itemStatus !== 'completed',
          'and it never projects as completed');

        // ── ZERO further governed spending ────────────────────────────────
        assertThat((await chargesOf()).length === chargesBefore.length,
          'no additional runtime-budget charge');
        assertThat((await economicOf()).length === economicBefore.length,
          'no additional economic reservation');
        assertThat((await economicOf()).every((row, index) =>
          row.model_request_ordinal === economicBefore[index].model_request_ordinal),
        'no new request ordinal was derived');
        const replayAfter = (await store.readRunReplay(runId) || {}).snapshot || {};
        assertThat((replayAfter.providerRequests || []).length ===
          (replayBefore.providerRequests || []).length,
        'no additional provider-request replay item');
        assertThat((replayAfter.modelResponses || []).length ===
          (replayBefore.modelResponses || []).length,
        'no additional model-response replay item');
        assertThat(capturesForRun().length === capturesBefore.length,
          'no transport occurred after the block');
        assertThat(!JSON.stringify(replayAfter).includes('must-not-be-served'),
          'the staged second response never entered the Run');
        assertThat((await receiptsOf()).length === receiptsBefore.length,
          'no additional workspace operation or receipt');
        assertThat((await store.readGovernedPostconditionEvidence(runId)).length ===
          evidenceBefore.length,
        'no additional evidence row');
        assertThat((await blockEventsOf()).length === blockEventsBefore.length,
          'the block event is NOT duplicated');

        // ── Drift does not rewrite history ────────────────────────────────
        //
        // The workspace has moved on since the decision (gamma exists), and a
        // recomputed verdict would be answering a different question. The block
        // is the decision of record.
        assertThat(fs.existsSync(path.join(workspaceRoot, `${OWNED_ROOT}/gamma`)),
          'the workspace HAS changed since the block was taken');
        const transitions = await store.readGovernedFactTransitions(runId);
        assertThat(transitions.newlyVerifiedFactIdentities.length === 0,
          'still no fact was ever newly verified');

        console.log(`  (${assertThat.count()} blocked restart assertions)`);
        // ── THE PROJECTED STATUS IS NON-SUCCESS ────────────────────────
        //
        // The decision's disposition is asserted above; this asserts what the
        // PROJECTION makes of it. Without this, a projector mapping `blocked`
        // to `completed` would satisfy every other assertion here — the block,
        // its hashes and the decision would all still be correct while the
        // Ticket claimed success over them.
        const projectedPlan = await store.getAllocationPlanForTicket(run.ticketId);
        const projectedItems = (projectedPlan && projectedPlan.aggregateDecision &&
          projectedPlan.aggregateDecision.items) || [];
        const projectedLeaf = projectedItems.find(item => Number(item.runId) === Number(runId));
        if (projectedLeaf) {
          assertThat(projectedLeaf.itemStatus !== 'completed',
            `the blocked leaf never projects as completed (${projectedLeaf.itemStatus})`);
        }
        const projectedTicket = (await store.pool.query(
          `SELECT status FROM ${store.table('tickets')} WHERE id = $1`,
          [run.ticketId])).rows[0];
        assertThat(projectedTicket.status !== 'completed',
          `and the parent Ticket cannot project completed over it ` +
          `(${projectedTicket.status})`);

        // ── EVERY APPLICABLE OPERATOR SURFACE ──────────────────────────
        //
        // The durable block is proved above. These are the surfaces an operator
        // actually reads, and each must present the governed progress-block
        // authority without borrowing another class.
        const cookie = await second.login();

        const runPage = await second.request('GET', `/runs/${runId}`, { cookie });
        assertThat(runPage.statusCode === 200,
          `the blocked Run detail page renders (${runPage.statusCode})`);
        const runBody = String(runPage.body || '');
        assertThat(runBody.includes('verified_progress_exhausted'),
          'and states the exact governed progress-block reason');
        assertThat(!runBody.includes('undeclared_sibling_dependency'),
          'without borrowing sibling-dependency authority');
        assertThat(!runBody.includes('replay_unavailable_integrity_failure') &&
          !runBody.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
        'and without borrowing replay-integrity authority');

        const ticketPage = await second.request(
          'GET', `/tickets/${run.ticketId}`, { cookie });
        assertThat(ticketPage.statusCode === 200,
          'the Ticket page renders over a progress-blocked leaf');
        assertThat(!/COMPLETION_EVIDENCE_MISSING/.test(String(ticketPage.body || '')),
          'with no completion-evidence refusal attributed to it');

        // ── THE ACTUAL TICKET RUNTIME API, SCOPED TO THIS RUN ──────────
        //
        // `/api/tickets/:id/runtime` is the real Ticket API — there is no
        // `GET /api/tickets/:id`. Its payload reports every Run, so the target
        // leaf is located by Run ID and only its own fields are inspected; a
        // sibling's truthful reason must neither satisfy nor fail this.
        const ticketRuntimeApi = await second.request(
          'GET', `/api/tickets/${run.ticketId}/runtime`, { cookie });
        assertThat(ticketRuntimeApi.statusCode === 200,
          `the Ticket runtime API projects over a blocked leaf ` +
          `(${ticketRuntimeApi.statusCode})`);
        const runtimePayload = JSON.parse(ticketRuntimeApi.body);
        const runtimeLeaf = findRuntimeRun(runtimePayload, runId);
        assertThat(runtimeLeaf.itemStatus !== 'completed',
          `the Ticket runtime API never reports the blocked leaf completed ` +
          `(${runtimeLeaf.itemStatus})`);
        assertThat(runtimeLeaf.dispositionReason !== 'completion_verified',
          'and never claims verified completion for it');
        assertThat(runtimeLeaf.runId === runId,
          'and the inspected entry is this Run, not a sibling');

        // ── BLOCK AUTHORITY LIVES IN `verifiedProgress`, NOT IN THE ITEM ───
        //
        // Two different hashes, and conflating them was the gap this closes.
        // `structuredAllocationLeafExecution.items[].completionDecisionHash`
        // identifies the completion DECISION. The governed progress block's own
        // immutable `blockHash` is projected separately by `projectBlock`
        // through `readTicketVerifiedProgressProjection`, surfaced here as
        // `verifiedProgress`. A reader that exposed only the decision hash
        // would carry no block authority at all.
        const vp = runtimePayload.verifiedProgress;
        assertThat(Boolean(vp), 'the Ticket runtime API carries a verifiedProgress projection');

        // WHAT THIS READER ACTUALLY OWNS. The ticket-level projection is a
        // SUMMARY: run IDs grouped by closed stop reason, deliberately named
        // per reason rather than as one "blocked" count because the reasons
        // call for different human responses. It does NOT carry each Run's
        // `blockHash` — that is the RUN-level `projectBlock`, asserted at its
        // own owner in verified-progress-projection-postgres-test.
        //
        // So the block authority this API owns is REASON MEMBERSHIP, and it is
        // asserted as such. Claiming a blockHash here would assert a field this
        // reader does not expose.
        assertThat(Array.isArray(vp.blockedForVerifiedProgressExhaustion) &&
          vp.blockedForVerifiedProgressExhaustion.map(Number).includes(Number(runId)),
        'and lists this Run under verified-progress exhaustion');
        assertThat(!(vp.blockedForUndeclaredSiblingDependency || [])
          .map(Number).includes(Number(runId)),
        'and NOT under sibling dependency — the reasons are not interchangeable');
        assertThat(!(vp.blockedForCumulativeExecutionDuration || [])
          .map(Number).includes(Number(runId)),
        'nor under duration exhaustion');

        // The same authority through the Run-state API, which is a DIFFERENT
        // reader from the events endpoint below and may not stand in for it.
        const runStateApi = await second.request(
          'GET', `/api/runs/${runId}/state`, { cookie });
        assertThat(runStateApi.statusCode === 200,
          `the Run-state API projects the blocked Run (${runStateApi.statusCode})`);
        // The Run-state payload is the Run itself, flat — `id`, `ticketId`,
        // `status` — not a wrapper. Identity is asserted so this cannot drift
        // into reading whichever Run the route happened to return.
        const runState = JSON.parse(runStateApi.body);
        assertThat(Number(runState.id) === Number(runId) &&
          Number(runState.ticketId) === Number(run.ticketId),
        'and reports this exact Run on this exact Ticket');
        assertThat(runState.status !== 'completed',
          `with a non-success disposition (${runState.status})`);
        // ── RUN-STATE OWNS THE FULL PER-RUN BLOCK ──────────────────────
        //
        // Blueprint §2.2: this reader carries the complete governed block at
        // `verifiedProgress.block`. An earlier revision searched for a
        // top-level `governedProgressBlock`, did not find one, and recorded the
        // authority as absent; that conclusion is corrected in
        // docs/TERMINAL_PROJECTION_READER_CONTRACTS.md §9.
        assertThat(runState.verifiedProgress &&
          Number(runState.verifiedProgress.runId) === Number(runId),
        'Run-state carries a per-Run verifiedProgress projection for this Run');
        const rsBlock = runState.verifiedProgress.block;
        assertThat(Boolean(rsBlock),
          'and the full governed progress block');
        assertThat(rsBlock.blockHash === blockBefore.blockHash,
          `preserving the EXACT immutable block hash (${rsBlock.blockHash})`);
        assertThat(rsBlock.reason === 'verified_progress_exhausted',
          `and the exact reason (${rsBlock.reason})`);
        assertThat(rsBlock.decision === 'blocked',
          `and the churn decision (${rsBlock.decision})`);
        assertThat(rsBlock.churnDecisionHash === blockBefore.churnDecisionHash &&
          rsBlock.verifiedProgressProjectionHash ===
            blockBefore.verifiedProgressProjectionHash &&
          rsBlock.progressPolicyHash === blockBefore.progressPolicyHash,
        'and the exact churn, projection and policy authority hashes');
        assertThat(rsBlock.siblingDependency === null ||
          rsBlock.siblingDependency === undefined,
        'with NO sibling-dependency authority — a different block class');
        assertThat(!runState.replaySummary ||
          !String(JSON.stringify(runState.replaySummary))
            .includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
        'and no replay-integrity authority');
        assertThat(runState.status !== 'completed',
          `and no successful completion claim (${runState.status})`);

        // THE TWO HASHES ARE NOT THE SAME AUTHORITY. Blueprint §1/§9.
        assertThat(rsBlock.blockHash !== runtimeLeaf.completionDecisionHash,
          'the governed block hash is distinct from the completion-decision hash');

        // Structured item result, from the reader that owns it.
        assertThat(runtimeLeaf.itemStatus === 'failed',
          `the structured item result is failed (${runtimeLeaf.itemStatus})`);
        // RECONCILIATION NOW CARRIES THE GOVERNED BLOCK AUTHORITY.
        //
        // Previously this reader could not distinguish a governed block from an
        // ordinary unsuccessful run: a blocked leaf's completion decision says
        // `incomplete` / `RUN_EXECUTION_FAILED`, exactly what a plain failure
        // says, and the durable block was never passed to
        // `deriveLeafItemDisposition`. It is now, so the item names the
        // authority that actually stopped the Run.
        //
        // `completion_blocked` is deliberately NOT reused: production already
        // emits it for VERIFICATION_UNAVAILABLE and infrastructure failure, and
        // collapsing the two would make "the verifier could not run" and "the
        // coordination controls stopped this Run" the same fact.
        assertThat(runtimeLeaf.dispositionReason === 'governed_progress_blocked',
          `the item names the governed progress block ` +
          `(${runtimeLeaf.dispositionReason})`);
        assertThat(runtimeLeaf.dispositionReason !== 'completion_unsuccessful',
          'and is no longer indistinguishable from an ordinary failure');
        assertThat(runtimeLeaf.dispositionReason !== 'completion_blocked',
          'nor borrows the verification-unavailable blocked reason');
        assertThat(!Object.prototype.hasOwnProperty.call(runtimeLeaf, 'requestedPath') &&
          !Object.prototype.hasOwnProperty.call(runtimeLeaf, 'siblingAllocationItemId'),
        'and no sibling item or path fields');

        const eventsApi = await second.request(
          'GET', `/api/runs/${runId}/events`, { cookie });
        assertThat(eventsApi.statusCode === 200,
          'the Run events API projects over the blocked Run');
        assertThat(String(eventsApi.body || '').includes('run.progress_blocked'),
          'and exposes the durable block event rather than inferring from status');

        // AUTOMATIC RETRY IS PROHIBITED BY ITS ACTUAL OWNER — the triage
        // record — not by the block reason being present somewhere.
        const blockedTriage = (await store.getRun(runId)).triage;
        if (blockedTriage) {
          assertThat(Array.isArray(blockedTriage.prohibitedActions) &&
            blockedTriage.prohibitedActions.includes('automatic_retry'),
          'automatic retry is prohibited through the canonical triage authority');
        } else {
          assertThat(true, 'the blocked Run raised no triage record');
        }
        assertThat((await store.getRun(runId)).leaseOwner === null,
          'and the blocked Run holds no lease — it is not scheduler-eligible');

        // ── NO SIDE EFFECTS, PROVED AT TICKET SCOPE ───────────────────
        //
        // The pre-restart baseline moves, and it is important to say exactly
        // why rather than to narrow the scope until the number looks right.
        // This scenario CRASHES a server mid-flight; the restart is a recovery,
        // so sibling Runs that were interrupted legitimately resume and finish.
        // Their rows are caused by execution, not by projection.
        //
        // Two things are therefore proved separately: no new row belongs to the
        // BLOCKED leaf, and — once the whole Ticket is genuinely quiescent —
        // repeating every projection read moves nothing at Ticket scope. The
        // second is the claim that closes the matrix; the first stops the
        // first read from being explained away.
        await waitForSchedulerQuiescence(store, run.ticketId);

        // THE RESTART IS RECOVERY, NOT PROJECTION — and conflating the two
        // would be the easiest way to claim a no-side-effect proof this
        // scenario cannot support. The server is CRASHED mid-flight here: at
        // the pre-restart baseline the leaf still holds a lease and has not
        // been terminalized, so the fresh process legitimately reclaims it,
        // terminalizes it into the blocked disposition, writes its completion
        // decision, and finishes interrupted siblings. Those rows are caused by
        // EXECUTION resuming.
        //
        // The delta is therefore reported and attributed rather than asserted
        // to be empty. The projection claim is made below, where it belongs:
        // against a Ticket that is already quiescent and terminal.
        const leafAfterRecovery = await durableRunCounts(store, runId);
        const leafDelta = countDelta(leafBeforeRestart, leafAfterRecovery);
        const ticketDelta = countDelta(countsBeforeRestart,
          await durableTerminalCounts(store, run.ticketId));
        console.log(`  (recovery delta — leaf: ${leafDelta.join(', ') || 'none'})`);
        console.log(`  (recovery delta — ticket: ${ticketDelta.join(', ') || 'none'})`);
        assertThat(leafAfterRecovery.reservations === leafBeforeRestart.reservations,
          `recovery issues the blocked leaf no new economic reservation ` +
          `(${leafBeforeRestart.reservations} -> ${leafAfterRecovery.reservations})`);
        assertThat(leafAfterRecovery.receipts === leafBeforeRestart.receipts,
          'and commits no new workspace receipt for it');
        assertThat(leafAfterRecovery.activeLease === 0,
          'and leaves it holding no lease once recovery settles it');

        // THE CLOSING READ. Ticket-scoped, taken with everything quiescent, and
        // every projection surface issued again against it.
        const quiescedBefore = await durableTerminalCounts(store, run.ticketId);
        await second.request('GET', `/runs/${runId}`, { cookie });
        await second.request('GET', `/tickets/${run.ticketId}`, { cookie });
        await second.request('GET', `/api/runs/${runId}/events`, { cookie });
        await store.getAllocationPlanForTicket(run.ticketId);
        await waitForSchedulerQuiescence(store, run.ticketId);
        const quiescedAfter = await durableTerminalCounts(store, run.ticketId);
        const drift = countDelta(quiescedBefore, quiescedAfter);
        assertThat(drift.length === 0,
          `with the Ticket fully quiescent, every projection read creates no ` +
          `durable fact at Ticket scope (${drift.join(', ')})`);
      } finally {
        await second.stop();
        for (const file of [capturePath, responsePath, markerPath, statePath, servedPath]) {
          fs.rmSync(file, { force: true });
        }
      }
    });

  // ── No-shortcut source boundary ─────────────────────────────────────────
  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['INSERT ', 'INTO'],
    ['UPDATE ', 'runs'],
    ['blockGovernedRunFor', 'ProgressDecision'],
    ['reserveEconomic', 'Request']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — production writes and re-reads the block`);
  }

  console.log('governed blocked restart PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
