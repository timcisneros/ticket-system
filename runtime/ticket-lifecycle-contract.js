'use strict';

// Canonical pure Ticket lifecycle projection.
//
// T2 frozen semantics:
//   1. cancellation authority present      -> canceled
//   2. current authoritative unsettled attempt -> in_progress
//   3. most-recent authoritative settled attempt has verified completed
//                                            -> completed
//   4. established unresolved durable blocking authority -> blocked
//   5. otherwise                          -> open
//
// This projector is pure, topology-neutral, and durable-authority-only.
// It must NOT:
//   - rerun routing
//   - inspect current provider availability
//   - predict whether a hypothetical admission would succeed
//   - inspect execution topology to choose lifecycle
//   - elevate a failed or interrupted attempt disposition directly
//
// The projector does NOT persist any state. The lifecycle projection is a
// read of durable authority facts; the canonical writers remain responsible
// for committing any status update.

const TICKET_LIFECYCLE_STATES = Object.freeze([
  'open',
  'in_progress',
  'blocked',
  'completed',
  'canceled'
]);

const TICKET_LIFECYCLE_SET = new Set(TICKET_LIFECYCLE_STATES);

class TicketLifecycleContractError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'TicketLifecycleContractError';
    this.code = code;
  }
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketLifecycleContractError(
      'TICKET_LIFECYCLE_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TicketLifecycleContractError(
      'TICKET_LIFECYCLE_INVALID',
      `${label} must be a positive safe integer`
    );
  }
  return value;
}

