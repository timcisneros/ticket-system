'use strict';

const { AccessCatalogReferenceError } = require('../access-catalog');
const { WorkflowCatalogReferenceError } = require('../workflow-catalog');

const TICKET_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const REQUIRED_TICKET_RUN_LIFECYCLE_REPOSITORY_METHODS = Object.freeze([
  'createTicketWithEvent',
  'transitionTicketState',
  'createRunsAndStartTicket',
  'transitionTicketAfterRun',
  'reopenTicket',
  'createRetryRun'
]);

class LifecycleConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LifecycleConflictError';
    this.code = 'LIFECYCLE_CONFLICT';
    Object.assign(this, details);
  }
}

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

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function assertTicketRunLifecycleRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('ticket/run lifecycle repository is required');
  }
  for (const method of REQUIRED_TICKET_RUN_LIFECYCLE_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`ticket/run lifecycle repository must implement ${method}()`);
    }
  }
  return repository;
}

class JsonTicketRunLifecycleRepository {
  constructor({
    readTickets,
    writeTickets,
    readGroups,
    readWorkflows = null,
    queueWorkflowMutation = null,
    readRuns,
    writeRuns,
    appendEvent,
    sanitizePayload = value => value,
    now = () => new Date()
  } = {}) {
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.writeTickets = requiredFunction(writeTickets, 'writeTickets');
    this.readGroups = requiredFunction(readGroups, 'readGroups');
    this.readWorkflows = readWorkflows === null ? null : requiredFunction(readWorkflows, 'readWorkflows');
    this.queueWorkflowMutation = queueWorkflowMutation === null ? operation => operation() : requiredFunction(queueWorkflowMutation, 'queueWorkflowMutation');
    this.readRuns = requiredFunction(readRuns, 'readRuns');
    this.writeRuns = requiredFunction(writeRuns, 'writeRuns');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.sanitizePayload = requiredFunction(sanitizePayload, 'sanitizePayload');
    this.now = requiredFunction(now, 'now');
  }

  _payload(value, label) {
    return jsonObject(this.sanitizePayload(jsonObject(value || {}, label)), label);
  }

  _nextId(records) {
    return records.reduce((maximum, record) => Math.max(maximum, Number(record.id) || 0), 0) + 1;
  }

  _clock() {
    return timestamp(this.now(), 'now');
  }

  _assertTicketAssignmentTarget(ticket) {
    if (!ticket || ticket.assignmentTargetType !== 'group') return;
    const groupId = positiveSafeInteger(ticket.assignmentTargetId, 'ticket.assignmentTargetId');
    const group = this.readGroups().find(item => Number(item && item.id) === groupId) || null;
    if (!group) throw new AccessCatalogReferenceError(`Selected group does not exist: `, 'GROUP_NOT_FOUND');
    if (group.canReceiveTickets !== true) {
      throw new AccessCatalogReferenceError(`Selected group cannot receive tickets: `, 'GROUP_NOT_TICKET_CAPABLE');
    }
  }

  _assertTicketWorkflow(ticket) {
    if (!ticket || ticket.executionMode !== 'workflow') return;
    if (!this.readWorkflows) throw new TypeError('readWorkflows is required for workflow tickets');
    const workflowId = String(ticket.workflowId || '').trim();
    if (!workflowId) throw new WorkflowCatalogReferenceError('ticket.workflowId is required', 'WORKFLOW_NOT_FOUND');
    const workflow = this.readWorkflows().find(item => item && item.id === workflowId) || null;
    if (!workflow) throw new WorkflowCatalogReferenceError("Selected workflow does not exist: " + workflowId, "WORKFLOW_NOT_FOUND");
    if (workflow.enabled === false) throw new WorkflowCatalogReferenceError("Selected workflow is disabled: " + workflowId, "WORKFLOW_DISABLED");
  }

  _ticketEventPayload(ticket, previousStatus, callerPayload = {}) {
    const payload = this._payload(callerPayload, 'ticket event payload');
    return {
      ...payload,
      previousStatus,
      status: ticket.status,
      updatedAt: ticket.updatedAt,
      ...(Object.prototype.hasOwnProperty.call(payload, 'changedAt') && ticket.changedAt
        ? { changedAt: ticket.changedAt }
        : {})
    };
  }

