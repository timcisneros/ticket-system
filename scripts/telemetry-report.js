#!/usr/bin/env node
// Telemetry Engine — deterministic operational metrics from ledger evidence.
// No hidden mutable counters. All metrics derived from events.jsonl, runs.json,
// tickets.json, and operation-history.json.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(name) {
  const fp = path.join(ROOT, 'data', name);
  if (!fs.existsSync(fp)) return [];
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { return []; }
}

function readEvents() {
  const fp = path.join(ROOT, 'data', 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

function readLines(name) {
  const fp = path.join(ROOT, 'data', name);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
}

// ── Simple profile detection (mirrors runtime) ────────────────────
function detectProfile(objective) {
  const text = String(objective || '').toLowerCase();
  if (/\b(diagnos|bug|failing test|incorrect assertion|test failure|which test|fix test|broken test)\b/.test(text)) return 'diagnosis';
  if (/\b(move|rename|restructur|refactor|reorganize|archive|consolidate)\b/.test(text)) return 'refactor';
  if (/\b(recommend|top [0-9]+|improvement|critical issue|action item|fix plan|roadmap)\b/.test(text)) return 'recommendation';
  if (/\b(list all|catalog|inventory|enumerate|all files|all directories|every file|full list)\b/.test(text)) return 'bulk-inventory';
  if (/\b(report|summary|synthesis|overview|analysis|status|audit)\b/.test(text)) return 'report';
  return 'other';
}

// ── Telemetry computation ───────────────────────────────────────────

function computeTelemetry() {
  const runs = readJson('runs.json');
  const tickets = readJson('tickets.json');
  const events = readEvents();
  const histories = readJson('operation-history.json');

  // ── Run-level metrics ───────────────────────────────────────────
  const terminalRuns = runs.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status));
  const completedRuns = runs.filter(r => r.status === 'completed');
  const failedRuns = runs.filter(r => r.status === 'failed');
  const interruptedRuns = runs.filter(r => r.status === 'interrupted');

  // Average metrics from replaySummary (evidence in run record)
  const avgSteps = safeAvg(terminalRuns.map(r => r.replaySummary && r.replaySummary.steps));
  const avgModelRequests = safeAvg(terminalRuns.map(r => r.replaySummary && r.replaySummary.providerRequests));
  const avgWorkspaceOps = safeAvg(terminalRuns.map(r => r.replaySummary && r.replaySummary.workspaceOperations));
  const avgMutations = safeAvg(terminalRuns.map(r => r.replaySummary && r.replaySummary.mutationCount));

  // Runtime duration from startedAt/completedAt
  const durations = terminalRuns.map(r => {
    if (!r.startedAt || !r.completedAt) return null;
    const start = new Date(r.startedAt).getTime();
    const end = new Date(r.completedAt).getTime();
    return Number.isFinite(end - start) ? end - start : null;
  }).filter(Number.isFinite);
  const avgDurationMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  // Retry/reassess frequency
  const retryRuns = terminalRuns.filter(r => r.rerunMode === 'retry');
  const reassessRuns = terminalRuns.filter(r => r.rerunMode === 'reassess');
  const rerunTickets = new Set(terminalRuns.filter(r => r.rerunMode).map(r => r.ticketId));

  // ── Profile-level metrics ──────────────────────────────────────
  const runsByProfile = {};
  for (const run of terminalRuns) {
    const ticket = tickets.find(t => t.id === run.ticketId);
    const profile = ticket ? detectProfile(ticket.objective) : 'other';
    if (!runsByProfile[profile]) runsByProfile[profile] = [];
    runsByProfile[profile].push(run);
  }

  const profileMetrics = {};
  for (const [profile, profileRuns] of Object.entries(runsByProfile)) {
    const pCompleted = profileRuns.filter(r => r.status === 'completed');
    const pFailed = profileRuns.filter(r => r.status === 'failed');
    profileMetrics[profile] = {
      total: profileRuns.length,
      completed: pCompleted.length,
      failed: pFailed.length,
      successRate: profileRuns.length > 0 ? Math.round((pCompleted.length / profileRuns.length) * 100) : 0,
      avgSteps: safeAvg(profileRuns.map(r => r.replaySummary && r.replaySummary.steps)),
      avgModelRequests: safeAvg(profileRuns.map(r => r.replaySummary && r.replaySummary.providerRequests)),
      avgWorkspaceOps: safeAvg(profileRuns.map(r => r.replaySummary && r.replaySummary.workspaceOperations)),
      avgMutations: safeAvg(profileRuns.map(r => r.replaySummary && r.replaySummary.mutationCount))
    };
  }

  // ── Failure metrics ─────────────────────────────────────────────
  const phaseViolations = events.filter(e => e.type === 'execution.phase_violation').length;
  const authorityDenied = events.filter(e => e.type === 'authority.denied').length;
  const actionSuppressed = events.filter(e => e.type === 'action.suppressed').length;

  // Commit conflicts: duplicate mutations in same run
  const commitConflicts = computeCommitConflicts(histories);

  // Model non-progress loops: stalled responses from replaySummary
  const nonProgressLoops = terminalRuns.filter(r =>
    r.replaySummary && r.replaySummary.failure && r.replaySummary.failure.kind === 'step' &&
    r.error && r.error.includes('stalled')
  ).length;

  // Limit exhaustion
  const limitExhaustion = terminalRuns.filter(r =>
    r.replaySummary && r.replaySummary.failure && r.replaySummary.failure.code === 'RUN_LIMIT_EXCEEDED'
  ).length;

  // Runtime crashes / OOM / model failures
  const oomFailures = terminalRuns.filter(r =>
    r.error && /memory|oom|out of memory|requires more system memory/i.test(r.error)
  ).length;
  const modelFailures = terminalRuns.filter(r =>
    r.error && /model|provider|ollama|openai|gpt|gemma|deepseek/i.test(r.error) && !/memory/i.test(r.error)
  ).length;

  // Failure classification from replaySummary
  const failureKinds = {};
  for (const run of terminalRuns) {
    if (run.replaySummary && run.replaySummary.failure && run.replaySummary.failure.kind) {
      const kind = run.replaySummary.failure.kind;
      failureKinds[kind] = (failureKinds[kind] || 0) + 1;
    }
  }

  // ── Model reliability metrics ─────────────────────────────────
  const runsByModel = {};
  for (const run of terminalRuns) {
    const model = run.replaySummary && run.replaySummary.model ? run.replaySummary.model : 'unknown';
    if (!runsByModel[model]) runsByModel[model] = { completed: 0, failed: 0, total: 0, durations: [] };
    runsByModel[model].total += 1;
    if (run.status === 'completed') {
      runsByModel[model].completed += 1;
    } else {
      runsByModel[model].failed += 1;
    }
    if (run.startedAt && run.completedAt) {
      const dur = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      if (Number.isFinite(dur)) runsByModel[model].durations.push(dur);
    }
  }

  const modelMetrics = {};
  for (const [model, stats] of Object.entries(runsByModel)) {
    modelMetrics[model] = {
      total: stats.total,
      completed: stats.completed,
      failed: stats.failed,
      successRate: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
      avgDurationMs: stats.durations.length > 0 ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length) : 0
    };
  }

  // Terminalization correctness: execution_completed followed by terminalized
  const terminalizationCorrect = events.filter(e => e.type === 'run.terminalized').length;
  const executionCompleted = events.filter(e => e.type === 'run.execution_completed').length;

  // ── Operational pressure metrics ──────────────────────────────
  // Queue depth from scheduler.tick events
  const tickEvents = events.filter(e => e.type === 'scheduler.tick');
  const pendingRunsOverTime = tickEvents.map(e => e.payload && e.payload.pendingRuns).filter(Number.isFinite);
  // Iterative reduce avoids spreading a large array into Math.max arguments,
  // which overflows the call stack on long event logs (172k+ tick entries).
  // Queue depths are non-negative, so an empty array yields 0 — same as before.
  const maxQueueDepth = pendingRunsOverTime.reduce((max, value) => Math.max(max, value), 0);
  const avgQueueDepth = pendingRunsOverTime.length > 0 ? Math.round(pendingRunsOverTime.reduce((a, b) => a + b, 0) / pendingRunsOverTime.length) : 0;

  // Active runs: run.started events minus terminal events
  const startedCount = events.filter(e => e.type === 'run.started').length;
  const recoveryCount = events.filter(e => e.type === 'run.resumed').length;
  const leaseExpiredCount = events.filter(e => e.type === 'run.lease_expired').length;

  // Checkpoint restores from snapshot events
  const checkpointRestoreCount = events.filter(e =>
    e.type === 'replay.snapshot.finalized' || e.type === 'run.snapshot_finalized'
  ).length;

  // ── Artifact metrics ────────────────────────────────────────────
  const writeFileOps = histories.filter(h => h.operation === 'writeFile');
  const reportArtifacts = writeFileOps.filter(h => {
    const path = h.args && h.args.path ? h.args.path.toLowerCase() : '';
    return /\.(md|txt|rst)$/.test(path);
  });
  const mutationCount = histories.filter(h =>
    ['writeFile', 'createFolder', 'renamePath', 'deletePath'].includes(h.operation)
  ).length;

  // Verification pass/fail: postcondition and violation events
  const postconditionChecks = events.filter(e => e.type === 'run.postcondition_completed').length;
  const violationChecks = events.filter(e => e.type === 'run.violations_checked').length;
  const violationDetected = events.filter(e => e.type === 'run.violation_detected').length;

  return {
    summary: {
      totalRuns: runs.length,
      terminalRuns: terminalRuns.length,
      completedRuns: completedRuns.length,
      failedRuns: failedRuns.length,
      interruptedRuns: interruptedRuns.length,
      avgSteps,
      avgModelRequests,
      avgWorkspaceOps,
      avgMutations,
      avgDurationMs,
      retryCount: retryRuns.length,
      reassessCount: reassessRuns.length,
      rerunTickets: rerunTickets.size
    },
    profileMetrics,
    failureMetrics: {
      phaseViolations,
      authorityDenied,
      actionSuppressed,
      commitConflicts,
      nonProgressLoops,
      limitExhaustion,
      oomFailures,
      modelFailures,
      failureKinds
    },
    modelMetrics,
    terminalizationMetrics: {
      terminalizationCorrect,
      executionCompleted,
      correctnessRatio: executionCompleted > 0 ? Math.round((terminalizationCorrect / executionCompleted) * 100) : 0
    },
    operationalPressure: {
      maxQueueDepth,
      avgQueueDepth,
      startedCount,
      recoveryCount,
      leaseExpiredCount,
      checkpointRestoreCount
    },
    artifactMetrics: {
      totalWriteFiles: writeFileOps.length,
      reportArtifacts: reportArtifacts.length,
      totalMutations: mutationCount,
      postconditionChecks,
      violationChecks,
      violationsDetected: violationDetected
    }
  };
}

