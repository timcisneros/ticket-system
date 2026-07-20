'use strict';

const {
  WATCHER_OBSERVATION_STATUSES,
  WATCHER_PROPOSAL_STATUSES,
  WATCHER_STATUSES,
  WatcherConflictError,
  WatcherIdConflictError,
  WatcherReferenceError,
  WatcherStateConflictError,
  enumList,
  nonNegativeSafeInteger,
  normalizeWatcherObservationRecord,
  normalizeWatcherObservationValue,
  normalizeWatcherProposalRecord,
  normalizeWatcherProposalValue,
  normalizeWatcherRecord,
  normalizeWatcherValue,
  nullablePositiveSafeInteger,
  positiveSafeInteger,
  requiredFunction,
  requiredString,
  sameSourceRefs,
  timestamp
} = require('../watcher-authority');

class JsonWatcherAuthorityRepository {
  constructor({
    readWatchers,
    writeWatchers,
    readObservations,
    writeObservations,
    readProposals,
    writeProposals,
    readWorkContexts,
    readTickets,
    appendEvent,
    appendSystemLog,
    queueMutation = null,
    now = () => new Date(),
    maxQueryRows = 1_000
  } = {}) {
    this.readWatchers = requiredFunction(readWatchers, 'readWatchers');
    this.writeWatchers = requiredFunction(writeWatchers, 'writeWatchers');
    this.readObservations = requiredFunction(readObservations, 'readObservations');
    this.writeObservations = requiredFunction(writeObservations, 'writeObservations');
    this.readProposals = requiredFunction(readProposals, 'readProposals');
    this.writeProposals = requiredFunction(writeProposals, 'writeProposals');
    this.readWorkContexts = requiredFunction(readWorkContexts, 'readWorkContexts');
    this.readTickets = requiredFunction(readTickets, 'readTickets');
    this.appendEvent = requiredFunction(appendEvent, 'appendEvent');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.mutationTail = Promise.resolve();
    this.queueMutation = queueMutation === null
      ? operation => {
          const result = this.mutationTail.then(operation, operation);
          this.mutationTail = result.then(() => undefined, () => undefined);
          return result;
        }
      : requiredFunction(queueMutation, 'queueMutation');
  }

  _limit(value, label = 'limit') {
    const size = positiveSafeInteger(value, label);
    if (size > this.maxQueryRows) throw new RangeError(`${label} exceeds the configured maximum of ${this.maxQueryRows}`);
    return size;
  }

  _raw(reader, label) {
    const records = reader();
    if (!Array.isArray(records)) throw new TypeError(`${label} must be an array`);
    return structuredClone(records);
  }

  _rawWatchers() { return this._raw(this.readWatchers, 'watcher catalog'); }
  _rawObservations() { return this._raw(this.readObservations, 'watcher observation store'); }
  _rawProposals() { return this._raw(this.readProposals, 'watcher proposal store'); }

