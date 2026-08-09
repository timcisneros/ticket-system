#!/usr/bin/env node
'use strict';

// Tranche 6 — the SCORED fixture executor.
//
// IT CONSUMES A FROZEN MANIFEST AND DECIDES NOTHING. Trial ordering, seeds,
// repetitions, arm membership, scenario variants, thresholds and the exclusion
// predicate are all read from
// `config/structured-allocation-evaluation-scored-v1.json`. This file generates
// none of them, and accepts no command-line option that could override one.
// The only options it takes are operational: where to write, whether to resume,
// how loudly to log.
//
// WHY THAT MATTERS MORE THAN CONVENIENCE. Any of those values chosen after
// seeing a result turns an experiment into a search for a favourable
// arrangement. The manifest was hashed before the first trial; this executor
// refuses to start if its runtime inputs differ from it.
//
// IT ALSO DOES NOT SCORE. It executes trials and writes immutable artifacts.
// Deciding which arm is ahead — mid-run or at all — belongs to the separate
// pure scorer, which reads only the frozen corpus.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario, PROTOCOL_VERSION } = require('./fixtures/evaluation-scenarios');
const {
  assertRuntimeMatchesManifest, hashCanonical
} = require('./fixtures/evaluation-scored-manifest');
const { runTrial } = require('./structured-allocation-evaluation-runner');
const {
  assertDispatchWithinGlobalCeiling, releaseUndispatchedReservation
} = require('./fixtures/evaluation-live-budget-ledger');
const {
  acceptedSlots, appendJournal, readJournal
} = require('./fixtures/evaluation-live-run-journal');
const {
  SYNTHETIC_ACCEPTANCE_LABEL, assertScorableLiveCorpus, auditLiveCorpus,
  buildExclusionArtifact
} = require('./fixtures/evaluation-live-corpus-integrity');
const { classifyLiveFailure } = require('./fixtures/evaluation-live-failure-classifier');
const { trialWorstCaseMicroUsd } = require('./fixtures/evaluation-live-trial-liability');
const { ROLE_ECONOMICS } = require('./fixtures/governed-role-policy-container');
const { withHarness } = require('./postgres-test-harness');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  assertAuthenticatedPreflightAuthority,
  authenticatedRealLivePreflight,
  realLiveCredentialAuthorityIdentity,
  resolveRealLiveCredentialAuthority,
  sameCredentialAuthority
} = require('./fixtures/evaluation-server-env');

const SCORED_RUNNER_VERSION = 1;
const SCORED_ARTIFACT_LABEL = 'SCORED FIXTURE TRIAL — FROZEN PROTOCOL V1';

class ScoredRunnerError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ScoredRunnerError';
    this.detail = detail;
  }
}

// ── CLI: operational options only ───────────────────────────────────────────
//
// There is deliberately no `--repetitions`, `--seed`, `--arms`, `--order`,
// `--threshold` or `--exclude`. An option that could change the experiment is
// not an option, it is a second protocol.
const OPERATIONAL_OPTIONS = Object.freeze([
  'manifest', 'output-root', 'resume', 'verbose', 'limit', 'dry-run',
  'credential-agent-id'
]);

const FROZEN_EXPERIMENTAL_OPTIONS = Object.freeze([
  'repetitions', 'repetition', 'seed', 'seeds', 'arm', 'arms', 'order',
  'ordering', 'threshold', 'thresholds', 'exclude', 'exclusion', 'scenario',
  'variant', 'metric', 'metrics', 'protocol'
]);

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      throw new ScoredRunnerError(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (FROZEN_EXPERIMENTAL_OPTIONS.includes(key)) {
      throw new ScoredRunnerError(
        `--${key} names a FROZEN experimental variable and may not be overridden ` +
        'from the command line; change it in the manifest and re-freeze, or do ' +
        'not change it', { option: key });
    }
    if (!OPERATIONAL_OPTIONS.includes(key)) {
      throw new ScoredRunnerError(`unknown option --${key}`);
    }
    if (key === 'resume' || key === 'verbose' || key === 'dry-run') {
      parsed[key] = true; continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ScoredRunnerError(`--${key} requires a value`);
    }
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.manifest) throw new ScoredRunnerError('--manifest is required');
  if (!parsed['output-root']) throw new ScoredRunnerError('--output-root is required');
  return parsed;
}

function repositoryCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
}

