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
// must continue an in-progress streak, not reset it. The runtime records each
// rejection into the durable replay snapshot's `events` array, and each parsed
// response into `parsedModelPlans`. This module reconstructs the trailing
// consecutive streak from that durable evidence alone — no new persistence.
//
// The streak resets as soon as a later parsed response PASSES both gates
// (durably: a turn with a parsed plan but no violation event). Authority
// blocks, execution failures, and valid no-op outcomes happen AFTER the gates
// and belong to other classifications — they never preserve the streak.

// After this many consecutive rejected responses, terminate.
const ACTION_CONTRACT_VIOLATION_THRESHOLD = 2;

// The two rejection event types recorded by the runtime action-count gates.
const ACTION_CONTRACT_VIOLATION_EVENT_TYPES = Object.freeze([
  'model:action_limit',        // total-action ceiling
  'model:mutating_action_limit' // mutating-action ceiling
]);

function turnOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (Number.isInteger(item.executionTurn)) return item.executionTurn;
  if (Number.isInteger(item.step)) return item.step;
  // stepId is a stringified turn on journal-shaped events.
  if (typeof item.stepId === 'string' && /^\d+$/.test(item.stepId)) return parseInt(item.stepId, 10);
  return null;
}

// Reconstruct the trailing consecutive action-contract violation streak from a
// durable replay snapshot. Returns 0 for a fresh/absent snapshot.
function reconstructActionContractViolationStreak(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const plans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];

  const violationTurns = new Set();
  for (const event of events) {
    if (event && ACTION_CONTRACT_VIOLATION_EVENT_TYPES.includes(event.type)) {
      const turn = turnOf(event);
      if (turn !== null) violationTurns.add(turn);
    }
  }
  if (violationTurns.size === 0) return 0;

  const parsedTurns = new Set();
  for (const plan of plans) {
    const turn = turnOf(plan);
    if (turn !== null) parsedTurns.add(turn);
  }

  const maxTurn = Math.max(...violationTurns, ...parsedTurns);
  let streak = 0;
  for (let turn = maxTurn; turn >= 0; turn -= 1) {
    if (violationTurns.has(turn)) {
      streak += 1;
    } else if (parsedTurns.has(turn)) {
      break; // a parsed response with no violation = it passed both gates
    } else {
      break; // no response recorded for this turn
    }
  }
  return streak;
}

module.exports = {
  ACTION_CONTRACT_VIOLATION_THRESHOLD,
  ACTION_CONTRACT_VIOLATION_EVENT_TYPES,
  reconstructActionContractViolationStreak
};
