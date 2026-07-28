#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  buildProcessOperationIdentity
} = require('../runtime/process-execution-contract');
const {
  buildGetProcessSnapshotRequest,
  buildProcessMaterializationRequest
} = require('../runtime/process-materializer-contract');
const {
  ProcessMaterializerClient
} = require('../runtime/process-materializer-client');

const ROOT = path.resolve(__dirname, '..');
const BINARY = path.join(
  ROOT,
  'native/process-materializer/target/debug/ticket-system-process-materializer'
);
const MAX_MESSAGE_BYTES = 2_097_152;
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function equal(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

async function rejectsCode(callback, code, message) {
  await assert.rejects(callback, error => error && error.code === code, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(25);
  }
  return null;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(label = 'main') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `process-materializer-${label}-`));
  const source = path.join(root, 'workspace');
  const sealed = path.join(root, 'sealed');
  const socket = path.join(root, 'run', 'materializer.sock');
  const policy = path.join(root, 'input-policy.json');
  const config = path.join(root, 'materializer.json');
  fs.mkdirSync(source, { recursive: true });
  writeJson(policy, JSON.parse(fs.readFileSync(
    path.join(ROOT, 'config/process-input-policy.json'),
    'utf8'
  )));
  writeJson(config, {
    version: 1,
    socketPath: socket,
    sealedSnapshotRoot: sealed,
    allowedClientUid: process.getuid(),
    inputPolicyPath: policy,
    workspaceAllocations: [{
      id: 'primary-workspace',
      sourceRoot: source
    }],
    protectedHostPaths: {
      runtimeData: [path.join(root, 'runtime')],
      artifacts: [path.join(root, 'artifacts')],
      database: [path.join(root, 'database')]
    }
  });
  return { root, source, sealed, socket, policy, config };
}

async function startService(fixture) {
  const child = spawn(BINARY, [fixture.config], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errorOutput = '';
  child.stderr.on('data', chunk => { errorOutput += String(chunk); });
  const ready = await waitFor(() => fs.existsSync(fixture.socket) || child.exitCode !== null);
  if (!ready || child.exitCode !== null) {
    throw new Error(`materializer did not start: exit=${child.exitCode} ${errorOutput}`);
  }
  const client = new ProcessMaterializerClient({
    version: 1,
    socketPath: fixture.socket,
    workspaceAllocationId: 'primary-workspace',
    timeoutMs: 120000
  });
  let generation = null;
  const healthy = await waitFor(async () => {
    if (child.exitCode !== null) return false;
    try {
      generation = await client.health();
      return true;
    } catch (_) {
      return false;
    }
  });
  if (!healthy) {
    throw new Error(`materializer never became healthy: exit=${child.exitCode} ${errorOutput}`);
  }
  return { child, client, generation, errorOutput: () => errorOutput };
}

async function stopService(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function requestFor(generation, operationId, overrides = {}) {
  return buildProcessMaterializationRequest({
    workspaceAllocationId: 'primary-workspace',
    runId: 123,
    ticketId: 45,
    operationId,
    policySnapshotHash: 'a'.repeat(64),
    materializerGeneration: generation.materializerGeneration,
    filesystemPolicy: {
      inputMode: 'materialized_read_only',
      writableRoots: [],
      allowSymlinks: false,
      allowSpecialFiles: false,
      maxInputFiles: 10000,
      maxInputBytes: 268435456
    },
    ...overrides
  });
}

function rawProtocol(socketPath, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(bytes.length + 4);
  frame.writeUInt32BE(bytes.length, 0);
  bytes.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    socket.once('error', reject);
    socket.once('connect', () => socket.write(frame));
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('end', () => {
      const response = Buffer.concat(chunks);
      if (response.length < 4) return resolve(null);
      const length = response.readUInt32BE(0);
      resolve(JSON.parse(response.subarray(4, 4 + length)));
    });
  });
}

