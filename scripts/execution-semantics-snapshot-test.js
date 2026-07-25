#!/usr/bin/env node
'use strict';
// Pure test for runtime/execution-semantics.js.
//
// Distinct from execution-semantics-test.js, which covers resume/retry/commit
// boundaries. This one covers the run-evidence reconstruction guarantees:
//
//  1. A finished run's execution semantics are recoverable from what the run
//     PERSISTED, and never silently substituted from current process state.
//     Changing the environment must not rewrite historical evidence.
//  2. A rejection count means "responses the runtime refused in full" exactly,
//     and never counts the terminal model:no_progress decision, which is a
//     decision ABOUT rejections rather than another rejection.

const assert = require('assert/strict');
const {
  EXECUTION_SEMANTICS_VERSION,
  EXECUTION_SEMANTICS_INTEGER_KEYS,
  EXECUTION_SEMANTICS_BOOLEAN_KEYS,
  RESPONSE_REJECTION_EVENT_TYPES,
  NON_REJECTION_EVENT_TYPES,
  buildExecutionSemanticsSnapshot,
  normalizeExecutionSemanticsSnapshot,
  resolveRunActionCaps,
  countResponseRejections
} = require('../runtime/execution-semantics');

let passed = 0;
function ok(desc, condition) {
  assert.equal(condition, true, desc);
  passed += 1;
  console.log(`  ok ${desc}`);
}
function eq(desc, actual, expected) {
  assert.deepEqual(actual, expected, `${desc}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed += 1;
  console.log(`  ok ${desc}`);
}

// The exact control set the audit required to be recorded.
const REQUIRED_CONTROLS = [
  'prefixTruncationEnabled',
  'contractCompilerEnabled',
  'actionContractViolationThreshold',
  'stalledResponseThreshold',
  'inspectionNoProgressThreshold',
  'workspaceSnapshotMaxEntries',
  'maxActionsPerResponse',
  'maxMutatingActionsPerResponse'
];

const FULL = Object.freeze({
  prefixTruncationEnabled: false,
  contractCompilerEnabled: false,
  actionContractViolationThreshold: 2,
  stalledResponseThreshold: 2,
  inspectionNoProgressThreshold: 3,
  workspaceSnapshotMaxEntries: 200,
  maxActionsPerResponse: 8,
  maxMutatingActionsPerResponse: 2,
  workloadProfile: null,
  maxListDirectoryPerRun: null,
  maxReadFilePerRun: null
});

// ── Every required control is captured ───────────────────────────────────────
const built = buildExecutionSemanticsSnapshot(FULL);
for (const key of REQUIRED_CONTROLS) {
  ok(`snapshot records ${key}`, Object.prototype.hasOwnProperty.call(built, key));
}
eq('snapshot is versioned', built.version, EXECUTION_SEMANTICS_VERSION);
eq('integer + boolean key sets cover every required control',
  [...EXECUTION_SEMANTICS_BOOLEAN_KEYS, ...EXECUTION_SEMANTICS_INTEGER_KEYS].slice().sort(),
  REQUIRED_CONTROLS.slice().sort());

// Booleans must round-trip as false, not be dropped as absent.
eq('false flags are recorded as false, not omitted', built.prefixTruncationEnabled, false);
eq('compiler flag recorded as false', built.contractCompilerEnabled, false);
const enabled = buildExecutionSemanticsSnapshot({ ...FULL, prefixTruncationEnabled: true, contractCompilerEnabled: true });
eq('true flags round-trip', [enabled.prefixTruncationEnabled, enabled.contractCompilerEnabled], [true, true]);

// Workload profile and its inspection limits when one matched.
const profiled = buildExecutionSemanticsSnapshot({
  ...FULL, workloadProfile: 'refactor', maxListDirectoryPerRun: 2, maxReadFilePerRun: 6
});
eq('resolved workload profile recorded', profiled.workloadProfile, 'refactor');
eq('profile listDirectory limit recorded', profiled.maxListDirectoryPerRun, 2);
eq('profile readFile limit recorded', profiled.maxReadFilePerRun, 6);
eq('absent profile recorded as null, not omitted', built.workloadProfile, null);

// A missing control is a build-time error rather than a fabricated default.
for (const key of EXECUTION_SEMANTICS_INTEGER_KEYS) {
  const partial = { ...FULL };
  delete partial[key];
  assert.throws(() => buildExecutionSemanticsSnapshot(partial), TypeError,
    `omitting ${key} must throw rather than invent a value`);
  passed += 1;
}
console.log('  ok every integer control is mandatory at build time');

// ── Round-trip through persistence ───────────────────────────────────────────
const roundTripped = normalizeExecutionSemanticsSnapshot(JSON.parse(JSON.stringify(built)));
eq('snapshot survives JSON round-trip intact', roundTripped, built);

// Malformed blocks are rejected wholesale, never partially trusted.
eq('null block normalizes to null', normalizeExecutionSemanticsSnapshot(null), null);
eq('array is not a semantics block', normalizeExecutionSemanticsSnapshot([]), null);
eq('missing integer control rejects whole block',
  normalizeExecutionSemanticsSnapshot({ ...built, maxActionsPerResponse: undefined }), null);
eq('non-boolean flag rejects whole block',
  normalizeExecutionSemanticsSnapshot({ ...built, prefixTruncationEnabled: 'false' }), null);
eq('zero threshold rejects whole block',
  normalizeExecutionSemanticsSnapshot({ ...built, actionContractViolationThreshold: 0 }), null);

// ── Historical evidence must not follow live configuration ───────────────────
// A run that recorded its caps keeps them even when today's process defaults
// differ. This is the regression the audit's T1 finding is about.
const LIVE_AFTER_CONFIG_CHANGE = { maxActionsPerResponse: 64, maxMutatingActionsPerResponse: 32 };

const recordedRun = resolveRunActionCaps({
  semantics: built,
  runtimeEnvelope: { maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 2 },
  liveDefaults: LIVE_AFTER_CONFIG_CHANGE
});
eq('recorded run keeps its own total cap after a config change', recordedRun.maxActionsPerResponse, 8);
eq('recorded run keeps its own mutating cap after a config change', recordedRun.maxMutatingActionsPerResponse, 2);
eq('recorded run is sourced from its semantics snapshot', recordedRun.source, 'run_semantics_snapshot');
ok('recorded run is marked recorded', recordedRun.recorded === true);

// The same run resolved under a different live configuration is byte-identical.
eq('resolution is independent of live defaults',
  resolveRunActionCaps({ semantics: built, liveDefaults: { maxActionsPerResponse: 1, maxMutatingActionsPerResponse: 1 } }),
  recordedRun);

// A run predating the semantics field falls back to its own run-start envelope,
// which is still historical evidence — not to today's constants.
const envelopeRun = resolveRunActionCaps({
  semantics: null,
  runtimeEnvelope: { maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 2 },
  liveDefaults: LIVE_AFTER_CONFIG_CHANGE
});
eq('envelope fallback uses the run-start envelope total', envelopeRun.maxActionsPerResponse, 8);
eq('envelope fallback uses the run-start envelope mutating cap', envelopeRun.maxMutatingActionsPerResponse, 2);
eq('envelope fallback is labelled', envelopeRun.source, 'runtime_envelope');
ok('envelope fallback still counts as recorded', envelopeRun.recorded === true);

// A browser run records 0 mutating actions; 0 is a real value, not "absent".
const browserRun = resolveRunActionCaps({
  semantics: null,
  runtimeEnvelope: { maxActionsPerResponse: 8, maxMutatingActionsPerResponse: 0 },
  liveDefaults: LIVE_AFTER_CONFIG_CHANGE
});
eq('browser run keeps its recorded 0 mutating cap', browserRun.maxMutatingActionsPerResponse, 0);
eq('browser run is not pushed to the unrecorded path', browserRun.source, 'runtime_envelope');

// Only when nothing at all was recorded do live defaults appear — and then the
// result is explicitly labelled so no caller can present them as governing.
const unrecorded = resolveRunActionCaps({
  semantics: null, runtimeEnvelope: null, liveDefaults: LIVE_AFTER_CONFIG_CHANGE
});
eq('unrecorded run is labelled unrecorded', unrecorded.source, 'live_defaults_unrecorded');
ok('unrecorded run is marked not recorded', unrecorded.recorded === false);
eq('unrecorded run surfaces current defaults for display', unrecorded.maxActionsPerResponse, 64);

// A partial envelope is not half-trusted.
eq('envelope missing the mutating cap falls through to unrecorded',
  resolveRunActionCaps({
    semantics: null, runtimeEnvelope: { maxActionsPerResponse: 8 }, liveDefaults: LIVE_AFTER_CONFIG_CHANGE
  }).source, 'live_defaults_unrecorded');

// ── Exact rejection counting ─────────────────────────────────────────────────
const ev = type => ({ type });

eq('no snapshot → 0 rejections', countResponseRejections(null), 0);
eq('no events → 0 rejections', countResponseRejections({ events: [] }), 0);

for (const type of RESPONSE_REJECTION_EVENT_TYPES) {
  eq(`${type} counts as one rejection`, countResponseRejections({ events: [ev(type)] }), 1);
}
for (const type of Object.keys(NON_REJECTION_EVENT_TYPES)) {
  eq(`${type} is not counted as a rejection`, countResponseRejections({ events: [ev(type)] }), 0);
}

// The run #8 shape: two rejected responses, then the terminal decision and the
// run failure. The old substring heuristic reported 3 here.
const runEightEvents = {
  events: [
    { type: 'model:action_limit', step: 0 },
    { type: 'model:action_limit', step: 1 },
    { type: 'model:no_progress', step: 1 },
    { type: 'run:failed' }
  ]
};
eq('two rejected responses plus terminal decision → exactly 2', countResponseRejections(runEightEvents), 2);

// A terminated run reports N, never N+1.
eq('terminal no_progress never inflates the count',
  countResponseRejections(runEightEvents),
  runEightEvents.events.filter(e => e.type === 'model:action_limit').length);

// Accepted and salvaged responses are not rejections.
eq('passed + truncated responses are not rejections',
  countResponseRejections({
    events: [
      { type: 'model:action_contract_passed' },
      { type: 'model:mutating_action_truncated' },
      { type: 'model:action_contract_passed' }
    ]
  }), 0);

// Mixed stream counts only the four rejection types.
eq('mixed stream counts only rejections',
  countResponseRejections({
    events: [
      { type: 'model:action_limit' },
      { type: 'model:action_contract_passed' },
      { type: 'execution.phase_violation' },
      { type: 'model:stalled' },
      { type: 'model:mutating_action_limit' },
      { type: 'model:no_progress' },
      { type: 'run:step_limit' },
      { type: 'run:failed' }
    ]
  }), 4);

// The exclusion list and the inclusion list must stay disjoint.
ok('rejection and non-rejection type sets are disjoint',
  RESPONSE_REJECTION_EVENT_TYPES.every(type => !(type in NON_REJECTION_EVENT_TYPES)));
ok('model:no_progress is explicitly excluded with a reason',
  typeof NON_REJECTION_EVENT_TYPES['model:no_progress'] === 'string');

console.log(`\nPASS: execution semantics snapshot — ${passed} checks (recorded semantics, historical stability, exact rejection count)`);
