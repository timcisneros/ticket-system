'use strict';

const fs = require('fs');
const path = require('path');
const {
  processIdentifier
} = require('./process-execution-contract');

const PROCESS_TARGET_CATALOG_VERSION = 1;
const PROCESS_RUNTIME_PHASES = Object.freeze(['inspection', 'mutation', 'verification']);
const PROCESS_EXECUTION_POLICY = Object.freeze({
  shell: false,
  stdin: 'disabled',
  detached: false,
  networkAccess: 'none',
  environmentMode: 'replace'
});
const PROCESS_PROFILE_BOUNDS = Object.freeze({
  maxExecutableBytes: 4096,
  maxArgumentCount: 128,
  maxArgumentBytes: 16384,
  maxArgumentVectorBytes: 131072,
  maxEnvironmentEntries: 64,
  maxEnvironmentValueBytes: 16384
});
const PROCESS_PROFILE_HARD_LIMITS = Object.freeze({
  wallTimeMs: 300000,
  maxOutputBytes: 16 * 1024 * 1024,
  maxProcesses: 64
});
const SHELL_INTERPRETER_BASENAMES = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh',
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'
]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENVIRONMENT_NAME_PATTERN =
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
  for (const [name, literal] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) fail(`${label} contains invalid variable name: ${name}`);
    if (SENSITIVE_ENVIRONMENT_NAME_PATTERN.test(name)) {
      fail(`${label} may not contain secret-bearing variable names: ${name}`);
    }
    normalized[name] = boundedString(
      literal,
      `${label}.${name}`,
      PROCESS_PROFILE_BOUNDS.maxEnvironmentValueBytes
    );
  }
  return normalized;
}

function normalizeLimits(value, label) {
  plainObject(value, label);
  onlyKeys(value, ['wallTimeMs', 'maxOutputBytes', 'maxProcesses'], label);
  const result = {};
  for (const key of ['wallTimeMs', 'maxOutputBytes', 'maxProcesses']) {
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

function normalizeProfile(value, label) {
  plainObject(value, label);
  onlyKeys(value, [
    'id', 'allowedPhases', 'executable', 'arguments', 'workingDirectory',
    'environment', 'limits'
  ], label);
  let id;
  try {
    id = processIdentifier(value.id, `${label}.id`);
  } catch (error) {
    fail(error.message);
  }
  return {
    id,
    allowedPhases: normalizeAllowedPhases(value.allowedPhases, `${label}.allowedPhases`),
    executable: normalizeExecutable(value.executable, `${label}.executable`),
    arguments: normalizeArguments(value.arguments, `${label}.arguments`),
    workingDirectory: normalizeWorkingDirectory(value.workingDirectory, `${label}.workingDirectory`),
    environment: normalizeEnvironment(value.environment, `${label}.environment`),
    limits: normalizeLimits(value.limits, `${label}.limits`)
  };
}

function validateProcessTargetCatalog(value) {
  plainObject(value, 'process target catalog');
  onlyKeys(value, ['version', 'targets'], 'process target catalog');
  if (value.version !== PROCESS_TARGET_CATALOG_VERSION) {
    fail(`process target catalog.version must be ${PROCESS_TARGET_CATALOG_VERSION}`);
  }
  if (!Array.isArray(value.targets)) fail('process target catalog.targets must be an array');
  const targets = value.targets.map((target, targetIndex) => {
    const label = `process target catalog.targets[${targetIndex}]`;
    plainObject(target, label);
    onlyKeys(target, ['id', 'profiles'], label);
    let id;
    try {
      id = processIdentifier(target.id, `${label}.id`);
    } catch (error) {
      fail(error.message);
    }
    if (!Array.isArray(target.profiles)) fail(`${label}.profiles must be an array`);
    const profiles = target.profiles.map((profile, profileIndex) =>
      normalizeProfile(profile, `${label}.profiles[${profileIndex}]`));
    const profileIds = profiles.map(profile => profile.id);
    if (new Set(profileIds).size !== profileIds.length) {
      fail(`${label}.profiles must have unique ids`);
    }
    profiles.sort((left, right) => left.id.localeCompare(right.id));
    return { id, profiles };
  });
  const targetIds = targets.map(target => target.id);
  if (new Set(targetIds).size !== targetIds.length) {
    fail('process target catalog.targets must have unique ids');
  }
  targets.sort((left, right) => left.id.localeCompare(right.id));
  return deepFreeze({ version: PROCESS_TARGET_CATALOG_VERSION, targets });
}

function normalizeProcessProfileGrants(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ProcessTargetCatalogError(
      'runtimeConfig.processProfileGrants must be an array',
      'PROCESS_PROFILE_GRANTS_INVALID'
    );
  }
  const grants = value.map((grant, index) => {
    const label = `runtimeConfig.processProfileGrants[${index}]`;
    plainObject(grant, label);
    onlyKeys(grant, ['targetId', 'profileIds'], label);
    let targetId;
    try {
      targetId = processIdentifier(grant.targetId, `${label}.targetId`);
    } catch (error) {
      throw new ProcessTargetCatalogError(error.message, 'PROCESS_PROFILE_GRANTS_INVALID');
    }
    if (!Array.isArray(grant.profileIds) || grant.profileIds.length === 0) {
      throw new ProcessTargetCatalogError(
        `${label}.profileIds must be a nonempty array`,
        'PROCESS_PROFILE_GRANTS_INVALID'
      );
    }
    let profileIds;
    try {
      profileIds = grant.profileIds.map((profileId, profileIndex) =>
        processIdentifier(profileId, `${label}.profileIds[${profileIndex}]`));
    } catch (error) {
      throw new ProcessTargetCatalogError(error.message, 'PROCESS_PROFILE_GRANTS_INVALID');
    }
    if (new Set(profileIds).size !== profileIds.length) {
      throw new ProcessTargetCatalogError(
        `${label}.profileIds must not contain duplicates`,
        'PROCESS_PROFILE_GRANTS_INVALID'
      );
    }
    profileIds.sort();
    return { targetId, profileIds };
  });
  const targetIds = grants.map(grant => grant.targetId);
  if (new Set(targetIds).size !== targetIds.length) {
    throw new ProcessTargetCatalogError(
      'runtimeConfig.processProfileGrants targetId values must be unique',
      'PROCESS_PROFILE_GRANTS_INVALID'
    );
  }
  grants.sort((left, right) => left.targetId.localeCompare(right.targetId));
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
      profiles.push({
        targetId: target.id,
        profileId: profile.id,
        allowedPhases: [...profile.allowedPhases],
        executable: profile.executable,
        arguments: [...profile.arguments],
        workingDirectory: profile.workingDirectory,
        environment: { ...profile.environment },
        limits: { ...profile.limits },
        executionPolicy: { ...PROCESS_EXECUTION_POLICY }
      });
    }
  }
  profiles.sort((left, right) =>
    left.targetId.localeCompare(right.targetId) || left.profileId.localeCompare(right.profileId));
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
  PROCESS_EXECUTION_POLICY,
  PROCESS_PROFILE_BOUNDS,
  PROCESS_PROFILE_HARD_LIMITS,
  PROCESS_RUNTIME_PHASES,
  PROCESS_TARGET_CATALOG_VERSION,
  ProcessTargetCatalogError,
  loadProcessTargetCatalog,
  normalizeProcessProfileGrants,
  resolveProcessProfileGrants,
  validateProcessTargetCatalog
};
