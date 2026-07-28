#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BINARY = path.join(
  ROOT,
  'native/process-launcher/target/release/ticket-system-process-launcher-foundation'
);
const LAUNCHER_UID = 62004;
const RUNTIME_UID = 62002;
const MATERIALIZER_UID = 62001;
const UNAUTHORIZED_UID = 62003;
const SHARED_GID = 62000;
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(25);
  }
  return false;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value, mode = 0o444) {
  fs.writeFileSync(file, JSON.stringify(value), { mode });
}

function setpriv(uid, command, args) {
  return [
    '--reuid', String(uid),
    '--regid', String(SHARED_GID),
    '--clear-groups',
    command,
    ...args
  ];
}

function copyClientBundle(destination) {
  fs.mkdirSync(path.join(destination, 'runtime'), { recursive: true, mode: 0o755 });
  for (const relative of [
    'runtime/process-launcher-foundation-client.js',
    'runtime/process-launcher-foundation-contract.js',
    'runtime/process-materializer-contract.js',
    'runtime/process-authority-constants.js',
    'runtime/process-execution-contract.js',
    'runtime/process-target-catalog.js'
  ]) {
    fs.copyFileSync(path.join(ROOT, relative), path.join(destination, relative));
    fs.chmodSync(path.join(destination, relative), 0o644);
  }
  fs.copyFileSync(
    path.join(ROOT, 'scripts/process-launcher-foundation-cross-uid-client.js'),
    path.join(destination, 'client.js')
  );
  fs.chmodSync(path.join(destination, 'client.js'), 0o755);
}

function runClient(uid, script, request) {
  return spawnSync('setpriv', setpriv(uid, process.execPath, [script, request]), {
    encoding: 'utf8'
  });
}

