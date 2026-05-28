#!/usr/bin/env node
// Replay Tamper Test — expanded corruption matrix on isolated forensic fixtures.
// Uses replay-fixture-generator to produce clean fixtures, then applies 10
// corruption mutations across 10 copies. Asserts verifier detects each.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Spawn fixture generator ──────────────────────────────────────

function generateFixture(scenario) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-fixture-generator.js'),
      scenario
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Fixture generator exited ${code}: ${stderr}`));
        return;
      }
      const match = stdout.match(/FIXTURE_DIR=(.+)/);
      if (!match) {
        reject(new Error('Fixture generator did not output FIXTURE_DIR'));
        return;
      }
      resolve(match[1].trim());
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
    if (stat.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

// ── Tamper mutations (target a specific run) ──────────────────────

function getRunEventLines(dataDir, targetRunId) {
  const eventsPath = path.join(dataDir, 'events.jsonl');
  const allLines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
  const runLines = [];
  const otherLines = [];
  for (const line of allLines) {
    try {
      const ev = JSON.parse(line);
      if (ev.runId === targetRunId) runLines.push(line);
      else otherLines.push(line);
    } catch (e) { otherLines.push(line); }
  }
  return { allLines, runLines, otherLines };
}

function tamperRemoveEventLine(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  if (runLines.length < 2) return 'insufficient_run_events';
  const mid = Math.floor(runLines.length / 2);
  const removed = runLines.splice(mid, 1)[0];
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return `removed_event_${JSON.parse(removed).type}`;
}

function tamperReorderEvents(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  if (runLines.length < 3) return 'insufficient_run_events';
  const mid = Math.floor(runLines.length / 2);
  [runLines[mid], runLines[mid + 1]] = [runLines[mid + 1], runLines[mid]];
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'reordered_adjacent_events';
}

function tamperDuplicateEvent(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  if (runLines.length < 2) return 'insufficient_run_events';
  const first = runLines[0];
  runLines.splice(1, 0, first);
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'duplicated_first_event';
}

function tamperPartialEventTruncation(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  if (runLines.length < 2) return 'insufficient_run_events';
  // Truncate the middle event line to make it invalid JSON
  const mid = Math.floor(runLines.length / 2);
  runLines[mid] = runLines[mid].substring(0, Math.floor(runLines[mid].length / 2));
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'truncated_middle_event_json';
}

function tamperEventInsertion(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  if (runLines.length < 2) return 'insufficient_run_events';
  // Insert a fabricated event with seq that breaks the chain
  const parsed = JSON.parse(runLines[0]);
  const fabricated = JSON.stringify({
    ...parsed,
    id: 'fabricated-' + Date.now(),
    ts: new Date().toISOString(),
    type: 'workspace.operation',
    seq: parsed.seq + 1,
    prevHash: '0000000000000000000000000000000000000000000000000000000000000000',
    payload: { operation: 'writeFile', path: 'fabricated.txt', mutating: true }
  });
  runLines.splice(1, 0, fabricated);
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'inserted_fabricated_event';
}

function tamperReplayEventDivergence(dataDir, targetRunId) {
  // Mutate an event payload so replay and events disagree
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  const target = runLines.find(l => l.includes('"workspace.operation"'));
  if (!target) return 'no_workspace_event';
  const ev = JSON.parse(target);
  ev.payload.path = 'divergent-path.txt';
  const mutated = JSON.stringify(ev);
  const idx = runLines.indexOf(target);
  runLines[idx] = mutated;
  const newLines = [...otherLines, ...runLines];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'mutated_workspace_event_payload';
}

function tamperOperationHistoryDivergence(dataDir, targetRunId) {
  const opHistoryPath = path.join(dataDir, 'operation-history.json');
  const ops = readJson(opHistoryPath);
  for (const op of ops) {
    if (op.runId === targetRunId) {
      op.args.path = 'divergent-history-path.txt';
      break;
    }
  }
  writeJson(opHistoryPath, ops);
  return 'mutated_operation_history_path';
}

function tamperAuthorityLineageBreak(dataDir, targetRunId) {
  const { runLines, otherLines } = getRunEventLines(dataDir, targetRunId);
  // Remove all authority.allowed events for this run
  const filtered = runLines.filter(l => !l.includes('"authority.allowed"'));
  if (filtered.length === runLines.length) return 'no_authority_events';
  const newLines = [...otherLines, ...filtered];
  fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
  return 'removed_authority_events';
}

function tamperSnapshotReplaySubstitution(dataDir, targetRunId) {
  const replayDir = path.join(dataDir, 'replay-snapshots');
  const files = fs.readdirSync(replayDir).filter(f => f.endsWith('.json'));
  if (files.length < 1) return 'no_replay_files';
  // Create a fake replay snapshot and overwrite the target
  const fake = {
    version: 1,
    runId: targetRunId,
    terminalStatus: 'failed',
    providerRequests: [],
    modelResponses: [],
    parsedModelPlans: [],
    workspaceOperations: [],
    events: [],
    authorityChecks: [],
    createdAt: new Date().toISOString()
  };
  writeJson(path.join(replayDir, `run-${targetRunId}.json`), fake);
  return `substituted_replay_with_fake`;
}

function tamperMutateReplayField(dataDir, targetRunId) {
  const replayDir = path.join(dataDir, 'replay-snapshots');
  const target = path.join(replayDir, `run-${targetRunId}.json`);
  if (!fs.existsSync(target)) return 'no_replay_file';
  const snapshot = readJson(target);
  snapshot.terminalStatus = snapshot.terminalStatus === 'completed' ? 'failed' : 'completed';
  if (Array.isArray(snapshot.workspaceOperations)) {
    snapshot.workspaceOperations.push({
      operation: { operation: 'writeFile', args: { path: 'tampered-fake.txt', content: 'injected' } },
      result: { path: 'tampered-fake.txt' },
      capturedAt: new Date().toISOString()
    });
  }
  writeJson(target, snapshot);
  return `mutated_terminalStatus_and_injected_op`;
}

const TAMPER_SCENARIOS = [
  { name: 'remove-event-line', fn: tamperRemoveEventLine },
  { name: 'reorder-events', fn: tamperReorderEvents },
  { name: 'duplicate-event', fn: tamperDuplicateEvent },
  { name: 'partial-event-truncation', fn: tamperPartialEventTruncation },
  { name: 'event-insertion', fn: tamperEventInsertion },
  { name: 'replay-event-divergence', fn: tamperReplayEventDivergence },
  { name: 'operation-history-divergence', fn: tamperOperationHistoryDivergence },
  { name: 'authority-lineage-break', fn: tamperAuthorityLineageBreak },
  { name: 'snapshot-replay-substitution', fn: tamperSnapshotReplaySubstitution },
  { name: 'mutate-replay-field', fn: tamperMutateReplayField }
];

// ── Verifier runner ──────────────────────────────────────────────

function runVerifier(dataDir, runId, mode) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'replay-verifier.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId),
      '--mode', mode
    ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('close', code => {
      try {
        const report = JSON.parse(stdout);
        resolve({ code, report, stderr });
      } catch (e) {
        resolve({ code, report: null, rawStdout: stdout, stderr, parseError: e.message });
      }
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  const scenario = process.argv[2] || 'multiStep';
  console.log('Replay Tamper Test Suite (Expanded Corruption Matrix)');
  console.log(`  Fixture scenario: ${scenario}`);

  // 1. Generate isolated forensic fixture
  console.log('\nGenerating isolated fixture...');
  const fixtureDir = await generateFixture(scenario);
  console.log(`  Fixture: ${fixtureDir}`);

  const manifest = readJson(path.join(fixtureDir, 'manifest.json'));
  const runId = manifest.runId;
  console.log(`  Run ID: ${runId}`);
  console.log(`  Events: ${manifest.expectedEventCount}, Mutations: ${manifest.expectedMutationCount}`);

  // 2. Verify clean fixture passes verifier
  console.log('\n[0] Verifying clean fixture...');
  const cleanResult = await runVerifier(fixtureDir, runId, 'strict');
  const cleanPassed = cleanResult.code === 0 &&
    cleanResult.report &&
    cleanResult.report.identityPassed &&
    cleanResult.report.failed === 0;

  if (!cleanPassed) {
    console.log('  ✗ CLEAN FIXTURE FAILED');
    console.log(JSON.stringify(cleanResult.report, null, 2));
    process.exit(1);
  }
  console.log('  ✓ Clean fixture passes verifier (identity + hash chain + causality)');

  // 3. Apply each tamper mutation to a copy and verify detection
  const results = [];
  for (let i = 0; i < TAMPER_SCENARIOS.length; i++) {
    const t = TAMPER_SCENARIOS[i];
    const tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), `tamper-${t.name}-`));
    copyDir(fixtureDir, tamperDir);

    const mutationDesc = t.fn(tamperDir, runId);
    console.log(`\n[${i + 1}/${TAMPER_SCENARIOS.length}] ${t.name} (${mutationDesc})`);

    const result = await runVerifier(tamperDir, runId, 'strict');
    const detected = result.code !== 0 ||
      !result.report ||
      !result.report.identityPassed ||
      result.report.failed > 0 ||
      result.report.identityErrors.length > 0;

    if (detected) {
      console.log(`  ✓ Verifier detected corruption`);
      if (result.report) {
        if (result.report.identityErrors.length > 0) {
          result.report.identityErrors.forEach(e => console.log(`    [identity] ${e}`));
        }
        if (result.report.runs[0]) {
          result.report.runs[0].errors.forEach(e => console.log(`    [run] ${e}`));
        }
      }
    } else {
      console.log(`  ✗ Verifier did NOT detect corruption (UNEXPECTED)`);
      if (result.report) console.log(JSON.stringify(result.report, null, 2));
      else console.log(result.rawStdout);
    }

    results.push({ name: t.name, detected, mutationDesc });

    // Cleanup tamper dir
    try { fs.rmSync(tamperDir, { recursive: true, force: true }); } catch (e) {}
  }

  // 4. Report
  console.log(`\n${'='.repeat(60)}`);
  console.log('Replay Tamper Test Results');
  console.log(`${'='.repeat(60)}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.detected ? '✓ PASS' : '✗ FAIL';
    if (r.detected) passed++; else failed++;
    console.log(`  ${status}: ${r.name} (${r.mutationDesc})`);
  }

  console.log(`\nTotal: ${results.length} | Detected: ${passed} | Missed: ${failed}`);

  // Cleanup fixture
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (e) {}

  const durationMs = Date.now() - startedAt;
  console.log(`\nDuration: ${durationMs}ms`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
