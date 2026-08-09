#!/usr/bin/env node
'use strict';

// Load-bearing pre-provider gate. This test writes a complete controlled
// live-v3-shaped corpus, then spawns the ACTUAL production report CLI. It does
// not pass a fixture report object or path: production resolves and validates
// the retained fixture-v2 bytes named by live-v3.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
  assertLiveReportIdentity, trialIdForLiveAssignment
} = require('./fixtures/evaluation-live-scoring');
const {
  assertDispatchWithinGlobalCeiling
} = require('./fixtures/evaluation-live-budget-ledger');
const { appendJournal } = require('./fixtures/evaluation-live-run-journal');
const { hashCanonical } = require('./structured-allocation-evaluation-scorer');
const {
  buildLiveReportFromRoot, parseArguments, sha256
} = require('./structured-allocation-evaluation-report-live');
const {
  LiveScoringClosureError, assertLiveScoringClosureReady
} = require('./fixtures/evaluation-live-scoring-closure');
const {
  artifactFor, headerFor, liveManifest
} = require('./evaluation-live-scoring-dress-rehearsal-test');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
function ok(value, message) {
  assert.equal(value, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function buildHeader() {
  const header = {
    ...headerFor(liveManifest),
    evidenceClass: READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
    readinessDressRehearsal: true,
    syntheticAcceptance: false,
    syntheticAcceptanceLabel: null,
    economics: {
      maximumTotalLiveMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
      committedMicroUsd: liveManifest.economics.computedWorstCaseMicroUsd
    }
  };
  delete header.runHeaderHash;
  header.runHeaderHash = hashCanonical(header);
  return header;
}

function writeControlledCorpus(root) {
  const header = buildHeader();
  writeJson(path.join(root, 'live-run-header.json'), header);
  writeJson(path.join(root, 'PROVIDER-FREE-SCORING-DRESS-REHEARSAL.json'), {
    evidenceClass: READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS,
    manifestHash: liveManifest.manifestHash,
    providerCalls: 0
  });
  fs.mkdirSync(path.join(root, 'trials'), { recursive: true });
  const bind = {
    runHeaderHash: header.runHeaderHash,
    manifestHash: liveManifest.manifestHash
  };
  for (const slot of liveManifest.slots) {
    const trialId = trialIdForLiveAssignment(slot);
    const artifact = artifactFor(slot, header);
    writeJson(path.join(root, 'trials', `${trialId}.json`), artifact);
    const bound = liveManifest.economics.liability.byArm[slot.armId].perTrialMicroUsd;
    assertDispatchWithinGlobalCeiling({
      runRoot: root,
      ceilingMicroUsd: liveManifest.economics.maximumTotalLiveMicroUsd,
      maximumLiabilityMicroUsd: bound,
      trialId,
      role: `controlled_dress_rehearsal:${slot.armId}`,
      ordinal: slot.slot
    });
    appendJournal(root, {
      ...bind, event: 'slot_accepted', trialId, slotOrdinal: slot.slot,
      controlledProviderCalls: 0
    });
  }
  appendJournal(root, {
    ...bind, event: 'run_complete', trialId: null, slotOrdinal: null,
    acceptedCount: liveManifest.slots.length,
    assignedCount: liveManifest.slots.length
  });
  return header;
}

function main() {
  console.log('evaluation live production scoring closure');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-v3-production-closure-'));
  try {
    writeControlledCorpus(root);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key === 'OPENAI_API_KEY' || key.startsWith('STRUCTURED_ALLOCATION_LIVE_') ||
          key.startsWith('EVALUATION_LIVE_')) delete env[key];
    }
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/structured-allocation-evaluation-report-live.js'),
      root,
      '--readiness-dress-rehearsal'
    ], { cwd: ROOT, env, encoding: 'utf8' });
    ok(result.status === 0,
      `the actual production report command completes (${result.stderr.trim() || 'no stderr'})`);
    const version = liveManifest.liveManifestVersion;
    const jsonPath = path.join(root,
      `structured-allocation-live-scoring-dress-rehearsal-v${version}.json`);
    const markdownPath = path.join(root,
      `structured-allocation-live-scoring-dress-rehearsal-v${version}.md`);
    const hashesPath = path.join(root,
      `structured-allocation-live-scoring-dress-rehearsal-hashes-v${version}.json`);
    const jsonBytes = fs.readFileSync(jsonPath);
    const markdownBytes = fs.readFileSync(markdownPath);
    const report = JSON.parse(jsonBytes);
    const hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8'));
    ok(report.evidenceClass === READINESS_DRESS_REHEARSAL_EVIDENCE_CLASS &&
       report.liveManifestVersion === 3 && report.counts.assigned === 120 &&
       report.counts.executed === 120 && report.counts.infrastructureExclusions === 0,
    'the command labels non-product evidence and accounts for all 120 live-v3 slots');
    ok(Object.keys(report.metricsByArm).join(',') === 'A,A2a,A2b,B,C' &&
       ['family-2', 'family-3', 'family-5', 'family-6'].every(family =>
         Object.prototype.hasOwnProperty.call(report.metricsByFamily, family)),
    'the exact command emits five-arm metrics for actual families 2/3/5/6');
    ok(report.authorizedDimensions.length === 5 &&
       report.hardDisqualifiers.length === 5 &&
       report.hardDisqualifiers.every(entry =>
         ['TRIGGERED', 'NOT TRIGGERED', 'NOT EVALUABLE'].includes(entry.result)),
    'all five metrics and every hard-disqualifier tri-state execute');
    ok(['RETAIN', 'REVISE', 'STOP'].includes(
      report.liveOrdinaryDecision.ordinaryDecision) &&
       ['RETAIN', 'REVISE', 'STOP'].includes(report.finalProductDecision),
    'ordinary and fixture/live-combined decisions reach a terminal mock result');
    ok(report.fixtureEvidence.fixtureEvidenceVersion === 2 &&
       report.fixtureEvidence.manifestHash ===
         liveManifest.source.fixtureManifestHash &&
       report.fixtureEvidence.corpusHash === liveManifest.source.fixtureCorpusHash &&
       report.fixtureEvidence.reportHash === liveManifest.source.fixtureReportHash,
    'the report consumed manifest-bound fixture-v2 evidence, not an injected capsule');
    ok(assertLiveReportIdentity(report) &&
       hashes.reportHash === report.reportHash &&
       hashes.jsonFileSha256 === sha256(jsonBytes) &&
       hashes.markdownFileSha256 === sha256(markdownBytes),
    'canonical JSON/Markdown and raw-file hashes validate');
    const first = buildLiveReportFromRoot({
      outputRoot: root, readinessDressRehearsal: true
    });
    const second = buildLiveReportFromRoot({
      outputRoot: root, readinessDressRehearsal: true
    });
    ok(JSON.stringify(first.report) === JSON.stringify(second.report) &&
       first.markdown === second.markdown &&
       first.fixtureEvidence.registryHash === second.fixtureEvidence.registryHash,
    'a fresh second read reproduces report, Markdown and fixture provenance exactly');
    let arbitraryPathRefused = false;
    try { parseArguments([root, '--fixture-report', '/tmp/look-alike.json']); }
    catch (_) { arbitraryPathRefused = true; }
    ok(arbitraryPathRefused,
      'the production command refuses an operator-supplied fixture report path');
    ok(!jsonBytes.includes(Buffer.from('OPENAI_API_KEY')) &&
       !markdownBytes.includes(Buffer.from('OPENAI_API_KEY')),
    'production-closure outputs contain no credential field');

    const ready = assertLiveScoringClosureReady({ manifest: liveManifest });
    ok(ready.ready === true &&
       ready.productionReportOwner ===
         'scripts/structured-allocation-evaluation-report-live.js',
    'the pre-provider gate resolves fixture bytes and the production report owner');

    const reportOwnerPath = require.resolve(
      './structured-allocation-evaluation-report-live');
    const reportOwner = require(reportOwnerPath);
    const originalBuild = reportOwner.buildLiveReportFromRoot;
    let missingProductionOwnerRefused = false;
    try {
      reportOwner.buildLiveReportFromRoot = undefined;
      assertLiveScoringClosureReady({ manifest: liveManifest });
    } catch (error) {
      missingProductionOwnerRefused = error instanceof LiveScoringClosureError &&
        error.code === 'LIVE_SCORING_CLOSURE_REPORT_OWNER_MISSING';
    } finally {
      reportOwner.buildLiveReportFromRoot = originalBuild;
    }
    ok(missingProductionOwnerRefused,
      'the pre-provider gate refuses when the production report command is unavailable');

    const noFixtureAuthorityRoot = fs.mkdtempSync(path.join(os.tmpdir(),
      'live-v3-no-fixture-authority-'));
    let resolverBypassRefused = false;
    try {
      buildLiveReportFromRoot({
        outputRoot: root,
        readinessDressRehearsal: true,
        repositoryRoot: noFixtureAuthorityRoot
      });
    } catch (error) {
      resolverBypassRefused = error?.code === 'FIXTURE_EVIDENCE_FILE_MISSING';
    } finally {
      fs.rmSync(noFixtureAuthorityRoot, { recursive: true, force: true });
    }
    ok(resolverBypassRefused,
      'the production command cannot bypass its repository-owned fixture resolver');
    console.log(`\nevaluation live production scoring closure passed — ${passed} assertions; provider calls 0`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