// ── The immutable scored-run header ─────────────────────────────────────────
//
// Written once, before trial 1. Every artifact binds its hash, so two different
// manifests can never write into one scored-run directory and an artifact can
// never be moved between runs.
function buildRunHeader({ manifest, manifestPath, outputRoot }) {
  const manifestFileHash = crypto.createHash('sha256')
    .update(fs.readFileSync(manifestPath)).digest('hex');
  const header = {
    scoredRunVersion: 1,
    repositoryCommit: repositoryCommit(),
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    manifestHash: manifest.manifestHash,
    manifestFileHash,
    runnerVersion: SCORED_RUNNER_VERSION,
    scorerVersion: 1,
    decisionRuleVersion: manifest.decisionRuleVersion,
    evaluationProtocolVersion: PROTOCOL_VERSION,
    mode: manifest.mode,
    startedAt: new Date().toISOString(),
    // A fixture manifest enumerates `trials`; a live manifest enumerates
    // `slots`. Both are the assigned set, and the header names which it read
    // rather than assuming one shape.
    assignedSetField: Array.isArray(manifest.trials) ? 'trials' : 'slots',
    expectedTrialCount: assignedSetOf(manifest).length,
    trialIds: assignedSetOf(manifest).map(trialIdFor),
    environment: {
      nodeVersion: process.version,
      platform: `${os.platform()}-${os.arch()}`
    },
    outputRoot
  };
  header.runHeaderHash = hashCanonical(header);
  return Object.freeze(header);
}

function assignedSetOf(manifest) {
  if (Array.isArray(manifest.trials)) return manifest.trials;
  if (Array.isArray(manifest.slots)) return manifest.slots;
  throw new ScoredRunnerError('the manifest enumerates neither trials nor slots');
}

// Stable per-trial identity, derived only from frozen manifest values.
function trialIdFor(trial) {
  return `${String(trial.repetition).padStart(2, '0')}-${String(trial.slot).padStart(3, '0')}` +
    `-${trial.cellId.replace('/', '_')}-${trial.armId}`;
}

function artifactPathFor(outputRoot, trial) {
  return path.join(outputRoot, 'trials', `${trialIdFor(trial)}.json`);
}

// ── Resume ──────────────────────────────────────────────────────────────────
//
// A 200-trial run may be interrupted operationally. Resume must never change
// what was frozen, and must never quietly replace a completed trial.
function classifyExistingArtifact(target, header) {
  if (!fs.existsSync(target)) return { state: 'absent' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    // A partial write is neither complete nor absent. It is refused rather
    // than re-run, because "recover or classify it" is a decision for an
    // operator, not something to paper over by overwriting.
    return { state: 'partial', reason: `unparseable artifact: ${error.message}` };
  }
  if (parsed.scoredRunHash !== header.runHeaderHash) {
    return {
      state: 'foreign',
      reason: `artifact belongs to scored run ${parsed.scoredRunHash}, not ` +
        header.runHeaderHash
    };
  }
  if (parsed.manifestHash !== header.manifestHash) {
    return { state: 'foreign', reason: 'artifact was produced under another manifest' };
  }
  if (parsed.sourceCommit !== header.repositoryCommit) {
    return { state: 'foreign', reason: 'artifact was produced from another source commit' };
  }
  return { state: 'complete', artifact: parsed };
}

// ── Execution ───────────────────────────────────────────────────────────────

