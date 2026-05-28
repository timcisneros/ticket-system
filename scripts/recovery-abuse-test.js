#!/usr/bin/env node
// Recovery Abuse Test — crash-scenario fixtures using ONLY tail truncation.
// Simulated crash = contiguous prefix of events.jsonl (never delete middle events).
// Truncation preserves seq/hash chain integrity. Any broken chain = tamper/unsafe.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Fixture generation ──────────────────────────────────────────

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

function runRecoveryVerifier(dataDir, runId) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'recovery-verifier.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId)
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
}

// ── File helpers ──────────────────────────────────────────────────

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

function truncateEvents(dataDir, runId, predicate) {
  // Keep contiguous prefix of run events where predicate returns true.
  // After first predicate failure, all subsequent run events are dropped.
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  let cutIdx = runLines.length;
  for (let i = 0; i < runLines.length; i++) {
    if (!predicate(runLines[i].ev, i)) {
      cutIdx = i;
      break;
    }
  }
  const keep = runLines.slice(0, cutIdx);
  const newLines = [...otherLines, ...keep.map(x => x.line)];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return keep.length;
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

function resetReplayTerminalStatus(dataDir, runId) {
  const replayPath = path.join(dataDir, 'replay-snapshots', `run-${runId}.json`);
  if (fs.existsSync(replayPath)) {
    const replay = readJson(replayPath);
    replay.terminalStatus = null;
    writeJson(replayPath, replay);
  }
}

// ── Scenario builders (tail truncation only) ──────────────────────

function scenarioKilledBeforeModelResponse(dataDir, runId) {
  // Truncate after first heartbeat that occurs AFTER run.started
  const { runLines } = getRunEventLines(dataDir, runId);
  const startedIdx = runLines.findIndex(x => x.ev.type === 'run.started');
  let cutAfter = -1;
  for (let i = 0; i < runLines.length; i++) {
    if (i > startedIdx && runLines[i].ev.type === 'run.heartbeat') {
      cutAfter = i;
      break;
    }
  }
  const keepCount = cutAfter >= 0 ? cutAfter + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);
  resetRunToRunning(dataDir, runId);
  resetReplayTerminalStatus(dataDir, runId);
  return `truncated_after_heartbeat_post_started`;
}

function scenarioKilledAfterAuthorityBeforeOperation(dataDir, runId) {
  // Truncate after first authority.allowed
  const { runLines } = getRunEventLines(dataDir, runId);
  const authIdx = runLines.findIndex(x => x.ev.type === 'authority.allowed');
  const keepCount = authIdx >= 0 ? authIdx + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);
  resetRunToRunning(dataDir, runId);
  resetReplayTerminalStatus(dataDir, runId);
  return `truncated_after_first_authority`;
}

function scenarioKilledAfterOperationBeforeEvaluation(dataDir, runId) {
  // Truncate after final workspace.operation
  const { runLines } = getRunEventLines(dataDir, runId);
  const wsIndices = runLines.map((x, i) => x.ev.type === 'workspace.operation' ? i : -1).filter(i => i >= 0);
  const lastWsIdx = wsIndices.length > 0 ? wsIndices[wsIndices.length - 1] : -1;
  const keepCount = lastWsIdx >= 0 ? lastWsIdx + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);
  resetRunToRunning(dataDir, runId);
  resetReplayTerminalStatus(dataDir, runId);
  return `truncated_after_final_workspace_op`;
}

function scenarioKilledAfterEvaluationBeforeConsequence(dataDir, runId) {
  // Truncate after run.evaluation_completed
  const { runLines } = getRunEventLines(dataDir, runId);
  const evalIdx = runLines.findIndex(x => x.ev.type === 'run.evaluation_completed');
  const keepCount = evalIdx >= 0 ? evalIdx + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);
  resetRunToRunning(dataDir, runId);
  // Do NOT reset replay terminal status — the replay may be ahead of events
  return `truncated_after_evaluation`;
}

function scenarioStaleLeaseWithCleanReplay(dataDir, runId) {
  // Truncate after final workspace.operation, add expired lease
  const { runLines } = getRunEventLines(dataDir, runId);
  const wsIndices = runLines.map((x, i) => x.ev.type === 'workspace.operation' ? i : -1).filter(i => i >= 0);
  const lastWsIdx = wsIndices.length > 0 ? wsIndices[wsIndices.length - 1] : -1;
  const keepCount = lastWsIdx >= 0 ? lastWsIdx + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);

  const runs = readJson(path.join(dataDir, 'runs.json'));
  const run = runs.find(r => r.id === runId);
  run.status = 'running';
  run.leaseOwner = 'old-process:dead-lease';
  run.leaseExpiresAt = new Date(Date.now() - 120000).toISOString();
  delete run.completedAt;
  delete run.runEvaluation;
  delete run.runConsequence;
  writeJson(path.join(dataDir, 'runs.json'), runs);
  resetReplayTerminalStatus(dataDir, runId);

  return `truncated_after_ops_lease_expired`;
}

