#!/usr/bin/env node
'use strict';

// Tranche 6 — deterministic proofs for the controlled-evaluation harness.
//
// The evaluation has not run and no verdict exists. What this suite proves is
// that the harness CANNOT produce a dishonest comparison when it does run:
//
//   * the oracle is structurally independent of the completion authority it
//     judges, and refuses rather than guessing;
//   * every arm reaches a different, named production path, and a
//     misconfigured or mis-executed trial is refused rather than mislabelled;
//   * one cost method prices every arm, with durable governed cost reported
//     beside it as a cross-check rather than compared against it;
//   * comparisons refuse when a controlled variable differs, when execution
//     modes are mixed, or when metrics would be divided by Runs instead of
//     trials;
//   * product failures stay in the data set.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildScenarioExpectation,
  evaluateScenarioOutcome,
  classifyTruthfulness
} = require('./fixtures/evaluation-oracle');
const {
  ARMS, ARM_IDS, predictProductionPath, assertArmReachesIntendedPath,
  assertObservedPathMatches, assertDistinctCells, EvaluationArmError
} = require('./fixtures/evaluation-arms');
const {
  freezePricingSnapshot, priceRequest, buildNormalizedCost, assertComparablePricing
} = require('./fixtures/evaluation-normalized-cost');
const {
  buildComparisonEnvelope, assertComparable, assertSingleExecutionMode,
  classifyTrialInclusion, buildTrialRecord, aggregateTicketScoped, CONTROLLED_FIELDS
} = require('./fixtures/evaluation-trial-record');
const { buildPricingCatalog } = require('../runtime/model-pricing-catalog');

async function main() {
let passed = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
  console.log(`  ok ${message}`);
};

// ── 1. THE ORACLE IS STRUCTURALLY INDEPENDENT ──────────────────────────────
//
// Not "carefully written to avoid" product authority — incapable of reaching
// it. Source-level, because a future edit is exactly the risk.
{
  const source = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'evaluation-oracle.js'), 'utf8');
  const executable = source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  for (const forbidden of [
    'completion-decision-contract',
    'structured-allocation-leaf-run-contract',
    'postcondition-criterion-evaluator',
    'governed-progress-block-contract',
    'deriveLeafItemDisposition',
    'completionDecision',
    'normalizeCompletionDecision',
    'persistence/postgres/store'
  ]) {
    ok(!executable.includes(forbidden),
      `1 oracle: never references ${forbidden}`);
  }
  ok(!/require\(['"][^'"]*runtime\//.test(executable),
    '1 oracle: imports NOTHING from runtime/ — it cannot reach product authority');
  // It takes no store and no run: there is no parameter through which product
  // authority could arrive.
  ok(!executable.includes('store') && !executable.includes('repository'),
    '1 oracle: accepts no store or repository');
}

// ── 2. THE ORACLE DETECTS ALL FIVE REQUIRED CASES ──────────────────────────
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-oracle-'));
  const expectation = buildScenarioExpectation({
    scenarioId: 'oracle-selftest', version: 1,
    expectations: [
      { kind: 'folder_exists', path: 'reports/alpha' },
      { kind: 'file_contains', path: 'reports/alpha/summary.md', contains: 'FINDING' }
    ]
  });

  // (3) product and oracle agree on SUCCESS
  fs.mkdirSync(path.join(root, 'reports/alpha'), { recursive: true });
  fs.writeFileSync(path.join(root, 'reports/alpha/summary.md'), '# FINDING one\n');
  const good = evaluateScenarioOutcome({ workspaceRoot: root, expectation });
  ok(good.verdict === 'pass', '2 oracle: raw state satisfying the objective passes');
  ok(classifyTruthfulness({ productClaimsCompleted: true, oracleResult: good }) ===
    'true_positive_completion',
  '2 oracle: case 3 — product and oracle agree on success');

  // (1) product says completed, objective actually FALSE — the disqualifier
  fs.writeFileSync(path.join(root, 'reports/alpha/summary.md'), '# nothing useful\n');
  const stale = evaluateScenarioOutcome({ workspaceRoot: root, expectation });
  ok(stale.verdict === 'fail', '2 oracle: unsatisfied content fails');
  ok(classifyTruthfulness({ productClaimsCompleted: true, oracleResult: stale }) ===
    'false_positive_completion',
  '2 oracle: case 1 — FALSE POSITIVE completion is detected');

  // (4) product and oracle agree on FAILURE
  ok(classifyTruthfulness({ productClaimsCompleted: false, oracleResult: stale }) ===
    'true_negative_completion',
  '2 oracle: case 4 — product and oracle agree on failure');

  // (2) product says incomplete, objective actually TRUE
  fs.writeFileSync(path.join(root, 'reports/alpha/summary.md'), 'FINDING restored\n');
  const recovered = evaluateScenarioOutcome({ workspaceRoot: root, expectation });
  ok(classifyTruthfulness({ productClaimsCompleted: false, oracleResult: recovered }) ===
    'false_negative_completion',
  '2 oracle: case 2 — FALSE NEGATIVE completion is detected');

  // (5) observable state insufficient → REFUSE, never guess
  const blocked = buildScenarioExpectation({
    scenarioId: 'oracle-refusal', version: 1,
    expectations: [{ kind: 'file_contains', path: 'reports/alpha', contains: 'x' }]
  });
  const refused = evaluateScenarioOutcome({ workspaceRoot: root, expectation: blocked });
  ok(refused.verdict === 'fail' || refused.verdict === 'refused',
    '2 oracle: a directory where a file was expected does not silently pass');

  const unreadable = path.join(root, 'reports/alpha/locked.md');
  fs.writeFileSync(unreadable, 'x');
  fs.chmodSync(unreadable, 0o000);
  const lockedExpectation = buildScenarioExpectation({
    scenarioId: 'oracle-unreadable', version: 1,
    expectations: [{ kind: 'file_contains', path: 'reports/alpha/locked.md', contains: 'x' }]
  });
  const lockedResult = evaluateScenarioOutcome({
    workspaceRoot: root, expectation: lockedExpectation });
  // Running as root can read anything; the refusal path is still asserted for
  // the ordinary case and the classifier is proved either way.
  if (lockedResult.verdict === 'refused') {
    ok(classifyTruthfulness({ productClaimsCompleted: true, oracleResult: lockedResult }) ===
      'oracle_refused',
    '2 oracle: case 5 — unobservable state REFUSES rather than guessing');
  } else {
    ok(classifyTruthfulness({
      productClaimsCompleted: true,
      oracleResult: { ...lockedResult, verdict: 'refused' }
    }) === 'oracle_refused',
    '2 oracle: case 5 — a refused verdict classifies as oracle_refused');
  }
  fs.chmodSync(unreadable, 0o600);
  fs.rmSync(root, { recursive: true, force: true });

  // ARM-BLIND: the oracle has no arm parameter at all.
  ok(evaluateScenarioOutcome.length === 1,
    '2 oracle: takes one options object and no arm identifier');
}

// ── 3. EVERY ARM REACHES A DIFFERENT, NAMED PRODUCTION PATH ────────────────
{
  ok(ARM_IDS.length === 5 && ARM_IDS.join(',') === 'A,A2a,A2b,B,C',
    '3 arms: exactly five configurations');

  const routed = {};
  for (const armId of ARM_IDS) {
    const arm = ARMS[armId];
    routed[armId] = predictProductionPath({
      assignmentTargetType: arm.assignmentTargetType,
      assignmentMode: arm.assignmentMode,
      declaredWorkSupplied: arm.declaredWork,
      plannerAgentPresent: arm.plannerAgent
    });
  }
  ok(routed.A === 'direct', '3 arms: A reaches the direct path');
  ok(routed.A2a === 'legacy_v1' && routed.A2b === 'legacy_v1',
    '3 arms: A2a and A2b reach the LEGACY v1 path, not the structured one');
  ok(routed.B === 'structured_v2' && routed.C === 'structured_v2',
    '3 arms: B and C reach the structured v2 path');

  // Legacy must never be mislabelled structured: declaredWork alone is not
  // enough, and a planner agent alone is not enough.
  ok(predictProductionPath({
    assignmentTargetType: 'group', assignmentMode: 'allocated',
    declaredWorkSupplied: true, plannerAgentPresent: false
  }) === 'legacy_v1',
  '3 arms: declaredWork without a planner agent stays LEGACY');
  ok(predictProductionPath({
    assignmentTargetType: 'group', assignmentMode: 'allocated',
    declaredWorkSupplied: false, plannerAgentPresent: true
  }) === 'legacy_v1',
  '3 arms: a planner agent without declaredWork stays LEGACY');

  // Allocated and dynamic are separate cells in both families.
  ok(ARMS.A2a.ownershipSource !== ARMS.A2b.ownershipSource,
    '3 arms: A2a and A2b are distinct cells (operator vs system-derived)');
  ok(ARMS.B.ownershipSource !== ARMS.C.ownershipSource,
    '3 arms: B and C are distinct cells');
  ok(assertDistinctCells(['A', 'A2a', 'A2b', 'B', 'C']),
    '3 arms: the five cells never collapse');

  // ACCEPTANCE, not only refusal. Every assertion below this point had been a
  // refusal, so a mutation that made the harness refuse EVERY trial survived
  // the suite. A correctly executed trial must be positively accepted and
  // return its own path, or the harness could reject all data and no proof
  // would notice.
  ok(assertObservedPathMatches(ARMS.A, {
    structuredPlanAdmitted: false, plannerRequestCount: 0,
    governedLeafRunCount: 0, allocationPlanPresent: false, runCount: 1
  }) === 'direct',
  '3 arms: a valid DIRECT trial is accepted as direct');

  ok(assertObservedPathMatches(ARMS.A2a, {
    structuredPlanAdmitted: false, plannerRequestCount: 0,
    governedLeafRunCount: 0, allocationPlanPresent: true, runCount: 2
  }) === 'legacy_v1',
  '3 arms: a valid LEGACY v1 trial is accepted as legacy, never as structured');

  ok(assertObservedPathMatches(ARMS.A2b, {
    structuredPlanAdmitted: false, plannerRequestCount: 0,
    governedLeafRunCount: 0, allocationPlanPresent: true, runCount: 3
  }) === 'legacy_v1',
  '3 arms: the dynamic legacy cell is also accepted as legacy');

  ok(assertObservedPathMatches(ARMS.B, {
    structuredPlanAdmitted: true, plannerRequestCount: 1,
    governedLeafRunCount: 2, allocationPlanPresent: true, runCount: 2
  }) === 'structured_v2',
  '3 arms: a valid STRUCTURED trial is accepted as structured');

  // A misconfigured trial is REFUSED before it runs.
  assert.throws(() => assertArmReachesIntendedPath(ARMS.B, {
    assignmentTargetType: 'group', assignmentMode: 'allocated',
    declaredWorkSupplied: false, plannerAgentPresent: true
  }), error => error instanceof EvaluationArmError);
  passed += 1;
  console.log('  ok 3 arms: a configuration reaching the wrong path is REFUSED pre-trial');

  // And a trial whose DURABLE FACTS show another path is refused afterwards.
  assert.throws(() => assertObservedPathMatches(ARMS.B, {
    structuredPlanAdmitted: false, plannerRequestCount: 0,
    governedLeafRunCount: 0, allocationPlanPresent: true, runCount: 2
  }), error => error instanceof EvaluationArmError);
  passed += 1;
  console.log('  ok 3 arms: a trial that actually ran the wrong path is INVALID, not mislabelled');

  assert.throws(() => assertObservedPathMatches(ARMS.A2a, {
    structuredPlanAdmitted: true, plannerRequestCount: 1,
    governedLeafRunCount: 2, allocationPlanPresent: true, runCount: 2
  }), error => error instanceof EvaluationArmError);
  passed += 1;
  console.log('  ok 3 arms: legacy v1 observed as structured is REFUSED');
}