// ── LIVE PRE-FLIGHT, WITH NO DISPATCH ───────────────────────────────────────
//
// A live manifest reaches the provider only through an explicitly authorized
// run. This path proves everything a live run needs — manifest validity, run
// header, credential PRESENCE without persisting it, remaining economic
// authority, the first slot and its request envelope — and then STOPS.
//
// It performs zero provider transport. That is asserted by construction: it
// never constructs a transport, and the dry run returns before any executor
// loop begins.
async function preflightLiveRun({
  manifestPath, outputRoot, resolvedLiveCredentialAuthority
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'live') {
    throw new ScoredRunnerError(
      'live pre-flight requires a live manifest; this one declares mode ' +
      `${manifest.mode}`, { mode: manifest.mode });
  }
  if (manifest.containsResults !== false) {
    throw new ScoredRunnerError('a manifest that carries results may not drive a run');
  }
  // CREDENTIAL AUTHORITY ONLY. Ambient OPENAI_API_KEY is deliberately ignored:
  // the explicitly selected configured-agent row is the durable authority.
  // Only its non-secret identity is written; the resolver's credential stays
  // on the in-memory authority object.
  const credentialAuthority = realLiveCredentialAuthorityIdentity(
    resolvedLiveCredentialAuthority);
  const credentialPresent = true;

  fs.mkdirSync(path.join(outputRoot, 'trials'), { recursive: true });
  const baseHeader = buildRunHeader({ manifest, manifestPath, outputRoot });
  const headerIdentity = {
    ...baseHeader, credentialPresent, credentialAuthority
  };
  delete headerIdentity.runHeaderHash;
  headerIdentity.runHeaderHash = hashCanonical(headerIdentity);
  const header = Object.freeze(headerIdentity);
  fs.writeFileSync(path.join(outputRoot, 'scored-run-header.json'),
    JSON.stringify(header, null, 2));

  // ── TRAVERSE TO THE REAL DISPATCH BOUNDARY ──────────────────────────
  //
  // The previous dry run stopped before a path that did not exist, which is why
  // it proved nothing. It now materializes trial 1, reserves its bounded
  // liability against the durable global ledger, and constructs the production
  // request envelope — everything except the final hop.
  const firstSlot = manifest.slots[0];
  const ledgerRoot = outputRoot;
  // THE WHOLE TRIAL, derived from the arm's Run topology and the two enforced
  // per-Run request ceilings. Reserving one request's worth — as this did — let
  // a trial that may issue ten requests pass a gate sized for one.
  const trialBound = trialWorstCaseMicroUsd({
    armId: firstSlot.armId,
    perRequestMicroUsd: manifest.economics.liability.perRequestMicroUsd,
    runtimeMaxModelRequestsPerRun:
      manifest.economics.liability.runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests,
    autoRetryEnabled: false,
    maxAttempts: null
  });
  const reservation = assertDispatchWithinGlobalCeiling({
    runRoot: ledgerRoot,
    ceilingMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
    maximumLiabilityMicroUsd: trialBound.trialWorstCaseMicroUsd,
    trialId: trialIdFor(firstSlot),
    role: firstSlot.armId === 'B' || firstSlot.armId === 'C'
      ? 'structured_planner' : 'ungoverned_worker',
    ordinal: 1
  });
  // A DRY RUN SPENDS NOTHING, so the reservation it took to prove the gate is
  // released again under the only proof that permits it: nothing was dispatched.
  releaseUndispatchedReservation({
    runRoot: ledgerRoot,
    reservationId: reservation.reservationId,
    proof: 'pre_delivery_refusal_no_provider_contact'
  });
  const envelope = {
    model: manifest.model,
    adapterId: manifest.adapterId,
    provider: manifest.provider,
    temperature: manifest.sampling.temperature,
    topP: manifest.sampling.topP,
    maxOutputTokens: manifest.maximumOutputTokensPerRequest,
    contextWindowTokens: manifest.contextWindowTokens,
    providerSeed: manifest.providerSeed,
    role: firstSlot.armId === 'B' || firstSlot.armId === 'C'
      ? 'structured_planner' : 'ungoverned_worker',
    cellKey: firstSlot.cellKey,
    repetition: firstSlot.repetition,
    slot: firstSlot.slot
  };
  return Object.freeze({
    dryRun: true,
    verdict: 'LIVE DRY RUN REACHED REAL PROVIDER DISPATCH BOUNDARY — 0 CALLS MADE',
    providerCallsMade: 0,
    credentialPresent,
    credentialAuthority,
    header,
    assignedTrials: manifest.slots.length,
    globalCeilingProved: true,
    reservationProved: reservation.reservationId,
    firstTrialWorstCaseMicroUsd: trialBound.trialWorstCaseMicroUsd,
    firstTrialProviderAttempts: trialBound.totalProviderAttempts,
    remainingEconomicAuthorityMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
    worstCaseMicroUsd: manifest.economics.computedWorstCaseMicroUsd,
    firstTrialEnvelope: Object.freeze(envelope),
    liveModeSelected: true,
    stoppedBefore: 'provider_dispatch'
  });
}


