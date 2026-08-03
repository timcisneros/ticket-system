'use strict';

const crypto = require('crypto');

const {
  COMPLETION_AUTHORITY_VERSION,
  COMPLETION_DECISION_VERSION
} = require('./completion-decision-contract');
const {
  PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
  PROCESS_ROOTFS_MANIFEST_SCHEMA_VERSION
} = require('./process-launcher-foundation-contract');
const {
  PROCESS_MATERIALIZER_PROTOCOL_VERSION
} = require('./process-materializer-contract');
const {
  PROCESS_TARGET_CATALOG_VERSION
} = require('./process-target-catalog');
const {
  RUNTIME_BUDGET_SNAPSHOT_VERSION
} = require('./runtime-budget-contract');
const {
  PROCESS_SUPERVISION_VERSION
} = require('./process-supervision');

const PROCESS_EXECUTION_RELEASE_CONTRACT_VERSION = 1;
// Bumped by Tranche 4, which added migrations 033 (role-scoped economic
// accounting) and 034 (logical request identity). Neither touches process
// execution, but the release preflight requires the head to match exactly, and
// the same bump was made by Tranche 2A when it added migration 032.
//
// Bumped again by Tranche 5, which added migrations 035 (governed
// postcondition evidence), 036 (evidence batch boundary) and 037 (baseline
// evidence). Same reasoning: none of them touches process execution, and the
// preflight still requires an exact head. Left at 34 these migrations would
// have made `inspectDatabase` refuse a correctly migrated database with
// PROCESS_RELEASE_SCHEMA_INCOMPATIBLE — a release blocked by a schema it
// actually had.
// Bumped again by migration 038 (governed request claim binding). Same
// reasoning as 035-037: it does not touch process execution, but the preflight
// requires an exact head, so leaving it behind would refuse a correctly
// migrated database.
const PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION = 38;
const PROCESS_EXECUTION_MINIMUM_DATABASE_SCHEMA_VERSION = 38;
const PROCESS_EXECUTION_MAXIMUM_DATABASE_SCHEMA_VERSION = 38;
const PROCESS_OPERATION_SCHEMA_VERSION = 29;
const PROCESS_EXECUTION_ROOTFS_REGISTRY_SCHEMA_VERSION = 1;
const PROCESS_EXECUTION_RELEASE_READINESS_VERSION = 1;
const PROCESS_EXECUTION_RELEASE_MANIFEST_VERSION = 1;

const PROCESS_EXECUTION_RELEASE_CONTRACT_KEYS = Object.freeze([
  'version',
  'applicationVersion',
  'sourceRevision',
  'databaseSchemaVersion',
  'minimumCompatibleDatabaseSchemaVersion',
  'maximumCompatibleDatabaseSchemaVersion',
  'launcherProtocolVersion',
  'materializerProtocolVersion',
  'processTargetCatalogSchemaVersion',
  'rootfsRegistrySchemaVersion',
  'runtimeBudgetSnapshotVersions',
  'completionAuthorityVersions',
  'completionDecisionVersions',
  'processSupervisionVersions',
  'processOperationSchemaVersions',
  'requiredFeatureFlags',
  'requiredNativeComponents',
  'requiredDeploymentCapabilities',
  'releaseContractHash'
]);

const PROCESS_EXECUTION_READINESS_STATES = Object.freeze([
  'disabled',
  'ready',
  'degraded_read_only',
  'blocked'
]);

const PROCESS_EXECUTION_RELEASE_ALERT_CATEGORIES = Object.freeze([
  'release_contract_invalid',
  'schema_incompatible',
  'native_component_mismatch',
  'containment_unavailable',
  'launcher_unavailable',
  'materializer_unavailable',
  'launcher_capacity_low',
  'launcher_capacity_exhausted',
  'operation_stuck_active',
  'operation_stuck_finalizing',
  'receipt_recovery_pending',
  'evidence_recovery_pending',
  'cancellation_stuck',
  'reconciliation_failed',
  'artifact_cleanup_failed',
  'backup_stale',
  'canary_failed'
]);

