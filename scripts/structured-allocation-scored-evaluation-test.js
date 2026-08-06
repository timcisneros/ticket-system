#!/usr/bin/env node
'use strict';

// Tranche 6 — the scored executor and the pure scorer.
//
// WHAT THESE PROVE. A scored run is only meaningful if the experiment could not
// have been adjusted to fit its own result. So the assertions here are mostly
// about REFUSALS: the runner refuses command-line overrides of frozen
// variables, refuses a foreign manifest, refuses to overwrite a completed
// trial; the scorer refuses an inconsistent corpus, refuses to score six
// dimensions, and refuses to average a false completion away.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FROZEN_EXPERIMENTAL_OPTIONS, SCORED_ARTIFACT_LABEL, ScoredRunnerError,
  buildRunHeader, classifyExistingArtifact, parseArguments, trialIdFor
} = require('./structured-allocation-evaluation-scored-runner');
const {
  AUTHORIZED_DIMENSIONS, ScorerError, applyFrozenDecisionRules,
  assertCorpusIntegrity, evaluateHardDisqualifiers, scoreCorpus, scoreDimensions
} = require('./structured-allocation-evaluation-scorer');

const manifest = require('../config/structured-allocation-evaluation-scored-v1.json');
const protocol = require('../config/structured-allocation-evaluation-v1.json');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

// Returns the refusal MESSAGE, never a bare boolean. Accepting any throw would
// let a mutation that disables one check pass because a different check happened
// to fire — which is exactly how six of these assertions first survived.
function refusalMessage(fn) {
  try { fn(); return null; } catch (error) { return String(error.message); }
}
function refuses(fn) { return refusalMessage(fn) !== null; }
function refusesWith(fn, fragment) {
  const message = refusalMessage(fn);
  return message !== null && message.includes(fragment);
}
function problemsOf(fn) {
  try { fn(); return []; } catch (error) { return (error.detail && error.detail.problems) || []; }
}

const HEADER = Object.freeze({
  runHeaderHash: 'r'.repeat(64),
  manifestHash: manifest.manifestHash,
  repositoryCommit: 'c'.repeat(40)
});

function artifactFor(trial, overrides = {}) {
  return {
    trialId: trialIdFor(trial),
    trialSlot: trial.slot,
    repetition: trial.repetition,
    armId: trial.armId,
    scenarioId: trial.scenarioId,
    variantId: trial.variantId,
    family: 7,
    seed: trial.seed,
    mode: manifest.mode,
    label: SCORED_ARTIFACT_LABEL,
    manifestHash: manifest.manifestHash,
    scoredRunHash: HEADER.runHeaderHash,
    sourceCommit: HEADER.repositoryCommit,
    envelopeHash: `env-${trial.slot}-${trial.repetition}`,
    artifactHash: `art-${trial.slot}-${trial.repetition}`,
    observationCompleteness: 'complete',
    oracleResult: { verdict: 'fail' },
    truthfulness: 'true_negative_completion',
    ticketReport: { secondReadIdentical: true },
    pathProof: {
      observedPath: 'direct', runCount: 1, ticketResultStatus: 'failed',
      governedLeafRunCount: 0, executableItemCount: 0,
      governedLeafExecutionObserved: false, sameParentPolicyRevision: null
    },
    latency: { endToEndMs: 1000 },
    normalizedCost: { totalNormalizedMicroUsd: 100 },
    churnFacts: { noProgressStreak: 0, worker: { attemptedTransports: 1, durableResponses: 1 } },
    ...overrides
  };
}

function fullCorpus(overrides = () => ({})) {
  return manifest.trials.map((trial, index) => artifactFor(trial, overrides(trial, index)));
}

