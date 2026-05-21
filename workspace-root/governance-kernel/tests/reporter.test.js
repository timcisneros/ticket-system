const test = require('node:test');
const assert = require('node:assert/strict');
const { generateTextReport, generateJsonReport } = require('../src/reporter');

const sampleResults = [
  { rule: 'file_exists_README_md', passed: true, description: 'Checks that README.md exists', error: '', severity: 'error' },
  { rule: 'file_exists_X', passed: false, description: 'Missing required file.', error: '', severity: 'error' },
];

test('Reporter Module', (t) => {
  t.test('generateTextReport includes severity text and correct format', () => {
    const report = generateTextReport(sampleResults);
    assert(report.startsWith('PASS file_exists_README_md [severity:error] - Checks that README.md exists'));
    assert(report.includes('FAIL file_exists_X [severity:error] - Missing required file.'));
    assert(!report.includes('[ERROR]'), 'Report should not contain leading [ERROR]');
    assert(report.includes('Summary:'));
    assert(report.includes('Passed: 1'));
    assert(report.includes('Failed: 1'));
    assert(report.includes('Total: 2'));
  });

  t.test('generateJsonReport includes severity property unchanged', () => {
    const jsonReport = generateJsonReport(sampleResults);
    const parsed = JSON.parse(jsonReport);
    assert.strictEqual(parsed.summary.total, 2);
    assert.strictEqual(parsed.summary.passed, 1);
    assert.strictEqual(parsed.summary.failed, 1);
    assert(Array.isArray(parsed.details));
    assert.strictEqual(parsed.details.length, 2);
    assert.strictEqual(parsed.details[0].severity, 'error');
    assert.strictEqual(parsed.details[1].severity, 'error');
  });
});
