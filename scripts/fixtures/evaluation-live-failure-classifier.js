'use strict';

// Tranche 6 — the frozen live failure classifier.
//
// THE ONE RULE THAT MATTERS. A bad model answer is the product behaving badly,
// and that is precisely what the evaluation exists to measure. It may never be
// relabelled "infrastructure" because it hurts a score. Infrastructure
// exclusion is reserved for evidence that inference and product behaviour were
// NOT MEANINGFULLY OBSERVED at all.
//
// Classification reads stable HTTP status and error codes, never human-readable
// message text: a message can be reworded by a provider at any time, and a
// classifier that keys on prose changes its verdict without anyone deciding to.

const CLASSES = Object.freeze([
  'product_data', 'infrastructure_exclusion', 'run_fatal_configuration'
]);

function classifyLiveFailure(evidence = {}) {
  const {
    httpStatus = null,
    errorCode = null,
    requestDelivered = null,
    modelResultObserved = false,
    phase = null
  } = evidence;

  const verdict = (classification, reason) =>
    Object.freeze({ classification, reason, evidence: Object.freeze({ ...evidence }) });

  // ── RUN-FATAL CONFIGURATION ───────────────────────────────────────────
  //
  // These are wrong about the RUN, not about a trial. Converting an auth
  // failure into 120 per-trial exclusions would manufacture a corpus of
  // "excluded" trials from a single mistake.
  if (httpStatus === 401 || httpStatus === 403 ||
      errorCode === 'invalid_api_key' || errorCode === 'account_deactivated' ||
      errorCode === 'model_not_found' || phase === 'preflight_configuration') {
    return verdict('run_fatal_configuration',
      'authentication, authorization, account/project configuration or model ' +
      'availability is wrong for the whole run; it aborts or pauses the run and ' +
      'is never spread across trials as exclusions');
  }

  // ── INFRASTRUCTURE-ONLY EXCLUSION ─────────────────────────────────────
  //
  // Only with positive evidence that no model result exists.
  if (httpStatus === 429 && modelResultObserved === false) {
    return verdict('infrastructure_exclusion',
      'explicit provider rate limit with no model result: inference was not observed');
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus <= 599 &&
      modelResultObserved === false) {
    return verdict('infrastructure_exclusion',
      'explicit provider 5xx with no model result: inference was not observed');
  }
  if (requestDelivered === false && modelResultObserved === false) {
    return verdict('infrastructure_exclusion',
      'connection failed BEFORE the request was delivered, so no inference occurred');
  }
  if (errorCode === 'local_infrastructure_failure') {
    return verdict('infrastructure_exclusion',
      'local harness, database or server failure under the frozen infrastructure predicate');
  }

  // ── AMBIGUOUS DELIVERY IS PRODUCT DATA ────────────────────────────────
  //
  // A network failure or timeout where delivery cannot be proven ABSENT is
  // exactly the delivery-uncertainty the product is being evaluated on. The
  // provider contributing to the failure does not make it infrastructure.
  if (requestDelivered === null && modelResultObserved === false) {
    return verdict('product_data',
      'delivery could not be proven absent, so recovery from delivery uncertainty ' +
      'is part of the product behaviour under test');
  }

  // ── EVERYTHING ELSE IS PRODUCT DATA ───────────────────────────────────
  return verdict('product_data',
    'inference or product behaviour was observed: a refusal, a poor or malformed ' +
    'answer, a context-length rejection of the submitted request, a product ' +
    'timeout after request authority was exercised, product retry, budget ' +
    'exhaustion, a churn block, a completion failure or an adapter defect are ' +
    'all outcomes of the product being evaluated');
}

module.exports = { CLASSES, classifyLiveFailure };
