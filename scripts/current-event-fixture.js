'use strict';

const { RUN_EVENT_SCHEMA_VERSION, computeRunEventHash } = require('../runtime/event-integrity');

function sealCurrentRunEventChains(events) {
  const chains = new Map();
  return (events || []).map((source, index) => {
    const event = {
      ...source,
      schemaVersion: RUN_EVENT_SCHEMA_VERSION,
      id: typeof source.id === 'string' && source.id ? source.id : `fixture-event-${index}`,
      ts: typeof source.ts === 'string' && source.ts ? source.ts : new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString(),
      ticketId: source.ticketId === undefined ? null : source.ticketId,
      runId: source.runId === undefined ? null : source.runId,
      stepId: source.stepId === undefined ? null : source.stepId,
      payload: source.payload && typeof source.payload === 'object' ? source.payload : {}
    };

    if (event.runId === undefined || event.runId === null) {
      delete event.seq;
      delete event.prevHash;
      delete event.hash;
      return event;
    }

    const chain = chains.get(event.runId) || { seq: 0, prevHash: null };
    event.seq = chain.seq;
    event.prevHash = chain.prevHash;
    event.hash = computeRunEventHash(event);
    chains.set(event.runId, { seq: chain.seq + 1, prevHash: event.hash });
    return event;
  });
}

module.exports = { sealCurrentRunEventChains };
