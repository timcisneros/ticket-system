#!/usr/bin/env node
// Rebuild Tickets Projection — reconstruct tickets.json from events.jsonl.
//
// Usage:
//   node scripts/rebuild-tickets-projection.js --data-dir <dir> [--compare]

const fs = require('fs');
const path = require('path');
const {
  readJson, readEventsJsonl,
  groupEventsByTicket, rebuildTicketProjection
} = require('./projection-rebuilder');

function compareTicketProjection(projection, actualTicket) {
  const diffs = [];
  if (!actualTicket) {
    return [{ field: 'existence', reconstructed: 'present', actual: 'missing' }];
  }
  const fields = [['status', 'status']];
  for (const [projField, ticketField] of fields) {
    const projVal = projection[projField];
    const actualVal = actualTicket[ticketField];
    if (projVal !== actualVal) {
      diffs.push({ field: projField, reconstructed: projVal, actual: actualVal });
    }
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
  const eventsByTicket = groupEventsByTicket(events);

  const reconstructed = [];
  for (const ticketId of Object.keys(eventsByTicket).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const projection = rebuildTicketProjection(eventsByTicket[ticketId], events);
    if (projection) reconstructed.push(projection);
  }

  const result = {
    dataDir,
    sourceOfTruth: 'events.jsonl',
    reconstructedTickets: reconstructed.length,
    tickets: reconstructed
  };

  if (compareMode) {
    const actualTickets = readJson(path.join(dataDir, 'tickets.json')) || [];
    result.comparison = {
      actualTickets: actualTickets.length,
      drifts: []
    };
    for (const proj of reconstructed) {
      const actual = actualTickets.find(t => t.id === proj.id);
      const diffs = compareTicketProjection(proj, actual);
      if (diffs.length > 0) {
        result.comparison.drifts.push({ ticketId: proj.id, diffs });
      }
    }
    for (const actual of actualTickets) {
      if (!reconstructed.find(p => p.id === actual.id)) {
        result.comparison.drifts.push({
          ticketId: actual.id,
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