// Normalized blocking authority inputs. Tranche 1 narrows the input set to the
// currently-durable authority surfaces; supersession mechanisms are introduced
// in later tranches. A blocking authority is "established unresolved" when it
// exists as a durable record AND has not been resolved/superseded by a durable
// record of equivalent authority.
//
// The shape is intentionally narrow: a single boolean flag per blocking class.
// Callers compose the inputs from their own durable authority reads; the
// projector does not inspect any other fact.
function normalizeBlockingAuthority(value, label = 'blockingAuthority') {
  if (value === null || value === undefined) {
    return {
      ticketTriageUnresolved: false,
      persistedRefusalEventId: null,
      maxAttemptsExhausted: false
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TicketLifecycleContractError(
      'TICKET_LIFECYCLE_INVALID',
      `${label} must be an object or null`
    );
  }
  const allowed = ['ticketTriageUnresolved', 'persistedRefusalEventId', 'maxAttemptsExhausted'];
  const extras = Object.keys(value).filter(key => !allowed.includes(key));
  if (extras.length > 0) {
    throw new TicketLifecycleContractError(
      'TICKET_LIFECYCLE_INVALID',
      `${label} contains unsupported fields: ${extras.sort().join(', ')}`
    );
  }
  const ticketTriageUnresolved = value.ticketTriageUnresolved === true;
  let persistedRefusalEventId = null;
  if (value.persistedRefusalEventId !== null && value.persistedRefusalEventId !== undefined) {
    if (typeof value.persistedRefusalEventId !== 'string' || value.persistedRefusalEventId.length === 0) {
      throw new TicketLifecycleContractError(
        'TICKET_LIFECYCLE_INVALID',
        `${label}.persistedRefusalEventId must be a non-empty string or null`
      );
    }
    persistedRefusalEventId = value.persistedRefusalEventId;
  }
  const maxAttemptsExhausted = value.maxAttemptsExhausted === true;
  return {
    ticketTriageUnresolved,
    persistedRefusalEventId,
    maxAttemptsExhausted
  };
}

function hasUnresolvedBlockingAuthority(blockingAuthority) {
  if (!blockingAuthority) return false;
  return blockingAuthority.ticketTriageUnresolved === true ||
    blockingAuthority.persistedRefusalEventId !== null ||
    blockingAuthority.maxAttemptsExhausted === true;
}

// Canonical five-state Ticket lifecycle projection. Pure, topology-neutral.
//
// Parameters:
//   cancellationAuthority: durable cancellation authority (null when absent;
//     structured shape introduced in a later tranche). Tranche 1 accepts a
//     boolean-like value: an object with a truthy `present` field, or null.
//   currentAttempt: the most-recent Ticket attempt, or null. Shape:
//     { id, ordinal, disposition: 'completed'|'failed'|'blocked'|'interrupted'|null, memberCount }
//   mostRecentSettledAttempt: the most-recent settled attempt that has been
//     verified completed. Shape: { id, ordinal, disposition: 'completed' } or null.
//   blockingAuthority: normalized blocking authority (see normalizeBlockingAuthority)
//
// Returns: { state, authorityReference }
//   state: one of TICKET_LIFECYCLE_STATES
//   authorityReference: typed reference to the authority that won precedence.
//     null when state === 'open' (no specific authority; absence of others).
function projectTicketLifecycle({
  cancellationAuthority = null,
  currentAttempt = null,
  mostRecentSettledAttempt = null,
  blockingAuthority = null
} = {}) {
  const blocking = normalizeBlockingAuthority(blockingAuthority);

  // 1. cancellation authority present -> canceled
  const cancellationPresent = cancellationAuthority !== null &&
    cancellationAuthority !== undefined &&
    (cancellationAuthority.present === true ||
      (typeof cancellationAuthority === 'object' && Object.keys(cancellationAuthority).length > 0 &&
        cancellationAuthority.present !== false));
  if (cancellationPresent) {
    return Object.freeze({
      state: 'canceled',
      authorityReference: Object.freeze({
        kind: 'cancellation',
        reference: cancellationAuthority
      })
    });
  }

  // 2. current authoritative unsettled attempt -> in_progress
  if (currentAttempt !== null && currentAttempt !== undefined) {
    const disposition = currentAttempt.disposition;
    if (disposition === null || disposition === undefined) {
      return Object.freeze({
        state: 'in_progress',
        authorityReference: Object.freeze({
          kind: 'attempt',
          reference: Object.freeze({
            ticketAttemptId: positiveSafeInteger(currentAttempt.id, 'currentAttempt.id'),
            ticketAttemptOrdinal: positiveInteger(
              currentAttempt.ordinal, 'currentAttempt.ordinal'),
            memberCount: positiveInteger(
              currentAttempt.memberCount, 'currentAttempt.memberCount')
          })
        })
      });
    }
  }

  // 3. most-recent authoritative settled attempt has verified completed -> completed
  if (mostRecentSettledAttempt !== null && mostRecentSettledAttempt !== undefined) {
    const disposition = mostRecentSettledAttempt.disposition;
    if (disposition === 'completed') {
      return Object.freeze({
        state: 'completed',
        authorityReference: Object.freeze({
          kind: 'completion',
          reference: Object.freeze({
            ticketAttemptId: positiveSafeInteger(
              mostRecentSettledAttempt.id, 'mostRecentSettledAttempt.id'),
            ticketAttemptOrdinal: positiveInteger(
              mostRecentSettledAttempt.ordinal, 'mostRecentSettledAttempt.ordinal')
          })
        })
      });
    }
  }

  // 4. established unresolved durable blocking authority -> blocked
  if (hasUnresolvedBlockingAuthority(blocking)) {
    const reference = {};
    if (blocking.ticketTriageUnresolved) reference.ticketTriageUnresolved = true;
    if (blocking.persistedRefusalEventId !== null) {
      reference.persistedRefusalEventId = blocking.persistedRefusalEventId;
    }
    if (blocking.maxAttemptsExhausted) reference.maxAttemptsExhausted = true;
    return Object.freeze({
      state: 'blocked',
      authorityReference: Object.freeze({
        kind: 'blocking',
        reference: Object.freeze(reference)
      })
    });
  }

  // 5. otherwise -> open
  return Object.freeze({
    state: 'open',
    authorityReference: null
  });
}

module.exports = {
  TICKET_LIFECYCLE_STATES,
  TICKET_LIFECYCLE_SET,
  TicketLifecycleContractError,
  normalizeBlockingAuthority,
  projectTicketLifecycle
};
