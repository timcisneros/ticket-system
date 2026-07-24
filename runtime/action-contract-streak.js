'use strict';

// Bounded repeated-response-contract-violation streak (docs/BOUNDED_OPERATION_BATCHES.md).
//
// A model response is rejected when it exceeds either per-response action-count
// gate — the total-action ceiling (MAX_AGENT_ACTIONS_PER_RESPONSE) or the
// mutating-action ceiling (MAX_MUTATING_ACTIONS_PER_RESPONSE). One rejection
// earns corrective feedback; a second CONSECUTIVE rejection terminates the run
// as a model-contract failure rather than burning the runtime-duration budget.
//
// The streak must survive process restarts: a run recovered between responses
// must continue an in-progress streak, not reset it. To make recovery safe, the
// runtime records an EXPLICIT durable contract-decision event for every parsed
// response — a violation event when a gate rejects it, or a
// `model:action_contract_passed` event once both gates pass. The streak is
// reconstructed from these ordered decision events ALONE.
//
// Why not infer "passed" from the absence of a violation event: the parsed plan
// and the violation event are separate, non-atomic writes. A crash after the
// plan is durable but before the decision event leaves an UNDECIDED turn. If a
// pass were inferred from "plan present, no violation", that crash would falsely
// reset the streak and let a misbehaving model evade termination. An undecided
// turn carries no decision event, so it is invisible here — it neither resets
// nor increments the streak until recovery deterministically re-classifies that
// response and writes its decision event.

// After this many consecutive rejected responses, terminate.
const ACTION_CONTRACT_VIOLATION_THRESHOLD = 2;

// The durable contract-decision event recorded once a response passes both gates.
const ACTION_CONTRACT_PASSED_EVENT_TYPE = 'model:action_contract_passed';

// The two rejection event types recorded by the runtime action-count gates.
const ACTION_CONTRACT_VIOLATION_EVENT_TYPES = Object.freeze([
  'model:action_limit',         // total-action ceiling
  'model:mutating_action_limit' // mutating-action ceiling
]);

// The full set of contract-decision events, the only events reconstruction reads.
const ACTION_CONTRACT_DECISION_EVENT_TYPES = Object.freeze([
  ACTION_CONTRACT_PASSED_EVENT_TYPE,
  ...ACTION_CONTRACT_VIOLATION_EVENT_TYPES
]);

function isViolationDecision(type) {
  return ACTION_CONTRACT_VIOLATION_EVENT_TYPES.includes(type);
}

// Reconstruct the trailing consecutive action-contract violation streak from a
// durable replay snapshot, reading contract-decision events ONLY, in their
// recorded (append/chronological) order. Returns 0 for a fresh/absent snapshot.
//
// The trailing run of consecutive violation decisions is the streak; the first
// `passed` decision encountered scanning backward ends it. Turns with no
// decision event (undecided — e.g. a crash between plan persistence and the
// decision write) are absent from the decision stream and therefore never
// reset and never increment the streak.
function reconstructActionContractViolationStreak(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];

  const decisions = events.filter(event =>
    event && ACTION_CONTRACT_DECISION_EVENT_TYPES.includes(event.type));

  let streak = 0;
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    if (isViolationDecision(decisions[i].type)) {
      streak += 1;
    } else {
      break; // model:action_contract_passed → the streak was reset here
    }
  }
  return streak;
}

module.exports = {
  ACTION_CONTRACT_VIOLATION_THRESHOLD,
  ACTION_CONTRACT_PASSED_EVENT_TYPE,
  ACTION_CONTRACT_VIOLATION_EVENT_TYPES,
  ACTION_CONTRACT_DECISION_EVENT_TYPES,
  reconstructActionContractViolationStreak
};
