#!/usr/bin/env node
'use strict';

// Deterministic, provider-free proof that fixture evidence means retained
// bytes, not a report-shaped object carrying self-declared hashes.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sourceManifest = require('../config/structured-allocation-evaluation-scored-v2.json');
const {
  CANONICAL_BUNDLE_ROOT, CANONICAL_REGISTRY_PATH, FIXTURE_CONCLUSION,
  FixtureEvidenceError, recordFixtureEvidenceBundle,
  resolveFixtureEvidenceForLiveManifest, sha256
} = require('./fixtures/evaluation-fixture-evidence');
const { hashCanonical } = require('./structured-allocation-evaluation-scorer');

let passed = 0;
function ok(value, message) {
  assert.equal(value, true, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-evidence-test-'));
  const manifestPath = path.join(root,
    'config/structured-allocation-evaluation-scored-v2.json');
  write(manifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`);
  const bundle = path.join(root, CANONICAL_BUNDLE_ROOT);
  fs.mkdirSync(path.join(bundle, 'trials'), { recursive: true });
  const header = {
    scoredRunVersion: 1,
    repositoryCommit: 'e'.repeat(40),
    protocolId: sourceManifest.protocolId,
    protocolVersion: sourceManifest.protocolVersion,
    manifestHash: sourceManifest.manifestHash,
    manifestFileHash: sha256(fs.readFileSync(manifestPath)),
    runnerVersion: 1,
    scorerVersion: 1,
    decisionRuleVersion: sourceManifest.decisionRuleVersion,
    evaluationProtocolVersion: sourceManifest.protocolVersion,
    mode: 'fixture',
    startedAt: '2026-01-01T00:00:00.000Z',
    assignedSetField: 'trials',
    expectedTrialCount: sourceManifest.trials.length,
    trialIds: sourceManifest.trials.map(trial =>
      `${String(trial.repetition).padStart(2, '0')}-` +
      `${String(trial.slot).padStart(3, '0')}-${trial.cellId.replace('/', '_')}-${trial.armId}`),
    environment: { nodeVersion: process.version, platform: `${process.platform}-${process.arch}` },
    outputRoot: CANONICAL_BUNDLE_ROOT,
    fixtureEvidenceVersion: 2,
    scoredManifestVersion: 2
  };
  header.runHeaderHash = hashCanonical(header);
  write(path.join(bundle, 'scored-run-header.json'), JSON.stringify(header, null, 2));

  const artifactHashes = [];
  const journal = [];
  sourceManifest.trials.forEach(trial => {
    const trialId = `${String(trial.repetition).padStart(2, '0')}-` +
      `${String(trial.slot).padStart(3, '0')}-${trial.cellId.replace('/', '_')}-${trial.armId}`;
    const artifact = {
      label: 'SCORED FIXTURE TRIAL — FROZEN PROTOCOL V1',
      trialId,
      manifestHash: sourceManifest.manifestHash,
      scoredRunHash: header.runHeaderHash,
      sourceCommit: header.repositoryCommit,
      mode: 'fixture'
    };
    artifact.artifactHash = crypto.createHash('sha256')
      .update(JSON.stringify(artifact)).digest('hex');
    artifactHashes.push(artifact.artifactHash);
    write(path.join(bundle, 'trials', `${trialId}.json`), JSON.stringify(artifact, null, 2));
    journal.push(JSON.stringify({ trialId, outcome: 'artifact_written' }));
  });
  write(path.join(bundle, 'scored-run-journal.jsonl'), `${journal.join('\n')}\n`);
  const corpusHash = hashCanonical(artifactHashes.sort());
  const report = {
    reportVersion: 1,
    fixtureEvidenceVersion: 2,
    scoredManifestVersion: 2,
    protocolId: sourceManifest.protocolId,
    protocolVersion: sourceManifest.protocolVersion,
    manifestHash: sourceManifest.manifestHash,
    repositoryCommit: header.repositoryCommit,
    scoredRunHash: header.runHeaderHash,
    corpusIntegrity: { corpusHash, trials: sourceManifest.trials.length },
    hardDisqualifiers: [],
    frozenDecision: { decision: FIXTURE_CONCLUSION }
  };
  report.reportHash = hashCanonical(report);
  write(path.join(bundle, 'structured-allocation-scored-fixture-report-v2.json'),
    `${JSON.stringify(report, null, 2)}\n`);
  write(path.join(bundle, 'structured-allocation-scored-fixture-report-v2.md'),
    '# Controlled fixture-v2 report\n');
  return root;
}

function manifestBinding(root) {
  const registryPath = path.join(root, CANONICAL_REGISTRY_PATH);
  const registryBytes = fs.readFileSync(registryPath);
  const registry = JSON.parse(registryBytes);
  return {
    mode: 'live',
    source: {
      fixtureManifestHash: registry.fixtureManifestHash,
      fixtureCorpusHash: registry.fixtureCorpusHash,
      fixtureReportHash: registry.fixtureReportHash,
      fixtureDecision: FIXTURE_CONCLUSION,
      fixtureEvidence: {
        version: 2,
        registryPath: CANONICAL_REGISTRY_PATH,
        registryHash: registry.registryHash,
        registryRawFileSha256: sha256(registryBytes),
        fixtureSourceCommit: registry.fixtureSourceCommit,
        runHeaderHash: registry.fixtureRunHeaderHash,
        corpusIndexHash: registry.fixtureCorpusIndexHash,
        manifestRawFileSha256: registry.files.manifest.rawFileSha256,
        runHeaderRawFileSha256: registry.files.runHeader.rawFileSha256,
        corpusIndexRawFileSha256: registry.files.corpusIndex.rawFileSha256,
        reportRawFileSha256: registry.files.reportJson.rawFileSha256,
        markdownRawFileSha256: registry.files.reportMarkdown.rawFileSha256
      }
    }
  };
}

function refuses(root, manifest, code) {
  try {
    resolveFixtureEvidenceForLiveManifest({ root, manifest });
    return false;
  } catch (error) {
    return error instanceof FixtureEvidenceError && error.code === code;
  }
}

function rewriteRegistry(root, edit) {
  const file = path.join(root, CANONICAL_REGISTRY_PATH);
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(registry);
  delete registry.registryHash;
  registry.registryHash = hashCanonical(registry);
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
  return manifestBinding(root);
}

function main() {
  console.log('evaluation fixture evidence');
  const roots = [];
  const make = () => {
    const root = fixtureRoot();
    roots.push(root);
    recordFixtureEvidenceBundle({ root });
    return root;
  };
  try {
    const complete = make();
    const binding = manifestBinding(complete);
    const resolved = resolveFixtureEvidenceForLiveManifest({
      root: complete, manifest: binding
    });
    ok(resolved.fixtureEvidenceVersion === 2 &&
       resolved.report.frozenDecision.decision === FIXTURE_CONCLUSION &&
       resolved.conclusion === FIXTURE_CONCLUSION,
    'the resolver parses and validates the actual retained fixture-v2 report bytes');
    ok(resolved.registry.trialCount === sourceManifest.trials.length &&
       resolved.fixtureCorpusHash === resolved.report.corpusIntegrity.corpusHash,
    'the complete retained trial corpus closes the report provenance chain');

    const missingRegistry = make();
    const missingRegistryManifest = manifestBinding(missingRegistry);
    fs.unlinkSync(path.join(missingRegistry, CANONICAL_REGISTRY_PATH));
    ok(refuses(missingRegistry, missingRegistryManifest,
      'FIXTURE_EVIDENCE_FILE_MISSING'),
    'an absent repository-owned fixture registry refuses');

    const changedRegistry = make();
    const changedRegistryManifest = manifestBinding(changedRegistry);
    fs.appendFileSync(path.join(changedRegistry, CANONICAL_REGISTRY_PATH), ' ');
    ok(refuses(changedRegistry, changedRegistryManifest,
      'FIXTURE_EVIDENCE_REGISTRY_RAW_HASH_DRIFT'),
    'a one-byte fixture registry mutation refuses at manifest-bound raw authority');

    const missing = make();
    fs.unlinkSync(path.join(missing, CANONICAL_BUNDLE_ROOT,
      'structured-allocation-scored-fixture-report-v2.json'));
    ok(refuses(missing, manifestBinding(missing), 'FIXTURE_EVIDENCE_FILE_MISSING'),
      'an absent durable fixture report refuses');

    const changed = make();
    fs.appendFileSync(path.join(changed, CANONICAL_BUNDLE_ROOT,
      'structured-allocation-scored-fixture-report-v2.json'), ' ');
    ok(refuses(changed, manifestBinding(changed), 'FIXTURE_EVIDENCE_RAW_HASH_DRIFT'),
      'a one-byte fixture report mutation refuses at raw-file authority');

    const reportRawIdentity = make();
    const reportRawIdentityManifest = rewriteRegistry(reportRawIdentity, registry => {
      registry.files.reportJson.rawFileSha256 = 'b'.repeat(64);
    });
    ok(refuses(reportRawIdentity, reportRawIdentityManifest,
      'FIXTURE_EVIDENCE_RAW_HASH_DRIFT'),
    'a mutated report raw-file SHA refuses against actual report bytes');

    const reportIdentity = make();
    const reportIdentityManifest = rewriteRegistry(reportIdentity, registry => {
      registry.fixtureReportHash = 'f'.repeat(64);
    });
    ok(refuses(reportIdentity, reportIdentityManifest,
      'FIXTURE_EVIDENCE_REGISTRY_IDENTITY_DRIFT'),
    'a mutated canonical report hash refuses against actual report bytes');

    const corpusIdentity = make();
    const corpusIdentityManifest = rewriteRegistry(corpusIdentity, registry => {
      registry.fixtureCorpusHash = 'c'.repeat(64);
    });
    ok(refuses(corpusIdentity, corpusIdentityManifest,
      'FIXTURE_EVIDENCE_REGISTRY_IDENTITY_DRIFT'),
    'a mutated fixture corpus hash refuses against the retained index');

    const manifestIdentity = make();
    const manifestIdentityManifest = rewriteRegistry(manifestIdentity, registry => {
      registry.fixtureManifestHash = 'a'.repeat(64);
    });
    ok(refuses(manifestIdentity, manifestIdentityManifest,
      'FIXTURE_EVIDENCE_REGISTRY_IDENTITY_DRIFT'),
    'a mutated fixture manifest hash refuses against the retained manifest');

    const sourceIdentity = make();
    const sourceIdentityManifest = rewriteRegistry(sourceIdentity, registry => {
      registry.fixtureSourceCommit = 'd'.repeat(40);
    });
    ok(refuses(sourceIdentity, sourceIdentityManifest,
      'FIXTURE_EVIDENCE_RUN_HEADER_DRIFT'),
    'a mutated fixture source binding refuses against the retained run header');

    const wrongVersion = make();
    const wrongVersionManifest = manifestBinding(wrongVersion);
    wrongVersionManifest.source.fixtureEvidence.version = 1;
    ok(refuses(wrongVersion, wrongVersionManifest,
      'FIXTURE_EVIDENCE_LIVE_BINDING_MISSING'),
    'a live manifest pointing at fixture-v1 cannot enter the fixture-v2 resolver');

    const lookalike = {
      mode: 'live', source: {
        fixtureManifestHash: resolved.fixtureManifestHash,
        fixtureCorpusHash: resolved.fixtureCorpusHash,
        fixtureReportHash: resolved.fixtureReportHash,
        fixtureDecision: FIXTURE_CONCLUSION
      }
    };
    ok(refuses(complete, lookalike, 'FIXTURE_EVIDENCE_LIVE_BINDING_MISSING'),
      'a look-alike in-memory capsule with correct top-level hashes is not provenance');

    const conclusion = make();
    const conclusionManifest = rewriteRegistry(conclusion, registry => {
      registry.conclusion = 'FIXTURE EVIDENCE SUPPORTS RETAIN';
    });
    ok(refuses(conclusion, conclusionManifest,
      'FIXTURE_EVIDENCE_REGISTRY_UNSUPPORTED'),
    'conclusion metadata cannot disagree with the retained STOP report');

    const artifactMutation = make();
    const registry = JSON.parse(fs.readFileSync(
      path.join(artifactMutation, CANONICAL_REGISTRY_PATH), 'utf8'));
    // Mutate the first retained artifact at its real indexed path.
    const index = JSON.parse(fs.readFileSync(path.join(artifactMutation,
      registry.files.corpusIndex.path), 'utf8'));
    fs.appendFileSync(path.join(artifactMutation, index.artifacts[0].path), ' ');
    ok(refuses(artifactMutation, manifestBinding(artifactMutation),
      'FIXTURE_EVIDENCE_RAW_HASH_DRIFT'),
    'retained evidence bytes cannot drift while registry metadata stays unchanged');

    ok(!JSON.stringify(resolved.registry).includes('apiKey') &&
       !JSON.stringify(resolved.registry).includes('credential'),
    'the fixture registry carries no credential material');
    console.log(`\nevaluation fixture evidence test passed — ${passed} assertions; provider calls 0`);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
