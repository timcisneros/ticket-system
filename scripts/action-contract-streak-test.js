#!/usr/bin/env node
'use strict';
// Pure test for the durable action-contract violation streak reconstruction
// (runtime/action-contract-streak.js). Reconstruction reads explicit ordered
// contract-decision events ONLY — a violation event per rejected response, an
// explicit pass event per accepted response — and never infers a pass from the
// absence of a violation event. This is what makes recovery safe across the
// non-atomic window between persisting a parsed plan and writing its decision.

const assert = require('assert/strict');
const {
  reconstructActionContractViolationStreak,
  ACTION_CONTRACT_VIOLATION_THRESHOLD,
  ACTION_CONTRACT_PASSED_EVENT_TYPE,
  ACTION_CONTRACT_VIOLATION_EVENT_TYPES,
  ACTION_CONTRACT_DECISION_EVENT_TYPES
} = require('../runtime/action-contract-streak');

let passed = 0;
function check(desc, actual, expected) {
  assert.equal(actual, expected, `${desc}: expected ${expected}, got ${actual}`);
  passed += 1;
  console.log(`  ok ${desc}`);
}

// A snapshot carrying ordered replay events; parsedModelPlans are included in
// some cases specifically to prove they are NOT consulted for pass inference.
const snap = ({ events = [], parsedModelPlans = [] }) => ({ events, parsedModelPlans });
const violation = (turn, type = 'model:action_limit') => ({ type, executionTurn: turn, step: turn });
const passEvent = turn => ({ type: ACTION_CONTRACT_PASSED_EVENT_TYPE, executionTurn: turn, step: turn });
const plan = turn => ({ executionTurn: turn, step: turn });

// Contract shape.
check('threshold is 2', ACTION_CONTRACT_VIOLATION_THRESHOLD, 2);
check('two violation event types', ACTION_CONTRACT_VIOLATION_EVENT_TYPES.length, 2);
check('three decision event types (2 violations + 1 pass)', ACTION_CONTRACT_DECISION_EVENT_TYPES.length, 3);

// Fresh / absent snapshot.
check('null snapshot → 0', reconstructActionContractViolationStreak(null), 0);
check('empty snapshot → 0', reconstructActionContractViolationStreak(snap({})), 0);

// Trailing streaks from violation decisions.
check('one violation decision → 1',
  reconstructActionContractViolationStreak(snap({ events: [violation(0)] })), 1);
check('two consecutive violation decisions → 2',
  reconstructActionContractViolationStreak(snap({ events: [violation(0), violation(1)] })), 2);
check('mutating-action violation counts too',
  reconstructActionContractViolationStreak(snap({ events: [violation(0, 'model:mutating_action_limit')] })), 1);
check('mixed total+mutating consecutive → 2',
  reconstructActionContractViolationStreak(snap({ events: [violation(0, 'model:action_limit'), violation(1, 'model:mutating_action_limit')] })), 2);

// An EXPLICIT pass decision resets the streak.
check('explicit pass decision after a violation resets → 0',
  reconstructActionContractViolationStreak(snap({ events: [violation(0), passEvent(1)] })), 0);
check('violation, pass, violation → trailing 1',
  reconstructActionContractViolationStreak(snap({ events: [violation(0), passEvent(1), violation(2)] })), 1);

// Distinctness: non-decision events never feed the streak.
check('unrelated events (stall / authority.denied / no_progress) do not count',
  reconstructActionContractViolationStreak(snap({
    events: [
      { type: 'model:stalled', executionTurn: 0 },
      { type: 'authority.denied', executionTurn: 1 },
      { type: 'model:no_progress', executionTurn: 2 }
    ]
  })), 0);

// ── PARTIAL-WRITE REGRESSION (the crash window the audit flagged) ──
// A parsed plan is durable for turn 1 but NO decision event was written before
// the crash, and the prior streak is already 1 (violation at turn 0).
// Reconstruction must NOT interpret the undecided turn as a pass and must NOT
// erase the prior violation — it stays at 1 (the undecided turn is invisible).
check('undecided turn (plan durable, no decision) does not reset the prior streak',
  reconstructActionContractViolationStreak(snap({
    events: [violation(0)],            // prior streak = 1, durable
    parsedModelPlans: [plan(0), plan(1)] // turn 1 parsed but UNDECIDED (no decision event)
  })), 1);
// And an undecided turn after a pass stays reset (undecided never increments).
check('undecided turn after a pass neither resets nor increments',
  reconstructActionContractViolationStreak(snap({
    events: [violation(0), passEvent(1)],
    parsedModelPlans: [plan(0), plan(1), plan(2)] // turn 2 undecided
  })), 0);

// Recovery-durability composition: seed after one recorded violation = 1, and
// one further consecutive violation reaches the threshold.
const seededAfterOneViolation = reconstructActionContractViolationStreak(snap({ events: [violation(0)] }));
check('recovery seeds streak = 1 after one recorded violation', seededAfterOneViolation, 1);
check('seed(1) + one further violation reaches the threshold',
  seededAfterOneViolation + 1 >= ACTION_CONTRACT_VIOLATION_THRESHOLD, true);

console.log(`\nPASS: action-contract streak reconstruction — ${passed} checks (explicit decision events, undecided-turn safety, pass-reset, distinctness)`);
