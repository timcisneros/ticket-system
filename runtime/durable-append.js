'use strict';

const fs = require('fs');

const DEFAULT_MAX_RECORD_BYTES = 1024 * 1024;
const DEFAULT_MAX_BATCH_ENTRIES = 256;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTSTANDING_ENTRIES = 4096;
const DEFAULT_MAX_OUTSTANDING_BYTES = 16 * 1024 * 1024;

const EVENT_JOURNAL_ENV = Object.freeze({
  maxRecordBytes: 'EVENT_JOURNAL_MAX_RECORD_BYTES',
  maxBatchEntries: 'EVENT_JOURNAL_MAX_BATCH_ENTRIES',
  maxBatchBytes: 'EVENT_JOURNAL_MAX_BATCH_BYTES',
  maxOutstandingEntries: 'EVENT_JOURNAL_MAX_OUTSTANDING_ENTRIES',
  maxOutstandingBytes: 'EVENT_JOURNAL_MAX_OUTSTANDING_BYTES'
});

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function optionValue(options, key, fallback) {
  return positiveInteger(options[key] === undefined ? fallback : options[key], key);
}

function resolveDurableAppendJournalOptions(env = process.env) {
  const defaults = {
    maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
    maxBatchEntries: DEFAULT_MAX_BATCH_ENTRIES,
    maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
    maxOutstandingEntries: DEFAULT_MAX_OUTSTANDING_ENTRIES,
    maxOutstandingBytes: DEFAULT_MAX_OUTSTANDING_BYTES
  };
  const resolved = {};

  for (const [key, envName] of Object.entries(EVENT_JOURNAL_ENV)) {
    const raw = env[envName];
    if (raw === undefined || String(raw).trim() === '') {
      resolved[key] = defaults[key];
      continue;
    }
    const normalized = String(raw).trim();
    if (!/^[1-9]\d*$/.test(normalized)) {
      throw new TypeError(`${envName} must be a positive integer`);
    }
    resolved[key] = positiveInteger(Number(normalized), envName);
  }

  if (resolved.maxRecordBytes > resolved.maxBatchBytes) {
    throw new TypeError(`${EVENT_JOURNAL_ENV.maxRecordBytes} cannot exceed ${EVENT_JOURNAL_ENV.maxBatchBytes}`);
  }
  if (resolved.maxRecordBytes > resolved.maxOutstandingBytes) {
    throw new TypeError(`${EVENT_JOURNAL_ENV.maxRecordBytes} cannot exceed ${EVENT_JOURNAL_ENV.maxOutstandingBytes}`);
  }

  return resolved;
}

function journalError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

// A single-writer, persistent append journal. Calls made in the same event-loop
// turn are written as a bounded batch and acknowledged only after FileHandle.sync
// completes. This preserves the event durability barrier without running file I/O
// or fsync on Node's main thread.
class DurableAppendJournal {
  constructor(filePath, options = {}) {
    if (!filePath) throw new Error('DurableAppendJournal requires a file path');
    this.filePath = filePath;
    this.fsPromises = options.fsPromises || fs.promises;
    this.schedule = options.schedule || (callback => setImmediate(callback));
    this.maxRecordBytes = optionValue(options, 'maxRecordBytes', DEFAULT_MAX_RECORD_BYTES);
    this.maxBatchEntries = optionValue(options, 'maxBatchEntries', DEFAULT_MAX_BATCH_ENTRIES);
    this.maxBatchBytes = optionValue(options, 'maxBatchBytes', DEFAULT_MAX_BATCH_BYTES);
    this.maxOutstandingEntries = optionValue(options, 'maxOutstandingEntries', DEFAULT_MAX_OUTSTANDING_ENTRIES);
    this.maxOutstandingBytes = optionValue(options, 'maxOutstandingBytes', DEFAULT_MAX_OUTSTANDING_BYTES);
    if (this.maxRecordBytes > this.maxBatchBytes) {
      throw new TypeError('maxRecordBytes cannot exceed maxBatchBytes');
    }
    if (this.maxRecordBytes > this.maxOutstandingBytes) {
      throw new TypeError('maxRecordBytes cannot exceed maxOutstandingBytes');
    }

    this.pending = [];
    this.pendingBytes = 0;
    this.outstandingEntries = 0;
    this.outstandingBytes = 0;
    this.activeBatchEntries = 0;
    this.activeBatchBytes = 0;
    this.handle = null;
    this.openPromise = null;
    this.drainPromise = null;
    this.drainScheduled = false;
    this.flushWaiters = [];
    this.failure = null;
    this.closing = false;
    this.closed = false;
    this.totals = {
      acceptedEntries: 0,
      committedEntries: 0,
      committedBytes: 0,
      commitBatches: 0,
      backpressureRejections: 0,
      oversizedRejections: 0,
      failedEntries: 0
    };
    this.highWatermarks = { outstandingEntries: 0, outstandingBytes: 0 };
    this.lastCommitAt = null;
    this.lastCommitDurationMs = null;
    this.maxCommitDurationMs = 0;
  }