function safeAvg(values) {
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (valid.length === 0) return 0;
  return Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 100) / 100;
}

function computeCommitConflicts(histories) {
  const byRun = {};
  for (const h of histories) {
    if (!byRun[h.runId]) byRun[h.runId] = new Set();
    const key = `${h.operation}:${JSON.stringify(h.args)}`;
    byRun[h.runId].add(key);
  }
  // Count duplicates within same run
  let conflicts = 0;
  const seen = new Map();
  for (const h of histories) {
    const key = `${h.runId}:${h.operation}:${JSON.stringify(h.args)}`;
    if (seen.has(key)) {
      conflicts += 1;
    } else {
      seen.set(key, true);
    }
  }
  return conflicts;
}

// ── Markdown report generation ──────────────────────────────────

function generateMarkdownReport(telemetry) {
  const s = telemetry.summary;
  const lines = [
    '# Operational Telemetry Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Data source: ledger evidence (events.jsonl, runs.json, tickets.json, operation-history.json)`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total runs | ${s.totalRuns} |`,
    `| Terminal runs | ${s.terminalRuns} |`,
    `| Completed | ${s.completedRuns} |`,
    `| Failed | ${s.failedRuns} |`,
    `| Interrupted | ${s.interruptedRuns} |`,
    `| Avg execution steps | ${s.avgSteps} |`,
    `| Avg model requests | ${s.avgModelRequests} |`,
    `| Avg workspace operations | ${s.avgWorkspaceOps} |`,
    `| Avg mutations | ${s.avgMutations} |`,
    `| Avg duration (ms) | ${s.avgDurationMs} |`,
    `| Retry runs | ${s.retryCount} |`,
    `| Reassess runs | ${s.reassessCount} |`,
    `| Tickets with reruns | ${s.rerunTickets} |`,
    '',
    '## Profile Metrics',
    '',
    '| Profile | Total | Completed | Failed | Success Rate | Avg Steps | Avg Model Requests | Avg Workspace Ops |',
    '|---------|-------|-----------|--------|--------------|-----------|-------------------|-------------------|'
  ];

  for (const [profile, m] of Object.entries(telemetry.profileMetrics).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${profile} | ${m.total} | ${m.completed} | ${m.failed} | ${m.successRate}% | ${m.avgSteps} | ${m.avgModelRequests} | ${m.avgWorkspaceOps} |`);
  }

  lines.push(
    '',
    '## Failure Metrics',
    '',
    '| Metric | Count |',
    '|--------|-------|',
    `| Phase violations | ${telemetry.failureMetrics.phaseViolations} |`,
    `| Authority denials | ${telemetry.failureMetrics.authorityDenied} |`,
    `| Action suppressed | ${telemetry.failureMetrics.actionSuppressed} |`,
    `| Commit conflicts | ${telemetry.failureMetrics.commitConflicts} |`,
    `| Non-progress loops | ${telemetry.failureMetrics.nonProgressLoops} |`,
    `| Limit exhaustion | ${telemetry.failureMetrics.limitExhaustion} |`,
    `| OOM failures | ${telemetry.failureMetrics.oomFailures} |`,
    `| Model failures | ${telemetry.failureMetrics.modelFailures} |`
  );

  if (Object.keys(telemetry.failureMetrics.failureKinds).length > 0) {
    lines.push('', '### Failure Classifications', '', '| Kind | Count |', '|------|-------|');
    for (const [kind, count] of Object.entries(telemetry.failureMetrics.failureKinds).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${kind} | ${count} |`);
    }
  }

  lines.push(
    '',
    '## Model Reliability',
    '',
    '| Model | Total | Completed | Failed | Success Rate | Avg Duration (ms) |',
    '|-------|-------|-----------|--------|--------------|-------------------|'
  );
  for (const [model, m] of Object.entries(telemetry.modelMetrics).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${model} | ${m.total} | ${m.completed} | ${m.failed} | ${m.successRate}% | ${m.avgDurationMs} |`);
  }

  const t = telemetry.terminalizationMetrics;
  lines.push(
    '',
    '## Terminalization Correctness',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| execution_completed events | ${t.executionCompleted} |`,
    `| terminalized events | ${t.terminalizationCorrect} |`,
    `| Correctness ratio | ${t.correctnessRatio}% |`
  );

  const p = telemetry.operationalPressure;
  lines.push(
    '',
    '## Operational Pressure',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Max queue depth | ${p.maxQueueDepth} |`,
    `| Avg queue depth | ${p.avgQueueDepth} |`,
    `| Runs started | ${p.startedCount} |`,
    `| Recovery events | ${p.recoveryCount} |`,
    `| Lease expired | ${p.leaseExpiredCount} |`,
    `| Checkpoint restores | ${p.checkpointRestoreCount} |`
  );

  const a = telemetry.artifactMetrics;
  lines.push(
    '',
    '## Artifact Metrics',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Total writeFile operations | ${a.totalWriteFiles} |`,
    `| Report artifacts (.md, .txt, .rst) | ${a.reportArtifacts} |`,
    `| Total mutations | ${a.totalMutations} |`,
    `| Postcondition checks | ${a.postconditionChecks} |`,
    `| Violation checks | ${a.violationChecks} |`,
    `| Violations detected | ${a.violationsDetected} |`
  );

  lines.push('');
  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────
function main() {
  const telemetry = computeTelemetry();
  const report = generateMarkdownReport(telemetry);

  const outputPath = process.argv[2] || path.join(ROOT, 'data', 'telemetry-report.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, report, 'utf8');

  console.log(`Telemetry report written to: ${outputPath}`);
  console.log(`  Runs: ${telemetry.summary.terminalRuns} terminal (${telemetry.summary.completedRuns} completed, ${telemetry.summary.failedRuns} failed)`);
  console.log(`  Phase violations: ${telemetry.failureMetrics.phaseViolations}`);
  console.log(`  Commit conflicts: ${telemetry.failureMetrics.commitConflicts}`);
}

module.exports = { computeTelemetry, generateMarkdownReport, detectProfile };

if (require.main === module) {
  main();
}
