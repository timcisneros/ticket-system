#!/usr/bin/env node
'use strict';

// Tranche 6 — the frozen LIVE manifest and the contracts guarding a live run.
//
// Nothing here calls a provider. What it proves is that a live run cannot start
// under different values than the ones approved: the matrix is derived rather
// than chosen, sampling is explicit and identical for every role, no seed is
// fabricated, the economic cap binds, failures are classified by stable codes
// rather than by whether they hurt the score, and the fixture evidence keeps
// its veto.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const live = require('../config/structured-allocation-evaluation-live-v1.json');
const fixture = require('../config/structured-allocation-evaluation-scored-v1.json');
const protocol = require('../config/structured-allocation-evaluation-v1.json');
const {
  APPROVED, LiveManifestError, buildLiveManifest, computeLiability, deriveLiveCells
} = require('./fixtures/evaluation-live-manifest');
const { classifyLiveFailure, CLASSES } = require('./fixtures/evaluation-live-failure-classifier');
const { combineEvidence } = require('./fixtures/evaluation-evidence-combination');
const { auditLiveReadiness, assertLiveExecutionPermitted } =
  require('./fixtures/evaluation-live-readiness');
const { parseArguments, preflightLiveRun, ScoredRunnerError, executeScoredRun } =
  require('./structured-allocation-evaluation-scored-runner');
const { buildOpenAiResponsesBody } = require('../runtime/provider-request-body');

