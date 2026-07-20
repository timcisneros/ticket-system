'use strict';

const BUILTIN_PERMISSIONS = Object.freeze([
  'ticket:create',
  'ticket:read',
  'ticket:update',
  'ticket:delete',
  'user:create',
  'user:read',
  'user:update',
  'user:delete',
  'group:create',
  'group:read',
  'group:update',
  'group:delete',
  'permission:assign',
  'workflow:manage',
  'workspace:read',
  'workspace:write',
  'workspace:reset',
  'workspace.delete.cross_ticket_artifact',
  'browser:read',
  'browser:operate',
  'processTemplate:manage',
  'workContext:manage',
  'watcher:manage',
  'modelRouting:manage',
  'connector:manage',
  'connector:read',
  'connector:write',
  'ops:read',
  'runtimeLimits:manage'
]);

const REQUIRED_ACCESS_CATALOG_REPOSITORY_METHODS = Object.freeze([
  'listUsers',
  'getUserById',
  'getUserByUsername',
  'listGroups',
  'getGroupById',
  'getGroupsByIds',
  'listPermissions',
  'listUserGroupMemberships',
  'getUserAuthorization',
  'createUser',
  'updateUser',
  'deleteUser',
  'createGroup',
  'updateGroup',
  'deleteGroup',
  'ensureBootstrapAccess'
]);

class AccessCatalogConflictError extends Error {
  constructor(entity, id, expectedRevision, current = null) {
    super(`${entity} ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'AccessCatalogConflictError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class AccessCatalogNameConflictError extends Error {
  constructor(entity, name) {
    super(`${entity} name already exists: ${name}`);
    this.name = 'AccessCatalogNameConflictError';
    this.code = entity === 'user' ? 'USER_NAME_CONFLICT' : 'GROUP_NAME_CONFLICT';
    this.entity = entity;
    this.nameValue = name;
  }
}

class AccessCatalogReferenceError extends Error {
  constructor(message, code = 'ACCESS_CATALOG_REFERENCE_ERROR') {
    super(message);
    this.name = 'AccessCatalogReferenceError';
    this.code = code;
  }
}

function assertAccessCatalogRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('access catalog repository is required');
  for (const method of REQUIRED_ACCESS_CATALOG_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`access catalog repository must implement ${method}()`);
    }
  }
  return repository;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return number;
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function normalizeIds(value, label, maximum, { allowEmpty = true } = {}) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} must be an array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function compareCatalogNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePermissionNames(value, allowed, maximum) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('permissions must be an array');
  const names = [...new Set(value.map((name, index) => requiredString(name, `permissions[${index}]`)))];
  if (names.length > maximum) throw new RangeError(`permissions exceeds the configured maximum of ${maximum}`);
  const allowedNames = allowed instanceof Set ? allowed : new Set(allowed || []);
  const missing = names.find(name => !allowedNames.has(name));
  if (missing) throw new AccessCatalogReferenceError(`Permission does not exist: ${missing}`, 'PERMISSION_NOT_FOUND');
  return names.sort(compareCatalogNames);
}

module.exports = {
  BUILTIN_PERMISSIONS,
  REQUIRED_ACCESS_CATALOG_REPOSITORY_METHODS,
  AccessCatalogConflictError,
  AccessCatalogNameConflictError,
  AccessCatalogReferenceError,
  assertAccessCatalogRepository,
  positiveSafeInteger,
  nonNegativeSafeInteger,
  requiredString,
  compareCatalogNames,
  normalizeIds,
  normalizePermissionNames
};