  _normalizeRunDraft(draft, index) {
    const run = this._payload(draft, `runDrafts[${index}]`);
    positiveSafeInteger(run.ticketId, `runDrafts[${index}].ticketId`);
    positiveSafeInteger(run.agentId, `runDrafts[${index}].agentId`);
    if (run.status !== undefined && run.status !== 'pending') {
      throw new TypeError('New runs must start pending');
    }
    return run;
  }

  _assertNoActiveAgentRuns(runs, ticketId, runDrafts) {
    const agentIds = new Set(runDrafts.map(run => run.agentId));
    const conflict = runs.find(run => run.ticketId === ticketId && agentIds.has(run.agentId) &&
      ['pending', 'running'].includes(run.status));
    if (conflict) {
      throw new LifecycleConflictError(
        `Ticket ${ticketId} already has an active run for agent ${conflict.agentId}`,
        { ticketId, runId: conflict.id, agentId: conflict.agentId }
      );
    }
  }

  _assertTerminalPredecessor(runs, ticketId, predecessorRunId, runDrafts) {
    if (predecessorRunId === undefined || predecessorRunId === null) return null;
    const id = positiveSafeInteger(predecessorRunId, 'afterTerminalRunId');
    if (runDrafts.length !== 1) {
      throw new TypeError('A terminal predecessor can authorize exactly one new run');
    }
    const predecessor = runs.find(run => run.id === id) || null;
    if (!predecessor || predecessor.ticketId !== ticketId ||
        predecessor.agentId !== runDrafts[0].agentId || !TERMINAL_RUN_STATUSES.has(predecessor.status)) {
      throw new LifecycleConflictError(`Run ${id} is not a terminal predecessor for the requested retry`, {
        ticketId,
        runId: id
      });
    }
    return predecessor;
  }

  createTicketWithEvent(options) {
    const ticket = options && options.ticket;
    return ticket && ticket.executionMode === 'workflow'
      ? this.queueWorkflowMutation(() => this._createTicketWithEvent(options))
      : this._createTicketWithEvent(options);
  }

