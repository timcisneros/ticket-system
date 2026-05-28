#!/usr/bin/env node
// Event Chain Verify — cryptographically verify append-only event history.
//
// Usage:
//   node scripts/event-chain-verify.js --data-dir <dir> [--strict] [--run-id <id>]
//
// Verifies per-run hash chains:
//   - seq continuity (no gaps, no duplicates)
//   - prevHash linkage (each event points to previous event's hash)
//   - hash correctness (each event's hash matches canonical content hash)
//
// With --strict, exits non-zero if any chain is broken.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readEventsJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return { _parseError: true, _raw: line.substring(0, 200) }; }
    });
  } catch (e) { return []; }
}

function computeEventHash(event) {
  const canonical = {
    type: event.type,
    ticketId: event.ticketId,
    runId: event.runId,
    stepId: event.stepId,
    payload: event.payload
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ── Verification logic ────────────────────────────────────────────

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

  // Group run events by runId
  const byRun = {};
  for (const ev of events) {
    if (ev._parseError) {
      report.errors.push({ type: 'parse', message: 'Event parse error', raw: ev._raw });
      report.chainValid = false;
      continue;
    }
    if (ev.runId == null) {
      report.nonRunEvents++;
      continue;
    }
    report.runEvents++;
    if (targetRunId != null && ev.runId !== targetRunId) continue;
    if (!byRun[ev.runId]) byRun[ev.runId] = [];
    byRun[ev.runId].push(ev);
  }

  for (const runId of Object.keys(byRun).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    const runEvents = byRun[runId].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const runReport = {
      runId: parseInt(runId, 10),
      eventCount: runEvents.length,
      errors: [],
      chainValid: true
    };

    // Verify each event
    const seenSeqs = new Set();
    for (let i = 0; i < runEvents.length; i++) {
      const ev = runEvents[i];
      const seq = ev.seq;

      // Seq must be defined
      if (seq === undefined || seq === null) {
        runReport.errors.push({ type: 'missing_seq', seq: null, message: `Event missing seq` });
        runReport.chainValid = false;
        continue;
      }

      // Duplicate seq detection
      if (seenSeqs.has(seq)) {
        runReport.errors.push({ type: 'duplicate_seq', seq, message: `Duplicate seq ${seq}` });
        runReport.chainValid = false;
      }
      seenSeqs.add(seq);

      // prevHash linkage: prevHash of event N should equal computeEventHash(event N-1)
      if (seq === 0) {
        if (ev.prevHash !== null) {
          runReport.errors.push({
            type: 'first_prevhash',
            seq,
            message: `First event (seq=0) should have prevHash=null, got ${ev.prevHash}`
          });
          runReport.chainValid = false;
        }
      } else {
        const prevEvent = runEvents[i - 1];
        const expectedPrevHash = computeEventHash(prevEvent);
        if (ev.prevHash !== expectedPrevHash) {
          runReport.errors.push({
            type: 'prevhash_mismatch',
            seq,
            message: `prevHash mismatch at seq ${seq}: expected=${expectedPrevHash}, got=${ev.prevHash}`,
            expected: expectedPrevHash,
            got: ev.prevHash
          });
          runReport.chainValid = false;
        }
      }
    }

    // Seq gap detection
    const seqs = [...seenSeqs].sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i) {
        runReport.errors.push({
          type: 'seq_gap',
          seq: i,
          message: `Seq gap: expected seq ${i}, but found ${seqs[i]}`
        });
        runReport.chainValid = false;
        break; // only report first gap
      }
    }

    report.runs[runId] = runReport;
    if (runReport.chainValid) {
      report.runsVerified++;
    } else {
      report.runsBroken++;
      report.chainValid = false;
    }
  }

  return report;
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let strictMode = false;
  let targetRunId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--strict') { strictMode = true; }
    else if (args[i] === '--run-id' && args[i + 1]) { targetRunId = parseInt(args[i + 1], 10); i++; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const report = verifyChain(events, targetRunId);
  report.dataDir = dataDir;

  console.log(JSON.stringify(report, null, 2));

  if (strictMode && !report.chainValid) {
    process.exit(1);
  }
}

main();
