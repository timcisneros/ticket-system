#!/usr/bin/env node
// Replay Export — creates deterministic canonical replay package.
// Packages: events, replay snapshot, operation history, manifest, hash summaries.
// Output is self-contained and offline-verifiable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function readEventsJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
  } catch (e) { return []; }
}

function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (e) { return null; }
}

function canonicalJson(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalJson);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = canonicalJson(obj[key]);
  return sorted;
}

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let runId = null;
  let outputDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--run-id' && args[i + 1]) { runId = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--output' && args[i + 1]) { outputDir = path.resolve(args[i + 1]); i++; }
  }

  if (!fs.existsSync(dataDir)) die(`Data directory not found: ${dataDir}`);
  if (!runId) die('Usage: node replay-export.js --data-dir <dir> --run-id <id> --output <dir>');

  const runs = readJson(path.join(dataDir, 'runs.json')) || [];
  const run = runs.find(r => r.id === runId);
  if (!run) die(`Run ${runId} not found`);

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const runEvents = events.filter(e => e.runId === runId);
  const operationHistory = readJson(path.join(dataDir, 'operation-history.json')) || [];
  const runOps = operationHistory.filter(o => o.runId === runId);

  const replayPath = run.replaySnapshotPath ? path.join(dataDir, run.replaySnapshotPath) : null;
  if (!replayPath || !fs.existsSync(replayPath)) die(`Replay snapshot not found for run ${runId}`);
  const replay = readJson(replayPath);

  // Build output directory
  outputDir = outputDir || path.join(process.cwd(), `replay-export-run-${runId}`);
  fs.mkdirSync(outputDir, { recursive: true });

  // 1. Filtered events.jsonl
  const eventsPath = path.join(outputDir, 'events.jsonl');
  const eventLines = runEvents.map(e => JSON.stringify(e));
  fs.writeFileSync(eventsPath, eventLines.join('\n') + '\n');

  // 2. Replay snapshot
  const replayOutPath = path.join(outputDir, 'replay-snapshot.json');
  fs.copyFileSync(replayPath, replayOutPath);

  // 3. Operation history
  const opsPath = path.join(outputDir, 'operation-history.json');
  fs.writeFileSync(opsPath, JSON.stringify(runOps, null, 2));

  // 4. Hash summaries
  const hashes = {
    eventsJsonl: hashFile(eventsPath),
    replaySnapshot: hashFile(replayOutPath),
    operationHistory: hashFile(opsPath),
    combined: null
  };
  hashes.combined = crypto.createHash('sha256')
    .update(hashes.eventsJsonl || '')
    .update(hashes.replaySnapshot || '')
    .update(hashes.operationHistory || '')
    .digest('hex');

  const hashesPath = path.join(outputDir, 'hashes.json');
  fs.writeFileSync(hashesPath, JSON.stringify(hashes, null, 2));

  // 5. Manifest
  const manifest = {
    runId,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    terminalStatus: run.status,
    createdAt: run.createdAt,
    completedAt: run.completedAt || null,
    eventCount: runEvents.length,
    workspaceOperationCount: runEvents.filter(e => e.type === 'workspace.operation').length,
    authorityEventCount: runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied').length,
    operationHistoryCount: runOps.length,
    replaySnapshotPath: 'replay-snapshot.json',
    eventLineagePath: 'events.jsonl',
    operationHistoryPath: 'operation-history.json',
    hashesPath: 'hashes.json',
    exportedAt: new Date().toISOString(),
    deterministic: true,
    reconstructable: true,
    combinedHash: hashes.combined
  };

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // 6. Human-readable summary
  const summaryPath = path.join(outputDir, 'SUMMARY.txt');
  const summary = `Replay Export Summary
=====================
Run ID:        ${runId}
Ticket ID:     ${run.ticketId}
Agent:         ${run.agentName} (ID: ${run.agentId})
Status:        ${run.status}
Events:        ${manifest.eventCount}
Operations:    ${manifest.workspaceOperationCount}
Authority:     ${manifest.authorityEventCount}
History:       ${manifest.operationHistoryCount}
Combined Hash: ${hashes.combined}

Files:
  events.jsonl          - ${runEvents.length} events
  replay-snapshot.json  - replay snapshot
  operation-history.json - ${runOps.length} operations
  hashes.json           - SHA-256 of each file
  manifest.json         - export metadata

This package is self-contained and offline-verifiable.
Run: node scripts/replay-verifier.js --data-dir ${outputDir} --run-id ${runId}
`;
  fs.writeFileSync(summaryPath, summary);

  console.log(`Replay export complete: ${outputDir}`);
  console.log(`  Events: ${runEvents.length}`);
  console.log(`  Operations: ${runOps.length}`);
  console.log(`  Combined hash: ${hashes.combined}`);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

main();
