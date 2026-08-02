#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildReleaseManifest,
  validateReleaseManifest
} = require('./release-manifest');

const root = path.resolve(__dirname, '..');
const revision = 'a'.repeat(40);
const manifest = buildReleaseManifest({
  root,
  sourceRevision: revision,
  checkpointReference: 'test:checkpoint-passed',
  generatedAt: '2026-07-29T00:00:00.000Z',
  requireClean: false,
  buildNative: false
});
assert.equal(manifest.sourceRevision, revision);
assert.equal(manifest.databaseMigrationHead,
  '037_governed_evidence_baseline.sql');
assert.equal(manifest.releaseContract.sourceRevision, revision);
assert.equal(validateReleaseManifest(manifest), manifest);
assert.equal(JSON.stringify(manifest).includes('/home/'), false);
assert.equal(JSON.stringify(manifest).includes('DATABASE_URL'), false);
assert.throws(() => validateReleaseManifest({
  ...manifest,
  privatePath: '/tmp/private'
}), /schema is not closed/);

const dirtyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-manifest-dirty-'));
try {
  fs.copyFileSync(
    path.join(root, 'package.json'),
    path.join(dirtyRoot, 'package.json')
  );
  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: dirtyRoot,
    encoding: 'utf8'
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.throws(() => buildReleaseManifest({
    root: dirtyRoot,
    sourceRevision: revision,
    checkpointReference: 'test:dirty',
    generatedAt: '2026-07-29T00:00:00.000Z',
    requireClean: true,
    buildNative: false
  }), /DIRTY_WORKTREE/, 'release generation refuses uncommitted source');
} finally {
  fs.rmSync(dirtyRoot, { recursive: true, force: true });
}

console.log('PASS: deterministic release manifest contract');
