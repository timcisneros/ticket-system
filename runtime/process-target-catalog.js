'use strict';

const fs = require('fs');
const path = require('path');
const {
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_EXECUTABLE_FORMAT,
  PROCESS_EXECUTION_POLICY,
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_LAUNCHER_ENVIRONMENT,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RUNTIME_PHASES,
  PROCESS_SHA256_PATTERN,
  compareCanonicalStrings,
  validateProcessIdentifier
} = require('./process-authority-constants');

const PROCESS_TARGET_CATALOG_HISTORICAL_VERSION = 1;
const PROCESS_TARGET_CATALOG_VERSION = 2;
const PROCESS_PROFILE_BOUNDS = Object.freeze({
  maxExecutableBytes: 4096,
  maxArgumentCount: 128,
  maxArgumentBytes: 16384,
  maxArgumentVectorBytes: 131072,
  maxEnvironmentEntries: 64,
  maxEnvironmentValueBytes: 16384
});
const PROCESS_PROFILE_LIMIT_KEYS_V1 = Object.freeze([
  'wallTimeMs',
  'maxOutputBytes',
  'maxProcesses'
]);
const PROCESS_PROFILE_LIMIT_KEYS_V2 = Object.freeze(Object.keys(PROCESS_PROFILE_HARD_LIMITS));
const SHELL_INTERPRETER_BASENAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'
]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONSERVATIVE_SENSITIVE_ENVIRONMENT_NAME_DENYLIST =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;

class ProcessTargetCatalogError extends Error {
  constructor(message, code = 'PROCESS_TARGET_CATALOG_INVALID', details = {}) {
    super(message);
    this.name = 'ProcessTargetCatalogError';
    this.code = code;
    this.failureKind = 'configuration_error';
    this.details = details;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function fail(message, details = {}) {
  throw new ProcessTargetCatalogError(message, 'PROCESS_TARGET_CATALOG_INVALID', details);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`);
  }
}

function onlyKeys(value, keys, label) {
  const unexpected = Object.keys(value).find(key => !keys.includes(key));
  if (unexpected) fail(`${label} includes unsupported field: ${unexpected}`, { field: unexpected });
}

function boundedString(value, label, maxBytes, { allowEmpty = true, singleLine = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string`);
  }
  if (value.includes('\0') || (singleLine && /[\r\n]/.test(value))) {
    fail(`${label} must not contain NUL, carriage-return, or newline characters`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    fail(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return value;
}

function normalizeAllowedPhases(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a nonempty array`);
  }
  const phases = value.map((phase, index) => {
    if (typeof phase !== 'string' || !PROCESS_RUNTIME_PHASES.includes(phase)) {
      fail(`${label}[${index}] must be one of ${PROCESS_RUNTIME_PHASES.join(', ')}`);
    }
    return phase;
  });
  if (new Set(phases).size !== phases.length) fail(`${label} must not contain duplicates`);
  return PROCESS_RUNTIME_PHASES.filter(phase => phases.includes(phase));
}

function normalizeExecutable(value, label) {
  const executable = boundedString(
    value,
    label,
    PROCESS_PROFILE_BOUNDS.maxExecutableBytes,
    { allowEmpty: false, singleLine: true }
  );
  if (!path.isAbsolute(executable)) fail(`${label} must be an absolute path`);
  if (path.normalize(executable) !== executable) fail(`${label} must be normalized`);
  if (/\s/.test(executable)) fail(`${label} must be one executable path, not a command string`);
  if (SHELL_INTERPRETER_BASENAMES.has(path.basename(executable).toLowerCase())) {
    fail(`${label} may not select a general shell interpreter`);
  }
  return executable;
}

function normalizeSha256(value, label) {
  if (typeof value !== 'string' || !PROCESS_SHA256_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function normalizeRuntimeRootfsEntry(value, label) {
  plainObject(value, label);
  onlyKeys(value, ['id', 'manifestSha256'], label);
  let id;
  try {
    id = validateProcessIdentifier(value.id, `${label}.id`);
  } catch (error) {
    fail(error.message);
  }
  return {
    id,
    manifestSha256: normalizeSha256(value.manifestSha256, `${label}.manifestSha256`)
  };
}

function normalizeExecutableIdentity(value, label) {
  plainObject(value, label);
  onlyKeys(value, ['path', 'sha256', 'format'], label);
  const executablePath = normalizeExecutable(value.path, `${label}.path`);
  if (value.format !== PROCESS_EXECUTABLE_FORMAT) {
    fail(`${label}.format must be ${PROCESS_EXECUTABLE_FORMAT}`);
  }
  return {
    path: executablePath,
    sha256: normalizeSha256(value.sha256, `${label}.sha256`),
    format: PROCESS_EXECUTABLE_FORMAT
  };
}

function normalizeArguments(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an ordered array of strings`);
  if (value.length > PROCESS_PROFILE_BOUNDS.maxArgumentCount) {
    fail(`${label} exceeds the ${PROCESS_PROFILE_BOUNDS.maxArgumentCount}-argument limit`);
  }
  let aggregateBytes = 0;
  const arguments_ = value.map((argument, index) => {
    const normalized = boundedString(
      argument,
      `${label}[${index}]`,
      PROCESS_PROFILE_BOUNDS.maxArgumentBytes
    );
    aggregateBytes += Buffer.byteLength(normalized, 'utf8');
    return normalized;
  });
  if (aggregateBytes > PROCESS_PROFILE_BOUNDS.maxArgumentVectorBytes) {
    fail(`${label} exceeds the ${PROCESS_PROFILE_BOUNDS.maxArgumentVectorBytes}-byte aggregate limit`);
  }
  return arguments_;
}

function normalizeWorkingDirectory(value, label) {
  const directory = boundedString(value, label, 4096, { allowEmpty: false, singleLine: true });
  if (path.isAbsolute(directory)) fail(`${label} must be relative to the run workspace`);
  if (directory.includes('\\')) fail(`${label} must use normalized POSIX separators`);
  const segments = directory.split('/');
  if (segments.includes('..')) fail(`${label} must not contain parent traversal`);
  const normalized = path.posix.normalize(directory);
  if (normalized !== directory || normalized.startsWith('../') || normalized === '..') {
    fail(`${label} must be a normalized path contained by the run workspace`);
  }
  return directory;
}

function normalizeEnvironment(value, label) {
  plainObject(value, label);
  const entries = Object.entries(value);
  if (entries.length > PROCESS_PROFILE_BOUNDS.maxEnvironmentEntries) {
    fail(`${label} exceeds the ${PROCESS_PROFILE_BOUNDS.maxEnvironmentEntries}-entry limit`);
  }
  const normalized = {};
  for (const [name, literal] of entries.sort(([left], [right]) =>
    compareCanonicalStrings(left, right))) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) fail(`${label} contains invalid variable name: ${name}`);
    if (Object.hasOwn(PROCESS_LAUNCHER_ENVIRONMENT, name)) {
      fail(`${label} cannot override launcher-owned variable: ${name}`);
    }
    if (CONSERVATIVE_SENSITIVE_ENVIRONMENT_NAME_DENYLIST.test(name)) {
      fail(`${label} variable name is denied by the conservative sensitive-name pattern: ${name}`);
    }
    normalized[name] = boundedString(
      literal,
      `${label}.${name}`,
      PROCESS_PROFILE_BOUNDS.maxEnvironmentValueBytes
    );
  }
  return normalized;
}

