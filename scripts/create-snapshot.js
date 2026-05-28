#!/usr/bin/env node
// Create Snapshot — deterministic checkpoint of operational state from events.
//
// Usage:
//   node scripts/create-snapshot.js --data-dir <dir> --output <snapshot.json>
//
// Rules:
//   - events.jsonl is source of truth
//   - projections are computed from events, not read from runs.json/tickets.json
//   - snapshot is diagnostic only — never mutates data

const fs = require('fs');
const path = require('path');
const {
  readJson, readEventsJsonl,
  canonicalJson, computeCanonicalHash,
  groupEventsByRun, rebuildRunProjection,
  groupEventsByTicket, rebuildTicketProjection
} = require('./projection-rebuilder');

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let outputPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--output' && args[i + 1]) { outputPath = args[i + 1]; i++; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }
  if (!outputPath) {
    console.error('Usage: node scripts/create-snapshot.js --data-dir <dir> --output <snapshot.json>');
    process.exit(1);
  }

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const operationHistory = readJson(path.join(dataDir, 'operation-history.json')) || [];

  // Build projections from events (source of truth)
  const eventsByRun = groupEventsByRun(events);
  const runs = [];
  const lastSeqPerRun = {};
  const lastVerifiedHashPerRun = {};

  for (const runId of Object.keys(eventsByRun).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const runEvents = eventsByRun[runId];
    const projection = rebuildRunProjection(runEvents);
    if (projection) runs.push(projection);

    // Track last event per run
    const lastEvent = runEvents[runEvents.length - 1];
    if (lastEvent) {
      lastSeqPerRun[runId] = lastEvent.seq;
      lastVerifiedHashPerRun[runId] = lastEvent.hash || null;
    }
  }

  const eventsByTicket = groupEventsByTicket(events);
  const tickets = [];
  for (const ticketId of Object.keys(eventsByTicket).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const projection = rebuildTicketProjection(eventsByTicket[ticketId], events);
    if (projection) tickets.push(projection);
  }

  // Canonicalize and hash projections
  const runsHash = computeCanonicalHash(runs);
  const ticketsHash = computeCanonicalHash(tickets);
  const operationsHash = computeCanonicalHash(operationHistory);

  // Build snapshot structure
  const snapshot = {
    version: '1',
    createdAt: new Date().toISOString(),
    metadata: {
      eventCount: events.length,
      runCount: Object.keys(eventsByRun).length,
      ticketCount: Object.keys(eventsByTicket).length,
      operationCount: operationHistory.length,
      lastSeqPerRun,
      lastVerifiedHashPerRun,
      projectionHashes: {
        runs: runsHash,
        tickets: ticketsHash,
        operations: operationsHash
      }
    },
    projections: {
      runs,
      tickets,
      operationHistory
    }
  };

  // Compute canonical hash of deterministic content (exclude timestamps)
  const deterministicContent = {
    version: snapshot.version,
    metadata: snapshot.metadata,
    projections: snapshot.projections
  };
  snapshot.manifest = {
    canonicalHash: computeCanonicalHash(deterministicContent)
  };

  fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2));
  console.log(JSON.stringify({
    created: true,
    outputPath,
    eventCount: snapshot.metadata.eventCount,
    runCount: snapshot.metadata.runCount,
    ticketCount: snapshot.metadata.ticketCount,
    canonicalHash: snapshot.manifest.canonicalHash
  }, null, 2));
}

main();
