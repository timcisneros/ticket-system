'use strict';

// Shared, pure blocking-authority composition for T2 Tranche 5.
//
// The runtime Ticket writers (settlement projection, cancellation, triage
// resolution, maxAttempts reprojection, admission-intent gating) and the
// Tranche 4 historical classifier BOTH call this module, so their blocking
// semantics cannot drift. It consumes only durable facts already read by the
// caller and never touches persistence or the network.
//
// Frozen authority precedence inside rule 4 of the lifecycle projector
// (first match wins; exactly one reference is reported):
//
//   1. ticketTriageUnresolved
//   2. settledBlockedAttempt   (write-once latest/highest attempt disposition)
//   3. maxAttemptsExhausted    (ticket-owned policy, as-of boundary)
//   4. admissionHold           (executeTicketPlan spawn provenance, zero attempts)
//   5. persistedRefusalEventId (reasoned ticket.blocked event, current only)
//
// Historical views are bounded by closeBoundary {position, tsMs|null}: event
// append POSITION is the primary ordering authority everywhere two events
// must be ordered; wall-clock timestamps are applicability/consistency
// evidence only.

const {
  normalizeBlockingAuthority
} = require('./ticket-lifecycle-contract');

class TicketBlockingAuthorityError extends TypeError {
  constructor(code, message, references = {}) {
    super(message);
    this.name = 'TicketBlockingAuthorityError';
    this.code = code;
    this.references = references;
  }
}

const BLOCKER_PRECEDENCE = Object.freeze([
  'ticketTriageUnresolved',
  'settledBlockedAttempt',
  'maxAttemptsExhausted',
  'admissionHold',
  'persistedRefusalEventId'
]);

function positiveId(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketBlockingAuthorityError(
      'TICKET_BLOCKING_AUTHORITY_INVALID_INPUT',
      `${label} must be a positive safe integer`
    );
  }
  return parsed;
}

function timeMs(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TicketBlockingAuthorityError(
      'TICKET_BLOCKING_AUTHORITY_INVALID_TIMESTAMP',
      `${label} must be a valid timestamp`
    );
  }
  return date.getTime();
}

function eventPosition(event, label = 'event.position') {
  return positiveId(event.position, label);
}

function eventPayload(event) {
  return event && typeof event.payload === 'object' && event.payload !== null
    ? event.payload
    : {};
}

function maxAttemptsScalar(value, label) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TicketBlockingAuthorityError(
      'TICKET_BLOCKING_AUTHORITY_POLICY_CHAIN_INVALID',
      `${label} must be a positive safe integer or null`
    );
  }
  return parsed;
}

// Complete-chain validation for the ticket-owned maxAttempts history.
// Positions are the canonical mutation order; wall-clock timestamps are NOT
// required to be monotonic (a moved clock must not invalidate an otherwise
// valid append sequence).
function reconstructMaxAttemptsChain({ policyEvents, currentBodyMaxAttempts }) {
  if (!Array.isArray(policyEvents)) {
    throw new TicketBlockingAuthorityError(
      'TICKET_BLOCKING_AUTHORITY_INVALID_INPUT',
      'policyEvents must be an array'
    );
  }
  const events = [...policyEvents].sort((left, right) =>
    eventPosition(left) - eventPosition(right));
  let previousTo = null;
  for (const event of events) {
    const payload = eventPayload(event);
    const from = maxAttemptsScalar(payload.fromMaxAttempts,
      `event ${eventPosition(event)} fromMaxAttempts`);
    const to = maxAttemptsScalar(payload.toMaxAttempts,
      `event ${eventPosition(event)} toMaxAttempts`);
    if (previousTo !== null || events.indexOf(event) > 0) {
      if (from !== previousTo) {
        throw new TicketBlockingAuthorityError(
          'TICKET_BLOCKING_AUTHORITY_POLICY_CHAIN_INVALID',
          `policy chain break at event position ${eventPosition(event)}: ` +
          `fromMaxAttempts ${JSON.stringify(from)} does not equal prior toMaxAttempts ${JSON.stringify(previousTo)}`,
          { position: eventPosition(event) }
        );
      }
    }
    previousTo = to;
  }
  if (events.length > 0) {
    const finalTo = maxAttemptsScalar(
      eventPayload(events[events.length - 1]).toMaxAttempts,
      'final policy event toMaxAttempts');
    const bodyValue = maxAttemptsScalar(currentBodyMaxAttempts,
      'current body executionPolicy.maxAttempts');
    if (finalTo !== bodyValue) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_POLICY_CHAIN_INVALID',
        'final policy event toMaxAttempts does not equal the current Ticket body value',
        { finalTo, bodyValue }
      );
    }
  }
  return Object.freeze({ events, valid: true });
}

