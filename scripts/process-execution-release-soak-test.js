#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision
} = require('../runtime/completion-decision-contract');
const {
  PROCESS_LAUNCHER_ENVIRONMENT
} = require('../runtime/process-authority-constants');
const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  buildProcessOperationIdentity,
  buildProcessPolicySnapshot,
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  ProcessExecutionController
} = require('../runtime/process-execution-controller');
const {
  compactEligibleLauncherOperations
} = require('../runtime/process-launcher-retention');
const {
  ProcessOutputArtifactStore
} = require('../runtime/process-output-artifact-store');
const {
  normalizeProcessRuntimeCapabilityDescriptor
} = require('../runtime/process-runtime-capability');
const { buildRuntimeBudgetSnapshot } = require('../runtime/runtime-budget-contract');
const { withHarness, sleep } = require('./postgres-test-harness');

const PROCESS_CONCURRENCY = 2;
const FULL_RECORD_CAPACITY = 4;
const COMPACT_TOMBSTONE_CAPACITY = 16;
const PROCESS_COUNT = 5;
const MAX_DURATION_MS = 45_000;
const MAX_POOL_CONNECTIONS = 6;
const MAX_EVENTS_PER_OPERATION = 32;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
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
      maxInputFiles: 10_000,
      maxInputBytes: 268_435_456
    },
    limits: {
      wallTimeMs: 30_000,
      maxOutputBytes: 1_048_576,
      maxProcesses: 8,
      memoryBytes: 268_435_456,
      cpuQuotaMicrosPer100ms: 100_000,
      maxOpenFiles: 128,
      maxFileBytes: 16_777_216,
      maxTempBytes: 67_108_864
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

function runtimeBudget() {
  return buildRuntimeBudgetSnapshot({
    runtimeLimits: {
      maxAttempts: 2,
      maxExecutionSteps: 12,
      maxModelRequestsPerRun: 4,
      maxWorkspaceOperationsPerRun: 4,
      maxProcessOperationsPerRun: 2,
      maxBrowserOperationsPerRun: 2,
      maxRuntimeDurationMs: 120_000,
      maxOutputArtifactBytesPerRun: 1_048_576,
      revision: 23
    },
    executionPolicy: {
      mode: 'assisted',
      requireVerification: 'when_declared',
      autoRetry: false,
      maxAttempts: null,
      maxExecutionSteps: null,
      maxRuntimeMs: null,
      maxModelRequests: null,
      maxWorkspaceOperations: null,
      maxProcessOperations: null,
      maxBrowserOperations: null,
      maxOutputArtifactBytes: null,
      allowWorkspaceWrites: true,
      allowParallelRuns: true,
      allowChildTickets: false,
      workspaceScope: 'shared'
    }
  });
}

function runtimeAuthority() {
  const now = Date.now();
  const processPolicySnapshot = buildProcessPolicySnapshot({
    version: PROCESS_POLICY_SNAPSHOT_VERSION,
    capabilityEnabled: true,
    profiles: [profile()],
    capturedAt: new Date(now - 1000).toISOString()
  });
  const sandboxCapability = {
    version: 1,
    status: 'containment_verified',
    generationId: `sandbox-containment-v1-${'c'.repeat(64)}`,
    launcherProtocolVersion: 1,
    launcherIdentityHash: '1'.repeat(64),
    sandboxBackendIdentityHash: '2'.repeat(64),
    seccompPolicyHash: '3'.repeat(64),
    rootfsRegistryGeneration: `rootfs-registry-v1-${'4'.repeat(64)}`,
    materializerGeneration: `materializer-v1-${'5'.repeat(64)}`,
    delegatedCgroupIdentityHash: '6'.repeat(64),
    containmentProbeHash: '7'.repeat(64),
    maxActiveOperations: PROCESS_CONCURRENCY,
    verifiedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 4 * 60_000).toISOString(),
    readyForExecution: true
  };
  const generationAuthority = {
    controllerProtocolVersion: 1,
    databaseSchemaVersion: 29,
    artifactPublicationContractVersion: 1,
    containmentGenerationId: sandboxCapability.generationId,
    materializerGeneration: sandboxCapability.materializerGeneration,
    rootfsRegistryGeneration: sandboxCapability.rootfsRegistryGeneration,
    launcherProtocolVersion: 1
  };
  const runtimeCapability = normalizeProcessRuntimeCapabilityDescriptor({
    version: 1,
    status: 'runtime_verified',
    generationId:
      `process-runtime-v1-${hashProcessContractValue(generationAuthority)}`,
    ...generationAuthority,
    verifiedAt: sandboxCapability.verifiedAt,
    expiresAt: sandboxCapability.expiresAt,
    readyForExecution: true
  });
  return {
    processPolicySnapshot,
    sandboxCapability,
    runtimeCapability
  };
}

