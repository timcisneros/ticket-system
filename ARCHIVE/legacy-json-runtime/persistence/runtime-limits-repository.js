'use strict';

const {
  RuntimeLimitsConflictError,
  normalizeRuntimeLimitsConfig,
  normalizeRuntimeLimitsValues,
  positiveSafeInteger,
  requiredFunction,
  requiredString
} = require('../runtime-limits');

class JsonRuntimeLimitsRepository {
  constructor({
    readConfig,
    writeConfig,
    appendEvent,
    appendSystemLog,
    queueMutation = null,
    now = () => new Date()
  } = {}) {
    this.readConfig = requiredFunction(readConfig, 'readConfig');
    this.writeConfig = requiredFunction(writeConfig, 'writeConfig');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.then(() => undefined, () => undefined);
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  async getRuntimeLimitsConfig() {
    return normalizeRuntimeLimitsConfig(this.readConfig());
  }

  async updateRuntimeLimitsConfig({ expectedRevision, value, changedBy } = {}) {
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const normalizedValue = normalizeRuntimeLimitsValues(value);
    const actor = requiredString(changedBy, 'changedBy');
    return this.queueMutation(async () => {
      const previousRaw = this.readConfig();
      const previous = normalizeRuntimeLimitsConfig(previousRaw);
      if (previous.revision !== revision) throw new RuntimeLimitsConflictError(revision, previous);
      const next = normalizeRuntimeLimitsConfig({
        ...normalizedValue,
        revision: previous.revision + 1,
        updatedBy: actor,
        updatedAt: this.now()
      });
      const auditPayload = {
        actor,
        timestamp: next.updatedAt,
        revision: next.revision,
        oldValues: Object.fromEntries(Object.keys(normalizedValue).map(key => [key, previous[key]])),
        newValues: { ...normalizedValue }
      };

      this.writeConfig(next);
      try {
        const event = await this.appendEvent({ type: 'runtime_limits.updated', payload: auditPayload });
        const auditLog = await this.appendSystemLog({
          type: 'runtime_limits.updated',
          message: `Runtime limits updated by ${actor}`,
          metadata: auditPayload
        });
        return { config: next, event, auditLog };
      } catch (error) {
        // JSON cannot make the config, append-only event journal, and log file one
        // crash-atomic transaction. Restore the authority record when evidence
        // admission fails; callers still fail the mutation instead of accepting an
        // unaudited policy change.
        this.writeConfig(previousRaw);
        throw error;
      }
    });
  }
}

module.exports = { JsonRuntimeLimitsRepository };