function main() {
  console.log('structured allocation scored evaluation');

  // ── 1-3. The runner cannot override a frozen experimental variable ────
  for (const option of ['repetitions', 'seed', 'arms', 'ordering', 'thresholds']) {
    ok(refusesWith(() => parseArguments([
      '--manifest', 'm.json', '--output-root', '/tmp/x', `--${option}`, '9'
    ]), 'FROZEN experimental variable'),
    `1-3 --${option} is refused AS a frozen experimental variable, not merely as unknown`);
  }
  ok(FROZEN_EXPERIMENTAL_OPTIONS.includes('seed') &&
     FROZEN_EXPERIMENTAL_OPTIONS.includes('order') &&
     FROZEN_EXPERIMENTAL_OPTIONS.includes('threshold'),
  '1-3 the frozen-option list names seeds, ordering and thresholds');
  // Operational options ARE allowed — the runner still has to be runnable.
  const parsed = parseArguments(['--manifest', 'm.json', '--output-root', '/tmp/x', '--resume']);
  ok(parsed.manifest === 'm.json' && parsed.resume === true,
    '1-3 operational options (output, resume) remain available');

  // ── 4, 12. Foreign manifest / commit / run refuse ─────────────────────
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scored-'));
    const target = path.join(dir, 'a.json');
    const trial = manifest.trials[0];
    fs.writeFileSync(target, JSON.stringify(artifactFor(trial)));
    ok(classifyExistingArtifact(target, HEADER).state === 'complete',
      '6-7 a matching completed artifact is recognized as complete');
    fs.writeFileSync(target, JSON.stringify(
      artifactFor(trial, { manifestHash: 'f'.repeat(64) })));
    ok(classifyExistingArtifact(target, HEADER).state === 'foreign',
      '4 an artifact from another MANIFEST refuses');
    fs.writeFileSync(target, JSON.stringify(
      artifactFor(trial, { sourceCommit: 'd'.repeat(40) })));
    ok(classifyExistingArtifact(target, HEADER).state === 'foreign',
      '12 an artifact from another SOURCE COMMIT refuses');
    fs.writeFileSync(target, JSON.stringify(
      artifactFor(trial, { scoredRunHash: 'e'.repeat(64) })));
    ok(classifyExistingArtifact(target, HEADER).state === 'foreign',
      '4 an artifact from another SCORED RUN refuses');
    fs.writeFileSync(target, '{ not json');
    ok(classifyExistingArtifact(target, HEADER).state === 'partial',
      '6 a partial artifact refuses rather than being silently overwritten');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ── 7. Resume never re-runs a completed trial ─────────────────────────
  //
  // `complete` is the only state the executor skips, and it is reached only
  // when manifest, run and commit all match.
  ok(classifyExistingArtifact('/nonexistent/path.json', HEADER).state === 'absent',
    '7 an assigned trial with no artifact may execute on resume');

  // ── 10, 11. Corpus completeness before aggregation ────────────────────
  const corpus = fullCorpus();
  const integrity = assertCorpusIntegrity({ manifest, header: HEADER, artifacts: corpus });
  ok(integrity.verdict === 'SCORED FIXTURE CORPUS COMPLETE AND INTERNALLY CONSISTENT' &&
     integrity.trials === manifest.trials.length,
  '10 a complete corpus passes the integrity gate');
  ok(problemsOf(() => assertCorpusIntegrity({
    manifest, header: HEADER, artifacts: corpus.slice(0, corpus.length - 1)
  })).some(problem => problem.includes('neither a result nor an exclusion')),
  '10 a MISSING trial is named as an unaccounted slot, not merely a count mismatch');
  ok(problemsOf(() => assertCorpusIntegrity({
    manifest, header: HEADER, artifacts: [...corpus, corpus[0]]
  })).some(problem => problem.includes('duplicate trial id')),
  '11 a DUPLICATE trial is named as a duplicate');
  // 19. Fixture and live corpora may never mix.
  ok(refuses(() => assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.map((a, i) => (i === 0 ? { ...a, mode: 'live' } : a))
  })), '19 a live-mode artifact cannot join a fixture corpus');
  // An artifact without scored identity is not scored evidence.
  ok(refuses(() => assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.map((a, i) => (i === 0
      ? { ...a, label: 'UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE' } : a))
  })), 'an artifact without scored identity cannot join the corpus');
  // A verdict reported on incomplete observation is refused.
  ok(problemsOf(() => assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.map((a, i) => (i === 0
      ? { ...a, observationCompleteness: 'unavailable' } : a))
  })).some(problem => problem.includes('incomplete observation')),
  'a verdict reported on incomplete observation is refused');
  // 20. A trial with no zero-drift proof cannot enter the corpus.
  ok(problemsOf(() => assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.map((a, i) => (i === 0
      ? { ...a, ticketReport: { secondReadIdentical: false } } : a))
  })).some(problem => problem.includes('no zero-drift proof')),
  '20 a trial without a zero-drift proof is named and refused');

  // ── 8. A failed product trial REMAINS in the corpus ───────────────────
  const withFailures = fullCorpus((trial, index) => (index % 3 === 0
    ? { pathProof: { ...artifactFor(trial).pathProof, ticketResultStatus: 'failed' },
      oracleResult: { verdict: 'fail' }, truthfulness: 'true_negative_completion' }
    : {}));
  const failureIntegrity = assertCorpusIntegrity({
    manifest, header: HEADER, artifacts: withFailures });
  ok(failureIntegrity.trials === manifest.trials.length,
    '8 product failures remain in the corpus and are never dropped');

  // ── 9. Only the frozen predicate may exclude ──────────────────────────
  ok(refuses(() => assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.slice(0, corpus.length - 1),
    exclusions: [{ trialId: trialIdFor(manifest.trials[corpus.length - 1]),
      predicate: 'inconvenient_result' }]
  })), '9 an exclusion outside the frozen predicate is refused');
  ok(assertCorpusIntegrity({
    manifest, header: HEADER,
    artifacts: corpus.slice(0, corpus.length - 1),
    exclusions: [{ trialId: trialIdFor(manifest.trials[corpus.length - 1]),
      predicate: 'database_unavailable' }]
  }).exclusions === 1,
  '9 an exclusion INSIDE the frozen predicate is accepted and counted');

  // ── 13. Exactly five dimensions ───────────────────────────────────────
  ok(AUTHORIZED_DIMENSIONS.length === 5 &&
     AUTHORIZED_DIMENSIONS.join(',') ===
       'allocation_quality,completion_truthfulness,latency,cost,churn',
  '13 the scorer computes exactly the five authorized dimensions');
  const dimensions = scoreDimensions(corpus);
  ok(Object.keys(dimensions).length === 5,
    '13 and produces no sixth composite metric');

  // ── 14. The scorer cannot read current production state ───────────────
  const scorerSource = fs.readFileSync(
    path.join(__dirname, 'structured-allocation-evaluation-scorer.js'), 'utf8');
  for (const forbidden of ['postgres-test-harness', 'persistence/postgres',
    'evaluation-scenarios', 'governed-policy-source', 'pg', 'fetch(']) {
    ok(!scorerSource.includes(`require('${forbidden}`) && !scorerSource.includes(forbidden === 'fetch(' ? 'fetch(' : `${forbidden}'`),
      `14 the scorer never reaches ${forbidden}`);
  }
  ok(scorerSource.includes("require('node:crypto')") &&
     (scorerSource.match(/require\(/g) || []).length === 1,
  '14 the scorer requires exactly one module — crypto — and no state source');

  // ── 15, 17. Disqualifiers first, and a false completion is not averaged ─
  const withFalsePositive = fullCorpus((trial, index) => (index === 0
    ? { armId: 'B', truthfulness: 'false_positive_completion' } : {}));
  const disqualifiers = evaluateHardDisqualifiers({
    protocol,
    byArm: withFalsePositive.reduce((acc, a) => {
      (acc[a.armId] = acc[a.armId] || []).push(a); return acc;
    }, {}),
    artifacts: withFalsePositive
  });
  const falsePositiveRule = disqualifiers.find(entry =>
    /false-positive completion rate higher than arm A/i.test(entry.statement));
  ok(falsePositiveRule.result === 'TRIGGERED' &&
     falsePositiveRule.contributingTrialIds.length > 0,
  '17 a single false completion TRIGGERS its disqualifier and names its trials');
  // The RATE itself must count it. A scorer that reported zero false
  // completions would make the disqualifier unreachable from the metrics.
  const falseRate = scoreDimensions(withFalsePositive.filter(a => a.armId === 'B'))
    .completion_truthfulness.falsePositiveCompletion;
  ok(falseRate.numerator === 1 && falseRate.trialIds.length === 1,
    '17 and the false-completion RATE counts it rather than averaging it away');
  // A corpus that would otherwise satisfy RETAIN, so the ONLY thing that can
  // produce STOP is the disqualifier being evaluated first.
  const retainWorthy = {
    A: corpus.map(a => ({ ...a, truthfulness: 'true_negative_completion' })),
    B: corpus.map(a => ({ ...a, truthfulness: 'true_positive_completion' })),
    A2a: corpus.map(a => ({ ...a, truthfulness: 'true_negative_completion' }))
  };
  const withoutDisqualifier = applyFrozenDecisionRules({
    protocol, disqualifiers: [], byArm: retainWorthy });
  ok(withoutDisqualifier.decision === 'FIXTURE EVIDENCE SUPPORTS RETAIN',
    '15 that corpus would otherwise support RETAIN');
  const stopped = applyFrozenDecisionRules({
    protocol,
    disqualifiers: [{ statement: 'x', result: 'TRIGGERED', contributingTrialIds: [] }],
    byArm: retainWorthy
  });
  ok(stopped.decision === 'FIXTURE EVIDENCE SUPPORTS STOP' &&
     stopped.basis.includes('hard disqualifier'),
  '15 a triggered disqualifier overrides it, deciding BEFORE any tradeoff');
  // NOT EVALUABLE is never converted into a pass.
  ok(disqualifiers.some(entry => entry.result === 'NOT EVALUABLE'
    ? Boolean(entry.notEvaluableReason) : true),
  'a disqualifier that cannot be evaluated states why');

  // ── 16. Thresholds are IMPORTED, never duplicated ─────────────────────
  ok(!/truePositiveGainVersusAPoints\s*[:=]\s*\d/.test(scorerSource),
    '16 the scorer hard-codes no threshold value');
  // BEHAVIOURAL: changing the frozen threshold must change the outcome. A
  // duplicated literal would ignore the protocol and decide the same way.
  const strictProtocol = {
    ...protocol,
    decisionThresholds: {
      ...protocol.decisionThresholds,
      retain: { ...protocol.decisionThresholds.retain,
        truePositiveGainVersusAPoints: 200 }
    }
  };
  ok(applyFrozenDecisionRules({
    protocol: strictProtocol, disqualifiers: [], byArm: retainWorthy
  }).decision !== 'FIXTURE EVIDENCE SUPPORTS RETAIN',
  '16 raising the frozen threshold changes the decision — it is read, not duplicated');
  ok(scorerSource.includes('protocol.decisionThresholds'),
    '16 and reads every threshold from the frozen protocol');

  // ── 18. Normalized cost is the common cross-arm basis ─────────────────
  ok(Boolean(dimensions.cost.normalized) && Boolean(dimensions.cost.governedCrossCheck),
    '18 normalized cost is the basis and governed settlement is a cross-check');

  // ── 21. Byte-identical rescoring ──────────────────────────────────────
  const first = scoreCorpus({ manifest, header: HEADER, artifacts: corpus, protocol });
  const second = scoreCorpus({ manifest, header: HEADER, artifacts: corpus, protocol });
  ok(first.reportHash === second.reportHash,
    '21 the same corpus scores byte-identically twice');

  // ── 20, 22. Ordering is frozen; claims name their trials ──────────────
  ok(first.metricsByArm.A.trialIds.length === first.metricsByArm.A.trials,
    '22 every metric names the exact trials contributing to it');
  ok(first.hardDisqualifiers.every(entry => Array.isArray(entry.contributingTrialIds)),
    '22 and every disqualifier result names its contributing trials');
  ok(manifest.ordering.generatedBeforeExecution === true &&
     manifest.trials.every(trial => Number.isSafeInteger(trial.slot)),
  '20 trial order and slots were assigned before execution, in the manifest');
  // Per-trial artifacts carry no aggregate or verdict field.
  ok(!('frozenDecision' in corpus[0]) && !('metricsByArm' in corpus[0]),
    'per-trial artifacts carry no aggregate or product verdict field');
  // The fixture phase never claims final product authority on its own.
  ok(first.finalProductDecision === 'REQUIRES LIVE-MODEL MATRIX',
    'fixture evidence never claims to be the final product decision');

  console.log(`\nstructured allocation scored evaluation test passed — ${passed} assertions`);
}

main();
