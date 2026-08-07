'use strict';

// Tranche 6 — WHICH RUNS ARE NOT DECISION EVIDENCE.
//
// A run that was deliberately abandoned partway through is not a small corpus.
// It is not a corpus at all: the slots it accepted were selected by WHEN the
// abort happened, so scoring them would report the first N trials of an
// experiment as though they were the experiment. The aborted run listed below
// additionally did not retain its provider responses, so nothing in it can be
// re-examined either.
//
// ONE OWNER, THREE ENFORCEMENT POINTS. This module holds the identity and the
// predicate and nothing else — no filesystem, no database, no scoring — because
// the same rule has to hold at the live corpus gate, at the scorer's door and
// at the final evidence-combination contract. A rule enforced at one of three
// doors is a rule that can be walked around.
//
// THE ARTIFACTS ARE NOT TOUCHED. What is forbidden is IMPORTING them into a
// valid corpus. Preserving an aborted run's evidence and refusing to score it
// are the same discipline, not opposite ones.

const ABORTED_LABEL = 'ABORTED — NOT DECISION EVIDENCE';

const ABORTED_CODE = 'ABORTED_NOT_DECISION_EVIDENCE';

// Listed BY IDENTITY, not only by label. A header hash is what the run is; a
// label is something a header carries. Listing the identity means the refusal
// survives a header that loses, or never had, its label.
const PERMANENTLY_ABORTED_RUNS = Object.freeze([
  Object.freeze({
    runHeaderHash:
      'b2b59ad2b9d9fafc8ac860838b0530cb8f90bc02907b36a3a230b560bece2eef',
    reason: '120 slots assigned, 31 accepted before a deliberate abort; the ' +
      'provider responses were not retained and the exact cause was never ' +
      'established, so no product conclusion may rest on it'
  })
]);

// True when a run header names an aborted run, by ANY of the routes it can be
// known: an explicit flag, the frozen label, a stated reason, or the permanent
// identity list.
function isAbortedRunHeader(header) {
  if (!header || typeof header !== 'object') return false;
  if (header.aborted === true) return true;
  if (header.label === ABORTED_LABEL) return true;
  if (typeof header.abortedReason === 'string' && header.abortedReason.length > 0) return true;
  return PERMANENTLY_ABORTED_RUNS
    .some(run => run.runHeaderHash === header.runHeaderHash);
}

function abortedRunDetail(header) {
  const listed = PERMANENTLY_ABORTED_RUNS
    .find(run => run.runHeaderHash === (header && header.runHeaderHash));
  return Object.freeze({
    code: ABORTED_CODE,
    runHeaderHash: header ? header.runHeaderHash || null : null,
    permanentlyListed: Boolean(listed),
    reason: listed
      ? listed.reason
      : (header && header.abortedReason) || 'the run header declares it aborted'
  });
}

module.exports = {
  ABORTED_CODE,
  ABORTED_LABEL,
  PERMANENTLY_ABORTED_RUNS,
  abortedRunDetail,
  isAbortedRunHeader
};
