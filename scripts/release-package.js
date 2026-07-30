#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ALLOWED_ROOTS = Object.freeze([
  'config/',
  'deployment/',
  'docs/',
  'persistence/',
  'runtime/',
  'scripts/',
  'src/',
  'views/'
]);
const ALLOWED_FILES = new Set([
  'CONTRIBUTING.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'pnpm-lock.yaml',
  'server.js'
]);

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `RELEASE_PACKAGE_COMMAND_FAILED: ${command}: ${
        result.error ? result.error.message : result.stderr.trim()
      }`
    );
  }
  return result.stdout.trim();
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function packageInventory(root = ROOT) {
  const tracked = run('git', ['ls-files', '-z'], root).split('\0').filter(Boolean);
  return tracked.filter(file =>
    ALLOWED_FILES.has(file) || ALLOWED_ROOTS.some(prefix => file.startsWith(prefix))
  ).filter(file =>
    !file.endsWith('-test.js') &&
    !file.includes('/fixtures/') &&
    !file.startsWith('docs/archive/')
  ).sort();
}

function buildReleasePackage({
  root = ROOT,
  outputDirectory,
  requireClean = true
} = {}) {
  if (requireClean && run('git', ['status', '--porcelain=v1'], root) !== '') {
    throw new Error('RELEASE_PACKAGE_DIRTY_WORKTREE');
  }
  const revision = run('git', ['rev-parse', 'HEAD'], root);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error('RELEASE_PACKAGE_SOURCE_REVISION_INVALID');
  }
  const destination = path.resolve(outputDirectory || fs.mkdtempSync(
    path.join(os.tmpdir(), 'ticket-system-release-output-')
  ));
  if (destination.startsWith(`${root}${path.sep}`)) {
    throw new Error('RELEASE_PACKAGE_OUTPUT_MUST_BE_OUTSIDE_SOURCE');
  }
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-system-package-stage-'));
  const packageRoot = path.join(stage, 'ticket-system');
  fs.mkdirSync(packageRoot, { mode: 0o700 });
  const inventory = packageInventory(root);
  for (const relative of inventory) {
    const source = path.join(root, relative);
    const target = path.join(packageRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(source, target);
  }
  const binaries = [
    [
      'native/process-launcher/target/release/ticket-system-process-launcher-foundation',
      'libexec/ticket-system-process-launcher-foundation'
    ],
    [
      'native/process-materializer/target/release/ticket-system-process-materializer',
      'libexec/ticket-system-process-materializer'
    ]
  ];
  for (const [sourceRelative, targetRelative] of binaries) {
    const source = path.join(root, sourceRelative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw new Error(`RELEASE_PACKAGE_NATIVE_BINARY_MISSING: ${sourceRelative}`);
    }
    const target = path.join(packageRoot, targetRelative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o555);
  }
  const generatedFiles = [];
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`RELEASE_PACKAGE_SYMLINK_FORBIDDEN: ${relative}`);
      }
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) generatedFiles.push(relative);
      else throw new Error(`RELEASE_PACKAGE_SPECIAL_FILE_FORBIDDEN: ${relative}`);
    }
  }
  walk(packageRoot);
  if (generatedFiles.some(file =>
    /(^|\/)\.env(?:\.|$)/.test(file) ||
    file.includes('node_modules/') ||
    file.includes('/target/') ||
    file.endsWith('.tmp'))) {
    throw new Error('RELEASE_PACKAGE_FORBIDDEN_CONTENT');
  }
  const inventoryDocument = {
    version: 1,
    sourceRevision: revision,
    files: Object.fromEntries(generatedFiles.sort().map(relative => [
      relative,
      sha256(path.join(packageRoot, relative))
    ]))
  };
  fs.writeFileSync(
    path.join(packageRoot, 'RELEASE_INVENTORY.json'),
    `${JSON.stringify(inventoryDocument)}\n`,
    { mode: 0o444 }
  );
  const archive = path.join(destination, `ticket-system-${revision}.tar`);
  run('tar', [
    '--sort=name',
    '--mtime=@0',
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '--format=ustar',
    '-cf',
    archive,
    'ticket-system'
  ], stage);
  const checksum = sha256(archive);
  fs.writeFileSync(`${archive}.sha256`, `${checksum}  ${path.basename(archive)}\n`, {
    mode: 0o444
  });
  fs.rmSync(stage, { recursive: true, force: true });
  return Object.freeze({
    sourceRevision: revision,
    archive,
    sha256: checksum,
    fileCount: generatedFiles.length + 1
  });
}

if (require.main === module) {
  try {
    const outputIndex = process.argv.indexOf('--output-directory');
    const outputDirectory = outputIndex === -1 ? null : process.argv[outputIndex + 1];
    process.stdout.write(`${JSON.stringify(buildReleasePackage({
      outputDirectory
    }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_FILES,
  ALLOWED_ROOTS,
  buildReleasePackage,
  packageInventory
};
