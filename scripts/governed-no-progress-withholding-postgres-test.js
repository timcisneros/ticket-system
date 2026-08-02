#!/usr/bin/env node
'use strict';

// Tranche 5 — the WITHHOLDING direction, through the real server.
//
// The lifecycle suite proves that new verified progress AUTHORIZES the next
// governed request. That is only half the claim. This proves the other half:
// that the ABSENCE of verified progress durably WITHHOLDS it.
//
// Why the two must be tested separately. A gate that never refuses behaves
// identically to a correct gate in every scenario that always makes progress —
// which is exactly why removing `permitsGovernedRequest` from the store failed
// nothing until this scenario existed.
//
// THE NO-PROGRESS CASE IS HONEST WORK, NOT A BROKEN RUN. The controlled response
// commits a REAL mutation and a REAL receipt, and the complete evidence set is
// written; the mutation simply satisfies no admitted fact, because it creates a
// folder nobody declared. That is the ordinary case a churn control exists for:
// an agent doing things that do not advance the declared work. Missing evidence,
// refused actions, malformed authority and unsupported objectives are all
// DIFFERENT conditions with different truthful outcomes, and using any of them
// here would prove something else.
//
// The request limit is deliberately TWO. If it were one, the second request
// would be withheld by the budget rather than by the progress gate, and the
// suite would pass while proving nothing.

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

