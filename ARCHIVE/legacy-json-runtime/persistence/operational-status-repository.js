'use strict';

const REQUIRED_OPERATIONAL_STATUS_REPOSITORY_METHODS = Object.freeze([
  'getRuntimeOperationalSummary'
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

function boundedLimit(value, maximum) {
  const limit = positiveSafeInteger(value, 'limit');
  if (limit > maximum) throw new RangeError(`limit exceeds the configured maximum of ${maximum}`);
  return limit;
}

function assertOperationalStatusRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('operational status repository is required');
  }
  for (const method of REQUIRED_OPERATIONAL_STATUS_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`operational status repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonOperationalStatusRepository {
  constructor({
    readTickets,
    readRuns,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
  }

  async getRuntimeOperationalSummary({ limit = 10 } = {}) {
    const size = boundedLimit(limit, this.maxQueryRows);
    const tickets = this.readTickets();
    const runs = this.readRuns();
    const now = this.now();
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    if (Number.isNaN(nowMs)) throw new TypeError('now must return a valid timestamp');
    const count = (items, predicate) => items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
    const pendingRuns = count(runs, run => run && run.status === 'pending');
    const runningRuns = count(runs, run => run && run.status === 'running');
    const expiredLeaseCandidates = runs.filter(run => {
      if (!run || run.status !== 'running') return false;
      if (!run.leaseOwner || !run.leaseExpiresAt) return true;
      const expiresAt = Date.parse(run.leaseExpiresAt);
      return !Number.isNaN(expiresAt) && expiresAt <= nowMs;
    });
    return {
      tickets: {
        total: tickets.length,
        open: count(tickets, ticket => ticket && ['open', 'in_progress'].includes(ticket.status)),
        blocked: count(tickets, ticket => ticket && ticket.status === 'blocked'),
        completed: count(tickets, ticket => ticket && ticket.status === 'completed'),
        failed: count(tickets, ticket => ticket && ticket.status === 'failed')
      },
      runs: {
        total: runs.length,
        active: pendingRuns + runningRuns,
        pending: pendingRuns,
        running: runningRuns,
        completed: count(runs, run => run && run.status === 'completed'),
        failed: count(runs, run => run && run.status === 'failed'),
        interrupted: count(runs, run => run && run.status === 'interrupted'),
        expiredLeases: Math.min(expiredLeaseCandidates.length, this.maxQueryRows),
        expiredLeasesTruncated: expiredLeaseCandidates.length > this.maxQueryRows
      },
      recentFailedRuns: runs
        .filter(run => run && run.status === 'failed')
        .slice()
        .sort((left, right) => right.id - left.id)
        .slice(0, size)
        .map(run => ({ runId: run.id, ticketId: run.ticketId }))
    };
  }
}

module.exports = {
  JsonOperationalStatusRepository,
  REQUIRED_OPERATIONAL_STATUS_REPOSITORY_METHODS,
  assertOperationalStatusRepository
};