function scenarioCorruptReplayWithValidEvents(dataDir, runId) {
  // Truncate after final workspace.operation, corrupt replay snapshot
  const { runLines } = getRunEventLines(dataDir, runId);
  const wsIndices = runLines.map((x, i) => x.ev.type === 'workspace.operation' ? i : -1).filter(i => i >= 0);
  const lastWsIdx = wsIndices.length > 0 ? wsIndices[wsIndices.length - 1] : -1;
  const keepCount = lastWsIdx >= 0 ? lastWsIdx + 1 : runLines.length;
  truncateEvents(dataDir, runId, (_ev, idx) => idx < keepCount);
  resetRunToRunning(dataDir, runId);

  const replayPath = path.join(dataDir, 'replay-snapshots', `run-${runId}.json`);
  const content = fs.readFileSync(replayPath, 'utf8');
  fs.writeFileSync(replayPath, content.substring(0, Math.floor(content.length / 2)));

  return `truncated_after_ops_replay_corrupt`;
}

// Scenario 2 (killed after model response before authority) is unsupported
// because the fake preload processes model-response → authority → workspace-op
// in a single synchronous tick. We cannot simulate a crash between model response
// and authority with the current fixture generator.

const SCENARIOS = [
  {
    name: 'killed-before-model-response',
    builder: scenarioKilledBeforeModelResponse,
    expected: 'safe_to_resume'
  },
  {
    name: 'killed-after-authority-before-operation',
    builder: scenarioKilledAfterAuthorityBeforeOperation,
    expected: 'safe_to_resume'
  },
  {
    name: 'killed-after-operation-before-evaluation',
    builder: scenarioKilledAfterOperationBeforeEvaluation,
    expected: 'mutation_committed_without_terminalization'
  },
  {
    name: 'killed-after-evaluation-before-consequence',
    builder: scenarioKilledAfterEvaluationBeforeConsequence,
    expected: 'execution_completed_awaiting_terminalization'
  },
  {
    name: 'stale-lease-with-clean-replay',
    builder: scenarioStaleLeaseWithCleanReplay,
    expected: 'lease_stale'
  },
  {
    name: 'corrupt-replay-with-valid-events',
    builder: scenarioCorruptReplayWithValidEvents,
    expected: 'replay_corrupt'
  }
];

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Recovery Abuse Test Suite (Tail Truncation Only)');

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
    const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), `recovery-abuse-${scenario.name}-`));
    copyDir(cleanFixture, scenarioDir);

    const desc = scenario.builder(scenarioDir, runId);
    console.log(`\n[${i + 1}/${SCENARIOS.length}] ${scenario.name} (${desc})`);

    const report = await runRecoveryVerifier(scenarioDir, runId);
    const classification = report && report.classifications && report.classifications[0];
    const detectedClass = classification ? classification.classification : 'NO_RESULT';
    const matches = detectedClass === scenario.expected;

    if (matches) {
      console.log(`  ✓ Classified as: ${detectedClass}`);
      console.log(`    lastVerifiedSeq: ${classification.lastVerifiedSeq}`);
      console.log(`    lastCommittedMutation: ${classification.lastCommittedMutation ? JSON.stringify(classification.lastCommittedMutation) : 'none'}`);
      console.log(`    expectedNextPhase: ${classification.expectedNextPhase}`);
      console.log(`    hashChainValid: ${classification.hashChainValid}`);
    } else {
      console.log(`  ✗ MISMATCH: expected ${scenario.expected}, got ${detectedClass}`);
      if (classification) {
        console.log(`    reason: ${classification.reason}`);
        console.log(`    lastVerifiedSeq: ${classification.lastVerifiedSeq}`);
        console.log(`    hashChainValid: ${classification.hashChainValid}`);
      }
      if (report) console.log(JSON.stringify(report, null, 2));
    }

    results.push({ name: scenario.name, expected: scenario.expected, actual: detectedClass, matches, classification });

    // Cleanup
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); } catch (e) {}
  }

  // 3. Cleanup clean fixture
  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (e) {}

  // 4. Report
  console.log(`\n${'='.repeat(60)}`);
  console.log('Recovery Abuse Test Results');
  console.log(`${'='.repeat(60)}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.matches ? '✓ PASS' : '✗ FAIL';
    if (r.matches) passed++; else failed++;
    console.log(`  ${status}: ${r.name}`);
    console.log(`    expected=${r.expected}, actual=${r.actual}`);
    if (r.classification) {
      console.log(`    lastVerifiedSeq=${r.classification.lastVerifiedSeq}, nextPhase=${r.classification.expectedNextPhase}, chainValid=${r.classification.hashChainValid}`);
    }
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
