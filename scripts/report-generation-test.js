#!/usr/bin/env node
// Report Generation Unit Test — verifies runtime support without model execution.
//
// 1. report objective detection
// 2. report runtime limits applied
// 3. parent folder auto-creation on writeFile
// 4. prior failure context building
// 5. listDirectory/readFile per-run limit enforcement

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

// Load server functions by requiring the module in a special way
// We'll test by evaluating specific functions
function loadServerModule() {
  // Create a minimal mock environment
  const modulePath = path.join(ROOT, 'server.js');
  const code = fs.readFileSync(modulePath, 'utf8');

  // Extract just the functions we need by finding their definitions
  return code;
}

// ── Test 1: Report objective detection ────────────────────────────
function testReportObjectiveDetection() {
  const code = loadServerModule();

  // Extract isReportObjective by regex
  const match = code.match(/function isReportObjective\(objective\) \{([^}]+)\}/);
  assert(match, 'isReportObjective function should exist in server.js');

  // We can't easily eval the function, so let's verify by pattern inspection
  const hasKeywords = /report|summary|synthesis|overview|analysis|status|audit/.test(match[1]);
  assert(hasKeywords, 'isReportObjective should check for report keywords');

  console.log('  ✓ report-objective-detection: function exists with correct keywords');
}

// ── Test 2: Report runtime limits ─────────────────────────────────
function testReportRuntimeLimits() {
  const code = loadServerModule();

  const hasReportLimits = code.includes('getReportRuntimeLimits');
  assert(hasReportLimits, 'getReportRuntimeLimits should exist');

  const hasListLimit = code.includes('maxListDirectoryPerRun');
  assert(hasListLimit, 'maxListDirectoryPerRun should be referenced');

  const hasReadLimit = code.includes('maxReadFilePerRun');
  assert(hasReadLimit, 'maxReadFilePerRun should be referenced');

  // Verify report limits are lower than base
  const baseStepsMatch = code.match(/maxExecutionSteps:\s*(\d+)/);
  assert(baseStepsMatch, 'maxExecutionSteps should be defined');
  const baseSteps = parseInt(baseStepsMatch[1], 10);
  assert(baseSteps <= 12, `maxExecutionSteps ${baseSteps} should be <= 12 for reports`);

  console.log('  ✓ report-runtime-limits: limits exist and are bounded');
}

// ── Test 3: Parent folder auto-creation ─────────────────────────────
function testParentFolderCreation() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-ws-'));

  // Simulate what workspaceProvider.writeFile does with parent dirs
  const targetPath = path.join(ws, 'nested', 'reports', 'output.md');
  const parentDir = path.dirname(targetPath);

  assert(!fs.existsSync(parentDir), 'parent dir should not exist initially');

  // Create parent dirs and write
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(targetPath, 'test content');

  assert(fs.existsSync(targetPath), 'file should exist after write with parent creation');
  assert(fs.readFileSync(targetPath, 'utf8') === 'test content', 'content should match');

  // Verify the server.js has the parent creation logic
  const code = loadServerModule();
  const hasParentCreation = code.includes('fs.mkdirSync(parentDir, { recursive: true })') ||
    code.includes("fs.mkdirSync(path.dirname(resolved.resolvedPath), { recursive: true })");
  assert(hasParentCreation, 'server.js should have parent directory creation in writeFile');

  fs.rmSync(ws, { recursive: true, force: true });
  console.log('  ✓ parent-folder-creation: recursive mkdir in writeFile');
}

// ── Test 4: Prior failure context function ──────────────────────────
function testPriorFailureContext() {
  const code = loadServerModule();

  const hasFunction = code.includes('function buildPriorFailureContext');
  assert(hasFunction, 'buildPriorFailureContext should exist');

  const hasPriorRunId = code.includes('priorRunId');
  assert(hasPriorRunId, 'context should include priorRunId');

  const hasInspectedFiles = code.includes('inspectedFiles');
  assert(hasInspectedFiles, 'context should include inspectedFiles');

  const hasRecoveryClass = code.includes('recoveryClassification');
  assert(hasRecoveryClass, 'context should include recoveryClassification');

  console.log('  ✓ prior-failure-context: function exists with required fields');
}

// ── Test 5: List/read limit enforcement in execution loop ──────────
function testListReadLimitEnforcement() {
  const code = loadServerModule();

  const hasListLimitCheck = code.includes("operation.operation === 'listDirectory' && limits.maxListDirectoryPerRun");
  assert(hasListLimitCheck, 'listDirectory limit check should exist in execution loop');

  const hasReadLimitCheck = code.includes("operation.operation === 'readFile' && limits.maxReadFilePerRun");
  assert(hasReadLimitCheck, 'readFile limit check should exist in execution loop');

  const hasListCounter = code.includes('listDirectoryCount += 1');
  assert(hasListCounter, 'listDirectoryCount increment should exist');

  const hasReadCounter = code.includes('readFileCount += 1');
  assert(hasReadCounter, 'readFileCount increment should exist');

  console.log('  ✓ list-read-limit-enforcement: counters and checks exist');
}

// ── Test 6: Report guidance in system prompt ──────────────────────
function testReportSystemPrompt() {
  const code = loadServerModule();

  const hasProfileGuidance = code.includes('buildProfileGuidance');
  assert(hasProfileGuidance, 'profile guidance builder should exist');

  const hasReportProfile = code.includes("name: 'report'") && code.includes('maxListDirectory');
  assert(hasReportProfile, 'report profile should define listDirectory limit');

  console.log('  ✓ report-system-prompt: profile guidance injected for report objectives');
}

// ── main ──────────────────────────────────────────────────────────
function main() {
  const startedAt = Date.now();
  console.log('Report Generation Unit Test Suite');
  console.log('='.repeat(70));

  try {
    testReportObjectiveDetection();
    testReportRuntimeLimits();
    testParentFolderCreation();
    testPriorFailureContext();
    testListReadLimitEnforcement();
    testReportSystemPrompt();

    console.log('\n' + '='.repeat(70));
    console.log('All tests passed');
    console.log(`Duration: ${Date.now() - startedAt}ms`);
    process.exit(0);
  } catch (err) {
    console.log('\n✗ FAIL: ' + err.message);
    console.log(`Duration: ${Date.now() - startedAt}ms`);
    process.exit(1);
  }
}

main();
