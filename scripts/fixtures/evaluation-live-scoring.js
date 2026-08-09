'use strict';

// Canonical REAL-live scoring owner.
//
// A live slot and a fixture trial are both frozen execution assignments, but
// they are not interchangeable JSON shapes. This module performs the explicit,
// validated identity projection and only then calls the existing five-metric
// scorer. No observed outcome participates in slot identity.

const crypto = require('node:crypto');

const {
  AUTHORIZED_DIMENSIONS, SCORER_VERSION, evaluateLiveHardDisqualifiers,
  evaluateLiveOrdinaryDecision, hashCanonical, scoreDimensions
} = require('../structured-allocation-evaluation-scorer');
const { combineEvidence } = require('./evaluation-evidence-combination');
const {
  REAL_LIVE_ARTIFACT_LABEL, SYNTHETIC_ACCEPTANCE_LABEL,
  abortedRunDetail, isAbortedRunHeader
} = require('./evaluation-live-corpus-integrity');
const { LIVE_MANIFEST_VERSION: LIVE_MANIFEST_V1 } =
  require('./evaluation-live-manifest');
const { LIVE_MANIFEST_VERSION: LIVE_MANIFEST_V2 } =
  require('./evaluation-live-manifest-v2');
const { LIVE_MANIFEST_VERSION: LIVE_MANIFEST_V3 } =
  require('./evaluation-live-manifest-v3');
const { validateLiveV2Topology } = require('./evaluation-live-v2-matrix');
const {
  LIVE_ARTIFACT_DOMAIN_VERSION, assertLiveProductArtifactScorable
} = require('./evaluation-live-artifact-domain');

const LIVE_SCORING_PROJECTION_VERSION = 1;
const LIVE_REPORT_VERSION = 1;
const EXPECTED_ARMS = Object.freeze(['A', 'A2a', 'A2b', 'B', 'C']);
const SUPPORTED_LIVE_MANIFEST_VERSIONS = Object.freeze([
  LIVE_MANIFEST_V1, LIVE_MANIFEST_V2, LIVE_MANIFEST_V3
]);

class LiveScoringError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveScoringError';
    this.code = detail.code || 'LIVE_SCORING_REFUSED';
    this.detail = detail;
  }
}

function trialIdForLiveAssignment(trial) {
  return `${String(trial.repetition).padStart(2, '0')}-` +
    `${String(trial.slot).padStart(3, '0')}-${trial.cellId.replace('/', '_')}-` +
    `${trial.armId}`;
}

function recomputeManifestHash(manifest) {
  const identity = { ...manifest };
  delete identity.manifestHash;
  return hashCanonical(identity);
}

function assertExactFiveDimensions(dimensions) {
  const expected = AUTHORIZED_DIMENSIONS;
  if (!Array.isArray(dimensions) || dimensions.length !== expected.length ||
      dimensions.some((value, index) => value !== expected[index])) {
    throw new LiveScoringError(
      'the live manifest does not carry exactly the frozen five metric authorities',
      { code: 'LIVE_SCORING_DIMENSIONS_DRIFTED' });
  }
}

