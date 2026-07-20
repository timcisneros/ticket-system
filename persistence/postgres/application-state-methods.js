'use strict';

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return number;
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function optionalPositiveSafeInteger(value, label) {
  return value === undefined || value === null ? null : positiveSafeInteger(value, label);
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function documentBody(record, structuralFields) {
  const body = { ...record };
  for (const field of structuralFields) delete body[field];
  return body;
}

function catalogFromRow(row, label) {
  return {
    ...(row.body || {}),
    id: row.id,
    status: row.status,
    revision: positiveSafeInteger(row.revision, `${label}.revision`),
    createdAt: timestamp(row.created_at, `${label}.createdAt`),
    updatedAt: timestamp(row.updated_at, `${label}.updatedAt`)
  };
}

function allocationPlanFromRow(row) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'allocationPlan.id'),
    ticketId: positiveSafeInteger(row.ticket_id, 'allocationPlan.ticketId'),
    status: row.status,
    revision: positiveSafeInteger(row.revision, 'allocationPlan.revision'),
    createdAt: timestamp(row.created_at, 'allocationPlan.createdAt'),
    updatedAt: timestamp(row.updated_at, 'allocationPlan.updatedAt')
  };
}

function messageFromRow(row) {
  return {
    id: positiveSafeInteger(row.message_id, 'message.id'),
    author: row.author,
    authorName: row.author_name,
    kind: row.kind,
    body: row.body,
    createdAt: timestamp(row.created_at, 'message.createdAt')
  };
}

function threadFromRow(row, messages = []) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'messageThread.id'),
    key: row.thread_key,
    kind: row.kind,
    ticketId: positiveSafeInteger(row.ticket_id, 'messageThread.ticketId'),
    runId: optionalPositiveSafeInteger(row.run_id, 'messageThread.runId'),
    status: row.status,
    revision: positiveSafeInteger(row.revision, 'messageThread.revision'),
    createdAt: timestamp(row.created_at, 'messageThread.createdAt'),
    updatedAt: timestamp(row.updated_at, 'messageThread.updatedAt'),
    closedAt: row.closed_at ? timestamp(row.closed_at, 'messageThread.closedAt') : null,
    closedBy: row.closed_by || null,
    messages
  };
}

