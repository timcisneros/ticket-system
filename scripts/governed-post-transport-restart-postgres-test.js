#!/usr/bin/env node
'use strict';

// Tranche 5 — a request the provider RECEIVED, whose answer never landed.
//
// The crash lands at the last instant before any byte leaves, once request 2
// has already obtained every piece of durable dispatch authority: economic
// reservation, ordinal, runtime-budget charge and provider-request replay all
// commit before transport. That is the dangerous window. A recovering process
// that treats an un-transported request as "never happened" would abandon
// authority the Ticket has already been charged for and buy a second one under
// a fresh identity — spending twice for one logical request, and doing it in
// the way that looks most like normal operation from every surface.
//
// So the assertion is not merely "one transport". It is that the SAME logical
// request identity, ordinal and reservation carry through the restart.
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

const STAMP = `gxa-${Date.now()}`;
const ACTOR = 'governed-post-transport-restart-test';
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
  await withHarness('governed post-transport restart',
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

      const tmp = suffix => path.join(os.tmpdir(), `gxa-${suffix}-${process.pid}-${STAMP}`);
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
        env: { ...env, HERMETIC_TRANSPORT_CRASH_AFTER_ORDINAL: '2' }
      });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (fs.existsSync(`${capturePath}.marker`) &&
              fs.readFileSync(`${capturePath}.marker`, 'utf8')
                .includes('BOUNDARY_POST_TRANSPORT_REACHED')) break;
          await sleep(500);
        }
        assertThat(fs.existsSync(`${capturePath}.marker`) &&
          fs.readFileSync(`${capturePath}.marker`, 'utf8')
            .includes('BOUNDARY_POST_TRANSPORT_REACHED'),
        'the EXACT boundary was reached: the provider RECEIVED request 2, then the process died');
        await sleep(3000);
      } finally {
        // The child crashed at the boundary; stopping a dead child is fine.
        try { await first.stop(); } catch (_) { /* already gone */ }
      }

      // ── Request 2 already holds ALL of its dispatch authority ───────────
      const economicBefore = await economicOf();
      const chargesBefore = await chargesOf();
      const replayBefore = await replayOf();
      assertThat(economicBefore.length === 2,
        'request 2 durably reserved before the crash');
      const requestTwoBefore = economicBefore[1];
      assertThat(Number(requestTwoBefore.model_request_ordinal) === 2,
        'request 2 holds ordinal 2');
      assertThat(requestTwoBefore.logical_source_identity ===
        'model-request:agent:1:provider',
      'request 2 holds its canonical logical source identity');
      assertThat(chargesBefore.length === 2,
        'request 2 durably charged the runtime budget before the crash');
      assertThat((replayBefore.providerRequests || []).length === 2,
        'request 2 durably persisted its provider-request replay before transport');
      assertThat(capturesForRun().length === 2,
        'the fixture RECORDED request 2 — the bytes really did arrive');
      assertThat((replayBefore.modelResponses || []).length === 1,
        'no response exists for request 2');

      // ── Server 2: restart. Authority is reconstructed, once ─────────────
      const second = await startServer({ env });
      try {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const current = await store.getRun(runId);
          if (['completed', 'failed', 'blocked', 'cancelled'].includes(current.status)) break;
          await sleep(500);
        }
        await sleep(2000);

        // Request-1 evidence is untouched by request 2's recovery.
        const evidenceAfter = await store.readGovernedPostconditionEvidence(runId);
        assertThat(evidenceAfter.filter(r => r.evaluationKind === 'baseline').length === 2,
          'the baseline is still captured exactly once');
        const transitionsAfter = await store.readGovernedFactTransitions(runId);
        assertThat(transitionsAfter.windows
          .filter(w => w.newlySatisfiedFactIdentities.includes(factA.declaredFactIdentity))
          .length === 1,
        'A remains credited exactly once');

        // ── THE SAME REQUEST IS REUSED, NOT RE-BOUGHT ───────────────────
        const economicAfter = await economicOf();
        const chargesAfter = await chargesOf();
        const replayAfter = await replayOf();

        assertThat(economicAfter.length === 2,
          'no additional economic reservation was created');
        assertThat(economicAfter.map(r => Number(r.model_request_ordinal))
          .join(',') === '1,2',
        'no additional ordinal was derived — the ordinals are still 1,2');
        assertThat(economicAfter[1].logical_source_identity ===
          requestTwoBefore.logical_source_identity,
        'request 2 kept its logical source identity across the restart');
        assertThat(chargesAfter.length === 2,
          'no additional runtime-budget charge');
        assertThat((replayAfter.providerRequests || []).length === 2,
          'no duplicate provider-request replay item');

        // ── NO SECOND TRANSPORT, AND NO SILENT RE-BUY ───────────────────
        //
        // What recovery must never do is treat an un-transported request as
        // "never happened" and buy another under a fresh identity. It does not:
        // the ordinals, reservation and charge above are unchanged.
        assertThat(capturesForRun().length === 2,
          'request 2 was never transported a second time');
        assertThat((replayAfter.modelResponses || []).length <= 2,
          'at most one response identity exists for request 2');

        // ── A MERELY AUTHORIZED REQUEST IS NOT A NO-PROGRESS WINDOW ─────
        //
        // Request 2 has an ordinal and a started reservation and no answer. It
        // has not failed to advance the work; it has not had the chance to. The
        // Run must not be stopped for churn on the strength of a request it was
        // interrupted before sending.
        const stopped = await store.getRun(runId);
        assertThat(!stopped.governedProgressBlock,
          'NO progress block: an unanswered request is not a no-progress window');
        const reservationStates = (await store.pool.query(
          `SELECT model_request_ordinal AS ord, state, response_hash IS NOT NULL AS answered
             FROM ${store.table('economic_request_reservations')}
            WHERE run_id = $1 ORDER BY model_request_ordinal`, [runId])).rows;
        assertThat(reservationStates.length === 2 &&
          reservationStates[0].answered === true &&
          reservationStates[1].answered === false,
        'request 1 is answered and request 2 is not — the two are distinguishable');

        // ── TRANSPORT UNCERTAINTY, FAILING CLOSED ───────────────────────
        //
        // Production cannot prove the bytes never left. `markEconomicRequestStarted`
        // commits BEFORE transport and nothing durable separates "request replay
        // persisted" from "transport began", so a started reservation with no
        // response is genuinely ambiguous. The existing Tranche 4 contract
        // refuses to re-dispatch it rather than guess, and that refusal is the
        // correct behaviour: sending again could pay for and apply a second
        // answer to a request the provider may already have served.
        assertThat(reservationStates[1].state === 'request_started',
          'request 2 keeps its started reservation — it is neither re-sent nor discarded');
        assertThat(['failed', 'blocked'].includes(stopped.status),
          'the Run reaches an explicit durable stop rather than looping');
        assertThat(!/verified_progress_exhausted/.test(String(stopped.error || '')),
          'and it does NOT stop for churn');

        // ── THE DISPOSITION SAYS WHAT ACTUALLY HAPPENED ─────────────────
        //
        // It previously said the Run was "still executing under lease" — naming
        // the recovering process as its own competitor, which is untrue and
        // unactionable. The durable reason now states the real condition and
        // binds the request it is about.
        const uncertainty = String(stopped.error || '');
        assertThat(/holds no durable response/.test(uncertainty),
          'the durable reason states that no response proves the outcome');
        assertThat(/automatic retransmission is unsupported/.test(uncertainty),
          'and that retransmission is not attempted');
        assertThat(uncertainty.includes('model-request:agent:1:provider'),
          'the disposition binds the exact logical request source');
        assertThat(/request 2/.test(uncertainty),
          'and its ordinal');
        assertThat(!/still executing under lease/.test(uncertainty),
          'it no longer describes the recovering process as a competing executor');

        // ── Same Run, same captured authority ───────────────────────────
        const resumed = await store.getRun(runId);
        assertThat(resumed.id === run.id && resumed.ticketId === run.ticketId,
          'no replacement Run — same Run and Ticket');
        assertThat(resumed.allocationItemId === run.allocationItemId,
          'same allocation item');
        assertThat(JSON.stringify(resumed.leafRunBinding) ===
          JSON.stringify(run.leafRunBinding),
        'same leaf binding');
        assertThat(resumed.completionAuthoritySnapshot.snapshotHash ===
          run.completionAuthoritySnapshot.snapshotHash,
        'same captured completion authority');
        assertThat(JSON.stringify(resumed.governedExecution.progressControlPolicy) ===
          JSON.stringify(run.governedExecution.progressControlPolicy),
        'same captured progress policy');
        const progressState = await store.readGovernedRunProgressState(runId,
          { forUpdate: false });
        assertThat(typeof progressState.executionEpochAt === 'string',
          'same immutable execution epoch');
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

        // Idempotent: the same reason, not a new or escalating one.
        const repeated = await store.getRun(runId);
        assertThat(/holds no durable response/.test(String(repeated.error || '')),
          'repeated restart returns the SAME delivery-uncertain reason');
        assertThat(!repeated.governedProgressBlock,
          'repeated restart still creates no progress block');
        const repeatedReservations = (await store.pool.query(
          `SELECT model_request_ordinal AS ord FROM ${store.table('economic_request_reservations')}
            WHERE run_id = $1`, [runId])).rows;
        assertThat(repeatedReservations.length === 2,
          'repeated restart creates no third ordinal');

        console.log(`  (${assertThat.count()} post-transport restart assertions)`);
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

  console.log('governed post-transport restart PostgreSQL test passed');
}

main().catch(error => { console.error(error); process.exit(1); });
