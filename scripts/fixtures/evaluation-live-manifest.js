'use strict';

// Tranche 6 — the FROZEN live-model manifest, and the contracts a live run
// must satisfy before it may spend money.
//
// EVERYTHING HERE IS DERIVED, NOT CHOSEN. The live cells come from the executed
// fixture manifest by construction, so no cell can be dropped for performing
// badly or added because the fixture corpus was non-discriminating. The
// repetition count, sampling values, ceilings and decision rules come from the
// approved decisions and the already-frozen protocol.
//
// It contains no results and cannot hold one.

const crypto = require('node:crypto');
const fixtureManifest = require('../../config/structured-allocation-evaluation-scored-v1.json');
const protocol = require('../../config/structured-allocation-evaluation-v1.json');
const { PRICING } = require('./evaluation-live-readiness');
const { trialWorstCaseMicroUsd } = require('./evaluation-live-trial-liability');
const {
  addMicroUsd, assertIntegerMicroUsd, canonicalPerRequestMicroUsd
} = require('./evaluation-live-canonical-price');
const { ROLE_ECONOMICS } = require('./governed-role-policy-container');

// THE PINNED RUNTIME REQUEST CEILING.
//
// An ungoverned Run has no economic authority, so `maxModelRequestsPerRun` is
// its ONLY bound on provider attempts — and it is operator-configurable, which
// makes it unprovable unless the live run pins it. It is pinned here to the
// same per-Run request ceiling the governed leaf executor already carries, so
// every arm's Run is bounded identically, for the same reason the 2,048-token
// output cap is common across arms. The live runner supplies it to the spawned
// server through the existing production configuration knob, and the executor
// refuses if the server's effective limit is larger than this.
const RUNTIME_MAX_MODEL_REQUESTS_PER_RUN =
  ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests;

const LIVE_MANIFEST_VERSION = 1;

// ── The eight approved decisions, as data ───────────────────────────────────
const APPROVED = Object.freeze({
  // 1. Membership is DERIVED from the fixture manifest, never enumerated here.
  matrixDerivation: 'unique scenario/variant/arm cells of the frozen fixture manifest',
  // 2. Sampling: explicit evaluation inputs, identical for every role.
  temperature: 0,
  topP: 1,
  // 3. The production Responses adapter owns no seed field; determinism is not
  //    fabricated. Verified against runtime/provider-request-body.js.
  providerSeedSupport: false,
  providerSeed: null,
  // 4. A hard global cap. Not a target, and not spending authorization.
  maximumTotalLiveMicroUsd: 20_000_000,
  // 8. Live evaluation is mandatory before the final product decision.
  livePhaseMandatory: true
});

class LiveManifestError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveManifestError';
    this.detail = detail;
  }
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

// ── 1. Cells, derived ───────────────────────────────────────────────────────
//
// Each unique cell records the fixture slots it came from, so the derivation is
// auditable rather than asserted.
function deriveLiveCells() {
  const byCell = new Map();
  for (const trial of fixtureManifest.trials) {
    const key = `${trial.cellId}|${trial.variantId === null ? '' : trial.variantId}|${trial.armId}`;
    if (!byCell.has(key)) {
      byCell.set(key, {
        cellKey: key,
        cellId: trial.cellId,
        scenarioId: trial.scenarioId,
        variantId: trial.variantId,
        armId: trial.armId,
        expectedOracleAuthority: trial.expectedOracleAuthority,
        expectedQuiescence: trial.expectedQuiescence,
        sourceFixtureSlots: []
      });
    }
    byCell.get(key).sourceFixtureSlots.push(
      { repetition: trial.repetition, slot: trial.slot });
  }
  const cells = [...byCell.values()].sort((left, right) =>
    left.cellKey.localeCompare(right.cellKey));
  if (cells.length !== 40) {
    throw new LiveManifestError(
      `the frozen fixture manifest yields ${cells.length} unique cells, not 40; ` +
      'refusing to force a 120-slot matrix onto a different membership',
      { uniqueCells: cells.length });
  }
  return cells;
}

