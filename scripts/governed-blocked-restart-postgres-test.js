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
  seedGovernedStructuredTicket,
  progressControlPolicy
} = require('./governed-structured-fixture');
const { eligibleExecutionFacts } = require('../runtime/governed-eligible-facts');

const STAMP = `gbr-${Date.now()}`;
const ACTOR = 'governed-blocked-restart-test';
const HERMETIC = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const FAULT = path.join(__dirname, 'fixtures', 'governed-fault-injection-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';
const OWNED_ROOT = 'reports/planner';

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
    match: OWNED_ROOT,
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
        .filter(entry => String(entry.body || '').includes(OWNED_ROOT));
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
      const second = await startServer({ env });
      try {
        await sleep(9000);

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
