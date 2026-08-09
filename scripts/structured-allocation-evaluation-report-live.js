#!/usr/bin/env node
'use strict';

// Immutable REAL-live report owner. This is intentionally separate from the
// fixture-branded renderer: the two evidence classes are scored independently
// and meet only at the frozen evidence-combination contract.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertScorableLiveCorpus, auditLiveCorpus
} = require('./fixtures/evaluation-live-corpus-integrity');
const {
  READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
  assertLiveHeaderScorable, assertLiveReportIdentity,
  projectLiveManifestToScoring, scoreLiveCorpus,
  trialIdForLiveAssignment
} = require('./fixtures/evaluation-live-scoring');
const {
  resolveFixtureEvidenceForLiveManifest
} = require('./fixtures/evaluation-fixture-evidence');
const {
  reconstructCommittedLiability
} = require('./fixtures/evaluation-live-budget-ledger');
const { readJournal } = require('./fixtures/evaluation-live-run-journal');

function parseArguments(argv) {
  if (argv.length < 1) {
    throw new Error('usage: structured-allocation-evaluation-report-live.js ' +
      '<real-live-root> [--readiness-dress-rehearsal]');
  }
  const parsed = { outputRoot: argv[0], readinessDressRehearsal: false };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== '--readiness-dress-rehearsal') {
      throw new Error('only --readiness-dress-rehearsal is accepted after the live root');
    }
    if (parsed.readinessDressRehearsal) {
      throw new Error('--readiness-dress-rehearsal may be supplied only once');
    }
    parsed.readinessDressRehearsal = true;
  }
  return parsed;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readRealCorpusFiles(outputRoot) {
  const trialsDir = path.join(outputRoot, 'trials');
  const exclusionsDir = path.join(outputRoot, 'exclusions');
  const readDirectory = directory => fs.existsSync(directory)
    ? fs.readdirSync(directory).filter(file => file.endsWith('.json')).sort()
      .map(file => readJson(path.join(directory, file))) : [];
  return Object.freeze({
    artifacts: Object.freeze(readDirectory(trialsDir)),
    exclusions: Object.freeze(readDirectory(exclusionsDir))
  });
}

function percent(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function number(value, digits = 0) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? 'n/a' : Number(value).toFixed(digits);
}

