'use strict';

// Tranche 6 live-v2 membership authority.
//
// This topology is derived only from the frozen decision contract and the
// executable scenario catalog. It contains no model outcome and does not read a
// prior corpus. Live-v1 remains the historical fixture-derived authority; v2
// repairs the later-discovered topology mismatch without rewriting v1 bytes.

const protocol = require('../../config/structured-allocation-evaluation-v1.json');
const { ARM_IDS } = require('./evaluation-arms');
const {
  getScenario, resolveScenarioVariant, validateScenario
} = require('./evaluation-scenarios');

const REQUIRED_FAMILIES = Object.freeze(
  [...protocol.decisionThresholds.retain.gainRequiredOnFamilies]);
const ALL_ARMS = Object.freeze([...ARM_IDS]);

class LiveV2MatrixError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveV2MatrixError';
    this.detail = detail;
  }
}

const SELECTION = Object.freeze([
  Object.freeze({
    family: 2, cellId: 'family-2/2A',
    scenarioId: 'family-2-cleanly-separable', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'first matched cell for frozen RETAIN-required family 2'
  }),
  Object.freeze({
    family: 2, cellId: 'family-2/2B',
    scenarioId: 'family-2-cleanly-separable-alt', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'second matched cell makes rate and cost baselines jointly evaluable'
  }),
  Object.freeze({
    family: 3, cellId: 'family-3/3A',
    scenarioId: 'family-3-sibling-dependency', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'first matched cell for frozen RETAIN-required family 3'
  }),
  Object.freeze({
    family: 3, cellId: 'family-3/3B',
    scenarioId: 'family-3-sibling-dependency-alt', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'second matched cell makes rate and cost baselines jointly evaluable'
  }),
  Object.freeze({
    family: 5, cellId: 'family-5/5A',
    scenarioId: 'family-5-ownership-known', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'first matched cell for frozen RETAIN-required family 5'
  }),
  Object.freeze({
    family: 5, cellId: 'family-5/5B',
    scenarioId: 'family-5-ownership-known-alt', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'second matched cell makes rate and cost baselines jointly evaluable'
  }),
  Object.freeze({
    family: 6, cellId: 'family-6/6A',
    scenarioId: 'family-6-ownership-unknown', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'first matched cell for frozen RETAIN-required family 6'
  }),
  Object.freeze({
    family: 6, cellId: 'family-6/6B',
    scenarioId: 'family-6-ownership-unknown-alt', variantIds: [null],
    arms: ALL_ARMS,
    rationale: 'second matched cell makes rate and cost baselines jointly evaluable'
  })
]);

function oracleAuthorityFor(scenario) {
  if (scenario.oracle.kind === 'raw_state') return 'raw_state';
  if (scenario.oracle.kind === 'coupling') {
    return 'coupling_raw_state_and_fixture_access_log';
  }
  throw new LiveV2MatrixError(
    `scenario ${scenario.scenarioId} has unsupported oracle ${scenario.oracle.kind}`);
}

function deriveLiveV2Cells() {
  const cells = [];
  for (const row of SELECTION) {
    const base = getScenario(row.scenarioId);
    validateScenario(base);
    if (base.family !== row.family) {
      throw new LiveV2MatrixError(
        `${row.scenarioId} belongs to family ${base.family}, not ${row.family}`);
    }
    for (const variantId of row.variantIds) {
      const scenario = resolveScenarioVariant(base, variantId);
      for (const armId of row.arms) {
        if (!scenario.allowedArms.includes(armId)) {
          throw new LiveV2MatrixError(
            `${scenario.scenarioId}/${variantId || 'none'} does not allow ${armId}`);
        }
        const cellId = row.cellId;
        const cellKey = `${cellId}|${variantId || ''}|${armId}`;
        cells.push(Object.freeze({
          cellKey,
          cellId,
          scenarioId: scenario.scenarioId,
          variantId,
          family: row.family,
          armId,
          expectedOracleAuthority: oracleAuthorityFor(scenario),
          expectedQuiescence: scenario.expectedQuiescence,
          scenarioVersion: scenario.version,
          selectionAuthority: 'frozen_decision_topology_v2',
          selectionRationale: row.rationale
        }));
      }
    }
  }
  cells.sort((left, right) => left.cellKey.localeCompare(right.cellKey));
  validateLiveV2Topology(cells);
  return Object.freeze(cells);
}

function armSet(cells, family) {
  return new Set(cells.filter(cell => cell.family === family).map(cell => cell.armId));
}

function validateLiveV2Topology(cells) {
  if (!Array.isArray(cells) || cells.length !== 40) {
    throw new LiveV2MatrixError(
      `live-v2 decision topology must contain exactly 40 cells; found ${cells?.length}`);
  }
  const keys = new Set(cells.map(cell => cell.cellKey));
  if (keys.size !== cells.length) {
    throw new LiveV2MatrixError('live-v2 contains a duplicate cell identity');
  }
  for (const family of REQUIRED_FAMILIES) {
    const arms = armSet(cells, family);
    const missing = ALL_ARMS.filter(arm => !arms.has(arm));
    if (missing.length > 0) {
      throw new LiveV2MatrixError(
        `RETAIN-required family ${family} lacks arm(s) ${missing.join(', ')}`,
        { family, missing });
    }
    const familyCellIds = [...new Set(cells
      .filter(cell => cell.family === family).map(cell => cell.cellId))];
    if (familyCellIds.length < 2) {
      throw new LiveV2MatrixError(
        `RETAIN-required family ${family} needs at least two matched cells so ` +
        'truthfulness gain and cost-per-truthful-completion can both be evaluable',
        { family, familyCellIds });
    }
    for (const cellId of familyCellIds) {
      const matched = new Set(cells
        .filter(cell => cell.family === family && cell.cellId === cellId)
        .map(cell => cell.armId));
      const unmatched = ALL_ARMS.filter(arm => !matched.has(arm));
      if (unmatched.length > 0) {
        throw new LiveV2MatrixError(
          `${cellId} is not a matched five-arm comparison; missing ${unmatched.join(', ')}`,
          { family, cellId, missing: unmatched });
      }
    }
  }
  const families = [...new Set(cells.map(cell => cell.family))].sort((a, b) => a - b);
  for (const family of families) {
    const arms = armSet(cells, family);
    if ((arms.has('B') || arms.has('C')) && !arms.has('A')) {
      throw new LiveV2MatrixError(
        `structured family ${family} lacks arm A false-positive baseline`, { family });
    }
  }
  for (const armId of ALL_ARMS) {
    if (!cells.some(cell => cell.armId === armId)) {
      throw new LiveV2MatrixError(`live-v2 does not contain arm ${armId}`);
    }
  }
  return true;
}

module.exports = {
  ALL_ARMS,
  REQUIRED_FAMILIES,
  SELECTION,
  LiveV2MatrixError,
  deriveLiveV2Cells,
  validateLiveV2Topology
};
