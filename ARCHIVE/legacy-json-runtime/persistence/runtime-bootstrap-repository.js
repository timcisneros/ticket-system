'use strict';

const REQUIRED_RUNTIME_BOOTSTRAP_REPOSITORY_METHODS = Object.freeze([
  'acquireRuntimeAuthority',
  'prepareRuntimePersistence',
  'refreshRuntimeAuthority',
  'releaseRuntimeAuthority'
]);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function assertRuntimeBootstrapRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('runtime bootstrap repository is required');
  }
  for (const method of REQUIRED_RUNTIME_BOOTSTRAP_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`runtime bootstrap repository must implement ${method}()`);
    }
  }
  return repository;
}

class RuntimeAuthorityConflictError extends Error {
  constructor(owner = {}) {
    super(
      'DATA_DIR writer lock is owned by a live process; refusing startup. ' +
      `pid=${owner.pid || 'unknown'} dataDir=${owner.dataDir || 'unknown'}`
    );
    this.name = 'RuntimeAuthorityConflictError';
    this.code = 'RUNTIME_AUTHORITY_CONFLICT';
    this.owner = owner;
  }
}

class JsonRuntimeBootstrapRepository {
  constructor({
    acquireAuthority,
    startAuthorityHeartbeat,
    initializeRuntimeData,
    verifyRuntimeIntegrity,
    refreshAuthority,
    releaseAuthority
  } = {}) {
    this.acquireAuthority = requiredFunction(acquireAuthority, 'acquireAuthority');
    this.startAuthorityHeartbeat = requiredFunction(startAuthorityHeartbeat, 'startAuthorityHeartbeat');
    this.initializeRuntimeData = requiredFunction(initializeRuntimeData, 'initializeRuntimeData');
    this.verifyRuntimeIntegrity = requiredFunction(verifyRuntimeIntegrity, 'verifyRuntimeIntegrity');
    this.refreshAuthority = requiredFunction(refreshAuthority, 'refreshAuthority');
    this.releaseAuthority = requiredFunction(releaseAuthority, 'releaseAuthority');
    this.authority = null;
  }

  async acquireRuntimeAuthority() {
    if (this.authority) return this.authority;
    const result = await this.acquireAuthority();
    if (!result || result.acquired !== true) {
      throw new RuntimeAuthorityConflictError(result && result.lock ? result.lock : {});
    }
    try {
      await this.startAuthorityHeartbeat();
    } catch (error) {
      await this.releaseAuthority();
      throw error;
    }
    this.authority = Object.freeze({
      backend: 'json',
      mode: 'exclusive_writer',
      owner: result.lock || null
    });
    return this.authority;
  }

  async prepareRuntimePersistence() {
    if (!this.authority) {
      const error = new Error('JSON runtime persistence preparation requires writer authority');
      error.code = 'RUNTIME_AUTHORITY_REQUIRED';
      throw error;
    }
    await this.initializeRuntimeData();
    const integrity = await this.verifyRuntimeIntegrity();
    return {
      backend: 'json',
      authorityMode: this.authority.mode,
      ...(integrity && typeof integrity === 'object' ? integrity : {})
    };
  }

  async refreshRuntimeAuthority() {
    if (!this.authority) {
      const error = new Error('JSON runtime authority cannot be refreshed before acquisition');
      error.code = 'RUNTIME_AUTHORITY_REQUIRED';
      throw error;
    }
    await this.refreshAuthority();
    return this.authority;
  }

  async releaseRuntimeAuthority() {
    if (!this.authority) return false;
    try {
      await this.releaseAuthority();
    } finally {
      this.authority = null;
    }
    return true;
  }
}

module.exports = {
  JsonRuntimeBootstrapRepository,
  REQUIRED_RUNTIME_BOOTSTRAP_REPOSITORY_METHODS,
  RuntimeAuthorityConflictError,
  assertRuntimeBootstrapRepository
};