  append(value) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || this.closed) {
      return Promise.reject(journalError('EVENT_JOURNAL_CLOSED', 'Event journal is closed'));
    }

    const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
    if (buffer.length > this.maxRecordBytes) {
      this.totals.oversizedRejections += 1;
      return Promise.reject(journalError(
        'EVENT_JOURNAL_RECORD_TOO_LARGE',
        `Event journal record is ${buffer.length} bytes; limit is ${this.maxRecordBytes}`
      ));
    }
    if (this.outstandingEntries >= this.maxOutstandingEntries || this.outstandingBytes + buffer.length > this.maxOutstandingBytes) {
      this.totals.backpressureRejections += 1;
      return Promise.reject(journalError(
        'EVENT_JOURNAL_BACKPRESSURE',
        `Event journal backlog exceeded ${this.maxOutstandingEntries} unacknowledged records or ${this.maxOutstandingBytes} bytes`
      ));
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.push({ buffer, resolve, reject });
      this.pendingBytes += buffer.length;
      this.outstandingEntries += 1;
      this.outstandingBytes += buffer.length;
      this.totals.acceptedEntries += 1;
      this.highWatermarks.outstandingEntries = Math.max(this.highWatermarks.outstandingEntries, this.outstandingEntries);
      this.highWatermarks.outstandingBytes = Math.max(this.highWatermarks.outstandingBytes, this.outstandingBytes);
    });
    this._scheduleDrain();
    return promise;
  }

  flush() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending.length === 0 && !this.drainPromise && !this.drainScheduled) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.flushWaiters.push({ resolve, reject });
      this._scheduleDrain();
    });
  }

  async close() {
    if (this.closed) {
      if (this.failure) throw this.failure;
      return;
    }
    this.closing = true;
    let closeError = null;
    try {
      await this.flush();
    } catch (error) {
      closeError = error;
    }

    try {
      const handle = this.handle || (this.openPromise ? await this.openPromise : null);
      if (handle) await handle.close();
    } catch (error) {
      if (!closeError) closeError = error;
    } finally {
      this.handle = null;
      this.openPromise = null;
      this.closed = true;
    }

    if (closeError) throw closeError;
  }

  getMetrics() {
    const entryUtilization = this.outstandingEntries / this.maxOutstandingEntries;
    const byteUtilization = this.outstandingBytes / this.maxOutstandingBytes;
    return {
      status: this.failure
        ? 'failed'
        : this.closed
          ? 'closed'
          : this.closing
            ? 'closing'
            : (this.drainScheduled || this.drainPromise || this.outstandingEntries > 0 ? 'committing' : 'idle'),
      config: {
        maxRecordBytes: this.maxRecordBytes,
        maxBatchEntries: this.maxBatchEntries,
        maxBatchBytes: this.maxBatchBytes,
        maxOutstandingEntries: this.maxOutstandingEntries,
        maxOutstandingBytes: this.maxOutstandingBytes
      },
      current: {
        queuedEntries: this.pending.length,
        queuedBytes: this.pendingBytes,
        activeBatchEntries: this.activeBatchEntries,
        activeBatchBytes: this.activeBatchBytes,
        outstandingEntries: this.outstandingEntries,
        outstandingBytes: this.outstandingBytes,
        entryUtilization,
        byteUtilization,
        utilization: Math.max(entryUtilization, byteUtilization)
      },
      highWatermarks: { ...this.highWatermarks },
      totals: { ...this.totals },
      commitTiming: {
        lastCommitAt: this.lastCommitAt,
        lastCommitDurationMs: this.lastCommitDurationMs,
        maxCommitDurationMs: this.maxCommitDurationMs
      },
      failure: this.failure ? { code: this.failure.code, message: this.failure.message } : null
    };
  }

  _scheduleDrain() {
    if (this.failure || this.closed || this.drainScheduled || this.drainPromise || this.pending.length === 0) return;
    this.drainScheduled = true;
    try {
      this.schedule(() => {
        this.drainScheduled = false;
        this.drainPromise = this._drain();
        this.drainPromise.catch(() => {}).finally(() => {
          this.drainPromise = null;
          if (this.pending.length > 0 && !this.failure) this._scheduleDrain();
          this._settleFlushWaiters();
        });
      });
    } catch (error) {
      this.drainScheduled = false;
      this._fail(error);
    }
  }

  async _open() {
    if (this.handle) return this.handle;
    if (!this.openPromise) {
      this.openPromise = this.fsPromises.open(this.filePath, 'a')
        .then(handle => {
          this.handle = handle;
          return handle;
        })
        .finally(() => {
          this.openPromise = null;
        });
    }
    return this.openPromise;
  }

  _takeBatch() {
    let count = 0;
    let bytes = 0;
    for (const entry of this.pending) {
      if (count >= this.maxBatchEntries || bytes + entry.buffer.length > this.maxBatchBytes) break;
      count += 1;
      bytes += entry.buffer.length;
    }
    const batch = this.pending.splice(0, count);
    this.pendingBytes -= bytes;
    return { batch, bytes };
  }

  async _drain() {
    let activeBatch = [];
    try {
      while (this.pending.length > 0) {
        const { batch, bytes } = this._takeBatch();
        activeBatch = batch;
        this.activeBatchEntries = batch.length;
        this.activeBatchBytes = bytes;
        const commitStartedAt = process.hrtime.bigint();
        const data = Buffer.concat(batch.map(entry => entry.buffer), bytes);
        const handle = await this._open();
        let offset = 0;
        while (offset < data.length) {
          const result = await handle.write(data, offset, data.length - offset, null);
          const written = result && result.bytesWritten;
          if (!Number.isInteger(written) || written <= 0) {
            throw new Error(`Durable append made no progress after ${offset} of ${data.length} bytes`);
          }
          offset += written;
        }
        await handle.sync();
        const commitDurationMs = Number(process.hrtime.bigint() - commitStartedAt) / 1e6;
        this.outstandingEntries -= batch.length;
        this.outstandingBytes -= bytes;
        this.activeBatchEntries = 0;
        this.activeBatchBytes = 0;
        this.totals.committedEntries += batch.length;
        this.totals.committedBytes += bytes;
        this.totals.commitBatches += 1;
        this.lastCommitAt = new Date().toISOString();
        this.lastCommitDurationMs = commitDurationMs;
        this.maxCommitDurationMs = Math.max(this.maxCommitDurationMs, commitDurationMs);
        batch.forEach(entry => entry.resolve());
        activeBatch = [];
      }
    } catch (error) {
      this._fail(error, activeBatch);
      throw error;
    }
  }

  _fail(error, activeBatch = []) {
    if (!this.failure) {
      this.failure = journalError(
        'EVENT_JOURNAL_FAILED',
        `Event journal failed: ${error && error.message ? error.message : error}`,
        error
      );
    }
    const pending = [...activeBatch, ...this.pending.splice(0)];
    this.pendingBytes = 0;
    this.activeBatchEntries = 0;
    this.activeBatchBytes = 0;
    this.outstandingEntries = 0;
    this.outstandingBytes = 0;
    this.totals.failedEntries += pending.length;
    pending.forEach(entry => entry.reject(this.failure));
    this._settleFlushWaiters();
  }

  _settleFlushWaiters() {
    if (!this.failure && (this.pending.length > 0 || this.drainPromise || this.drainScheduled)) return;
    const waiters = this.flushWaiters.splice(0);
    waiters.forEach(waiter => {
      if (this.failure) waiter.reject(this.failure);
      else waiter.resolve();
    });
  }
}

function createDurableAppendJournal(filePath, options = {}) {
  return new DurableAppendJournal(filePath, options);
}

module.exports = {
  DurableAppendJournal,
  createDurableAppendJournal,
  resolveDurableAppendJournalOptions,
  EVENT_JOURNAL_ENV,
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_BATCH_ENTRIES,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_OUTSTANDING_ENTRIES,
  DEFAULT_MAX_OUTSTANDING_BYTES
};
