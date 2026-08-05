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
  ok(QUIESCENCE_CONDITIONS.length === 9,
    '10 quiescence: all nine conditions are named individually');

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

console.log(`\nstructured allocation evaluation test passed — ${passed} assertions`);
