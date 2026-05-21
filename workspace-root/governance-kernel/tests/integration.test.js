const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const { buildContext } = require('../src/utils');
const { createRule } = require('../src/rules-engine');
const { enforceSilent } = require('../src/enforcer');


// Test suite
// Note: predicates are synchronous booleans, enforceSilent returns { passed, failures }
test('integration test for governance kernel pipeline', (t) => {
  // Step 1: Define project root and build context
  const projectRoot = path.resolve(__dirname, '..');
  const context = buildContext(projectRoot);

  // Step 2: Create passing rules using ctx.files.includes
  const hasReadme = createRule('hasReadme', (ctx) => ctx.files.includes('README.md'));
  const hasSrcDir = createRule('hasSrcDir', (ctx) => ctx.files.includes('src'));

  // Step 3: Enforce rules
  const passingResult = enforceSilent([hasReadme, hasSrcDir], context);

  // Step 4: Verify all passed and no failures
  assert.strictEqual(passingResult.passed, true, 'Passing rules should pass');
  assert.strictEqual(passingResult.failures.length, 0, 'No failures for passing rules');

  // Step 5: Create a failing rule using a predicate that fails
  const hasNonexistent = createRule('hasNonexistent', (ctx) => ctx.files.includes('nonexistent'));
  const failingResult = enforceSilent([hasNonexistent], context);

  // Step 6: Verify failure and one failure reported
  assert.strictEqual(failingResult.passed, false, 'Failing rules should not pass');
  assert.strictEqual(failingResult.failures.length, 1, 'Should report one failure');
});