function normalizeLimits(value, label, version) {
  plainObject(value, label);
  const limitKeys = version === PROCESS_TARGET_CATALOG_HISTORICAL_VERSION
    ? PROCESS_PROFILE_LIMIT_KEYS_V1
    : PROCESS_PROFILE_LIMIT_KEYS_V2;
  onlyKeys(value, limitKeys, label);
  const result = {};
  for (const key of limitKeys) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
      fail(`${label}.${key} must be a positive safe integer`);
    }
    if (value[key] > PROCESS_PROFILE_HARD_LIMITS[key]) {
      fail(`${label}.${key} exceeds the hard ceiling of ${PROCESS_PROFILE_HARD_LIMITS[key]}`);
    }
    result[key] = value[key];
  }
  return result;
}

function normalizeFilesystemPolicy(value, label) {
  plainObject(value, label);
  const allowedKeys = [
    'inputMode',
    'writableRoots',
    'allowSymlinks',
    'allowSpecialFiles',
    'maxInputFiles',
    'maxInputBytes'
  ];
  onlyKeys(value, allowedKeys, label);
  for (const key of ['inputMode', 'allowSymlinks', 'allowSpecialFiles']) {
    if (value[key] !== PROCESS_FILESYSTEM_POLICY[key]) {
      fail(`${label}.${key} must be ${JSON.stringify(PROCESS_FILESYSTEM_POLICY[key])}`);
    }
  }
  if (!Array.isArray(value.writableRoots) || value.writableRoots.length !== 0) {
    fail(`${label}.writableRoots must be an empty array`);
  }
  const normalized = {
    inputMode: PROCESS_FILESYSTEM_POLICY.inputMode,
    writableRoots: [],
    allowSymlinks: false,
    allowSpecialFiles: false
  };
  for (const key of ['maxInputFiles', 'maxInputBytes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) {
      fail(`${label}.${key} must be a positive safe integer`);
    }
    if (value[key] > PROCESS_FILESYSTEM_POLICY_HARD_LIMITS[key]) {
      fail(
        `${label}.${key} exceeds the hard ceiling of ` +
        PROCESS_FILESYSTEM_POLICY_HARD_LIMITS[key]
      );
    }
    normalized[key] = value[key];
  }
  return normalized;
}

