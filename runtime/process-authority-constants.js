'use strict';

const PROCESS_IDENTIFIER_MAX_LENGTH = 128;
const PROCESS_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

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

// These are authority-size ceilings, not executor resource limits. They keep
// trusted configuration, admission work, persisted snapshots, and hashing
// bounded before any process executor exists.
const PROCESS_AUTHORITY_CARDINALITY_LIMITS = Object.freeze({
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
  PROCESS_EXECUTION_POLICY,
  PROCESS_IDENTIFIER_MAX_LENGTH,
  PROCESS_IDENTIFIER_PATTERN,
  PROCESS_RESOLUTION_RUNTIME_PHASES,
  PROCESS_RUNTIME_PHASES,
  compareCanonicalStrings,
  validateProcessIdentifier
};
