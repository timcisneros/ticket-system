#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDurableAppendJournal, resolveDurableAppendJournalOptions } = require('../runtime/durable-append');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(operation, pattern, message) {
  try {
    operation();
  } catch (error) {
    if (pattern.test(error.message)) return;
    throw new Error(`${message}: ${error.message}`);
  }
  throw new Error(message);
}

function testValidatedConfiguration() {
  const configured = resolveDurableAppendJournalOptions({
    EVENT_JOURNAL_MAX_RECORD_BYTES: '1024',
    EVENT_JOURNAL_MAX_BATCH_ENTRIES: '32',
    EVENT_JOURNAL_MAX_BATCH_BYTES: '4096',
    EVENT_JOURNAL_MAX_OUTSTANDING_ENTRIES: '512',
    EVENT_JOURNAL_MAX_OUTSTANDING_BYTES: '8192'
  });
  assert(configured.maxRecordBytes === 1024, 'record capacity override was not resolved');
  assert(configured.maxBatchEntries === 32, 'batch entry override was not resolved');
  assert(configured.maxOutstandingEntries === 512, 'outstanding entry override was not resolved');
  assertThrows(
    () => resolveDurableAppendJournalOptions({ EVENT_JOURNAL_MAX_BATCH_ENTRIES: '0' }),
    /positive integer/,
    'zero-valued journal configuration was not rejected'
  );
  assertThrows(
    () => resolveDurableAppendJournalOptions({
      EVENT_JOURNAL_MAX_RECORD_BYTES: '2048',
      EVENT_JOURNAL_MAX_BATCH_BYTES: '1024'
    }),
    /cannot exceed/,
    'record capacity larger than batch capacity was not rejected'
  );
}

function createFakeFs({ partialWriteSize = Infinity, syncImpl = async () => {} } = {}) {
  const calls = [];
  const bytes = [];
  const handle = {
    async write(buffer, offset, length) {
      const written = Math.min(partialWriteSize, length);
      calls.push(`write:${offset}:${written}`);
      bytes.push(...buffer.subarray(offset, offset + written));
      return { bytesWritten: written };
    },
    async sync() {
      calls.push('sync');
      await syncImpl();
    },
    async close() {
      calls.push('close');
    }
  };
  return {
    calls,
    bytes,
    api: {
      async open(filePath, flags) {
        calls.push(`open:${filePath}:${flags}`);
        return handle;
      }
    }
  };
}

async function testGroupCommitAndPartialWrites() {
  const fake = createFakeFs({ partialWriteSize: 3 });
  const journal = createDurableAppendJournal('/events.jsonl', { fsPromises: fake.api });
  await Promise.all([
    journal.append('one\n'),
    journal.append('two\n'),
    journal.append('three\n')
  ]);
  assert(Buffer.from(fake.bytes).toString('utf8') === 'one\ntwo\nthree\n', 'group commit did not preserve complete records in order');
  assert(fake.calls[0] === 'open:/events.jsonl:a', 'journal was not opened in append mode');
  assert(fake.calls.filter(call => call === 'sync').length === 1, 'same-turn appends were not committed with one sync');
  await journal.close();
  assert(fake.calls.at(-1) === 'close', 'persistent descriptor was not closed');
}

