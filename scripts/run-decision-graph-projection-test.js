#!/usr/bin/env node
// Golden-fixture test for the run decision-graph projection
// (runtime/run-decision-graph.js, docs/RUN_DECISION_MAP_DESIGN.md).
// Pure, provider-free, no server: feeds a synthetic run whose evidence contains
// every interesting shape — executed/created/noop/blocked operations, a
// cap-dropped proposal, phase transitions and a phase violation, verification
// with postcondition counts, terminal failure, recorded evaluation and
// consequence, resolved triage — and asserts the exact truthfulness
// properties: evidence-linked edges only, proposed-vs-executed divergence
// rendered first-class, verbatim plan messages, and a stable cursor.

const { buildRunDecisionGraph, renderRunDecisionGraphText } = require('../runtime/run-decision-graph');

function assert(c, m) { if (!c) throw new Error(m); }

const run = {
  id: 42, ticketId: 7, status: 'failed', error: 'Verification failed: 1 postcondition',
  currentPhase: 'terminalization',
  triage: {
    required: false, reasonCode: 'verification_failed', summary: 'Verification failed: 1 postcondition',
    requiredDecision: 'review_failure',
    createdAt: '2026-03-01T09:00:10.000Z', resolvedAt: '2026-03-01T10:00:00.000Z', resolvedBy: 'admin', resolution: 'Reviewed.'
  },
  runEvaluation: {
    effectiveness: { status: 'failed', postconditionsPassed: 2, postconditionsFailed: 1, errors: ['Verification failed: 1 postcondition'] },
    efficiency: { durationMs: 5000, providerRequests: 2, modelResponses: 2, workspaceOperations: 3, mutationCount: 1, retryCount: 0 },
    violations: { status: 'none', items: [] }
  },
  runConsequence: {
    mutations: [
      { operation: 'writeFile', path: 'reports/summary.md' },
      { operation: 'deletePath', path: 'tmp/scratch.txt', attempted: true }
    ],
    created: [{ operation: 'writeFile', path: 'reports/summary.md' }],
    updated: [], deleted: [], renamed: [],
    notifications: [], externalEffects: [],
    verification: { postconditionsStatus: 'failed', violationsStatus: 'none' }
  }
};

const snapshot = {
  terminalStatus: 'failed',
  failureReason: 'Verification failed: 1 postcondition',
  parsedModelPlans: [
    { message: 'Listing the workspace to find existing reports.', actions: [{ operation: 'listDirectory', args: { path: '' } }], complete: false, step: 0 },
    {
      message: 'Creating the summary and archive; removing the scratch file.',
      actions: [
        { operation: 'writeFile', args: { path: 'reports/summary.md' } },
        { operation: 'createFolder', args: { path: 'archive' } },
        { operation: 'deletePath', args: { path: 'tmp/scratch.txt' } }
      ],
      complete: true, step: 1
    }
  ],
  providerRequests: [
    { url: 'https://api.example.test/v1/chat/completions', method: 'POST', body: { model: 'gpt-5' }, provider: 'openai', startedAt: '2026-03-01T09:00:01.000Z', durationMs: 900 },
    { url: 'https://api.example.test/v1/chat/completions', method: 'POST', body: { model: 'gpt-5' }, provider: 'openai', startedAt: '2026-03-01T09:00:04.000Z', durationMs: 1200 }
  ],
  modelResponses: [{}, {}],
  workspaceOperations: [
    { operation: { operation: 'listDirectory', args: { path: '' } }, result: { entries: [] }, historyId: 1, durationMs: 3 },
    { operation: { operation: 'writeFile', args: { path: 'reports/summary.md' } }, result: { status: 'created' }, historyId: 2, durationMs: 8 },
    { operation: { operation: 'createFolder', args: { path: 'archive' } }, blocked: true, reason: 'Path is outside owned output paths', historyId: 3 }
  ],
  events: [{ type: 'run:mutating_actions_truncated', payload: { dropped: 1 } }]
};

