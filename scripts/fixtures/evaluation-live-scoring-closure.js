'use strict';

// Cheap, provider-free opening gate for every future REAL live execution.
// It proves the immutable input half of the post-corpus production command is
// already closed before authenticated preflight can run. The full 120-slot
// production-command rehearsal remains a canonical release test; this gate
// re-opens its load-bearing fixture authority on every operational start.

const {
  resolveFixtureEvidenceForLiveManifest
} = require('./evaluation-fixture-evidence');

class LiveScoringClosureError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveScoringClosureError';
    this.code = detail.code || 'LIVE_SCORING_CLOSURE_UNAVAILABLE';
    this.detail = detail;
  }
}

function assertLiveScoringClosureReady({ manifest, repositoryRoot }) {
  if (!manifest || manifest.mode !== 'live' || manifest.liveManifestVersion !== 3) {
    throw new LiveScoringClosureError(
      'REAL live execution requires live-v3 with durable fixture-v2 provenance',
      { code: 'LIVE_SCORING_CLOSURE_MANIFEST_UNSUPPORTED' });
  }
  let fixtureEvidence;
  try {
    fixtureEvidence = resolveFixtureEvidenceForLiveManifest({
      manifest,
      ...(repositoryRoot === undefined ? {} : { root: repositoryRoot })
    });
  } catch (error) {
    throw new LiveScoringClosureError(
      `REAL live scoring closure is unavailable: ${error.message}`,
      { code: 'LIVE_SCORING_CLOSURE_FIXTURE_PROVENANCE_MISSING',
        causeCode: error.code || null });
  }
  // Load the same owner the post-corpus command invokes. An in-memory scorer
  // helper is deliberately insufficient: only this module resolves fixture
  // bytes and writes immutable live JSON/Markdown/hashes.
  // eslint-disable-next-line global-require
  const productionOwner = require('../structured-allocation-evaluation-report-live');
  if (typeof productionOwner.buildLiveReportFromRoot !== 'function' ||
      typeof productionOwner.renderLiveMarkdown !== 'function' ||
      typeof productionOwner.writeImmutable !== 'function') {
    throw new LiveScoringClosureError('production live report owner is incomplete',
      { code: 'LIVE_SCORING_CLOSURE_REPORT_OWNER_MISSING' });
  }
  return Object.freeze({
    ready: true,
    liveManifestVersion: manifest.liveManifestVersion,
    liveManifestHash: manifest.manifestHash,
    fixtureEvidenceVersion: fixtureEvidence.fixtureEvidenceVersion,
    fixtureRegistryHash: fixtureEvidence.registryHash,
    fixtureReportHash: fixtureEvidence.fixtureReportHash,
    fixtureReportRawFileSha256: fixtureEvidence.fixtureReportRawFileSha256,
    fixtureConclusion: fixtureEvidence.conclusion,
    productionReportOwner: 'scripts/structured-allocation-evaluation-report-live.js'
  });
}

module.exports = {
  LiveScoringClosureError,
  assertLiveScoringClosureReady
};
