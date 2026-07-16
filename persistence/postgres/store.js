'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const {
  RUN_EVENT_SCHEMA_VERSION,
  computeRunEventHash,
  validateCurrentEventEnvelope
} = require('../../runtime/event-integrity');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TICKET_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed']);
const RUN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'interrupted']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const OPERATION_OUTCOMES = new Set(['succeeded', 'failed', 'refused']);
const RUN_STATUS_TRANSITIONS = new Map([
  ['pending', new Set(['pending', 'running', 'failed', 'interrupted'])],
  ['running', new Set(['running', 'pending', 'completed', 'failed', 'interrupted'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['interrupted', new Set()]
]);

class OptimisticConcurrencyError extends Error {
  constructor(entity, id, expectedRevision, current = null) {
    super(`${entity} ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'OptimisticConcurrencyError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class ImmutableEvidenceConflictError extends Error {
  constructor(kind, runId) {
    super(`${kind} for run ${runId} already exists with different evidence`);
    this.name = 'ImmutableEvidenceConflictError';
    this.code = 'IMMUTABLE_EVIDENCE_CONFLICT';
    this.kind = kind;
    this.runId = runId;
  }
}

class IdempotencyConflictError extends Error {
  constructor(runId, idempotencyKey) {
    super(`Operation receipt idempotency key conflicts for run ${runId}: ${idempotencyKey}`);
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
    this.runId = runId;
    this.idempotencyKey = idempotencyKey;
  }
}

class StateTransitionConflictError extends Error {
  constructor(entity, id, expectedStatuses, current) {
    super(`${entity} ${id} is ${current.status}; expected ${expectedStatuses.join(' or ')}`);
    this.name = 'StateTransitionConflictError';
    this.code = 'STATE_TRANSITION_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedStatuses = expectedStatuses;
    this.current = current;
  }
}

class LeaseAuthorityError extends Error {
  constructor(runId, leaseOwner, current) {
    super(`Run ${runId} is not controlled by a live lease for ${leaseOwner || '(no owner)'}`);
    this.name = 'LeaseAuthorityError';
    this.code = 'LEASE_AUTHORITY_CONFLICT';
    this.runId = runId;
    this.leaseOwner = leaseOwner;
    this.current = current;
  }
}

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

function requiredString(value, label, maxLength = null) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (maxLength !== null && normalized.length > maxLength) {
    throw new RangeError(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeStatuses(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  return [...new Set(value.map(item => requiredString(item, label)))].map(status => {
    if (!allowed.has(status)) throw new TypeError(`Unsupported ${label}: ${status}`);
    return status;
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
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
    startedAt: rowTimestamp(row.started_at),
    completedAt: rowTimestamp(row.completed_at),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function evaluationFromRow(row) {
  return {
    runId: positiveSafeInteger(row.run_id, 'evaluation.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'evaluation.ticketId'),
    evaluation: row.evaluation,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function consequenceFromRow(row) {
  return {
    runId: positiveSafeInteger(row.run_id, 'consequence.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'consequence.ticketId'),
    consequence: row.consequence,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function replaySnapshotFromRow(row) {
  const computedHash = sha256Json(row.snapshot);
  if (computedHash !== row.snapshot_hash) {
    const error = new Error(`Replay snapshot integrity check failed for run ${row.run_id}`);
    error.code = 'POSTGRES_REPLAY_INTEGRITY_FAILURE';
    error.expectedHash = row.snapshot_hash;
    error.computedHash = computedHash;
    throw error;
  }
  return {
    runId: positiveSafeInteger(row.run_id, 'replaySnapshot.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'replaySnapshot.ticketId'),
    snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash,
    revision: positiveSafeInteger(row.revision, 'replaySnapshot.revision'),
    finalizedAt: rowTimestamp(row.finalized_at),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function operationReceiptFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'operationReceipt.id'),
    runId: positiveSafeInteger(row.run_id, 'operationReceipt.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'operationReceipt.ticketId'),
    idempotencyKey: row.idempotency_key,
    stepId: row.step_id,
    operation: row.operation,
    outcome: row.outcome,
    targetId: row.target_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    targetResourceId: row.target_resource_id,
    receipt: row.receipt,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function targetOperationIntentFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'targetOperationIntent.id'),
    runId: positiveSafeInteger(row.run_id, 'targetOperationIntent.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'targetOperationIntent.ticketId'),
    operationKey: row.operation_key,
    stepId: row.step_id,
    operation: row.operation,
    targetId: row.target_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    targetResourceId: row.target_resource_id,
    intent: row.intent,
    preparedAt: rowTimestamp(row.prepared_at)
  };
}

function targetOperationReceiptProjection(envelope, intentRecord) {
  if (!envelope) return null;
  const document = envelope.receipt || {};
  const intent = intentRecord && intentRecord.intent ? intentRecord.intent : {};
  const error = document.error && typeof document.error === 'object' ? document.error : null;
  return {
    id: envelope.id,
    timestamp: envelope.recordedAt,
    runId: envelope.runId,
    ticketId: envelope.ticketId,
    step: envelope.stepId,
    operation: envelope.operation,
    operationKey: envelope.idempotencyKey,
    args: intent.args || {},
    preState: document.before || intent.preState || null,
    postState: document.after || null,
    result: envelope.outcome === 'succeeded' ? document.providerResponse || null : null,
    error: error ? error.message || 'Target operation failed' : null,
    errorCode: error ? error.code || null : null,
    failureKind: error ? error.failureKind || null : null,
    outcome: envelope.outcome,
    isRecovery: document.reconciliation === 'applied_effect_confirmed',
    authorityDecision: document.authorityDecision || intent.authorityDecision || null,
    mutationReceipt: document,
    targetId: envelope.targetId,
    targetKind: envelope.targetKind,
    targetPath: envelope.targetPath,
    targetResourceId: envelope.targetResourceId
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
    maxEligibleRunIds = 1_000,
    maxJsonRecordBytes = 2 * 1024 * 1024
  } = {}) {
    this.schema = String(schema || 'ticket_system');
    this.schemaSql = quoteIdentifier(this.schema);
    this.lockTimeoutMs = positiveSafeInteger(lockTimeoutMs, 'lockTimeoutMs');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.maxEligibleRunIds = positiveSafeInteger(maxEligibleRunIds, 'maxEligibleRunIds');
    this.maxJsonRecordBytes = positiveSafeInteger(maxJsonRecordBytes, 'maxJsonRecordBytes');
    this.targetOperationClientStorage = new AsyncLocalStorage();
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

  assertJsonRecord(value, label) {
    const record = jsonObject(value, label);
    const bytes = Buffer.byteLength(canonicalJson(record), 'utf8');
    if (bytes > this.maxJsonRecordBytes) {
      const error = new RangeError(`${label} exceeds the configured maximum of ${this.maxJsonRecordBytes} bytes`);
      error.code = 'POSTGRES_RECORD_TOO_LARGE';
      error.recordBytes = bytes;
      error.maxRecordBytes = this.maxJsonRecordBytes;
      throw error;
    }
    return record;
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
    const scopedClient = this.targetOperationClientStorage.getStore();
    if (scopedClient) return this._withClientTransaction(scopedClient, operation);
    const client = await this.pool.connect();
    try {
      return await this._withClientTransaction(client, operation);
    } finally {
      client.release();
    }
  }

  async _withClientTransaction(client, operation) {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  async health() {
    const result = await this.pool.query('SELECT 1 AS ok');
    return result.rows[0] && Number(result.rows[0].ok) === 1;
  }

  async _throwTransitionConflict(client, {
    entity,
    tableName,
    id,
    expectedRevision,
    expectedStatuses,
    fromRow,
    leaseOwner = null,
    leaseConstrained = false
  }) {
    const currentResult = await client.query(
      `SELECT * FROM ${this.table(tableName)} WHERE id = $1`,
      [id]
    );
    if (currentResult.rowCount === 0) {
      const error = new Error(`${entity} ${id} was not found`);
      error.code = 'POSTGRES_RECORD_NOT_FOUND';
      throw error;
    }
    const current = fromRow(currentResult.rows[0]);
    if (current.revision !== expectedRevision) {
      throw new OptimisticConcurrencyError(entity, id, expectedRevision, current);
    }
    if (!expectedStatuses.includes(current.status)) {
      throw new StateTransitionConflictError(entity, id, expectedStatuses, current);
    }
    if (leaseConstrained) throw new LeaseAuthorityError(id, leaseOwner, current);
    throw new StateTransitionConflictError(entity, id, expectedStatuses, current);
  }

  async createTicket(record, { client = null } = {}) {
    const ticket = this.assertJsonRecord(record, 'ticket');
    const status = requiredString(ticket.status || 'open', 'ticket.status');
    if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket.status: ${status}`);
    const values = [
      status,
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

  async createTicketWithEvent({ ticket, eventPayload = {} }, { client = null } = {}) {
    const body = this.assertJsonRecord(ticket, 'ticket');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const execute = async connection => {
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'ticket clock');
      const record = {
        ...body,
        createdAt: now,
        updatedAt: now,
        ...(Object.prototype.hasOwnProperty.call(body, 'changedAt') ? { changedAt: now } : {})
      };
      const spawnIdempotencyKey = optionalString(record.spawnIdempotencyKey);
      if (spawnIdempotencyKey) record.spawnIdempotencyKey = spawnIdempotencyKey;
      let created;
      let inserted = true;
      if (spawnIdempotencyKey) {
        const status = requiredString(record.status || 'open', 'ticket.status');
        if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket.status: ${status}`);
        const result = await connection.query(
          `INSERT INTO ${this.table('tickets')}
            (status, assignment_target_type, assignment_target_id, body)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            status,
            record.assignmentTargetType || null,
            nullablePositiveSafeInteger(record.assignmentTargetId, 'ticket.assignmentTargetId'),
            record
          ]
        );
        if (result.rowCount > 0) {
          created = ticketFromRow(result.rows[0]);
        } else {
          const existing = await connection.query(
            `SELECT * FROM ${this.table('tickets')} WHERE body->>'spawnIdempotencyKey' = $1`,
            [spawnIdempotencyKey]
          );
          if (existing.rowCount !== 1) throw new Error(`Ticket idempotency conflict for ${spawnIdempotencyKey}`);
          created = ticketFromRow(existing.rows[0]);
          inserted = false;
        }
      } else {
        created = await this.createTicket(record, { client: connection });
      }
      if (!inserted) return { ticket: created, event: null, created: false };
      const event = await this._appendEvent(connection, {
        type: 'ticket.created',
        ticketId: created.id,
        payload: {
          ...callerPayload,
          status: created.status,
          createdAt: created.createdAt
        }
      });
      return { ticket: created, event, created: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRun(record, { client = null } = {}) {
    const run = this.assertJsonRecord(record, 'run');
    const status = requiredString(run.status || 'pending', 'run.status');
    if (status !== 'pending') throw new TypeError('New runs must start pending');
    const leaseOwner = typeof run.leaseOwner === 'string' && run.leaseOwner.trim() ? run.leaseOwner.trim() : null;
    const leaseExpiresAt = leaseOwner ? isoTimestamp(run.leaseExpiresAt, 'run.leaseExpiresAt') : null;
    const values = [
      positiveSafeInteger(run.ticketId, 'run.ticketId'),
      positiveSafeInteger(run.agentId, 'run.agentId'),
      status,
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

  async createRunsAndStartTicket({
    ticketId,
    runDrafts,
    afterTerminalRunId = null,
    runEventPayload = () => ({}),
    ticketEventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(runDrafts) || runDrafts.length === 0) {
      throw new TypeError('runDrafts must be a non-empty array');
    }
    if (typeof runEventPayload !== 'function') throw new TypeError('runEventPayload must be a function');
    const drafts = runDrafts.map((draft, index) => {
      const run = this.assertJsonRecord(draft, `runDrafts[${index}]`);
      if (positiveSafeInteger(run.ticketId, `runDrafts[${index}].ticketId`) !== id) {
        throw new TypeError('Every run draft must belong to ticketId');
      }
      positiveSafeInteger(run.agentId, `runDrafts[${index}].agentId`);
      if (run.status !== undefined && run.status !== 'pending') {
        throw new TypeError('New runs must start pending');
      }
      return run;
    });
    const callerTicketPayload = this.assertJsonRecord(ticketEventPayload, 'ticketEventPayload');
    const predecessorId = afterTerminalRunId === null || afterTerminalRunId === undefined
      ? null
      : positiveSafeInteger(afterTerminalRunId, 'afterTerminalRunId');
    if (predecessorId !== null && drafts.length !== 1) {
      throw new TypeError('A terminal predecessor can authorize exactly one new run');
    }

    const execute = async connection => {
      const ticketResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (ticketResult.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(ticketResult.rows[0]);
      if (ticket.status !== 'open') {
        throw new StateTransitionConflictError('ticket', id, ['open'], ticket);
      }
      if (ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt) {
        const error = new Error('Cannot start runs while unresolved ticket-level triage exists');
        error.code = 'TICKET_TRIAGE_REQUIRED';
        throw error;
      }

      const agentIds = drafts.map(run => run.agentId);
      const active = await connection.query(
        `SELECT * FROM ${this.table('runs')}
         WHERE ticket_id = $1 AND agent_id = ANY($2::bigint[])
           AND status = ANY(ARRAY['pending', 'running'])
         ORDER BY id LIMIT 1`,
        [id, agentIds]
      );
      if (active.rowCount > 0) {
        const current = runFromRow(active.rows[0]);
        throw new StateTransitionConflictError('run', current.id, ['no active run for this ticket and agent'], current);
      }

      if (predecessorId !== null) {
        const predecessorResult = await connection.query(
          `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
          [predecessorId]
        );
        const predecessor = predecessorResult.rowCount === 0 ? null : runFromRow(predecessorResult.rows[0]);
        if (!predecessor || predecessor.ticketId !== id || predecessor.agentId !== drafts[0].agentId ||
            !TERMINAL_RUN_STATUSES.has(predecessor.status)) {
          throw new StateTransitionConflictError(
            'run',
            predecessorId,
            ['terminal predecessor for the requested retry'],
            predecessor || { status: 'missing' }
          );
        }
      }

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'run creation clock');
      const runs = [];
      const events = [];
      for (const draft of drafts) {
        const run = await this.createRun({
          ...draft,
          status: 'pending',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          ticketOpenedAt: ticket.updatedAt,
          createdAt: now,
          updatedAt: now
        }, { client: connection });
        runs.push(run);
        const payload = this.assertJsonRecord(runEventPayload(run), `run ${run.id} event payload`);
        events.push(await this._appendEvent(connection, {
          type: 'run.created',
          ticketId: id,
          runId: run.id,
          payload: { ...payload, status: run.status, createdAt: run.createdAt }
        }));
      }

      const transitioned = await this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses: ['open'],
        toStatus: 'in_progress',
        eventPayload: callerTicketPayload
      }, { client: connection });
      events.push(transitioned.event);
      return {
        ticket: transitioned.ticket,
        runs,
        events,
        previousStatus: transitioned.previousStatus
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async getTicket(ticketId) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const result = await this.pool.query(`SELECT * FROM ${this.table('tickets')} WHERE id = $1`, [id]);
    return result.rowCount === 0 ? null : ticketFromRow(result.rows[0]);
  }

  async getRun(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(`SELECT * FROM ${this.table('runs')} WHERE id = $1`, [id]);
    return result.rowCount === 0 ? null : runFromRow(result.rows[0]);
  }

  async verifyRunLease({ runId, leaseOwner }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE id = $1
         AND status = ANY($2::text[])
         AND lease_owner = $3
         AND lease_expires_at > clock_timestamp()`,
      [id, ['pending', 'running'], owner]
    );
    return result.rowCount === 0 ? null : runFromRow(result.rows[0]);
  }

  async listPendingRuns({ limit = 100, cursor = null, scanEndCursor = null } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const after = cursor === null || cursor === undefined ? null : jsonObject(cursor, 'cursor');
    const afterCreatedAt = after ? requiredString(after.createdAt, 'cursor.createdAt') : null;
    if (afterCreatedAt !== null && Number.isNaN(Date.parse(afterCreatedAt))) {
      throw new TypeError('cursor.createdAt must be a valid timestamp');
    }
    const afterId = after ? positiveSafeInteger(after.id, 'cursor.id') : null;
    const requestedScanEnd = scanEndCursor === null || scanEndCursor === undefined
      ? null
      : jsonObject(scanEndCursor, 'scanEndCursor');
    let scanEndCreatedAt = requestedScanEnd
      ? requiredString(requestedScanEnd.createdAt, 'scanEndCursor.createdAt')
      : null;
    if (scanEndCreatedAt !== null && Number.isNaN(Date.parse(scanEndCreatedAt))) {
      throw new TypeError('scanEndCursor.createdAt must be a valid timestamp');
    }
    let scanEndId = requestedScanEnd
      ? positiveSafeInteger(requestedScanEnd.id, 'scanEndCursor.id')
      : null;
    if (!requestedScanEnd) {
      const horizon = await this.pool.query(
        `SELECT id, created_at::text AS cursor_created_at
         FROM ${this.table('runs')}
         WHERE status = 'pending'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      );
      if (horizon.rowCount > 0) {
        scanEndCreatedAt = horizon.rows[0].cursor_created_at;
        scanEndId = positiveSafeInteger(horizon.rows[0].id, 'scanEndCursor.id');
      }
    }
    const result = await this.pool.query(
      `SELECT run.*, run.created_at::text AS cursor_created_at
       FROM ${this.table('runs')} AS run
       WHERE run.status = 'pending'
         AND ($2::timestamptz IS NULL OR (run.created_at, run.id) > ($2::timestamptz, $3::bigint))
         AND ($4::timestamptz IS NULL OR (run.created_at, run.id) <= ($4::timestamptz, $5::bigint))
       ORDER BY run.created_at, run.id
       LIMIT $1`,
      [boundedLimit + 1, afterCreatedAt, afterId, scanEndCreatedAt, scanEndId]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextCursor: result.rows.length > boundedLimit && last
        ? { createdAt: result.rows[boundedLimit - 1].cursor_created_at, id: last.id }
        : null,
      scanEndCursor: result.rows.length > boundedLimit
        ? { createdAt: scanEndCreatedAt, id: scanEndId }
        : null
    };
  }

  async listExpiredRunningRuns({ limit = 100 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
       ORDER BY lease_expires_at, id
       LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(runFromRow);
  }

  async transitionTicket({
    ticketId,
    expectedRevision,
    fromStatuses,
    toStatus,
    patch = {},
    eventType = 'ticket.updated',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const sources = normalizeStatuses(fromStatuses, TICKET_STATUSES, 'ticket source status');
    const target = requiredString(toStatus, 'toStatus');
    if (!TICKET_STATUSES.has(target)) throw new TypeError(`Unsupported ticket status: ${target}`);
    const bodyPatch = this.assertJsonRecord(patch, 'ticket patch');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const result = await connection.query(
        `WITH candidate AS (
           SELECT id, status
           FROM ${this.table('tickets')}
           WHERE id = $1 AND revision = $2 AND status = ANY($3::text[])
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('tickets')} AS ticket
           SET status = $4,
               body = ticket.body || $5::jsonb,
               revision = ticket.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE ticket.id = candidate.id
           RETURNING ticket.*, candidate.status AS previous_status
         )
         SELECT * FROM updated`,
        [id, revision, sources, target, bodyPatch]
      );
      if (result.rowCount === 0) {
        return this._throwTransitionConflict(connection, {
          entity: 'ticket',
          tableName: 'tickets',
          id,
          expectedRevision: revision,
          expectedStatuses: sources,
          fromRow: ticketFromRow
        });
      }
      const ticket = ticketFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const event = await this._appendEvent(connection, {
        type,
        ticketId: ticket.id,
        payload: {
          ...callerPayload,
          previousStatus,
          status: ticket.status,
          revision: ticket.revision,
          updatedAt: ticket.updatedAt
        }
      });
      return { ticket, event, previousStatus };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async transitionTicketState({
    ticketId,
    fromStatuses,
    toStatus,
    patch = {},
    eventType = 'ticket.updated',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (result.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(result.rows[0]);
      const bodyPatch = this.assertJsonRecord(patch, 'ticket patch');
      let authoritativePatch = bodyPatch;
      let authoritativeEventPayload = eventPayload;
      if (Object.prototype.hasOwnProperty.call(bodyPatch, 'changedAt')) {
        const clock = await connection.query('SELECT clock_timestamp() AS ts');
        const changedAt = isoTimestamp(clock.rows[0].ts, 'ticket change clock');
        authoritativePatch = { ...bodyPatch, changedAt };
        authoritativeEventPayload = { ...eventPayload, changedAt };
      }
      return this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses,
        toStatus,
        patch: authoritativePatch,
        eventType,
        eventPayload: authoritativeEventPayload
      }, { client: connection });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async transitionTicketAfterRun({ runId }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const runIdentityResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runIdentityResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runIdentityResult.rows[0].ticket_id, 'run.ticketId');
      const ticketResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [ticketId]
      );
      if (ticketResult.rowCount === 0) {
        const error = new Error(`ticket ${ticketId} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(ticketResult.rows[0]);
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const run = runFromRow(runResult.rows[0]);
      if (run.ticketId !== ticketId || !TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new StateTransitionConflictError('run', id, [...TERMINAL_RUN_STATUSES], run);
      }
      const batchResult = await connection.query(
        `SELECT * FROM ${this.table('runs')}
         WHERE ticket_id = $1 AND body->>'ticketOpenedAt' = $2
         ORDER BY id
         FOR UPDATE`,
        [run.ticketId, run.ticketOpenedAt]
      );
      const batchRuns = batchResult.rows.map(runFromRow);
      const ownedScope = ticket.assignmentTargetType === 'group' &&
        ['allocated', 'dynamic'].includes(ticket.assignmentMode);
      let targetStatus = null;
      if (run.status === 'interrupted') {
        if (ticket.status === 'in_progress' &&
            !batchRuns.some(item => ['pending', 'running'].includes(item.status))) {
          targetStatus = 'open';
        }
      } else if (!ownedScope) {
        targetStatus = run.status;
      } else if (run.status === 'failed' || batchRuns.some(item => item.status === 'failed')) {
        targetStatus = 'failed';
      } else if (batchRuns.length > 0 && batchRuns.every(item => item.status === 'completed')) {
        targetStatus = 'completed';
      }

      if (!targetStatus || ticket.status === targetStatus) {
        return { ticket, event: null, previousStatus: ticket.status, changed: false };
      }
      const patch = ['completed', 'failed', 'interrupted'].includes(targetStatus)
        ? { rerunMode: null }
        : {};
      const transitioned = await this.transitionTicket({
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        fromStatuses: [ticket.status],
        toStatus: targetStatus,
        patch
      }, { client: connection });
      return { ...transitioned, changed: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async reopenTicket({ ticketId, rerunMode = null }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (result.rowCount === 0) return null;
      const ticket = ticketFromRow(result.rows[0]);
      if (ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt) {
        const error = new Error('Cannot rerun: unresolved ticket-level triage exists on this ticket. Resolve triage first.');
        error.code = 'TICKET_TRIAGE_REQUIRED';
        throw error;
      }
      return this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses: [ticket.status],
        toStatus: 'open',
        patch: { rerunMode: rerunMode ? String(rerunMode) : null }
      }, { client: connection });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRetryRun({
    ticketId,
    predecessorRunId,
    runDraft,
    runEventPayload = () => ({})
  }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const predecessorId = positiveSafeInteger(predecessorRunId, 'predecessorRunId');
    const draft = this.assertJsonRecord(runDraft, 'runDraft');
    return this.withTransaction(async client => {
      const reopened = await this.reopenTicket({ ticketId: id, rerunMode: 'auto_retry' }, { client });
      if (!reopened) return null;
      const created = await this.createRunsAndStartTicket({
        ticketId: id,
        runDrafts: [{ ...draft, rerunMode: 'auto_retry' }],
        afterTerminalRunId: predecessorId,
        runEventPayload,
        ticketEventPayload: { rerunMode: 'auto_retry', predecessorRunId: predecessorId }
      }, { client });
      return { ...created, reopenEvent: reopened.event };
    });
  }

  async transitionRun({
    runId,
    expectedRevision,
    fromStatuses,
    toStatus,
    leaseOwner = null,
    allowExpiredLease = false,
    patch = {},
    eventType = 'run.status_changed',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const sources = normalizeStatuses(fromStatuses, RUN_STATUSES, 'run source status');
    const target = requiredString(toStatus, 'toStatus');
    if (!RUN_STATUSES.has(target)) throw new TypeError(`Unsupported run status: ${target}`);
    for (const source of sources) {
      if (!RUN_STATUS_TRANSITIONS.get(source).has(target)) {
        throw new TypeError(`Unsupported run status transition: ${source} -> ${target}`);
      }
    }
    const owner = optionalString(leaseOwner);
    const permitExpiredLease = allowExpiredLease === true;
    if (target === 'running' && !owner) throw new TypeError('leaseOwner is required to start a run');
    const expiredTerminalRecovery = permitExpiredLease && ['failed', 'interrupted'].includes(target);
    if (sources.includes('running') && target !== 'pending' && !owner && !expiredTerminalRecovery) {
      throw new TypeError('leaseOwner is required to transition a running run');
    }
    const bodyPatch = this.assertJsonRecord(patch, 'run patch');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const result = await connection.query(
        `WITH candidate AS (
           SELECT id, status
           FROM ${this.table('runs')}
           WHERE id = $1
             AND revision = $2
             AND status = ANY($3::text[])
             AND (
               (
                 status = 'pending' AND
                 (
                   ($4::text = 'running' AND $6::text IS NOT NULL AND
                     lease_owner = $6 AND lease_expires_at > clock_timestamp()) OR
                   ($4::text = 'pending' AND (
                     ($6::text IS NULL AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())) OR
                     ($6::text IS NOT NULL AND lease_owner = $6 AND lease_expires_at > clock_timestamp())
                   )) OR
                   ($4::text = ANY(ARRAY['failed', 'interrupted']) AND (
                     $6::text IS NULL OR
                     (lease_owner = $6 AND lease_expires_at > clock_timestamp())
                   ))
                 )
               ) OR (
               status = 'running' AND
               (
                  ($4::text = 'pending' AND $6::text IS NULL AND (
                    lease_owner IS NULL OR lease_expires_at <= clock_timestamp()
                  )) OR (
                    $6::text IS NOT NULL AND
                    lease_owner = $6 AND
                    lease_expires_at > clock_timestamp()
                  ) OR (
                    $7::boolean = TRUE AND
                    $4::text = ANY(ARRAY['failed', 'interrupted']) AND
                    (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
                  )
                )
               )
             )
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = $4,
               body = run.body || $5::jsonb,
               revision = run.revision + 1,
               started_at = CASE
                 WHEN $4 = 'pending' THEN NULL
                 WHEN $4 = 'running' THEN COALESCE(run.started_at, clock_timestamp())
                 ELSE run.started_at
               END,
               completed_at = CASE
                 WHEN $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN clock_timestamp()
                 ELSE NULL
               END,
               lease_owner = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.lease_owner
               END,
               lease_expires_at = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.lease_expires_at
               END,
               last_heartbeat_at = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.last_heartbeat_at
               END,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.status AS previous_status
         )
         SELECT * FROM updated`,
        [id, revision, sources, target, bodyPatch, owner, permitExpiredLease]
      );
      if (result.rowCount === 0) {
        return this._throwTransitionConflict(connection, {
          entity: 'run',
          tableName: 'runs',
          id,
          expectedRevision: revision,
          expectedStatuses: sources,
          fromRow: runFromRow,
          leaseOwner: owner,
          leaseConstrained: true
        });
      }
      const run = runFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const event = await this._appendEvent(connection, {
        type,
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousStatus,
          status: run.status,
          revision: run.revision,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          updatedAt: run.updatedAt
        }
      });
      return { run, event, previousStatus };
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
    this.assertJsonRecord(normalized.payload, 'event.payload');
    const result = await client.query(
      `INSERT INTO ${this.table('events')}
        (id, schema_version, ts, type, ticket_id, run_id, step_id, seq, prev_hash, hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::json)
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

  async _recordImmutableRunEvidence({
    runId,
    value,
    valueLabel,
    tableName,
    columnName,
    eventType,
    eventPayloadKey,
    eventPayload = {},
    fromRow,
    client = null
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const document = this.assertJsonRecord(value, valueLabel);
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id, status FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      if (!TERMINAL_RUN_STATUSES.has(runResult.rows[0].status)) {
        throw new TypeError(`${valueLabel} requires a terminal run`);
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table(tableName)} (run_id, ticket_id, ${quoteIdentifier(columnName)})
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING *`,
        [id, ticketId, document]
      );
      if (inserted.rowCount === 0) {
        const existingResult = await connection.query(
          `SELECT *, ${quoteIdentifier(columnName)} = $2::jsonb AS evidence_matches
           FROM ${this.table(tableName)}
           WHERE run_id = $1`,
          [id, document]
        );
        if (existingResult.rowCount === 1 && existingResult.rows[0].evidence_matches === true) {
          return { record: fromRow(existingResult.rows[0]), event: null, inserted: false };
        }
        throw new ImmutableEvidenceConflictError(valueLabel, id);
      }

      const record = fromRow(inserted.rows[0]);
      const event = await this._appendEvent(connection, {
        type: eventType,
        ticketId,
        runId: id,
        payload: {
          ...callerPayload,
          [eventPayloadKey]: document,
          recordedAt: record.recordedAt
        }
      });
      return { record, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async recordRunEvaluation({ runId, evaluation, eventPayload = {} }, { client = null } = {}) {
    return this._recordImmutableRunEvidence({
      runId,
      value: evaluation,
      valueLabel: 'run evaluation',
      tableName: 'run_evaluations',
      columnName: 'evaluation',
      eventType: 'run.evaluation_completed',
      eventPayloadKey: 'evaluation',
      eventPayload,
      fromRow: evaluationFromRow,
      client
    });
  }

  async recordRunConsequence({ runId, consequence, eventPayload = {} }, { client = null } = {}) {
    return this._recordImmutableRunEvidence({
      runId,
      value: consequence,
      valueLabel: 'run consequence',
      tableName: 'run_consequences',
      columnName: 'consequence',
      eventType: 'run.consequence_recorded',
      eventPayloadKey: 'consequence',
      eventPayload,
      fromRow: consequenceFromRow,
      client
    });
  }

  async getRunEvaluation(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('run_evaluations')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : evaluationFromRow(result.rows[0]);
  }

  async getRunConsequence(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('run_consequences')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : consequenceFromRow(result.rows[0]);
  }

  async writeReplaySnapshot({
    runId,
    expectedRevision = null,
    snapshot,
    finalize = false,
    eventType = null,
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const document = this.assertJsonRecord(snapshot, 'replay snapshot');
    const snapshotHash = sha256Json(document);
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const explicitEventType = eventType === null || eventType === undefined
      ? null
      : requiredString(eventType, 'eventType');
    const isCreate = expectedRevision === null || expectedRevision === undefined;
    const revision = isCreate ? null : positiveSafeInteger(expectedRevision, 'expectedRevision');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id, status FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      if (finalize === true && !TERMINAL_RUN_STATUSES.has(runResult.rows[0].status)) {
        throw new TypeError('Finalizing a replay snapshot requires a terminal run');
      }
      let result;
      if (isCreate) {
        result = await connection.query(
          `INSERT INTO ${this.table('replay_snapshots')}
            (run_id, ticket_id, snapshot, snapshot_hash, finalized_at)
           VALUES ($1, $2, $3::jsonb, $4, CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *`,
          [id, ticketId, document, snapshotHash, finalize === true]
        );
      } else {
        result = await connection.query(
          `UPDATE ${this.table('replay_snapshots')}
           SET snapshot = $3::jsonb,
               snapshot_hash = $4,
               revision = revision + 1,
               finalized_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
               updated_at = clock_timestamp()
           WHERE run_id = $1 AND revision = $2 AND finalized_at IS NULL
           RETURNING *`,
          [id, revision, document, snapshotHash, finalize === true]
        );
      }

      if (result.rowCount === 0) {
        const currentResult = await connection.query(
          `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`,
          [id]
        );
        if (currentResult.rowCount === 1 && currentResult.rows[0].finalized_at !== null) {
          throw new ImmutableEvidenceConflictError('finalized replay snapshot', id);
        }
        const current = currentResult.rowCount === 0 ? null : replaySnapshotFromRow(currentResult.rows[0]);
        throw new OptimisticConcurrencyError('replay snapshot', id, revision || 0, current);
      }

      const record = replaySnapshotFromRow(result.rows[0]);
      const resolvedEventType = explicitEventType || (record.finalizedAt
        ? 'replay.snapshot.finalized'
        : record.revision === 1
          ? 'replay.snapshot.created'
          : 'replay.snapshot.updated');
      const event = await this._appendEvent(connection, {
        type: resolvedEventType,
        ticketId,
        runId: id,
        payload: {
          ...callerPayload,
          snapshotHash: record.snapshotHash,
          revision: record.revision,
          finalizedAt: record.finalizedAt,
          updatedAt: record.updatedAt
        }
      });
      return { record, event, created: isCreate };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async terminalizeRun({
    runId,
    expectedRevision,
    expectedReplayRevision = null,
    fromStatuses,
    status,
    leaseOwner = null,
    allowExpiredLease = false,
    patch = {},
    replaySnapshot,
    evaluation,
    consequence,
    executionEvent,
    beforeReplayEvents = [],
    replayEvent,
    beforeEvaluationEvents = [],
    terminalEvent
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const requestedRevision = expectedRevision === null || expectedRevision === undefined
      ? null
      : positiveSafeInteger(expectedRevision, 'expectedRevision');
    const requestedReplayRevision = expectedReplayRevision === null || expectedReplayRevision === undefined
      ? null
      : positiveSafeInteger(expectedReplayRevision, 'expectedReplayRevision');
    if (!Array.isArray(beforeReplayEvents) || !Array.isArray(beforeEvaluationEvents)) {
      throw new TypeError('terminalization event groups must be arrays');
    }
    const normalizeTerminalEvent = (event, label) => {
      const source = this.assertJsonRecord(event, label);
      return {
        type: requiredString(source.type, `${label}.type`),
        ...(source.stepId === undefined || source.stepId === null ? {} : { stepId: String(source.stepId) }),
        payload: this.assertJsonRecord(source.payload || {}, `${label}.payload`)
      };
    };
    const execution = normalizeTerminalEvent(executionEvent, 'executionEvent');
    const preReplay = beforeReplayEvents.map((event, index) => normalizeTerminalEvent(event, `beforeReplayEvents[${index}]`));
    const replay = normalizeTerminalEvent(replayEvent, 'replayEvent');
    const preEvaluation = beforeEvaluationEvents.map((event, index) => normalizeTerminalEvent(event, `beforeEvaluationEvents[${index}]`));
    const terminal = normalizeTerminalEvent(terminalEvent, 'terminalEvent');

    return this.withTransaction(async client => {
      const storedEvents = [];
      const currentRun = await client.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentRun.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const revision = positiveSafeInteger(currentRun.rows[0].revision, 'run.revision');
      if (requestedRevision !== null && requestedRevision !== revision) {
        throw new OptimisticConcurrencyError('run', id, requestedRevision, runFromRow(currentRun.rows[0]));
      }
      const currentReplay = await client.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      const replayRevision = currentReplay.rowCount === 0
        ? null
        : positiveSafeInteger(currentReplay.rows[0].revision, 'replaySnapshot.revision');
      if (requestedReplayRevision !== null && requestedReplayRevision !== replayRevision) {
        throw new OptimisticConcurrencyError(
          'replay snapshot',
          id,
          requestedReplayRevision,
          currentReplay.rowCount === 0 ? null : replaySnapshotFromRow(currentReplay.rows[0])
        );
      }
      const transitioned = await this.transitionRun({
        runId: id,
        expectedRevision: revision,
        fromStatuses,
        toStatus: status,
        leaseOwner,
        allowExpiredLease,
        patch,
        eventType: execution.type,
        eventPayload: execution.payload
      }, { client });
      storedEvents.push(transitioned.event);

      for (const event of preReplay) {
        storedEvents.push(await this._appendEvent(client, {
          ...event,
          ticketId: transitioned.run.ticketId,
          runId: id
        }));
      }

      const replayResult = await this.writeReplaySnapshot({
        runId: id,
        expectedRevision: replayRevision,
        snapshot: replaySnapshot,
        finalize: true,
        eventType: replay.type,
        eventPayload: replay.payload
      }, { client });
      storedEvents.push(replayResult.event);

      for (const event of preEvaluation) {
        storedEvents.push(await this._appendEvent(client, {
          ...event,
          ticketId: transitioned.run.ticketId,
          runId: id
        }));
      }

      const evaluationDocument = typeof evaluation === 'function'
        ? await evaluation({
            run: transitioned.run,
            replaySnapshot,
            events: storedEvents.slice()
          })
        : evaluation;
      const evaluationResult = await this.recordRunEvaluation({
        runId: id,
        evaluation: evaluationDocument
      }, { client });
      storedEvents.push(evaluationResult.event);
      const consequenceDocument = typeof consequence === 'function'
        ? await consequence({
            run: transitioned.run,
            replaySnapshot,
            events: storedEvents.slice(),
            evaluation: evaluationDocument
          })
        : consequence;
      const consequenceResult = await this.recordRunConsequence({
        runId: id,
        consequence: consequenceDocument
      }, { client });
      storedEvents.push(consequenceResult.event);
      const terminalizedEvent = await this._appendEvent(client, {
        ...terminal,
        ticketId: transitioned.run.ticketId,
        runId: id
      });
      storedEvents.push(terminalizedEvent);

      return {
        run: transitioned.run,
        replaySnapshot: replayResult.record,
        evaluation: evaluationDocument,
        consequence: consequenceDocument,
        events: storedEvents.filter(Boolean)
      };
    });
  }

  async getReplaySnapshot(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : replaySnapshotFromRow(result.rows[0]);
  }

  async recordOperationReceipt({
    runId,
    idempotencyKey,
    stepId = null,
    operation,
    outcome,
    receipt,
    eventType = 'operation.receipt_recorded',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(idempotencyKey, 'idempotencyKey', 512);
    const normalizedStepId = optionalString(stepId);
    const operationName = requiredString(operation, 'operation');
    const normalizedOutcome = requiredString(outcome, 'outcome');
    if (!OPERATION_OUTCOMES.has(normalizedOutcome)) {
      throw new TypeError(`Unsupported operation receipt outcome: ${normalizedOutcome}`);
    }
    const document = this.assertJsonRecord(receipt, 'operation receipt');
    const type = eventType === null ? null : requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const targetId = optionalString(document.targetId);
    const targetKind = optionalString(document.targetKind);
    const targetPath = optionalString(document.targetPath);
    const targetResourceId = optionalString(document.targetResourceId);

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      const inserted = await connection.query(
        `INSERT INTO ${this.table('operation_receipts')}
          (run_id, ticket_id, idempotency_key, step_id, operation, outcome,
           target_id, target_kind, target_path, target_resource_id, receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (run_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          ticketId,
          key,
          normalizedStepId,
          operationName,
          normalizedOutcome,
          targetId,
          targetKind,
          targetPath,
          targetResourceId,
          document
        ]
      );

      if (inserted.rowCount === 0) {
        const existingResult = await connection.query(
          `SELECT * FROM ${this.table('operation_receipts')}
           WHERE run_id = $1 AND idempotency_key = $2`,
          [id, key]
        );
        const existing = existingResult.rowCount === 0 ? null : operationReceiptFromRow(existingResult.rows[0]);
        const matches = existing &&
          existing.ticketId === ticketId &&
          existing.stepId === normalizedStepId &&
          existing.operation === operationName &&
          existing.outcome === normalizedOutcome &&
          existing.targetId === targetId &&
          existing.targetKind === targetKind &&
          existing.targetPath === targetPath &&
          existing.targetResourceId === targetResourceId &&
          canonicalJson(existing.receipt) === canonicalJson(document);
        if (matches) return { record: existing, event: null, inserted: false };
        throw new IdempotencyConflictError(id, key);
      }

      const record = operationReceiptFromRow(inserted.rows[0]);
      const event = type === null ? null : await this._appendEvent(connection, {
        type,
        ticketId,
        runId: id,
        stepId: normalizedStepId,
        payload: {
          ...callerPayload,
          receiptId: record.id,
          idempotencyKey: record.idempotencyKey,
          operation: record.operation,
          outcome: record.outcome,
          receipt: record.receipt,
          recordedAt: record.recordedAt
        }
      });
      return { record, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async listOperationReceipts(runId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    return result.rows.map(operationReceiptFromRow);
  }

  async appendRunEvidence({
    runId,
    ticketId,
    evidenceKey,
    replayKey,
    replayItem,
    event
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(evidenceKey, 'evidenceKey', 512);
    const collection = requiredString(replayKey, 'replayKey');
    const item = { ...this.assertJsonRecord(replayItem, 'replayItem'), evidenceKey: key };
    const eventInput = this.assertJsonRecord(event, 'event');
    const eventType = requiredString(eventInput.type, 'event.type');
    const eventStepId = eventInput.stepId === undefined || eventInput.stepId === null
      ? null
      : String(eventInput.stepId);
    const eventPayload = {
      ...this.assertJsonRecord(eventInput.payload || {}, 'event.payload'),
      evidenceKey: key
    };

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      if (positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId') !== ownerTicketId) {
        throw new TypeError(`Run ${id} does not belong to ticket ${ownerTicketId}`);
      }
      const replayResult = await connection.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      if (replayResult.rowCount === 0) throw new TypeError(`Run ${id} does not have a replay snapshot`);
      const currentReplay = replaySnapshotFromRow(replayResult.rows[0]);
      if (currentReplay.finalizedAt) throw new ImmutableEvidenceConflictError('finalized replay snapshot', id);
      const snapshot = currentReplay.snapshot;
      const items = Array.isArray(snapshot[collection]) ? snapshot[collection] : [];
      const existingItem = items.find(candidate => candidate && candidate.evidenceKey === key) || null;
      if (existingItem && canonicalJson(existingItem) !== canonicalJson(item)) {
        throw new IdempotencyConflictError(id, key);
      }
      let storedReplay = currentReplay;
      if (!existingItem) {
        const document = this.assertJsonRecord(
          { ...snapshot, [collection]: [...items, item] },
          'replay snapshot'
        );
        const updated = await connection.query(
          `UPDATE ${this.table('replay_snapshots')}
           SET snapshot = $3::jsonb,
               snapshot_hash = $4,
               revision = revision + 1,
               updated_at = clock_timestamp()
           WHERE run_id = $1 AND revision = $2 AND finalized_at IS NULL
           RETURNING *`,
          [id, currentReplay.revision, document, sha256Json(document)]
        );
        if (updated.rowCount !== 1) {
          throw new OptimisticConcurrencyError('replay snapshot', id, currentReplay.revision, currentReplay);
        }
        storedReplay = replaySnapshotFromRow(updated.rows[0]);
      }

      const existingEventResult = await connection.query(
        `SELECT * FROM ${this.table('events')}
         WHERE run_id = $1 AND payload->>'evidenceKey' = $2
         ORDER BY position
         LIMIT 1`,
        [id, key]
      );
      let storedEvent = existingEventResult.rowCount === 0 ? null : eventFromRow(existingEventResult.rows[0]);
      if (storedEvent) {
        if (storedEvent.type !== eventType || storedEvent.stepId !== eventStepId ||
            canonicalJson(storedEvent.payload) !== canonicalJson(eventPayload)) {
          throw new IdempotencyConflictError(id, key);
        }
      } else {
        storedEvent = await this._appendEvent(connection, {
          type: eventType,
          ticketId: ownerTicketId,
          runId: id,
          ...(eventStepId === null ? {} : { stepId: eventStepId }),
          payload: eventPayload
        });
      }
      return {
        replayItem: existingItem || item,
        replaySnapshot: storedReplay,
        event: storedEvent,
        inserted: !existingItem
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async getTargetOperation(runId, operationKey, { client = null, forUpdate = false } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const connection = client || this.pool;
    const intentResult = await connection.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE run_id = $1 AND operation_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, key]
    );
    const receiptResult = await connection.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND idempotency_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, key]
    );
    const intent = intentResult.rowCount === 0 ? null : targetOperationIntentFromRow(intentResult.rows[0]);
    const receiptEnvelope = receiptResult.rowCount === 0 ? null : operationReceiptFromRow(receiptResult.rows[0]);
    return {
      intent,
      receipt: targetOperationReceiptProjection(receiptEnvelope, intent),
      receiptEnvelope
    };
  }

  async prepareTargetOperation({
    runId,
    ticketId,
    operationKey,
    stepId = null,
    leaseOwner,
    intent
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const document = this.assertJsonRecord(intent, 'intent');
    const operation = requiredString(document.operation, 'intent.operation');
    const target = document.target && typeof document.target === 'object' && !Array.isArray(document.target)
      ? document.target
      : {};
    const normalizedStepId = optionalString(stepId);
    const owner = requiredString(leaseOwner, 'leaseOwner');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT *, lease_expires_at > clock_timestamp() AS lease_live
         FROM ${this.table('runs')}
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const runRow = runResult.rows[0];
      const liveLease = runRow.status === 'running' && runRow.lease_owner === owner && runRow.lease_live === true;
      if (positiveSafeInteger(runRow.ticket_id, 'run.ticketId') !== ownerTicketId || !liveLease) {
        throw new LeaseAuthorityError(id, owner, runFromRow(runRow));
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table('target_operation_intents')}
          (run_id, ticket_id, operation_key, step_id, operation,
           target_id, target_kind, target_path, target_resource_id, intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (run_id, operation_key) DO NOTHING
         RETURNING *`,
        [
          id,
          ownerTicketId,
          key,
          normalizedStepId,
          operation,
          optionalString(target.targetId),
          optionalString(target.targetKind),
          optionalString(target.targetPath),
          optionalString(target.targetResourceId),
          document
        ]
      );
      if (inserted.rowCount === 0) {
        const current = await this.getTargetOperation(id, key, { client: connection, forUpdate: true });
        if (current.intent && current.intent.ticketId === ownerTicketId &&
            current.intent.stepId === normalizedStepId && current.intent.operation === operation &&
            canonicalJson(current.intent.intent) === canonicalJson(document)) {
          return { intent: current.intent, receipt: current.receipt, event: null, inserted: false };
        }
        throw new IdempotencyConflictError(id, key);
      }
      const record = targetOperationIntentFromRow(inserted.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'workspace.operation_prepared',
        ticketId: ownerTicketId,
        runId: id,
        ...(normalizedStepId === null ? {} : { stepId: normalizedStepId }),
        payload: { operationKey: key, intent: document }
      });
      return { intent: record, receipt: null, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async completeTargetOperation({
    runId,
    ticketId,
    operationKey,
    historyRecord,
    receipt,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const history = this.assertJsonRecord(historyRecord, 'historyRecord');
    const receiptDocument = this.assertJsonRecord(receipt, 'receipt');
    const proposedReplayItem = this.assertJsonRecord(replayItem, 'replayItem');
    const proposedEvent = this.assertJsonRecord(event, 'event');

    return this.withTransaction(async client => {
      const current = await this.getTargetOperation(id, key, { client, forUpdate: true });
      if (!current.intent) throw new TypeError(`Target operation ${key} was not prepared`);
      if (current.intent.ticketId !== ownerTicketId) throw new IdempotencyConflictError(id, key);
      const outcome = history.outcome === 'failed' || history.outcome === 'refused'
        ? history.outcome
        : 'succeeded';
      const recorded = await this.recordOperationReceipt({
        runId: id,
        idempotencyKey: key,
        stepId: current.intent.stepId,
        operation: current.intent.operation,
        outcome,
        receipt: receiptDocument,
        eventType: null
      }, { client });
      if (!recorded.inserted) return { record: recorded.record, evidence: null, inserted: false };
      const evidence = await this.appendRunEvidence({
        runId: id,
        ticketId: ownerTicketId,
        evidenceKey: `target-operation:${key}:completed`,
        replayKey: 'workspaceOperations',
        replayItem: {
          ...proposedReplayItem,
          historyId: recorded.record.id,
          operationKey: key,
          mutationReceipt: recorded.record.receipt
        },
        event: {
          ...proposedEvent,
          payload: {
            ...this.assertJsonRecord(proposedEvent.payload || {}, 'event.payload'),
            historyId: recorded.record.id,
            operationKey: key,
            mutationReceipt: recorded.record.receipt
          }
        }
      }, { client });
      return { record: recorded.record, evidence, inserted: recorded.inserted };
    });
  }

  async withTargetOperationLock({ targetId, paths }, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const requests = buildWorkspaceLockRequests(targetId, paths);
    const client = await this.pool.connect();
    const acquired = [];
    try {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [`${this.lockTimeoutMs}ms`]);
      for (const request of requests) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_lock' : 'pg_advisory_lock_shared';
        await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]);
        acquired.push(request);
      }
      return await this.targetOperationClientStorage.run(client, () => operation(requests));
    } finally {
      for (const request of acquired.reverse()) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared';
        try { await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]); } catch (_) {}
      }
      try { await client.query("SELECT set_config('lock_timeout', '0', false)"); } catch (_) {}
      client.release();
    }
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
      const callerPayload = typeof claimPayload === 'function'
        ? this.assertJsonRecord(claimPayload(run), 'claimPayload')
        : this.assertJsonRecord(claimPayload, 'claimPayload');
      const event = await this._appendEvent(client, {
        type: 'run.lease_acquired',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
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
         WHERE id = $1
           AND status = ANY($4::text[])
           AND lease_owner = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, duration, ['pending', 'running']]
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
             last_heartbeat_at = NULL,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp()
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

  async persistRunWorkflowStep({
    runId,
    leaseOwner,
    leaseDurationMs,
    stepId = null,
    action = null,
    status = 'started',
    payload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const normalizedStepId = optionalString(stepId);
    const normalizedAction = optionalString(action);
    const normalizedStatus = requiredString(status, 'status');
    const callerPayload = this.assertJsonRecord(payload, 'workflow step payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET body = body || $4::jsonb,
             lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, duration, {
          currentStepId: normalizedStepId,
          currentWorkflowAction: normalizedAction
        }]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'workflow.step.persisted',
        ticketId: run.ticketId,
        runId: run.id,
        stepId: normalizedStepId,
        payload: {
          ...callerPayload,
          status: normalizedStatus,
          action: normalizedAction,
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async recoverExpiredRun({ runId, eventType = 'run.resumed', eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'recovery event payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, lease_owner, lease_expires_at, last_heartbeat_at
           FROM ${this.table('runs')}
           WHERE id = $1
             AND status = 'running'
             AND lease_expires_at <= clock_timestamp()
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = 'pending',
               started_at = NULL,
               completed_at = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               revision = run.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.lease_owner AS previous_lease_owner,
             candidate.lease_expires_at AS previous_lease_expires_at,
             candidate.last_heartbeat_at AS previous_last_heartbeat_at
         )
         SELECT * FROM updated`,
        [id]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const previousLease = {
        leaseOwner: result.rows[0].previous_lease_owner,
        leaseExpiresAt: rowTimestamp(result.rows[0].previous_lease_expires_at),
        lastHeartbeatAt: rowTimestamp(result.rows[0].previous_last_heartbeat_at)
      };
      const event = await this._appendEvent(client, {
        type,
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousLease,
          recoveredAt: run.updatedAt,
          status: run.status
        }
      });
      return { run, event, previousLease };
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
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeStore,
  StateTransitionConflictError,
  buildEventEnvelope,
  buildWorkspaceLockRequests,
  canonicalJson,
  normalizeWorkspacePath,
  quoteIdentifier,
  sha256Json
};