  async _createTicketWithEvent({ ticket, eventPayload = {} }) {
    const body = this._payload(ticket, 'ticket');
    const status = String(body.status || 'open');
    if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket status: ${status}`);
    this._assertTicketAssignmentTarget(body);
    this._assertTicketWorkflow(body);
    const tickets = this.readTickets();
    if (typeof body.spawnIdempotencyKey === 'string' && body.spawnIdempotencyKey.trim()) {
      body.spawnIdempotencyKey = body.spawnIdempotencyKey.trim();
      const existing = tickets.find(item => item.spawnIdempotencyKey === body.spawnIdempotencyKey);
      if (existing) return { ticket: existing, event: null, created: false };
    }
    const now = this._clock();
    const created = {
      ...body,
      id: this._nextId(tickets),
      status,
      createdAt: now,
      updatedAt: now,
      changedAt: body.changedAt ? now : body.changedAt
    };
    tickets.push(created);
    this.writeTickets(tickets);
    let event;
    try {
      event = await this.appendEvent({
        type: 'ticket.created',
        ticketId: created.id,
        payload: {
          ...this._payload(eventPayload, 'ticket event payload'),
          status: created.status,
          createdAt: created.createdAt
        }
      });
    } catch (error) {
      error.lifecycleTicket = created;
      throw error;
    }
    return { ticket: created, event, created: true };
  }

  async transitionTicketState({
    ticketId,
    fromStatuses,
    toStatus,
    patch = {},
    eventType = 'ticket.updated',
    eventPayload = {}
  }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
      throw new TypeError('fromStatuses must be a non-empty array');
    }
    const sources = [...new Set(fromStatuses.map(status => String(status)))];
    if (sources.some(status => !TICKET_STATUSES.has(status))) throw new TypeError('Unsupported ticket source status');
    const target = String(toStatus || '');
    if (!TICKET_STATUSES.has(target)) throw new TypeError(`Unsupported ticket status: ${target}`);
    const bodyPatch = this._payload(patch, 'ticket patch');
    const tickets = this.readTickets();
    const ticket = tickets.find(item => item.id === id) || null;
    if (!ticket) throw new LifecycleConflictError(`Ticket ${id} was not found`, { ticketId: id });
    if (!sources.includes(ticket.status)) {
      throw new LifecycleConflictError(
        `Ticket ${id} is ${ticket.status}; expected ${sources.join(' or ')}`,
        { ticketId: id }
      );
    }
    const previousStatus = ticket.status;
    const now = this._clock();
    Object.assign(ticket, bodyPatch);
    ticket.status = target;
    ticket.updatedAt = now;
    if (Object.prototype.hasOwnProperty.call(bodyPatch, 'changedAt')) ticket.changedAt = now;
    if (bodyPatch.rerunMode === null) delete ticket.rerunMode;
    this.writeTickets(tickets);
    const event = await this.appendEvent({
      type: String(eventType || 'ticket.updated'),
      ticketId: id,
      payload: this._ticketEventPayload(ticket, previousStatus, eventPayload)
    });
    return { ticket, event, previousStatus };
  }

  async createRunsAndStartTicket({
    ticketId,
    runDrafts,
    afterTerminalRunId = null,
    runEventPayload = () => ({}),
    ticketEventPayload = {}
  }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(runDrafts) || runDrafts.length === 0) {
      throw new TypeError('runDrafts must be a non-empty array');
    }
    if (typeof runEventPayload !== 'function') throw new TypeError('runEventPayload must be a function');
    const drafts = runDrafts.map((draft, index) => this._normalizeRunDraft(draft, index));
    if (drafts.some(run => run.ticketId !== id)) throw new TypeError('Every run draft must belong to ticketId');

    // All state writes happen synchronously before the first journal await. This
    // prevents unrelated ticket creations from overwriting one another in the
    // active single-writer JSON stage, but it is not a filesystem transaction.
    const tickets = this.readTickets();
    const ticket = tickets.find(item => item.id === id) || null;
    if (!ticket) throw new LifecycleConflictError(`Ticket ${id} was not found`, { ticketId: id });
    if (ticket.status !== 'open') {
      throw new LifecycleConflictError(`Ticket ${id} is ${ticket.status}; expected open`, { ticketId: id });
    }
    const runs = this.readRuns();
    this._assertNoActiveAgentRuns(runs, id, drafts);
    this._assertTerminalPredecessor(runs, id, afterTerminalRunId, drafts);
    const now = this._clock();
    let nextRunId = this._nextId(runs);
    const createdRuns = drafts.map(draft => ({
      ...draft,
      id: nextRunId++,
      status: 'pending',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      ticketOpenedAt: ticket.updatedAt,
      createdAt: now,
      updatedAt: now
    }));
    runs.push(...createdRuns);
    this.writeRuns(runs);

    const previousStatus = ticket.status;
    ticket.status = 'in_progress';
    ticket.updatedAt = now;
    this.writeTickets(tickets);

    const events = [];
    try {
      for (const run of createdRuns) {
        events.push(await this.appendEvent({
          type: 'run.created',
          ticketId: id,
          runId: run.id,
          payload: {
            ...this._payload(runEventPayload(run), `run ${run.id} event payload`),
            status: run.status,
            createdAt: run.createdAt
          }
        }));
      }
      events.push(await this.appendEvent({
        type: 'ticket.updated',
        ticketId: id,
        payload: this._ticketEventPayload(ticket, previousStatus, ticketEventPayload)
      }));
    } catch (error) {
      error.lifecycleTicket = ticket;
      error.lifecycleRuns = createdRuns;
      throw error;
    }
    return { ticket, runs: createdRuns, events, previousStatus };
  }

  async transitionTicketAfterRun({ runId }) {
    const id = positiveSafeInteger(runId, 'runId');
    const runs = this.readRuns();
    const run = runs.find(item => item.id === id) || null;
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new LifecycleConflictError(`Run ${id} is not terminal`, { runId: id });
    }
    const tickets = this.readTickets();
    const ticket = tickets.find(item => item.id === run.ticketId) || null;
    if (!ticket) throw new LifecycleConflictError(`Ticket ${run.ticketId} was not found`, { ticketId: run.ticketId });

    let targetStatus = null;
    const currentBatchRuns = runs.filter(item => item.ticketId === run.ticketId && item.ticketOpenedAt === run.ticketOpenedAt);
    if (run.status === 'interrupted') {
      if (ticket.status === 'in_progress' && !currentBatchRuns.some(item => ['pending', 'running'].includes(item.status))) {
        targetStatus = 'open';
      }
    } else if (ticket.assignmentTargetType !== 'group' ||
        !['allocated', 'dynamic'].includes(ticket.assignmentMode)) {
      targetStatus = run.status;
    } else if (run.status === 'failed' || currentBatchRuns.some(item => item.status === 'failed')) {
      targetStatus = 'failed';
    } else if (currentBatchRuns.length > 0 && currentBatchRuns.every(item => item.status === 'completed')) {
      targetStatus = 'completed';
    }

    if (!targetStatus || ticket.status === targetStatus) {
      return { ticket, event: null, previousStatus: ticket.status, changed: false };
    }
    const previousStatus = ticket.status;
    ticket.status = targetStatus;
    ticket.updatedAt = this._clock();
    if (['completed', 'failed', 'interrupted'].includes(targetStatus)) delete ticket.rerunMode;
    this.writeTickets(tickets);
    const event = await this.appendEvent({
      type: 'ticket.updated',
      ticketId: ticket.id,
      payload: this._ticketEventPayload(ticket, previousStatus)
    });
    return { ticket, event, previousStatus, changed: true };
  }

  async reopenTicket({ ticketId, rerunMode = null }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const tickets = this.readTickets();
    const ticket = tickets.find(item => item.id === id) || null;
    if (!ticket) return null;
    if (ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt) {
      throw new LifecycleConflictError(
        'Cannot rerun: unresolved ticket-level triage exists on this ticket. Resolve triage first.',
        { ticketId: id }
      );
    }
    const previousStatus = ticket.status;
    ticket.status = 'open';
    ticket.updatedAt = this._clock();
    if (rerunMode) ticket.rerunMode = String(rerunMode);
    else delete ticket.rerunMode;
    this.writeTickets(tickets);
    const event = await this.appendEvent({
      type: 'ticket.updated',
      ticketId: id,
      payload: this._ticketEventPayload(ticket, previousStatus)
    });
    return { ticket, event, previousStatus };
  }

  async createRetryRun({ ticketId, predecessorRunId, runDraft, runEventPayload = () => ({}) }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const predecessorId = positiveSafeInteger(predecessorRunId, 'predecessorRunId');
    const draft = this._normalizeRunDraft(runDraft, 0);
    if (draft.ticketId !== id) throw new TypeError('runDraft must belong to ticketId');
    this._assertTerminalPredecessor(this.readRuns(), id, predecessorId, [draft]);
    const reopened = await this.reopenTicket({ ticketId: id, rerunMode: 'auto_retry' });
    if (!reopened) return null;
    try {
      return await this.createRunsAndStartTicket({
        ticketId: id,
        runDrafts: [{ ...draft, rerunMode: 'auto_retry' }],
        afterTerminalRunId: predecessorId,
        runEventPayload,
        ticketEventPayload: { rerunMode: 'auto_retry', predecessorRunId: predecessorId }
      });
    } catch (error) {
      // The active JSON stage cannot roll the reopen event back. Startup and
      // operator recovery can safely see the honestly open ticket; PostgreSQL
      // implements this same method as one transaction.
      throw error;
    }
  }
}

module.exports = {
  JsonTicketRunLifecycleRepository,
  LifecycleConflictError,
  REQUIRED_TICKET_RUN_LIFECYCLE_REPOSITORY_METHODS,
  assertTicketRunLifecycleRepository
};
