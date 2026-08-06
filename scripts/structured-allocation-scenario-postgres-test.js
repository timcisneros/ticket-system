#!/usr/bin/env node
'use strict';

// Tranche 6 — scenario families 3, 4, 7, 8 and 9, executed through the REAL
// production paths.
//
// This is the companion to the family-1 five-arm milestone. It drives the same
// canonical PostgreSQL real-server harness — a spawned server under the
// hermetic preload, an authenticated session, the real `POST /tickets` form,
// and the existing scheduler, workers, terminalization and reconciliation —
// across every cell the execution matrix declares.
//
// WHAT IT PROVES, per cell:
//
//   * the declared cell actually ran and was observed;
//   * the independent oracle returned a verdict from raw state (plus, for the
//     coupling families, the fixture-owned access log);
//   * the family's own distinction is visible in durable state and fixture
//     facts — not inferred from model prose or terminal status;
//   * invoking the read-only report twice changes nothing;
//   * one immutable unscored artifact is written and cannot be overwritten.
//
// WHAT IT DELIBERATELY DOES NOT DO. No comparison, no ranking, no aggregate, no
// threshold, no arm scoring. A trial that ends in a truthful product failure is
// a RESULT, not a suite failure. A cell may only be skipped when the matrix
// itself declared the exclusion.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { MATRIX, NOT_NATURALLY_PRODUCED } = require('./fixtures/evaluation-execution-matrix');
const { runTrial } = require('./structured-allocation-evaluation-runner');

// One family per invocation keeps a single suite run bounded; with no argument
// every declared family runs.
const SELECTED = process.argv.slice(2).map(Number).filter(Number.isFinite);

function repositoryCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch (_) { return 'unknown'; }
}