class MeasuredMaterializerFixture {
  constructor(materializerGeneration) {
    this.materializerGeneration = materializerGeneration;
    this.snapshots = new Map();
    this.materializationCount = 0;
    this.configuration = {
      workspaceAllocationId: 'primary-workspace'
    };
  }

  async health() {
    return {
      materializerGeneration: this.materializerGeneration,
      materializerIdentityHash: '8'.repeat(64),
      inputPolicyHash: '9'.repeat(64),
      manifestSchemaVersion: 1,
      registrySchemaVersion: 1
    };
  }

  async materialize(request) {
    const current = this.snapshots.get(request.operationIdentity);
    if (current) return structuredClone(current);
    this.materializationCount += 1;
    const descriptor = {
      id: `workspace-snapshot-${sha256(Buffer.from(request.operationIdentity)).slice(0, 24)}`,
      runId: request.runId,
      policySnapshotHash: request.policySnapshotHash,
      materializerGeneration: request.materializerGeneration,
      manifestSha256: sha256(Buffer.from(`manifest:${request.operationIdentity}`)),
      fileCount: 2,
      totalBytes: 128
    };
    this.snapshots.set(request.operationIdentity, descriptor);
    return structuredClone(descriptor);
  }

  async getSnapshot(request) {
    const descriptor = this.snapshots.get(request.expectedOperationIdentity);
    if (!descriptor || descriptor.id !== request.snapshotId) {
      const error = new Error('snapshot missing');
      error.code = 'PROCESS_INPUT_SNAPSHOT_NOT_FOUND';
      throw error;
    }
    return structuredClone(descriptor);
  }
}

class MeasuredLauncherFixture {
  constructor() {
    this.records = new Map();
    this.launchCalls = new Map();
    this.cancellationInvocations = 0;
    this.cancellationEffects = 0;
    this.acknowledgementEffects = 0;
    this.compactionEffects = 0;
    this.restartCount = 0;
    this.activeDescendants = new Set();
    this.operationCgroups = new Set();
    this.naturalRaceIdentities = new Set();
  }

  metrics() {
    const fullRecordCount = [...this.records.values()]
      .filter(record => !record.compacted).length;
    const compactTombstoneCount = this.records.size - fullRecordCount;
    return {
      fullRecordCount,
      compactTombstoneCount,
      fullRecordCapacity: FULL_RECORD_CAPACITY,
      compactTombstoneCapacity: COMPACT_TOMBSTONE_CAPACITY,
      fullRecordCapacityRemaining:
        Math.max(0, FULL_RECORD_CAPACITY - fullRecordCount),
      compactTombstoneCapacityRemaining:
        Math.max(0, COMPACT_TOMBSTONE_CAPACITY - compactTombstoneCount),
      activeOperations: this.activeDescendants.size,
      activeDescendants: this.activeDescendants.size,
      operationCgroups: this.operationCgroups.size,
      inMemoryRegistryCount: this.records.size
    };
  }

  status(record) {
    return structuredClone({
      operationIdentity: record.operationIdentity,
      state: record.state,
      launcherAcceptanceIdentity: record.launcherAcceptanceIdentity,
      terminalResultHash: record.terminalResultHash,
      outputAvailable: record.outputAvailable,
      result: record.result
    });
  }

  async launch({ launchPlan, containmentGenerationId }) {
    const existing = this.records.get(launchPlan.operationIdentity);
    if (existing) {
      if (existing.launchPlanHash !== launchPlan.launchPlanHash ||
          existing.containmentGenerationId !== containmentGenerationId) {
        const error = new Error('launcher identity is bound to other authority');
        error.code = 'PROCESS_EXECUTION_INTENT_CONFLICT';
        throw error;
      }
      return this.status(existing);
    }
    const metrics = this.metrics();
    if (metrics.fullRecordCount >= FULL_RECORD_CAPACITY) {
      const error = new Error('launcher full-record registry is full');
      error.code = 'PROCESS_LAUNCHER_REGISTRY_FULL';
      throw error;
    }
    if (metrics.activeOperations >= PROCESS_CONCURRENCY) {
      const error = new Error('launcher active operation capacity is full');
      error.code = 'PROCESS_LAUNCHER_CAPACITY_UNAVAILABLE';
      throw error;
    }
    const operationIdentity = launchPlan.operationIdentity;
    const suffix = operationIdentity.slice(-12);
    const stdout = Buffer.from(`stdout:${suffix}\n`);
    const stderr = Buffer.from(`stderr:${suffix}\n`);
    const record = {
      operationIdentity,
      launchPlan: structuredClone(launchPlan),
      launchPlanHash: launchPlan.launchPlanHash,
      containmentGenerationId,
      launcherAcceptanceIdentity:
        `process-launcher-acceptance:${sha256(Buffer.from(`accept:${operationIdentity}`))}`,
      state: 'active',
      terminalResultHash: null,
      result: null,
      outputAvailable: false,
      outputAcknowledged: false,
      compacted: false,
      durableFinalizationHash: null,
      stdout,
      stderr
    };
    this.records.set(operationIdentity, record);
    this.launchCalls.set(
      operationIdentity,
      (this.launchCalls.get(operationIdentity) || 0) + 1
    );
    this.activeDescendants.add(operationIdentity);
    this.operationCgroups.add(operationIdentity);
    return this.status(record);
  }

