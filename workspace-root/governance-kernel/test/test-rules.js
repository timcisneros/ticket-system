const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { test } = require('node:test');
const { enforceSilent } = require('../src/enforcer');
const { createRule } = require('../src/rules-engine');

const projectRoot = path.resolve(__dirname, '..');

const rules = [
  createRule('hasReadme', () => fs.existsSync(path.join(projectRoot, 'README.md')), 'Project should have a README.md'),
  createRule('hasSrcDir', () => fs.existsSync(path.join(projectRoot, 'src')), 'Project should have a src/ directory'),
];

// existing tests

test('README.md exists using hasReadme rule', () => {
  const result = enforceSilent([rules.find(r => r.name === 'hasReadme')], {});
  assert.strictEqual(result.passed, true);
});

test('src/ directory exists using hasSrcDir rule', () => {
  const result = enforceSilent([rules.find(r => r.name === 'hasSrcDir')], {});
  assert.strictEqual(result.passed, true);
});

// new edge case tests

test('empty rule list - enforceSilent should pass with no failures', () => {
  const result = enforceSilent([], {});
  assert.strictEqual(result.passed, true);
  assert.deepStrictEqual(result.failures, []);
});

const alwaysTrueRule = createRule('alwaysTrue', () => true, 'This rule always passes');
const alwaysFalseRule = createRule('alwaysFalse', () => false, 'This rule always fails');

// Test default severity is error
const defaultSeverityRule = createRule('defaultSeverityRule', () => true, 'Default severity to error test');

// Test explicit severity levels
const warnSeverityRule = createRule('warnSeverityRule', () => true, 'Warn severity test', 'warn');
const infoSeverityRule = createRule('infoSeverityRule', () => true, 'Info severity test', 'info');
const errorSeverityRule = createRule('errorSeverityRule', () => false, 'Error severity test', 'error');


test('always-true rule - enforceSilent should pass', () => {
  const result = enforceSilent([alwaysTrueRule], {});
  assert.strictEqual(result.passed, true);
  assert.deepStrictEqual(result.failures, []);
});

test('always-false rule - enforceSilent should fail with one failure', () => {
  const result = enforceSilent([alwaysFalseRule], {});
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].rule, 'alwaysFalse');
  assert.strictEqual(result.failures[0].description, 'This rule always fails');
});

// Test that default severity is error

test('default severity is error if not provided', () => {
  const result = enforceSilent([defaultSeverityRule], {});
  assert.strictEqual(defaultSeverityRule.severity, 'error');
  assert.strictEqual(result.passed, true);
  assert.deepStrictEqual(result.failures, []);
});

// Test explicitly set severities

test('rules with explicit severities retain correct severity values', () => {
  assert.strictEqual(warnSeverityRule.severity, 'warn');
  assert.strictEqual(infoSeverityRule.severity, 'info');
  assert.strictEqual(errorSeverityRule.severity, 'error');
});

// Test error rule fails

test('errorSeverityRule should fail with severity error', () => {
  const result = enforceSilent([errorSeverityRule], {});
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].rule, 'errorSeverityRule');
  assert.strictEqual(result.failures[0].description, 'Error severity test');
});