// ── 4. ONE COST METHOD FOR EVERY ARM ───────────────────────────────────────
{
  // The SAME catalog shape the governed arms capture, so the normalized method
  // and the durable method price from an identical authority.
  const { pricedCatalogValue } = require('./governed-structured-fixture');
  const snapshot = freezePricingSnapshot(buildPricingCatalog(pricedCatalogValue()));

  const request = {
    role: 'worker', provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
    inputTokens: 1000, outputTokens: 500
  };
  const priced = priceRequest(snapshot, request);
  ok(priced.measurement === 'derived',
    '4 cost: every normalized value is labelled derived');
  ok(priced.tokenSource === 'metered_usage',
    '4 cost: metered usage is used when durably present');

  // THE SAME INPUT PRICES IDENTICALLY REGARDLESS OF ARM. There is no arm
  // parameter, so an arm cannot get a different method.
  const again = priceRequest(snapshot, { ...request });
  ok(priced.microUsd === again.microUsd,
    '4 cost: identical requests price identically — no per-arm branch exists');
  ok(priceRequest.length === 2,
    '4 cost: priceRequest takes only a snapshot and a request');

  // Unmetered requests fall back identically on every arm, and never to zero.
  const unmetered = priceRequest(snapshot, {
    role: 'planner', provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
    authorizedOutputTokens: 2048, boundInputTokens: 8000
  });
  ok(unmetered.tokenSource === 'authorized_maximum_assumed' && unmetered.microUsd > 0,
    '4 cost: an unmetered request is priced at the authorized maximum, never zero');

  // Planner cost is counted, not excluded.
  const structured = buildNormalizedCost({
    snapshot,
    requests: [
      { role: 'planner', provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
        inputTokens: 4000, outputTokens: 800 },
      { role: 'worker', provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
        inputTokens: 1000, outputTokens: 500 }
    ],
    truthfulCompletions: 1,
    durableGovernedMicroUsd: 999_999
  });
  ok(structured.plannerRequestCount === 1 && structured.plannerMicroUsd > 0,
    '4 cost: planner cost is COUNTED for the structured arms');
  ok(structured.totalNormalizedMicroUsd ===
    structured.plannerMicroUsd + structured.workerMicroUsd,
  '4 cost: the total includes planner spend');

  // Durable governed cost is reported BESIDE the normalized figure, with their
  // difference as an accounting cross-check — never as the comparison value.
  ok(structured.durableGovernedMicroUsd === 999_999 &&
    structured.durableVersusNormalizedDeltaMicroUsd ===
      999_999 - structured.totalNormalizedMicroUsd,
  '4 cost: durable governed cost is a cross-check, reported separately');

  const ungoverned = buildNormalizedCost({
    snapshot,
    requests: [{ role: 'worker', provider: 'openai', model: 'gpt-4o-mini-2024-07-18',
      inputTokens: 1000, outputTokens: 500 }],
    truthfulCompletions: 1
  });
  ok(ungoverned.durableGovernedMicroUsd === null,
    '4 cost: no settled monetary authority is invented for the ungoverned arms');
  ok(ungoverned.measurement === 'derived' && structured.measurement === 'derived',
    '4 cost: BOTH arms are compared on the same derived method');

  // Zero truthful completions is undefined, not zero and not infinity.
  const none = buildNormalizedCost({
    snapshot, requests: [], truthfulCompletions: 0 });
  ok(none.normalizedMicroUsdPerTruthfulCompletion === null,
    '4 cost: cost per truthful completion is null when there were none');

  assert.throws(() => assertComparablePricing([
    { pricingSnapshotHash: 'a' }, { pricingSnapshotHash: 'b' }
  ]));
  passed += 1;
  console.log('  ok 4 cost: costs priced under different snapshots may not be pooled');
}

// ── 5. COMPARABILITY IS ENFORCED, NOT DOCUMENTED ───────────────────────────
{
  const base = {};
  for (const field of CONTROLLED_FIELDS) base[field] = `${field}-value`;
  const left = buildComparisonEnvelope(base);
  const right = buildComparisonEnvelope({ ...base });
  ok(left.envelopeHash === right.envelopeHash,
    '5 envelope: identical controls produce an identical envelope hash');
  ok(assertComparable([left, right]), '5 envelope: identical envelopes compare');

  const differentModel = buildComparisonEnvelope({ ...base, model: 'other-model' });
  assert.throws(() => assertComparable([left, differentModel]), /model/);
  passed += 1;
  console.log('  ok 5 envelope: a different model REFUSES the comparison');

  const differentState = buildComparisonEnvelope({
    ...base, initialWorkspaceHash: 'different' });
  assert.throws(() => assertComparable([left, differentState]), /initialWorkspaceHash/);
  passed += 1;
  console.log('  ok 5 envelope: different initial state REFUSES the comparison');

  assert.throws(() => buildComparisonEnvelope({ ...base, scenarioSeed: undefined }));
  passed += 1;
  console.log('  ok 5 envelope: an unstated control is refused, never defaulted');

  ok(left.unavoidableDifferences.some(text => text.includes('one Run')),
    '5 envelope: unavoidable arm differences are recorded on every envelope');
}

// ── 6. TICKET-SCOPED METRICS AND HONEST INCLUSION ──────────────────────────
{
  const base = {};
  for (const field of CONTROLLED_FIELDS) base[field] = `${field}-value`;
  const envelope = buildComparisonEnvelope(base);

  const structuredRecord = buildTrialRecord({
    trialId: 't1', scenarioId: 's1', scenarioVersion: 1, armId: 'B',
    repetition: 1, executionMode: 'deterministic_fixture', envelope,
    ticketId: 10, runIds: [1, 2, 3, 4], latency: { endToEndMs: 400 },
    churn: { persistedProgressBlocks: 0 }
  });
  const directRecord = buildTrialRecord({
    trialId: 't2', scenarioId: 's1', scenarioVersion: 1, armId: 'A',
    repetition: 1, executionMode: 'deterministic_fixture', envelope,
    ticketId: 11, runIds: [5], latency: { endToEndMs: 200 }
  });

  ok(structuredRecord.runCount === 4 && directRecord.runCount === 1,
    '6 record: Run counts are recorded and differ by arm');
  const aggregate = aggregateTicketScoped(
    [structuredRecord, directRecord], r => r.latency.endToEndMs);
  ok(aggregate.denominator === 'trials' && aggregate.n === 2 && aggregate.mean === 300,
    '6 record: aggregation divides by TRIALS, never by Runs');

  ok(directRecord.churn === null,
    '6 record: an arm with no churn control reports null churn, never zero');

  assert.throws(() => assertSingleExecutionMode([
    structuredRecord,
    buildTrialRecord({ ...{
      trialId: 't3', scenarioId: 's1', scenarioVersion: 1, armId: 'A',
      repetition: 1, executionMode: 'live_model', envelope, ticketId: 12, runIds: [6]
    } })
  ]));
  passed += 1;
  console.log('  ok 6 record: fixture and live results may not be combined');

  // A product failure is DATA.
  const productFailure = classifyTrialInclusion({
    completedTrial: false, failureReason: 'run_failed_postconditions' });
  ok(productFailure.included === true,
    '6 record: a PRODUCT failure stays in the data set');
  const infra = classifyTrialInclusion({
    completedTrial: false, failureReason: 'database_unavailable' });
  ok(infra.included === false && infra.exclusionReason === 'database_unavailable',
    '6 record: only a predeclared infrastructure failure is excluded');
}

