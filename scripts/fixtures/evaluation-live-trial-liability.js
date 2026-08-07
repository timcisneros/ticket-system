'use strict';

// Tranche 6 — the maximum provider liability ONE live trial can create.
//
// WHY THIS MODULE EXISTS. The ledger used to reserve `perRequestMicroUsd` — one
// request — as a whole trial's liability, while a trial may issue three or ten.
// The gate passed while real exposure ran several times the reserved amount.
// A ceiling that is checked against the wrong number is not a ceiling.
//
// THE BOUND IS DERIVED, NEVER DECLARED. Every quantity below comes from an
// authoritative source and is recomputed here:
//
//   * how many Runs one trial can create        <- arm topology (agents/plan)
//   * how many provider requests one Run can    <- min(economic ceiling,
//     issue                                          runtime request ceiling)
//   * how many attempts one ticket can make     <- executionPolicy.autoRetry,
//                                                    proved OFF, and maxAttempts
//   * what one request can cost                 <- the frozen pricing bound
//
// RETRIES ARE NOT "HEADROOM". A product retry creates a NEW Run with its own
// request budget, so it is liability outside any single Run's ceiling. It is
// included here as `attemptsPerRun` — a number that is 1 only because
// `normalizeExecutionPolicy` makes `autoRetry` a strict opt-in that the live
// trial construction never sets, and because a group ticket is refused for
// retry outright. That fact is asserted at reservation time by
// `assertRetryLiabilityBounded`, so if the trial construction ever enabled
// retry, the reservation would grow rather than silently understate.

class TrialLiabilityError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TrialLiabilityError';
    this.code = detail.code || 'TRIAL_LIABILITY_INVALID';
    this.detail = detail;
  }
}

// ── Arm topology ────────────────────────────────────────────────────────────
//
// The harness builds every group from two worker agents, and a structured arm
// adds a planner agent — which is itself a group member and therefore receives
// an allocation item of its own. So a structured plan carries one item per
// candidate, and each admitted item becomes one leaf Run.
//
// `basis` is not decoration: it names the source the number was read from, so a
// changed topology shows up as a contradiction rather than a stale constant.
const ARM_TOPOLOGY = Object.freeze({
  A: Object.freeze({
    governed: false, plannerRequests: 0, workerRuns: 1,
    ticketShape: 'agent',
    basis: 'individual agent ticket -> exactly one ungoverned Run'
  }),
  A2a: Object.freeze({
    governed: false, plannerRequests: 0, workerRuns: 2,
    ticketShape: 'group',
    basis: 'legacy v1 group allocation -> one ungoverned Run per worker agent (2)'
  }),
  A2b: Object.freeze({
    governed: false, plannerRequests: 0, workerRuns: 2,
    ticketShape: 'group',
    basis: 'legacy v1 group dynamic -> one ungoverned Run per worker agent (2)'
  }),
  B: Object.freeze({
    governed: true, plannerRequests: 1, workerRuns: 3,
    ticketShape: 'group',
    basis: 'one planning attempt + one governed leaf Run per candidate ' +
      '(2 workers + the planner agent, itself a group member)'
  }),
  C: Object.freeze({
    governed: true, plannerRequests: 1, workerRuns: 3,
    ticketShape: 'group',
    basis: 'one planning attempt + one governed leaf Run per candidate ' +
      '(2 workers + the planner agent, itself a group member)'
  })
});

const ARM_IDS = Object.freeze(Object.keys(ARM_TOPOLOGY));

// ── The retry bound ─────────────────────────────────────────────────────────
//
// A live trial may reserve `attemptsPerRun: 1` ONLY while auto-retry is proved
// off for its ticket shape. Anything else must reserve maxAttempts.
function assertRetryLiabilityBounded({ armId, autoRetryEnabled, maxAttempts }) {
  const topology = ARM_TOPOLOGY[armId];
  if (!topology) {
    throw new TrialLiabilityError(`unknown arm ${String(armId)}`, { armId });
  }
  if (autoRetryEnabled !== true) return 1;
  // A group ticket is refused for auto-retry by `assessAutoRetryAfterFailure…`
  // (`unsupported_ticket_shape`), so enabling the policy cannot create attempts
  // there. An agent ticket can, and must reserve every attempt it may make.
  if (topology.ticketShape !== 'agent') return 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TrialLiabilityError(
      'auto-retry is enabled but its attempt ceiling is not a proven integer; ' +
      'refusing to price an unbounded number of provider attempts',
      { code: 'TRIAL_LIABILITY_RETRY_UNBOUNDED', armId, maxAttempts });
  }
  return maxAttempts;
}