// ── 3. Ordering, balanced as far as 3 repetitions allow ─────────────────────
//
// Five arms cannot be perfectly counterbalanced across three repetitions — a
// complete Latin square needs five. The rotation is still deterministic and
// bounded: each arm takes a different starting position in each repetition, so
// no arm is systematically first or last, and the residual imbalance is
// reported rather than described as perfect balance.
function balancedArmOrder(repetitionIndex, arms) {
  const offset = repetitionIndex % arms.length;
  return Object.freeze([...arms.slice(offset), ...arms.slice(0, offset)]);
}

function orderingBalanceReport(permutations, arms) {
  const positions = new Map(arms.map(arm => [arm, new Map()]));
  permutations.forEach(order => {
    order.forEach((arm, index) => {
      const counts = positions.get(arm);
      counts.set(index, (counts.get(index) || 0) + 1);
    });
  });
  const perArm = {};
  for (const [arm, counts] of positions) {
    perArm[arm] = {
      positionCounts: Object.fromEntries([...counts.entries()].sort()),
      distinctPositions: counts.size
    };
  }
  return Object.freeze({
    repetitions: permutations.length,
    arms: arms.length,
    completeLatinSquarePossible: permutations.length === arms.length,
    achievedProperty: 'every arm occupies a DIFFERENT ordinal position in each ' +
      'repetition; with 3 repetitions and 5 arms each arm reaches 3 of the 5 ' +
      'positions, which is the maximum achievable',
    residualImbalance: 'each arm misses 2 of the 5 ordinal positions; no arm is ' +
      'first or last more than once',
    perArm: Object.freeze(perArm)
  });
}

// ── 4. Worst-case liability, recomputed from THIS manifest ──────────────────
//
// DERIVED, NOT DECLARED. Each arm's bound comes from its Run topology and the
// two enforced request ceilings, so a changed topology or a raised ceiling
// changes the money — which is the only way the reservation can stay true.
function computeLiability(slots) {
  // THE KERNEL PRICES, THIS FUNCTION COUNTS. The live layer previously computed
  // `(ctx * inRate + out * outRate) / 1e6` — a second pricing implementation
  // that never rounded and divided the summed product once, producing a
  // fractional monetary authority. The number now comes from
  // `computeMaximumLiability`, the same function governed economics trusts.
  const perRequest = canonicalPerRequestMicroUsd({
    role: 'structured_leaf_executor' }).perRequestMicroUsd;
  const byArm = {};
  const byCell = {};
  let totalMicroUsd = 0;
  for (const slot of slots) {
    const bound = trialWorstCaseMicroUsd({
      armId: slot.armId,
      perRequestMicroUsd: perRequest,
      runtimeMaxModelRequestsPerRun: RUNTIME_MAX_MODEL_REQUESTS_PER_RUN,
      governedLeafMaximumProviderRequests:
        ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
      governedPlannerMaximumProviderRequests:
        ROLE_ECONOMICS.structured_planner.maximumProviderRequests,
      // Auto-retry is a strict opt-in the live trial construction never sets;
      // `assertLiveTrialRetryDisabled` proves it per trial before reservation.
      autoRetryEnabled: false,
      maxAttempts: null
    });
    const perTrial = bound.trialWorstCaseMicroUsd;
    byArm[slot.armId] = byArm[slot.armId] || {
      trials: 0,
      plannerRequestsPerTrial: bound.plannerRequestMaximum,
      workerRequestsPerTrial: bound.maximumWorkerRuns * bound.workerRequestsPerRun,
      maximumWorkerRuns: bound.maximumWorkerRuns,
      workerRequestsPerRun: bound.workerRequestsPerRun,
      attemptsPerRun: bound.attemptsPerRun,
      totalProviderAttempts: bound.totalProviderAttempts,
      basis: bound.basis,
      perTrialMicroUsd: perTrial,
      totalMicroUsd: 0
    };
    byArm[slot.armId].trials += 1;
    byArm[slot.armId].totalMicroUsd = addMicroUsd(
      byArm[slot.armId].totalMicroUsd, perTrial, 'armTotal');
    byCell[slot.cellKey] = addMicroUsd(
      byCell[slot.cellKey] || 0, perTrial, 'cellTotal');
    totalMicroUsd = addMicroUsd(totalMicroUsd, perTrial, 'matrixTotal');
  }
  // EVERY AUTHORITATIVE MONETARY FIELD IS A SAFE INTEGER, checked here rather
  // than assumed, because these are the values that get hashed and reserved.
  assertIntegerMicroUsd(totalMicroUsd, 'matrix totalMicroUsd');
  for (const [armId, arm] of Object.entries(byArm)) {
    assertIntegerMicroUsd(arm.perTrialMicroUsd, `${armId}.perTrialMicroUsd`);
    assertIntegerMicroUsd(arm.totalMicroUsd, `${armId}.totalMicroUsd`);
  }
  for (const [cellKey, amount] of Object.entries(byCell)) {
    assertIntegerMicroUsd(amount, `${cellKey}.micro-USD`);
  }
  return Object.freeze({
    boundMethod: PRICING.boundMethod,
    perRequestMicroUsd: perRequest,
    runtimeMaxModelRequestsPerRun: RUNTIME_MAX_MODEL_REQUESTS_PER_RUN,
    byArm: Object.freeze(byArm),
    byCellMicroUsd: Object.freeze(byCell),
    totalMicroUsd,
    // Informational only, and named so. Every authority above is integer
    // micro-USD; nothing compares or reserves against this field.
    totalUsdInformational: totalMicroUsd / 1e6
  });
}

