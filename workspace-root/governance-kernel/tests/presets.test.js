const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { fileExistsRules, directoryExistsRules, standardProjectRules } = require('../src/presets');

const projectPath = path.resolve(__dirname, '..');

test('fileExistsRules returns rules checking files', (t) => {
  const rules = fileExistsRules(projectPath);
  assert.strictEqual(rules.length, 3);
  rules.forEach(rule => {
    assert.strictEqual(typeof rule.name, 'string');
    assert.strictEqual(typeof rule.description, 'string');
    assert.strictEqual(typeof rule.predicate, 'function');
    // The file probably exists since it's this repo, so test predicate
    // but allow false in case some files are missing
    assert.strictEqual(typeof rule.predicate(), 'boolean');
  });
  const ruleNames = rules.map(r => r.name);
  assert(ruleNames.includes('file_exists_LICENSE'));
  assert(!ruleNames.includes('file_exists__gitignore'));
});

test('directoryExistsRules returns rules checking directories', (t) => {
  const rules = directoryExistsRules(projectPath);
  assert.strictEqual(rules.length, 3);
  rules.forEach(rule => {
    assert.strictEqual(typeof rule.name, 'string');
    assert.strictEqual(typeof rule.description, 'string');
    assert.strictEqual(typeof rule.predicate, 'function');
    assert.strictEqual(typeof rule.predicate(), 'boolean');
  });
});

test('standardProjectRules returns combined rules', (t) => {
  const rules = standardProjectRules(projectPath);
  assert.strictEqual(rules.length, 6); // 3 files + 3 directories
  const names = rules.map(r => r.name);
  assert(names.includes('file_exists_LICENSE'));
  assert(!names.includes('file_exists__gitignore'));
  assert(names.includes('directory_exists_src'));
});
