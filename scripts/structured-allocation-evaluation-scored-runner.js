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
  'manifest', 'output-root', 'resume', 'verbose', 'limit'
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
    if (key === 'resume' || key === 'verbose') { parsed[key] = true; continue; }
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
    expectedTrialCount: manifest.trials.length,
    trialIds: manifest.trials.map(trialIdFor),
    environment: {
      nodeVersion: process.version,
      platform: `${os.platform()}-${os.arch()}`
    },
    outputRoot
  };
  header.runHeaderHash = hashCanonical(header);
  return Object.freeze(header);
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

async function executeScoredRun({ manifestPath, outputRoot, resume = false, limit = null }) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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
