#!/usr/bin/env node
'use strict';
// Evidence-truthfulness contract test.
//
// server.js cannot be required in-process (it calls start() on load and demands
// a live database), so this test uses the established pattern from
// execution-semantics-test.js: extract the functions under test from source and
// execute them against injected stubs. That gives real behavioral coverage of
// the feasibility gate rather than a source-text grep.
//
// Structural assertions are used only where behavior genuinely cannot be
// isolated — the two corrective-feedback assignments and the authority block —
// and each is written to fail if the defect is reintroduced.

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

// Extract a top-level function (async or sync) by brace matching.
//
// The parameter list is skipped by paren depth before brace matching starts.
// A naive `[^{]*\{` stops at the `{}` inside a default parameter such as
// `options = {}` and silently returns a truncated, unparseable fragment.
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
  if (bodyStart === -1) throw new Error(`could not locate body of ${name}`);

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

// Guard the extractor itself: a silently truncated extraction would make every
// assertion below vacuous.
{
  const sample = extractFunction(
    'function sample(a, options = {}) { return { ok: true }; }\nfunction after() {}',
    'sample'
  );
  assert.equal(sample.endsWith('}'), true, 'extractor must capture the full body');
  assert.equal(/return \{ ok: true \}/.test(sample), true, 'extractor must not stop at a default-parameter brace');
}

// ── The feasibility gate, executed on every path ─────────────────────────────

const gateSource = [
  extractFunction(SOURCE, 'recordRuntimeFeasibilityDecision'),
  extractFunction(SOURCE, 'assertRuntimeBudgetFeasible')
].join('\n\n');

function buildGate({ required, contract, mutationCap = 2 }) {
  const runEvents = [];
  const journalEvents = [];
  const factory = new Function('deps', `
    const {
      isBrowserRun, buildObjectiveContract, countRequiredContractMutations,
      recordRunEvent, appendEvent, MAX_MUTATING_ACTIONS_PER_RESPONSE
    } = deps;
    ${gateSource}
    return assertRuntimeBudgetFeasible;
  `);
  const gate = factory({
    isBrowserRun: run => run.kind === 'browser',
    buildObjectiveContract: () => contract,
    countRequiredContractMutations: () => required,
    recordRunEvent: async (run, type, message, details) => {
      runEvents.push({ type, message, ...details });
    },
    appendEvent: async event => { journalEvents.push(event); },
    MAX_MUTATING_ACTIONS_PER_RESPONSE: mutationCap
  });
  return { gate, runEvents, journalEvents };
}

const RECOGNIZED = { source: 'objective-contract', recognized: true, intent: 'create_folder' };
const UNRECOGNIZED = { source: 'objective-contract', recognized: false, intent: 'model_driven' };

async function runGate(options, run = { id: 8, ticketId: 3 }, ticket = { objective: 'obj' }, limits = { maxExecutionSteps: 32 }) {
  const harness = buildGate(options);
  let thrown = null;
  try {
    await harness.gate(run, ticket, null, limits, options.compiledContract || null);
  } catch (error) {
    thrown = error;
  }
  return { ...harness, thrown };
}

// Every path must leave exactly one durable decision in BOTH the replay event
// stream and the journal. Silence on any path is the defect being fixed.
const cases = [
  {
    name: 'passed',
    options: { required: 24, contract: RECOGNIZED },
    run: { id: 1, ticketId: 1 },
    expect: { outcome: 'passed', checked: true, requiredMutations: 24, projectedSteps: 12, throws: false }
  },
  {
    name: 'rejected',
    options: { required: 24, contract: RECOGNIZED },
    limits: { maxExecutionSteps: 4 },
    expect: { outcome: 'rejected', checked: true, requiredMutations: 24, projectedSteps: 12, throws: true }
  },
  {
    name: 'skipped_unrecognized_objective',
    options: { required: null, contract: UNRECOGNIZED },
    expect: { outcome: 'skipped_unrecognized_objective', checked: false, requiredMutations: null, projectedSteps: null, throws: false }
  },
  {
    name: 'skipped_no_required_mutations',
    options: { required: 0, contract: RECOGNIZED },
    expect: { outcome: 'skipped_no_required_mutations', checked: false, requiredMutations: 0, projectedSteps: 0, throws: false }
  },
  {
    name: 'skipped_browser_run',
    options: { required: 24, contract: RECOGNIZED },
    run: { id: 2, ticketId: 2, kind: 'browser' },
    expect: { outcome: 'skipped_browser_run', checked: false, throws: false }
  },
  {
    name: 'skipped_workflow_run',
    options: { required: 24, contract: RECOGNIZED },
    run: { id: 3, ticketId: 3, executionMode: 'workflow' },
    expect: { outcome: 'skipped_workflow_run', checked: false, throws: false }
  }
];

