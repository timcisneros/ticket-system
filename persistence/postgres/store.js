'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  RUN_EVENT_SCHEMA_VERSION,
  computeRunEventHash,
  validateCurrentEventEnvelope
} = require('../../runtime/event-integrity');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function quoteIdentifier(value) {
  const normalized = String(value || '');
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`Invalid PostgreSQL identifier: ${normalized}`);
  }
  return `"${normalized}"`;
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

function nullablePositiveSafeInteger(value, label) {
  if (value === undefined || value === null) return null;
  return positiveSafeInteger(value, label);
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function normalizeWorkspacePath(value) {
  const raw = String(value === undefined || value === null ? '' : value).replaceAll('\\', '/').trim();
  if (raw === '' || raw === '.') return '';
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes('\0')) {
    throw new TypeError(`Unsafe workspace path: ${raw}`);
  }
  const parts = raw.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new TypeError(`Unsafe workspace path: ${raw}`);
  return parts.join('/');
}

// Hierarchical advisory-lock plan. Non-root mutations take shared locks on
// ancestors and an exclusive lock on the exact path. A parent mutation takes an
// exclusive lock on that parent, so it conflicts with descendants without
// globally serializing unrelated top-level paths.
function buildWorkspaceLockRequests(targetId, paths) {
  const target = String(targetId || '').trim();
  if (!target) throw new TypeError('targetId is required');
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('paths must be a non-empty array');

  const modes = new Map();
  for (const value of paths) {
    const normalized = normalizeWorkspacePath(value);
    const parts = normalized ? normalized.split('/') : [];
    const resources = [`workspace:${target}:`];
    for (let index = 0; index < parts.length; index += 1) {
      resources.push(`workspace:${target}:${parts.slice(0, index + 1).join('/')}`);
    }
    resources.forEach((resource, index) => {
      const mode = index === resources.length - 1 ? 'exclusive' : 'shared';
      if (mode === 'exclusive' || !modes.has(resource)) modes.set(resource, mode);
    });
  }

  return [...modes.entries()]
    .map(([resource, mode]) => ({ resource, mode }))
    .sort((left, right) => left.resource.localeCompare(right.resource));
}

function buildEventEnvelope({ event, eventId, timestamp, chain = null }) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const ticketId = nullablePositiveSafeInteger(input.ticketId, 'event.ticketId');
  const runId = nullablePositiveSafeInteger(input.runId, 'event.runId');
  const normalized = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: String(eventId || '').trim(),
    ts: isoTimestamp(timestamp, 'event timestamp'),
    type: typeof input.type === 'string' && input.type.trim() ? input.type.trim() : 'event',
    ticketId,
    runId,
    stepId: input.stepId === undefined || input.stepId === null ? null : String(input.stepId),
    payload: jsonObject(input.payload || {}, 'event.payload')
  };

  if (!normalized.id) throw new TypeError('eventId is required');
  if (runId !== null) {
    if (ticketId === null) throw new TypeError('Run events require ticketId');
    const nextSeq = nonNegativeSafeInteger(chain && chain.nextSeq, 'chain.nextSeq');
    const previousHash = chain && chain.previousHash !== undefined ? chain.previousHash : null;
    if (nextSeq === 0 && previousHash !== null) throw new TypeError('The first run event cannot have a previous hash');
    if (nextSeq > 0 && !/^[0-9a-f]{64}$/.test(String(previousHash || ''))) {
      throw new TypeError('A continued run event requires a valid previous hash');
    }
    normalized.seq = nextSeq;
    normalized.prevHash = previousHash;
    normalized.hash = computeRunEventHash(normalized);
  }

  const errors = validateCurrentEventEnvelope(normalized);
  if (errors.length > 0) throw new TypeError(errors[0].message);
  return normalized;
}

function rowTimestamp(value) {
  return value === null || value === undefined ? null : isoTimestamp(value, 'database timestamp');
}

function eventFromRow(row) {
  const event = {
    schemaVersion: Number(row.schema_version),
    id: row.id,
    ts: rowTimestamp(row.ts),
    type: row.type,
    ticketId: nullablePositiveSafeInteger(row.ticket_id, 'event.ticketId'),
    runId: nullablePositiveSafeInteger(row.run_id, 'event.runId'),
    stepId: row.step_id,
    payload: row.payload
  };
  if (event.runId !== null) {
    event.seq = nonNegativeSafeInteger(row.seq, 'event.seq');
    event.prevHash = row.prev_hash;
    event.hash = row.hash;
  }
  return event;
}

