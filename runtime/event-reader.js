// Bounded readers over the append-only events.jsonl log.
//
// The evidence log is append-only and can grow large (the historical file is
// ~30 MB / 172k lines, dominated by scheduler heartbeat events). Normal
// UI/API requests only ever need the events for a single run, so parsing the
// entire file on every request is wasted work. These helpers parse only the
// lines that can possibly be relevant:
//
//   readMatchingEvents — JSON.parse only lines that pass a cheap raw-substring
//                        prefilter, then apply an exact predicate. Used for
//                        run/ticket-scoped reads.
//   readRecentEvents   — return just the newest `limit` events by scanning
//                        backward from end of file, parsing only the tail.
//
// These do not change storage, ordering, or event semantics. They never drop a
// relevant event: the prefilter is a safe superset (the writer serializes each
// event with `"runId":N` / `"ticketId":N` and no whitespace, so any line that
// truly matches contains the needle), and the exact predicate runs after parse.

const fs = require('fs');

function readFileSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return null;
  }
}

// Parse only lines that contain at least one `needle` (or every line when no
// needles are given), keeping those for which `predicate(event)` is true.
// `onParse`, when provided, is invoked once per line that is actually parsed —
// exposed so tests can assert that irrelevant lines are not parsed.
// Returns events in file order.
function readMatchingEvents(filePath, { needles = [], predicate = () => true, onParse = null } = {}) {
  const raw = readFileSafe(filePath);
  if (raw === null) return [];

  const lineMightMatch = needles.length === 0
    ? () => true
    : line => needles.some(needle => line.includes(needle));

  const events = [];
  let start = 0;
  while (start <= raw.length) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    if (end > start) {
      const line = raw.slice(start, end);
      if (line.trim() && lineMightMatch(line)) {
        if (typeof onParse === 'function') onParse(line);
        let event = null;
        try {
          event = JSON.parse(line);
        } catch (error) {
          event = null;
        }
        if (event && typeof event === 'object' && predicate(event)) {
          events.push(event);
        }
      }
    }
    if (end === raw.length) break;
    start = end + 1;
  }
  return events;
}

// Return the newest `limit` events (oldest→newest within that window) by
// scanning backward from the end of the file, parsing only the tail lines.
function readRecentEvents(filePath, limit) {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const raw = readFileSafe(filePath);
  if (raw === null) return [];

  const newestFirst = [];
  let end = raw.length;
  // Ignore a trailing newline so the final line is not treated as empty.
  while (end > 0 && (raw[end - 1] === '\n' || raw[end - 1] === '\r')) end -= 1;

  while (end > 0 && newestFirst.length < limit) {
    const nl = raw.lastIndexOf('\n', end - 1);
    const lineStart = nl === -1 ? 0 : nl + 1;
    const line = raw.slice(lineStart, end).trim();
    if (line) {
      try {
        const event = JSON.parse(line);
        if (event && typeof event === 'object') newestFirst.push(event);
      } catch (error) {
        // skip unparseable trailing line
      }
    }
    end = nl === -1 ? 0 : nl;
  }

  return newestFirst.reverse();
}

module.exports = {
  readMatchingEvents,
  readRecentEvents
};
