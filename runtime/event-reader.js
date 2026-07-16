'use strict';

// Bounded-memory readers over the append-only event journal. Matching reads
// still scan the file because the development JSONL store has no index, but
// they retain at most one bounded record at a time. Recent reads work backward
// in fixed-size blocks and stop after collecting the requested window.

const fs = require('fs');

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

function eventReadError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function openForRead(filePath, strict) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.openSync(filePath, 'r');
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

function parseEventLine(lineBuffer, byteOffset, strict, onParse) {
  const line = lineBuffer.toString('utf8');
  if (!line.trim()) return null;
  if (typeof onParse === 'function') onParse(line);
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' && !Array.isArray(event) ? event : null;
  } catch (error) {
    if (!strict) return null;
    throw eventReadError(
      'EVENT_PARSE_ERROR',
      `Malformed matching event line at byte ${byteOffset}: ${error.message}`,
      error
    );
  }
}

// Scan in file order, parsing only candidate lines. The file is never loaded
// wholesale; a corrupt or externally-written oversized record is bounded too.
function readMatchingEvents(filePath, {
  needles = [],
  predicate = () => true,
  onParse = null,
  strict = false,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES
} = {}) {
  const fd = openForRead(filePath, strict);
  if (fd === null) return [];

  const events = [];
  const buffer = Buffer.allocUnsafe(DEFAULT_CHUNK_BYTES);
  const parts = [];
  let partBytes = 0;
  let fileOffset = 0;
  let lineOffset = 0;
  let discardingOversizedLine = false;

  function consumeLine() {
    if (discardingOversizedLine) return;
    const lineBuffer = parts.length === 1 ? parts[0] : Buffer.concat(parts, partBytes);
    const rawCandidate = needles.length === 0 || needles.some(needle => lineBuffer.includes(needle));
    if (!rawCandidate) return;
    const event = parseEventLine(lineBuffer, lineOffset, strict, onParse);
    if (event && predicate(event)) events.push(event);
  }

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let segmentStart = 0;

      while (segmentStart < bytesRead) {
        const newline = buffer.indexOf(10, segmentStart);
        const segmentEnd = newline === -1 || newline >= bytesRead ? bytesRead : newline;
        const segmentLength = segmentEnd - segmentStart;

        if (!discardingOversizedLine && segmentLength > 0) {
          if (partBytes + segmentLength > maxLineBytes) {
            if (strict) {
              throw eventReadError(
                'EVENT_RECORD_TOO_LARGE',
                `Event line at byte ${lineOffset} exceeds ${maxLineBytes} bytes`
              );
            }
            discardingOversizedLine = true;
            parts.length = 0;
            partBytes = 0;
          } else {
            parts.push(Buffer.from(buffer.subarray(segmentStart, segmentEnd)));
            partBytes += segmentLength;
          }
        }

        if (newline === -1 || newline >= bytesRead) break;
        consumeLine();
        parts.length = 0;
        partBytes = 0;
        discardingOversizedLine = false;
        lineOffset = fileOffset + newline + 1;
        segmentStart = newline + 1;
      }

      fileOffset += bytesRead;
    }

    if (partBytes > 0 || discardingOversizedLine) consumeLine();
    return events;
  } finally {
    fs.closeSync(fd);
  }
}

function parseRecentLine(lineBuffer) {
  const line = lineBuffer.toString('utf8').trim();
  if (!line) return null;
  try {
    const event = JSON.parse(line);
    return event && typeof event === 'object' && !Array.isArray(event) ? event : null;
  } catch (_) {
    return null;
  }
}

// Read newest records first in fixed-size blocks, then return the selected
// window in file order. A partial line is capped at maxLineBytes.
function readRecentEvents(filePath, limit, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const fd = openForRead(filePath, false);
  if (fd === null) return [];

  const newestFirst = [];
  let position;
  try {
    position = fs.fstatSync(fd).size;
  } catch (_) {
    fs.closeSync(fd);
    return [];
  }

  let partial = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let isFileTail = true;

  try {
    while (position > 0 && newestFirst.length < limit) {
      const readStart = Math.max(0, position - DEFAULT_CHUNK_BYTES);
      const bytesToRead = position - readStart;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      fs.readSync(fd, chunk, 0, bytesToRead, readStart);
      position = readStart;

      let data = chunk;
      if (discardingOversizedLine) {
        const boundary = data.lastIndexOf(10);
        if (boundary === -1) continue;
        data = data.subarray(0, boundary);
        discardingOversizedLine = false;
      } else if (partial.length > 0) {
        data = Buffer.concat([data, partial]);
      }

      let end = data.length;
      if (isFileTail) {
        while (end > 0 && (data[end - 1] === 10 || data[end - 1] === 13)) end -= 1;
        isFileTail = false;
      }

      while (end > 0 && newestFirst.length < limit) {
        const newline = data.lastIndexOf(10, end - 1);
        if (newline === -1) break;
        const event = parseRecentLine(data.subarray(newline + 1, end));
        if (event) newestFirst.push(event);
        end = newline;
      }

      partial = Buffer.from(data.subarray(0, end));
      if (partial.length > maxLineBytes) {
        partial = Buffer.alloc(0);
        discardingOversizedLine = true;
      }
    }

    if (position === 0 && newestFirst.length < limit && !discardingOversizedLine && partial.length > 0) {
      const event = parseRecentLine(partial);
      if (event) newestFirst.push(event);
    }
    return newestFirst.reverse();
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  readMatchingEvents,
  readRecentEvents
};
