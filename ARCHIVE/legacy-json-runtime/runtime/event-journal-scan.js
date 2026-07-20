'use strict';

const fs = require('fs');
const {
  computeRunEventHash,
  validateCurrentEventEnvelope
} = require('./event-integrity');

// Validate the current append-only journal without materializing it. Memory is
// proportional to the number of run-chain tips, not the number or byte size of
// historical events.
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

async function scanCurrentEventJournal(filePath, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  const states = new Map();
  let eventCount = 0;

  if (!fs.existsSync(filePath)) return { states, eventCount };

  const input = fs.createReadStream(filePath);
  let lineNumber = 0;
  let parts = [];
  let partBytes = 0;

  function consumeLine() {
    lineNumber += 1;
    const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes)).toString('utf8');
    parts = [];
    partBytes = 0;
    if (!line.trim()) return;

    let event;
    try {
      event = JSON.parse(line);
    } catch (_) {
      throw new Error(`line ${lineNumber} is not valid JSON`);
    }

    const envelopeErrors = validateCurrentEventEnvelope(event);
    if (envelopeErrors.length > 0) {
      throw new Error(`line ${lineNumber}: ${envelopeErrors[0].message}`);
    }
    eventCount += 1;

    if (event.runId === null) return;
    if (!Number.isInteger(event.seq) || event.seq < 0) {
      throw new Error(`line ${lineNumber} has an invalid run-event sequence`);
    }
    if (typeof event.hash !== 'string' || event.hash !== computeRunEventHash(event)) {
      throw new Error(`line ${lineNumber} has an invalid event hash`);
    }

    const state = states.get(event.runId) || { nextSeq: 0, previousHash: null };
    if (event.seq !== state.nextSeq) {
      throw new Error(`line ${lineNumber} breaks run ${event.runId} sequence continuity`);
    }
    if (event.prevHash !== state.previousHash) {
      throw new Error(`line ${lineNumber} breaks run ${event.runId} hash linkage`);
    }

    states.set(event.runId, {
      nextSeq: state.nextSeq + 1,
      previousHash: event.hash
    });
  }

  try {
    for await (const chunk of input) {
      let segmentStart = 0;
      while (segmentStart < chunk.length) {
        const newline = chunk.indexOf(10, segmentStart);
        const segmentEnd = newline === -1 ? chunk.length : newline;
        const segmentLength = segmentEnd - segmentStart;
        if (partBytes + segmentLength > maxLineBytes) {
          throw new Error(`line ${lineNumber + 1} exceeds ${maxLineBytes} bytes`);
        }
        if (segmentLength > 0) {
          parts.push(Buffer.from(chunk.subarray(segmentStart, segmentEnd)));
          partBytes += segmentLength;
        }
        if (newline === -1) break;
        consumeLine();
        segmentStart = newline + 1;
      }
    }
    if (partBytes > 0) consumeLine();
  } finally {
    input.destroy();
  }

  return { states, eventCount };
}

module.exports = {
  scanCurrentEventJournal
};
