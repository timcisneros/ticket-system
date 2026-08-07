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
const { withHarness } = require('./postgres-test-harness');

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
  'manifest', 'output-root', 'resume', 'verbose', 'limit', 'dry-run'
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
async function preflightLiveRun({ manifestPath, outputRoot }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.mode !== 'live') {
    throw new ScoredRunnerError(
      'live pre-flight requires a live manifest; this one declares mode ' +
      `${manifest.mode}`, { mode: manifest.mode });
  }
  if (manifest.containsResults !== false) {
    throw new ScoredRunnerError('a manifest that carries results may not drive a run');
  }
  // CREDENTIAL PRESENCE ONLY. The value is never read into a variable that is
  // returned, logged, hashed or written.
  const credentialPresent = typeof process.env.OPENAI_API_KEY === 'string' &&
    process.env.OPENAI_API_KEY.length > 0;

  fs.mkdirSync(path.join(outputRoot, 'trials'), { recursive: true });
  // The header is frozen by its builder, so presence is recorded beside it
  // rather than mutated into it — and it is a BOOLEAN, never the value.
  const baseHeader = buildRunHeader({ manifest, manifestPath, outputRoot });
  const header = Object.freeze({ ...baseHeader, credentialPresent });
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
  const perRequestMicroUsd = manifest.economics.liability.perRequestMicroUsd;
  const reservation = assertDispatchWithinGlobalCeiling({
    runRoot: ledgerRoot,
    ceilingMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
    maximumLiabilityMicroUsd: perRequestMicroUsd,
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
    header,
    assignedTrials: manifest.slots.length,
    globalCeilingProved: true,
    reservationProved: reservation.reservationId,
    remainingEconomicAuthorityMicroUsd: manifest.economics.maximumTotalLiveMicroUsd,
    worstCaseMicroUsd: manifest.economics.computedWorstCaseMicroUsd,
    firstTrialEnvelope: Object.freeze(envelope),
    liveModeSelected: true,
    stoppedBefore: 'provider_dispatch'
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

module.exports = {
  assignedSetOf,
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

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2));
  if (options.verbose) process.env.SCORED_RUNNER_VERBOSE = '1';
  // A branch rather than an early return: the repository's syntax gate parses
  // every file as a script, where a top-level `return` is illegal.
  if (options['dry-run']) {
    preflightLiveRun({
      manifestPath: options.manifest, outputRoot: options['output-root']
    }).then(result => {
      console.log(result.verdict);
      console.log(`credential present: ${result.credentialPresent}`);
      console.log(`assigned trials: ${result.assignedTrials}`);
      console.log(`stopped before: ${result.stoppedBefore}`);
      console.log(`run header: ${result.header.runHeaderHash}`);
    }).catch(error => { console.error(error); process.exit(1); });
  } else {
    executeScoredRun({
      manifestPath: options.manifest,
      outputRoot: options['output-root'],
      resume: Boolean(options.resume),
      limit: options.limit ? Number(options.limit) : null
    }).then(result => {
      console.log(`scored run complete: ${result.executed} executed, ` +
        `${result.reused} reused, ${result.planned} planned`);
      console.log(`run header: ${result.header.runHeaderHash}`);
    }).catch(error => { console.error(error); process.exit(1); });
  }
}
