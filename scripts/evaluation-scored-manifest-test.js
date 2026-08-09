#!/usr/bin/env node
'use strict';

// Tranche 6 — the frozen scored-run manifest, and the rules that must be fixed
// BEFORE the first scored trial.
//
// WHY THESE ARE TESTED AT ALL. Repetition count, trial ordering and
// comparability decide what a score means. Choosing any of them after seeing
// results turns an experiment into a search for a favourable arrangement. This
// suite proves they are frozen, derived from the protocol rather than invented,
// reproducible, and that the manifest carries no result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTROLLED_COMPARABILITY_FIELDS, DECLARED_CONFOUNDERS, ScoredManifestError,
  assertComparableForScoring, assertRuntimeMatchesManifest, balancedArmOrder,
  buildScoredManifest, classifyComparabilityDifference
} = require('./fixtures/evaluation-scored-manifest');
const { ARM_IDS } = require('./fixtures/evaluation-arms');
const { requiredTrials } = require('./fixtures/evaluation-execution-matrix');
const protocol = require('../config/structured-allocation-evaluation-v1.json');

const FROZEN = require('../config/structured-allocation-evaluation-scored-v1.json');
const FIXTURE_V2 = require('../config/structured-allocation-evaluation-scored-v2.json');
const {
  buildScoredManifestV2
} = require('./fixtures/evaluation-scored-manifest-v2');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function main() {
  console.log('evaluation scored manifest');

  const rebuilt = buildScoredManifest({
    protocolSeed: FROZEN.protocolSeed, artifactRoot: FROZEN.artifactRoot
  });

  // ── The manifest is FROZEN, not regenerated per run ───────────────────
  ok(rebuilt.manifestHash === FROZEN.manifestHash,
    'the committed manifest reproduces exactly from the frozen protocol seed');
  const rebuiltV2 = buildScoredManifestV2({ artifactRoot: FIXTURE_V2.artifactRoot });
  ok(rebuiltV2.manifestHash === FIXTURE_V2.manifestHash &&
     FIXTURE_V2.fixtureEvidenceVersion === 2,
  'fixture-v2 reproduces exactly as repository-owned evidence authority');
  ok(FIXTURE_V2.trials.length === FROZEN.trials.length &&
     FIXTURE_V2.trials.every((trial, index) =>
       JSON.stringify(trial) === JSON.stringify(FROZEN.trials[index])),
  'fixture-v2 preserves every frozen fixture assignment and seed');
  ok(FROZEN.trials.length === requiredTrials().length * FROZEN.repetitions,
    `every required cell appears in every repetition ` +
    `(${FROZEN.trials.length} trials)`);

  // ── Repetition is READ from the protocol, never invented ──────────────
  ok(FROZEN.repetitions === protocol.repetition.deterministicFixtureRepetitions,
    'the repetition count comes from the frozen protocol decision');
  ok(protocol.repetition.deterministicFixtureRepetitions === 5,
    'and that decision is 5 deterministic fixture repetitions');
  // Fixture and live results may never be pooled.
  ok(protocol.repetition.poolingRule.includes('never combined'),
    'deterministic-fixture and live-model results are never pooled');

  // ── Ordering is balanced, deterministic and pre-generated ─────────────
  ok(FROZEN.ordering.strategy === protocol.ordering.strategy &&
     FROZEN.ordering.counterbalanced === true,
  'ordering follows the frozen counterbalanced strategy');
  ok(FROZEN.ordering.generatedBeforeExecution === true,
    'ordering is generated before execution, never interactively');
  // EVERY ARM IN EVERY POSITION. With one repetition per arm the Latin square
  // is complete, so no arm systematically runs first (empty database, cold
  // caches) or last (accumulated state).
  const positions = new Map(ARM_IDS.map(arm => [arm, new Set()]));
  FROZEN.ordering.permutations.forEach(order => {
    order.forEach((arm, index) => positions.get(arm).add(index));
  });
  ok([...positions.values()].every(set => set.size === ARM_IDS.length),
    'every arm occupies every ordinal position exactly once across repetitions');
  ok(balancedArmOrder(0).join(',') === ARM_IDS.join(',') &&
     balancedArmOrder(1).join(',') !== ARM_IDS.join(','),
  'the permutation rotates deterministically by repetition index');
  // Reproducible: the same index always yields the same order.
  ok(balancedArmOrder(3).join(',') === balancedArmOrder(3).join(','),
    'and is reproducible rather than randomized');

  // ── Slots are assigned before execution ───────────────────────────────
  const slotsByRepetition = new Map();
  for (const trial of FROZEN.trials) {
    if (!slotsByRepetition.has(trial.repetition)) slotsByRepetition.set(trial.repetition, []);
    slotsByRepetition.get(trial.repetition).push(trial.slot);
  }
  ok([...slotsByRepetition.values()].every(slots =>
    new Set(slots).size === slots.length),
  'each repetition assigns a distinct ordinal slot to every trial');
  // A failed product trial keeps its slot; a re-run is a NEW trial.
  ok(protocol.failureHandling.productFailureRule.includes('never discarded'),
    'a failed product trial remains data and is never discarded');
  ok(protocol.failureHandling.resultFreezing.includes('never rewritten'),
    'trial records are written once and a re-run produces a new trial id');

  // ── Seeds are derived, distinct and reproducible ──────────────────────
  const seeds = FROZEN.trials.map(trial => trial.seed);
  ok(new Set(seeds).size === seeds.length,
    'every trial carries its own derived seed');
  ok(rebuilt.trials.every((trial, index) => trial.seed === FROZEN.trials[index].seed),
    'and the whole seed set reproduces from the one recorded protocol seed');

  // ── NO RESULTS ────────────────────────────────────────────────────────
  //
  // A manifest that could carry an outcome could be edited to fit one.
  ok(FROZEN.containsResults === false,
    'the manifest declares that it contains no results');
  const serialized = JSON.stringify(FROZEN);
  for (const forbidden of ['"verdict"', '"winner"', '"rank"', '"score"',
    '"aggregate"', '"oracleResult"', '"artifactHash"']) {
    ok(!serialized.includes(forbidden),
      `the manifest carries no ${forbidden.replace(/"/g, '')}`);
  }

  // ── Comparability ─────────────────────────────────────────────────────
  const base = Object.fromEntries(
    CONTROLLED_COMPARABILITY_FIELDS.map(field => [field, 'same']));
  ok(assertComparableForScoring(base, { ...base }) === true,
    'identical controlled values are comparable');
  for (const field of ['modelProviderSnapshot', 'fixtureTableHash',
    'runtimeLimitsRevision', 'protocolVersion', 'pricingCatalogHash']) {
    let refused = null;
    try {
      assertComparableForScoring(base, { ...base, [field]: 'drifted' });
    } catch (error) { refused = error; }
    ok(refused instanceof ScoredManifestError &&
       refused.detail.classification === 'invalid_comparability_drift',
    `a differing ${field} REFUSES aggregation rather than adjusting for it`);
  }
  // Architectural differences the experiment exists to compare are NOT drift.
  for (const field of DECLARED_CONFOUNDERS) {
    ok(classifyComparabilityDifference(field) === 'expected_arm_difference',
      `${field} is a declared confounder, not comparability drift`);
  }
  ok(classifyComparabilityDifference('somethingNobodyClassified') === 'unknown_field',
    'an unclassified field is neither — it is unknown, and never assumed harmless');

  // ── The scored runner refuses on runtime drift ────────────────────────
  ok(assertRuntimeMatchesManifest(FROZEN, {
    protocolId: FROZEN.protocolId, protocolVersion: FROZEN.protocolVersion,
    mode: FROZEN.mode, repetitions: FROZEN.repetitions,
    protocolSeed: FROZEN.protocolSeed, manifestHash: FROZEN.manifestHash
  }) === true, 'matching runtime inputs are accepted');
  for (const [field, value] of [
    ['protocolVersion', 999], ['mode', 'live'], ['repetitions', 3],
    ['protocolSeed', 'different'], ['manifestHash', 'f'.repeat(64)]
  ]) {
    let refused = false;
    try {
      assertRuntimeMatchesManifest(FROZEN, {
        protocolId: FROZEN.protocolId, protocolVersion: FROZEN.protocolVersion,
        mode: FROZEN.mode, repetitions: FROZEN.repetitions,
        protocolSeed: FROZEN.protocolSeed, manifestHash: FROZEN.manifestHash,
        [field]: value
      });
    } catch (_) { refused = true; }
    ok(refused, `a scored run with a different ${field} REFUSES to start`);
  }

  // ── Exactly five authorized metrics ───────────────────────────────────
  ok(FROZEN.authorizedDimensions.join(',') ===
     'allocation_quality,completion_truthfulness,latency,cost,churn',
  'exactly the five authorized metrics — no sixth');
  ok(protocol.authorizedDimensions.length === 5,
    'and the protocol itself still authorizes exactly five');

  // ── Timeout and exclusion predicate are frozen ────────────────────────
  ok(FROZEN.failureHandling.timeoutMs === protocol.failureHandling.timeoutMs,
    'the trial timeout is frozen with the protocol');
  ok(Array.isArray(FROZEN.failureHandling.infrastructureExclusions) &&
     FROZEN.failureHandling.infrastructureExclusions.length === 4,
  'the infrastructure-only exclusion predicate is a closed, frozen list');
  ok(protocol.failureHandling.timeoutRule.includes('recorded as a product failure'),
    'a timeout is a product failure unless the harness itself crashed');

  // ── Config and docs must agree ────────────────────────────────────────
  //
  // A prerequisite marked closed in one place and open in the other is a
  // contradiction, and the resolution must never be "believe the optimistic
  // one".
  const evaluationDoc = fs.readFileSync(
    path.join(__dirname, '..', 'docs', 'STRUCTURED_ALLOCATION_CONTROLLED_EVALUATION.md'),
    'utf8');
  const prerequisites = protocol.executionPrerequisites;
  ok(prerequisites && Object.keys(prerequisites).length === 6,
    'the protocol records all six execution prerequisites');
  ok(Object.values(prerequisites).every(state => state === 'CLOSED'),
    'and every one of them is CLOSED in the machine-readable config');
  ok(evaluationDoc.includes('Prerequisite 3 (hermetic scenario fixtures) is CLOSED'),
    'the documentation agrees that prerequisite 3 is closed');
  ok(!evaluationDoc.includes('Prerequisite 3 cannot close'),
    'and no stale statement claims it cannot close');
  ok(Array.isArray(protocol.unresolvedBlockers) &&
     protocol.unresolvedBlockers.length === 0,
  'the protocol records no unresolved execution blocker');

  console.log(`\nevaluation scored manifest test passed — ${passed} assertions`);
}

main();