const runEvents = [
  { type: 'execution.phase_transition', seq: 1, stepId: '0', payload: { fromPhase: 'planning', toPhase: 'inspection', reason: 'Inferred from model response actions' } },
  { type: 'execution.phase_transition', seq: 2, stepId: '1', payload: { fromPhase: 'inspection', toPhase: 'mutation', reason: 'Inferred from model response actions' } },
  { type: 'execution.phase_violation', seq: 3, stepId: '1', payload: { currentPhase: 'mutation', inferredPhase: 'mixed', violationType: 'mixed_phase', reason: 'Mixed-phase response: actions belong to different execution phases' } },
  { type: 'run.postconditions_checked', seq: 4, payload: { workflowId: 9, contractSource: 'workflow', status: 'failed', passed: 2, failed: 1, total: 3 } },
  { type: 'run.verification_failed', seq: 5, payload: { status: 'failed', error: 'Verification failed: 1 postcondition' } }
];

const operationHistory = [
  { id: 1, step: 0, operation: 'listDirectory', args: { path: '' } },
  { id: 2, step: 1, operation: 'writeFile', args: { path: 'reports/summary.md' } },
  { id: 3, step: 1, operation: 'createFolder', args: { path: 'archive' } }
];

const graph = buildRunDecisionGraph(run, snapshot, runEvents, operationHistory);
const byId = new Map(graph.nodes.map(node => [node.id, node]));
const edgeSet = new Set(graph.edges.map(edge => `${edge.from}>${edge.to}:${edge.kind}`));

// Identity + lanes.
assert(graph.runId === 42 && graph.ticketId === 7, 'graph must carry run/ticket identity');
assert(JSON.stringify(graph.lanes) === JSON.stringify(['model', 'authority', 'target', 'outcome']), 'lane order must be stable');

// Model lane: verbatim messages, complete flags, request linkage (1:1 here).
assert(byId.get('plan:0') && byId.get('plan:0').detail.message === 'Listing the workspace to find existing reports.', 'plan message must be verbatim');
assert(byId.get('plan:1').status === 'complete_claimed' && byId.get('plan:0').status === 'continuing', 'complete flag must map to status');
assert(byId.get('request:0') && edgeSet.has('request:0>plan:0:flow'), 'provider request must link to its plan when counts align');
assert(edgeSet.has('plan:0>request:1:continuation'), 'continuation edge must connect steps');

// Target lane + authority lane per operation.
assert(byId.get('op:1').status === 'created' && byId.get('op:1').step === 1, 'created op must carry historyId-derived step');
assert(byId.get('op:2').status === 'blocked', 'blocked op must render blocked');
assert(byId.get('auth:op:2').status === 'blocked' && byId.get('auth:op:2').label.includes('owned output paths'), 'authority node must carry the recorded refusal reason');
assert(edgeSet.has('auth:op:2>op:2:blocked') && edgeSet.has('auth:op:1>op:1:executed'), 'authority→target edges must reflect outcome');
assert(edgeSet.has('plan:1>auth:op:1:proposed'), 'plan must connect to the authority decision for its step');

// Proposed-but-not-executed: deletePath tmp/scratch.txt never executed, and a
// truncation event exists → cap-dropped node, edge from its plan.
const dropped = graph.nodes.find(node => node.kind === 'cap_dropped');
assert(dropped && dropped.detail.operation === 'deletePath' && dropped.detail.path === 'tmp/scratch.txt', 'dropped proposal must be first-class');
assert(edgeSet.has(`plan:1>${dropped.id}:dropped`), 'dropped proposal must edge from its plan');
// The blocked createFolder DID execute (as a blocked op) — it must not double-render as unexecuted.
assert(!graph.nodes.some(node => node.kind === 'unexecuted_proposal' && node.detail.operation === 'createFolder'), 'blocked op must not also appear as unexecuted proposal');

