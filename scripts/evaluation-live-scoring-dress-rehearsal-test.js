#!/usr/bin/env node
'use strict';

// Provider-free pre-dispatch proof of the complete post-corpus path. All trial
// facts below are controlled synthetic values authored independently of any
// real-model outcome. This suite is structural harness evidence, never product
// evidence.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const liveManifest = require('../config/structured-allocation-evaluation-live-v3.json');
const historicalLiveManifest = require('../config/structured-allocation-evaluation-live-v2.json');
const historicalLiveV1Manifest = require('../config/structured-allocation-evaluation-live-v1.json');
const fixtureManifest = require('../config/structured-allocation-evaluation-scored-v1.json');
const protocol = require('../config/structured-allocation-evaluation-v1.json');
const {
  REAL_LIVE_ARTIFACT_LABEL, SYNTHETIC_ACCEPTANCE_LABEL,
  auditLiveCorpus
} = require('./fixtures/evaluation-live-corpus-integrity');
const {
  LiveScoringError, assertLiveHeaderScorable, assertLiveReportIdentity,
  assertLiveScoringCorpus, projectLiveManifestToScoring, scoreLiveCorpus,
  trialIdForLiveAssignment
} = require('./fixtures/evaluation-live-scoring');
const {
  LIVE_ARTIFACT_DOMAIN_VERSION
} = require('./fixtures/evaluation-live-artifact-domain');
const { hashCanonical } = require('./structured-allocation-evaluation-scorer');
const {
  renderLiveMarkdown, sha256, writeImmutable
} = require('./structured-allocation-evaluation-report-live');

