'use strict';

// Tranche 6 — the persistent global live economic ceiling.
//
// WHY A LEDGER AND NOT A COUNTER. The authorization is a HARD GLOBAL CAP across
// a whole 120-trial run that may be interrupted and resumed. An in-memory
// counter forgets everything the moment the executor restarts, and a run that
// forgets what it already committed can spend the authorization twice.
//
// So every reservation is appended to a durable file in the scored-run
// directory, fsynced before the dispatch it authorizes, and re-read on restart.
// The ledger lives beside the run it belongs to, so it cannot be confused with
// another run's spending.
//
// WHY LIABILITY, NOT OBSERVED COST. The gate must decide BEFORE dispatch, when
// observed cost does not exist yet. It therefore reserves the request's bounded
// MAXIMUM liability under the frozen `model_context_window_ceiling` method. A
// request that may have reached the provider has consumed that bound whatever
// the provider later reports: assuming a cheaper outcome is how a cap gets
// exceeded. Actual observed spend is recorded separately and never relaxes the
// gate.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEDGER_FILE = 'live-economic-ledger.jsonl';
const LOCK_FILE = 'live-economic-ledger.lock';

const {
  assertIntegerMicroUsd: assertCanonicalIntegerMicroUsd
} = require('./evaluation-live-canonical-price');

class LiveBudgetError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LiveBudgetError';
    this.code = detail.code || 'LIVE_BUDGET_REFUSED';
    this.detail = detail;
  }
}

// ONE MONETARY RULE, reused rather than restated. The canonical guard decides
// what a valid amount is; the ledger only translates the refusal into its own
// error type, so a caller catching LiveBudgetError still sees every refusal.
function assertIntegerMicroUsd(value, label) {
  try {
    return assertCanonicalIntegerMicroUsd(value, label);
  } catch (error) {
    throw new LiveBudgetError(error.message,
      { code: error.code || 'LIVE_BUDGET_AMOUNT_INVALID', label, value: String(value) });
  }
}

function ledgerPath(runRoot) { return path.join(runRoot, LEDGER_FILE); }

// ── Durable reconstruction ──────────────────────────────────────────────────
//
// The whole committed liability, re-derived from the file rather than carried
// in memory. This is what makes resume safe.
function reconstructCommittedLiability(runRoot) {
  const target = ledgerPath(runRoot);
  if (!fs.existsSync(target)) {
    return Object.freeze({ committedMicroUsd: 0, entries: Object.freeze([]) });
  }
  const entries = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
  // A RELEASE only ever follows a reservation that provably never reached the
  // provider. Anything else stays committed.
  let committed = 0;
  for (const entry of entries) {
    if (entry.kind === 'reserve') committed += entry.maximumLiabilityMicroUsd;
    else if (entry.kind === 'release') committed -= entry.maximumLiabilityMicroUsd;
  }
  // A ledger whose durable records sum to a fractional total has been written
  // by something that bypassed the canonical calculation. Reading it must fail
  // rather than hand a broken number to the ceiling comparison.
  assertIntegerMicroUsd(committed, 'reconstructed committedMicroUsd');
  return Object.freeze({
    committedMicroUsd: committed,
    entries: Object.freeze(entries)
  });
}

// ── Mutual exclusion ────────────────────────────────────────────────────────
//
// Two dispatchers must not both see the same remaining authority and both
// spend it. An exclusive-create lock file is the same pattern the repository
// uses for single-holder operations, and it survives process death because the
// caller always releases in `finally`.
function withLedgerLock(runRoot, body) {
  // The run root belongs to the executor, and creating it is idempotent. Doing
  // it here means a missing directory cannot be MISREPORTED as a concurrency
  // conflict — an operator told "another dispatcher holds the ledger" would go
  // looking for a second process that never existed.
  fs.mkdirSync(runRoot, { recursive: true });
  const lock = path.join(runRoot, LOCK_FILE);
  let handle = null;
  try {
    handle = fs.openSync(lock, 'wx');
  } catch (error) {
    // Only EEXIST means contention. Anything else is a different fault and
    // must say so rather than borrow the concurrency explanation.
    if (error.code !== 'EEXIST') {
      throw new LiveBudgetError(
        `the live economic ledger could not be locked at ${runRoot}: ${error.code}`,
        { code: 'LIVE_BUDGET_LOCK_UNAVAILABLE', cause: error.code });
    }
    throw new LiveBudgetError(
      'another dispatcher holds the live economic ledger; refusing to compute ' +
      'remaining authority concurrently',
      { code: 'LIVE_BUDGET_LOCKED' });
  }
  try {
    return body();
  } finally {
    try { fs.closeSync(handle); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(lock); } catch (_) { /* best effort */ }
  }
}