// The matrix is NEVER reduced to fit a budget. If the worst case exceeds the
// frozen cap the run refuses, and the decision about what to do next belongs to
// whoever set the cap.
function assertWithinCap(totalMicroUsd, capMicroUsd) {
  if (totalMicroUsd > capMicroUsd) {
    throw new LiveManifestError(
      `worst-case live liability ${totalMicroUsd} micro-USD exceeds the frozen ` +
      `cap ${capMicroUsd}; the matrix is not reduced to fit a budget`,
      { totalMicroUsd, capMicroUsd });
  }
  return true;
}

// ── The manifest ────────────────────────────────────────────────────────────

function buildLiveManifest({ fixtureCorpusHash, fixtureReportHash, artifactRootRecipe }) {
  const cells = deriveLiveCells();
  const repetitions = protocol.repetition.liveModelRepetitions;
  if (!Number.isSafeInteger(repetitions) || repetitions <= 0) {
    throw new LiveManifestError(
      'the protocol records no live repetition count; it is a frozen product ' +
      'decision and may not be invented here');
  }
  const arms = [...new Set(cells.map(cell => cell.armId))].sort();
  const permutations = Array.from({ length: repetitions },
    (unused, index) => balancedArmOrder(index, arms));

  const slots = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const order = permutations[repetition - 1];
    let slot = 0;
    for (const armId of order) {
      for (const cell of cells.filter(entry => entry.armId === armId)) {
        slot += 1;
        slots.push(Object.freeze({
          slot,
          repetition,
          cellKey: cell.cellKey,
          cellId: cell.cellId,
          scenarioId: cell.scenarioId,
          variantId: cell.variantId,
          armId,
          sourceFixtureSlots: cell.sourceFixtureSlots,
          // No provider seed exists, so the per-slot stochastic identity is the
          // exact tuple that DOES determine the request, plus the repetition.
          // It is an identity, never a determinism claim.
          stochasticIdentity: hashCanonical({
            model: protocol.fixedModel.model,
            temperature: APPROVED.temperature,
            topP: APPROVED.topP,
            providerSeed: APPROVED.providerSeed,
            cellKey: cell.cellKey,
            repetition
          })
        }));
      }
    }
  }
  if (slots.length !== cells.length * repetitions) {
    throw new LiveManifestError('slot generation did not cover every cell in every repetition');
  }

  const liability = computeLiability(slots);
  assertWithinCap(liability.totalMicroUsd, APPROVED.maximumTotalLiveMicroUsd);

  const manifest = {
    liveManifestVersion: LIVE_MANIFEST_VERSION,
    protocolId: protocol.protocolId,
    protocolVersion: protocol.protocolVersion,
    mode: 'live',
    containsResults: false,

    source: {
      fixtureManifestHash: fixtureManifest.manifestHash,
      fixtureCorpusHash,
      fixtureReportHash,
      fixtureDecision: 'FIXTURE EVIDENCE SUPPORTS STOP',
      derivation: APPROVED.matrixDerivation
    },
    repositoryBaselineRule:
      'every live artifact binds the repository commit it was produced from, and ' +
      'a corpus mixing commits is refused',

    provider: protocol.fixedModel.provider,
    model: protocol.fixedModel.model,
    adapterId: protocol.fixedModel.adapterId,
    plannerModel: protocol.fixedModel.model,
    workerModel: protocol.fixedModel.model,
    sameModelForPlannerAndWorkers: true,
    sampling: {
      temperature: APPROVED.temperature,
      topP: APPROVED.topP,
      appliesTo: ['structured_planner', 'structured_leaf_executor', 'ungoverned_worker'],
      note: 'one sampling configuration for every role; no role may differ'
    },
    providerSeedSupport: APPROVED.providerSeedSupport,
    providerSeed: APPROVED.providerSeed,
    stochasticityDeclaration:
      'the production Responses request contract owns no seed field, so residual ' +
      'provider stochasticity is an experimental variable controlled by the exact ' +
      'model snapshot, exact request inputs, temperature/top_p, 3 repetitions and ' +
      'balanced ordering — determinism is not claimed',

    contextWindowTokens: PRICING.contextWindowTokens,
    maximumOutputTokensPerRequest: PRICING.maximumOutputTokensPerRequest,
    pricing: {
      inputMicroUsdPerMillionTokens: PRICING.inputMicroUsdPerMillionTokens,
      outputMicroUsdPerMillionTokens: PRICING.outputMicroUsdPerMillionTokens,
      boundMethod: PRICING.boundMethod
    },

    uniqueCellCount: cells.length,
    cells,
    repetitions,
    totalAssignedTrials: slots.length,
    ordering: {
      strategy: protocol.ordering.strategy,
      generatedBeforeExecution: true,
      permutations,
      balance: orderingBalanceReport(permutations, arms)
    },
    slots,

    timeoutMs: protocol.failureHandling.timeoutMs,
    productFailureRule: protocol.failureHandling.productFailureRule,
    resultFreezing: protocol.failureHandling.resultFreezing,
    economics: {
      maximumTotalLiveMicroUsd: APPROVED.maximumTotalLiveMicroUsd,
      computedWorstCaseMicroUsd: liability.totalMicroUsd,
      headroomMicroUsd: APPROVED.maximumTotalLiveMicroUsd - liability.totalMicroUsd,
      liability,
      note: 'a HARD GLOBAL CAP. It may only tighten existing per-role and ' +
        'per-trial economic authority and may never widen a Run\'s limit. It is ' +
        'not spending authorization; execution requires explicit approval.'
    },

    authorizedDimensions: protocol.authorizedDimensions,
    hardDisqualifierVersion: protocol.protocolVersion,
    decisionRuleVersion: protocol.protocolVersion,
    artifactRootRecipe,
    livePhaseMandatory: APPROVED.livePhaseMandatory
  };
  manifest.manifestHash = hashCanonical(manifest);
  return Object.freeze(manifest);
}

module.exports = {
  APPROVED,
  assertWithinCap,
  LIVE_MANIFEST_VERSION,
  LiveManifestError,
  balancedArmOrder,
  buildLiveManifest,
  computeLiability,
  deriveLiveCells,
  hashCanonical,
  orderingBalanceReport
};