  terminalize(operationIdentity, terminalOutcome, {
    outputComplete = true,
    enforcementCause = null
  } = {}) {
    const record = this.records.get(operationIdentity);
    if (!record) {
      const error = new Error('launcher operation missing');
      error.code = 'PROCESS_OPERATION_NOT_FOUND';
      throw error;
    }
    if (record.state === 'terminal') return this.status(record);
    const ended = new Date();
    const stdout = outputComplete ? record.stdout : Buffer.alloc(0);
    const stderr = outputComplete ? record.stderr : Buffer.alloc(0);
    const result = {
      operationIdentity,
      terminalOutcome,
      startedAt: new Date(ended.getTime() - 20).toISOString(),
      endedAt: ended.toISOString(),
      durationMs: 20,
      exitCode: terminalOutcome === 'completed' ? 0 : null,
      signal: null,
      stdoutBytes: stdout.length,
      stderrBytes: stderr.length,
      combinedOutputBytes: stdout.length + stderr.length,
      stdoutSha256: sha256(stdout),
      stderrSha256: sha256(stderr),
      outputComplete,
      resourceCause: null,
      enforcementCause,
      cpuThrottledEvents: 1,
      launcherEnvironment: { ...PROCESS_LAUNCHER_ENVIRONMENT }
    };
    record.state = 'terminal';
    record.result = result;
    record.terminalResultHash = hashProcessContractValue(result);
    record.outputAvailable = outputComplete;
    this.activeDescendants.delete(operationIdentity);
    this.operationCgroups.delete(operationIdentity);
    return this.status(record);
  }

  async getOperation({ operationIdentity }) {
    const record = this.records.get(operationIdentity);
    if (!record) {
      const error = new Error('launcher operation missing');
      error.code = 'PROCESS_OPERATION_NOT_FOUND';
      throw error;
    }
    return this.status(record);
  }

  async cancelOperation({ operationIdentity }) {
    this.cancellationInvocations += 1;
    const record = this.records.get(operationIdentity);
    if (!record) {
      const error = new Error('launcher operation missing');
      error.code = 'PROCESS_OPERATION_NOT_FOUND';
      throw error;
    }
    if (record.state === 'terminal') return this.status(record);
    if (this.naturalRaceIdentities.has(operationIdentity)) {
      return this.terminalize(operationIdentity, 'completed');
    }
    this.cancellationEffects += 1;
    return this.terminalize(operationIdentity, 'cancelled', {
      enforcementCause: 'cancellation_requested'
    });
  }

  async readOutput(request) {
    const record = this.records.get(request.operationIdentity);
    if (!record || record.state !== 'terminal' || !record.outputAvailable) {
      const error = new Error('launcher output unavailable');
      error.code = 'PROCESS_OUTPUT_UNAVAILABLE';
      throw error;
    }
    const bytes = request.stream === 'stdout' ? record.stdout : record.stderr;
    const end = Math.min(bytes.length, request.offset + request.maximumBytes);
    return {
      operationIdentity: request.operationIdentity,
      stream: request.stream,
      offset: request.offset,
      totalBytes: bytes.length,
      sha256: sha256(bytes),
      bytes: bytes.subarray(request.offset, end),
      end: end === bytes.length
    };
  }

  async acknowledgeOutput({ operationIdentity, terminalResultHash }) {
    const record = this.records.get(operationIdentity);
    if (!record || record.terminalResultHash !== terminalResultHash) {
      const error = new Error('launcher output acknowledgement conflict');
      error.code = 'PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED';
      throw error;
    }
    if (!record.outputAcknowledged) {
      this.acknowledgementEffects += 1;
      record.outputAcknowledged = true;
      record.outputAvailable = false;
    }
    return this.status(record);
  }

