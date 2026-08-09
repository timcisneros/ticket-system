'use strict';

// Tranche 6 live-v3 authority.
//
// V3 preserves live-v2's decision-evaluable 40-cell topology, provider
// controls, economics and decision contract. Its only experimental-authority
// change is that fixture evidence is no longer a trio of historical hash
// assertions: it binds the complete repository-owned fixture-v2 registry and
// the raw scored-report bytes that registry validates.

const historicalV1 = require('../../config/structured-allocation-evaluation-live-v1.json');
const historicalV2 = require('../../config/structured-allocation-evaluation-live-v2.json');
const {
  FIXTURE_CONCLUSION, SUPPORTED_FIXTURE_EVIDENCE_VERSION,
  validateRegistryIdentity
} = require('./evaluation-fixture-evidence');
const {
  LiveManifestError, hashCanonical
} = require('./evaluation-live-manifest');
const { buildLiveManifestV2 } = require('./evaluation-live-manifest-v2');

const LIVE_MANIFEST_VERSION = 3;
const LIVE_V3_ARTIFACT_ROOT_RECIPE =
  '/tmp/ticket-system-structured-evaluation-live-v3/real-<commit>-<run-header-prefix>';

function buildLiveManifestV3({
  fixtureEvidenceRegistry,
  registryRawFileSha256,
  artifactRootRecipe = LIVE_V3_ARTIFACT_ROOT_RECIPE
}) {
  const rebuiltV2 = buildLiveManifestV2({
    fixtureCorpusHash: historicalV2.source.fixtureCorpusHash,
    fixtureReportHash: historicalV2.source.fixtureReportHash,
    artifactRootRecipe: historicalV2.artifactRootRecipe
  });
  if (rebuiltV2.manifestHash !== historicalV2.manifestHash) {
    throw new LiveManifestError(
      'historical live-v2 no longer reproduces; refusing to derive live-v3');
  }
  const registryHash = validateRegistryIdentity(fixtureEvidenceRegistry);
  if (fixtureEvidenceRegistry.fixtureEvidenceVersion !==
      SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      fixtureEvidenceRegistry.conclusion !== FIXTURE_CONCLUSION ||
      typeof registryRawFileSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(registryRawFileSha256)) {
    throw new LiveManifestError('fixture-v2 registry is not valid live-v3 authority');
  }
  const files = fixtureEvidenceRegistry.files || {};
  for (const name of ['manifest', 'runHeader', 'journal', 'corpusIndex',
    'reportJson', 'reportMarkdown']) {
    if (!files[name] || typeof files[name].path !== 'string' ||
        typeof files[name].rawFileSha256 !== 'string') {
      throw new LiveManifestError(`fixture-v2 registry lacks retained ${name} bytes`);
    }
  }

  const manifest = {
    ...rebuiltV2,
    liveManifestVersion: LIVE_MANIFEST_VERSION,
    source: {
      ...rebuiltV2.source,
      fixtureManifestHash: fixtureEvidenceRegistry.fixtureManifestHash,
      fixtureCorpusHash: fixtureEvidenceRegistry.fixtureCorpusHash,
      fixtureReportHash: fixtureEvidenceRegistry.fixtureReportHash,
      fixtureDecision: fixtureEvidenceRegistry.conclusion,
      fixtureEvidence: {
        version: fixtureEvidenceRegistry.fixtureEvidenceVersion,
        registryPath:
          'config/structured-allocation-evaluation-fixture-evidence-v2.json',
        registryHash,
        registryRawFileSha256,
        fixtureSourceCommit: fixtureEvidenceRegistry.fixtureSourceCommit,
        runHeaderHash: fixtureEvidenceRegistry.fixtureRunHeaderHash,
        corpusIndexHash: fixtureEvidenceRegistry.fixtureCorpusIndexHash,
        manifestRawFileSha256: files.manifest.rawFileSha256,
        runHeaderRawFileSha256: files.runHeader.rawFileSha256,
        corpusIndexRawFileSha256: files.corpusIndex.rawFileSha256,
        reportRawFileSha256: files.reportJson.rawFileSha256,
        markdownRawFileSha256: files.reportMarkdown.rawFileSha256,
        conclusion: fixtureEvidenceRegistry.conclusion
      },
      derivation: rebuiltV2.source.derivation + '; fixture decision input is ' +
        'the complete repository-owned fixture-v2 evidence bundle'
    },
    historicalLiveManifests: [
      {
        liveManifestVersion: 1,
        manifestHash: historicalV1.manifestHash,
        status: 'historical execution authority; unchanged'
      },
      {
        liveManifestVersion: 2,
        manifestHash: historicalV2.manifestHash,
        status: 'historical execution authority; unchanged; real run remains aborted'
      }
    ],
    artifactRootRecipe
  };
  // V2's singular historical field points only to v1. V3 owns the explicit
  // complete list above and does not mutate either predecessor.
  delete manifest.historicalLiveManifest;
  delete manifest.manifestHash;
  manifest.manifestHash = hashCanonical(manifest);
  return Object.freeze(manifest);
}

module.exports = {
  LIVE_MANIFEST_VERSION,
  LIVE_V3_ARTIFACT_ROOT_RECIPE,
  buildLiveManifestV3
};
