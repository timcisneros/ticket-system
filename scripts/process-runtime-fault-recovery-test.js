#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROCESS_LAUNCHER_ENVIRONMENT
} = require('../runtime/process-authority-constants');
const {
  PROCESS_POLICY_SNAPSHOT_VERSION,
  buildProcessPolicySnapshot,
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  ProcessExecutionController
} = require('../runtime/process-execution-controller');
const {
  ProcessOutputArtifactStore
} = require('../runtime/process-output-artifact-store');
const {
  normalizeProcessRuntimeCapabilityDescriptor
} = require('../runtime/process-runtime-capability');

const CRASH_WINDOWS = Object.freeze([
  'after_process_intent_commit_before_launcher_call',
  'after_launcher_acceptance_before_active_state_commit',
  'after_child_release_before_start_evidence',
  'after_launcher_terminal_before_finalizing_commit',
  'during_process_stdout_artifact_transfer',
  'after_artifact_publication_before_database_binding',
  'after_terminal_database_commit_before_required_evidence',
  'after_required_evidence_before_action_response'
]);
const EMPTY_SHA =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
let passed = 0;
function ok(value, message) {
  assert.ok(value, message);
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

class MemoryRepository {
  constructor() {
    this.record = null;
    this.evidence = new Map();
    this.receipts = new Map();
  }
  async withProcessOperationLock(_identity, operation) {
    return operation();
  }
  async withWorkspaceMutationBoundary(_input, operation) {
    return operation();
  }
  async getProcessOperation() {
    return this.record ? structuredClone(this.record) : null;
  }
  async listProcessOperationsForRun(_runId, { states = null } = {}) {
    if (!this.record || states && !states.includes(this.record.lifecycleState)) return [];
    return [structuredClone(this.record)];
  }
  async createProcessExecutionIntent(input) {
    if (this.record) {
      if (this.record.launchPlanHash !== input.launchPlanHash) {
        const error = new Error('intent conflict');
        error.code = 'PROCESS_EXECUTION_INTENT_CONFLICT';
        throw error;
      }
      return { inserted: false, record: structuredClone(this.record) };
    }
    const now = new Date().toISOString();
    this.record = {
      ...structuredClone(input),
      lifecycleState: 'intent',
      launcherAcceptanceIdentity: null,
      requestedAt: now,
      startedAt: null,
      terminalAt: null,
      terminalOutcome: null,
      terminalResult: null,
      terminalResultHash: null,
      exitCode: null,
      terminatingSignal: null,
      resourceCause: null,
      stdoutByteCount: null,
      stdoutSha256: null,
      stderrByteCount: null,
      stderrSha256: null,
      combinedOutputByteCount: null,
      stdoutArtifact: null,
      stderrArtifact: null,
      requiredEvidenceState: 'pending',
      launcherOutputAcknowledged: false,
      cancellationRequested: false,
      cancellationRequestedAt: null,
      cancellationReason: null,
      lastReconciliationResult: null,
      revision: 1,
      updatedAt: now
    };
    return { inserted: true, record: structuredClone(this.record) };
  }
  async transitionProcessOperation({
    expectedStates,
    expectedRevision,
    changes
  }) {
    if (!this.record || !expectedStates.includes(this.record.lifecycleState) ||
        expectedRevision !== this.record.revision) {
      const error = new Error('state conflict');
      error.code = 'PROCESS_EXECUTION_STATE_INVALID';
      throw error;
    }
    Object.assign(this.record, structuredClone(changes), {
      revision: this.record.revision + 1,
      updatedAt: new Date().toISOString()
    });
    return structuredClone(this.record);
  }
  async requestProcessOperationCancellation({ reason }) {
    if (!this.record.cancellationRequested) {
      this.record.cancellationRequested = true;
      this.record.cancellationRequestedAt = new Date().toISOString();
      this.record.cancellationReason = reason;
      this.record.revision += 1;
    }
    return structuredClone(this.record);
  }
  async appendRunEvidence(input) {
    const encoded = JSON.stringify(input.replayItem);
    const existing = this.evidence.get(input.evidenceKey);
    if (existing && existing !== encoded) throw new Error('evidence conflict');
    this.evidence.set(input.evidenceKey, encoded);
    return { inserted: existing === undefined };
  }
  async recordOperationReceipt(input) {
    const encoded = JSON.stringify(input);
    const existing = this.receipts.get(input.idempotencyKey);
    if (existing && existing !== encoded) throw new Error('receipt conflict');
    this.receipts.set(input.idempotencyKey, encoded);
    return { inserted: existing === undefined };
  }
}

class DurableLauncherFixture {
  constructor({ stdout, stderr, cancelOutcome = 'completed' }) {
    this.stdout = stdout;
    this.stderr = stderr;
    this.status = null;
    this.launchCount = 0;
    this.ackCount = 0;
    this.cancelCount = 0;
    this.cancelOutcome = cancelOutcome;
  }
  async launch({ launchPlan }) {
    if (!this.status) {
      this.launchCount += 1;
      const acceptance = `process-launcher-acceptance:${'d'.repeat(64)}`;
      this.status = {
        operationIdentity: launchPlan.operationIdentity,
        state: 'active',
        launcherAcceptanceIdentity: acceptance,
        terminalResultHash: null,
        outputAvailable: false,
        result: null
      };
    }
    return structuredClone(this.status);
  }
  #complete(terminalOutcome = 'completed') {
    if (this.status.state === 'terminal') return;
    const now = new Date();
    const result = {
      operationIdentity: this.status.operationIdentity,
      terminalOutcome,
      startedAt: new Date(now.getTime() - 5).toISOString(),
      endedAt: now.toISOString(),
      durationMs: 5,
      exitCode: terminalOutcome === 'completed' ? 0 : null,
      signal: null,
      stdoutBytes: this.stdout.length,
      stderrBytes: this.stderr.length,
      combinedOutputBytes: this.stdout.length + this.stderr.length,
      stdoutSha256: crypto.createHash('sha256').update(this.stdout).digest('hex'),
      stderrSha256: crypto.createHash('sha256').update(this.stderr).digest('hex'),
      outputComplete: true,
      resourceCause: null,
      enforcementCause: terminalOutcome === 'cancelled'
        ? 'cancellation_requested'
        : null,
      cpuThrottledEvents: 3,
      launcherEnvironment: { ...PROCESS_LAUNCHER_ENVIRONMENT }
    };
    this.status = {
      ...this.status,
      state: 'terminal',
      terminalResultHash: hashProcessContractValue(result),
      outputAvailable: true,
      result
    };
  }
  async getOperation() {
    if (!this.status) {
      const error = new Error('not found');
      error.code = 'PROCESS_OPERATION_NOT_FOUND';
      throw error;
    }
    this.#complete();
    return structuredClone(this.status);
  }
  async cancelOperation() {
    this.cancelCount += 1;
    if (!this.status) {
      const error = new Error('not found');
      error.code = 'PROCESS_OPERATION_NOT_FOUND';
      throw error;
    }
    this.#complete(this.cancelOutcome);
    return structuredClone(this.status);
  }
  async readOutput(request) {
    const bytes = request.stream === 'stdout' ? this.stdout : this.stderr;
    const end = Math.min(bytes.length, request.offset + request.maximumBytes);
    return {
      operationIdentity: this.status.operationIdentity,
      stream: request.stream,
      offset: request.offset,
      totalBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.subarray(request.offset, end),
      end: end === bytes.length
    };
  }
  async acknowledgeOutput({ terminalResultHash }) {
    assert.equal(terminalResultHash, this.status.terminalResultHash);
    this.ackCount += 1;
    this.status.outputAvailable = false;
    return structuredClone(this.status);
  }
}