  async compactOperation({
    operationIdentity,
    terminalResultHash,
    durableFinalizationHash
  }) {
    const record = this.records.get(operationIdentity);
    if (!record || record.state !== 'terminal' ||
        record.terminalResultHash !== terminalResultHash ||
        !record.outputAcknowledged) {
      const error = new Error('launcher record lacks compaction authority');
      error.code = 'PROCESS_LAUNCHER_REGISTRY_INVALID';
      throw error;
    }
    if (record.compacted) {
      if (record.durableFinalizationHash !== durableFinalizationHash) {
        const error = new Error('compacted authority conflict');
        error.code = 'PROCESS_LAUNCHER_REGISTRY_INVALID';
        throw error;
      }
      return this.status(record);
    }
    if (this.metrics().compactTombstoneCount >= COMPACT_TOMBSTONE_CAPACITY) {
      const error = new Error('launcher compact-tombstone registry is full');
      error.code = 'PROCESS_LAUNCHER_REGISTRY_FULL';
      throw error;
    }
    record.compacted = true;
    record.durableFinalizationHash = durableFinalizationHash;
    this.compactionEffects += 1;
    return this.status(record);
  }

  restart() {
    this.restartCount += 1;
    for (const operationIdentity of [...this.activeDescendants]) {
      this.terminalize(operationIdentity, 'runtime_interrupted', {
        outputComplete: false,
        enforcementCause: 'launcher_restart'
      });
    }
  }
}

function artifactProjection(receipt) {
  return {
    operationIdentity: receipt.operationIdentity,
    operation: 'runProcess',
    targetId: receipt.targetId,
    profileId: receipt.profileId,
    outcome: receipt.terminalOutcome === 'completed'
      ? 'succeeded'
      : 'failed',
    terminalOutcome: receipt.terminalOutcome,
    terminalResultHash: receipt.terminalResultHash,
    ...(receipt.stdoutArtifact
      ? { stdoutArtifact: receipt.stdoutArtifact }
      : {}),
    ...(receipt.stderrArtifact
      ? { stderrArtifact: receipt.stderrArtifact }
      : {})
  };
}

async function createRunFixture(store, agent, authority, label) {
  const objective = `Release soak process ${label}`;
  const ticket = (await store.createTicketWithEvent({
    ticket: {
      status: 'in_progress',
      title: objective,
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    }
  })).ticket;
  const completionAuthoritySnapshot = buildCompletionAuthoritySnapshot({
    objective,
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required',
    verificationPolicy: 'when_declared',
    capturedAt: new Date().toISOString()
  });
  const leaseOwner = `release-soak-${label}-${crypto.randomBytes(4).toString('hex')}`;
  let run = await store.createRun({
    ticketId: ticket.id,
    agentId: agent.id,
    status: 'pending',
    executionMode: 'agent',
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    processPolicySnapshot: authority.processPolicySnapshot,
    processRuntimeCapabilitySnapshot: authority.runtimeCapability,
    runtimeBudgetSnapshot: runtimeBudget(),
    completionAuthoritySnapshot,
    executionPolicySnapshot: {
      requireVerification: 'when_declared'
    }
  });
  run = (await store.transitionRun({
    runId: run.id,
    expectedRevision: run.revision,
    fromStatuses: ['pending'],
    toStatus: 'running',
    leaseOwner,
    eventType: 'run.started',
    eventPayload: { source: 'process-execution-release-soak-test' }
  })).run;
  run = (await store.advanceRunPhase({
    runId: run.id,
    leaseOwner,
    fromPhase: 'planning',
    toPhase: 'verification',
    stepId: '1',
    reason: 'trusted release soak fixture'
  })).run;
  await store.initializeRunReplay({
    runId: run.id,
    ticketId: ticket.id,
    snapshot: {
      runId: run.id,
      ticketId: ticket.id,
      events: [],
      parsedModelPlans: [{ complete: false }],
      providerRequests: [],
      modelResponses: [],
      workspaceOperations: [],
      processExecutionLifecycle: []
    }
  });
  const operationId = `soak-${label}`;
  return {
    label,
    ticket,
    run,
    leaseOwner,
    operationId,
    operationIdentity: buildProcessOperationIdentity(run.id, operationId),
    action: {
      operation: 'runProcess',
      args: {
        targetId: 'ticket-system-local',
        profileId: 'syntax-check',
        operationId
      }
    }
  };
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`PROCESS_RELEASE_SOAK_TIMEOUT: ${label}`);
}

