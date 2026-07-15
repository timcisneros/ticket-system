'use strict';

const crypto = require('crypto');

const RUN_EVENT_SCHEMA_VERSION = 1;

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
    if (event.schemaVersion !== RUN_EVENT_SCHEMA_VERSION) {
      add('schema_version', `Expected run-event schema ${RUN_EVENT_SCHEMA_VERSION}, got ${event.schemaVersion}`);
    }
    if (typeof event.id !== 'string' || !event.id.trim()) add('missing_id', 'Run event is missing an id');
    if (typeof event.ts !== 'string' || Number.isNaN(Date.parse(event.ts))) add('invalid_timestamp', 'Run event has an invalid timestamp');

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
  canonicalRunEvent,
  computeRunEventHash,
  verifyCurrentRunEventChain
};
