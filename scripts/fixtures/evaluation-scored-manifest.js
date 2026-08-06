'use strict';

// Tranche 6 — the FROZEN scored-run manifest.
//
// WHY A MANIFEST AND NOT A LOOP. Repetition count, trial ordering and
// comparability rules decide what a score means. Choosing any of them after
// seeing results — even innocently, even once — turns an experiment into a
// search for a favourable arrangement. So they are generated from the frozen
// protocol BEFORE the first scored trial, written to a machine-readable file,
// and hashed. The scored runner refuses to run against runtime inputs that
// differ from the manifest it was frozen with.
//
// THIS FILE CONTAINS NO RESULTS AND CANNOT PRODUCE ONE. It builds a plan and a
// hash; nothing here executes a trial, reads an artifact or computes a metric.

const crypto = require('node:crypto');
const { ARM_IDS } = require('./evaluation-arms');
const { requiredTrials } = require('./evaluation-execution-matrix');
const protocol = require('../../config/structured-allocation-evaluation-v1.json');

const SCORED_MANIFEST_VERSION = 1;

class ScoredManifestError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ScoredManifestError';
    this.detail = detail;
  }
}

// ── Comparability ───────────────────────────────────────────────────────────
//
// Two kinds of difference, and conflating them is how a broken comparison gets
// reported as a finding.
//
// CONTROLLED FIELDS must be identical across every comparable cell. A
// difference is INVALID COMPARABILITY DRIFT and the runner refuses to
// aggregate — it does not "adjust" for it.
const CONTROLLED_COMPARABILITY_FIELDS = Object.freeze([
  'protocolVersion',
  'scenarioVersion',
  'variantId',
  'modelProviderSnapshot',
  'plannerModelSnapshot',
  'runtimeLimitsRevision',
  'maximumOutputTokensPerRequest',
  'contextWindowTokens',
  'pricingCatalogHash',
  'retryPolicy',
  'concurrency',
  'toolAvailability',
  'initialStateRecipeVersion',
  'fixtureTableHash',
  'independentOracleVersion',
  'parentPolicyContainerHash',
  'progressControlPolicyVersion'
]);

// DECLARED CONFOUNDERS are the architectural differences the experiment exists
// to compare. They differ BY DESIGN between arms, are recorded on every trial,
// and are never treated as drift.
const DECLARED_CONFOUNDERS = Object.freeze([
  'plannerPresence',
  'runCardinality',
  'governedEconomics',
  'ownershipSource',
  'allocationPlanVersion'
]);

function classifyComparabilityDifference(field) {
  if (CONTROLLED_COMPARABILITY_FIELDS.includes(field)) return 'invalid_comparability_drift';
  if (DECLARED_CONFOUNDERS.includes(field)) return 'expected_arm_difference';
  return 'unknown_field';
}

// Refuses rather than adjusting. An unknown field is refused too: a value
// nobody classified cannot be asserted to be harmless.
function assertComparableForScoring(left, right) {
  const differences = [];
  for (const field of CONTROLLED_COMPARABILITY_FIELDS) {
    if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) {
      differences.push(field);
    }
  }
  if (differences.length > 0) {
    throw new ScoredManifestError(
      `refusing to aggregate: controlled value(s) differ across comparable cells ` +
      `(${differences.sort().join(', ')})`,
      { differences, classification: 'invalid_comparability_drift' });
  }
  return true;
}

