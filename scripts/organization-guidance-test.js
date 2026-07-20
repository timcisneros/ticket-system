#!/usr/bin/env node
// Organization Guidance Test — verifies refactor profile includes
// explicit 4-phase progression guidance with bounded batch semantics.
//
// Scenarios:
// 1. Refactor guidance includes DISCOVER phase with single listDirectory
// 2. Refactor guidance includes MUTATE phase with bounded batches
// 3. Refactor guidance includes VERIFY phase after mutations
// 4. Refactor guidance includes COMPLETE phase
// 5. Refactor guidance forbids repeated DISCOVER unless evidence insufficient
// 6. Refactor guidance requires explicit failure for indeterminate paths

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
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

// ── Test 1: Refactor guidance includes DISCOVER phase ────────────
function testDiscoverPhase() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');
  assert(profileConst, 'WORKLOAD_PROFILES should exist');
  assert(profileConst.includes('DISCOVER'), 'refactor guidance should include DISCOVER phase');
  assert(profileConst.includes('listDirectory the relevant directory ONCE'), 'discover should say list once');
  assert(profileConst.includes('Phase 1'), 'refactor guidance should number phases');
  assert(!profileConst.includes('PLAN'), 'refactor guidance should NOT include a PLAN phase');

  console.log('  ✓ discover-phase: refactor guidance includes explicit DISCOVER phase, no PLAN phase');
}

// ── Test 2: Refactor guidance includes MUTATE with bounded batches ─
function testMutatePhase() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');

  assert(profileConst.includes('MUTATE'), 'refactor guidance should include MUTATE phase');
  assert(profileConst.includes('bounded mutation batches'), 'mutate should mention bounded mutation batches');
  assert(profileConst.includes('Respect maxMutatingActionsPerResponse'), 'mutate should reference mutation limit');
  assert(profileConst.includes('next bounded mutation batch'), 'mutate should describe continuation batches');

  console.log('  ✓ mutate-phase: refactor guidance includes bounded batch MUTATE phase');
}

// ── Test 3: Refactor guidance defers VERIFY until after mutations ──
function testVerifyPhase() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');

  assert(profileConst.includes('VERIFY'), 'refactor guidance should include VERIFY phase');
  assert(profileConst.includes('listDirectory the affected directories'), 'verify should mention listDirectory confirmation');
  assert(profileConst.includes('Verify only after at least one mutation batch has executed'), 'verify must be deferred until after mutations');

  console.log('  ✓ verify-phase: refactor guidance defers verification until after mutation batch');
}

// ── Test 4: Refactor guidance includes COMPLETE phase ────────────
function testCompletePhase() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');

  assert(profileConst.includes('COMPLETE'), 'refactor guidance should include COMPLETE phase');
  assert(profileConst.includes('complete:true'), 'complete phase should mention complete:true');
  assert(profileConst.includes('after verification succeeds'), 'complete should be gated on verification');

  console.log('  ✓ complete-phase: refactor guidance includes explicit COMPLETE phase');
}

// ── Test 5: Refactor guidance forbids repeated DISCOVER ──────────
function testNoRepeatedDiscover() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');

  assert(profileConst.includes('Do not repeat DISCOVER'), 'guidance should forbid repeating DISCOVER');
  assert(profileConst.includes('Do not list again in later steps'), 'guidance should explicitly forbid later listing');
  assert(profileConst.includes('unless evidence is insufficient'), 'guidance should allow exception only for insufficient evidence');
  assert(profileConst.includes('loop of repeated listDirectory'), 'guidance should warn against listDirectory loops');

  console.log('  ✓ no-repeated-discover: refactor guidance forbids repeated DISCOVER');
}

// ── Test 6: Refactor guidance requires explicit failure ───────────
function testExplicitFailure() {
  const code = loadServerCode();
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');

  assert(profileConst.includes('cannot be determined'), 'guidance should mention indeterminate paths case');
  assert(profileConst.includes('fail with an explicit reason'), 'guidance should require explicit failure reason');

  console.log('  ✓ explicit-failure: refactor guidance requires explicit failure for indeterminate paths');
}

