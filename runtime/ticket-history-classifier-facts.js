'use strict';

// Shared pure persistence-row -> classifier-fact normalization boundary.
//
// classifyTicketHistory() is the single semantic authority for historical
// Ticket classification, but it consumes PLAIN FACT OBJECTS assembled by its
// callers. Two production paths assemble those facts from PostgreSQL rows:
//
//   1. scripts/t2-five-state-classifier.js — the zero-mutation preflight
//      classifier;
//   2. persistence/postgres/t041-five-state-backfill.js — migration 041's
//      in-transaction classification hook.
//
// Operational incident T2-041-1 proved these two assemblers can drift: the
// hook mapped diagnostic-log identity without the context_ticket_id
// fallback, fed ticketId:null into the shared contract, and refused a fact
// set the preflight had classified clean. Source review found further drift
// candidates (body spread vs nesting, contextual identities, timestamps).
// Both callers therefore MUST normalize through this module so the same
// persisted row cannot produce two different classifier inputs.
//
// The normalizers are pure: they take one persistence row (timestamps as JS
// Date or anything `new Date()` accepts) and return plain JSON-safe facts.
// They never query, never lock, never mutate. Identity fallback semantics:
// direct ownership wins; context_* columns resolve only when the direct
// column is NULL, which is exactly how the runtime writes contextual logs;
// rows owned by neither remain unassigned (null) and are excluded from every
// Ticket by factsForTicket.

const IDENTIFIER = /^[1-9]\d*$/;

function numberId(value, label) {
  const parsed = typeof value === 'string' && IDENTIFIER.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function nullableNumberId(direct, contextual, label) {
  if (direct !== null && direct !== undefined) {
    return numberId(direct, label);
  }
  if (contextual !== null && contextual !== undefined) {
    return numberId(contextual, `${label} (contextual)`);
  }
  return null;
}

function isoTime(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp`);
  }
  return date.toISOString();
}

function nullableIsoTime(value, label) {
  return value === null || value === undefined
    ? null
    : isoTime(value, label);
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function ticketFact(row) {
  return {
    ...(jsonObject(row.body)),
    id: numberId(row.id, 'ticket.id'),
    status: row.status,
    cancellationAuthority: row.cancellation_authority ?? null,
    createdAt: isoTime(row.created_at, 'ticket.createdAt'),
    updatedAt: isoTime(row.updated_at, 'ticket.updatedAt')
  };
}

function attemptFact(row) {
  return {
    id: numberId(row.id, 'attempt.id'),
    ticketId: numberId(row.ticket_id, 'attempt.ticketId'),
    ordinal: numberId(row.ordinal, 'attempt.ordinal'),
    memberCount: numberId(row.member_count, 'attempt.memberCount'),
    disposition: row.disposition,
    admittedAt: isoTime(row.admitted_at, 'attempt.admittedAt'),
    settledAt: nullableIsoTime(row.settled_at, 'attempt.settledAt'),
    revision: numberId(row.revision, 'attempt.revision')
  };
}

function runFact(row) {
  return {
    ...(jsonObject(row.body)),
    id: numberId(row.id, 'run.id'),
    ticketId: numberId(row.ticket_id, 'run.ticketId'),
    ticketAttemptId: numberId(row.ticket_attempt_id, 'run.ticketAttemptId'),
    status: row.status,
    createdAt: isoTime(row.created_at, 'run.createdAt'),
    updatedAt: isoTime(row.updated_at, 'run.updatedAt'),
    completedAt: nullableIsoTime(row.completed_at, 'run.completedAt')
  };
}

function consequenceFact(row) {
  return {
    runId: numberId(row.run_id, 'consequence.runId'),
    ticketId: numberId(row.ticket_id, 'consequence.ticketId'),
    recordedAt: isoTime(row.recorded_at, 'consequence.recordedAt'),
    consequence: jsonObject(row.consequence)
  };
}

function planFact(row) {
  return {
    ...(jsonObject(row.body)),
    id: numberId(row.id, 'plan.id'),
    ticketId: numberId(row.ticket_id, 'plan.ticketId'),
    status: row.status,
    revision: numberId(row.revision, 'plan.revision'),
    createdAt: isoTime(row.created_at, 'plan.createdAt'),
    updatedAt: isoTime(row.updated_at, 'plan.updatedAt')
  };
}

function eventFact(row) {
  return {
    id: row.id,
    position: numberId(row.position, 'event.position'),
    ticketId: row.ticket_id === null ? null : numberId(row.ticket_id, 'event.ticketId'),
    runId: row.run_id === null ? null : numberId(row.run_id, 'event.runId'),
    type: row.type,
    ts: isoTime(row.ts, 'event.ts'),
    payload: jsonObject(row.payload)
  };
}

function logFact(row) {
  return {
    id: numberId(row.id, 'log.id'),
    ticketId: nullableNumberId(
      row.ticket_id,
      row.context_ticket_id,
      'log.ticketId'
    ),
    runId: nullableNumberId(
      row.run_id,
      row.context_run_id,
      'log.runId'
    ),
    type: row.type,
    timestamp: isoTime(row.occurred_at, 'log.timestamp'),
    body: jsonObject(row.body)
  };
}

// The complete fact set one Ticket owns, normalized. A log is governed by the
// Ticket named in ticket_id, or — only when that column is NULL — by the
// Ticket named in context_ticket_id; rows owned by neither are global and are
// excluded for every Ticket.
function factsForTicket(facts, ticketId) {
  const id = numberId(ticketId, 'ticket.id');
  return {
    ticket: facts.tickets.find(ticket => ticket.id === id) || null,
    attempts: facts.attempts.filter(attempt => attempt.ticketId === id),
    runs: facts.runs.filter(run => run.ticketId === id),
    consequences: facts.consequences.filter(item => item.ticketId === id),
    plans: facts.plans.filter(plan => plan.ticketId === id),
    events: facts.events.filter(event => event.ticketId === id),
    logs: facts.logs.filter(log => log.ticketId === id)
  };
}

module.exports = {
  ticketFact,
  attemptFact,
  runFact,
  consequenceFact,
  planFact,
  eventFact,
  logFact,
  factsForTicket
};
