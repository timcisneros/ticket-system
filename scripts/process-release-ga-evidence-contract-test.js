#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const backup = read('scripts/process-release-backup-restore-test.js');
assert.match(backup, /runPostgresTool\('pg_dump'/);
assert.match(backup, /--format=custom/);
assert.match(backup, /runPostgresTool\('pg_restore'/);
assert.match(backup, /new PostgresRuntimeStore\(\{\s*connectionString: databaseUrl,\s*schema: restoredSchema/s);
assert.match(backup, /restoredArtifacts\.verifyPublished/);
assert.doesNotMatch(backup, /seedSource\(restoredStore/);
assert.doesNotMatch(backup, /Buffer\.from\(JSON\.stringify\(await authority/);
assert.match(backup, /PROCESS_RELEASE_BACKUP_TOOL_UNAVAILABLE/);

const soak = read('scripts/process-execution-release-soak-test.js');
assert.match(soak, /new PostgresRuntimeStore/);
assert.match(soak, /new ProcessExecutionController/);
assert.match(soak, /acquireRuntimeCapacity/);
assert.match(soak, /compactEligibleLauncherOperations/);
assert.match(soak, /nativeLauncherLaunchCount: nativeLaunchCount/);
assert.match(soak, /activeDescendantCount: finalMetrics\.activeDescendants/);
assert.match(soak, /temporaryArtifactFileCount: files\.temporary/);
assert.doesNotMatch(soak, /duplicateLaunches:\s*0/);
assert.doesNotMatch(soak, /leakedTemporaryArtifacts:\s*0/);
assert.doesNotMatch(soak, /unboundedRegistryGrowth:\s*false/);
assert.doesNotMatch(soak, /spawnSync\(process\.execPath/);

const registry = read('native/process-launcher/src/operation_registry.rs');
assert.match(registry, /fn open_with_limits\(/);
assert.match(
  registry,
  /fn compaction_releases_full_record_capacity_without_releasing_identity\(\)/
);
assert.match(registry, /PROCESS_LAUNCHER_REGISTRY_FULL/);
assert.match(registry, /compaction must release one full-record admission slot/);
assert.match(registry, /compact tombstones retain a separately enforced hard capacity/);

console.log('PASS: Tranche 8 GA evidence uses real archive, measured soak, and capacity proof');