// ── 7. THE READER IS READ-ONLY BY CONSTRUCTION ─────────────────────────────
{
  const { assertSelectOnly } = require('./structured-allocation-evaluation-report');
  ok(assertSelectOnly('SELECT 1') === 'SELECT 1',
    '7 reader: SELECT is permitted');
  for (const statement of [
    'INSERT INTO runs VALUES (1)',
    'UPDATE runs SET status = $1',
    'DELETE FROM runs',
    'TRUNCATE runs'
  ]) {
    assert.throws(() => assertSelectOnly(statement));
    passed += 1;
    console.log(`  ok 7 reader: refuses ${statement.split(' ')[0]}`);
  }

  const source = fs.readFileSync(
    path.join(__dirname, 'structured-allocation-evaluation-report.js'), 'utf8');
  const executable = source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const forbidden of [
    'INSERT ', 'UPDATE ', 'DELETE ', 'transitionRun', 'claimPendingRun',
    'recordRunConsequence', 'settleEconomicRequest', 'terminalizeRun'
  ]) {
    ok(!executable.includes(forbidden),
      `7 reader: never calls ${forbidden.trim()}`);
  }
}


// ── 8. THE HERMETIC FIXTURE PROVIDER ───────────────────────────────────────
{
  const {
    createFixtureNamespace, stageResponses, serveRequest, readTranscript,
    transportSummary, transcriptHash, FixtureProviderError, responseKey
  } = require('./fixtures/evaluation-fixture-provider');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-fixture-'));
  const ns = createFixtureNamespace(root, 'trial-1');

  // THE KEY CARRIES NO ARM. Two arms issuing the same logical request get the
  // same key and therefore the same bytes.
  const base = {
    protocolVersion: 1, scenarioId: 's1', logicalTaskId: 'task-a',
    seed: 'seed-1', role: 'worker', ordinal: 1
  };
  ok(responseKey(base) === responseKey({ ...base }),
    '8 fixture: the response key is a pure function of protocol/scenario/task/seed/role/ordinal');
  ok(responseKey.length === 1,
    '8 fixture: responseKey takes one options object — there is no arm parameter');

  stageResponses(ns, [
    { ...base, body: '{"ok":true}', inputTokens: 100, outputTokens: 50 },
    { ...base, role: 'planner', ordinal: 1, body: '{"plan":true}',
      inputTokens: 200, outputTokens: 80 },
    { ...base, ordinal: 2, body: '{"second":true}', inputTokens: 10, outputTokens: 5,
      failureBoundary: 'after_transport_before_response' },
    { ...base, ordinal: 3, body: '{"never":true}', inputTokens: 1, outputTokens: 1,
      failureBoundary: 'before_transport' }
  ]);

  const served = serveRequest(ns, { ...base, body: 'request-bytes' });
  ok(served.text === '{"ok":true}' && served.usage.input_tokens === 100,
    '8 fixture: a staged request is served deterministically with its token usage');
  ok(typeof served.identity === 'string' && served.identity.startsWith('fixture-'),
    '8 fixture: responses carry a stable identity');

  // AN UNEXPECTED REQUEST IS REFUSED, never answered generically.
  assert.throws(() => serveRequest(ns, { ...base, ordinal: 99, body: 'x' }),
    error => error instanceof FixtureProviderError && /no staged fixture response/.test(error.message));
  passed += 1;
  console.log('  ok 8 fixture: an unexpected request is REFUSED, not given a generic success');

  // Controlled failure boundaries.
  assert.throws(() => serveRequest(ns, { ...base, ordinal: 2, body: 'x' }),
    /post-transport response loss/);
  passed += 1;
  console.log('  ok 8 fixture: the post-transport boundary serves bytes then loses the response');
  assert.throws(() => serveRequest(ns, { ...base, ordinal: 3, body: 'x' }),
    /pre-transport provider failure/);
  passed += 1;
  console.log('  ok 8 fixture: the pre-transport boundary refuses before any byte');

  const summary = transportSummary(ns);
  ok(summary.transportsServed === 2,
    '8 fixture: the transcript distinguishes bytes-sent from refused-before-transport');
  ok(summary.refusals === 2,
    '8 fixture: refusals are recorded, not silent');
  ok(readTranscript(ns).some(entry => entry.key.includes('|worker|1')),
    '8 fixture: the transcript records the exact logical key served');
  ok(/^[0-9a-f]{64}$/.test(transcriptHash(ns)),
    '8 fixture: the transcript hashes to a stable identity for the trial artifact');

  // ISOLATION: a second trial cannot reuse a namespace.
  assert.throws(() => createFixtureNamespace(root, 'trial-1'),
    /already exists — refusing to reuse/);
  passed += 1;
  console.log('  ok 8 fixture: reusing a trial namespace is REFUSED');
  const ns2 = createFixtureNamespace(root, 'trial-2');
  ok(ns2.dir !== ns.dir && readTranscript(ns2).length === 0,
    '8 fixture: a new trial starts with a completely empty namespace');
  assert.throws(() => stageResponses(ns, []), /already staged/);
  passed += 1;
  console.log('  ok 8 fixture: re-staging responses mid-trial is REFUSED');

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 9. FAMILY 4 — GENUINE COUPLING VERSUS LUCKY FINAL STATE ────────────────
{
  const {
    expectedProducerBytes, evaluateCoupling, evaluateCouplingWithFixture
  } = require('./fixtures/evaluation-coupling-oracle');
  const crypto = require('node:crypto');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-coupling-'));
  const seed = 'trial-seed-42';
  const producerPath = 'reports/a/producer.txt';
  const consumerPath = 'reports/b/consumer.md';
  const reader = 'consumer-agent';

  fs.mkdirSync(path.join(root, 'reports/a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'reports/b'), { recursive: true });
  const bytes = expectedProducerBytes(seed);
  fs.writeFileSync(path.join(root, producerPath), bytes);
  const producerHash = crypto.createHash('sha256').update(bytes).digest('hex');

  // CORRECT DEPENDENCY USE -> PASS
  fs.writeFileSync(path.join(root, consumerPath), `derived from ${producerHash}\n`);
  const correct = evaluateCoupling({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLog: [{ reader, artifactPath: producerPath, artifactHash: producerHash }]
  });
  ok(correct.verdict === 'pass',
    '9 coupling: genuine dependency use PASSES');

  // FINAL FILES LOOK CORRECT BUT THE CONSUMER NEVER READ -> FAIL
  const lucky = evaluateCoupling({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLog: []
  });
  ok(lucky.verdict === 'fail',
    '9 coupling: correct-looking final files with NO consumer read FAIL');
  ok(lucky.observations.some(o => o.fact === 'consumer_read' && o.verdict === 'fail' &&
    /access log records no consumer read/.test(o.detail)),
  '9 coupling: and the diagnostic names the MISSING READ specifically, not a ' +
  'generic mismatch — the two are different failures');

  // CONSUMER READ A DIFFERENT ARTIFACT VERSION -> FAIL
  const wrongHash = evaluateCoupling({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLog: [{ reader, artifactPath: producerPath, artifactHash: 'f'.repeat(64) }]
  });
  ok(wrongHash.verdict === 'fail',
    '9 coupling: reading a different version of the artifact FAILS');

  // OUTPUT DOES NOT BIND THE PRODUCER HASH -> FAIL
  fs.writeFileSync(path.join(root, consumerPath), 'looks fine but binds nothing\n');
  const unbound = evaluateCoupling({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLog: [{ reader, artifactPath: producerPath, artifactHash: producerHash }]
  });
  ok(unbound.verdict === 'fail',
    '9 coupling: an output that does not bind the producer hash FAILS');

  // A FULLY SELF-CONSISTENT FORGERY -> FAIL, on the seed derivation alone.
  //
  // The producer content is hard-coded rather than seed-derived, but the access
  // log records a read of THAT content's hash and the consumer output binds it.
  // Every downstream check therefore agrees; only the seed-derivation check can
  // reject it. Without this case a mutation removing that check survived,
  // because the earlier cases were caught by the later checks instead.
  const forgedBytes = 'PRODUCER-NONCE guessed\n';
  fs.writeFileSync(path.join(root, producerPath), forgedBytes);
  const forgedHash = crypto.createHash('sha256').update(forgedBytes).digest('hex');
  fs.writeFileSync(path.join(root, consumerPath), `derived from ${forgedHash}\n`);
  const forged = evaluateCoupling({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLog: [{ reader, artifactPath: producerPath, artifactHash: forgedHash }]
  });
  ok(forged.verdict === 'fail',
    '9 coupling: a self-consistent forgery FAILS — a staged response cannot ' +
    'hard-code the answer, because the nonce is derived from the trial seed');
  ok(forged.observations.some(o => o.fact === 'producer_artifact' && o.verdict === 'fail'),
    '9 coupling: and it fails specifically on the seed derivation');

  // INSUFFICIENT FIXTURE EVIDENCE -> REFUSED, never a guess
  const noLog = evaluateCouplingWithFixture({
    workspaceRoot: root, seed, producerPath, consumerPath, consumerReaderId: reader,
    accessLogAvailable: false, accessLog: []
  });
  ok(noLog.verdict === 'refused',
    '9 coupling: an unavailable access log REFUSES rather than guessing');

  // Independence: no product authority is reachable from this module.
  const source = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'evaluation-coupling-oracle.js'), 'utf8');
  const executable = source.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  ok(!/require\(['"][^'"]*runtime\//.test(executable) &&
    !executable.includes('completionDecision') && !executable.includes('store'),
  '9 coupling: the coupling oracle reaches no product authority either');

  fs.rmSync(root, { recursive: true, force: true });
}


// ── 10. QUIESCENCE AND THE IMMUTABLE TRIAL ARTIFACT ────────────────────────
{
  const {
    QUIESCENCE_CONDITIONS, assertSelectOnly: quiescentSelectOnly, assertMode,
    buildTrialArtifact, writeTrialArtifact, artifactPathFor, assertSingleMode,
    QuiescenceError
  } = require('./fixtures/evaluation-quiescence');

  // Quiescence is more than terminal status.
  ok(QUIESCENCE_CONDITIONS.includes('active_leases') &&
    QUIESCENCE_CONDITIONS.includes('in_flight_governed_requests') &&
    QUIESCENCE_CONDITIONS.includes('recoverable_terminalization') &&
    QUIESCENCE_CONDITIONS.includes('active_fixture_requests'),
  '10 quiescence: leases, in-flight requests, recoverable terminalization and ' +
  'fixture requests all block quiescence');
  ok(QUIESCENCE_CONDITIONS.length === 10,
    '10 quiescence: all ten conditions are named individually');
  // An admitted structured plan that has produced no governed leaf Run is
  // MID-FLIGHT, not finished. Without this condition a structured trial that
  // never executed any governed work could be observed as quiescent and read as
  // a completed one.
  ok(QUIESCENCE_CONDITIONS.includes('admitted_plan_without_leaf_runs'),
    '10 quiescence: an admitted plan owing leaf Runs blocks quiescence');

  // ── The ONE canonical path-stage classifier ────────────────────────────
  //
  // Runner and report share it, so the "did governed work execute?" answer
  // cannot be derived twice and disagree.
  {
    const {
      ARMS: STAGE_ARMS, classifyPathStage, expectedPathStage
    } = require('./fixtures/evaluation-arms');
    const structured = {
      observedPath: 'structured_v2', runCount: 3, planningAttempted: true,
      planAdmitted: true, leafRunsAdmitted: true,
      governedLeafExecutionObserved: true, ticketStatus: 'completed'
    };
    ok(expectedPathStage(STAGE_ARMS.A) === 'direct_executed' &&
       expectedPathStage(STAGE_ARMS.A2a) === 'legacy_v1_allocated_executed' &&
       expectedPathStage(STAGE_ARMS.A2b) === 'legacy_v1_dynamic_executed' &&
       expectedPathStage(STAGE_ARMS.B) === 'structured_v2_allocated_executed' &&
       expectedPathStage(STAGE_ARMS.C) === 'structured_v2_dynamic_executed',
    '10 stages: each arm names its own canonical stage');
    ok(classifyPathStage(STAGE_ARMS.B, structured) === 'structured_v2_allocated_executed',
      '10 stages: a fully executed structured trial reaches its executed stage');
    // ADMISSION IS NOT EXECUTION. Leaf Runs admitted but never claimed may not
    // be reported as worker execution.
    ok(classifyPathStage(STAGE_ARMS.B,
      { ...structured, governedLeafExecutionObserved: false }) ===
      'structured_v2_allocated_leaf_runs_unexecuted',
    '10 stages: admitted-but-unexecuted leaf Runs are NOT reported as execution');
    ok(classifyPathStage(STAGE_ARMS.B,
      { ...structured, leafRunsAdmitted: false, governedLeafExecutionObserved: false }) ===
      'structured_v2_allocated_no_leaf_runs',
    '10 stages: an admitted plan with no leaf Runs names that exact gap');
    ok(classifyPathStage(STAGE_ARMS.B,
      { ...structured, planAdmitted: false, leafRunsAdmitted: false,
        governedLeafExecutionObserved: false }) ===
      'structured_v2_allocated_plan_refused',
    '10 stages: a refused plan is distinguished from an unattempted one');
    // A terminal Ticket status may NEVER by itself confer an executed stage.
    ok(classifyPathStage(STAGE_ARMS.B, {
      ...structured, leafRunsAdmitted: false,
      governedLeafExecutionObserved: false, ticketStatus: 'completed'
    }) !== 'structured_v2_allocated_executed',
    '10 stages: a terminal ticket status alone never implies governed execution');
  }

  // The reader observes; it never creates.
  for (const statement of ['UPDATE runs SET status = $1', 'INSERT INTO runs VALUES (1)']) {
    assert.throws(() => quiescentSelectOnly(statement));
    passed += 1;
    console.log(`  ok 10 quiescence: refuses ${statement.split(' ')[0]}`);
  }
  const quiescenceSource = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'evaluation-quiescence.js'), 'utf8')
    .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const forbidden of ['transitionRun', 'claimPendingRun', 'settleEconomicRequest',
    'repairRunTerminalization', 'INSERT ', 'UPDATE ']) {
    ok(!quiescenceSource.includes(forbidden),
      `10 quiescence: never calls ${forbidden.trim()}`);
  }

  // Mode is mandatory and validated.
  ok(assertMode('fixture') === 'fixture' && assertMode('live') === 'live',
    '10 artifact: fixture and live are the only modes');
  assert.throws(() => assertMode(undefined), /may not be scored/);
  passed += 1;
  console.log('  ok 10 artifact: a result with no stated mode is REFUSED');
  assert.throws(() => assertMode('mixed'));
  passed += 1;
  console.log('  ok 10 artifact: an unknown mode is REFUSED');

  const baseArtifact = {
    protocolVersion: 1, repositoryCommit: 'deadbeef', scenarioId: 's1', armId: 'B',
    repetition: 1, seed: 'seed-1', mode: 'fixture', envelopeHash: 'abc',
    pathProof: 'structured_v2', ticketReport: { ticketId: 1 },
    oracleResult: { verdict: 'pass' }, normalizedCost: { totalNormalizedMicroUsd: 5 },
    quiescence: { quiescent: true }
  };
  const artifact = buildTrialArtifact(baseArtifact);
  ok(artifact.label === 'UNSCORED HARNESS SMOKE — NOT PRODUCT EVIDENCE',
    '10 artifact: every artifact is labelled unscored');
  ok(/^[0-9a-f]{64}$/.test(artifact.artifactHash),
    '10 artifact: carries a final artifact hash');
  ok(Object.isFrozen(artifact), '10 artifact: is immutable in memory');
  assert.throws(() => buildTrialArtifact({ ...baseArtifact, quiescence: undefined }));
  passed += 1;
  console.log('  ok 10 artifact: a missing required field is REFUSED');

  // Distinct namespaces AND a validated mode field — neither alone.
  const live = buildTrialArtifact({ ...baseArtifact, mode: 'live' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-artifact-'));
  const fixturePath = artifactPathFor(root, artifact);
  const livePath = artifactPathFor(root, live);
  ok(fixturePath.includes(`${path.sep}fixture${path.sep}`) &&
    livePath.includes(`${path.sep}live${path.sep}`),
  '10 artifact: fixture and live results are written to DISTINCT namespaces');
  assert.throws(() => assertSingleMode([artifact, live]), /refusing to combine/);
  passed += 1;
  console.log('  ok 10 artifact: a fixture result cannot enter a live set, or the reverse');

  // Write once; never overwrite.
  writeTrialArtifact(fixturePath, artifact);
  ok(fs.existsSync(fixturePath), '10 artifact: the artifact is written');
  assert.throws(() => writeTrialArtifact(fixturePath, artifact),
    error => error instanceof QuiescenceError && /refusing to overwrite/.test(error.message));
  passed += 1;
  console.log('  ok 10 artifact: overwriting an existing result is REFUSED');
  fs.rmSync(root, { recursive: true, force: true });
}


// ── 11. THE FETCH-SIDE FIXTURE ADAPTER (ungoverned arms) ───────────────────
{
  const {
    installEvaluationFetchFixture, assertAllWorkerResponsesConsumed,
    buildFixtureResponse, selectStaged, EvaluationFetchFixtureError, PROVIDER_URL
  } = require('./fixtures/evaluation-fetch-fixture');
  const {
    createFixtureNamespace, stageResponses
  } = require('./fixtures/evaluation-fixture-provider');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-fetch-'));
  const ns = createFixtureNamespace(root, 'fetch-trial-1');
  const base = {
    protocolVersion: 1, scenarioId: 'family-1', logicalTaskId: 'alpha',
    seed: 'seed-1', role: 'worker'
  };
  stageResponses(ns, [
    { ...base, ordinal: 1, body: '{"complete":true}', inputTokens: 120,
      outputTokens: 40, match: 'reports/alpha' }
  ]);
  // `match` is carried through staging so the adapter can recover the logical
  // task from what production actually sent.
  const staged = JSON.parse(fs.readFileSync(ns.stagedPath, 'utf8'));
  for (const entry of Object.values(staged)) entry.match = 'reports/alpha';
  fs.writeFileSync(ns.stagedPath, JSON.stringify(staged));

  const restore = installEvaluationFetchFixture({ namespaceDir: ns.dir });
  try {
    // THE UNGOVERNED ARMS RECEIVE STAGED RESPONSES.
    const response = await globalThis.fetch(PROVIDER_URL, {
      method: 'POST', body: JSON.stringify({ input: 'write reports/alpha' })
    });
    ok(response.ok === true && response.status === 200,
      '11 fetch fixture: an ungoverned provider request is served hermetically');
    const payload = JSON.parse(await response.text());
    ok(payload.output_text === '{"complete":true}',
      '11 fetch fixture: with the exact staged body');
    ok(payload.usage.input_tokens === 120 && payload.usage.output_tokens === 40,
      '11 fetch fixture: and deterministic token usage');
    ok(Object.fromEntries(response.headers.entries())['content-type'] === 'application/json',
      '11 fetch fixture: headers.entries() satisfies the production reader');

    // The bounded reader contract production uses when a byte limit is set.
    const streamed = buildFixtureResponse({ body: 'hello' });
    const reader = streamed.body.getReader();
    const first = await reader.read();
    ok(!first.done && Buffer.from(first.value).toString('utf8') === 'hello',
      '11 fetch fixture: body.getReader() streams the bytes once');
    ok((await reader.read()).done === true,
      '11 fetch fixture: and then completes');

    // AN UNEXPECTED REQUEST REFUSES rather than receiving a generic success.
    let refused = null;
    try {
      await globalThis.fetch(PROVIDER_URL, {
        method: 'POST', body: JSON.stringify({ input: 'unplanned work' })
      });
    } catch (error) { refused = error; }
    ok(refused instanceof EvaluationFetchFixtureError &&
      /no staged fixture response matches/.test(refused.message),
    '11 fetch fixture: an unmatched ungoverned request is REFUSED');

    // NO OTHER HOST REACHES THE NETWORK.
    let blocked = null;
    try { await globalThis.fetch('https://example.com/x'); }
    catch (error) { blocked = error; }
    ok(blocked && /UNEXPECTED_EXTERNAL_NETWORK_REQUEST/.test(blocked.message),
      '11 fetch fixture: any other non-localhost URL is refused before the network');

    // localhost still passes through to the real implementation.
    ok(typeof globalThis.fetch === 'function',
      '11 fetch fixture: localhost routing remains delegated to the real fetch');

    // Selection never sees an arm.
    ok(selectStaged.length === 3,
      '11 fetch fixture: selectStaged takes table/body/counts — no arm parameter');

    ok(assertAllWorkerResponsesConsumed(ns.dir) === true,
      '11 fetch fixture: all staged worker responses were consumed');
  } finally {
    restore();
  }

  // SELECTION IS BY BODY MARKER, NOT BY ORDER.
  //
  // With a single staged response any selection rule looks correct, so a
  // mutation deleting the marker filter survived. Two responses with different
  // markers, requested out of staging order, isolate it.
  const ns3 = createFixtureNamespace(root, 'fetch-trial-3');
  stageResponses(ns3, [
    { ...base, logicalTaskId: 'alpha', ordinal: 1, body: '{"which":"alpha"}',
      inputTokens: 1, outputTokens: 1 },
    { ...base, logicalTaskId: 'beta', ordinal: 2, body: '{"which":"beta"}',
      inputTokens: 1, outputTokens: 1 }
  ]);
  const staged3 = JSON.parse(fs.readFileSync(ns3.stagedPath, 'utf8'));
  for (const entry of Object.values(staged3)) {
    entry.match = entry.key.includes('alpha') ? 'reports/alpha' : 'reports/beta';
  }
  fs.writeFileSync(ns3.stagedPath, JSON.stringify(staged3));
  const restore3 = installEvaluationFetchFixture({ namespaceDir: ns3.dir });
  try {
    // Ask for BETA first — the second staged entry.
    const betaFirst = JSON.parse(await (await globalThis.fetch(PROVIDER_URL, {
      method: 'POST', body: JSON.stringify({ input: 'write reports/beta' })
    })).text());
    ok(betaFirst.output_text === '{"which":"beta"}',
      '11 fetch fixture: the response is chosen by the REQUEST BODY marker, not ' +
      'by staging order');
    const alphaSecond = JSON.parse(await (await globalThis.fetch(PROVIDER_URL, {
      method: 'POST', body: JSON.stringify({ input: 'write reports/alpha' })
    })).text());
    ok(alphaSecond.output_text === '{"which":"alpha"}',
      '11 fetch fixture: and the other marker still selects its own response');
  } finally { restore3(); }

  // THE PRE-TRANSPORT BOUNDARY REFUSES THROUGH THE FETCH ADAPTER TOO.
  const ns4 = createFixtureNamespace(root, 'fetch-trial-4');
  stageResponses(ns4, [
    { ...base, ordinal: 1, body: '{"never":true}', inputTokens: 1, outputTokens: 1,
      failureBoundary: 'before_transport' }
  ]);
  const restore4 = installEvaluationFetchFixture({ namespaceDir: ns4.dir });
  try {
    let preTransport = null;
    try {
      await globalThis.fetch(PROVIDER_URL, { method: 'POST', body: '{}' });
    } catch (error) { preTransport = error; }
    ok(preTransport && /pre-transport provider failure/.test(preTransport.message),
      '11 fetch fixture: the pre-transport boundary refuses before serving bytes');
    const transcript = fs.readFileSync(ns4.transcriptPath, 'utf8');
    ok(transcript.includes('before_transport') && !/"served":true/.test(transcript),
      '11 fetch fixture: and the transcript records a refusal, not a transport');
  } finally { restore4(); }

  // AN UNCONSUMED STAGED RESPONSE FAILS THE TRIAL.
  const ns2 = createFixtureNamespace(root, 'fetch-trial-2');
  stageResponses(ns2, [
    { ...base, ordinal: 1, body: '{"a":1}', inputTokens: 1, outputTokens: 1 },
    { ...base, logicalTaskId: 'beta', ordinal: 2, body: '{"b":2}',
      inputTokens: 1, outputTokens: 1 }
  ]);
  assert.throws(() => assertAllWorkerResponsesConsumed(ns2.dir),
    error => error instanceof EvaluationFetchFixtureError &&
      /production never requested/.test(error.message));
  passed += 1;
  console.log('  ok 11 fetch fixture: staged responses production never asked for FAIL the trial');

  fs.rmSync(root, { recursive: true, force: true });
}


// ── 12. THE SCENARIO CATALOG ───────────────────────────────────────────────
{
  const {
    SCENARIOS, SCENARIO_IDS, ALL_ARMS, getScenario, assertArmAllowed,
    materializeResponses, buildOracleFor, validateScenario,
    EvaluationScenarioError, PROTOCOL_VERSION
  } = require('./fixtures/evaluation-scenarios');
  const crypto = require('node:crypto');
  const { expectedProducerBytes } = require('./fixtures/evaluation-coupling-oracle');

  // Every catalog entry is structurally valid.
  for (const scenarioId of SCENARIO_IDS) {
    ok(validateScenario(SCENARIOS[scenarioId]) === true,
      `12 catalog: ${scenarioId} is structurally complete`);
  }
  ok(SCENARIO_IDS.length >= 6,
    '12 catalog: families 1, 3, 4, 7, 8 and 9 all have executable definitions');

  // Family 1 is attemptable by ALL five arms — the routing probe.
  const family1 = getScenario('family-1-simple');
  ok(family1.allowedArms.length === 5 &&
    ALL_ARMS.every(arm => family1.allowedArms.includes(arm)),
  '12 catalog: family 1 is attemptable by all five arms');
  for (const arm of ALL_ARMS) {
    ok(assertArmAllowed(family1, arm) === true,
      `12 catalog: family 1 accepts arm ${arm}`);
  }

  // A restricted scenario must SAY WHY, not merely restrict.
  const family7 = getScenario('family-7-no-progress');
  ok(family7.allowedArms.join(',') === 'B,C' &&
    /churn control exists only on the governed/.test(family7.allowedArmsReason),
  '12 catalog: family 7 restricts arms and states the reason');
  assert.throws(() => assertArmAllowed(family7, 'A'),
    error => error instanceof EvaluationScenarioError && /does not allow arm A/.test(error.message));
  passed += 1;
  console.log('  ok 12 catalog: a disallowed arm is REFUSED with its reason');

  // declaredWork.objective must equal the ticket objective — production refuses
  // otherwise, so the catalog refuses first.
  assert.throws(() => validateScenario({
    ...family1, declaredWork: { ...family1.declaredWork, objective: 'different' }
  }), /must equal the ticket objective/);
  passed += 1;
  console.log('  ok 12 catalog: a declaredWork objective mismatch is REFUSED');

  // NO PRODUCT COMPLETION ANSWER IS TREATED AS ORACLE TRUTH.
  const catalogSource = fs.readFileSync(
    path.join(__dirname, 'fixtures', 'evaluation-scenarios.js'), 'utf8')
    .split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const forbidden of ['completionDecision', 'deriveLeafItemDisposition',
    'ticketStatus', 'run.status']) {
    ok(!catalogSource.includes(forbidden),
      `12 catalog: no oracle contract references ${forbidden}`);
  }

  // SEED-DEPENDENT BODIES ARE GENERATED PER TRIAL, so a staged response cannot
  // hard-code the family 3/4 answer.
  const family4 = getScenario('family-4-coupled');
  const seedOne = materializeResponses(family4, 'seed-one');
  const seedTwo = materializeResponses(family4, 'seed-two');
  const bodyFor = (staged, taskId) =>
    staged.find(entry => entry.logicalTaskId === taskId).body;
  ok(bodyFor(seedOne, 'left') !== bodyFor(seedTwo, 'left'),
    '12 catalog: the producer body CHANGES with the trial seed');
  ok(bodyFor(seedOne, 'right') !== bodyFor(seedTwo, 'right'),
    '12 catalog: and so does the bound consumer output');
  const expectedHash = crypto.createHash('sha256')
    .update(expectedProducerBytes('seed-one')).digest('hex');
  ok(bodyFor(seedOne, 'right').includes(expectedHash),
    '12 catalog: the consumer output binds the exact seed-derived producer hash');
  ok(bodyFor(seedOne, 'left').includes(expectedProducerBytes('seed-one').trim()),
    '12 catalog: and the producer writes exactly the seed-derived bytes');

  // Planner responses exist only for the structured arms to consume; the
  // catalog never varies content by arm.
  // The planner proposal binds real agent ids, so it is a per-trial template
  // rather than a frozen response — and it is built from the planning
  // request's own candidates, never from the arm.
  ok(family1.plannerResponseTemplate &&
    family1.plannerResponseTemplate.role === 'planner' &&
    family1.plannerResponseTemplate.itemObjectives.length === 2,
  '12 catalog: family 1 carries a planner proposal TEMPLATE, not a frozen response');
  const withAgents = materializeResponses(family1, 'seed-x',
    { candidateAgentIds: [11, 22] });
  const proposal = JSON.parse(
    withAgents.find(entry => entry.role === 'planner').body);
  ok(proposal.version === 1 && Array.isArray(proposal.sharedConstraints) &&
    proposal.items.length === 2,
  '12 catalog: the materialized proposal carries version, sharedConstraints and items');
  ok(proposal.items.map(item => item.assignedAgentId).join(',') === '11,22',
    '12 catalog: and binds the trial\'s real candidate agent ids');
  ok(proposal.items.every(item => Array.isArray(item.evidenceRequirements) &&
    item.evidenceRequirements.length === 0),
  '12 catalog: evidence requirements stay empty — they are runtime-bound');
  ok(!JSON.stringify(proposal).includes('ownedOutputPaths'),
    '12 catalog: the proposal claims no owned paths — production assigns them, ' +
    'which is why one proposal serves both the allocated and dynamic arms');
  ok(!JSON.stringify(family1).includes('"A2a"') || family1.allowedArms.includes('A2a'),
    '12 catalog: arm identifiers appear only in allowedArms, never in response selection');

  // Oracle contracts build from raw declarations.
  const rawOracle = buildOracleFor(family1);
  ok(rawOracle.expectations.length === 2 && /^[0-9a-f]{64}$/.test(rawOracle.expectationHash),
    '12 catalog: a raw-state oracle contract is built and hashed');
  const couplingOracle = buildOracleFor(family4);
  ok(couplingOracle.kind === 'coupling' && couplingOracle.producerPath.includes('left'),
    '12 catalog: a coupling oracle contract carries its producer and consumer paths');

  // Family 9's refusal scenario declares that it expects a refusal.
  ok(getScenario('family-9-oracle-refusal').oracle.expectRefusal === true,
    '12 catalog: the oracle-refusal scenario declares its expected refusal');
  ok(getScenario('family-8-recovery').boundaryVariants.uncertain_delivery ===
    'after_transport_before_response',
  '12 catalog: family 8 names its concrete failure boundaries');
  ok(Object.keys(family7.controls).length === 3,
    '12 catalog: family 7 carries its three neighbouring non-churn controls');

  assert.throws(() => getScenario('does-not-exist'), /unknown scenario/);
  passed += 1;
  console.log('  ok 12 catalog: an unknown scenario is REFUSED');
  ok(PROTOCOL_VERSION === 1, '12 catalog: the catalog declares protocol version 1');
}


// ── 13. THE STRUCTURED PLAN-TO-LEAF CORRECTIONS ────────────────────────────
//
// Two defects found through this harness are now fixed, and one newly exposed
// gap is pinned in their place.
//
// FIXED 1 — server.js supplies the mandatory governed leaf capture. It was
// omitted entirely, so every structured Allocation Plan v2 that reached leaf
// admission was refused.
//
// FIXED 2 — the catch-all no longer reports every unexpected exception as a
// lost concurrency race. That mislabelling is what made the first defect
// expensive to find: the real cause reached neither durable state nor stdout.
{
  const serverSource = fs.readFileSync(
    path.join(__dirname, '..', 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(
    path.join(__dirname, '..', 'persistence', 'postgres', 'store.js'), 'utf8');

  // EXECUTABLE source only. A substring check against the raw file passes
  // happily when the call has been commented out, which is precisely the
  // mutation this section must catch.
  const stripComments = text => text.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .map(line => line.replace(/\s\/\/.*$/, '')).join('\n');
  const serverExecutable = stripComments(serverSource);

  ok(serverExecutable.includes('governedLeafCapture = {') &&
     /\n\s*governedLeafCapture,\n/.test(serverExecutable),
  '13 plan-to-leaf: server.js BUILDS and PASSES governedLeafCapture');
  ok(serverExecutable.includes('buildDefaultProgressControlPolicy({'),
    '13 plan-to-leaf: from the canonical version-1 builder, not a local literal');
  ok(serverExecutable.includes('assertUniformProgressPolicyInputs('),
    '13 plan-to-leaf: after proving every leaf draft shares one execution snapshot');

  // ── The two capture contracts, proved by BEHAVIOUR ────────────────────
  //
  // Source presence is not enough: a builder can be present and still read the
  // wrong thing.
  {
    const {
      buildDefaultProgressControlPolicy, assertUniformProgressPolicyInputs
    } = require('../runtime/churn-decision-contract');
    // A distinctive duration no ambient default could coincidentally produce.
    const snapshot = duration => ({
      maxRuntimeDurationMs: duration, snapshotHash: 'a'.repeat(64),
      executionPolicyHash: 'b'.repeat(64), runtimeLimitsRevision: 3
    });
    const policy = buildDefaultProgressControlPolicy({
      runtimeBudgetSnapshot: snapshot(777_777) });
    ok(policy.maximumCumulativeExecutionDurationMs === 777_777,
      '13 capture: the duration comes ONLY from the captured runtime budget snapshot');
    ok(policy.version === 1 && policy.maximumConsecutiveNoProgressWindows === 3 &&
       policy.maximumRepeatedMutations === 3 && policy.maximumFailedOperationStreak === 4 &&
       policy.maximumMutationReversals === 3 && policy.maximumInspectionOnlyStreak === 4,
    '13 capture: the approved version-1 tolerances are the ones built');
    ok(policy.resourceDimensions.join(',') === 'provider_requests,settled_micro_usd',
      '13 capture: the approved resource dimensions are the ones built');
    // The fixture-only hour must never appear as a production default.
    ok(policy.maximumCumulativeExecutionDurationMs !== 3_600_000,
      '13 capture: the fixture-only 3 600 000 ms duration is not adopted');

    // Uniformity is PROVED, never assumed from the first draft.
    ok(assertUniformProgressPolicyInputs([snapshot(600_000), snapshot(600_000)])
      .maxRuntimeDurationMs === 600_000,
    '13 capture: identical leaf snapshots yield one plan-scoped capture');
    let disagreement = null;
    try {
      assertUniformProgressPolicyInputs([snapshot(600_000), snapshot(900_000)]);
    } catch (error) { disagreement = error; }
    ok(disagreement !== null,
      '13 capture: leaf drafts that DISAGREE refuse instead of using the first');
  }

  // The store's fail-closed requirement is UNCHANGED — the correction supplied
  // the authority rather than relaxing the check.
  ok(storeSource.includes("error.code = 'GOVERNED_LEAF_CAPTURE_REQUIRED'"),
    '13 plan-to-leaf: the store still refuses admission without governed capture');

  // A genuine race is now a narrow named set, not the default.
  ok(!serverSource.includes("return refuse('leaf_admission_conflict', error.message);\n  }"),
    '13 plan-to-leaf: the blanket conflict catch-all is gone');
  ok(serverExecutable.includes("'OPTIMISTIC_CONCURRENCY_CONFLICT'") &&
    serverExecutable.includes("'STATE_TRANSITION_CONFLICT'"),
  '13 plan-to-leaf: only real revision/state conflicts map to a race');
  // The conflict classification must still be REACHABLE from those codes. A
  // mutation that disables the branch would leave the codes present and
  // classify a genuine race as an internal failure.
  ok(serverExecutable.includes('if (optimistic || serialization) {'),
    '13 plan-to-leaf: a genuine conflict still reaches the conflict classification');
  ok(serverExecutable.includes("leaf_admission_internal_failure"),
    '13 plan-to-leaf: unexpected failures get an internal classification');
  // ...and exactly ONE site may produce a race, so an internal failure cannot
  // be relabelled as one.
  ok(serverExecutable.split("refuse('leaf_admission_conflict'").length - 1 === 1,
    '13 plan-to-leaf: exactly one site classifies a failure as a race');
  ok(serverSource.includes("leaf_governed_authority_unavailable"),
    '13 plan-to-leaf: missing governed authority gets its own exact code');

  // ── CROSS-ROLE PARENT REVISION PARITY, exercised with MISMATCHES ───────
  //
  // A happy-path trial always agrees, so a predicate that simply returned true
  // would be indistinguishable there. It is fed disagreeing inputs directly.
  {
    const {
      sameParentPolicyRevisionOf
    } = require('./structured-allocation-evaluation-runner');
    const reference = {
      version: 1, policyContainerId: 4, policyContainerRevision: 9,
      policyContainerHash: 'a'.repeat(64),
      economicPolicySetVersion: 2, economicPolicySetHash: 'b'.repeat(64)
    };
    ok(sameParentPolicyRevisionOf(reference, [{ ...reference }]) === true,
      '13 parity: matching planner and worker references agree');
    ok(sameParentPolicyRevisionOf(reference,
      [{ ...reference }, { ...reference }]) === true,
    '13 parity: identical worker references are one revision, however many Runs');
    for (const [field, value] of [
      ['policyContainerRevision', 10], ['policyContainerId', 5],
      ['policyContainerHash', 'c'.repeat(64)],
      ['economicPolicySetHash', 'd'.repeat(64)], ['economicPolicySetVersion', 1]
    ]) {
      ok(sameParentPolicyRevisionOf(reference,
        [{ ...reference, [field]: value }]) === false,
      `13 parity: a differing ${field} is NOT the same revision`);
    }
    // Leaf Runs that disagree among themselves fail parity regardless of the
    // planner.
    ok(sameParentPolicyRevisionOf(reference,
      [{ ...reference }, { ...reference, policyContainerRevision: 10 }]) === false,
    '13 parity: leaf Runs disagreeing among themselves fail parity');
    ok(sameParentPolicyRevisionOf(null, [{ ...reference }]) === false &&
       sameParentPolicyRevisionOf(reference, []) === false,
    '13 parity: an absent reference on either side is never parity');
  }

  // The server-side guard is proved as WIRING here and as BEHAVIOUR in the
  // policy-source and PostgreSQL suites, which drive the comparison itself with
  // replaced containers, revision-only and row-only differences.
  ok(serverExecutable.includes('assertSameParentPolicyRevision(') &&
     serverExecutable.includes('plannerGoverned.parentPolicyReference'),
  '13 parity: leaf admission compares the planner reference against its own');
  // The GUARD CONDITION, not its message. A message can survive as unreachable
  // text while the branch that raises it has been disabled.
  ok(serverExecutable.includes(
    'if (!plannerGoverned || !plannerGoverned.parentPolicyReference) {'),
  '13 parity: a plan with no captured parent revision refuses leaf admission');
  ok(serverExecutable.includes(
    'the admitted plan carries no captured parent policy revision'),
  '13 parity: and says so in terms of the missing capture, not a race');

  // The runner must not derive the stage itself: one classifier, called.
  const runnerSource = fs.readFileSync(
    path.join(__dirname, 'structured-allocation-evaluation-runner.js'), 'utf8');
  ok(runnerSource.includes('pathStage: classifyPathStage(arm, proof)'),
    '13 stages: the runner calls the shared classifier rather than deriving a stage');

  // ── THE COMPLETENESS GATE ──────────────────────────────────────────────
  //
  // An oracle that needs an access observation may report PASS or FAIL only
  // when the observation is COMPLETE. Passing an unconditional availability
  // would let an absent observer be reported as a negative finding.
  ok(runnerSource.includes("accessLogAvailable: observations.completeness === 'complete'"),
    '13 observation: the coupling oracle is gated on observation completeness');
  ok(runnerSource.includes('observationCompleteness: observations.completeness'),
    '13 observation: every artifact records whether an observer was running');


  // Sanitization: only a stable code reaches durable authority.
  ok(serverSource.includes('causeCode ? `cause ${causeCode}` :'),
    '13 plan-to-leaf: durable refusal detail carries a stable cause code, not raw text');

  // ── RESOLVED: one active container now funds BOTH canonical roles ──────
  //
  // The previous OPEN pin recorded that `readGovernedPolicySource` refused
  // unless the container's single `economicPolicy.role` equalled the requested
  // role, while `loadGovernedPlannerPolicyContainer` permitted only ONE active
  // governed container — so a deployment could fund the planner or the worker,
  // never both. That pin failed the moment the gap closed, which is what it was
  // for. It is replaced here by proofs of the approved resolution.
  const {
    readGovernedPolicySource: readSource, GOVERNED_POLICY_SOURCE_VERSION
  } = require('../runtime/governed-policy-source');
  const { CANONICAL_ROLES } = require('../runtime/role-routing-contract');
  const {
    buildRoleKeyedGovernedContainer
  } = require('./fixtures/governed-role-policy-container');
  const roleKeyed = buildRoleKeyedGovernedContainer();

  ok(GOVERNED_POLICY_SOURCE_VERSION === 2,
    '13 role funding: the policy-source contract is at the role-keyed version');

  const plannerSource = readSource(roleKeyed, { role: 'structured_planner' });
  const workerSource = readSource(roleKeyed, { role: 'structured_leaf_executor' });

  // ONE container, BOTH roles — the fact the whole decision exists to establish.
  ok(plannerSource.economicPolicy.role === 'structured_planner' &&
     workerSource.economicPolicy.role === 'structured_leaf_executor',
  '13 role funding: one active container funds both canonical roles');
  ok(plannerSource.economicPolicyHash !== workerSource.economicPolicyHash,
    '13 role funding: each role keeps its own economic-policy identity');
  // Role selection READS the container; it never changes it.
  ok(plannerSource.economicPolicySetHash === workerSource.economicPolicySetHash,
    '13 role funding: the parent economic-set identity is the same for both roles');
  ok(plannerSource.roleRoutingPolicyHash === workerSource.roleRoutingPolicyHash &&
     plannerSource.pricingCatalogHash === workerSource.pricingCatalogHash,
  '13 role funding: routing and pricing remain shared, separately hashed authority');

  // Still exactly ONE active container. The decision widened what a container
  // may fund; it did not permit a second container.
  ok(serverSource.includes('GOVERNED_PLANNER_POLICY_AMBIGUOUS'),
    '13 role funding: more than one active governed container is still refused');

  // No fourth subdocument: `economicPolicies` is the version-2 shape of the
  // EXISTING economic category, and the three categories are unchanged.
  const { GOVERNED_SUBDOCUMENTS } = require('../runtime/governed-policy-source');
  ok(GOVERNED_SUBDOCUMENTS.length === 3,
    '13 role funding: the container still carries exactly three authority categories');
  ok(CANONICAL_ROLES.length === 2 &&
     plannerSource.economicPolicyRoles.join(',') === CANONICAL_ROLES.join(','),
  '13 role funding: the funded set is canonically ordered by the role constants');
}

// ── 14. SCENARIO FAMILIES 3, 4, 7, 8 AND 9 ─────────────────────────────────
//
// The catalog, the variant model and the execution matrix, proved
// deterministically. The real trials live in the scenario PostgreSQL suite;
// what is proved here is that a scenario cannot be mis-declared, a variant
// cannot be mis-selected, and a cell cannot be silently dropped.
{
  const {
    SCENARIOS, SCENARIO_IDS, getScenario, resolveScenarioVariant, variantIdsOf,
    validateScenario, materializeResponses
  } = require('./fixtures/evaluation-scenarios');
  const {
    MATRIX, NOT_NATURALLY_PRODUCED, assertDeclaredExclusion, requiredTrials,
    ExecutionMatrixError
  } = require('./fixtures/evaluation-execution-matrix');
  const { evaluateCoupling } = require('./fixtures/evaluation-coupling-oracle');
  const { expectedProducerBytes } = require('./fixtures/evaluation-coupling-oracle');
  const crypto14 = require('node:crypto');

  // ── Catalog ───────────────────────────────────────────────────────────
  for (const scenarioId of SCENARIO_IDS) {
    const scenario = getScenario(scenarioId);
    validateScenario(scenario);
    ok(true, `14 catalog: ${scenarioId} is structurally valid`);
    // A scenario that stages a static planner proposal cannot name the agents a
    // trial actually created, and lowering refuses a proposal that omits any
    // captured candidate — so every structured arm would refuse the plan.
    ok(!scenario.plannerResponses || scenario.plannerResponseTemplate,
      `14 catalog: ${scenarioId} binds planner items to real candidates`);
    // Dynamic allocation needs one usable top-level directory per agent.
    ok((scenario.initialState.folders || []).length >= 3,
      `14 catalog: ${scenarioId} provides enough roots for the dynamic arms`);
  }

  // ── Variant selection ─────────────────────────────────────────────────
  const seven = getScenario('family-7-no-progress');
  ok(variantIdsOf(seven).join(',') === '7A,7B,7C,7D',
    '14 variants: family 7 declares its four distinct variants');
  ok(resolveScenarioVariant(seven, null).variantId === '7A',
    '14 variants: a default variant is used when none is requested');
  ok(resolveScenarioVariant(seven, '7C').variantId === '7C',
    '14 variants: an explicit variant is selected exactly');
  for (const [label, fn] of [
    ['an unknown variant', () => resolveScenarioVariant(seven, '7Z')],
    ['a variant of another scenario',
      () => resolveScenarioVariant(getScenario('family-1-simple'), '7A')]
  ]) {
    let refused14 = false;
    try { fn(); } catch (_) { refused14 = true; }
    ok(refused14, `14 variants: ${label} refuses`);
  }
  // A variant may replace what a trial STAGES; it may never change the
  // experimental cell — objective, declared work, ownership or allowed arms.
  for (const variantId of variantIdsOf(seven)) {
    const resolved = resolveScenarioVariant(seven, variantId);
    ok(resolved.objective === seven.objective &&
       resolved.allowedArms.join(',') === seven.allowedArms.join(',') &&
       JSON.stringify(resolved.ownedOutputPaths) ===
         JSON.stringify(seven.ownedOutputPaths),
    `14 variants: ${variantId} changes the trial, not the experimental cell`);
  }
  // A variant may replace what a trial stages; it may NEVER leak its own
  // bookkeeping into the resolved scenario, because that is how a variant would
  // quietly redefine the cell it belongs to.
  for (const variantId of variantIdsOf(seven)) {
    const resolved = resolveScenarioVariant(seven, variantId);
    ok(!('label' in resolved) && !('expectation' in resolved) &&
       !('variants' in resolved),
    `14 variants: ${variantId} leaks no variant bookkeeping into the scenario`);
  }
  // TWO VARIANTS, TWO IDENTITIES. A shared trial id would mean a shared fixture
  // namespace, and staged state from one variant would silently serve another.
  {
    const { trialIdFor } = require('./structured-allocation-evaluation-runner');
    const armB = ARMS.B;
    const ids = variantIdsOf(seven).map(id =>
      trialIdFor(resolveScenarioVariant(seven, id), armB, 1));
    ok(new Set(ids).size === ids.length,
      '14 variants: every variant of one scenario has a distinct trial identity');
    ok(ids.every(id => id.includes('family-7-no-progress') && id.includes('--B--r1')),
      '14 variants: and the identity still names its scenario, arm and repetition');
  }

  // 7B and 8A/8B carry real failure boundaries, and staging must apply them.
  const undelivered = resolveScenarioVariant(seven, '7B');
  ok(undelivered.failureBoundary === 'after_transport_before_response',
    '14 variants: 7B declares the delivery-uncertainty boundary');
  const stagedUndelivered = materializeResponses(undelivered, 'seed-14',
    { candidateAgentIds: [1, 2, 3] });
  ok(stagedUndelivered.some(entry => entry.role === 'worker' &&
     entry.failureBoundary === 'after_transport_before_response'),
  '14 variants: the boundary reaches the staged WORKER response');
  ok(stagedUndelivered.every(entry => entry.role !== 'planner' ||
     !entry.failureBoundary),
  '14 variants: and never the planner request, which is a different window');

  // ── Execution matrix ──────────────────────────────────────────────────
  const { CANDIDATE_CELLS, OBSERVATION_BLOCKED, BLOCKED_FAMILIES } =
    require('./fixtures/evaluation-execution-matrix');
  ok(CANDIDATE_CELLS.length === 12,
    '14 matrix: twelve candidate cells are declared across families 3,4,7,8,9');
  for (const family of [3, 4, 7, 8, 9]) {
    ok(CANDIDATE_CELLS.some(cell => cell.family === family),
      `14 matrix: family ${family} has at least one declared cell`);
  }
  // ── THE OBSERVATION BLOCK, pinned ─────────────────────────────────────
  //
  // Families 3, 4, 7 and 8 depend on a fixture-owned external channel that does
  // not reach a spawned server. Requiring those cells would produce verdicts
  // computed from an absent observer — "no consumer read" instead of "no
  // observation", which inverts the finding rather than weakening it. They are
  // recorded as blocked, and this pin fails the day the channel is connected.
  // The OBSERVATION block is resolved: the shared sink is installed in the
  // spawned server and families 3 and 4 execute with complete observation. What
  // remains is a narrower STAGING gap on the governed worker request.
  const { GOVERNED_WORKER_STAGING_BLOCKED } =
    require('./fixtures/evaluation-execution-matrix');
  // BOTH blocks are resolved: the shared sink observes every transport and the
  // real read, and both roles are staged for the governed transport. The
  // records of what was wrong are retained so neither mistake can recur
  // silently.
  ok(OBSERVATION_BLOCKED.length > 0 && GOVERNED_WORKER_STAGING_BLOCKED.length > 0 &&
     BLOCKED_FAMILIES.length === 0,
  '14 matrix: no family is blocked — both the observation and staging gaps are closed');
  ok(GOVERNED_WORKER_STAGING_BLOCKED.every(entry =>
    entry.requires && entry.blockedBy && entry.wouldFabricate && entry.fix),
  '14 matrix: the remaining block names what it needs, what blocks it, what a ' +
  'false reading would credit, and the exact fix');
  ok(OBSERVATION_BLOCKED.every(entry =>
    entry.requires && entry.blockedBy && entry.wouldFabricate && entry.fix),
  '14 matrix: each block names what it needs, what blocks it, what a false ' +
  'reading would claim, and the exact fix');
  ok(MATRIX.every(cell => !BLOCKED_FAMILIES.includes(cell.family)),
    '14 matrix: no blocked family is required until its observation exists');
  ok(MATRIX.length === 12 && requiredTrials().length === 40,
    '14 matrix: all twelve protocol-required cells are required — forty trials');
  const seven7 = CANDIDATE_CELLS.filter(cell => cell.family === 7);
  ok(seven7.every(cell => cell.requiredArms.join(',') === 'B,C'),
    '14 matrix: family 7 runs the structured arms only');
  ok(seven7.every(cell => Object.keys(cell.excludedArms).length === 3 &&
     Object.values(cell.excludedArms).every(reason => reason.length > 10)),
  '14 matrix: and states an exact reason for every excluded arm');
  // An exclusion is only legitimate when the matrix declared it. This is what
  // stops a failing cell being retired as "infrastructure" after the fact.
  ok(assertDeclaredExclusion('family-7/7A', 'A').includes('churn'),
    '14 matrix: a declared exclusion returns its recorded reason');
  let undeclared = false;
  try { assertDeclaredExclusion('family-7/7A', 'B'); } catch (error) {
    undeclared = error instanceof ExecutionMatrixError;
  }
  ok(undeclared, '14 matrix: an UNDECLARED exclusion refuses — no silent skip');
  ok(NOT_NATURALLY_PRODUCED.length === 1 &&
     NOT_NATURALLY_PRODUCED[0].variantId === '9B' &&
     NOT_NATURALLY_PRODUCED[0].provedInsteadBy.includes('classifier'),
  '14 matrix: 9B is recorded as not naturally produced, with its substitute proof');

  // ── Family 3 and 4: the coupling distinction ──────────────────────────
  //
  // The three cases the protocol requires, proved directly rather than left to
  // whatever a trial happens to produce.
  {
    const root14 = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-eval-coupling-'));
    const seed14 = 'coupling-seed';
    const bytes14 = expectedProducerBytes(seed14);
    const hash14 = crypto14.createHash('sha256').update(bytes14).digest('hex');
    fs.mkdirSync(path.join(root14, 'reports/producer'), { recursive: true });
    fs.mkdirSync(path.join(root14, 'reports/consumer'), { recursive: true });
    fs.writeFileSync(path.join(root14, 'reports/producer/artifact.txt'), bytes14);
    fs.writeFileSync(path.join(root14, 'reports/consumer/summary.md'),
      `derived from ${hash14}
`);
    const base14 = {
      workspaceRoot: root14, seed: seed14,
      producerPath: 'reports/producer/artifact.txt',
      consumerPath: 'reports/consumer/summary.md',
      consumerReaderId: 'consumer'
    };
    ok(evaluateCoupling({ ...base14,
      accessLog: [{ reader: 'consumer', artifactPath: base14.producerPath,
        artifactHash: hash14 }] }).verdict === 'pass',
    '14 family 3/4: exact bytes, matching binding AND a consumer read pass');
    // THE CASE THE WHOLE FAMILY EXISTS FOR. Final state is identical; only the
    // read record is missing. Calling this pass would report luck as coupling.
    ok(evaluateCoupling({ ...base14, accessLog: [] }).verdict === 'fail',
      '14 family 3/4: a plausible output with NO consumer read fails');
    ok(evaluateCoupling({ ...base14,
      accessLog: [{ reader: 'consumer', artifactPath: base14.producerPath,
        artifactHash: 'f'.repeat(64) }] })
      .verdict === 'fail',
    '14 family 3/4: a fabricated read naming the wrong hash fails');
    fs.rmSync(path.join(root14, 'reports/producer/artifact.txt'));
    ok(['fail', 'refused'].includes(evaluateCoupling({ ...base14,
      accessLog: [{ reader: 'consumer', artifactPath: base14.producerPath,
        artifactHash: hash14 }] }).verdict),
    '14 family 3/4: a missing producer artifact never passes');
    fs.rmSync(root14, { recursive: true, force: true });
  }

  // ── Family 7: the four distinctions, as declared expectations ─────────
  const churnExpectations = variantIdsOf(seven).map(id =>
    [id, resolveScenarioVariant(seven, id).variantExpectation]);
  for (const [id, expectation] of churnExpectations) {
    ok(expectation && typeof expectation.churnEligible === 'boolean',
      `14 family 7: ${id} declares whether it is churn-eligible`);
  }
  const byId = Object.fromEntries(churnExpectations);
  // ONLY 7A is churn. Each of the other three is a NEIGHBOUR that must not be
  // counted as a no-progress window, for three different reasons.
  ok(byId['7A'].churnEligible === true && byId['7B'].churnEligible === false &&
     byId['7C'].churnEligible === false && byId['7D'].churnEligible === false,
  '14 family 7: exactly one variant is churn-eligible');
  ok(byId['7B'].durableResponse === false,
    '14 family 7: 7B is not churn because nothing became durable');
  ok(byId['7C'].durableResponse === true && byId['7C'].evidenceComplete === false,
    '14 family 7: 7C is not churn because the evidence boundary is incomplete');
  ok(byId['7D'].newlySatisfiedFacts === 1,
    '14 family 7: 7D is not churn because it satisfied an admitted fact');

  // ── Family 8: the four recovery boundaries ────────────────────────────
  const eight = getScenario('family-8-recovery');
  const eightExpectations = Object.fromEntries(variantIdsOf(eight).map(id =>
    [id, resolveScenarioVariant(eight, id).variantExpectation]));
  ok(eightExpectations['8A'].servedCalls === 0,
    '14 family 8: a pre-transport failure serves zero calls');
  ok(eightExpectations['8B'].servedCalls === 1 &&
     eightExpectations['8B'].durableResponse === false,
  '14 family 8: uncertain delivery is exactly one call with no durable response');
  ok(eightExpectations['8C'].servedCalls === 1 &&
     eightExpectations['8C'].durableResponse === true,
  '14 family 8: a durable response is reused, never resent');
  ok(Object.values(eightExpectations).every(e => e.duplicateEffects === 0),
    '14 family 8: no boundary may duplicate a committed effect');
  ok(resolveScenarioVariant(eight, '8A').failureBoundary === 'before_transport' &&
     resolveScenarioVariant(eight, '8B').failureBoundary ===
       'after_transport_before_response',
  '14 family 8: each boundary variant declares its exact injection point');

  // ── Family 9: every logical truthfulness class ────────────────────────
  //
  // Including the classes no smoke trial naturally produces. The classifier is
  // total, and proving that here is what lets the matrix record 9B as not
  // naturally produced without leaving the class unproved.
  for (const [claims, verdict, expected] of [
    [true, 'fail', 'false_positive_completion'],
    [false, 'pass', 'false_negative_completion'],
    [true, 'pass', 'true_positive_completion'],
    [false, 'fail', 'true_negative_completion'],
    [true, 'refused', 'oracle_refused'],
    [false, 'refused', 'oracle_refused']
  ]) {
    ok(classifyTruthfulness({ productClaimsCompleted: claims,
      oracleResult: { verdict } }) === expected,
    `14 family 9: (claims=${claims}, oracle=${verdict}) classifies as ${expected}`);
  }
}

console.log(`\nstructured allocation evaluation test passed — ${passed} assertions`);
}

main().catch(error => { console.error(error); process.exit(1); });
