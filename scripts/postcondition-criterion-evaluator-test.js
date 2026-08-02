#!/usr/bin/env node
'use strict';

// Tranche 5 — one criterion rule, called by both the execution seam and the
// completion decision.
//
// Before this, two evaluators answered "is this admitted criterion satisfied":
// the execution loop read the live filesystem and supported two criterion types
// all-or-nothing; the completion decision read recorded claims and supported
// three, deciding each separately. Two authorities for one question disagree
// silently, and the disagreement would have shown up as execution crediting
// progress the completion decision would not honour.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  CRITERION_EVALUATOR_IDENTITY,
  CRITERION_EVALUATOR_VERSION,
  EVALUABLE_CRITERION_TYPES,
  evaluateCriterion,
  observationFromCheckedPath,
  observationFromPathInfo
} = require('../runtime/postcondition-criterion-evaluator');

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// ── Three outcomes, and the third is not the second ─────────────────────────
{
  const criterion = { type: 'folder_exists', path: 'reports/a' };
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('reports/a', { exists: true, type: 'directory' })]).passed,
  true, 'an existing directory satisfies folder_exists');
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('reports/a', { exists: false })]).passed,
  false, 'an absent path does not satisfy folder_exists');

  // Nothing observed is NOT unsatisfied. Recording it as evidence would assert
  // something nobody checked.
  const unobserved = evaluateCriterion(criterion, []);
  assert.equal(unobserved.passed, null,
    'an unobserved criterion is unknown, not unsatisfied');
  assert.equal(unobserved.reasonCode, 'POSTCONDITION_EVIDENCE_UNAVAILABLE');
}

// ── path_absent ─────────────────────────────────────────────────────────────
{
  const criterion = { type: 'path_absent', path: 'tmp/scratch' };
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('tmp/scratch', { exists: false })]).passed, true);
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('tmp/scratch', { exists: true, type: 'directory' })]).passed,
  false, 'a path that exists does not satisfy path_absent');
}

// ── file_content_equals ─────────────────────────────────────────────────────
{
  const criterion = {
    type: 'file_content_equals', path: 'reports/a/report.md', contentSha256: sha('done')
  };
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('reports/a/report.md',
      { exists: true, type: 'file', content: 'done' })]).passed,
  true, 'matching content satisfies file_content_equals');
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('reports/a/report.md',
      { exists: true, type: 'file', content: 'different' })]).passed,
  false, 'different content does not satisfy it');
  assert.equal(evaluateCriterion(criterion,
    [observationFromPathInfo('reports/a/report.md', { exists: true, type: 'file' })]).passed,
  false, 'a file whose content is unknown is not a match');
}

// ── Unsupported criteria are unsupported, never unsatisfied ─────────────────
for (const type of ['fileExists', 'jsonPathEquals', 'processOperationExists', 'nonsense']) {
  const verdict = evaluateCriterion({ type, path: 'x' }, []);
  assert.equal(verdict.passed, null, `${type} is not decided by this evaluator`);
  assert.equal(verdict.reasonCode, 'POSTCONDITION_UNSUPPORTED',
    `${type} is reported unsupported rather than failed`);
}
assert.deepEqual([...EVALUABLE_CRITERION_TYPES],
  ['folder_exists', 'path_absent', 'file_content_equals'],
  'the evaluable set is closed');

// ── THE INVARIANT: both observation sources reach the same verdict ──────────
//
// The execution seam observes the live filesystem; the completion decision
// observes recorded claims. Same admitted criterion plus equivalent observed
// state must produce the same answer, or the two systems disagree about work
// that was actually done.
const cases = [
  {
    label: 'folder present',
    criterion: { type: 'folder_exists', path: 'reports/a' },
    pathInfo: { exists: true, type: 'directory' },
    checked: { type: 'folder', path: 'reports/a' }
  },
  {
    label: 'folder missing',
    criterion: { type: 'folder_exists', path: 'reports/a' },
    pathInfo: { exists: false },
    checked: { type: 'absent', path: 'reports/a' }
  },
  {
    label: 'path absent',
    criterion: { type: 'path_absent', path: 'tmp/scratch' },
    pathInfo: { exists: false },
    checked: { type: 'absent', path: 'tmp/scratch' }
  },
  {
    label: 'path still present',
    criterion: { type: 'path_absent', path: 'tmp/scratch' },
    pathInfo: { exists: true, type: 'directory' },
    checked: { type: 'folder', path: 'tmp/scratch' }
  },
  {
    label: 'file content matches',
    criterion: { type: 'file_content_equals', path: 'r.md', contentSha256: sha('ok') },
    pathInfo: { exists: true, type: 'file', content: 'ok' },
    checked: { type: 'file', path: 'r.md', expectedContent: 'ok' }
  },
  {
    label: 'file content differs',
    criterion: { type: 'file_content_equals', path: 'r.md', contentSha256: sha('ok') },
    pathInfo: { exists: true, type: 'file', content: 'no' },
    checked: { type: 'file', path: 'r.md', expectedContent: 'no' }
  }
];

for (const { label, criterion, pathInfo, checked } of cases) {
  const fromFilesystem = evaluateCriterion(criterion,
    [observationFromPathInfo(criterion.path, pathInfo)]);
  const fromClaims = evaluateCriterion(criterion,
    [observationFromCheckedPath(checked)]);
  assert.equal(fromFilesystem.passed, fromClaims.passed,
    `${label}: execution-time and completion-time verdicts agree`);
  assert.equal(fromFilesystem.authority, CRITERION_EVALUATOR_IDENTITY);
  assert.equal(fromClaims.authority, CRITERION_EVALUATOR_IDENTITY);
}

// ── The evaluator is pure ───────────────────────────────────────────────────
const source = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'runtime',
    'postcondition-criterion-evaluator.js'), 'utf8');
const executable = source.split('\n')
  .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
for (const [label, pattern] of [
  ['filesystem', /require\(['"]node:fs['"]\)|readFileSync|existsSync/],
  ['clock', /Date\.now\s*\(|new Date\(/],
  ['database', /query\(|pool\./],
  ['process state', /process\.(env|hrtime|uptime)/]
]) {
  assert.equal(pattern.test(executable), false,
    `the canonical criterion rule reads no ${label}`);
}
assert.equal(CRITERION_EVALUATOR_VERSION, 1);

console.log('postcondition criterion evaluator test passed');