let passed = 0;
function ok(value, message) {
  assert.equal(value, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function refusalCode(fn) {
  try { fn(); return null; } catch (error) { return error.code || error.detail?.code || null; }
}

function rehashManifest(change) {
  const manifest = JSON.parse(JSON.stringify(liveManifest));
  change(manifest);
  delete manifest.manifestHash;
  manifest.manifestHash = hashCanonical(manifest);
  return manifest;
}

function headerFor(manifest = liveManifest) {
  const header = {
    scoredRunVersion: 1,
    liveRunVersion: 2,
    repositoryCommit: 'd'.repeat(40),
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    manifestHash: manifest.manifestHash,
    mode: 'live',
    assignedSetField: 'slots',
    expectedTrialCount: manifest.slots.length,
    trialIds: manifest.slots.map(trialIdForLiveAssignment),
    provider: manifest.provider,
    model: manifest.model,
    adapterId: manifest.adapterId,
    liveArtifactDomainVersion: LIVE_ARTIFACT_DOMAIN_VERSION,
    credentialAuthority: {
      kind: 'configured_agent', configuredAgentId: 41,
      configuredAgentRevision: 7, provider: 'openai'
    },
    syntheticAcceptance: false,
    syntheticAcceptanceLabel: null
  };
  header.runHeaderHash = hashCanonical(header);
  return header;
}

function isControlledTrueCompletion(slot) {
  if (slot.armId === 'B' || slot.armId === 'C') return true;
  // Every required family has two matched cells on every arm. One controlled
  // baseline cell succeeds and one fails, consistently across repetitions;
  // this makes both truthfulness gain and cost-per-truthful-completion
  // evaluable without inventing a family outside the actual manifest.
  return /\/[2356]A$/.test(slot.cellId);
}

function request(role, microUsd) {
  return {
    role, provider: 'openai', model: liveManifest.model,
    tokenSource: 'metered_usage', inputTokens: 10, outputTokens: 2,
    microUsd, measurement: 'derived'
  };
}

function artifactFor(slot, header = HEADER) {
  const structured = slot.armId === 'B' || slot.armId === 'C';
  const legacy = slot.armId === 'A2a' || slot.armId === 'A2b';
  const completed = isControlledTrueCompletion(slot);
  const terminal = completed ? 'completed' : 'failed';
  const family = Number((slot.scenarioId.match(/^family-(\d+)/) || [])[1]);
  const cell = liveManifest.cells.find(entry => entry.cellKey === slot.cellKey);
  const requests = structured ? [request('planner', 4), request('worker', 6)]
    : [request('worker', 6)];
  const total = requests.reduce((sum, item) => sum + item.microUsd, 0);
  const ceiling = liveManifest.economics.liability.byArm[slot.armId].perTrialMicroUsd;
  const artifact = {
    schemaVersion: 1,
    protocolVersion: protocol.protocolVersion,
    repositoryCommit: header.repositoryCommit,
    label: REAL_LIVE_ARTIFACT_LABEL,
    scoredRunHash: header.runHeaderHash,
    manifestHash: header.manifestHash,
    trialSlot: slot.slot,
    trialId: trialIdForLiveAssignment(slot),
    sourceCommit: header.repositoryCommit,
    scenarioId: slot.scenarioId,
    family,
    variantId: slot.variantId ?? null,
    variantLabel: null,
    armId: slot.armId,
    repetition: slot.repetition,
    seed: slot.stochasticIdentity,
    mode: 'live',
    envelopeHash: `controlled-envelope-${slot.cellKey}`,
    pathProof: {
      observedPath: structured ? 'structured_v2' : (legacy ? 'legacy_v1' : 'direct'),
      ticketResultStatus: terminal,
      ticketStatus: terminal,
      runCount: 1,
      leafRunsAdmitted: structured,
      governedLeafRunCount: structured ? 1 : 0,
      executableItemCount: structured ? 1 : 0,
      governedLeafExecutionObserved: structured,
      sameParentPolicyRevision: structured ? true : null,
      aggregateReconciliationObserved: structured,
      aggregateReconciliationAuthority: structured
        ? { events: 1, aggregateStatus: terminal,
          aggregateDecisionHash: `controlled-decision-${slot.repetition}-${slot.slot}` }
        : null
    },
    ticketReport: {
      secondReadIdentical: true,
      productClaimsCompleted: completed,
      terminalTicketStatus: terminal,
      durableObservation: {
        version: 1,
        transport: { byRole: { ungoverned_worker: structured ? 0 : 1,
          structured_planner: structured ? 1 : 0,
          governed_leaf_worker: structured ? 1 : 0 } }
      },
      authority: {
        ticketStatus: terminal,
        anyRunCompleted: completed,
        completionDecisionCount: completed ? 1 : 0,
        completionDecidedEvents: completed ? 1 : 0
      },
      churn: structured ? { persistedProgressBlocks: 0, blockEvents: 0 } : null
    },
    oracleResult: {
      verdict: completed ? 'pass' : 'fail',
      observations: [],
      authority: cell.expectedOracleAuthority === 'raw_state'
        ? 'independent_raw_state_observation'
        : 'independent_raw_state_and_fixture_access_log'
    },
    normalizedCost: {
      pricingSnapshotHash: 'p'.repeat(64),
      measurement: 'derived',
      plannerRequestCount: structured ? 1 : 0,
      plannerMicroUsd: structured ? 4 : 0,
      workerRequestCount: 1,
      workerMicroUsd: structured ? 6 : 6,
      totalNormalizedMicroUsd: total,
      truthfulCompletions: completed ? 1 : 0,
      normalizedMicroUsdPerTruthfulCompletion: completed ? total : null,
      unmeteredRequestCount: 0,
      capturedEconomicCeilingMicroUsd: ceiling,
      ceilingAuthority: 'captured_trial_economic_ceiling',
      normalizedExceedsCeiling: false,
      durableGovernedExceedsCeiling: structured ? false : null,
      exceededCeiling: false,
      durableGovernedMicroUsd: structured ? total : null,
      durableVersusNormalizedDeltaMicroUsd: structured ? 0 : null,
      requests
    },
    durableGovernedCost: structured ? total : null,
    latency: { endToEndMs: structured ? 120 : 100, planningMs: structured ? 20 : null,
      timeToFirstExecutionMs: 50 },
    churn: null,
    observationSinkVersion: 1,
    observationCompleteness: cell.expectedOracleAuthority === 'raw_state'
      ? 'unavailable' : 'complete',
    observationStreamIdentities: [],
    churnFacts: {
      evidenceAuthority: 'durable_ticket_report_v1',
      observationCompleteness: 'complete', noProgressStreak: structured ? 0 : null,
      worker: { attemptedTransports: 1, durableResponses: 1 }
    },
    recoveryFacts: null,
    variantExpectation: null,
    truthfulness: completed ? 'true_positive_completion' : 'true_negative_completion',
    quiescence: { quiescent: true, timedOut: false, authority: 'read_only_observation' },
    fixtureTranscriptHash: null,
    externalStateHash: null,
    exclusions: [],
    warnings: []
  };
  artifact.artifactHash = crypto.createHash('sha256')
    .update(JSON.stringify(artifact)).digest('hex');
  return artifact;
}

function rehashArtifact(artifact) {
  const copy = JSON.parse(JSON.stringify(artifact));
  delete copy.artifactHash;
  copy.artifactHash = crypto.createHash('sha256')
    .update(JSON.stringify(copy)).digest('hex');
  return copy;
}

function fixtureReport() {
  return {
    manifestHash: liveManifest.source.fixtureManifestHash,
    corpusIntegrity: { corpusHash: liveManifest.source.fixtureCorpusHash },
    reportHash: liveManifest.source.fixtureReportHash,
    hardDisqualifiers: [
      { statement: 'controlled fixture disqualifier', result: 'NOT TRIGGERED' }
    ],
    frozenDecision: { decision: liveManifest.source.fixtureDecision }
  };
}

const HEADER = headerFor();
const ARTIFACTS = liveManifest.slots.map(slot => artifactFor(slot));
const PREFLIGHT_FAKE_SECRET = 'controlled-fake-secret-never-persist';
const PREFLIGHT = {
  authenticatedPreflightVersion: 1,
  manifestHash: liveManifest.manifestHash,
  credentialAuthority: HEADER.credentialAuthority,
  provider: liveManifest.provider,
  adapterId: liveManifest.adapterId,
  model: liveManifest.model,
  requestControls: {
    temperature: liveManifest.sampling.temperature,
    topP: liveManifest.sampling.topP,
    maxOutputTokens: liveManifest.maximumOutputTokensPerRequest
  },
  usage: { inputTokens: 10, outputTokens: 2 },
  actualCostMicroUsd: 1,
  providerCallsMade: 1,
  credential: PREFLIGHT_FAKE_SECRET
};

function score(overrides = {}) {
  return scoreLiveCorpus({
    manifest: liveManifest,
    protocol,
    header: HEADER,
    artifacts: ARTIFACTS,
    exclusions: [],
    fixtureReport: fixtureReport(),
    committedLiabilityMicroUsd: liveManifest.economics.computedWorstCaseMicroUsd,
    interruptionResumeHistory: [],
    authenticatedPreflight: PREFLIGHT,
    ...overrides
  });
}

function main() {
  console.log('evaluation live scoring dress rehearsal');
  const projection = projectLiveManifestToScoring({ manifest: liveManifest, protocol });
  ok(projection.trials.length === 120 && projection.projectionVersion === 1,
    'canonical live slots project to 120 explicit scoring trials');
  ok(projection.trials.every((trial, index) =>
    trial.trialId === trialIdForLiveAssignment(liveManifest.slots[index]) &&
    trial.armId === liveManifest.slots[index].armId &&
    trial.repetition === liveManifest.slots[index].repetition),
  'slot→trial identity is lossless, ordered and outcome-independent');
  ok(new Set(projection.trials.map(trial => trial.trialId)).size === 120,
    'the projection creates no duplicate or ambiguous trial identity');

  const report = score();
  const markdown = renderLiveMarkdown(report);
  ok(report.finalProductDecision === 'RETAIN' &&
     report.liveOrdinaryDecision.ordinaryDecision === 'RETAIN',
  'the complete controlled path reaches RETAIN from the actual live-v3 topology');
  ok(report.authorizedDimensions.length === 5 &&
     Object.values(report.metricsByArm).every(metric =>
       ['allocation_quality', 'completion_truthfulness', 'latency', 'cost', 'churn']
         .every(dimension => Object.prototype.hasOwnProperty.call(metric, dimension))),
  'all five frozen metrics aggregate separately for A/A2a/A2b/B/C');
  ok(report.hardDisqualifiers.length === 5 &&
     report.hardDisqualifiers.every(entry =>
       ['TRIGGERED', 'NOT TRIGGERED', 'NOT EVALUABLE'].includes(entry.result)),
  'all five hard-disqualifier owners execute with explicit tri-state results');
  ok(report.providerUsage.plannerRequestCount === 48 &&
     report.providerUsage.canonicalProviderRequestCount === 168,
  'the controlled 48 planner requests join all worker/leaf requests exactly once');
  ok(report.fixtureEvidence.conclusion === 'FIXTURE EVIDENCE SUPPORTS STOP' &&
     report.evidenceCombination.metricReporting.includes('never pooled') &&
     report.denominatorSeparation.includes('never pooled'),
  'immutable fixture STOP combines mechanically without pooling denominators');
  ok(report.counts.assigned === 120 && report.counts.executed === 120 &&
     report.counts.infrastructureExclusions === 0,
  'all 120 controlled assigned slots are accounted for once');
  ok(assertLiveReportIdentity(report) &&
     report.reportHash === score().reportHash &&
     markdown === renderLiveMarkdown(score()),
  'JSON identity, Markdown and report hash reproduce with zero drift');
  ok(!JSON.stringify(report).includes(PREFLIGHT_FAKE_SECRET) &&
     !markdown.includes(PREFLIGHT_FAKE_SECRET),
  'fake credential material is absent from JSON and Markdown observables');
  ok(markdown.includes('REAL LIVE PRODUCT EVIDENCE') &&
     !markdown.includes('SCORED FIXTURE EVIDENCE.'),
  'the live report is distinctly branded and never reuses fixture branding');

  // Projection refusal matrix.
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: fixtureManifest, protocol
  })) === 'LIVE_SCORING_LIVE_MANIFEST_REQUIRED',
  'a fixture manifest cannot enter the live adapter');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.liveManifestVersion = 99; }), protocol
  })) === 'LIVE_SCORING_MANIFEST_VERSION_UNSUPPORTED',
  'the adapter refuses the wrong live-manifest version');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.slots = []; }), protocol
  })) === 'LIVE_SCORING_MATRIX_SHAPE_MISMATCH',
  'a live manifest with no slots refuses');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => {
      manifest.slots[1] = JSON.parse(JSON.stringify(manifest.slots[0]));
    }), protocol
  })) === 'LIVE_SCORING_SLOT_DUPLICATE',
  'duplicate live slot identity refuses');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.slots.pop(); }), protocol
  })) === 'LIVE_SCORING_MATRIX_SHAPE_MISMATCH',
  'a missing live slot refuses');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.slots[0].cellKey = 'not-a-cell'; }),
    protocol
  })) === 'LIVE_SCORING_CELL_JOIN_MISSING',
  'an invalid cell join refuses');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.slots[0].armId = 'C'; }), protocol
  })) === 'LIVE_SCORING_SLOT_CELL_DRIFT',
  'slot arm drift refuses before aggregation');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.slots[0].repetition = 2; }), protocol
  })) === 'LIVE_SCORING_REPETITION_SLOT_DUPLICATE',
  'slot repetition drift cannot create an ambiguous identity');
  ok(refusalCode(() => projectLiveManifestToScoring({
    manifest: rehashManifest(manifest => { manifest.authorizedDimensions.pop(); }), protocol
  })) === 'LIVE_SCORING_DIMENSIONS_DRIFTED',
  'omission of one of the five metric authorities refuses');

  // Corpus/refusal matrix.
  const extra = rehashArtifact({ ...ARTIFACTS[0], trialId: 'extra-unassigned' });
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection, header: HEADER,
    artifacts: [...ARTIFACTS, extra], exclusions: []
  })) === 'LIVE_SCORING_ARTIFACT_UNASSIGNED',
  'an extra/unassigned artifact refuses');
  const wrongArm = rehashArtifact({ ...ARTIFACTS[0], armId: 'C' });
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection, header: HEADER,
    artifacts: [wrongArm, ...ARTIFACTS.slice(1)], exclusions: []
  })) === 'LIVE_SCORING_ARTIFACT_IDENTITY_DRIFT',
  'artifact arm/slot identity drift refuses');
  const wrongFamily = rehashArtifact({ ...ARTIFACTS[0], family: 9 });
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection, header: HEADER,
    artifacts: [wrongFamily, ...ARTIFACTS.slice(1)], exclusions: []
  })) === 'LIVE_SCORING_ARTIFACT_IDENTITY_DRIFT',
  'artifact family identity cannot drift from its frozen scenario');
  const fixtureMixed = rehashArtifact({ ...ARTIFACTS[0], mode: 'fixture' });
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection, header: HEADER,
    artifacts: [fixtureMixed, ...ARTIFACTS.slice(1)], exclusions: []
  })) === 'LIVE_SCORING_ARTIFACT_IDENTITY_DRIFT',
  'fixture/live artifact pooling refuses');

  const excludedTrial = projection.trials[projection.trials.length - 1];
  const excludedArtifact = ARTIFACTS[ARTIFACTS.length - 1];
  const exclusion = {
    label: REAL_LIVE_ARTIFACT_LABEL,
    trialId: excludedTrial.trialId,
    scoredRunHash: HEADER.runHeaderHash,
    manifestHash: liveManifest.manifestHash,
    sourceCommit: HEADER.repositoryCommit,
    assignedSlot: {
      slot: excludedTrial.slot, armId: excludedTrial.armId,
      scenarioId: excludedTrial.scenarioId, variantId: excludedTrial.variantId,
      repetition: excludedTrial.repetition, seed: excludedTrial.seed
    },
    frozenReason: 'controlled infrastructure exclusion',
    classification: 'infrastructure_exclusion',
    evidence: {}, replacementSlot: null
  };
  const excludedReport = score({
    artifacts: ARTIFACTS.slice(0, -1), exclusions: [exclusion]
  });
  ok(excludedReport.counts.executed === 119 &&
     excludedReport.counts.infrastructureExclusions === 1 &&
     Object.values(excludedReport.metricsByArm)
       .reduce((sum, metric) => sum + metric.trials, 0) === 119,
  'an infrastructure exclusion keeps its slot while leaving live metric denominators separate');
  ok(refusalCode(() => score({
    artifacts: ARTIFACTS,
    exclusions: [{ ...exclusion, assignedSlot: { ...exclusion.assignedSlot, armId: 'A' } }]
  })) === 'LIVE_SCORING_SLOT_DUPLICATE',
  'an exclusion cannot duplicate or corrupt an already-accounted denominator');
  void excludedArtifact;

  const missingCost = rehashArtifact({
    ...ARTIFACTS[0],
    normalizedCost: { ...ARTIFACTS[0].normalizedCost,
      capturedEconomicCeilingMicroUsd: null, exceededCeiling: null }
  });
  ok(refusalCode(() => score({
    artifacts: [missingCost, ...ARTIFACTS.slice(1)]
  })) === 'LIVE_SCORING_DISQUALIFIER_EVIDENCE_MISSING',
  'missing required hard-disqualifier evidence refuses before decision');

  const missingLatency = rehashArtifact({ ...ARTIFACTS[0], latency: null });
  ok(refusalCode(() => score({
    artifacts: [missingLatency, ...ARTIFACTS.slice(1)]
  })) === 'LIVE_SCORING_METRIC_EVIDENCE_MISSING',
  'an artifact omitting one of the five metric inputs refuses before aggregation');
  const omittedPlanner = rehashArtifact({
    ...ARTIFACTS.find(artifact => artifact.armId === 'B'),
    normalizedCost: {
      ...ARTIFACTS.find(artifact => artifact.armId === 'B').normalizedCost,
      requests: ARTIFACTS.find(artifact => artifact.armId === 'B')
        .normalizedCost.requests.filter(request => request.role !== 'planner')
    }
  });
  const omittedPlannerIndex = ARTIFACTS.findIndex(artifact => artifact.armId === 'B');
  ok(refusalCode(() => score({
    artifacts: ARTIFACTS.map((artifact, index) =>
      index === omittedPlannerIndex ? omittedPlanner : artifact)
  })) === 'LIVE_SCORING_METRIC_EVIDENCE_MISSING',
  'planner cost cannot be omitted from a live artifact without refusing');
  const nonQuiescent = rehashArtifact({ ...ARTIFACTS[0],
    quiescence: { ...ARTIFACTS[0].quiescence, quiescent: false, timedOut: true } });
  ok(refusalCode(() => score({
    artifacts: [nonQuiescent, ...ARTIFACTS.slice(1)]
  })) === 'LIVE_ARTIFACT_TIMEOUT_ORACLE_INVALID',
  'a product timeout cannot carry an oracle verdict sampled before quiescence');

  const alteredReport = { ...report, finalProductDecision: 'STOP' };
  ok(refusalCode(() => assertLiveReportIdentity(alteredReport)) ===
     'LIVE_SCORING_REPORT_HASH_DRIFT',
  'report identity/hash drift refuses');

  // Quarantine runs before artifact access. The Proxy would throw if touched.
  const outcomeBearingTrap = new Proxy([], {
    get() { throw new Error('outcome artifacts were read'); }
  });
  for (const runHeaderHash of [
    'b2b59ad2b9d9fafc8ac860838b0530cb8f90bc02907b36a3a230b560bece2eef',
    '986249cebdf2239c93b37ed7340aedbebbb85df5e134f4f848264dd5c1916359',
    '1cb2332d782b9478454d329dfd5ebd95e195acb6289ffd57b9e1255045d95022',
    'ad677632d187a791f885869f69dbd7232caab1d170ceb9fee7357f515871aed6',
    '7297f3dd7d3ec98e563c1474a6163fc14d06612824091b7ac76838cfc364e47f'
  ]) {
    ok(refusalCode(() => assertLiveScoringCorpus({
      manifest: liveManifest, projection,
      header: { ...HEADER, runHeaderHash },
      artifacts: outcomeBearingTrap, exclusions: outcomeBearingTrap
    })) === 'LIVE_SCORING_ABORTED_RUN',
    `aborted run ${runHeaderHash.slice(0, 8)} refuses before outcome artifacts are read`);
    const audit = auditLiveCorpus({
      manifest: liveManifest,
      header: { ...HEADER, runHeaderHash },
      outputRoot: path.join(os.tmpdir(), 'deliberately-nonexistent-live-root'),
      trialIdFor: trialIdForLiveAssignment
    });
    ok(audit.aborted === true && audit.artifactCount === 0,
      `aborted run ${runHeaderHash.slice(0, 8)} also stops at the disk corpus gate`);
  }
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection,
    header: { ...HEADER, syntheticAcceptance: true,
      syntheticAcceptanceLabel: SYNTHETIC_ACCEPTANCE_LABEL },
    artifacts: outcomeBearingTrap, exclusions: outcomeBearingTrap
  })) === 'LIVE_SCORING_SYNTHETIC_NOT_PRODUCT_EVIDENCE',
  'synthetic acceptance refuses before product aggregation');
  ok(refusalCode(() => assertLiveScoringCorpus({
    manifest: liveManifest, projection,
    header: headerFor(historicalLiveManifest),
    artifacts: outcomeBearingTrap, exclusions: outcomeBearingTrap
  })) === 'LIVE_SCORING_RUN_HEADER_MISMATCH',
  'a historical live-v2 run header cannot be paired with live-v3 before artifacts are read');

  // Immutable report files and hashes, in an isolated temporary directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-score-dress-'));
  try {
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const md = renderLiveMarkdown(report);
    const jsonPath = path.join(root, 'report.json');
    const mdPath = path.join(root, 'report.md');
    writeImmutable(jsonPath, json);
    writeImmutable(mdPath, md);
    ok(sha256(fs.readFileSync(jsonPath)) === sha256(json) &&
       sha256(fs.readFileSync(mdPath)) === sha256(md),
    'immutable JSON/Markdown bytes reproduce their report hashes');
    ok(refusalCode(() => writeImmutable(jsonPath, json)) === 'EEXIST',
      'an immutable live report cannot be overwritten');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  ok(liveManifest.liveManifestVersion === 3 &&
     liveManifest.source.fixtureEvidence?.version === 2,
  'the candidate live-v3 manifest binds fixture-evidence v2');
  ok(historicalLiveManifest.manifestHash ===
    '634963b5581a57449e0c45ffb7973f86a3ff0b6bd6b708d4fc06b9969c8c76b6',
  'historical live-v2 manifest bytes remain bound to their exact hash');
  ok(historicalLiveV1Manifest.manifestHash ===
    '792d228f939d597891da25bd4d779d76999940c2040e7e846afaf81fc35530b6',
  'historical live-v1 manifest bytes remain bound to their exact hash');
  ok(fixtureReport().manifestHash === liveManifest.source.fixtureManifestHash &&
     fixtureReport().corpusIntegrity.corpusHash ===
       liveManifest.source.fixtureCorpusHash &&
     fixtureReport().reportHash === liveManifest.source.fixtureReportHash,
  'the low-level scorer fixture capsule follows the live-v3 binding');

  console.log(`\nevaluation live scoring dress rehearsal passed — ${passed} assertions; provider calls 0`);
}

module.exports = {
  ARTIFACTS,
  HEADER,
  PREFLIGHT,
  artifactFor,
  fixtureReport,
  headerFor,
  liveManifest,
  rehashArtifact,
  score
};

if (require.main === module) main();
