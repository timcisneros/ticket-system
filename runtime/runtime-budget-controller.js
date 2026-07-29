'use strict';

const {
  RuntimeBudgetError,
  getRunRuntimeBudgetSnapshot
} = require('./runtime-budget-contract');

const DEFAULT_CAPACITY_RETRY_MS = 250;
const DEFAULT_CAPACITY_LEASE_MS = 30_000;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class RuntimeBudgetController {
  constructor({
    repository,
    leaseOwner,
    renewRunLease = async () => {},
    isCancelled = async () => false,
    faultCheckpoint = async () => {}
  } = {}) {
    for (const method of [
      'reserveRunBudget',
      'commitRunBudget',
      'releaseRunBudget',
      'listRunBudgetCharges',
      'acquireRuntimeCapacity',
      'renewRuntimeCapacity',
      'releaseRuntimeCapacity'
    ]) {
      if (!repository || typeof repository[method] !== 'function') {
        throw new TypeError(`Runtime budget repository must implement ${method}()`);
      }
    }
    this.repository = repository;
    this.leaseOwner = String(leaseOwner || '').trim();
    if (!this.leaseOwner) throw new TypeError('leaseOwner is required');
    this.renewRunLease = renewRunLease;
    this.isCancelled = isCancelled;
    this.faultCheckpoint = faultCheckpoint;
  }

  snapshot(run) {
    return getRunRuntimeBudgetSnapshot(run);
  }

  async reserve(run, dimension, sourceIdentity, amount = 1) {
    if (!this.snapshot(run)) return null;
    const reservation = await this.repository.reserveRunBudget({
      runId: run.id,
      dimension,
      sourceIdentity,
      amount
    });
    await this.faultCheckpoint('after_budget_reservation_before_side_effect', {
      runId: run.id,
      dimension,
      sourceIdentity
    });
    return reservation;
  }

  async commit(run, dimension, sourceIdentity, amount = 1) {
    if (!this.snapshot(run)) return null;
    const committed = await this.repository.commitRunBudget({
      runId: run.id,
      dimension,
      sourceIdentity,
      amount
    });
    await this.faultCheckpoint('after_budget_charge_commit_before_operation_receipt', {
      runId: run.id,
      dimension,
      sourceIdentity
    });
    return committed;
  }

  async release(run, dimension, sourceIdentity, reason) {
    if (!this.snapshot(run)) return null;
    return this.repository.releaseRunBudget({
      runId: run.id,
      dimension,
      sourceIdentity,
      reason
    });
  }

  async charge(run, dimension, sourceIdentity, amount = 1) {
    await this.reserve(run, dimension, sourceIdentity, amount);
    return this.commit(run, dimension, sourceIdentity, amount);
  }

  async observedSideEffect(run, dimension, sourceIdentity) {
    if (!this.snapshot(run)) return;
    await this.faultCheckpoint('after_side_effect_before_budget_charge_commit', {
      runId: run.id,
      dimension,
      sourceIdentity
    });
  }

  async reconciling(run) {
    if (!this.snapshot(run)) return;
    await this.faultCheckpoint('during_budget_reconciliation', {
      runId: run.id
    });
  }

  async recoveringSchedulerLease(run) {
    if (!this.snapshot(run)) return;
    await this.faultCheckpoint('during_scheduler_lease_recovery', {
      runId: run.id
    });
  }

  assertDuration(run, observedAtMs = Date.now()) {
    const snapshot = this.snapshot(run);
    if (!snapshot) return;
    const startedAt = run.runtimeBudgetStartedAt || run.startedAt;
    const startedAtMs = Date.parse(startedAt || '');
    if (!Number.isFinite(startedAtMs)) {
      throw new RuntimeBudgetError(
        'Budgeted run has no durable runtime start timestamp',
        'RUN_BUDGET_SNAPSHOT_INVALID'
      );
    }
    const elapsedMs = Math.max(0, observedAtMs - startedAtMs);
    if (elapsedMs >= snapshot.maxRuntimeDurationMs) {
      throw new RuntimeBudgetError(
        `Run runtime duration exhausted after ${elapsedMs}ms`,
        'RUN_RUNTIME_DURATION_EXCEEDED',
        {
          runId: run.id,
          elapsedMs,
          limit: snapshot.maxRuntimeDurationMs
        }
      );
    }
  }

  async withCapacity(run, {
    capacityDomain,
    resourceKey,
    limit,
    sourceIdentity,
    operationIdentity = null,
    leaseDurationMs = DEFAULT_CAPACITY_LEASE_MS,
    retryMs = DEFAULT_CAPACITY_RETRY_MS
  }, operation) {
    if (!this.snapshot(run)) return operation();
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    let acquired = null;
    while (!acquired) {
      this.assertDuration(run);
      if (await this.isCancelled(run.id)) {
        const error = new Error('Run interrupted while waiting for runtime capacity');
        error.code = 'RUN_INTERRUPTED';
        throw error;
      }
      const result = await this.repository.acquireRuntimeCapacity({
        capacityDomain,
        resourceKey,
        limit,
        leaseOwner: this.leaseOwner,
        runId: run.id,
        operationIdentity,
        leaseDurationMs,
        sourceIdentity,
        waitRetryMs: retryMs
      });
      if (result.acquired) {
        acquired = result.slot;
        break;
      }
      await this.renewRunLease(run.id, {
        phase: 'capacity_waiting',
        capacityDomain,
        resourceKey,
        sourceIdentity
      });
      await sleep(retryMs);
    }
    await this.faultCheckpoint('after_capacity_acquisition_before_run_dispatch', {
      runId: run.id,
      capacityDomain,
      resourceKey,
      sourceIdentity
    });
    const renewalInterval = Math.max(250, Math.floor(leaseDurationMs / 3));
    let renewalFailure = null;
    const renewal = setInterval(() => {
      void Promise.all([
        this.renewRunLease(run.id, {
          phase: 'capacity_owned',
          capacityDomain,
          resourceKey,
          sourceIdentity
        }),
        this.repository.renewRuntimeCapacity({
          capacityDomain,
          resourceKey,
          slotNumber: acquired.slotNumber,
          leaseOwner: this.leaseOwner,
          runId: run.id,
          operationIdentity,
          leaseDurationMs
        })
      ]).then(([, capacityLease]) => {
        if (!capacityLease) {
          renewalFailure = new RuntimeBudgetError(
            'Runtime capacity lease was lost',
            'RUNTIME_CAPACITY_LEASE_CONFLICT'
          );
        }
      }).catch(error => {
        renewalFailure = error;
      });
    }, renewalInterval);
    renewal.unref?.();
    try {
      const result = await operation();
      if (renewalFailure) throw renewalFailure;
      return result;
    } finally {
      clearInterval(renewal);
      await this.faultCheckpoint('during_capacity_release', {
        runId: run.id,
        capacityDomain,
        resourceKey,
        sourceIdentity
      });
      const released = await this.repository.releaseRuntimeCapacity({
        capacityDomain,
        resourceKey,
        slotNumber: acquired.slotNumber,
        leaseOwner: this.leaseOwner,
        runId: run.id,
        operationIdentity,
        reason: 'operation_settled'
      });
      if (!released && !renewalFailure) {
        throw new RuntimeBudgetError(
          'Runtime capacity release could not prove ownership',
          'RUNTIME_CAPACITY_RECONCILIATION_FAILED'
        );
      }
    }
  }
}

module.exports = {
  DEFAULT_CAPACITY_LEASE_MS,
  DEFAULT_CAPACITY_RETRY_MS,
  RuntimeBudgetController
};
