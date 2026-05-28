#!/usr/bin/env node
// Pressure Report — generates operational readability report from
// pressure suite results. Discovers what becomes operationally
// unreadable first.
//
// Usage:
//   node scripts/pressure-report.js <pressure-results.json>
//   node scripts/pressure-report.js --data-dir <dir>

const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function analyzeEvidenceReadability(metrics, events) {
  const notes = [];

  // 1. Replay size bloat
  const largeReplays = metrics.filter(m => m.replaySize > 50000);
  if (largeReplays.length > 0) {
    notes.push(`BLOAT: ${largeReplays.length} runs have replay snapshots >50KB (largest: ${formatBytes(Math.max(...largeReplays.map(m => m.replaySize)))})`);
  }

  // 2. Low authority density = hard to trace lineage
  const lowAuthDensity = metrics.filter(m => m.mutatingCount > 0 && m.authCount === 0);
  if (lowAuthDensity.length > 0) {
    notes.push(`LINEAGE: ${lowAuthDensity.length} runs with mutating operations but zero authority events`);
  }

  // 3. High event count without terminalization = confusing
  const highEventNoTerminal = metrics.filter(m => m.eventCount > 15 && !['completed', 'failed', 'interrupted'].includes(m.status));
  if (highEventNoTerminal.length > 0) {
    notes.push(`AMBIGUOUS: ${highEventNoTerminal.length} runs with >15 events but no terminal status`);
  }

  // 4. Suppressed actions without explanation
  const suppressedWithoutTerminal = metrics.filter(m => m.suppressedCount > 0 && m.status === 'completed');
  if (suppressedWithoutTerminal.length > 0) {
    notes.push(`SILENT: ${suppressedWithoutTerminal.length} completed runs had suppressed actions (mutating limit hit but run succeeded)`);
  }

  // 5. Rejected actions
  const rejectedRuns = metrics.filter(m => m.rejectedCount > 0);
  if (rejectedRuns.length > 0) {
    notes.push(`REJECTION: ${rejectedRuns.length} runs had pre-execution rejected actions`);
  }

  // 6. Event type diversity per run
  const runEventTypes = new Map();
  for (const ev of events) {
    if (!ev.runId) continue;
    const types = runEventTypes.get(ev.runId) || new Set();
    types.add(ev.type);
    runEventTypes.set(ev.runId, types);
  }
  const lowDiversityRuns = [];
  for (const [runId, types] of runEventTypes) {
    if (types.size < 5) {
      lowDiversityRuns.push(runId);
    }
  }
  if (lowDiversityRuns.length > 0) {
    notes.push(`SHALLOW: ${lowDiversityRuns.length} runs have <5 distinct event types (insufficient evidence depth)`);
  }

  // 7. Workspace reconstruction confidence
  const { reconstructWorkspaceForRun } = require('./replay-workspace');
  const reconstructionErrors = [];
  for (const m of metrics) {
    try {
      const ws = reconstructWorkspaceForRun(events, m.runId);
      if (ws.applied.some(op => op.result && op.result.status === 'unknown_operation')) {
        reconstructionErrors.push(m.runId);
      }
    } catch (e) {
      reconstructionErrors.push(m.runId);
    }
  }
  if (reconstructionErrors.length > 0) {
    notes.push(`UNRECOVERABLE: ${reconstructionErrors.length} runs had workspace reconstruction errors`);
  }

  return notes;
}