async function testAcknowledgementWaitsForSyncWithoutBlockingTimers() {
  let releaseSync;
  let syncStarted = false;
  const fake = createFakeFs({
    syncImpl: () => new Promise(resolve => {
      syncStarted = true;
      releaseSync = resolve;
    })
  });
  const journal = createDurableAppendJournal('/events.jsonl', {
    fsPromises: fake.api,
    maxOutstandingEntries: 1
  });
  let acknowledged = false;
  const appendPromise = journal.append('event\n').then(() => { acknowledged = true; });

  await new Promise(resolve => setImmediate(resolve));
  assert(syncStarted, 'journal did not begin the scheduled sync');
  assert(!acknowledged, 'append acknowledged before sync completed');
  const inFlight = journal.getMetrics();
  assert(inFlight.status === 'committing', 'in-flight journal status was not observable');
  assert(inFlight.current.activeBatchEntries === 1 && inFlight.current.outstandingEntries === 1, 'active durable work was omitted from journal pressure');
  const activeOverflow = await journal.append('second\n').then(() => null, error => error);
  assert(activeOverflow && activeOverflow.code === 'EVENT_JOURNAL_BACKPRESSURE', 'active sync work was omitted from the outstanding-work capacity check');

  let timerRan = false;
  await new Promise(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
  assert(timerRan && !acknowledged, 'in-flight sync blocked the event loop or acknowledged early');

  releaseSync();
  await appendPromise;
  assert(acknowledged, 'append did not acknowledge after sync completed');
  const committed = journal.getMetrics();
  assert(committed.current.outstandingEntries === 0, 'committed entry remained in journal pressure');
  assert(committed.totals.committedEntries === 1 && committed.totals.commitBatches === 1, 'commit totals were not recorded');
  assert(committed.commitTiming.lastCommitDurationMs !== null, 'commit latency was not recorded');
  await journal.close();
}

async function testFlushFailureFailsClosed() {
  const flushError = new Error('flush failed');
  const fake = createFakeFs({ syncImpl: async () => { throw flushError; } });
  const journal = createDurableAppendJournal('/events.jsonl', { fsPromises: fake.api });
  const first = journal.append('one\n');
  const second = journal.append('two\n');

  const settled = await Promise.allSettled([first, second]);
  assert(settled.every(result => result.status === 'rejected'), 'flush failure did not reject the whole active batch');
  const later = await journal.append('three\n').then(() => null, error => error);
  assert(later && later.code === 'EVENT_JOURNAL_FAILED', 'journal accepted an append after a flush failure');
  await journal.close().catch(() => {});
  assert(fake.calls.at(-1) === 'close', 'persistent descriptor was not closed after a flush failure');
}

async function testBoundedBackpressure() {
  const scheduled = [];
  const fake = createFakeFs();
  const journal = createDurableAppendJournal('/events.jsonl', {
    fsPromises: fake.api,
    schedule: callback => scheduled.push(callback),
    maxOutstandingEntries: 2
  });
  const first = journal.append('one\n');
  const second = journal.append('two\n');
  const overflow = await journal.append('three\n').then(() => null, error => error);
  assert(overflow && overflow.code === 'EVENT_JOURNAL_BACKPRESSURE', 'journal backlog was not bounded');
  const saturated = journal.getMetrics();
  assert(saturated.current.outstandingEntries === 2 && saturated.current.entryUtilization === 1, 'journal saturation was not observable');
  assert(saturated.highWatermarks.outstandingEntries === 2, 'journal high-water mark was not recorded');
  assert(saturated.totals.backpressureRejections === 1, 'backpressure rejection was not counted');
  scheduled.shift()();
  await Promise.all([first, second]);
  await journal.close();
}

async function testRecordLimitIsIndependentFromBatchCapacity() {
  const fake = createFakeFs();
  const journal = createDurableAppendJournal('/events.jsonl', {
    fsPromises: fake.api,
    maxRecordBytes: 4,
    maxBatchBytes: 8
  });
  const oversized = await journal.append('12345').then(() => null, error => error);
  assert(oversized && oversized.code === 'EVENT_JOURNAL_RECORD_TOO_LARGE', 'record limit did not reject an oversized event');
  assert(journal.getMetrics().totals.oversizedRejections === 1, 'oversized rejection was not counted');
  await journal.close();
}

async function testRealFileAppend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-event-append-'));
  const file = path.join(dir, 'events.jsonl');
  const journal = createDurableAppendJournal(file);
  try {
    await Promise.all([journal.append('one\n'), journal.append('two\n')]);
    await journal.close();
    assert(fs.readFileSync(file, 'utf8') === 'one\ntwo\n', 'real durable appends were not preserved in order');
  } finally {
    await journal.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testValidatedConfiguration();
  await testGroupCommitAndPartialWrites();
  await testAcknowledgementWaitsForSyncWithoutBlockingTimers();
  await testFlushFailureFailsClosed();
  await testBoundedBackpressure();
  await testRecordLimitIsIndependentFromBatchCapacity();
  await testRealFileAppend();
  console.log('PASS: event journal batches appends, awaits async sync, preserves order, bounds backlog, and fails closed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
