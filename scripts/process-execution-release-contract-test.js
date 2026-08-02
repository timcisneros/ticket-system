#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');

const {
  buildProcessExecutionReleaseContract,
  evaluateProcessExecutionReleaseReadiness,
  normalizeProcessExecutionReleaseContract
} = require('../runtime/process-execution-release-contract');
const {
  buildLauncherCompactionRequest,
  normalizeLauncherRegistryMetrics
} = require('../runtime/process-launcher-foundation-contract');

const sourceRevision = 'a'.repeat(40);
const contract = buildProcessExecutionReleaseContract({
  applicationVersion: '1.1.1',
  sourceRevision
});
assert.deepEqual(
  buildProcessExecutionReleaseContract({
    applicationVersion: '1.1.1',
    sourceRevision
  }),
  contract,
  'release contract identity is deterministic'
);
assert.throws(() => normalizeProcessExecutionReleaseContract({
  ...contract,
  extra: true
}), /exactly/, 'release contract rejects unknown fields');
assert.throws(() => normalizeProcessExecutionReleaseContract({
  ...contract,
  version: 2
}), /Unsupported/, 'release contract rejects future versions');

const baseReadiness = {
  releaseContract: contract,
  installed: true,
  admissionEnabled: true,
  releaseState: {
    admissionEnabled: true,
    releaseContractHash: contract.releaseContractHash,
    sourceRevision,
    applicationVersion: '1.1.1'
  },
  migrationStatus: {
    currentVersion: 37,
    headVersion: 37,
    fullyApplied: true,
    checksumsValid: true,
    partial: false,
    unknownMigrations: 0
  },
  launcher: {
    available: true,
    protocolVersion: 1,
    rootfsRegistrySchemaVersion: 1,
    readyForExecution: true
  },
  materializer: { available: true, protocolVersion: 1 },
  artifactStorage: { available: true },
  targetCatalog: { schemaVersion: 2 },
  deployment: { validated: true },
  evaluatedAt: '2026-07-29T00:00:00.000Z'
};
assert.equal(
  evaluateProcessExecutionReleaseReadiness(baseReadiness).state,
  'ready'
);
assert.equal(
  evaluateProcessExecutionReleaseReadiness({
    ...baseReadiness,
    admissionEnabled: false,
    releaseState: {
      ...baseReadiness.releaseState,
      admissionEnabled: false
    }
  }).state,
  'disabled'
);
assert.equal(
  evaluateProcessExecutionReleaseReadiness({
    ...baseReadiness,
    launcher: { ...baseReadiness.launcher, available: false }
  }).state,
  'degraded_read_only'
);
assert.equal(
  evaluateProcessExecutionReleaseReadiness({
    ...baseReadiness,
    migrationStatus: { ...baseReadiness.migrationStatus, currentVersion: 30 }
  }).state,
  'blocked'
);

assert.deepEqual(buildLauncherCompactionRequest({
  operationIdentity: `process-operation:${'b'.repeat(64)}`,
  terminalResultHash: 'c'.repeat(64),
  durableFinalizationHash: 'd'.repeat(64)
}), {
  operationIdentity: `process-operation:${'b'.repeat(64)}`,
  terminalResultHash: 'c'.repeat(64),
  durableFinalizationHash: 'd'.repeat(64)
});
assert.equal(normalizeLauncherRegistryMetrics({
  version: 1,
  fullRecordCount: 10,
  compactTombstoneCount: 20,
  fullRecordCapacity: 4096,
  compactTombstoneCapacity: 65536,
  fullRecordCapacityRemaining: 4086,
  compactTombstoneCapacityRemaining: 65516
}).compactTombstoneCount, 20);

console.log('PASS: process execution release contract and readiness');
