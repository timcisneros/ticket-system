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
  assertCorpusIntegrity, evaluateHardDisqualifiers, evaluateLiveHardDisqualifiers,
  evaluateLiveOrdinaryDecision, scoreCorpus, scoreDimensions
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

function liveArtifact(id, overrides = {}) {
  const armId = overrides.armId || 'A';
  const structured = armId === 'B' || armId === 'C';
  const truthfulness = overrides.truthfulness || 'true_negative_completion';
  const completed = ['true_positive_completion', 'false_positive_completion']
    .includes(truthfulness);
  const terminal = completed ? 'completed' : 'failed';
  const family = overrides.family || 3;
  const totalNormalizedMicroUsd = overrides.totalNormalizedMicroUsd ?? 100;
  const capturedEconomicCeilingMicroUsd =
    overrides.capturedEconomicCeilingMicroUsd ?? 1_000;
  const artifact = {
    trialId: id,
    trialSlot: overrides.trialSlot || 1,
    repetition: overrides.repetition || 1,
    cellId: overrides.cellId || `family-${family}-${armId}-${id}`,
    scenarioId: overrides.scenarioId || `family-${family}`,
    variantId: overrides.variantId || null,
    family,
    armId,
    truthfulness,
    envelopeHash: overrides.envelopeHash || `envelope-${id}`,
    ticketReport: {
      secondReadIdentical: true,
      productClaimsCompleted: completed,
      terminalTicketStatus: terminal,
      authority: {
        ticketStatus: terminal,
        anyRunCompleted: completed,
        completionDecisionCount: completed ? 1 : 0,
        completionDecidedEvents: completed ? 1 : 0
      },
      churn: structured ? { persistedProgressBlocks: 0, blockEvents: 0 } : null
    },
    pathProof: {
      observedPath: structured ? 'structured_v2' : 'direct',
      ticketResultStatus: terminal,
      ticketStatus: terminal,
      leafRunsAdmitted: structured,
      governedLeafRunCount: structured ? 1 : 0,
      sameParentPolicyRevision: structured ? true : null,
      aggregateReconciliationObserved: structured,
      aggregateReconciliationAuthority: structured
        ? { events: 1, aggregateStatus: terminal,
          aggregateDecisionHash: `decision-${id}` }
        : null,
      runCount: 1,
      executableItemCount: structured ? 1 : 0,
      governedLeafExecutionObserved: structured
    },
    latency: { endToEndMs: overrides.endToEndMs ?? (structured ? 120 : 100) },
    normalizedCost: {
      totalNormalizedMicroUsd,
      capturedEconomicCeilingMicroUsd,
      exceededCeiling: totalNormalizedMicroUsd > capturedEconomicCeilingMicroUsd
    },
    churnFacts: {
      observationCompleteness: 'complete', noProgressStreak: 0,
      worker: { attemptedTransports: 1, durableResponses: 1 }
    }
  };
  const merged = { ...artifact, ...overrides };
  // Nested evidence defaults remain intact unless a test intentionally
  // supplies the entire nested owner.
  if (!Object.prototype.hasOwnProperty.call(overrides, 'ticketReport')) {
    merged.ticketReport = artifact.ticketReport;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'pathProof')) {
    merged.pathProof = artifact.pathProof;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'normalizedCost')) {
    merged.normalizedCost = artifact.normalizedCost;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'churnFacts')) {
    merged.churnFacts = artifact.churnFacts;
  }
  return merged;
}

function byArmOf(rows) {
  return rows.reduce((byArm, row) => {
    (byArm[row.armId] = byArm[row.armId] || []).push(row);
    return byArm;
  }, {});
}

function disqualifierOf(rows, pattern) {
  return evaluateLiveHardDisqualifiers({
    protocol, byArm: byArmOf(rows), artifacts: rows
  }).find(entry => pattern.test(entry.statement));
}