function ticketFromRow(row) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'ticket.id'),
    status: row.status,
    assignmentTargetType: row.assignment_target_type,
    assignmentTargetId: nullablePositiveSafeInteger(row.assignment_target_id, 'ticket.assignmentTargetId'),
    revision: positiveSafeInteger(row.revision, 'ticket.revision'),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function runFromRow(row) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'run.id'),
    ticketId: positiveSafeInteger(row.ticket_id, 'run.ticketId'),
    agentId: positiveSafeInteger(row.agent_id, 'run.agentId'),
    status: row.status,
    executionMode: row.execution_mode,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: rowTimestamp(row.lease_expires_at),
    lastHeartbeatAt: rowTimestamp(row.last_heartbeat_at),
    revision: positiveSafeInteger(row.revision, 'run.revision'),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

class PostgresRuntimeStore {
  constructor({
    connectionString,
    pool = null,
    schema = 'ticket_system',
    maxConnections = 16,
    connectionTimeoutMs = 5_000,
    statementTimeoutMs = 30_000,
    lockTimeoutMs = 5_000,
    maxQueryRows = 1_000,
    maxEligibleRunIds = 1_000
  } = {}) {
    this.schema = String(schema || 'public');
    this.schemaSql = quoteIdentifier(this.schema);
    this.lockTimeoutMs = positiveSafeInteger(lockTimeoutMs, 'lockTimeoutMs');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.maxEligibleRunIds = positiveSafeInteger(maxEligibleRunIds, 'maxEligibleRunIds');
    this.ownsPool = !pool;
    if (!pool && (typeof connectionString !== 'string' || !connectionString.trim())) {
      throw new TypeError('connectionString is required when pool is not provided');
    }
    this.pool = pool || new Pool({
      connectionString,
      max: positiveSafeInteger(maxConnections, 'maxConnections'),
      connectionTimeoutMillis: positiveSafeInteger(connectionTimeoutMs, 'connectionTimeoutMs'),
      statement_timeout: positiveSafeInteger(statementTimeoutMs, 'statementTimeoutMs')
    });
  }

  table(name) {
    return `${this.schemaSql}.${quoteIdentifier(name)}`;
  }

  async close() {
    if (this.ownsPool && this.pool) await this.pool.end();
  }

