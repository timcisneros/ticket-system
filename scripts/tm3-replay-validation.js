#!/usr/bin/env node
/**
 * TM-3 — Counterfactual truncation replay against the TM-2 corpus.
 *
 * Reads tm2-events-final.json, applies prefix truncation to each
 * suppressed batch, classifies the counterfactual outcome against
 * the actual suppression outcome.
 *
 * Usage: node scripts/tm3-replay-validation.js
 * Output: JSON report + summary table
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EVENTS_PATH = path.join(ROOT, 'data', 'tm2-events-final.json');
const OUT_PATH = path.join(ROOT, 'data', 'tm3-replay-report.json');

function truncationCounterfactual(event) {
  const { suppressedOps, mutatingCount, limit, nextOps, classification } = event;

  // Truncation keeps first N mutating actions, drops the rest.
  // All suppressedOps are mutating (100% of TM-2 corpus).
  const keptCount = Math.min(mutatingCount, limit);
  const droppedCount = mutatingCount - keptCount;
  const keptOps = suppressedOps.slice(0, keptCount);
  const droppedOps = suppressedOps.slice(keptCount);

  let outcome;
  let rationale;

  switch (classification) {
    case 'abandonment':
      // Model stopped producing mutating actions → runtime terminated.
      // Truncation would have executed first N and continued.
      outcome = 'win';
      rationale = `truncation executes ${keptCount} actions instead of 0; model would have more state to continue from`;
      break;

    case 'inspection_fallback':
      // Model retried with 0 mutating (read/list only).
      // Truncation would have executed first N.
      outcome = 'win';
      rationale = `truncation executes ${keptCount} actions instead of falling back to inspection`;
      break;

    case 'repeat_exact_batch':
      // Model retried with identical oversized batch.
      // Truncation would have executed first N on first try.
      outcome = 'win';
      rationale = `truncation executes ${keptCount} actions on first try instead of repeating the same oversized batch`;
      break;

    case 'reduced_but_still_oversized': {
      // Model retried with fewer mutating actions but still > limit.
      // Truncation would have executed first N; retry still oversized.
      // Tie: both paths eventually need another step, but truncation did some work.
      const nextMutCount = (nextOps || []).filter(op =>
        ['createFolder', 'writeFile', 'renamePath', 'deletePath'].includes(op)
      ).length;
      if (nextMutCount > limit && keptCount > 0) {
        outcome = 'tie';
        rationale = `truncation executes ${keptCount} actions but next response also oversized (${nextMutCount} > ${limit})`;
      } else {
        outcome = 'win';
        rationale = `truncation executes ${keptCount} actions; retry batch would be within limit`;
      }
      break;
    }

    case 'legal_retry':
      // Model retried with ≤ limit actions and succeeded.
      // Truncation would have also succeeded (first N + retry).
      outcome = 'tie';
      rationale = `both paths execute allowed actions; truncation saves one retry round-trip`;
      break;

    default:
      outcome = 'unknown';
      rationale = `unexpected classification: ${classification}`;
  }

  return { keptCount, droppedCount, keptOps, droppedOps, outcome, rationale };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(EVENTS_PATH, 'utf8'));
  const events = raw.events || raw;

  if (!Array.isArray(events) || events.length === 0) {
    console.error('No events found in ' + EVENTS_PATH);
    process.exit(1);
  }

  console.log(`TM-3 Counterfactual Truncation Replay\n`);
  console.log(`Corpus: ${events.length} suppression events\n`);

  const results = events.map(event => {
    const cf = truncationCounterfactual(event);
    return {
      runId: event.runId,
      ticketId: event.ticketId,
      step: event.step,
      limit: event.limit,
      classification: event.classification,
      terminalOutcome: event.terminalOutcome,
      suppressedOps: (event.suppressedOps || []).join(', '),
      nextOps: (event.nextOps || []).join(', '),
      keptOps: cf.keptOps.join(', '),
      droppedOps: cf.droppedOps.join(', '),
      keptCount: cf.keptCount,
      droppedCount: cf.droppedCount,
      outcome: cf.outcome,
      rationale: cf.rationale
    };
  });

  // Aggregate
  const dist = {};
  for (const r of results) {
    dist[r.outcome] = (dist[r.outcome] || 0) + 1;
  }

  const total = results.length;
  console.log('Counterfactual outcomes:\n');
  for (const [outcome, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / total) * 100).toFixed(1);
    console.log(`  ${outcome.padEnd(8)} ${count}/${total} (${pct}%)`);
  }

  // Per-classification breakdown
  console.log('\nBy classification:\n');
  const byClass = {};
  for (const r of results) {
    if (!byClass[r.classification]) byClass[r.classification] = { wins: 0, ties: 0, losses: 0, total: 0 };
    byClass[r.classification][r.outcome + 's']++;
    byClass[r.classification].total++;
  }
  for (const [cls, counts] of Object.entries(byClass)) {
    console.log(`  ${cls.padEnd(30)} wins=${counts.wins} ties=${counts.ties} losses=${counts.losses} (total=${counts.total})`);
  }

  // Detail table
  console.log('\nPer-event detail:\n');
  console.log('  Run  Tkt Step Class                    Outcome  Kept Dropped Next');
  console.log('  ---- --- ---- ------------------------ ------- ---- ------- ----');
  for (const r of results) {
    const cls = r.classification.substring(0, 24).padEnd(24);
    console.log(`  R${String(r.runId).padStart(3)} T${String(r.ticketId).padStart(3)}  ${String(r.step).padStart(2)}  ${cls} ${r.outcome.padEnd(7)} ${String(r.keptCount).padStart(2)}   ${String(r.droppedCount).padStart(4)}    ${(r.nextOps || '-').substring(0, 20)}`);
  }

  // Save report
  const report = {
    corpus: EVENTS_PATH,
    totalEvents: total,
    summary: dist,
    byClassification: byClass,
    results
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${OUT_PATH}`);
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