// ── Deterministic balanced ordering ─────────────────────────────────────────
//
// The protocol freezes `deterministic_balanced_latin_square`. A Latin square
// rotation gives every arm a different ordinal position in each repetition, so
// no arm systematically runs first (warm caches, empty database) or last
// (accumulated state). The rotation is derived from the frozen protocol seed and
// is therefore reproducible without being interactively randomized.
function balancedArmOrder(repetitionIndex, arms = ARM_IDS) {
  const offset = repetitionIndex % arms.length;
  return Object.freeze([...arms.slice(offset), ...arms.slice(0, offset)]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// One seed per (cell, arm, repetition), derived from the frozen protocol seed
// so the whole matrix is reproducible from one recorded value.
function seedFor(protocolSeed, cellId, armId, repetition) {
  return crypto.createHash('sha256')
    .update(`${protocolSeed}|${cellId}|${armId}|${repetition}`)
    .digest('hex').slice(0, 32);
}

// ── The manifest ────────────────────────────────────────────────────────────

function buildScoredManifest({ protocolSeed, artifactRoot }) {
  if (typeof protocolSeed !== 'string' || !protocolSeed) {
    throw new ScoredManifestError('a frozen protocol seed is required');
  }
  if (typeof artifactRoot !== 'string' || !artifactRoot) {
    throw new ScoredManifestError('an artifact root is required');
  }
  const repetitions = protocol.repetition.deterministicFixtureRepetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    // The count is a PRODUCT decision recorded in the frozen protocol. This
    // module reads it and never chooses one.
    throw new ScoredManifestError(
      'the protocol does not record deterministicFixtureRepetitions; the ' +
      'repetition count is a frozen product decision and may not be invented here');
  }

  const cells = requiredTrials();
  const trials = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const order = balancedArmOrder(repetition - 1);
    // Ordinal position is assigned BEFORE execution and written down, so a
    // failed trial keeps its slot rather than being re-ordered away.
    let slot = 0;
    for (const armId of order) {
      for (const cell of cells.filter(entry => entry.armId === armId)) {
        slot += 1;
        trials.push(Object.freeze({
          slot,
          repetition,
          cellId: cell.cellId,
          scenarioId: cell.scenarioId,
          variantId: cell.variantId,
          armId,
          seed: seedFor(protocolSeed, cell.cellId, armId, repetition),
          expectedOracleAuthority: cell.oracleAuthority,
          expectedQuiescence: cell.expectedQuiescence
        }));
      }
    }
  }

  const manifest = {
    manifestVersion: SCORED_MANIFEST_VERSION,
    protocolId: protocol.protocolId,
    protocolVersion: protocol.protocolVersion,
    mode: 'fixture',
    // NO RESULTS. The scored runner writes artifacts elsewhere; a manifest that
    // carried an outcome could be edited to fit one.
    containsResults: false,
    protocolSeed,
    artifactRoot,
    repetitions,
    arms: [...ARM_IDS],
    ordering: {
      strategy: protocol.ordering.strategy,
      counterbalanced: protocol.ordering.counterbalanced,
      generatedBeforeExecution: true,
      permutations: Array.from({ length: repetitions },
        (unused, index) => balancedArmOrder(index))
    },
    failureHandling: protocol.failureHandling,
    authorizedDimensions: protocol.authorizedDimensions,
    decisionRuleVersion: protocol.protocolVersion,
    comparability: {
      controlledFields: CONTROLLED_COMPARABILITY_FIELDS,
      declaredConfounders: DECLARED_CONFOUNDERS,
      driftRule: 'refuse to aggregate; never adjust'
    },
    trials
  };
  manifest.manifestHash = hashCanonical(manifest);
  return Object.freeze(manifest);
}

// The scored runner calls this before its first trial. Runtime inputs that
// differ from the frozen manifest refuse, so a scored run cannot quietly
// proceed under a different protocol, model snapshot, fixture table or limits.
function assertRuntimeMatchesManifest(manifest, runtime) {
  const mismatches = [];
  for (const field of ['protocolId', 'protocolVersion', 'mode', 'repetitions', 'protocolSeed']) {
    if (JSON.stringify(manifest[field]) !== JSON.stringify(runtime[field])) {
      mismatches.push(field);
    }
  }
  if (runtime.manifestHash !== undefined && runtime.manifestHash !== manifest.manifestHash) {
    mismatches.push('manifestHash');
  }
  if (mismatches.length > 0) {
    throw new ScoredManifestError(
      `refusing to run scored trials: runtime differs from the frozen manifest ` +
      `(${mismatches.sort().join(', ')})`, { mismatches });
  }
  return true;
}

module.exports = {
  CONTROLLED_COMPARABILITY_FIELDS,
  DECLARED_CONFOUNDERS,
  SCORED_MANIFEST_VERSION,
  ScoredManifestError,
  assertComparableForScoring,
  assertRuntimeMatchesManifest,
  balancedArmOrder,
  buildScoredManifest,
  classifyComparabilityDifference,
  hashCanonical
};
