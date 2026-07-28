#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  buildProcessOperationIdentity
} = require('../runtime/process-execution-contract');

const ROOT = path.resolve(__dirname, '..');
const BINARY = path.join(
  ROOT,
  'native/process-materializer/target/release/ticket-system-process-materializer'
);
const SERVICE_UID = 61001;
const RUNTIME_UID = 61002;
const UNAUTHORIZED_UID = 61003;
const SHARED_GID = 61000;
let passed = 0;

function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function writeJson(file, value, mode = 0o644) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
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

function setpriv(uid, command, commandArguments) {
  return [
    '--reuid', String(uid),
    '--regid', String(SHARED_GID),
    '--clear-groups',
    command,
    ...commandArguments
  ];
}

function copyClientBundle(destination) {
  fs.mkdirSync(path.join(destination, 'runtime'), { recursive: true, mode: 0o755 });
  for (const relative of [
    'runtime/process-materializer-client.js',
    'runtime/process-materializer-contract.js',
    'runtime/process-authority-constants.js',
    'runtime/process-execution-contract.js'
  ]) {
    fs.copyFileSync(path.join(ROOT, relative), path.join(destination, relative));
    fs.chmodSync(path.join(destination, relative), 0o644);
  }
  fs.copyFileSync(
    path.join(ROOT, 'scripts/process-materializer-cross-uid-client.js'),
    path.join(destination, 'client.js')
  );
  fs.chmodSync(path.join(destination, 'client.js'), 0o755);
}

