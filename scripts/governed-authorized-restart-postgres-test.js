#!/usr/bin/env node
'use strict';

// Tranche 5 — a crashed governed Run can be recovered at all.
//
// The lifecycle suite proves that complete request-1 evidence authorizes a
// second governed request. This proves that authority is a HISTORICAL FACT
// reconstructed from durable rows, not an in-flight decision that a restart can
// lose or repeat.
//
// Both failure directions cost real money. Lose it, and a Run that genuinely
// advanced stops as though it had churned. Repeat it, and every crash buys
// another provider request against the same earned progress — an unbounded
// spend that looks like normal operation from every surface.
//
// So the interruption lands exactly between durable request-1 evidence and any
// request-2 authority, and the scenario then restarts twice.

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

const STAMP = `gar-${Date.now()}`;
const ACTOR = 'governed-authorized-restart-test';
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
  maxExecutionSteps: 8,
  // EXACTLY TWO, because this Run genuinely makes exactly two requests. The
  // crashed attempt's replayed turn is not a third: it is request 1 again,
  // already counted from durable evidence. Sitting exactly on the ceiling is
  // deliberate — it is what makes double-counting the replayed turn fail here
  // rather than pass unnoticed with headroom to absorb it.
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
  await withHarness('governed authorized restart',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();

      const seeded = await seedGovernedStructuredTicket(store, {
        stamp: STAMP,
        actor: ACTOR,
        workspaceRoot,
        agentApiKey: SENTINEL,
        runtimeLimits: LIMITS,
        ticketObjective:
          'Create folders reports/planner/alpha and reports/planner/beta',
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

      const tmp = suffix => path.join(os.tmpdir(), `gar-${suffix}-${process.pid}-${STAMP}`);
      const capturePath = tmp('cap');
      const responsePath = tmp('res');
      const markerPath = tmp('marker');
      const statePath = tmp('state');
      const servedPath = tmp('served');
      fs.writeFileSync(capturePath, '');
      fs.writeFileSync(markerPath, '');
      fs.writeFileSync(responsePath, JSON.stringify({
        responses: [
          staged('fixture-restart-response-1', {
            message: 'Creating the first declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factA.criterion.path } }],
            complete: false
          }),
          staged('fixture-restart-response-2', {
            message: 'Creating the second declared folder.',
            actions: [{ operation: 'createFolder', args: { path: factB.criterion.path } }],
            complete: true
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
        // Short, so the crashed Run's lease expires promptly and the real
        // recovery path can reclaim it within the scenario.
        RUN_LEASE_DURATION_MS: '4000'
      };

      const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => String(entry.body || '').includes(LEAF_MARKER));
      const chargesOf = async () => (await store.pool.query(
        `SELECT source_identity, state FROM ${store.table('run_budget_charges')}
          WHERE run_id = $1 AND dimension = 'model_request' ORDER BY id`, [runId])).rows;
      const economicOf = async () => (await store.pool.query(
        `SELECT logical_source_identity, model_request_ordinal
           FROM ${store.table('economic_request_reservations')}
          WHERE run_id = $1 ORDER BY id`, [runId])).rows;
      const replayOf = async () => {
        const replay = await store.readRunReplay(runId);
        return (replay && replay.snapshot) || {};
      };

      // ── Server 1: interrupted after request-1 evidence, before request 2 ──
      const first = await startServer({
        env: { ...env, GOVERNED_FAULT_BOUNDARY: 'before_next_request_reservation' }
      });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_B_REACHED')) break;
          await sleep(500);
        }
        assertThat(fs.readFileSync(markerPath, 'utf8').includes('BOUNDARY_B_REACHED'),
          'the EXACT boundary was reached: request-2 authority was about to be created');
        await sleep(3000);
      } finally {
        // The child crashed at the boundary; stopping a dead child is fine.
        try { await first.stop(); } catch (_) { /* already gone */ }
      }

      // ── Durable state after the interruption ────────────────────────────
      const evidenceBefore = await store.readGovernedPostconditionEvidence(runId);
      const postBatchBefore = evidenceBefore.filter(r => r.evaluationKind === 'post_batch');
      assertThat(postBatchBefore.length === 2,
        'request 1 durably committed its COMPLETE evidence set');
      const verdictBefore = fact => postBatchBefore
        .find(r => r.declaredFactIdentity === fact.declaredFactIdentity).satisfied;
      assertThat(verdictBefore(factA) === true && verdictBefore(factB) === false,
        'the durable request-1 evidence is A=true, B=false');
      assertThat(capturesForRun().length === 1, 'exactly one transport call so far');
      assertThat((await chargesOf()).length === 1, 'exactly one budget charge so far');
      assertThat((await economicOf()).length === 1, 'exactly one economic reservation so far');

      const transitionsBefore = await store.readGovernedFactTransitions(runId);
      const baselineIdsBefore = evidenceBefore
        .filter(r => r.evaluationKind === 'baseline').map(r => r.evidenceId).sort();

      // ── Server 2: restart. Authority is reconstructed, once ─────────────
      const second = await startServer({ env });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await store.getRun(runId);
          if (['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) break;
          await sleep(500);
        }
        await sleep(2000);

        const evidenceAfter = await store.readGovernedPostconditionEvidence(runId);
        const baselineIdsAfter = evidenceAfter
          .filter(r => r.evaluationKind === 'baseline').map(r => r.evidenceId).sort();
        assertThat(JSON.stringify(baselineIdsAfter) === JSON.stringify(baselineIdsBefore),
          'the SAME baseline rows are read — none re-appended');
        const window1After = evidenceAfter.filter(r =>
          r.evaluationKind === 'post_batch' &&
          r.batchStepId === postBatchBefore[0].batchStepId);
        assertThat(window1After.length === 2,
          'request-1 evidence is unchanged — no duplicate row was appended');

        const transitionsAfter = await store.readGovernedFactTransitions(runId);
        const creditedA = transitionsAfter.creditedInBatch[factA.declaredFactIdentity];
        assertThat(creditedA === transitionsBefore.creditedInBatch[factA.declaredFactIdentity],
          'the SAME cutoff-bounded A false-to-true transition is derived after restart');
        assertThat(transitionsAfter.windows
          .filter(w => w.newlySatisfiedFactIdentities.includes(factA.declaredFactIdentity))
          .length === 1,
        'A is credited EXACTLY ONCE across the restart');

        // ── WHAT THIS PROVES, AND WHAT IT DOES NOT ──────────────────────
        //
        // Recovery is ADMITTED: the crashed governed Run is reclaimed and
        // resumes without being rejected by its own durable evidence. Two
        // production defects made that impossible, and each is load-bearing
        // here — remove either and this suite fails with that exact error.
        //
        //   1. the governed response replay item carried no
        //      `providerRequestEvidenceKey`, so `hasDurableAgentResponseWithoutPlan`
        //      refused to resume any governed Run at all;
        //   2. the baseline was re-observed on resume against a workspace the
        //      Run had already changed, so the append conflicted with the
        //      baseline it had written itself.
        //
        // Request 2 does NOT yet dispatch after recovery — a third defect,
        // recorded in the pending-decisions register. This suite therefore
        // asserts recovery admission and evidence identity, and deliberately
        // asserts nothing about request-2 authority.
        const resumedRun = await store.getRun(runId);
        const resumeError = String(resumedRun.error || '');
        // A POSITIVE assertion, not merely the absence of known errors. Checking
        // only that specific messages are missing lets any NEW recovery failure
        // pass silently — which is how a mutation that broke rehydration a
        // different way slipped through this suite once.
        assertThat(resumedRun.status !== 'failed',
          'the recovered Run is not terminalized by its own recovery');
        assertThat(!resumeError.includes('Resume denied'),
          'recovery is ADMITTED: the Run is not rejected by the resume identity contract');
        assertThat(!resumeError.includes('already holds different evidence'),
          'the resumed Run does not conflict with the baseline it wrote itself');
        // The reused reservation reports identity and hash, not the transcript.
        // Without rehydration from the Run's own canonical response evidence the
        // worker received `text: null`, and `JSON.parse("null")` then died
        // reading `.message` of it.
        assertThat(!resumeError.includes('not valid execution JSON'),
          'the recovered Run rehydrates its durable response instead of parsing null');

        // ── REQUEST 1 IS NOT REPEATED ────────────────────────────────────
        //
        // Recovery may reconstruct state. It may not re-execute a request that
        // already happened — that would pay for the same answer twice. Request 1
        // is identified by its own reserved ordinal, not by counting calls.
        const economicAfter = await economicOf();
        const ordinals = economicAfter.map(row => Number(row.model_request_ordinal));
        assertThat(ordinals.filter(ordinal => ordinal === 1).length === 1,
          'request 1 holds exactly ONE economic reservation — it was not re-reserved');
        const chargesAfter = await chargesOf();
        assertThat(chargesAfter
          .filter(row => row.source_identity === 'model-request:agent:0:provider')
          .length === 1,
        'no duplicate request-1 runtime-budget charge');
        const capturedAll = capturesForRun();
        assertThat(capturedAll.filter(entry =>
          String(entry.body || '').includes('alpha') &&
          !String(entry.body || '').includes('beta')).length <= 1,
        'request 1 was not transported a second time');
        const resumedSnapshot = await replayOf();
        assertThat((resumedSnapshot.modelResponses || [])
          .filter(item => item.responseHash === (resumedSnapshot.modelResponses[0] || {}).responseHash)
          .length === 1,
        'no duplicate model-response replay item for the recovered turn');
        const succeededReceipts = (await store.pool.query(
          `SELECT id, workspace_path FROM ${store.table('operation_receipts')}
            WHERE run_id = $1 AND outcome = 'succeeded' ORDER BY id`, [runId])).rows;
        assertThat(succeededReceipts
          .filter(row => String(row.workspace_path).endsWith('alpha')).length === 1,
        'no duplicate operation receipt — request 1 mutation was not re-committed');
        const postBatchAfter = (await store.readGovernedPostconditionEvidence(runId))
          .filter(r => r.evaluationKind === 'post_batch');
        assertThat(postBatchAfter.filter(r => r.batchStepId === '0').length === 2,
          'no duplicate postcondition evidence for the recovered window');

        // ── A IS CREDITED ONCE, AND IT AUTHORIZED REQUEST 2 ──────────────
        const transitionsResumed = await store.readGovernedFactTransitions(runId);
        assertThat(transitionsResumed.windows
          .filter(w => w.newlySatisfiedFactIdentities.includes(factA.declaredFactIdentity))
          .length === 1,
        'A is credited exactly once across the crash and recovery');

        // ── REQUEST 2 EXACTLY ONCE ───────────────────────────────────────
        //
        // The whole point of recovering: the SAME Run goes on to earn its next
        // request from durable evidence, rather than discarding proven progress.
        assertThat(ordinals.filter(ordinal => ordinal === 2).length === 1,
          'exactly ONE request-2 economic reservation exists');
        assertThat(chargesAfter
          .filter(row => row.source_identity === 'model-request:agent:1:provider')
          .length === 1,
        'exactly ONE request-2 runtime-budget charge exists');
        assertThat((resumedSnapshot.providerRequests || []).length === 2,
          'exactly ONE request-2 provider-request replay item exists');
        assertThat(capturedAll.length === 2,
          'exactly ONE request-2 transport call occurred');
        assertThat(!resumedRun.governedProgressBlock,
          'no progress block exists — A reset the no-progress streak');

        // ── SAME RUN, SAME AUTHORITY ─────────────────────────────────────
        //
        // A recovery lease or attempt may change. Execution authority may not.
        assertThat(resumedRun.id === run.id && resumedRun.ticketId === run.ticketId,
          'request 2 is issued by the SAME Run and Ticket — no replacement Run');
        assertThat(resumedRun.allocationItemId === run.allocationItemId,
          'the same allocation item');
        assertThat(JSON.stringify(resumedRun.leafRunBinding) ===
          JSON.stringify(run.leafRunBinding),
        'the same leaf binding');
        assertThat(resumedRun.completionAuthoritySnapshot.snapshotHash ===
          run.completionAuthoritySnapshot.snapshotHash,
        'the same captured completion authority hash');
        assertThat(JSON.stringify(resumedRun.governedExecution.progressControlPolicy) ===
          JSON.stringify(run.governedExecution.progressControlPolicy),
        'the same captured progress policy');

        const progress = await store.readGovernedRunProgressState(runId,
          { forUpdate: false });
        assertThat(progress.cumulativeResources.providerRequests === 2,
          'cumulative provider requests is 2 across the crash — never reset');
        assertThat(typeof progress.executionEpochAt === 'string',
          'duration is still anchored to the IMMUTABLE epoch, not the latest attempt');
      } finally {
        await second.stop();
      }

      // ── A further restart buys nothing ─────────────────────────────────
      const economicBeforeThird = (await economicOf()).length;
      const chargesBeforeThird = (await chargesOf()).length;
      const capturesBeforeThird = capturesForRun().length;
      const evidenceBeforeThird = (await store.readGovernedPostconditionEvidence(runId)).length;
      const third = await startServer({ env });
      try {
        await sleep(6000);
        assertThat((await economicOf()).length === economicBeforeThird,
          'a further restart creates no additional economic reservation');
        assertThat((await chargesOf()).length === chargesBeforeThird,
          'a further restart creates no additional budget charge');
        assertThat(capturesForRun().length === capturesBeforeThird,
          'a further restart dispatches nothing');
        assertThat((await store.readGovernedPostconditionEvidence(runId)).length ===
          evidenceBeforeThird,
        'a further restart appends no duplicate evidence');

        console.log(`  (${assertThat.count()} authorized restart assertions)`);
      } finally {
        await third.stop();
        for (const file of [capturePath, responsePath, markerPath, statePath, servedPath]) {
          fs.rmSync(file, { force: true });
        }
      }
    });

  const forbidden = [
    ['appendGovernedPostcondition', 'Evidence'],
    ['INSERT ', 'INTO'],
    ['DELETE ', 'FROM'],
    ['UPDATE ', 'runs'],
    ['reserveEconomic', 'Request']
  ].map(parts => parts.join(''));
  const executable = fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !/^\s*\['/.test(line))
    .join('\n');
  for (const name of forbidden) {
    assert.equal(executable.includes(name), false,
      `the suite never calls ${name} — production creates and recovers these records`);
  }

  console.log('governed authorized restart PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