(async () => {
  const seenOutcomes = new Set();

  for (const testCase of cases) {
    const result = await runGate(
      testCase.options,
      testCase.run || { id: 8, ticketId: 3 },
      { objective: 'obj' },
      testCase.limits || { maxExecutionSteps: 32 }
    );

    eq(`${testCase.name}: exactly one replay decision event`, result.runEvents.length, 1);
    eq(`${testCase.name}: exactly one journal decision event`, result.journalEvents.length, 1);
    eq(`${testCase.name}: replay event type`, result.runEvents[0].type, 'run:feasibility_decision');
    eq(`${testCase.name}: journal event type`, result.journalEvents[0].type, 'run.feasibility_decision');
    eq(`${testCase.name}: outcome recorded`, result.runEvents[0].outcome, testCase.expect.outcome);
    eq(`${testCase.name}: checked flag recorded`, result.runEvents[0].checked, testCase.expect.checked);

    // Resolved inputs are present on every path, null where genuinely absent.
    for (const field of ['effectiveMutationCap', 'effectiveExecutionStepLimit', 'recognitionSource', 'outcome']) {
      ok(`${testCase.name}: records ${field}`,
        Object.prototype.hasOwnProperty.call(result.runEvents[0], field));
    }
    eq(`${testCase.name}: effective mutation cap recorded`, result.runEvents[0].effectiveMutationCap, 2);

    if (testCase.expect.requiredMutations !== undefined) {
      eq(`${testCase.name}: requiredMutations`, result.runEvents[0].requiredMutations, testCase.expect.requiredMutations);
      eq(`${testCase.name}: projectedSteps`, result.runEvents[0].projectedSteps, testCase.expect.projectedSteps);
    }

    eq(`${testCase.name}: throw behavior unchanged`, Boolean(result.thrown), testCase.expect.throws);
    if (testCase.expect.throws) {
      eq(`${testCase.name}: error code preserved`, result.thrown.code, 'RUNTIME_BUDGET_INSUFFICIENT');
      // Evidence must be durable BEFORE the throw, or a rejected run loses it.
      ok(`${testCase.name}: decision recorded before throwing`, result.runEvents.length === 1);
    }

    // Journal and replay payloads must agree — one decision, not two stories.
    const { type: _replayType, message: _msg, ...replayPayload } = result.runEvents[0];
    eq(`${testCase.name}: journal payload matches replay payload`, result.journalEvents[0].payload, replayPayload);

    seenOutcomes.add(testCase.expect.outcome);
  }

  // Every outcome the gate can produce is covered above.
  const declaredOutcomes = [...SOURCE.matchAll(/outcome: '(passed|rejected|skipped_[a-z_]+)'/g)].map(m => m[1]);
  eq('every outcome emitted by the gate is exercised',
    [...new Set(declaredOutcomes)].sort(), [...seenOutcomes].sort());

  // The gate still enforces only the step relation — no widened enforcement.
  const gateBody = extractFunction(SOURCE, 'assertRuntimeBudgetFeasible');
  ok('gate throws only on the projected-step relation',
    (gateBody.match(/RUNTIME_BUDGET_INSUFFICIENT/g) || []).length === 1);
  ok('gate does not consult wall-clock budget',
    !/maxRuntimeDurationMs/.test(gateBody));
  ok('gate does not consult model-request budget',
    !/maxModelRequestsPerRun/.test(gateBody));

  // ── Both action gates preserve the prior step's action results ─────────────
  const totalGate = SOURCE.slice(
    SOURCE.indexOf("warning: 'model:action_limit'") - 1200,
    SOURCE.indexOf("warning: 'model:action_limit'") + 200
  );
  ok('total-action gate spreads priorStepActionResults into its feedback',
    /actionResults = \[\s*\.\.\.priorStepActionResults,/.test(totalGate));

  const mutatingIndex = SOURCE.indexOf("warning: 'model:mutating_action_limit',\n              message: buildMutatingActionLimitFeedback");
  ok('mutating-action gate still spreads priorStepActionResults',
    mutatingIndex > 0 && /actionResults = \[\s*\.\.\.priorStepActionResults,/.test(
      SOURCE.slice(mutatingIndex - 400, mutatingIndex + 200)));

  const totalGateAssignments = (SOURCE.match(/actionResults = \[\{\s*\n?\s*warning: 'model:action_limit'/g) || []);
  eq('no bare overwrite left on the total-action feedback path', totalGateAssignments.length, 0);

  // ── Terminal thresholds report the value actually enforced ─────────────────
  ok('inspection no-progress threshold is a named constant',
    /const INSPECTION_NO_PROGRESS_THRESHOLD = 3;/.test(SOURCE));
  ok('stalled-response threshold is a named constant',
    /const STALLED_RESPONSE_THRESHOLD = 2;/.test(SOURCE));
  ok('no-progress termination compares against the named threshold',
    /noProgressResponses >= INSPECTION_NO_PROGRESS_THRESHOLD/.test(SOURCE));
  ok('no-progress evidence reports the named threshold',
    /configuredLimit: INSPECTION_NO_PROGRESS_THRESHOLD/.test(SOURCE));
  ok('stall termination compares against the named threshold',
    /stalledResponses >= STALLED_RESPONSE_THRESHOLD/.test(SOURCE));
  ok('stall evidence reports the named threshold',
    /configuredLimit: STALLED_RESPONSE_THRESHOLD/.test(SOURCE));
  eq('no run-limit evidence still reports the fabricated limit of 1',
    (SOURCE.match(/configuredLimit: 1,/g) || []).length, 0);

  // ── Historical authority block is sourced from run evidence ───────────────
  const authorityBlock = SOURCE.slice(SOURCE.indexOf('    authority: {'), SOURCE.indexOf('    provenance: {'));
  ok('authority block exists', authorityBlock.length > 0);
  ok('authority block does not read the live total-action constant',
    !/maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE/.test(authorityBlock));
  ok('authority block does not read the live mutating constant',
    !/maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE/.test(authorityBlock));
  ok('authority block resolves caps from run evidence',
    /maxActionsPerResponse: actionCaps\.maxActionsPerResponse/.test(authorityBlock));
  ok('authority block exposes cap provenance to the view',
    /actionCapsRecorded: actionCaps\.recorded/.test(authorityBlock));

  // The view must label an unrecorded cap rather than presenting it as governing.
  const runDetail = fs.readFileSync(path.join(ROOT, 'views', 'run-detail.ejs'), 'utf8');
  ok('run detail labels unrecorded per-response caps',
    /actionCapsRecorded/.test(runDetail) && /not recorded for this run/.test(runDetail));
  ok('run detail no longer renders the old heuristic field',
    !/boundedTransitionRejectionCount/.test(runDetail));
  ok('run detail renders the exact rejection count',
    /failureSummary\.rejectedResponseCount/.test(runDetail));

  // ── Semantics are recorded once, and no gate reads them ───────────────────
  ok('semantics are attached to the existing runtime limits snapshot',
    /semantics: buildCurrentExecutionSemanticsSnapshot\(limits, profile\)/.test(SOURCE));
  ok('semantics survive snapshot normalization',
    /semantics: normalizeExecutionSemanticsSnapshot\(snapshot\.semantics\)/.test(SOURCE));
  eq('semantics snapshot is built in exactly one place',
    (SOURCE.match(/buildCurrentExecutionSemanticsSnapshot\(/g) || []).length, 2); // definition + single call

  // The record must stay descriptive: no enforcement path may branch on it.
  const enforcementReads = (SOURCE.match(/limits\.semantics\./g) || []);
  eq('no enforcement gate branches on the semantics record', enforcementReads.length, 0);

  // ── The production resolution path actually attaches the record ───────────
  // Executed, not grepped: the real resolveAgentRuntimeLimitsFromConfig is run
  // against stubbed dependencies so a missing or partial semantics block fails
  // here rather than only showing up in a live run's persisted evidence.
  const resolverSource = [
    extractFunction(SOURCE, 'buildCurrentExecutionSemanticsSnapshot'),
    extractFunction(SOURCE, 'resolveAgentRuntimeLimitsFromConfig')
  ].join('\n\n');

  function runResolver({ objective = 'create folders A-Z in the workspace', profile = null, workflow = false } = {}) {
    const factory = new Function('deps', `
      const {
        buildExecutionSemanticsSnapshot, getDeploymentRuntimeDefaults, RUNTIME_LIMIT_CONFIG_KEYS,
        RUNTIME_LIMIT_MINIMUMS, detectWorkloadProfile, getProfileRuntimeLimits, isReportObjective,
        getReportRuntimeLimits, runtimeLimitsForExecution, getWorkflowSpecificLimits,
        ENABLE_PREFIX_TRUNCATION, MODEL_CONTRACT_COMPILER_ENABLED, ACTION_CONTRACT_VIOLATION_THRESHOLD,
        STALLED_RESPONSE_THRESHOLD, INSPECTION_NO_PROGRESS_THRESHOLD, RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES,
        MAX_AGENT_ACTIONS_PER_RESPONSE, MAX_MUTATING_ACTIONS_PER_RESPONSE
      } = deps;
      ${resolverSource}
      return resolveAgentRuntimeLimitsFromConfig;
    `);
    const base = {
      maxExecutionSteps: 32, maxModelRequestsPerRun: 32,
      maxWorkspaceOperationsPerRun: 256, maxRuntimeDurationMs: 400000
    };
    const resolve = factory({
      buildExecutionSemanticsSnapshot: require('../runtime/execution-semantics').buildExecutionSemanticsSnapshot,
      getDeploymentRuntimeDefaults: () => ({ ...base }),
      RUNTIME_LIMIT_CONFIG_KEYS: Object.keys(base),
      RUNTIME_LIMIT_MINIMUMS: { maxExecutionSteps: 1, maxModelRequestsPerRun: 1, maxWorkspaceOperationsPerRun: 1, maxRuntimeDurationMs: 5000 },
      detectWorkloadProfile: () => profile,
      getProfileRuntimeLimits: (limits, name) => ({ ...limits, maxListDirectoryPerRun: 2, maxReadFilePerRun: 6, profileName: name }),
      isReportObjective: () => false,
      getReportRuntimeLimits: limits => limits,
      runtimeLimitsForExecution: limits => {
        const out = { ...base };
        for (const key of ['maxListDirectoryPerRun', 'maxReadFilePerRun']) {
          if (Number.isInteger(limits[key])) out[key] = limits[key];
        }
        return out;
      },
      getWorkflowSpecificLimits: () => ({ maxTransitions: 16, maxLoopIterations: 3, maxMutations: 2 }),
      ENABLE_PREFIX_TRUNCATION: false,
      MODEL_CONTRACT_COMPILER_ENABLED: false,
      ACTION_CONTRACT_VIOLATION_THRESHOLD: 2,
      STALLED_RESPONSE_THRESHOLD: 2,
      INSPECTION_NO_PROGRESS_THRESHOLD: 3,
      RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES: 200,
      MAX_AGENT_ACTIONS_PER_RESPONSE: 8,
      MAX_MUTATING_ACTIONS_PER_RESPONSE: 2
    });
    return resolve(objective, {}, { workflow });
  }

  const resolved = runResolver();
  ok('resolution attaches a semantics block to the snapshot', Boolean(resolved.snapshot.semantics));
  const requiredControls = [
    'prefixTruncationEnabled', 'contractCompilerEnabled', 'actionContractViolationThreshold',
    'stalledResponseThreshold', 'inspectionNoProgressThreshold', 'workspaceSnapshotMaxEntries',
    'maxActionsPerResponse', 'maxMutatingActionsPerResponse'
  ];
  for (const control of requiredControls) {
    ok(`resolved snapshot records ${control}`,
      Object.prototype.hasOwnProperty.call(resolved.snapshot.semantics, control));
  }
  eq('resolved snapshot records the real prefix-truncation flag', resolved.snapshot.semantics.prefixTruncationEnabled, false);
  eq('resolved snapshot records the real compiler flag', resolved.snapshot.semantics.contractCompilerEnabled, false);
  eq('resolved snapshot records the terminal threshold', resolved.snapshot.semantics.inspectionNoProgressThreshold, 3);
  eq('resolved snapshot records the workspace entry limit', resolved.snapshot.semantics.workspaceSnapshotMaxEntries, 200);
  eq('no profile resolves to a null workload profile', resolved.snapshot.semantics.workloadProfile, null);
  eq('no profile leaves list/read limits unrecorded',
    [resolved.snapshot.semantics.maxListDirectoryPerRun, resolved.snapshot.semantics.maxReadFilePerRun], [null, null]);

  // A matched profile records its name and the inspection limits it imposed.
  const profiled = runResolver({ profile: 'refactor' });
  eq('matched profile is recorded', profiled.snapshot.semantics.workloadProfile, 'refactor');
  eq('matched profile records its listDirectory limit', profiled.snapshot.semantics.maxListDirectoryPerRun, 2);
  eq('matched profile records its readFile limit', profiled.snapshot.semantics.maxReadFilePerRun, 6);

  // The resolved block round-trips through the same normalizer persistence uses.
  const { normalizeExecutionSemanticsSnapshot } = require('../runtime/execution-semantics');
  eq('resolved semantics survive the persistence normalizer',
    normalizeExecutionSemanticsSnapshot(JSON.parse(JSON.stringify(resolved.snapshot.semantics))),
    resolved.snapshot.semantics);

  // Existing snapshot content is untouched by the addition.
  ok('resolution still records the limit source', Boolean(resolved.snapshot.source));
  eq('resolution still records the four numeric limits',
    [resolved.snapshot.maxExecutionSteps, resolved.snapshot.maxModelRequestsPerRun,
      resolved.snapshot.maxWorkspaceOperationsPerRun, resolved.snapshot.maxRuntimeDurationMs],
    [32, 32, 256, 400000]);

  // ── Diagnostic bundle surfaces the controls ──────────────────────────────
  ok('bundle has an execution-semantics section',
    /### Execution semantics \(run-start\)/.test(SOURCE));
  for (const label of [
    'Prefix truncation enabled',
    'Objective-contract compiler enabled',
    'Max actions per response',
    'Max mutating actions per response',
    'Action-contract violation threshold',
    'Stalled-response threshold',
    'Inspection no-progress threshold',
    'Workspace snapshot entry limit',
    'Workload profile'
  ]) {
    ok(`bundle surfaces "${label}"`, SOURCE.includes(label));
  }
  ok('bundle states plainly when semantics were not recorded',
    /run predates execution-semantics capture/.test(SOURCE));

  console.log(`\nPASS: evidence truthfulness contract — ${passed} checks`);
})().catch(error => {
  console.error(`\nFAIL: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
