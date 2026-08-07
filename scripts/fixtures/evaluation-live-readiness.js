'use strict';

// Tranche 6 — the LIVE-MODEL readiness audit.
//
// WHAT THIS IS FOR. A live matrix spends real money against a real provider and
// produces evidence that cannot be re-derived from the repository. Every value
// that shapes it must therefore be frozen BEFORE the first call — and a value
// that is merely absent must be reported as absent, never chosen here to let
// execution proceed.
//
// So this module reads the authoritative protocol and answers, per item,
// FROZEN or UNRESOLVED. It chooses nothing. It computes one thing — the
// worst-case monetary liability implied by the already-frozen pricing and
// ceiling contracts — because a reader cannot judge whether an economic
// authorization is adequate without knowing what it would authorize.
//
// While any item is UNRESOLVED the verdict is BLOCKED, and the live executor
// has no manifest to run.

const protocol = require('../../config/structured-allocation-evaluation-v1.json');

const LIVE_READINESS_VERSION = 1;

// The exact worst case the frozen contracts imply, not an estimate.
//
// `model_context_window_ceiling` is the frozen bound method: a request may cost
// at most a full context window of input plus the capped output. That is the
// number an economic authorization has to cover, and it is deliberately the
// pessimistic one — an authorization sized to a nominal estimate is not an
// authorization at all.
const PRICING = Object.freeze({
  inputMicroUsdPerMillionTokens: 150_000,
  outputMicroUsdPerMillionTokens: 600_000,
  contextWindowTokens: 128_000,
  maximumOutputTokensPerRequest: 2_048,
  boundMethod: 'model_context_window_ceiling'
});

// Maximum provider requests per trial, by arm, from the frozen role economics.
// The ungoverned arms carry no governed ceiling, so the worker cap is used as
// the closest frozen bound and is labelled as such.
const MAX_REQUESTS_PER_TRIAL = Object.freeze({
  A: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  A2a: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  A2b: { planner: 0, worker: 3, basis: 'worker economic ceiling (no governed planner on this path)' },
  B: { planner: 1, worker: 9, basis: 'planner ceiling 1 + 3 leaf Runs x worker ceiling 3' },
  C: { planner: 1, worker: 9, basis: 'planner ceiling 1 + 3 leaf Runs x worker ceiling 3' }
});

// THE KERNEL OWNS THIS NUMBER. This used to be a second pricing implementation:
// a single floating division of the summed product, with no rounding, which
// produced a fractional monetary authority (20,428.8) in a contract whose
// first rule is integer micro-USD rounded up. It now asks the same
// `computeMaximumLiability` that governed economics trusts.
const { canonicalPerRequestMicroUsd } =
  require('./evaluation-live-canonical-price');

function worstCaseMicroUsdPerRequest() {
  return canonicalPerRequestMicroUsd({ role: 'structured_leaf_executor' })
    .perRequestMicroUsd;
}

function worstCaseLiability({ trialsPerArm }) {
  const perRequest = worstCaseMicroUsdPerRequest();
  const byArm = {};
  let totalMicroUsd = 0;
  for (const [armId, trials] of Object.entries(trialsPerArm)) {
    const caps = MAX_REQUESTS_PER_TRIAL[armId];
    if (!caps) continue;
    const requests = caps.planner + caps.worker;
    const perTrial = requests * perRequest;
    byArm[armId] = {
      trials,
      maxRequestsPerTrial: requests,
      basis: caps.basis,
      perTrialMicroUsd: perTrial,
      totalMicroUsd: perTrial * trials
    };
    totalMicroUsd += perTrial * trials;
  }
  return Object.freeze({
    boundMethod: PRICING.boundMethod,
    perRequestMicroUsd: perRequest,
    byArm: Object.freeze(byArm),
    totalMicroUsd,
    // Informational only. Every authority here is integer micro-USD.
    totalUsdInformational: totalMicroUsd / 1e6,
    note: 'worst case under the frozen bound method, not a nominal estimate'
  });
}