// ── THE LIVE MATRIX EXECUTOR ────────────────────────────────────────────────
//
// THE CAPABILITY THAT WAS MISSING. The repository could dispatch ONE live trial
// and could reach the dispatch boundary in a dry run, and a readiness audit
// mistook those for the ability to run the experiment. Nothing consumed the
// frozen manifest's 120 preassigned slots. This is that owner.
//
// It owns orchestration only — slot iteration, run identity, journal, resume,
// per-slot reservation, acceptance and exclusion. Product execution stays in
// `runTrial`, unchanged and un-duplicated: a second execution implementation
// would mean the live corpus was produced by a different path than the one
// proved.
//
// SLOTS ARE NEVER GENERATED. The order is the manifest's order, the seed is the
// manifest's seed, the arm is the manifest's arm. Nothing is chosen after a
// result is observed, which is the difference between an experiment and a
// search.
async function executeLiveRun({
  manifestPath, outputRoot, resume = false, limit = null,
  // REAL LIVE ONLY. This is the single configured-agent authority result used
  // by both authenticated preflight and every spawned production server.
  resolvedLiveCredentialAuthority = null,
  authenticatedPreflight = null,
  // TEST-ONLY. When set, the final network hop is replaced by the role-aware
  // capture and the run is permanently marked as NOT product evidence.
  syntheticTransportCapture = null,
  // Deterministic crash injection for the recovery proofs. Never set in a real
  // run; the executor refuses to treat an injected stop as an outcome.
  stopAfter = null
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'live') {
    throw new ScoredRunnerError(
      'the live matrix executor requires a live manifest; this one declares ' +
      `mode ${manifest.mode}`, { mode: manifest.mode });
  }
  if (manifest.containsResults !== false) {
    throw new ScoredRunnerError('a manifest that carries results may not drive a run');
  }
  assertRuntimeMatchesManifest(manifest, {
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    mode: manifest.mode,
    repetitions: manifest.repetitions,
    protocolSeed: manifest.protocolSeed,
    manifestHash: manifest.manifestHash
  });

  const syntheticAcceptance = Boolean(syntheticTransportCapture);
  if (syntheticAcceptance && resolvedLiveCredentialAuthority !== null) {
    throw new ScoredRunnerError(
      'synthetic acceptance must not receive real credential authority',
      { code: 'SYNTHETIC_ACCEPTANCE_REAL_CREDENTIAL_FORBIDDEN' });
  }
  const credentialAuthority = syntheticAcceptance
    ? null
    : realLiveCredentialAuthorityIdentity(resolvedLiveCredentialAuthority);

  fs.mkdirSync(path.join(outputRoot, 'trials'), { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'exclusions'), { recursive: true });

  // ── THE IMMUTABLE RUN IDENTITY ──────────────────────────────────────
  const headerPath = path.join(outputRoot, 'live-run-header.json');
  let header;
  if (fs.existsSync(headerPath)) {
    if (!resume) {
      throw new ScoredRunnerError(
        `${outputRoot} already holds a live-run header; pass resume to continue it, ` +
        'or choose a new empty directory. A live run is never restarted in place, ' +
        'because that would silently discard accepted slots.');
    }
    header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
    // REFUSE A SECOND CORPUS IN ONE DIRECTORY. Source, manifest and run header
    // must all be the ones this corpus began under.
    if (header.manifestHash !== manifest.manifestHash) {
      throw new ScoredRunnerError('refusing to resume: another manifest started this directory',
        { existing: header.manifestHash, supplied: manifest.manifestHash });
    }
    if (header.repositoryCommit !== repositoryCommit()) {
      throw new ScoredRunnerError('refusing to resume: the source commit has changed',
        { existing: header.repositoryCommit, current: repositoryCommit() });
    }
    const rebuilt = { ...header };
    delete rebuilt.runHeaderHash;
    if (hashCanonical(rebuilt) !== header.runHeaderHash) {
      throw new ScoredRunnerError('refusing to resume: the run header has been altered',
        { code: 'LIVE_RUN_HEADER_ALTERED' });
    }
    if (Boolean(header.syntheticAcceptance) !== Boolean(syntheticTransportCapture)) {
      throw new ScoredRunnerError(
        'refusing to resume: this directory was started under a different transport ' +
        'class; a synthetic acceptance corpus and a product corpus never mix');
    }
    if (header.syntheticAcceptance) {
      if (header.credentialAuthority !== null &&
          header.credentialAuthority !== undefined) {
        throw new ScoredRunnerError(
          'refusing to resume: a synthetic acceptance header carries real ' +
          'credential authority',
          { code: 'SYNTHETIC_ACCEPTANCE_AUTHORITY_BINDING_FORBIDDEN' });
      }
    } else if (!sameCredentialAuthority(
      header.credentialAuthority, credentialAuthority)) {
      throw new ScoredRunnerError(
        'refusing to resume: configured-agent credential authority changed',
        {
          code: 'REAL_LIVE_CREDENTIAL_AUTHORITY_CHANGED',
          existing: header.credentialAuthority,
          supplied: credentialAuthority
        });
    }
  } else {
    if (!syntheticAcceptance) {
      assertAuthenticatedPreflightAuthority({
        preflight: authenticatedPreflight,
        resolvedLiveCredentialAuthority,
        manifestHash: manifest.manifestHash
      });
    }
    const base = buildRunHeader({ manifest, manifestPath, outputRoot });
    const identity = {
      ...base,
      liveRunVersion: LIVE_RUN_VERSION,
      provider: manifest.provider,
      model: manifest.model,
      adapterId: manifest.adapterId,
      sampling: manifest.sampling,
      providerSeed: manifest.providerSeed,
      maximumOutputTokensPerRequest: manifest.maximumOutputTokensPerRequest,
      pricing: manifest.pricing,
      monetaryAuthorityVersion: 'canonical-integer-micro-usd/v1',
      hardDisqualifierVersion: manifest.hardDisqualifierVersion,
      fixtureSource: manifest.source,
      economics: {
        maximumTotalLiveMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
        canonicalMatrixMaximumMicroUsd: manifest.economics.computedWorstCaseMicroUsd,
        perRequestMicroUsd: manifest.economics.liability.perRequestMicroUsd
      },
      // Execution authority, not an experimental dimension. The persisted
      // secret and any secret-derived value are intentionally absent. A later
      // configured-agent edit increments this revision and makes resume refuse.
      credentialAuthority,
      // A synthetic run says so in its own identity, so nothing downstream has
      // to infer it from how the run was invoked.
      syntheticAcceptance,
      syntheticAcceptanceLabel: syntheticTransportCapture
        ? SYNTHETIC_ACCEPTANCE_LABEL : null
    };
    delete identity.runHeaderHash;
    identity.runHeaderHash = hashCanonical(identity);
    header = Object.freeze(identity);
    fs.writeFileSync(headerPath, JSON.stringify(header, null, 2));
  }

  const bind = { runHeaderHash: header.runHeaderHash, manifestHash: header.manifestHash };
  const alreadyAccepted = acceptedSlots(outputRoot);
  const assigned = manifest.slots;
  const plan = limit === null ? assigned : assigned.slice(0, limit);

  const liveBudget = {
    runRoot: outputRoot,
    ceilingMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
    perRequestMicroUsd: manifest.economics.liability.perRequestMicroUsd,
    runtimeMaxModelRequestsPerRun: manifest.economics.liability.runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests:
      ROLE_ECONOMICS.structured_leaf_executor.maximumProviderRequests,
    governedPlannerMaximumProviderRequests:
      ROLE_ECONOMICS.structured_planner.maximumProviderRequests
  };
  const controls = {
    temperature: manifest.sampling.temperature,
    topP: manifest.sampling.topP,
    maxOutputTokens: manifest.maximumOutputTokensPerRequest
  };

  let executed = 0;
  let reused = 0;
  let excluded = 0;
  let stopped = null;

  await withHarness('structured allocation live matrix run',
    async ({ store, workspaceRoot, startServer }) => {
      const namespaceRoot = path.join(outputRoot, 'namespaces');
      fs.mkdirSync(namespaceRoot, { recursive: true });

      for (const slot of plan) {
        const id = trialIdFor(slot);

        // ACCEPTED IS FOREVER. Neither a completed trial nor an accepted
        // exclusion is ever executed again or replaced.
        if (alreadyAccepted.has(id)) { reused += 1; continue; }

        const target = artifactPathFor(outputRoot, slot);
        const existing = classifyExistingArtifact(target, header);
        if (existing.state === 'partial' || existing.state === 'foreign') {
          throw new ScoredRunnerError(
            `refusing to proceed at ${id}: ${existing.reason}`, { trialId: id });
        }
        if (existing.state === 'complete') {
          // The artifact survived a crash before its acceptance was journalled.
          // Accept it rather than re-running: the provider was already paid.
          appendJournal(outputRoot, { ...bind, event: 'slot_accepted', trialId: id,
            slotOrdinal: slot.slot, recoveredArtifact: true });
          reused += 1;
          continue;
        }

        // ── RESERVE BEFORE ANYTHING CAN REACH THE PROVIDER ─────────────
        //
        // Derived from the slot's arm and the canonical contracts. A caller
        // cannot supply the amount: an executor that accepted an arbitrary
        // bound would be a gate sized by whoever called it.
        const bound = trialWorstCaseMicroUsd({
          armId: slot.armId,
          runtimeMaxModelRequestsPerRun: liveBudget.runtimeMaxModelRequestsPerRun,
          governedLeafMaximumProviderRequests:
            liveBudget.governedLeafMaximumProviderRequests,
          governedPlannerMaximumProviderRequests:
            liveBudget.governedPlannerMaximumProviderRequests,
          autoRetryEnabled: false, maxAttempts: null
        });
        assertDispatchWithinGlobalCeiling({
          runRoot: outputRoot,
          ceilingMicroUsd: liveBudget.ceilingMicroUsd,
          maximumLiabilityMicroUsd: bound.trialWorstCaseMicroUsd,
          trialId: id, role: `trial_worst_case:${slot.armId}`, ordinal: slot.slot
        });
        appendJournal(outputRoot, { ...bind, event: 'reservation_committed', trialId: id,
          slotOrdinal: slot.slot, reservedMicroUsd: bound.trialWorstCaseMicroUsd });
        if (stopAfter && stopAfter.event === 'reservation_committed' &&
            stopAfter.trialId === id) { stopped = stopAfter; break; }

        appendJournal(outputRoot, { ...bind, event: 'trial_started', trialId: id,
          slotOrdinal: slot.slot });
        if (stopAfter && stopAfter.event === 'trial_started' &&
            stopAfter.trialId === id) { stopped = stopAfter; break; }

        let artifact = null;
        let failure = null;
        try {
          artifact = await runTrial({
            store, startServer, workspaceRoot,
            scenario: getScenario(slot.scenarioId),
            arm: ARMS[slot.armId],
            variant: slot.variantId,
            repetition: slot.repetition,
            // THE FROZEN PER-SLOT IDENTITY. A live slot carries no provider
            // seed — the contract owns no seed field — so the manifest's
            // `stochasticIdentity` is the frozen value that identifies this
            // slot's request tuple. It is read, never generated, and never
            // chosen after a result is observed.
            seed: slot.stochasticIdentity,
            outputPath: target,
            commit: header.repositoryCommit,
            smokeRoot: outputRoot,
            namespaceRoot,
            mode: 'live',
            resolvedLiveCredentialAuthority,
            liveRequestControls: controls,
            liveTransportCapture: syntheticTransportCapture
              ? path.join(syntheticTransportCapture, `${id}.jsonl`) : null,
            liveBudget,
            // The reservation is already committed for this slot; runTrial must
            // not take a second one.
            liveReservationAlreadyCommitted: true,
            scoredIdentity: {
              label: header.syntheticAcceptance
                ? SYNTHETIC_ACCEPTANCE_LABEL : SCORED_ARTIFACT_LABEL,
              scoredRunHash: header.runHeaderHash,
              manifestHash: header.manifestHash,
              trialSlot: slot.slot,
              trialId: id
            }
          });
        } catch (error) { failure = error; }

        appendJournal(outputRoot, { ...bind, event: 'product_terminal_or_stable',
          trialId: id, slotOrdinal: slot.slot, harnessError: failure ? true : false });

        if (failure) {
          // ── THE FROZEN PREDICATE DECIDES, NOT THE EXECUTOR ───────────
          const classified = classifyLiveFailure({
            httpStatus: failure.httpStatus || null,
            errorCode: failure.code || null,
            requestDelivered: failure.requestDelivered ?? null,
            modelResultObserved: failure.modelResultObserved === true,
            phase: failure.phase || null
          });
          if (classified.classification === 'run_fatal_configuration') {
            // Not 120 exclusions from one mistake.
            throw new ScoredRunnerError(
              `RUN-LEVEL FATAL CONFIGURATION FAILURE at ${id}: ${classified.reason}`,
              { trialId: id, classification: classified.classification });
          }
          if (classified.classification === 'infrastructure_exclusion') {
            const exclusion = buildExclusionArtifact({
              label: header.syntheticAcceptance
                ? SYNTHETIC_ACCEPTANCE_LABEL : SCORED_ARTIFACT_LABEL,
              trialId: id, header, slot, classified
            });
            fs.writeFileSync(path.join(outputRoot, 'exclusions', `${id}.json`),
              JSON.stringify(exclusion, null, 2));
            appendJournal(outputRoot, { ...bind, event: 'infrastructure_excluded',
              trialId: id, slotOrdinal: slot.slot, reason: classified.reason });
            excluded += 1;
            continue;
          }
          // PRODUCT DATA. A bad outcome is evidence, not an exclusion — but a
          // trial that produced no artifact at all cannot be evidence either.
          throw new ScoredRunnerError(
            `trial ${id} produced no artifact and was not an infrastructure ` +
            `failure: ${failure.message}`, { trialId: id });
        }

        appendJournal(outputRoot, { ...bind, event: 'artifact_committed', trialId: id,
          slotOrdinal: slot.slot });
        if (stopAfter && stopAfter.event === 'artifact_committed' &&
            stopAfter.trialId === id) { stopped = stopAfter; break; }

        appendJournal(outputRoot, { ...bind, event: 'slot_accepted', trialId: id,
          slotOrdinal: slot.slot,
          oracleVerdict: artifact && artifact.oracleResult
            ? artifact.oracleResult.verdict : null });
        executed += 1;
        if (stopAfter && stopAfter.event === 'slot_accepted' &&
            stopAfter.trialId === id) { stopped = stopAfter; break; }
      }
    }, { timeoutMs: 12 * 60 * 60 * 1000 });

  const acceptedNow = acceptedSlots(outputRoot);
  const complete = assigned.every(slot => acceptedNow.has(trialIdFor(slot)));
  appendJournal(outputRoot, { ...bind,
    event: complete ? 'run_complete' : 'run_paused',
    trialId: null, slotOrdinal: null,
    acceptedCount: acceptedNow.size, assignedCount: assigned.length });

  return Object.freeze({
    header, executed, reused, excluded,
    assigned: assigned.length,
    accepted: acceptedNow.size,
    complete,
    stoppedAfter: stopped,
    syntheticAcceptance: header.syntheticAcceptance === true
  });
}

