'use strict';

const {
  PROCESS_LAUNCHER_ENVIRONMENT
} = require('./process-authority-constants');
const {
  buildProcessOperationIdentity,
  hashProcessContractValue,
  normalizeProcessPolicySnapshot,
  parseProcessOperationRequest
} = require('./process-execution-contract');
const {
  buildProcessLaunchPlan,
  validateProcessLaunchAuthorityContext,
  validateProcessLaunchPlan
} = require('./process-launch-plan');
const {
  materializeProcessExecutionInput
} = require('./process-input-materialization');
const {
  normalizePrivateExecutionResult
} = require('./process-launcher-foundation-contract');
const {
  normalizeProcessRuntimeCapabilityDescriptor
} = require('./process-runtime-capability');

const PROCESS_EXECUTION_POLL_INTERVAL_MS = 100;
const PROCESS_EXECUTION_OBSERVATION_GRACE_MS = 30_000;
const PROCESS_EXECUTION_FAILURE_CODES = Object.freeze([
  'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE',
  'PROCESS_RUNTIME_CAPABILITY_MISMATCH',
  'PROCESS_EXECUTION_INTENT_CONFLICT',
  'PROCESS_EXECUTION_STATE_INVALID',
  'PROCESS_EXECUTION_ALREADY_TERMINAL',
  'PROCESS_EXECUTION_RECONCILIATION_FAILED',
  'PROCESS_EXECUTION_OPERATION_LOST',
  'PROCESS_EXECUTION_LAUNCHER_RESTARTED',
  'PROCESS_OUTPUT_UNAVAILABLE',
  'PROCESS_OUTPUT_CHUNK_INVALID',
  'PROCESS_OUTPUT_HASH_MISMATCH',
  'PROCESS_OUTPUT_ARTIFACT_FAILED',
  'PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED',
  'PROCESS_EXECUTION_EVIDENCE_FAILED',
  'PROCESS_EXECUTION_CANCELLATION_FAILED',
  'PROCESS_EXECUTION_FINALIZATION_FAILED',
  'PROCESS_LAUNCHER_REGISTRY_INVALID',
  'PROCESS_LAUNCHER_REGISTRY_FULL'
]);

