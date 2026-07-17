#!/usr/bin/env node
// Golden-fixture test for the run decision-graph projection
// (runtime/run-decision-graph.js, docs/RUN_DECISION_MAP_DESIGN.md).
// Pure, provider-free, no server: feeds a synthetic run whose evidence contains
// every interesting shape — executed/created/noop/blocked operations, a
// cap-dropped proposal, verification, terminal failure, resolved triage — and
// asserts the exact truthfulness properties: evidence-linked edges only,
// proposed-vs-executed divergence rendered first-class, verbatim plan
// messages, and a stable cursor.

const { buildRunDecisionGraph } = require('../runtime/run-decision-graph');

function assert(c, m) { if (!c) throw new Error(m); }

const run = {
  id: 42, ticketId: 7, status: 'failed', error: 'Verification failed: 1 postcondition',
  triage: {
    required: false, reasonCode: 'verification_failed', requiredDecision: 'review_failure',
    createdAt: '2026-03-01T09:00:10.000Z', resolvedAt: '2026-03-01T10:00:00.000Z', resolvedBy: 'admin', resolution: 'Reviewed.'
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
  providerRequests: [{ durationMs: 900 }, { durationMs: 1200 }],
  modelResponses: [{}, {}],
  workspaceOperations: [
    { operation: { operation: 'listDirectory', args: { path: '' } }, result: { entries: [] }, historyId: 1, durationMs: 3 },
    { operation: { operation: 'writeFile', args: { path: 'reports/summary.md' } }, result: { status: 'created' }, historyId: 2, durationMs: 8 },
    { operation: { operation: 'createFolder', args: { path: 'archive' } }, blocked: true, reason: 'Path is outside owned output paths', historyId: 3 }
  ],
  events: [{ type: 'run:mutating_actions_truncated', payload: { dropped: 1 } }]
};

const runEvents = [
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

// Outcome lane: verification failed → terminal failed → resolved triage, chained.
assert(byId.get('verification').status === 'failed', 'verification node must reflect the recorded event');
assert(byId.get('terminal').status === 'failed' && byId.get('terminal').label.includes('Verification failed'), 'terminal node must carry status + reason');
assert(byId.get('triage').status === 'resolved', 'resolved triage must render resolved');
assert(edgeSet.has('verification>terminal:flow') && edgeSet.has('terminal>triage:flow') && edgeSet.has('plan:1>verification:flow'), 'outcome chain must be edged');

// Truncation annotation surfaces as a runtime event node.
assert(graph.nodes.some(node => node.kind === 'runtime_event' && node.label === 'run:mutating_actions_truncated'), 'truncation event must annotate');

// Every node carries an evidence reference; every edge endpoint exists.
for (const node of graph.nodes) assert(typeof node.evidenceRef === 'string' && node.evidenceRef.length > 0, `node ${node.id} must carry evidenceRef`);
for (const edge of graph.edges) assert(byId.has(edge.from) && byId.has(edge.to), `edge ${edge.from}>${edge.to} endpoints must exist`);

// Cursor is deterministic for identical evidence and changes when evidence grows.
const again = buildRunDecisionGraph(run, snapshot, runEvents, operationHistory);
assert(again.cursor === graph.cursor, 'cursor must be deterministic for identical evidence');
const grown = buildRunDecisionGraph(run, { ...snapshot, workspaceOperations: [...snapshot.workspaceOperations, { operation: { operation: 'writeFile', args: { path: 'x' } }, result: {} }] }, runEvents, operationHistory);
assert(grown.cursor !== graph.cursor, 'cursor must change when evidence grows');

// Empty-evidence honesty: a run with no snapshot still yields a terminal node, nothing invented.
const bare = buildRunDecisionGraph({ id: 1, ticketId: 1, status: 'pending' }, null, [], []);
assert(bare.nodes.length === 1 && bare.nodes[0].id === 'terminal' && bare.nodes[0].status === 'pending', 'bare run must project only its status');
assert(bare.edges.length === 0, 'bare run must have no invented edges');

console.log('PASS: run decision-graph projection — evidence-linked lanes, proposed-vs-executed divergence, outcome chain, deterministic cursor');
