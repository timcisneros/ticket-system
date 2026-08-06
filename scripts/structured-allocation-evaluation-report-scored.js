#!/usr/bin/env node
'use strict';

// Tranche 6 — render the immutable scored report from a frozen corpus.
//
// It reads artifacts from disk, hands them to the pure scorer, and writes the
// JSON and Markdown reports. It computes nothing itself: every number in the
// output comes from the scorer, and every claim carries the trial ids behind
// it.

const fs = require('node:fs');
const path = require('node:path');
const { scoreCorpus } = require('./structured-allocation-evaluation-scorer');

function loadCorpus(outputRoot) {
  const header = JSON.parse(
    fs.readFileSync(path.join(outputRoot, 'scored-run-header.json'), 'utf8'));
  const trialsDir = path.join(outputRoot, 'trials');
  const artifacts = fs.readdirSync(trialsDir).filter(name => name.endsWith('.json'))
    .sort()
    .map(name => JSON.parse(fs.readFileSync(path.join(trialsDir, name), 'utf8')));
  const exclusionsPath = path.join(outputRoot, 'exclusions.json');
  const exclusions = fs.existsSync(exclusionsPath)
    ? JSON.parse(fs.readFileSync(exclusionsPath, 'utf8')) : [];
  return { header, artifacts, exclusions };
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function number(value, digits = 0) {
  return value === null || value === undefined ? 'n/a' : value.toFixed(digits);
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Structured Allocation — Scored Fixture Evaluation, Protocol v1');
  lines.push('');
  lines.push('**SCORED FIXTURE EVIDENCE.** Deterministic fixture trials only. No');
  lines.push('live-model trial contributed to any number below.');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Protocol | ${report.protocolId} v${report.protocolVersion} |`);
  lines.push(`| Manifest hash | \`${report.manifestHash}\` |`);
  lines.push(`| Scored-run hash | \`${report.scoredRunHash}\` |`);
  lines.push(`| Repository commit | \`${report.repositoryCommit}\` |`);
  lines.push(`| Corpus hash | \`${report.corpusIntegrity.corpusHash}\` |`);
  lines.push(`| Trials | ${report.trialCount} |`);
  lines.push(`| Exclusions | ${report.exclusions.length} |`);
  lines.push(`| Report hash | \`${report.reportHash}\` |`);
  lines.push('');
  lines.push(`**Corpus integrity:** ${report.corpusIntegrity.verdict}`);
  lines.push('');

  lines.push('## Metrics by arm');
  lines.push('');
  lines.push('Arms are never collapsed: A2a/A2b and B/C stay separate so the evidence');
  lines.push('can distinguish legacy parallelism from structured machinery, and');
  lines.push('allocated from dynamic ownership.');
  lines.push('');
  lines.push('| Arm | Trials | Allocation quality | True completion | FALSE completion | Oracle refused | Latency (ms) | Normalized cost | Churn windows |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const armId of ['A', 'A2a', 'A2b', 'B', 'C']) {
    const m = report.metricsByArm[armId];
    if (!m) continue;
    lines.push(`| ${armId} | ${m.trials} | ${percent(m.allocation_quality.value)} | ` +
      `${percent(m.completion_truthfulness.truePositiveCompletion.value)} | ` +
      `${percent(m.completion_truthfulness.falsePositiveCompletion.value)} | ` +
      `${percent(m.completion_truthfulness.oracleRefused.value)} | ` +
      `${number(m.latency.endToEndMs.value)} | ${number(m.cost.normalized.value, 2)} | ` +
      `${number(m.churn.evaluatedNoProgressWindows.value, 2)} |`);
  }
  lines.push('');

  lines.push('## Hard disqualifiers');
  lines.push('');
  lines.push('Evaluated BEFORE any ordinary tradeoff. None was added, waived or');
  lines.push('reworded after seeing which arm triggered it.');
  lines.push('');
  for (const entry of report.hardDisqualifiers) {
    lines.push(`- **${entry.result}** — ${entry.statement}`);
    if (entry.contributingTrialIds.length > 0) {
      lines.push(`  - contributing: \`${entry.contributingTrialIds.slice(0, 8).join('`, `')}\`` +
        (entry.contributingTrialIds.length > 8
          ? ` … (${entry.contributingTrialIds.length} total)` : ''));
    }
  }
  lines.push('');

  lines.push('## Frozen decision');
  lines.push('');
  lines.push(`**${report.frozenDecision.decision}**`);
  lines.push('');
  lines.push(`Basis: ${report.frozenDecision.basis}`);
  lines.push('');
  lines.push(`- structured true-completion gain versus A: ` +
    `${report.frozenDecision.gainVersusAPoints.toFixed(1)} points`);
  lines.push(`- structured true-completion gain versus A2: ` +
    `${report.frozenDecision.gainVersusA2Points.toFixed(1)} points`);
  lines.push('');
  lines.push(`**FINAL PRODUCT DECISION: ${report.finalProductDecision}**`);
  lines.push('');

  lines.push('## Metrics by scenario family');
  lines.push('');
  for (const [family, arms] of Object.entries(report.metricsByFamily).sort()) {
    lines.push(`### ${family}`);
    lines.push('');
    lines.push('| Arm | Trials | Allocation quality | True completion | FALSE completion |');
    lines.push('|---|---|---|---|---|');
    for (const [armId, m] of Object.entries(arms).sort()) {
      lines.push(`| ${armId} | ${m.trials} | ${percent(m.allocation_quality.value)} | ` +
        `${percent(m.completion_truthfulness.truePositiveCompletion.value)} | ` +
        `${percent(m.completion_truthfulness.falsePositiveCompletion.value)} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const outputRoot = process.argv[2];
  if (!outputRoot) {
    console.error('usage: structured-allocation-evaluation-report-scored.js <scored-run-root>');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config',
      'structured-allocation-evaluation-scored-v1.json'), 'utf8'));
  const protocol = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config',
      'structured-allocation-evaluation-v1.json'), 'utf8'));
  const { header, artifacts, exclusions } = loadCorpus(outputRoot);
  const report = scoreCorpus({ manifest, header, artifacts, exclusions, protocol });

  const jsonPath = path.join(outputRoot, 'structured-allocation-scored-fixture-report-v1.json');
  const mdPath = path.join(outputRoot, 'structured-allocation-scored-fixture-report-v1.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));
  console.log(report.corpusIntegrity.verdict);
  console.log(`trials ${report.trialCount} | exclusions ${report.exclusions.length}`);
  console.log(`decision: ${report.frozenDecision.decision}`);
  console.log(`final: ${report.finalProductDecision}`);
  console.log(`report hash: ${report.reportHash}`);
  console.log(jsonPath);
  console.log(mdPath);
}

module.exports = { loadCorpus, renderMarkdown };

if (require.main === module) main();