  async migrate() {
    const client = await this.pool.connect();
    const lockName = `ticket-system:migrations:${this.schema}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table('schema_migrations')} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);

      const migrations = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
      const applied = [];
      for (const version of migrations) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
          const existing = await client.query(
            `SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = $1`,
            [version]
          );
          if (existing.rowCount === 0) {
            await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, version), 'utf8'));
            await client.query(
              `INSERT INTO ${this.table('schema_migrations')} (version) VALUES ($1)`,
              [version]
            );
            applied.push(version);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return applied;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]); } catch (_) {}
      client.release();
    }
  }

  async withTransaction(operation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async health() {
    const result = await this.pool.query('SELECT 1 AS ok');
    return result.rows[0] && Number(result.rows[0].ok) === 1;
  }

  async createTicket(record, { client = null } = {}) {
    const ticket = jsonObject(record, 'ticket');
    const values = [
      String(ticket.status || 'open'),
      ticket.assignmentTargetType || null,
      nullablePositiveSafeInteger(ticket.assignmentTargetId, 'ticket.assignmentTargetId'),
      ticket
    ];
    const execute = async connection => {
      const result = await connection.query(
        `INSERT INTO ${this.table('tickets')}
          (status, assignment_target_type, assignment_target_id, body)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *`,
        values
      );
      return ticketFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRun(record, { client = null } = {}) {
    const run = jsonObject(record, 'run');
    const leaseOwner = typeof run.leaseOwner === 'string' && run.leaseOwner.trim() ? run.leaseOwner.trim() : null;
    const leaseExpiresAt = leaseOwner ? isoTimestamp(run.leaseExpiresAt, 'run.leaseExpiresAt') : null;
    const values = [
      positiveSafeInteger(run.ticketId, 'run.ticketId'),
      positiveSafeInteger(run.agentId, 'run.agentId'),
      String(run.status || 'pending'),
      run.executionMode === 'workflow' ? 'workflow' : 'agent',
      leaseOwner,
      leaseExpiresAt,
      run.lastHeartbeatAt ? isoTimestamp(run.lastHeartbeatAt, 'run.lastHeartbeatAt') : null,
      run
    ];
    const execute = async connection => {
      const result = await connection.query(
        `INSERT INTO ${this.table('runs')}
          (ticket_id, agent_id, status, execution_mode, lease_owner, lease_expires_at,
           last_heartbeat_at, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        values
      );
      return runFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async appendEvent(event, { client = null } = {}) {
    const execute = connection => this._appendEvent(connection, event);
    return client ? execute(client) : this.withTransaction(execute);
  }

  async _appendEvent(client, event) {
    const runId = nullablePositiveSafeInteger(event && event.runId, 'event.runId');
    let chain = null;
    if (runId !== null) {
      await client.query(
        `INSERT INTO ${this.table('run_event_chain_tips')} (run_id, next_seq, previous_hash)
         VALUES ($1, 0, NULL) ON CONFLICT (run_id) DO NOTHING`,
        [runId]
      );
      const tip = await client.query(
        `SELECT next_seq, previous_hash FROM ${this.table('run_event_chain_tips')}
         WHERE run_id = $1 FOR UPDATE`,
        [runId]
      );
      if (tip.rowCount !== 1) throw new Error(`Run ${runId} has no event-chain tip`);
      chain = {
        nextSeq: nonNegativeSafeInteger(tip.rows[0].next_seq, 'chain.nextSeq'),
        previousHash: tip.rows[0].previous_hash
      };
    }

    const clock = await client.query('SELECT clock_timestamp() AS ts');
    const normalized = buildEventEnvelope({
      event,
      eventId: crypto.randomUUID(),
      timestamp: clock.rows[0].ts,
      chain
    });
    const result = await client.query(
      `INSERT INTO ${this.table('events')}
        (id, schema_version, ts, type, ticket_id, run_id, step_id, seq, prev_hash, hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        normalized.id,
        normalized.schemaVersion,
        normalized.ts,
        normalized.type,
        normalized.ticketId,
        normalized.runId,
        normalized.stepId,
        normalized.seq === undefined ? null : normalized.seq,
        normalized.prevHash === undefined ? null : normalized.prevHash,
        normalized.hash === undefined ? null : normalized.hash,
        normalized.payload
      ]
    );

    if (runId !== null) {
      await client.query(
        `UPDATE ${this.table('run_event_chain_tips')}
         SET next_seq = $2, previous_hash = $3, updated_at = clock_timestamp()
         WHERE run_id = $1`,
        [runId, normalized.seq + 1, normalized.hash]
      );
    }
    return eventFromRow(result.rows[0]);
  }

  async claimPendingRun({ leaseOwner, leaseDurationMs, eligibleRunIds = null, claimPayload = {} }) {
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const eligible = eligibleRunIds === null
      ? null
      : eligibleRunIds.map((id, index) => positiveSafeInteger(id, `eligibleRunIds[${index}]`));
    if (eligible && eligible.length > this.maxEligibleRunIds) {
      throw new RangeError(`eligibleRunIds exceeds the configured limit of ${this.maxEligibleRunIds}`);
    }

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id
           FROM ${this.table('runs')}
           WHERE status = 'pending'
             AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
             AND ($3::bigint[] IS NULL OR id = ANY($3::bigint[]))
           ORDER BY created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE ${this.table('runs')} AS run
         SET lease_owner = $1,
             lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = run.revision + 1,
             updated_at = clock_timestamp()
         FROM candidate
         WHERE run.id = candidate.id
         RETURNING run.*`,
        [owner, duration, eligible]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'run.lease_acquired',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...jsonObject(claimPayload, 'claimPayload'),
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async heartbeatRunLease({ runId, leaseOwner, leaseDurationMs, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');

    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, duration]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'run.heartbeat',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...jsonObject(payload, 'heartbeat payload'),
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async releaseRunLease({ runId, leaseOwner, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET lease_owner = NULL,
             lease_expires_at = NULL,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND lease_owner = $2
         RETURNING *`,
        [id, owner]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'run.lease_released',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...jsonObject(payload, 'release payload'),
          leaseOwner: owner,
          releasedAt: run.updatedAt
        }
      });
      return { run, event };
    });
  }

  async withWorkspaceMutationLocks({ targetId, paths }, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const requests = buildWorkspaceLockRequests(targetId, paths);
    return this.withTransaction(async client => {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      for (const request of requests) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
        await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]);
      }
      return operation(client, requests);
    });
  }

  async listRunEvents(runId, { afterSeq = -1, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = Number(afterSeq);
    if (!Number.isSafeInteger(cursor) || cursor < -1) {
      throw new TypeError('afterSeq must be a safe integer greater than or equal to -1');
    }
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('events')}
       WHERE run_id = $1 AND seq > $2
       ORDER BY seq
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    return result.rows.map(eventFromRow);
  }

  async listRecentEvents(limit = 100) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM ${this.table('events')} ORDER BY position DESC LIMIT $1
       ) recent ORDER BY position`,
      [boundedLimit]
    );
    return result.rows.map(eventFromRow);
  }
}

module.exports = {
  PostgresRuntimeStore,
  buildEventEnvelope,
  buildWorkspaceLockRequests,
  normalizeWorkspacePath,
  quoteIdentifier
};