async function oversizedFrameIsRejected(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let bytes = 0;
    socket.once('error', error => {
      if (error.code === 'ECONNRESET') resolve(true);
      else reject(error);
    });
    socket.on('data', chunk => { bytes += chunk.length; });
    socket.once('connect', () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_MESSAGE_BYTES + 1);
      socket.write(header);
    });
    socket.once('close', () => resolve(bytes === 0));
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeTreeWritable(root) {
  if (!fs.existsSync(root)) return;
  const metadata = fs.lstatSync(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  fs.chmodSync(root, 0o700);
  for (const name of fs.readdirSync(root)) {
    makeTreeWritable(path.join(root, name));
  }
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('process materializer Linux integrity test is mandatory on Linux releases');
  }
  if (!fs.existsSync(BINARY)) {
    throw new Error(`native materializer binary is missing: ${BINARY}`);
  }
  const fixture = createFixture();
  let service;
  let specialSocket = null;
  try {
    fs.writeFileSync(path.join(fixture.source, 'server.js'), 'console.log("safe");\n');
    fs.writeFileSync(path.join(fixture.source, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(fixture.source, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    for (const excluded of [
      '.git/config',
      '.env',
      '.env.local',
      'node_modules/pkg/index.js',
      '.local-artifacts/out.bin',
      'runtime-state/run.json',
      'replay-snapshots/run.json',
      'data/runtime.json',
      '.runtime/service.sock',
      'swap.swp'
    ]) {
      fs.mkdirSync(path.dirname(path.join(fixture.source, excluded)), { recursive: true });
      fs.writeFileSync(path.join(fixture.source, excluded), 'excluded');
    }

    service = await startService(fixture);
    ok(service.generation.materializerGeneration.startsWith('materializer-v1-'),
      'health exposes a deterministic bounded materializer generation');
    equal(service.generation.manifestSchemaVersion, 1,
      'health exposes manifest schema version 1');
    equal(service.generation.registrySchemaVersion, 1,
      'health exposes registry schema version 1');

    const request = requestFor(service.generation, 'operation-001');
    const descriptor = await service.client.materialize(request);
    equal(Object.keys(descriptor).sort(), [
      'fileCount',
      'id',
      'manifestSha256',
      'materializerGeneration',
      'policySnapshotHash',
      'runId',
      'totalBytes'
    ], 'materialize returns only the exact public workspace descriptor');
    ok(!JSON.stringify(descriptor).includes(fixture.root),
      'Node client receives no source or sealed host path');
    equal(descriptor.fileCount, 3,
      'ordinary project files and lockfiles remain in read-only input');

    const privateRoot = path.join(fixture.sealed, 'sealed', descriptor.id);
    const tree = path.join(privateRoot, 'tree');
    const manifestPath = path.join(privateRoot, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    const paths = manifest.entries.map(entry => entry.path);
    for (const included of ['package.json', 'pnpm-lock.yaml', 'server.js']) {
      ok(paths.includes(included), `${included} remains authorized read-only input`);
    }
    for (const excluded of [
      '.git',
      '.env',
      '.env.local',
      'node_modules',
      '.local-artifacts',
      'runtime-state',
      'replay-snapshots',
      'data',
      '.runtime',
      'swap.swp'
    ]) {
      ok(!paths.some(value => value === excluded || value.startsWith(`${excluded}/`)),
        `${excluded} is excluded from process input`);
    }
    equal(sha256(manifestPath), descriptor.manifestSha256,
      'descriptor manifest hash covers the exact canonical manifest bytes');
    const regularEntries = manifest.entries.filter(entry => entry.type === 'regular_file');
    equal(regularEntries.reduce((sum, entry) => sum + entry.size, 0), descriptor.totalBytes,
      'descriptor byte total equals the canonical regular-file manifest');
    equal(manifest.entries.length, descriptor.fileCount,
      'descriptor file count equals the complete canonical manifest entry count');
    for (const entry of regularEntries) {
      equal(sha256(path.join(tree, entry.path)), entry.sha256,
        `manifest hash matches sealed bytes for ${entry.path}`);
      equal(fs.statSync(path.join(tree, entry.path)).mode & 0o7777, 0o440,
        `sealed file mode is normalized for ${entry.path}`);
    }

    const registryPath = path.join(
      fixture.sealed,
      'registry',
      `${descriptor.id}.json`
    );
    const registry = JSON.parse(fs.readFileSync(registryPath));
    equal(registry.operationIdentity, request.operationIdentity,
      'private registry binds the process operation identity');
    equal(registry.inputPolicyHash, service.generation.inputPolicyHash,
      'private registry binds the exact exclusion policy hash');
    ok(!Object.keys(registry).some(key => /path/i.test(key)),
      'private registry stores no source or sealed host path');

    const retrieved = await service.client.getSnapshot(buildGetProcessSnapshotRequest({
      snapshotId: descriptor.id,
      runId: 123,
      ticketId: 45,
      operationId: 'operation-001',
      policySnapshotHash: 'a'.repeat(64),
      materializerGeneration: service.generation.materializerGeneration
    }));
    equal(retrieved, descriptor,
      'getSnapshot reproduces the exact durable public descriptor');
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: descriptor.id,
        runId: 123,
        ticketId: 46,
        operationId: 'operation-001',
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: service.generation.materializerGeneration
      })),
      'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'another ticket cannot substitute the sealed snapshot'
    );
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: descriptor.id,
        runId: 123,
        ticketId: 45,
        operationId: 'operation-002',
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: service.generation.materializerGeneration
      })),
      'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'another operation in the same run cannot substitute the sealed snapshot'
    );
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: descriptor.id,
        runId: 124,
        ticketId: 45,
        operationId: 'operation-001',
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: service.generation.materializerGeneration
      })),
      'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'another run cannot substitute the sealed snapshot'
    );
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: descriptor.id,
        runId: 123,
        ticketId: 45,
        operationId: 'operation-001',
        policySnapshotHash: 'b'.repeat(64),
        materializerGeneration: service.generation.materializerGeneration
      })),
      'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'another policy snapshot cannot substitute the sealed snapshot'
    );
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: descriptor.id,
        runId: 123,
        ticketId: 45,
        operationId: 'operation-001',
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: `materializer-v1-${'f'.repeat(64)}`
      })),
      'PROCESS_INPUT_GENERATION_MISMATCH',
      'another materializer generation cannot retrieve the sealed snapshot'
    );
    await rejectsCode(
      () => service.client.getSnapshot(buildGetProcessSnapshotRequest({
        snapshotId: 'staging-unpublished',
        runId: 123,
        ticketId: 45,
        operationId: 'operation-001',
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: service.generation.materializerGeneration
      })),
      'PROCESS_INPUT_SNAPSHOT_NOT_FOUND',
      'staging or unpublished state cannot be retrieved as a snapshot'
    );

    const extra = await rawProtocol(fixture.socket, {
      version: 1,
      requestId: 'raw-extra',
      operation: 'materialize',
      body: {
        ...request,
        sourcePath: fixture.source
      }
    });
    equal(extra.error.code, 'PROCESS_MATERIALIZER_REQUEST_INVALID',
      'protocol rejects extra source path before materialization');
    const wrongIdentity = await rawProtocol(fixture.socket, {
      version: 1,
      requestId: 'raw-identity',
      operation: 'materialize',
      body: {
        ...requestFor(service.generation, 'operation-raw'),
        operationIdentity: buildProcessOperationIdentity(999, 'operation-raw')
      }
    });
    equal(wrongIdentity.error.code, 'PROCESS_MATERIALIZER_REQUEST_INVALID',
      'service independently recomputes operation identity');
    await rejectsCode(
      () => service.client.materialize(requestFor(
        { materializerGeneration: `materializer-v1-${'f'.repeat(64)}` },
        'operation-generation'
      )),
      'PROCESS_INPUT_GENERATION_MISMATCH',
      'materialization is bound to the current service generation'
    );
    const unknownAllocation = await rawProtocol(fixture.socket, {
      version: 1,
      requestId: 'raw-allocation',
      operation: 'materialize',
      body: requestFor(
        service.generation,
        'operation-allocation',
        { workspaceAllocationId: 'unknown-workspace' }
      )
    });
    equal(unknownAllocation.error.code, 'PROCESS_WORKSPACE_ALLOCATION_UNKNOWN',
      'native service rejects an unknown trusted workspace allocation');
    ok(await oversizedFrameIsRejected(fixture.socket),
      'oversized frame is rejected from its length before payload allocation');

    fs.symlinkSync('/etc/passwd', path.join(fixture.source, 'escape-link'));
    await rejectsCode(
      () => service.client.materialize(requestFor(service.generation, 'operation-symlink')),
      'PROCESS_INPUT_SYMLINK_REJECTED',
      'symlink input is rejected through descriptor-relative traversal'
    );
    fs.unlinkSync(path.join(fixture.source, 'escape-link'));

    specialSocket = net.createServer();
    const specialPath = path.join(fixture.source, 'host-channel');
    await new Promise((resolve, reject) => {
      specialSocket.once('error', reject);
      specialSocket.listen(specialPath, resolve);
    });
    await rejectsCode(
      () => service.client.materialize(requestFor(service.generation, 'operation-socket')),
      'PROCESS_INPUT_SPECIAL_FILE_REJECTED',
      'Unix socket input is rejected as a special file'
    );
    await new Promise(resolve => specialSocket.close(resolve));
    specialSocket = null;
    if (fs.existsSync(specialPath)) fs.unlinkSync(specialPath);

    const racePath = path.join(fixture.source, 'race.bin');
    const first = Buffer.alloc(8 * 1024 * 1024, 0x41);
    const second = Buffer.alloc(8 * 1024 * 1024, 0x42);
    fs.writeFileSync(racePath, first);
    let racing = true;
    const raceLoop = (async () => {
      let index = 0;
      while (racing) {
        const temporary = `${racePath}.replacement`;
        fs.writeFileSync(temporary, index++ % 2 ? first : second);
        fs.renameSync(temporary, racePath);
        await new Promise(resolve => setImmediate(resolve));
      }
    })();
    await rejectsCode(
      () => service.client.materialize(requestFor(service.generation, 'operation-race')),
      'PROCESS_INPUT_SOURCE_CHANGED',
      'external file replacement during copy is detected without retry'
    );
    racing = false;
    await raceLoop;
    const registryFilesAfterRace = fs.readdirSync(path.join(fixture.sealed, 'registry'));
    equal(registryFilesAfterRace.length, 1,
      'source inconsistency publishes no descriptor or registry record');

    await stopService(service.child);
    service = null;
    const abandoned = path.join(fixture.sealed, 'staging', 'staging-abandoned');
    fs.mkdirSync(abandoned, { recursive: true });
    fs.writeFileSync(path.join(abandoned, 'partial'), 'partial');
    service = await startService(fixture);
    ok(!fs.existsSync(abandoned),
      'service restart removes abandoned staging deterministically');
    const afterRestart = await service.client.getSnapshot(buildGetProcessSnapshotRequest({
      snapshotId: descriptor.id,
      runId: 123,
      ticketId: 45,
      operationId: 'operation-001',
      policySnapshotHash: 'a'.repeat(64),
      materializerGeneration: service.generation.materializerGeneration
    }));
    equal(afterRestart, descriptor,
      'sealed registry record remains valid across service restart');

    await stopService(service.child);
    service = null;
    const missingTree = path.join(fixture.root, 'temporarily-missing-tree');
    fs.renameSync(privateRoot, missingTree);
    const missingStart = await startExpectFailure(fixture);
    ok(missingStart.stderr.includes('PROCESS_INPUT_REGISTRY_INVALID'),
      'registry lookup fails closed when its sealed tree is missing');
    fs.renameSync(missingTree, privateRoot);

    const originalRegistryBytes = fs.readFileSync(registryPath);
    const invalidRegistry = { ...registry, state: 'staging' };
    fs.chmodSync(registryPath, 0o600);
    fs.writeFileSync(registryPath, canonicalJson(invalidRegistry));
    fs.chmodSync(registryPath, 0o440);
    const invalidStart = await startExpectFailure(fixture);
    ok(invalidStart.stderr.includes('PROCESS_INPUT_REGISTRY_INVALID'),
      'invalid private registry state prevents service startup');
    fs.chmodSync(registryPath, 0o600);
    fs.writeFileSync(registryPath, originalRegistryBytes);
    fs.chmodSync(registryPath, 0o440);

    fs.renameSync(registryPath, path.join(fixture.root, 'removed-registry.json'));
    const orphanStart = await startExpectFailure(fixture);
    ok(orphanStart.stderr.includes('PROCESS_INPUT_REGISTRY_INVALID'),
      'sealed tree without a matching registry record prevents startup');

    console.log(`\nPASS: process materializer Linux integration — ${passed} assertions`);
  } finally {
    if (specialSocket) await new Promise(resolve => specialSocket.close(resolve));
    if (service) await stopService(service.child);
    try { makeTreeWritable(fixture.root); } catch (_) {}
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function startExpectFailure(fixture) {
  const child = spawn(BINARY, [fixture.config], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = await waitFor(() => child.exitCode !== null, 5000);
  if (!exited) {
    child.kill('SIGKILL');
    throw new Error('invalid materializer state did not fail startup');
  }
  return { status: child.exitCode, stderr };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  ).join(',')}}`;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