// ── The gate ────────────────────────────────────────────────────────────────
//
// Called BEFORE every provider dispatch. It reserves first and returns second,
// so a crash between reservation and dispatch leaves the liability committed —
// the safe direction.
function assertDispatchWithinGlobalCeiling({
  runRoot, ceilingMicroUsd, maximumLiabilityMicroUsd, trialId, role, ordinal
}) {
  // FAIL-CLOSED MONETARY VALIDATION.
  //
  // By the time an amount reaches this ledger it must ALREADY be an integer
  // authority. Rounding here would be repairing a value that escaped the
  // canonical pricing calculation, and a ledger that silently rounds is a
  // ledger that cannot tell a correct authority from a broken one. So a
  // fractional, NaN, infinite, negative or unsafe amount refuses instead.
  assertIntegerMicroUsd(ceilingMicroUsd, 'ceilingMicroUsd');
  if (ceilingMicroUsd <= 0) {
    throw new LiveBudgetError('a positive global ceiling is required',
      { code: 'LIVE_BUDGET_CEILING_INVALID', ceilingMicroUsd });
  }
  assertIntegerMicroUsd(maximumLiabilityMicroUsd, 'maximumLiabilityMicroUsd');
  return withLedgerLock(runRoot, () => {
    const { committedMicroUsd } = reconstructCommittedLiability(runRoot);
    const projected = committedMicroUsd + maximumLiabilityMicroUsd;
    if (projected > ceilingMicroUsd) {
      // STOP BEFORE DISPATCH. The matrix is never trimmed and the cap is never
      // stretched to finish a nearly complete run.
      throw new LiveBudgetError(
        `refusing to dispatch ${trialId}: committed ${committedMicroUsd} + ` +
        `${maximumLiabilityMicroUsd} would reach ${projected}, above the frozen ` +
        `ceiling ${ceilingMicroUsd}`,
        { code: 'LIVE_BUDGET_EXHAUSTED', committedMicroUsd, projected, ceilingMicroUsd });
    }
    const entry = {
      kind: 'reserve',
      reservationId: crypto.randomUUID(),
      trialId, role, ordinal,
      maximumLiabilityMicroUsd,
      committedBeforeMicroUsd: committedMicroUsd,
      committedAfterMicroUsd: projected,
      at: new Date().toISOString()
    };
    // FSYNCED BEFORE THE DISPATCH IT AUTHORIZES. A reservation that is only in
    // the page cache is a reservation a power failure can erase.
    const handle = fs.openSync(ledgerPath(runRoot), 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return Object.freeze({
      permitted: true,
      reservationId: entry.reservationId,
      committedAfterMicroUsd: projected,
      remainingMicroUsd: ceilingMicroUsd - projected
    });
  });
}

// A release is only legitimate with POSITIVE proof that no request reached the
// provider — a pre-delivery refusal. Ambiguous delivery is never released,
// because "we are not sure it arrived" is not evidence that it did not.
function releaseUndispatchedReservation({ runRoot, reservationId, proof }) {
  if (proof !== 'pre_delivery_refusal_no_provider_contact') {
    throw new LiveBudgetError(
      'a reservation may only be released with positive proof that no request ' +
      'reached the provider; ambiguous delivery stays committed',
      { code: 'LIVE_BUDGET_RELEASE_UNPROVEN' });
  }
  return withLedgerLock(runRoot, () => {
    const { entries } = reconstructCommittedLiability(runRoot);
    const reservation = entries.find(entry =>
      entry.kind === 'reserve' && entry.reservationId === reservationId);
    if (!reservation) {
      throw new LiveBudgetError(`no such reservation ${reservationId}`);
    }
    if (entries.some(entry =>
      entry.kind === 'release' && entry.reservationId === reservationId)) {
      throw new LiveBudgetError(`reservation ${reservationId} is already released`);
    }
    const entry = {
      kind: 'release',
      reservationId,
      maximumLiabilityMicroUsd: reservation.maximumLiabilityMicroUsd,
      proof,
      at: new Date().toISOString()
    };
    const handle = fs.openSync(ledgerPath(runRoot), 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(entry)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return Object.freeze({ released: true, reservationId });
  });
}

// Observed spend is recorded BESIDE the liability accounting and never relaxes
// the gate: the gate must be decidable before a response exists.
function recordObservedSpend({ runRoot, trialId, observedMicroUsd }) {
  const entry = {
    kind: 'observed', trialId, observedMicroUsd, at: new Date().toISOString()
  };
  fs.appendFileSync(ledgerPath(runRoot), `${JSON.stringify(entry)}\n`);
  return Object.freeze(entry);
}

module.exports = {
  LEDGER_FILE,
  LiveBudgetError,
  assertDispatchWithinGlobalCeiling,
  ledgerPath,
  reconstructCommittedLiability,
  recordObservedSpend,
  releaseUndispatchedReservation,
  withLedgerLock
};