// Execution phase progression: recorded transitions, step-anchored, with the
// stored currentPhase carried at the top level.
assert(graph.currentPhase === 'terminalization', 'graph must carry the stored current phase');
assert(Array.isArray(graph.phases) && graph.phases.length === 2, 'both recorded phase transitions must project');
assert(graph.phases[0].fromPhase === 'planning' && graph.phases[0].toPhase === 'inspection' && graph.phases[0].step === 0, 'phase transition must anchor to its recorded step');
assert(graph.phases[1].toPhase === 'mutation' && graph.phases[1].step === 1 && graph.phases[1].reason === 'Inferred from model response actions', 'phase transition must carry the recorded reason');
assert(graph.phases.every(t => typeof t.evidenceRef === 'string' && t.evidenceRef.length > 0), 'phase transitions must cite evidence');
assert(!graph.nodes.some(node => node.label === 'execution.phase_transition'), 'phase transitions must render as the phase axis, not as annotation nodes');

// Phase violation surfaces as a step-linked annotation.
const violation = graph.nodes.find(node => node.kind === 'runtime_event' && node.label === 'execution.phase_violation');
assert(violation && violation.step === 1, 'phase violation must annotate at its recorded step');
assert(violation.detail.payload.violationType === 'mixed_phase', 'violation annotation must carry its full recorded payload');

// Provider request nodes carry the recorded request identity.
assert(byId.get('request:0').detail.model === 'gpt-5' && byId.get('request:0').detail.provider === 'openai', 'provider request must carry recorded model and provider');
assert(byId.get('request:0').detail.durationMs === 900, 'provider request must carry duration');

// Outcome lane: verification failed → terminal failed → evaluation → consequence, triage chained off terminal.
assert(byId.get('verification').status === 'failed', 'verification node must reflect the recorded event');
assert(byId.get('verification').label.includes('2/3 postconditions passed'), 'verification label must carry postcondition counts');
assert(byId.get('verification').detail.eventType === 'run.verification_failed', 'explicit verdict event must win over the postconditions check');
assert(byId.get('verification').detail.postconditionsPayload && byId.get('verification').detail.postconditionsPayload.total === 3, 'verification must carry the full postconditions payload');
assert(byId.get('terminal').status === 'failed' && byId.get('terminal').label.includes('Verification failed'), 'terminal node must carry status + reason');
assert(byId.get('triage').status === 'resolved', 'resolved triage must render resolved');
assert(edgeSet.has('verification>terminal:flow') && edgeSet.has('terminal>triage:flow') && edgeSet.has('plan:1>verification:flow'), 'outcome chain must be edged');

// Recorded evaluation and consequence are first-class outcome nodes.
const evaluationNode = byId.get('evaluation');
assert(evaluationNode && evaluationNode.status === 'failed' && evaluationNode.label.includes('violations none'), 'evaluation node must carry effectiveness and violations status');
assert(evaluationNode.detail.efficiency.providerRequests === 2, 'evaluation node must carry the recorded efficiency record');
assert(edgeSet.has('terminal>evaluation:flow'), 'evaluation must chain from the terminal node');
const consequenceNode = byId.get('consequence');
assert(consequenceNode && consequenceNode.label.includes('1 committed mutation(s)') && consequenceNode.label.includes('1 attempted'), 'consequence node must separate committed from attempted mutations');
assert(consequenceNode.detail.verification.postconditionsStatus === 'failed', 'consequence node must carry the verification rollup');
assert(edgeSet.has('evaluation>consequence:flow'), 'consequence must chain from evaluation');

// Truncation annotation surfaces as a runtime event node, payload untruncated.
const annotation = graph.nodes.find(node => node.kind === 'runtime_event' && node.label === 'run:mutating_actions_truncated');
assert(annotation, 'truncation event must annotate');
assert(annotation.detail.payload && annotation.detail.payload.dropped === 1, 'annotation must carry its full recorded payload');

