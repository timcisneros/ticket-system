#!/usr/bin/env node
// Verify the single current run-event schema and its continuous per-run chains.
//
// Usage:
//   node scripts/event-chain-verify.js --data-dir <dir> [--strict] [--run-id <id>]

'use strict';

const fs = require('fs');
const path = require('path');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

function readEventsJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return { _parseError: true, _raw: line.substring(0, 200) };
      }
    });
  } catch (_) {
    return [];
  }
}

function verifyChain(events, targetRunId = null) {
  const report = {
    dataDir: null,
    totalEvents: events.length,
    runEvents: 0,
    nonRunEvents: 0,
    runsVerified: 0,
    runsBroken: 0,
    chainValid: true,
    errors: [],
    runs: {}
  };

  const byRun = {};
  for (const event of events) {
    if (event._parseError) {
      report.errors.push({ type: 'parse', message: 'Event parse error', raw: event._raw });
      report.chainValid = false;
      continue;
    }
    if (event.runId == null) {
      report.nonRunEvents += 1;
      continue;
    }
    report.runEvents += 1;
    if (targetRunId != null && event.runId !== targetRunId) continue;
    if (!byRun[event.runId]) byRun[event.runId] = [];
    byRun[event.runId].push(event);
  }

  for (const runId of Object.keys(byRun).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const runEvents = byRun[runId];
    const runReport = {
      runId: parseInt(runId, 10),
      eventCount: runEvents.length,
      sealedEvents: 0,
      errors: [],
      chainValid: true,
      sealStatus: 'current_schema'
    };
    const verification = verifyCurrentRunEventChain(runEvents);
    runReport.errors = verification.errors;
    runReport.chainValid = verification.chainValid;
    runReport.sealedEvents = runEvents.length - verification.errors.filter(error => ['missing_hash', 'hash_mismatch'].includes(error.type)).length;

    if (!runReport.chainValid) runReport.sealStatus = 'invalid';
    report.runs[runId] = runReport;
    if (runReport.chainValid) report.runsVerified += 1;
    else {
      report.runsBroken += 1;
      report.chainValid = false;
    }
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let strictMode = false;
  let targetRunId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) {
      dataDir = path.resolve(args[++i]);
    } else if (args[i] === '--strict') {
      strictMode = true;
    } else if (args[i] === '--run-id' && args[i + 1]) {
      targetRunId = parseInt(args[++i], 10);
    }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const report = verifyChain(readEventsJsonl(path.join(dataDir, 'events.jsonl')), targetRunId);
  report.dataDir = dataDir;
  console.log(JSON.stringify(report, null, 2));
  if (strictMode && !report.chainValid) process.exit(1);
}

module.exports = { readEventsJsonl, verifyChain };

if (require.main === module) main();
