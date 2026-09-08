'use strict';

// Pure, zero-mutation historical Ticket classifier for the Tranche 3
// five-state cutover preflight. This module consumes facts already read by a
// caller and never invokes persistence or reconciliation.

const {
  evaluateAttemptCompletionAuthority
} = require('./ticket-attempt-completion-contract');
const {
  deriveLeafItemDisposition,
  normalizeLeafRunBinding
} = require('./structured-allocation-leaf-run-contract');
const {
  normalizeCancellationAuthority
} = require('./ticket-cancellation-authority-contract');
const {
  projectTicketLifecycle
} = require('./ticket-lifecycle-contract');
const {
  composeBlockingAuthority,
  reconstructMaxAttemptsChain,
  maxAttemptsAsOf
} = require('./ticket-blocking-authority-composer');

const LIFECYCLES = new Set(['open', 'in_progress', 'blocked', 'completed', 'canceled']);

class TicketHistoryClassifierError extends TypeError {
  constructor(code, message, references = {}) {
    super(message);
    this.name = 'TicketHistoryClassifierError';
    this.code = code;
    this.references = references;
  }
}

function positiveId(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketHistoryClassifierError(
      'HISTORY_CLASSIFIER_INVALID_INPUT',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

function time(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TicketHistoryClassifierError(
      'HISTORY_CLASSIFIER_INVALID_TIMESTAMP',
      `${label} must be a valid timestamp`
    );
  }
  return date.getTime();
}

function asTimestamp(value, label) {
  return new Date(time(value, label)).toISOString();
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function references(value = {}) {
  return Object.freeze({
    ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  });
}

function reason(code, value = {}) {
  return Object.freeze({ code, references: references(value) });
}

function sortedByTimeAndId(values, timeField, idField = 'id') {
  return [...values].sort((left, right) => {
    const timeDifference = time(left[timeField], timeField) - time(right[timeField], timeField);
    if (timeDifference !== 0) return timeDifference;
    return positiveId(left[idField], idField) - positiveId(right[idField], idField);
  });
}

function eventPayload(event) {
  return objectOrEmpty(event && event.payload);
}

function eventTime(event) {
  return time(event.ts || event.timestamp, 'event.ts');
}

function logBody(log) {
  return objectOrEmpty(log && (log.body || log));
}

function logTime(log) {
  return time(log.timestamp || log.occurredAt || log.createdAt, 'diagnostic log timestamp');
}

function asOfRun(run, runEvents, closeAt) {
  if (closeAt === null) return { ...run };
  const createdAt = time(run.createdAt, 'run.createdAt');
  if (createdAt > closeAt) return null;
  let status = 'pending';
  const events = runEvents
    .filter(event => event.runId !== null && event.runId !== undefined &&
      positiveId(event.runId, 'event.runId') === positiveId(run.id, 'run.id'))
    .filter(event => eventTime(event) <= closeAt)
    .sort((left, right) => eventTime(left) - eventTime(right) ||
      positiveId(left.position || 1, 'event.position') - positiveId(right.position || 1, 'event.position'));
  for (const event of events) {
    const payload = eventPayload(event);
    if (event.type === 'run.started') status = 'running';
    if (event.type === 'run.status_changed' && typeof payload.status === 'string') status = payload.status;
    if (['run.terminalized', 'run.completed', 'run.failed', 'run.interrupted'].includes(event.type)) {
      status = typeof payload.status === 'string'
        ? payload.status
        : event.type.slice('run.'.length);
    }
  }
  if (events.length === 0 && run.status && time(run.updatedAt || run.createdAt, 'run.updatedAt') <= closeAt) {
    status = run.status;
  }
  return { ...run, status };
}

function consequenceAsOf(consequence, closeAt) {
  if (!consequence) return null;
  if (closeAt !== null && time(consequence.recordedAt, 'run consequence.recordedAt') > closeAt) return null;
  return consequence.consequence || consequence;
}

function matchingCloseOperations(ticket, events, logs) {
  const id = positiveId(ticket.id, 'ticket.id');
  const closeEvents = events.filter(event => {
    const payload = eventPayload(event);
    return positiveId(event.ticketId, 'event.ticketId') === id &&
      event.type === 'ticket.updated' && payload.status === 'closed';
  });
  const closeLogs = logs.filter(log => {
    const body = logBody(log);
    return positiveId(body.ticketId || log.ticketId, 'log.ticketId') === id &&
      log.type === 'ticket:status_change' && body.toStatus === 'closed';
  });
  const operations = [];
  for (const event of closeEvents) {
    const payload = eventPayload(event);
    const operator = payload.changedBy || null;
    const closeAt = eventTime(event);
    if (typeof operator !== 'string' || !operator.trim() ||
        typeof payload.previousStatus !== 'string' || !payload.previousStatus.trim()) {
      continue;
    }
    const matchingLogs = closeLogs.filter(log => {
      const body = logBody(log);
      return body.fromStatus === (payload.previousStatus || null) &&
        body.toStatus === 'closed' &&
        body.changedBy === operator &&
        logTime(log) >= closeAt;
    });
    if (matchingLogs.length === 1) {
      const log = matchingLogs[0];
      const body = logBody(log);
      operations.push({
        event,
        log,
        closeAt,
        operator,
        fromStatus: payload.previousStatus || body.fromStatus || null,
        toStatus: 'closed',
        logBody: body
      });
    }
  }
  return { closeEvents, closeLogs, operations };
}

function runInterruptionProof(ticketId, operator, closeAt, activeRuns, events, logs) {
  const expectedReason = `${operator} closed ticket #${ticketId}`;
  const proofs = [];
  for (const run of activeRuns) {
    const terminalEvent = events
      .filter(event => event.runId !== null && event.runId !== undefined &&
        positiveId(event.runId, 'event.runId') === run.id &&
        event.type === 'run.terminalized' && eventTime(event) >= closeAt &&
        eventPayload(event).status === 'interrupted')
      .sort((left, right) => eventTime(left) - eventTime(right))[0] || null;
    const interruptionLog = logs
      .filter(log => {
        const body = logBody(log);
        const logRunId = body.runId || log.runId;
        return logRunId !== null && logRunId !== undefined &&
          positiveId(logRunId, 'log.runId') === run.id &&
          log.type === 'run:interrupted' &&
          logTime(log) >= closeAt &&
          typeof body.message === 'string' && body.message.startsWith(expectedReason);
      })
      .sort((left, right) => logTime(left) - logTime(right))[0] || null;
    if (!terminalEvent || !interruptionLog) return null;
    proofs.push({
      runId: run.id,
      terminalEventPosition: terminalEvent.position || null,
      interruptionLogId: interruptionLog.id || null
    });
  }
  return proofs;
}

// Blocking-authority derivation for the historical view. Delegates to the
// SHARED Tranche 5 composer so runtime writers and this classifier cannot
// drift. closeBoundary is {position, tsMs} for a historical view (position is
// the primary ordering authority) or null for the live view.
//
// The composer's fixed precedence: unresolved triage, latest settled BLOCKED
// attempt, as-of maxAttempts exhaustion, executeTicketPlan admission hold,
// then the CURRENT reasoned refusal event (superseded by any later successful
// attempt admission within the boundary, ordered by event position).
function deriveBlocker(ticket, events, attempts, closeBoundary) {
  const composed = composeBlockingAuthority({
    triage: objectOrEmpty(ticket.body || ticket).triage || null,
    attempts: attempts.map(attempt => ({
      id: attempt.id,
      ordinal: attempt.ordinal,
      disposition: attempt.disposition,
      admittedAt: attempt.admittedAt,
      settledAt: attempt.settledAt,
      memberCount: attempt.memberCount
    })),
    events: events.filter(event =>
      positiveId(event.ticketId, 'event.ticketId') === positiveId(ticket.id, 'ticket.id')),
    executionPolicy: objectOrEmpty(ticket.body || ticket).executionPolicy || null,
    closeBoundary
  });
  if (!composed.won) return null;
  return { authority: composed.input, reference: composed.reference };
}

function deriveV2Completion(plan, members, decisionsByRunId) {
  if (!plan || plan.version !== 2) return null;
  if (!Array.isArray(plan.items) || plan.items.length === 0 || !plan.planHash) {
    throw new TicketHistoryClassifierError(
      'HISTORY_CLASSIFIER_V2_PLAN_INVALID',
      `v2 plan ${plan.id} lacks immutable plan metadata`,
      { planId: plan.id }
    );
  }
  const byItem = new Map();
  for (const member of members) {
    if (!member.leafRunBinding) continue;
    const binding = normalizeLeafRunBinding(member.leafRunBinding, {
      expectedRunId: member.id,
      expectedTicketId: plan.ticketId,
      expectedPlanId: plan.id,
      expectedPlanHash: plan.planHash
    });
    const lineage = byItem.get(binding.allocationItemId) || [];
    lineage.push({ run: member, binding });
    byItem.set(binding.allocationItemId, lineage);
  }
  const itemDispositions = plan.items.map(item => {
    const lineage = [...(byItem.get(item.allocationItemId) || [])]
      .sort((left, right) => left.run.id - right.run.id);
    if (lineage.length === 0) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_V2_LEAF_MEMBERSHIP_INVALID',
        `v2 plan ${plan.id} is missing a leaf for item ${item.allocationItemId}`,
        { planId: plan.id, allocationItemId: item.allocationItemId }
      );
    }
    const current = lineage[lineage.length - 1];
    const disposition = deriveLeafItemDisposition({
      binding: current.binding,
      runId: current.run.id,
      runTicketId: current.run.ticketId,
      runStatus: current.run.status,
      runDeclaredWorkHash: current.run.declaredWorkSnapshot
        ? current.run.declaredWorkSnapshot.contractHash
        : null,
      runCompletionAuthorityHash: current.run.completionAuthoritySnapshot
        ? current.run.completionAuthoritySnapshot.objectiveContractHash
        : null,
      decision: decisionsByRunId.get(current.run.id) || null,
      governedProgressBlock: current.run.governedProgressBlock || null
    });
    return {
      allocationItemId: item.allocationItemId,
      itemStatus: disposition.itemStatus,
      runId: current.run.id
    };
  });
  return {
    planId: plan.id,
    planHash: plan.planHash,
    completed: itemDispositions.every(item => item.itemStatus === 'completed'),
    itemDispositions
  };
}

