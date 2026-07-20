'use strict';

const {
  WATCHER_OBSERVATION_STATUSES,
  WATCHER_PROPOSAL_STATUSES,
  WATCHER_STATUSES,
  WatcherReferenceError,
  WatcherStateConflictError,
  enumList,
  nonNegativeSafeInteger,
  normalizeWatcherObservationValue,
  normalizeWatcherProposalValue,
  normalizeWatcherValue,
  nullablePositiveSafeInteger,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  sameSourceRefs
} = require('../watcher-authority');

function rowTimestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('PostgreSQL returned an invalid timestamp');
  return date.toISOString();
}

function watcherFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    id: positiveSafeInteger(row.id, 'watcher.id'),
    ...body,
    name: row.name,
    status: row.status,
    workContextId: positiveSafeInteger(row.work_context_id, 'watcher.workContextId'),
    sourceKind: row.source_kind,
    lastObservedAt: rowTimestamp(row.last_observed_at),
    lastObservationHash: row.last_observation_hash || null,
    revision: positiveSafeInteger(row.revision, 'watcher.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function observationFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    id: positiveSafeInteger(row.id, 'watcherObservation.id'),
    ...body,
    watcherId: positiveSafeInteger(row.watcher_id, 'watcherObservation.watcherId'),
    workContextId: positiveSafeInteger(row.work_context_id, 'watcherObservation.workContextId'),
    status: row.status,
    sourceKind: row.source_kind,
    previousHash: row.previous_hash || null,
    currentHash: row.current_hash || null,
    observedAt: rowTimestamp(row.observed_at)
  };
}

function proposalFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    id: positiveSafeInteger(row.id, 'watcherProposal.id'),
    ...body,
    watcherId: positiveSafeInteger(row.watcher_id, 'watcherProposal.watcherId'),
    workContextId: positiveSafeInteger(row.work_context_id, 'watcherProposal.workContextId'),
    observationId: nullablePositiveSafeInteger(row.observation_id, 'watcherProposal.observationId'),
    status: row.status,
    objective: row.objective,
    createdTicketId: nullablePositiveSafeInteger(row.created_ticket_id, 'watcherProposal.createdTicketId'),
    approvedAt: rowTimestamp(row.approved_at),
    rejectedAt: rowTimestamp(row.rejected_at),
    revision: positiveSafeInteger(row.revision, 'watcherProposal.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function safeCount(value, label) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds the safe integer range`);
  return count;
}