// ── The trial bound ─────────────────────────────────────────────────────────
//
// requestsPerRun is min(economic ceiling, runtime ceiling) because BOTH are
// enforced: the economic authority refuses an ordinal beyond its
// `maximumProviderRequests`, and `assertRunModelRequestAllowed` refuses beyond
// `maxModelRequestsPerRun`. An ungoverned Run has no economic authority, so the
// runtime ceiling is its only bound — which is why it must be pinned and read,
// never assumed.
function maximumProviderAttempts({
  armId,
  runtimeMaxModelRequestsPerRun,
  governedLeafMaximumProviderRequests,
  governedPlannerMaximumProviderRequests,
  autoRetryEnabled = false,
  maxAttempts = null
}) {
  const topology = ARM_TOPOLOGY[armId];
  if (!topology) {
    throw new TrialLiabilityError(`unknown arm ${String(armId)}`, { armId });
  }
  for (const [name, value] of Object.entries({
    runtimeMaxModelRequestsPerRun,
    governedLeafMaximumProviderRequests,
    governedPlannerMaximumProviderRequests
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TrialLiabilityError(
        `${name} must be a positive safe integer read from its authority; a ` +
        'trial may not be priced against an unproven ceiling',
        { code: 'TRIAL_LIABILITY_CEILING_UNPROVEN', armId, name, value });
    }
  }
  const attemptsPerRun = assertRetryLiabilityBounded({
    armId, autoRetryEnabled, maxAttempts
  });
  const workerRequestsPerRun = topology.governed
    ? Math.min(governedLeafMaximumProviderRequests, runtimeMaxModelRequestsPerRun)
    : runtimeMaxModelRequestsPerRun;
  const plannerRequests = topology.plannerRequests === 0
    ? 0
    : Math.min(governedPlannerMaximumProviderRequests,
      runtimeMaxModelRequestsPerRun) * topology.plannerRequests;
  const workerRequests = topology.workerRuns * workerRequestsPerRun * attemptsPerRun;
  return Object.freeze({
    armId,
    governed: topology.governed,
    basis: topology.basis,
    runsCapableOfProviderRequests: topology.workerRuns + topology.plannerRequests,
    plannerRequestMaximum: plannerRequests,
    workerRequestsPerRun,
    maximumWorkerRuns: topology.workerRuns,
    attemptsPerRun,
    retryIncludedInRunCeiling: attemptsPerRun === 1,
    totalProviderAttempts: plannerRequests + workerRequests
  });
}

function trialWorstCaseMicroUsd({ perRequestMicroUsd, ...bounds }) {
  if (typeof perRequestMicroUsd !== 'number' || !Number.isFinite(perRequestMicroUsd) ||
      perRequestMicroUsd <= 0) {
    throw new TrialLiabilityError('perRequestMicroUsd must be a positive number',
      { code: 'TRIAL_LIABILITY_PRICE_INVALID', perRequestMicroUsd });
  }
  const attempts = maximumProviderAttempts(bounds);
  return Object.freeze({
    ...attempts,
    perRequestMicroUsd,
    // trialWorstCase = plannerWorstCase + sum(worker Run worst cases), where
    // every attempt is priced at the same frozen per-request bound.
    trialWorstCaseMicroUsd: attempts.totalProviderAttempts * perRequestMicroUsd
  });
}

module.exports = {
  ARM_IDS,
  ARM_TOPOLOGY,
  TrialLiabilityError,
  assertRetryLiabilityBounded,
  maximumProviderAttempts,
  trialWorstCaseMicroUsd
};
