'use strict';

// Tranche 6 live-v2 manifest authority.
//
// Live-v1 is intentionally left untouched because historical run headers bind
// its exact bytes. V2 carries the same provider, request, pricing, fixture and
// decision authorities, but derives membership from the frozen decision
// topology so every advertised terminal decision is structurally evaluable.

const historicalV1 = require('../../config/structured-allocation-evaluation-live-v1.json');
const protocol = require('../../config/structured-allocation-evaluation-v1.json');
const {
  APPROVED, LiveManifestError, assertWithinCap, balancedArmOrder,
  buildLiveManifest, computeLiability, hashCanonical, orderingBalanceReport
} = require('./evaluation-live-manifest');
const {
  ALL_ARMS, REQUIRED_FAMILIES, deriveLiveV2Cells, validateLiveV2Topology
} = require('./evaluation-live-v2-matrix');

const LIVE_MANIFEST_VERSION = 2;

function buildLiveManifestV2({ fixtureCorpusHash, fixtureReportHash,
  artifactRootRecipe }) {
  // Build the historical authority first so every shared frozen field remains
  // source-derived. The returned object is copied; v1 itself is never mutated.
  const v1 = buildLiveManifest({
    fixtureCorpusHash, fixtureReportHash, artifactRootRecipe
  });
  if (v1.manifestHash !== historicalV1.manifestHash) {
    throw new LiveManifestError(
      'historical live-v1 no longer reproduces; refusing to derive live-v2');
  }

  const cells = deriveLiveV2Cells();
  validateLiveV2Topology(cells);
  const repetitions = protocol.repetition.liveModelRepetitions;
  const permutations = Array.from({ length: repetitions },
    (unused, index) => balancedArmOrder(index, ALL_ARMS));
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
          // Legacy scorer field name only. This identity is NOT a provider seed
          // and the production request body owns no seed field. It is stable
          // across repetitions of the same cell so recovery determinism is
          // mechanically evaluable from repeated identical control envelopes.
          stochasticIdentity: hashCanonical({
            model: protocol.fixedModel.model,
            temperature: APPROVED.temperature,
            topP: APPROVED.topP,
            providerSeed: APPROVED.providerSeed,
            cellKey: cell.cellKey
          })
        }));
      }
    }
  }
  if (slots.length !== 120 || cells.length !== 40 || repetitions !== 3) {
    throw new LiveManifestError(
      `live-v2 must be 40 cells x 3 repetitions = 120 slots; found ` +
      `${cells.length} x ${repetitions} = ${slots.length}`);
  }

  const liability = computeLiability(slots);
  assertWithinCap(liability.totalMicroUsd, APPROVED.maximumTotalLiveMicroUsd);
  const familyArmCoverage = {};
  for (const family of [...new Set(cells.map(cell => cell.family))].sort((a, b) => a - b)) {
    familyArmCoverage[family] = Object.freeze(ALL_ARMS.filter(armId =>
      cells.some(cell => cell.family === family && cell.armId === armId)));
  }

  const manifest = {
    ...v1,
    liveManifestVersion: LIVE_MANIFEST_VERSION,
    source: {
      ...v1.source,
      derivation: 'deterministic decision-evaluable topology from the frozen ' +
        'protocol and executable scenario catalog; no observed outcome participates'
    },
    historicalLiveManifest: {
      liveManifestVersion: 1,
      manifestHash: historicalV1.manifestHash,
      status: 'historical execution authority; preserved byte-for-byte for prior evidence only'
    },
    decisionTopology: {
      topologyVersion: 2,
      requiredFamilies: Object.freeze([...REQUIRED_FAMILIES]),
      familyArmCoverage: Object.freeze(familyArmCoverage),
      matchedCellsPerRequiredFamily: 2,
      everyRequiredFamilyHasAllComparisonArms: true,
      everyRequiredCellIsFiveArmMatched: true,
      everyStructuredFamilyHasArmABaseline: true,
      terminalDecisionsRequiredReachable: Object.freeze(['RETAIN', 'REVISE', 'STOP'])
    },
    uniqueCellCount: cells.length,
    cells,
    repetitions,
    totalAssignedTrials: slots.length,
    ordering: {
      strategy: protocol.ordering.strategy,
      generatedBeforeExecution: true,
      permutations,
      balance: orderingBalanceReport(permutations, ALL_ARMS)
    },
    slots,
    economics: {
      maximumTotalLiveMicroUsd: APPROVED.maximumTotalLiveMicroUsd,
      computedWorstCaseMicroUsd: liability.totalMicroUsd,
      headroomMicroUsd: APPROVED.maximumTotalLiveMicroUsd - liability.totalMicroUsd,
      liability,
      note: v1.economics.note
    }
  };
  delete manifest.manifestHash;
  manifest.manifestHash = hashCanonical(manifest);
  return Object.freeze(manifest);
}

module.exports = {
  LIVE_MANIFEST_VERSION,
  buildLiveManifestV2
};