function methods({ OptimisticConcurrencyError }) {
  return {
    _watcherLimit(value, label = 'limit') {
      const size = positiveSafeInteger(value, label);
      if (size > this.maxQueryRows) throw new RangeError(`${label} exceeds the configured maximum of ${this.maxQueryRows}`);
      return size;
    },

    _watcherValue(value) {
      const normalized = normalizeWatcherValue(this.assertJsonRecord(value, 'value'));
      const body = { ...normalized };
      for (const key of ['name', 'status', 'workContextId', 'sourceKind']) delete body[key];
      return {
        name: normalized.name,
        status: normalized.status,
        workContextId: normalized.workContextId,
        sourceKind: normalized.sourceKind,
        body: this.assertJsonRecord(body, 'watcher body')
      };
    },

    _watcherObservationValue(value) {
      const normalized = normalizeWatcherObservationValue(this.assertJsonRecord(value, 'value'));
      const body = { ...normalized };
      for (const key of ['watcherId', 'workContextId', 'status', 'sourceKind', 'previousHash', 'currentHash']) delete body[key];
      return { ...normalized, body: this.assertJsonRecord(body, 'watcher observation body') };
    },

    _watcherProposalValue(value) {
      const normalized = normalizeWatcherProposalValue(this.assertJsonRecord(value, 'value'));
      const body = { ...normalized };
      for (const key of ['watcherId', 'workContextId', 'observationId', 'objective']) delete body[key];
      return { ...normalized, body: this.assertJsonRecord(body, 'watcher proposal body') };
    },

    async _assertWatcherWorkContext(connection, workContextId, { requireActive = false } = {}) {
      const result = await connection.query(
        `SELECT id, status FROM ${this.table('work_contexts')} WHERE id = $1 FOR SHARE`,
        [workContextId]
      );
      if (result.rowCount === 0) throw new WatcherReferenceError(`Work Context not found: ${workContextId}`, 'WORK_CONTEXT_NOT_FOUND');
      if (requireActive && result.rows[0].status !== 'active') {
        throw new WatcherReferenceError('An active watcher requires an active Work Context', 'WORK_CONTEXT_NOT_ACTIVE');
      }
      return result.rows[0];
    },

    async listWatchers({ afterId = 0, statuses = null, workContextId = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const allowed = enumList(statuses, WATCHER_STATUSES, 'statuses');
      const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
      const size = this._watcherLimit(limit);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('watchers')}
         WHERE id > $1
           AND ($2::text[] IS NULL OR status = ANY($2::text[]))
           AND ($3::bigint IS NULL OR work_context_id = $3)
         ORDER BY id LIMIT $4`,
        [cursor, allowed, contextId, size + 1]
      );
      const watchers = result.rows.slice(0, size).map(watcherFromRow);
      return { watchers, nextAfterId: result.rows.length > size && watchers.length ? watchers[watchers.length - 1].id : null };
    },

    async getWatcherById(watcherId) {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('watchers')} WHERE id = $1`, [id]);
      return result.rowCount === 0 ? null : watcherFromRow(result.rows[0]);
    },

    async getWatcherOperationalSummary({ limit = 10 } = {}) {
      const size = this._watcherLimit(limit);
      const [countsResult, failuresResult, existsResult] = await Promise.all([
        this.pool.query(
          `SELECT
             COALESCE(SUM(count) FILTER (WHERE status = 'active'), 0)::bigint AS active,
             COALESCE(SUM(count) FILTER (WHERE status = 'paused'), 0)::bigint AS paused,
             COALESCE(SUM(count) FILTER (WHERE status = 'archived'), 0)::bigint AS archived,
             COALESCE(SUM(count), 0)::bigint AS total
           FROM ${this.table('watcher_status_counts')}`
        ),
        this.pool.query(
          `SELECT * FROM ${this.table('watcher_observations')}
           WHERE status IN ('failed', 'refused') ORDER BY id DESC LIMIT $1`,
          [size]
        ),
        this.pool.query(
          `SELECT EXISTS (
             SELECT 1 FROM ${this.table('watcher_observations')}
             WHERE status IN ('failed', 'refused') LIMIT 1
           ) AS exists`
        )
      ]);
      const row = countsResult.rows[0] || {};
      return {
        active: safeCount(row.active || 0, 'active watcher count'),
        paused: safeCount(row.paused || 0, 'paused watcher count'),
        archived: safeCount(row.archived || 0, 'archived watcher count'),
        total: safeCount(row.total || 0, 'watcher count'),
        recentFailures: failuresResult.rows.map(observationFromRow),
        hasFailures: Boolean(existsResult.rows[0] && existsResult.rows[0].exists)
      };
    },

    async _listWatcherObservations(connection, { watcherId = null, beforeId = null, statuses = null, limit = 20 } = {}) {
      const ownerId = nullablePositiveSafeInteger(watcherId, 'watcherId');
      const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
      const allowed = enumList(statuses, WATCHER_OBSERVATION_STATUSES, 'statuses');
      const size = this._watcherLimit(limit);
      const result = await connection.query(
        `SELECT * FROM ${this.table('watcher_observations')}
         WHERE ($1::bigint IS NULL OR watcher_id = $1)
           AND ($2::bigint IS NULL OR id < $2)
           AND ($3::text[] IS NULL OR status = ANY($3::text[]))
         ORDER BY id DESC LIMIT $4`,
        [ownerId, before, allowed, size + 1]
      );
      const observations = result.rows.slice(0, size).map(observationFromRow);
      return { observations, nextBeforeId: result.rows.length > size && observations.length ? observations[observations.length - 1].id : null };
    },

    async listWatcherObservations(options = {}) {
      return this._listWatcherObservations(this.pool, options);
    },

    async _listWatcherProposals(connection, { watcherId = null, beforeId = null, statuses = null, limit = 20 } = {}) {
      const ownerId = nullablePositiveSafeInteger(watcherId, 'watcherId');
      const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
      const allowed = enumList(statuses, WATCHER_PROPOSAL_STATUSES, 'statuses');
      const size = this._watcherLimit(limit);
      const result = await connection.query(
        `SELECT * FROM ${this.table('watcher_ticket_proposals')}
         WHERE ($1::bigint IS NULL OR watcher_id = $1)
           AND ($2::bigint IS NULL OR id < $2)
           AND ($3::text[] IS NULL OR status = ANY($3::text[]))
         ORDER BY id DESC LIMIT $4`,
        [ownerId, before, allowed, size + 1]
      );
      const proposals = result.rows.slice(0, size).map(proposalFromRow);
      return { proposals, nextBeforeId: result.rows.length > size && proposals.length ? proposals[proposals.length - 1].id : null };
    },

    async listWatcherProposals(options = {}) {
      return this._listWatcherProposals(this.pool, options);
    },

    async getWatcherProposalById(proposalId) {
      const id = positiveSafeInteger(proposalId, 'proposalId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('watcher_ticket_proposals')} WHERE id = $1`, [id]);
      return result.rowCount === 0 ? null : proposalFromRow(result.rows[0]);
    },

    async createWatcher({ value, changedBy, audit = null }) {
      const normalized = this._watcherValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        await this._assertWatcherWorkContext(client, normalized.workContextId, { requireActive: normalized.status === 'active' });
        const result = await client.query(
          `INSERT INTO ${this.table('watchers')}
             (name, status, work_context_id, source_kind, body, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $6) RETURNING *`,
          [normalized.name, normalized.status, normalized.workContextId, normalized.sourceKind, normalized.body, actor]
        );
        const watcher = watcherFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), watcherId: watcher.id, workContextId: watcher.workContextId }
        }) : null;
        return { watcher, auditLog };
      });
    },

    async updateWatcher({ watcherId, expectedRevision, value, changedBy, audit = null }) {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const normalized = this._watcherValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(`SELECT * FROM ${this.table('watchers')} WHERE id = $1 FOR UPDATE`, [id]);
        if (currentResult.rowCount === 0) return null;
        const current = watcherFromRow(currentResult.rows[0]);
        if (current.revision !== revision) throw new OptimisticConcurrencyError('watcher', id, revision, current);
        await this._assertWatcherWorkContext(client, normalized.workContextId, { requireActive: normalized.status === 'active' });
        const result = await client.query(
          `UPDATE ${this.table('watchers')}
           SET name = $2, status = $3, work_context_id = $4, source_kind = $5, body = $6::jsonb,
               revision = revision + 1, updated_by = $7, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $8 RETURNING *`,
          [id, normalized.name, normalized.status, normalized.workContextId, normalized.sourceKind, normalized.body, actor, revision]
        );
        if (result.rowCount === 0) {
          const latest = await client.query(`SELECT * FROM ${this.table('watchers')} WHERE id = $1`, [id]);
          throw new OptimisticConcurrencyError('watcher', id, revision, latest.rowCount ? watcherFromRow(latest.rows[0]) : null);
        }
        const watcher = watcherFromRow(result.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), watcherId: id, workContextId: watcher.workContextId }
        }) : null;
        return { watcher, auditLog };
      });
    },

    async recordWatcherObservation({ watcherId, expectedRevision, value, changedBy, advanceCursor, audit = null }) {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      if (typeof advanceCursor !== 'boolean') throw new TypeError('advanceCursor must be boolean');
      const normalized = this._watcherObservationValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const watcherResult = await client.query(`SELECT * FROM ${this.table('watchers')} WHERE id = $1 FOR UPDATE`, [id]);
        if (watcherResult.rowCount === 0) return null;
        const watcher = watcherFromRow(watcherResult.rows[0]);
        if (watcher.revision !== revision) throw new OptimisticConcurrencyError('watcher', id, revision, watcher);
        if (normalized.watcherId !== id || normalized.workContextId !== watcher.workContextId ||
            normalized.sourceKind !== watcher.sourceKind || !sameSourceRefs(normalized.sourceRefs, watcher.sourceRefs)) {
          throw new WatcherReferenceError('Observation authority does not match watcher', 'WATCHER_OBSERVATION_MISMATCH');
        }
        await this._assertWatcherWorkContext(client, watcher.workContextId);
        const inserted = await client.query(
          `INSERT INTO ${this.table('watcher_observations')}
             (watcher_id, work_context_id, status, source_kind, previous_hash, current_hash, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
          [id, watcher.workContextId, normalized.status, normalized.sourceKind,
            normalized.previousHash, normalized.currentHash, normalized.body]
        );
        const observation = observationFromRow(inserted.rows[0]);
        let updatedWatcher = watcher;
        if (advanceCursor) {
          const cursorHash = normalized.currentHash === null ? normalized.previousHash : normalized.currentHash;
          const updated = await client.query(
            `UPDATE ${this.table('watchers')}
             SET last_observed_at = $2, last_observation_hash = $3, revision = revision + 1,
                 updated_by = $4, updated_at = $2
             WHERE id = $1 AND revision = $5 RETURNING *`,
            [id, observation.observedAt, cursorHash, actor, revision]
          );
          if (updated.rowCount === 0) throw new OptimisticConcurrencyError('watcher', id, revision, watcher);
          updatedWatcher = watcherFromRow(updated.rows[0]);
        }
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), watcherId: id, observationId: observation.id, status: observation.status }
        }) : null;
        return { observation, watcher: updatedWatcher, auditLog };
      });
    },

    async createWatcherProposal({ watcherId, value, changedBy, audit = null }) {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const normalized = this._watcherProposalValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const watcherResult = await client.query(`SELECT * FROM ${this.table('watchers')} WHERE id = $1 FOR SHARE`, [id]);
        if (watcherResult.rowCount === 0) return null;
        const watcher = watcherFromRow(watcherResult.rows[0]);
        if (normalized.watcherId !== id || normalized.workContextId !== watcher.workContextId ||
            !sameSourceRefs(normalized.sourceRefs, watcher.sourceRefs)) {
          throw new WatcherReferenceError('Proposal authority does not match watcher', 'WATCHER_PROPOSAL_MISMATCH');
        }
        await this._assertWatcherWorkContext(client, watcher.workContextId, { requireActive: true });
        if (normalized.observationId !== null) {
          const observation = await client.query(
            `SELECT 1 FROM ${this.table('watcher_observations')}
             WHERE id = $1 AND watcher_id = $2 AND work_context_id = $3 FOR SHARE`,
            [normalized.observationId, id, watcher.workContextId]
          );
          if (observation.rowCount === 0) {
            throw new WatcherReferenceError('Proposal observation does not belong to watcher', 'WATCHER_OBSERVATION_MISMATCH');
          }
        }
        const inserted = await client.query(
          `INSERT INTO ${this.table('watcher_ticket_proposals')}
             (watcher_id, work_context_id, observation_id, status, objective, body, created_by, updated_by)
           VALUES ($1, $2, $3, 'proposed', $4, $5::jsonb, $6, $6) RETURNING *`,
          [id, watcher.workContextId, normalized.observationId, normalized.objective, normalized.body, actor]
        );
        const proposal = proposalFromRow(inserted.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), watcherId: id, proposalId: proposal.id, workContextId: watcher.workContextId }
        }) : null;
        return { proposal, auditLog };
      });
    },

    async approveWatcherProposal({ proposalId, changedBy, createTicket }) {
      const id = positiveSafeInteger(proposalId, 'proposalId');
      const actor = requiredString(changedBy, 'changedBy');
      const create = requiredFunction(createTicket, 'createTicket');
      return this.withTransaction(async client => {
        const proposalResult = await client.query(
          `SELECT * FROM ${this.table('watcher_ticket_proposals')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (proposalResult.rowCount === 0) return null;
        const proposal = proposalFromRow(proposalResult.rows[0]);
        if (proposal.status !== 'proposed') {
          throw new WatcherStateConflictError('Only a proposed proposal can be approved', 'WATCHER_PROPOSAL_NOT_PROPOSED', proposal);
        }
        await this._assertWatcherWorkContext(client, proposal.workContextId, { requireActive: true });
        const at = rowTimestamp((await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts);
        const source = {
          type: 'watcher_proposal', watcherId: proposal.watcherId, workContextId: proposal.workContextId,
          observationId: proposal.observationId, proposalId: proposal.id, fromActor: actor,
          sourceRefs: proposal.sourceRefs, evidenceRefs: proposal.evidenceRefs, constraints: proposal.constraints,
          authorityLimits: proposal.authorityLimits, stopCondition: proposal.stopCondition,
          receiptExpectation: proposal.receiptExpectation, createdAt: at, createdBy: actor, status: 'created'
        };
        const ticketResult = await create({ proposal, source, persistence: { client } });
        if (!ticketResult || ticketResult.ok !== true || !ticketResult.ticket) return ticketResult || { ok: false, error: 'Ticket creation failed' };
        const ticket = ticketResult.ticket;
        if (!ticket.source || ticket.source.type !== 'watcher_proposal' || ticket.source.proposalId !== id ||
            ticket.source.watcherId !== proposal.watcherId || ticket.source.workContextId !== proposal.workContextId ||
            ticket.source.observationId !== proposal.observationId) {
          throw new WatcherReferenceError('Approved ticket provenance does not match proposal', 'WATCHER_TICKET_PROVENANCE_MISMATCH');
        }
        const updated = await client.query(
          `UPDATE ${this.table('watcher_ticket_proposals')}
           SET status = 'approved', created_ticket_id = $2, approved_at = $3, rejected_at = NULL,
               revision = revision + 1, updated_by = $4, updated_at = $3
           WHERE id = $1 AND revision = $5 RETURNING *`,
          [id, positiveSafeInteger(ticket.id, 'ticket.id'), at, actor, proposal.revision]
        );
        if (updated.rowCount === 0) throw new OptimisticConcurrencyError('watcher proposal', id, proposal.revision, proposal);
        const approved = proposalFromRow(updated.rows[0]);
        const event = await this._appendEvent(client, {
          type: 'watcher.proposal_approved',
          ticketId: ticket.id,
          payload: { watcherId: approved.watcherId, proposalId: id, createdTicketId: ticket.id, createdBy: actor }
        });
        const auditLog = await this._appendSystemLog(client, {
          type: 'watcher:proposal_approved',
          message: `Watcher proposal #${id} approved → ticket #${ticket.id}`,
          metadata: { proposalId: id, watcherId: approved.watcherId, contextTicketId: ticket.id, createdTicketId: ticket.id, changedBy: actor }
        });
        return { ok: true, proposal: approved, ticket, event, auditLog };
      });
    },

    async rejectWatcherProposal({ proposalId, changedBy, audit = null }) {
      const id = positiveSafeInteger(proposalId, 'proposalId');
      const actor = requiredString(changedBy, 'changedBy');
      return this.withTransaction(async client => {
        const currentResult = await client.query(
          `SELECT * FROM ${this.table('watcher_ticket_proposals')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentResult.rowCount === 0) return null;
        const current = proposalFromRow(currentResult.rows[0]);
        if (current.status !== 'proposed') {
          throw new WatcherStateConflictError('Only a proposed proposal can be rejected', 'WATCHER_PROPOSAL_NOT_PROPOSED', current);
        }
        const updated = await client.query(
          `UPDATE ${this.table('watcher_ticket_proposals')}
           SET status = 'rejected', rejected_at = clock_timestamp(), approved_at = NULL,
               created_ticket_id = NULL, revision = revision + 1,
               updated_by = $2, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $3 RETURNING *`,
          [id, actor, current.revision]
        );
        if (updated.rowCount === 0) throw new OptimisticConcurrencyError('watcher proposal', id, current.revision, current);
        const proposal = proposalFromRow(updated.rows[0]);
        const auditLog = audit ? await this._appendSystemLog(client, {
          ...audit,
          metadata: { ...(audit.metadata || {}), proposalId: id, watcherId: proposal.watcherId, changedBy: actor }
        }) : null;
        return { proposal, auditLog };
      });
    }
  };
}

function installWatcherAuthorityMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installWatcherAuthorityMethods };