// ── Test 7: Transition guidance exists and is generic ──────────────
function testTransitionGuidance() {
  const code = loadServerCode();
  const transitionFn = extractFunction(code, 'buildTransitionGuidance');
  assert(transitionFn, 'buildTransitionGuidance should exist');
  assert(transitionFn.includes('listDirectory'), 'transition guidance should check for listDirectory');
  assert(transitionFn.includes('readFile'), 'transition guidance should check for readFile');
  assert(transitionFn.includes('Previous inspection is complete'), 'transition guidance should declare inspection complete');
  assert(transitionFn.includes('Do not call listDirectory'), 'transition guidance should forbid repeated inspection');
  assert(transitionFn.includes('maxMutatingActionsPerResponse'), 'transition guidance should reference mutation limit');
  assert(transitionFn.includes('fail explicitly'), 'transition guidance should require explicit failure');

  // Verify it is called in buildAgentPrompt
  const promptFn = extractFunction(code, 'buildAgentPrompt');
  assert(promptFn.includes('buildTransitionGuidance'), 'buildAgentPrompt should call buildTransitionGuidance');

  console.log('  ✓ transition-guidance: generic transition from DISCOVER to MUTATE exists');
}

// ── Test 8: Transition guidance is injected after successful list ───
function testTransitionGuidanceInjection() {
  const code = loadServerCode();
  const transitionFn = extractFunction(code, 'buildTransitionGuidance');

  // Verify it filters to actual workspace ops
  assert(transitionFn.includes('item.action.operation'), 'transition guidance should inspect action operations');
  // Verify it requires all to be inspection-only
  assert(transitionFn.includes("return op === 'listDirectory' || op === 'readFile'"), 'transition guidance should detect inspection-only responses');
  // Verify it requires all to succeed
  assert(transitionFn.includes('!result.error'), 'transition guidance should require successful results');

  console.log('  ✓ transition-guidance-injection: guidance only fires after successful inspection-only responses');
}

// ── Test 9: Phase-gated catalog exposes currentPhase in prompt ─────
function testPhaseGatedCatalog() {
  const code = loadServerCode();
  const promptFn = extractFunction(code, 'buildAgentPrompt');

  assert(promptFn.includes('currentPhase'), 'prompt should reference currentPhase');
  assert(promptFn.includes('getAllowedOperationsForPhase') && promptFn.includes('currentPhaseAllowedOps'), 'prompt should derive current phase operations');

  const catalogFn = extractFunction(code, 'getAllowedOperationsForPhase');
  assert(catalogFn, 'getAllowedOperationsForPhase should exist');
  assert(catalogFn.includes('PHASE_OPERATIONS'), 'catalog should use PHASE_OPERATIONS');
  assert(catalogFn.includes('phase'), 'catalog should reference its phase argument');

  console.log('  ✓ phase-gated-catalog: prompt uses phase-gated operation catalog');
}

// ── Test 10: Prompt explicitly tells model not to repeat inspection in mutation ─
function testNoRepeatInspectionInMutationPrompt() {
  const code = loadServerCode();
  const promptFn = extractFunction(code, 'buildAgentPrompt');

  assert(promptFn.includes('do not emit listDirectory or readFile again'), 'prompt should forbid repeated inspection in mutation phase');

  console.log('  ✓ no-repeat-inspection-in-mutation: prompt explicitly forbids repeated inspection in mutation');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Organization Guidance Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testDiscoverPhase,
    testMutatePhase,
    testVerifyPhase,
    testCompletePhase,
    testNoRepeatedDiscover,
    testExplicitFailure,
    testTransitionGuidance,
    testTransitionGuidanceInjection,
    testPhaseGatedCatalog,
    testNoRepeatInspectionInMutationPrompt
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