function deriveLifecycle({ ticket, attempts, runs, consequences, plans, events, closeAt, closeBoundary = null }) {
  const ticketId = positiveId(ticket.id, 'ticket.id');
  const eligibleAttempts = attempts.filter(attempt =>
    time(attempt.admittedAt, 'attempt.admittedAt') <= (closeAt === null ? Number.POSITIVE_INFINITY : closeAt));
  const currentAttempt = [...eligibleAttempts].sort((left, right) =>
    positiveId(right.ordinal, 'attempt.ordinal') - positiveId(left.ordinal, 'attempt.ordinal'))[0] || null;
  const attemptViews = new Map();
  const decisionsByRunId = new Map();
  for (const attempt of eligibleAttempts) {
    const members = runs
      .filter(run => positiveId(run.ticketAttemptId, 'run.ticketAttemptId') === positiveId(attempt.id, 'attempt.id'))
      .map(run => asOfRun(run, events, closeAt))
      .filter(Boolean);
    if (members.length !== positiveId(attempt.memberCount, 'attempt.memberCount')) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_ATTEMPT_MEMBERSHIP_INVALID',
        `attempt ${attempt.id} does not have exact as-of-close membership`,
        { attemptId: attempt.id }
      );
    }
    for (const run of members) {
      const consequence = consequences.find(item =>
        positiveId(item.runId, 'consequence.runId') === run.id);
      const value = consequenceAsOf(consequence, closeAt);
      decisionsByRunId.set(run.id, value && value.completionDecision
        ? value.completionDecision
        : null);
    }
    const planIds = [...new Set(members
      .map(run => run.allocationPlanId)
      .filter(value => value !== null && value !== undefined)
      .map(value => positiveId(value, 'run.allocationPlanId')))
    ];
    if (planIds.length > 1) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_V2_PLAN_MEMBERSHIP_INVALID',
        `attempt ${attempt.id} names multiple allocation plans`,
        { attemptId: attempt.id, planIds }
      );
    }
    const plan = planIds.length === 0 ? null : plans.find(candidate =>
      positiveId(candidate.id, 'allocationPlan.id') === planIds[0]);
    if (planIds.length > 0 && (!plan ||
        time(plan.createdAt, 'allocationPlan.createdAt') >
          (closeAt === null ? Number.POSITIVE_INFINITY : closeAt))) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_V2_PLAN_UNAVAILABLE_AS_OF_CLOSE',
        `v2 plan for attempt ${attempt.id} is unavailable as of close`,
        { attemptId: attempt.id, planId: planIds[0] }
      );
    }
    const v2 = plan ? deriveV2Completion(plan, members, decisionsByRunId) : null;
    const rawSettled = attempt.disposition && attempt.settledAt &&
      (closeAt === null || time(attempt.settledAt, 'attempt.settledAt') <= closeAt)
      ? attempt.disposition
      : null;
    const authority = evaluateAttemptCompletionAuthority(members, decisionsByRunId);
    if (rawSettled === 'completed' && (!authority || authority.candidateDisposition !== 'completed')) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_COMPLETION_AUTHORITY_CONTRADICTION',
        `attempt ${attempt.id} claims completed without matching as-of-close completion authority`,
        { attemptId: attempt.id }
      );
    }
    if (rawSettled === 'completed' && v2 && !v2.completed) {
      throw new TicketHistoryClassifierError(
        'HISTORY_CLASSIFIER_V2_COMPLETION_CONTRADICTION',
        `v2 plan ${v2.planId} does not prove completed attempt ${attempt.id}`,
        { attemptId: attempt.id, planId: v2.planId }
      );
    }
    attemptViews.set(attempt.id, { attempt, members, rawSettled, authority, v2 });
  }

  const currentView = currentAttempt ? attemptViews.get(currentAttempt.id) : null;
  const settledCompleted = currentAttempt && currentView &&
    currentView.rawSettled === 'completed' &&
    currentView.authority && currentView.authority.candidateDisposition === 'completed'
    ? currentAttempt
    : null;
  const cancellation = ticket.cancellationAuthority || null;
  const cancellationAt = cancellation ? time(cancellation.committedAt, 'cancellationAuthority.committedAt') : null;
  const effectiveCancellation = cancellation &&
    (closeAt === null || cancellationAt <= closeAt) ? cancellation : null;
  const blocker = deriveBlocker(ticket, events, eligibleAttempts, closeBoundary);
  const projection = projectTicketLifecycle({
    cancellationAuthority: effectiveCancellation,
    currentAttempt: currentView && currentView.rawSettled === null
      ? {
          id: currentAttempt.id,
          ordinal: currentAttempt.ordinal,
          disposition: null,
          memberCount: currentAttempt.memberCount
        }
      : null,
    mostRecentSettledAttempt: settledCompleted
      ? { id: settledCompleted.id, ordinal: settledCompleted.ordinal, disposition: 'completed' }
      : null,
    blockingAuthority: blocker ? blocker.authority : null
  });
  const referencesByKind = {
    cancellation: effectiveCancellation ? { ticketId } : null,
    attempt: currentAttempt ? { attemptId: currentAttempt.id, ordinal: currentAttempt.ordinal } : null,
    completion: settledCompleted ? { attemptId: settledCompleted.id, ordinal: settledCompleted.ordinal } : null,
    blocker: blocker ? blocker.reference : null
  };
  if (ticket.status === 'blocked' && !blocker) {
    throw new TicketHistoryClassifierError(
      'HISTORY_CLASSIFIER_BLOCKER_AUTHORITY_MISSING',
      `Ticket ${ticketId} has status-only blocked history`,
      { ticketId }
    );
  }
  return {
    projection,
    references: referencesByKind,
    currentAttempt,
    currentView,
    settledCompleted,
    blocker,
    attemptViews
  };
}

