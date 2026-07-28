'use strict';

const PROCESS_IDENTIFIER_MAX_LENGTH = 128;
const PROCESS_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROCESS_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const PROCESS_RUNTIME_PHASES = Object.freeze([
  'inspection',
  'mutation',
  'verification'
]);

const PROCESS_RESOLUTION_RUNTIME_PHASES = Object.freeze([
  'planning',
  ...PROCESS_RUNTIME_PHASES,
  'terminalization'
]);

const PROCESS_EXECUTION_POLICY = Object.freeze({
  shell: false,
  stdin: 'disabled',
  detached: false,
  networkAccess: 'none',
  environmentMode: 'replace'
});

const PROCESS_NETWORK_ACCESS_NONE_MEANING =
  'The process and its descendants cannot communicate with anything outside their operation sandbox.';

const PROCESS_EXECUTABLE_FORMAT = 'elf';

const PROCESS_FILESYSTEM_POLICY = Object.freeze({
  inputMode: 'materialized_read_only',
  writableRoots: Object.freeze([]),
  allowSymlinks: false,
  allowSpecialFiles: false
});

const PROCESS_FILESYSTEM_POLICY_HARD_LIMITS = Object.freeze({
  maxInputFiles: 10000,
  maxInputBytes: 256 * 1024 * 1024
});

const PROCESS_PROFILE_HARD_LIMITS = Object.freeze({
  wallTimeMs: 300000,
  maxOutputBytes: 16 * 1024 * 1024,
  // cgroup-v2 pids.max semantics: kernel tasks, including threads and future
  // namespace-init overhead, excluding the trusted launcher daemon.
  maxProcesses: 64,
  memoryBytes: 1024 * 1024 * 1024,
  cpuQuotaMicrosPer100ms: 100000,
  maxOpenFiles: 256,
  maxFileBytes: 64 * 1024 * 1024,
  maxTempBytes: 256 * 1024 * 1024
});

const PROCESS_RESOURCE_LIMIT_CAUSES = Object.freeze([
  'memory',
  'process_count',
  'cpu',
  'open_files',
  'file_size',
  'temporary_storage',
  'launcher_capacity'
]);

// These are authority-size ceilings, not executor resource limits. They keep
// trusted configuration, admission work, persisted snapshots, and hashing
// bounded before any process executor exists.
const PROCESS_AUTHORITY_CARDINALITY_LIMITS = Object.freeze({
  maxRuntimeRootfsEntries: 32,
  maxTargetsPerCatalog: 64,
  maxProfilesPerTarget: 64,
  maxTotalProfilesPerCatalog: 256,
  maxGrantEntriesPerAgent: 32,
  maxProfileIdsPerGrant: 32,
  maxResolvedProfilesPerSnapshot: 128
});

function compareCanonicalStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateProcessIdentifier(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value !== value.trim()) {
    throw new TypeError(`${label} must not have surrounding whitespace`);
  }
  if (value.length > PROCESS_IDENTIFIER_MAX_LENGTH) {
    throw new TypeError(`${label} must not exceed ${PROCESS_IDENTIFIER_MAX_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  if (!PROCESS_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(
      `${label} must use lowercase letters, numbers, dots, underscores, or hyphens and start with a letter or number`
    );
  }
  return value;
}

module.exports = {
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_EXECUTABLE_FORMAT,
  PROCESS_EXECUTION_POLICY,
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_IDENTIFIER_PATTERN,
  PROCESS_NETWORK_ACCESS_NONE_MEANING,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RESOLUTION_RUNTIME_PHASES,
  PROCESS_RESOURCE_LIMIT_CAUSES,
  PROCESS_RUNTIME_PHASES,
  PROCESS_SHA256_PATTERN,
  compareCanonicalStrings,
  validateProcessIdentifier
};