async function startService(config, socket) {
  const child = spawn('setpriv', setpriv(LAUNCHER_UID, BINARY, [config]), {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const ready = await waitFor(() => fs.existsSync(socket) || child.exitCode !== null);
  if (!ready || child.exitCode !== null) {
    throw new Error(`launcher foundation did not start: ${stderr}`);
  }
  return { child, stderr: () => stderr };
}

async function startExpectFailure(config) {
  const child = spawn('setpriv', setpriv(LAUNCHER_UID, BINARY, [config]), {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const exited = await waitFor(() => child.exitCode !== null, 5000);
  if (!exited) {
    child.kill('SIGKILL');
    throw new Error('invalid launcher foundation startup did not fail');
  }
  return { status: child.exitCode, stderr };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await waitFor(() => child.exitCode !== null, 5000);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('launcher foundation cross-UID proof requires Linux');
  }
  if (process.getuid() !== 0) {
    const message =
      'BLOCKED: launcher/rootfs proof requires root or a working multi-UID user namespace';
    if (process.env.PROCESS_LAUNCHER_CROSS_UID_REQUIRED === '1' ||
        process.env.ENABLE_PROCESS_EXECUTION_CONTRACT === 'true') {
      throw new Error(message);
    }
    console.log(
      `${message}; run sudo env PROCESS_LAUNCHER_CROSS_UID_REQUIRED=1 ` +
      'node scripts/process-launcher-foundation-cross-uid-test.js in dedicated CI.'
    );
    return;
  }
  if (!fs.existsSync(BINARY)) throw new Error(`release launcher binary missing: ${BINARY}`);

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'process-launcher-foundation-'));
  fs.chmodSync(fixture, 0o755);
  const socketDirectory = path.join(fixture, 'run');
  const socket = path.join(socketDirectory, 'launcher.sock');
  const state = path.join(fixture, 'state');
  const protectedRuntime = path.join(fixture, 'runtime');
  const protectedMaterializer = path.join(fixture, 'materializer');
  const protectedWorkspace = path.join(fixture, 'workspace');
  const rootfs = path.join(fixture, 'rootfs');
  const manifest = path.join(fixture, 'manifest.json');
  const backend = path.join(fixture, 'bwrap');
  const seccomp = path.join(fixture, 'seccomp.bpf');
  const config = path.join(fixture, 'launcher.json');
  const clientRoot = path.join(fixture, 'client');
  const clientScript = path.join(clientRoot, 'client.js');
  let service;
  let restarted;
  try {
    for (const directory of [socketDirectory, state]) {
      fs.mkdirSync(directory, { mode: 0o750 });
      fs.chownSync(directory, LAUNCHER_UID, SHARED_GID);
      fs.chmodSync(directory, 0o750);
    }
    for (const directory of [
      protectedRuntime,
      protectedMaterializer,
      protectedWorkspace
    ]) {
      fs.mkdirSync(directory, { mode: 0o750 });
    }
    fs.mkdirSync(path.join(rootfs, 'usr', 'bin'), { recursive: true });
    fs.copyFileSync('/usr/bin/true', path.join(rootfs, 'usr', 'bin', 'node'));
    for (const directory of [rootfs, path.join(rootfs, 'usr'), path.join(rootfs, 'usr', 'bin')]) {
      fs.chownSync(directory, 0, 0);
      fs.chmodSync(directory, 0o555);
    }
    const executable = path.join(rootfs, 'usr', 'bin', 'node');
    fs.chownSync(executable, 0, 0);
    fs.chmodSync(executable, 0o555);
    const executableBytes = fs.statSync(executable).size;
    const executableHash = sha256File(executable);
    writeJson(manifest, {
      version: 1,
      entries: [
        { type: 'directory', path: 'usr', mode: '0555' },
        { type: 'directory', path: 'usr/bin', mode: '0555' },
        {
          type: 'regular_file',
          path: 'usr/bin/node',
          size: executableBytes,
          sha256: executableHash,
          mode: '0555'
        }
      ]
    });
    fs.chownSync(manifest, 0, 0);
    fs.chmodSync(manifest, 0o444);
    fs.copyFileSync('/usr/bin/bwrap', backend);
    fs.chownSync(backend, 0, 0);
    fs.chmodSync(backend, 0o555);
    fs.writeFileSync(seccomp, Buffer.from([0, 0, 0, 0]), { mode: 0o444 });
    fs.chownSync(seccomp, 0, 0);
    const configuration = {
      version: 1,
      socketPath: socket,
      stateRoot: state,
      allowedClientUid: RUNTIME_UID,
      launcherServiceUid: LAUNCHER_UID,
      materializerServiceUid: MATERIALIZER_UID,
      trustedRootfsOwnerUid: 0,
      delegatedCgroupRoot: '/sys/fs/cgroup/user.slice',
      healthValidityMs: 5000,
      rootfsRegistry: [{
        id: 'node-24-fedora-runtime-v1',
        rootPath: rootfs,
        manifestPath: manifest,
        manifestSha256: sha256File(manifest)
      }],
      sandboxBackend: {
        kind: 'bubblewrap',
        binaryPath: backend,
        binarySha256: sha256File(backend)
      },
      seccompPolicyPath: seccomp,
      seccompPolicySha256: sha256File(seccomp),
      protectedHostPaths: {
        runtimeData: [protectedRuntime],
        materializerState: [protectedMaterializer],
        workspaces: [protectedWorkspace]
      }
    };
    writeJson(config, configuration);
    fs.chownSync(config, 0, SHARED_GID);
    fs.chmodSync(config, 0o440);
    copyClientBundle(clientRoot);

    const healthFile = path.join(clientRoot, 'health.json');
    writeJson(healthFile, {
      client: { version: 1, socketPath: socket, timeoutMs: 30000 },
      operation: 'health',
      options: {}
    }, 0o640);
    fs.chownSync(healthFile, RUNTIME_UID, SHARED_GID);
    service = await startService(config, socket);
    const healthResult = runClient(RUNTIME_UID, clientScript, healthFile);
    ok(healthResult.status === 0,
      `authorized runtime UID receives foundation health (${healthResult.stderr.trim()})`);
    const health = JSON.parse(healthResult.stdout);
    ok(health.readyForExecution === false,
      'cross-UID foundation health is explicitly non-executable');

    const rootfsFile = path.join(clientRoot, 'rootfs.json');
    writeJson(rootfsFile, {
      client: { version: 1, socketPath: socket, timeoutMs: 30000 },
      operation: 'getRootfs',
      request: {
        rootfsId: configuration.rootfsRegistry[0].id,
        rootfsManifestSha256: configuration.rootfsRegistry[0].manifestSha256
      }
    }, 0o640);
    fs.chownSync(rootfsFile, RUNTIME_UID, SHARED_GID);
    const rootfsResult = runClient(RUNTIME_UID, clientScript, rootfsFile);
    ok(rootfsResult.status === 0 && !rootfsResult.stdout.includes(fixture),
      'rootfs lookup returns verified authority without a host path');

    const executableFile = path.join(clientRoot, 'executable.json');
    writeJson(executableFile, {
      client: { version: 1, socketPath: socket, timeoutMs: 30000 },
      operation: 'verifyExecutable',
      request: {
        rootfsId: configuration.rootfsRegistry[0].id,
        rootfsManifestSha256: configuration.rootfsRegistry[0].manifestSha256,
        executablePath: '/usr/bin/node',
        executableSha256: executableHash,
        format: 'elf'
      }
    }, 0o640);
    fs.chownSync(executableFile, RUNTIME_UID, SHARED_GID);
    const executableResult = runClient(RUNTIME_UID, clientScript, executableFile);
    ok(executableResult.status === 0 && !executableResult.stdout.includes(fixture),
      'ELF identity verification returns no rootfs host path');

    const unauthorized = runClient(UNAUTHORIZED_UID, clientScript, healthFile);
    const unauthorizedError = JSON.parse(unauthorized.stderr);
    ok(unauthorized.status !== 0 &&
      unauthorizedError.code === 'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED',
    'unauthorized UID receives the exact launcher pre-authentication refusal');

    const socketInode = fs.statSync(socket).ino;
    const second = await startExpectFailure(config);
    ok(second.stderr.includes('PROCESS_LAUNCHER_ALREADY_RUNNING'),
      'launcher lifetime lease rejects a second instance');
    ok(fs.statSync(socket).ino === socketInode,
      'rejected second launcher cannot unlink the active socket');
    ok(runClient(RUNTIME_UID, clientScript, healthFile).status === 0,
      'first launcher remains healthy after a rejected second start');

    await stop(service.child);
    service = null;
    restarted = await startService(config, socket);
    ok(fs.existsSync(path.join(state, 'launcher-foundation-instance.lock')),
      'stale lock pathname does not block restart after kernel lease release');
    await stop(restarted.child);
    restarted = null;

    const oldGeneration = health.rootfsRegistryGeneration;
    const retainedRootfs = `${rootfs}-retained`;
    fs.renameSync(rootfs, retainedRootfs);
    fs.mkdirSync(path.join(rootfs, 'usr', 'bin'), { recursive: true });
    fs.copyFileSync(path.join(retainedRootfs, 'usr', 'bin', 'node'), executable);
    for (const directory of [rootfs, path.join(rootfs, 'usr'), path.join(rootfs, 'usr', 'bin')]) {
      fs.chownSync(directory, 0, 0);
      fs.chmodSync(directory, 0o555);
    }
    fs.chownSync(executable, 0, 0);
    fs.chmodSync(executable, 0o555);
    restarted = await startService(config, socket);
    const replacedHealth = runClient(RUNTIME_UID, clientScript, healthFile);
    ok(replacedHealth.status === 0 &&
      JSON.parse(replacedHealth.stdout).rootfsRegistryGeneration !== oldGeneration,
    'a physical rootfs replacement changes the registry generation on restart');
  } finally {
    if (service) await stop(service.child);
    if (restarted) await stop(restarted.child);
    fs.chmodSync(fixture, 0o755);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
  console.log(`\nPASS: launcher foundation privileged Linux proof — ${passed} assertions`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
