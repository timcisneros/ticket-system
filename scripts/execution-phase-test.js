#!/usr/bin/env node
// Execution Phase Test — verifies the single-response single-phase invariant.
//
// Invariant: a single model response must belong to exactly one execution phase.
// Phase state tracks forward progression for observability, but does not
// constrain which single-phase response the model may emit.
//
// Scenarios:
// 1. Mixed inspection + mutation in one response rejected
// 2. Mixed mutation + verification in one response rejected
// 3. Pure single-phase responses are always allowed
// 4. Phase state advances forward across responses
// 5. Terminalization blocks further actions

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function loadServerCode() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function extractFunction(code, name) {
  const pattern = new RegExp(`function ${name}\\b[^{]*\\{`);
  const match = code.match(pattern);
  if (!match) return null;
  const start = match.index;
  let depth = 0;
  let i = start + match[0].length - 1;
  while (i < code.length) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
    if (depth === 0) break;
  }
  return code.slice(start, i);
}

function extractConstant(code, name) {
  const pattern = new RegExp(`(const|let|var) ${name}\\s*=\\s*[{\\[]`);
  const match = code.match(pattern);
  if (!match) return null;
  const start = match.index;
  let i = start + match[0].length - 1;
  let depth = 0;
  let inString = false;
  let stringChar = null;
  while (i < code.length) {
    const ch = code[i];
    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === stringChar) inString = false;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
    } else if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        i++;
        while (i < code.length && /[;\\s]/.test(code[i])) i++;
        break;
      }
    }
    i++;
  }
  return code.slice(start, i);
}

function makeSandbox() {
  const runs = [];
  return {
    readRuns: () => runs,
    writeRuns: (newRuns) => {
      runs.length = 0;
      for (const r of newRuns) runs.push(r);
    }
  };
}

function installInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  const wrapper = new Function(...keys, fnCode + `
    const result = {};
    if (typeof inferPhaseFromActions !== 'undefined') result.inferPhaseFromActions = inferPhaseFromActions;
    if (typeof isPhaseTransitionAllowed !== 'undefined') result.isPhaseTransitionAllowed = isPhaseTransitionAllowed;
    if (typeof checkPhaseCompliance !== 'undefined') result.checkPhaseCompliance = checkPhaseCompliance;
    if (typeof advanceRunPhase !== 'undefined') result.advanceRunPhase = advanceRunPhase;
    return result;
  `);
  const result = wrapper(...values);
  Object.assign(sandbox, result);
}

// ── Test 1: Mixed inspection + mutation in one response rejected ──
function testMixedInspectionMutation() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'PHASE_OPERATIONS') + '\n' +
    extractConstant(code, 'ALLOWED_PHASE_TRANSITIONS') + '\n' +
    extractFunction(code, 'inferPhaseFromActions') + '\n' +
    extractFunction(code, 'isPhaseTransitionAllowed') + '\n' +
    extractFunction(code, 'checkPhaseCompliance'),
    sandbox
  );

  const check = sandbox.checkPhaseCompliance;

  // readFile + writeFile in same response → mixed_phase violation
  const result = check({ currentPhase: 'inspection' }, [
    { operation: 'readFile', args: { path: 'a.txt' } },
    { operation: 'writeFile', args: { path: 'b.txt' } }
  ]);
  assertEqual(result.compliant, false, 'readFile + writeFile in one response should be rejected');
  assertEqual(result.violationType, 'mixed_phase', 'should be mixed_phase');

  // listDirectory + createFolder in same response → mixed_phase violation
  const result2 = check({ currentPhase: 'planning' }, [
    { operation: 'listDirectory', args: { path: '' } },
    { operation: 'createFolder', args: { path: 'dir' } }
  ]);
  assertEqual(result2.compliant, false, 'listDirectory + createFolder in one response should be rejected');
  assertEqual(result2.violationType, 'mixed_phase', 'should be mixed_phase');

  console.log('  ✓ mixed-inspection-mutation: mixed-phase responses rejected');
}

// ── Test 2: Mixed mutation + verification in one response rejected ─
function testMixedMutationVerification() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'PHASE_OPERATIONS') + '\n' +
    extractConstant(code, 'ALLOWED_PHASE_TRANSITIONS') + '\n' +
    extractFunction(code, 'inferPhaseFromActions') + '\n' +
    extractFunction(code, 'isPhaseTransitionAllowed') + '\n' +
    extractFunction(code, 'checkPhaseCompliance'),
    sandbox
  );

  const check = sandbox.checkPhaseCompliance;

  // writeFile + readFile in same response → mixed_phase violation
  const result = check({ currentPhase: 'mutation' }, [
    { operation: 'writeFile', args: { path: 'a.txt' } },
    { operation: 'readFile', args: { path: 'b.txt' } }
  ]);
  assertEqual(result.compliant, false, 'writeFile + readFile in one response should be rejected');
  assertEqual(result.violationType, 'mixed_phase', 'should be mixed_phase');

  // renamePath + listDirectory in same response → mixed_phase violation
  const result2 = check({ currentPhase: 'mutation' }, [
    { operation: 'renamePath', args: { path: 'a.txt', nextPath: 'b.txt' } },
    { operation: 'listDirectory', args: { path: '' } }
  ]);
  assertEqual(result2.compliant, false, 'renamePath + listDirectory in one response should be rejected');
  assertEqual(result2.violationType, 'mixed_phase', 'should be mixed_phase');

  console.log('  ✓ mixed-mutation-verification: mixed-phase responses rejected');
}

