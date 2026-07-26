#!/usr/bin/env node
'use strict';
// A1 (E4): workspace-snapshot failure truthfulness.
//
// Decided shape is recorded in docs/ARCHITECTURAL_DECISIONS_PENDING.md entry A1.
// This suite is purpose-built because the natural feasibility/postcondition
// harnesses are orphaned (entry A10) and cannot host it.
//
// SCOPE — this suite covers representation, classification, and the availability
// transition logic. It does NOT prove the recovery lifecycle.
//
// Covered here:
//   - successful empty root listing
//   - successful truncated listing
//   - failure representation (never an empty listing)
//   - containment violation classified distinctly from an availability fault
//   - compatibility for historical snapshots that predate `available`
//   - availability transitions (runtime/workspace-snapshot-availability.js)
//
// NOT covered here — see scripts/workspace-snapshot-recovery-test.js:
//   stopping recoverably, mutation preservation, absence of further model
//   requests, full unwind before reclaim, repeated failed recovery attempts not
//   terminalizing, resumption after a later successful capture, and
//   exactly-once recovery evidence. Those are lifecycle guarantees that source
//   inspection cannot establish.
//
// An earlier revision of this file asserted `recoverableStop: false` in the
// run-start guard under the label "failed recovery capture cannot resume". That
// assertion described the terminalizing behavior — the defect — and was reported
// as covering "failed recovery remains stopped". It was written to match the
// implementation rather than the requirement. Recorded as blocker B5 in
// docs/ARCHITECTURAL_DECISIONS_PENDING.md.
//
// server.js cannot be required in-process (it calls start() and demands a live
// database), so the capture/classification functions are extracted from source
// and executed against injected stubs. Structural assertions here pin wiring
// only; they never stand in for behavioral proof. (A13 retired the suites that
// relied on source extraction ALONE, because coupling to internal structure
// breaks on renames while missing behavioral regressions; the pattern is sound
// only alongside behavioral coverage, which this file has.)

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

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

