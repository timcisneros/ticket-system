#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  PROCESS_EXECUTION_RELEASE_MANIFEST_VERSION,
  buildProcessExecutionReleaseContract,
  canonicalJson,
  hashReleaseValue
} = require('../runtime/process-execution-release-contract');
const {
  REQUIRED_TESTS
} = require('./test-manifest');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_PATTERN = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const RELEASE_MANIFEST_KEYS = Object.freeze([
  'version',
  'applicationVersion',
  'sourceRevision',
  'cleanWorktree',
  'releaseContract',
  'releaseContractHash',
  'databaseMigrationHead',
  'databaseMigrationChecksums',
  'nodeLockfileSha256',
  'nativeCargoLockfileSha256',
  'nativeBinaries',
  'deploymentUnitSha256',
  'targetCatalog',
  'rootfsRegistry',
  'requiredTestInventory',
  'releaseCheckpointResultReference',
  'generatedAt',
  'manifestHash'
]);

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `RELEASE_MANIFEST_GIT_UNAVAILABLE: ${
        result.error ? result.error.message : result.stderr.trim()
      }`
    );
  }
  return result.stdout.trim();
}

function trackedClean(root) {
  return git(root, ['status', '--porcelain=v1']) === '';
}

function migrationIdentity(root) {
  const directory = path.join(root, 'persistence', 'postgres', 'migrations');
  const files = fs.readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .sort();
  if (files.length === 0 ||
      files.some(name => !MIGRATION_PATTERN.test(name)) ||
      new Set(files.map(name => name.slice(0, 3))).size !== files.length) {
    throw new Error(
      'RELEASE_MANIFEST_MIGRATION_HEAD_INVALID: migration identity is ambiguous'
    );
  }
  return {
    head: files[files.length - 1],
    checksums: Object.fromEntries(files.map(name => [
      name,
      sha256File(path.join(directory, name))
    ]))
  };
}

function hashFiles(root, relativeFiles) {
  return Object.fromEntries([...relativeFiles].sort().map(file => {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`RELEASE_MANIFEST_INPUT_MISSING: ${file}`);
    }
    return [file, sha256File(absolute)];
  }));
}

function buildNativeBinaries(root) {
  for (const manifest of [
    'native/process-launcher/Cargo.toml',
    'native/process-materializer/Cargo.toml'
  ]) {
    const result = spawnSync('cargo', [
      'build',
      '--locked',
      '--release',
      '--manifest-path',
      manifest
    ], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `RELEASE_MANIFEST_NATIVE_BUILD_FAILED: ${manifest}: ${
          result.error ? result.error.message : result.stderr.trim()
        }`
      );
    }
  }
  const binaries = {
    'ticket-system-process-launcher-foundation':
      'native/process-launcher/target/release/' +
      'ticket-system-process-launcher-foundation',
    'ticket-system-process-materializer':
      'native/process-materializer/target/release/' +
      'ticket-system-process-materializer'
  };
  return Object.fromEntries(Object.entries(binaries).map(([name, relative]) => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) ||
        !fs.statSync(absolute).isFile() ||
        (fs.statSync(absolute).mode & 0o111) === 0) {
      throw new Error(`RELEASE_MANIFEST_NATIVE_BINARY_MISSING: ${name}`);
    }
    return [name, {
      sha256: sha256File(absolute),
      sourceLockSha256: sha256File(path.join(
        root,
        name.includes('launcher')
          ? 'native/process-launcher/Cargo.lock'
          : 'native/process-materializer/Cargo.lock'
      ))
    }];
  }));
}