function normalizeProfile(value, label, version) {
  plainObject(value, label);
  const profileKeys = version === PROCESS_TARGET_CATALOG_HISTORICAL_VERSION
    ? [
        'id', 'allowedPhases', 'executable', 'arguments', 'workingDirectory',
        'environment', 'limits'
      ]
    : [
        'id', 'allowedPhases', 'runtimeRootfsId', 'executableIdentity',
        'arguments', 'workingDirectory', 'environment', 'filesystemPolicy', 'limits'
      ];
  onlyKeys(value, profileKeys, label);
  let id;
  try {
    id = validateProcessIdentifier(value.id, `${label}.id`);
  } catch (error) {
    fail(error.message);
  }
  const normalized = {
    id,
    allowedPhases: normalizeAllowedPhases(value.allowedPhases, `${label}.allowedPhases`),
    arguments: normalizeArguments(value.arguments, `${label}.arguments`),
    workingDirectory: normalizeWorkingDirectory(value.workingDirectory, `${label}.workingDirectory`),
    environment: normalizeEnvironment(value.environment, `${label}.environment`),
    limits: normalizeLimits(value.limits, `${label}.limits`, version)
  };
  if (version === PROCESS_TARGET_CATALOG_HISTORICAL_VERSION) {
    return {
      ...normalized,
      executable: normalizeExecutable(value.executable, `${label}.executable`)
    };
  }
  let runtimeRootfsId;
  try {
    runtimeRootfsId = validateProcessIdentifier(
      value.runtimeRootfsId,
      `${label}.runtimeRootfsId`
    );
  } catch (error) {
    fail(error.message);
  }
  return {
    ...normalized,
    runtimeRootfsId,
    executableIdentity: normalizeExecutableIdentity(
      value.executableIdentity,
      `${label}.executableIdentity`
    ),
    filesystemPolicy: normalizeFilesystemPolicy(
      value.filesystemPolicy,
      `${label}.filesystemPolicy`
    )
  };
}

function validateProcessTargetCatalog(value) {
  plainObject(value, 'process target catalog');
  if (![PROCESS_TARGET_CATALOG_HISTORICAL_VERSION, PROCESS_TARGET_CATALOG_VERSION]
    .includes(value.version)) {
    fail(
      `process target catalog.version must be ` +
      `${PROCESS_TARGET_CATALOG_HISTORICAL_VERSION} or ${PROCESS_TARGET_CATALOG_VERSION}`
    );
  }
  const isHistorical = value.version === PROCESS_TARGET_CATALOG_HISTORICAL_VERSION;
  onlyKeys(
    value,
    isHistorical ? ['version', 'targets'] : ['version', 'runtimeRootfs', 'targets'],
    'process target catalog'
  );
  let runtimeRootfs = [];
  if (!isHistorical) {
    if (!Array.isArray(value.runtimeRootfs)) {
      fail('process target catalog.runtimeRootfs must be an array');
    }
    if (value.runtimeRootfs.length >
        PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxRuntimeRootfsEntries) {
      fail(
        `process target catalog.runtimeRootfs exceeds the ` +
        `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxRuntimeRootfsEntries}-entry limit`
      );
    }
    runtimeRootfs = value.runtimeRootfs.map((entry, index) =>
      normalizeRuntimeRootfsEntry(entry, `process target catalog.runtimeRootfs[${index}]`));
    if (new Set(runtimeRootfs.map(entry => entry.id)).size !== runtimeRootfs.length) {
      fail('process target catalog.runtimeRootfs must have unique ids');
    }
    runtimeRootfs.sort((left, right) => compareCanonicalStrings(left.id, right.id));
  }
  if (!Array.isArray(value.targets)) fail('process target catalog.targets must be an array');
  if (value.targets.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTargetsPerCatalog) {
    fail(
      `process target catalog.targets exceeds the ` +
      `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTargetsPerCatalog}-target limit`
    );
  }
  let totalProfileCount = 0;
  const targets = value.targets.map((target, targetIndex) => {
    const label = `process target catalog.targets[${targetIndex}]`;
    plainObject(target, label);
    onlyKeys(target, ['id', 'profiles'], label);
    let id;
    try {
      id = validateProcessIdentifier(target.id, `${label}.id`);
    } catch (error) {
      fail(error.message);
    }
    if (!Array.isArray(target.profiles)) fail(`${label}.profiles must be an array`);
    if (target.profiles.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfilesPerTarget) {
      fail(
        `${label}.profiles exceeds the ` +
        `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfilesPerTarget}-profile limit`
      );
    }
    totalProfileCount += target.profiles.length;
    if (totalProfileCount > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTotalProfilesPerCatalog) {
      fail(
        `process target catalog exceeds the ` +
        `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxTotalProfilesPerCatalog}-profile total limit`
      );
    }
    const profiles = target.profiles.map((profile, profileIndex) =>
      normalizeProfile(profile, `${label}.profiles[${profileIndex}]`, value.version));
    if (!isHistorical) {
      for (const profile of profiles) {
        if (!runtimeRootfs.some(entry => entry.id === profile.runtimeRootfsId)) {
          fail(
            `${label}.profiles references unknown runtimeRootfsId: ` +
            profile.runtimeRootfsId
          );
        }
      }
    }
    const profileIds = profiles.map(profile => profile.id);
    if (new Set(profileIds).size !== profileIds.length) {
      fail(`${label}.profiles must have unique ids`);
    }
    profiles.sort((left, right) => compareCanonicalStrings(left.id, right.id));
    return { id, profiles };
  });
  const targetIds = targets.map(target => target.id);
  if (new Set(targetIds).size !== targetIds.length) {
    fail('process target catalog.targets must have unique ids');
  }
  targets.sort((left, right) => compareCanonicalStrings(left.id, right.id));
  return deepFreeze(isHistorical
    ? { version: PROCESS_TARGET_CATALOG_HISTORICAL_VERSION, targets }
    : { version: PROCESS_TARGET_CATALOG_VERSION, runtimeRootfs, targets });
}