function methods({ OptimisticConcurrencyError }) {
  return {
    async listBrowserTargets({ afterId = '', statuses = null, limit = 100 } = {}) {
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const allowed = statuses === null ? null : [...new Set(statuses.map(value => requiredString(value, 'status')))];
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('browser_targets')}
         WHERE id > $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
         ORDER BY id LIMIT $3`,
        [String(afterId || ''), allowed, size + 1]
      );
      const rows = result.rows.slice(0, size);
      return { targets: rows.map(row => catalogFromRow(row, 'browserTarget')), nextAfterId: result.rowCount > size ? rows[rows.length - 1].id : null };
    },

    async getBrowserTarget(id) {
      const result = await this.pool.query(`SELECT * FROM ${this.table('browser_targets')} WHERE id = $1`, [requiredString(id, 'id')]);
      return result.rowCount ? catalogFromRow(result.rows[0], 'browserTarget') : null;
    },

    async createBrowserTarget({ target, changedBy = 'system' }) {
      const record = this.assertJsonRecord(target, 'target');
      const id = requiredString(record.id, 'target.id');
      const status = requiredString(record.status, 'target.status');
      const body = this.assertJsonRecord(documentBody(record, ['id', 'status', 'revision', 'createdAt', 'updatedAt']), 'browser target body');
      return this.withTransaction(async client => {
        const result = await client.query(
          `INSERT INTO ${this.table('browser_targets')} (id, status, body) VALUES ($1, $2, $3::jsonb) RETURNING *`,
          [id, status, body]
        );
        const created = catalogFromRow(result.rows[0], 'browserTarget');
        await this._appendSystemLog(client, { type: 'browser_target.created', message: `Browser target "${created.name || created.id}" created by ${changedBy}`, metadata: { targetId: created.id, changedBy } });
        return created;
      });
    },

    async updateBrowserTarget({ targetId, expectedRevision, target, changedBy = 'system', auditType = 'browser_target.updated' }) {
      const id = requiredString(targetId, 'targetId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const record = this.assertJsonRecord(target, 'target');
      const status = requiredString(record.status, 'target.status');
      const body = this.assertJsonRecord(documentBody(record, ['id', 'status', 'revision', 'createdAt', 'updatedAt']), 'browser target body');
      return this.withTransaction(async client => {
        const result = await client.query(
          `UPDATE ${this.table('browser_targets')} SET status = $3, body = $4::jsonb, revision = revision + 1, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $2 RETURNING *`,
          [id, revision, status, body]
        );
        if (!result.rowCount) {
          const current = await this.getBrowserTarget(id);
          if (!current) return null;
          throw new OptimisticConcurrencyError('browser target', id, revision, current);
        }
        const updated = catalogFromRow(result.rows[0], 'browserTarget');
        await this._appendSystemLog(client, { type: auditType, message: `Browser target "${updated.name || updated.id}" updated by ${changedBy}`, metadata: { targetId: updated.id, changedBy } });
        return updated;
      });
    },

    async listWorkTypes({ afterId = '', statuses = null, limit = 100 } = {}) {
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const allowed = statuses === null ? null : [...new Set(statuses.map(value => requiredString(value, 'status')))];
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('work_types')} WHERE id > $1 AND ($2::text[] IS NULL OR status = ANY($2::text[])) ORDER BY id LIMIT $3`,
        [String(afterId || ''), allowed, size + 1]
      );
      const rows = result.rows.slice(0, size);
      return { workTypes: rows.map(row => catalogFromRow(row, 'workType')), nextAfterId: result.rowCount > size ? rows[rows.length - 1].id : null };
    },

    async getWorkType(id) {
      const result = await this.pool.query(`SELECT * FROM ${this.table('work_types')} WHERE id = $1`, [requiredString(id, 'id')]);
      return result.rowCount ? catalogFromRow(result.rows[0], 'workType') : null;
    },

    async getLocalConnectorObject(id) {
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('local_connector_objects')} WHERE id = $1`,
        [requiredString(id, 'id')]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        id: row.id,
        workContextId: positiveSafeInteger(row.work_context_id, 'localConnectorObject.workContextId'),
        content: row.content,
        metadata: row.metadata || {},
        revision: positiveSafeInteger(row.revision, 'localConnectorObject.revision'),
        createdAt: timestamp(row.created_at, 'localConnectorObject.createdAt'),
        updatedAt: timestamp(row.updated_at, 'localConnectorObject.updatedAt')
      };
    },

    async createLocalConnectorObject({ object }) {
      const record = this.assertJsonRecord(object, 'local connector object');
      const result = await this.pool.query(
        `INSERT INTO ${this.table('local_connector_objects')} (id, work_context_id, content, metadata)
         VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
        [
          requiredString(record.id, 'object.id'),
          positiveSafeInteger(record.workContextId, 'object.workContextId'),
          String(record.content || ''),
          this.assertJsonRecord(record.metadata || {}, 'object.metadata')
        ]
      );
      return this.getLocalConnectorObject(result.rows[0].id);
    },

    async updateLocalConnectorObject({ objectId, expectedRevision, object }) {
      const id = requiredString(objectId, 'objectId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const record = this.assertJsonRecord(object, 'local connector object');
      const result = await this.pool.query(
        `UPDATE ${this.table('local_connector_objects')}
         SET work_context_id = $3, content = $4, metadata = $5::jsonb,
             revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND revision = $2 RETURNING id`,
        [
          id,
          revision,
          positiveSafeInteger(record.workContextId, 'object.workContextId'),
          String(record.content || ''),
          this.assertJsonRecord(record.metadata || {}, 'object.metadata')
        ]
      );
      if (!result.rowCount) {
        const current = await this.getLocalConnectorObject(id);
        if (!current) return null;
        throw new OptimisticConcurrencyError('local connector object', id, revision, current);
      }
      return this.getLocalConnectorObject(id);
    },

    async getOperation(operationId) {
      const id = positiveSafeInteger(operationId, 'operationId');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('operation_receipts')} WHERE id = $1`,
        [id]
      );
      if (!result.rowCount) return null;
      const row = result.rows[0];
      return {
        ...(row.receipt || {}),
        id: positiveSafeInteger(row.id, 'operation.id'),
        runId: positiveSafeInteger(row.run_id, 'operation.runId'),
        ticketId: positiveSafeInteger(row.ticket_id, 'operation.ticketId'),
        step: row.step_id,
        operation: row.operation,
        operationKey: row.idempotency_key,
        outcome: row.outcome,
        timestamp: timestamp(row.recorded_at, 'operation.timestamp'),
        targetId: row.target_id,
        targetKind: row.target_kind,
        targetPath: row.target_path,
        targetResourceId: row.target_resource_id
      };
    },

    async listOperations({ afterId = 0, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('operation_receipts')} WHERE id > $1 ORDER BY id LIMIT $2`,
        [cursor, size]
      );
      return result.rows.map(row => ({
        ...(row.receipt || {}),
        id: positiveSafeInteger(row.id, 'operation.id'),
        runId: positiveSafeInteger(row.run_id, 'operation.runId'),
        ticketId: positiveSafeInteger(row.ticket_id, 'operation.ticketId'),
        step: row.step_id,
        operation: row.operation,
        operationKey: row.idempotency_key,
        outcome: row.outcome,
        timestamp: timestamp(row.recorded_at, 'operation.timestamp'),
        targetId: row.target_id,
        targetKind: row.target_kind,
        targetPath: row.target_path,
        targetResourceId: row.target_resource_id
      }));
    },

    async listAllocationPlans({ afterId = 0, ticketId = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const ticket = optionalPositiveSafeInteger(ticketId, 'ticketId');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('allocation_plans')} WHERE id > $1 AND ($2::bigint IS NULL OR ticket_id = $2) ORDER BY id LIMIT $3`,
        [cursor, ticket, size + 1]
      );
      const rows = result.rows.slice(0, size);
      return { plans: rows.map(allocationPlanFromRow), nextAfterId: result.rowCount > size ? positiveSafeInteger(rows[rows.length - 1].id, 'nextAfterId') : null };
    },

    async getAllocationPlan(planId) {
      const id = positiveSafeInteger(planId, 'planId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('allocation_plans')} WHERE id = $1`, [id]);
      return result.rowCount ? allocationPlanFromRow(result.rows[0]) : null;
    },

    async getAllocationPlanForTicket(ticketId) {
      const id = positiveSafeInteger(ticketId, 'ticketId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('allocation_plans')} WHERE ticket_id = $1 ORDER BY id LIMIT 1`, [id]);
      return result.rowCount ? allocationPlanFromRow(result.rows[0]) : null;
    },

    async createAllocationPlan({ plan }) {
      const draft = this.assertJsonRecord(plan, 'plan');
      const ticketId = positiveSafeInteger(draft.ticketId, 'plan.ticketId');
      const status = requiredString(draft.status || 'pending', 'plan.status');
      const items = Array.isArray(draft.items) ? draft.items : [];
      if (!items.length) throw new TypeError('plan.items must be a non-empty array');
      return this.withTransaction(async client => {
        const clock = await client.query('SELECT clock_timestamp() AS ts');
        const now = timestamp(clock.rows[0].ts, 'allocation clock');
        const itemIds = await client.query(`SELECT nextval('${this.schemaSql}.allocation_item_id_seq') AS id FROM generate_series(1, $1)`, [items.length]);
        const allocatedItems = items.map((item, index) => ({ ...item, allocationItemId: positiveSafeInteger(itemIds.rows[index].id, 'allocationItemId'), status: item.status || 'pending', createdAt: item.createdAt || now }));
        const body = this.assertJsonRecord(documentBody({ ...draft, items: allocatedItems }, ['id', 'ticketId', 'status', 'revision', 'createdAt', 'updatedAt']), 'allocation plan body');
        const result = await client.query(
          `INSERT INTO ${this.table('allocation_plans')} (ticket_id, status, body, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING *`,
          [ticketId, status, body, draft.createdAt || now]
        );
        return allocationPlanFromRow(result.rows[0]);
      });
    },

    async updateAllocationItemStatus({ planId, allocationItemId, status }) {
      const id = positiveSafeInteger(planId, 'planId');
      const itemId = positiveSafeInteger(allocationItemId, 'allocationItemId');
      const nextStatus = requiredString(status, 'status');
      return this.withTransaction(async client => {
        const locked = await client.query(`SELECT * FROM ${this.table('allocation_plans')} WHERE id = $1 FOR UPDATE`, [id]);
        if (!locked.rowCount) return null;
        const plan = allocationPlanFromRow(locked.rows[0]);
        const items = Array.isArray(plan.items) ? plan.items.map(item => ({ ...item })) : [];
        const item = items.find(candidate => candidate.allocationItemId === itemId);
        if (!item) return null;
        item.status = nextStatus;
        const planStatus = items.some(candidate => candidate.status === 'failed') ? 'failed'
          : items.some(candidate => candidate.status === 'interrupted') ? 'interrupted'
            : items.every(candidate => candidate.status === 'completed') ? 'completed'
              : items.some(candidate => candidate.status === 'running') ? 'running' : 'pending';
        const body = this.assertJsonRecord(documentBody({ ...plan, items }, ['id', 'ticketId', 'status', 'revision', 'createdAt', 'updatedAt']), 'allocation plan body');
        const result = await client.query(
          `UPDATE ${this.table('allocation_plans')} SET status = $2, body = $3::jsonb, revision = revision + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
          [id, planStatus, body]
        );
        return { plan: allocationPlanFromRow(result.rows[0]), item };
      });
    },

    async _messagesForThreadIds(connection, threadIds) {
      if (!threadIds.length) return new Map();
      const result = await connection.query(`SELECT * FROM ${this.table('message_thread_messages')} WHERE thread_id = ANY($1::bigint[]) ORDER BY thread_id, message_id`, [threadIds]);
      const grouped = new Map(threadIds.map(id => [id, []]));
      for (const row of result.rows) grouped.get(positiveSafeInteger(row.thread_id, 'message.threadId')).push(messageFromRow(row));
      return grouped;
    },

    async listMessageThreads({ afterId = 0, statuses = null, workContextId = null, limit = 100 } = {}) {
      const cursor = nonNegativeSafeInteger(afterId, 'afterId');
      const size = positiveSafeInteger(limit, 'limit');
      if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const allowed = statuses === null ? null : [...new Set(statuses.map(value => requiredString(value, 'status')))];
      const contextId = optionalPositiveSafeInteger(workContextId, 'workContextId');
      const result = await this.pool.query(
        `SELECT * FROM ${this.table('message_threads')}
         WHERE id > $1 AND ($2::text[] IS NULL OR status = ANY($2::text[]))
           AND ($3::bigint IS NULL OR (body->>'workContextId')::bigint = $3)
         ORDER BY id LIMIT $4`,
        [cursor, allowed, contextId, size + 1]
      );
      const rows = result.rows.slice(0, size);
      const ids = rows.map(row => positiveSafeInteger(row.id, 'messageThread.id'));
      const messages = await this._messagesForThreadIds(this.pool, ids);
      return { threads: rows.map(row => threadFromRow(row, messages.get(positiveSafeInteger(row.id, 'messageThread.id')) || [])), nextAfterId: result.rowCount > size ? ids[ids.length - 1] : null };
    },

    async getMessageThread(threadId) {
      const id = positiveSafeInteger(threadId, 'threadId');
      const result = await this.pool.query(`SELECT * FROM ${this.table('message_threads')} WHERE id = $1`, [id]);
      if (!result.rowCount) return null;
      const messages = await this._messagesForThreadIds(this.pool, [id]);
      return threadFromRow(result.rows[0], messages.get(id) || []);
    },

    async getMessageThreadByKey(key) {
      const result = await this.pool.query(`SELECT * FROM ${this.table('message_threads')} WHERE thread_key = $1`, [requiredString(key, 'key')]);
      if (!result.rowCount) return null;
      const id = positiveSafeInteger(result.rows[0].id, 'messageThread.id');
      const messages = await this._messagesForThreadIds(this.pool, [id]);
      return threadFromRow(result.rows[0], messages.get(id) || []);
    },

    async createMessageThreadIfAbsent({ thread, initialMessage = null }) {
      const record = this.assertJsonRecord(thread, 'thread');
      const key = requiredString(record.key, 'thread.key');
      const ticketId = positiveSafeInteger(record.ticketId, 'thread.ticketId');
      const runId = optionalPositiveSafeInteger(record.runId, 'thread.runId');
      const kind = requiredString(record.kind, 'thread.kind');
      return this.withTransaction(async client => {
        const body = this.assertJsonRecord(documentBody(record, ['id', 'key', 'kind', 'ticketId', 'runId', 'status', 'revision', 'createdAt', 'updatedAt', 'closedAt', 'closedBy', 'messages']), 'message thread body');
        const result = await client.query(
          `INSERT INTO ${this.table('message_threads')} (thread_key, kind, ticket_id, run_id, status, body, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'open', $5::jsonb, COALESCE($6::timestamptz, clock_timestamp()), COALESCE($6::timestamptz, clock_timestamp()))
           ON CONFLICT (thread_key) DO NOTHING RETURNING *`,
          [key, kind, ticketId, runId, body, record.createdAt || null]
        );
        if (!result.rowCount) {
          const existing = await client.query(`SELECT * FROM ${this.table('message_threads')} WHERE thread_key = $1`, [key]);
          const id = positiveSafeInteger(existing.rows[0].id, 'messageThread.id');
          const messages = await this._messagesForThreadIds(client, [id]);
          return { thread: threadFromRow(existing.rows[0], messages.get(id) || []), created: false };
        }
        const row = result.rows[0];
        const id = positiveSafeInteger(row.id, 'messageThread.id');
        const messages = [];
        if (initialMessage) {
          const message = await this._appendMessageThreadMessage(client, id, initialMessage);
          messages.push(message);
        }
        return { thread: threadFromRow(row, messages), created: true };
      });
    },

    async _appendMessageThreadMessage(client, threadId, message) {
      const record = this.assertJsonRecord(message, 'message');
      const result = await client.query(
        `INSERT INTO ${this.table('message_thread_messages')} (thread_id, message_id, author, author_name, kind, body, created_at)
         SELECT $1, COALESCE(MAX(message_id), 0) + 1, $2, $3, $4, $5, COALESCE($6::timestamptz, clock_timestamp())
         FROM ${this.table('message_thread_messages')} WHERE thread_id = $1 RETURNING *`,
        [threadId, requiredString(record.author, 'message.author'), requiredString(record.authorName, 'message.authorName'), requiredString(record.kind, 'message.kind'), String(record.body || ''), record.createdAt || null]
      );
      return messageFromRow(result.rows[0]);
    },

    async appendMessageThreadMessage({ threadId, message }) {
      const id = positiveSafeInteger(threadId, 'threadId');
      return this.withTransaction(async client => {
        const locked = await client.query(`SELECT * FROM ${this.table('message_threads')} WHERE id = $1 FOR UPDATE`, [id]);
        if (!locked.rowCount) return null;
        const thread = threadFromRow(locked.rows[0]);
        if (thread.status !== 'open') {
          const error = new Error('Thread is already closed');
          error.code = 'MESSAGE_THREAD_CLOSED';
          throw error;
        }
        const storedMessage = await this._appendMessageThreadMessage(client, id, message);
        const updated = await client.query(`UPDATE ${this.table('message_threads')} SET revision = revision + 1, updated_at = $2 WHERE id = $1 RETURNING *`, [id, storedMessage.createdAt]);
        const allMessages = await this._messagesForThreadIds(client, [id]);
        return { thread: threadFromRow(updated.rows[0], allMessages.get(id) || []), message: storedMessage };
      });
    },

    async resolveMessageThread({ threadId, message, closedBy, closedAt = null }) {
      const id = positiveSafeInteger(threadId, 'threadId');
      const actor = requiredString(closedBy, 'closedBy');
      return this.withTransaction(async client => {
        const locked = await client.query(`SELECT * FROM ${this.table('message_threads')} WHERE id = $1 FOR UPDATE`, [id]);
        if (!locked.rowCount) return null;
        const current = threadFromRow(locked.rows[0]);
        if (current.status !== 'open') return { thread: current, changed: false };
        const storedMessage = message ? await this._appendMessageThreadMessage(client, id, message) : null;
        const at = closedAt || (storedMessage && storedMessage.createdAt) || new Date().toISOString();
        const updated = await client.query(
          `UPDATE ${this.table('message_threads')} SET status = 'closed', revision = revision + 1, updated_at = $2, closed_at = $2, closed_by = $3 WHERE id = $1 RETURNING *`,
          [id, at, actor]
        );
        const messages = await this._messagesForThreadIds(client, [id]);
        return { thread: threadFromRow(updated.rows[0], messages.get(id) || []), message: storedMessage, changed: true };
      });
    },

    async resolveMessageThreadByKey({ key, message, closedBy, closedAt = null }) {
      const found = await this.getMessageThreadByKey(key);
      return found ? this.resolveMessageThread({ threadId: found.id, message, closedBy, closedAt }) : null;
    },

    async getHttpSession(sid) {
      const result = await this.pool.query(`SELECT session FROM ${this.table('http_sessions')} WHERE sid = $1 AND expires_at > clock_timestamp()`, [requiredString(sid, 'sid')]);
      return result.rowCount ? result.rows[0].session : null;
    },

    async setHttpSession({ sid, session, expiresAt }) {
      const record = this.assertJsonRecord(session, 'session');
      await this.pool.query(
        `INSERT INTO ${this.table('http_sessions')} (sid, session, expires_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (sid) DO UPDATE SET session = EXCLUDED.session, expires_at = EXCLUDED.expires_at, updated_at = clock_timestamp()`,
        [requiredString(sid, 'sid'), record, timestamp(expiresAt, 'expiresAt')]
      );
    },

    async deleteHttpSession(sid) {
      await this.pool.query(`DELETE FROM ${this.table('http_sessions')} WHERE sid = $1`, [requiredString(sid, 'sid')]);
    },

    async touchHttpSession({ sid, expiresAt }) {
      await this.pool.query(`UPDATE ${this.table('http_sessions')} SET expires_at = $2, updated_at = clock_timestamp() WHERE sid = $1`, [requiredString(sid, 'sid'), timestamp(expiresAt, 'expiresAt')]);
    },

    async purgeExpiredHttpSessions({ limit = 1_000 } = {}) {
      const boundedLimit = positiveSafeInteger(limit, 'limit');
      if (boundedLimit > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
      const result = await this.pool.query(
        `DELETE FROM ${this.table('http_sessions')} AS session
         USING (
           SELECT sid FROM ${this.table('http_sessions')}
           WHERE expires_at <= clock_timestamp()
           ORDER BY expires_at, sid
           LIMIT $1
         ) AS expired
         WHERE session.sid = expired.sid`,
        [boundedLimit]
      );
      return result.rowCount;
    }
  };
}

function installApplicationStateMethods(PostgresRuntimeStore, dependencies) {
  Object.assign(PostgresRuntimeStore.prototype, methods(dependencies));
}

module.exports = { installApplicationStateMethods };
