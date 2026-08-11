'use strict';

// Internal kernel authority only. A Ticket attempt owns an immutable set of
// admitted Run identities and one topology-neutral disposition. It deliberately
// carries no plan, role, executor, target, or decomposition semantics.

const TICKET_ATTEMPT_DISPOSITIONS = Object.freeze([
  'completed',
  'failed',
  'blocked',
  'interrupted'
]);

const TICKET_ATTEMPT_MEMBER_DISPOSITIONS = new Set(
  TICKET_ATTEMPT_DISPOSITIONS
);

class TicketAttemptContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'TicketAttemptContractError';
    this.code = code;
  }
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_INVALID',
      `${label} must be a valid timestamp`
    );
  }
  return date.toISOString();
}

function normalizeTicketAttemptDisposition(value, label = 'attempt.disposition') {
  if (!TICKET_ATTEMPT_MEMBER_DISPOSITIONS.has(value)) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_INVALID',
      `${label} must be one of ${TICKET_ATTEMPT_DISPOSITIONS.join(', ')}`
    );
  }
  return value;
}

function normalizeTicketAttempt(value, label = 'attempt') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_INVALID',
      `${label} must be an object`
    );
  }
  const disposition = value.disposition === null || value.disposition === undefined
    ? null
    : normalizeTicketAttemptDisposition(value.disposition, `${label}.disposition`);
  const settledAt = value.settledAt === null || value.settledAt === undefined
    ? null
    : timestamp(value.settledAt, `${label}.settledAt`);
  if ((disposition === null) !== (settledAt === null)) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_INVALID',
      `${label}.disposition and ${label}.settledAt must be null or present together`
    );
  }
  return Object.freeze({
    id: positiveSafeInteger(value.id, `${label}.id`),
    ticketId: positiveSafeInteger(value.ticketId, `${label}.ticketId`),
    ordinal: positiveSafeInteger(value.ordinal, `${label}.ordinal`),
    memberCount: positiveSafeInteger(value.memberCount, `${label}.memberCount`),
    disposition,
    admittedAt: timestamp(value.admittedAt, `${label}.admittedAt`),
    settledAt,
    revision: positiveSafeInteger(value.revision, `${label}.revision`)
  });
}

// Precedence is the existing eventual multi-Run Ticket result: completion
// blocking outranks generic failure, generic failure outranks interruption, and
// completion requires every member. This function is called only after every
// exact member has terminal evidence, so it never turns an active wave into a
// terminal Ticket merely because one sibling finished first.
function deriveTicketAttemptDisposition(memberDispositions) {
  if (!Array.isArray(memberDispositions) || memberDispositions.length === 0) {
    throw new TicketAttemptContractError(
      'TICKET_ATTEMPT_MEMBERSHIP_INVALID',
      'An attempt disposition requires at least one member'
    );
  }
  const normalized = memberDispositions.map((value, index) =>
    normalizeTicketAttemptDisposition(value, `memberDispositions[${index}]`));
  if (normalized.includes('blocked')) return 'blocked';
  if (normalized.includes('failed')) return 'failed';
  if (normalized.includes('interrupted')) return 'interrupted';
  if (normalized.every(value => value === 'completed')) return 'completed';
  throw new TicketAttemptContractError(
    'TICKET_ATTEMPT_DISPOSITION_UNDEFINED',
    'The terminal member set has no defined Ticket-attempt disposition'
  );
}

function ticketStatusForAttemptDisposition(disposition) {
  const normalized = normalizeTicketAttemptDisposition(disposition);
  return normalized === 'interrupted' ? 'open' : normalized;
}

module.exports = {
  TICKET_ATTEMPT_DISPOSITIONS,
  TicketAttemptContractError,
  deriveTicketAttemptDisposition,
  normalizeTicketAttempt,
  normalizeTicketAttemptDisposition,
  ticketStatusForAttemptDisposition
};