// Extract a top-level function, skipping the parameter list by paren depth so a
// default parameter containing `{}` cannot truncate the body.
function extractFunction(code, name) {
  const match = code.match(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`));
  if (!match) throw new Error(`could not locate function ${name} in server.js`);
  const start = match.index;
  let i = start + match[0].length;
  let parens = 1;
  while (i < code.length && parens > 0) {
    if (code[i] === '(') parens += 1;
    else if (code[i] === ')') parens -= 1;
    i += 1;
  }
  const bodyStart = code.indexOf('{', i);
  let depth = 0;
  let j = bodyStart;
  while (j < code.length) {
    if (code[j] === '{') depth += 1;
    else if (code[j] === '}') depth -= 1;
    j += 1;
    if (depth === 0) break;
  }
  if (depth !== 0) throw new Error(`unbalanced braces extracting ${name}`);
  return code.slice(start, j);
}

const MAX_ENTRIES = Number(
  (SOURCE.match(/const RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES = (\d+);/) || [])[1]
);
ok('workspace snapshot entry limit is readable from source', Number.isInteger(MAX_ENTRIES) && MAX_ENTRIES > 0);

// Read the classification codes from source rather than hard-coding them, so a
// rename in server.js surfaces here instead of silently passing.
function sourceConst(name) {
  const match = SOURCE.match(new RegExp(`const ${name} = '([A-Z_]+)';`));
  if (!match) throw new Error(`could not read constant ${name} from server.js`);
  return match[1];
}
const CONTAINMENT_CODE = sourceConst('WORKSPACE_CONTAINMENT_VIOLATION');
const UNAVAILABLE_CODE = sourceConst('WORKSPACE_SNAPSHOT_UNAVAILABLE');
eq('containment code is WORKSPACE_CONTAINMENT_VIOLATION', CONTAINMENT_CODE, 'WORKSPACE_CONTAINMENT_VIOLATION');
eq('availability code is WORKSPACE_SNAPSHOT_UNAVAILABLE', UNAVAILABLE_CODE, 'WORKSPACE_SNAPSHOT_UNAVAILABLE');

// Build the capture function with a stubbed provider.
function buildCapture(listImpl) {
  const factory = new Function('deps', `
    const {
      getRunWorkspaceProvider, RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES, sanitizeLogMessage,
      WORKSPACE_CONTAINMENT_VIOLATION, WORKSPACE_SNAPSHOT_UNAVAILABLE
    } = deps;
    ${extractFunction(SOURCE, 'isWorkspaceSnapshotUnavailable')}
    ${extractFunction(SOURCE, 'classifyWorkspaceSnapshotFailure')}
    ${extractFunction(SOURCE, 'captureRunWorkspaceRootSnapshot')}
    return {
      captureRunWorkspaceRootSnapshot,
      classifyWorkspaceSnapshotFailure,
      isWorkspaceSnapshotUnavailable
    };
  `);
  return factory({
    getRunWorkspaceProvider: () => ({
      id: 'local-workspace',
      kind: 'localWorkspace',
      scope: { type: 'filesystemRoot', root: '/tmp/ws' },
      list: listImpl
    }),
    RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES: MAX_ENTRIES,
    sanitizeLogMessage: value => String(value),
    WORKSPACE_CONTAINMENT_VIOLATION: CONTAINMENT_CODE,
    WORKSPACE_SNAPSHOT_UNAVAILABLE: UNAVAILABLE_CODE
  });
}

const structuredError = (message, code, kind) => {
  const error = new Error(message);
  error.code = code;
  if (kind) error.kind = kind;
  return error;
};

// ── 1. Successful empty root listing ─────────────────────────────────────────
// The critical contrast for scenario 8: a genuinely empty workspace and an
// unreadable one must be distinguishable in every field.
const emptyApi = buildCapture(() => ({ path: '', entries: [] }));
const emptySnapshot = emptyApi.captureRunWorkspaceRootSnapshot({});
eq('empty listing is marked available', emptySnapshot.available, true);
eq('empty listing has an empty entries array, not null', emptySnapshot.entries, []);
eq('empty listing reports entryCount 0', emptySnapshot.entryCount, 0);
eq('empty listing reports truncated false', emptySnapshot.truncated, false);
ok('empty listing carries no error', emptySnapshot.error === undefined);
ok('empty listing is not treated as unavailable',
  emptyApi.isWorkspaceSnapshotUnavailable(emptySnapshot) === false);

// ── 2. Successful truncated listing ──────────────────────────────────────────
const manyEntries = Array.from({ length: MAX_ENTRIES + 25 },
  (_, i) => ({ name: `entry-${i}`, type: 'folder' }));
const truncatedApi = buildCapture(() => ({ path: '', entries: manyEntries }));
const truncatedSnapshot = truncatedApi.captureRunWorkspaceRootSnapshot({});
eq('truncated listing is marked available', truncatedSnapshot.available, true);
eq('truncated listing caps entries at the limit', truncatedSnapshot.entries.length, MAX_ENTRIES);
eq('truncated listing reports the true total entryCount', truncatedSnapshot.entryCount, MAX_ENTRIES + 25);
eq('truncated listing sets truncated true', truncatedSnapshot.truncated, true);
ok('truncated listing is not treated as unavailable',
  truncatedApi.isWorkspaceSnapshotUnavailable(truncatedSnapshot) === false);

// ── Representation on failure ────────────────────────────────────────────────
const ioApi = buildCapture(() => { throw structuredError('permission denied', 'EACCES'); });
const ioSnapshot = ioApi.captureRunWorkspaceRootSnapshot({});
eq('I/O failure is marked unavailable', ioSnapshot.available, false);
eq('I/O failure nulls entries — never an empty array', ioSnapshot.entries, null);
eq('I/O failure nulls entryCount — never 0', ioSnapshot.entryCount, null);
eq('I/O failure nulls truncated — never false', ioSnapshot.truncated, null);
eq('I/O failure classifies as unavailable', ioSnapshot.error, 'WORKSPACE_SNAPSHOT_UNAVAILABLE');
eq('I/O failure records its kind', ioSnapshot.errorKind, 'unavailable');
eq('I/O failure retains the underlying cause', ioSnapshot.errorDetail, 'EACCES');
ok('I/O failure is treated as unavailable',
  ioApi.isWorkspaceSnapshotUnavailable(ioSnapshot) === true);

// Scenario 8, stated directly: no field of a failed capture reads as an empty
// workspace, and it is field-by-field distinguishable from the real empty case.
ok('failed capture is distinguishable from an empty workspace',
  ioSnapshot.available !== emptySnapshot.available
  && ioSnapshot.entries !== emptySnapshot.entries
  && ioSnapshot.entryCount !== emptySnapshot.entryCount
  && ioSnapshot.truncated !== emptySnapshot.truncated);
ok('failed capture never presents a zero entry count', ioSnapshot.entryCount !== 0);
ok('failed capture never presents an empty entries array',
  Array.isArray(ioSnapshot.entries) === false);

// ── 4. Containment violation is classified separately ────────────────────────
const containmentApi = buildCapture(() =>
  { throw structuredError('Path is outside workspace root', 'WORKSPACE_OUTSIDE_ROOT', 'protected_path'); });
const containmentSnapshot = containmentApi.captureRunWorkspaceRootSnapshot({});
eq('containment violation gets its own code',
  containmentSnapshot.error, 'WORKSPACE_CONTAINMENT_VIOLATION');
eq('containment violation gets its own kind',
  containmentSnapshot.errorKind, 'containment_violation');
ok('containment violation is distinct from an availability fault',
  containmentSnapshot.error !== ioSnapshot.error
  && containmentSnapshot.errorKind !== ioSnapshot.errorKind);
eq('containment violation is still unavailable', containmentSnapshot.available, false);

// Classification is driven by the structured kind too, not only the code string.
eq('protected_path kind alone classifies as containment',
  ioApi.classifyWorkspaceSnapshotFailure({ kind: 'protected_path' }).code,
  'WORKSPACE_CONTAINMENT_VIOLATION');
eq('an unknown error classifies as unavailable, not containment',
  ioApi.classifyWorkspaceSnapshotFailure(new Error('boom')).code,
  'WORKSPACE_SNAPSHOT_UNAVAILABLE');

// ── 9. Historical snapshots without `available` ──────────────────────────────
// Absence of the field must never read as failure, or every pre-A1 run would
// retroactively look like it had an unreadable workspace.
const historical = {
  targetId: 'local-workspace', targetKind: 'localWorkspace', path: '',
  entries: [{ name: 'A', type: 'folder' }], entryCount: 1, truncated: false, capturedAt: '2026-07-01T00:00:00.000Z'
};
ok('historical snapshot without `available` is treated as available',
  ioApi.isWorkspaceSnapshotUnavailable(historical) === false);
ok('historical empty snapshot without `available` is treated as available',
  ioApi.isWorkspaceSnapshotUnavailable({ ...historical, entries: [], entryCount: 0 }) === false);
ok('null snapshot is not treated as unavailable',
  ioApi.isWorkspaceSnapshotUnavailable(null) === false);
ok('only an explicit available:false is unavailable',
  ioApi.isWorkspaceSnapshotUnavailable({ available: undefined }) === false
  && ioApi.isWorkspaceSnapshotUnavailable({ available: false }) === true);

// ── Error construction: run-start vs per-step ────────────────────────────────
const errApi = (() => {
  const factory = new Function('deps', `
    const { sanitizeLogMessage, WORKSPACE_CONTAINMENT_VIOLATION, WORKSPACE_SNAPSHOT_UNAVAILABLE } = deps;
    ${extractFunction(SOURCE, 'createWorkspaceSnapshotFailureError')}
    return createWorkspaceSnapshotFailureError;
  `);
  return factory({
    sanitizeLogMessage: v => String(v),
    WORKSPACE_CONTAINMENT_VIOLATION: CONTAINMENT_CODE,
    WORKSPACE_SNAPSHOT_UNAVAILABLE: UNAVAILABLE_CODE
  });
})();

const runStartError = errApi(ioSnapshot, { phase: 'run_start', recoverableStop: false });
eq('run-start failure carries the availability code', runStartError.code, 'WORKSPACE_SNAPSHOT_UNAVAILABLE');
eq('run-start failure is classified environment/integrity', runStartError.failureKind, 'environment_integrity');
ok('run-start failure is NOT a model failure', runStartError.failureKind !== 'no_progress');
ok('run-start failure is NOT a provider failure', runStartError.failureKind !== 'provider_error');
eq('run-start failure is not a recoverable stop', runStartError.recoverableStop, false);
eq('run-start failure records its phase', runStartError.details.phase, 'run_start');

const perStepError = errApi(ioSnapshot, { phase: 'execution_step', recoverableStop: true });
eq('per-step failure is a recoverable stop', perStepError.recoverableStop, true);
eq('per-step failure records its phase', perStepError.details.phase, 'execution_step');
eq('per-step failure shares the environment/integrity classification',
  perStepError.failureKind, 'environment_integrity');

const containmentError = errApi(containmentSnapshot, { phase: 'run_start', recoverableStop: false });
eq('containment error keeps its distinct code',
  containmentError.code, 'WORKSPACE_CONTAINMENT_VIOLATION');
ok('containment error message names containment, not mere unavailability',
  /containment violation/i.test(containmentError.message));
ok('availability error message does not claim containment',
  !/containment/i.test(runStartError.message));

// ── Wiring that cannot be isolated from a live run ───────────────────────────
const loop = SOURCE.slice(SOURCE.indexOf('async function runAgentTicket'));

// 3. Run start: evidence, then terminate before the first model request.
const runStartGuard = loop.slice(
  loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)'),
  loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)') + 1400
);
ok('run-start guard slice captured the throw', /createWorkspaceSnapshotFailureError/.test(runStartGuard));
ok('run-start guard records durable evidence before throwing',
  runStartGuard.indexOf('recordWorkspaceSnapshotFailure')
    < runStartGuard.indexOf('createWorkspaceSnapshotFailureError'));
// The guard is state-aware: it terminalizes a FIRST failure but stops
// recoverably when a prior failure is still unresolved. Asserting only
// `recoverableStop: false` here is what produced blocker B5.
ok('run-start guard decides terminalize-vs-stop from unresolved state',
  /recoverableStop: wasStoppedForSnapshotFailure/.test(runStartGuard));
ok('run-start guard does not hard-code terminalization',
  !/recoverableStop: false/.test(runStartGuard));
ok('run-start guard runs before the execution loop begins',
  loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)')
    < loop.indexOf('for (let step = initialExecutionTurn'));
ok('run-start guard runs before any provider call',
  loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)')
    < loop.indexOf('callModelProviderWithRunEvidence'));

// 5. Per-step: capture and guard precede prompt construction and the model call.
const perStepGuardIndex = loop.indexOf('isWorkspaceSnapshotUnavailable(currentWorkspaceSnapshot)');
ok('per-step guard exists', perStepGuardIndex > 0);
ok('per-step guard precedes prompt construction',
  perStepGuardIndex < loop.indexOf('const input = await buildAgentPrompt(promptTicket, currentEnvelope'));
const perStepGuard = loop.slice(perStepGuardIndex, perStepGuardIndex + 1400);
ok('per-step guard slice captured the throw', /createWorkspaceSnapshotFailureError/.test(perStepGuard));
ok('per-step guard records durable evidence before throwing',
  perStepGuard.indexOf('recordWorkspaceSnapshotFailure') < perStepGuard.indexOf('createWorkspaceSnapshotFailureError'));
ok('per-step guard stops recoverably', /recoverableStop: true/.test(perStepGuard));
ok('per-step guard records the step', /step\b/.test(perStepGuard));

// The stop must not terminalize, and must not roll back or redo work.
// Bound the slice to the finally that FOLLOWS the catch; an earlier `} finally {`
// inside the loop would otherwise produce an empty slice and vacuous assertions.
const catchStart = loop.indexOf("error.code === 'RUN_LEASE_LOST'");
const catchBlock = loop.slice(catchStart, loop.indexOf('} finally {', catchStart));
ok('catch block was located and is non-empty', catchBlock.length > 0);
ok('recoverable stop is handled before the generic failure path',
  catchBlock.indexOf('error.recoverableStop === true') < catchBlock.indexOf('failAgentRun'));
// Strip comment lines first: the branch's own explanation mentions failAgentRun
// by name, which would otherwise make this assertion fail on prose.
const stripComments = text => text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
const recoverableBranch = stripComments(catchBlock.slice(
  catchBlock.indexOf('error.recoverableStop === true'),
  catchBlock.indexOf('} else {')
));
ok('recoverable-stop branch was located', recoverableBranch.length > 0);
ok('recoverable stop does not call failAgentRun in its own branch',
  !recoverableBranch.includes('failAgentRun'));
ok('recoverable stop writes no terminal status transition',
  !/commitRunTerminalization|interruptAgentRun/.test(recoverableBranch));
ok('recoverable stop records that mutations are preserved',
  /mutationsPreserved: true/.test(catchBlock));
ok('recoverable stop emits a durable journal event',
  /run\.execution_stopped_for_recovery/.test(catchBlock));

// 6/7. Recovery: a fresh capture is attempted on re-entry, and only success
// records recovery. Lifecycle proof lives in the integration suite.
ok('resumed run re-captures at run start (capture precedes the loop)',
  loop.indexOf('captureRunWorkspaceRootSnapshot(run)') < loop.indexOf('for (let step = initialExecutionTurn'));
ok('recovery acknowledgement is gated on unresolved availability state',
  /if \(wasStoppedForSnapshotFailure\) \{/.test(loop));
ok('recovery acknowledgement names the failure it resolved',
  /unresolvedSnapshotFailure\(priorAvailabilitySnapshot\)/.test(loop));
ok('recovery acknowledgement is emitted only after the availability guard',
  loop.indexOf('if (wasStoppedForSnapshotFailure) {')
    > loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)'));
ok('recovery emits a durable journal event',
  /workspace\.snapshot_recovered/.test(SOURCE));
// Replaces the assertion that produced B5. Lifecycle behavior is proven in
// scripts/workspace-snapshot-recovery-test.js against a real store; here we pin
// only that the decision is derived from unresolved availability state.
ok('unresolved-state predicate drives the stop decision',
  /const wasStoppedForSnapshotFailure = /.test(loop)
  && /hasUnresolvedSnapshotFailure\(priorAvailabilitySnapshot\)/.test(loop));
ok('recoverable stop no longer releases the lease (claim race, B3)',
  !/releaseRunLease\(runId/.test(catchBlock));
ok('recoverable stop records that the lease is retained until expiry',
  /leaseRetainedUntilExpiry: true/.test(catchBlock));

// Scenario 8 at the diagnostic layer: the snapshot object persisted as evidence
// is the same object asserted above, so a failed capture reaches diagnostics
// with available:false and null counts rather than an empty listing.
ok('run-start snapshot is persisted as target-snapshot evidence',
  /replayKey: 'targetSnapshots'/.test(loop));
ok('snapshot evidence is recorded before the availability guard runs',
  loop.indexOf("replayKey: 'targetSnapshots'")
    < loop.indexOf('isWorkspaceSnapshotUnavailable(initialWorkspaceSnapshot)'));

// Scope guard: A1 must not have changed the model prompt.
ok('A1 introduced no available:false prompt guidance',
  !/available:\s*false/i.test(SOURCE.slice(SOURCE.indexOf('function buildAgentPrompt'),
    SOURCE.indexOf('function buildAgentPrompt') + 12000)));

// ── Availability transitions (runtime/workspace-snapshot-availability.js) ────
// Real module, executed — this is the logic that decides whether a capture
// failure terminalizes or stops recoverably, and whether recovery is recorded.
const availability = require('../runtime/workspace-snapshot-availability');
const snap = types => ({ events: types.map(type => ({ type })) });
const UNAVAIL = availability.SNAPSHOT_UNAVAILABLE_EVENT;
const RECOV = availability.SNAPSHOT_RECOVERED_EVENT;

eq('no events → no transition', availability.latestSnapshotAvailabilityTransition(snap([])), null);
eq('null snapshot → no transition', availability.latestSnapshotAvailabilityTransition(null), null);
ok('a run with no transitions has no unresolved failure',
  availability.hasUnresolvedSnapshotFailure(snap([])) === false);

// Unrelated events must not affect the state.
ok('unrelated events do not create an unresolved failure',
  availability.hasUnresolvedSnapshotFailure(
    snap(['model:action_limit', 'run:feasibility_decision', 'model:action_contract_passed'])) === false);

// A single failure is unresolved: this is what makes a second failure stop
// recoverably instead of terminalizing.
ok('a lone failure is unresolved', availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL])) === true);

// Recovery closes it — and a later clean entry must NOT re-emit recovery.
ok('failure followed by recovery is resolved',
  availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL, RECOV])) === false);
ok('a clean re-entry after recovery stays resolved (no duplicate recovery)',
  availability.hasUnresolvedSnapshotFailure(
    snap([UNAVAIL, RECOV, 'model:action_contract_passed'])) === false);

// Repeated failed recovery attempts stay unresolved — the run remains stopped
// rather than terminalizing on the first failed recovery capture.
ok('repeated failures remain unresolved',
  availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL, UNAVAIL, UNAVAIL])) === true);
ok('many failures then one recovery resolves them',
  availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL, UNAVAIL, UNAVAIL, RECOV])) === false);

// A genuinely NEW failure after a recovery opens a new transition.
ok('a new failure after recovery is unresolved again',
  availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL, RECOV, UNAVAIL])) === true);
eq('latest transition wins over history',
  availability.latestSnapshotAvailabilityTransition(snap([UNAVAIL, RECOV, UNAVAIL])), 'unavailable');
eq('recovery after a new failure resolves again',
  availability.latestSnapshotAvailabilityTransition(snap([UNAVAIL, RECOV, UNAVAIL, RECOV])), 'recovered');

// Existence-based logic (blocker B4) would answer "unresolved" for every case
// containing a failure. Transition-based logic must disagree on exactly those.
ok('transition logic differs from existence logic where B4 mattered',
  availability.hasUnresolvedSnapshotFailure(snap([UNAVAIL, RECOV])) === false
  && snap([UNAVAIL, RECOV]).events.some(e => e.type === UNAVAIL));

// The resolved failure is identified so recovery evidence can name it.
const withDetail = { events: [
  { type: UNAVAIL, classification: 'WORKSPACE_SNAPSHOT_UNAVAILABLE', phase: 'execution_step', step: 3 },
  { type: RECOV },
  { type: UNAVAIL, classification: 'WORKSPACE_CONTAINMENT_VIOLATION', phase: 'run_start', step: null }
] };
eq('unresolved failure returns the LATEST failure, not the first',
  availability.unresolvedSnapshotFailure(withDetail).classification, 'WORKSPACE_CONTAINMENT_VIOLATION');
eq('a resolved run has no unresolved failure to name',
  availability.unresolvedSnapshotFailure(snap([UNAVAIL, RECOV])), null);

// server.js must consume the module rather than re-deriving this inline.
ok('server.js imports the availability module',
  /require\('\.\/runtime\/workspace-snapshot-availability'\)/.test(SOURCE));

console.log(`\nPASS: workspace snapshot availability (A1) — ${passed} checks`);
