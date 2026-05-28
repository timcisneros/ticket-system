#!/usr/bin/env node
// Replay Reconstructor Test — 6 cases proving events.jsonl is source of truth.
//
// Cases:
// 1. replay snapshot deleted → reconstruction succeeds
// 2. replay snapshot ahead of event log → drift reported
// 3. replay snapshot behind event log → drift reported
// 4. replay snapshot corrupted → events reconstruct truth
// 5. operation-history missing entry → incomplete lineage reported
// 6. events chain broken → unsafe_to_resume

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

function runReconstructor(dataDir, runId, compare) {
  return new Promise((resolve) => {
    const args = [
      path.join(ROOT, 'scripts', 'replay-reconstructor.js'),
      '--data-dir', dataDir,
      '--run-id', String(runId)
    ];
    if (compare) args.push('--compare');
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.on('close', () => {
      try { resolve(JSON.parse(stdout)); } catch (e) { resolve(null); }
    });
  });
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

// ── Scenario builders ─────────────────────────────────────────────

function scenarioSnapshotDeleted(dataDir, runId) {
  fs.rmSync(path.join(dataDir, 'replay-snapshots', `run-${runId}.json`), { force: true });
  return 'snapshot_deleted';
}

function scenarioSnapshotAheadOfEvents(dataDir, runId) {
  // Truncate events to remove last workspace operation — snapshot still has it
  const { runLines } = getRunEventLines(dataDir, runId);
  const wsIndices = runLines.map((x, i) => x.ev.type === 'workspace.operation' ? i : -1).filter(i => i >= 0);
  if (wsIndices.length >= 2) {
    truncateEvents(dataDir, runId, wsIndices[wsIndices.length - 2] + 1);
  }
  return 'events_truncated_snapshot_ahead';
}

function scenarioSnapshotBehindEvents(dataDir, runId) {
  // Remove last workspace op from snapshot, keep events intact
  const replayPath = path.join(dataDir, 'replay-snapshots', `run-${runId}.json`);
  const replay = readJson(replayPath);
  if (replay.workspaceOperations && replay.workspaceOperations.length > 1) {
    replay.workspaceOperations.pop();
    writeJson(replayPath, replay);
  }
  return 'snapshot_missing_last_op';
}

function scenarioSnapshotCorrupted(dataDir, runId) {
  const replayPath = path.join(dataDir, 'replay-snapshots', `run-${runId}.json`);
  const content = fs.readFileSync(replayPath, 'utf8');
  fs.writeFileSync(replayPath, content.substring(0, Math.floor(content.length / 2)));
  return 'snapshot_truncated';
}

function scenarioOperationHistoryMissingEntry(dataDir, runId) {
  // Remove last entry from operation-history.json
  const ops = readJson(path.join(dataDir, 'operation-history.json'));
  const runOps = ops.filter(o => o.runId === runId);
  if (runOps.length > 0) {
    const lastOp = runOps[runOps.length - 1];
    const filtered = ops.filter(o => o.id !== lastOp.id);
    writeJson(path.join(dataDir, 'operation-history.json'), filtered);
  }
  return 'last_history_entry_removed';
}

function scenarioEventsChainBroken(dataDir, runId) {
  // Remove a middle event (creates seq gap + hash break)
  const { runLines, otherLines } = getRunEventLines(dataDir, runId);
  if (runLines.length >= 5) {
    // Remove one event from the middle (not first, not last)
    const removed = runLines.splice(3, 1)[0];
    const newLines = [...otherLines, ...runLines.map(x => x.line)];
    fs.writeFileSync(path.join(dataDir, 'events.jsonl'), newLines.join('\n') + '\n');
    return `middle_event_removed_${removed.ev.type}`;
  }
  return 'insufficient_events';
}

// ── Test definitions ────────────────────────────────────────────────

const SCENARIOS = [
  {
    name: 'snapshot-deleted',
    builder: scenarioSnapshotDeleted,
    check: (result) => {
      const ok = result && !result.error && result.hashChainValid === true && result.eventCount > 0;
      return { pass: ok, detail: `reconstructed_without_snapshot events=${result.eventCount}` };
    }
  },
  {
    name: 'snapshot-ahead-of-events',
    builder: scenarioSnapshotAheadOfEvents,
    check: (result) => {
      const comp = result && result.snapshotComparison;
      const ok = comp && comp.snapshotPresent && comp.diffs.length > 0 &&
        comp.diffs.some(d => d.drift === 'snapshot_ahead');
      return { pass: ok, detail: ok ? `drift_detected: ${comp.diffs.map(d => d.field).join(', ')}` : 'no_drift' };
    }
  },
  {
    name: 'snapshot-behind-events',
    builder: scenarioSnapshotBehindEvents,
    check: (result) => {
      const comp = result && result.snapshotComparison;
      const ok = comp && comp.snapshotPresent && comp.diffs.length > 0 &&
        comp.diffs.some(d => d.drift === 'events_ahead');
      return { pass: ok, detail: ok ? `drift_detected: ${comp.diffs.map(d => d.field).join(', ')}` : 'no_drift' };
    }
  },
  {
    name: 'snapshot-corrupted',
    builder: scenarioSnapshotCorrupted,
    check: (result) => {
      const ok = result && !result.error && result.hashChainValid === true &&
        result.workspaceOperationsApplied > 0 && result.authorityErrors.length === 0;
      return { pass: ok, detail: `events_reconstruct_truth ops=${result.workspaceOperationsApplied}` };
    }
  },
  {
    name: 'operation-history-missing-entry',
    builder: scenarioOperationHistoryMissingEntry,
    check: (result) => {
      const ok = result && result.authorityErrors && result.authorityErrors.length > 0;
      return { pass: ok, detail: ok ? `lineage_incomplete: ${result.authorityErrors.length} errors` : 'no_errors' };
    }
  },
  {
    name: 'events-chain-broken',
    builder: scenarioEventsChainBroken,
    check: (result) => {
      const ok = result && result.hashChainValid === false &&
        result.hashChainErrors && result.hashChainErrors.length > 0;
      return { pass: ok, detail: ok ? `chain_broken: ${result.hashChainErrors.join('; ')}` : 'chain_intact' };
    }
  }
];

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const startedAt = Date.now();
  console.log('Replay Reconstructor Test Suite');

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
    const scenarioDir = fs.mkdtempSync(path.join(os.tmpdir(), `recon-test-${scenario.name}-`));
    copyDir(cleanFixture, scenarioDir);

    const desc = scenario.builder(scenarioDir, runId);
    console.log(`\n[${i + 1}/${SCENARIOS.length}] ${scenario.name} (${desc})`);

    const result = await runReconstructor(scenarioDir, runId, true);
    const check = scenario.check(result);

    if (check.pass) {
      console.log(`  ✓ PASS: ${check.detail}`);
    } else {
      console.log(`  ✗ FAIL: ${check.detail}`);
      if (result) {
        console.log(`    hashChainValid: ${result.hashChainValid}`);
        console.log(`    eventCount: ${result.eventCount}`);
        if (result.snapshotComparison) {
          console.log(`    snapshotDiffs: ${JSON.stringify(result.snapshotComparison.diffs)}`);
        }
        if (result.authorityErrors) {
          console.log(`    authorityErrors: ${result.authorityErrors.length}`);
        }
      }
    }

    results.push({ name: scenario.name, pass: check.pass, detail: check.detail, result });

    // Cleanup
    try { fs.rmSync(scenarioDir, { recursive: true, force: true }); } catch (e) {}
  }

  // 3. Cleanup clean fixture
  try { fs.rmSync(cleanFixture, { recursive: true, force: true }); } catch (e) {}

  // 4. Report
  console.log(`\n${'='.repeat(60)}`);
  console.log('Replay Reconstructor Test Results');
  console.log(`${'='.repeat(60)}`);

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const status = r.pass ? '✓ PASS' : '✗ FAIL';
    if (r.pass) passed++; else failed++;
    console.log(`  ${status}: ${r.name} (${r.detail})`);
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