async function acquireCapacity(repository, fixture) {
  return repository.acquireRuntimeCapacity({
    capacityDomain: 'process_launcher',
    resourceKey: 'sandbox-containment-release-soak',
    limit: PROCESS_CONCURRENCY,
    leaseOwner: fixture.leaseOwner,
    runId: fixture.run.id,
    operationIdentity: fixture.operationIdentity,
    leaseDurationMs: 5 * 60_000,
    sourceIdentity: fixture.operationIdentity,
    waitRetryMs: 100
  });
}

async function releaseCapacity(repository, fixture, slot) {
  return repository.releaseRuntimeCapacity({
    capacityDomain: 'process_launcher',
    resourceKey: 'sandbox-containment-release-soak',
    slotNumber: slot.slotNumber,
    leaseOwner: fixture.leaseOwner,
    runId: fixture.run.id,
    operationIdentity: fixture.operationIdentity,
    reason: 'release_soak_operation_settled'
  });
}

function buildController({
  repository,
  authority,
  materializer,
  launcher,
  artifactRoot
}) {
  return new ProcessExecutionController({
    repository,
    capabilityResolver: {
      async resolve() {
        return authority.runtimeCapability;
      },
      async resolveLaunchAuthority(_snapshot, expectedGeneration) {
        if (expectedGeneration !== authority.runtimeCapability.generationId) {
          const error = new Error('runtime capability mismatch');
          error.code = 'PROCESS_RUNTIME_CAPABILITY_MISMATCH';
          throw error;
        }
        return {
          runtimeCapability: authority.runtimeCapability,
          sandboxCapability: authority.sandboxCapability
        };
      }
    },
    materializerClient: materializer,
    launcherClient: launcher,
    artifactStore: new ProcessOutputArtifactStore({ artifactRoot }),
    workspaceTargetId: 'local-workspace'
  });
}

async function finalizeRun(store, fixture) {
  const operation = await store.getProcessOperation(fixture.operationIdentity);
  const receipts = await store.listOperationReceipts(fixture.run.id, {
    limit: 20
  });
  assert.equal(receipts.length, 1);
  const projection = artifactProjection(receipts[0].receipt);
  const eventsBefore = await store.listRunEvents(fixture.run.id, { limit: 500 });
  const replay = await store.getReplaySnapshot(fixture.run.id);
  const infrastructureFailure = operation.terminalOutcome === 'runtime_interrupted'
    ? {
        code: 'PROCESS_EXECUTION_LAUNCHER_RESTARTED',
        kind: 'infrastructure_failure'
      }
    : null;
  const status = operation.terminalOutcome === 'cancelled'
    ? 'interrupted'
    : infrastructureFailure
      ? 'failed'
      : 'completed';
  const endedAt = operation.terminalAt || new Date().toISOString();
  const replaySnapshot = {
    ...replay.snapshot,
    terminalStatus: status,
    finalizedAt: endedAt,
    ...(infrastructureFailure ? { failure: infrastructureFailure } : {})
  };
  const terminalized = await store.terminalizeRun({
    runId: fixture.run.id,
    expectedRevision: fixture.run.revision,
    expectedReplayRevision: replay.revision,
    fromStatuses: ['running'],
    status,
    leaseOwner: fixture.leaseOwner,
    patch: {
      currentPhase: 'terminalization',
      ...(infrastructureFailure
        ? { errorCode: infrastructureFailure.code, failure: infrastructureFailure }
        : {})
    },
    replaySnapshot,
    evaluation: {
      effectiveness: { status: 'unknown' },
      violations: { status: 'none' },
      browserEvidence: null
    },
    consequence: context => {
      const base = {
        version: 1,
        mutations: [],
        created: [],
        modified: [],
        updated: [],
        deleted: [],
        renamed: [],
        notifications: [],
        externalEffects: [],
        processOperations: [projection],
        verification: {
          postconditionsStatus: 'not_required',
          violationsStatus: 'none',
          browserEvidence: null
        }
      };
      return {
        ...base,
        completionDecision: buildCompletionDecision({
          run: context.run,
          replaySnapshot: context.replaySnapshot,
          events: [...eventsBefore, ...context.events],
          operations: [projection],
          consequence: base,
          verificationContract: null,
          evaluatedAt: endedAt
        })
      };
    },
    executionEvent: {
      type: status === 'completed'
        ? 'run.execution_completed'
        : 'run.execution_failed',
      payload: {
        status,
        ...(infrastructureFailure ? { failure: infrastructureFailure } : {})
      }
    },
    replayEvent: {
      type: 'run.snapshot_finalized',
      payload: { status, finalizedAt: endedAt }
    },
    beforeEvaluationEvents: [{
      type: 'run.violations_checked',
      payload: { status: 'none' }
    }],
    terminalEvent: {
      type: 'run.terminalized',
      payload: { status }
    }
  });
  return terminalized;
}

