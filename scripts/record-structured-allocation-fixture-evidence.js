#!/usr/bin/env node
'use strict';

// One-shot fixture-v2 retention owner. The canonical fixture runner and report
// command write the actual corpus/report first; this command indexes those
// bytes, copies the exact manifest into the bundle, writes the immutable
// registry, and immediately re-opens every retained artifact through the
// production validator. It never constructs scoring evidence itself.

const {
  recordFixtureEvidenceBundle
} = require('./fixtures/evaluation-fixture-evidence');

function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) {
    throw new Error('record-structured-allocation-fixture-evidence accepts no arguments');
  }
  const recorded = recordFixtureEvidenceBundle();
  console.log('fixture-v2 evidence retained and independently validated');
  console.log(`fixture source: ${recorded.fixtureSourceCommit}`);
  console.log(`fixture manifest: ${recorded.fixtureManifestHash}`);
  console.log(`fixture run header: ${recorded.fixtureRunHeaderHash}`);
  console.log(`fixture corpus: ${recorded.fixtureCorpusHash}`);
  console.log(`fixture report: ${recorded.fixtureReportHash}`);
  console.log(`fixture conclusion: ${recorded.conclusion}`);
}

module.exports = { main };

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`${error.code || error.name}: ${error.message}`);
    process.exit(1);
  }
}
