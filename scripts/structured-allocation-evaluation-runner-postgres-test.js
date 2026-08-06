#!/usr/bin/env node
'use strict';

// Tranche 6 — the family-1 five-arm execution milestone, through the REAL
// production paths.
//
// This is the suite that turns the evaluation harness from a set of contracts
// into something that has actually run. It drives the canonical PostgreSQL
// real-server harness: a spawned server under the hermetic preload, an
// authenticated session, the real `POST /tickets` form, and the existing
// scheduler, workers, terminalization and reconciliation.
//
// WHAT IT PROVES, per arm:
//
//   * the durable state shows the intended production path — not the arm label;
//   * the independent oracle returns pass, fail or refused from raw state;
//   * invoking the read-only report twice changes nothing;
//   * one immutable unscored artifact is written and cannot be overwritten.
//
// WHAT IT DELIBERATELY DOES NOT DO. No comparison, no ranking, no aggregate, no
// threshold. A trial that ends in a truthful product failure is a RESULT, not a
// suite failure: the milestone is that each arm reached its own path and was
// observed honestly, not that the product succeeded.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { ARMS, ARM_IDS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial, EvaluationRunnerError } = require('./structured-allocation-evaluation-runner');

const SCENARIO_ID = 'family-1-simple';

function repositoryCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch (_) { return 'unknown'; }
}

async function main() {
  const commit = repositoryCommit();
  const smokeRoot = path.join('/tmp',
    'ticket-system-structured-evaluation-smoke', commit);
  fs.mkdirSync(smokeRoot, { recursive: true });
  // One fixture-namespace root per invocation, so re-running the milestone is
  // possible while namespace reuse WITHIN an invocation still refuses.
  const namespaceRoot = path.join(smokeRoot, 'namespaces',
    `${process.pid}-${Date.now()}`);
  fs.mkdirSync(namespaceRoot, { recursive: true });

  await withHarness('structured allocation evaluation runner',
    async ({ store, workspaceRoot, startServer }) => {
      const assertThat = createAsserter();
      const scenario = getScenario(SCENARIO_ID);
      const artifacts = {};

      for (const armId of ARM_IDS) {
        const arm = ARMS[armId];
        const outputPath = path.join(smokeRoot, 'fixture', `family1-${armId}.json`);
        // A re-run must not silently reuse a prior result.
        if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

        let artifact = null;
        let failure = null;
        try {
          artifact = await runTrial({
            store, startServer, workspaceRoot, scenario, arm,
            repetition: 1, seed: `family1-${armId}-seed`,
            outputPath, commit, smokeRoot, namespaceRoot
          });
        } catch (error) { failure = error; }

        // A truthful product failure is data. A HARNESS failure is not, and the
        // two are distinguished by whether the runner could observe the trial
        // at all.
        assertThat(failure === null,
          `${armId}: the trial executed and was observed` +
          (failure ? ` — ${failure.stack}` : ''));
        if (failure) continue;

        artifacts[armId] = artifact;

        assertThat(artifact.label === 'UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE',
          `${armId}: the artifact is labelled unscored`);
        assertThat(artifact.repositoryCommit === commit,
          `${armId}: the artifact records the exact repository commit`);

        // ── DURABLE PATH PROOF, not the arm label ────────────────────────
        assertThat(artifact.pathProof.authority === 'durable_state',
          `${armId}: the path proof is derived from durable state`);
        assertThat(artifact.pathProof.observedPath === arm.expectedPath,
          `${armId}: durable facts show the ${arm.expectedPath} path`);
        if (arm.expectedPath === 'direct') {
          assertThat(artifact.pathProof.allocationPlanIds.length === 0,
            `${armId}: no allocation plan exists`);
          assertThat(artifact.pathProof.planningAttempts === 0,
            `${armId}: no structured planning attempt`);
          assertThat(artifact.pathProof.governedLeafRunCount === 0,
            `${armId}: no structured leaf binding`);
        }
        if (arm.expectedPath === 'legacy_v1') {
          assertThat(artifact.pathProof.planVersion === 1,
            `${armId}: allocation plan version 1`);
          assertThat(artifact.pathProof.planningAttempts === 0,
            `${armId}: no structured planning attempt`);
          assertThat(artifact.pathProof.governedLeafRunCount === 0,
            `${armId}: no version-2 leaf authority`);
        }
        if (arm.expectedPath === 'structured_v2') {
          // The structured PATH is proved by the planning attempt. Whether that
          // attempt admitted a plan is a product outcome, and a blocked trial is
          // valid data — so the plan-shape facts are asserted only when a plan
          // was actually admitted.
          assertThat(artifact.pathProof.planningAttempts > 0,
            `${armId}: a structured planning attempt is durable`);
          // The four facts are asserted SEPARATELY so a planning attempt can
          // never stand in for executed governed work.
          assertThat(artifact.pathProof.planAdmitted === true,
            `${armId}: an Allocation Plan v2 was admitted`);
          assertThat(artifact.pathProof.planVersion === 2,
            `${armId}: the admitted plan is version 2`);
          assertThat(artifact.pathProof.plannerRequestCount > 0,
            `${armId}: a structured planner request was made`);
          // RECORDED, NOT YET REQUIRED. Leaf-run admission has not been
          // observed; the milestone is incomplete and this states which fact is
          // missing rather than implying execution happened.
          assertThat(artifact.pathProof.leafRunsAdmitted === false,
            `${armId}: leaf-run admission is NOT yet observed — recorded as the ` +
            'remaining gap, not as executed governed work');
        }

        // ── INDEPENDENT ORACLE ───────────────────────────────────────────
        assertThat(['pass', 'fail', 'refused'].includes(artifact.oracleResult.verdict),
          `${armId}: the independent oracle returned a verdict`);
        assertThat(artifact.oracleResult.authority ===
          'independent_raw_state_observation',
        `${armId}: from raw state, not product authority`);

        // ── ZERO DRIFT ───────────────────────────────────────────────────
        assertThat(artifact.ticketReport.secondReadIdentical === true,
          `${armId}: invoking the read-only report twice changed nothing`);

        // ── NO SCORING ───────────────────────────────────────────────────
        const serialized = JSON.stringify(artifact);
        for (const forbidden of ['"rank"', '"winner"', '"score"', '"aggregate"']) {
          assertThat(!serialized.includes(forbidden),
            `${armId}: the artifact carries no ${forbidden.replace(/"/g, '')}`);
        }

        // ── IMMUTABLE ────────────────────────────────────────────────────
        assertThat(fs.existsSync(outputPath), `${armId}: the artifact was written`);
        assert.throws(() => require('./fixtures/evaluation-quiescence')
          .writeTrialArtifact(outputPath, artifact), /refusing to overwrite/);
        assertThat(true, `${armId}: overwriting the artifact is refused`);
      }

      // Every arm produced its own distinct cell.
      const paths = ARM_IDS.map(armId => artifacts[armId] &&
        artifacts[armId].pathProof.observedPath).filter(Boolean);
      assertThat(paths.length === ARM_IDS.length,
        'all five arms produced an artifact');
      assertThat(new Set(paths).size === 3,
        'the five arms resolved to exactly three distinct production paths');

      console.log(`\n  (${assertThat.count()} five-arm smoke assertions)`);
      console.log(`  artifacts: ${path.join(smokeRoot, 'fixture')}`);
    }, { timeoutMs: 1_800_000 });

  console.log('structured allocation evaluation runner PostgreSQL test passed');
  console.log('UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE');
}

main().catch(error => { console.error(error); process.exit(1); });