// As-of reconstruction. boundaryPosition === null means the live/current view.
function maxAttemptsAsOf({ chainEvents, currentBodyMaxAttempts, boundaryPosition }) {
  if (!Array.isArray(chainEvents)) {
    throw new TicketBlockingAuthorityError(
      'TICKET_BLOCKING_AUTHORITY_INVALID_INPUT',
      'chainEvents must be an array'
    );
  }
  if (chainEvents.length === 0 || boundaryPosition === null || boundaryPosition === undefined) {
    return maxAttemptsScalar(currentBodyMaxAttempts, 'currentBodyMaxAttempts');
  }
  let lastBeforeClose = null;
  for (const event of chainEvents) {
    if (eventPosition(event) < positiveId(boundaryPosition, 'boundaryPosition')) {
      lastBeforeClose = event;
    } else {
      break;
    }
  }
  if (lastBeforeClose !== null) {
    return maxAttemptsScalar(eventPayload(lastBeforeClose).toMaxAttempts,
      'last pre-close policy event toMaxAttempts');
  }
  return maxAttemptsScalar(eventPayload(chainEvents[0]).fromMaxAttempts,
    'first post-close policy event fromMaxAttempts');
}

// executeTicketPlan child creation evidence. The predicate binds ONLY to the
// append-only ticket.created payload; mutable Ticket body prose never
// participates. Callers that can resolve parentTicketId pass knownTicketIds.
//
// spawnPlanId accepts BOTH durable shapes production has emitted: the legacy
// integer id and the composite workflow reference
// `${run.id}:${workflow.id}:${step.id}:transition:${n}` written by
// executeTicketPlanWorkflowAction. The hold binds to PROVENANCE PRESENCE and
// parent identity, never to prose: a missing or blank plan reference is not
// executeTicketPlan provenance; any durable non-blank one is.
function isExecuteTicketPlanCreationEvent(payload, knownTicketIds = null) {
  if (!payload || typeof payload !== 'object') return false;
  const parentTicketId = payload.parentTicketId;
  const parentParsed = typeof parentTicketId === 'string' && /^[1-9]\d*$/.test(parentTicketId)
    ? Number(parentTicketId)
    : parentTicketId;
  if (!Number.isSafeInteger(parentParsed) || parentParsed <= 0) return false;
  if (knownTicketIds && !knownTicketIds.has(parentParsed)) return false;
  if (typeof payload.spawnIdempotencyKey !== 'string' ||
      payload.spawnIdempotencyKey.trim().length === 0) return false;
  const spawnPlanId = payload.spawnPlanId;
  if (spawnPlanId === null || spawnPlanId === undefined) return false;
  if (typeof spawnPlanId === 'string') {
    return spawnPlanId.trim().length > 0;
  }
  return Number.isSafeInteger(spawnPlanId) && spawnPlanId > 0;
}