function generateReport(data) {
  const lines = [];
  lines.push('# Pressure Suite Operational Readability Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Duration: ${data.durationMs}ms`);
  lines.push(`Data directory: ${data.dataDir}`);
  lines.push('');

  // Scenario results
  lines.push('## Scenario Results');
  lines.push('');
  for (const r of data.results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    lines.push(`### ${r.name} [${status}]`);
    for (const note of r.notes) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  // Evidence readability audit
  const audit = data.results.find(r => r.name === 'evidence-readability');
  if (audit && audit.metrics) {
    lines.push('## Evidence Readability Audit');
    lines.push('');
    lines.push('| Run | Status | Events | WS Ops | Mutating | Auth | Suppressed | Rejected | Replay Size | Auth Density | Mut Density |');
    lines.push('|-----|--------|--------|--------|----------|------|------------|----------|-------------|--------------|-------------|');
    for (const m of audit.metrics) {
      lines.push(`| ${m.runId} | ${m.status} | ${m.eventCount} | ${m.wsEventCount} | ${m.mutatingCount} | ${m.authCount} | ${m.suppressedCount} | ${m.rejectedCount} | ${formatBytes(m.replaySize)} | ${m.authorityDensity} | ${m.mutationDensity} |`);
    }
    lines.push('');
  }

  // Operational readability assessment
  lines.push('## Operational Readability Assessment');
  lines.push('');

  const eventsPath = path.join(data.dataDir, 'events.jsonl');
  let events = [];
  try {
    events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {}

  const readabilityNotes = analyzeEvidenceReadability(audit ? audit.metrics : [], events);
  if (readabilityNotes.length > 0) {
    for (const note of readabilityNotes) {
      lines.push(`- ${note}`);
    }
  } else {
    lines.push('- All evidence surfaces remain readable.');
  }
  lines.push('');

  // Recovery confidence
  lines.push('## Recovery Confidence');
  lines.push('');
  const runs = readJson(path.join(data.dataDir, 'runs.json')) || [];
  const nonTerminal = runs.filter(r => !['completed', 'failed', 'interrupted'].includes(r.status));
  lines.push(`- Total runs: ${runs.length}`);
  lines.push(`- Non-terminal runs: ${nonTerminal.length}`);
  lines.push(`- Recovery confidence: ${nonTerminal.length === 0 ? 'HIGH (all runs terminalized)' : 'LOW (' + nonTerminal.length + ' runs may need recovery)'}`);
  lines.push('');

  // What becomes unreadable first
  lines.push('## What Becomes Unreadable First');
  lines.push('');
  if (readabilityNotes.length > 0) {
    const priority = readabilityNotes.filter(n => n.startsWith('SILENT') || n.startsWith('LINEAGE'));
    if (priority.length > 0) {
      lines.push('**Highest priority:**');
      for (const note of priority) {
        lines.push(`- ${note}`);
      }
      lines.push('');
    }
    lines.push('**Full findings:**');
    for (const note of readabilityNotes) {
      lines.push(`- ${note}`);
    }
  } else {
    lines.push('No operational readability degradation detected under tested pressure.');
  }
  lines.push('');

  // Recommendations
  lines.push('## Recommendations');
  lines.push('');
  if (readabilityNotes.some(n => n.includes('suppressed'))) {
    lines.push('- Add explicit `action.suppressed` events for all dropped actions (already added for mutating limit)');
  }
  if (readabilityNotes.some(n => n.includes('LINEAGE'))) {
    lines.push('- Ensure read-only operations do not trigger false authority-missing warnings');
  }
  if (readabilityNotes.some(n => n.includes('SHALLOW'))) {
    lines.push('- Consider adding more event types (heartbeat, step boundaries) for short runs');
  }
  if (readabilityNotes.some(n => n.includes('BLOAT'))) {
    lines.push('- Review replay snapshot compression or truncation for large outputs');
  }
  if (readabilityNotes.length === 0) {
    lines.push('- System remains readable under tested pressure. No changes needed.');
  }
  lines.push('');

  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let dataDir = null;
  let resultsFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = args[i + 1]; i++; }
    else if (!resultsFile && !args[i].startsWith('-')) { resultsFile = args[i]; }
  }

  let data = null;
  if (resultsFile) {
    data = readJson(resultsFile);
  } else if (dataDir) {
    const reportPath = path.join(dataDir, 'pressure-results.json');
    data = readJson(reportPath);
  } else {
    console.error('Usage: node scripts/pressure-report.js <pressure-results.json>');
    console.error('       node scripts/pressure-report.js --data-dir <dir>');
    process.exit(1);
  }

  if (!data) {
    console.error('Could not load pressure results');
    process.exit(1);
  }

  const report = generateReport(data);
  console.log(report);

  // Save to file
  const outPath = path.join(data.dataDir || path.dirname(resultsFile || '.'), 'pressure-readability-report.md');
  fs.writeFileSync(outPath, report);
  console.log(`\nReport saved to: ${outPath}`);
}

main();