function buildReleaseManifest({
  root = ROOT,
  sourceRevision,
  checkpointReference,
  generatedAt = new Date().toISOString(),
  requireClean = true,
  buildNative = true
} = {}) {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(root, 'package.json'),
    'utf8'
  ));
  const revision = sourceRevision || git(root, ['rev-parse', 'HEAD']);
  const clean = trackedClean(root);
  if (requireClean && !clean) {
    throw new Error(
      'RELEASE_MANIFEST_DIRTY_WORKTREE: release manifests require committed source'
    );
  }
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('RELEASE_MANIFEST_SOURCE_REVISION_INVALID');
  }
  if (typeof checkpointReference !== 'string' ||
      !/^[a-z0-9][a-z0-9:._-]{0,255}$/.test(checkpointReference)) {
    throw new Error('RELEASE_MANIFEST_CHECKPOINT_REFERENCE_REQUIRED');
  }
  if (!Number.isFinite(Date.parse(generatedAt)) ||
      new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error('RELEASE_MANIFEST_TIMESTAMP_INVALID');
  }
  const migration = migrationIdentity(root);
  const releaseContract = buildProcessExecutionReleaseContract({
    applicationVersion: packageJson.version,
    sourceRevision: revision
  });
  const deploymentUnits = [
    'deployment/systemd/ticket-system-process-launcher-foundation.service',
    'deployment/systemd/ticket-system-process-launcher-foundation.tmpfiles',
    'deployment/systemd/ticket-system-process-materializer.service',
    'deployment/systemd/ticket-system-process-materializer.tmpfiles',
    'deployment/systemd/ticket-system.service',
    'deployment/systemd/ticket-system.tmpfiles'
  ];
  const targetCatalogBytes = fs.readFileSync(
    path.join(root, 'config', 'process-targets.json')
  );
  const rootfsConfigurationBytes = fs.readFileSync(
    path.join(root, 'config', 'process-launcher-foundation.example.json')
  );
  const requiredTestInventory = {
    count: REQUIRED_TESTS.length,
    sha256: hashReleaseValue([...REQUIRED_TESTS].sort())
  };
  const authority = {
    version: PROCESS_EXECUTION_RELEASE_MANIFEST_VERSION,
    applicationVersion: packageJson.version,
    sourceRevision: revision,
    cleanWorktree: clean,
    releaseContract,
    releaseContractHash: releaseContract.releaseContractHash,
    databaseMigrationHead: migration.head,
    databaseMigrationChecksums: migration.checksums,
    nodeLockfileSha256: sha256File(path.join(root, 'pnpm-lock.yaml')),
    nativeCargoLockfileSha256: hashFiles(root, [
      'native/process-launcher/Cargo.lock',
      'native/process-materializer/Cargo.lock'
    ]),
    nativeBinaries: buildNative ? buildNativeBinaries(root) : {},
    deploymentUnitSha256: hashFiles(root, deploymentUnits),
    targetCatalog: {
      schemaVersion: releaseContract.processTargetCatalogSchemaVersion,
      generation: `process-target-catalog-v${
        releaseContract.processTargetCatalogSchemaVersion
      }-${sha256Bytes(targetCatalogBytes)}`
    },
    rootfsRegistry: {
      schemaVersion: releaseContract.rootfsRegistrySchemaVersion,
      releaseGeneration: `rootfs-registry-release-v${
        releaseContract.rootfsRegistrySchemaVersion
      }-${sha256Bytes(rootfsConfigurationBytes)}`
    },
    requiredTestInventory,
    releaseCheckpointResultReference: checkpointReference,
    generatedAt
  };
  return Object.freeze({
    ...authority,
    manifestHash: hashReleaseValue(authority)
  });
}

function validateReleaseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RELEASE_MANIFEST_INVALID');
  }
  const actual = Object.keys(value).sort();
  const expected = [...RELEASE_MANIFEST_KEYS].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new Error('RELEASE_MANIFEST_INVALID: schema is not closed');
  }
  const withoutHash = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'manifestHash')
  );
  if (value.manifestHash !== hashReleaseValue(withoutHash)) {
    throw new Error('RELEASE_MANIFEST_INVALID: manifest hash mismatch');
  }
  return value;
}

function parseArguments(argv) {
  const options = {
    output: null,
    checkpointReference:
      process.env.PROCESS_RELEASE_CHECKPOINT_REFERENCE || null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') {
      options.output = argv[++index];
    } else if (argument === '--checkpoint-reference') {
      options.checkpointReference = argv[++index];
    } else {
      throw new Error(`Unknown release manifest argument: ${argument}`);
    }
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = buildReleaseManifest({
    checkpointReference: options.checkpointReference
  });
  validateReleaseManifest(manifest);
  const output = `${canonicalJson(manifest)}\n`;
  if (options.output) {
    const resolved = path.resolve(options.output);
    if (resolved.startsWith(`${ROOT}${path.sep}`)) {
      throw new Error(
        'RELEASE_MANIFEST_OUTPUT_INVALID: generated release evidence must not dirty source'
      );
    }
    fs.writeFileSync(resolved, output, { mode: 0o600, flag: 'wx' });
  } else {
    process.stdout.write(output);
  }
}

module.exports = {
  RELEASE_MANIFEST_KEYS,
  buildReleaseManifest,
  migrationIdentity,
  validateReleaseManifest
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
