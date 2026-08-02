'use strict';

// Test-only deterministic interruption seam for governed execution.
//
// WHY A DECORATOR AND NOT A PRODUCTION HOOK. The boundaries this needs to
// interrupt — between a committed receipt and its evidence set, between
// complete evidence and the next reservation, between a persisted block and the
// worker returning — are places where production must have NO conditional at
// all. A branch that exists only for tests is a branch that can be reached in
// production, and this is exactly the code path where "it silently continued"
// is the failure being tested for. So the fault lives entirely outside
// production source: `PostgresRuntimeStore.prototype` is decorated here, before
// server.js requires it, and production defaults are untouched.
//
// WHY NOT KILL THE PROCESS. A signal at an approximate moment proves whatever
// happened to be true when it landed. These faults fire at an exact named
// boundary and record that they did, so a scenario can assert the interruption
// occurred where it claims rather than inferring it from wreckage.
//
// Every fault is ARMED ONCE. The restart that follows must run against
// unmodified behaviour, or the scenario would be testing a permanently broken
// server rather than recovery from one interruption.

const fs = require('node:fs');
const path = require('node:path');

const BOUNDARY = String(process.env.GOVERNED_FAULT_BOUNDARY || '').trim();
const MARKER_PATH = process.env.GOVERNED_FAULT_MARKER || null;
// A restart is a fresh process. The armed/fired state must survive it, or every
// restart would re-arm the fault and no scenario could ever get past it.
const STATE_PATH = process.env.GOVERNED_FAULT_STATE || null;

function alreadyFired() {
  if (!STATE_PATH) return false;
  return fs.existsSync(STATE_PATH);
}

function recordFired(detail) {
  if (STATE_PATH) fs.writeFileSync(STATE_PATH, detail);
  if (MARKER_PATH) fs.appendFileSync(MARKER_PATH, `${detail}\n`);
}

function mark(detail) {
  if (MARKER_PATH) fs.appendFileSync(MARKER_PATH, `${detail}\n`);
}

// A CRASH, NOT AN EXCEPTION.
//
// Throwing models a fatal error: it unwinds through the fail-closed path and
// terminalizes the Run as `failed`, which is not recoverable and so cannot test
// recovery. A crash is what actually happens when a host dies — the process
// stops mid-transaction, the Run stays claimed, and its lease expires. That is
// the state the recovery path exists for.
//
// This is deterministic despite being a process exit: it fires at one named
// boundary that has already been recorded as reached, not at an arbitrary
// moment chosen by a signal.
function crashAtBoundary(boundary, detail) {
  recordFired(detail);
  process.exit(70);
}

if (BOUNDARY) {
  const storePath = path.join(
    __dirname, '..', '..', 'persistence', 'postgres', 'store.js');
  const { PostgresRuntimeStore } = require(storePath);
  const prototype = PostgresRuntimeStore.prototype;

  // ── A. after operation receipt commit, before evidence-set commit ────────
  //
  // The receipt is already durable when this fires: the worker commits receipts
  // during the action batch and only then evaluates postconditions. Baseline
  // sets are allowed through, because the baseline is captured before the first
  // request and interrupting it would be a different scenario.
  if (BOUNDARY === 'before_evidence_set_commit') {
    const real = prototype.appendGovernedPostconditionEvidenceSet;
    prototype.appendGovernedPostconditionEvidenceSet =
      async function faultedAppend(args, options) {
        const records = (args && args.evidenceRecords) || [];
        const isPostBatch = records.some(
          record => record && record.evaluationKind === 'post_batch');
        if (isPostBatch && !alreadyFired()) {
          crashAtBoundary(BOUNDARY,
            `BOUNDARY_A_REACHED facts=${records.length} ` +
            `batch=${records[0] ? records[0].batchStepId : 'none'}`);
        }
        return real.call(this, args, options);
      };
  }

  // ── B. after complete evidence-set commit, before next reservation ───────
  //
  // Fires on the reservation that FOLLOWS a committed post-batch evidence set,
  // so the interruption lands between durable request-1 evidence and any
  // request-2 authority. Ordinal 1 must be allowed through or there would be no
  // request 1 to recover from.
  if (BOUNDARY === 'before_next_request_reservation') {
    const realPrepare = prototype.prepareAndReserveNextGovernedRunRequest;
    prototype.prepareAndReserveNextGovernedRunRequest =
      async function faultedPrepare(args, options) {
        if (!alreadyFired()) {
          const existing = await this.pool.query(
            `SELECT count(*)::int AS committed
               FROM ${this.table('governed_postcondition_evidence')}
              WHERE run_id = $1 AND evaluation_kind = 'post_batch'`,
            [args.runId]);
          if (existing.rows[0].committed > 0) {
            crashAtBoundary(BOUNDARY,
              `BOUNDARY_B_REACHED evidence_rows=${existing.rows[0].committed}`);
          }
        }
        return realPrepare.call(this, args, options);
      };
  }

  // ── C. after progress block commit, before worker return ────────────────
  if (BOUNDARY === 'after_progress_block_commit') {
    const realBlock = prototype.blockGovernedRunForProgressDecision;
    if (typeof realBlock === 'function') {
      prototype.blockGovernedRunForProgressDecision =
        async function faultedBlock(...args) {
          const result = await realBlock.apply(this, args);
          if (!alreadyFired()) {
            crashAtBoundary(BOUNDARY, 'BOUNDARY_C_REACHED block=' +
              (result && result.block ? result.block.blockHash : 'none'));
          }
          return result;
        };
    }
  }

  mark(`FAULT_PRELOAD_ARMED=${BOUNDARY}`);
}

console.log(`GOVERNED_FAULT_PRELOAD_ACTIVE=${BOUNDARY || 'none'}`);
