#!/usr/bin/env node
// Rebuild Runs Projection — reconstruct runs.json from events.jsonl (source of truth).
//
// Usage:
//   node scripts/rebuild-runs-projection.js --data-dir <dir> [--compare]

const fs = require('fs');
const path = require('path');
const {
  readJson, readEventsJsonl,
  groupEventsByRun, rebuildRunProjection
} = require('./projection-rebuilder');

function compareProjection(projection, actualRun) {
  const diffs = [];
  if (!actualRun) {
    return [{ field: 'existence', reconstructed: 'present', actual: 'missing' }];
  }

  const fields = [
    ['status', 'status'],
    ['startedAt', 'startedAt'],
    ['hasEvaluation', 'runEvaluation'],
    ['hasConsequence', 'runConsequence']
  ];

  for (const [projField, runField] of fields) {
    const projVal = projection[projField];
    const actualVal = actualRun[runField];
    if (projField === 'hasEvaluation' || projField === 'hasConsequence') {
      const actualBool = actualVal !== undefined && actualVal !== null;
      if (projVal !== actualBool) {
        diffs.push({ field: projField, reconstructed: projVal, actual: actualBool });
      }
      continue;
    }
    if (projVal !== actualVal) {
      diffs.push({ field: projField, reconstructed: projVal, actual: actualVal });
    }
  }

  const projCompleted = projection.completedAt != null;
  const actualCompleted = actualRun.completedAt != null;
  if (projCompleted !== actualCompleted) {
    diffs.push({ field: 'completedAt', reconstructed: projCompleted, actual: actualCompleted });
  }

  return diffs;
}

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let compareMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--compare') { compareMode = true; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const eventsByRun = groupEventsByRun(events);

  const reconstructed = [];
  for (const runId of Object.keys(eventsByRun).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const projection = rebuildRunProjection(eventsByRun[runId]);
    if (projection) reconstructed.push(projection);
  }

  const result = {
    dataDir,
    sourceOfTruth: 'events.jsonl',
    reconstructedRuns: reconstructed.length,
    runs: reconstructed
  };

  if (compareMode) {
    const actualRuns = readJson(path.join(dataDir, 'runs.json')) || [];
    result.comparison = {
      actualRuns: actualRuns.length,
      drifts: []
    };
    for (const proj of reconstructed) {
      const actual = actualRuns.find(r => r.id === proj.id);
      const diffs = compareProjection(proj, actual);
      if (diffs.length > 0) {
        result.comparison.drifts.push({ runId: proj.id, diffs });
      }
    }
    for (const actual of actualRuns) {
      if (!reconstructed.find(p => p.id === actual.id)) {
        result.comparison.drifts.push({
          runId: actual.id,
          diffs: [{ field: 'existence', reconstructed: 'missing', actual: 'present' }]
        });
      }
    }
    result.comparison.driftCount = result.comparison.drifts.length;
    result.comparison.match = result.comparison.driftCount === 0;
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
