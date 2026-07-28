#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES,
  PROCESS_SANDBOX_PREREQUISITE_STATUS,
  ProcessLauncherFoundationError,
  buildGetRootfsRequest,
  buildLauncherOperationRequest,
  buildProcessSandboxPrerequisiteDescriptor,
  buildVerifyExecutableRequest,
  normalizeContainmentHealth,
  normalizeExecutableAuthority,
  normalizeFoundationHealth,
  normalizePrivateExecutionResult,
  normalizePrivateOperationStatus,
  normalizeProcessSandboxPrerequisiteDescriptor,
  normalizeRootfsAuthority
} = require('../runtime/process-launcher-foundation-contract');
const {
  parseResponse
} = require('../runtime/process-launcher-foundation-client');
const {
  CURRENT_PROCESS_SANDBOX_CAPABILITY
} = require('../runtime/process-execution-contract');
const {
  inspectProcessSandboxPrerequisites
} = require('../runtime/process-sandbox-prerequisite-inspection');

const ROOT = path.resolve(__dirname, '..');
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

function throwsCode(callback, code, message) {
  assert.throws(callback, error => error && error.code === code, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function health(overrides = {}) {
  return {
    version: 1,
    status: 'foundation_verified',
    launcherProtocolVersion: 1,
    launcherIdentityHash: '1'.repeat(64),
    sandboxBackendIdentityHash: '2'.repeat(64),
    seccompPolicyHash: '3'.repeat(64),
    rootfsRegistryGeneration: `rootfs-registry-v1-${'4'.repeat(64)}`,
    hostPrerequisiteIdentityHash: 'd'.repeat(64),
    verifiedAt: '2026-07-28T10:00:00.000Z',
    expiresAt: '2026-07-28T10:01:00.000Z',
    readyForExecution: false,
    hostPrerequisites: {
      platform: 'linux',
      kernelRelease: '7.1.4',
      cgroupV2: 'statically_present',
      cgroupControllers: ['cpuset', 'cpu', 'memory', 'pids'],
      delegatedCgroupRoot: 'statically_present',
      userNamespaces: 'statically_present',
      mountNamespaces: 'statically_present',
      pidNamespaces: 'statically_present',
      networkNamespaces: 'statically_present',
      seccompFilter: 'statically_present',
      noNewPrivs: 'statically_present',
      activeContainmentProof: 'not_proven_until_2a3'
    },
    ...overrides
  };
}

function containmentHealth(overrides = {}) {
  return {
    version: 1,
    status: 'containment_verified',
    generationId: `sandbox-containment-v1-${'a'.repeat(64)}`,
    launcherProtocolVersion: 1,
    launcherIdentityHash: '1'.repeat(64),
    sandboxBackendIdentityHash: '2'.repeat(64),
    seccompPolicyHash: '3'.repeat(64),
    rootfsRegistryGeneration: `rootfs-registry-v1-${'4'.repeat(64)}`,
    materializerGeneration: `materializer-v1-${'5'.repeat(64)}`,
    delegatedCgroupIdentityHash: '8'.repeat(64),
    containmentProbeHash: '9'.repeat(64),
    verifiedAt: '2026-07-28T10:00:00.000Z',
    expiresAt: '2026-07-28T10:01:00.000Z',
    readyForExecution: true,
    ...overrides
  };
}

const materializer = {
  materializerGeneration: `materializer-v1-${'5'.repeat(64)}`,
  materializerIdentityHash: '6'.repeat(64),
  inputPolicyHash: '7'.repeat(64),
  manifestSchemaVersion: 1,
  registrySchemaVersion: 1
};
const observedAt = '2026-07-28T10:00:30.000Z';

const normalizedHealth = normalizeFoundationHealth(health(), { observedAt });
equal(normalizedHealth.readyForExecution, false,
  'foundation health explicitly remains insufficient for execution');
equal(normalizedHealth.hostPrerequisites.activeContainmentProof,
  'not_proven_until_2a3',
  'foundation health labels active containment as unproven');
throwsCode(
  () => normalizeFoundationHealth(health({ readyForExecution: true }), { observedAt }),
  'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE',
  'foundation health cannot claim execution readiness'
);
throwsCode(
  () => normalizeFoundationHealth(health(), {
    observedAt: '2026-07-28T10:01:00.000Z'
  }),
  'PROCESS_SANDBOX_PREREQUISITES_EXPIRED',
  'expired prerequisite health fails closed'
);
throwsCode(
  () => normalizeFoundationHealth({
    ...health(),
    extra: true
  }, { observedAt }),
  'PROCESS_LAUNCHER_PROTOCOL_INVALID',
  'foundation health rejects extra fields'
);

const descriptor = buildProcessSandboxPrerequisiteDescriptor({
  launcherHealth: health(),
  materializerHealth: materializer,
  observedAt
});
equal(descriptor.status, PROCESS_SANDBOX_PREREQUISITE_STATUS,
  'private prerequisite descriptor uses the frozen non-execution status');
equal(descriptor.readyForExecution, false,
  'private prerequisite descriptor cannot authorize execution');
ok(descriptor.generationId.startsWith('sandbox-prerequisite-v1-'),
  'prerequisite generation has a bounded deterministic identity');
equal(
  descriptor,
  buildProcessSandboxPrerequisiteDescriptor({
    launcherHealth: health(),
    materializerHealth: materializer,
    observedAt
  }),
  'prerequisite generation is deterministic for exact pinned authority'
);
ok(
  buildProcessSandboxPrerequisiteDescriptor({
    launcherHealth: health({ seccompPolicyHash: '8'.repeat(64) }),
    materializerHealth: materializer,
    observedAt
  }).generationId !== descriptor.generationId,
  'seccomp policy replacement changes prerequisite generation'
);
ok(
  buildProcessSandboxPrerequisiteDescriptor({
    launcherHealth: health({ sandboxBackendIdentityHash: '9'.repeat(64) }),
    materializerHealth: materializer,
    observedAt
  }).generationId !== descriptor.generationId,
  'sandbox backend replacement changes prerequisite generation'
);
normalizeProcessSandboxPrerequisiteDescriptor(descriptor, { observedAt });
throwsCode(
  () => normalizeProcessSandboxPrerequisiteDescriptor({
    ...descriptor,
    generationId: `sandbox-prerequisite-v1-${'0'.repeat(64)}`
  }, { observedAt }),
  'PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE',
  'prerequisite descriptor rejects a mismatched generation'
);

equal(
  normalizeContainmentHealth(containmentHealth(), { observedAt }),
  containmentHealth(),
  'active containment health uses the closed time-bounded execution descriptor'
);
throwsCode(
  () => normalizeContainmentHealth(containmentHealth({
    readyForExecution: false
  }), { observedAt }),
  'PROCESS_CONTAINMENT_UNAVAILABLE',
  'containment health cannot omit active execution readiness'
);

equal(buildGetRootfsRequest({
  rootfsId: 'node-24-fedora-runtime-v1',
  rootfsManifestSha256: 'a'.repeat(64)
}), {
  rootfsId: 'node-24-fedora-runtime-v1',
  rootfsManifestSha256: 'a'.repeat(64)
}, 'getRootfs accepts only rootfs authority references');
throwsCode(() => buildGetRootfsRequest({
  rootfsId: 'node-24-fedora-runtime-v1',
  rootfsManifestSha256: 'a'.repeat(64),
  rootPath: '/host/rootfs'
}), 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
'getRootfs rejects request-provided rootfs host paths');

const verifyRequest = buildVerifyExecutableRequest({
  rootfsId: 'node-24-fedora-runtime-v1',
  rootfsManifestSha256: 'a'.repeat(64),
  executablePath: '/usr/bin/node',
  executableSha256: 'b'.repeat(64),
  format: 'elf'
});
equal(verifyRequest.executablePath, '/usr/bin/node',
  'verifyExecutable represents one rootfs-internal absolute ELF identity');
throwsCode(() => buildVerifyExecutableRequest({
  ...verifyRequest,
  executablePath: '/usr/../etc/passwd'
}), 'PROCESS_EXECUTABLE_IDENTITY_MISMATCH',
'verifyExecutable rejects traversal');
throwsCode(() => buildVerifyExecutableRequest({
  ...verifyRequest,
  arguments: ['server.js']
}), 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
'verifyExecutable rejects arguments and execution material');
throwsCode(() => buildVerifyExecutableRequest({
  ...verifyRequest,
  format: 'script'
}), 'PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED',
'verifyExecutable rejects script authority');

const rootfsAuthority = normalizeRootfsAuthority({
  id: verifyRequest.rootfsId,
  manifestSha256: verifyRequest.rootfsManifestSha256,
  physicalIdentityHash: 'c'.repeat(64),
  entryCount: 3,
  totalRegularBytes: 4,
  rootfsRegistryGeneration: descriptor.rootfsRegistryGeneration
}, {
  id: verifyRequest.rootfsId,
  manifestSha256: verifyRequest.rootfsManifestSha256
});
ok(!JSON.stringify(rootfsAuthority).includes('/var/') &&
  !JSON.stringify(rootfsAuthority).includes('rootPath'),
'rootfs protocol result contains no host rootfs path');
const executableAuthority = normalizeExecutableAuthority({
  rootfsId: verifyRequest.rootfsId,
  rootfsManifestSha256: verifyRequest.rootfsManifestSha256,
  executablePath: verifyRequest.executablePath,
  executableSha256: verifyRequest.executableSha256,
  format: 'elf',
  rootfsRegistryGeneration: descriptor.rootfsRegistryGeneration
}, verifyRequest);
equal(executableAuthority.executableSha256, verifyRequest.executableSha256,
  'executable authority is correlated to every requested identity field');

throwsCode(() => parseResponse(Buffer.from(JSON.stringify({
  version: 1,
  requestId: null,
  ok: false,
  error: {
    code: 'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED',
    message: 'Launcher foundation client is not authorized'
  }
})), 'request-1'), 'PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED',
'client preserves the exact pre-authentication unauthorized failure');
throwsCode(() => parseResponse(Buffer.from(JSON.stringify({
  version: 1,
  requestId: null,
  ok: false,
  error: {
    code: 'PROCESS_ROOTFS_UNKNOWN',
    message: 'missing'
  }
})), 'request-1'), 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
'null correlation is forbidden for ordinary typed failures');

const operationIdentity = `process-operation:${'a'.repeat(64)}`;
equal(buildLauncherOperationRequest({ operationIdentity }), { operationIdentity },
  'get/cancel request accepts only one canonical operation identity');
throwsCode(() => buildLauncherOperationRequest({
  operationIdentity,
  pid: 123
}), 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
'operation lookup rejects a client-selected PID');
const privateResult = {
  operationIdentity,
  terminalOutcome: 'completed',
  startedAt: '2026-07-28T10:00:00.000Z',
  endedAt: '2026-07-28T10:00:01.000Z',
  durationMs: 1000,
  exitCode: 0,
  signal: null,
  stdoutBytes: 1,
  stderrBytes: 2,
  combinedOutputBytes: 3,
  stdoutSha256: 'a'.repeat(64),
  stderrSha256: 'b'.repeat(64),
  resourceCause: null,
  enforcementCause: null,
  cpuThrottledEvents: 2,
  launcherEnvironment: {
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp'
  }
};
equal(normalizePrivateExecutionResult(privateResult, operationIdentity), privateResult,
  'bounded private terminal result validates exact stream counts and fixed environment');
equal(normalizePrivateOperationStatus({
  operationIdentity,
  state: 'terminal',
  result: privateResult
}, operationIdentity).result, privateResult,
'private operation lookup binds its terminal result to the requested identity');
throwsCode(() => normalizePrivateExecutionResult({
  ...privateResult,
  resourceCause: 'cpu',
  terminalOutcome: 'resource_limit_exceeded'
}), 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
'CPU throttling cannot be misreported as a terminal resource cause');

equal(CURRENT_PROCESS_SANDBOX_CAPABILITY, null,
  'runtime sandbox capability remains null');
ok(!fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')
  .includes('process-launcher-foundation'),
'launcher foundation remains disconnected from server and model dispatch');
for (const code of [
  'PROCESS_LAUNCHER_ALREADY_RUNNING',
  'PROCESS_ROOTFS_MANIFEST_MISMATCH',
  'PROCESS_EXECUTABLE_IDENTITY_MISMATCH',
  'PROCESS_SANDBOX_PREREQUISITES_EXPIRED'
]) {
  ok(PROCESS_LAUNCHER_FOUNDATION_FAILURE_CODES.includes(code),
    `typed launcher failure is registered: ${code}`);
}
ok(new ProcessLauncherFoundationError('x') instanceof Error,
  'launcher foundation exposes one typed runtime error');

(async () => {
  const inspected = await inspectProcessSandboxPrerequisites({
    launcherFoundationClient: {
      async health(options) {
        equal(options, { observedAt },
          'trusted inspection passes one observation time to launcher validation');
        return containmentHealth();
      }
    },
    materializerClient: {
      async health() {
        return materializer;
      }
    },
    observedAt
  });
  equal(inspected, containmentHealth(),
    'trusted inspection returns the exact active containment generation');
  console.log(`\nPASS: process launcher foundation contract — ${passed} assertions`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
