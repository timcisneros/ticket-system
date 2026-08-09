#!/usr/bin/env node
'use strict';

// Focused mutation proof for the frozen Tranche 6 scoring contract.
//
// Unlike the repository-wide mutation tool, this harness never rewrites the
// working tree. Each mutant is compiled in memory in a fresh child process and
// the smallest deterministic owner must fail with the assertion that names the
// removed contract. The source file hash is checked before and after every
// child, so a kill caused by an unrelated write cannot be counted.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const MUTATIONS = Object.freeze([
  Object.freeze({
    name: 'planner-request-omitted',
    file: 'scripts/structured-allocation-evaluation-report.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: 'return Object.freeze([...governed, ...ungoverned]);',
    replace: 'return Object.freeze([...ungoverned]);',
    failure: 'metered planning-attempt reservation contributes one planner request'
  }),
  Object.freeze({
    name: 'planner-metered-usage-ignored',
    file: 'scripts/structured-allocation-evaluation-report.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: 'inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens });',
    replace: 'inputTokens: 0, outputTokens: receipt.outputTokens });',
    failure: 'metered planning-attempt reservation contributes one planner request'
  }),
  Object.freeze({
    name: 'planner-authorized-maximum-ignored',
    file: 'scripts/structured-allocation-evaluation-report.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: 'authorizedOutputTokens: output, boundInputTokens: input });',
    replace: 'authorizedOutputTokens: output, boundInputTokens: 0 });',
    failure: 'unmetered planner settlement carries its captured authorized maximum'
  }),
  Object.freeze({
    name: 'family-false-positive-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'if (rate(structured.trials) > rate(baseline)) {',
    replace: 'if (false) {',
    failure: 'overall-safe aggregate cannot hide one family'
  }),
  Object.freeze({
    name: 'cost-ceiling-trigger-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'return { complete: true, exceeded: derived };',
    replace: 'return { complete: true, exceeded: false };',
    failure: 'normalized cost above the captured economic ceiling triggers'
  }),
  Object.freeze({
    name: 'overall-gain-versus-a-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'gainA >= thresholds.retain.truePositiveGainVersusAPoints },',
    replace: 'true },',
    failure: 'existing overall gain-versus-A threshold is independently executable'
  }),
  Object.freeze({
    name: 'overall-gain-versus-a2-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'gainA2 >= thresholds.retain.truePositiveGainVersusA2Points }',
    replace: 'true }',
    failure: 'existing overall gain-versus-A2 threshold is independently executable'
  }),
  Object.freeze({
    name: 'family-gain-versus-a-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'value.truePositiveGainVersusAPoints >= thresholds.retain.truePositiveGainVersusAPoints),',
    replace: 'true),',
    failure: 'per-family gain versus A is an executable RETAIN hinge'
  }),
  Object.freeze({
    name: 'family-gain-versus-a2-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'value.truePositiveGainVersusA2Points >= thresholds.retain.truePositiveGainVersusA2Points),',
    replace: 'true),',
    failure: 'per-family gain versus A2 is an executable RETAIN hinge'
  }),
  Object.freeze({
    name: 'family-latency-ratio-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'latencyPassed: Boolean(value && value.latencyRatioVersusA.passed),',
    replace: 'latencyPassed: true,',
    failure: '1.5x family latency bound is an executable RETAIN hinge'
  }),
  Object.freeze({
    name: 'family-cost-ratio-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'costPassed: Boolean(value && value.costRatioVersusA.passed),',
    replace: 'costPassed: true,',
    failure: '1.5x cost-per-truthful-completion bound is an executable RETAIN hinge'
  }),
  Object.freeze({
    name: 'no-family-worse-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'const noFamilyWorse = comparableFamilies.length > 0 && comparableFamilies.every(([, value]) =>\n' +
      '    value.truthfulnessNoWorse && value.falsePositiveNoWorseThanA);',
    replace: 'const noFamilyWorse = true;',
    failure: 'one non-required family worse on truthfulness blocks RETAIN'
  }),
  Object.freeze({
    name: 'repetition-inconclusive-disabled',
    file: 'scripts/structured-allocation-evaluation-scorer.js',
    suite: 'structured-allocation-scored-evaluation-test.js',
    find: 'value.repetitionConsistency.evaluable && value.repetitionConsistency.consistent),',
    replace: 'true),',
    failure: 'disagreeing repeated completion verdicts are INCONCLUSIVE'
  }),
  Object.freeze({
    name: 'live-v2-required-family-check-disabled',
    file: 'scripts/fixtures/evaluation-live-v2-matrix.js',
    suite: 'evaluation-live-decision-topology-test.js',
    find: 'for (const family of REQUIRED_FAMILIES) {',
    replace: 'for (const family of REQUIRED_FAMILIES.slice(1)) {',
    failure: 'removing a required family fails the release topology gate'
  }),
  Object.freeze({
    name: 'live-v2-arm-a-baseline-check-disabled',
    file: 'scripts/fixtures/evaluation-live-v2-matrix.js',
    suite: 'evaluation-live-decision-topology-test.js',
    edits: Object.freeze([
      Object.freeze({
        find: 'const missing = ALL_ARMS.filter(arm => !arms.has(arm));',
        replace: "const missing = ALL_ARMS.filter(arm => arm !== 'A' && !arms.has(arm));"
      }),
      Object.freeze({
        find: 'const unmatched = ALL_ARMS.filter(arm => !matched.has(arm));',
        replace: "const unmatched = ALL_ARMS.filter(arm => arm !== 'A' && !matched.has(arm));"
      }),
      Object.freeze({
        find: "if ((arms.has('B') || arms.has('C')) && !arms.has('A')) {",
        replace: 'if (false) {'
      })
    ]),
    failure: 'a structured family cannot lose its arm A comparison baseline'
  }),
  Object.freeze({
    name: 'live-v2-second-cell-check-disabled',
    file: 'scripts/fixtures/evaluation-live-v2-matrix.js',
    suite: 'evaluation-live-decision-topology-test.js',
    find: 'if (familyCellIds.length < 2) {',
    replace: 'if (false) {',
    failure: 'a required family cannot lose the second cell needed for cost/gain evaluability'
  }),
  Object.freeze({
    name: 'live-v2-matched-cell-check-disabled',
    file: 'scripts/fixtures/evaluation-live-v2-matrix.js',
    suite: 'evaluation-live-decision-topology-test.js',
    find: 'if (unmatched.length > 0) {\n        throw new LiveV2MatrixError(\n          `${cellId} is not a matched five-arm comparison; missing ${unmatched.join(\', \')}`',
    replace: 'if (false) {\n        throw new LiveV2MatrixError(\n          `${cellId} is not a matched five-arm comparison; missing ${unmatched.join(\', \')}`',
    failure: 'each selected scenario must remain matched across all five arms'
  }),
  Object.freeze({
    name: 'live-v2-stochastic-identity-varies-by-repetition',
    file: 'scripts/fixtures/evaluation-live-manifest-v2.js',
    suite: 'evaluation-live-manifest-test.js',
    find: 'cellKey: cell.cellKey\n          })',
    replace: 'cellKey: `${cell.cellKey}|repetition-${repetition}`\n          })',
    failure: 'the committed live-v2 manifest reproduces byte-identically from source'
  }),
  Object.freeze({
    name: 'real-live-fixture-staging-restored',
    file: 'scripts/structured-allocation-evaluation-runner.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: "if (mode === 'live') return NO_STAGED_RESPONSES;",
    replace: "if (false) return NO_STAGED_RESPONSES;",
    failure: 'real live mode stages no fixture responses'
  }),
  Object.freeze({
    name: 'real-live-envelope-hashes-temporary-agents',
    file: 'scripts/structured-allocation-evaluation-runner.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: "? 'REAL_LIVE_NO_FIXTURE_RESPONSE_STAGED'\n      : JSON.stringify(staged)",
    replace: '? JSON.stringify(staged)\n      : JSON.stringify(staged)',
    failure: 'live comparison identity is stable across temporary agents'
  }),
  Object.freeze({
    name: 'live-v2-objective-loses-evaluable-facts',
    file: 'scripts/fixtures/evaluation-scenarios.js',
    suite: 'structured-allocation-evaluation-test.js',
    find: "objective: 'Create folders reports/separable-alpha/done and ' +",
    replace: "objective: 'Create independent folders reports/separable-alpha/done and ' +",
    failure: 'family-2-cleanly-separable admits two execution-evaluable folder facts'
  })
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scrubProviderEnvironment(environment) {
  const result = { ...environment, NODE_ENV: environment.NODE_ENV || 'test' };
  for (const key of Object.keys(result)) {
    if (/OPENAI|LIVE.*AUTH|AUTH.*LIVE|PROVIDER.*CALL/i.test(key)) delete result[key];
  }
  return result;
}

function editsOf(mutation) {
  return mutation.edits || [{ find: mutation.find, replace: mutation.replace }];
}

function installMutant(mutation) {
  const target = path.join(ROOT, mutation.file);
  const originalLoader = Module._extensions['.js'];
  Module._extensions['.js'] = function loadMutated(module, filename) {
    if (path.resolve(filename) !== target) return originalLoader(module, filename);
    const source = fs.readFileSync(filename, 'utf8');
    let mutated = source;
    for (const edit of editsOf(mutation)) {
      const occurrences = mutated.split(edit.find).length - 1;
      assert.equal(occurrences, 1,
        `${mutation.name} must match exactly one source anchor, found ${occurrences}`);
      mutated = mutated.replace(edit.find, edit.replace);
    }
    module._compile(mutated, filename);
  };
}

function childMain(name) {
  const mutation = MUTATIONS.find(entry => entry.name === name);
  if (!mutation) throw new Error(`unknown mutation ${String(name)}`);
  installMutant(mutation);
  require(path.join(ROOT, 'scripts', mutation.suite));
}

function main() {
  let killed = 0;
  for (const mutation of MUTATIONS) {
    const target = path.join(ROOT, mutation.file);
    const before = fs.readFileSync(target);
    for (const edit of editsOf(mutation)) {
      const occurrences = before.toString('utf8').split(edit.find).length - 1;
      assert.equal(occurrences, 1,
        `${mutation.name} must match exactly one source anchor, found ${occurrences}`);
    }
    const child = spawnSync(process.execPath, [__filename, '--mutant', mutation.name], {
      cwd: ROOT,
      env: scrubProviderEnvironment(process.env),
      encoding: 'utf8',
      timeout: 60_000
    });
    const output = `${child.stdout || ''}${child.stderr || ''}`;
    assert.notEqual(child.status, 0, `${mutation.name} survived its focused owner`);
    assert.match(output, new RegExp(mutation.failure.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${mutation.name} died outside the assertion for its own contract`);
    assert.equal(sha256(fs.readFileSync(target)), sha256(before),
      `${mutation.name} changed tracked source bytes`);
    killed += 1;
    console.log(`  ok ${mutation.name}`);
  }
  console.log(`evaluation scoring contract mutations passed — ${killed}/${MUTATIONS.length} killed`);
}

if (process.argv[2] === '--mutant') childMain(process.argv[3]);
else main();
