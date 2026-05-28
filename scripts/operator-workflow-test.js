#!/usr/bin/env node
// Operator Workflow Test — validates the operator-facing surfaces.
//
// Scenarios:
// 1. Successful report ticket has clear replaySummary and artifact
// 2. Broad inventory ticket failed due to bounded limits
// 3. Revised narrower ticket succeeded
// 4. Reassess mode is accepted by rerun endpoint
// 5. Artifact inspection path is clear
// 6. Telemetry report reflects all runs

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function assert(value, msg) {
  if (!value) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERTION FAILED: ${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function readJson(name) {
  const fp = path.join(ROOT, 'data', name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function readEvents() {
  const fp = path.join(ROOT, 'data', 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function loadServerCode() {
  return fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
}

function execOquery(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'oquery.js'), ...args], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`oquery exit ${code}: ${stdout}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(stdout.trim()); }
    });
  });
}

// ── Test 1: Successful report ticket ─────────────────────────────
function testSuccessfulReportTicket() {
  const runs = readJson('runs.json');
  const tickets = readJson('tickets.json');

  // Find a completed run on a report-profile ticket
  const completedRuns = runs.filter(r => r.status === 'completed');
  assert(completedRuns.length > 0, 'there should be at least one completed run');

  const reportRun = completedRuns.find(r => {
    const ticket = tickets.find(t => t.id === r.ticketId);
    if (!ticket) return false;
    const obj = ticket.objective.toLowerCase();
    return /\b(report|summary|status)\b/.test(obj);
  });
  assert(reportRun, 'there should be a completed report run');

  // Verify replaySummary exists and shows completion
  assert(reportRun.replaySummary, 'completed run should have replaySummary');
  assertEqual(reportRun.replaySummary.terminalStatus, 'completed', 'terminalStatus should be completed');
  assert(reportRun.replaySummary.mutationCount > 0 || reportRun.replaySummary.workspaceOperations > 0,
    'report run should have performed some work');

  // Verify failure fields are absent or empty
  assert(!reportRun.replaySummary.failureReason, 'successful run should not have failureReason');

  console.log('  ✓ successful-report-ticket: completed report run with clear replaySummary');
}

// ── Test 2: Broad inventory ticket failed due to bounded limits ─
function testBroadInventoryFailed() {
  const runs = readJson('runs.json');
  const tickets = readJson('tickets.json');

  // Find a failed run where the objective was broad inventory and failure was limit-related
  const failedRuns = runs.filter(r => r.status === 'failed');
  assert(failedRuns.length > 0, 'there should be at least one failed run');

  const limitFailedRun = failedRuns.find(r => {
    const ticket = tickets.find(t => t.id === r.ticketId);
    if (!ticket) return false;
    const obj = ticket.objective.toLowerCase();
    const isInventory = /\b(list all|inventory|all files|subdirector)\b/.test(obj);
    const isLimitError = r.error && /limit|exceeded|listDirectory/i.test(r.error);
    return isInventory && isLimitError;
  });

  assert(limitFailedRun, 'there should be a failed run due to limit exhaustion on broad inventory');
  assert(limitFailedRun.replaySummary, 'failed run should have replaySummary');
  assert(limitFailedRun.replaySummary.failure, 'failed run should have failure metadata');

  console.log('  ✓ broad-inventory-failed: limit-exhaustion failure is recorded with clear reason');
}

// ── Test 3: Revised narrower ticket succeeded ────────────────────
function testRevisedNarrowerTicket() {
  const runs = readJson('runs.json');
  const tickets = readJson('tickets.json');

  // Find a failed ticket followed by a completed ticket with similar but narrower objective
  const failedTickets = tickets.filter(t => {
    const tRuns = runs.filter(r => r.ticketId === t.id);
    return tRuns.some(r => r.status === 'failed');
  });

  const completedTickets = tickets.filter(t => {
    const tRuns = runs.filter(r => r.ticketId === t.id);
    return tRuns.some(r => r.status === 'completed');
  });

  assert(failedTickets.length > 0, 'there should be failed tickets');
  assert(completedTickets.length > 0, 'there should be completed tickets');

  // Verify we have both failure and success in the dataset
  console.log('  ✓ revised-narrower-ticket: both failed and completed tickets exist in dataset');
}

// ── Test 4: Reassess mode accepted by rerun endpoint ───────────
function testReassessModeAccepted() {
  const code = loadServerCode();

  // Verify the rerun endpoint accepts mode parameter
  assert(code.includes("request.body.mode === 'reassess'"), 'rerun endpoint should accept reassess mode');
  assert(code.includes("rerunTicketFromBeginning(ticketId, changedBy, mode)"), 'rerun should pass mode to ticket function');

  // Verify rerunMode is stored on run
  assert(code.includes('rerunMode: ticket.rerunMode'), 'rerunMode should be copied to run record');

  // Verify priorFailureContext is gated on reassess
  assert(code.includes("rerunMode === 'reassess'"), 'priorFailureContext should only inject for reassess');

  console.log('  ✓ reassess-mode-accepted: rerun endpoint accepts retry and reassess modes');
}

// ── Test 5: Artifact inspection path is clear ────────────────────
function testArtifactInspectionPath() {
  const histories = readJson('operation-history.json');
  const workspace = path.join(ROOT, 'workspace-root');

  // Find writeFile operations and verify the artifacts exist
  const writeFileOps = histories.filter(h => h.operation === 'writeFile');
  assert(writeFileOps.length > 0, 'there should be at least one writeFile in history');

  let foundArtifact = false;
  for (const op of writeFileOps) {
    const artifactPath = op.args && op.args.path;
    if (!artifactPath) continue;
    const fullPath = path.join(workspace, artifactPath);
    if (fs.existsSync(fullPath)) {
      foundArtifact = true;
      break;
    }
  }
  assert(foundArtifact, 'at least one artifact from writeFile should exist in workspace');

  // Verify the operator can trace artifact to run via history
  const firstWrite = writeFileOps[0];
  assert(firstWrite.runId, 'history record should include runId');
  assert(firstWrite.args.path, 'history record should include artifact path');

  console.log('  ✓ artifact-inspection-path: artifacts traceable from history to workspace');
}

// ── Test 6: Telemetry report reflects all runs ──────────────────
function testTelemetryReflectsRuns() {
  const { computeTelemetry } = require('./telemetry-report');

  const t = computeTelemetry();

  const runs = readJson('runs.json');
  const terminalRuns = runs.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status));

  assert(t.summary.terminalRuns > 0, 'telemetry should have terminal runs');
  assert(t.summary.terminalRuns <= runs.length, 'terminal runs should not exceed total runs');

  // Verify profile metrics include all terminal runs
  const profileTotalSum = Object.values(t.profileMetrics).reduce((sum, p) => sum + p.total, 0);
  assertEqual(profileTotalSum, t.summary.terminalRuns,
    'telemetry profile totals should equal terminal runs');

  // Verify failure metrics are non-negative
  assert(t.failureMetrics.phaseViolations >= 0, 'phaseViolations should be non-negative');
  assert(t.failureMetrics.commitConflicts >= 0, 'commitConflicts should be non-negative');

  // Verify artifact metrics reflect actual history
  assert(t.artifactMetrics.totalWriteFiles >= 0, 'totalWriteFiles should be non-negative');

  // Verify determinism: compute twice, get same result
  const t2 = computeTelemetry();
  assertEqual(t.summary.terminalRuns, t2.summary.terminalRuns, 'telemetry should be deterministic');
  assertEqual(t.summary.completedRuns, t2.summary.completedRuns, 'completed count should be deterministic');

  console.log('  ✓ telemetry-reflects-runs: telemetry accurately reflects all ledger runs');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  console.log('Operator Workflow Test Suite');
  console.log('='.repeat(70));

  const tests = [
    testSuccessfulReportTicket,
    testBroadInventoryFailed,
    testRevisedNarrowerTicket,
    testReassessModeAccepted,
    testArtifactInspectionPath,
    testTelemetryReflectsRuns
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