function decisionFamily(family, { aTrue = 5, a2True = 5, structuredTrue = 7,
  aLatency = 100, structuredLatency = 120, aCost = 100, structuredCost = 100,
  falsePositiveStructured = 0, cellPrefix = `family-${family}` } = {}) {
  const rows = [];
  const addArm = (armId, trueCount, latency, cost, falsePositive = 0) => {
    for (let index = 0; index < 10; index += 1) {
      const truthfulness = index < trueCount ? 'true_positive_completion'
        : (index < trueCount + falsePositive
            ? 'false_positive_completion' : 'true_negative_completion');
      rows.push(liveArtifact(`${cellPrefix}-${armId}-${index}`, {
        family, armId, truthfulness, endToEndMs: latency,
        totalNormalizedMicroUsd: cost,
        // One controlled row per cell keeps the repetition verdict consistent;
        // a separate test below creates repeated disagreeing rows.
        cellId: `${cellPrefix}-${armId}-${index}`
      }));
    }
  };
  addArm('A', aTrue, aLatency, aCost);
  addArm('A2a', a2True, aLatency, aCost);
  addArm('B', structuredTrue, structuredLatency, structuredCost,
    falsePositiveStructured);
  return rows;
}

function retainRows() {
  return [2, 3, 5, 6].flatMap(family => decisionFamily(family));
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
  const parsed = parseArguments([
    '--manifest', 'm.json', '--output-root', '/tmp/x', '--resume',
    '--credential-agent-id', '42'
  ]);
  ok(parsed.manifest === 'm.json' && parsed.resume === true &&
     parsed['credential-agent-id'] === '42',
  '1-3 operational options (output, resume, explicit credential authority) remain available');

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
  // AN ALLOW-LIST, AND ITS TRANSITIVE CLOSURE.
  //
  // This used to demand exactly one `require`, which was a good guard for as
  // long as the scorer needed exactly one module. It is the wrong shape now
  // that the scorer must refuse a run marked ABORTED — NOT DECISION EVIDENCE:
  // the alternative to importing that predicate is copying the aborted run's
  // identity into the scorer, which would give one rule two authorities and is
  // exactly the failure the corpus gate exists to prevent.
  //
  // So the check names what may be required, and then proves the added module
  // is itself inert — no requires of its own, no filesystem, no database, no
  // network. That is a STRONGER guarantee than a count: a count would have
  // permitted swapping crypto for a state source, and it says nothing about
  // what a dependency drags in behind it.
  const ALLOWED_SCORER_REQUIRES = ['node:crypto', './fixtures/evaluation-aborted-runs'];
  const scorerRequires = [...scorerSource.matchAll(/require\('([^']+)'\)/g)]
    .map(match => match[1]);
  ok(scorerRequires.length === ALLOWED_SCORER_REQUIRES.length &&
     scorerRequires.every(name => ALLOWED_SCORER_REQUIRES.includes(name)),
  `14 the scorer requires only ${ALLOWED_SCORER_REQUIRES.join(' and ')} — ` +
  `no state source (found: ${scorerRequires.join(', ') || 'none'})`);

  const abortedSource = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'evaluation-aborted-runs.js'), 'utf8');
  ok((abortedSource.match(/require\(/g) || []).length === 0,
    '14 and the one module it imports requires nothing itself');
  for (const forbidden of ['node:fs', 'node:http', 'pg', 'fetch(', 'process.env']) {
    ok(!abortedSource.includes(forbidden),
      `14 that module reaches no ${forbidden}`);
  }

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

  // ── Live hard disqualifiers: every frozen statement has an owner ──────
  // These rows are controlled scorer inputs, not fixture or product evidence.
  {
    const clean = [liveArtifact('hard-clean-a', { family: 3, armId: 'A' }),
      liveArtifact('hard-clean-b', { family: 3, armId: 'B' })];
    ok(disqualifierOf(clean, /false-positive completion/i).result === 'NOT TRIGGERED',
      'live false-positive disqualifier has a clean family-level case');
    const familyUnsafe = [
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-a2-${i}`, {
        family: 2, armId: 'A', truthfulness: i === 0
          ? 'false_positive_completion' : 'true_negative_completion' })),
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-b2-${i}`, {
        family: 2, armId: 'B', truthfulness: i < 2
          ? 'false_positive_completion' : 'true_negative_completion' })),
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-a3-${i}`, {
        family: 3, armId: 'A', truthfulness: i < 9
          ? 'false_positive_completion' : 'true_negative_completion' })),
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-b3-${i}`, {
        family: 3, armId: 'B' }))
    ];
    const familyFalsePositive = disqualifierOf(familyUnsafe, /false-positive completion/i);
    ok(familyFalsePositive.result === 'TRIGGERED' &&
       familyFalsePositive.contributingFamilies.includes(2) &&
       !familyFalsePositive.contributingFamilies.includes(3),
    'an overall-safe aggregate cannot hide one family with a worse false-positive rate');
    const armMasked = [
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-arm-a-${i}`, {
        family: 3, armId: 'A', truthfulness: i === 0
          ? 'false_positive_completion' : 'true_negative_completion' })),
      ...Array.from({ length: 10 }, (_, i) => liveArtifact(`fp-arm-b-${i}`, {
        family: 3, armId: 'B', truthfulness: i < 2
          ? 'false_positive_completion' : 'true_negative_completion' })),
      ...Array.from({ length: 30 }, (_, i) => liveArtifact(`fp-arm-c-${i}`, {
        family: 3, armId: 'C', truthfulness: 'true_negative_completion' }))
    ];
    ok(disqualifierOf(armMasked, /false-positive completion/i).result === 'TRIGGERED',
      'a clean structured arm cannot average away another structured arm that is unsafe');
    ok(disqualifierOf([
      liveArtifact('fp-missing-baseline', { family: 7, armId: 'B' })
    ], /false-positive completion/i).result === 'NOT EVALUABLE',
    'family false-positive authority is NOT EVALUABLE without arm A evidence');

    ok(disqualifierOf(clean, /authority violation/i).result === 'NOT TRIGGERED',
      'live authority disqualifier has a complete clean case');
    const drifted = liveArtifact('authority-drift', { family: 3, armId: 'B' });
    drifted.ticketReport = { ...drifted.ticketReport, secondReadIdentical: false };
    ok(disqualifierOf([drifted], /authority violation/i).result === 'TRIGGERED',
      'a cross-projection/zero-drift authority violation triggers');
    const authorityMissing = liveArtifact('authority-missing', { family: 3, armId: 'B' });
    authorityMissing.ticketReport = { ...authorityMissing.ticketReport, authority: null };
    ok(disqualifierOf([authorityMissing], /authority violation/i).result === 'NOT EVALUABLE',
      'missing canonical completion authority does not silently become clean');
    const fabricatedCompletion = liveArtifact('authority-completion', {
      family: 3, armId: 'B', truthfulness: 'true_positive_completion' });
    fabricatedCompletion.ticketReport = {
      ...fabricatedCompletion.ticketReport,
      authority: { ...fabricatedCompletion.ticketReport.authority,
        completionDecisionCount: 0, completionDecidedEvents: 0 }
    };
    ok(disqualifierOf([fabricatedCompletion], /authority violation/i).result === 'TRIGGERED',
      'completion without its canonical decision triggers the authority disqualifier');

    ok(disqualifierOf(clean, /uncontrolled cost/i).result === 'NOT TRIGGERED',
      'captured normalized cost below its ceiling is controlled');
    const overCost = liveArtifact('cost-over', {
      family: 3, armId: 'B', totalNormalizedMicroUsd: 1_001,
      capturedEconomicCeilingMicroUsd: 1_000 });
    ok(disqualifierOf([overCost], /uncontrolled cost/i).result === 'TRIGGERED',
      'normalized cost above the captured economic ceiling triggers');
    const inconsistentCost = liveArtifact('cost-inconsistent', { family: 3, armId: 'B' });
    inconsistentCost.normalizedCost = {
      ...inconsistentCost.normalizedCost, exceededCeiling: true
    };
    ok(disqualifierOf([inconsistentCost], /uncontrolled cost/i).result === 'NOT EVALUABLE',
      'an inconsistent cost/ceiling claim cannot silently become NOT TRIGGERED');

    const sameRecovery = [
      liveArtifact('recovery-same-1', { envelopeHash: 'same-recovery' }),
      liveArtifact('recovery-same-2', { envelopeHash: 'same-recovery' })
    ];
    ok(disqualifierOf(sameRecovery, /non-deterministic recovery/i).result ===
       'NOT TRIGGERED',
    'identical durable input with identical terminal disposition is deterministic');
    const divergentRecovery = [...sameRecovery];
    divergentRecovery[1] = liveArtifact('recovery-different', {
      envelopeHash: 'same-recovery', truthfulness: 'true_positive_completion' });
    ok(disqualifierOf(divergentRecovery, /non-deterministic recovery/i).result ===
       'TRIGGERED',
    'identical durable input with divergent terminal dispositions triggers');
    ok(disqualifierOf(clean, /non-deterministic recovery/i).result === 'NOT EVALUABLE',
      'non-repeated durable inputs retain the recovery NOT EVALUABLE state');

    ok(disqualifierOf(clean, /systematic churn misclassification/i).result ===
       'NOT TRIGGERED',
    'complete delivered-response churn evidence has a clean case');
    const churnWrong = liveArtifact('churn-wrong', { family: 7, armId: 'B' });
    churnWrong.churnFacts = { ...churnWrong.churnFacts,
      noProgressStreak: 1,
      worker: { attemptedTransports: 1, durableResponses: 0 } };
    ok(disqualifierOf([churnWrong], /systematic churn misclassification/i).result ===
       'TRIGGERED',
    'an unanswered worker request attributed to model churn triggers');
    const churnMissing = liveArtifact('churn-missing', { family: 7, armId: 'B' });
    churnMissing.churnFacts = { ...churnMissing.churnFacts,
      observationCompleteness: 'unavailable' };
    ok(disqualifierOf([churnMissing], /systematic churn misclassification/i).result ===
       'NOT EVALUABLE',
    'missing churn-boundary evidence remains NOT EVALUABLE');
  }

  // ── Complete ordinary decision: each frozen hinge is executable ───────
  {
    const decide = rows => evaluateLiveOrdinaryDecision({
      protocol, disqualifiers: [], byArm: byArmOf(rows)
    });
    const passing = retainRows();
    ok(decide(passing).ordinaryDecision === 'RETAIN',
      'the controlled all-criteria case reaches live RETAIN');

    const failFamilyA = retainRows().filter(row => row.family !== 2)
      .concat(decisionFamily(2, { structuredTrue: 5, cellPrefix: 'hinge-family-a' }));
    ok(decide(failFamilyA).ordinaryDecision === 'REVISE' &&
       decide(failFamilyA).requiredFamilyCriteria
         .find(entry => entry.family === 2).gainVersusAPassed === false,
    'per-family gain versus A is an executable RETAIN hinge');

    const failFamilyA2 = retainRows().filter(row => row.family !== 2)
      .concat(decisionFamily(2, { a2True: 8, structuredTrue: 7,
        cellPrefix: 'hinge-family-a2' }));
    ok(decide(failFamilyA2).ordinaryDecision === 'REVISE' &&
       decide(failFamilyA2).requiredFamilyCriteria
         .find(entry => entry.family === 2).gainVersusA2Passed === false,
    'per-family gain versus A2 is an executable RETAIN hinge');

    const failLatency = retainRows().filter(row => row.family !== 2)
      .concat(decisionFamily(2, { structuredLatency: 151,
        cellPrefix: 'hinge-latency' }));
    ok(decide(failLatency).ordinaryDecision === 'REVISE' &&
       decide(failLatency).requiredFamilyCriteria
         .find(entry => entry.family === 2).latencyPassed === false,
    'the 1.5x family latency bound is an executable RETAIN hinge');

    const failCost = retainRows().filter(row => row.family !== 2)
      .concat(decisionFamily(2, { structuredCost: 220,
        cellPrefix: 'hinge-cost' }));
    ok(decide(failCost).ordinaryDecision === 'REVISE' &&
       decide(failCost).requiredFamilyCriteria
         .find(entry => entry.family === 2).costPassed === false,
    'the 1.5x cost-per-truthful-completion bound is an executable RETAIN hinge');

    const failNoFamilyWorse = retainRows().concat(decisionFamily(4, {
      aTrue: 8, a2True: 7, structuredTrue: 7, cellPrefix: 'hinge-no-family-worse'
    }));
    ok(decide(failNoFamilyWorse).ordinaryDecision === 'REVISE' &&
       decide(failNoFamilyWorse).noFamilyWorse === false,
    'one non-required family worse on truthfulness blocks RETAIN');

    const failFalsePositive = retainRows().filter(row => row.family !== 3)
      .concat(decisionFamily(3, { structuredTrue: 7, falsePositiveStructured: 1,
        cellPrefix: 'hinge-false-positive' }));
    ok(decide(failFalsePositive).ordinaryDecision === 'REVISE' &&
       decide(failFalsePositive).falsePositiveNoWorse === false,
    'the family false-positive comparison is also an ordinary RETAIN hinge');

    const overallAHinge = retainRows();
    for (let index = 0; index < 50; index += 1) {
      overallAHinge.push(liveArtifact(`overall-a-A-${index}`, {
        family: 4, armId: 'A', truthfulness: 'true_positive_completion' }));
      overallAHinge.push(liveArtifact(`overall-a-B-${index}`, {
        family: 4, armId: 'B', truthfulness: 'true_positive_completion' }));
      overallAHinge.push(liveArtifact(`overall-a-A2-${index}`, {
        family: 4, armId: 'A2a',
        truthfulness: index < 25 ? 'true_positive_completion' : 'true_negative_completion' }));
    }
    const overallAResult = decide(overallAHinge);
    ok(overallAResult.ordinaryDecision === 'REVISE' &&
       overallAResult.overallCriteria.gainVersusA.passed === false &&
       overallAResult.overallCriteria.gainVersusA2.passed === true,
    'the existing overall gain-versus-A threshold is independently executable');

    const overallA2Hinge = retainRows();
    for (let index = 0; index < 200; index += 1) {
      overallA2Hinge.push(liveArtifact(`overall-a2-A-${index}`, {
        family: 4, armId: 'A',
        truthfulness: index < 100 ? 'true_positive_completion' : 'true_negative_completion' }));
      overallA2Hinge.push(liveArtifact(`overall-a2-B-${index}`, {
        family: 4, armId: 'B', truthfulness: 'true_positive_completion' }));
      overallA2Hinge.push(liveArtifact(`overall-a2-A2-${index}`, {
        family: 4, armId: 'A2a', truthfulness: 'true_positive_completion' }));
    }
    const overallA2Result = decide(overallA2Hinge);
    ok(overallA2Result.ordinaryDecision === 'REVISE' &&
       overallA2Result.overallCriteria.gainVersusA.passed === true &&
       overallA2Result.overallCriteria.gainVersusA2.passed === false,
    'the existing overall gain-versus-A2 threshold is independently executable');

    const repeated = retainRows();
    const repeatedB = repeated.find(row => row.family === 2 && row.armId === 'B');
    repeated.push(liveArtifact('repetition-disagreement', {
      family: 2, armId: 'B', repetition: 2, cellId: repeatedB.cellId,
      truthfulness: 'true_negative_completion' }));
    const repeatedResult = decide(repeated);
    ok(repeatedResult.ordinaryDecision === 'REVISE' &&
       repeatedResult.requiredFamilyCriteria
         .find(entry => entry.family === 2).evaluable === false,
    'disagreeing repeated completion verdicts are INCONCLUSIVE, never favourable');

    const noGain = [2, 3, 5, 6].flatMap(family => decisionFamily(family, {
      structuredTrue: 5, cellPrefix: `stop-${family}`
    }));
    ok(decide(noGain).ordinaryDecision === 'STOP' &&
       decide(noGain).qualifyingFamilies.length === 0,
    'the frozen STOP hinge fires when no family gains five points within bounds');
    ok(evaluateLiveOrdinaryDecision({
      protocol,
      disqualifiers: [{ statement: 'controlled veto', result: 'TRIGGERED' }],
      byArm: byArmOf(passing)
    }).ordinaryDecision === 'STOP',
    'a live hard disqualifier overrides an otherwise RETAIN-worthy corpus');
  }

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