// ── AUTHORIZED REAL-LIVE OWNER ─────────────────────────────────────────────
//
// Resolves one explicit configured-agent row ONCE. The resulting in-memory
// object feeds both the authenticated preflight and the child-server
// projection. Identity equality alone is insufficient here: the preflight
// proof carries a private reference to this exact authority object, and
// executeLiveRun mechanically checks it before writing a real run header.
async function executeAuthorizedLiveRun({
  manifestPath, outputRoot, credentialAuthority, authorityStore,
  resume = false, limit = null, preflightTransport = undefined,
  preflightOutputPath = `${outputRoot}.authenticated-preflight.json`
}) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'live') {
    throw new ScoredRunnerError(
      'authorized live execution requires a live manifest',
      { code: 'REAL_LIVE_MANIFEST_REQUIRED' });
  }
  const resolvedLiveCredentialAuthority =
    await resolveRealLiveCredentialAuthority({
      store: authorityStore,
      credentialAuthority,
      expectedProvider: manifest.provider
    });

  if (resume) {
    // No second preflight and no second corpus. The existing run header is the
    // durable identity; executeLiveRun compares its configured-agent id and
    // revision to the freshly resolved row before touching any remaining slot.
    return executeLiveRun({
      manifestPath, outputRoot, resume: true, limit,
      resolvedLiveCredentialAuthority
    });
  }

  if ((fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0) ||
      fs.existsSync(path.join(outputRoot, 'live-run-header.json')) ||
      fs.existsSync(preflightOutputPath)) {
    throw new ScoredRunnerError(
      'real live output or authenticated-preflight evidence already exists; ' +
      'choose a fresh output root or explicitly resume the existing corpus',
      { code: 'REAL_LIVE_OUTPUT_NOT_FRESH' });
  }

  const authenticatedPreflight = await authenticatedRealLivePreflight({
    manifest,
    resolvedLiveCredentialAuthority,
    ...(preflightTransport === undefined ? {} : { transport: preflightTransport })
  });
  fs.mkdirSync(path.dirname(preflightOutputPath), { recursive: true });
  fs.writeFileSync(preflightOutputPath,
    `${JSON.stringify(authenticatedPreflight, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 });

  const result = await executeLiveRun({
    manifestPath, outputRoot, resume: false, limit,
    resolvedLiveCredentialAuthority,
    authenticatedPreflight
  });
  return Object.freeze({
    ...result,
    authenticatedPreflight,
    authenticatedPreflightPath: preflightOutputPath
  });
}

async function executeScoredRun({ manifestPath, outputRoot, resume = false, limit = null }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // A LIVE manifest may never reach the fixture execution loop, and the fixture
  // executor may never dispatch a live trial. The two corpora are separate
  // evidence classes and their executors do not share a run path.
  if (manifest.mode === 'live') {
    throw new ScoredRunnerError(
      'this executor runs fixture trials; a live manifest requires the ' +
      'authorized live run and is refused here', { mode: manifest.mode });
  }

  // THE GATE. Runtime inputs that differ from the frozen manifest refuse before
  // a single trial runs.
  assertRuntimeMatchesManifest(manifest, {
    protocolId: manifest.protocolId,
    protocolVersion: manifest.protocolVersion,
    mode: manifest.mode,
    repetitions: manifest.repetitions,
    protocolSeed: manifest.protocolSeed,
    manifestHash: manifest.manifestHash
  });

  fs.mkdirSync(path.join(outputRoot, 'trials'), { recursive: true });
  const headerPath = path.join(outputRoot, 'scored-run-header.json');
  let header;
  if (fs.existsSync(headerPath)) {
    if (!resume) {
      throw new ScoredRunnerError(
        `${outputRoot} already holds a scored-run header; pass --resume to continue ` +
        'it, or choose a new empty directory. A scored run is never restarted in ' +
        'place, because that would silently discard completed trials.');
    }
    header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
    if (header.manifestHash !== manifest.manifestHash) {
      throw new ScoredRunnerError(
        'refusing to resume: this directory was started under a different manifest',
        { existing: header.manifestHash, supplied: manifest.manifestHash });
    }
  } else {
    header = buildRunHeader({ manifest, manifestPath, outputRoot });
    fs.writeFileSync(headerPath, JSON.stringify(header, null, 2));
  }

  const seenTrialIds = new Set();
  for (const trial of manifest.trials) {
    const id = trialIdFor(trial);
    if (seenTrialIds.has(id)) {
      throw new ScoredRunnerError(`duplicate trial id in the manifest: ${id}`);
    }
    seenTrialIds.add(id);
  }

  const journalPath = path.join(outputRoot, 'scored-run-journal.jsonl');
  const plan = limit ? manifest.trials.slice(0, limit) : manifest.trials;
  let executed = 0;
  let reused = 0;

  await withHarness('structured allocation scored fixture run',
    async ({ store, workspaceRoot, startServer }) => {
      const namespaceRoot = path.join(outputRoot, 'namespaces');
      fs.mkdirSync(namespaceRoot, { recursive: true });

      for (const trial of plan) {
        const id = trialIdFor(trial);
        const target = artifactPathFor(outputRoot, trial);
        const existing = classifyExistingArtifact(target, header);

        if (existing.state === 'complete') {
          // NEVER re-run and never replaced.
          reused += 1;
          continue;
        }
        if (existing.state === 'partial' || existing.state === 'foreign') {
          throw new ScoredRunnerError(
            `refusing to proceed at ${id}: ${existing.reason}`, { trialId: id });
        }

        const startedAt = Date.now();
        let artifact = null;
        let failure = null;
        try {
          artifact = await runTrial({
            store, startServer, workspaceRoot,
            scenario: getScenario(trial.scenarioId),
            arm: ARMS[trial.armId],
            variant: trial.variantId,
            // FROZEN VALUES, read straight from the manifest.
            repetition: trial.repetition,
            seed: trial.seed,
            outputPath: target,
            commit: header.repositoryCommit,
            smokeRoot: outputRoot,
            namespaceRoot,
            scoredIdentity: {
              label: SCORED_ARTIFACT_LABEL,
              scoredRunHash: header.runHeaderHash,
              manifestHash: header.manifestHash,
              trialSlot: trial.slot,
              trialId: id
            }
          });
        } catch (error) { failure = error; }

        // A PRODUCT FAILURE IS DATA. Only an infrastructure failure — judged by
        // the frozen predicate — may remove a trial from the corpus, and even
        // then the slot is recorded rather than silently dropped.
        const journalEntry = {
          trialId: id,
          slot: trial.slot,
          repetition: trial.repetition,
          cellId: trial.cellId,
          armId: trial.armId,
          seed: trial.seed,
          durationMs: Date.now() - startedAt,
          outcome: failure ? 'harness_error' : 'artifact_written',
          harnessError: failure ? String(failure.message).slice(0, 400) : null,
          at: new Date().toISOString()
        };
        fs.appendFileSync(journalPath, `${JSON.stringify(journalEntry)}\n`);
        if (failure) {
          throw new ScoredRunnerError(
            `trial ${id} could not be observed at all: ${failure.message}`,
            { trialId: id });
        }
        executed += 1;
        if (process.env.SCORED_RUNNER_VERBOSE === '1') {
          console.log(`  ${id} → ${artifact.oracleResult.verdict} ` +
            `(${journalEntry.durationMs}ms)`);
        }
      }
    }, { timeoutMs: 12 * 60 * 60 * 1000 });

  return Object.freeze({ header, executed, reused, planned: plan.length });
}

const LIVE_RUN_VERSION = 2;

module.exports = {
  LIVE_RUN_VERSION,
  assignedSetOf,
  auditLiveCorpus,
  assertScorableLiveCorpus,
  executeAuthorizedLiveRun,
  executeLiveRun,
  readJournal,
  preflightLiveRun,
  FROZEN_EXPERIMENTAL_OPTIONS,
  OPERATIONAL_OPTIONS,
  SCORED_ARTIFACT_LABEL,
  SCORED_RUNNER_VERSION,
  ScoredRunnerError,
  artifactPathFor,
  buildRunHeader,
  classifyExistingArtifact,
  executeScoredRun,
  parseArguments,
  trialIdFor
};

async function runMain() {
  const options = parseArguments(process.argv.slice(2));
  if (options.verbose) process.env.SCORED_RUNNER_VERBOSE = '1';
  const manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8'));
  const limit = options.limit === undefined ? null : Number(options.limit);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new ScoredRunnerError('--limit must be a non-negative integer');
  }

  // A branch rather than an early return: the repository's syntax gate parses
  // every file as a script, where a top-level `return` is illegal.
  if (options['dry-run']) {
    if (manifest.mode !== 'live') {
      throw new ScoredRunnerError('--dry-run requires a live manifest');
    }
  }

  if (manifest.mode === 'live') {
    const configuredAgentId = Number(options['credential-agent-id']);
    if (!Number.isSafeInteger(configuredAgentId) || configuredAgentId <= 0) {
      throw new ScoredRunnerError(
        'REAL live execution requires --credential-agent-id with a positive id');
    }
    if (!process.env.DATABASE_URL) {
      throw new ScoredRunnerError(
        'DATABASE_URL is required to resolve the explicit configured-agent authority');
    }
    const authorityStore = new PostgresRuntimeStore({
      connectionString: process.env.DATABASE_URL,
      schema: process.env.POSTGRES_SCHEMA || 'ticket_system'
    });
    try {
      const selection = {
        kind: 'configured_agent', configuredAgentId
      };
      if (options['dry-run']) {
        const resolved = await resolveRealLiveCredentialAuthority({
          store: authorityStore,
          credentialAuthority: selection,
          expectedProvider: manifest.provider
        });
        const result = await preflightLiveRun({
          manifestPath: options.manifest,
          outputRoot: options['output-root'],
          resolvedLiveCredentialAuthority: resolved
        });
        console.log(result.verdict);
        console.log(`credential authority: configured agent ${configuredAgentId}, ` +
          `revision ${result.credentialAuthority.configuredAgentRevision}`);
        console.log(`assigned trials: ${result.assignedTrials}`);
        console.log(`stopped before: ${result.stoppedBefore}`);
        console.log(`run header: ${result.header.runHeaderHash}`);
      } else {
        if (!process.env.TEST_DATABASE_URL) {
          throw new ScoredRunnerError(
            'TEST_DATABASE_URL is required for isolated evaluation trial state');
        }
        const result = await executeAuthorizedLiveRun({
          manifestPath: options.manifest,
          outputRoot: options['output-root'],
          credentialAuthority: selection,
          authorityStore,
          resume: Boolean(options.resume),
          limit
        });
        console.log(`live run: ${result.executed} executed, ${result.reused} reused, ` +
          `${result.accepted}/${result.assigned} accepted`);
        console.log(`run header: ${result.header.runHeaderHash}`);
      }
    } finally {
      await authorityStore.close();
    }
  } else {
    if (options['credential-agent-id'] !== undefined) {
      throw new ScoredRunnerError(
        '--credential-agent-id is valid only for REAL live execution');
    }
    const result = await executeScoredRun({
      manifestPath: options.manifest,
      outputRoot: options['output-root'],
      resume: Boolean(options.resume),
      limit
    });
    console.log(`scored run complete: ${result.executed} executed, ` +
      `${result.reused} reused, ${result.planned} planned`);
    console.log(`run header: ${result.header.runHeaderHash}`);
  }
}

if (require.main === module) {
  runMain().catch(error => { console.error(error); process.exit(1); });
}