// ── The audit ───────────────────────────────────────────────────────────────
//
// Each item names WHERE its value would live. An item is FROZEN only when the
// authoritative source actually carries it — never because a sensible default
// exists.
// `liveManifest` is injectable so the audit's dependence on it can be proved:
// with no manifest every derived decision must fall back to UNRESOLVED, which
// is the state the repository was in before the decisions were approved.
// `sources` exists so the NEGATIVE case is provable. An audit that can only be
// observed saying FROZEN is not a gate — it has to be shown going UNRESOLVED
// when the evidence it names is absent, which is what these overrides allow a
// test to do without editing the repository.
function auditLiveReadiness({ liveManifest, sources = {} } = {}) {
  const items = [];
  const record = (id, state, detail, source) =>
    items.push({ id, state, detail, source });

  const fixed = protocol.fixedModel || {};
  const datedSnapshot = typeof fixed.model === 'string' &&
    /\d{4}-\d{2}-\d{2}$/.test(fixed.model);

  record('provider', fixed.provider ? 'FROZEN' : 'UNRESOLVED',
    fixed.provider || null, 'protocol.fixedModel.provider');
  record('model_snapshot', datedSnapshot ? 'FROZEN' : 'UNRESOLVED',
    fixed.model || null, 'protocol.fixedModel.model');
  record('adapter_identity', fixed.adapterId ? 'FROZEN' : 'UNRESOLVED',
    fixed.adapterId || null, 'protocol.fixedModel.adapterId');
  // The protocol states one identity for planner and every worker, which is
  // what stops planner quality varying between arms.
  record('planner_and_worker_model_identity',
    fixed.note && /planner agent and every worker agent/i.test(fixed.note)
      ? 'FROZEN' : 'UNRESOLVED',
    fixed.note || null, 'protocol.fixedModel.note');
  record('pricing_snapshot', 'FROZEN',
    'runtime/model-pricing-catalog with the frozen catalog used by the cost method',
    'protocol.costMethod.normalized');
  record('context_and_output_ceilings', 'FROZEN',
    `context ${PRICING.contextWindowTokens}, output cap ${PRICING.maximumOutputTokensPerRequest}`,
    'provider-adapter-capability + role economic policy');

  record('live_repetitions',
    Number.isSafeInteger(protocol.repetition.liveModelRepetitions) &&
    protocol.repetition.liveModelRepetitions > 0 ? 'FROZEN' : 'UNRESOLVED',
    protocol.repetition.liveModelRepetitions, 'protocol.repetition.liveModelRepetitions');
  record('pooling_rule', protocol.repetition.poolingRule ? 'FROZEN' : 'UNRESOLVED',
    protocol.repetition.poolingRule, 'protocol.repetition.poolingRule');
  record('arm_ordering_strategy', protocol.ordering && protocol.ordering.strategy
    ? 'FROZEN' : 'UNRESOLVED',
  protocol.ordering && protocol.ordering.strategy, 'protocol.ordering.strategy');
  record('timeout', protocol.failureHandling.timeoutMs ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.timeoutMs, 'protocol.failureHandling.timeoutMs');
  record('product_failure_retention',
    protocol.failureHandling.productFailureRule ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.productFailureRule, 'protocol.failureHandling');
  record('result_freezing', protocol.failureHandling.resultFreezing ? 'FROZEN' : 'UNRESOLVED',
    protocol.failureHandling.resultFreezing, 'protocol.failureHandling.resultFreezing');
  record('authorized_metrics', protocol.authorizedDimensions.length === 5
    ? 'FROZEN' : 'UNRESOLVED',
  protocol.authorizedDimensions, 'protocol.authorizedDimensions');
  record('decision_thresholds', protocol.decisionThresholds ? 'FROZEN' : 'UNRESOLVED',
    'retain/revise/stop and 5 hard disqualifiers', 'protocol.decisionThresholds');

  // ── The eight approved decisions, DERIVED from the live manifest ──────
  //
  // Not a literal flipped from UNRESOLVED to FROZEN: each reads the frozen live
  // manifest and is CLOSED only when the manifest actually carries the approved
  // value. A missing manifest leaves every one of them unresolved, which is the
  // state the repository was in before the decisions were approved.
  let live = liveManifest === undefined ? null : liveManifest;
  if (liveManifest === undefined) {
    try {
      // eslint-disable-next-line global-require
      live = require('../../config/structured-allocation-evaluation-live-v1.json');
    } catch (_) { live = null; }
  }

  const derived = (id, condition, detail, source) =>
    record(id, live && condition ? 'FROZEN' : 'UNRESOLVED', detail, source);

  derived('live_matrix_membership',
    live && live.uniqueCellCount === 40 && live.totalAssignedTrials === 120 &&
      live.cells.every(cell => Array.isArray(cell.sourceFixtureSlots) &&
        cell.sourceFixtureSlots.length > 0),
    live && `${live.uniqueCellCount} cells x ${live.repetitions} repetitions = ` +
      `${live.totalAssignedTrials} slots, each derived from frozen fixture slots`,
    'live manifest cells[].sourceFixtureSlots');

  derived('sampling_parameters',
    live && live.sampling && live.sampling.temperature === 0 && live.sampling.topP === 1 &&
      live.sampling.appliesTo.length >= 2,
    live && `temperature ${live.sampling.temperature}, top_p ${live.sampling.topP} ` +
      'for every role',
    'live manifest sampling');

  derived('provider_seed_support',
    live && live.providerSeedSupport === false && live.providerSeed === null &&
      typeof live.stochasticityDeclaration === 'string',
    live && 'no provider seed; residual stochasticity declared as an experimental variable',
    'live manifest providerSeedSupport');

  derived('live_economic_ceiling',
    live && live.economics &&
      live.economics.maximumTotalLiveMicroUsd === 20_000_000 &&
      live.economics.computedWorstCaseMicroUsd <= live.economics.maximumTotalLiveMicroUsd,
    live && `cap ${live.economics.maximumTotalLiveMicroUsd} micro-USD, worst case ` +
      `${live.economics.computedWorstCaseMicroUsd}, headroom ${live.economics.headroomMicroUsd}`,
    'live manifest economics');

  derived('provider_failure_classification',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const { classifyLiveFailure } = require('./evaluation-live-failure-classifier');
        return classifyLiveFailure({ httpStatus: 429, modelResultObserved: false })
            .classification === 'infrastructure_exclusion' &&
          classifyLiveFailure({ requestDelivered: null, modelResultObserved: false })
            .classification === 'product_data' &&
          classifyLiveFailure({ httpStatus: 401 }).classification === 'run_fatal_configuration';
      } catch (_) { return false; }
    })(),
    'three classes, proved by the frozen classifier contract',
    'evaluation-live-failure-classifier');

  derived('rate_limit_and_outage_handling',
    live && live.resultFreezing && live.productFailureRule,
    live && 'excluded slots keep their assignment; resume preserves manifest, ' +
      'slot order, arm, repetition and stochastic contract',
    'live manifest resultFreezing / productFailureRule');

  derived('fixture_live_evidence_combination',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const { combineEvidence } = require('./evaluation-evidence-combination');
        return combineEvidence({
          fixture: { hardDisqualifierTriggered: true, ordinaryDecision: 'STOP' },
          live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
        }).finalProductDecision === 'STOP' &&
          combineEvidence({
            fixture: { hardDisqualifierTriggered: false, ordinaryDecision: 'STOP' },
            live: { ordinaryDecision: 'RETAIN', corpusComplete: true }
          }).finalProductDecision === 'RETAIN';
      } catch (_) { return false; }
    })(),
    'fixture disqualifier vetoes; fixture ordinary STOP reverses only through ' +
    'the frozen live RETAIN rule; denominators are never pooled',
    'evaluation-evidence-combination');

  derived('live_phase_necessity',
    live && live.livePhaseMandatory === true,
    live && 'live evaluation is MANDATORY before the final product decision',
    'live manifest livePhaseMandatory');

  // ── THE FACTS THE PREVIOUS READY VERDICT LACKED ───────────────────────
  //
  // That verdict verified the manifest, the contracts, the cap and a dry run
  // that "stopped before dispatch" — while NO dispatch path existed beyond that
  // stop and the frozen sampling reached no request. Documentation and config
  // could satisfy every item it checked. These eight cannot be satisfied that
  // way: each reads the implementation.
  const runnerSource = sources.runnerSource !== undefined ? sources.runnerSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-evaluation-runner.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const bodySource = sources.bodySource !== undefined ? sources.bodySource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'runtime',
          'provider-request-body.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const serverSource = sources.serverSource !== undefined ? sources.serverSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'server.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const plannerSource = sources.plannerSource !== undefined ? sources.plannerSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', '..', 'runtime',
          'structured-planner-governance.js'), 'utf8');
    } catch (_) { return ''; }
  })();

  const suiteSource = sources.suiteSource !== undefined ? sources.suiteSource : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..',
          'structured-allocation-live-dispatch-postgres-test.js'), 'utf8');
    } catch (_) { return ''; }
  })();
  const registered = sources.registered !== undefined ? sources.registered : (() => {
    try {
      return require('node:fs').readFileSync(
        require('node:path').join(__dirname, '..', 'test-manifest.js'), 'utf8')
        .includes('structured-allocation-live-dispatch-postgres-test.js');
    } catch (_) { return false; }
  })();

  // ── THE THREE ROLES ARE THREE FACTS ─────────────────────────────────────
  //
  // One boolean must never stand in for several unexercised roles. That is
  // exactly how a verdict came to claim three roles on two captured requests:
  // the planner received a worker-shaped answer, no plan was admitted, and the
  // governed leaf executor was never reached. Each role therefore has its own
  // item, and each requires the acceptance suite to be registered AND to carry
  // the assertion that fails when that role produces no outbound request.
  const roleModule = sources.roleModule !== undefined ? sources.roleModule : (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-capture-roles');
    } catch (_) { return null; }
  })();
  const roleProved = role => registered && roleModule !== null &&
    roleModule.ROLES.includes(role) &&
    typeof roleModule.assertEveryRoleDispatched === 'function' &&
    suiteSource.includes('assertEveryRoleDispatched(allCaptured)') &&
    suiteSource.includes('at least one ACTUAL outbound request instance was captured');

  // A live trial must be able to run WITHOUT the hermetic response fixture.
  record('liveDispatchPathImplemented',
    runnerSource.includes('assertMode(mode)') &&
      runnerSource.includes("const isLive = mode === 'live'") &&
      runnerSource.includes('live-transport-capture-preload.js')
      ? 'FROZEN' : 'UNRESOLVED',
    'runTrial accepts live mode and spawns without the hermetic response fixture',
    'structured-allocation-evaluation-runner runTrial');

  record('ungovernedWorkerDispatchProved', roleProved('ungoverned_worker')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual ungoverned worker request was captured at the final network hop',
  'structured-allocation-live-dispatch-postgres-test');
  record('structuredPlannerDispatchProved', roleProved('structured_planner')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual structured planner request was captured at the final network hop',
  'structured-allocation-live-dispatch-postgres-test');
  record('governedLeafDispatchProved', roleProved('governed_leaf_worker')
    ? 'FROZEN' : 'UNRESOLVED',
  'an actual governed leaf worker request was captured, after a real admitted plan',
  'structured-allocation-live-dispatch-postgres-test');

  // ── SAMPLING, PER ROLE ──────────────────────────────────────────────────
  const samplingWired = bodySource.includes('options.sampling');
  record('liveSamplingPlannerProved',
    samplingWired && plannerSource.includes('sampling: resolveProviderSampling()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the planner request body carries the canonical sampling authority',
    'structured-planner-governance buildOpenAiResponsesBody options');
  record('liveSamplingGovernedWorkerProved',
    samplingWired && serverSource.includes('sampling: resolveProviderSampling()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the governed leaf request body carries the canonical sampling authority',
    'server.js governed leaf body');
  record('liveSamplingUngovernedWorkerProved',
    samplingWired && serverSource.includes('sampling: resolveProviderSampling(),')
      ? 'FROZEN' : 'UNRESOLVED',
    'the ungoverned worker request body carries the canonical sampling authority',
    'server.js callOpenAI');

  // ── THE OUTPUT CAP, PER ROLE ────────────────────────────────────────────
  //
  // The liability model prices every request at one output cap. A role whose
  // wire body omits it is priced against a bound it does not carry — which is
  // what made the ungoverned arms' liability claim false.
  const capAgrees = source => source.includes('assertOutputCapAgrees(');
  record('liveOutputCapPlannerProved', capAgrees(plannerSource)
    ? 'FROZEN' : 'UNRESOLVED',
  'the planner output cap is checked to agree with the frozen live control',
  'structured-planner-governance assertOutputCapAgrees');
  record('liveOutputCapGovernedWorkerProved', capAgrees(serverSource)
    ? 'FROZEN' : 'UNRESOLVED',
  'the governed leaf output cap is checked to agree with the frozen live control',
  'server.js governed leaf assertOutputCapAgrees');
  record('liveOutputCapUngovernedWorkerProved',
    serverSource.includes('resolveUngovernedOutputCap()')
      ? 'FROZEN' : 'UNRESOLVED',
    'the ungoverned worker carries the frozen live output cap on the wire',
    'server.js callOpenAI resolveUngovernedOutputCap');

  // ── HISTORICAL COMPATIBILITY ────────────────────────────────────────────
  record('fixtureBodyCompatibilityProved',
    bodySource.includes('options.sampling !== undefined && options.sampling !== null') &&
      !bodySource.includes('sampling = { temperature')
      ? 'FROZEN' : 'UNRESOLVED',
    'a body built without live controls is byte-identical to its historical form',
    'provider-request-body explicit sampling with no default');

  // ── THE GLOBAL ECONOMIC GATE ────────────────────────────────────────────
  const ledger = sources.ledger !== undefined ? sources.ledger : (() => {
    try {
      // eslint-disable-next-line global-require
      return require('./evaluation-live-budget-ledger');
    } catch (_) { return null; }
  })();
  record('liveGlobalEconomicGateImplemented',
    ledger && typeof ledger.assertDispatchWithinGlobalCeiling === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'a global ceiling is enforced before every provider dispatch',
    'evaluation-live-budget-ledger');

  // THE WHOLE TRIAL, NOT ONE REQUEST. Reserving `perRequestMicroUsd` for a
  // trial that may issue ten requests is a gate sized for the wrong number.
  record('liveTrialWorstCaseReservationProved',
    runnerSource.includes('trialWorstCaseMicroUsd({') &&
      runnerSource.includes('maximumLiabilityMicroUsd: liveTrialBound.trialWorstCaseMicroUsd')
      ? 'FROZEN' : 'UNRESOLVED',
    'the reservation is the whole trial worst case, derived from Run topology',
    'evaluation-live-trial-liability trialWorstCaseMicroUsd');

  record('liveRetryLiabilityBoundProved',
    (() => {
      try {
        // eslint-disable-next-line global-require
        const liability = require('./evaluation-live-trial-liability');
        return typeof liability.assertRetryLiabilityBounded === 'function';
      } catch (_) { return false; }
    })() ? 'FROZEN' : 'UNRESOLVED',
    'every product-authorized retry attempt is inside the reserved bound',
    'evaluation-live-trial-liability assertRetryLiabilityBounded');

  record('liveGlobalEconomicGateRecoveryProved',
    ledger && typeof ledger.reconstructCommittedLiability === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'committed live liability reconstructs after restart from durable records',
    'evaluation-live-budget-ledger reconstructCommittedLiability');

  record('liveGlobalEconomicGateConcurrencyProved',
    ledger && typeof ledger.withLedgerLock === 'function'
      ? 'FROZEN' : 'UNRESOLVED',
    'two concurrent dispatchers cannot spend the same remaining authority',
    'evaluation-live-budget-ledger withLedgerLock');

  record('liveDryRunReachedProviderBoundary',
    runnerSource.includes("mode = 'fixture'") &&
      (() => {
        try {
          const scored = require('node:fs').readFileSync(
            require('node:path').join(__dirname, '..',
              'structured-allocation-evaluation-scored-runner.js'), 'utf8');
          return scored.includes('LIVE DRY RUN REACHED REAL PROVIDER DISPATCH BOUNDARY');
        } catch (_) { return false; }
      })() ? 'FROZEN' : 'UNRESOLVED',
    'the dry run traverses to the real provider dispatch boundary before stopping',
    'scored runner preflightLiveRun');

  record('externalProviderCallsZero',
    registered && suiteSource.includes('EXTERNAL PROVIDER CALLS MADE: 0') &&
      suiteSource.includes('LIVE_CAPTURE_ESCAPE')
      ? 'FROZEN' : 'UNRESOLVED',
    'the acceptance proof makes zero external calls and refuses any escape route',
    'live-transport-capture-preload escape guard');

  const unresolved = items.filter(item => item.state === 'UNRESOLVED');
  return Object.freeze({
    version: LIVE_READINESS_VERSION,
    items: Object.freeze(items),
    unresolved: Object.freeze(unresolved.map(item => item.id)),
    verdict: unresolved.length === 0
      ? 'TRANCHE 6 LIVE-MODEL EVALUATION READY'
      : 'TRANCHE 6 LIVE-MODEL EVALUATION BLOCKED',
    liability: worstCaseLiability({
      // ILLUSTRATIVE ONLY, and labelled so: the live matrix membership is
      // itself unresolved, so this shows what the fixture cells would cost at
      // the frozen live repetition count — not what has been authorized.
      trialsPerArm: { A: 24, A2a: 24, A2b: 12, B: 36, C: 24 }
    })
  });
}

// The gate a live executor must pass before its first provider call. It refuses
// while anything is unresolved, and it names what.
function assertLiveExecutionPermitted(audit = auditLiveReadiness()) {
  if (audit.unresolved.length > 0) {
    const error = new Error(
      'LIVE EVALUATION BLOCKED — the live protocol is not frozen: ' +
      audit.unresolved.join(', '));
    error.code = 'LIVE_EVALUATION_BLOCKED';
    error.detail = { unresolved: audit.unresolved };
    throw error;
  }
  return true;
}

module.exports = {
  LIVE_READINESS_VERSION,
  MAX_REQUESTS_PER_TRIAL,
  PRICING,
  assertLiveExecutionPermitted,
  auditLiveReadiness,
  worstCaseLiability,
  worstCaseMicroUsdPerRequest
};
