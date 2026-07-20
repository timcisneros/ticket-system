'use strict';

const {
  REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS,
  WorkflowCatalogConflictError,
  WorkflowCatalogIdConflictError,
  compareWorkflowIds,
  normalizeWorkflowIds,
  normalizeWorkflowRecord,
  normalizeWorkflowValue,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  timestamp
} = require('../workflow-catalog');

class JsonWorkflowCatalogRepository {
  constructor({
    readWorkflows,
    writeWorkflows,
    appendSystemLog,
    appendRunEvidence = null,
    queueMutation = null,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readWorkflows = requiredFunction(readWorkflows, 'readWorkflows');
    this.writeWorkflows = requiredFunction(writeWorkflows, 'writeWorkflows');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.appendRunEvidence = appendRunEvidence === null ? null : requiredFunction(appendRunEvidence, 'appendRunEvidence');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.then(() => undefined, () => undefined);
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  _readRaw() {
    const records = this.readWorkflows();
    if (!Array.isArray(records)) throw new TypeError('workflow catalog must be an array');
    return structuredClone(records);
  }

  _read() {
    const records = this._readRaw().map(normalizeWorkflowRecord);
    const seen = new Set();
    for (const workflow of records) {
      if (seen.has(workflow.id)) throw new WorkflowCatalogIdConflictError(workflow.id);
      seen.add(workflow.id);
    }
    return records;
  }

  _limit(limit) {
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  async listWorkflows({ afterId = '', enabled = null, limit = 100 } = {}) {
    const cursor = String(afterId || '');
    const size = this._limit(limit);
    if (enabled !== null && typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean or null');
    const matches = this._read()
      .filter(item => compareWorkflowIds(item.id, cursor) > 0 && (enabled === null || item.enabled === enabled))
      .sort((left, right) => compareWorkflowIds(left.id, right.id))
      .slice(0, size + 1);
    const workflows = matches.slice(0, size);
    return {
      workflows,
      nextAfterId: matches.length > size && workflows.length > 0 ? workflows[workflows.length - 1].id : null
    };
  }

  async getWorkflowById(workflowId) {
    const id = requiredString(workflowId, 'workflowId');
    return this._read().find(item => item.id === id) || null;
  }

  async getWorkflowsByIds({ workflowIds }) {
    const ids = normalizeWorkflowIds(workflowIds, this.maxQueryRows);
    const wanted = new Set(ids);
    return this._read().filter(item => wanted.has(item.id)).sort((left, right) => compareWorkflowIds(left.id, right.id));
  }

  async _appendAuditOrRollback(rollback, audit) {
    if (!audit) return null;
    try {
      return await this.appendSystemLog(audit);
    } catch (error) {
      this.writeWorkflows(rollback);
      throw error;
    }
  }

  createWorkflow({ value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const definition = normalizeWorkflowValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      const rollback = this._readRaw();
      const workflows = this._read();
      if (workflows.some(item => item.id === definition.id)) throw new WorkflowCatalogIdConflictError(definition.id);
      const now = timestamp(this.now(), 'now');
      const workflow = {
        ...definition,
        revision: 1,
        createdBy: actor,
        createdAt: now,
        updatedBy: actor,
        updatedAt: now
      };
      this.writeWorkflows([...workflows, workflow].sort((left, right) => compareWorkflowIds(left.id, right.id)));
      const auditLog = await this._appendAuditOrRollback(rollback, audit);
      return { workflow: structuredClone(workflow), auditLog };
    });
  }

  createWorkflowWithEvidence({ value, changedBy, evidence }) {
    return this.queueMutation(async () => {
      if (!this.appendRunEvidence) throw new TypeError('appendRunEvidence is required');
      const definition = normalizeWorkflowValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw new TypeError('evidence must be an object');
      }
      const rollback = this._readRaw();
      const workflows = this._read();
      if (workflows.some(item => item.id === definition.id)) throw new WorkflowCatalogIdConflictError(definition.id);
      const now = timestamp(this.now(), 'now');
      const workflow = {
        ...definition,
        revision: 1,
        createdBy: actor,
        createdAt: now,
        updatedBy: actor,
        updatedAt: now
      };
      this.writeWorkflows([...workflows, workflow].sort((left, right) => compareWorkflowIds(left.id, right.id)));
      try {
        const recordedEvidence = await this.appendRunEvidence(evidence);
        return { workflow: structuredClone(workflow), evidence: recordedEvidence };
      } catch (error) {
        this.writeWorkflows(rollback);
        throw error;
      }
    });
  }

  updateWorkflow({ workflowId, expectedRevision, value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = requiredString(workflowId, 'workflowId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const definition = normalizeWorkflowValue(value);
      if (definition.id !== id) throw new TypeError('Workflow id cannot be changed');
      const actor = requiredString(changedBy, 'changedBy');
      const rollback = this._readRaw();
      const workflows = this._read();
      const index = workflows.findIndex(item => item.id === id);
      if (index === -1) return null;
      const current = workflows[index];
      if (current.revision !== revision) throw new WorkflowCatalogConflictError(id, revision, structuredClone(current));
      const workflow = {
        ...definition,
        id,
        revision: revision + 1,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedBy: actor,
        updatedAt: timestamp(this.now(), 'now')
      };
      workflows[index] = workflow;
      this.writeWorkflows(workflows);
      const auditLog = await this._appendAuditOrRollback(rollback, audit);
      return { workflow: structuredClone(workflow), auditLog };
    });
  }

  ensureDefaultWorkflows({ definitions, changedBy = 'system' } = {}) {
    return this.queueMutation(async () => {
      if (!Array.isArray(definitions)) throw new TypeError('definitions must be an array');
      const actor = requiredString(changedBy, 'changedBy');
      const workflows = this._read();
      const known = new Set(workflows.map(item => item.id));
      const createdWorkflowIds = [];
      const now = timestamp(this.now(), 'now');
      for (const value of definitions) {
        const definition = normalizeWorkflowValue(value);
        if (known.has(definition.id)) continue;
        known.add(definition.id);
        createdWorkflowIds.push(definition.id);
        workflows.push({
          ...definition,
          revision: 1,
          createdBy: actor,
          createdAt: now,
          updatedBy: actor,
          updatedAt: now
        });
      }
      if (createdWorkflowIds.length > 0) {
        this.writeWorkflows(workflows.sort((left, right) => compareWorkflowIds(left.id, right.id)));
      }
      return { changed: createdWorkflowIds.length > 0, createdWorkflowIds };
    });
  }
}

module.exports = { JsonWorkflowCatalogRepository, REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS };
