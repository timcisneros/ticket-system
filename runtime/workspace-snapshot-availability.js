'use strict';

// Workspace-snapshot availability transitions (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A1).
//
// A run's workspace-snapshot availability is a state machine with exactly two
// transitions, both recorded as ordered durable events:
//
//   workspace:snapshot_unavailable — a capture failed; the run stopped
//   workspace:snapshot_recovered   — a later capture succeeded; truth restored
//
// Two decisions read this state, and both must read the LATEST transition
// rather than merely asking whether a failure ever occurred:
//
//   1. Whether a run-start capture failure terminalizes or stops recoverably.
//      A first failure on a healthy run terminalizes before any model request.
//      A failure while a prior failure is still unresolved must NOT terminalize —
//      the run is mid-recovery and must remain recoverably stopped until some
//      later capture succeeds.
//
//   2. Whether a successful capture emits a recovery event. Recovery closes an
//      unresolved failure exactly once. A run that re-enters cleanly afterwards
//      must not emit a duplicate recovery for an already-closed failure, and a
//      genuinely new failure must be able to open a new transition later.
//
// Existence-based logic ("has this run ever failed a capture?") gets both wrong:
// it re-emits recovery on every later entry and cannot distinguish a first
// failure from a failure during recovery.

const SNAPSHOT_UNAVAILABLE_EVENT = 'workspace:snapshot_unavailable';
const SNAPSHOT_RECOVERED_EVENT = 'workspace:snapshot_recovered';

const SNAPSHOT_AVAILABILITY_EVENT_TYPES = Object.freeze([
  SNAPSHOT_UNAVAILABLE_EVENT,
  SNAPSHOT_RECOVERED_EVENT
]);

const AVAILABILITY_STATE = Object.freeze({
  UNAVAILABLE: 'unavailable',
  RECOVERED: 'recovered'
});

function eventsOf(replaySnapshot) {
  if (!replaySnapshot || typeof replaySnapshot !== 'object') return [];
  return Array.isArray(replaySnapshot.events) ? replaySnapshot.events : [];
}

// The latest availability transition in recorded (append/chronological) order, or
// null when the run has never recorded one. Only the two transition events are
// consulted; every other event is irrelevant to this state.
function latestSnapshotAvailabilityTransition(replaySnapshot) {
  const transitions = eventsOf(replaySnapshot)
    .filter(event => event && SNAPSHOT_AVAILABILITY_EVENT_TYPES.includes(event.type));
  if (transitions.length === 0) return null;
  const latest = transitions[transitions.length - 1];
  return latest.type === SNAPSHOT_UNAVAILABLE_EVENT
    ? AVAILABILITY_STATE.UNAVAILABLE
    : AVAILABILITY_STATE.RECOVERED;
}

// True when the run's latest transition is a failure that no later capture has
// closed. Drives both the terminalize-vs-stop decision and whether a successful
// capture should record recovery.
function hasUnresolvedSnapshotFailure(replaySnapshot) {
  return latestSnapshotAvailabilityTransition(replaySnapshot) === AVAILABILITY_STATE.UNAVAILABLE;
}

// The unresolved failure a recovery event would close, or null when there is
// none. Returned so the recovery record can name what it resolved.
function unresolvedSnapshotFailure(replaySnapshot) {
  if (!hasUnresolvedSnapshotFailure(replaySnapshot)) return null;
  const failures = eventsOf(replaySnapshot)
    .filter(event => event && event.type === SNAPSHOT_UNAVAILABLE_EVENT);
  return failures[failures.length - 1] || null;
}

module.exports = {
  SNAPSHOT_UNAVAILABLE_EVENT,
  SNAPSHOT_RECOVERED_EVENT,
  SNAPSHOT_AVAILABILITY_EVENT_TYPES,
  AVAILABILITY_STATE,
  latestSnapshotAvailabilityTransition,
  hasUnresolvedSnapshotFailure,
  unresolvedSnapshotFailure
};