function projectLiveManifestToScoring({ manifest, protocol }) {
  if (!manifest || manifest.mode !== 'live' || Array.isArray(manifest.trials)) {
    throw new LiveScoringError(
      'the live scoring projection accepts only a canonical slots-based live manifest',
      { code: 'LIVE_SCORING_LIVE_MANIFEST_REQUIRED' });
  }
  if (!SUPPORTED_LIVE_MANIFEST_VERSIONS.includes(manifest.liveManifestVersion)) {
    throw new LiveScoringError(
      `unsupported live manifest version ${String(manifest.liveManifestVersion)}`,
      { code: 'LIVE_SCORING_MANIFEST_VERSION_UNSUPPORTED' });
  }
  if (manifest.containsResults !== false) {
    throw new LiveScoringError('a result-bearing manifest cannot define scoring identity',
      { code: 'LIVE_SCORING_RESULT_BEARING_MANIFEST' });
  }
  if (recomputeManifestHash(manifest) !== manifest.manifestHash) {
    throw new LiveScoringError('the live manifest hash does not match its canonical bytes',
      { code: 'LIVE_SCORING_MANIFEST_HASH_DRIFT' });
  }
  if (!protocol || protocol.protocolId !== manifest.protocolId ||
      protocol.protocolVersion !== manifest.protocolVersion) {
    throw new LiveScoringError('the live manifest and frozen protocol identity disagree',
      { code: 'LIVE_SCORING_PROTOCOL_MISMATCH' });
  }
  assertExactFiveDimensions(manifest.authorizedDimensions);
  assertExactFiveDimensions(protocol.authorizedDimensions);
  if (manifest.decisionRuleVersion !== protocol.protocolVersion ||
      manifest.hardDisqualifierVersion !== protocol.protocolVersion) {
    throw new LiveScoringError('live decision/disqualifier authority version drifted',
      { code: 'LIVE_SCORING_DECISION_AUTHORITY_DRIFT' });
  }
  if (!Array.isArray(manifest.cells) || manifest.uniqueCellCount !== 40 ||
      manifest.cells.length !== 40 || !Array.isArray(manifest.slots) ||
      manifest.repetitions !== protocol.repetition.liveModelRepetitions ||
      manifest.repetitions !== 3 || manifest.totalAssignedTrials !== 120 ||
      manifest.slots.length !== 120) {
    throw new LiveScoringError(
      'the live matrix is not the frozen 40-cell x 3-repetition x 120-slot authority',
      { code: 'LIVE_SCORING_MATRIX_SHAPE_MISMATCH' });
  }
  if (manifest.liveManifestVersion === LIVE_MANIFEST_V2 ||
      manifest.liveManifestVersion === LIVE_MANIFEST_V3) {
    try {
      validateLiveV2Topology(manifest.cells);
    } catch (error) {
      throw new LiveScoringError(
        `live-v2 decision topology is invalid: ${error.message}`,
        { code: 'LIVE_SCORING_DECISION_TOPOLOGY_INVALID' });
    }
  }

  const cells = new Map();
  for (const cell of manifest.cells) {
    if (!cell || typeof cell.cellKey !== 'string' || cells.has(cell.cellKey)) {
      throw new LiveScoringError('live cells contain a missing or duplicate cellKey',
        { code: 'LIVE_SCORING_CELL_AMBIGUOUS' });
    }
    cells.set(cell.cellKey, cell);
  }

  const identities = new Set();
  const slotsByRepetition = new Map();
  const trials = manifest.slots.map((slot, index) => {
    const cell = cells.get(slot && slot.cellKey);
    if (!cell) {
      throw new LiveScoringError(`slot ${index + 1} has no exact cell join`,
        { code: 'LIVE_SCORING_CELL_JOIN_MISSING', index });
    }
    for (const field of ['cellId', 'scenarioId', 'variantId', 'armId']) {
      const slotValue = slot[field] === undefined ? null : slot[field];
      const cellValue = cell[field] === undefined ? null : cell[field];
      if (slotValue !== cellValue) {
        throw new LiveScoringError(
          `slot ${index + 1} disagrees with its cell on ${field}`,
          { code: 'LIVE_SCORING_SLOT_CELL_DRIFT', field, index });
      }
    }
    if (!Number.isSafeInteger(slot.repetition) || slot.repetition < 1 ||
        slot.repetition > manifest.repetitions ||
        !Number.isSafeInteger(slot.slot) || slot.slot < 1 || slot.slot > 40 ||
        typeof slot.stochasticIdentity !== 'string' ||
        !/^[0-9a-f]{64}$/.test(slot.stochasticIdentity)) {
      throw new LiveScoringError(`slot ${index + 1} has invalid frozen identity`,
        { code: 'LIVE_SCORING_SLOT_IDENTITY_INVALID', index });
    }
    const identity = trialIdForLiveAssignment(slot);
    if (identities.has(identity)) {
      throw new LiveScoringError(`duplicate live slot identity ${identity}`,
        { code: 'LIVE_SCORING_SLOT_DUPLICATE', trialId: identity });
    }
    identities.add(identity);
    if (!slotsByRepetition.has(slot.repetition)) slotsByRepetition.set(slot.repetition, new Set());
    const ordinalSet = slotsByRepetition.get(slot.repetition);
    if (ordinalSet.has(slot.slot)) {
      throw new LiveScoringError(
        `repetition ${slot.repetition} contains duplicate slot ${slot.slot}`,
        { code: 'LIVE_SCORING_REPETITION_SLOT_DUPLICATE' });
    }
    ordinalSet.add(slot.slot);
    return Object.freeze({
      slot: slot.slot,
      repetition: slot.repetition,
      cellKey: slot.cellKey,
      cellId: slot.cellId,
      scenarioId: slot.scenarioId,
      family: Number((slot.scenarioId.match(/^family-(\d+)-/) || [])[1]),
      variantId: slot.variantId === undefined ? null : slot.variantId,
      armId: slot.armId,
      seed: slot.stochasticIdentity,
      expectedOracleAuthority: cell.expectedOracleAuthority,
      expectedQuiescence: cell.expectedQuiescence,
      trialId: identity
    });
  });
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const ordinals = slotsByRepetition.get(repetition);
    if (!ordinals || ordinals.size !== 40 ||
        Array.from({ length: 40 }, (_, index) => index + 1)
          .some(ordinal => !ordinals.has(ordinal))) {
      throw new LiveScoringError(`repetition ${repetition} does not assign slots 1..40 exactly`,
        { code: 'LIVE_SCORING_REPETITION_INCOMPLETE', repetition });
    }
  }
  const arms = [...new Set(trials.map(trial => trial.armId))].sort();
  if (arms.length !== EXPECTED_ARMS.length ||
      arms.some((arm, index) => arm !== [...EXPECTED_ARMS].sort()[index])) {
    throw new LiveScoringError('the live projection does not contain exactly A/A2a/A2b/B/C',
      { code: 'LIVE_SCORING_ARM_SET_DRIFT' });
  }
  return Object.freeze({
    projectionVersion: LIVE_SCORING_PROJECTION_VERSION,
    sourceShape: `canonical-live-manifest-v${manifest.liveManifestVersion}/slots`,
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    mode: 'live',
    manifestHash: manifest.manifestHash,
    failureHandling: Object.freeze({ ...protocol.failureHandling }),
    authorizedDimensions: Object.freeze([...manifest.authorizedDimensions]),
    trials: Object.freeze(trials)
  });
}

const READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS =
  'PROVIDER-FREE LIVE SCORING DRESS REHEARSAL — NOT PRODUCT EVIDENCE';

function assertLiveHeaderScorable({ header, manifest, projection,
  readinessDressRehearsal = false }) {
  if (isAbortedRunHeader(header)) {
    throw new LiveScoringError(
      'refusing an ABORTED — NOT DECISION EVIDENCE run before artifact aggregation',
      { code: 'LIVE_SCORING_ABORTED_RUN', aborted: abortedRunDetail(header) });
  }
  if (header && (header.syntheticAcceptance === true ||
      header.syntheticAcceptanceLabel === SYNTHETIC_ACCEPTANCE_LABEL)) {
    throw new LiveScoringError(
      'synthetic acceptance is harness evidence and may never be scored as product data',
      { code: 'LIVE_SCORING_SYNTHETIC_NOT_PRODUCT_EVIDENCE' });
  }
  const headerIsDressRehearsal = header?.readinessDressRehearsal === true &&
    header?.evidenceClass === READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS;
  if (readinessDressRehearsal !== headerIsDressRehearsal) {
    throw new LiveScoringError(
      'provider-free dress-rehearsal identity does not match the scoring invocation',
      { code: 'LIVE_SCORING_DRESS_REHEARSAL_IDENTITY_MISMATCH' });
  }
  if (header && typeof header.runHeaderHash === 'string') {
    const identity = { ...header };
    delete identity.runHeaderHash;
    if (hashCanonical(identity) !== header.runHeaderHash) {
      throw new LiveScoringError('the real run header hash does not reproduce',
        { code: 'LIVE_SCORING_RUN_HEADER_HASH_DRIFT' });
    }
  }
  if (!header || header.mode !== 'live' || header.assignedSetField !== 'slots' ||
      header.liveArtifactDomainVersion !== LIVE_ARTIFACT_DOMAIN_VERSION ||
      header.manifestHash !== manifest.manifestHash ||
      header.expectedTrialCount !== projection.trials.length ||
      !Array.isArray(header.trialIds) ||
      header.trialIds.length !== projection.trials.length ||
      header.trialIds.some((id, index) => id !== projection.trials[index].trialId)) {
    throw new LiveScoringError('the real run header does not bind the projected live slots',
      { code: 'LIVE_SCORING_RUN_HEADER_MISMATCH' });
  }
  const authority = header.credentialAuthority;
  if (!authority || authority.kind !== 'configured_agent' ||
      !Number.isSafeInteger(authority.configuredAgentId) ||
      !Number.isSafeInteger(authority.configuredAgentRevision) ||
      authority.provider !== manifest.provider) {
    throw new LiveScoringError('the real run header lacks a valid non-secret credential authority',
      { code: 'LIVE_SCORING_CREDENTIAL_AUTHORITY_MISSING' });
  }
  for (const forbidden of ['credential', 'secret', 'apiKey', 'api_key']) {
    if (Object.prototype.hasOwnProperty.call(authority, forbidden)) {
      throw new LiveScoringError('the run header credential authority contains secret material',
        { code: 'LIVE_SCORING_SECRET_PERSISTENCE', field: forbidden });
    }
  }
  return true;
}