// ── Test 3: Pure single-phase responses are always allowed ────────
function testPureSinglePhaseAllowed() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'PHASE_OPERATIONS') + '\n' +
    extractConstant(code, 'ALLOWED_PHASE_TRANSITIONS') + '\n' +
    extractFunction(code, 'inferPhaseFromActions') + '\n' +
    extractFunction(code, 'isPhaseTransitionAllowed') + '\n' +
    extractFunction(code, 'checkPhaseCompliance'),
    sandbox
  );

  const check = sandbox.checkPhaseCompliance;

  // Pure inspection from any phase is allowed
  assertEqual(check({ currentPhase: 'planning' }, [{ operation: 'readFile' }]).compliant, true, 'pure readFile from planning');
  assertEqual(check({ currentPhase: 'inspection' }, [{ operation: 'listDirectory' }]).compliant, true, 'pure listDirectory from inspection');
  assertEqual(check({ currentPhase: 'mutation' }, [{ operation: 'readFile' }]).compliant, true, 'pure readFile from mutation');
  assertEqual(check({ currentPhase: 'verification' }, [{ operation: 'readFile' }]).compliant, true, 'pure readFile from verification');

  // Pure mutation from any phase is allowed
  assertEqual(check({ currentPhase: 'planning' }, [{ operation: 'writeFile' }]).compliant, true, 'pure writeFile from planning');
  assertEqual(check({ currentPhase: 'inspection' }, [{ operation: 'writeFile' }]).compliant, true, 'pure writeFile from inspection');
  assertEqual(check({ currentPhase: 'mutation' }, [{ operation: 'createFolder' }]).compliant, true, 'pure createFolder from mutation');

  // Empty actions (planning) from any non-terminal phase is allowed
  assertEqual(check({ currentPhase: 'inspection' }, []).compliant, true, 'empty response from inspection');
  assertEqual(check({ currentPhase: 'mutation' }, []).compliant, true, 'empty response from mutation');

  console.log('  ✓ pure-single-phase-allowed: single-phase responses always allowed');
}

// ── Test 4: Phase state advances forward across responses ─────────
function testPhaseStateAdvancesForward() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'PHASE_OPERATIONS') + '\n' +
    extractConstant(code, 'ALLOWED_PHASE_TRANSITIONS') + '\n' +
    extractFunction(code, 'inferPhaseFromActions') + '\n' +
    extractFunction(code, 'isPhaseTransitionAllowed') + '\n' +
    extractFunction(code, 'checkPhaseCompliance') + '\n' +
    extractFunction(code, 'advanceRunPhase'),
    sandbox
  );

  const advance = sandbox.advanceRunPhase;

  // Forward progression: planning → inspection
  const run1 = { currentPhase: 'planning', id: 1 };
  advance(run1, 'inspection');
  assertEqual(run1.currentPhase, 'inspection', 'planning → inspection should advance');

  // Forward progression: inspection → mutation
  const run2 = { currentPhase: 'inspection', id: 2 };
  advance(run2, 'mutation');
  assertEqual(run2.currentPhase, 'mutation', 'inspection → mutation should advance');

  // Forward progression: mutation → verification
  const run3 = { currentPhase: 'mutation', id: 3 };
  advance(run3, 'verification');
  assertEqual(run3.currentPhase, 'verification', 'mutation → verification should advance');

  // Forward progression: verification → terminalization
  const run4 = { currentPhase: 'verification', id: 4 };
  advance(run4, 'terminalization');
  assertEqual(run4.currentPhase, 'terminalization', 'verification → terminalization should advance');

  // Backward move: mutation → inspection should NOT advance state
  const run5 = { currentPhase: 'mutation', id: 5 };
  advance(run5, 'inspection');
  assertEqual(run5.currentPhase, 'mutation', 'mutation → inspection should NOT advance (backward)');

  // Same phase: no change
  const run6 = { currentPhase: 'mutation', id: 6 };
  advance(run6, 'mutation');
  assertEqual(run6.currentPhase, 'mutation', 'mutation → mutation should stay same');

  console.log('  ✓ phase-state-advances-forward: phase tracks forward progression only');
}

// ── Test 5: Terminalization blocks further actions ──────────────────
function testTerminalizationBlocksActions() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'PHASE_OPERATIONS') + '\n' +
    extractConstant(code, 'ALLOWED_PHASE_TRANSITIONS') + '\n' +
    extractFunction(code, 'inferPhaseFromActions') + '\n' +
    extractFunction(code, 'isPhaseTransitionAllowed') + '\n' +
    extractFunction(code, 'checkPhaseCompliance'),
    sandbox
  );

  const check = sandbox.checkPhaseCompliance;

  // Terminalization with readFile → rejected (terminalization blocks)
  const result1 = check({ currentPhase: 'terminalization' }, [{ operation: 'readFile' }]);
  assertEqual(result1.compliant, false, 'readFile in terminalization should be blocked');

  // Terminalization with writeFile → rejected
  const result2 = check({ currentPhase: 'terminalization' }, [{ operation: 'writeFile' }]);
  assertEqual(result2.compliant, false, 'writeFile in terminalization should be blocked');

  // Terminalization with no actions → allowed (stays in terminalization)
  const result3 = check({ currentPhase: 'terminalization' }, []);
  assertEqual(result3.compliant, true, 'empty response in terminalization should be allowed');

  console.log('  ✓ terminalization-blocks-actions: terminalization rejects all workspace ops');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Execution Phase Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testMixedInspectionMutation,
    testMixedMutationVerification,
    testPureSinglePhaseAllowed,
    testPhaseStateAdvancesForward,
    testTerminalizationBlocksActions
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      test();
      passed++;
    } catch (err) {
      failed++;
      console.log(`  ✗ ${test.name}: ${err.message}`);
    }
  }

  console.log('='.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