// No-truncation contract: layout-truncated labels must carry full values in detail.
assert(byId.get('triage').detail.summary === run.triage.summary && byId.get('triage').detail.resolution === 'Reviewed.', 'triage node must carry full summary and resolution');
assert(byId.get('terminal').detail.failureReason === snapshot.failureReason, 'terminal node must carry the full failure reason');
assert(byId.get('auth:op:2').detail.reason === 'Path is outside owned output paths', 'authority node must carry the full refusal reason');

// Every node carries an evidence reference; every edge endpoint exists.
for (const node of graph.nodes) assert(typeof node.evidenceRef === 'string' && node.evidenceRef.length > 0, `node ${node.id} must carry evidenceRef`);
for (const edge of graph.edges) assert(byId.has(edge.from) && byId.has(edge.to), `edge ${edge.from}>${edge.to} endpoints must exist`);

// Cursor is deterministic for identical evidence and changes when evidence grows.
const again = buildRunDecisionGraph(run, snapshot, runEvents, operationHistory);
assert(again.cursor === graph.cursor, 'cursor must be deterministic for identical evidence');
const grown = buildRunDecisionGraph(run, { ...snapshot, workspaceOperations: [...snapshot.workspaceOperations, { operation: { operation: 'writeFile', args: { path: 'x' } }, result: {} }] }, runEvents, operationHistory);
assert(grown.cursor !== graph.cursor, 'cursor must change when evidence grows');
const phaseMoved = buildRunDecisionGraph({ ...run, currentPhase: 'verification' }, snapshot, runEvents, operationHistory);
assert(phaseMoved.cursor !== graph.cursor, 'cursor must change when the phase advances');

// Text rendering (diagnostics bundle): same projection, plain text, nothing lost.
const text = renderRunDecisionGraphText(graph).join('\n');
assert(text.includes('step 0 [continuing] model message (verbatim):') && text.includes('Listing the workspace to find existing reports.'), 'text must carry step-0 verbatim message');
assert(text.includes('step 1 [complete:true] model message (verbatim):') && text.includes('Creating the summary and archive; removing the scratch file.'), 'text must carry step-1 message with complete flag');
assert(text.includes('[authority] blocked: blocked: Path is outside owned output paths') || text.includes('blocked: Path is outside owned output paths'), 'text must carry the full refusal reason');
assert(text.includes('dropped by per-response cap: deletePath tmp/scratch.txt'), 'text must carry the cap-dropped proposal');
assert(text.includes('run failed: Verification failed: 1 postcondition'), 'text must carry the terminal outcome with full reason');
assert(text.includes('resolution: Reviewed.'), 'text must carry the triage resolution');
assert(text.includes('Execution phase: planning → inspection (step 0) → mutation (step 1)'), 'text must carry the phase progression');
assert(text.includes('evaluation: effectiveness failed · violations none'), 'text must carry the evaluation record');
assert(text.includes('postconditions 2 passed / 1 failed'), 'text must carry the evaluation postcondition counts');
assert(text.includes('1 committed mutation(s)'), 'text must carry the consequence record');

// Renderer honesty on empty graphs.
const bareText = renderRunDecisionGraphText(buildRunDecisionGraph({ id: 1, ticketId: 1, status: 'pending' }, null, [], []));
assert(bareText.some(line => line.includes('run pending')), 'bare-run text must render only the status');

// Empty-evidence honesty: a run with no snapshot still yields a terminal node, nothing invented.
const bare = buildRunDecisionGraph({ id: 1, ticketId: 1, status: 'pending' }, null, [], []);
assert(bare.nodes.length === 1 && bare.nodes[0].id === 'terminal' && bare.nodes[0].status === 'pending', 'bare run must project only its status');
assert(bare.edges.length === 0, 'bare run must have no invented edges');
assert(bare.currentPhase === null && bare.phases.length === 0, 'bare run must not invent phase state');

console.log('PASS: run decision-graph projection — evidence-linked lanes, phase progression, proposed-vs-executed divergence, outcome chain, deterministic cursor');