function artifactHashMatches(artifact) {
  const body = { ...artifact };
  const stored = body.artifactHash;
  delete body.artifactHash;
  return typeof stored === 'string' &&
    crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex') === stored;
}

function assertLiveScoringCorpus({ manifest, projection, header, artifacts, exclusions = [],
  readinessDressRehearsal = false }) {
  assertLiveHeaderScorable({
    header, manifest, projection, readinessDressRehearsal
  });
  if (!Array.isArray(artifacts) || !Array.isArray(exclusions)) {
    throw new LiveScoringError('live artifacts and exclusions must be arrays',
      { code: 'LIVE_SCORING_CORPUS_SHAPE_INVALID' });
  }
  const expected = new Map(projection.trials.map(trial => [trial.trialId, trial]));
  const accounted = new Set();
  const scoringArtifacts = [];
  for (const artifact of artifacts) {
    const trial = expected.get(artifact && artifact.trialId);
    if (!trial) {
      throw new LiveScoringError('a live artifact is extra or unassigned',
        { code: 'LIVE_SCORING_ARTIFACT_UNASSIGNED', trialId: artifact && artifact.trialId });
    }
    if (accounted.has(trial.trialId)) {
      throw new LiveScoringError(`duplicate result for ${trial.trialId}`,
        { code: 'LIVE_SCORING_ARTIFACT_DUPLICATE', trialId: trial.trialId });
    }
    accounted.add(trial.trialId);
    const expectedFields = {
      label: REAL_LIVE_ARTIFACT_LABEL,
      mode: 'live',
      scoredRunHash: header.runHeaderHash,
      manifestHash: manifest.manifestHash,
      sourceCommit: header.repositoryCommit,
      trialSlot: trial.slot,
      repetition: trial.repetition,
      scenarioId: trial.scenarioId,
      variantId: trial.variantId,
      armId: trial.armId,
      seed: trial.seed
    };
    for (const [field, value] of Object.entries(expectedFields)) {
      const observed = artifact[field] === undefined && value === null ? null : artifact[field];
      if (observed !== value) {
        throw new LiveScoringError(`${trial.trialId} drifted on ${field}`,
          { code: 'LIVE_SCORING_ARTIFACT_IDENTITY_DRIFT', trialId: trial.trialId, field });
      }
    }
    if (!Number.isSafeInteger(trial.family) || artifact.family !== trial.family) {
      throw new LiveScoringError(`${trial.trialId} drifted on family identity`,
        { code: 'LIVE_SCORING_ARTIFACT_IDENTITY_DRIFT',
          trialId: trial.trialId, field: 'family' });
    }
    if (!artifactHashMatches(artifact)) {
      throw new LiveScoringError(`${trial.trialId} artifact hash does not reproduce`,
        { code: 'LIVE_SCORING_ARTIFACT_HASH_DRIFT', trialId: trial.trialId });
    }
    if (artifact.ticketReport?.secondReadIdentical !== true) {
      throw new LiveScoringError(`${trial.trialId} lacks report zero-drift proof`,
        { code: 'LIVE_SCORING_ZERO_DRIFT_UNPROVEN', trialId: trial.trialId });
    }
    assertLiveProductArtifactScorable({ artifact, trial, manifest });
    scoringArtifacts.push(Object.freeze({ ...artifact,
      cellKey: trial.cellKey, cellId: trial.cellId,
      expectedOracleAuthority: trial.expectedOracleAuthority,
      expectedQuiescence: trial.expectedQuiescence }));
  }
  for (const exclusion of exclusions) {
    const trial = expected.get(exclusion && exclusion.trialId);
    if (!trial) {
      throw new LiveScoringError('a live exclusion is extra or unassigned',
        { code: 'LIVE_SCORING_EXCLUSION_UNASSIGNED', trialId: exclusion && exclusion.trialId });
    }
    if (accounted.has(trial.trialId)) {
      throw new LiveScoringError(`slot ${trial.trialId} has more than one result/exclusion`,
        { code: 'LIVE_SCORING_SLOT_DUPLICATE', trialId: trial.trialId });
    }
    accounted.add(trial.trialId);
    if (exclusion.label !== REAL_LIVE_ARTIFACT_LABEL ||
        exclusion.scoredRunHash !== header.runHeaderHash ||
        exclusion.manifestHash !== manifest.manifestHash ||
        exclusion.sourceCommit !== header.repositoryCommit ||
        exclusion.classification !== 'infrastructure_exclusion' ||
        exclusion.replacementSlot !== null ||
        exclusion.assignedSlot?.slot !== trial.slot ||
        exclusion.assignedSlot?.armId !== trial.armId ||
        exclusion.assignedSlot?.scenarioId !== trial.scenarioId ||
        (exclusion.assignedSlot?.variantId ?? null) !== trial.variantId ||
        exclusion.assignedSlot?.repetition !== trial.repetition ||
        exclusion.assignedSlot?.seed !== trial.seed) {
      throw new LiveScoringError(`${trial.trialId} exclusion does not preserve its slot`,
        { code: 'LIVE_SCORING_EXCLUSION_IDENTITY_DRIFT', trialId: trial.trialId });
    }
  }
  const missing = projection.trials.filter(trial => !accounted.has(trial.trialId));
  if (missing.length > 0 || accounted.size !== projection.trials.length) {
    throw new LiveScoringError(
      `${accounted.size} live slots accounted for, expected ${projection.trials.length}`,
      { code: 'LIVE_SCORING_CORPUS_INCOMPLETE',
        missingTrialIds: missing.slice(0, 20).map(trial => trial.trialId) });
  }
  const liveCorpusHash = hashCanonical({
    manifestHash: manifest.manifestHash,
    runHeaderHash: header.runHeaderHash,
    repositoryCommit: header.repositoryCommit,
    results: projection.trials.map(trial => {
      const artifact = artifacts.find(entry => entry.trialId === trial.trialId);
      if (artifact) return { trialId: trial.trialId, artifactHash: artifact.artifactHash };
      const exclusion = exclusions.find(entry => entry.trialId === trial.trialId);
      return { trialId: trial.trialId, exclusion: hashCanonical(exclusion) };
    })
  });
  return Object.freeze({
    verdict: 'LIVE SCORING CORPUS COMPLETE AND INTERNALLY CONSISTENT',
    assignedCount: projection.trials.length,
    executedCount: scoringArtifacts.length,
    exclusionCount: exclusions.length,
    liveCorpusHash,
    artifacts: Object.freeze(scoringArtifacts)
  });
}