function renderLiveMarkdown(report) {
  const lines = [];
  const dressRehearsal =
    report.evidenceClass === READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS;
  lines.push(dressRehearsal
    ? `# Structured Allocation — Provider-Free Live Scoring Dress Rehearsal, Protocol v${report.protocolVersion}`
    : `# Structured Allocation — REAL Live Evaluation, Protocol v${report.protocolVersion}`);
  lines.push('');
  lines.push(dressRehearsal
    ? `**${READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS}.**`
    : '**REAL LIVE PRODUCT EVIDENCE.** Fixture and live denominators were');
  if (dressRehearsal) {
    lines.push('Controlled synthetic live-shaped facts exercise the production report path.');
    lines.push('Fixture and live denominators were');
  }
  lines.push('scored separately and were never pooled.');
  lines.push('');
  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Trial source | \`${report.trialSourceCommit}\` |`);
  lines.push(`| Live manifest | v${report.liveManifestVersion} \`${report.liveManifestHash}\` |`);
  lines.push(`| Live artifact domain | v${report.liveArtifactDomainVersion} |`);
  lines.push(`| Real run header | \`${report.realRunHeaderHash}\` |`);
  lines.push(`| Live corpus | \`${report.liveCorpusHash}\` |`);
  lines.push(`| Credential authority | configured agent ${report.credentialAuthority.configuredAgentId}, revision ${report.credentialAuthority.configuredAgentRevision}, ${report.credentialAuthority.provider} |`);
  lines.push(`| Assigned / executed / excluded | ${report.counts.assigned} / ${report.counts.executed} / ${report.counts.infrastructureExclusions} |`);
  lines.push(`| Report hash | \`${report.reportHash}\` |`);
  lines.push('');

  lines.push('## Five frozen metrics by arm');
  lines.push('');
  lines.push('| Arm | Trials | Allocation quality | True completion | FALSE completion | Latency ms | Normalized cost | Churn windows |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const armId of ['A', 'A2a', 'A2b', 'B', 'C']) {
    const metric = report.metricsByArm[armId];
    lines.push(`| ${armId} | ${metric.trials} | ${percent(metric.allocation_quality.value)} | ` +
      `${percent(metric.completion_truthfulness.truePositiveCompletion.value)} | ` +
      `${percent(metric.completion_truthfulness.falsePositiveCompletion.value)} | ` +
      `${number(metric.latency.endToEndMs.value)} | ` +
      `${number(metric.cost.normalized.value, 2)} | ` +
      `${number(metric.churn.evaluatedNoProgressWindows.value, 2)} |`);
  }
  lines.push('');

  lines.push('## Hard disqualifiers');
  lines.push('');
  for (const entry of report.hardDisqualifiers) {
    const family = entry.contributingFamilies.length > 0
      ? `; families ${entry.contributingFamilies.join(', ')}` : '';
    lines.push(`- **${entry.result}** — ${entry.statement}${family}`);
    if (entry.contributingTrialIds.length > 0) {
      lines.push(`  - trial IDs: \`${entry.contributingTrialIds.join('`, `')}\``);
    }
    if (entry.notEvaluableReason) lines.push(`  - reason: ${entry.notEvaluableReason}`);
  }
  lines.push('');

  lines.push('## Decision');
  lines.push('');
  lines.push(`- Live ordinary decision: **${report.liveOrdinaryDecision.ordinaryDecision}**`);
  lines.push(`- Immutable fixture conclusion: **${report.fixtureEvidence.conclusion}**`);
  lines.push(`- Final combined decision: **${report.finalProductDecision}**`);
  lines.push(`- Basis: ${report.evidenceCombination.rationale}`);
  lines.push(`- Strongest competing interpretation: ${report.strongestCompetingInterpretation}`);
  lines.push('');
  lines.push('Decision-driving trial IDs:');
  lines.push('');
  lines.push(report.decisionDrivingTrialIds.length > 0
    ? report.decisionDrivingTrialIds.map(id => `- \`${id}\``).join('\n')
    : '- none (the frozen rule was not evaluable from a narrower trial subset)');
  lines.push('');

  lines.push('## Cost and authority reporting');
  lines.push('');
  lines.push(`- Observable provider spend: ${report.costReporting.observableProviderSpendMicroUsd} micro-USD (${report.costReporting.observableProviderSpendCompleteness}).`);
  lines.push('- Normalized cost is labelled normalized scoring cost; it is not actual billing.');
  lines.push(`- Committed maximum liability: ${report.costReporting.committedLiabilityMicroUsd} micro-USD; it is not actual billing.`);
  lines.push(`- Global live authority: ${report.costReporting.globalAuthorityMicroUsd} micro-USD; never exceeded: ${report.costReporting.globalAuthorityNeverExceeded}.`);
  if (report.authenticatedPreflight) {
    lines.push(`- Authenticated preflight actual observable cost: ${report.authenticatedPreflight.actualCostMicroUsd === null ? 'unknown' : `${report.authenticatedPreflight.actualCostMicroUsd} micro-USD`} (separate from experiment evidence).`);
  }
  lines.push('');

  lines.push('## Scenario/family breakdown');
  lines.push('');
  for (const [family, arms] of Object.entries(report.metricsByFamily)) {
    lines.push(`### ${family}`);
    lines.push('');
    for (const [armId, metric] of Object.entries(arms)) {
      lines.push(`- ${armId}: ${metric.trials} trials, true completion ` +
        `${percent(metric.completion_truthfulness.truePositiveCompletion.value)}, ` +
        `latency ${number(metric.latency.endToEndMs.value)} ms, normalized cost ` +
        `${number(metric.cost.normalized.value, 2)}.`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeImmutable(file, bytes) {
  const handle = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function interruptionResumeHistory(journal) {
  return journal.records.filter(record => record.event === 'run_paused' ||
    record.recoveredArtifact === true).map(record => Object.freeze({
    event: record.event,
    trialId: record.trialId || null,
    acceptedCount: record.acceptedCount ?? null,
    recoveredArtifact: record.recoveredArtifact === true,
    at: record.at
  }));
}

function buildLiveReportFromRoot({ outputRoot,
  manifestPath = path.join(__dirname, '..', 'config',
    'structured-allocation-evaluation-live-v3.json'),
  protocolPath = path.join(__dirname, '..', 'config',
    'structured-allocation-evaluation-v1.json'),
  readinessDressRehearsal = false,
  repositoryRoot = path.join(__dirname, '..') }) {
  const manifest = readJson(manifestPath);
  const protocol = readJson(protocolPath);
  const projection = projectLiveManifestToScoring({ manifest, protocol });
  const header = readJson(path.join(outputRoot, 'live-run-header.json'));

  // The abort/synthetic/header gate runs BEFORE `trials/` or `exclusions/` is
  // listed. This ordering is load-bearing quarantine, not an optimization.
  assertLiveHeaderScorable({
    header, manifest, projection, readinessDressRehearsal
  });

  const diskAudit = auditLiveCorpus({
    manifest, header, outputRoot, trialIdFor: trialIdForLiveAssignment
  });
  assertScorableLiveCorpus(diskAudit);
  const { artifacts, exclusions } = readRealCorpusFiles(outputRoot);
  const journal = readJournal(outputRoot);
  const liability = reconstructCommittedLiability(outputRoot);
  // THE PROVENANCE BOUNDARY. No caller supplies fixture report bytes. The live
  // manifest names a repository registry, and the resolver re-opens the full
  // retained fixture corpus/report before returning its parsed report.
  const fixtureEvidence = resolveFixtureEvidenceForLiveManifest({
    manifest, root: repositoryRoot
  });
  let authenticatedPreflight = null;
  if (readinessDressRehearsal) {
    const markerPath = path.join(outputRoot,
      'PROVIDER-FREE-SCORING-DRESS-REHEARSAL.json');
    const marker = readJson(markerPath);
    if (marker.evidenceClass !== READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS ||
        marker.manifestHash !== manifest.manifestHash ||
        marker.providerCalls !== 0) {
      throw new Error('provider-free dress-rehearsal marker is absent or inconsistent');
    }
  } else {
    const preflightPath = `${outputRoot}.authenticated-preflight.json`;
    if (!fs.existsSync(preflightPath)) {
      throw new Error('the real live report requires the separately recorded authenticated preflight');
    }
    authenticatedPreflight = readJson(preflightPath);
  }
  const inputs = {
    manifest, protocol, header, artifacts, exclusions,
    fixtureReport: fixtureEvidence.report,
    committedLiabilityMicroUsd: liability.committedMicroUsd,
    interruptionResumeHistory: interruptionResumeHistory(journal),
    authenticatedPreflight,
    readinessDressRehearsal
  };
  const report = scoreLiveCorpus(inputs);
  const repeated = scoreLiveCorpus(inputs);
  assertLiveReportIdentity(report);
  if (JSON.stringify(report) !== JSON.stringify(repeated)) {
    throw new Error('live scoring is not deterministic under identical inputs');
  }
  const markdown = renderLiveMarkdown(report);
  if (markdown !== renderLiveMarkdown(repeated)) {
    throw new Error('live Markdown report is not deterministic under identical inputs');
  }
  return Object.freeze({ report, markdown, diskAudit, fixtureEvidence });
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const built = buildLiveReportFromRoot({
    outputRoot: options.outputRoot,
    readinessDressRehearsal: options.readinessDressRehearsal
  });
  const jsonBytes = `${JSON.stringify(built.report, null, 2)}\n`;
  const markdownBytes = built.markdown;
  const prefix = options.readinessDressRehearsal
    ? 'structured-allocation-live-scoring-dress-rehearsal'
    : 'structured-allocation-real-live-report';
  const version = built.report.liveManifestVersion;
  const jsonPath = path.join(options.outputRoot, `${prefix}-v${version}.json`);
  const markdownPath = path.join(options.outputRoot, `${prefix}-v${version}.md`);
  const hashesPath = path.join(options.outputRoot, `${prefix}-hashes-v${version}.json`);
  writeImmutable(jsonPath, jsonBytes);
  writeImmutable(markdownPath, markdownBytes);
  const hashes = {
    reportHash: built.report.reportHash,
    jsonFileSha256: sha256(jsonBytes),
    markdownFileSha256: sha256(markdownBytes)
  };
  writeImmutable(hashesPath, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(built.diskAudit.verdict);
  console.log(`assigned ${built.report.counts.assigned} | executed ` +
    `${built.report.counts.executed} | exclusions ` +
    `${built.report.counts.infrastructureExclusions}`);
  console.log(`final: ${built.report.finalProductDecision}`);
  console.log(`report hash: ${built.report.reportHash}`);
  console.log(jsonPath);
  console.log(markdownPath);
  console.log(hashesPath);
}

module.exports = {
  buildLiveReportFromRoot,
  parseArguments,
  readRealCorpusFiles,
  renderLiveMarkdown,
  sha256,
  writeImmutable
};

if (require.main === module) main();
