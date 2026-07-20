'use strict';

const PERFORMANCE_OPERATIONS = new Set(['writeFile', 'createFolder', 'renamePath', 'deletePath']);

const REQUIRED_PERFORMANCE_ANALYTICS_REPOSITORY_METHODS = Object.freeze([
  'listPerformanceRunEvidence'
]);

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function boundedLimit(value, maximum, label = 'limit') {
  const limit = positiveSafeInteger(value, label);
  if (limit > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return limit;
}

function isPerformanceOperation(record) {
  return Boolean(record && PERFORMANCE_OPERATIONS.has(record.operation) &&
    !record.error && record.outcome !== 'failed' && record.outcome !== 'refused');
}

function assertPerformanceAnalyticsRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('performance analytics repository is required');
  }
  for (const method of REQUIRED_PERFORMANCE_ANALYTICS_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`performance analytics repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonPerformanceAnalyticsRepository {
  constructor({
    readRuns,
    readTickets,
    readOperationHistory,
    readReplaySnapshot,
    getRunLogMetrics,
    maxQueryRows = 1_000,
    maxEvidenceRowsPerRun = maxQueryRows
  } = {}) {
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.readOperationHistory = requiredFunction(readOperationHistory, 'readOperationHistory');
    this.readReplaySnapshot = requiredFunction(readReplaySnapshot, 'readReplaySnapshot');
    this.getRunLogMetrics = requiredFunction(getRunLogMetrics, 'getRunLogMetrics');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.maxEvidenceRowsPerRun = positiveSafeInteger(maxEvidenceRowsPerRun, 'maxEvidenceRowsPerRun');
  }

  async listPerformanceRunEvidence({ afterRunId = 0, throughRunId = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterRunId, 'afterRunId');
    const size = boundedLimit(limit, this.maxQueryRows);
    const runs = this.readRuns();
    const highWaterRunId = throughRunId === null || throughRunId === undefined
      ? runs.reduce((maximum, run) => Math.max(maximum, Number.isSafeInteger(run && run.id) ? run.id : 0), 0)
      : nonNegativeSafeInteger(throughRunId, 'throughRunId');
    const candidates = runs
      .filter(run => run && Number.isSafeInteger(run.id) && run.id > cursor && run.id <= highWaterRunId)
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const pageRuns = candidates.slice(0, size);
    if (pageRuns.length === 0) return { evidence: [], nextAfterRunId: null, throughRunId: highWaterRunId };

    const runIds = pageRuns.map(run => run.id);
    const selectedRunIds = new Set(runIds);
    const ticketsById = new Map(this.readTickets()
      .filter(ticket => ticket && Number.isSafeInteger(ticket.id))
      .map(ticket => [ticket.id, ticket]));
    const operationsByRunId = new Map(runIds.map(runId => [runId, []]));
    for (const operation of this.readOperationHistory()) {
      if (!operation || !selectedRunIds.has(operation.runId) || !isPerformanceOperation(operation)) continue;
      const operations = operationsByRunId.get(operation.runId);
      operations.push(operation);
      if (operations.length > this.maxEvidenceRowsPerRun) {
        throw new RangeError(
          `run ${operation.runId} performance operation evidence exceeds the configured maximum of ${this.maxEvidenceRowsPerRun}`
        );
      }
    }
    operationsByRunId.forEach(operations => operations.sort((left, right) => (left.id || 0) - (right.id || 0)));

    const [replaySnapshots, logMetrics] = await Promise.all([
      Promise.all(pageRuns.map(run => this.readReplaySnapshot(run))),
      this.getRunLogMetrics({ runIds })
    ]);
    const logMetricsByRunId = new Map((logMetrics || []).map(metric => [metric.runId, metric]));
    const evidence = pageRuns.map((run, index) => ({
      run,
      ticket: ticketsById.get(run.ticketId) || null,
      replaySnapshot: replaySnapshots[index] || null,
      operationHistory: operationsByRunId.get(run.id) || [],
      logMetrics: logMetricsByRunId.get(run.id) || null
    }));
    const last = evidence[evidence.length - 1];
    return {
      evidence,
      nextAfterRunId: candidates.length > size && last ? last.run.id : null,
      throughRunId: highWaterRunId
    };
  }
}

module.exports = {
  JsonPerformanceAnalyticsRepository,
  PERFORMANCE_OPERATIONS,
  REQUIRED_PERFORMANCE_ANALYTICS_REPOSITORY_METHODS,
  assertPerformanceAnalyticsRepository,
  isPerformanceOperation
};
