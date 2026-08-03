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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const {
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

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

      try {
        // ── Wait for the SECOND post-batch evidence set ───────────────────
        let evidence = [];
        let terminal = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          evidence = await store.readGovernedPostconditionEvidence(runId);
          const batches = new Set(evidence
            .filter(row => row.evaluationKind === 'post_batch')
            .map(row => row.batchStepId));
          const current = await store.getRun(runId);
          if (batches.size >= 2 && ['completed', 'failed', 'blocked', 'cancelled']
            .includes(current.status)) { terminal = current; break; }
          await sleep(500);
        }

        // ── Hermeticity first ─────────────────────────────────────────────
        const output = String(server.output());
        assertThat(output.includes('HERMETIC_PRELOAD_ACTIVE=true'),
          'the hermetic preload ran inside the spawned server');
        const captured = fs.readFileSync(capturePath, 'utf8').trim()
          .split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(entry => String(entry.body || '').includes(LEAF_MARKER));
        assertThat(captured.length === 2,
          'exactly two hermetic transport calls occurred — one per governed request');
        assertThat(captured.every(entry => entry.hostname === 'api.openai.com' &&
          entry.path === '/v1/responses' && entry.method === 'POST'),
        'both calls went to the governed endpoint and nowhere else');
        assertThat(captured[1].requestOrdinal === 2,
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
        fs.rmSync(capturePath, { force: true });
        fs.rmSync(responsePath, { force: true });
      }
    });

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
