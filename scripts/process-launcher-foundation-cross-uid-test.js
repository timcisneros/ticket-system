#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'native/process-launcher/target/release');
const MATERIALIZER_RELEASE = path.join(
  ROOT,
  'native/process-materializer/target/release/ticket-system-process-materializer'
);
const LAUNCHER_RELEASE = path.join(RELEASE, 'ticket-system-process-launcher-foundation');
const PROBE_RELEASE = path.join(RELEASE, 'process-containment-probe');
const GATE_RELEASE = path.join(RELEASE, 'process-launcher-test-gate');
const RUNTIME_UID = 2;
const MATERIALIZER_UID = 1;
const LAUNCHER_UID = 0;
const UNAUTHORIZED_UID = 3;
const TRUSTED_UID = 4;
const RUNTIME_GID = 10;
const HANDOFF_GID = 11;
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(20);
  }
  return false;
}

function writeJson(file, value, mode = 0o440) {
  fs.writeFileSync(file, JSON.stringify(value), { mode });
}

function chownMode(file, uid, gid, mode) {
  fs.chownSync(file, uid, gid);
  fs.chmodSync(file, mode);
}

function mkdir(file, uid, gid, mode) {
  fs.mkdirSync(file, { recursive: true, mode });
  chownMode(file, uid, gid, mode);
}

function copy(file, destination, uid, gid, mode) {
  fs.copyFileSync(file, destination);
  chownMode(destination, uid, gid, mode);
}

function setpriv(uid, command, args) {
  const primaryGroup = uid === MATERIALIZER_UID || uid === LAUNCHER_UID
    ? HANDOFF_GID
    : uid === RUNTIME_UID || uid === UNAUTHORIZED_UID
      ? RUNTIME_GID
      : uid;
  const supplementaryGroups = uid === MATERIALIZER_UID || uid === LAUNCHER_UID
    ? `${RUNTIME_GID},${HANDOFF_GID}`
    : String(primaryGroup);
  return [
    '--reuid', String(uid),
    '--regid', String(primaryGroup),
    '--groups', supplementaryGroups,
    command,
    ...args
  ];
}

function runAs(uid, command, args, options = {}) {
  return spawnSync('setpriv', setpriv(uid, command, args), {
    encoding: 'utf8',
    timeout: 120000,
    ...options
  });
}

function spawnAs(uid, command, args) {
  const child = spawn('setpriv', setpriv(uid, command, args), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return { child, stderr: () => stderr };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function copyClientBundle(destination) {
  mkdir(path.join(destination, 'runtime'), LAUNCHER_UID, RUNTIME_GID, 0o755);
  for (const relative of [
    'runtime/process-authority-constants.js',
    'runtime/process-execution-contract.js',
    'runtime/process-launch-plan.js',
    'runtime/process-launcher-foundation-contract.js',
    'runtime/process-launcher-foundation-client.js',
    'runtime/process-materializer-contract.js',
    'runtime/process-materializer-client.js',
    'runtime/process-target-catalog.js'
  ]) {
    copy(path.join(ROOT, relative), path.join(destination, relative),
      LAUNCHER_UID, RUNTIME_GID, 0o644);
  }
  copy(path.join(ROOT, 'scripts/process-launcher-foundation-cross-uid-client.js'),
    path.join(destination, 'launcher-client.js'), LAUNCHER_UID, RUNTIME_GID, 0o755);
  copy(path.join(ROOT, 'scripts/process-materializer-cross-uid-client.js'),
    path.join(destination, 'materializer-client.js'), LAUNCHER_UID, RUNTIME_GID, 0o755);
  copy(process.execPath, path.join(destination, 'node'), LAUNCHER_UID, RUNTIME_GID, 0o555);
}

function lddFiles(binary) {
  const result = spawnSync('ldd', [binary], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const files = new Set();
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/=>\s+(\/[^\s]+)|^\s*(\/[^\s]+)/);
    const file = match && (match[1] || match[2]);
    if (file) files.add(file);
  }
  return files;
}

function provisionRootfs(rootfs, nodeBinary, probeBinary) {
  const files = new Map([
    ['/usr/bin/node', nodeBinary],
    ['/usr/bin/process-containment-probe', probeBinary]
  ]);
  for (const binary of [nodeBinary, probeBinary]) {
    for (const dependency of lddFiles(binary)) files.set(dependency, dependency);
  }
  const directories = new Set();
  for (const mountpoint of ['dev', 'proc', 'tmp', 'workspace']) {
    directories.add(mountpoint);
  }
  for (const destination of files.keys()) {
    let current = path.posix.dirname(destination);
    while (current !== '/') {
      directories.add(current.slice(1));
      current = path.posix.dirname(current);
    }
  }
  fs.mkdirSync(rootfs, { recursive: true });
  for (const directory of [...directories].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)))) {
    fs.mkdirSync(path.join(rootfs, directory), { recursive: true });
  }
  for (const [destination, source] of files) {
    const output = path.join(rootfs, destination.slice(1));
    fs.copyFileSync(source, output);
  }
  const entries = [];
  for (const directory of directories) {
    entries.push({ type: 'directory', path: directory, mode: '0555' });
  }
  for (const destination of files.keys()) {
    const relative = destination.slice(1);
    const output = path.join(rootfs, relative);
    fs.chmodSync(output, 0o555);
    entries.push({
      type: 'regular_file',
      path: relative,
      size: fs.statSync(output).size,
      sha256: sha256File(output),
      mode: '0555'
    });
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8')
  ));
  for (const entry of entries) {
    const output = path.join(rootfs, entry.path);
    chownMode(output, TRUSTED_UID, TRUSTED_UID,
      entry.type === 'directory' ? 0o555 : 0o555);
  }
  chownMode(rootfs, TRUSTED_UID, TRUSTED_UID, 0o555);
  return Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8');
}

