#!/usr/bin/env node
'use strict';
// Pure test for the durable action-contract violation streak reconstruction
// (runtime/action-contract-streak.js). This is the exact function a recovered
// run calls at loop entry to re-seed its streak from durable replay evidence,
// so it deterministically proves the recovery-durability invariant without a
// fragile crash/restart: a run recovered after one recorded violation
// reconstructs streak = 1, and one further consecutive violation reaches the
// termination threshold.

const assert = require('assert/strict');
const {
  reconstructActionContractViolationStreak,
  ACTION_CONTRACT_VIOLATION_THRESHOLD,
  ACTION_CONTRACT_VIOLATION_EVENT_TYPES
} = require('../runtime/action-contract-streak');

let passed = 0;
function check(desc, actual, expected) {
  assert.equal(actual, expected, `${desc}: expected ${expected}, got ${actual}`);
  passed += 1;
  console.log(`  ok ${desc}`);
}

const snap = ({ events = [], parsedModelPlans = [] }) => ({ events, parsedModelPlans });
const violation = (turn, type = 'model:action_limit') => ({ type, executionTurn: turn });
const plan = turn => ({ executionTurn: turn });

// Threshold is the documented "one correction, then terminate".
check('threshold is 2', ACTION_CONTRACT_VIOLATION_THRESHOLD, 2);
check('two violation event types are tracked', ACTION_CONTRACT_VIOLATION_EVENT_TYPES.length, 2);

// Fresh / absent snapshot.
check('null snapshot → 0', reconstructActionContractViolationStreak(null), 0);
check('empty snapshot → 0', reconstructActionContractViolationStreak(snap({})), 0);

// Trailing streaks.
check('one trailing total-action violation → 1',
  reconstructActionContractViolationStreak(snap({ events: [violation(0)], parsedModelPlans: [plan(0)] })), 1);
check('two consecutive violations → 2',
  reconstructActionContractViolationStreak(snap({ events: [violation(0), violation(1)], parsedModelPlans: [plan(0), plan(1)] })), 2);
check('mutating-action violation counts too',
  reconstructActionContractViolationStreak(snap({ events: [violation(0, 'model:mutating_action_limit')], parsedModelPlans: [plan(0)] })), 1);
check('mixed total+mutating consecutive → 2',
  reconstructActionContractViolationStreak(snap({
    events: [violation(0, 'model:action_limit'), violation(1, 'model:mutating_action_limit')],
    parsedModelPlans: [plan(0), plan(1)]
  })), 2);

// Reset: a parsed response with no violation event = it passed both gates.
check('a later passing response resets the streak → 0',
  reconstructActionContractViolationStreak(snap({ events: [violation(0)], parsedModelPlans: [plan(0), plan(1)] })), 0);
check('violation, pass, violation → only the trailing 1',
  reconstructActionContractViolationStreak(snap({ events: [violation(0), violation(2)], parsedModelPlans: [plan(0), plan(1), plan(2)] })), 1);

// Distinctness: other runtime classifications must never feed this streak.
check('unrelated events (stall / authority.denied / no_progress) do not count',
  reconstructActionContractViolationStreak(snap({
    events: [
      { type: 'model:stalled', executionTurn: 0 },
      { type: 'authority.denied', executionTurn: 1 },
      { type: 'model:no_progress', executionTurn: 2 }
    ],
    parsedModelPlans: [plan(0), plan(1), plan(2)]
  })), 0);

// stepId string fallback (journal-shaped) and `step` fallback.
check('stepId string + step fallback resolve the turn',
  reconstructActionContractViolationStreak(snap({ events: [{ type: 'model:action_limit', stepId: '0' }], parsedModelPlans: [{ step: 0 }] })), 1);

// Recovery-durability composition (scenario 4): reconstruct after ONE recorded
// violation = 1 (streak survives recovery), and one further consecutive
// violation reaches the threshold.
const seededAfterOneViolation = reconstructActionContractViolationStreak(
  snap({ events: [violation(0)], parsedModelPlans: [plan(0)] })
);
check('recovery seeds streak = 1 after one recorded violation', seededAfterOneViolation, 1);
check('seed(1) + one further violation reaches the threshold',
  seededAfterOneViolation + 1 >= ACTION_CONTRACT_VIOLATION_THRESHOLD, true);

console.log(`\nPASS: action-contract streak reconstruction — ${passed} checks (durable recovery seeding, pass-reset, type distinctness)`);
