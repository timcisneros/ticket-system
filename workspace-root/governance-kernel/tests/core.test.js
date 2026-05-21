const test = require('node:test');
const assert = require('node:assert/strict');
const { Governance } = require('../src/core');

test('Governance class with globally registered testRule', (t) => {
  const governance = new Governance();

  t.test('registerRule should create a rule', () => {
    const rule = governance.registerRule('testRule', (ctx) => ctx.value === 42, 'Value must be 42');
    assert.strictEqual(rule.name, 'testRule');
    assert.strictEqual(typeof rule.predicate, 'function');
    assert.strictEqual(rule.description, 'Value must be 42');
  });

  t.test('check should return passed true when rule passes due to global registration', () => {
    const context = { value: 42 };
    const result = governance.check(context);
    assert.strictEqual(typeof result, 'object');
    assert.strictEqual(result.passed, true); // Registered rule remains globally, so check returns passed true
  });

  t.test('createProjectContext should build context with rootDir and options', () => {
    const ctx = Governance.createProjectContext(__dirname, {extra: true});
    assert.strictEqual(ctx.rootDir, __dirname);
    assert.ok(Array.isArray(ctx.files));
    assert.strictEqual(ctx.extra, true);
  });

  t.test('enforce should not throw if no rules fail', () => {
    const context = {};
    assert.doesNotThrow(() => governance.enforce(context));
  });
});
