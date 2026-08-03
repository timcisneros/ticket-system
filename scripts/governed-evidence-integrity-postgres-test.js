#!/usr/bin/env node
'use strict';

// Tranche 5 — a committed receipt whose evidence never committed.
//
// THE DISTINCTION THIS PROTECTS. "We did not record whether the fact advanced"
// and "the fact did not advance" are different statements. Only the second may
// count a no-progress window and spend a Run's churn tolerance. If missing
// evidence were read as an unsatisfied fact, an interrupted writer would look
// exactly like an agent making no progress, and the Run would be stopped for
// churn it may never have committed — with `verified_progress_exhausted`
// persisted as the operator-visible reason, which would be false about the work.
//
// So this drives the real hermetic governed worker to commit a REAL mutation and
// a REAL receipt, interrupts deterministically between the receipt and the
// atomic evidence set, and then proves the runtime refuses on integrity rather
// than proceeding on a guess — and spends nothing further.
//
// The interruption is a decorator installed before server.js loads (see
// scripts/fixtures/governed-fault-injection-preload.js). Production source has
// no branch for it, which matters here more than anywhere: the behaviour under
// test is precisely "does it silently continue".

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

const STAMP = `gei-${Date.now()}`;
const ACTOR = 'governed-evidence-integrity-test';
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
  maxModelRequestsPerRun: 3,
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
  await withHarness('governed evidence integrity',
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
      const factB = facts.find(f => f.criterion.path.endsWith('/beta'));
      fs.mkdirSync(path.join(workspaceRoot, OWNED_ROOT), { recursive: true });

      const tmp = suffix => path.join(os.tmpdir(), `gei-${suffix}-${process.pid}-${STAMP}`);
      const capturePath = tmp('cap');
      const responsePath = tmp('res');
      const markerPath = tmp('marker');
      const statePath = tmp('state');
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(markerPath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          staged('fixture-integrity-response-1', {
            message: 'Creating the first declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          }),
          // Staged so a runtime that wrongly continued would SUCCEED in getting
          // an answer. A refusal here would look like a transport problem
          // instead of the integrity failure this scenario is about.
          staged('fixture-integrity-response-2-must-not-be-served', {
            message: 'This must never be requested.',
            actions: [{ operation: 'createFolder', args: { path: factB.criterion.path } }],
            complete: false
          })
        ]
      }));

      const env = {
        NODE_OPTIONS: `--require ${HERMETIC} --require ${FAULT}`,
        OPENAI_API_KEY: SENTINEL,
        HERMETIC_TRANSPORT_CAPTURE: capturePath,
        HERMETIC_TRANSPORT_RESPONSE: responsePath,
        GOVERNED_FAULT_MARKER: markerPath,
        GOVERNED_FAULT_STATE: statePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        // Short, so the crashed Run's lease expires promptly and the real
        // recovery path can reclaim it within the scenario.
        RUN_LEASE_DURATION_MS: '4000'
      };

      const receiptsOf = async () => (await store.pool.query(
        `SELECT id, step_id, operation, outcome, workspace_path
           FROM ${store.table('operation_receipts')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;
      const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => String(entry.body || '').includes(LEAF_MARKER));
      const chargesOf = async () => (await store.pool.query(
        `SELECT source_identity, state FROM ${store.table('run_budget_charges')}
          WHERE run_id = $1 AND dimension = 'model_request' ORDER BY id`, [runId])).rows;
      const economicOf = async () => (await store.pool.query(
        `SELECT logical_source_identity FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;

      // ── Server 1: interrupted between receipt and evidence set ──────────
      const first = await startServer({
        env: { ...env, GOVERNED_FAULT_BOUNDARY: 'before_evidence_set_commit' }
      });
      let interrupted = false;
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_A_REACHED')) {
            interrupted = true; break;
          }
          await sleep(500);
        }
        assertThat(String(first.output()).includes('HERMETIC_PRELOAD_ACTIVE=true'),
          'the hermetic boundary was active');
        assertThat(String(first.output())
          .includes('GOVERNED_FAULT_PRELOAD_ACTIVE=before_evidence_set_commit'),
        'the interruption seam was armed at the named boundary');
        assertThat(interrupted,
          'the EXACT boundary was reached: the evidence set was about to commit');
        // Let the interrupted Run settle rather than racing its unwind.
        await sleep(3000);
      } finally {
        // The child crashed at the boundary; stopping a dead child is fine.
        try { await first.stop(); } catch (_) { /* already gone */ }
      }

      // ── The receipt is durable; the evidence is not ─────────────────────
      const receipts = await receiptsOf();
      const mutations = receipts.filter(row =>
        row.operation === 'createFolder' && row.outcome === 'succeeded');
      assertThat(mutations.length === 1,
        'the operation receipt remains durable after the interruption');
      assertThat(fs.existsSync(path.join(workspaceRoot, factA.criterion.path)),
        'the real workspace mutation survives');

      const evidence = await store.readGovernedPostconditionEvidence(runId);
      const baseline = evidence.filter(row => row.evaluationKind === 'baseline');
      const postBatch = evidence.filter(row => row.evaluationKind === 'post_batch');
      assertThat(baseline.length === 2,
        'the eligible fact catalog is valid and fully baselined');
      assertThat(postBatch.length === 0,
        'the required post-batch evidence is ABSENT — the set never committed');

      // ── Integrity refusal, not a no-progress verdict ────────────────────
      let refusal = null;
      try {
        await store.readGovernedFactTransitions(runId);
      } catch (error) {
        refusal = error;
      }
      assertThat(refusal !== null,
        'readGovernedFactTransitions REFUSES incomplete authority');
      assertThat(refusal.code === 'GOVERNED_FACT_TRANSITION_REFUSED',
        'the refusal is the canonical integrity result');
      assertThat(refusal.detail && refusal.detail.reason === 'fact_evidence_incomplete',
        'the reason names incomplete evidence, not an unsatisfied fact');

      const afterFault = await store.getRun(runId);
      assertThat(!afterFault.governedProgressBlock ||
        afterFault.governedProgressBlock.reason !== 'verified_progress_exhausted',
      'NO verified_progress_exhausted block was produced — this is not churn');

      const chargesAfterFault = await chargesOf();
      const economicAfterFault = await economicOf();
      const capturesAfterFault = capturesForRun();
      assertThat(chargesAfterFault.length === 1,
        'no new runtime-budget charge was created');
      assertThat(economicAfterFault.length === 1,
        'no new economic reservation was created');
      assertThat(capturesAfterFault.length === 1, 'no further transport call occurred');

      // ── Server 2: restart. The fault is spent; behaviour is normal ──────
      const second = await startServer({ env });
      try {
        assertThat(String(second.output())
          .includes('GOVERNED_FAULT_PRELOAD_ACTIVE=none'),
        'the restarted server carries no armed fault');
        await sleep(6000);

        const replay = await store.readRunReplay(runId);
        const snapshot = (replay && replay.snapshot) || {};
        assertThat((snapshot.providerRequests || []).length === 1,
          'no provider-request replay item was created after the integrity failure');
        assertThat(!JSON.stringify(snapshot).includes('must-not-be-served'),
          'no second provider response entered the Run');
        assertThat(capturesForRun().length === 1,
          'still no transport call after restart');
        assertThat((await chargesOf()).length === 1,
          'still no new runtime-budget charge after restart');
        assertThat((await economicOf()).length === 1,
          'still no new economic reservation after restart');

        // THE OLD WINDOW IS NOT RE-JUDGED. `alpha` exists now, so a runtime that
        // re-evaluated the interrupted batch against current workspace state
        // would happily manufacture the verdict it failed to record — turning a
        // recorded integrity failure into invented progress.
        const settledEvidence = await store.readGovernedPostconditionEvidence(runId);
        const settledPostBatch = settledEvidence
          .filter(row => row.evaluationKind === 'post_batch');
        assertThat(settledPostBatch.every(row =>
          row.batchStepId !== String(mutations[0].step_id)),
        'the interrupted batch is never re-evaluated against later workspace state');
        assertThat((await receiptsOf()).length === receipts.length,
          'no further receipts committed');

        console.log(`  (${assertThat.count()} evidence integrity assertions)`);
      } finally {
        await second.stop();
        for (const file of [capturePath, responsePath, markerPath, statePath]) {
          fs.rmSync(file, { force: true });
        }
      }
    });

  // ── No-shortcut source boundary ─────────────────────────────────────────
  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['INSERT ', 'INTO'],
    ['DELETE ', 'FROM'],
    ['UPDATE ', 'runs'],
    ['recordOperation', 'Receipt']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — and never repairs the database after the fault`);
  }

  console.log('governed evidence integrity PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
