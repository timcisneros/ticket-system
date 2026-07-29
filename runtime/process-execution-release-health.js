'use strict';

const crypto = require('crypto');

const RELEASE_HEALTH_VERSION = 1;
const ACTIVE_STUCK_MS = 10 * 60 * 1000;
const FINALIZING_STUCK_MS = 5 * 60 * 1000;
const LAUNCHER_CAPACITY_LOW_PERCENT = 10;

function ageMs(timestamp, nowMs) {
  if (timestamp === null || timestamp === undefined) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

function alert(category, code) {
  return Object.freeze({ category, code });
}

async function buildProcessExecutionReleaseHealth({
  readiness,
  repository,
  launcherClient,
  artifactCleanup = null,
  nowMs = Date.now()
} = {}) {
  const operations = await repository.getProcessReleaseOperationalMetrics();
  let registry = null;
  try {
    registry = await launcherClient.getRegistryMetrics();
  } catch (_) {
    // Readiness already carries the bounded launcher failure. Missing metrics
    // never become a healthy or zero-capacity assertion.
  }
  const alerts = [];
  for (const issue of readiness.issues || []) {
    alerts.push(alert(issue.category, issue.code));
  }
  const activeAge = ageMs(operations.oldestActiveAt, nowMs);
  const finalizingAge = ageMs(operations.oldestFinalizingAt, nowMs);
  if (activeAge !== null && activeAge >= ACTIVE_STUCK_MS) {
    alerts.push(alert('operation_stuck_active', 'PROCESS_OPERATION_STUCK_ACTIVE'));
  }
  if (finalizingAge !== null && finalizingAge >= FINALIZING_STUCK_MS) {
    alerts.push(alert(
      'operation_stuck_finalizing',
      'PROCESS_OPERATION_STUCK_FINALIZING'
    ));
  }
  if (operations.operationsAwaitingReceipts > 0) {
    alerts.push(alert(
      'receipt_recovery_pending',
      'PROCESS_OPERATION_RECEIPT_MISSING'
    ));
  }
  if (operations.operationsAwaitingEvidence > 0) {
    alerts.push(alert(
      'evidence_recovery_pending',
      'PROCESS_EXECUTION_EVIDENCE_FAILED'
    ));
  }
  if (operations.cancellationPending > 0) {
    alerts.push(alert('cancellation_stuck', 'PROCESS_EXECUTION_CANCELLATION_PENDING'));
  }
  if (operations.reconciliationFailed > 0) {
    alerts.push(alert(
      'reconciliation_failed',
      'PROCESS_EXECUTION_RECONCILIATION_FAILED'
    ));
  }
  if (artifactCleanup && artifactCleanup.error === true) {
    alerts.push(alert('artifact_cleanup_failed', 'PROCESS_ARTIFACT_CLEANUP_FAILED'));
  }
  if (registry) {
    if (registry.fullRecordCapacityRemaining === 0) {
      alerts.push(alert(
        'launcher_capacity_exhausted',
        'PROCESS_LAUNCHER_REGISTRY_FULL'
      ));
    } else if (
      registry.fullRecordCapacityRemaining * 100 <=
      registry.fullRecordCapacity * LAUNCHER_CAPACITY_LOW_PERCENT
    ) {
      alerts.push(alert(
        'launcher_capacity_low',
        'PROCESS_LAUNCHER_REGISTRY_CAPACITY_LOW'
      ));
    }
  }
  const projection = {
    version: RELEASE_HEALTH_VERSION,
    readiness: readiness.state,
    releaseContractHash: readiness.releaseContractHash,
    databaseSchemaStatus:
      readiness.migrationStatus && readiness.migrationStatus.fullyApplied === true
        ? 'current'
        : 'incompatible',
    admissionEnabled: readiness.admissionEnabled,
    recoveryAvailable: readiness.recoveryAvailable,
    launcherGeneration: readiness.launcher && readiness.launcher.generationId || null,
    materializerGeneration:
      readiness.materializer && readiness.materializer.generationId || null,
    containmentHealth:
      readiness.launcher && readiness.launcher.readyForExecution === true
        ? 'verified'
        : 'unavailable',
    activeProcessOperations: operations.activeOperations,
    finalizingOperations: operations.finalizingOperations,
    operationsAwaitingReceipts: operations.operationsAwaitingReceipts,
    operationsAwaitingEvidence: operations.operationsAwaitingEvidence,
    operationsAwaitingOutputAcknowledgement:
      operations.operationsAwaitingOutputAcknowledgement,
    cancellationPending: operations.cancellationPending,
    reconciliationFailed: operations.reconciliationFailed,
    launcherRegistry: registry,
    orphanTemporaryArtifactCount:
      artifactCleanup && Number.isSafeInteger(artifactCleanup.orphanCount)
        ? artifactCleanup.orphanCount
        : null,
    oldestActiveOperationAgeMs: activeAge,
    oldestFinalizingOperationAgeMs: finalizingAge,
    alerts,
    observedAt: new Date(nowMs).toISOString()
  };
  return Object.freeze({
    ...projection,
    projectionHash: crypto.createHash('sha256')
      .update(JSON.stringify(projection))
      .digest('hex')
  });
}

module.exports = {
  ACTIVE_STUCK_MS,
  FINALIZING_STUCK_MS,
  LAUNCHER_CAPACITY_LOW_PERCENT,
  RELEASE_HEALTH_VERSION,
  buildProcessExecutionReleaseHealth
};
