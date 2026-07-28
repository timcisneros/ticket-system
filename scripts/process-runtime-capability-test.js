#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  buildProcessPolicySnapshot
} = require('../runtime/process-execution-contract');
const {
  PROCESS_ENABLED_RELEASE_GATES,
  ProcessRuntimeCapabilityResolver,
  normalizeProcessRuntimeCapabilityDescriptor
} = require('../runtime/process-runtime-capability');

let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
  passed += 1;
  console.log(`  ok ${message}`);
}
async function rejectsCode(operation, code, message) {
  await assert.rejects(operation, error => error && error.code === code);
  passed += 1;
  console.log(`  ok ${message}`);
}

const rootfsGeneration = `rootfs-registry-v1-${'4'.repeat(64)}`;
const materializerGeneration = `materializer-v1-${'5'.repeat(64)}`;
const profile = {
  targetId: 'ticket-system-local',
  profileId: 'syntax-check',
  allowedPhases: ['verification'],
  runtimeRootfs: {
    id: 'node-24-fedora-runtime-v1',
    manifestSha256: 'a'.repeat(64)
  },
  executableIdentity: {
    path: '/usr/bin/node',
    sha256: 'b'.repeat(64),
    format: 'elf'
  },
  arguments: ['--check', 'server.js'],
  workingDirectory: '.',
  environment: { CI: '1' },
  filesystemPolicy: {
    inputMode: 'materialized_read_only',
    writableRoots: [],
    allowSymlinks: false,
    allowSpecialFiles: false,
    maxInputFiles: 10000,
    maxInputBytes: 268435456
  },
  limits: {
    wallTimeMs: 30000,
    maxOutputBytes: 1048576,
    maxProcesses: 8,
    memoryBytes: 268435456,
    cpuQuotaMicrosPer100ms: 100000,
    maxOpenFiles: 128,
    maxFileBytes: 16777216,
    maxTempBytes: 67108864
  },
  executionPolicy: {
    shell: false,
    stdin: 'disabled',
    detached: false,
    networkAccess: 'none',
    environmentMode: 'replace'
  }
};
const snapshot = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_VERSION,
  capabilityEnabled: true,
  profiles: [profile],
  capturedAt: '2026-07-28T12:00:00.000Z'
});

function fixture({ now = Date.now(), containmentOverrides = {}, calls = null } = {}) {
  const count = calls || {
    schema: 0, artifact: 0, materializer: 0, health: 0, rootfs: 0, executable: 0
  };
  const containment = {
    version: 1,
    status: 'containment_verified',
    generationId: `sandbox-containment-v1-${'c'.repeat(64)}`,
    launcherProtocolVersion: 1,
    launcherIdentityHash: '1'.repeat(64),
    sandboxBackendIdentityHash: '2'.repeat(64),
    seccompPolicyHash: '3'.repeat(64),
    rootfsRegistryGeneration: rootfsGeneration,
    materializerGeneration,
    delegatedCgroupIdentityHash: '8'.repeat(64),
    containmentProbeHash: '9'.repeat(64),
    verifiedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    readyForExecution: true,
    ...containmentOverrides
  };
  const repository = {
    async isProcessExecutionSchemaAvailable() {
      count.schema += 1;
      return true;
    }
  };
  const artifactStore = {
    async health() {
      count.artifact += 1;
      return { version: 1, status: 'writable' };
    }
  };
  const materializerClient = {
    async health() {
      count.materializer += 1;
      return {
        materializerGeneration,
        materializerIdentityHash: '6'.repeat(64),
        inputPolicyHash: '7'.repeat(64),
        manifestSchemaVersion: 1,
        registrySchemaVersion: 1
      };
    }
  };
  const launcherClient = {
    async health() {
      count.health += 1;
      return containment;
    },
    async getRootfs(request) {
      count.rootfs += 1;
      return {
        id: request.rootfsId,
        manifestSha256: request.rootfsManifestSha256,
        physicalIdentityHash: 'd'.repeat(64),
        entryCount: 12,
        totalRegularBytes: 1234,
        rootfsRegistryGeneration: rootfsGeneration
      };
    },
    async verifyExecutable(request) {
      count.executable += 1;
      return {
        rootfsId: request.rootfsId,
        rootfsManifestSha256: request.rootfsManifestSha256,
        executablePath: request.executablePath,
        executableSha256: request.executableSha256,
        format: 'elf',
        rootfsRegistryGeneration: rootfsGeneration
      };
    }
  };
  return {
    count,
    containment,
    resolver: new ProcessRuntimeCapabilityResolver({
      featureEnabled: true,
      repository,
      artifactStore,
      materializerClient,
      launcherClient,
      releaseGates: [...PROCESS_ENABLED_RELEASE_GATES]
    })
  };
}