function groupMetrics(artifacts, keyOf) {
  const grouped = new Map();
  for (const artifact of artifacts) {
    const key = keyOf(artifact);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(artifact);
  }
  const output = {};
  for (const [key, rows] of [...grouped.entries()].sort(([a], [b]) =>
    String(a).localeCompare(String(b)))) {
    output[key] = {};
    for (const armId of EXPECTED_ARMS) {
      const armRows = rows.filter(row => row.armId === armId);
      if (armRows.length === 0) continue;
      output[key][armId] = { trials: armRows.length, ...scoreDimensions(armRows) };
    }
  }
  return output;
}

function fixtureSummary(manifest, fixtureReport) {
  if (!fixtureReport || fixtureReport.manifestHash !== manifest.source.fixtureManifestHash ||
      fixtureReport.corpusIntegrity?.corpusHash !== manifest.source.fixtureCorpusHash ||
      fixtureReport.reportHash !== manifest.source.fixtureReportHash ||
      fixtureReport.frozenDecision?.decision !== manifest.source.fixtureDecision) {
    throw new LiveScoringError('immutable fixture evidence identity/conclusion drifted',
      { code: 'LIVE_SCORING_FIXTURE_EVIDENCE_DRIFT' });
  }
  const disqualifiers = fixtureReport.hardDisqualifiers || [];
  return Object.freeze({
    fixtureEvidenceVersion: manifest.source.fixtureEvidence?.version || 1,
    manifestHash: fixtureReport.manifestHash,
    corpusHash: fixtureReport.corpusIntegrity.corpusHash,
    reportHash: fixtureReport.reportHash,
    conclusion: fixtureReport.frozenDecision.decision,
    hardDisqualifierTriggered: disqualifiers.some(entry => entry.result === 'TRIGGERED'),
    hardDisqualifiersNotEvaluable: disqualifiers
      .filter(entry => entry.result === 'NOT EVALUABLE').map(entry => entry.statement),
    ordinaryDecision: fixtureReport.frozenDecision.decision.split(' ').pop()
  });
}

