'use strict';

// Durable Ticket cancellation authority.
//
// This is intentionally separate from Run execution outcomes and from the
// append-only event stream. The authority is the Ticket-owned fact; events are
// provenance for the transaction that committed it.

const CANCELLATION_AUTHORITY_VERSION = 1;

class TicketCancellationAuthorityError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'TicketCancellationAuthorityError';
    this.code = code;
  }
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

function requiredString(value, label, maxLength) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `${label} is required`
    );
  }
  if (normalized.length > maxLength) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `${label} exceeds ${maxLength} characters`
    );
  }
  return normalized;
}

function timestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `${label} must be a valid timestamp`
    );
  }
  return date.toISOString();
}

function normalizeCancellationAuthority(value, { expectedTicketId = null } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      'cancellation authority must be an object'
    );
  }
  const allowed = new Set([
    'version',
    'ticketId',
    'authoritySource',
    'requestedBy',
    'reason',
    'committedAt'
  ]);
  const extras = Object.keys(value).filter(key => !allowed.has(key));
  if (extras.length > 0) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `cancellation authority contains unsupported fields: ${extras.sort().join(', ')}`
    );
  }
  if (value.version !== CANCELLATION_AUTHORITY_VERSION) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_INVALID',
      `cancellation authority version must be ${CANCELLATION_AUTHORITY_VERSION}`
    );
  }
  const ticketId = positiveSafeInteger(value.ticketId, 'cancellationAuthority.ticketId');
  if (expectedTicketId !== null && ticketId !== positiveSafeInteger(
    expectedTicketId,
    'expectedTicketId'
  )) {
    throw new TicketCancellationAuthorityError(
      'TICKET_CANCELLATION_AUTHORITY_BINDING_INVALID',
      'cancellation authority ticketId does not match its Ticket'
    );
  }
  return Object.freeze({
    version: CANCELLATION_AUTHORITY_VERSION,
    ticketId,
    authoritySource: requiredString(value.authoritySource, 'cancellationAuthority.authoritySource', 128),
    requestedBy: requiredString(value.requestedBy, 'cancellationAuthority.requestedBy', 256),
    reason: requiredString(value.reason, 'cancellationAuthority.reason', 1024),
    committedAt: timestamp(value.committedAt, 'cancellationAuthority.committedAt')
  });
}

function buildCancellationAuthority({
  ticketId,
  authoritySource = 'operator',
  requestedBy,
  reason,
  committedAt = new Date().toISOString()
} = {}) {
  return normalizeCancellationAuthority({
    version: CANCELLATION_AUTHORITY_VERSION,
    ticketId,
    authoritySource,
    requestedBy,
    reason,
    committedAt
  }, { expectedTicketId: ticketId });
}

function cancellationAuthoritySemanticallyEqual(left, right) {
  const normalizedLeft = normalizeCancellationAuthority(left);
  const normalizedRight = normalizeCancellationAuthority(right);
  return normalizedLeft.ticketId === normalizedRight.ticketId &&
    normalizedLeft.authoritySource === normalizedRight.authoritySource &&
    normalizedLeft.requestedBy === normalizedRight.requestedBy &&
    normalizedLeft.reason === normalizedRight.reason;
}

module.exports = {
  CANCELLATION_AUTHORITY_VERSION,
  TicketCancellationAuthorityError,
  buildCancellationAuthority,
  cancellationAuthoritySemanticallyEqual,
  normalizeCancellationAuthority
};
