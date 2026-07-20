'use strict';

const REQUIRED_WORKSPACE_OWNERSHIP_REPOSITORY_METHODS = Object.freeze([
  'findMutationConflict',
  'listArtifactOwners'
]);

const MUTATING_OPERATIONS = new Set(['createFolder', 'writeFile', 'renamePath', 'deletePath']);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
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

function optionalPositiveSafeInteger(value, label) {
  return value === null || value === undefined ? null : positiveSafeInteger(value, label);
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function normalizeWorkspaceOwnershipPath(value) {
  const raw = String(value === undefined || value === null ? '' : value).replaceAll('\\', '/').trim();
  if (!raw || raw === '.') return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:\//.test(raw) || raw.includes('\0')) {
    throw new TypeError(`Unsafe workspace path: ${raw}`);
  }
  const parts = raw.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new TypeError(`Unsafe workspace path: ${raw}`);
  return parts.join('/') || null;
}

function workspaceMutationFingerprint(operation, args = {}) {
  if (operation === 'writeFile') return `writeFile:${args.path}`;
  if (operation === 'createFolder') return `createFolder:${args.path}`;
  if (operation === 'renamePath') return `renamePath:${args.path}->${args.nextPath}`;
  if (operation === 'deletePath') return `deletePath:${args.path}`;
  return null;
}

function workspaceArtifactPath(operation, args = {}) {
  if (operation === 'writeFile' || operation === 'createFolder') {
    return normalizeWorkspaceOwnershipPath(args.path);
  }
  if (operation === 'renamePath') return normalizeWorkspaceOwnershipPath(args.nextPath);
  return null;
}

function operationTargetId(record) {
  if (!record || typeof record !== 'object') return null;
  return record.targetId || (record.mutationReceipt && record.mutationReceipt.targetId) || null;
}

function operationArgs(record) {
  return record && record.args && typeof record.args === 'object' && !Array.isArray(record.args)
    ? record.args
    : {};
}

function artifactOwnerProjection(record) {
  const artifactPath = workspaceArtifactPath(record.operation, operationArgs(record));
  if (!artifactPath || record.error || record.outcome === 'failed' || record.outcome === 'refused') return null;
  return {
    ...record,
    artifactPath,
    targetId: operationTargetId(record)
  };
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertWorkspaceOwnershipRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('workspace ownership repository is required');
  for (const method of REQUIRED_WORKSPACE_OWNERSHIP_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`workspace ownership repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonWorkspaceOwnershipRepository {
  constructor({ readOperationHistory, maxQueryRows = 1000 } = {}) {
    this.readOperationHistory = requiredFunction(readOperationHistory, 'readOperationHistory');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  _limit(value) {
    const limit = positiveSafeInteger(value, 'limit');
    if (limit > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return limit;
  }

  async findMutationConflict({ runId, targetId, operation, args = {} } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const target = requiredString(targetId, 'targetId');
    const operationName = requiredString(operation, 'operation');
    if (!MUTATING_OPERATIONS.has(operationName)) return null;
    const sourcePath = normalizeWorkspaceOwnershipPath(args.path);
    const fingerprint = workspaceMutationFingerprint(operationName, args);
    if (!sourcePath || !fingerprint) return null;

    return this.readOperationHistory().find(record => {
      if (!record || record.runId !== id || !MUTATING_OPERATIONS.has(record.operation)) return false;
      const recordTarget = operationTargetId(record);
      if (recordTarget && recordTarget !== target) return false;
      if (normalizeWorkspaceOwnershipPath(operationArgs(record).path) !== sourcePath) return false;
      if (workspaceMutationFingerprint(record.operation, operationArgs(record)) === fingerprint) return false;
      if (operationName === 'renamePath' && ['writeFile', 'createFolder'].includes(record.operation)) return false;
      return true;
    }) || null;
  }

  async listArtifactOwners({
    targetId,
    candidatePath,
    overlap = false,
    ticketId = null,
    excludeTicketId = null,
    afterId = 0,
    limit = 100
  } = {}) {
    const target = requiredString(targetId, 'targetId');
    const candidate = normalizeWorkspaceOwnershipPath(candidatePath);
    if (!candidate) throw new TypeError('candidatePath is required');
    const includeTicketId = optionalPositiveSafeInteger(ticketId, 'ticketId');
    const omittedTicketId = optionalPositiveSafeInteger(excludeTicketId, 'excludeTicketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = this._limit(limit);
    const owners = this.readOperationHistory()
      .map(artifactOwnerProjection)
      .filter(Boolean)
      .filter(owner => owner.id > cursor)
      .filter(owner => !owner.targetId || owner.targetId === target)
      .filter(owner => includeTicketId === null || owner.ticketId === includeTicketId)
      .filter(owner => omittedTicketId === null || owner.ticketId !== omittedTicketId)
      .filter(owner => overlap ? pathsOverlap(candidate, owner.artifactPath) : owner.artifactPath === candidate)
      .sort((left, right) => left.id - right.id)
      .slice(0, size);
    return {
      owners,
      nextAfterId: owners.length === size ? owners[owners.length - 1].id : null
    };
  }
}

module.exports = {
  JsonWorkspaceOwnershipRepository,
  REQUIRED_WORKSPACE_OWNERSHIP_REPOSITORY_METHODS,
  assertWorkspaceOwnershipRepository,
  normalizeWorkspaceOwnershipPath,
  workspaceArtifactPath,
  workspaceMutationFingerprint
};