async function main() {
  const disabledCalls = {};
  const disabled = new ProcessRuntimeCapabilityResolver({
    featureEnabled: false,
    repository: {
      async isProcessExecutionSchemaAvailable() {
        disabledCalls.schema = true;
        return true;
      }
    }
  });
  await rejectsCode(
    () => disabled.resolve(snapshot),
    'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE',
    'process execution remains default-off before native or storage health is touched'
  );
  ok(disabledCalls.schema !== true,
    'disabled capability performs no lifecycle or launcher probe');

  const healthy = fixture();
  const first = await healthy.resolver.resolve(snapshot);
  ok(first.readyForExecution === true &&
    /^process-runtime-v1-[0-9a-f]{64}$/.test(first.generationId),
  'all runtime prerequisites publish one closed runtime capability');
  ok(Object.isFrozen(first), 'runtime capability descriptors are immutable');
  ok(healthy.count.schema === 1 && healthy.count.artifact === 1 &&
    healthy.count.materializer === 1 && healthy.count.rootfs === 1 &&
    healthy.count.executable === 1,
  'capability resolution checks database, artifact, materializer, rootfs, and executable health');

  const refreshedFixture = fixture({
    containmentOverrides: {
      verifiedAt: new Date(Date.now() - 500).toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString()
    }
  });
  const refreshed = await refreshedFixture.resolver.resolve(snapshot);
  ok(refreshed.generationId === first.generationId &&
    refreshed.expiresAt !== first.expiresAt,
  'fresh health with unchanged authority renews expiry without changing generation');
  const launchAuthority = await refreshedFixture.resolver.resolveLaunchAuthority(
    snapshot,
    refreshed.generationId
  );
  ok(launchAuthority.runtimeCapability.generationId === refreshed.generationId &&
    launchAuthority.sandboxCapability.generationId ===
      refreshed.containmentGenerationId,
  'launch authority re-probes and binds the exact admitted generation');

  await rejectsCode(
    () => refreshedFixture.resolver.resolveLaunchAuthority(
      snapshot,
      `process-runtime-v1-${'0'.repeat(64)}`
    ),
    'PROCESS_RUNTIME_CAPABILITY_MISMATCH',
    'an admitted runtime-generation mismatch denies launch'
  );

  const expired = fixture({
    now: Date.now() - 120_000,
    containmentOverrides: {
      verifiedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString()
    }
  });
  await rejectsCode(
    () => expired.resolver.resolve(snapshot),
    'PROCESS_CONTAINMENT_EXPIRED',
    'expired containment health denies a new launch'
  );

  const materializerMismatch = fixture({
    containmentOverrides: {
      materializerGeneration: `materializer-v1-${'0'.repeat(64)}`
    }
  });
  await rejectsCode(
    () => materializerMismatch.resolver.resolve(snapshot),
    'PROCESS_RUNTIME_CAPABILITY_MISMATCH',
    'materializer and containment generation mismatch fails closed'
  );

  const missingGateFixture = fixture();
  missingGateFixture.resolver.releaseGates = [];
  await rejectsCode(
    () => missingGateFixture.resolver.resolve(snapshot),
    'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE',
    'mandatory process-enabled release gates cannot be omitted'
  );

  const malformed = { ...first, readyForExecution: false };
  assert.throws(
    () => normalizeProcessRuntimeCapabilityDescriptor(malformed),
    error => error && error.code === 'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE'
  );
  passed += 1;
  console.log('  ok malformed or non-ready runtime capability cannot authorize execution');

  console.log(`PASS: process runtime capability (${passed} assertions)`);
}

main().catch(error => {
  console.error(`FAIL: process runtime capability — ${error.stack || error.message}`);
  process.exit(1);
});