class ProcessExecutionControllerError extends Error {
  constructor(message, code = 'PROCESS_EXECUTION_RECONCILIATION_FAILED', details = {}) {
    super(message);
    this.name = 'ProcessExecutionControllerError';
    this.code = code;
    this.failureKind = 'process_execution_failed';
    this.details = details;
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function exactRuntimeCapability(run, current) {
  const admitted = normalizeProcessRuntimeCapabilityDescriptor(
    run.processRuntimeCapabilitySnapshot,
    { observedAt: run.processRuntimeCapabilitySnapshot.verifiedAt }
  );
  const fresh = normalizeProcessRuntimeCapabilityDescriptor(current);
  if (admitted.generationId !== fresh.generationId) {
    throw new ProcessExecutionControllerError(
      'Current runtime capability differs from admitted run authority',
      'PROCESS_RUNTIME_CAPABILITY_MISMATCH'
    );
  }
  return fresh;
}

function terminalActionResult(record) {
  const terminal = record.terminalResult;
  return Object.freeze({
    operation: 'runProcess',
    operationIdentity: record.operationIdentity,
    targetId: record.targetId,
    profileId: record.profileId,
    outcome: record.terminalOutcome,
    exitCode: record.exitCode,
    signal: record.terminatingSignal,
    resourceCause: record.resourceCause,
    stdout: record.stdoutArtifact,
    stderr: record.stderrArtifact,
    terminalResultHash: record.terminalResultHash,
    startedAt: record.startedAt,
    terminalAt: record.terminalAt,
    durationMs: terminal && terminal.durationMs
  });
}

function terminalReceiptOutcome(terminalOutcome) {
  return terminalOutcome === 'completed' ? 'succeeded' : 'failed';
}

function normalizeLauncherTerminalStatus(status, operationIdentity) {
  if (!status || status.state !== 'terminal' || !status.result ||
      status.operationIdentity !== operationIdentity ||
      typeof status.launcherAcceptanceIdentity !== 'string' ||
      typeof status.terminalResultHash !== 'string') {
    throw new ProcessExecutionControllerError(
      'Launcher terminal status is incomplete or substituted',
      'PROCESS_EXECUTION_RECONCILIATION_FAILED'
    );
  }
  const result = normalizePrivateExecutionResult(status.result, operationIdentity);
  if (hashProcessContractValue(result) !== status.terminalResultHash) {
    throw new ProcessExecutionControllerError(
      'Launcher terminal-result hash is invalid',
      'PROCESS_EXECUTION_RECONCILIATION_FAILED'
    );
  }
  if (result.outputComplete === true && status.outputAvailable !== true) {
    throw new ProcessExecutionControllerError(
      'Launcher terminal output is unavailable before durable runtime finalization',
      'PROCESS_OUTPUT_UNAVAILABLE'
    );
  }
  return { status, result };
}

class ProcessExecutionController {
  constructor({
    repository,
    capabilityResolver,
    materializerClient,
    launcherClient,
    artifactStore,
    workspaceTargetId,
    faultCheckpoint = async () => {},
    renewRunLease = async () => {},
    shutdownSignal = () => false
  } = {}) {
    for (const method of [
      'getProcessOperation',
      'listProcessOperationsForRun',
      'createProcessExecutionIntent',
      'transitionProcessOperation',
      'requestProcessOperationCancellation',
      'withProcessOperationLock',
      'appendRunEvidence',
      'recordOperationReceipt'
    ]) {
      if (!repository || typeof repository[method] !== 'function') {
        throw new TypeError(`Process execution repository must implement ${method}()`);
      }
    }
    if (!capabilityResolver ||
        typeof capabilityResolver.resolveLaunchAuthority !== 'function') {
      throw new TypeError('A process runtime capability resolver is required');
    }
    if (!launcherClient || typeof launcherClient.launch !== 'function' ||
        typeof launcherClient.getOperation !== 'function' ||
        typeof launcherClient.cancelOperation !== 'function' ||
        typeof launcherClient.readOutput !== 'function' ||
        typeof launcherClient.acknowledgeOutput !== 'function') {
      throw new TypeError('A complete private process launcher client is required');
    }
    if (!artifactStore || typeof artifactStore.publish !== 'function') {
      throw new TypeError('A process output artifact store is required');
    }
    this.repository = repository;
    this.capabilityResolver = capabilityResolver;
    this.materializerClient = materializerClient;
    this.launcherClient = launcherClient;
    this.artifactStore = artifactStore;
    this.workspaceTargetId = workspaceTargetId;
    this.faultCheckpoint = faultCheckpoint;
    this.renewRunLease = renewRunLease;
    this.shutdownSignal = shutdownSignal;
  }

  async currentCapabilityForRun(run) {
    if (!run || !run.processRuntimeCapabilitySnapshot) {
      throw new ProcessExecutionControllerError(
        'Run has no admitted process runtime capability',
        'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE'
      );
    }
    const current = await this.capabilityResolver.resolve(
      run.processPolicySnapshot
    );
    return exactRuntimeCapability(run, current);
  }

  async execute({ run, action, step, observationDeadlineMs = null }) {
    const parsed = parseProcessOperationRequest(action);
    const operationIdentity = buildProcessOperationIdentity(
      run.id,
      parsed.args.operationId
    );
    return this.repository.withProcessOperationLock(operationIdentity, async () => {
      let record = await this.repository.getProcessOperation(operationIdentity);
      if (record) {
        this.#assertRequestMatches(record, parsed.args);
        return this.#reconcileLocked({ run, record, observationDeadlineMs });
      }
      const admittedCapability = await this.currentCapabilityForRun(run);
      const authority = await this.capabilityResolver.resolveLaunchAuthority(
        run.processPolicySnapshot,
        admittedCapability.generationId
      );
      const context = validateProcessLaunchAuthorityContext({
        runId: run.id,
        ticketId: run.ticketId,
        currentPhase: run.currentPhase,
        processPolicySnapshot: run.processPolicySnapshot
      }, parsed.args);
      const workspaceSnapshot = await materializeProcessExecutionInput({
        boundaryRepository: this.repository,
        materializerClient: this.materializerClient,
        workspaceTargetId: this.workspaceTargetId,
        launchAuthorityContext: context,
        targetId: parsed.args.targetId,
        profileId: parsed.args.profileId,
        operationId: parsed.args.operationId
      });
      const launchPlan = buildProcessLaunchPlan({
        launchAuthorityContext: context,
        targetId: parsed.args.targetId,
        profileId: parsed.args.profileId,
        operationId: parsed.args.operationId,
        workspaceSnapshot,
        sandboxCapability: authority.sandboxCapability
      });
      const profile = context.processPolicySnapshot.profiles.find(item =>
        item.targetId === parsed.args.targetId &&
        item.profileId === parsed.args.profileId);
      const intent = await this.repository.createProcessExecutionIntent({
        operationIdentity,
        runId: run.id,
        ticketId: run.ticketId,
        actingAgentId: run.agentId,
        stepId: String(step),
        runtimePhase: context.currentPhase,
        targetId: parsed.args.targetId,
        profileId: parsed.args.profileId,
        policySnapshotHash: context.processPolicySnapshot.snapshotHash,
        runtimeCapabilityGeneration: admittedCapability.generationId,
        launchPlanVersion: launchPlan.version,
        launchPlanHash: launchPlan.launchPlanHash,
        launchPlan,
        workspaceSnapshotId: workspaceSnapshot.id,
        workspaceManifestHash: workspaceSnapshot.manifestSha256,
        materializerGeneration: workspaceSnapshot.materializerGeneration,
        containmentGenerationId: authority.sandboxCapability.generationId,
        rootfsId: profile.runtimeRootfs.id,
        rootfsManifestHash: profile.runtimeRootfs.manifestSha256,
        executableIdentityHash: hashProcessContractValue(profile.executableIdentity),
        executionPolicyHash: hashProcessContractValue(profile.executionPolicy),
        filesystemPolicyHash: hashProcessContractValue(profile.filesystemPolicy)
      });
      record = intent.record;
      await this.#publishEvidence(record, 'process.intent_admitted', {
        lifecycleState: 'intent'
      });
      await this.faultCheckpoint('after_process_intent_commit_before_launcher_call', {
        operationIdentity
      });
      return this.#reconcileLocked({
        run,
        record,
        launchAuthority: authority,
        observationDeadlineMs
      });
    });
  }

  async cancelRunOperations(run, reason) {
    const records = await this.repository.listProcessOperationsForRun(run.id);
    for (const current of records) {
      const disposition = await this.repository.withProcessOperationLock(
        current.operationIdentity,
        async () => {
          let record = await this.repository.getProcessOperation(current.operationIdentity);
          if (record.lifecycleState === 'terminal') {
            return record.launcherOutputAcknowledged
              ? { kind: 'complete', record }
              : { kind: 'reconcile', record };
          }
          if (record.lifecycleState === 'finalizing') {
            // The launcher has already published one authoritative terminal
            // result. Finish its artifacts/evidence/receipt without rewriting
            // that result as cancellation.
            return { kind: 'reconcile', record };
          }

          record = await this.repository.requestProcessOperationCancellation({
            operationIdentity: record.operationIdentity,
            reason
          });
          await this.#publishEvidence(record, 'process.cancellation_requested', {
            reason: record.cancellationReason
          });
          await this.faultCheckpoint('during_process_cancellation', {
            operationIdentity: record.operationIdentity
          });

          if (record.lifecycleState === 'intent' &&
              record.launcherAcceptanceIdentity === null) {
            // PostgreSQL may still say `intent` after launcher acceptance when
            // the runtime crashed before committing `active`. Query the
            // launcher's durable registry before deciding that no process ever
            // started. A missing record is the only authority for the
            // zero-output pre-launch cancellation path.
            let launcherStatus = null;
            try {
              launcherStatus = await this.launcherClient.getOperation({
                operationIdentity: record.operationIdentity
              });
            } catch (error) {
              if (error.code !== 'PROCESS_OPERATION_NOT_FOUND') throw error;
            }
            if (!launcherStatus) {
              await this.#finalizeUnlaunchedCancellation(record);
              return { kind: 'complete', record };
            }
          }
          return { kind: 'cancel', record };
        }
      );

      if (disposition.kind === 'cancel') {
        await this.#cancelAccepted(disposition.record);
      } else if (disposition.kind === 'reconcile') {
        await this.repository.withProcessOperationLock(
          disposition.record.operationIdentity,
          async () => this.#reconcileLocked({
            run,
            record: await this.repository.getProcessOperation(
              disposition.record.operationIdentity
            )
          })
        );
      }
    }
    const remaining = await this.repository.listProcessOperationsForRun(run.id, {
      states: ['intent', 'active', 'finalizing']
    });
    const incompleteTerminal = (await this.repository.listProcessOperationsForRun(run.id))
      .filter(record => record.lifecycleState === 'terminal' &&
        !record.launcherOutputAcknowledged &&
        record.launcherAcceptanceIdentity !== null);
    if (remaining.length > 0 || incompleteTerminal.length > 0) {
      throw new ProcessExecutionControllerError(
        'Owned process operations remain incomplete after cancellation',
        'PROCESS_EXECUTION_CANCELLATION_FAILED'
      );
    }
  }

  async reconcileRun(run) {
    const records = (await this.repository.listProcessOperationsForRun(run.id))
      .filter(record => record.lifecycleState !== 'terminal' ||
        !record.launcherOutputAcknowledged);
    const results = [];
    for (const current of records) {
      await this.faultCheckpoint('during_process_startup_reconciliation', {
        operationIdentity: current.operationIdentity
      });
      results.push(await this.repository.withProcessOperationLock(
        current.operationIdentity,
        async () => this.#reconcileLocked({
          run,
          record: await this.repository.getProcessOperation(current.operationIdentity)
        })
      ));
    }
    return results;
  }

  async #reconcileLocked({
    run,
    record,
    launchAuthority = null,
    observationDeadlineMs = null
  }) {
    if (record.lifecycleState === 'terminal') {
      if (!record.launcherOutputAcknowledged &&
          record.launcherAcceptanceIdentity !== null) {
        await this.#acknowledge(record);
        record = await this.repository.getProcessOperation(record.operationIdentity);
      }
      return terminalActionResult(record);
    }
    if (record.lifecycleState === 'finalizing') {
      return this.#finishFinalization(record);
    }
    let launcherStatus = null;
    try {
      launcherStatus = await this.launcherClient.getOperation({
        operationIdentity: record.operationIdentity
      });
    } catch (error) {
      if (error.code !== 'PROCESS_OPERATION_NOT_FOUND') throw error;
    }
    if (!launcherStatus) {
      if (record.lifecycleState === 'active' ||
          record.launcherAcceptanceIdentity !== null) {
        throw new ProcessExecutionControllerError(
          'Launcher lost a durably accepted process operation',
          'PROCESS_EXECUTION_OPERATION_LOST',
          { operationIdentity: record.operationIdentity }
        );
      }
      if (record.cancellationRequested) {
        return this.#finalizeUnlaunchedCancellation(record);
      }
      let authority = launchAuthority;
      if (!authority) {
        try {
          authority = await this.capabilityResolver.resolveLaunchAuthority(
            run.processPolicySnapshot,
            record.runtimeCapabilityGeneration
          );
        } catch (error) {
          return this.#finalizeUnlaunchedFailure(record, error);
        }
      }
      const context = validateProcessLaunchAuthorityContext({
        runId: record.runId,
        ticketId: record.ticketId,
        currentPhase: record.runtimePhase,
        processPolicySnapshot: run.processPolicySnapshot
      }, {
        targetId: record.targetId,
        profileId: record.profileId
      });
      const launchPlan = validateProcessLaunchPlan(record.launchPlan, {
        launchAuthorityContext: context,
        sandboxCapability: authority.sandboxCapability
      });
      launcherStatus = await this.launcherClient.launch({
        launchPlan,
        containmentGenerationId: record.containmentGenerationId
      }, {
        launchAuthorityContext: context,
        sandboxCapability: authority.sandboxCapability
      });
      await this.faultCheckpoint('after_launcher_acceptance_before_active_state_commit', {
        operationIdentity: record.operationIdentity
      });
    }
    if (launcherStatus.state === 'active') {
      record = await this.#markActive(record, launcherStatus);
      await this.#publishEvidence(record, 'process.launcher_accepted', {
        launcherAcceptanceIdentity: record.launcherAcceptanceIdentity
      });
      await this.faultCheckpoint('after_child_release_before_start_evidence', {
        operationIdentity: record.operationIdentity
      });
      launcherStatus = await this.#observeTerminal(record, observationDeadlineMs);
    }
    const terminal = normalizeLauncherTerminalStatus(
      launcherStatus,
      record.operationIdentity
    );
    if (record.lifecycleState === 'intent') {
      record = await this.#markActive(record, launcherStatus);
      await this.#publishEvidence(record, 'process.launcher_accepted', {
        launcherAcceptanceIdentity: record.launcherAcceptanceIdentity
      });
    }
    await this.faultCheckpoint('after_launcher_terminal_before_finalizing_commit', {
      operationIdentity: record.operationIdentity
    });
    record = await this.#markFinalizing(record, terminal);
    return this.#finishFinalization(record);
  }

  async #observeTerminal(record, observationDeadlineMs = null) {
    const profile = record.launchPlan;
    const policyDeadline = Date.now() +
      profile.limits.wallTimeMs +
      PROCESS_EXECUTION_OBSERVATION_GRACE_MS;
    const deadline = Number.isSafeInteger(observationDeadlineMs)
      ? Math.min(policyDeadline, observationDeadlineMs)
      : policyDeadline;
    let nextLeaseHeartbeat = Date.now();
    while (Date.now() < deadline) {
      if (Date.now() >= nextLeaseHeartbeat) {
        try {
          await this.renewRunLease(record.runId, record.operationIdentity);
          nextLeaseHeartbeat = Date.now() + 30_000;
        } catch (error) {
          await this.launcherClient.cancelOperation({
            operationIdentity: record.operationIdentity
          });
          throw new ProcessExecutionControllerError(
            `Run lease renewal failed while a process was active: ${
              error.message || String(error)
            }`,
            'PROCESS_EXECUTION_CANCELLATION_FAILED'
          );
        }
      }
      if (this.shutdownSignal()) {
        await this.repository.requestProcessOperationCancellation({
          operationIdentity: record.operationIdentity,
          reason: 'runtime shutdown'
        });
        await this.launcherClient.cancelOperation({
          operationIdentity: record.operationIdentity
        });
      }
      const current = await this.repository.getProcessOperation(record.operationIdentity);
      if (current.cancellationRequested) {
        await this.launcherClient.cancelOperation({
          operationIdentity: record.operationIdentity
        });
      }
      const status = await this.launcherClient.getOperation({
        operationIdentity: record.operationIdentity
      });
      if (status.state === 'terminal') return status;
      await sleep(PROCESS_EXECUTION_POLL_INTERVAL_MS);
    }
    await this.launcherClient.cancelOperation({
      operationIdentity: record.operationIdentity
    });
    const cancellationDeadline = Date.now() + PROCESS_EXECUTION_OBSERVATION_GRACE_MS;
    while (Date.now() < cancellationDeadline) {
      const cancelled = await this.launcherClient.getOperation({
        operationIdentity: record.operationIdentity
      });
      if (cancelled.state === 'terminal') return cancelled;
      await sleep(PROCESS_EXECUTION_POLL_INTERVAL_MS);
    }
    throw new ProcessExecutionControllerError(
      'Launcher did not publish a terminal result within the bounded observation window',
      'PROCESS_EXECUTION_RECONCILIATION_FAILED'
    );
  }

  async #markActive(record, status) {
    if (record.lifecycleState === 'active') return record;
    return this.repository.transitionProcessOperation({
      operationIdentity: record.operationIdentity,
      expectedStates: ['intent'],
      expectedRevision: record.revision,
      changes: {
        lifecycleState: 'active',
        launcherAcceptanceIdentity: status.launcherAcceptanceIdentity,
        lastReconciliationResult: {
          kind: 'launcher_accepted',
          observedAt: new Date().toISOString()
        }
      }
    });
  }

  async #markFinalizing(record, { status, result }) {
    const expected = record.lifecycleState === 'active' ? ['active'] : ['intent'];
    return this.repository.transitionProcessOperation({
      operationIdentity: record.operationIdentity,
      expectedStates: expected,
      expectedRevision: record.revision,
      changes: {
        lifecycleState: 'finalizing',
        launcherAcceptanceIdentity: status.launcherAcceptanceIdentity,
        startedAt: result.startedAt,
        terminalAt: result.endedAt,
        terminalOutcome: result.terminalOutcome,
        terminalResult: result,
        terminalResultHash: status.terminalResultHash,
        exitCode: result.exitCode,
        terminatingSignal: result.signal,
        resourceCause: result.resourceCause,
        stdoutByteCount: result.stdoutBytes,
        stdoutSha256: result.stdoutSha256,
        stderrByteCount: result.stderrBytes,
        stderrSha256: result.stderrSha256,
        combinedOutputByteCount: result.combinedOutputBytes,
        lastReconciliationResult: {
          kind: result.terminalOutcome === 'runtime_interrupted'
            ? 'launcher_restart_interruption'
            : 'launcher_terminal',
          observedAt: new Date().toISOString(),
          terminalResultHash: status.terminalResultHash
        }
      }
    });
  }

  async #finishFinalization(record) {
    let stdoutArtifact = record.stdoutArtifact;
    let stderrArtifact = record.stderrArtifact;
    const result = normalizePrivateExecutionResult(
      record.terminalResult,
      record.operationIdentity
    );
    if (result.outputComplete) {
      if (!stdoutArtifact) {
        stdoutArtifact = await this.#publishOutput(record, result, 'stdout');
        await this.faultCheckpoint('during_process_stdout_artifact_transfer', {
          operationIdentity: record.operationIdentity
        });
      }
      if (!stderrArtifact) {
        stderrArtifact = await this.#publishOutput(record, result, 'stderr');
      }
      await this.faultCheckpoint('after_artifact_publication_before_database_binding', {
        operationIdentity: record.operationIdentity
      });
      if (!record.stdoutArtifact || !record.stderrArtifact) {
        record = await this.repository.transitionProcessOperation({
          operationIdentity: record.operationIdentity,
          expectedStates: ['finalizing'],
          expectedRevision: record.revision,
          changes: {
            stdoutArtifact,
            stderrArtifact,
            lastReconciliationResult: {
              kind: 'artifacts_published',
              observedAt: new Date().toISOString()
            }
          }
        });
      }
    }
    await this.faultCheckpoint('after_terminal_database_commit_before_required_evidence', {
      operationIdentity: record.operationIdentity
    });
    await this.#publishTerminalEvidence(record, stdoutArtifact, stderrArtifact);
    record = await this.repository.getProcessOperation(record.operationIdentity);
    if (record.lifecycleState !== 'terminal') {
      record = await this.repository.transitionProcessOperation({
        operationIdentity: record.operationIdentity,
        expectedStates: ['finalizing', 'intent'],
        expectedRevision: record.revision,
        changes: {
          lifecycleState: 'terminal',
          requiredEvidenceState: 'complete',
          stdoutArtifact,
          stderrArtifact,
          lastReconciliationResult: {
            kind: 'durable_finalization_complete',
            observedAt: new Date().toISOString()
          }
        }
      });
    }
    if (record.launcherAcceptanceIdentity !== null) {
      await this.#acknowledge(record);
      record = await this.repository.getProcessOperation(record.operationIdentity);
    }
    await this.faultCheckpoint('after_required_evidence_before_action_response', {
      operationIdentity: record.operationIdentity
    });
    return terminalActionResult(record);
  }

  async #publishOutput(record, result, stream) {
    const prefix = stream === 'stdout' ? 'stdout' : 'stderr';
    return this.artifactStore.publish({
      operationIdentity: record.operationIdentity,
      stream,
      expectedBytes: result[`${prefix}Bytes`],
      expectedSha256: result[`${prefix}Sha256`],
      readChunk: request => this.launcherClient.readOutput({
        operationIdentity: record.operationIdentity,
        ...request
      })
    });
  }

  async #publishTerminalEvidence(record, stdoutArtifact, stderrArtifact) {
    const binding = this.#binding(record);
    await this.#publishEvidence(record, 'process.terminal', {
      ...binding,
      terminalOutcome: record.terminalOutcome,
      terminalResultHash: record.terminalResultHash,
      exitCode: record.exitCode,
      signal: record.terminatingSignal,
      resourceCause: record.resourceCause
    });
    if (stdoutArtifact) {
      await this.#publishEvidence(record, 'process.stdout_artifact', {
        ...binding,
        artifact: stdoutArtifact
      });
    }
    if (stderrArtifact) {
      await this.#publishEvidence(record, 'process.stderr_artifact', {
        ...binding,
        artifact: stderrArtifact
      });
    }
    const receipt = {
      version: 1,
      operationIdentity: record.operationIdentity,
      targetId: record.targetId,
      profileId: record.profileId,
      runtimePhase: record.runtimePhase,
      launchPlanHash: record.launchPlanHash,
      policySnapshotHash: record.policySnapshotHash,
      runtimeCapabilityGeneration: record.runtimeCapabilityGeneration,
      containmentGenerationId: record.containmentGenerationId,
      materializerGeneration: record.materializerGeneration,
      workspaceSnapshotId: record.workspaceSnapshotId,
      workspaceManifestHash: record.workspaceManifestHash,
      rootfsId: record.rootfsId,
      rootfsManifestHash: record.rootfsManifestHash,
      executableIdentityHash: record.executableIdentityHash,
      terminalOutcome: record.terminalOutcome,
      terminalResultHash: record.terminalResultHash,
      exitCode: record.exitCode,
      signal: record.terminatingSignal,
      resourceCause: record.resourceCause,
      stdoutArtifact,
      stderrArtifact,
      stdoutByteCount: record.stdoutByteCount,
      stderrByteCount: record.stderrByteCount,
      combinedOutputByteCount: record.combinedOutputByteCount
    };
    await this.repository.recordOperationReceipt({
      runId: record.runId,
      idempotencyKey: record.operationIdentity,
      stepId: record.stepId,
      operation: 'runProcess',
      outcome: terminalReceiptOutcome(record.terminalOutcome),
      targetId: record.targetId,
      targetKind: 'process',
      targetResourceId: `${record.targetId}/${record.profileId}`,
      artifactPath: null,
      receipt,
      eventType: null
    });
  }

  async #publishEvidence(record, eventType, payload) {
    const suffix = eventType.replace(/^process\./, '').replaceAll('.', '_');
    const evidenceKey = `process-execution:${record.operationIdentity}:${suffix}`;
    const replayItem = {
      version: 1,
      evidenceType: eventType,
      ...this.#binding(record),
      ...payload
    };
    try {
      await this.repository.appendRunEvidence({
        runId: record.runId,
        ticketId: record.ticketId,
        evidenceKey,
        replayKey: 'processExecutionLifecycle',
        replayItem,
        event: {
          type: eventType,
          ticketId: record.ticketId,
          runId: record.runId,
          ...(record.stepId === null ? {} : { stepId: record.stepId }),
          payload: replayItem
        }
      });
    } catch (error) {
      throw new ProcessExecutionControllerError(
        `Process required evidence failed: ${error.message || String(error)}`,
        'PROCESS_EXECUTION_EVIDENCE_FAILED'
      );
    }
  }

  #binding(record) {
    return {
      runId: record.runId,
      ticketId: record.ticketId,
      operationIdentity: record.operationIdentity,
      launchPlanHash: record.launchPlanHash,
      policySnapshotHash: record.policySnapshotHash,
      runtimeCapabilityGeneration: record.runtimeCapabilityGeneration,
      containmentGenerationId: record.containmentGenerationId,
      materializerGeneration: record.materializerGeneration,
      rootfsId: record.rootfsId,
      rootfsManifestHash: record.rootfsManifestHash,
      executableIdentityHash: record.executableIdentityHash,
      workspaceSnapshotId: record.workspaceSnapshotId,
      workspaceManifestHash: record.workspaceManifestHash
    };
  }

  async #acknowledge(record) {
    if (record.launcherOutputAcknowledged) return;
    try {
      await this.launcherClient.acknowledgeOutput({
        operationIdentity: record.operationIdentity,
        terminalResultHash: record.terminalResultHash
      });
      await this.repository.transitionProcessOperation({
        operationIdentity: record.operationIdentity,
        expectedStates: ['terminal'],
        expectedRevision: record.revision,
        changes: {
          launcherOutputAcknowledged: true,
          lastReconciliationResult: {
            kind: 'launcher_output_acknowledged',
            observedAt: new Date().toISOString()
          }
        }
      });
    } catch (error) {
      throw new ProcessExecutionControllerError(
        `Launcher output acknowledgement failed: ${error.message || String(error)}`,
        'PROCESS_OUTPUT_ACKNOWLEDGEMENT_FAILED'
      );
    }
  }

  async #cancelAccepted(record) {
    try {
      await this.launcherClient.cancelOperation({
        operationIdentity: record.operationIdentity
      });
      await this.repository.withProcessOperationLock(
        record.operationIdentity,
        async () => this.#reconcileLocked({
          run: {
            id: record.runId,
            ticketId: record.ticketId,
            processPolicySnapshot: record.launchPlan
          },
          record: await this.repository.getProcessOperation(record.operationIdentity)
        })
      );
    } catch (error) {
      throw new ProcessExecutionControllerError(
        `Process cancellation could not prove whole-tree terminalization: ${
          error.message || String(error)
        }`,
        'PROCESS_EXECUTION_CANCELLATION_FAILED'
      );
    }
  }

  async #finalizeUnlaunchedCancellation(record) {
    const timestamp = new Date().toISOString();
    const result = {
      operationIdentity: record.operationIdentity,
      terminalOutcome: 'cancelled',
      startedAt: record.requestedAt,
      endedAt: timestamp,
      durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(record.requestedAt)),
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      combinedOutputBytes: 0,
      stdoutSha256: hashProcessContractValue(''),
      stderrSha256: hashProcessContractValue(''),
      outputComplete: false,
      resourceCause: null,
      enforcementCause: 'cancelled_before_launch',
      cpuThrottledEvents: 0,
      launcherEnvironment: { ...PROCESS_LAUNCHER_ENVIRONMENT }
    };
    // SHA-256 of zero raw bytes, not canonical JSON of an empty string.
    result.stdoutSha256 = result.stderrSha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const terminalResultHash = hashProcessContractValue(result);
    record = await this.repository.transitionProcessOperation({
      operationIdentity: record.operationIdentity,
      expectedStates: ['intent'],
      expectedRevision: record.revision,
      changes: {
        lifecycleState: 'finalizing',
        terminalAt: timestamp,
        terminalOutcome: 'cancelled',
        terminalResult: result,
        terminalResultHash,
        stdoutByteCount: 0,
        stdoutSha256: result.stdoutSha256,
        stderrByteCount: 0,
        stderrSha256: result.stderrSha256,
        combinedOutputByteCount: 0,
        lastReconciliationResult: {
          kind: 'cancelled_before_launcher_acceptance',
          observedAt: timestamp
        }
      }
    });
    return this.#finishFinalization(record);
  }

  async #finalizeUnlaunchedFailure(record, error) {
    const timestamp = new Date().toISOString();
    const emptySha256 =
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const result = {
      operationIdentity: record.operationIdentity,
      terminalOutcome: 'failed_to_start',
      startedAt: record.requestedAt,
      endedAt: timestamp,
      durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(record.requestedAt)),
      exitCode: null,
      signal: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      combinedOutputBytes: 0,
      stdoutSha256: emptySha256,
      stderrSha256: emptySha256,
      outputComplete: false,
      resourceCause: null,
      enforcementCause: error && typeof error.code === 'string'
        ? error.code
        : 'PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE',
      cpuThrottledEvents: 0,
      launcherEnvironment: { ...PROCESS_LAUNCHER_ENVIRONMENT }
    };
    const terminalResultHash = hashProcessContractValue(result);
    record = await this.repository.transitionProcessOperation({
      operationIdentity: record.operationIdentity,
      expectedStates: ['intent'],
      expectedRevision: record.revision,
      changes: {
        lifecycleState: 'finalizing',
        startedAt: record.requestedAt,
        terminalAt: timestamp,
        terminalOutcome: 'failed_to_start',
        terminalResult: result,
        terminalResultHash,
        stdoutByteCount: 0,
        stdoutSha256: emptySha256,
        stderrByteCount: 0,
        stderrSha256: emptySha256,
        combinedOutputByteCount: 0,
        lastReconciliationResult: {
          kind: 'unaccepted_launch_refused',
          code: result.enforcementCause,
          observedAt: timestamp
        }
      }
    });
    return this.#finishFinalization(record);
  }

  #assertRequestMatches(record, request) {
    if (record.targetId !== request.targetId ||
        record.profileId !== request.profileId) {
      throw new ProcessExecutionControllerError(
        'Process operation identity is already bound to another target or profile',
        'PROCESS_EXECUTION_INTENT_CONFLICT'
      );
    }
  }
}

module.exports = {
  PROCESS_EXECUTION_FAILURE_CODES,
  PROCESS_EXECUTION_OBSERVATION_GRACE_MS,
  PROCESS_EXECUTION_POLL_INTERVAL_MS,
  ProcessExecutionController,
  ProcessExecutionControllerError,
  normalizeLauncherTerminalStatus,
  terminalActionResult
};
