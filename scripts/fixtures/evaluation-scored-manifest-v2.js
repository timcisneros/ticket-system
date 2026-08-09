'use strict';

// Tranche 6 fixture-evidence v2 execution authority.
//
// Historical fixture-v1 is immutable and remains the authority for its old
// run. V2 deliberately keeps the same protocol, scenario assignments, arms,
// response fixtures, repetitions, ordering, metrics and decision rules. It
// changes only evidence ownership: its generated corpus is retained under a
// repository-owned, versioned bundle instead of relying on /tmp history.

const historicalV1 = require('../../config/structured-allocation-evaluation-scored-v1.json');
const {
  ScoredManifestError, buildScoredManifest, hashCanonical
} = require('./evaluation-scored-manifest');

const FIXTURE_EVIDENCE_VERSION = 2;
const SCORED_MANIFEST_VERSION = 2;
const FIXTURE_V2_ARTIFACT_ROOT =
  'evidence/structured-allocation-evaluation/fixture-v2';

function buildScoredManifestV2({
  artifactRoot = FIXTURE_V2_ARTIFACT_ROOT
} = {}) {
  const rebuiltHistorical = buildScoredManifest({
    protocolSeed: historicalV1.protocolSeed,
    artifactRoot: historicalV1.artifactRoot
  });
  if (rebuiltHistorical.manifestHash !== historicalV1.manifestHash) {
    throw new ScoredManifestError(
      'historical fixture-v1 manifest no longer reproduces; refusing fixture-v2');
  }

  const base = buildScoredManifest({
    protocolSeed: historicalV1.protocolSeed,
    artifactRoot
  });
  const manifest = {
    ...base,
    manifestVersion: SCORED_MANIFEST_VERSION,
    fixtureEvidenceVersion: FIXTURE_EVIDENCE_VERSION,
    historicalFixtureManifest: {
      manifestVersion: historicalV1.manifestVersion,
      manifestHash: historicalV1.manifestHash,
      status: 'historical authority; bytes and identities remain unchanged'
    },
    evidenceOwnership: {
      kind: 'repository_owned_versioned_bundle',
      bundleRoot: 'evidence/structured-allocation-evaluation/fixture-v2',
      registryPath:
        'config/structured-allocation-evaluation-fixture-evidence-v2.json',
      rule: 'the actual run header, complete trial corpus, journal and scored ' +
        'report bytes are retained; registry identities never substitute for evidence'
    }
  };
  delete manifest.manifestHash;
  manifest.manifestHash = hashCanonical(manifest);
  return Object.freeze(manifest);
}

module.exports = {
  FIXTURE_EVIDENCE_VERSION,
  FIXTURE_V2_ARTIFACT_ROOT,
  SCORED_MANIFEST_VERSION,
  buildScoredManifestV2
};
