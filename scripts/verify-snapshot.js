#!/usr/bin/env node
// Verify Snapshot — integrity verification for operational state snapshots.
//
// Usage:
//   node scripts/verify-snapshot.js --snapshot <snapshot.json> [--strict]
//
// Verifies:
//   - snapshot manifest hash matches contents
//   - projection hashes match recomputed canonical hashes
//   - metadata is consistent with projections
//   - lineage is intact
//
// With --strict, exits non-zero on any issue.

const fs = require('fs');
const path = require('path');
const { canonicalJson, computeCanonicalHash } = require('./projection-rebuilder');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function main() {
  const args = process.argv.slice(2);
  let snapshotPath = null;
  let strictMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--snapshot' && args[i + 1]) { snapshotPath = args[i + 1]; i++; }
    else if (args[i] === '--strict') { strictMode = true; }
  }

  if (!snapshotPath) {
    console.error('Usage: node scripts/verify-snapshot.js --snapshot <snapshot.json> [--strict]');
    process.exit(1);
  }
  if (!fs.existsSync(snapshotPath)) {
    console.error(`Snapshot not found: ${snapshotPath}`);
    process.exit(1);
  }

  const snapshot = readJson(snapshotPath);
  if (!snapshot) {
    console.error(`Snapshot unparseable: ${snapshotPath}`);
    process.exit(1);
  }

  const report = {
    snapshotPath,
    version: snapshot.version || 'unknown',
    valid: true,
    checks: {},
    errors: []
  };

  // Check 1: Manifest hash
  const storedManifest = snapshot.manifest;
  if (!storedManifest || !storedManifest.canonicalHash) {
    report.errors.push({ check: 'manifest', message: 'Missing manifest.canonicalHash' });
    report.valid = false;
  } else {
    // Recompute hash from deterministic content (same as create-snapshot)
    const deterministicContent = {
      version: snapshot.version,
      metadata: snapshot.metadata,
      projections: snapshot.projections
    };
    const recomputedHash = computeCanonicalHash(deterministicContent);
    report.checks.manifestHash = {
      stored: storedManifest.canonicalHash,
      recomputed: recomputedHash,
      match: storedManifest.canonicalHash === recomputedHash
    };
    if (!report.checks.manifestHash.match) {
      report.errors.push({
        check: 'manifest',
        message: `Manifest hash mismatch: stored=${storedManifest.canonicalHash}, recomputed=${recomputedHash}`
      });
      report.valid = false;
    }
  }

  // Check 2: Projection hashes
  const meta = snapshot.metadata || {};
  const proj = snapshot.projections || {};

  if (meta.projectionHashes) {
    const runsHash = computeCanonicalHash(proj.runs || []);
    const ticketsHash = computeCanonicalHash(proj.tickets || []);
    const operationsHash = computeCanonicalHash(proj.operationHistory || []);

    report.checks.projections = {
      runs: { stored: meta.projectionHashes.runs, recomputed: runsHash, match: meta.projectionHashes.runs === runsHash },
      tickets: { stored: meta.projectionHashes.tickets, recomputed: ticketsHash, match: meta.projectionHashes.tickets === ticketsHash },
      operations: { stored: meta.projectionHashes.operations, recomputed: operationsHash, match: meta.projectionHashes.operations === operationsHash }
    };

    for (const [name, check] of Object.entries(report.checks.projections)) {
      if (!check.match) {
        report.errors.push({
          check: `projection.${name}`,
          message: `Projection hash mismatch for ${name}: stored=${check.stored}, recomputed=${check.recomputed}`
        });
        report.valid = false;
      }
    }
  }

  // Check 3: Consistency
  const expectedRunCount = (proj.runs || []).length;
  const actualRunCount = Object.keys(meta.lastSeqPerRun || {}).length;
  report.checks.consistency = {
    runCountMatch: expectedRunCount === actualRunCount,
    eventCount: meta.eventCount,
    runCount: expectedRunCount
  };
  if (!report.checks.consistency.runCountMatch) {
    report.errors.push({
      check: 'consistency',
      message: `Run count mismatch: projections=${expectedRunCount}, metadata=${actualRunCount}`
    });
    report.valid = false;
  }

  // Check 4: Lineage (createdAt in reasonable range)
  const createdAt = new Date(snapshot.createdAt || 0);
  const now = new Date();
  report.checks.lineage = {
    createdAt: snapshot.createdAt,
    future: createdAt > now
  };
  if (report.checks.lineage.future) {
    report.errors.push({ check: 'lineage', message: 'Snapshot createdAt is in the future' });
    report.valid = false;
  }

  console.log(JSON.stringify(report, null, 2));

  if (strictMode && !report.valid) {
    process.exit(1);
  }
}

main();
