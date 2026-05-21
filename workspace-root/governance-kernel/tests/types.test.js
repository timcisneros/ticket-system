const test = require('node:test');
const assert = require('node:assert');
const {
  createRuleType,
  validateValue,
  TYPE_STRING,
  TYPE_NUMBER,
  TYPE_BOOLEAN,
  TYPE_OBJECT,
  TYPE_ARRAY
} = require('../src/types');

// Test creating rule types
const alwaysTrueValidator = () => true;
const ruleType = createRuleType('custom', alwaysTrueValidator);
test('createRuleType creates a type with name and validate function', () => {
  assert.strictEqual(ruleType.name, 'custom');
  assert.strictEqual(typeof ruleType.validate, 'function');
  assert.strictEqual(ruleType.validate(), true);
});

test('validateValue validates correct values against type', () => {
  assert.strictEqual(validateValue(TYPE_STRING, 'hello'), true);
  assert.strictEqual(validateValue(TYPE_NUMBER, 10), true);
  assert.strictEqual(validateValue(TYPE_BOOLEAN, false), true);
  assert.strictEqual(validateValue(TYPE_OBJECT, {a:1}), true);
  assert.strictEqual(validateValue(TYPE_ARRAY, [1, 2, 3]), true);
});

test('validateValue rejects incorrect values against type', () => {
  assert.strictEqual(validateValue(TYPE_STRING, 10), false);
  assert.strictEqual(validateValue(TYPE_NUMBER, '10'), false);
  assert.strictEqual(validateValue(TYPE_BOOLEAN, 0), false);
  assert.strictEqual(validateValue(TYPE_OBJECT, null), false);
  assert.strictEqual(validateValue(TYPE_ARRAY, {}), false);
});

// Additional test for invalid type in validateValue
test('validateValue throws for invalid type argument', () => {
  assert.throws(() => validateValue(null, 'anything'), /Invalid type provided/);
});

// Ensure TYPE_* objects have correct structure
for (const type of [TYPE_STRING, TYPE_NUMBER, TYPE_BOOLEAN, TYPE_OBJECT, TYPE_ARRAY]) {
  test(`TYPE_${type.name.toUpperCase()} has name and validate function`, () => {
    assert.strictEqual(typeof type.name, 'string');
    assert.strictEqual(typeof type.validate, 'function');
  });
}
