#!/usr/bin/env node
'use strict';

const assert = require('assert');

const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  buildProcessOperationIdentity,
  buildProcessPolicySnapshot
} = require('../runtime/process-execution-contract');
const {
  PROCESS_MATERIALIZER_FAILURE_CODES,
  ProcessMaterializerError,
  buildGetProcessSnapshotRequest,
  buildProcessMaterializationRequest,
  hashProcessFilesystemPolicy,
  normalizeMaterializerGeneration,
  normalizeProcessMaterializerClientConfig,
  normalizeWorkspaceSnapshotDescriptor,
  validateGetProcessSnapshotRequest,
  validateProcessMaterializationRequest
} = require('../runtime/process-materializer-contract');
const {
  materializeProcessExecutionInput
} = require('../runtime/process-input-materialization');
const {
  ProcessMaterializerClient,
  parseResponse
} = require('../runtime/process-materializer-client');

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
async function rejectsCode(callback, code, message) {
  await assert.rejects(callback, error => error && error.code === code, message);
  passed += 1;
  console.log(`  ok ${message}`);
}

function profile() {
  return {
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
}

const snapshot = buildProcessPolicySnapshot({
  version: PROCESS_POLICY_SNAPSHOT_VERSION,
  capabilityEnabled: true,
  profiles: [profile()],
  capturedAt: '2026-07-28T12:00:00.000Z'
});
const context = {
  runId: 123,
  ticketId: 45,
  currentPhase: 'verification',
  processPolicySnapshot: snapshot
};
const generation = {
  materializerGeneration: `materializer-v1-${'c'.repeat(64)}`,
  materializerIdentityHash: 'd'.repeat(64),
  inputPolicyHash: 'e'.repeat(64),
  manifestSchemaVersion: 1,
  registrySchemaVersion: 1
};

async function main() {
  const normalizedGeneration = normalizeMaterializerGeneration(generation);
  ok(Object.isFrozen(normalizedGeneration),
    'materializer generation is closed, normalized, and frozen');
  throwsCode(
    () => normalizeMaterializerGeneration({ ...generation, executablePath: '/host' }),
    'PROCESS_MATERIALIZER_REQUEST_INVALID',
    'materializer generation rejects extra host authority'
  );

  const request = buildProcessMaterializationRequest({
    workspaceAllocationId: 'primary-workspace',
    runId: context.runId,
    ticketId: context.ticketId,
    operationId: 'operation-001',
    policySnapshotHash: snapshot.snapshotHash,
    materializerGeneration: generation.materializerGeneration,
    filesystemPolicy: profile().filesystemPolicy
  });
  equal(
    request.operationIdentity,
    buildProcessOperationIdentity(context.runId, request.operationId),
    'materialization request derives operation identity from run and operation IDs'
  );
  ok(Object.isFrozen(request) && Object.isFrozen(request.filesystemPolicy),
    'materialization request is deeply immutable');
  equal(validateProcessMaterializationRequest(request), request,
    'closed materialization request validates deterministically');
  throwsCode(
    () => validateProcessMaterializationRequest({
      ...request,
      operationIdentity: buildProcessOperationIdentity(999, request.operationId)
    }),
    'PROCESS_MATERIALIZER_REQUEST_INVALID',
    'independent operation identity cannot override recomputation'
  );
  for (const [field, value] of [
    ['sourcePath', '/workspace'],
    ['destinationPath', '/sealed'],
    ['executable', '/usr/bin/node'],
    ['environment', { SECRET: 'value' }],
    ['mountOptions', ['bind']]
  ]) {
    throwsCode(
      () => validateProcessMaterializationRequest({ ...request, [field]: value }),
      'PROCESS_MATERIALIZER_REQUEST_INVALID',
      `materialization request rejects ${field}`
    );
  }

  const descriptor = {
    id: 'snapshot-001',
    runId: context.runId,
    policySnapshotHash: snapshot.snapshotHash,
    materializerGeneration: generation.materializerGeneration,
    manifestSha256: 'f'.repeat(64),
    fileCount: 2,
    totalBytes: 12
  };
  equal(normalizeWorkspaceSnapshotDescriptor(descriptor, {
    runId: context.runId,
    policySnapshotHash: snapshot.snapshotHash,
    materializerGeneration: generation.materializerGeneration
  }), descriptor, 'public descriptor is exact and bound to run, policy, and generation');
  throwsCode(
    () => normalizeWorkspaceSnapshotDescriptor({ ...descriptor, sealedPath: '/private' }),
    'PROCESS_MATERIALIZER_REQUEST_INVALID',
    'public descriptor cannot expose a sealed host path'
  );

  const getRequest = buildGetProcessSnapshotRequest({
    snapshotId: descriptor.id,
    runId: context.runId,
    ticketId: context.ticketId,
    operationId: request.operationId,
    policySnapshotHash: snapshot.snapshotHash,
    materializerGeneration: generation.materializerGeneration,
    filesystemPolicy: profile().filesystemPolicy
  });
  equal(getRequest.expectedFilesystemPolicyHash,
    hashProcessFilesystemPolicy(profile().filesystemPolicy),
    'getSnapshot derives the exact normalized filesystem-policy hash');
  equal(validateGetProcessSnapshotRequest(getRequest), getRequest,
    'getSnapshot recomputes and validates operation identity');
  throwsCode(
    () => validateGetProcessSnapshotRequest({
      ...getRequest,
      expectedOperationId: 'operation-002'
    }),
    'PROCESS_MATERIALIZER_REQUEST_INVALID',
    'another operation in the same run cannot substitute at getSnapshot'
  );

  const correlatedRequestId = 'request-parser-001';
  throwsCode(
    () => parseResponse(Buffer.from(JSON.stringify({
      version: 1,
      requestId: null,
      ok: false,
      error: {
        code: 'PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED',
        message: 'Materializer client is not authorized'
      }
    })), correlatedRequestId),
    'PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED',
    'the exact null-ID pre-authentication refusal preserves its typed unauthorized result'
  );
  for (const [requestId, code, message] of [
    [null, 'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'a null request ID with another code is protocol-invalid'],
    ['peer', 'PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED',
      'a synthetic peer request ID is not a pre-authentication envelope'],
    ['request-other', 'PROCESS_INPUT_SNAPSHOT_MISMATCH',
      'an ordinary mismatched request ID remains protocol-invalid']
  ]) {
    throwsCode(
      () => parseResponse(Buffer.from(JSON.stringify({
        version: 1,
        requestId,
        ok: false,
        error: { code, message: 'refused' }
      })), correlatedRequestId),
      'PROCESS_MATERIALIZER_PROTOCOL_INVALID',
      message
    );
  }
  throwsCode(
    () => parseResponse(Buffer.from(JSON.stringify({
      version: 1,
      requestId: correlatedRequestId,
      ok: false,
      error: {
        code: 'PROCESS_INPUT_SNAPSHOT_MISMATCH',
        message: 'snapshot mismatch'
      }
    })), correlatedRequestId),
    'PROCESS_INPUT_SNAPSHOT_MISMATCH',
    'an authorized correlated typed failure remains typed'
  );

  const clientConfig = normalizeProcessMaterializerClientConfig({
    version: 1,
    socketPath: '/run/ticket-system-process/materializer/materializer.sock',
    workspaceAllocationId: 'primary-workspace',
    timeoutMs: 120000
  });
  ok(Object.isFrozen(clientConfig) && !Object.hasOwn(clientConfig, 'sealedSnapshotRoot'),
    'Node client holds only the fixed socket and trusted allocation reference');
  const configuredClient = new ProcessMaterializerClient(clientConfig);
  const {
    operationIdentity: _derivedOperationIdentity,
    ...requestBuildInput
  } = request;
  await rejectsCode(
    () => configuredClient.materialize(buildProcessMaterializationRequest({
      ...requestBuildInput,
      workspaceAllocationId: 'another-workspace'
    })),
    'PROCESS_WORKSPACE_ALLOCATION_UNKNOWN',
    'Node client cannot override its trusted configured workspace allocation'
  );

  const order = [];
  const fakeBoundary = {
    async withWorkspaceMutationBoundary({ targetId }, callback) {
      equal(targetId, 'local-workspace',
        'materialization uses the physical workspace target boundary');
      order.push('boundary-acquired');
      const value = await callback();
      order.push('boundary-released');
      return value;
    }
  };
  const fakeClient = {
    configuration: clientConfig,
    async health() {
      order.push('health');
      return normalizedGeneration;
    },
    async materialize(actual) {
      order.push('materialize');
      equal(actual, request,
        'trusted integration derives the exact request from immutable run authority');
      return descriptor;
    },
    async getSnapshot(actual) {
      order.push('getSnapshot');
      equal(actual, getRequest,
        'trusted integration retrieves using every expected ownership field');
      return descriptor;
    }
  };
  const integrated = await materializeProcessExecutionInput({
    boundaryRepository: fakeBoundary,
    materializerClient: fakeClient,
    workspaceTargetId: 'local-workspace',
    launchAuthorityContext: context,
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    operationId: 'operation-001'
  });
  equal(integrated, descriptor,
    'trusted integration returns only the bound public descriptor');
  equal(order, [
    'boundary-acquired',
    'health',
    'materialize',
    'getSnapshot',
    'boundary-released'
  ], 'authority resolution, materialization, registry verification, and release stay inside boundary');

  await rejectsCode(
    () => materializeProcessExecutionInput({
      boundaryRepository: {
        async withWorkspaceMutationBoundary() {
          throw new Error('lock timeout');
        }
      },
      materializerClient: fakeClient,
      workspaceTargetId: 'local-workspace',
      launchAuthorityContext: context,
      targetId: 'ticket-system-local',
      profileId: 'syntax-check',
      operationId: 'operation-001'
    }),
    'PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE',
    'workspace mutation-boundary failure is typed and fail-closed'
  );
  ok(PROCESS_MATERIALIZER_FAILURE_CODES.length === 21 &&
    new Set(PROCESS_MATERIALIZER_FAILURE_CODES).size === 21,
  'all twenty-one materializer failures are stable and unique');
  ok(!PROCESS_MATERIALIZER_FAILURE_CODES.includes('PROCESS_EXECUTOR_UNAVAILABLE'),
    'materialization failures do not claim process execution');

  console.log(`\nPASS: process materializer contract — ${passed} assertions`);
}

main().catch(error => {
  if (error instanceof ProcessMaterializerError) {
    console.error(`${error.code}: ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
});
