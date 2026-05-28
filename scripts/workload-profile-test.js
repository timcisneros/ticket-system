#!/usr/bin/env node
// Workload Profile Test — verifies profile detection, limits, and guidance.
//
// Scenarios:
// 1. Profile detection for all 5 profiles
// 2. Profile limits are applied and capped at base limits
// 3. Profile guidance is generated for each profile
// 4. Bulk-inventory profile has higher listDirectory limit than report
// 5. Refactor profile allows renamePath and expects verification phase

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
  return {};
}

function installInSandbox(fnCode, sandbox) {
  const keys = Object.keys(sandbox);
  const values = keys.map(k => sandbox[k]);
  const wrapper = new Function(...keys, fnCode + `
    const result = {};
    if (typeof detectWorkloadProfile !== 'undefined') result.detectWorkloadProfile = detectWorkloadProfile;
    if (typeof getProfileRuntimeLimits !== 'undefined') result.getProfileRuntimeLimits = getProfileRuntimeLimits;
    if (typeof buildProfileGuidance !== 'undefined') result.buildProfileGuidance = buildProfileGuidance;
    return result;
  `);
  const result = wrapper(...values);
  Object.assign(sandbox, result);
}

// ── Test 1: Profile detection for all 5 profiles ────────────────
function testProfileDetection() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'WORKLOAD_PROFILES') + '\n' +
    extractFunction(code, 'detectWorkloadProfile'),
    sandbox
  );

  const detect = sandbox.detectWorkloadProfile;

  // Report
  assertEqual(detect('Create a security risk report'), 'report', 'should detect report');
  assertEqual(detect('Generate a status summary'), 'report', 'should detect summary as report');

  // Diagnosis
  assertEqual(detect('Diagnose failing test assertions'), 'diagnosis', 'should detect diagnosis');
  assertEqual(detect('Find the bug in src/calc.js'), 'diagnosis', 'should detect bug as diagnosis');

  // Refactor
  assertEqual(detect('Move files to archive folder'), 'refactor', 'should detect refactor');
  assertEqual(detect('Rename old paths to new paths'), 'refactor', 'should detect rename as refactor');

  // Recommendation
  assertEqual(detect('Recommend top 3 critical fixes'), 'recommendation', 'should detect recommendation');
  assertEqual(detect('Provide improvement plan for codebase'), 'recommendation', 'should detect improvement as recommendation');

  // Bulk inventory
  assertEqual(detect('List all files in workspace'), 'bulk-inventory', 'should detect bulk-inventory');
  assertEqual(detect('Catalog every directory'), 'bulk-inventory', 'should detect catalog as bulk-inventory');

  // No match
  assertEqual(detect('Hello world'), null, 'should return null for no match');

  console.log('  ✓ profile-detection: all 5 profiles detected correctly');
}

// ── Test 2: Profile limits are applied and capped ─────────────────
function testProfileLimits() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'WORKLOAD_PROFILES') + '\n' +
    extractFunction(code, 'getProfileRuntimeLimits'),
    sandbox
  );

  const getLimits = sandbox.getProfileRuntimeLimits;
  const base = {
    maxExecutionSteps: 20,
    maxModelRequestsPerRun: 15,
    maxWorkspaceOperationsPerRun: 50,
    maxRuntimeDurationMs: 120000
  };

  // Report limits should be lower than base
  const reportLimits = getLimits(base, 'report');
  assertEqual(reportLimits.maxExecutionSteps, 12, 'report should cap steps at 12');
  assertEqual(reportLimits.maxModelRequestsPerRun, 8, 'report should cap model requests at 8');
  assertEqual(reportLimits.maxListDirectoryPerRun, 3, 'report should set listDir to 3');
  assertEqual(reportLimits.maxReadFilePerRun, 8, 'report should set readFile to 8');

  // Bulk inventory limits should be higher than report
  const inventoryLimits = getLimits(base, 'bulk-inventory');
  assertEqual(inventoryLimits.maxExecutionSteps, 16, 'bulk-inventory should cap steps at 16');
  assertEqual(inventoryLimits.maxModelRequestsPerRun, 10, 'bulk-inventory should cap model requests at 10');
  assertEqual(inventoryLimits.maxListDirectoryPerRun, 8, 'bulk-inventory should set listDir to 8');
  assertEqual(inventoryLimits.maxReadFilePerRun, 4, 'bulk-inventory should set readFile to 4');

  // Refactor limits
  const refactorLimits = getLimits(base, 'refactor');
  assertEqual(refactorLimits.maxListDirectoryPerRun, 2, 'refactor should set listDir to 2');
  assertEqual(refactorLimits.maxReadFilePerRun, 4, 'refactor should set readFile to 4');

  // Unknown profile returns base
  const unknownLimits = getLimits(base, 'nonexistent');
  assertEqual(unknownLimits.maxExecutionSteps, 20, 'unknown profile should return base');

  console.log('  ✓ profile-limits: limits applied and capped correctly');
}