function classifyTicketHistory(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new TicketHistoryClassifierError('HISTORY_CLASSIFIER_INVALID_INPUT', 'facts must be an object');
  }
  const ticket = objectOrEmpty(facts.ticket);
  const ticketId = positiveId(ticket.id, 'ticket.id');
  const attempts = Array.isArray(facts.attempts) ? facts.attempts : [];
  const runs = Array.isArray(facts.runs) ? facts.runs : [];
  const consequences = Array.isArray(facts.consequences) ? facts.consequences : [];
  const plans = Array.isArray(facts.plans) ? facts.plans : [];
  const events = Array.isArray(facts.events) ? facts.events : [];
  const logs = Array.isArray(facts.logs) ? facts.logs : [];
  const legacyStatus = ticket.status || null;
  const reasons = [];
  let cancellation = null;
  try {
    if (ticket.cancellationAuthority !== null && ticket.cancellationAuthority !== undefined) {
      cancellation = normalizeCancellationAuthority(ticket.cancellationAuthority, {
        expectedTicketId: ticketId
      });
    }
  } catch (error) {
    return Object.freeze({
      ticketId,
      legacyStatus,
      classification: 'integrity_contradiction',
      proposedLifecycle: null,
      authorityReferences: references({ cancellation: { ticketId } }),
      closedClassification: null,
      historicalCancellationAuthority: null,
      reasons: Object.freeze([reason(error.code || 'HISTORY_CLASSIFIER_CANCELLATION_INVALID', { ticketId })])
    });
  }
  let closeData;
  try {
    closeData = matchingCloseOperations(ticket, events, logs);
  } catch (error) {
    return Object.freeze({
      ticketId,
      legacyStatus,
      classification: 'integrity_contradiction',
      proposedLifecycle: null,
      authorityReferences: references(),
      closedClassification: legacyStatus === 'closed' ? 'ambiguous' : null,
      historicalCancellationAuthority: null,
      reasons: Object.freeze([reason(
        error.code || 'HISTORY_CLASSIFIER_CLOSE_EVIDENCE_INVALID',
        { ticketId }
      )])
    });
  }
  const isClosed = legacyStatus === 'closed' || closeData.closeEvents.length > 0;
  let closeOperation = null;
  if (isClosed) {
    if (closeData.operations.length !== 1 || closeData.closeEvents.length !== 1) {
      return Object.freeze({
        ticketId,
        legacyStatus,
        classification: 'ambiguous',
        proposedLifecycle: null,
        authorityReferences: references({ closeOperation: { eventCount: closeData.closeEvents.length } }),
        closedClassification: 'ambiguous',
        historicalCancellationAuthority: null,
        reasons: Object.freeze([reason('HISTORY_CLASSIFIER_CLOSE_OPERATION_NOT_UNIQUE', {
          closeEventCount: closeData.closeEvents.length,
          matchingOperationCount: closeData.operations.length
        })])
      });
    }
    closeOperation = closeData.operations[0];
  }
  const closeAt = closeOperation ? closeOperation.closeAt : null;
  // Event append POSITION is the primary historical ordering authority; the
  // close timestamp remains applicability/consistency evidence.
  const closeBoundary = closeOperation
    ? { position: positiveId(closeOperation.event.position, 'close event position'), tsMs: closeAt }
    : null;
  const semanticTicket = { ...ticket, cancellationAuthority: cancellation };
  let derived;
  try {
    derived = deriveLifecycle({
      ticket: semanticTicket,
      attempts,
      runs,
      consequences,
      plans,
      events,
      closeAt,
      closeBoundary
    });
  } catch (error) {
    return Object.freeze({
      ticketId,
      legacyStatus,
      classification: 'integrity_contradiction',
      proposedLifecycle: null,
      authorityReferences: references({ closeOperation: closeOperation ? {
        eventPosition: closeOperation.event.position || null,
        logId: closeOperation.log.id || null
      } : null }),
      closedClassification: closeOperation ? 'ambiguous' : null,
      historicalCancellationAuthority: null,
      reasons: Object.freeze([reason(error.code || 'HISTORY_CLASSIFIER_AUTHORITY_INVALID', error.references || {})])
    });
  }
  // T2 Tranche 5 authority-first model: legacy status is consistency/history
  // evidence only. A divergence between the legacy string and the derived
  // canonical projection is RECORDED, never fatal — the derived projection is
  // the migration authority (e.g. legacy 'completed' with a newer settled
  // failed attempt and no blocker projects 'open'; legacy 'failed' with a
  // durable latest completion authority projects 'completed'). Genuine
  // authority contradictions (malformed/unorderable facts) still refuse via
  // the deriveLifecycle catch above.
  if (legacyStatus && legacyStatus !== derived.projection.state) {
    reasons.push(reason('HISTORY_CLASSIFIER_LEGACY_STATUS_MATERIALIZATION_MISMATCH', {
      legacyStatus,
      derivedLifecycle: derived.projection.state
    }));
  }
  if (!isClosed) {
    return Object.freeze({
      ticketId,
      legacyStatus,
      classification: 'migratable',
      proposedLifecycle: derived.projection.state,
      authorityReferences: references(derived.references),
      closedClassification: null,
      historicalCancellationAuthority: null,
      reasons: Object.freeze(reasons)
    });
  }
  const closeReferences = {
    eventPosition: closeOperation.event.position || null,
    eventId: closeOperation.event.id || null,
    logId: closeOperation.log.id || null,
    operator: closeOperation.operator,
    closeAt: asTimestamp(closeOperation.event.ts, 'close event timestamp'),
    fromStatus: closeOperation.fromStatus,
    toStatus: closeOperation.toStatus
  };
  let closedClassification = 'ambiguous';
  let proposedLifecycle = null;
  let historicalCancellationAuthority = null;
  if (derived.projection.state === 'completed') {
    closedClassification = 'proven_not_canceled';
    proposedLifecycle = 'completed';
  } else if (derived.projection.state === 'canceled') {
    closedClassification = 'proven_canceled';
    proposedLifecycle = 'canceled';
  } else if (derived.projection.state === 'open') {
    closedClassification = 'proven_canceled';
    proposedLifecycle = 'canceled';
  } else if (derived.projection.state === 'in_progress') {
    const activeRuns = [...derived.attemptViews.values()]
      .filter(view => view.attempt.id === derived.currentAttempt.id)
      .flatMap(view => view.members)
      .filter(run => ['pending', 'running'].includes(run.status));
    const interruptionProof = runInterruptionProof(
      ticketId,
      closeOperation.operator,
      closeAt,
      activeRuns,
      events,
      logs
    );
    if (interruptionProof !== null) {
      closedClassification = 'proven_canceled';
      proposedLifecycle = 'canceled';
      closeReferences.interruptionProof = interruptionProof;
    } else {
      reasons.push(reason('HISTORY_CLASSIFIER_INTERRUPTION_PROOF_INCOMPLETE', {
        activeRunCount: activeRuns.length
      }));
    }
  } else if (derived.projection.state === 'blocked') {
    reasons.push(reason('HISTORY_CLASSIFIER_BLOCKED_CLOSE_REQUIRES_STRONGER_PROOF', {
      ticketId
    }));
  }
  if (closedClassification === 'proven_canceled') {
    historicalCancellationAuthority = {
      version: 1,
      ticketId,
      authoritySource: 'historical_operator_closure',
      requestedBy: closeOperation.operator,
      reason: 'historical operator closure of unfinished Ticket work',
      committedAt: asTimestamp(closeOperation.event.ts, 'close event timestamp')
    };
    try {
      normalizeCancellationAuthority(historicalCancellationAuthority, { expectedTicketId: ticketId });
    } catch (error) {
      return Object.freeze({
        ticketId,
        legacyStatus,
        classification: 'integrity_contradiction',
        proposedLifecycle: null,
        authorityReferences: references({ closeOperation: closeReferences }),
        closedClassification: 'ambiguous',
        historicalCancellationAuthority: null,
        reasons: Object.freeze([reason(error.code || 'HISTORY_CLASSIFIER_CANCELLATION_CANDIDATE_INVALID', {
          ticketId
        })])
      });
    }
  }
  if (closedClassification === 'ambiguous') {
    return Object.freeze({
      ticketId,
      legacyStatus,
      classification: 'ambiguous',
      proposedLifecycle: null,
      authorityReferences: references({ ...derived.references, closeOperation: closeReferences }),
      closedClassification,
      historicalCancellationAuthority: null,
      reasons: Object.freeze(reasons.length > 0 ? reasons : [
        reason('HISTORY_CLASSIFIER_CLOSE_INTENT_NOT_PROVEN', { ticketId })
      ])
    });
  }
  return Object.freeze({
    ticketId,
    legacyStatus,
    classification: 'migratable',
    proposedLifecycle,
    authorityReferences: references({ ...derived.references, closeOperation: closeReferences }),
    closedClassification,
    historicalCancellationAuthority,
    reasons: Object.freeze(reasons)
  });
}

module.exports = {
  LIFECYCLES,
  TicketHistoryClassifierError,
  classifyTicketHistory,
  deriveLifecycle,
  matchingCloseOperations,
  runInterruptionProof
};