function runClient(uid, clientScript, requestFile) {
  return spawnSync(
    'setpriv',
    setpriv(uid, process.execPath, [clientScript, requestFile]),
    { encoding: 'utf8' }
  );
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('cross-UID materializer proof requires Linux');
  }
  if (process.getuid() !== 0) {
    const message =
      'BLOCKED: cross-UID materializer proof requires root or a multi-UID user namespace';
    if (process.env.PROCESS_MATERIALIZER_CROSS_UID_REQUIRED === '1' ||
        process.env.ENABLE_PROCESS_EXECUTION_CONTRACT === 'true') {
      throw new Error(message);
    }
    console.log(`${message}; the mandatory process-enabled release gate is registered.`);
    return;
  }
  if (!fs.existsSync(BINARY)) {
    throw new Error(`release materializer binary is missing: ${BINARY}`);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-materializer-cross-uid-'));
  fs.chmodSync(root, 0o755);
  const source = path.join(root, 'workspace');
  const sealed = path.join(root, 'sealed');
  const socket = path.join(root, 'run', 'materializer.sock');
  const policy = path.join(root, 'input-policy.json');
  const config = path.join(root, 'materializer.json');
  const clientRoot = path.join(root, 'client');
  const clientScript = path.join(clientRoot, 'client.js');
  let service = null;
  try {
    fs.mkdirSync(source, { mode: 0o750 });
    fs.chownSync(source, RUNTIME_UID, SHARED_GID);
    fs.mkdirSync(sealed, { mode: 0o750 });
    fs.chownSync(sealed, SERVICE_UID, SHARED_GID);
    fs.chmodSync(sealed, 0o750);
    fs.mkdirSync(path.dirname(socket), { mode: 0o750 });
    fs.chownSync(path.dirname(socket), SERVICE_UID, SHARED_GID);
    fs.chmodSync(path.dirname(socket), 0o750);
    ok(fs.statSync(sealed).uid === SERVICE_UID &&
      fs.statSync(sealed).gid === SHARED_GID &&
      (fs.statSync(sealed).mode & 0o7777) === 0o750,
    'sealed state root is pre-provisioned with the deployment ownership and mode');
    ok(fs.statSync(path.dirname(socket)).uid === SERVICE_UID &&
      fs.statSync(path.dirname(socket)).gid === SHARED_GID &&
      (fs.statSync(path.dirname(socket)).mode & 0o7777) === 0o750,
    'socket directory is pre-provisioned with the deployment ownership and mode');
    fs.writeFileSync(path.join(source, 'input.txt'), 'cross uid input\n', { mode: 0o640 });
    fs.chownSync(path.join(source, 'input.txt'), RUNTIME_UID, SHARED_GID);
    fs.copyFileSync(path.join(ROOT, 'config/process-input-policy.json'), policy);
    fs.chmodSync(policy, 0o644);
    writeJson(config, {
      version: 1,
      socketPath: socket,
      sealedSnapshotRoot: sealed,
      allowedClientUid: RUNTIME_UID,
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
    copyClientBundle(clientRoot);
    const serviceArguments = setpriv(SERVICE_UID, BINARY, [config]);
    service = spawn('setpriv', serviceArguments, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let serviceError = '';
    service.stderr.on('data', chunk => { serviceError += String(chunk); });
    ok(await waitFor(() => fs.existsSync(socket) || service.exitCode !== null),
      'cross-UID materializer reached its socket boundary');
    if (service.exitCode !== null) {
      throw new Error(`cross-UID materializer exited: ${service.exitCode} ${serviceError}`);
    }

    const healthFile = path.join(clientRoot, 'health.json');
    writeJson(healthFile, {
      client: {
        version: 1,
        socketPath: socket,
        workspaceAllocationId: 'primary-workspace',
        timeoutMs: 120000
      },
      operation: 'health'
    });
    fs.chownSync(healthFile, RUNTIME_UID, SHARED_GID);
    const healthResult = runClient(RUNTIME_UID, clientScript, healthFile);
    ok(healthResult.status === 0,
      `runtime UID can authenticate and read health metadata (${healthResult.stderr.trim()})`);
    const generation = JSON.parse(healthResult.stdout);

    const requestFile = path.join(clientRoot, 'materialize.json');
    writeJson(requestFile, {
      client: {
        version: 1,
        socketPath: socket,
        workspaceAllocationId: 'primary-workspace',
        timeoutMs: 120000
      },
      operation: 'materialize',
      request: {
        workspaceAllocationId: 'primary-workspace',
        runId: 123,
        ticketId: 45,
        operationId: 'operation-001',
        operationIdentity: buildProcessOperationIdentity(123, 'operation-001'),
        policySnapshotHash: 'a'.repeat(64),
        materializerGeneration: generation.materializerGeneration,
        filesystemPolicy: {
          inputMode: 'materialized_read_only',
          writableRoots: [],
          allowSymlinks: false,
          allowSpecialFiles: false,
          maxInputFiles: 10000,
          maxInputBytes: 268435456
        }
      }
    });
    fs.chownSync(requestFile, RUNTIME_UID, SHARED_GID);
    const materializeResult = runClient(RUNTIME_UID, clientScript, requestFile);
    ok(materializeResult.status === 0,
      `runtime UID can request materialization (${materializeResult.stderr.trim()})`);
    const descriptor = JSON.parse(materializeResult.stdout);
    ok(!JSON.stringify(descriptor).includes(root),
      'cross-UID runtime receives no sealed host path');

    const snapshotRoot = path.join(sealed, 'sealed', descriptor.id);
    const sealedFile = path.join(snapshotRoot, 'tree', 'input.txt');
    ok(fs.statSync(snapshotRoot).uid === SERVICE_UID,
      'materializer service UID owns the sealed snapshot root');
    ok(fs.statSync(sealedFile).uid === SERVICE_UID,
      'materializer service UID owns sealed files');
    ok(fs.statSync(path.join(source, 'input.txt')).uid === RUNTIME_UID &&
      fs.statSync(sealedFile).uid !== fs.statSync(path.join(source, 'input.txt')).uid,
    'source ownership is not preserved in normalized sealed input');

    const mutate = runClientMutation(RUNTIME_UID, sealedFile, snapshotRoot);
    ok(mutate.status !== 0,
      'runtime UID cannot modify, replace, rename, or delete sealed content');
    ok(fs.readFileSync(sealedFile, 'utf8') === 'cross uid input\n',
      'failed runtime mutation leaves sealed bytes intact');

    const unauthorized = runClient(UNAUTHORIZED_UID, clientScript, healthFile);
    const unauthorizedError = JSON.parse(unauthorized.stderr);
    ok(unauthorized.status !== 0 &&
      unauthorizedError.code === 'PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED' &&
      unauthorizedError.message === 'Materializer client is not authorized' &&
      !unauthorized.stderr.includes(String(UNAUTHORIZED_UID)),
    'unauthorized UID observes the exact non-identifying pre-authentication refusal');
    ok(!path.resolve(sealed).startsWith(`${path.resolve(source)}${path.sep}`),
      'source workspace contains no path into sealed storage');

    const devicePath = path.join(source, 'device-node');
    const device = spawnSync('/usr/bin/mknod', [devicePath, 'c', '1', '3'], {
      encoding: 'utf8'
    });
    ok(device.status === 0,
      `cross-UID environment can create the required special-device fixture (${device.stderr.trim()})`);
    const deviceRequestFile = path.join(clientRoot, 'device.json');
    const deviceOperationId = 'operation-device';
    writeJson(deviceRequestFile, {
      client: {
        version: 1,
        socketPath: socket,
        workspaceAllocationId: 'primary-workspace',
        timeoutMs: 120000
      },
      operation: 'materialize',
      request: {
        ...JSON.parse(fs.readFileSync(requestFile, 'utf8')).request,
        operationId: deviceOperationId,
        operationIdentity: buildProcessOperationIdentity(123, deviceOperationId)
      }
    });
    fs.chownSync(deviceRequestFile, RUNTIME_UID, SHARED_GID);
    const deviceResult = runClient(RUNTIME_UID, clientScript, deviceRequestFile);
    ok(deviceResult.status !== 0 &&
      deviceResult.stderr.includes('PROCESS_INPUT_SPECIAL_FILE_REJECTED'),
    'device files are rejected by the authenticated materializer');

    console.log(`\nPASS: process materializer cross-UID ownership — ${passed} assertions`);
  } finally {
    if (service && service.exitCode === null) {
      service.kill('SIGTERM');
      await waitFor(() => service.exitCode !== null, 5000);
      if (service.exitCode === null) service.kill('SIGKILL');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runClientMutation(uid, sealedFile, snapshotRoot) {
  const program = [
    "const fs=require('fs');",
    `const file=${JSON.stringify(sealedFile)};`,
    `const root=${JSON.stringify(snapshotRoot)};`,
    "let failures=0;",
    "for(const action of [",
    "()=>fs.writeFileSync(file,'tampered'),",
    "()=>fs.renameSync(file,file+'.moved'),",
    "()=>fs.unlinkSync(file),",
    "()=>fs.renameSync(root,root+'.moved')",
    "]){try{action();}catch(_){failures++;}}",
    "process.exit(failures===4?1:0);"
  ].join('');
  return spawnSync(
    'setpriv',
    setpriv(uid, process.execPath, ['-e', program]),
    { encoding: 'utf8' }
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
