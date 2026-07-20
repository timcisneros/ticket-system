'use strict';

function positiveInteger(value, fallback, label) {
  const parsed = Number.parseInt(String(value || ''), 10);
  const result = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return result;
}

function resolveMutationAdmissionOptions(env = process.env) {
  const maxOutstanding = positiveInteger(env.MUTATION_ADMISSION_MAX_OUTSTANDING, 256, 'MUTATION_ADMISSION_MAX_OUTSTANDING');
  const maxReservationBytes = positiveInteger(env.MUTATION_ADMISSION_MAX_RESERVATION_BYTES, 2 * 1024 * 1024, 'MUTATION_ADMISSION_MAX_RESERVATION_BYTES');
  const maxOutstandingBytes = positiveInteger(
    env.MUTATION_ADMISSION_MAX_OUTSTANDING_BYTES,
    maxOutstanding * maxReservationBytes,
    'MUTATION_ADMISSION_MAX_OUTSTANDING_BYTES'
  );
  return Object.freeze({ maxOutstanding, maxReservationBytes, maxOutstandingBytes });
}

function createMutationAdmissionController(options = resolveMutationAdmissionOptions()) {
  let outstanding = 0;
  let outstandingBytes = 0;
  let admissionVersion = 0;
  let closed = false;
  let acquired = 0;
  let released = 0;
  let rejected = 0;
  let oversizedRejected = 0;
  let highOutstanding = 0;
  let highOutstandingBytes = 0;
  const waiters = new Set();
  const tokens = new Set();

  function signalChange() {
    admissionVersion += 1;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  function tryAcquireAdmission(metadata = {}, reservationBytes = options.maxReservationBytes) {
    if (closed) { rejected += 1; return null; }
    const bytes = positiveInteger(reservationBytes, options.maxReservationBytes, 'reservationBytes');
    if (bytes > options.maxReservationBytes) { rejected += 1; oversizedRejected += 1; return null; }
    if (outstanding >= options.maxOutstanding || outstandingBytes + bytes > options.maxOutstandingBytes) {
      rejected += 1;
      return null;
    }
    const token = Object.freeze({ id: Symbol('mutation-admission'), bytes, metadata: { ...metadata } });
    tokens.add(token);
    outstanding += 1;
    outstandingBytes += bytes;
    acquired += 1;
    highOutstanding = Math.max(highOutstanding, outstanding);
    highOutstandingBytes = Math.max(highOutstandingBytes, outstandingBytes);
    return token;
  }

  function releaseAdmission(token) {
    if (!tokens.delete(token)) return false;
    outstanding -= 1;
    outstandingBytes -= token.bytes;
    released += 1;
    signalChange();
    return true;
  }

  function waitForAdmissionChange(version) {
    if (version !== admissionVersion || closed) return Promise.resolve();
    return new Promise(resolve => waiters.add(resolve));
  }

  async function close() {
    closed = true;
    signalChange();
  }

  return {
    maxRecordBytes: options.maxReservationBytes,
    tryAcquireAdmission,
    releaseAdmission,
    waitForAdmissionChange,
    isBackpressured: () => outstanding >= options.maxOutstanding || outstandingBytes >= options.maxOutstandingBytes,
    getMetrics: () => {
      const backpressured = outstanding >= options.maxOutstanding || outstandingBytes >= options.maxOutstandingBytes;
      return {
        backend: 'postgres',
        role: 'mutation_admission',
        scope: 'process',
        status: closed ? 'closed' : backpressured ? 'backpressured' : 'available',
        current: {
          outstanding,
          outstandingBytes,
          availableSlots: Math.max(0, options.maxOutstanding - outstanding),
          availableBytes: Math.max(0, options.maxOutstandingBytes - outstandingBytes),
          backpressured,
          utilization: Math.max(outstanding / options.maxOutstanding, outstandingBytes / options.maxOutstandingBytes)
        },
        limits: {
          maxOutstanding: options.maxOutstanding,
          maxOutstandingBytes: options.maxOutstandingBytes,
          maxReservationBytes: options.maxReservationBytes
        },
        highWatermarks: { outstanding: highOutstanding, outstandingBytes: highOutstandingBytes },
        totals: { acquired, released, rejected, oversizedRejected }
      };
    },
    close,
    get admissionVersion() { return admissionVersion; },
    get failure() { return null; },
    get closing() { return false; },
    get closed() { return closed; }
  };
}

module.exports = { createMutationAdmissionController, resolveMutationAdmissionOptions };
