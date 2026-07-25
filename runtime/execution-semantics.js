'use strict';

// Execution-semantic controls and response-rejection accounting.
//
// Two distinct problems are solved here, both about TRUTHFUL reconstruction of
// a finished run — neither changes what the runtime enforces.
//
// 1. Semantic controls (docs/BOUNDED_OPERATION_BATCHES.md).
//    A run's observable behavior is governed not only by the four numeric
//    runtime limits but by process constants and environment flags that were
//    never recorded: whether prefix truncation was enabled, whether the
//    objective-contract compiler ran, the per-response action ceilings, and the
//    thresholds at which the runtime terminates a run for repeated contract
//    violations, stalls, or inspection non-progress. Two runs with byte-identical
//    evidence could therefore have executed under different semantics, with no
//    way to tell them apart after the fact.
//
//    The snapshot built here is captured ONCE at run creation and carried inside
//    the existing runtimeLimitsSnapshot. It is deliberately not a second policy
//    object: nothing reads it to decide behavior, and the enforcement gates keep
//    reading their own constants. It exists so a finished run can be explained.
//
//    Runs created before this field existed have no semantics block. Their caps
//    are recovered from replaySnapshot.runtimeEnvelope (historical, captured at
//    run start) and only as a last resort from live process defaults — and in
//    that last case the resolution is LABELLED as unrecorded, so a historical run
//    can never silently present today's configuration as the one that governed it.
//
// 2. Response-rejection counting.
//    A "rejection" is a model response the runtime refused in full: none of its
//    proposed actions executed, and the model was asked to try again. That is an
//    exact, enumerable set of decision events. The terminal `model:no_progress`
//    event is a decision ABOUT an accumulated streak of rejections, not an
//    additional rejection, and counting it inflates every terminated run by one.

const EXECUTION_SEMANTICS_VERSION = 1;

// Integer-valued semantic controls. Booleans are handled separately because
// `false` is a meaningful recorded value and must not be treated as absent.
const EXECUTION_SEMANTICS_INTEGER_KEYS = Object.freeze([
  'actionContractViolationThreshold',
  'stalledResponseThreshold',
  'inspectionNoProgressThreshold',
  'workspaceSnapshotMaxEntries',
  'maxActionsPerResponse',
  'maxMutatingActionsPerResponse'
]);

const EXECUTION_SEMANTICS_BOOLEAN_KEYS = Object.freeze([
  'prefixTruncationEnabled',
  'contractCompilerEnabled'
]);

// Each of these means: the runtime rejected the whole response and executed
// none of its proposed actions. Rejection is what the count reports.
const RESPONSE_REJECTION_EVENT_TYPES = Object.freeze([
  'model:action_limit',          // total-action ceiling rejected the response
  'model:mutating_action_limit', // mutating-action ceiling rejected the response
  'execution.phase_violation',   // phase gate rejected the response
  'model:stalled'                // complete:false with no actions — nothing to execute
]);

// Explicitly excluded, with the reason each one is NOT a rejection. Kept as a
// named list so the exclusion is reviewable rather than implied by omission.
const NON_REJECTION_EVENT_TYPES = Object.freeze({
  // Terminal decision about an accumulated rejection streak. Counting it would
  // report N+1 rejections for a run terminated after N.
  'model:no_progress': 'terminal decision about prior rejections, not a rejection',
  // The response passed both gates.
  'model:action_contract_passed': 'acceptance decision',
  // Salvaged: the response was partially EXECUTED, so it was not rejected.
  'model:mutating_action_truncated': 'partially executed, not rejected',
  // Run-scoped limit exhaustion, not a per-response decision.
  'run:step_limit': 'run-level limit, not a response rejection',
  'run:failed': 'terminal run outcome'
});

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Build the immutable semantics record captured at run creation. Every value
// must be supplied by the caller — this module never reads process state, so a
// snapshot can never be built from ambient configuration by accident.
function buildExecutionSemanticsSnapshot(values) {
  const source = values && typeof values === 'object' ? values : {};
  const snapshot = { version: EXECUTION_SEMANTICS_VERSION };

  for (const key of EXECUTION_SEMANTICS_BOOLEAN_KEYS) {
    snapshot[key] = source[key] === true;
  }
  for (const key of EXECUTION_SEMANTICS_INTEGER_KEYS) {
    const normalized = positiveInteger(source[key]);
    if (normalized === null) {
      throw new TypeError(`executionSemantics.${key} must be a positive integer`);
    }
    snapshot[key] = normalized;
  }

  // Resolved workload profile and the inspection limits it imposed. Null when no
  // profile matched, which is itself a recorded fact rather than missing data.
  snapshot.workloadProfile = typeof source.workloadProfile === 'string' && source.workloadProfile
    ? source.workloadProfile
    : null;
  snapshot.maxListDirectoryPerRun = positiveInteger(source.maxListDirectoryPerRun);
  snapshot.maxReadFilePerRun = positiveInteger(source.maxReadFilePerRun);

  return snapshot;
}