// A reasoned refusal remains CURRENT only while no qualifying successful
// attempt admission supersedes it by append position within the view.
// Additionally, a refusal whose reason code is PAIRED with a Ticket-triage
// resolution (the feasibility/objective/no-route writer class always writes
// both) is superseded by that class's own durable resolution event
// (ticket.triage_resolved carrying the matching reasonCode). Structured
// planning/leaf refusals have no resolvable triage and therefore keep the
// admission-only supersession path — resolveTicketTriage refuses them as
// TRIAGE_NOT_REQUIRED, so no spurious resolution event can exist.
function refusalSuperseded({
  refusalEvent,
  admissionEvents,
  attempts,
  events = [],
  boundary = null
}) {
  const refusalPosition = eventPosition(refusalEvent);
  const refusalReason = eventPayload(refusalEvent).reasonCode;
  const withinView = position => boundary === null ||
    position <= positiveId(boundary.position, 'boundary.position');
  for (const candidate of events) {
    if (candidate.type !== 'ticket.triage_resolved') continue;
    const candidatePosition = eventPosition(candidate);
    if (candidatePosition <= refusalPosition || !withinView(candidatePosition)) continue;
    const payload = eventPayload(candidate);
    if (payload.triage && typeof payload.triage === 'object' &&
        payload.triage.reasonCode === refusalReason) {
      return true;
    }
  }
  const attemptsById = new Map(attempts.map(attempt => [positiveId(attempt.id, 'attempt.id'), attempt]));
  for (const candidate of admissionEvents) {
    const candidatePosition = eventPosition(candidate);
    if (candidatePosition <= refusalPosition) continue;
    if (boundary && candidatePosition > positiveId(boundary.position, 'boundary.position')) continue;
    const payload = eventPayload(candidate);
    const attemptId = typeof payload.ticketAttemptId === 'string' && /^[1-9]\d*$/.test(payload.ticketAttemptId)
      ? Number(payload.ticketAttemptId)
      : payload.ticketAttemptId;
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
        `admission event at position ${candidatePosition} carries malformed ticketAttemptId`,
        { position: candidatePosition }
      );
    }
    const attempt = attemptsById.get(attemptId);
    if (!attempt) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
        `admission event at position ${candidatePosition} binds no known Ticket attempt`,
        { position: candidatePosition, ticketAttemptId: attemptId }
      );
    }
    if (payload.ordinal !== undefined && payload.ordinal !== null &&
        Number(payload.ordinal) !== attempt.ordinal) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
        `admission event at position ${candidatePosition} ordinal contradicts its attempt row`,
        { position: candidatePosition }
      );
    }
    if (payload.memberCount !== undefined && payload.memberCount !== null &&
        Number(payload.memberCount) !== attempt.memberCount) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
        `admission event at position ${candidatePosition} memberCount contradicts its attempt row`,
        { position: candidatePosition }
      );
    }
    if (boundary && boundary.tsMs !== null && boundary.tsMs !== undefined &&
        attempt.admittedAt !== null && attempt.admittedAt !== undefined &&
        timeMs(attempt.admittedAt, 'attempt.admittedAt') > boundary.tsMs) {
      throw new TicketBlockingAuthorityError(
        'TICKET_BLOCKING_AUTHORITY_ADMISSION_PROVENANCE_INVALID',
        `admission event at position ${candidatePosition} binds an attempt admitted after the close boundary`,
        { position: candidatePosition }
      );
    }
    return true;
  }
  return false;
}