function countArtifactFiles(root) {
  let temporary = 0;
  let published = 0;
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name.endsWith('.tmp')) temporary += 1;
      else if (entry.isFile() && entry.name.endsWith('.bin')) published += 1;
    }
  };
  visit(root);
  return { temporary, published };
}

async function main() {
  const started = process.hrtime.bigint();
  await withHarness('measured process execution release soak', async ({
    store,
    databaseUrl,
    schema
  }) => {
    const peer = new PostgresRuntimeStore({
      connectionString: databaseUrl,
      schema,
      lockTimeoutMs: 10_000
    });
    const artifactRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'process-release-soak-artifacts-')
    );
    try {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `Release soak agent ${Date.now()}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: ''
        },
        groupIds: [],
        changedBy: 'process-execution-release-soak-test'
      })).agent;
      const authority = runtimeAuthority();
      const materializer = new MeasuredMaterializerFixture(
        authority.sandboxCapability.materializerGeneration
      );
      const launcher = new MeasuredLauncherFixture();
      const controllerA = buildController({
        repository: store,
        authority,
        materializer,
        launcher,
        artifactRoot
      });
      const controllerB = buildController({
        repository: peer,
        authority,
        materializer,
        launcher,
        artifactRoot
      });
      const fixtures = {};
      for (const label of ['success', 'cancel', 'race', 'restart', 'post-compact']) {
        fixtures[label] = await createRunFixture(store, agent, authority, label);
      }

      const successCapacity = await acquireCapacity(store, fixtures.success);
      const cancelCapacity = await acquireCapacity(peer, fixtures.cancel);
      assert.equal(successCapacity.acquired, true);
      assert.equal(cancelCapacity.acquired, true);
      const blockedCapacity = await acquireCapacity(store, fixtures.race);
      assert.equal(blockedCapacity.acquired, false,
        'third operation waits under configured process capacity');
      assert.equal(
        await store.getProcessOperation(fixtures.race.operationIdentity),
        null,
        'capacity waiting creates no premature process intent'
      );

      const successPromise = controllerA.execute({
        run: fixtures.success.run,
        action: fixtures.success.action,
        step: 1
      });
      const cancelPromise = controllerB.execute({
        run: fixtures.cancel.run,
        action: fixtures.cancel.action,
        step: 1
      });
      await waitFor(() =>
        launcher.activeDescendants.has(fixtures.success.operationIdentity) &&
        launcher.activeDescendants.has(fixtures.cancel.operationIdentity),
      'two operations active at launcher capacity');
      assert.equal(launcher.metrics().activeOperations, PROCESS_CONCURRENCY);

      launcher.terminalize(fixtures.success.operationIdentity, 'completed');
      await successPromise;
      assert.equal(await releaseCapacity(
        store,
        fixtures.success,
        successCapacity.slot
      ), true);
      const raceCapacity = await acquireCapacity(peer, fixtures.race);
      assert.equal(raceCapacity.acquired, true,
        'queued work acquires only after an owned capacity slot is released');
      const racePromise = controllerB.execute({
        run: fixtures.race.run,
        action: fixtures.race.action,
        step: 1
      });
      await waitFor(
        () => launcher.activeDescendants.has(fixtures.race.operationIdentity),
        'natural-completion race operation active'
      );

      const cancelRequest = controllerA.cancelRunOperations(
        fixtures.cancel.run,
        'authorized operator cancellation during release soak'
      );
      await Promise.all([cancelPromise, cancelRequest]);
      assert.equal(await releaseCapacity(
        peer,
        fixtures.cancel,
        cancelCapacity.slot
      ), true);

      launcher.naturalRaceIdentities.add(fixtures.race.operationIdentity);
      const naturalRaceCancellation = controllerA.cancelRunOperations(
        fixtures.race.run,
        'authorized cancellation racing natural completion'
      );
      await Promise.all([racePromise, naturalRaceCancellation]);
      assert.equal((await store.getProcessOperation(
        fixtures.race.operationIdentity
      )).terminalOutcome, 'completed',
      'natural completion remains the launcher-authoritative race result');
      assert.equal(await releaseCapacity(
        peer,
        fixtures.race,
        raceCapacity.slot
      ), true);

      const restartCapacity = await acquireCapacity(store, fixtures.restart);
      assert.equal(restartCapacity.acquired, true);
      const restartPromise = controllerA.execute({
        run: fixtures.restart.run,
        action: fixtures.restart.action,
        step: 1
      });
      await waitFor(
        () => launcher.activeDescendants.has(fixtures.restart.operationIdentity),
        'launcher restart operation active'
      );
      const launchesBeforeRestart = launcher.launchCalls.get(
        fixtures.restart.operationIdentity
      );
      launcher.restart();
      await restartPromise;
      assert.equal(
        launcher.launchCalls.get(fixtures.restart.operationIdentity),
        launchesBeforeRestart,
        'launcher restart recovery does not relaunch accepted work'
      );
      assert.equal(await releaseCapacity(
        store,
        fixtures.restart,
        restartCapacity.slot
      ), true);

      for (const label of ['success', 'cancel', 'race', 'restart']) {
        await finalizeRun(store, fixtures[label]);
      }
      const beforeCompaction = launcher.metrics();
      assert.equal(beforeCompaction.fullRecordCount, FULL_RECORD_CAPACITY);
      assert.equal(beforeCompaction.fullRecordCapacityRemaining, 0);
      const compacted = await compactEligibleLauncherOperations({
        repository: store,
        launcherClient: launcher,
        limit: FULL_RECORD_CAPACITY
      });
      assert.equal(compacted.compacted.length, FULL_RECORD_CAPACITY);
      const afterCompaction = launcher.metrics();
      assert.equal(afterCompaction.compactTombstoneCount,
        beforeCompaction.compactTombstoneCount + FULL_RECORD_CAPACITY);
      assert.ok(afterCompaction.fullRecordCount < beforeCompaction.fullRecordCount);
      assert.ok(afterCompaction.fullRecordCapacityRemaining >
        beforeCompaction.fullRecordCapacityRemaining);

      const compactedIdentity = fixtures.success.operationIdentity;
      const compactedRecord = launcher.records.get(compactedIdentity);
      const launchesBeforeReplay = [...launcher.launchCalls.values()]
        .reduce((sum, value) => sum + value, 0);
      await launcher.launch({
        launchPlan: structuredClone(compactedRecord.launchPlan),
        containmentGenerationId: compactedRecord.containmentGenerationId
      });
      assert.equal(
        [...launcher.launchCalls.values()].reduce((sum, value) => sum + value, 0),
        launchesBeforeReplay,
        'exact compact-tombstone replay remains non-launching'
      );
      await assert.rejects(
        () => launcher.launch({
          launchPlan: {
            ...structuredClone(compactedRecord.launchPlan),
            launchPlanHash: 'e'.repeat(64)
          },
          containmentGenerationId: compactedRecord.containmentGenerationId
        }),
        error => error && error.code === 'PROCESS_EXECUTION_INTENT_CONFLICT'
      );

      const postCompactCapacity = await acquireCapacity(
        peer,
        fixtures['post-compact']
      );
      assert.equal(postCompactCapacity.acquired, true);
      const postCompactPromise = controllerB.execute({
        run: fixtures['post-compact'].run,
        action: fixtures['post-compact'].action,
        step: 1
      });
      await waitFor(
        () => launcher.activeDescendants.has(
          fixtures['post-compact'].operationIdentity
        ),
        'post-compaction operation accepted'
      );
      launcher.terminalize(
        fixtures['post-compact'].operationIdentity,
        'completed'
      );
      await postCompactPromise;
      assert.equal(await releaseCapacity(
        peer,
        fixtures['post-compact'],
        postCompactCapacity.slot
      ), true);
      await finalizeRun(store, fixtures['post-compact']);

      const operationRows = [];
      const eventCounts = {};
      const artifactStore = new ProcessOutputArtifactStore({ artifactRoot });
      for (const fixture of Object.values(fixtures)) {
        const operation = await store.getProcessOperation(
          fixture.operationIdentity
        );
        operationRows.push(operation);
        const receipts = await store.listOperationReceipts(fixture.run.id, {
          limit: 20
        });
        assert.equal(receipts.filter(receipt =>
          receipt.operation === 'runProcess' &&
          receipt.idempotencyKey === fixture.operationIdentity
        ).length, 1, 'each terminal process has exactly one generic receipt');
        const events = await store.listRunEvents(fixture.run.id, { limit: 500 });
        assert.equal(events.filter(event =>
          event.type === 'process.terminal' &&
          event.payload.operationIdentity === fixture.operationIdentity
        ).length, 1, 'each terminal process has exactly one terminal evidence record');
        assert.ok(events.filter(event =>
          event.type === 'run.completion_decided').length <= 1,
        'each terminal run has at most one completion decision');
        assert.ok((await store.getRunConsequence(fixture.run.id))
          .consequence.completionDecision.decisionHash);
        eventCounts[fixture.operationIdentity] = events.length;
        assert.ok(events.length <= MAX_EVENTS_PER_OPERATION,
          'event growth per one-operation run remains bounded');
        for (const artifact of [
          operation.stdoutArtifact,
          operation.stderrArtifact
        ].filter(Boolean)) {
          const verified = await artifactStore.verifyPublished(artifact);
          assert.equal(verified.byteCount, artifact.byteCount);
          assert.equal(verified.sha256, artifact.sha256);
        }
      }

      const uniqueIdentities = new Set(
        operationRows.map(operation => operation.operationIdentity)
      );
      const nativeLaunchCount = [...launcher.launchCalls.values()]
        .reduce((sum, value) => sum + value, 0);
      assert.equal(uniqueIdentities.size, PROCESS_COUNT);
      assert.equal(nativeLaunchCount, uniqueIdentities.size,
        'native launches equal unique newly accepted operations');
      assert.ok([...launcher.launchCalls.values()].every(count => count === 1),
        'no process operation launches twice');
      assert.equal(launcher.cancellationInvocations, 2);
      assert.equal(launcher.cancellationEffects, 1,
        'operator cancellation has one effect while natural completion wins its race');
      assert.equal(materializer.materializationCount, PROCESS_COUNT);
      assert.equal(launcher.restartCount, 1);

      const files = countArtifactFiles(artifactRoot);
      const durableArtifactCount = operationRows.reduce((count, operation) =>
        count +
        (operation.stdoutArtifact ? 1 : 0) +
        (operation.stderrArtifact ? 1 : 0), 0);
      assert.equal(files.temporary, 0);
      assert.equal(files.published, durableArtifactCount);
      const finalMetrics = launcher.metrics();
      assert.equal(finalMetrics.activeDescendants, 0);
      assert.equal(finalMetrics.operationCgroups, 0);
      assert.equal(finalMetrics.fullRecordCount, 1);
      assert.equal(finalMetrics.compactTombstoneCount, 4);
      assert.ok(finalMetrics.fullRecordCapacityRemaining > 0);

      const poolConnections = store.pool.totalCount + peer.pool.totalCount;
      assert.ok(poolConnections <= MAX_POOL_CONNECTIONS,
        `PostgreSQL pools remain within ${MAX_POOL_CONNECTIONS} allocated connections`);
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      assert.ok(durationMs <= MAX_DURATION_MS,
        `bounded soak converges within ${MAX_DURATION_MS}ms`);

      console.log(JSON.stringify({
        status: 'passed',
        durationMs: Math.round(durationMs),
        configuredProcessConcurrency: PROCESS_CONCURRENCY,
        uniqueProcessOperationIdentities: uniqueIdentities.size,
        nativeLauncherLaunchCount: nativeLaunchCount,
        launcherLaunchCounts: Object.fromEntries(launcher.launchCalls),
        launcherCancellationInvocationCount: launcher.cancellationInvocations,
        launcherCancellationEffectCount: launcher.cancellationEffects,
        genericRunProcessReceiptCount: operationRows.length,
        processTerminalEvidenceCount: operationRows.length,
        completionDecisionCount: Object.keys(eventCounts).length,
        fullLauncherRecordCountBeforeCompaction:
          beforeCompaction.fullRecordCount,
        fullLauncherRecordCountAfterCompaction:
          afterCompaction.fullRecordCount,
        fullLauncherRecordCountFinal: finalMetrics.fullRecordCount,
        compactTombstoneCountBefore:
          beforeCompaction.compactTombstoneCount,
        compactTombstoneCountAfter:
          afterCompaction.compactTombstoneCount,
        launcherCapacityRemaining: finalMetrics.fullRecordCapacityRemaining,
        activeDescendantCount: finalMetrics.activeDescendants,
        remainingProcessCgroupCount: finalMetrics.operationCgroups,
        temporaryArtifactFileCount: files.temporary,
        publishedArtifactFileCount: files.published,
        durableArtifactCount,
        postgresPoolConnectionCount: poolConnections,
        postgresPoolConnectionBound: MAX_POOL_CONNECTIONS,
        eventCountPerProcessOperation: eventCounts,
        eventCountBound: MAX_EVENTS_PER_OPERATION,
        launcherInMemoryRegistryCount: finalMetrics.inMemoryRegistryCount,
        launcherRestartCount: launcher.restartCount,
        materializationCount: materializer.materializationCount
      }));
    } finally {
      await peer.close();
      fs.rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
}

main().then(() => {
  console.log('PASS: measured bounded process execution release soak');
}).catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