async function main() {
  const commit = repositoryCommit();
  const smokeRoot = path.join('/tmp', 'ticket-system-structured-evaluation-smoke',
    `${commit.slice(0, 8)}-scenarios`);
  fs.mkdirSync(smokeRoot, { recursive: true });
  const namespaceRoot = path.join(smokeRoot, 'namespaces',
    `${process.pid}-${Date.now()}`);
  fs.mkdirSync(namespaceRoot, { recursive: true });

  const cells = SELECTED.length > 0
    ? MATRIX.filter(cell => SELECTED.includes(cell.family)) : MATRIX;
  if (cells.length === 0) throw new Error(`no matrix cell matches ${SELECTED.join(',')}`);

  await withHarness('structured allocation scenarios',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();
      const executed = [];

      for (const cell of cells) {
        const scenario = getScenario(cell.scenarioId);
        for (const armId of cell.requiredArms) {
          const arm = ARMS[armId];
          const label = `${cell.cellId}/${armId}`;
          const outputPath = path.join(smokeRoot, 'fixture',
            `${cell.cellId.replace('/', '-')}-${armId}.json`);
          if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

          let artifact = null;
          let failure = null;
          try {
            artifact = await runTrial({
              store, startServer, workspaceRoot, scenario, arm,
              variant: cell.variantId,
              repetition: 1, seed: `${cell.cellId}-${armId}-seed`,
              outputPath, commit, smokeRoot, namespaceRoot
            });
          } catch (error) { failure = error; }

          // A truthful product failure is DATA. A harness failure is not, and
          // the two are distinguished by whether the trial could be observed at
          // all.
          assertThat(failure === null,
            `${label}: the trial executed and was observed` +
            (failure ? ` — ${failure.stack}` : ''));
          if (failure) continue;
          executed.push({ label, artifact });

          // ── UNIVERSAL ARTIFACT REQUIREMENTS ─────────────────────────────
          assertThat(artifact.label === 'UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE',
            `${label}: the artifact is labelled unscored`);
          assertThat(artifact.repositoryCommit === commit,
            `${label}: the artifact records the exact repository commit`);
          assertThat(artifact.family === cell.family &&
            artifact.variantId === cell.variantId,
          `${label}: the artifact names its family and variant`);
          assertThat(artifact.pathProof.authority === 'durable_state',
            `${label}: the path proof is derived from durable state`);
          assertThat(artifact.ticketReport.secondReadIdentical === true,
            `${label}: invoking the read-only report twice changed nothing`);
          assertThat(cell.expectedOracleVerdicts.includes(artifact.oracleResult.verdict),
            `${label}: the oracle verdict ${artifact.oracleResult.verdict} is one the ` +
            `matrix declared (${cell.expectedOracleVerdicts.join('/')})`);

          const serialized = JSON.stringify(artifact);
          for (const forbidden of ['"rank"', '"winner"', '"score"', '"aggregate"']) {
            assertThat(!serialized.includes(forbidden),
              `${label}: the artifact carries no ${forbidden.replace(/"/g, '')}`);
          }
          assertThat(fs.existsSync(outputPath), `${label}: the artifact was written`);
          assert.throws(() => require('./fixtures/evaluation-quiescence')
            .writeTrialArtifact(outputPath, artifact), /refusing to overwrite/);
          assertThat(true, `${label}: overwriting the artifact is refused`);

          // ── FAMILY-SPECIFIC OBSERVATIONS ────────────────────────────────
          if (cell.family === 3 || cell.family === 4) {
            // The verdict must come from the COUPLING authority, which consults
            // the fixture access log — not from final files alone, which cannot
            // tell a genuine read from a staged one.
            assertThat(artifact.oracleResult.authority ===
              'independent_raw_state_and_fixture_access_log',
            `${label}: the coupling verdict is independent of product authority`);
            assertThat(Array.isArray(artifact.oracleResult.observations),
              `${label}: the coupling oracle recorded its raw observations`);
          }

          if (cell.family === 7) {
            const facts = artifact.churnFacts;
            const expected = artifact.variantExpectation;
            assertThat(Boolean(facts) && Boolean(expected),
              `${label}: churn facts and the variant expectation are recorded`);
            // DURABILITY IS THE FIRST DISTINCTION. 7B stages a boundary that
            // loses the response after transport, so no response becomes
            // durable and no window may be judged from it at all.
            assertThat((facts.durableResponses > 0) === expected.durableResponse,
              `${label}: durable-response fact matches the variant (` +
              `${facts.durableResponses} durable, expected ${expected.durableResponse})`);
            if (!expected.durableResponse) {
              assertThat(facts.refusedTransports > 0,
                `${label}: the undelivered window shows a refused transport`);
              // NOT churn: nothing was delivered, so no no-progress window
              // exists to count.
              assertThat(facts.noProgressStreak === null || facts.noProgressStreak === 0,
                `${label}: an undelivered response contributes no churn`);
            }
          }

          if (cell.family === 8) {
            const facts = artifact.recoveryFacts;
            const expected = artifact.variantExpectation;
            assertThat(Boolean(facts) && Boolean(expected),
              `${label}: recovery facts and the variant expectation are recorded`);
            assertThat(facts.servedCalls === expected.servedCalls,
              `${label}: served calls ${facts.servedCalls}, expected ` +
              `${expected.servedCalls}`);
            // THE CENTRAL RECOVERY GUARANTEE. An uncertainly delivered request
            // is never retransmitted, and a durable response is reused rather
            // than resent — both appear as zero duplicate served calls.
            assertThat(facts.duplicateServedCalls === 0,
              `${label}: no request was retransmitted`);
            assertThat(facts.duplicateEffects === 0,
              `${label}: no committed effect was duplicated`);
            if (expected.servedCalls === 0) {
              assertThat(facts.refusedBefore > 0,
                `${label}: the pre-transport boundary refused before any byte`);
              assertThat(facts.committedEffects === 0,
                `${label}: a pre-transport failure left no external effect`);
            }
          }

          if (cell.family === 9) {
            assertThat(typeof artifact.truthfulness === 'string',
              `${label}: a truthfulness classification is recorded`);
            // A MODEL CLAIM IS NEVER RAW TRUTH. 9A stages a model that claims
            // completion having done nothing; the oracle must still say the
            // objective is unmet.
            if (cell.cellId === 'family-9/9A') {
              assertThat(artifact.oracleResult.verdict === 'fail',
                `${label}: raw state reports the objective unmet`);
              assertThat(artifact.truthfulness !== 'true_positive_completion',
                `${label}: a claimed completion is not recorded as a truthful one`);
            }
            if (cell.cellId === 'family-9/9C') {
              assertThat(artifact.oracleResult.verdict === 'refused',
                `${label}: undecidable raw state REFUSES rather than guessing`);
              assertThat(artifact.truthfulness === 'oracle_refused',
                `${label}: refusal is classified as refusal, not as a result`);
            }
          }
        }
      }

      // Every declared cell produced an artifact. A silently skipped cell is
      // the failure this assertion exists to prevent.
      const expectedTrials = cells.reduce((n, cell) => n + cell.requiredArms.length, 0);
      assertThat(executed.length === expectedTrials,
        `every declared matrix cell executed (${executed.length} of ${expectedTrials})`);

      assertThat(NOT_NATURALLY_PRODUCED.every(entry => entry.reason && entry.provedInsteadBy),
        'any not-naturally-produced variant names both its reason and its substitute proof');

      console.log(`\n  (${assertThat.count()} scenario assertions)`);
      console.log(`  artifacts: ${path.join(smokeRoot, 'fixture')}`);
    }, { timeoutMs: 5_400_000 });

  console.log('structured allocation scenario PostgreSQL test passed');
  console.log('UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE');
}

main().catch(error => { console.error(error); process.exit(1); });