function fixture(faultPoint = null, { cancelOutcome = 'completed' } = {}) {
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
    verifiedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 120000).toISOString(),
    readyForExecution: true
  };
  const runtimeAuthority = {
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
    generationId: `process-runtime-v1-${hashProcessContractValue(runtimeAuthority)}`,
    ...runtimeAuthority,
    verifiedAt: sandboxCapability.verifiedAt,
    expiresAt: sandboxCapability.expiresAt,
    readyForExecution: true
  });
  const run = {
    id: 123,
    ticketId: 45,
    agentId: 9,
    currentPhase: 'verification',
    processPolicySnapshot,
    processRuntimeCapabilitySnapshot: runtimeCapability
  };
  const descriptor = {
    id: 'workspace-snapshot-001',
    runId: run.id,
    policySnapshotHash: processPolicySnapshot.snapshotHash,
    materializerGeneration: sandboxCapability.materializerGeneration,
    manifestSha256: '8'.repeat(64),
    fileCount: 1,
    totalBytes: 12
  };
  const repository = new MemoryRepository();
  const launcher = new DurableLauncherFixture({
    stdout: Buffer.from([0, 1, 2, 255, 10]),
    stderr: Buffer.from('syntax warning\\n', 'utf8'),
    cancelOutcome
  });
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-runtime-fault-'));
  const capabilityResolver = {
    async resolve() {
      return runtimeCapability;
    },
    async resolveLaunchAuthority(_snapshot, expected) {
      if (expected !== runtimeCapability.generationId) {
        const error = new Error('capability mismatch');
        error.code = 'PROCESS_RUNTIME_CAPABILITY_MISMATCH';
        throw error;
      }
      return { runtimeCapability, sandboxCapability };
    }
  };
  const materializerClient = {
    configuration: { workspaceAllocationId: 'primary-workspace' },
    async health() {
      return {
        materializerGeneration: sandboxCapability.materializerGeneration,
        materializerIdentityHash: '9'.repeat(64),
        inputPolicyHash: 'a'.repeat(64),
        manifestSchemaVersion: 1,
        registrySchemaVersion: 1
      };
    },
    async materialize() {
      return structuredClone(descriptor);
    },
    async getSnapshot() {
      return structuredClone(descriptor);
    }
  };
  let armed = faultPoint;
  const buildController = ({ startupFault = null } = {}) => new ProcessExecutionController({
    repository,
    capabilityResolver,
    materializerClient,
    launcherClient: launcher,
    artifactStore: new ProcessOutputArtifactStore({ artifactRoot }),
    workspaceTargetId: 'local-workspace',
    faultCheckpoint: async point => {
      if (point === armed || point === startupFault) {
        if (point === armed) armed = null;
        const error = new Error(`simulated runtime crash at ${point}`);
        error.code = 'TEST_PROCESS_RUNTIME_CRASH';
        throw error;
      }
    }
  });
  return {
    run,
    repository,
    launcher,
    artifactRoot,
    buildController,
    action: {
      operation: 'runProcess',
      args: {
        targetId: 'ticket-system-local',
        profileId: 'syntax-check',
        operationId: 'syntax-operation-001'
      }
    }
  };
}