function normalizeProcessProfileGrants(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProcessTargetCatalogError(
      'runtimeConfig.processProfileGrants must be an array',
      'PROCESS_PROFILE_GRANTS_INVALID'
    );
  }
  if (value.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxGrantEntriesPerAgent) {
    throw new ProcessTargetCatalogError(
      `runtimeConfig.processProfileGrants exceeds the ` +
      `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxGrantEntriesPerAgent}-entry limit`,
      'PROCESS_PROFILE_GRANTS_INVALID'
    );
  }
  const grants = value.map((grant, index) => {
    const label = `runtimeConfig.processProfileGrants[${index}]`;
    plainObject(grant, label);
    onlyKeys(grant, ['targetId', 'profileIds'], label);
    let targetId;
    try {
      targetId = validateProcessIdentifier(grant.targetId, `${label}.targetId`);
    } catch (error) {
      throw new ProcessTargetCatalogError(error.message, 'PROCESS_PROFILE_GRANTS_INVALID');
    }
    if (!Array.isArray(grant.profileIds) || grant.profileIds.length === 0) {
      throw new ProcessTargetCatalogError(
        `${label}.profileIds must be a nonempty array`,
        'PROCESS_PROFILE_GRANTS_INVALID'
      );
    }
    if (grant.profileIds.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfileIdsPerGrant) {
      throw new ProcessTargetCatalogError(
        `${label}.profileIds exceeds the ` +
        `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxProfileIdsPerGrant}-profile limit`,
        'PROCESS_PROFILE_GRANTS_INVALID'
      );
    }
    let profileIds;
    try {
      profileIds = grant.profileIds.map((profileId, profileIndex) =>
        validateProcessIdentifier(profileId, `${label}.profileIds[${profileIndex}]`));
    } catch (error) {
      throw new ProcessTargetCatalogError(error.message, 'PROCESS_PROFILE_GRANTS_INVALID');
    }
    if (new Set(profileIds).size !== profileIds.length) {
      throw new ProcessTargetCatalogError(
        `${label}.profileIds must not contain duplicates`,
        'PROCESS_PROFILE_GRANTS_INVALID'
      );
    }
    profileIds.sort(compareCanonicalStrings);
    return { targetId, profileIds };
  });
  const targetIds = grants.map(grant => grant.targetId);
  if (new Set(targetIds).size !== targetIds.length) {
    throw new ProcessTargetCatalogError(
      'runtimeConfig.processProfileGrants targetId values must be unique',
      'PROCESS_PROFILE_GRANTS_INVALID'
    );
  }
  grants.sort((left, right) => compareCanonicalStrings(left.targetId, right.targetId));
  return deepFreeze(grants);
}

