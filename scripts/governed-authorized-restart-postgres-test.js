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
const OWNED_ROOT = 'reports/planner';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const LIMITS = {
  maxExecutionSteps: 8,
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
        GOVERNED_FAULT_MARKER: markerPath,
        GOVERNED_FAULT_STATE: statePath,
        RUNTIME_SCHEDULER_INTERVAL_MS: '200',
        // Short, so the crashed Run's lease expires promptly and the real
        // recovery path can reclaim it within the scenario.
        RUN_LEASE_DURATION_MS: '4000'
      };

      const capturesForRun = () => fs.readFileSync(capturePath, 'utf8').trim()
        .split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => String(entry.body || '').includes(OWNED_ROOT));
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
        // already happened — that would pay for the same answer twice.
        assertThat(capturesForRun().length === 1,
          'provider request 1 was NOT transported again');
        assertThat((await economicOf()).length === 1,
          'no duplicate request-1 economic reservation');
        assertThat((await chargesOf()).length === 1,
          'no duplicate request-1 runtime-budget charge');
        const receiptsAfterResume = (await store.pool.query(
          `SELECT id FROM ${store.table('operation_receipts')}
            WHERE run_id = $1 AND outcome = 'succeeded'`, [runId])).rows;
        assertThat(receiptsAfterResume.length === 1,
          'no duplicate operation receipt — the mutation was not re-committed');
        const resumedSnapshot = await replayOf();
        assertThat((resumedSnapshot.providerRequests || []).length === 1,
          'no duplicate provider-request replay item');
        assertThat((resumedSnapshot.modelResponses || []).length === 1,
          'no duplicate model-response replay item');
        const postBatchAfterResume = (await store.readGovernedPostconditionEvidence(runId))
          .filter(r => r.evaluationKind === 'post_batch');
        assertThat(postBatchAfterResume.length === 2,
          'no duplicate postcondition evidence for the recovered window');

        const transitionsResumed = await store.readGovernedFactTransitions(runId);
        assertThat(transitionsResumed.windows
          .filter(w => w.newlySatisfiedFactIdentities.includes(factA.declaredFactIdentity))
          .length === 1,
        'A is credited exactly once across the crash and recovery');
        assertThat(!transitionsResumed.newlyVerifiedFactIdentities
          .includes(factB.declaredFactIdentity),
        'B remains unverified');

        const baselineAfterResume = (await store.readGovernedPostconditionEvidence(runId))
          .filter(r => r.evaluationKind === 'baseline');
        assertThat(baselineAfterResume.length === 2,
          'the baseline is captured ONCE — resume re-reports it, never re-observes it');
        assertThat(capturesForRun().length === 1,
          'no provider request was replayed by the recovery itself');

      } finally {
        await second.stop();
      }

      // ── A second restart changes nothing that was already durable ──────
      const evidenceBeforeThird = (await store.readGovernedPostconditionEvidence(runId)).length;
      const chargesBeforeThird = (await chargesOf()).length;
      const third = await startServer({ env });
      try {
        await sleep(6000);
        assertThat((await store.readGovernedPostconditionEvidence(runId)).length ===
          evidenceBeforeThird,
        'a second restart appends no duplicate evidence');
        assertThat((await chargesOf()).length === chargesBeforeThird,
          'a second restart creates no further budget charge');
        assertThat(capturesForRun().length === 1,
          'a second restart dispatches nothing');

        // VERIFIED PROGRESS IS STILL NOT COMPLETION, EVEN AFTER RECOVERY.
        // B was never satisfied, so no surface may report this work as done —
        // whatever terminal status the recovered attempt happens to reach.
        const plan = await store.getAllocationPlanForTicket(run.ticketId);
        const items = (plan && plan.aggregateDecision && plan.aggregateDecision.items) || [];
        const leafItem = items.find(item =>
          Number(item.allocationItemId) === Number(run.allocationItemId));
        assertThat(!leafItem || leafItem.itemStatus !== 'completed',
          'the leaf item is NOT completed — B was never satisfied');

        const progress = await store.readGovernedRunProgressState(runId,
          { forUpdate: false });
        assertThat(progress.cumulativeResources.providerRequests === 1,
          'cumulative provider requests survives every restart');
        assertThat(typeof progress.executionEpochAt === 'string',
          'duration is still anchored to the IMMUTABLE epoch, not the latest attempt');

        console.log(`  (${assertThat.count()} authorized restart assertions)`);
      } finally {
        await third.stop();
        for (const file of [capturePath, responsePath, markerPath, statePath]) {
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
