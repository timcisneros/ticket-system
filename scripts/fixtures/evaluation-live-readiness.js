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
function auditLiveReadiness() {
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

  // ── The genuinely missing pieces ──────────────────────────────────────
  //
  // Each of these shapes the experiment or authorizes spending. None has a
  // safe default, and choosing one here would be inventing product authority.

  record('live_matrix_membership', 'UNRESOLVED',
    'no scenario/variant/arm membership is defined for the live phase; the ' +
    'fixture matrix is a fixture decision and does not carry over by itself',
    'absent from protocol and both manifests');

  record('sampling_parameters', 'UNRESOLVED',
    'temperature, top-p or the equivalent randomness controls are not recorded ' +
    'anywhere; a live result is not reproducible without them',
    'absent from protocol.fixedModel');

  record('provider_seed_support', 'UNRESOLVED',
    'whether the provider seed is used, and its values, is not declared; ' +
    'determinism may not be assumed and may not be fabricated',
    'absent from protocol');

  record('live_economic_ceiling', 'UNRESOLVED',
    'no monetary ceiling authorizes live spending. The fixture protocol ' +
    'authorizes no expenditure, and inheriting silence as permission would be ' +
    'spending money nobody approved',
    'absent from protocol and manifests');

  record('provider_failure_classification', 'UNRESOLVED',
    'HTTP 429, provider 5xx, network interruption, provider timeout, malformed ' +
    'response, model refusal, context-length rejection and authentication ' +
    'failure are not classified as product data or infrastructure exclusion. ' +
    'The frozen infrastructure list names only local conditions',
    'protocol.failureHandling.infrastructureExclusions covers local failures only');

  record('rate_limit_and_outage_handling', 'UNRESOLVED',
    'no backoff, retry-budget or outage-resume rule exists for a live run',
    'absent from protocol');

  record('fixture_live_evidence_combination', 'UNRESOLVED',
    'the protocol forbids POOLING fixture and live results into one score but ' +
    'never states how a final RETAIN/REVISE/STOP is derived from both, nor ' +
    'whether a fixture hard disqualifier can independently stop the product, ' +
    'nor the exact condition under which live evidence could reverse a fixture ' +
    'STOP', 'protocol.repetition.poolingRule states separation only');

  // A CONTRADICTION, recorded as its own item rather than silently resolved.
  //
  // The authoritative protocol calls live confirmation OPTIONAL (§10 step 7 of
  // the evaluation document). The scorer this repository now ships emits
  // `REQUIRES LIVE-MODEL MATRIX` for every fixture-mode report. Those cannot
  // both be authoritative, and which one governs is a product decision.
  record('live_phase_necessity', 'UNRESOLVED',
    'the evaluation document calls live confirmation OPTIONAL while the scorer ' +
    'emits REQUIRES LIVE-MODEL MATRIX for fixture-mode reports; whether a live ' +
    'matrix is mandatory before the final product decision is undecided',
    'docs §10.7 versus scorer finalProductDecision');

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