// ── Test 3: Profile guidance is generated ───────────────────────
function testProfileGuidance() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'WORKLOAD_PROFILES') + '\n' +
    extractFunction(code, 'detectWorkloadProfile') + '\n' +
    extractFunction(code, 'buildProfileGuidance'),
    sandbox
  );

  const guidance = sandbox.buildProfileGuidance;

  // Report guidance
  const reportGuidance = guidance('Create a report');
  assert(reportGuidance.length > 0, 'report guidance should not be empty');
  assert(reportGuidance.some(l => l.includes('report')), 'report guidance should mention report');
  assert(reportGuidance.some(l => l.includes('listDirectory')), 'report guidance should mention listDirectory limit');

  // Diagnosis guidance
  const diagGuidance = guidance('Diagnose the bug');
  assert(diagGuidance.some(l => l.includes('root cause')), 'diagnosis guidance should mention root cause');

  // Refactor guidance
  const refactorGuidance = guidance('Move files to archive');
  assert(refactorGuidance.some(l => l.includes('renamePath')), 'refactor guidance should mention renamePath');
  assert(refactorGuidance.some(l => l.includes('verification')), 'refactor guidance should mention verification');

  // Recommendation guidance
  const recGuidance = guidance('Recommend top 3 fixes');
  assert(recGuidance.some(l => l.includes('critical')), 'recommendation guidance should mention critical');

  // Bulk inventory guidance
  const invGuidance = guidance('List all files');
  assert(invGuidance.some(l => l.includes('inventory')), 'bulk-inventory guidance should mention inventory');

  // No match
  assertEqual(guidance('Hello world').length, 0, 'no guidance for unknown objective');

  console.log('  ✓ profile-guidance: guidance generated for all profiles');
}

// ── Test 4: Bulk-inventory has higher listDirectory than report ─
function testBulkInventoryHigherListDir() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'WORKLOAD_PROFILES') + '\n' +
    extractFunction(code, 'getProfileRuntimeLimits'),
    sandbox
  );

  const getLimits = sandbox.getProfileRuntimeLimits;
  const base = { maxExecutionSteps: 20, maxModelRequestsPerRun: 15, maxWorkspaceOperationsPerRun: 50, maxRuntimeDurationMs: 120000 };

  const report = getLimits(base, 'report');
  const inventory = getLimits(base, 'bulk-inventory');

  assert(inventory.maxListDirectoryPerRun > report.maxListDirectoryPerRun,
    'bulk-inventory should have higher listDirectory limit than report');
  assertEqual(inventory.maxListDirectoryPerRun, 8, 'bulk-inventory listDir should be 8');
  assertEqual(report.maxListDirectoryPerRun, 3, 'report listDir should be 3');

  console.log('  ✓ bulk-inventory-higher-listdir: bulk-inventory allows 8 listDir vs report 3');
}

// ── Test 5: Refactor profile allows renamePath ────────────────────
function testRefactorAllowsRename() {
  const code = loadServerCode();

  const sandbox = makeSandbox();
  installInSandbox(
    extractConstant(code, 'WORKLOAD_PROFILES') + '\n' +
    extractFunction(code, 'detectWorkloadProfile') + '\n' +
    extractFunction(code, 'getProfileRuntimeLimits') + '\n' +
    extractFunction(code, 'buildProfileGuidance'),
    sandbox
  );

  const getLimits = sandbox.getProfileRuntimeLimits;
  const base = { maxExecutionSteps: 20, maxModelRequestsPerRun: 15, maxWorkspaceOperationsPerRun: 50, maxRuntimeDurationMs: 120000 };
  const refactorLimits = getLimits(base, 'refactor');

  // Verify the profile definition includes renamePath
  const profileConst = extractConstant(code, 'WORKLOAD_PROFILES');
  assert(profileConst.includes('renamePath'), 'refactor profile should include renamePath');
  assert(profileConst.includes('deletePath'), 'refactor profile should include deletePath');

  const guidance = sandbox.buildProfileGuidance('Move files');
  assert(guidance.some(l => l.includes('renamePath')), 'refactor guidance should mention renamePath');

  console.log('  ✓ refactor-allows-rename: refactor profile supports renamePath and deletePath');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Workload Profile Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testProfileDetection,
    testProfileLimits,
    testProfileGuidance,
    testBulkInventoryHigherListDir,
    testRefactorAllowsRename
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
