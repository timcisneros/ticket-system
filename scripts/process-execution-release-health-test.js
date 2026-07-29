#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const {
  buildProcessExecutionReleaseHealth
} = require('../runtime/process-execution-release-health');

async function main() {
  const health = await buildProcessExecutionReleaseHealth({
    readiness: {
      state: 'disabled',
      releaseContractHash: 'a'.repeat(64),
      admissionEnabled: false,
      recoveryAvailable: true,
      issues: [],
      migrationStatus: { fullyApplied: true },
      launcher: {
        generationId: `sandbox-containment-v1-${'b'.repeat(64)}`,
        readyForExecution: true
      },
      materializer: {
        generationId: `materializer-v1-${'c'.repeat(64)}`
      }
    },
    repository: {
      async getProcessReleaseOperationalMetrics() {
        return {
          activeOperations: 1,
          finalizingOperations: 1,
          operationsAwaitingReceipts: 1,
          operationsAwaitingEvidence: 1,
          operationsAwaitingOutputAcknowledgement: 1,
          cancellationPending: 1,
          reconciliationFailed: 1,
          oldestActiveAt: '2026-07-28T23:00:00.000Z',
          oldestFinalizingAt: '2026-07-28T23:00:00.000Z'
        };
      }
    },
    launcherClient: {
      async getRegistryMetrics() {
        return {
          version: 1,
          fullRecordCount: 4095,
          compactTombstoneCount: 2,
          fullRecordCapacity: 4096,
          compactTombstoneCapacity: 65536,
          fullRecordCapacityRemaining: 1,
          compactTombstoneCapacityRemaining: 65534
        };
      }
    },
    artifactCleanup: { orphanCount: 2, error: false },
    nowMs: Date.parse('2026-07-29T00:00:00.000Z')
  });
  assert.equal(health.readiness, 'disabled');
  assert.equal(health.operationsAwaitingReceipts, 1);
  assert(health.alerts.some(item =>
    item.category === 'receipt_recovery_pending'));
  assert(health.alerts.some(item =>
    item.category === 'operation_stuck_active'));
  assert(health.alerts.some(item =>
    item.category === 'launcher_capacity_low'));
  const serialized = JSON.stringify(health);
  for (const forbidden of [
    '/run/',
    '/home/',
    'socketPath',
    'cgroupPath',
    'leaseOwner',
    'launchPlan',
    'pid',
    'rawOutput'
  ]) {
    assert.equal(serialized.includes(forbidden), false,
      `release health excludes ${forbidden}`);
  }
  const unavailable = await buildProcessExecutionReleaseHealth({
    readiness: {
      state: 'degraded_read_only',
      releaseContractHash: 'a'.repeat(64),
      admissionEnabled: false,
      recoveryAvailable: true,
      issues: [{
        category: 'launcher_unavailable',
        code: 'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE'
      }],
      migrationStatus: { fullyApplied: true },
      launcher: null,
      materializer: null
    },
    repository: {
      async getProcessReleaseOperationalMetrics() {
        return {
          activeOperations: 0,
          finalizingOperations: 0,
          operationsAwaitingReceipts: 0,
          operationsAwaitingEvidence: 0,
          operationsAwaitingOutputAcknowledgement: 0,
          cancellationPending: 0,
          reconciliationFailed: 0,
          oldestActiveAt: null,
          oldestFinalizingAt: null
        };
      }
    },
    launcherClient: {
      async getRegistryMetrics() {
        throw new Error('unavailable');
      }
    },
    nowMs: Date.parse('2026-07-29T00:00:00.000Z')
  });
  assert.equal(unavailable.launcherRegistry, null);
  assert.equal(unavailable.readiness, 'degraded_read_only');
}

main().then(() => {
  console.log('PASS: bounded process execution release health');
}).catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