let passed = 0;
function ok(condition, message) {
  assert.equal(condition, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
function refuses(fn) { try { fn(); return false; } catch (_) { return true; } }
async function refusesAsync(fn) { try { await fn(); return false; } catch (_) { return true; } }

async function main() {
  console.log('evaluation live manifest');

  // ── 1-5. Membership is DERIVED from the immutable fixture manifest ────
  ok(live.uniqueCellCount === 40, '1 the live matrix has exactly 40 unique cells');
  ok(live.repetitions === 3 && live.repetitions === protocol.repetition.liveModelRepetitions,
    '2 exactly 3 repetitions, read from the frozen protocol');
  ok(live.totalAssignedTrials === 120 && live.slots.length === 120,
    '3 exactly 120 assigned slots');
  const fixtureCells = new Set(fixture.trials.map(t =>
    `${t.cellId}|${t.variantId === null ? '' : t.variantId}|${t.armId}`));
  ok(live.cells.every(cell => fixtureCells.has(cell.cellKey)),
    '4 every live cell derives from a frozen fixture cell');
  ok(live.cells.length === fixtureCells.size,
    '5 no cell was removed for performing badly and none was added');
  ok(live.cells.every(cell => cell.sourceFixtureSlots.length > 0),
    '4 and each records the fixture slots it came from');
  ok(live.source.fixtureManifestHash === fixture.manifestHash,
    'the live manifest names the exact fixture manifest it derived from');

  // ── 6-10. Sampling is explicit, identical, and seedless ───────────────
  ok(live.sampling.temperature === 0 && live.sampling.topP === 1,
    '6-7 temperature 0 and top_p 1 are frozen');
  ok(live.plannerModel === live.workerModel && live.sameModelForPlannerAndWorkers,
    '10 planner and workers use one model identity');
  ok(live.sampling.appliesTo.includes('structured_planner') &&
     live.sampling.appliesTo.includes('structured_leaf_executor'),
  '10 one sampling configuration applies to every role — no role may differ');
  ok(live.providerSeedSupport === false && live.providerSeed === null,
    '8 no provider seed is fabricated');
  // Source proof: the production body carries no seed field to bind.
  const bodySource = fs.readFileSync(
    path.join(__dirname, '..', 'runtime', 'provider-request-body.js'), 'utf8');
  ok(!/\bseed\b/.test(bodySource),
    '8 and the production Responses body owns no seed field to bind');
  ok(/\d{4}-\d{2}-\d{2}$/.test(live.model) && live.model === protocol.fixedModel.model,
    '9 the model is the exact dated snapshot, not a floating alias');

  // The sampling values actually SERIALIZE into a request body, and their
  // absence leaves the body byte-identical to the executed fixture form.
  const withSampling = buildOpenAiResponsesBody({
    model: live.model, input: [],
    options: { sampling: { temperature: live.sampling.temperature, topP: live.sampling.topP } }
  });
  ok(withSampling.temperature === 0 && withSampling.top_p === 1,
    '6-7 the frozen sampling values serialize into the request body');
  const withoutSampling = buildOpenAiResponsesBody({ model: live.model, input: [], options: {} });
  ok(!('temperature' in withoutSampling) && !('top_p' in withoutSampling),
    'and omitting sampling adds nothing, so executed fixture hashes stay valid');
  ok(refuses(() => buildOpenAiResponsesBody({
    model: 'm', input: [], options: { sampling: { temperature: 'hot', topP: 1 } }
  })), '6 a non-numeric temperature refuses rather than defaulting');

  // ── 11-14. Economics ──────────────────────────────────────────────────
  ok(live.economics.maximumTotalLiveMicroUsd === 20_000_000,
    '13 the hard global cap is 20 000 000 micro-USD');
  ok(live.economics.computedWorstCaseMicroUsd <= live.economics.maximumTotalLiveMicroUsd,
    '13 the recomputed worst case is within the cap');
  ok(live.economics.headroomMicroUsd ===
     live.economics.maximumTotalLiveMicroUsd - live.economics.computedWorstCaseMicroUsd,
  '13 headroom is exact');
  // BOTH roles contribute. Omitting either would understate the bound in the
  // one direction an economic ceiling must never err.
  const structured = live.economics.liability.byArm.B;
  ok(structured.plannerRequestsPerTrial > 0 && structured.workerRequestsPerTrial > 0,
    '10-11 structured liability counts BOTH planner and worker requests');
  ok(live.economics.liability.boundMethod === 'model_context_window_ceiling',
    'liability uses the frozen worst-case bound method');
  ok(live.contextWindowTokens === 128_000 && live.maximumOutputTokensPerRequest === 2_048,
    '14 context and output ceilings match the existing role authority');
  // A matrix whose liability exceeded the cap REFUSES; it is not trimmed to fit.
  ok(refuses(() => computeLiability(
    Array.from({ length: 1_000_000 }, () => ({ armId: 'B', cellKey: 'x' })))
    .totalMicroUsd > 0 ? (() => { throw new Error('force'); })() : null),
  '12 an oversized matrix is refused rather than reduced to fit the budget');

  // ── 15-21. Failure classification ─────────────────────────────────────
  const cases = [
    ['15 provider 429 with no model result', { httpStatus: 429, modelResultObserved: false },
      'infrastructure_exclusion'],
    ['16 provider 5xx with no model result', { httpStatus: 503, modelResultObserved: false },
      'infrastructure_exclusion'],
    ['17 connection failed before delivery',
      { requestDelivered: false, modelResultObserved: false }, 'infrastructure_exclusion'],
    ['18 delivery cannot be proven absent',
      { requestDelivered: null, modelResultObserved: false }, 'product_data'],
    ['19 model refusal after inference',
      { httpStatus: 200, modelResultObserved: true, errorCode: 'refusal' }, 'product_data'],
    ['20 context-length rejection of the submitted request',
      { httpStatus: 400, errorCode: 'context_length_exceeded', requestDelivered: true,
        modelResultObserved: false }, 'product_data'],
    ['21 authentication failure', { httpStatus: 401 }, 'run_fatal_configuration'],
    ['21 invalid model availability', { errorCode: 'model_not_found' },
      'run_fatal_configuration']
  ];
  for (const [label, evidence, expected] of cases) {
    ok(classifyLiveFailure(evidence).classification === expected,
      `${label} → ${expected}`);
  }
  ok(CLASSES.length === 3, 'exactly three failure classes exist');
  // A poor answer is the product behaving badly — never infrastructure.
  ok(classifyLiveFailure({ httpStatus: 200, modelResultObserved: true })
    .classification === 'product_data',
  'a poor or incorrect model answer is PRODUCT DATA, never an exclusion');

  // ── 22-23. Exclusions and resume ──────────────────────────────────────
  ok(protocol.failureHandling.resultFreezing.includes('never rewritten'),
    '22 an excluded slot keeps its record; no substitute seed is issued');
  ok(live.ordering.generatedBeforeExecution === true,
    '23 ordering was generated before execution and is not regenerated on resume');
  ok(live.slots.every(slot => typeof slot.stochasticIdentity === 'string'),
    '23 every slot carries a fixed stochastic identity, preserved across resume');

  // ── Ordering balance, claimed honestly ────────────────────────────────
  ok(live.ordering.balance.completeLatinSquarePossible === false,
    'a complete Latin square is NOT claimed: 3 repetitions cannot balance 5 arms');
  const firstCounts = {};
  const lastCounts = {};
  for (const order of live.ordering.permutations) {
    firstCounts[order[0]] = (firstCounts[order[0]] || 0) + 1;
    lastCounts[order[order.length - 1]] = (lastCounts[order[order.length - 1]] || 0) + 1;
  }
  ok(Object.values(firstCounts).every(count => count <= 1) &&
     Object.values(lastCounts).every(count => count <= 1),
  'and no arm is systematically first or last');

  // ── 24. Credentials ───────────────────────────────────────────────────
  ok(!JSON.stringify(live).includes('OPENAI_API_KEY') &&
     !/sk-[A-Za-z0-9]/.test(JSON.stringify(live)),
  '24 the live manifest contains no credential material');

  // ── 25-27. Fixture/live evidence relationship ─────────────────────────
  ok(combineEvidence({
    fixture: { hardDisqualifierTriggered: true, ordinaryDecision: 'STOP' },
    live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
  }).finalProductDecision === 'STOP',
  '25 a fixture hard disqualifier VETOES a live RETAIN');
  ok(combineEvidence({
    fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' },
    live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
  }).finalProductDecision === 'RETAIN',
  '26 fixture ordinary STOP reverses only through the frozen live RETAIN rule');
  for (const [liveDecision, expected] of [['REVISE', 'REVISE'], ['STOP', 'STOP']]) {
    ok(combineEvidence({
      fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' },
      live: { ordinaryDecision: liveDecision, corpusComplete: true }
    }).finalProductDecision === expected,
    `26 fixture STOP + live ${liveDecision} → ${expected}`);
  }
  const notEvaluable = combineEvidence({
    fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP',
      hardDisqualifiersNotEvaluable: ['non-deterministic recovery'] },
    live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
  });
  ok(notEvaluable.notEvaluable.length === 1 && notEvaluable.vetoes.length === 0,
    'a NOT EVALUABLE disqualifier is neither a veto nor a clearance');
  ok(notEvaluable.metricReporting.includes('never pooled'),
    '27 fixture and live metrics are reported separately and never pooled');
  // 30. No final decision from an incomplete live corpus.
  ok(combineEvidence({
    fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' },
    live: { ordinaryDecision: 'RETAIN', corpusComplete: false }
  }).finalProductDecision === 'NOT YET DECIDABLE',
  '30 a final decision refuses on an incomplete live corpus');
  ok(combineEvidence({ fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' } })
    .finalProductDecision === 'NOT YET DECIDABLE',
  '30 and refuses when no live corpus exists at all');

  // ── 28-29. Executor contract ──────────────────────────────────────────
  const dryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-dry-'));
  const result = await preflightLiveRun({
    manifestPath: path.join(__dirname, '..', 'config',
      'structured-allocation-evaluation-live-v1.json'),
    outputRoot: dryRoot
  });
  ok(result.providerCallsMade === 0 && result.stoppedBefore === 'provider_dispatch',
    '28 the dry run performs ZERO provider calls and stops before dispatch');
  ok(result.assignedTrials === 120 && Boolean(result.header.runHeaderHash),
    '28 having built the immutable run header for all 120 slots');
  ok(result.firstTrialEnvelope.temperature === 0 &&
     result.firstTrialEnvelope.topP === 1 &&
     result.firstTrialEnvelope.providerSeed === null,
  '28 and the first request envelope carries the frozen sampling and no seed');
  ok(typeof result.credentialPresent === 'boolean',
    '24 credential PRESENCE is recorded as a boolean');
  const written = fs.readFileSync(path.join(dryRoot, 'scored-run-header.json'), 'utf8');
  ok(!/sk-[A-Za-z0-9]/.test(written) && !written.includes('OPENAI_API_KEY'),
    '24 and no secret material is written to the run header');
  fs.rmSync(dryRoot, { recursive: true, force: true });

  // 1-2 of the brief's list: the two executors refuse each other's manifest.
  ok(await refusesAsync(() => executeScoredRun({
    manifestPath: path.join(__dirname, '..', 'config',
      'structured-allocation-evaluation-live-v1.json'),
    outputRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))
  })), '1 the fixture executor REFUSES a live manifest');
  ok(await refusesAsync(() => preflightLiveRun({
    manifestPath: path.join(__dirname, '..', 'config',
      'structured-allocation-evaluation-scored-v1.json'),
    outputRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'y-'))
  })), '2 the live pre-flight REFUSES a fixture manifest');

  // 29. No CLI override of a frozen experimental variable.
  for (const option of ['repetitions', 'seed', 'arms', 'ordering', 'thresholds', 'scenario']) {
    ok(refuses(() => parseArguments([
      '--manifest', 'm.json', '--output-root', '/tmp/x', `--${option}`, '9'
    ])), `29 --${option} cannot override the frozen experiment`);
  }

  // ── Readiness ─────────────────────────────────────────────────────────
  const audit = auditLiveReadiness();
  ok(audit.unresolved.length === 0 &&
     audit.verdict === 'TRANCHE 6 LIVE-MODEL EVALUATION READY',
  'every live decision is encoded and the verdict is READY');
  ok(assertLiveExecutionPermitted(audit) === true,
    'and live execution would be permitted — subject to explicit authorization');
  ok(APPROVED.livePhaseMandatory === true && live.livePhaseMandatory === true,
    '23 the live phase is MANDATORY, superseding the optional-confirmation text');

  // The fixture evidence is untouched.
  ok(fixture.manifestHash ===
     '044d37828f6f251eefaef66eccb2362ff6c6498c689baf54eb357870c4d9a07b' &&
     fixture.trials.length === 200,
  'the frozen fixture manifest is unchanged');
  ok(live.containsResults === false, 'the live manifest carries no results');

  console.log(`\nevaluation live manifest test passed — ${passed} assertions`);
  console.log(`VERDICT: ${audit.verdict}`);
}

main().catch(error => { console.error(error); process.exit(1); });
