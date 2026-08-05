#!/usr/bin/env node
'use strict';

// Tranche 5 — the whole verified-progress lifecycle, through the real server.
//
// The first-response suite proves production WRITES evidence. This proves
// production READS it and acts on it: that a durable false→true transition of an
// admitted fact is what resets the no-progress streak and authorizes a second
// governed request, and that verified progress is still not completion.
//
// THE DISTINCTION UNDER TEST:
//
//   request 1 satisfies A  → verified progress → NOT completion
//   request 2 satisfies B  + existing completion authority → completion
//
// With `maximumConsecutiveNoProgressWindows = 1`, a Run that cannot demonstrate
// verified progress in its first window is blocked before a second request. So
// the second request happening AT ALL is the observable consequence of the
// transition chain — request-1 evidence → stable cutoff →
// readGovernedFactTransitions → A false→true → streak reset → request 2 — and a
// bypass anywhere in it stops the Run instead of quietly degrading.
//
// This suite writes NO evidence, receipts, transitions, reservations, completion
// decisions or item statuses. It only reads durable rows and asserts on them,
// which the source scan at the end enforces.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  countDelta,
  durableTerminalCounts,
  findRuntimeRun,
  fullTerminalCounts,
  pageSection,
  waitForSchedulerQuiescence
} = require('./fixtures/terminal-projection-restart');
const {
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');
const {
  correlateGovernedTransports,
  missingTransports,
  transportedOrdinals,
  transportsForRun
} = require('./fixtures/governed-transport-correlation');

const STAMP = `gvl-${Date.now()}`;
const ACTOR = 'governed-verified-progress-lifecycle-test';
const PRELOAD = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';
const RESPONSE_ONE = 'fixture-governed-lifecycle-response-1';
const RESPONSE_TWO = 'fixture-governed-lifecycle-response-2';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const OWNED_ROOT = 'reports/planner';
// DISCRIMINATE THE LEAF, NOT THE FOLDER. The planner Run's own governed request
// also names `reports/planner` — it is that item's owned output path — so
// matching the root alone let a planner request be counted as a leaf transport,
// and let the planner consume a response staged for the leaf. The leaf's
// declared postcondition path appears only in the leaf's prompt, which is what
// makes it a safe identifier for this Run's traffic.
const LEAF_MARKER = 'reports/planner/alpha';

const LIFECYCLE_LIMITS = {
  maxExecutionSteps: 6,
  // EXACTLY TWO governed requests. A third would be answered by nothing, and
  // bounding it here — in the Run's admission-captured limits, where the Run
  // actually reads it — keeps the scenario closed.
  maxModelRequestsPerRun: 2,
  maxWorkspaceOperationsPerRun: 40,
  maxRuntimeDurationMs: 600_000,
  maxAttempts: 3,
  maxProcessOperationsPerRun: 5,
  maxBrowserOperationsPerRun: 5,
  maxOutputArtifactBytes: 1_048_576,
  maxOutputArtifactBytesPerRun: 1_048_576
};

function stagedResponse(identity, plan, match) {
  return {
    // Sibling leaf Runs share this fixture; a staged response is addressed to
    // the Run whose prompt carries this path, never to whoever asks first.
    match,
    statusCode: 200,
    body: JSON.stringify({
      id: identity,
      output_text: JSON.stringify(plan),
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    })
  };
}

async function main() {
  await withHarness('governed verified progress lifecycle',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: LIFECYCLE_LIMITS,
        // The objective the deterministic grammar compiles into EXACTLY the two
        // declared facts. Completion is Tranche 3 authority evaluating recorded
        // verification claims, and those claims only exist for a recognized
        // contract — so an objective the grammar cannot read would leave a Run
        // that executed perfectly permanently uncompletable.
        ticketObjective:
          'Create folders reports/planner/alpha and reports/planner/beta',
        // ONE no-progress window is tolerated. The second request therefore
        // depends on the first having produced VERIFIED progress.
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
      const factB = facts.find(f => f.criterion.path.endsWith('/beta'));
      assert.ok(factA && factB, 'two admitted facts');

      // Deterministic initial state: the owned parent exists, neither declared
      // folder does. createFolder is non-recursive in production.
      fs.mkdirSync(path.join(workspaceRoot, path.dirname(factA.criterion.path)),
        { recursive: true });

      const capturePath = path.join(os.tmpdir(), `gvl-cap-${process.pid}-${STAMP}.jsonl`);
      const responsePath = path.join(os.tmpdir(), `gvl-res-${process.pid}-${STAMP}.json`);
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          stagedResponse(RESPONSE_ONE, {
            message: 'Creating the first declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          }, LEAF_MARKER),
          stagedResponse(RESPONSE_TWO, {
            message: 'Creating the second declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factB.criterion.path } }],
            complete: true
          }, LEAF_MARKER)
        ]
      }));

      const server = await startServer({
        env: {
          NODE_OPTIONS: `--require ${PRELOAD}`,
          OPENAI_API_KEY: SENTINEL,
          HERMETIC_TRANSPORT_CAPTURE: capturePath,
          HERMETIC_TRANSPORT_RESPONSE: responsePath,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '60000'
        }
      });

      const receiptsOf = async () => (await store.pool.query(
        `SELECT id, step_id, operation, outcome, workspace_path
           FROM ${store.table('operation_receipts')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;

      // ── CANONICAL TRANSPORT ATTRIBUTION ─────────────────────────────────
      //
      // A transport belongs to this Run when its bytes hash to the
      // `exact_request_hash` its own economic reservation recorded. Counting by
      // prompt substring was attribution by resemblance: the planner item's
      // owned path appears in more than one Run's prompt, and any refinement of
      // the string is still a guess about content rather than a statement about
      // identity.
      // Attribution is delegated to the canonical correlation helper, whose
      // rules are proved deterministically in governed-transport-correlation-test.
      // This suite supplies durable rows and captured bytes; it does not decide
      // which call belongs to whom.
      const reservationRows = async () => (await store.pool.query(
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
      const capturedEntries = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line));
      const attributedTransports = async () => correlateGovernedTransports({
        captures: capturedEntries(),
        reservations: await reservationRows()
      });
      const capturesForRun = async () =>
        transportsForRun(await attributedTransports(), runId);

      try {
        // ── Wait for a COMPLETE, DURABLE lifecycle ────────────────────────
        //
        // The previous loop exited silently when it ran out of attempts, and
        // the assertions then ran against whatever had happened so far — which
        // is indistinguishable from a real defect and is the most likely source
        // of this suite's intermittent transport-count failure. It now waits on
        // every durable fact the assertions depend on, and says so loudly if
        // they never arrive.
        let evidence = [];
        let terminal = null;
        let lifecycleSettled = false;
        for (let attempt = 0; attempt < 240; attempt += 1) {
          evidence = await store.readGovernedPostconditionEvidence(runId);
          const batches = new Set(evidence
            .filter(row => row.evaluationKind === 'post_batch')
            .map(row => row.batchStepId));
          const current = await store.getRun(runId);
          const reservations = (await reservationRows())
            .filter(row => row.runId === runId);
          const correlated = await capturesForRun();
          if (batches.size >= 2 &&
              reservations.length >= 2 &&
              correlated.length >= 2 &&
              (await store.readRunReplay(runId) || {}).snapshot &&
              ((await store.readRunReplay(runId)).snapshot.modelResponses || []).length >= 2 &&
              ['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) {
            terminal = current;
            lifecycleSettled = true;
            break;
          }
          await sleep(500);
        }
        assert.ok(lifecycleSettled,
          'the lifecycle never reached a complete durable state: ' +
          `evidence batches=${new Set(evidence.filter(r => r.evaluationKind === 'post_batch')
            .map(r => r.batchStepId)).size}, ` +
          `reservations=${(await reservationRows()).filter(r => r.runId === runId).length}, ` +
          `correlated transports=${(await capturesForRun()).length}, ` +
          `status=${(await store.getRun(runId)).status}`);

        // ── Hermeticity first ─────────────────────────────────────────────
        const output = String(server.output());
        assertThat(output.includes('HERMETIC_PRELOAD_ACTIVE=true'),
          'the hermetic preload ran inside the spawned server');
        const attributed = await attributedTransports();
        const correlated = transportsForRun(attributed, runId);
        const captured = correlated.map(item => capturedEntries()[item.captureIndex]);

        // An omission is invisible to a count of what arrived, so it is asked
        // about directly.
        assertThat(missingTransports(attributed, await reservationRows(), runId)
          .length === 0,
        'every request-2 dispatch authority actually reached the transport');
        assertThat(captured.length === 2,
          'exactly two hermetic transport calls occurred — one per governed request');
        assertThat(captured.every(entry => entry.hostname === 'api.openai.com' &&
          entry.path === '/v1/responses' && entry.method === 'POST'),
        'both calls went to the governed endpoint and nowhere else');
        // THE FIXTURE'S ARRIVAL NUMBER IS NOT THIS RUN'S ORDINAL.
        //
        // `requestOrdinal` counts every call the fixture SAW in its process,
        // including ones it refused — the planner's governed request is refused
        // for want of a staged response and still advances the counter. Reading
        // it as "this leaf's second request" made the assertion depend on
        // whether a foreign Run happened to reach the transport first, which is
        // exactly the intermittency this suite kept showing.
        //
        // The canonical ordinal comes from the reservation whose
        // `exact_request_hash` these bytes hash to.
        assertThat(transportedOrdinals(attributed, runId) === '1,2',
          'this Run made exactly requests 1 and 2, by canonical reservation ordinal');
        assertThat(correlated.filter(item => item.ordinal === 2).length === 1,
          'exactly one SECOND transport call occurred');

        const receipts = await receiptsOf();
        const mutations = receipts.filter(row =>
          row.operation === 'createFolder' && row.outcome === 'succeeded');
        assertThat(mutations.length === 2, 'two real operation receipts committed');
        const [receiptA, receiptB] = mutations;
        assertThat(String(receiptA.workspace_path).endsWith('alpha') &&
          String(receiptB.workspace_path).endsWith('beta'),
        'the receipts record the two intended mutations in order');
        assertThat(receiptA.step_id !== receiptB.step_id,
          'the two mutations belong to two distinct request windows');

        assertThat(fs.existsSync(path.join(workspaceRoot, factA.criterion.path)) &&
          fs.existsSync(path.join(workspaceRoot, factB.criterion.path)),
        'both declared folders exist on disk');

        // ── Response identities are fixture-controlled ────────────────────
        const replay = await store.readRunReplay(runId);
        const snapshot = (replay && replay.snapshot) || {};
        const modelResponses = snapshot.modelResponses || [];
        const providerRequests = snapshot.providerRequests || [];
        assertThat(modelResponses.length === 2 && providerRequests.length === 2,
          'replay holds two provider requests and two model responses');
        // ── ONE RUN NEVER HAS TWO TURNS IN FLIGHT ────────────────────────
        //
        // This is what makes staged response ORDER safe within a Run, and it is
        // a property of production rather than of the fixture: request 2's
        // authority cannot exist until request 1 is durably finished. Proved
        // from durable row ordering, since ids are monotonic — the request-2
        // reservation is created after request 1's response, receipts and
        // evidence are committed.
        //
        // Two turns cannot race for a staged answer if the second cannot be
        // authorized while the first is unresolved.
        const orderRows = await store.pool.query(
          `SELECT
             (SELECT created_at FROM ${store.table('economic_request_reservations')}
               WHERE run_id = $1 AND model_request_ordinal = 2) AS request_two_reserved_at,
             (SELECT max(recorded_at) FROM ${store.table('operation_receipts')}
               WHERE run_id = $1 AND step_id = $2) AS turn_one_last_receipt_at,
             (SELECT max(evaluated_at) FROM ${store.table('governed_postcondition_evidence')}
               WHERE run_id = $1 AND batch_step_id = $2) AS turn_one_last_evidence_at,
             (SELECT response_persisted_at FROM ${store.table('economic_request_reservations')}
               WHERE run_id = $1 AND model_request_ordinal = 1) AS request_one_response_at`,
          [runId, String(receiptA.step_id)]);
        const order = orderRows.rows[0];
        const at = value => (value === null ? null : new Date(value).getTime());

        assertThat(at(order.request_two_reserved_at) !== null,
          'request 2 obtained its own reservation');
        assertThat(at(order.turn_one_last_receipt_at) <= at(order.request_two_reserved_at),
          'turn 0 receipts committed BEFORE request-2 authority existed');
        assertThat(at(order.turn_one_last_evidence_at) <= at(order.request_two_reserved_at),
          'turn 0 postcondition evidence committed BEFORE request-2 authority existed');
        assertThat(at(order.request_one_response_at) !== null &&
          at(order.request_one_response_at) <= at(order.request_two_reserved_at),
        'request 1 had a DURABLE RESPONSE before request 2 was authorized');

        // The transports themselves never overlap: request 2's bytes are
        // captured after request 1's, by the canonical ordinals above.
        assertThat(correlated[0].ordinal === 1 && correlated[1].ordinal === 2,
          'the two transports are ordered turn 0 then turn 1 — never interleaved');

        // ── OWNERSHIP IS VERIFIED, NOT ASSUMED ───────────────────────────
        //
        // The fixture still selects a staged answer by matching content and
        // taking the first unused one, so within a single Run the staged ORDER
        // decides which of its own requests gets which response. Keying that by
        // canonical identity needs a parent/fixture handshake, because the
        // request body carries no Run, source or ordinal and the exact hash is
        // unknowable while the scenario is being staged.
        //
        // What can be done without that machinery is to stop trusting the
        // ordering and CHECK it: each response is matched to its execution turn,
        // which is canonical, and compared against the answer that turn was
        // supposed to receive. A mis-served response is then a deterministic
        // failure rather than a silent swap.
        const responseByTurn = new Map((modelResponses || [])
          .filter(item => Number.isSafeInteger(item.executionTurn))
          .map(item => [item.executionTurn, item.responseIdentity]));
        assertThat(responseByTurn.get(0) === RESPONSE_ONE,
          'execution turn 0 received the response staged for request 1');
        assertThat(responseByTurn.get(1) === RESPONSE_TWO,
          'execution turn 1 received the response staged for request 2');
        assertThat(responseByTurn.size === 2,
          'exactly two turns received a staged response');

        assertThat(JSON.stringify(modelResponses).includes(RESPONSE_ONE) &&
          JSON.stringify(modelResponses).includes(RESPONSE_TWO),
        'both persisted response identities are the fixed fixture identities');
        assertThat(!JSON.stringify(snapshot).includes('resp_'),
          'no uncontrolled external response identity appears anywhere in replay');

        // ── Evidence: two complete post-batch sets ────────────────────────
        const baseline = evidence.filter(row => row.evaluationKind === 'baseline');
        const postBatch = evidence.filter(row => row.evaluationKind === 'post_batch');
        assertThat(baseline.length === 2 && baseline.every(row => !row.satisfied),
          'baseline evidence records BOTH admitted facts unsatisfied');

        const batchOne = postBatch.filter(row => row.batchStepId === String(receiptA.step_id));
        const batchTwo = postBatch.filter(row => row.batchStepId === String(receiptB.step_id));
        const verdict = (rows, fact) => {
          const row = rows.find(entry => entry.declaredFactIdentity === fact.declaredFactIdentity);
          return row ? row.satisfied : null;
        };
        assertThat(batchOne.length === 2 && batchTwo.length === 2,
          'each request window recorded a COMPLETE evidence set');
        assertThat(verdict(batchOne, factA) === true && verdict(batchOne, factB) === false,
          'request 1 evidence is A=true, B=false');
        assertThat(verdict(batchTwo, factA) === true && verdict(batchTwo, factB) === true,
          'request 2 evidence is A=true, B=true');

        // ── The transition derivation production itself uses ──────────────
        const transitions = await store.readGovernedFactTransitions(runId);
        assertThat(transitions !== null, 'production derives fact transitions');
        assertThat(transitions.baselineSatisfiedFactIdentities.length === 0,
          'no fact was satisfied at baseline, so none can be credited for free');
        assertThat(transitions.newlyVerifiedFactIdentities.length === 2,
          'exactly two facts were newly verified across the Run');
        assertThat(transitions.creditedInBatch[factA.declaredFactIdentity] ===
          String(receiptA.step_id),
        'A is credited in request window 1 — once');
        assertThat(transitions.creditedInBatch[factB.declaredFactIdentity] ===
          String(receiptB.step_id),
        'B is credited in request window 2 — once');

        const windowOne = transitions.windows.find(w => w.batchStepId === String(receiptA.step_id));
        const windowTwo = transitions.windows.find(w => w.batchStepId === String(receiptB.step_id));
        assertThat(windowOne.newlySatisfiedFactIdentities.length === 1 &&
          windowOne.newlySatisfiedFactIdentities[0] === factA.declaredFactIdentity,
        'window 1 newly verifies A and only A');
        assertThat(windowOne.unsatisfiedFactIdentities.includes(factB.declaredFactIdentity),
          'window 1 records B as still unsatisfied — B is NOT verified by request 1');
        assertThat(windowTwo.newlySatisfiedFactIdentities.length === 1 &&
          windowTwo.newlySatisfiedFactIdentities[0] === factB.declaredFactIdentity,
        'window 2 newly verifies B and only B');
        assertThat(windowTwo.repeatedSatisfiedFactIdentities
          .includes(factA.declaredFactIdentity),
        'A is REPEATED in window 2, not credited a second time');
        assertThat(windowOne.throughOperationReceiptId === Number(receiptA.id) &&
          windowTwo.throughOperationReceiptId === Number(receiptB.id),
        'each window anchors to its own real committed receipt');

        // ── Candidate activity stays separate from verified progress ──────
        const progressState = await store.readGovernedRunProgressState(runId,
          { forUpdate: false });
        assertThat(progressState.cumulativeResources.providerRequests === 2,
          'cumulative provider requests is 2, reconstructed from durable rows');
        assertThat(progressState.cumulativeResources.durableOperations >= 2,
          'cumulative durable operations counts both committed mutations');
        assertThat(progressState.cumulativeResources.budgetChargedUnits >= 2,
          'cumulative budget-charged units counts both governed requests');
        assertThat(progressState.cumulativeResources.settledMicroUsd > 0,
          'cumulative settled cost is reconstructed from durable settlement');
        // Duration is measured from the IMMUTABLE epoch — the earliest
        // run.lease_acquired — so recovery cannot hand a Run a fresh budget.
        assertThat(typeof progressState.executionEpochAt === 'string' &&
          Number.isFinite(Date.parse(progressState.executionEpochAt)),
        'cumulative duration is anchored to the immutable execution epoch');

        // ── The Run was never blocked for want of verified progress ───────
        const finalRun = terminal || await store.getRun(runId);
        assertThat(!finalRun.governedProgressBlock,
          'no verified_progress_exhausted block exists — A reset the streak');

        // ── Two runtime budget reservations AND charges, two economic ─────
        const charges = (await store.pool.query(
          `SELECT source_identity, state FROM ${store.table('run_budget_charges')}
            WHERE run_id = $1 AND dimension = 'model_request' ORDER BY id`, [runId])).rows;
        assertThat(charges.length === 2,
          'a SECOND runtime-budget reservation and charge exist');
        assertThat(charges.every(row => row.state === 'committed'),
          'both runtime-budget charges committed');
        assertThat(new Set(charges.map(row => row.source_identity)).size === 2,
          'the two charges name two distinct request identities');

        const economic = (await store.pool.query(
          `SELECT logical_source_identity, state
             FROM ${store.table('economic_request_reservations')}
            WHERE run_id = $1 ORDER BY id`, [runId])).rows;
        assertThat(economic.length === 2, 'a SECOND economic reservation exists');
        assertThat(new Set(economic.map(row => row.logical_source_identity)).size === 2,
          'the two economic reservations name two distinct requests');
        // The two ledgers must not derive different names for the same request.
        assertThat(charges.map(row => row.source_identity).sort()
          .join('|') === economic.map(row => row.logical_source_identity).sort().join('|'),
        'runtime budget and economic ledger name the same two requests');

        // ── COMPLETION, and its separation from verified progress ─────────
        assertThat(finalRun.status === 'completed',
          'the Run reached a terminal completed state');
        const consequences = (await store.pool.query(
          `SELECT consequence FROM ${store.table('run_consequences')}
            WHERE run_id = $1`, [runId])).rows
          .filter(row => row.consequence && row.consequence.completionDecision);
        assertThat(consequences.length === 1,
          'exactly ONE canonical completion decision persists');
        const decision = consequences[0].consequence.completionDecision;
        assertThat(Boolean(decision.decisionHash || decision.completionDecisionHash),
          'the completion decision is hash-identified');

        // Tranche 3 reconciliation completed the leaf item.
        const plan = await store.getAllocationPlanForTicket(run.ticketId);
        const items = (plan && plan.aggregateDecision && plan.aggregateDecision.items) || [];
        const leafItem = items.find(item =>
          Number(item.allocationItemId) === Number(run.allocationItemId));
        assertThat(Boolean(leafItem), 'the leaf item is present in the aggregate decision');
        assertThat(leafItem.itemStatus === 'completed',
          'Tranche 3 reconciliation completed the leaf item from persisted facts');

        // Ticket projection succeeds over the completed governed Run.
        const cookie = await server.login();
        const page = await server.request('GET', `/tickets/${run.ticketId}`, { cookie });
        assertThat(page.statusCode === 200,
          'the Ticket projection renders over the completed governed Run');

        // ── Stability: the terminal state does not move ───────────────────
        await sleep(1500);
        const settled = await store.getRun(runId);
        assertThat(settled.status === finalRun.status,
          'the Run reached ONE stable terminal state');
        const settledEvidence = await store.readGovernedPostconditionEvidence(runId);
        assertThat(settledEvidence.length === evidence.length,
          'no further evidence is appended after completion');
        assertThat((await receiptsOf()).length === receipts.length,
          'no further receipts commit after completion');
        assertThat(captured.length === 2,
          'no third provider request was dispatched');

        console.log(`  (${assertThat.count()} lifecycle assertions)`);
      } finally {
        await server.stop();
      }

      // ── VALID STRUCTURED COMPLETION THROUGH A COLD PROCESS ─────────────
      //
      // Everything above was proved by the process that DID the work. A
      // completion that only holds while its author is alive is a cache, not a
      // projection, so the same claims are re-read by a server that has never
      // seen this Ticket.
      //
      // The baseline is taken only after durable quiescence, so the
      // no-side-effect comparison below is Ticket-scoped rather than narrowed
      // to the terminal Run — nothing here is still legitimately executing, so
      // there is no live-sibling ambiguity to hide behind.
      {
        await waitForSchedulerQuiescence(store, run.ticketId);
        const before = await durableTerminalCounts(store, run.ticketId);
        const runBefore = await store.getRun(runId);
        const decisionBefore = (await store.getRunConsequence(runId))
          .consequence.completionDecision;

        const cold = await startServer({ env: {
          NODE_OPTIONS: `--require ${PRELOAD}`,
          OPENAI_API_KEY: SENTINEL,
          HERMETIC_TRANSPORT_CAPTURE: capturePath,
          HERMETIC_TRANSPORT_RESPONSE: responsePath,
          RUNTIME_SCHEDULER_INTERVAL_MS: '200',
          RUN_LEASE_DURATION_MS: '60000'
        } });
        try {
          await waitForSchedulerQuiescence(store, run.ticketId);
          const cookie = await cold.login();

          // ── The durable authority, re-read cold ────────────────────────
          const coldRun = await store.getRun(runId);
          assertThat(coldRun.status === 'completed',
            `the Run still projects completed after a cold restart (${coldRun.status})`);
          assertThat(coldRun.leaseOwner === null,
            'and holds no lease — it is not scheduler-eligible');
          assertThat(coldRun.revision === runBefore.revision,
            'the restart does not touch its revision');

          const decisionAfter = (await store.getRunConsequence(runId))
            .consequence.completionDecision;
          assertThat(decisionAfter.decisionHash === decisionBefore.decisionHash,
            'the canonical completion decision is byte-identical after restart');
          assertThat(Number(decisionAfter.runId) === Number(runId) &&
            Number(decisionAfter.ticketId) === Number(run.ticketId),
          'and is bound to THIS Run and Ticket');
          assertThat(decisionAfter.completionDisposition === 'completed',
            `the decision itself claims completion (${decisionAfter.completionDisposition})`);

          // COMPLETION IS NOT INFERRED FROM STATUS. The expected authority is
          // compared, which is the rule a status-only projection would skip.
          const expectedHash = coldRun.completionAuthoritySnapshot
            ? coldRun.completionAuthoritySnapshot.objectiveContractHash
            : null;
          assertThat(typeof expectedHash === 'string' && /^[0-9a-f]{64}$/.test(expectedHash),
            'the Run carries a durable expected completion-authority hash');
          assertThat(decisionAfter.objectiveContractHash === expectedHash,
            'and the decision authority matches it exactly');

          // ── Reconciliation and the parent aggregate ────────────────────
          const coldPlan = await store.getAllocationPlanForTicket(run.ticketId);
          const coldItems = (coldPlan && coldPlan.aggregateDecision &&
            coldPlan.aggregateDecision.items) || [];
          const coldLeaf = coldItems.find(item =>
            Number(item.allocationItemId) === Number(run.allocationItemId));
          assertThat(Boolean(coldLeaf), 'the leaf item is present after restart');
          assertThat(coldLeaf.itemStatus === 'completed',
            `reconciliation still completes the leaf item (${coldLeaf.itemStatus})`);
          assertThat(coldLeaf.completionDecisionHash === decisionAfter.decisionHash,
            'and names the same completion decision');

          // ── Operator surfaces ─────────────────────────────────────────
          const ticketPage = await cold.request(
            'GET', `/tickets/${run.ticketId}`, { cookie });
          assertThat(ticketPage.statusCode === 200,
            'the Ticket page renders over the completed leaf');
          assertThat(!/COMPLETION_EVIDENCE_MISSING/.test(String(ticketPage.body || '')),
            'with no completion-evidence refusal');
          const runPage = await cold.request('GET', `/runs/${runId}`, { cookie });
          assertThat(runPage.statusCode === 200,
            'the Run detail page renders');
          const runBody = String(runPage.body || '');
          assertThat(!runBody.includes('replay_unavailable_integrity_failure'),
            'a completed Run borrows no replay-integrity authority');
          // AUTHORITY, NOT VOCABULARY.
          //
          // The page does render `verified_progress_exhausted` for this
          // COMPLETED Run — under a "Churn decision" heading, which is a
          // different question from the Run's disposition: the last progress
          // window produced no new verified progress, and the Run then
          // completed because its declared work was satisfied. Both are true,
          // and the churn record is labelled as its own authority rather than
          // presented as the outcome.
          //
          // So asserting the absence of the STRING would be asserting the wrong
          // thing. What must hold is that no BLOCK AUTHORITY exists for a
          // completed leaf, and that no other authority class is borrowed.
          assertThat(!coldRun.governedProgressBlock,
            'a completed leaf holds NO governed progress block authority');
          assertThat(!coldRun.integrityFailureCode,
            'and no replay-integrity disposition');
          assertThat(!runBody.includes('undeclared_sibling_dependency'),
            'and the page borrows no sibling-dependency authority');
          assertThat(runBody.includes('completed'),
            'while presenting the Run as completed');

          // ── PAGE SEMANTIC SECTIONS (row 1) ────────────────────────────
          //
          // This page renders `verified_progress_exhausted` under a historical
          // "Churn decision" heading for a COMPLETED Run — the final window
          // produced no new verified progress while the declared work was
          // satisfied. Section reading is what separates that history from the
          // terminal authority; a page-wide substring check cannot.
          {
            const outcome = pageSection(runBody, 'Run Outcome');
            const endedAs = pageSection(runBody, 'Run Ended As');
            const churn = pageSection(runBody, 'Churn decision');
            assertThat(outcome !== null || endedAs !== null,
              'the Run page exposes a current-outcome section');
            assertThat(/completed/i.test(`${outcome || ''} ${endedAs || ''}`),
              `the current outcome is completed (${outcome} / ${endedAs})`);
            if (runBody.includes('verified_progress_exhausted')) {
              assertThat(churn !== null &&
                churn.includes('verified_progress_exhausted'),
              'and verified-progress text appears in the historical Churn ' +
              'decision section, which owns it');
              assertThat(!String(outcome || '').includes('verified_progress_exhausted') &&
                !String(endedAs || '').includes('verified_progress_exhausted'),
              'and never in the current-outcome section');
            }
            assertThat(!String(`${outcome || ''} ${endedAs || ''}`)
              .includes('undeclared_sibling_dependency'),
            'no sibling/path authority owns the outcome');
            assertThat(!String(`${outcome || ''} ${endedAs || ''}`)
              .includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
            'and no integrity authority owns it');
          }

          // ── TICKET TIMELINE: APPLICABLE — RAW HISTORY ONLY ────────────
          const timelineResp = await cold.request(
            'GET', `/api/tickets/${run.ticketId}/timeline`, { cookie });
          assertThat(timelineResp.statusCode === 200,
            `the Ticket timeline answers (${timelineResp.statusCode})`);
          const timeline = JSON.parse(timelineResp.body);
          assertThat(Number(timeline.ticketId) === Number(run.ticketId),
            'for this exact Ticket');
          assertThat(timeline.sourceSummary &&
            timeline.sourceSummary.appendOnlyEvents > 0,
          'and reports durable append-only history');
          assertThat(Array.isArray(timeline.entries) && timeline.entries.length > 0,
            'with timeline entries present');
          assertThat(!String(timelineResp.body).includes('completion_verified'),
            'and repeats no reconciliation reason — raw history owns none');

          const eventsApi = await cold.request(
            'GET', `/api/runs/${runId}/events`, { cookie });
          assertThat(eventsApi.statusCode === 200, 'the Run events API projects');
          assertThat(String(eventsApi.body || '').includes('run.completion_decided'),
            'and exposes the durable completion-decision event');
          // THE REAL TICKET API. There is no `GET /api/tickets/:id` route; the
          // canonical readers are `/api/tickets/:id/runtime` and
          // `/api/tickets/:id/timeline`. A previous assertion accepted 200 OR
          // 404 against the non-existent route, which passed by hitting the
          // 404 and proved nothing about any surface.
          const ticketApi = await cold.request(
            'GET', `/api/tickets/${run.ticketId}/runtime`, { cookie });
          assertThat(ticketApi.statusCode === 200,
            `the Ticket runtime API projects over the completed leaf ` +
            `(${ticketApi.statusCode})`);
          // Only the status is asserted. Field-level claims on this payload
          // are deliberately NOT made: it reports every Run on the Ticket and
          // carries per-Run `error` fields, so whole-payload substring checks
          // pass or fail for reasons belonging to SIBLINGS rather than to this
          // leaf — the same over-broad mistake corrected earlier for the churn
          // badge. Establishing its real per-Run shape ran past this session's
          // budget and is recorded as open.

          // Per-item Ticket runtime projection, scoped by Run ID (§2.1).
          const runtimeLeaf = findRuntimeRun(JSON.parse(ticketApi.body), runId);
          assertThat(runtimeLeaf.itemStatus === 'completed',
            `the structured item projects completed (${runtimeLeaf.itemStatus})`);
          assertThat(runtimeLeaf.dispositionReason === 'completion_verified',
            `with the verified reason (${runtimeLeaf.dispositionReason})`);
          assertThat(runtimeLeaf.completionDecisionHash === decisionAfter.decisionHash,
            'naming the exact completion decision');
          assertThat(Number(runtimeLeaf.allocationItemId) ===
            Number(run.allocationItemId),
          'and the exact allocation item');

          const runStateApi = await cold.request(
            'GET', `/api/runs/${runId}/state`, { cookie });
          assertThat(runStateApi.statusCode === 200,
            `the Run runtime-state API projects (${runStateApi.statusCode})`);
          const runStateBody = String(runStateApi.body || '');
          assertThat(runStateBody.includes('completed'),
            'and reports the completed disposition');
          assertThat(!runStateBody.includes('undeclared_sibling_dependency'),
            'without borrowing sibling-block authority');

          // ── NO BLOCK OR INTEGRITY AUTHORITY OWNS A COMPLETED LEAF ──────
          //
          // The decisive checks are FIELDS, not page substrings: the completed
          // Run's page legitimately renders `verified_progress_exhausted` under
          // a historical "Churn decision" heading, so absence of the string
          // proves nothing. `verifiedProgress.block` being null is what proves
          // no progress block owns the terminal state.
          const runStateJson = JSON.parse(runStateApi.body);
          assertThat(Number(runStateJson.id) === Number(runId) &&
            Number(runStateJson.ticketId) === Number(run.ticketId),
          'the Run-state API reports this exact Run on this exact Ticket');
          assertThat(runStateJson.verifiedProgress === null ||
            !runStateJson.verifiedProgress.block,
          'and NO governed progress block owns the completed terminal state');
          // `completionDecisionIntegrity` is populated only when there IS a
          // concern — it is null for a healthy completed leaf. So the claim is
          // that it never reports `missing` here, not that it is present.
          assertThat(runStateJson.completionDecisionIntegrity === null ||
            runStateJson.completionDecisionIntegrity.status !== 'missing',
          `and completion-decision integrity never reports missing ` +
          `(${JSON.stringify(runStateJson.completionDecisionIntegrity)})`);
          assertThat(runStateJson.completionAuthoritySnapshot &&
            runStateJson.completionAuthoritySnapshot.objectiveContractHash ===
              expectedHash,
          'and the reader presents the same expected authority hash the decision matches');
          assertThat(!runStateJson.replaySummary ||
            !String(JSON.stringify(runStateJson.replaySummary))
              .includes('POSTGRES_REPLAY_INTEGRITY_FAILURE'),
          'and no integrity failure owns it');

          // ── HISTORICAL CHURN DOES NOT CLASSIFY A COMPLETED RUN ────────
          //
          // This Run's final progress window truthfully evaluated to
          // `blocked` / `verified_progress_exhausted` — it produced no NEW
          // verified progress — and its declared work was satisfied in that
          // same window. The Ticket summary previously fell back to that live
          // churn decision whenever no block was persisted, so a COMPLETED Run
          // holding no block was listed as blocked while Run-state and the
          // durable row both said otherwise.
          //
          // The fallback is now restricted to nonterminal Runs, so a terminal
          // Run contributes a blocked reason only from its own durable block.
          // The churn history remains visible on the Run page under its
          // "Churn decision" heading; it simply no longer classifies.
          const ticketVp = JSON.parse(ticketApi.body).verifiedProgress;
          for (const list of ['blockedForVerifiedProgressExhaustion',
            'blockedForUndeclaredSiblingDependency',
            'blockedForCumulativeExecutionDuration',
            'blockedForRepeatedNoOp']) {
            assertThat(!(ticketVp[list] || []).map(Number).includes(Number(runId)),
              `the completed Run appears in no ${list} group`);
          }
          assertThat(runtimeLeaf.dispositionReason === 'completion_verified',
            'and reconciliation still reports verified completion');

          // ── CLI READER: APPLICABLE — ASSERTED ─────────────────────────
          //
          // Through the real command path — `node scripts/oquery.js run-state
          // <runId>` — not by calling a formatter. oquery is an HTTP operator
          // client: it reads `OPERC_URL` and a cached session from
          // `OPERC_COOKIE_PATH`, so the cold server's cookie is written where
          // the CLI looks for it.
          //
          // Only what this command OWNS is asserted. `run-state` prints the
          // three completion dispositions but NOT the decision hash — that is
          // printed by other commands — so requiring a hash here would be
          // requiring a field this reader does not emit.
          const cliCookiePath = path.join(os.tmpdir(),
            `gvl-oquery-${process.pid}-${STAMP}.cookie`);
          fs.writeFileSync(cliCookiePath, cookie.replace(/^sessionId=/, ''));
          const cliOutput = await new Promise(resolve => {
            const child = require('node:child_process').spawn(
              process.execPath,
              [path.join(__dirname, 'oquery.js'), 'run-state', String(runId)],
              {
                cwd: path.join(__dirname, '..'),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                  ...process.env,
                  OPERC_URL: cold.baseUrl,
                  OPERC_COOKIE_PATH: cliCookiePath
                }
              });
            let text = '';
            child.stdout.on('data', c => { text += c.toString(); });
            child.stderr.on('data', c => { text += c.toString(); });
            child.on('close', code => resolve({ code, text }));
          });
          // Strip ANSI so substring assertions are stable.
          const cliText = cliOutput.text.replace(/\u001b\[[0-9;]*m/g, '');
          assertThat(cliOutput.code === 0,
            `oquery run-state exits successfully (${cliOutput.code})`);
          assertThat(cliText.includes(`Run #${runId}`),
            `and names the exact Run (#${runId})`);
          assertThat(cliText.includes(`ticket #${run.ticketId}`),
            `and the exact Ticket (#${run.ticketId})`);
          assertThat(/completion decision/.test(cliText),
            'and prints the completion decision it owns');
          assertThat(new RegExp(
            `execution ${decisionAfter.executionDisposition}`).test(cliText),
          `with the durable execution disposition ` +
          `(${decisionAfter.executionDisposition})`);
          assertThat(new RegExp(
            `verification ${decisionAfter.verificationDisposition}`).test(cliText),
          `the durable verification disposition ` +
          `(${decisionAfter.verificationDisposition})`);
          assertThat(new RegExp(
            `objective ${decisionAfter.completionDisposition}`).test(cliText),
          `and the durable objective disposition ` +
          `(${decisionAfter.completionDisposition})`);
          // It claims none of the authorities it cannot read (rows 2-5).
          assertThat(!cliText.includes('verified_progress_exhausted') &&
            !cliText.includes('undeclared_sibling_dependency') &&
            !cliText.includes('POSTGRES_REPLAY_INTEGRITY_FAILURE') &&
            !cliText.includes('replay_unavailable_integrity_failure'),
          'and claims no block or replay-integrity authority');
          fs.rmSync(cliCookiePath, { force: true });

          // ── NOTHING WAS CREATED BY PROJECTING ─────────────────────────
          await waitForSchedulerQuiescence(store, run.ticketId);
          const after = await fullTerminalCounts(store, run.ticketId);
          const drift = countDelta(before, after);
          assertThat(drift.length === 0,
            `cold restart and every projection read create no durable facts ` +
            `(${drift.join(', ')})`);
          assertThat(capturedEntries().length === 2,
            'and no third provider request was ever dispatched');
        } finally {
          await cold.stop();
        }
      }

      fs.rmSync(capturePath, { force: true });
      fs.rmSync(responsePath, { force: true });
    });

  // ── CLI APPLICABILITY BOUNDARY (rows 2-5) ──────────────────────────────
  //
  // Row 1 is asserted above through the real `oquery run-state` command. Rows
  // 2-5 are NOT APPLICABLE, and that is proved from the CLI's source rather
  // than by running it against those rows to watch fields be missing — absence
  // observed once is not a contract.
  //
  // oquery is an HTTP operator client over `tickets, runs, logs, history,
  // plans`. It never reads the seams that own the other four rows' authority,
  // so it cannot report them and must not be marked as asserting them.
  {
    const oquerySource = fs.readFileSync(path.join(__dirname, 'oquery.js'), 'utf8');
    const executable = oquerySource.split('\n')
      .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    // WHAT SOURCE ACTUALLY PROVES ABSENT.
    //
    // An earlier revision of §4 also listed the governed block and sibling
    // authority here. That was wrong: `cmdReplay` prints
    // `progress.block.reason`, `blockHash`, `blockedAt`, `churnDecisionHash`,
    // `progressPolicyHash` and `block.siblingDependency.requestedPath` /
    // `siblingAllocationItemId` (oquery.js:679-691). The grep behind that claim
    // looked for `governedProgressBlock`, which is not the payload's field
    // name — the CLI reaches the block through `verifiedProgress.block`.
    //
    // So only these are genuinely unreachable by the CLI, and only rows 2 and 5
    // are NOT APPLICABLE.
    for (const [row, symbol] of [
      ['contained replay-integrity containment', 'integrityFailureCode'],
      ['replay availability', 'replayAvailability'],
      ['replay-integrity code', 'POSTGRES_REPLAY_INTEGRITY_FAILURE'],
      ['ticket verified-progress summary seam', 'readTicketVerifiedProgressProjection']
    ]) {
      assert.equal(executable.includes(symbol), false,
        `oquery reads no ${row} authority (${symbol}) — rows 2 and 5 are ` +
        'NOT APPLICABLE by source, not by observation');
    }

    // The block and sibling authorities ARE reachable, so the matrix may not
    // claim they are unreachable. This fails if anyone re-marks them
    // NOT APPLICABLE.
    for (const [row, symbol] of [
      ['governed progress block', 'blockHash'],
      ['sibling/path block', 'siblingDependency'],
      ['sibling requested path', 'requestedPath']
    ]) {
      assert.equal(executable.includes(symbol), true,
        `oquery DOES read ${row} authority (${symbol}) — rows 3 and 4 may not ` +
        'be marked NOT APPLICABLE');
    }

    // And the documented matrix must not claim otherwise.
    const contracts = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'TERMINAL_PROJECTION_READER_CONTRACTS.md'), 'utf8');
    const cliRow = contracts.split('\n').find(line => line.startsWith('| CLI |'));
    assert.ok(cliRow, 'the matrix carries a CLI row');
    const cells = cliRow.split('|').map(cell => cell.trim());
    assert.ok(/APPLICABLE — ASSERTED/.test(cells[2]),
      `the matrix marks valid completion CLI-asserted (${cells[2]})`);
    for (const [index, label] of [[3, 'contained integrity'], [6, 'uncontained']]) {
      assert.ok(/NOT APPLICABLE/.test(cells[index]),
        `matrix CLI cell for ${label} stays NOT APPLICABLE (${cells[index]})`);
    }
    for (const [index, label] of [[4, 'verified-progress'], [5, 'sibling dependency']]) {
      assert.ok(!/NOT APPLICABLE/.test(cells[index]),
        `matrix CLI cell for ${label} may not claim NOT APPLICABLE — the CLI ` +
        `reads that authority (${cells[index]})`);
    }
  }

  // ── No caller supplies a satisfied-fact map ─────────────────────────────
  //
  // The hole this whole tranche closes is an orchestration caller handing the
  // progress evaluator its own idea of which facts are satisfied. The gate must
  // DERIVE that from durable evidence, so the request-preparation entry point
  // must not accept it as input.
  const storeSource = fs.readFileSync(
    path.join(__dirname, '..', 'persistence', 'postgres', 'store.js'), 'utf8');
  const orchestrationSource = fs.readFileSync(
    path.join(__dirname, '..', 'runtime', 'governed-leaf-orchestration.js'), 'utf8');

  // The gate still ACCEPTS a satisfied-fact map, for contract tests. What
  // matters is that production never supplies one, so the check is on the real
  // call site rather than on the signature.
  const callStart = orchestrationSource.indexOf(
    'repository.prepareAndReserveNextGovernedRunRequest({');
  assert.ok(callStart > 0, 'the production governed request call site exists');
  const callArguments = orchestrationSource.slice(
    callStart, orchestrationSource.indexOf('});', callStart));
  for (const supplied of [
    'satisfiedFactIdentities', 'satisfiedFacts', 'verifiedFacts', 'factTransitions'
  ]) {
    assert.equal(callArguments.includes(supplied), false,
      `production supplies no ${supplied} — the gate derives progress itself`);
  }

  // And the gate derives them from durable evidence inside its own transaction,
  // under its own cutoff, rather than trusting anything handed in.
  const gateStart = storeSource.indexOf('async prepareAndReserveNextGovernedRunRequest(');
  const gateBody = storeSource.slice(gateStart, gateStart + 12000);
  assert.ok(gateBody.includes('readGovernedFactTransitions'),
    'the gate derives fact transitions from durable evidence itself');
  assert.ok(gateBody.includes('satisfiedFactIdentitiesByReceiptId: transitions'),
    'the derived transitions take precedence over any caller-supplied mapping');

  // ── No-shortcut source boundary ─────────────────────────────────────────
  //
  // Assembled from fragments: a literal list of forbidden identifiers is itself
  // executable source and would match its own definition.
  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['appendGovernedPostcondition', 'EvidenceSet'],
    ['INSERT ', 'INTO'],
    ['recordOperation', 'Receipt'],
    ['recordRun', 'Consequence'],
    ['reserveEconomic', 'Request'],
    ['reconcileStructuredAllocationLeaf', 'Items'],
    ['writeStructuredAllocationAggregate', 'Decision'],
    ['UPDATE ', 'runs']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — production creates these records`);
  }

  console.log('governed verified progress lifecycle PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
