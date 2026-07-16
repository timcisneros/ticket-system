'use strict';

const fs = require('fs');

const DEFAULT_MAX_BATCH_ENTRIES = 256;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_ENTRIES = 4096;
const DEFAULT_MAX_PENDING_BYTES = 16 * 1024 * 1024;

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
    this.maxBatchEntries = options.maxBatchEntries || DEFAULT_MAX_BATCH_ENTRIES;
    this.maxBatchBytes = options.maxBatchBytes || DEFAULT_MAX_BATCH_BYTES;
    this.maxPendingEntries = options.maxPendingEntries || DEFAULT_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = options.maxPendingBytes || DEFAULT_MAX_PENDING_BYTES;

    this.pending = [];
    this.pendingBytes = 0;
    this.handle = null;
    this.openPromise = null;
    this.drainPromise = null;
    this.drainScheduled = false;
    this.flushWaiters = [];
    this.failure = null;
    this.closing = false;
    this.closed = false;
  }

  append(value) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing || this.closed) {
      return Promise.reject(journalError('EVENT_JOURNAL_CLOSED', 'Event journal is closed'));
    }

    const buffer = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value), 'utf8');
    if (buffer.length > this.maxBatchBytes) {
      return Promise.reject(journalError(
        'EVENT_JOURNAL_RECORD_TOO_LARGE',
        `Event journal record is ${buffer.length} bytes; limit is ${this.maxBatchBytes}`
      ));
    }
    if (this.pending.length >= this.maxPendingEntries || this.pendingBytes + buffer.length > this.maxPendingBytes) {
      return Promise.reject(journalError(
        'EVENT_JOURNAL_BACKPRESSURE',
        `Event journal backlog exceeded ${this.maxPendingEntries} records or ${this.maxPendingBytes} bytes`
      ));
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.push({ buffer, resolve, reject });
      this.pendingBytes += buffer.length;
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
  DEFAULT_MAX_BATCH_ENTRIES,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_PENDING_ENTRIES,
  DEFAULT_MAX_PENDING_BYTES
};