const REQUIRED_FEATURE_FLAGS = Object.freeze([
  'ENABLE_PROCESS_EXECUTION_CONTRACT',
  'processExecutionAdmissionEnabled'
]);
const REQUIRED_NATIVE_COMPONENTS = Object.freeze([
  'ticket-system-process-launcher-foundation',
  'ticket-system-process-materializer'
]);
const REQUIRED_DEPLOYMENT_CAPABILITIES = Object.freeze([
  'artifact_storage',
  'cgroup_v2_cpu_memory_pids_delegation',
  'dedicated_launcher_principal',
  'dedicated_materializer_principal',
  'immutable_runtime_rootfs',
  'multi_uid_active_containment',
  'postgresql_17',
  'preprovisioned_private_state',
  'seccomp_filter',
  'systemd_killmode_control_group',
  'unix_peer_credentials'
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

class ProcessExecutionReleaseError extends Error {
  constructor(message, code = 'PROCESS_RELEASE_CONTRACT_INVALID', details = {}) {
    super(message);
    this.name = 'ProcessExecutionReleaseError';
    this.code = code;
    this.failureKind = 'process_release_unavailable';
    this.details = details;
  }
}

function fail(message, code = 'PROCESS_RELEASE_CONTRACT_INVALID', details = {}) {
  throw new ProcessExecutionReleaseError(message, code, details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function closed(value, keys, label) {
  plainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exactly: ${keys.join(', ')}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function hashReleaseValue(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function exactIntegerArray(value, expected, label) {
  if (!Array.isArray(value) ||
      value.length !== expected.length ||
      value.some((entry, index) =>
        !Number.isSafeInteger(entry) || entry !== expected[index])) {
    fail(`${label} is not a supported compatibility version set`);
  }
  return [...value];
}

function exactStringArray(value, expected, label) {
  if (!Array.isArray(value) ||
      value.length !== expected.length ||
      value.some((entry, index) => entry !== expected[index])) {
    fail(`${label} is not the supported closed requirement set`);
  }
  return [...value];
}

function releaseContractAuthority({
  applicationVersion,
  sourceRevision
} = {}) {
  if (typeof applicationVersion !== 'string' ||
      !SEMVER_PATTERN.test(applicationVersion)) {
    fail('applicationVersion must be a canonical semantic version');
  }
  if (typeof sourceRevision !== 'string' ||
      !SOURCE_REVISION_PATTERN.test(sourceRevision)) {
    fail('sourceRevision must be the exact lowercase 40-character release commit');
  }
  return {
    version: PROCESS_EXECUTION_RELEASE_CONTRACT_VERSION,
    applicationVersion,
    sourceRevision,
    databaseSchemaVersion: PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION,
    minimumCompatibleDatabaseSchemaVersion:
      PROCESS_EXECUTION_MINIMUM_DATABASE_SCHEMA_VERSION,
    maximumCompatibleDatabaseSchemaVersion:
      PROCESS_EXECUTION_MAXIMUM_DATABASE_SCHEMA_VERSION,
    launcherProtocolVersion: PROCESS_LAUNCHER_FOUNDATION_PROTOCOL_VERSION,
    materializerProtocolVersion: PROCESS_MATERIALIZER_PROTOCOL_VERSION,
    processTargetCatalogSchemaVersion: PROCESS_TARGET_CATALOG_VERSION,
    rootfsRegistrySchemaVersion:
      PROCESS_EXECUTION_ROOTFS_REGISTRY_SCHEMA_VERSION,
    runtimeBudgetSnapshotVersions: [RUNTIME_BUDGET_SNAPSHOT_VERSION],
    completionAuthorityVersions: [COMPLETION_AUTHORITY_VERSION],
    completionDecisionVersions: [COMPLETION_DECISION_VERSION],
    processSupervisionVersions: [PROCESS_SUPERVISION_VERSION],
    processOperationSchemaVersions: [PROCESS_OPERATION_SCHEMA_VERSION],
    requiredFeatureFlags: [...REQUIRED_FEATURE_FLAGS],
    requiredNativeComponents: [...REQUIRED_NATIVE_COMPONENTS],
    requiredDeploymentCapabilities: [...REQUIRED_DEPLOYMENT_CAPABILITIES]
  };
}

function buildProcessExecutionReleaseContract(input = {}) {
  const authority = releaseContractAuthority(input);
  return normalizeProcessExecutionReleaseContract({
    ...authority,
    releaseContractHash: hashReleaseValue(authority)
  });
}

function normalizeProcessExecutionReleaseContract(value) {
  closed(
    value,
    PROCESS_EXECUTION_RELEASE_CONTRACT_KEYS,
    'process execution release contract'
  );
  if (value.version !== PROCESS_EXECUTION_RELEASE_CONTRACT_VERSION) {
    fail(
      `Unsupported process execution release contract version ${value.version}`,
      'PROCESS_RELEASE_VERSION_UNSUPPORTED'
    );
  }
  const expected = releaseContractAuthority({
    applicationVersion: value.applicationVersion,
    sourceRevision: value.sourceRevision
  });
  for (const key of [
    'databaseSchemaVersion',
    'minimumCompatibleDatabaseSchemaVersion',
    'maximumCompatibleDatabaseSchemaVersion',
    'launcherProtocolVersion',
    'materializerProtocolVersion',
    'processTargetCatalogSchemaVersion',
    'rootfsRegistrySchemaVersion'
  ]) {
    if (value[key] !== expected[key]) {
      fail(`process execution release contract.${key} is unsupported`);
    }
  }
  const normalized = {
    ...expected,
    runtimeBudgetSnapshotVersions: exactIntegerArray(
      value.runtimeBudgetSnapshotVersions,
      expected.runtimeBudgetSnapshotVersions,
      'runtimeBudgetSnapshotVersions'
    ),
    completionAuthorityVersions: exactIntegerArray(
      value.completionAuthorityVersions,
      expected.completionAuthorityVersions,
      'completionAuthorityVersions'
    ),
    completionDecisionVersions: exactIntegerArray(
      value.completionDecisionVersions,
      expected.completionDecisionVersions,
      'completionDecisionVersions'
    ),
    processSupervisionVersions: exactIntegerArray(
      value.processSupervisionVersions,
      expected.processSupervisionVersions,
      'processSupervisionVersions'
    ),
    processOperationSchemaVersions: exactIntegerArray(
      value.processOperationSchemaVersions,
      expected.processOperationSchemaVersions,
      'processOperationSchemaVersions'
    ),
    requiredFeatureFlags: exactStringArray(
      value.requiredFeatureFlags,
      expected.requiredFeatureFlags,
      'requiredFeatureFlags'
    ),
    requiredNativeComponents: exactStringArray(
      value.requiredNativeComponents,
      expected.requiredNativeComponents,
      'requiredNativeComponents'
    ),
    requiredDeploymentCapabilities: exactStringArray(
      value.requiredDeploymentCapabilities,
      expected.requiredDeploymentCapabilities,
      'requiredDeploymentCapabilities'
    )
  };
  if (typeof value.releaseContractHash !== 'string' ||
      !SHA256_PATTERN.test(value.releaseContractHash) ||
      value.releaseContractHash !== hashReleaseValue(normalized)) {
    fail('process execution release contract hash does not match its authority');
  }
  return deepFreeze({
    ...normalized,
    releaseContractHash: value.releaseContractHash
  });
}

function readinessIssue(code, category, message, severity = 'blocked') {
  if (!PROCESS_EXECUTION_RELEASE_ALERT_CATEGORIES.includes(category)) {
    fail(`Unknown release alert category ${category}`);
  }
  return { code, category, message, severity };
}

function evaluateProcessExecutionReleaseReadiness({
  releaseContract,
  installed = false,
  admissionEnabled = false,
  releaseState = null,
  migrationStatus = null,
  launcher = null,
  materializer = null,
  artifactStorage = null,
  targetCatalog = null,
  deployment = null,
  evaluatedAt = new Date().toISOString()
} = {}) {
  const issues = [];
  let contract = null;
  try {
    contract = normalizeProcessExecutionReleaseContract(releaseContract);
  } catch (error) {
    issues.push(readinessIssue(
      error.code || 'PROCESS_RELEASE_CONTRACT_INVALID',
      'release_contract_invalid',
      error.message
    ));
  }
  if (contract && (!migrationStatus ||
      migrationStatus.currentVersion < contract.minimumCompatibleDatabaseSchemaVersion ||
      migrationStatus.currentVersion > contract.maximumCompatibleDatabaseSchemaVersion ||
      migrationStatus.headVersion !== contract.databaseSchemaVersion ||
      migrationStatus.fullyApplied !== true ||
      migrationStatus.checksumsValid !== true ||
      migrationStatus.partial !== false ||
      migrationStatus.unknownMigrations !== 0)) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_SCHEMA_INCOMPATIBLE',
      'schema_incompatible',
      'PostgreSQL migration identity or schema compatibility is not current'
    ));
  }
  if (contract && releaseState && releaseState.admissionEnabled === true &&
      (releaseState.releaseContractHash !== contract.releaseContractHash ||
        releaseState.sourceRevision !== contract.sourceRevision ||
        releaseState.applicationVersion !== contract.applicationVersion)) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_GENERATION_MISMATCH',
      'native_component_mismatch',
      'Durable admission authority is bound to another release generation'
    ));
  }
  if (contract && launcher && launcher.available === true &&
      launcher.protocolVersion !== contract.launcherProtocolVersion) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_LAUNCHER_PROTOCOL_INCOMPATIBLE',
      'native_component_mismatch',
      'Launcher protocol is incompatible with this release'
    ));
  }
  if (contract && materializer && materializer.available === true &&
      materializer.protocolVersion !== contract.materializerProtocolVersion) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_MATERIALIZER_PROTOCOL_INCOMPATIBLE',
      'native_component_mismatch',
      'Materializer protocol is incompatible with this release'
    ));
  }
  if (contract && targetCatalog &&
      targetCatalog.schemaVersion !== contract.processTargetCatalogSchemaVersion) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_TARGET_CATALOG_INCOMPATIBLE',
      'native_component_mismatch',
      'Process target catalog schema is incompatible with this release'
    ));
  }
  if (contract && launcher && launcher.available === true &&
      launcher.rootfsRegistrySchemaVersion !==
        contract.rootfsRegistrySchemaVersion) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_ROOTFS_REGISTRY_INCOMPATIBLE',
      'native_component_mismatch',
      'Rootfs registry schema is incompatible with this release'
    ));
  }
  if (installed === true && (!launcher || launcher.available !== true)) {
    issues.push(readinessIssue(
      'PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE',
      'launcher_unavailable',
      'Launcher health is unavailable',
      'degraded_read_only'
    ));
  }
  if (installed === true && (!materializer || materializer.available !== true)) {
    issues.push(readinessIssue(
      'PROCESS_MATERIALIZER_UNAVAILABLE',
      'materializer_unavailable',
      'Materializer health is unavailable',
      'degraded_read_only'
    ));
  }
  if (installed === true && launcher && launcher.available === true &&
      launcher.readyForExecution !== true) {
    issues.push(readinessIssue(
      'PROCESS_CONTAINMENT_UNAVAILABLE',
      'containment_unavailable',
      'Active containment generation is unavailable',
      'degraded_read_only'
    ));
  }
  if (installed === true && (!artifactStorage ||
      artifactStorage.available !== true)) {
    issues.push(readinessIssue(
      'PROCESS_OUTPUT_ARTIFACT_FAILED',
      'artifact_cleanup_failed',
      'Process artifact storage is unavailable',
      'degraded_read_only'
    ));
  }
  if (installed === true && (!deployment ||
      deployment.validated !== true)) {
    issues.push(readinessIssue(
      'PROCESS_RELEASE_DEPLOYMENT_UNVALIDATED',
      'native_component_mismatch',
      'Required deployment capabilities are not validated'
    ));
  }
  const blocked = issues.some(issue => issue.severity === 'blocked');
  const degraded = issues.some(issue => issue.severity === 'degraded_read_only');
  const state = blocked
    ? 'blocked'
    : installed !== true || admissionEnabled !== true
      ? 'disabled'
      : degraded
        ? 'degraded_read_only'
        : 'ready';
  return deepFreeze({
    version: PROCESS_EXECUTION_RELEASE_READINESS_VERSION,
    state,
    releaseContractHash: contract ? contract.releaseContractHash : null,
    sourceRevision: contract ? contract.sourceRevision : null,
    admissionEnabled: admissionEnabled === true,
    recoveryAvailable: state !== 'blocked' && Boolean(
      migrationStatus && migrationStatus.fullyApplied === true
    ),
    evaluatedAt,
    issues: issues.map(issue => ({ ...issue }))
  });
}

module.exports = {
  PROCESS_EXECUTION_DATABASE_SCHEMA_VERSION,
  PROCESS_EXECUTION_MAXIMUM_DATABASE_SCHEMA_VERSION,
  PROCESS_EXECUTION_MINIMUM_DATABASE_SCHEMA_VERSION,
  PROCESS_EXECUTION_RELEASE_ALERT_CATEGORIES,
  PROCESS_EXECUTION_RELEASE_CONTRACT_KEYS,
  PROCESS_EXECUTION_RELEASE_CONTRACT_VERSION,
  PROCESS_EXECUTION_RELEASE_MANIFEST_VERSION,
  PROCESS_EXECUTION_RELEASE_READINESS_VERSION,
  PROCESS_EXECUTION_ROOTFS_REGISTRY_SCHEMA_VERSION,
  PROCESS_EXECUTION_READINESS_STATES,
  PROCESS_OPERATION_SCHEMA_VERSION,
  ProcessExecutionReleaseError,
  buildProcessExecutionReleaseContract,
  canonicalJson,
  evaluateProcessExecutionReleaseReadiness,
  hashReleaseValue,
  normalizeProcessExecutionReleaseContract
};
