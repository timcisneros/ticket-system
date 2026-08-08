'use strict';

const {
  RUNTIME_BUDGET_DIMENSIONS,
  RUNTIME_CAPACITY_DOMAINS,
  RuntimeBudgetError,
  budgetLimitForDimension,
  normalizeRuntimeBudgetSnapshot
} = require('../../runtime/runtime-budget-contract');

const DIMENSIONS = new Set(RUNTIME_BUDGET_DIMENSIONS);
const CAPACITY_DOMAINS = new Set(RUNTIME_CAPACITY_DOMAINS);

function positiveInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nonnegativeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return number;
}

function boundedString(value, label, maximum) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized || normalized.length > maximum) {
    throw new TypeError(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return parsed.toISOString();
}

function dimension(value) {
  const normalized = boundedString(value, 'dimension', 64);
  if (!DIMENSIONS.has(normalized)) throw new TypeError(`Unsupported budget dimension: ${normalized}`);
  return normalized;
}

function capacityDomain(value) {
  const normalized = boundedString(value, 'capacityDomain', 64);
  if (!CAPACITY_DOMAINS.has(normalized)) {
    throw new TypeError(`Unsupported capacity domain: ${normalized}`);
  }
  return normalized;
}

function chargeFromRow(row) {
  return {
    id: positiveInteger(row.id, 'budgetCharge.id'),
    runId: positiveInteger(row.run_id, 'budgetCharge.runId'),
    ticketId: positiveInteger(row.ticket_id, 'budgetCharge.ticketId'),
    dimension: row.dimension,
    sourceIdentity: row.source_identity,
    reservedAmount: positiveInteger(row.reserved_amount, 'budgetCharge.reservedAmount'),
    committedAmount: nonnegativeInteger(row.committed_amount, 'budgetCharge.committedAmount'),
    state: row.state,
    createdAt: timestamp(row.created_at),
    committedAt: timestamp(row.committed_at),
    releasedAt: timestamp(row.released_at),
    revision: positiveInteger(row.revision, 'budgetCharge.revision')
  };
}

function capacitySlotFromRow(row) {
  return {
    capacityDomain: row.capacity_domain,
    resourceKey: row.resource_key,
    slotNumber: positiveInteger(row.slot_number, 'capacitySlot.slotNumber'),
    leaseOwner: row.lease_owner,
    runId: row.run_id === null ? null : positiveInteger(row.run_id, 'capacitySlot.runId'),
    operationIdentity: row.operation_identity,
    leaseExpiresAt: timestamp(row.lease_expires_at),
    acquiredAt: timestamp(row.acquired_at),
    revision: positiveInteger(row.revision, 'capacitySlot.revision')
  };
}

function exhaustionError(details) {
  return new RuntimeBudgetError(
    `Run ${details.runId} exhausted ${details.dimension} budget ` +
      `(${details.currentCommitted}+${details.currentReserved}+${details.requested}>${details.limit})`,
    'RUN_BUDGET_EXHAUSTED',
    details
  );
}

function methods() {
  return {
    async isRuntimeBudgetSchemaAvailable() {
      const result = await this.pool.query(
        `SELECT
           to_regclass($1) IS NOT NULL AS charges,
           to_regclass($2) IS NOT NULL AS capacity`,
        [
          `${this.schema}.run_budget_charges`,
          `${this.schema}.runtime_capacity_slots`
        ]
      );
      return result.rows[0].charges === true && result.rows[0].capacity === true;
    },

    async reserveRunBudget({
      runId,
      dimension: requestedDimension,
      sourceIdentity,
      amount = 1
    } = {}, { client: suppliedClient = null, deferExhaustion = false } = {}) {
      const id = positiveInteger(runId, 'runId');
      const normalizedDimension = dimension(requestedDimension);
      const source = boundedString(sourceIdentity, 'sourceIdentity', 512);
      const reservation = positiveInteger(amount, 'amount');
      const execute = async client => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`ticket-system:run-budget:${id}:${normalizedDimension}`]
        );
        const runResult = await client.query(
          `SELECT ticket_id, body FROM ${this.table('runs')} WHERE id = $1 FOR SHARE`,
          [id]
        );
        if (runResult.rowCount !== 1) {
          const error = new Error(`run ${id} was not found`);
          error.code = 'POSTGRES_RECORD_NOT_FOUND';
          throw error;
        }
        const snapshot = normalizeRuntimeBudgetSnapshot(
          runResult.rows[0].body.runtimeBudgetSnapshot
        );
        const limit = budgetLimitForDimension(snapshot, normalizedDimension);
        const existingResult = await client.query(
          `SELECT * FROM ${this.table('run_budget_charges')}
           WHERE run_id = $1 AND dimension = $2 AND source_identity = $3`,
          [id, normalizedDimension, source]
        );
        if (existingResult.rowCount === 1) {
          const existing = chargeFromRow(existingResult.rows[0]);
          if (existing.reservedAmount !== reservation) {
            throw new RuntimeBudgetError(
              'Budget reservation identity is already bound to another amount',
              'RUN_BUDGET_RESERVATION_CONFLICT',
              { runId: id, dimension: normalizedDimension, sourceIdentity: source }
            );
          }
          if (existing.state === 'released') {
            throw new RuntimeBudgetError(
              'A released budget source identity cannot be reused',
              'RUN_BUDGET_RECONCILIATION_FAILED',
              { runId: id, dimension: normalizedDimension, sourceIdentity: source }
            );
          }
          return { charge: existing, inserted: false, exhausted: null };
        }
        const usageResult = await client.query(
          `SELECT
             COALESCE(SUM(committed_amount) FILTER (WHERE state = 'committed'), 0)::bigint
               AS committed,
             COALESCE(SUM(reserved_amount) FILTER (WHERE state = 'reserved'), 0)::bigint
               AS reserved
           FROM ${this.table('run_budget_charges')}
           WHERE run_id = $1 AND dimension = $2`,
          [id, normalizedDimension]
        );
        const currentCommitted = nonnegativeInteger(
          usageResult.rows[0].committed,
          'budgetUsage.committed'
        );
        const currentReserved = nonnegativeInteger(
          usageResult.rows[0].reserved,
          'budgetUsage.reserved'
        );
        if (currentCommitted + currentReserved + reservation > limit) {
          const details = {
            runId: id,
            ticketId: positiveInteger(runResult.rows[0].ticket_id, 'run.ticketId'),
            dimension: normalizedDimension,
            sourceIdentity: source,
            requested: reservation,
            limit,
            currentCommitted,
            currentReserved,
            remaining: Math.max(0, limit - currentCommitted - currentReserved)
          };
          await this._appendEvent(client, {
            type: 'budget.exhausted',
            ticketId: details.ticketId,
            runId: id,
            payload: details
          });
          return { charge: null, inserted: false, exhausted: details };
        }
        const inserted = await client.query(
          `INSERT INTO ${this.table('run_budget_charges')}
            (run_id, ticket_id, dimension, source_identity, reserved_amount)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [id, runResult.rows[0].ticket_id, normalizedDimension, source, reservation]
        );
        const charge = chargeFromRow(inserted.rows[0]);
        await this._appendEvent(client, {
          type: 'budget.reserved',
          ticketId: charge.ticketId,
          runId: id,
          payload: {
            budgetSnapshotHash: snapshot.snapshotHash,
            dimension: normalizedDimension,
            sourceIdentity: source,
            amount: reservation,
            limit,
            currentCommitted,
            currentReserved: currentReserved + reservation,
            remaining: limit - currentCommitted - currentReserved - reservation
          }
        });
        return { charge, inserted: true, exhausted: null };
      };
      const result = suppliedClient
        ? await execute(suppliedClient)
        : await this.withTransaction(execute);
      if (result.exhausted && !deferExhaustion) throw exhaustionError(result.exhausted);
      return result;
    },

    async commitRunBudget({
      runId,
      dimension: requestedDimension,
      sourceIdentity,
      amount
    } = {}, { client: suppliedClient = null } = {}) {
      const id = positiveInteger(runId, 'runId');
      const normalizedDimension = dimension(requestedDimension);
      const source = boundedString(sourceIdentity, 'sourceIdentity', 512);
      const actual = normalizedDimension === 'output_artifact_bytes'
        ? nonnegativeInteger(amount, 'amount')
        : positiveInteger(amount, 'amount');
      const execute = async client => {
        const selected = await client.query(
          `SELECT charge.*, run.body
           FROM ${this.table('run_budget_charges')} AS charge
           JOIN ${this.table('runs')} AS run ON run.id = charge.run_id
           WHERE charge.run_id = $1 AND charge.dimension = $2
             AND charge.source_identity = $3
           FOR UPDATE OF charge`,
          [id, normalizedDimension, source]
        );
        if (selected.rowCount !== 1) {
          throw new RuntimeBudgetError(
            'Budget reservation does not exist',
            'RUN_BUDGET_RECONCILIATION_FAILED',
            { runId: id, dimension: normalizedDimension, sourceIdentity: source }
          );
        }
        const current = chargeFromRow(selected.rows[0]);
        if (current.state === 'committed') {
          if (current.committedAmount !== actual) {
            throw new RuntimeBudgetError(
              'Committed budget charge conflicts with the requested amount',
              'RUN_BUDGET_RESERVATION_CONFLICT'
            );
          }
          return { charge: current, committed: false };
        }
        if (current.state !== 'reserved' || actual > current.reservedAmount) {
          throw new RuntimeBudgetError(
            'Budget reservation cannot be committed',
            'RUN_BUDGET_RECONCILIATION_FAILED'
          );
        }
        const updated = await client.query(
          `UPDATE ${this.table('run_budget_charges')}
           SET state = 'committed',
               committed_amount = $4,
               committed_at = clock_timestamp(),
               revision = revision + 1
           WHERE run_id = $1 AND dimension = $2 AND source_identity = $3
             AND state = 'reserved'
           RETURNING *`,
          [id, normalizedDimension, source, actual]
        );
        const charge = chargeFromRow(updated.rows[0]);
        const snapshot = normalizeRuntimeBudgetSnapshot(selected.rows[0].body.runtimeBudgetSnapshot);
        const limit = budgetLimitForDimension(snapshot, normalizedDimension);
        const totals = await client.query(
          `SELECT
             COALESCE(SUM(committed_amount) FILTER (WHERE state = 'committed'), 0)::bigint
               AS committed,
             COALESCE(SUM(reserved_amount) FILTER (WHERE state = 'reserved'), 0)::bigint
               AS reserved
           FROM ${this.table('run_budget_charges')}
           WHERE run_id = $1 AND dimension = $2`,
          [id, normalizedDimension]
        );
        const committed = nonnegativeInteger(totals.rows[0].committed, 'budgetUsage.committed');
        const reserved = nonnegativeInteger(totals.rows[0].reserved, 'budgetUsage.reserved');
        await this._appendEvent(client, {
          type: 'budget.committed',
          ticketId: charge.ticketId,
          runId: id,
          payload: {
            budgetSnapshotHash: snapshot.snapshotHash,
            dimension: normalizedDimension,
            sourceIdentity: source,
            amount: actual,
            releasedUnusedAmount: current.reservedAmount - actual,
            limit,
            currentCommitted: committed,
            currentReserved: reserved,
            remaining: Math.max(0, limit - committed - reserved)
          }
        });
        if (actual < current.reservedAmount) {
          await this._appendEvent(client, {
            type: 'budget.released',
            ticketId: charge.ticketId,
            runId: id,
            payload: {
              budgetSnapshotHash: snapshot.snapshotHash,
              dimension: normalizedDimension,
              sourceIdentity: source,
              amount: current.reservedAmount - actual,
              reason: 'unused_reservation',
              limit,
              currentCommitted: committed,
              currentReserved: reserved,
              remaining: Math.max(0, limit - committed - reserved)
            }
          });
        }
        return { charge, committed: true };
      };
      return suppliedClient ? execute(suppliedClient) : this.withTransaction(execute);
    },

    // These three boundaries do not cross an external effect. Keeping the
    // budget lifecycle and the durable fact it authorizes in one transaction
    // removes partial internal states while preserving every charge and event.
    async appendRunEvidenceWithRunBudgetCharge({ budget, evidence } = {}) {
      const result = await this.withTransaction(async client => {
        const reservation = await this.reserveRunBudget(budget, {
          client,
          deferExhaustion: true
        });
        if (reservation.exhausted) return { exhausted: reservation.exhausted };
        const recorded = await this.appendRunEvidence(evidence, { client });
        const committed = await this.commitRunBudget(budget, { client });
        return { reservation, recorded, committed, exhausted: null };
      });
      if (result.exhausted) throw exhaustionError(result.exhausted);
      return result;
    },

    async heartbeatRunLeaseWithRunBudgetCharge({ budget, heartbeat } = {}) {
      const result = await this.withTransaction(async client => {
        const reservation = await this.reserveRunBudget(budget, {
          client,
          deferExhaustion: true
        });
        if (reservation.exhausted) return { exhausted: reservation.exhausted };
        const committed = await this.commitRunBudget(budget, { client });
        const recordedHeartbeat = await this.heartbeatRunLease(heartbeat, { client });
        return { reservation, committed, heartbeat: recordedHeartbeat, exhausted: null };
      });
      if (result.exhausted) throw exhaustionError(result.exhausted);
      return result;
    },

    async completeTargetOperationWithRunBudgetCommit({ budget, operation } = {}) {
      return this.withTransaction(async client => {
        const completion = await this.completeTargetOperation(operation, { client });
        const committed = await this.commitRunBudget(budget, { client });
        return { completion, committed };
      });
    },

    async prepareTargetOperationWithRunBudgetReservation({ budget, operation } = {}) {
      const result = await this.withTransaction(async client => {
        const reservation = await this.reserveRunBudget(budget, {
          client,
          deferExhaustion: true
        });
        if (reservation.exhausted) return { exhausted: reservation.exhausted };
        const preparation = await this.prepareTargetOperation(operation, { client });
        return { reservation, preparation, exhausted: null };
      });
      if (result.exhausted) throw exhaustionError(result.exhausted);
      return result;
    },

    async reserveAndReleaseRunBudget({ budget, reason } = {}) {
      const result = await this.withTransaction(async client => {
        const reservation = await this.reserveRunBudget(budget, {
          client,
          deferExhaustion: true
        });
        if (reservation.exhausted) return { exhausted: reservation.exhausted };
        const released = await this.releaseRunBudget({
          ...budget,
          reason
        }, { client });
        return { reservation, released, exhausted: null };
      });
      if (result.exhausted) throw exhaustionError(result.exhausted);
      return result;
    },

    async releaseRunBudget({
      runId,
      dimension: requestedDimension,
      sourceIdentity,
      reason = 'side_effect_not_observed'
    } = {}, { client: suppliedClient = null } = {}) {
      const id = positiveInteger(runId, 'runId');
      const normalizedDimension = dimension(requestedDimension);
      const source = boundedString(sourceIdentity, 'sourceIdentity', 512);
      const stableReason = boundedString(reason, 'reason', 1024);
      const execute = async client => {
        const selected = await client.query(
          `SELECT charge.*, run.body
           FROM ${this.table('run_budget_charges')} AS charge
           JOIN ${this.table('runs')} AS run ON run.id = charge.run_id
           WHERE charge.run_id = $1 AND charge.dimension = $2
             AND charge.source_identity = $3
           FOR UPDATE OF charge`,
          [id, normalizedDimension, source]
        );
        if (selected.rowCount !== 1) return null;
        const current = chargeFromRow(selected.rows[0]);
        if (current.state === 'released') return { charge: current, released: false };
        if (current.state === 'committed') {
          throw new RuntimeBudgetError(
            'Committed budget charges cannot be released',
            'RUN_BUDGET_RECONCILIATION_FAILED'
          );
        }
        const updated = await client.query(
          `UPDATE ${this.table('run_budget_charges')}
           SET state = 'released',
               released_at = clock_timestamp(),
               revision = revision + 1
           WHERE run_id = $1 AND dimension = $2 AND source_identity = $3
             AND state = 'reserved'
           RETURNING *`,
          [id, normalizedDimension, source]
        );
        const charge = chargeFromRow(updated.rows[0]);
        const snapshot = normalizeRuntimeBudgetSnapshot(selected.rows[0].body.runtimeBudgetSnapshot);
        const limit = budgetLimitForDimension(snapshot, normalizedDimension);
        await this._appendEvent(client, {
          type: 'budget.released',
          ticketId: charge.ticketId,
          runId: id,
          payload: {
            budgetSnapshotHash: snapshot.snapshotHash,
            dimension: normalizedDimension,
            sourceIdentity: source,
            amount: charge.reservedAmount,
            reason: stableReason,
            limit
          }
        });
        return { charge, released: true };
      };
      return suppliedClient ? execute(suppliedClient) : this.withTransaction(execute);
    },

    async listRunBudgetCharges(runId) {
      const id = positiveInteger(runId, 'runId');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('run_budget_charges')}
         WHERE run_id = $1 ORDER BY dimension, id`,
        [id]
      );
      return result.rows.map(chargeFromRow);
    },

    async getRunBudgetState(runId) {
      const id = positiveInteger(runId, 'runId');
      const runResult = await this.pool.query(
        `SELECT body FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount !== 1) return null;
      const snapshot = normalizeRuntimeBudgetSnapshot(
        runResult.rows[0].body.runtimeBudgetSnapshot
      );
      const charges = await this.listRunBudgetCharges(id);
      const [waitResult, exhaustionResult] = await Promise.all([
        this.pool.query(
          `SELECT capacity_domain, resource_key, source_identity, reason,
                  first_blocked_at, next_eligible_at, active, revision
           FROM ${this.table('run_capacity_waits')}
           WHERE run_id = $1`,
          [id]
        ),
        this.pool.query(
          `SELECT payload
           FROM ${this.table('events')}
           WHERE run_id = $1 AND type IN (
             'budget.exhausted',
             'feasibility.rejected'
           )
           ORDER BY position DESC
           LIMIT 1`,
          [id]
        )
      ]);
      const usage = {};
      for (const requestedDimension of RUNTIME_BUDGET_DIMENSIONS) {
        const relevant = charges.filter(charge => charge.dimension === requestedDimension);
        const committed = relevant.filter(charge => charge.state === 'committed')
          .reduce((sum, charge) => sum + charge.committedAmount, 0);
        const reserved = relevant.filter(charge => charge.state === 'reserved')
          .reduce((sum, charge) => sum + charge.reservedAmount, 0);
        const limit = budgetLimitForDimension(snapshot, requestedDimension);
        usage[requestedDimension] = {
          limit,
          committed,
          reserved,
          remaining: Math.max(0, limit - committed - reserved)
        };
      }
      const wait = waitResult.rowCount === 1 ? waitResult.rows[0] : null;
      return {
        snapshot,
        usage,
        charges,
        capacityWait: wait ? {
          capacityDomain: wait.capacity_domain,
          resourceKey: wait.resource_key,
          sourceIdentity: wait.source_identity,
          reason: wait.reason,
          firstBlockedAt: timestamp(wait.first_blocked_at),
          nextEligibleAt: timestamp(wait.next_eligible_at),
          active: wait.active === true,
          revision: positiveInteger(wait.revision, 'capacityWait.revision')
        } : null,
        exhaustion: exhaustionResult.rowCount === 1
          ? exhaustionResult.rows[0].payload
          : null
      };
    },

    async recordPendingRunCapacityWait({ runId, retryMs = 500 } = {}) {
      const id = positiveInteger(runId, 'runId');
      const retry = positiveInteger(retryMs, 'retryMs');
      return this.withTransaction(async client => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('ticket-system:run-admission', 0))`
        );
        const result = await client.query(
          `WITH policy AS (
             SELECT
               COALESCE(max_active_runs, $2::bigint) AS max_active_runs,
               COALESCE(local_model_concurrency, $3::bigint) AS local_model_concurrency
             FROM ${this.table('runtime_limit_config')}
             WHERE id = 1
           ), candidate AS (
             SELECT run.*, agent.provider
             FROM ${this.table('runs')} AS run
             JOIN ${this.table('configured_agents')} AS agent ON agent.id = run.agent_id
             WHERE run.id = $1 AND run.status = 'pending'
               AND (run.lease_owner IS NULL OR run.lease_expires_at <= clock_timestamp())
           ), active AS (
             SELECT
               COUNT(*)::bigint AS total,
               COUNT(*) FILTER (WHERE agent.provider = 'ollama')::bigint AS local_model
             FROM ${this.table('runs')} AS active_run
             JOIN ${this.table('configured_agents')} AS agent ON agent.id = active_run.agent_id
             WHERE active_run.status IN ('pending', 'running')
               AND active_run.lease_owner IS NOT NULL
               AND active_run.lease_expires_at > clock_timestamp()
           )
           SELECT candidate.*,
             policy.max_active_runs,
             policy.local_model_concurrency,
             active.total AS active_total,
             active.local_model AS active_local_model,
             EXISTS (
               SELECT 1 FROM ${this.table('runs')} AS sibling
               WHERE sibling.ticket_id = candidate.ticket_id
                 AND sibling.id <> candidate.id
                 AND sibling.status IN ('pending', 'running')
                 AND sibling.lease_owner IS NOT NULL
                 AND sibling.lease_expires_at > clock_timestamp()
                 AND (
                   COALESCE(
                     (candidate.body #>>
                       '{runtimeBudgetSnapshot,allowParallelRuns}')::boolean,
                     true
                   ) = false OR
                   COALESCE(
                     (sibling.body #>>
                       '{runtimeBudgetSnapshot,allowParallelRuns}')::boolean,
                     true
                   ) = false
                 )
             ) AS parallel_blocked
           FROM candidate CROSS JOIN policy CROSS JOIN active`,
          [id, this.defaultMaxActiveRuns, this.defaultLocalModelConcurrency]
        );
        if (result.rowCount !== 1) return null;
        const row = result.rows[0];
        let domain = null;
        let resource = null;
        let reason = null;
        if (Number(row.active_total) >= Number(row.max_active_runs)) {
          domain = 'global_run';
          resource = 'deployment';
          reason = 'Global active-run capacity is occupied';
        } else if (row.provider === 'ollama' &&
            Number(row.active_local_model) >= Number(row.local_model_concurrency)) {
          domain = 'model_provider';
          resource = 'ollama';
          reason = 'Local model-provider capacity is occupied';
        } else if (row.parallel_blocked === true) {
          domain = 'global_run';
          resource = `ticket:${row.ticket_id}`;
          reason = 'Ticket policy serializes active runs';
        }
        if (!domain) return null;
        const source = `scheduler:${id}`;
        const inserted = await client.query(
          `INSERT INTO ${this.table('run_capacity_waits')} AS current_wait
            (run_id, ticket_id, capacity_domain, resource_key, source_identity,
             reason, next_eligible_at)
           VALUES (
             $1, $2, $3, $4, $5, $6,
             clock_timestamp() + ($7::bigint * interval '1 millisecond')
           )
           ON CONFLICT (run_id) DO UPDATE
             SET next_eligible_at = EXCLUDED.next_eligible_at,
                 updated_at = clock_timestamp(),
                 revision = current_wait.revision + 1
             WHERE current_wait.active = false OR
               current_wait.capacity_domain <> EXCLUDED.capacity_domain OR
               current_wait.resource_key <> EXCLUDED.resource_key
           RETURNING *`,
          [id, row.ticket_id, domain, resource, source, reason, retry]
        );
        if (inserted.rowCount === 1) {
          await this._appendEvent(client, {
            type: 'capacity.waiting',
            ticketId: positiveInteger(row.ticket_id, 'run.ticketId'),
            runId: id,
            payload: {
              capacityDomain: domain,
              resourceKey: resource,
              sourceIdentity: source,
              reason,
              nextEligibleMs: retry
            }
          });
        }
        return { capacityDomain: domain, resourceKey: resource, reason };
      });
    },

    async acquireRuntimeCapacity({
      capacityDomain: requestedDomain,
      resourceKey,
      limit,
      leaseOwner,
      runId,
      operationIdentity = null,
      leaseDurationMs,
      sourceIdentity,
      waitRetryMs = 500
    } = {}) {
      const domain = capacityDomain(requestedDomain);
      const resource = boundedString(resourceKey, 'resourceKey', 256);
      const boundedLimit = positiveInteger(limit, 'limit');
      if (boundedLimit > 4096) throw new RangeError('capacity limit cannot exceed 4096');
      const owner = boundedString(leaseOwner, 'leaseOwner', 256);
      const id = positiveInteger(runId, 'runId');
      const operation = operationIdentity === null
        ? null
        : boundedString(operationIdentity, 'operationIdentity', 512);
      const source = boundedString(sourceIdentity, 'sourceIdentity', 512);
      const duration = positiveInteger(leaseDurationMs, 'leaseDurationMs');
      const retryMs = positiveInteger(waitRetryMs, 'waitRetryMs');
      return this.withTransaction(async client => {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`ticket-system:capacity:${domain}:${resource}`]
        );
        const runResult = await client.query(
          `SELECT ticket_id FROM ${this.table('runs')}
           WHERE id = $1
             AND status IN ('pending', 'running')
             AND lease_owner = $2
             AND lease_expires_at > clock_timestamp()`,
          [id, owner]
        );
        if (runResult.rowCount !== 1) {
          throw new RuntimeBudgetError(
            `Run ${id} does not hold the live lease required for capacity`,
            'RUNTIME_CAPACITY_LEASE_CONFLICT'
          );
        }
        const ticketId = positiveInteger(runResult.rows[0].ticket_id, 'run.ticketId');
        await client.query(
          `INSERT INTO ${this.table('runtime_capacity_slots')}
             (capacity_domain, resource_key, slot_number)
           SELECT $1, $2, slot_number
           FROM generate_series(1, $3::integer) AS slot_number
           ON CONFLICT DO NOTHING`,
          [domain, resource, boundedLimit]
        );
        const expired = await client.query(
          `WITH expired AS (
             SELECT slot.capacity_domain, slot.resource_key, slot.slot_number,
                    slot.run_id AS released_run_id, run.ticket_id AS released_ticket_id
             FROM ${this.table('runtime_capacity_slots')} AS slot
             JOIN ${this.table('runs')} AS run ON run.id = slot.run_id
             WHERE slot.capacity_domain = $1 AND slot.resource_key = $2
               AND slot.lease_owner IS NOT NULL
               AND (
                 slot.lease_expires_at <= clock_timestamp() OR
                 run.lease_owner IS DISTINCT FROM slot.lease_owner OR
                 run.lease_expires_at <= clock_timestamp() OR
                 run.status NOT IN ('pending', 'running')
               )
             FOR UPDATE OF slot
           )
           UPDATE ${this.table('runtime_capacity_slots')} AS slot
           SET lease_owner = NULL, run_id = NULL, operation_identity = NULL,
               lease_expires_at = NULL, acquired_at = NULL,
               revision = revision + 1
           FROM expired
           WHERE slot.capacity_domain = expired.capacity_domain
             AND slot.resource_key = expired.resource_key
             AND slot.slot_number = expired.slot_number
           RETURNING slot.slot_number, expired.released_run_id,
                     expired.released_ticket_id`,
          [domain, resource]
        );
        for (const row of expired.rows) {
          await this._appendEvent(client, {
            type: 'capacity.released',
            ticketId: positiveInteger(row.released_ticket_id, 'capacity.ticketId'),
            runId: positiveInteger(row.released_run_id, 'capacity.runId'),
            payload: {
              capacityDomain: domain,
              resourceKey: resource,
              slotNumber: row.slot_number,
              reason: 'stale_lease_reclaimed'
            }
          });
        }
        const exact = await client.query(
          `SELECT * FROM ${this.table('runtime_capacity_slots')}
           WHERE capacity_domain = $1 AND resource_key = $2
             AND lease_owner = $3 AND run_id = $4
             AND operation_identity IS NOT DISTINCT FROM $5
             AND lease_expires_at > clock_timestamp()`,
          [domain, resource, owner, id, operation]
        );
        if (exact.rowCount === 1) {
          return { acquired: true, slot: capacitySlotFromRow(exact.rows[0]), replayed: true };
        }
        const olderWait = await client.query(
          `SELECT wait.run_id
           FROM ${this.table('run_capacity_waits')} AS wait
           JOIN ${this.table('runs')} AS run ON run.id = wait.run_id
           WHERE wait.capacity_domain = $1 AND wait.resource_key = $2
             AND wait.active = true AND wait.run_id <> $3
             AND run.status IN ('pending', 'running')
             AND run.lease_owner IS NOT NULL
             AND run.lease_expires_at > clock_timestamp()
           ORDER BY wait.first_blocked_at, wait.run_id
           LIMIT 1`,
          [domain, resource, id]
        );
        const free = olderWait.rowCount > 0 ? { rows: [], rowCount: 0 } : await client.query(
          `SELECT * FROM ${this.table('runtime_capacity_slots')}
           WHERE capacity_domain = $1 AND resource_key = $2
             AND slot_number <= $3 AND lease_owner IS NULL
           ORDER BY slot_number
           FOR UPDATE SKIP LOCKED
           LIMIT 1`,
          [domain, resource, boundedLimit]
        );
        if (free.rowCount === 0) {
          const wait = await client.query(
            `INSERT INTO ${this.table('run_capacity_waits')} AS current_wait
              (run_id, ticket_id, capacity_domain, resource_key, source_identity,
               reason, next_eligible_at)
             VALUES (
               $1, $2, $3, $4, $5, $6,
               clock_timestamp() + ($7::bigint * interval '1 millisecond')
             )
             ON CONFLICT (run_id) DO UPDATE
               SET next_eligible_at = EXCLUDED.next_eligible_at,
                   updated_at = clock_timestamp(),
                   revision = current_wait.revision + 1
               WHERE current_wait.active = false OR
                 current_wait.capacity_domain <> EXCLUDED.capacity_domain OR
                 current_wait.resource_key <> EXCLUDED.resource_key OR
                 current_wait.source_identity <> EXCLUDED.source_identity
             RETURNING (xmax = 0) AS inserted`,
            [
              id,
              ticketId,
              domain,
              resource,
              source,
              `Capacity ${domain}/${resource} is occupied`,
              retryMs
            ]
          );
          if (wait.rowCount === 1) {
            await this._appendEvent(client, {
              type: 'capacity.waiting',
              ticketId,
              runId: id,
              payload: {
                capacityDomain: domain,
                resourceKey: resource,
                sourceIdentity: source,
                reason: `Capacity ${domain}/${resource} is occupied`,
                limit: boundedLimit,
                nextEligibleMs: retryMs
              }
            });
          }
          return { acquired: false, slot: null, replayed: false };
        }
        const selected = capacitySlotFromRow(free.rows[0]);
        const acquired = await client.query(
          `UPDATE ${this.table('runtime_capacity_slots')}
           SET lease_owner = $4, run_id = $5, operation_identity = $6,
               lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
               acquired_at = clock_timestamp(), revision = revision + 1
           WHERE capacity_domain = $1 AND resource_key = $2 AND slot_number = $3
             AND lease_owner IS NULL
           RETURNING *`,
          [domain, resource, selected.slotNumber, owner, id, operation, duration]
        );
        if (acquired.rowCount !== 1) {
          throw new RuntimeBudgetError(
            'Capacity slot changed while being acquired',
            'RUNTIME_CAPACITY_LEASE_CONFLICT'
          );
        }
        await client.query(
          `UPDATE ${this.table('run_capacity_waits')}
           SET active = false, updated_at = clock_timestamp(), revision = revision + 1
           WHERE run_id = $1 AND active = true`,
          [id]
        );
        const slot = capacitySlotFromRow(acquired.rows[0]);
        await this._appendEvent(client, {
          type: 'capacity.acquired',
          ticketId,
          runId: id,
          payload: {
            capacityDomain: domain,
            resourceKey: resource,
            sourceIdentity: source,
            slotNumber: slot.slotNumber,
            limit: boundedLimit,
            leaseExpiresAt: slot.leaseExpiresAt
          }
        });
        return { acquired: true, slot, replayed: false };
      });
    },

    async renewRuntimeCapacity({
      capacityDomain: requestedDomain,
      resourceKey,
      slotNumber,
      leaseOwner,
      runId,
      operationIdentity = null,
      leaseDurationMs
    } = {}) {
      const domain = capacityDomain(requestedDomain);
      const resource = boundedString(resourceKey, 'resourceKey', 256);
      const slot = positiveInteger(slotNumber, 'slotNumber');
      const owner = boundedString(leaseOwner, 'leaseOwner', 256);
      const id = positiveInteger(runId, 'runId');
      const operation = operationIdentity === null
        ? null
        : boundedString(operationIdentity, 'operationIdentity', 512);
      const duration = positiveInteger(leaseDurationMs, 'leaseDurationMs');
      const updated = await this.pool.query(
        `UPDATE ${this.table('runtime_capacity_slots')}
         SET lease_expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
             revision = revision + 1
         WHERE capacity_domain = $1 AND resource_key = $2 AND slot_number = $3
           AND lease_owner = $4 AND run_id = $5
           AND operation_identity IS NOT DISTINCT FROM $6
           AND lease_expires_at > clock_timestamp()
           AND EXISTS (
             SELECT 1 FROM ${this.table('runs')} AS run
             WHERE run.id = $5
               AND run.status IN ('pending', 'running')
               AND run.lease_owner = $4
               AND run.lease_expires_at > clock_timestamp()
           )
         RETURNING *`,
        [domain, resource, slot, owner, id, operation, duration]
      );
      return updated.rowCount === 1 ? capacitySlotFromRow(updated.rows[0]) : null;
    },

    async releaseRuntimeCapacity({
      capacityDomain: requestedDomain,
      resourceKey,
      slotNumber,
      leaseOwner,
      runId,
      operationIdentity = null,
      reason = 'operation_settled'
    } = {}) {
      const domain = capacityDomain(requestedDomain);
      const resource = boundedString(resourceKey, 'resourceKey', 256);
      const slot = positiveInteger(slotNumber, 'slotNumber');
      const owner = boundedString(leaseOwner, 'leaseOwner', 256);
      const id = positiveInteger(runId, 'runId');
      const operation = operationIdentity === null
        ? null
        : boundedString(operationIdentity, 'operationIdentity', 512);
      const stableReason = boundedString(reason, 'reason', 1024);
      return this.withTransaction(async client => {
        const released = await client.query(
          `UPDATE ${this.table('runtime_capacity_slots')}
           SET lease_owner = NULL, run_id = NULL, operation_identity = NULL,
               lease_expires_at = NULL, acquired_at = NULL,
               revision = revision + 1
           WHERE capacity_domain = $1 AND resource_key = $2 AND slot_number = $3
             AND lease_owner = $4 AND run_id = $5
             AND operation_identity IS NOT DISTINCT FROM $6
           RETURNING *`,
          [domain, resource, slot, owner, id, operation]
        );
        if (released.rowCount !== 1) return false;
        const runResult = await client.query(
          `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
          [id]
        );
        await this._appendEvent(client, {
          type: 'capacity.released',
          ticketId: positiveInteger(runResult.rows[0].ticket_id, 'run.ticketId'),
          runId: id,
          payload: {
            capacityDomain: domain,
            resourceKey: resource,
            slotNumber: slot,
            reason: stableReason
          }
        });
        return true;
      });
    }
  };
}

function installRuntimeBudgetMethods(PostgresRuntimeStore) {
  Object.assign(PostgresRuntimeStore.prototype, methods());
}

module.exports = {
  chargeFromRow,
  installRuntimeBudgetMethods
};
