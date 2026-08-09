#!/usr/bin/env node
'use strict';

// Provider-free release gate: the ACTUAL candidate live manifest must be able
// to reach every advertised terminal decision. Controlled outcomes prove
// topology only; they are synthetic harness evidence, never product evidence.

const assert = require('node:assert/strict');

const manifest = require('../config/structured-allocation-evaluation-live-v3.json');
const protocol = require('../config/structured-allocation-evaluation-v1.json');
const {
  evaluateLiveHardDisqualifiers, evaluateLiveOrdinaryDecision
} = require('./structured-allocation-evaluation-scorer');
const { combineEvidence } = require('./fixtures/evaluation-evidence-combination');
const {
  REQUIRED_FAMILIES, validateLiveV2Topology
} = require('./fixtures/evaluation-live-v2-matrix');

let passed = 0;
function ok(value, message) {
  assert.equal(value, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function refuses(fn, pattern = null) {
  try { fn(); return false; } catch (error) {
    return pattern ? pattern.test(error.message) : true;
  }
}

function familyOf(slot) {
  return Number((slot.scenarioId.match(/^family-(\d+)-/) || [])[1]);
}

function trueCompletion(slot, branch) {
  const firstCell = /\/[2356]A$/.test(slot.cellId);
  if (branch === 'STOP') return firstCell;
  if (branch === 'REVISE' && familyOf(slot) === 2) return firstCell;
  if (slot.armId === 'B' || slot.armId === 'C') return true;
  return firstCell;
}

function controlledArtifact(slot, branch) {
  const completed = trueCompletion(slot, branch);
  const terminal = completed ? 'completed' : 'failed';
  const structured = slot.armId === 'B' || slot.armId === 'C';
  return Object.freeze({
    trialId: `${branch}-${slot.repetition}-${slot.slot}-${slot.armId}`,
    family: familyOf(slot),
    cellId: slot.cellId,
    scenarioId: slot.scenarioId,
    variantId: slot.variantId,
    armId: slot.armId,
    repetition: slot.repetition,
    truthfulness: completed
      ? 'true_positive_completion' : 'true_negative_completion',
    envelopeHash: `controlled-${slot.cellKey}`,
    latency: Object.freeze({ endToEndMs: structured ? 120 : 100 }),
    normalizedCost: Object.freeze({
      totalNormalizedMicroUsd: 10,
      capturedEconomicCeilingMicroUsd: 100,
      normalizedExceedsCeiling: false,
      durableGovernedMicroUsd: structured ? 10 : null,
      durableGovernedExceedsCeiling: structured ? false : null,
      exceededCeiling: false
    }),
    pathProof: Object.freeze({
      observedPath: structured ? 'structured_v2' :
        (slot.armId === 'A' ? 'direct' : 'legacy_v1'),
      ticketResultStatus: terminal,
      ticketStatus: terminal,
      runCount: 1,
      leafRunsAdmitted: structured,
      governedLeafRunCount: structured ? 1 : 0,
      sameParentPolicyRevision: structured ? true : null,
      aggregateReconciliationObserved: structured,
      aggregateReconciliationAuthority: structured
        ? Object.freeze({ events: 1, aggregateStatus: terminal,
          aggregateDecisionHash: `decision-${slot.cellKey}-${slot.repetition}` })
        : null
    }),
    ticketReport: Object.freeze({
      secondReadIdentical: true,
      productClaimsCompleted: completed,
      terminalTicketStatus: terminal,
      authority: Object.freeze({
        ticketStatus: terminal,
        anyRunCompleted: completed,
        completionDecisionCount: completed ? 1 : 0,
        completionDecidedEvents: completed ? 1 : 0
      }),
      churn: structured
        ? Object.freeze({ persistedProgressBlocks: 0, blockEvents: 0 }) : null
    }),
    churnFacts: Object.freeze({
      observationCompleteness: 'complete',
      noProgressStreak: structured ? 0 : null,
      worker: Object.freeze({ attemptedTransports: 1, durableResponses: 1 })
    })
  });
}

function byArmOf(artifacts) {
  const byArm = { A: [], A2a: [], A2b: [], B: [], C: [] };
  for (const artifact of artifacts) byArm[artifact.armId].push(artifact);
  return byArm;
}

function decide(branch) {
  const artifacts = manifest.slots.map(slot => controlledArtifact(slot, branch));
  const byArm = byArmOf(artifacts);
  const disqualifiers = evaluateLiveHardDisqualifiers({ protocol, byArm, artifacts });
  const ordinary = evaluateLiveOrdinaryDecision({ protocol, disqualifiers, byArm });
  const combined = combineEvidence({
    fixture: {
      hardDisqualifierTriggered: false,
      hardDisqualifiersNotEvaluable: [],
      ordinaryDecision: 'STOP'
    },
    live: {
      hardDisqualifierTriggered: disqualifiers.some(row => row.result === 'TRIGGERED'),
      hardDisqualifiersNotEvaluable: disqualifiers
        .filter(row => row.result === 'NOT EVALUABLE').map(row => row.statement),
      ordinaryDecision: ordinary.ordinaryDecision,
      corpusComplete: true
    }
  });
  return { artifacts, disqualifiers, ordinary, combined };
}

function main() {
  console.log('evaluation live decision topology reachability');
  ok(manifest.liveManifestVersion === 3 && validateLiveV2Topology(manifest.cells),
    'the exact live-v3 manifest preserves the canonical live-v2 topology validator');
  ok(JSON.stringify([...new Set(manifest.cells.map(cell => cell.family))]) ===
     JSON.stringify(REQUIRED_FAMILIES),
  'the live family set is exactly the four frozen RETAIN-required families');

  for (const family of REQUIRED_FAMILIES) {
    const rows = manifest.cells.filter(cell => cell.family === family);
    const cellIds = [...new Set(rows.map(cell => cell.cellId))];
    ok(cellIds.length === 2 && cellIds.every(cellId =>
      ['A', 'A2a', 'A2b', 'B', 'C'].every(armId =>
        rows.some(row => row.cellId === cellId && row.armId === armId))),
    `family ${family} has two outcome-independent matched five-arm cells`);
  }
  ok(manifest.slots.every(slot => manifest.slots
    .filter(other => other.cellKey === slot.cellKey)
    .every(other => other.stochasticIdentity === slot.stochasticIdentity)),
  'each cell repeats one legacy stochastic-identity alias across all repetitions');
  ok(manifest.providerSeed === null && manifest.providerSeedSupport === false,
    'the stochastic identity is not a provider seed');

  for (const expected of ['RETAIN', 'REVISE', 'STOP']) {
    const result = decide(expected);
    ok(result.disqualifiers.every(row => row.result === 'NOT TRIGGERED'),
      `${expected} construction leaves every hard disqualifier evaluable and clear`);
    ok(result.ordinary.ordinaryDecision === expected,
      `ordinary ${expected} is REACHABLE from actual manifest slots`);
    ok(result.combined.finalProductDecision === expected,
      `FINAL ${expected} is REACHABLE under immutable fixture ordinary STOP`);
    ok(result.artifacts.length === manifest.totalAssignedTrials,
      `${expected} construction assigns exactly the real 120-slot topology`);
  }

  const missingFamily = manifest.cells.map((cell, index) => cell.family === 2
    ? { ...cell, cellKey: `${cell.cellKey}|family-removed-${index}`, family: 3 }
    : cell);
  ok(refuses(() => validateLiveV2Topology(missingFamily), /required family/i),
    'removing a required family fails the release topology gate');
  const missingBaseline = manifest.cells.map((cell, index) =>
    cell.family === 2 && cell.armId === 'A'
      ? { ...cell, cellKey: `${cell.cellKey}|baseline-removed-${index}`, armId: 'A2a' }
      : cell);
  ok(refuses(() => validateLiveV2Topology(missingBaseline), /lacks arm.*A/i),
    'a structured family cannot lose its arm A comparison baseline');
  const oneCell = manifest.cells.map((cell, index) =>
    cell.family === 3 && cell.cellId === 'family-3/3B'
      ? { ...cell, cellKey: `${cell.cellKey}|cell-collapsed-${index}`,
        cellId: 'family-3/3A' }
      : cell);
  ok(refuses(() => validateLiveV2Topology(oneCell), /two matched cells/i),
    'a required family cannot lose the second cell needed for cost/gain evaluability');
  const unmatchedCell = manifest.cells.map((cell, index) =>
    cell.family === 5 && cell.cellId === 'family-5/5A' && cell.armId === 'B'
      ? { ...cell, cellKey: `${cell.cellKey}|unmatched-${index}`, armId: 'C' }
      : cell);
  ok(refuses(() => validateLiveV2Topology(unmatchedCell), /not a matched five-arm/i),
    'each selected scenario must remain matched across all five arms');

  console.log(`\nevaluation live decision topology passed — ${passed} assertions; provider calls 0`);
}

main();