function observableProviderUsage(artifacts) {
  const requests = artifacts.flatMap(artifact => artifact.normalizedCost?.requests || []);
  const metered = requests.filter(request => request.tokenSource === 'metered_usage');
  const unmetered = requests.filter(
    request => request.tokenSource === 'authorized_maximum_assumed');
  return Object.freeze({
    canonicalProviderRequestCount: requests.length,
    plannerRequestCount: requests.filter(request => request.role === 'planner').length,
    workerRequestCount: requests.filter(request => request.role === 'worker').length,
    meteredRequestCount: metered.length,
    unmeteredRequestCount: unmetered.length,
    providerReportedInputTokens: metered.reduce((sum, request) => sum + request.inputTokens, 0),
    providerReportedOutputTokens: metered.reduce((sum, request) => sum + request.outputTokens, 0),
    observableSpendMicroUsd: metered.reduce((sum, request) => sum + request.microUsd, 0),
    observableSpendCompleteness: unmetered.length === 0 ? 'complete' : 'lower_bound',
    basis: 'provider-reported tokens priced under the frozen pricing snapshot; ' +
      'unmetered requests are excluded from observable spend and remain in normalized cost'
  });
}

function strongestCompetingInterpretation(finalDecision) {
  if (finalDecision === 'RETAIN') {
    return 'The deterministic fixture could not discriminate live model performance; ' +
      'the live result reverses its ordinary STOP only by satisfying every frozen RETAIN rule.';
  }
  if (finalDecision === 'REVISE') {
    return 'Structured allocation may help selected families even though the frozen ' +
      'evidence does not justify one global activation policy.';
  }
  return 'A STOP may be driven by a narrow family or hard evidence boundary rather ' +
    'than uniform underperformance; the report preserves the exact driving trial IDs.';
}