async function main() {
  for (const crashPoint of CRASH_WINDOWS) {
    const scenario = fixture(crashPoint);
    try {
      await assert.rejects(
        () => scenario.buildController().execute({
          run: scenario.run,
          action: scenario.action,
          step: 1
        }),
        error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
      );
      const result = await scenario.buildController().reconcileRun(scenario.run);
      const terminal = await scenario.repository.getProcessOperation();
      ok(terminal.lifecycleState === 'terminal' &&
        (result.length === 0 ||
          result.length === 1 &&
          result[0].terminalResultHash === terminal.terminalResultHash),
      `${crashPoint}: restart converges to one truthful terminal operation`);
      ok(scenario.launcher.launchCount === 1,
        `${crashPoint}: restart never duplicates native execution`);
      ok(scenario.repository.receipts.size === 1 &&
        [...scenario.repository.evidence.keys()]
          .filter(key => key.endsWith(':terminal')).length === 1,
      `${crashPoint}: receipt and required terminal evidence remain idempotent`);
      ok(terminal.stdoutArtifact && terminal.stderrArtifact &&
        terminal.launcherOutputAcknowledged === true &&
        scenario.launcher.ackCount === 1,
      `${crashPoint}: verified artifacts finalize before one launcher acknowledgement`);
    } finally {
      fs.rmSync(scenario.artifactRoot, { recursive: true, force: true });
    }
  }

  const cancellation = fixture('after_process_intent_commit_before_launcher_call');
  try {
    await assert.rejects(
      () => cancellation.buildController().execute({
        run: cancellation.run,
        action: cancellation.action,
        step: 1
      }),
      error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
    );
    await assert.rejects(
      () => cancellation.buildController({ startupFault: 'during_process_cancellation' })
        .cancelRunOperations(cancellation.run, 'lease expired'),
      error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
    );
    await cancellation.buildController().cancelRunOperations(
      cancellation.run,
      'lease expired'
    );
    const terminal = await cancellation.repository.getProcessOperation();
    ok(terminal.lifecycleState === 'terminal' &&
      terminal.terminalOutcome === 'cancelled' &&
      cancellation.launcher.launchCount === 0,
    'crash during pre-launch cancellation recovers without executing');
    ok(terminal.requiredEvidenceState === 'complete' &&
      cancellation.repository.evidence.size >= 2,
    'cancellation evidence is durable before ownership is released');
  } finally {
    fs.rmSync(cancellation.artifactRoot, { recursive: true, force: true });
  }

  const startup = fixture('after_process_intent_commit_before_launcher_call');
  try {
    await assert.rejects(
      () => startup.buildController().execute({
        run: startup.run,
        action: startup.action,
        step: 1
      }),
      error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
    );
    await assert.rejects(
      () => startup.buildController({
        startupFault: 'during_process_startup_reconciliation'
      }).reconcileRun(startup.run),
      error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
    );
    await startup.buildController().reconcileRun(startup.run);
    const terminal = await startup.repository.getProcessOperation();
    ok(terminal.lifecycleState === 'terminal' && startup.launcher.launchCount === 1,
      'repeated startup reconciliation converges without duplicate launch');
  } finally {
    fs.rmSync(startup.artifactRoot, { recursive: true, force: true });
  }

  const activeCancellation = fixture(
    'after_child_release_before_start_evidence',
    { cancelOutcome: 'cancelled' }
  );
  try {
    await assert.rejects(
      () => activeCancellation.buildController().execute({
        run: activeCancellation.run,
        action: activeCancellation.action,
        step: 1
      }),
      error => error && error.code === 'TEST_PROCESS_RUNTIME_CRASH'
    );
    await activeCancellation.buildController().cancelRunOperations(
      activeCancellation.run,
      'run interrupted'
    );
    const terminal = await activeCancellation.repository.getProcessOperation();
    ok(terminal.lifecycleState === 'terminal' &&
      terminal.terminalOutcome === 'cancelled' &&
      activeCancellation.launcher.cancelCount === 1,
    'accepted-operation cancellation observes launcher terminalization before returning');
    ok(activeCancellation.launcher.launchCount === 1 &&
      terminal.requiredEvidenceState === 'complete' &&
      terminal.launcherOutputAcknowledged === true,
    'active cancellation converges through artifacts/evidence without a second launch');
  } finally {
    fs.rmSync(activeCancellation.artifactRoot, { recursive: true, force: true });
  }

  ok(CRASH_WINDOWS.length === 8,
    'all required non-cancellation runtime crash windows are exercised');
  console.log(`PASS: process runtime fault recovery (${passed} assertions)`);
}

main().catch(error => {
  console.error(`FAIL: process runtime fault recovery — ${error.stack || error.message}`);
  process.exit(1);
});
