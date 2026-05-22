#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'replay-snapshots');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, filePath);
}

function replaySnapshotRelativePath(runId) {
  return path.join('replay-snapshots', `run-${runId}.json`);
}

function extractReplaySummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const parsedModelPlans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests : [];
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];

  return {
    model: snapshot.model || null,
    terminalStatus: snapshot.terminalStatus || null,
    failureReason: snapshot.failureReason || null,
    failure: snapshot.failure || null,
    mutationCount: snapshot.mutationCount,
    mutationOutcome: snapshot.mutationOutcome || null,
    finalizedAt: snapshot.finalizedAt || null,
    continuationOf: snapshot.continuationOf || null,
    steps: parsedModelPlans.length,
    workspaceOperations: workspaceOperations.length,
    providerRequests: providerRequests.length,
    modelResponses: modelResponses.length,
    hasBlockedOrRejected: workspaceOperations.some(item => item && (item.blocked || item.reason || (item.operation && item.operation.blocked))),
    hasCompletedNoop: events.some(item => item && item.type === 'run:completed_noop')
  };
}

function main() {
  const runs = readJson(RUNS_FILE, []);
  if (!Array.isArray(runs)) throw new Error('runs.json is not an array');
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  let extracted = 0;
  const migratedRuns = runs.map(run => {
    if (!run || typeof run !== 'object' || !run.replaySnapshot) return run;

    const snapshot = run.replaySnapshot;
    const relativePath = replaySnapshotRelativePath(run.id);
    const snapshotPath = path.join(DATA_DIR, relativePath);
    writeFileAtomic(snapshotPath, JSON.stringify(snapshot, null, 2));

    const roundTrip = readJson(snapshotPath, null);
    if (JSON.stringify(roundTrip) !== JSON.stringify(snapshot)) {
      throw new Error(`Replay snapshot round-trip mismatch for run ${run.id}`);
    }

    const nextRun = { ...run };
    delete nextRun.replaySnapshot;
    nextRun.replaySnapshotPath = relativePath;
    nextRun.replaySummary = extractReplaySummary(snapshot);
    if (nextRun.replaySummary && nextRun.replaySummary.mutationCount !== undefined) {
      nextRun.mutationCount = nextRun.replaySummary.mutationCount;
    }
    if (nextRun.replaySummary && nextRun.replaySummary.mutationOutcome) {
      nextRun.mutationOutcome = nextRun.replaySummary.mutationOutcome;
    }
    extracted += 1;
    return nextRun;
  });

  writeFileAtomic(RUNS_FILE, JSON.stringify(migratedRuns, null, 2));
  console.log(JSON.stringify({
    dataDir: DATA_DIR,
    runs: runs.length,
    extracted,
    snapshotDir: SNAPSHOT_DIR
  }, null, 2));
}

main();
