'use strict';

// Tranche 6 — the append-only journal of a live matrix run.
//
// WHAT IT IS FOR, AND WHAT IT IS NOT. The journal answers exactly one question:
//
//   which frozen slot has been ACCEPTED into THIS scored live corpus?
//
// It is orchestration truth, not product truth. Whether a Ticket completed,
// whether a Run mutated the workspace, whether the oracle passed — all of that
// is owned by durable Ticket/Run state and by the immutable trial artifact, and
// the journal never restates it. A journal that started carrying product facts
// would become a second, weaker copy of the evidence, and the two would drift.
//
// APPEND ONLY, HASH CHAINED. Every record binds the run header, the manifest,
// the trial identity and the hash of the record before it. A rewritten history
// therefore breaks the chain rather than silently replacing what happened. That
// matters most on resume: the whole point is to know what was already accepted
// without trusting the filesystem's mtimes or a summary someone could edit.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The smallest vocabulary that covers the lifecycle the executor must survive a
// crash inside. Each names a durable boundary, not a step in a happy path.
const JOURNAL_EVENTS = Object.freeze([
  'assigned',                  // the slot exists in the frozen manifest
  'reservation_committed',     // liability is durably committed; transport MAY become reachable
  'trial_started',             // a process capable of provider contact was spawned
  'product_terminal_or_stable', // the product reached quiescence or truthful failure
  'infrastructure_excluded',   // the frozen predicate classified it out of the corpus
  'artifact_committed',        // the immutable artifact is on disk
  'slot_accepted',             // this slot is now part of the corpus, once and forever
  'run_paused',
  'run_complete'
]);

const TERMINAL_ACCEPTANCE = Object.freeze(['slot_accepted', 'infrastructure_excluded']);

class LiveJournalError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveJournalError';
    this.code = detail.code || 'LIVE_JOURNAL_INVALID';
    this.detail = detail;
  }
}

function journalPath(outputRoot) {
  return path.join(outputRoot, 'live-run-journal.jsonl');
}

function recordHash(record) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(record)).digest('hex');
}

function readJournal(outputRoot) {
  const file = journalPath(outputRoot);
  if (!fs.existsSync(file)) return Object.freeze({ records: Object.freeze([]), tipHash: null });
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new LiveJournalError(`journal line ${index + 1} is unparseable`,
          { code: 'LIVE_JOURNAL_UNREADABLE', line: index + 1 });
      }
    });
  // THE CHAIN IS VERIFIED ON EVERY READ. A resume that trusted an edited
  // journal would rerun accepted slots or skip unexecuted ones.
  let previous = null;
  for (const [index, record] of records.entries()) {
    const { entryHash, ...body } = record;
    if (body.previousHash !== previous) {
      throw new LiveJournalError(
        `journal record ${index + 1} does not follow its predecessor`,
        { code: 'LIVE_JOURNAL_CHAIN_BROKEN', index: index + 1 });
    }
    if (entryHash !== recordHash(body)) {
      throw new LiveJournalError(`journal record ${index + 1} has been rewritten`,
        { code: 'LIVE_JOURNAL_REWRITTEN', index: index + 1 });
    }
    previous = entryHash;
  }
  return Object.freeze({ records: Object.freeze(records), tipHash: previous });
}

function appendJournal(outputRoot, entry) {
  if (!JOURNAL_EVENTS.includes(entry.event)) {
    throw new LiveJournalError(`unknown journal event ${String(entry.event)}`,
      { code: 'LIVE_JOURNAL_EVENT_UNKNOWN', event: entry.event });
  }
  for (const field of ['runHeaderHash', 'manifestHash']) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      throw new LiveJournalError(`a journal entry must bind ${field}`,
        { code: 'LIVE_JOURNAL_UNBOUND', field });
    }
  }
  const { tipHash, records } = readJournal(outputRoot);

  // ONE ACCEPTANCE PER SLOT, FOREVER. A duplicate acceptance is how a corpus
  // silently grows a 121st result, or replaces an exclusion with a retry.
  if (TERMINAL_ACCEPTANCE.includes(entry.event)) {
    const already = records.find(record =>
      TERMINAL_ACCEPTANCE.includes(record.event) && record.trialId === entry.trialId);
    if (already) {
      throw new LiveJournalError(
        `slot ${entry.trialId} was already accepted as ${already.event}; a slot ` +
        'is accepted exactly once and is never replaced',
        { code: 'LIVE_JOURNAL_DUPLICATE_ACCEPTANCE', trialId: entry.trialId,
          existing: already.event });
    }
  }
  const body = { ...entry, previousHash: tipHash, at: new Date().toISOString() };
  const written = { ...body, entryHash: recordHash(body) };
  const handle = fs.openSync(journalPath(outputRoot), 'a');
  try {
    fs.writeSync(handle, `${JSON.stringify(written)}\n`);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  return Object.freeze(written);
}

// The set of slots already in the corpus, and how each got there.
function acceptedSlots(outputRoot) {
  const accepted = new Map();
  for (const record of readJournal(outputRoot).records) {
    if (TERMINAL_ACCEPTANCE.includes(record.event)) {
      accepted.set(record.trialId, record.event);
    }
  }
  return accepted;
}

// A slot whose reservation was committed but which never reached acceptance.
// The executor must resolve these through the canonical release proof rather
// than assuming either direction.
function unresolvedReservations(outputRoot) {
  const reserved = new Map();
  for (const record of readJournal(outputRoot).records) {
    if (record.event === 'reservation_committed') reserved.set(record.trialId, record);
    if (TERMINAL_ACCEPTANCE.includes(record.event)) reserved.delete(record.trialId);
  }
  return reserved;
}

module.exports = {
  JOURNAL_EVENTS,
  LiveJournalError,
  TERMINAL_ACCEPTANCE,
  acceptedSlots,
  appendJournal,
  journalPath,
  readJournal,
  unresolvedReservations
};
