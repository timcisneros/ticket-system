#!/usr/bin/env node
// Projection Integrity Audit — cryptographically prove operational state from events.
//
// Usage:
//   node scripts/projection-integrity-audit.js --data-dir <dir> [--strict] [--manifest <file>]
//
// --strict : exit non-zero if any drift detected
// --manifest <file> : write projection hash manifest

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  readJson, readEventsJsonl,
  canonicalJson, computeCanonicalHash,
  groupEventsByRun, rebuildRunProjection,
  groupEventsByTicket, rebuildTicketProjection
} = require('./projection-rebuilder');

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let strictMode = false;
  let manifestPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--strict') { strictMode = true; }
    else if (args[i] === '--manifest' && args[i + 1]) { manifestPath = args[i + 1]; i++; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));

  // Rebuild projections
  const eventsByRun = groupEventsByRun(events);
  const reconstructedRuns = [];
  for (const runId of Object.keys(eventsByRun).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const projection = rebuildRunProjection(eventsByRun[runId]);
    if (projection) reconstructedRuns.push(projection);
  }

  const eventsByTicket = groupEventsByTicket(events);
  const reconstructedTickets = [];
  for (const ticketId of Object.keys(eventsByTicket).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const projection = rebuildTicketProjection(eventsByTicket[ticketId], events);
    if (projection) reconstructedTickets.push(projection);
  }

  // Canonicalize and hash
  const runsCanonical = canonicalJson(reconstructedRuns);
  const ticketsCanonical = canonicalJson(reconstructedTickets);
  const runsHash = computeCanonicalHash(reconstructedRuns);
  const ticketsHash = computeCanonicalHash(reconstructedTickets);
  const combinedHash = computeCanonicalHash({ runs: reconstructedRuns, tickets: reconstructedTickets });

  // Compare against live projections
  const actualRuns = readJson(path.join(dataDir, 'runs.json')) || [];
  const actualTickets = readJson(path.join(dataDir, 'tickets.json')) || [];

  // Build drift report
  const drifts = [];

  // Runs drift
  for (const proj of reconstructedRuns) {
    const actual = actualRuns.find(r => r.id === proj.id);
    if (!actual) {
      drifts.push({ type: 'run', id: proj.id, field: 'existence', reconstructed: 'present', actual: 'missing' });
      continue;
    }
    if (actual.status !== proj.status) {
      drifts.push({ type: 'run', id: proj.id, field: 'status', reconstructed: proj.status, actual: actual.status });
    }
  }
  for (const actual of actualRuns) {
    if (!reconstructedRuns.find(p => p.id === actual.id)) {
      drifts.push({ type: 'run', id: actual.id, field: 'existence', reconstructed: 'missing', actual: 'present' });
    }
  }

  // Tickets drift
  for (const proj of reconstructedTickets) {
    const actual = actualTickets.find(t => t.id === proj.id);
    if (!actual) {
      drifts.push({ type: 'ticket', id: proj.id, field: 'existence', reconstructed: 'present', actual: 'missing' });
      continue;
    }
    if (actual.status !== proj.status) {
      drifts.push({ type: 'ticket', id: proj.id, field: 'status', reconstructed: proj.status, actual: actual.status });
    }
  }
  for (const actual of actualTickets) {
    if (!reconstructedTickets.find(p => p.id === actual.id)) {
      drifts.push({ type: 'ticket', id: actual.id, field: 'existence', reconstructed: 'missing', actual: 'present' });
    }
  }

  const hasDrift = drifts.length > 0;

  // Build manifest
  const manifest = {
    dataDir,
    auditedAt: new Date().toISOString(),
    eventCount: events.length,
    runs: {
      reconstructedCount: reconstructedRuns.length,
      actualCount: actualRuns.length,
      canonicalHash: runsHash
    },
    tickets: {
      reconstructedCount: reconstructedTickets.length,
      actualCount: actualTickets.length,
      canonicalHash: ticketsHash
    },
    combinedHash,
    hasDrift,
    driftCount: drifts.length,
    drifts: drifts.slice(0, 50) // cap at 50
  };

  console.log(JSON.stringify(manifest, null, 2));

  if (manifestPath) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  if (strictMode && hasDrift) {
    process.exit(1);
  }
}

main();