function resolveProcessProfileGrants({ capabilityEnabled, catalog, grants }) {
  if (typeof capabilityEnabled !== 'boolean') {
    throw new TypeError('capabilityEnabled must be a boolean');
  }
  const normalizedCatalog = validateProcessTargetCatalog(catalog);
  const normalizedGrants = normalizeProcessProfileGrants(grants);
  if (!capabilityEnabled) return [];
  const profiles = [];
  for (const grant of normalizedGrants) {
    const target = normalizedCatalog.targets.find(candidate => candidate.id === grant.targetId);
    if (!target) {
      throw new ProcessTargetCatalogError(
        `Granted process target does not exist: ${grant.targetId}`,
        'PROCESS_TARGET_UNKNOWN',
        { targetId: grant.targetId }
      );
    }
    for (const profileId of grant.profileIds) {
      const profile = target.profiles.find(candidate => candidate.id === profileId);
      if (!profile) {
        throw new ProcessTargetCatalogError(
          `Granted process profile does not exist for ${grant.targetId}: ${profileId}`,
          'PROCESS_PROFILE_UNKNOWN',
          { targetId: grant.targetId, profileId }
        );
      }
      const resolved = {
        targetId: target.id,
        profileId: profile.id,
        allowedPhases: [...profile.allowedPhases],
        arguments: [...profile.arguments],
        workingDirectory: profile.workingDirectory,
        environment: { ...profile.environment },
        limits: { ...profile.limits },
        executionPolicy: { ...PROCESS_EXECUTION_POLICY }
      };
      if (normalizedCatalog.version === PROCESS_TARGET_CATALOG_HISTORICAL_VERSION) {
        profiles.push({
          ...resolved,
          executable: profile.executable
        });
      } else {
        const rootfs = normalizedCatalog.runtimeRootfs.find(
          entry => entry.id === profile.runtimeRootfsId
        );
        // Catalog validation already established this reference. Retain the check
        // here so the grant resolver fails closed if that invariant is changed.
        if (!rootfs) {
          throw new ProcessTargetCatalogError(
            `Process profile references unavailable runtime rootfs: ${profile.runtimeRootfsId}`,
            'PROCESS_ROOTFS_UNKNOWN',
            {
              targetId: target.id,
              profileId: profile.id,
              runtimeRootfsId: profile.runtimeRootfsId
            }
          );
        }
        profiles.push({
          ...resolved,
          runtimeRootfs: { ...rootfs },
          executableIdentity: { ...profile.executableIdentity },
          filesystemPolicy: {
            ...profile.filesystemPolicy,
            writableRoots: []
          }
        });
      }
      if (profiles.length > PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxResolvedProfilesPerSnapshot) {
        throw new ProcessTargetCatalogError(
          `Resolved process profile authority exceeds the ` +
          `${PROCESS_AUTHORITY_CARDINALITY_LIMITS.maxResolvedProfilesPerSnapshot}-profile limit`,
          'PROCESS_PROFILE_GRANTS_INVALID'
        );
      }
    }
  }
  profiles.sort((left, right) =>
    compareCanonicalStrings(left.targetId, right.targetId) ||
    compareCanonicalStrings(left.profileId, right.profileId));
  return profiles;
}

function loadProcessTargetCatalog(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ProcessTargetCatalogError(
      `Unable to read process target catalog ${filePath}: ${error.message}`,
      'PROCESS_TARGET_CATALOG_UNAVAILABLE',
      { filePath }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ProcessTargetCatalogError(
      `Unable to parse process target catalog ${filePath}: ${error.message}`,
      'PROCESS_TARGET_CATALOG_INVALID',
      { filePath }
    );
  }
  return validateProcessTargetCatalog(parsed);
}

module.exports = {
  PROCESS_AUTHORITY_CARDINALITY_LIMITS,
  PROCESS_EXECUTABLE_FORMAT,
  PROCESS_EXECUTION_POLICY,
  PROCESS_FILESYSTEM_POLICY,
  PROCESS_FILESYSTEM_POLICY_HARD_LIMITS,
  PROCESS_PROFILE_BOUNDS,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RUNTIME_PHASES,
  PROCESS_TARGET_CATALOG_HISTORICAL_VERSION,
  PROCESS_TARGET_CATALOG_VERSION,
  ProcessTargetCatalogError,
  loadProcessTargetCatalog,
  normalizeProcessProfileGrants,
  resolveProcessProfileGrants,
  validateProcessTargetCatalog
};