// Accept a persisted semantics block, or null when the run predates the field.
// Never fabricates values: a malformed or partial block is rejected wholesale so
// callers fall through to the labelled-fallback path instead of reading a mix of
// recorded and invented numbers.
function normalizeExecutionSemanticsSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const normalized = { version: positiveInteger(value.version) || EXECUTION_SEMANTICS_VERSION };

  for (const key of EXECUTION_SEMANTICS_BOOLEAN_KEYS) {
    if (typeof value[key] !== 'boolean') return null;
    normalized[key] = value[key];
  }
  for (const key of EXECUTION_SEMANTICS_INTEGER_KEYS) {
    const integer = positiveInteger(value[key]);
    if (integer === null) return null;
    normalized[key] = integer;
  }

  normalized.workloadProfile = typeof value.workloadProfile === 'string' && value.workloadProfile
    ? value.workloadProfile
    : null;
  normalized.maxListDirectoryPerRun = positiveInteger(value.maxListDirectoryPerRun);
  normalized.maxReadFilePerRun = positiveInteger(value.maxReadFilePerRun);

  return normalized;
}

// Resolve the per-response action ceilings that governed a finished run, in
// descending order of authority:
//
//   run_semantics_snapshot — recorded at run creation (authoritative)
//   runtime_envelope       — recorded at run start in the replay snapshot
//   live_defaults_unrecorded — nothing was recorded; these are TODAY's process
//                              values and are labelled as such so no caller can
//                              present them as the run's governing configuration
//
// `liveDefaults` is required for the last case; callers pass their own constants
// rather than this module reading process state.
function resolveRunActionCaps({ semantics, runtimeEnvelope, liveDefaults } = {}) {
  const recorded = normalizeExecutionSemanticsSnapshot(semantics);
  if (recorded) {
    return {
      maxActionsPerResponse: recorded.maxActionsPerResponse,
      maxMutatingActionsPerResponse: recorded.maxMutatingActionsPerResponse,
      source: 'run_semantics_snapshot',
      recorded: true
    };
  }

  const envelope = runtimeEnvelope && typeof runtimeEnvelope === 'object' ? runtimeEnvelope : null;
  const envelopeTotal = envelope ? positiveInteger(envelope.maxActionsPerResponse) : null;
  // A browser run records 0 mutating actions, which is a real recorded value and
  // must not be discarded by a positive-integer test.
  const envelopeMutating = envelope && Number.isInteger(envelope.maxMutatingActionsPerResponse)
    && envelope.maxMutatingActionsPerResponse >= 0
    ? envelope.maxMutatingActionsPerResponse
    : null;
  if (envelopeTotal !== null && envelopeMutating !== null) {
    return {
      maxActionsPerResponse: envelopeTotal,
      maxMutatingActionsPerResponse: envelopeMutating,
      source: 'runtime_envelope',
      recorded: true
    };
  }

  const defaults = liveDefaults && typeof liveDefaults === 'object' ? liveDefaults : {};
  return {
    maxActionsPerResponse: positiveInteger(defaults.maxActionsPerResponse),
    maxMutatingActionsPerResponse: Number.isInteger(defaults.maxMutatingActionsPerResponse)
      ? defaults.maxMutatingActionsPerResponse
      : null,
    source: 'live_defaults_unrecorded',
    recorded: false
  };
}

// Exact count of model responses the runtime rejected in full, read from the
// replay snapshot's ordered decision events. See RESPONSE_REJECTION_EVENT_TYPES
// and NON_REJECTION_EVENT_TYPES for what is and is not counted.
function countResponseRejections(snapshot) {
  const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
  return events.filter(event =>
    event && RESPONSE_REJECTION_EVENT_TYPES.includes(event.type)).length;
}

module.exports = {
  EXECUTION_SEMANTICS_VERSION,
  EXECUTION_SEMANTICS_INTEGER_KEYS,
  EXECUTION_SEMANTICS_BOOLEAN_KEYS,
  RESPONSE_REJECTION_EVENT_TYPES,
  NON_REJECTION_EVENT_TYPES,
  buildExecutionSemanticsSnapshot,
  normalizeExecutionSemanticsSnapshot,
  resolveRunActionCaps,
  countResponseRejections
};
