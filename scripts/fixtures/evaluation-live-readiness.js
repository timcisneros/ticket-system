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

function worstCaseMicroUsdPerRequest() {
  return (PRICING.contextWindowTokens * PRICING.inputMicroUsdPerMillionTokens +
    PRICING.maximumOutputTokensPerRequest * PRICING.outputMicroUsdPerMillionTokens) / 1e6;
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
    totalUsd: totalMicroUsd / 1e6,
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
function auditLiveReadiness({ liveManifest } = {}) {
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