function selfCgroup() {
  const line = fs.readFileSync('/proc/self/cgroup', 'utf8').trim();
  assert.match(line, /^0::\//);
  return path.join('/sys/fs/cgroup', line.slice(3));
}

function prepareDelegation() {
  const root = selfCgroup();
  const fixtureControl = path.join(root, 'fixture-control');
  fs.mkdirSync(fixtureControl);
  fs.writeFileSync(path.join(fixtureControl, 'cgroup.procs'), String(process.pid));
  return { root, fixtureControl };
}

async function waitForSocket(service, socket, label, timeoutMs = 120000) {
  const ready = await waitFor(() => fs.existsSync(socket) || service.child.exitCode !== null,
    timeoutMs);
  if (!ready || service.child.exitCode !== null) {
    throw new Error(`${label} failed to start: ${service.stderr()}`);
  }
}

function requestFile(file, value, uid = RUNTIME_UID) {
  writeJson(file, value, 0o640);
  chownMode(file, uid, RUNTIME_GID, 0o640);
  return file;
}

function parseClient(result, label) {
  assert.strictEqual(result.status, 0,
    `${label} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

function clientRun(uid, clientNode, script, request) {
  return runAs(uid, clientNode, [script, request]);
}

async function startLauncherGated({
  gate,
  launcher,
  configuration,
  cgroupRoot,
  socket,
  resetDelegation = false
}) {
  let previousSocketInode = null;
  try {
    previousSocketInode = fs.lstatSync(socket).ino;
  } catch {}
  const service = spawnAs(LAUNCHER_UID, gate, [launcher, configuration]);
  const stopped = await waitFor(() => {
    if (service.child.exitCode !== null) return true;
    try {
      return /State:\s+T/.test(fs.readFileSync(
        `/proc/${service.child.pid}/status`,
        'utf8'
      ));
    } catch {
      return false;
    }
  }, 5000);
  if (!stopped || service.child.exitCode !== null) {
    throw new Error(`launcher gate did not stop: ${service.stderr()}`);
  }
  if (resetDelegation) {
    fs.writeFileSync(
      path.join(cgroupRoot, 'cgroup.subtree_control'),
      '-cpu -memory -pids'
    );
  }
  fs.writeFileSync(path.join(cgroupRoot, 'cgroup.procs'), String(service.child.pid));
  process.kill(service.child.pid, 'SIGCONT');
  const rebound = await waitFor(() => {
    if (service.child.exitCode !== null) return true;
    try {
      const current = fs.lstatSync(socket);
      return previousSocketInode === null || current.ino !== previousSocketInode;
    } catch {
      return false;
    }
  }, 120000);
  if (!rebound || service.child.exitCode !== null) {
    throw new Error(`active launcher failed to start: ${service.stderr()}`);
  }
  return service;
}

async function inside() {
  if (process.platform !== 'linux' || process.getuid() !== 0) {
    throw new Error('inner containment proof requires mapped root in a delegated user namespace');
  }
  for (const binary of [
    MATERIALIZER_RELEASE,
    LAUNCHER_RELEASE,
    PROBE_RELEASE,
    GATE_RELEASE,
    '/usr/bin/bwrap'
  ]) {
    if (!fs.existsSync(binary)) throw new Error(`required fixture is missing: ${binary}`);
  }
  const delegation = prepareDelegation();
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'process-containment-'));
  fs.chmodSync(fixture, 0o755);
  let materializer;
  let launcher;
  try {
    const binaries = path.join(fixture, 'bin');
    const clients = path.join(fixture, 'clients');
    mkdir(binaries, LAUNCHER_UID, RUNTIME_GID, 0o755);
    mkdir(clients, LAUNCHER_UID, RUNTIME_GID, 0o755);
    const materializerBinary = path.join(binaries, 'materializer');
    const launcherBinary = path.join(binaries, 'launcher');
    const probeBinary = path.join(binaries, 'probe');
    const gateBinary = path.join(binaries, 'gate');
    copy(MATERIALIZER_RELEASE, materializerBinary, MATERIALIZER_UID, RUNTIME_GID, 0o555);
    copy(LAUNCHER_RELEASE, launcherBinary, LAUNCHER_UID, RUNTIME_GID, 0o555);
    copy(PROBE_RELEASE, probeBinary, TRUSTED_UID, TRUSTED_UID, 0o555);
    copy(GATE_RELEASE, gateBinary, LAUNCHER_UID, RUNTIME_GID, 0o555);
    copyClientBundle(clients);
    const clientNode = path.join(clients, 'node');
    const materializerClient = path.join(clients, 'materializer-client.js');
    const launcherClient = path.join(clients, 'launcher-client.js');

    const runtimeSocketDirectory = path.join(fixture, 'materializer-socket');
    const launcherSocketDirectory = path.join(fixture, 'launcher-socket');
    const sealed = path.join(fixture, 'sealed');
    const launcherState = path.join(fixture, 'launcher-state');
    const workspace = path.join(fixture, 'workspace');
    const runtimeData = path.join(fixture, 'runtime-data');
    const artifacts = path.join(fixture, 'artifacts');
    const database = path.join(fixture, 'database');
    const configDirectory = path.join(fixture, 'config');
    mkdir(runtimeSocketDirectory, MATERIALIZER_UID, RUNTIME_GID, 0o750);
    mkdir(launcherSocketDirectory, LAUNCHER_UID, RUNTIME_GID, 0o750);
    mkdir(sealed, MATERIALIZER_UID, HANDOFF_GID, 0o750);
    mkdir(launcherState, LAUNCHER_UID, HANDOFF_GID, 0o750);
    for (const directory of [workspace, runtimeData, artifacts, database, configDirectory]) {
      mkdir(directory, LAUNCHER_UID, RUNTIME_GID, 0o755);
    }
    fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(workspace, 'server.js'));
    chownMode(path.join(workspace, 'server.js'), LAUNCHER_UID, RUNTIME_GID, 0o444);

    const inputPolicy = path.join(configDirectory, 'input-policy.json');
    copy(path.join(ROOT, 'config/process-input-policy.json'), inputPolicy,
      TRUSTED_UID, RUNTIME_GID, 0o440);
    const materializerSocket = path.join(runtimeSocketDirectory, 'materializer.sock');
    const materializerConfiguration = path.join(configDirectory, 'materializer.json');
    writeJson(materializerConfiguration, {
      version: 1,
      socketPath: materializerSocket,
      sealedSnapshotRoot: sealed,
      allowedClientUid: RUNTIME_UID,
      launcherClientUid: LAUNCHER_UID,
      runtimeClientGid: RUNTIME_GID,
      handoffGid: HANDOFF_GID,
      inputPolicyPath: inputPolicy,
      workspaceAllocations: [{
        id: 'primary-workspace',
        sourceRoot: workspace
      }],
      protectedHostPaths: {
        runtimeData: [runtimeData],
        artifacts: [artifacts],
        database: [database]
      }
    });
    chownMode(materializerConfiguration, TRUSTED_UID, RUNTIME_GID, 0o440);
    materializer = spawnAs(
      MATERIALIZER_UID,
      materializerBinary,
      [materializerConfiguration]
    );
    await waitForSocket(materializer, materializerSocket, 'materializer');

    const materializerHealthRequest = requestFile(
      path.join(clients, 'materializer-health.json'),
      {
        client: {
          version: 1,
          socketPath: materializerSocket,
          workspaceAllocationId: 'primary-workspace',
          timeoutMs: 120000
        },
        operation: 'health'
      }
    );
    const materializerHealth = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      materializerClient,
      materializerHealthRequest
    ), 'materializer health');
    ok(materializerHealth.materializerGeneration.startsWith('materializer-v1-'),
      'authorized runtime UID receives the exact materializer generation');

    const rootfs = path.join(fixture, 'rootfs');
    const manifest = path.join(fixture, 'rootfs-manifest.json');
    const manifestBytes = provisionRootfs(rootfs, process.execPath, probeBinary);
    fs.writeFileSync(manifest, manifestBytes);
    chownMode(manifest, TRUSTED_UID, TRUSTED_UID, 0o440);
    const rootfsManifestSha256 = sha256Bytes(manifestBytes);
    const nodeSha256 = sha256File(path.join(rootfs, 'usr/bin/node'));
    const probeSha256 = sha256File(path.join(rootfs, 'usr/bin/process-containment-probe'));
    const backend = path.join(fixture, 'bwrap');
    copy('/usr/bin/bwrap', backend, TRUSTED_UID, TRUSTED_UID, 0o555);
    const seccomp = path.join(configDirectory, 'seccomp.json');
    fs.writeFileSync(
      seccomp,
      fs.readFileSync(
        path.join(ROOT, 'config/process-seccomp-v1.example.json'),
        'utf8'
      ).trim()
    );
    chownMode(seccomp, TRUSTED_UID, TRUSTED_UID, 0o440);
    const launcherSocket = path.join(launcherSocketDirectory, 'launcher.sock');
    const launcherConfiguration = path.join(configDirectory, 'launcher.json');
    writeJson(launcherConfiguration, {
      version: 1,
      socketPath: launcherSocket,
      stateRoot: launcherState,
      allowedClientUid: RUNTIME_UID,
      launcherServiceUid: LAUNCHER_UID,
      materializerServiceUid: MATERIALIZER_UID,
      runtimeClientGid: RUNTIME_GID,
      handoffGid: HANDOFF_GID,
      trustedRootfsOwnerUid: TRUSTED_UID,
      materializerSocketPath: materializerSocket,
      healthValidityMs: 300000,
      rootfsRegistry: [{
        id: 'node-runtime-v1',
        rootPath: rootfs,
        manifestPath: manifest,
        manifestSha256: rootfsManifestSha256
      }],
      sandboxBackend: {
        kind: 'bubblewrap',
        binaryPath: backend,
        binarySha256: sha256File(backend)
      },
      seccompPolicyPath: seccomp,
      seccompPolicySha256: sha256File(seccomp),
      containmentProbe: {
        rootfsId: 'node-runtime-v1',
        executablePath: '/usr/bin/process-containment-probe',
        executableSha256: probeSha256,
        format: 'elf'
      },
      protectedHostPaths: {
        runtimeData: [runtimeData],
        materializerState: [sealed],
        workspaces: [workspace]
      }
    });
    chownMode(launcherConfiguration, TRUSTED_UID, RUNTIME_GID, 0o440);

    launcher = await startLauncherGated({
      gate: gateBinary,
      launcher: launcherBinary,
      configuration: launcherConfiguration,
      cgroupRoot: delegation.root,
      socket: launcherSocket
    });
    const launcherHealthRequest = requestFile(path.join(clients, 'launcher-health.json'), {
      client: { version: 1, socketPath: launcherSocket, timeoutMs: 120000 },
      operation: 'health'
    });
    const containment = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      launcherClient,
      launcherHealthRequest
    ), 'launcher containment health');
    ok(containment.status === 'containment_verified' &&
      containment.readyForExecution === true &&
      containment.delegatedCgroupIdentityHash.length === 64 &&
      containment.containmentProbeHash.length === 64,
    'active containment generation binds cgroup delegation and adversarial probe evidence');

    const { buildProcessPolicySnapshot, buildProcessOperationIdentity } =
      require('../runtime/process-execution-contract');
    const { buildProcessLaunchPlan } = require('../runtime/process-launch-plan');
    const filesystemPolicy = {
      inputMode: 'materialized_read_only',
      writableRoots: [],
      allowSymlinks: false,
      allowSpecialFiles: false,
      maxInputFiles: 10000,
      maxInputBytes: 268435456
    };
    const limits = {
      wallTimeMs: 30000,
      maxOutputBytes: 1048576,
      maxProcesses: 16,
      memoryBytes: 268435456,
      cpuQuotaMicrosPer100ms: 100000,
      maxOpenFiles: 128,
      maxFileBytes: 16777216,
      maxTempBytes: 67108864
    };
    const executionPolicy = {
      shell: false,
      stdin: 'disabled',
      detached: false,
      networkAccess: 'none',
      environmentMode: 'replace'
    };
    const nodeProfile = {
      targetId: 'ticket-system-local',
      profileId: 'syntax-check',
      allowedPhases: ['verification'],
      runtimeRootfs: { id: 'node-runtime-v1', manifestSha256: rootfsManifestSha256 },
      executableIdentity: { path: '/usr/bin/node', sha256: nodeSha256, format: 'elf' },
      arguments: ['--check', '/workspace/server.js'],
      workingDirectory: '.',
      environment: {},
      filesystemPolicy,
      limits,
      executionPolicy
    };
    const probeProfile = {
      ...nodeProfile,
      profileId: 'cancel-probe',
      executableIdentity: {
        path: '/usr/bin/process-containment-probe',
        sha256: probeSha256,
        format: 'elf'
      },
      arguments: ['sleep'],
      environment: {}
    };
    const crashProfile = {
      ...probeProfile,
      profileId: 'crash-probe',
      arguments: ['descendants']
    };
    const policySnapshot = buildProcessPolicySnapshot({
      version: 3,
      capabilityEnabled: true,
      profiles: [nodeProfile, probeProfile, crashProfile],
      capturedAt: '2026-07-28T12:00:00.000Z'
    });
    const authority = {
      runId: 123,
      ticketId: 45,
      currentPhase: 'verification',
      processPolicySnapshot: policySnapshot
    };

    async function materialize(operationId) {
      const request = {
        workspaceAllocationId: 'primary-workspace',
        runId: authority.runId,
        ticketId: authority.ticketId,
        operationId,
        operationIdentity: buildProcessOperationIdentity(authority.runId, operationId),
        policySnapshotHash: policySnapshot.snapshotHash,
        materializerGeneration: materializerHealth.materializerGeneration,
        filesystemPolicy
      };
      const file = requestFile(path.join(clients, `${operationId}-materialize.json`), {
        client: {
          version: 1,
          socketPath: materializerSocket,
          workspaceAllocationId: 'primary-workspace',
          timeoutMs: 120000
        },
        operation: 'materialize',
        request
      });
      return parseClient(clientRun(
        RUNTIME_UID,
        clientNode,
        materializerClient,
        file
      ), `materialize ${operationId}`);
    }

    function launchFile(operationId, profileId, workspaceSnapshot) {
      const launchPlan = buildProcessLaunchPlan({
        launchAuthorityContext: authority,
        operationId,
        targetId: 'ticket-system-local',
        profileId,
        workspaceSnapshot,
        sandboxCapability: containment
      });
      return requestFile(path.join(clients, `${operationId}-launch.json`), {
        client: { version: 1, socketPath: launcherSocket, timeoutMs: 120000 },
        operation: 'launch',
        request: {
          launchPlan,
          containmentGenerationId: containment.generationId
        },
        authority: {
          launchAuthorityContext: authority,
          sandboxCapability: containment
        }
      });
    }

    const nodeWorkspace = await materialize('node-check-001');
    const sealedTree = path.join(sealed, 'sealed', nodeWorkspace.id, 'tree');
    const sealedTreeIdentity = fs.statSync(sealedTree);
    ok(sealedTreeIdentity.uid === MATERIALIZER_UID &&
      sealedTreeIdentity.gid === HANDOFF_GID &&
      (sealedTreeIdentity.mode & 0o777) === 0o550 &&
      runAs(LAUNCHER_UID, '/usr/bin/test', ['-r', sealedTree]).status === 0 &&
      runAs(RUNTIME_UID, '/usr/bin/test', ['-r', sealedTree]).status !== 0,
    'only the launcher handoff principal can traverse the materializer-owned normalized tree');
    const nodeLaunch = launchFile('node-check-001', 'syntax-check', nodeWorkspace);
    const nodeResult = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      launcherClient,
      nodeLaunch
    ), 'fixed Node syntax-check');
    await wait(100);
    ok(nodeResult.terminalOutcome === 'completed' &&
      nodeResult.exitCode === 0 &&
      nodeResult.resourceCause === null,
    `fixed trusted Node syntax-check succeeds through the production containment plan: ` +
      `${JSON.stringify(nodeResult)} launcher=${launcher.stderr()}`);
    ok(!JSON.stringify(nodeResult).includes(fixture) &&
      !Object.hasOwn(nodeResult, 'stdout') &&
      !Object.hasOwn(nodeResult, 'stderr'),
    'private result is bounded and discloses no host path or output content');
    const replay = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      launcherClient,
      nodeLaunch
    ), 'exact private launch replay');
    assert.deepStrictEqual(replay, nodeResult);
    passed += 1;
    console.log('  ok exact private operation replay returns its in-memory terminal result');

    const runtimeAcquire = requestFile(path.join(clients, 'runtime-acquire.json'), {
      client: {
        version: 1,
        socketPath: materializerSocket,
        workspaceAllocationId: 'primary-workspace',
        timeoutMs: 120000
      },
      operation: 'rawAcquire',
      request: {
        snapshotId: nodeWorkspace.id,
        expectedRunId: authority.runId,
        expectedTicketId: authority.ticketId,
        expectedOperationId: 'node-check-001',
        expectedOperationIdentity: buildProcessOperationIdentity(
          authority.runId,
          'node-check-001'
        ),
        expectedPolicySnapshotHash: policySnapshot.snapshotHash,
        expectedMaterializerGeneration: materializerHealth.materializerGeneration,
        expectedFilesystemPolicyHash: crypto.createHash('sha256').update(
          JSON.stringify({
            allowSpecialFiles: false,
            allowSymlinks: false,
            inputMode: 'materialized_read_only',
            maxInputBytes: 268435456,
            maxInputFiles: 10000,
            writableRoots: []
          })
        ).digest('hex'),
        expectedManifestSha256: nodeWorkspace.manifestSha256,
        expectedFileCount: nodeWorkspace.fileCount,
        expectedTotalBytes: nodeWorkspace.totalBytes
      }
    });
    const runtimeAcquireResult = clientRun(
      RUNTIME_UID,
      clientNode,
      materializerClient,
      runtimeAcquire
    );
    ok(runtimeAcquireResult.status !== 0 &&
      JSON.parse(runtimeAcquireResult.stderr).code ===
        'PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED',
    'runtime UID cannot acquire sealed workspace descriptors');

    const tamperedAcquire = clientRun(
      LAUNCHER_UID,
      clientNode,
      materializerClient,
      requestFile(path.join(clients, 'tampered-launcher-acquire.json'), {
        client: {
          version: 1,
          socketPath: materializerSocket,
          workspaceAllocationId: 'primary-workspace',
          timeoutMs: 120000
        },
        operation: 'rawAcquire',
        request: {
          ...JSON.parse(fs.readFileSync(runtimeAcquire, 'utf8')).request,
          expectedTicketId: authority.ticketId + 1
        }
      }, LAUNCHER_UID)
    );
    ok(tamperedAcquire.status !== 0 &&
      JSON.parse(tamperedAcquire.stderr).code === 'PROCESS_INPUT_SNAPSHOT_MISMATCH',
    'launcher cannot acquire a descriptor with a substituted ownership tuple');

    const launcherMaterialize = clientRun(
      LAUNCHER_UID,
      clientNode,
      materializerClient,
      requestFile(path.join(clients, 'launcher-materialize.json'), {
        client: {
          version: 1,
          socketPath: materializerSocket,
          workspaceAllocationId: 'primary-workspace',
          timeoutMs: 120000
        },
        operation: 'materialize',
        request: {
          workspaceAllocationId: 'primary-workspace',
          runId: authority.runId,
          ticketId: authority.ticketId,
          operationId: 'launcher-denied',
          operationIdentity: buildProcessOperationIdentity(
            authority.runId,
            'launcher-denied'
          ),
          policySnapshotHash: policySnapshot.snapshotHash,
          materializerGeneration: materializerHealth.materializerGeneration,
          filesystemPolicy
        }
      }, LAUNCHER_UID)
    );
    ok(launcherMaterialize.status !== 0 &&
      JSON.parse(launcherMaterialize.stderr).code ===
        'PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED',
    'launcher UID cannot invoke workspace materialization');

    const unauthorizedLauncher = clientRun(
      UNAUTHORIZED_UID,
      clientNode,
      launcherClient,
      launcherHealthRequest
    );
    ok(unauthorizedLauncher.status !== 0 &&
      JSON.parse(unauthorizedLauncher.stderr).code ===
        'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED',
    `unauthorized UID receives the exact launcher pre-authentication refusal: ` +
      `${JSON.stringify(unauthorizedLauncher)}`);

    const cancelWorkspace = await materialize('cancel-001');
    const cancelLaunch = launchFile('cancel-001', 'cancel-probe', cancelWorkspace);
    const active = spawn('setpriv', setpriv(
      RUNTIME_UID,
      clientNode,
      [launcherClient, cancelLaunch]
    ), { stdio: ['ignore', 'pipe', 'pipe'] });
    let activeStdout = '';
    let activeStderr = '';
    active.stdout.on('data', chunk => { activeStdout += String(chunk); });
    active.stderr.on('data', chunk => { activeStderr += String(chunk); });
    const cancelIdentity = buildProcessOperationIdentity(authority.runId, 'cancel-001');
    const operationRequest = requestFile(path.join(clients, 'cancel-operation.json'), {
      client: { version: 1, socketPath: launcherSocket, timeoutMs: 120000 },
      operation: 'cancelOperation',
      request: { operationIdentity: cancelIdentity }
    });
    const becameActive = await waitFor(() => {
      const result = clientRun(
        RUNTIME_UID,
        clientNode,
        launcherClient,
        requestFile(path.join(clients, 'get-cancel-operation.json'), {
          client: { version: 1, socketPath: launcherSocket, timeoutMs: 120000 },
          operation: 'getOperation',
          request: { operationIdentity: cancelIdentity }
        })
      );
      return result.status === 0 && JSON.parse(result.stdout).state === 'active';
    }, 10000);
    ok(becameActive, 'private operation lookup observes the bounded active state');
    const cancellation = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      launcherClient,
      operationRequest
    ), 'cancel operation');
    ok(cancellation.state === 'active',
      'cancellation records intent while the operation is still launcher-owned');
    await waitFor(() => active.exitCode !== null, 10000);
    assert.strictEqual(active.exitCode, 0, activeStderr);
    const cancelled = JSON.parse(activeStdout);
    ok(cancelled.terminalOutcome === 'cancelled',
      `cancellation kills and terminalizes the whole operation cgroup: ` +
        `${JSON.stringify(cancelled)} launcher=${launcher.stderr()}`);

    const remainingOperationCgroups = fs.readdirSync(delegation.root)
      .filter(name => name.startsWith('operation-') || name.startsWith('probe-'));
    ok(remainingOperationCgroups.length === 0,
      'all operation and active-probe cgroups reach populated 0 and are removed');

    const crashWorkspace = await materialize('crash-001');
    const crashLaunch = launchFile('crash-001', 'crash-probe', crashWorkspace);
    const crashingClient = spawn('setpriv', setpriv(
      RUNTIME_UID,
      clientNode,
      [launcherClient, crashLaunch]
    ), { stdio: ['ignore', 'pipe', 'pipe'] });
    const crashIdentity = buildProcessOperationIdentity(authority.runId, 'crash-001');
    const crashCgroup = path.join(
      delegation.root,
      `operation-${crashIdentity.slice('process-operation:'.length)}`
    );
    const crashTreeActive = await waitFor(() => {
      try {
        return fs.readFileSync(path.join(crashCgroup, 'cgroup.procs'), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .length >= 2;
      } catch {
        return false;
      }
    }, 10000);
    ok(crashTreeActive,
      'crash fixture establishes launcher-owned double-fork descendants');
    const crashPids = fs.readFileSync(path.join(crashCgroup, 'cgroup.procs'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
    launcher.child.kill('SIGKILL');
    await waitFor(() => launcher.child.exitCode !== null, 5000);
    await waitFor(() => crashingClient.exitCode !== null, 5000);
    const crashTreeEmpty = await waitFor(() => {
      try {
        return fs.readFileSync(path.join(crashCgroup, 'cgroup.events'), 'utf8')
          .includes('populated 0');
      } catch {
        return false;
      }
    }, 5000);
    const survivingStates = crashPids
      .filter(pid => fs.existsSync(`/proc/${pid}/status`))
      .map(pid => {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        return `${pid}:${status.match(/^State:\s+(.+)$/m)?.[1] || 'unknown'}`;
      });
    ok(crashTreeEmpty && survivingStates.length === 0,
      `launcher crash leaves no double-fork or new-session descendant alive: ` +
        `populated0=${crashTreeEmpty} survivors=${survivingStates.join(',')}`);

    launcher = await startLauncherGated({
      gate: gateBinary,
      launcher: launcherBinary,
      configuration: launcherConfiguration,
      cgroupRoot: delegation.root,
      socket: launcherSocket,
      resetDelegation: true
    });
    const restartedContainment = parseClient(clientRun(
      RUNTIME_UID,
      clientNode,
      launcherClient,
      launcherHealthRequest
    ), 'restarted launcher containment health');
    ok(restartedContainment.status === 'containment_verified' &&
      restartedContainment.readyForExecution === true &&
      !fs.existsSync(crashCgroup),
    'launcher restart removes stale empty operation cgroups before publishing health');

    const sealedDirectoryIdentity = fs.statSync(path.join(sealed, 'sealed'));
    ok(sealedDirectoryIdentity.uid === MATERIALIZER_UID &&
      sealedDirectoryIdentity.gid === HANDOFF_GID &&
      (sealedDirectoryIdentity.mode & 0o777) === 0o710 &&
      runAs(RUNTIME_UID, '/usr/bin/test', ['-x', path.join(sealed, 'sealed')]).status !== 0,
    'materializer owns sealed state and the runtime principal cannot traverse it');
  } finally {
    await stop(launcher && launcher.child);
    await stop(materializer && materializer.child);
    try {
      fs.rmSync(fixture, { recursive: true, force: true });
    } catch {}
  }
  console.log(`\nPASS: privileged active process containment — ${passed} assertions`);
}

function outer() {
  const required = process.env.PROCESS_CONTAINMENT_ACTIVE_REQUIRED === '1' ||
    process.env.ENABLE_PROCESS_EXECUTION_CONTRACT === 'true';
  const unavailable = message => {
    if (required) throw new Error(`BLOCKED: ${message}`);
    console.log(`SKIP: ${message}`);
    return true;
  };
  if (process.platform !== 'linux') {
    if (unavailable('active containment proof requires Linux')) return;
  }
  if (!fs.existsSync('/usr/bin/bwrap') ||
      !fs.existsSync('/run/user/' + process.getuid() + '/bus')) {
    if (unavailable(
      'active containment proof requires Bubblewrap and a running systemd user manager'
    )) return;
  }
  const namespaceProbe = spawnSync('unshare', [
    '--user',
    '--map-auto',
    '--map-root-user',
    '/usr/bin/true'
  ], { encoding: 'utf8' });
  if (namespaceProbe.status !== 0) {
    if (unavailable(
      'active containment proof requires subordinate UID mappings usable by unshare --map-auto'
    )) return;
  }
  const result = spawnSync('systemd-run', [
    '--user',
    '--scope',
    '--quiet',
    '--property=Delegate=cpu',
    '--property=Delegate=memory',
    '--property=Delegate=pids',
    'unshare',
    '--user',
    '--map-auto',
    '--map-root-user',
    process.execPath,
    __filename,
    '--inside'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 300000,
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(
      `delegated multi-UID containment suite failed with status ${result.status}`
    );
  }
}

if (process.argv.includes('--inside')) {
  inside().catch(error => {
    console.error(error);
    process.exit(1);
  });
} else {
  try {
    outer();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
