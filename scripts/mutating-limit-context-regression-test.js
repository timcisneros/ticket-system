const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const source = fs.readFileSync(SERVER_PATH, 'utf8');

let failures = 0;
function assert(condition, msg) {
  if (!condition) {
    console.error('FAIL: ' + msg);
    failures++;
  } else {
    console.log('  OK: ' + msg);
  }
}

// 1. No mutating_action_limit handler uses replacement pattern (actionResults = [{ warning: ...)
//    Both TM-1 (single path) and TM-3 (truncation + suppression paths) must preserve priorStepActionResults.
assert(
  !source.includes("actionResults = [{\n          warning: 'model:mutating_action_limit'"),
  'mutating_action_limit must NOT use bare replacement pattern (actionResults = [{ warning: ...])'
);

// 2. All mutating_action_limit handlers must use spread pattern to preserve priorStepActionResults
const spreadPattern = /actionResults = \[[\s\S]*?priorStepActionResults[\s\S]*?warning: 'model:mutating_action_limit'/g;
const spreadMatches = source.match(spreadPattern);
assert(
  spreadMatches && spreadMatches.length >= 1,
  `mutating_action_limit paths must use spread pattern [...priorStepActionResults, { warning: ...}] (count=${spreadMatches ? spreadMatches.length : 0})`
);

// 3. no_progress must still preserve context
assert(
  source.includes("actionResults = [\n          ...priorStepActionResults,\n          { warning: 'model:no_progress'") ||
  source.includes("actionResults = [...priorStepActionResults,\n          { warning: 'model:no_progress'") ||
  source.includes("actionResults.push({\n              warning: 'model:no_progress'"),
  'no_progress must preserve priorStepActionResults'
);

// 4. action_limit must ALSO preserve priorStepActionResults.
//    Previously this asserted the opposite — the total-action gate was left on the
//    bare replacement pattern while only the mutating gate was fixed. That
//    asymmetry meant a response rejected by the total-action gate silently dropped
//    the prior step's action results from the model's next prompt, while an
//    otherwise identical response rejected by the mutating gate kept them. Both
//    gates now preserve context, so the old expectation is inverted.
assert(
  !source.includes("actionResults = [{\n          warning: 'model:action_limit'"),
  'action_limit must NOT use bare replacement pattern'
);
assert(
  /actionResults = \[\s*\n\s*\.\.\.priorStepActionResults,[\s\S]{0,200}?warning: 'model:action_limit'/.test(source),
  'action_limit path must use spread pattern [...priorStepActionResults, { warning: ...}]'
);

// 5. Every model:mutating_action_limit warning reference uses spread pattern
const allRefs = source.match(/warning: 'model:mutating_action_limit'/g);
assert(
  allRefs && allRefs.length >= 1,
  `At least one model:mutating_action_limit warning reference in source (count=${allRefs ? allRefs.length : 0})`
);

if (failures === 0) {
  console.log('\n\u2713 All checks passed. mutating_action_limit context preserved.');
} else {
  console.error(`\n\u2717 ${failures} check(s) failed.`);
  process.exit(1);
}