function scoreLiveCorpus({ manifest, protocol, header, artifacts, exclusions = [],
  fixtureReport, committedLiabilityMicroUsd, interruptionResumeHistory = [],
  authenticatedPreflight = null, readinessDressRehearsal = false }) {
  const projection = projectLiveManifestToScoring({ manifest, protocol });
  const integrity = assertLiveScoringCorpus({
    manifest, projection, header, artifacts, exclusions, readinessDressRehearsal
  });
  const contributing = integrity.artifacts;
  const byArm = {};
  for (const armId of EXPECTED_ARMS) byArm[armId] = [];
  for (const artifact of contributing) byArm[artifact.armId].push(artifact);
  const metricsByArm = {};
  for (const armId of EXPECTED_ARMS) {
    metricsByArm[armId] = {
      trials: byArm[armId].length,
      trialIds: byArm[armId].map(artifact => artifact.trialId).sort(),
      ...scoreDimensions(byArm[armId])
    };
    if (Object.keys(metricsByArm[armId]).filter(key =>
      AUTHORIZED_DIMENSIONS.includes(key)).length !== AUTHORIZED_DIMENSIONS.length) {
      throw new LiveScoringError(`arm ${armId} does not report all five frozen metrics`,
        { code: 'LIVE_SCORING_METRIC_OMITTED', armId });
    }
  }
  const disqualifiers = evaluateLiveHardDisqualifiers({ protocol, byArm, artifacts: contributing });
  if (disqualifiers.length !== protocol.decisionThresholds.hardDisqualifiers.length ||
      disqualifiers.some((entry, index) =>
        entry.statement !== protocol.decisionThresholds.hardDisqualifiers[index])) {
    throw new LiveScoringError('the live path omitted a frozen hard-disqualifier owner',
      { code: 'LIVE_SCORING_DISQUALIFIER_OMITTED' });
  }
  const structurallyMissingDisqualifiers = disqualifiers.filter(entry =>
    entry.result === 'NOT EVALUABLE' &&
    entry.notEvaluableKind === 'required_evidence_missing');
  if (structurallyMissingDisqualifiers.length > 0) {
    throw new LiveScoringError(
      'required hard-disqualifier evidence is missing; refusing before decision',
      { code: 'LIVE_SCORING_DISQUALIFIER_EVIDENCE_MISSING',
        statements: structurallyMissingDisqualifiers.map(entry => entry.statement) });
  }
  const ordinary = evaluateLiveOrdinaryDecision({ protocol, disqualifiers, byArm });
  const fixture = fixtureSummary(manifest, fixtureReport);
  const liveForCombination = Object.freeze({
    hardDisqualifierTriggered: disqualifiers.some(entry => entry.result === 'TRIGGERED'),
    hardDisqualifiersNotEvaluable: disqualifiers
      .filter(entry => entry.result === 'NOT EVALUABLE').map(entry => entry.statement),
    ordinaryDecision: ordinary.ordinaryDecision,
    corpusComplete: true,
    runHeader: header
  });
  const combination = combineEvidence({ fixture, live: liveForCombination });
  if (!Number.isSafeInteger(committedLiabilityMicroUsd) || committedLiabilityMicroUsd < 0 ||
      committedLiabilityMicroUsd > manifest.economics.maximumTotalLiveMicroUsd) {
    throw new LiveScoringError('committed liability is missing or exceeds global authority',
      { code: 'LIVE_SCORING_LIABILITY_INVALID' });
  }
  const usage = observableProviderUsage(contributing);
  const nonSecretAuthority = Object.freeze({
    kind: header.credentialAuthority.kind,
    configuredAgentId: header.credentialAuthority.configuredAgentId,
    configuredAgentRevision: header.credentialAuthority.configuredAgentRevision,
    provider: header.credentialAuthority.provider
  });
  if (authenticatedPreflight !== null &&
      (authenticatedPreflight.manifestHash !== manifest.manifestHash ||
       authenticatedPreflight.provider !== manifest.provider ||
       authenticatedPreflight.adapterId !== manifest.adapterId ||
       authenticatedPreflight.model !== manifest.model ||
       hashCanonical(authenticatedPreflight.credentialAuthority) !==
         hashCanonical(nonSecretAuthority) ||
       authenticatedPreflight.providerCallsMade !== 1)) {
    throw new LiveScoringError(
      'authenticated preflight identity does not match the scored experiment authority',
      { code: 'LIVE_SCORING_PREFLIGHT_AUTHORITY_DRIFT' });
  }
  const report = {
    reportVersion: LIVE_REPORT_VERSION,
    liveManifestVersion: manifest.liveManifestVersion,
    liveArtifactDomainVersion: LIVE_ARTIFACT_DOMAIN_VERSION,
    scoringProjectionVersion: LIVE_SCORING_PROJECTION_VERSION,
    scorerVersion: SCORER_VERSION,
    evidenceClass: readinessDressRehearsal
      ? READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS
      : 'REAL LIVE PRODUCT EVIDENCE',
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    trialSourceCommit: header.repositoryCommit,
    liveManifestHash: manifest.manifestHash,
    realRunHeaderHash: header.runHeaderHash,
    liveCorpusHash: integrity.liveCorpusHash,
    credentialAuthority: nonSecretAuthority,
    fixtureEvidence: fixture,
    counts: Object.freeze({
      assigned: integrity.assignedCount,
      executed: integrity.executedCount,
      infrastructureExclusions: integrity.exclusionCount
    }),
    interruptionResumeHistory: Object.freeze([...interruptionResumeHistory]),
    authenticatedPreflight: authenticatedPreflight === null ? null : Object.freeze({
      provider: authenticatedPreflight.provider,
      adapterId: authenticatedPreflight.adapterId,
      model: authenticatedPreflight.model,
      requestControls: authenticatedPreflight.requestControls,
      usage: authenticatedPreflight.usage,
      actualCostMicroUsd: authenticatedPreflight.actualCostMicroUsd,
      providerCallsMade: authenticatedPreflight.providerCallsMade
    }),
    authorizedDimensions: AUTHORIZED_DIMENSIONS,
    metricsByArm,
    metricsByFamily: groupMetrics(contributing, artifact => `family-${artifact.family}`),
    metricsByScenario: groupMetrics(contributing, artifact =>
      `${artifact.scenarioId}/${artifact.variantId || 'none'}`),
    hardDisqualifiers: disqualifiers,
    liveOrdinaryDecision: ordinary,
    evidenceCombination: combination,
    finalProductDecision: combination.finalProductDecision,
    strongestCompetingInterpretation:
      strongestCompetingInterpretation(combination.finalProductDecision),
    decisionDrivingTrialIds: ordinary.decisionDrivingTrialIds,
    providerUsage: usage,
    costReporting: Object.freeze({
      observableProviderSpendMicroUsd: usage.observableSpendMicroUsd,
      observableProviderSpendCompleteness: usage.observableSpendCompleteness,
      normalizedCostLabel: 'normalized scoring cost — not actual billing',
      committedLiabilityMicroUsd,
      committedLiabilityLabel: 'maximum committed liability — not actual billing',
      globalAuthorityMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
      globalAuthorityNeverExceeded:
        committedLiabilityMicroUsd <= manifest.economics.maximumTotalLiveMicroUsd
    }),
    denominatorSeparation:
      'fixture and live denominators were scored separately and were never pooled'
  };
  report.reportHash = hashCanonical(report);
  return Object.freeze(report);
}

function assertLiveReportIdentity(report) {
  if (!report || typeof report.reportHash !== 'string') {
    throw new LiveScoringError('live report carries no immutable report hash',
      { code: 'LIVE_SCORING_REPORT_HASH_MISSING' });
  }
  const identity = { ...report };
  delete identity.reportHash;
  if (hashCanonical(identity) !== report.reportHash) {
    throw new LiveScoringError('live report identity/hash drifted',
      { code: 'LIVE_SCORING_REPORT_HASH_DRIFT' });
  }
  return true;
}

module.exports = {
  EXPECTED_ARMS,
  LIVE_REPORT_VERSION,
  LIVE_SCORING_PROJECTION_VERSION,
  READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
  LiveScoringError,
  assertLiveHeaderScorable,
  assertLiveReportIdentity,
  assertLiveScoringCorpus,
  projectLiveManifestToScoring,
  scoreLiveCorpus,
  trialIdForLiveAssignment
};
