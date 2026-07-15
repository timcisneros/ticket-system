'use strict';

const crypto = require('crypto');

const RUN_EVENT_SCHEMA_VERSION = 1;

function isCurrentEventIntegerId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateCurrentEventEnvelope(event) {
  const errors = [];
  const add = (type, message) => errors.push({ type, message });

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    add('event_shape', 'Event must be an object');
    return errors;
  }
  if (event.schemaVersion !== RUN_EVENT_SCHEMA_VERSION) {
    add('schema_version', `Expected event schema ${RUN_EVENT_SCHEMA_VERSION}, got ${event.schemaVersion}`);
  }
  if (typeof event.id !== 'string' || !event.id.trim()) add('missing_id', 'Event is missing an id');
  const currentTimestamp = typeof event.ts === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,9}Z$/.test(event.ts) &&
    !Number.isNaN(Date.parse(event.ts));
  if (!currentTimestamp) add('invalid_timestamp', 'Event timestamp must be an ISO-8601 UTC timestamp');
  if (typeof event.type !== 'string' || !event.type.trim()) add('invalid_type', 'Event has an invalid type');
  if (event.ticketId !== null && !isCurrentEventIntegerId(event.ticketId)) add('invalid_ticket_id', 'Event has an invalid ticketId');
  if (event.runId !== null && !isCurrentEventIntegerId(event.runId)) add('invalid_run_id', 'Event has an invalid runId');
  if (event.stepId !== null && typeof event.stepId !== 'string') add('invalid_step_id', 'Event has an invalid stepId');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) add('invalid_payload', 'Event payload must be an object');
  if (event.runId === null && (event.seq !== undefined || event.prevHash !== undefined || event.hash !== undefined)) {
    add('unexpected_chain_fields', 'Non-run event contains run-chain fields');
  }

  return errors;
}

function canonicalRunEvent(event) {
  return {
    schemaVersion: event.schemaVersion,
    id: event.id,
    ts: event.ts,
    type: event.type,
    ticketId: event.ticketId,
    runId: event.runId,
    stepId: event.stepId,
    seq: event.seq,
    prevHash: event.prevHash,
    payload: event.payload
  };
}

function computeRunEventHash(event) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalRunEvent(event)))
    .digest('hex');
}

function verifyCurrentRunEventChain(events) {
  const errors = [];
  const seenIds = new Set();
  const seenSeqs = new Set();
  let lastVerifiedSeq = null;
  let lastVerifiedHash = null;

  (events || []).forEach((event, index) => {
    const seq = event && event.seq;
    const expectedPrevHash = index === 0 ? null : events[index - 1] && events[index - 1].hash;
    const eventErrors = [];
    const add = (type, message, detail = {}) => {
      const error = { index, type, seq: Number.isInteger(seq) ? seq : null, message, ...detail };
      errors.push(error);
      eventErrors.push(error);
    };

    if (!event || event._parseError) {
      add('parse', 'Event is not valid JSON');
      return;
    }
    validateCurrentEventEnvelope(event).forEach(error => add(error.type, error.message));
    if (typeof event.id === 'string' && event.id.trim()) {
      if (seenIds.has(event.id)) add('duplicate_id', `Duplicate event id ${event.id}`);
      seenIds.add(event.id);
    }

    if (!Number.isInteger(seq) || seq < 0) {
      add('missing_seq', 'Run event is missing a non-negative integer seq');
    } else {
      if (seenSeqs.has(seq)) add('duplicate_seq', `Duplicate seq ${seq}`);
      seenSeqs.add(seq);
      if (seq !== index) {
        const type = seq < index ? 'duplicate_seq' : index === 0 ? 'first_seq' : 'seq_gap';
        if (!eventErrors.some(error => error.type === type)) add(type, `Expected seq ${index}, got ${seq}`);
      }
    }

    if (event.prevHash !== expectedPrevHash) {
      add(index === 0 ? 'first_prevhash' : 'prevhash_mismatch', `Expected prevHash ${expectedPrevHash}, got ${event.prevHash}`, {
        expected: expectedPrevHash,
        got: event.prevHash
      });
    }

    const expectedHash = computeRunEventHash(event);
    if (typeof event.hash !== 'string') {
      add('missing_hash', 'Run event is not sealed');
    } else if (event.hash !== expectedHash) {
      add('hash_mismatch', `Stored hash mismatch at seq ${seq}`, { expected: expectedHash, got: event.hash });
    }

    if (eventErrors.length === 0) {
      lastVerifiedSeq = seq;
      lastVerifiedHash = event.hash;
    }
  });

  return {
    chainValid: errors.length === 0,
    errors,
    lastVerifiedSeq,
    lastVerifiedHash
  };
}

module.exports = {
  RUN_EVENT_SCHEMA_VERSION,
  isCurrentEventIntegerId,
  validateCurrentEventEnvelope,
  canonicalRunEvent,
  computeRunEventHash,
  verifyCurrentRunEventChain
};