const STAMP = `gnw-${Date.now()}`;
const ACTOR = 'governed-no-progress-withholding-test';
const PRELOAD = path.join(__dirname, 'fixtures', 'hermetic-governed-transport-preload.js');
const SENTINEL = 'test-only-sentinel-not-a-real-credential';
const RESPONSE_ONE = 'fixture-governed-withholding-response-1';
// Staged but MUST NEVER BE SERVED. Its arrival in replay is the failure this
// scenario is built to detect.
const RESPONSE_TWO = 'fixture-governed-withholding-response-2-must-not-be-served';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const WITHHOLDING_LIMITS = {
  maxExecutionSteps: 6,
  // TWO permitted. The withholding under test must come from the progress gate.
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
  await withHarness('governed no progress withholding',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: WITHHOLDING_LIMITS,
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
      assertThat(facts.length === 2,
        'the Run admits a nonempty eligible fact catalog');
      const factA = facts.find(f => f.criterion.path.endsWith('/alpha'));
      const factB = facts.find(f => f.criterion.path.endsWith('/beta'));
      const ownedRoot = path.dirname(factA.criterion.path);
      // A real, permitted, novel mutation that satisfies NEITHER admitted fact.
      const unrelatedPath = `${ownedRoot}/gamma`;

      fs.mkdirSync(path.join(workspaceRoot, ownedRoot), { recursive: true });

      const capturePath = path.join(os.tmpdir(), `gnw-cap-${process.pid}-${STAMP}.jsonl`);
      const responsePath = path.join(os.tmpdir(), `gnw-res-${process.pid}-${STAMP}.json`);
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          stagedResponse(RESPONSE_ONE, {
            message: 'Creating a scratch folder.',
            actions: [{ operation: 'createFolder', args: { path: unrelatedPath } }],
            complete: false
          }, ownedRoot),
          // Staged so that a broken gate would SUCCEED in getting an answer. If
          // the fixture refused instead, a second dispatch would look like a
          // transport failure rather than the authority failure it is.
          stagedResponse(RESPONSE_TWO, {
            message: 'This response must never be requested.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          }, ownedRoot)
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

      try {
        // Wait for the block to persist, or for the Run to stop.
        let blocked = null;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await store.getRun(runId);
          if (current.governedProgressBlock) { blocked = current; break; }
          if (['completed', 'failed', 'cancelled'].includes(current.status)) {
            blocked = current; break;
          }
          await sleep(500);
        }
        const finalRun = blocked || await store.getRun(runId);

        assertThat(String(server.output()).includes('HERMETIC_PRELOAD_ACTIVE=true'),
          'the hermetic preload ran inside the spawned server');

        // ── Exactly ONE of everything ─────────────────────────────────────
        // Sibling leaf Runs share this fixture, so transport calls are counted
        // for THIS Run by the owned path its prompt necessarily carries.
        const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
          .split('\n').filter(Boolean).map(line => JSON.parse(line))
          .filter(entry => String(entry.body || '').includes(ownedRoot));
        const captured = capturesForRun();
        assertThat(captured.length === 1,
          'exactly ONE transport call occurred — the second was never dispatched');

        const receipts = (await store.pool.query(
          `SELECT id, step_id, operation, outcome, workspace_path
             FROM ${store.table('operation_receipts')}
            WHERE run_id = $1 ORDER BY id`, [runId])).rows;
        const mutations = receipts.filter(row =>
          row.operation === 'createFolder' && row.outcome === 'succeeded');
        assertThat(mutations.length === 1,
          'the real operation receipt committed — this Run did genuine work');
        assertThat(String(mutations[0].workspace_path).endsWith('gamma'),
          'the committed mutation is the novel, unrelated one');
        assertThat(fs.existsSync(path.join(workspaceRoot, unrelatedPath)),
          'the unrelated folder really exists — activity, not a failed action');
        assertThat(!fs.existsSync(path.join(workspaceRoot, factA.criterion.path)) &&
          !fs.existsSync(path.join(workspaceRoot, factB.criterion.path)),
        'neither admitted fact was satisfied');

        const charges = (await store.pool.query(
          `SELECT source_identity FROM ${store.table('run_budget_charges')}
            WHERE run_id = $1 AND dimension = 'model_request'`, [runId])).rows;
        console.log('DIAG econ=', JSON.stringify((await store.pool.query(
          `SELECT logical_source_identity, state FROM ${store.table('economic_request_reservations')}
            WHERE run_id = $1 ORDER BY id`, [runId])).rows));
        assertThat(charges.length === 1,
          'exactly ONE runtime-budget request charge exists — no second charge');
        const economic = (await store.pool.query(
          `SELECT id FROM ${store.table('economic_request_reservations')}
            WHERE run_id = $1`, [runId])).rows;
        assertThat(economic.length === 1,
          'exactly ONE economic reservation exists — no second reservation');

        const replay = await store.readRunReplay(runId);
        const snapshot = (replay && replay.snapshot) || {};
        assertThat((snapshot.providerRequests || []).length === 1,
          'no second provider-request replay item exists');
        assertThat((snapshot.modelResponses || []).length === 1,
          'no second provider response was processed');
        assertThat(!JSON.stringify(snapshot).includes(RESPONSE_TWO),
          'the staged second response never entered the Run');

        // ── The complete evidence set committed, and credits nothing ──────
        const evidence = await store.readGovernedPostconditionEvidence(runId);
        const baseline = evidence.filter(row => row.evaluationKind === 'baseline');
        const postBatch = evidence.filter(row => row.evaluationKind === 'post_batch');
        assertThat(baseline.length === 2 && baseline.every(row => !row.satisfied),
          'baseline evidence records both admitted facts unsatisfied');
        assertThat(postBatch.length === 2,
          'the COMPLETE post-batch evidence set committed — nothing is missing');
        assertThat(postBatch.every(row => !row.satisfied),
          'every admitted fact is recorded unsatisfied after real work');

        const transitions = await store.readGovernedFactTransitions(runId);
        assertThat(transitions.newlyVerifiedFactIdentities.length === 0,
          'NO fact transition is newly verified');
        assertThat(transitions.windows.length === 1 &&
          transitions.windows[0].newlySatisfiedFactIdentities.length === 0,
        'the one request window credits nothing');

        // ── The canonical, cutoff-bound block ─────────────────────────────
        const block = finalRun.governedProgressBlock;
        assertThat(Boolean(block), 'ONE canonical progress block persists');
        assertThat(block.reason === 'verified_progress_exhausted',
          'the block reason is truthful: verified progress was exhausted');
        assertThat(block.decision === 'blocked', 'the decision is blocked');
        assertThat(block.consecutiveNoProgressWindows >= 1,
          'the consecutive no-progress threshold is exhausted');
        assertThat(Boolean(block.cutoff) &&
          Number.isFinite(Number(block.cutoff.postconditionEvidenceCutoff)),
        'the block is bound to a durable postcondition-evidence cutoff');
        assertThat(/^[0-9a-f]{64}$/.test(block.blockHash) &&
          /^[0-9a-f]{64}$/.test(block.verifiedProgressProjectionHash),
        'the block carries canonical projection and block hashes');
        assertThat(block.runId === runId,
          'the block names this Run');

        // Activity existed even though verified progress did not — the two
        // levels must stay distinguishable, or "did nothing" and "did nothing
        // that mattered" collapse into one wrong story.
        assertThat(block.cumulativeResources.durableOperations >= 1,
          'ACTIVITY exists: durable operations were performed');
        assertThat(block.cumulativeResources.providerRequests === 1,
          'exactly one provider request is counted cumulatively');

        // ── Stability: a blocked Run keeps spending nothing ───────────────
        await sleep(2000);
        const settled = await store.getRun(runId);
        assertThat(settled.governedProgressBlock.blockHash === block.blockHash,
          'the persisted block is stable — it is not rewritten');
        assertThat(capturesForRun().length === 1,
          'still exactly one transport call after the Run has settled');
        const settledCharges = (await store.pool.query(
          `SELECT id FROM ${store.table('run_budget_charges')}
            WHERE run_id = $1 AND dimension = 'model_request'`, [runId])).rows;
        assertThat(settledCharges.length === 1,
          'a blocked Run never acquires another budget charge');

        console.log(`  (${assertThat.count()} withholding assertions)`);
      } finally {
        await server.stop();
        fs.rmSync(capturePath, { force: true });
        fs.rmSync(responsePath, { force: true });
      }
    });

  // ── No-shortcut source boundary ─────────────────────────────────────────
  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['INSERT ', 'INTO'],
    ['recordOperation', 'Receipt'],
    ['persistGovernedProgress', 'Block'],
    ['reserveEconomic', 'Request'],
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

  console.log('governed no progress withholding PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