  _contexts() {
    const records = this._raw(this.readWorkContexts, 'Work Context catalog');
    return new Map(records.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0).map(item => [item.id, item]));
  }

  _tickets() {
    const records = this._raw(this.readTickets, 'ticket store');
    return new Map(records.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0).map(item => [item.id, item]));
  }

  _watchers() {
    const contexts = this._contexts();
    const records = this._rawWatchers().map(normalizeWatcherRecord);
    const seen = new Set();
    for (const watcher of records) {
      if (seen.has(watcher.id)) throw new WatcherIdConflictError('watcher', watcher.id);
      seen.add(watcher.id);
      if (!contexts.has(watcher.workContextId)) {
        throw new WatcherReferenceError(`Watcher ${watcher.id} references missing Work Context ${watcher.workContextId}`, 'WORK_CONTEXT_NOT_FOUND');
      }
    }
    return records;
  }

  _observations(watchers = null) {
    const watcherRecords = watchers || this._watchers();
    const watcherContexts = new Map(watcherRecords.map(item => [item.id, item.workContextId]));
    const records = this._rawObservations().map(normalizeWatcherObservationRecord);
    const seen = new Set();
    for (const observation of records) {
      if (seen.has(observation.id)) throw new WatcherIdConflictError('watcher observation', observation.id);
      seen.add(observation.id);
      const workContextId = watcherContexts.get(observation.watcherId);
      if (workContextId === undefined) {
        throw new WatcherReferenceError(`Watcher observation ${observation.id} references missing watcher ${observation.watcherId}`, 'WATCHER_NOT_FOUND');
      }
      if (workContextId !== observation.workContextId) {
        throw new WatcherReferenceError(`Watcher observation ${observation.id} Work Context does not match watcher`, 'WATCHER_WORK_CONTEXT_MISMATCH');
      }
      const watcher = watcherRecords.find(item => item.id === observation.watcherId);
      if (observation.sourceKind !== watcher.sourceKind || !sameSourceRefs(observation.sourceRefs, watcher.sourceRefs)) {
        throw new WatcherReferenceError(`Watcher observation ${observation.id} source does not match watcher`, 'WATCHER_OBSERVATION_SOURCE_MISMATCH');
      }
    }
    return records;
  }

  _proposals(watchers = null, observations = null) {
    const watcherRecords = watchers || this._watchers();
    const observationRecords = observations || this._observations(watcherRecords);
    const watcherContexts = new Map(watcherRecords.map(item => [item.id, item.workContextId]));
    const observationOwners = new Map(observationRecords.map(item => [item.id, item]));
    const tickets = this._tickets();
    const records = this._rawProposals().map(normalizeWatcherProposalRecord);
    const seen = new Set();
    for (const proposal of records) {
      if (seen.has(proposal.id)) throw new WatcherIdConflictError('watcher proposal', proposal.id);
      seen.add(proposal.id);
      const workContextId = watcherContexts.get(proposal.watcherId);
      if (workContextId === undefined) {
        throw new WatcherReferenceError(`Watcher proposal ${proposal.id} references missing watcher ${proposal.watcherId}`, 'WATCHER_NOT_FOUND');
      }
      if (workContextId !== proposal.workContextId) {
        throw new WatcherReferenceError(`Watcher proposal ${proposal.id} Work Context does not match watcher`, 'WATCHER_WORK_CONTEXT_MISMATCH');
      }
      const watcher = watcherRecords.find(item => item.id === proposal.watcherId);
      if (!sameSourceRefs(proposal.sourceRefs, watcher.sourceRefs)) {
        throw new WatcherReferenceError(`Watcher proposal ${proposal.id} source does not match watcher`, 'WATCHER_PROPOSAL_SOURCE_MISMATCH');
      }
      if (proposal.observationId !== null) {
        const observation = observationOwners.get(proposal.observationId) || null;
        if (!observation || observation.watcherId !== proposal.watcherId || observation.workContextId !== proposal.workContextId) {
          throw new WatcherReferenceError(`Watcher proposal ${proposal.id} references an observation outside its watcher`, 'WATCHER_OBSERVATION_MISMATCH');
        }
      }
      if (proposal.createdTicketId !== null) {
        const ticket = tickets.get(proposal.createdTicketId) || null;
        const source = ticket && ticket.source;
        if (!ticket || !source || source.type !== 'watcher_proposal' || source.proposalId !== proposal.id ||
            source.watcherId !== proposal.watcherId || source.workContextId !== proposal.workContextId) {
          throw new WatcherReferenceError(`Watcher proposal ${proposal.id} ticket provenance is invalid`, 'WATCHER_TICKET_PROVENANCE_MISMATCH');
        }
      }
    }
    const proposalsById = new Map(records.map(item => [item.id, item]));
    for (const ticket of tickets.values()) {
      const source = ticket && ticket.source;
      if (!source || source.type !== 'watcher_proposal') continue;
      const proposal = proposalsById.get(source.proposalId) || null;
      if (!proposal || proposal.status !== 'approved' || proposal.createdTicketId !== ticket.id ||
          source.watcherId !== proposal.watcherId || source.workContextId !== proposal.workContextId ||
          source.observationId !== proposal.observationId) {
        throw new WatcherReferenceError(`Ticket ${ticket.id} watcher proposal provenance is invalid`, 'WATCHER_TICKET_PROVENANCE_MISMATCH');
      }
    }
    return records;
  }

  _assertContext(workContextId, { requireActive = false } = {}) {
    const context = this._contexts().get(workContextId) || null;
    if (!context) throw new WatcherReferenceError(`Work Context not found: ${workContextId}`, 'WORK_CONTEXT_NOT_FOUND');
    if (requireActive && context.status !== 'active') {
      throw new WatcherReferenceError('An active watcher requires an active Work Context', 'WORK_CONTEXT_NOT_ACTIVE');
    }
    return context;
  }

  async _audit(audit, metadata) {
    if (!audit) return null;
    return this.appendSystemLog({ ...audit, metadata: { ...(audit.metadata || {}), ...metadata } });
  }

  async listWatchers({ afterId = 0, statuses = null, workContextId = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const allowed = enumList(statuses, WATCHER_STATUSES, 'statuses');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const size = this._limit(limit);
    const matches = this._watchers()
      .filter(item => item.id > cursor)
      .filter(item => !allowed || allowed.includes(item.status))
      .filter(item => contextId === null || item.workContextId === contextId)
      .sort((left, right) => left.id - right.id)
      .slice(0, size + 1);
    const watchers = matches.slice(0, size);
    return { watchers, nextAfterId: matches.length > size && watchers.length ? watchers[watchers.length - 1].id : null };
  }

  async getWatcherById(watcherId) {
    const id = positiveSafeInteger(watcherId, 'watcherId');
    return this._watchers().find(item => item.id === id) || null;
  }

  async getWatcherOperationalSummary({ limit = 10 } = {}) {
    const size = this._limit(limit);
    const watchers = this._watchers();
    const observations = this._observations(watchers).sort((left, right) => right.id - left.id);
    const counts = { active: 0, paused: 0, archived: 0, total: watchers.length };
    for (const watcher of watchers) counts[watcher.status] += 1;
    const failures = observations.filter(item => item.status === 'failed' || item.status === 'refused');
    return { ...counts, recentFailures: failures.slice(0, size), hasFailures: failures.length > 0 };
  }

  async listWatcherObservations({ watcherId = null, beforeId = null, statuses = null, limit = 20 } = {}) {
    const ownerId = nullablePositiveSafeInteger(watcherId, 'watcherId');
    const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
    const allowed = enumList(statuses, WATCHER_OBSERVATION_STATUSES, 'statuses');
    const size = this._limit(limit);
    const matches = this._observations()
      .filter(item => ownerId === null || item.watcherId === ownerId)
      .filter(item => before === null || item.id < before)
      .filter(item => !allowed || allowed.includes(item.status))
      .sort((left, right) => right.id - left.id)
      .slice(0, size + 1);
    const observations = matches.slice(0, size);
    return { observations, nextBeforeId: matches.length > size && observations.length ? observations[observations.length - 1].id : null };
  }

  async listWatcherProposals({ watcherId = null, beforeId = null, statuses = null, limit = 20 } = {}) {
    const ownerId = nullablePositiveSafeInteger(watcherId, 'watcherId');
    const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
    const allowed = enumList(statuses, WATCHER_PROPOSAL_STATUSES, 'statuses');
    const size = this._limit(limit);
    const matches = this._proposals()
      .filter(item => ownerId === null || item.watcherId === ownerId)
      .filter(item => before === null || item.id < before)
      .filter(item => !allowed || allowed.includes(item.status))
      .sort((left, right) => right.id - left.id)
      .slice(0, size + 1);
    const proposals = matches.slice(0, size);
    return { proposals, nextBeforeId: matches.length > size && proposals.length ? proposals[proposals.length - 1].id : null };
  }

  async getWatcherProposalById(proposalId) {
    const id = positiveSafeInteger(proposalId, 'proposalId');
    return this._proposals().find(item => item.id === id) || null;
  }

  createWatcher({ value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const body = normalizeWatcherValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertContext(body.workContextId, { requireActive: body.status === 'active' });
      const rollback = this._rawWatchers();
      const watchers = this._watchers();
      const at = timestamp(this.now(), 'now');
      const watcher = {
        id: watchers.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        lastObservedAt: null,
        lastObservationHash: null,
        revision: 1,
        createdBy: actor,
        createdAt: at,
        updatedBy: actor,
        updatedAt: at
      };
      try {
        this.writeWatchers([...watchers, watcher].sort((left, right) => left.id - right.id));
        const auditLog = await this._audit(audit, { watcherId: watcher.id, workContextId: watcher.workContextId });
        return { watcher: structuredClone(watcher), auditLog };
      } catch (error) {
        try { this.writeWatchers(rollback); } catch (_) {}
        throw error;
      }
    });
  }

  updateWatcher({ watcherId, expectedRevision, value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      const body = normalizeWatcherValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      this._assertContext(body.workContextId, { requireActive: body.status === 'active' });
      const rollback = this._rawWatchers();
      const watchers = this._watchers();
      const index = watchers.findIndex(item => item.id === id);
      if (index === -1) return null;
      const current = watchers[index];
      if (current.revision !== revision) throw new WatcherConflictError('watcher', id, revision, structuredClone(current));
      const watcher = {
        id,
        ...body,
        lastObservedAt: current.lastObservedAt,
        lastObservationHash: current.lastObservationHash,
        revision: revision + 1,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedBy: actor,
        updatedAt: timestamp(this.now(), 'now')
      };
      watchers[index] = watcher;
      try {
        this.writeWatchers(watchers);
        const auditLog = await this._audit(audit, { watcherId: id, workContextId: watcher.workContextId });
        return { watcher: structuredClone(watcher), auditLog };
      } catch (error) {
        try { this.writeWatchers(rollback); } catch (_) {}
        throw error;
      }
    });
  }

  recordWatcherObservation({ watcherId, expectedRevision, value, changedBy, advanceCursor, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
      if (typeof advanceCursor !== 'boolean') throw new TypeError('advanceCursor must be boolean');
      const body = normalizeWatcherObservationValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      const rollback = { watchers: this._rawWatchers(), observations: this._rawObservations() };
      const watchers = this._watchers();
      const index = watchers.findIndex(item => item.id === id);
      if (index === -1) return null;
      const watcher = watchers[index];
      if (watcher.revision !== revision) throw new WatcherConflictError('watcher', id, revision, structuredClone(watcher));
      if (body.watcherId !== id || body.workContextId !== watcher.workContextId || body.sourceKind !== watcher.sourceKind ||
          !sameSourceRefs(body.sourceRefs, watcher.sourceRefs)) {
        throw new WatcherReferenceError('Observation authority does not match watcher', 'WATCHER_OBSERVATION_MISMATCH');
      }
      const observations = this._observations(watchers);
      const at = timestamp(this.now(), 'now');
      const observation = {
        id: observations.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        observedAt: at
      };
      observations.push(observation);
      if (advanceCursor) {
        watcher.lastObservedAt = at;
        watcher.lastObservationHash = body.currentHash === null ? body.previousHash : body.currentHash;
        watcher.revision += 1;
        watcher.updatedBy = actor;
        watcher.updatedAt = at;
      }
      try {
        this.writeObservations(observations);
        if (advanceCursor) this.writeWatchers(watchers);
        const auditLog = await this._audit(audit, { watcherId: id, observationId: observation.id, status: observation.status });
        return { observation: structuredClone(observation), watcher: structuredClone(watcher), auditLog };
      } catch (error) {
        try { this.writeObservations(rollback.observations); } catch (_) {}
        if (advanceCursor) try { this.writeWatchers(rollback.watchers); } catch (_) {}
        throw error;
      }
    });
  }

  createWatcherProposal({ watcherId, value, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(watcherId, 'watcherId');
      const body = normalizeWatcherProposalValue(value);
      const actor = requiredString(changedBy, 'changedBy');
      const watchers = this._watchers();
      const watcher = watchers.find(item => item.id === id) || null;
      if (!watcher) return null;
      if (body.watcherId !== id || body.workContextId !== watcher.workContextId ||
          !sameSourceRefs(body.sourceRefs, watcher.sourceRefs)) {
        throw new WatcherReferenceError('Proposal authority does not match watcher', 'WATCHER_PROPOSAL_MISMATCH');
      }
      const context = this._assertContext(watcher.workContextId);
      if (context.status !== 'active') throw new WatcherStateConflictError('Work Context is not active; proposals are blocked', 'WORK_CONTEXT_NOT_ACTIVE');
      const observations = this._observations(watchers);
      if (body.observationId !== null) {
        const observation = observations.find(item => item.id === body.observationId) || null;
        if (!observation || observation.watcherId !== id) {
          throw new WatcherReferenceError('Proposal observation does not belong to watcher', 'WATCHER_OBSERVATION_MISMATCH');
        }
      }
      const rollback = this._rawProposals();
      const proposals = this._proposals(watchers, observations);
      const at = timestamp(this.now(), 'now');
      const proposal = {
        id: proposals.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        ...body,
        status: 'proposed',
        createdTicketId: null,
        approvedAt: null,
        rejectedAt: null,
        revision: 1,
        createdBy: actor,
        createdAt: at,
        updatedBy: actor,
        updatedAt: at
      };
      try {
        this.writeProposals([...proposals, proposal].sort((left, right) => left.id - right.id));
        const auditLog = await this._audit(audit, { watcherId: id, proposalId: proposal.id, workContextId: watcher.workContextId });
        return { proposal: structuredClone(proposal), auditLog };
      } catch (error) {
        try { this.writeProposals(rollback); } catch (_) {}
        throw error;
      }
    });
  }

  approveWatcherProposal({ proposalId, changedBy, createTicket }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(proposalId, 'proposalId');
      const actor = requiredString(changedBy, 'changedBy');
      const create = requiredFunction(createTicket, 'createTicket');
      const rollback = this._rawProposals();
      const proposals = this._proposals();
      const index = proposals.findIndex(item => item.id === id);
      if (index === -1) return null;
      const proposal = proposals[index];
      if (proposal.status !== 'proposed') throw new WatcherStateConflictError('Only a proposed proposal can be approved', 'WATCHER_PROPOSAL_NOT_PROPOSED', proposal);
      const context = this._assertContext(proposal.workContextId);
      if (context.status !== 'active') throw new WatcherStateConflictError('Work Context is not active; proposal approval is blocked', 'WORK_CONTEXT_NOT_ACTIVE', proposal);
      const at = timestamp(this.now(), 'now');
      const source = {
        type: 'watcher_proposal',
        watcherId: proposal.watcherId,
        workContextId: proposal.workContextId,
        observationId: proposal.observationId,
        proposalId: proposal.id,
        fromActor: actor,
        sourceRefs: proposal.sourceRefs,
        evidenceRefs: proposal.evidenceRefs,
        constraints: proposal.constraints,
        authorityLimits: proposal.authorityLimits,
        stopCondition: proposal.stopCondition,
        receiptExpectation: proposal.receiptExpectation,
        createdAt: at,
        createdBy: actor,
        status: 'created'
      };
      const ticketResult = await create({ proposal: structuredClone(proposal), source });
      if (!ticketResult || ticketResult.ok !== true || !ticketResult.ticket) return ticketResult || { ok: false, error: 'Ticket creation failed' };
      const ticket = ticketResult.ticket;
      if (!ticket.source || ticket.source.type !== 'watcher_proposal' || ticket.source.proposalId !== id ||
          ticket.source.watcherId !== proposal.watcherId || ticket.source.workContextId !== proposal.workContextId ||
          ticket.source.observationId !== proposal.observationId) {
        throw new WatcherReferenceError('Approved ticket provenance does not match proposal', 'WATCHER_TICKET_PROVENANCE_MISMATCH');
      }
      proposal.status = 'approved';
      proposal.createdTicketId = positiveSafeInteger(ticket.id, 'ticket.id');
      proposal.approvedAt = at;
      proposal.rejectedAt = null;
      proposal.revision += 1;
      proposal.updatedBy = actor;
      proposal.updatedAt = at;
      try {
        this.writeProposals(proposals);
        const event = await this.appendEvent({
          type: 'watcher.proposal_approved',
          ticketId: ticket.id,
          payload: { watcherId: proposal.watcherId, proposalId: id, createdTicketId: ticket.id, createdBy: actor }
        });
        const auditLog = await this._audit({
          type: 'watcher:proposal_approved',
          message: `Watcher proposal #${id} approved → ticket #${ticket.id}`,
          metadata: {}
        }, { proposalId: id, watcherId: proposal.watcherId, contextTicketId: ticket.id, createdTicketId: ticket.id, changedBy: actor });
        return { ok: true, proposal: structuredClone(proposal), ticket, event, auditLog };
      } catch (error) {
        try { this.writeProposals(rollback); } catch (_) {}
        throw error;
      }
    });
  }

  rejectWatcherProposal({ proposalId, changedBy, audit = null }) {
    return this.queueMutation(async () => {
      const id = positiveSafeInteger(proposalId, 'proposalId');
      const actor = requiredString(changedBy, 'changedBy');
      const rollback = this._rawProposals();
      const proposals = this._proposals();
      const proposal = proposals.find(item => item.id === id) || null;
      if (!proposal) return null;
      if (proposal.status !== 'proposed') throw new WatcherStateConflictError('Only a proposed proposal can be rejected', 'WATCHER_PROPOSAL_NOT_PROPOSED', proposal);
      const at = timestamp(this.now(), 'now');
      proposal.status = 'rejected';
      proposal.rejectedAt = at;
      proposal.approvedAt = null;
      proposal.createdTicketId = null;
      proposal.revision += 1;
      proposal.updatedBy = actor;
      proposal.updatedAt = at;
      try {
        this.writeProposals(proposals);
        const auditLog = await this._audit(audit, { proposalId: id, watcherId: proposal.watcherId, changedBy: actor });
        return { proposal: structuredClone(proposal), auditLog };
      } catch (error) {
        try { this.writeProposals(rollback); } catch (_) {}
        throw error;
      }
    });
  }
}

module.exports = { JsonWatcherAuthorityRepository };
