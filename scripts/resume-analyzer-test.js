#!/usr/bin/env node
// Resume Analyzer Test Suite — 10 crash-scenario fixtures.
// Simulated crash = contiguous prefix of events.jsonl (tail truncation only).
//
// Cases:
// 1. truncated before model response → safe
// 2. truncated after authority before operation → safe
// 3. truncated after final workspace operation → safe (next phase terminalization)
// 4. terminal reached but status mismatch → not safe (reconcile status)
// 5. hash chain broken → unsafe
// 6. authority missing → unsafe
// 7. operation-history missing committed mutation → unsafe
// 8. duplicate workspace mutation ambiguity → unsafe
// 9. stale lease with intact evidence → safe
// 10. corrupt replay but intact events → safe

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function generateFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-fixture-generator.js'),
      'multiStep'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) reject(new Error('Fixture generator failed'));
      else {
        const match = stdout.match(/FIXTURE_DIR=(.+)/);
        resolve(match ? match[1].trim() : null);
      }
    });
  });
}

function runAnalyzer(dataDir, runId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'resume-analyzer.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--include-terminal'
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

function assertRunMutated(dataDir, runId, scenarioName) {
  const runs = readJson(path.join(dataDir, 'runs.json'));
  const run = runs.find(r => r.id === runId);
  if (!run) {
    throw new Error(`[${scenarioName}] ASSERTION FAILED: run ${runId} not found in copied fixture`);
  }
  if (run.status !== 'running') {
    throw new Error(`[${scenarioName}] ASSERTION FAILED: run.status=${run.status}, expected 'running'`);
  }
  if ('completedAt' in run) {
    throw new Error(`[${scenarioName}] ASSERTION FAILED: completedAt still present after reset`);
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    const srcPath = path.join(src, file);
    const dstPath = path.join(dst, file);
    const stat = fs.statSync(srcPath);
    if (stat.isDirectory()) copyDir(srcPath, dstPath);
    else fs.copyFileSync(srcPath, dstPath);
  }
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }

function getRunEventLines(dataDir, runId) {
  const allLines = fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const runLines = [];
  const otherLines = [];
  for (const line of allLines) {
    try {
      const ev = JSON.parse(line);
      if (ev.runId === runId) runLines.push({ line, ev });
      else otherLines.push(line);
    } catch (e) { otherLines.push(line); }
  }
  return { runLines, otherLines };
}

function truncateEvents(dataDir, runId, keepCount) {
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  const keep = runLines.slice(0, keepCount);
  const newLines = [...otherLines, ...keep.map(x => x.line)];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
}

function truncateOperationHistory(dataDir, runId, lastWorkspaceOpSeq) {
  // Remove history entries for workspace operations that are NOT in the
  // truncated event log. Match by (operation, path).
  const ops = readJson(path.join(dataDir, 'operation-history.json')) || [];
  const { runLines } = getRunEventLines(dataDir, runId);
  const wsEvents = runLines.filter(x => x.ev.type === 'workspace.operation');
  const wsSignatures = new Set();
  for (const ws of wsEvents) {
    const p = ws.ev.payload || {};
    const op = p.operation || (p.operation && p.operation.operation);
    const path = p.path || (p.operation && p.operation.args && p.operation.args.path);
    wsSignatures.add(`${op}:${path}`);
  }
  const filtered = ops.filter(o => {
    if (o.runId !== runId) return true;
    const sig = `${o.operation}:${o.args && o.args.path}`;
    return wsSignatures.has(sig);
  });
  writeJson(path.join(dataDir, 'operation-history.json'), filtered);
}

function stripTerminalEvents(dataDir, runId) {
  // Remove terminal event AND all events after it to preserve hash chain integrity.
  // (Events after a terminal event depend on it via prevHash; removing the terminal
  // event would break the chain for subsequent events.)
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  const terminalTypes = ['run.completed', 'run.failed', 'run.interrupted', 'run.terminalized', 'run.execution_completed'];
  const firstTerminalIdx = runLines.findIndex(x => terminalTypes.includes(x.ev.type));
  let keep;
  if (firstTerminalIdx >= 0) {
    keep = runLines.slice(0, firstTerminalIdx);
  } else {
    keep = runLines;
  }
  const newLines = [...otherLines, ...keep.map(x => x.line)];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
}

function resetRunToRunning(dataDir, runId) {
  const runs = readJson(path.join(dataDir, 'runs.json'));
  const run = runs.find(r => r.id === runId);
  run.status = 'running';
  delete run.completedAt;
  delete run.runEvaluation;
  delete run.runConsequence;
  writeJson(path.join(dataDir, 'runs.json'), runs);
}

// ── Scenario builders (tail truncation only) ──────────────────────

function scenarioTruncatedBeforeModelResponse(dataDir, runId) {
  // Truncate after first heartbeat post-run.started (seq=5)
  // Strip terminal events, truncate history to match
  stripTerminalEvents(dataDir, runId);
  truncateEvents(dataDir, runId, 6);
  truncateOperationHistory(dataDir, runId);
  resetRunToRunning(dataDir, runId);
  return 'truncated_after_first_heartbeat';
}

function scenarioTruncatedAfterAuthorityBeforeOp(dataDir, runId) {
  // Truncate after first authority.allowed (seq=6)
  // Strip terminal events, truncate history to match
  stripTerminalEvents(dataDir, runId);
  truncateEvents(dataDir, runId, 7);
  truncateOperationHistory(dataDir, runId);
  resetRunToRunning(dataDir, runId);
  return 'truncated_after_first_authority';
}

function scenarioTruncatedAfterWorkspaceOpTerminalizationNext(dataDir, runId) {
  // Truncate after final workspace.operation (seq=13)
  // All authority events are matched. Next phase = terminalization.
  stripTerminalEvents(dataDir, runId);
  truncateEvents(dataDir, runId, 14);
  // All history entries match (all 3 ops executed)
  resetRunToRunning(dataDir, runId);
  return 'truncated_after_final_workspace_op';
}

function scenarioTerminalReachedButStatusMismatch(dataDir, runId) {
  // Keep all events (terminal event present), but reset run.status to running
  // Do NOT strip terminal events — this scenario tests status mismatch
  resetRunToRunning(dataDir, runId);
  return 'terminal_event_present_status_running';
}

function scenarioHashChainBroken(dataDir, runId) {
  // Remove middle event (seq gap + hash break)
  stripTerminalEvents(dataDir, runId);
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  if (runLines.length >= 6) {
    runLines.splice(3, 1); // Remove event at index 3
    const newLines = [...otherLines, ...runLines.map(x => x.line)];
    fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  }
  truncateOperationHistory(dataDir, runId);
  resetRunToRunning(dataDir, runId);
  return 'middle_event_removed';
}

function scenarioAuthorityMissing(dataDir, runId) {
  // Remove all authority.allowed events
  stripTerminalEvents(dataDir, runId);
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  const withoutAuth = runLines.filter(x => x.ev.type !== 'authority.allowed');
  const newLines = [...otherLines, ...withoutAuth.map(x => x.line)];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  truncateOperationHistory(dataDir, runId);
  resetRunToRunning(dataDir, runId);
  return 'authority_events_removed';
}

function scenarioOperationHistoryMissingEntry(dataDir, runId) {
  // Remove last entry from operation-history.json
  stripTerminalEvents(dataDir, runId);
  const ops = readJson(path.join(dataDir, 'operation-history.json'));
  const runOps = ops.filter(o => o.runId === runId);
  if (runOps.length > 0) {
    const lastOp = runOps[runOps.length - 1];
    const filtered = ops.filter(o => o.id !== lastOp.id);
    writeJson(path.join(dataDir, 'operation-history.json'), filtered);
  }
  resetRunToRunning(dataDir, runId);
  return 'last_history_entry_removed';
}

function scenarioDuplicateMutationAmbiguity(dataDir, runId) {
  // Duplicate a workspace.operation event (creates duplicate mutation risk)
  stripTerminalEvents(dataDir, runId);
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  const wsIdx = runLines.findIndex(x => x.ev.type === 'workspace.operation');
  if (wsIdx >= 0) {
    const duplicate = { ...runLines[wsIdx] };
    // Splice duplicate after original
    runLines.splice(wsIdx + 1, 0, duplicate);
    const newLines = [...otherLines, ...runLines.map(x => x.line)];
    fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  }
  resetRunToRunning(dataDir, runId);
  return 'workspace_event_duplicated';
}

function scenarioStaleLeaseWithIntactEvidence(dataDir, runId) {
  // Strip terminal events, keep clean evidence, set expired lease
  stripTerminalEvents(dataDir, runId);
  const runs = readJson(path.join(dataDir, 'runs.json'));
  const run = runs.find(r => r.id === runId);
  run.status = 'running';
  run.leaseOwner = 'old-process:dead-lease';
  run.leaseExpiresAt = new Date(Date.now() - 120000).toISOString();
  delete run.completedAt;
  delete run.runEvaluation;
  delete run.runConsequence;
  writeJson(path.join(dataDir, 'runs.json'), runs);
  return 'lease_expired_events_intact';
}

function scenarioCorruptReplayButIntactEvents(dataDir, runId) {
  // Strip terminal events, corrupt replay snapshot
  stripTerminalEvents(dataDir, runId);
  const replayPath = path.join(dataDir, 'replay-snapshots', `run-${runId}.json`);
  const content = fs.readFileSync(replayPath, 'utf8');
  fs.writeFileSync(replayPath, content.substring(0, Math.floor(content.length / 2)));
  resetRunToRunning(dataDir, runId);
  return 'replay_truncated_events_intact';
}

// ── Test definitions ────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'truncated-before-model-response',
    builder: scenarioTruncatedBeforeModelResponse,
    expectedSafe: true,
    expectedPhase: 'model_request'
  },
  {
    name: 'truncated-after-authority-before-operation',
    builder: scenarioTruncatedAfterAuthorityBeforeOp,
    expectedSafe: true,
    expectedPhase: 'workspace_operation'
  },
  {
    name: 'truncated-after-workspace-op-terminalization-next',
    builder: scenarioTruncatedAfterWorkspaceOpTerminalizationNext,
    expectedSafe: true,
    expectedPhase: 'terminalization_or_evaluation'
  },
  {
    name: 'terminal-reached-but-status-mismatch',
    builder: scenarioTerminalReachedButStatusMismatch,
    expectedSafe: false
  },
  {
    name: 'hash-chain-broken',
    builder: scenarioHashChainBroken,
    expectedSafe: false
  },
  {
    name: 'authority-missing',
    builder: scenarioAuthorityMissing,
    expectedSafe: false
  },
  {
    name: 'operation-history-missing-entry',
    builder: scenarioOperationHistoryMissingEntry,
    expectedSafe: false
  },
  {
    name: 'duplicate-mutation-ambiguity',
    builder: scenarioDuplicateMutationAmbiguity,
    expectedSafe: false
  },
  {
    name: 'stale-lease-with-intact-evidence',
    builder: scenarioStaleLeaseWithIntactEvidence,
    expectedSafe: true
  },
  {
    name: 'corrupt-replay-but-intact-events',
    builder: scenarioCorruptReplayButIntactEvents,
    expectedSafe: true
  }
];

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Resume Analyzer Test Suite');

  // 1. Generate clean fixture
  console.log('\nGenerating clean multi-step fixture...');
  const cleanFixture = await generateFixture();
  const manifest = readJson(path.join(cleanFixture, 'manifest.json'));
  const runId = manifest.runId;
  console.log(`  Fixture: ${cleanFixture}`);
  console.log(`  Run: ${runId}, Events: ${manifest.expectedEventCount}, Mutations: ${manifest.expectedMutationCount}`);

  // 2. Run each scenario
  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), `resume-analyzer-${scenario.name}-`));
    copyDir(cleanFixture, scenarioDir);

    const desc = scenario.builder(scenarioDir, runId);
    console.log(`\n[${i + 1}/${SCENARIOS.length}] ${scenario.name} (${desc})`);

    // Assert fixture was actually mutated before analyzer reads it
    assertRunMutated(scenarioDir, runId, scenario.name);

    const report = await runAnalyzer(scenarioDir, runId);
    const analysis = report && report.analyses && report.analyses[0];
    const safe = analysis ? analysis.safeToResume : null;
    const phase = analysis ? analysis.expectedNextPhase : null;
    const matchesSafe = safe === scenario.expectedSafe;
    const matchesPhase = scenario.expectedPhase ? phase === scenario.expectedPhase : true;
    const matches = matchesSafe && matchesPhase;

    if (matches) {
      console.log(`  ✓ PASS: safe=${safe}, phase=${phase}`);
      if (analysis) {
        console.log(`    hashChainIntact: ${analysis.hashChainIntact}`);
        console.log(`    authorityChainIntact: ${analysis.authorityChainIntact}`);
        console.log(`    workspaceProjectionStable: ${analysis.workspaceProjectionStable}`);
        console.log(`    duplicateMutationRisk: ${analysis.duplicateMutationRisk}`);
        console.log(`    reasons: ${JSON.stringify(analysis.reasons)}`);
      }
    } else {
      console.log(`  ✗ FAIL: safe=${safe} (expected=${scenario.expectedSafe}), phase=${phase} (expected=${scenario.expectedPhase || 'any'})`);
      if (analysis) {
        console.log(`    hashChainIntact: ${analysis.hashChainIntact}`);
        console.log(`    authorityChainIntact: ${analysis.authorityChainIntact}`);
        console.log(`    workspaceProjectionStable: ${analysis.workspaceProjectionStable}`);
        console.log(`    duplicateMutationRisk: ${analysis.duplicateMutationRisk}`);
        console.log(`    reasons: ${JSON.stringify(analysis.reasons)}`);
      }
      if (report) console.log(JSON.stringify(report, null, 2));
    }

    results.push({
      name: scenario.name,
      pass: matches,
      safe,
      expectedSafe: scenario.expectedSafe,
      phase,
      expectedPhase: scenario.expectedPhase,
      analysis
    });

    // Cleanup
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); } catch (e) {}
  }

  // 3. Cleanup clean fixture
  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (e) {}

  // 4. Report
  console.log(`\n${'='.repeat(60)}`);
  console.log('Resume Analyzer Test Results');
  console.log(`${'='.repeat(60)}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.pass ? '✓ PASS' : '✗ FAIL';
    if (r.pass) passed++; else failed++;
    console.log(`  ${status}: ${r.name}`);
    console.log(`    safe=${r.safe} (expected=${r.expectedSafe}), phase=${r.phase} (expected=${r.expectedPhase || 'any'})`);
  }

  console.log(`\nTotal: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  const durationMs = Date.now() - startedAt;
  console.log(`Duration: ${durationMs}ms`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
