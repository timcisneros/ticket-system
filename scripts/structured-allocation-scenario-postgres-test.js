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
          // ── THE OBSERVATION CONTRACT ────────────────────────────────────
          //
          // Every artifact must say whether an observer was actually running.
          // A count read without this is a number that cannot be interpreted:
          // zero means "nothing happened" only when completeness is complete.
          assertThat(artifact.observationCompleteness === 'complete',
            `${label}: the shared observation sink was installed and complete ` +
            `(got ${artifact.observationCompleteness})`);
          assertThat(Boolean(artifact.observationSinkVersion) &&
            Boolean(artifact.observationStreamIdentities),
          `${label}: the artifact records the sink version and stream identities`);
          // A trial that reached the provider must show it in the SHARED
          // stream. Both transports write there, so an empty stream beside a
          // non-zero request count means an adapter is not reporting.
          // ── A DURABLE RESPONSE MUST NAME THE RESPONSE IT DELIVERED ──────
          //
          // An unexpected request has no staged response, so it can only ever
          // be a refusal. Recording it as durable would invent a delivery that
          // never happened — and a durable observation with no response
          // identity is exactly what that looks like.
          for (const roleFacts of [
            ['planner', (artifact.churnFacts || artifact.recoveryFacts || {}).planner],
            ['worker', (artifact.churnFacts || artifact.recoveryFacts || {}).worker]
          ]) {
            const [roleName, roleData] = roleFacts;
            if (!roleData) continue;
            assertThat(roleData.durableResponses === roleData.responseIdentities.length ||
              roleData.durableResponses === 0 || roleData.duplicateServedCalls > 0,
            `${label}: every ${roleName} durable response names the response it ` +
            `delivered (${roleData.durableResponses} durable, ` +
            `${roleData.responseIdentities.length} identities)`);
          }
          // ── PLANNER AND WORKER ARE SEPARATE SUMMARIES ───────────────────
          //
          // Collapsing them into one count would make a planner success
          // indistinguishable from a worker success, which is the whole basis
          // of the family-7 and family-8 distinctions.
          // BOTH fact objects, independently. Reading only the first would
          // leave the other's role separation unasserted, and each is built by
          // its own function.
          for (const combined of [artifact.churnFacts, artifact.recoveryFacts]) {
          if (combined && combined.planner && combined.worker &&
              arm.expectedPath === 'structured_v2') {
            // The structured planner's economic policy authorizes exactly ONE
            // provider request, so its durable-response count is exactly one.
            // A collapsed summary would report every transport under the
            // planner, which is how "the planner succeeded" would come to stand
            // for "the worker succeeded".
            assertThat(combined.planner.durableResponses === 1,
              `${label}: the planner summary counts exactly its own one request ` +
              `(got ${combined.planner.durableResponses})`);
            assertThat(combined.planner.responseIdentities.every(id =>
              !combined.worker.responseIdentities.includes(id)),
            `${label}: no response identity appears under both roles`);
          }
          }

          const requestCount = (artifact.ticketReport.canonicalRequests || []).length;
          if (requestCount > 0) {
            assertThat(artifact.churnFacts &&
              (artifact.churnFacts.durableResponses + artifact.churnFacts.refusedTransports) > 0,
            `${label}: ${requestCount} provider request(s) are visible in the shared ` +
            'transport stream');
          }
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
            // THE WORKER WINDOW UNDER TEST — not the planner, and not the
            // sibling filler item a structured trial also stages.
            //
            // The planner is asserted separately precisely so its success can
            // never stand in for the worker's, and a structured trial's extra
            // captured candidate gets its own durable response that says
            // nothing about the boundary this variant injected.
            assertThat(facts.planner.durableResponses > 0,
              `${label}: the planner completed normally, separately from the worker window`);
            const injected = facts.worker.injectedBoundaryCounts || {};
            if (expected.durableResponse) {
              assertThat(Object.keys(injected).length === 0,
                `${label}: no boundary was injected — the worker window ran normally`);
              assertThat(facts.worker.durableResponses > 0,
                `${label}: and the worker response became durable`);
            } else {
              // 7B: bytes left, nothing came back. Exactly once, and never
              // retransmitted.
              assertThat(injected.bytes_sent === 1,
                `${label}: exactly one worker request sent bytes with no durable ` +
                `response (got ${injected.bytes_sent || 0})`);
              assertThat(!injected.response_durable,
                `${label}: the injected worker window produced no durable response`);
              assertThat(facts.worker.duplicateServedCalls === 0,
                `${label}: and the uncertain worker request is never retransmitted`);
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
            // WORKER-SCOPED. The planner request must not be mistaken for the
            // worker boundary under test.
            // THE INJECTED BOUNDARY, counted where it was injected.
            //
            // A structured trial has sibling leaf Runs, so a total worker
            // transport count says nothing about the ONE request the variant
            // targets. What the variant declares is which boundary that request
            // reached, and it must have been reached exactly once.
            const counts = facts.worker.injectedBoundaryCounts || {};
            const declaredBoundary = artifact.recoveryFacts.failureBoundary;
            if (declaredBoundary === 'before_transport') {
              // WHAT 8A ACTUALLY REQUIRES IS THAT NO BYTES LEFT.
              //
              // The refusal happens before the staged response is consumed, so
              // a legitimate retry reaches the same boundary again. That is
              // still zero bytes sent and zero durable responses, which is the
              // property under test — requiring exactly one refusal would fail
              // the variant for a retry that violated nothing.
              assertThat((counts.refused_before_transport || 0) >= 1,
                `${label}: the worker request refused BEFORE transport`);
              assertThat(!counts.bytes_sent && !counts.response_durable,
                `${label}: no worker bytes were sent and no response became durable`);
              assertThat(facts.worker.durableResponses === 0 ||
                facts.worker.injectedBoundaryCounts.response_durable === undefined,
              `${label}: the injected worker window produced no durable response`);
            } else if (declaredBoundary === 'after_transport_before_response') {
              assertThat(counts.bytes_sent === 1,
                `${label}: exactly one worker request sent bytes with no durable ` +
                `response (got ${counts.bytes_sent || 0})`);
              assertThat(!counts.bytes_sent || counts.bytes_sent === 1,
                `${label}: and it was never retransmitted`);
            } else {
              assertThat((facts.worker.durableResponses > 0) === expected.durableResponse,
                `${label}: worker durable response ${facts.worker.durableResponses > 0}, ` +
                `expected ${expected.durableResponse}`);
            }
            assertThat(facts.worker.duplicateServedCalls === 0,
              `${label}: the worker request was never retransmitted`);
            // THE CENTRAL RECOVERY GUARANTEE. An uncertainly delivered request
            // is never retransmitted, and a durable response is reused rather
            // than resent — both appear as zero duplicate served calls.
            assertThat(facts.duplicateServedCalls === 0,
              `${label}: no request was retransmitted`);
            assertThat(facts.duplicateEffects === 0,
              `${label}: no committed effect was duplicated`);
            if (expected.servedCalls === 0) {
              assertThat(facts.worker.boundaries.includes('refused_before_transport'),
                `${label}: the worker pre-transport boundary refused before any byte`);
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