// Compose the normalized blocking-authority input for one Ticket from durable
// facts. Returns { input, won, reference } where input is a
// normalizeBlockingAuthority-shaped object with exactly the winning field
// set, won is the precedence key or null, and reference describes the winning
// durable fact for audit.
function composeBlockingAuthority({
  triage = null,
  attempts = [],
  events = [],
  executionPolicy = null,
  closeBoundary = null,
  knownTicketIds = null
} = {}) {
  const neutral = {
    ticketTriageUnresolved: false,
    persistedRefusalEventId: null,
    maxAttemptsExhausted: false,
    settledBlockedAttempt: null,
    admissionHold: null
  };
  const boundaryTs = closeBoundary && closeBoundary.tsMs !== null && closeBoundary.tsMs !== undefined
    ? closeBoundary.tsMs
    : null;

  // 1. Unresolved ticket-level triage.
  if (triage && typeof triage === 'object' && triage.required === true) {
    const createdAt = triage.createdAt ? timeMs(triage.createdAt, 'triage.createdAt') : null;
    const resolvedAt = triage.resolvedAt ? timeMs(triage.resolvedAt, 'triage.resolvedAt') : null;
    const createdWithinView = createdAt !== null &&
      (boundaryTs === null || createdAt <= boundaryTs);
    const unresolvedInView = resolvedAt === null ||
      (boundaryTs !== null && resolvedAt > boundaryTs);
    if (createdWithinView && unresolvedInView) {
      return {
        input: normalizeBlockingAuthority({ ...neutral, ticketTriageUnresolved: true }),
        won: 'ticketTriageUnresolved',
        reference: Object.freeze({ kind: 'triage', createdAt: triage.createdAt })
      };
    }
  }

  const sortedAttempts = [...attempts].sort((left, right) => left.ordinal - right.ordinal);
  const latestAttempt = sortedAttempts.length > 0 ? sortedAttempts[sortedAttempts.length - 1] : null;

  // 2. Latest/highest settled BLOCKED attempt.
  if (latestAttempt && latestAttempt.disposition === 'blocked' &&
      latestAttempt.settledAt !== null && latestAttempt.settledAt !== undefined &&
      (boundaryTs === null || timeMs(latestAttempt.settledAt, 'attempt.settledAt') <= boundaryTs)) {
    return {
      input: normalizeBlockingAuthority({
        ...neutral,
        settledBlockedAttempt: {
          ticketAttemptId: latestAttempt.id,
          ordinal: latestAttempt.ordinal
        }
      }),
      won: 'settledBlockedAttempt',
      reference: Object.freeze({
        kind: 'settled_blocked_attempt',
        ticketAttemptId: latestAttempt.id,
        ordinal: latestAttempt.ordinal
      })
    };
  }

  // 3. Ticket-owned maxAttempts exhaustion, as-of the boundary.
  const policyEvents = events.filter(event => event.type === 'ticket.execution_policy_updated');
  const chain = reconstructMaxAttemptsChain({
    policyEvents,
    currentBodyMaxAttempts: executionPolicy ? executionPolicy.maxAttempts ?? null : null
  });
  const asOfMaxAttempts = maxAttemptsAsOf({
    chainEvents: chain.events,
    currentBodyMaxAttempts: executionPolicy ? executionPolicy.maxAttempts ?? null : null,
    boundaryPosition: closeBoundary ? closeBoundary.position ?? null : null
  });
  const admittedInView = sortedAttempts.filter(attempt =>
    boundaryTs === null || attempt.admittedAt === null || attempt.admittedAt === undefined ||
    timeMs(attempt.admittedAt, 'attempt.admittedAt') <= boundaryTs);
  if (asOfMaxAttempts !== null && admittedInView.length >= asOfMaxAttempts) {
    return {
      input: normalizeBlockingAuthority({ ...neutral, maxAttemptsExhausted: true }),
      won: 'maxAttemptsExhausted',
      reference: Object.freeze({
        kind: 'max_attempts_exhausted',
        maxAttempts: asOfMaxAttempts,
        admittedCount: admittedInView.length
      })
    };
  }

  // 4. executeTicketPlan admission hold (spawn provenance + zero attempts).
  const holdEvents = events
    .filter(event => event.type === 'ticket.created')
    .filter(event => isExecuteTicketPlanCreationEvent(eventPayload(event), knownTicketIds))
    .sort((left, right) => eventPosition(left) - eventPosition(right));
  if (holdEvents.length > 0 && sortedAttempts.length === 0) {
    const holdEvent = holdEvents[0];
    return {
      input: normalizeBlockingAuthority({
        ...neutral,
        admissionHold: { createdEventId: String(holdEvent.id) }
      }),
      won: 'admissionHold',
      reference: Object.freeze({
        kind: 'admission_hold',
        createdEventId: String(holdEvent.id),
        createdEventPosition: eventPosition(holdEvent)
      })
    };
  }

  // 5. Reasoned structured refusal, current only (position-bounded view).
  const reasonedRefusals = events
    .filter(event => event.type === 'ticket.blocked')
    .filter(event => {
      const reasonCode = eventPayload(event).reasonCode;
      return typeof reasonCode === 'string' && reasonCode.trim().length > 0;
    });
  const eligibleRefusals = closeBoundary
    ? reasonedRefusals.filter(event =>
      eventPosition(event) <= positiveId(closeBoundary.position, 'boundary.position'))
    : reasonedRefusals;
  if (eligibleRefusals.length > 0) {
    const refusal = eligibleRefusals.reduce((latest, event) =>
      eventPosition(event) > eventPosition(latest) ? event : latest);
    const superseded = refusalSuperseded({
      refusalEvent: refusal,
      admissionEvents: events.filter(event => event.type === 'ticket.attempt_admitted'),
      attempts: sortedAttempts,
      events,
      boundary: closeBoundary
    });
    if (!superseded) {
      return {
        input: normalizeBlockingAuthority({
          ...neutral,
          persistedRefusalEventId: String(refusal.id)
        }),
        won: 'persistedRefusalEventId',
        reference: Object.freeze({
          kind: 'refusal_event',
          eventId: String(refusal.id),
          eventPosition: eventPosition(refusal),
          reasonCode: eventPayload(refusal).reasonCode
        })
      };
    }
  }

  return {
    input: normalizeBlockingAuthority(neutral),
    won: null,
    reference: null
  };
}

module.exports = {
  BLOCKER_PRECEDENCE,
  TicketBlockingAuthorityError,
  composeBlockingAuthority,
  reconstructMaxAttemptsChain,
  maxAttemptsAsOf,
  isExecuteTicketPlanCreationEvent,
  refusalSuperseded
};
