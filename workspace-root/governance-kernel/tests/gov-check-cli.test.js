const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const govCheckPath = path.resolve(__dirname, '../bin/gov-check.js');
const testCwd = path.resolve(__dirname, '..');

function runGovernanceCli(args = ['.']) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [govCheckPath, ...args], { cwd: testCwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', data => { stdout += data.toString(); });
    proc.stderr.on('data', data => { stderr += data.toString(); });
    proc.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('gov-check CLI runs and outputs report in new format', async () => {
  const result = await runGovernanceCli();
  assert.strictEqual(typeof result.stdout, 'string');
  assert(result.stdout.length > 0, 'Output report should not be empty');
  assert.strictEqual(typeof result.code, 'number');
  assert(result.code === 0 || result.code === 1);
  assert(result.stderr === '' || !result.stderr.startsWith('Error running governance check:'));

  // Assert severity text pattern present in text mode
  assert(result.stdout.includes('PASS'), 'Output should include PASS');
  assert(result.stdout.match(/\[severity:[a-z]+\]/), 'Output should include severity in format [severity:level]');
  assert(!result.stdout.includes('[ERROR]'), 'Output should NOT include leading [ERROR]');
});

// Test --json output without ignore

test('gov-check CLI outputs valid JSON with --json, unchanged shape', async () => {
  const result = await runGovernanceCli(['.', '--json']);
  assert.strictEqual(result.stderr, '');
  assert(result.stdout.length > 0, 'JSON output should not be empty');

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail('Output is not valid JSON');
  }

  // Check JSON structure
  assert.ok('passed' in parsed, 'JSON output missing "passed"');
  assert.ok('failed' in parsed, 'JSON output missing "failed"');
  assert.ok('total' in parsed, 'JSON output missing "total"');
  assert.ok('failures' in parsed, 'JSON output missing "failures"');
  assert.ok('rules' in parsed, 'JSON output missing "rules"');

  assert.strictEqual(typeof parsed.passed, 'boolean');
  assert.strictEqual(typeof parsed.failed, 'number');
  assert.strictEqual(typeof parsed.total, 'number');
  assert.ok(Array.isArray(parsed.failures), 'failures is not array');
  assert.ok(Array.isArray(parsed.rules), 'rules is not array');

  // ignoredPaths should be empty or missing
  assert.ok(!('ignoredPaths' in parsed) || (Array.isArray(parsed.ignoredPaths) && parsed.ignoredPaths.length === 0));

  // Check every rule has valid severity
  const validSeverities = new Set(['info', 'warn', 'error']);
  for (const rule of parsed.rules) {
    assert('severity' in rule);
    assert(validSeverities.has(rule.severity));
  }
  for (const failure of parsed.failures) {
    assert('severity' in failure);
    assert(validSeverities.has(failure.severity));
  }
});

// New test for --ignore node_modules with --json

test('gov-check CLI --ignore node_modules --json includes ignoredPaths array properly and preserves existing JSON fields', async () => {
  const result = await runGovernanceCli(['.', '--ignore', 'node_modules', '--json']);
  assert.strictEqual(result.stderr, '');
  assert(result.stdout.length > 0, 'JSON output should not be empty');

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail('Output is not valid JSON');
  }

  // Check that ignoredPaths contains node_modules exactly
  assert.ok(Array.isArray(parsed.ignoredPaths), 'ignoredPaths should be an array');
  assert(parsed.ignoredPaths.includes('node_modules'), 'ignoredPaths should include node_modules');

  // Check original JSON fields exist
  assert.ok('passed' in parsed);
  assert.ok('failed' in parsed);
  assert.ok('total' in parsed);
  assert.ok('failures' in parsed);
  assert.ok('rules' in parsed);

  // Check severity fields
  const validSeverities = new Set(['info', 'warn', 'error']);
  for (const rule of parsed.rules) {
    assert('severity' in rule);
    assert(validSeverities.has(rule.severity));
  }
  for (const failure of parsed.failures) {
    assert('severity' in failure);
    assert(validSeverities.has(failure.severity));
  }
});

// Test text mode with --ignore node_modules

test('gov-check CLI --ignore node_modules text output works normally', async () => {
  const result = await runGovernanceCli(['.', '--ignore', 'node_modules']);
  assert.strictEqual(result.stderr, '');
  assert(result.stdout.length > 0, 'Text output should not be empty');
  assert(result.stdout.includes('PASS') || result.stdout.includes('FAIL'), 'Text output should include PASS or FAIL');
});

// Updated test for --failures-only

test('gov-check CLI --failures-only text output shows only failures with proper format when no failures', async () => {
  const result = await runGovernanceCli(['.', '--failures-only']);
  assert.strictEqual(result.stderr, '', 'stderr should be empty');
  assert(result.stdout.length > 0, 'Text output should not be empty');

  // Output should include Summary
  assert(result.stdout.includes('Summary'), 'Output should include Summary');

  // Split output lines and check rule result lines
  const lines = result.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0);

  // Identify rule result lines starting with PASS or FAIL
  const ruleResultLines = lines.filter(line => line.startsWith('PASS') || line.startsWith('FAIL'));

  // Assert none start with PASS
  const anyPass = ruleResultLines.some(line => line.startsWith('PASS'));
  assert(!anyPass, 'No rule result line should start with PASS');

  // If there are any rule result lines, each must start with FAIL
  if (ruleResultLines.length > 0) {
    ruleResultLines.forEach(line => {
      assert(line.startsWith('FAIL'), 'All rule result lines must start with FAIL');
    });
  }

  // Assert stdout is non-empty and includes Summary (already asserted)
});

test('gov-check CLI --failures-only --json output shows only failed rules in rules array', async () => {
  const result = await runGovernanceCli(['.', '--failures-only', '--json']);
  assert.strictEqual(result.stderr, '');
  assert(result.stdout.length > 0, 'JSON output should not be empty');

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    assert.fail('Output is not valid JSON');
  }

  // rules array should only contain rules that have passed:false
  const anyPassed = parsed.rules.some(rule => rule.passed === true);
  assert.strictEqual(anyPassed, false, 'rules array should not contain passing rules');

  // failures array remains full failures
  assert.ok(Array.isArray(parsed.failures));

  // Other JSON fields preserved
  assert('passed' in parsed);
  assert('failed' in parsed);
  assert('total' in parsed);
  assert.ok('ignoredPaths' in parsed);

  // Check severity fields
  const validSeverities = new Set(['info', 'warn', 'error']);
  for (const rule of parsed.rules) {
    assert('severity' in rule);
    assert(validSeverities.has(rule.severity));
  }
  for (const failure of parsed.failures) {
    assert('severity' in failure);
    assert(validSeverities.has(failure.severity));
  }
});
