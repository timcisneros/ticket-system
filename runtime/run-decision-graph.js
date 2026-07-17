'use strict';

// Run decision graph — a pure, side-effect-free projection of recorded run
// evidence into a lane graph (docs/RUN_DECISION_MAP_DESIGN.md). It renders the
// truth hierarchy spatially: what the model proposed (inference), what the
// runtime allowed (guards), what actually executed against the target (facts),
// and how the run was verified and terminalized (outcome).
//
// Honesty rules:
//   - Nodes and edges derive only from recorded linkage (plan step numbers,
//     historyId → operation-history step, chronological array order). No edge
//     is drawn that the evidence does not assert.
//   - A node label may truncate for layout ONLY if the full underlying value
//     is carried untruncated in the node's `detail` — nothing recorded is
//     reachable solely through a truncated string.
//   - Proposed actions with no recorded execution are first-class nodes
//     (dropped/blocked/unexecuted), never smoothed over.
//   - This is a projection: it reads run/snapshot/events/history and writes
//     nothing. Same contract as the ticket timeline.

const MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function normalizePath(value) {
  return String(value || '').trim().replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
}

function actionSignature(operation, args) {
  const path = args && args.path !== undefined ? normalizePath(args.path) : '';
  const nextPath = args && args.nextPath !== undefined ? normalizePath(args.nextPath) : '';
  const url = args && args.url !== undefined ? String(args.url) : '';
  return `${operation || ''}|${path}|${nextPath}|${url}`;
}

function operationOutcome(op) {
  if (op.blocked) return 'blocked';
  if (op.error) return 'error';
  const status = op.result && op.result.status;
  if (status === 'already_exists_noop') return 'noop';
  if (status === 'created') return 'created';
  if (op.result !== undefined && op.result !== null) return 'ok';
  return 'recorded';
}

function truncateLabel(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Build the graph. All inputs are plain recorded structures:
//   run              — the stored run record (status, triage, terminal fields)
//   snapshot         — the hydrated replay snapshot (may be null)
//   runEvents        — journal events scoped to this run (may be empty)
//   operationHistory — operation-history records for this run (may be empty)
function buildRunDecisionGraph(run, snapshot, runEvents = [], operationHistory = []) {
  const nodes = [];
  const edges = [];
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const plans = Array.isArray(snap.parsedModelPlans) ? snap.parsedModelPlans : [];
  const workspaceOps = Array.isArray(snap.workspaceOperations) ? snap.workspaceOperations : [];
  const browserOps = Array.isArray(snap.browserOperations) ? snap.browserOperations : [];
  const workflowActions = Array.isArray(snap.workflowActions) ? snap.workflowActions : [];
  const providerRequests = Array.isArray(snap.providerRequests) ? snap.providerRequests : [];
  const snapEvents = Array.isArray(snap.events) ? snap.events : [];
  const journalEvents = Array.isArray(runEvents) ? runEvents : [];
  const history = Array.isArray(operationHistory) ? operationHistory : [];

  const stepByHistoryId = new Map();
  history.forEach(record => {
    if (record && record.id != null && Number.isInteger(record.step)) stepByHistoryId.set(record.id, record.step);
  });

  function addNode(node) {
    nodes.push(node);
    return node.id;
  }
  function addEdge(from, to, kind) {
    edges.push({ from, to, kind });
  }

  // ── Model lane: one plan node per parsed plan (the model's stated intent,
  // message verbatim), preceded by its provider request when 1:1 linkage holds.
  const requestLinkable = providerRequests.length === plans.length;
  const planNodeByStep = new Map();
  plans.forEach((plan, index) => {
    const step = Number.isInteger(plan.step) ? plan.step : index;
    if (requestLinkable) {
      const requestId = addNode({
        id: `request:${index}`,
        lane: 'model', step, kind: 'provider_request',
        label: `Model request ${index + 1}`,
        status: 'recorded',
        detail: { durationMs: providerRequests[index] && providerRequests[index].durationMs },
        evidenceRef: `providerRequests[${index}]`
      });
      addEdge(requestId, `plan:${index}`, 'flow');
    }
    addNode({
      id: `plan:${index}`,
      lane: 'model', step, kind: 'parsed_plan',
      label: truncateLabel(plan.message) || `Plan ${index + 1}`,
      status: plan.complete === true ? 'complete_claimed' : 'continuing',
      detail: {
        message: plan.message || null,
        complete: plan.complete === true,
        proposedActions: Array.isArray(plan.actions) ? plan.actions.length : 0
      },
      evidenceRef: `parsedModelPlans[${index}]`
    });
    planNodeByStep.set(step, `plan:${index}`);
    const previous = plans[index - 1];
    if (previous) addEdge(`plan:${index - 1}`, requestLinkable ? `request:${index}` : `plan:${index}`, 'continuation');
  });

  // ── Target lane: executed operations (workspace, browser, workflow), linked
  // to their step via historyId → operation-history when recorded.
  const executedByStep = new Map();
  function targetStepOf(op, fallbackStep) {
    if (op && op.historyId != null && stepByHistoryId.has(op.historyId)) return stepByHistoryId.get(op.historyId);
    return fallbackStep;
  }

  workspaceOps.forEach((op, index) => {
    const operationName = op.operation && op.operation.operation ? op.operation.operation : (typeof op.operation === 'string' ? op.operation : 'operation');
    const args = op.operation && op.operation.args ? op.operation.args : {};
    const step = targetStepOf(op, null);
    const outcome = operationOutcome(op);
    const nodeId = addNode({
      id: `op:${index}`,
      lane: 'target', step, kind: 'workspace_operation',
      label: `${operationName}${args.path ? ' ' + truncateLabel(args.path, 60) : ''}`,
      status: outcome,
      detail: {
        operation: operationName,
        path: args.path || null,
        nextPath: args.nextPath || null,
        reason: op.reason || op.error || null,
        historyId: op.historyId != null ? op.historyId : null,
        durationMs: op.durationMs
      },
      evidenceRef: `workspaceOperations[${index}]`
    });
    if (step !== null && !executedByStep.has(step)) executedByStep.set(step, []);
    if (step !== null) executedByStep.get(step).push({ nodeId, signature: actionSignature(operationName, args), outcome });

    // Authority lane: every recorded target operation passed (or was refused
    // by) the runtime guards — that decision is part of the record.
    const authorityId = addNode({
      id: `auth:op:${index}`,
      lane: 'authority', step, kind: 'authority_decision',
      label: outcome === 'blocked' ? `blocked: ${truncateLabel(op.reason || 'guard refusal', 60)}` : 'allowed',
      status: outcome === 'blocked' ? 'blocked' : 'allowed',
      detail: { reason: op.reason || null },
      evidenceRef: `workspaceOperations[${index}]`
    });
    addEdge(authorityId, nodeId, outcome === 'blocked' ? 'blocked' : 'executed');
    if (step !== null && planNodeByStep.has(step)) addEdge(planNodeByStep.get(step), authorityId, 'proposed');
  });

  browserOps.forEach((item, index) => {
    const operationName = item.operation && item.operation.operation ? item.operation.operation : 'browser_operation';
    addNode({
      id: `browser:${index}`,
      lane: 'target', step: null, kind: 'browser_operation',
      label: `${operationName}${item.operation && item.operation.args && item.operation.args.url ? ' ' + truncateLabel(item.operation.args.url, 50) : ''}`,
      status: item.status === 'ok' ? 'ok' : 'blocked',
      detail: {
        operation: operationName,
        url: item.operation && item.operation.args && item.operation.args.url ? item.operation.args.url : null,
        error: item.error || null,
        errorCode: item.errorCode || null,
        durationMs: item.durationMs
      },
      evidenceRef: `browserOperations[${index}]`
    });
  });

  workflowActions.forEach((action, index) => {
    const nodeId = addNode({
      id: `workflow:${index}`,
      lane: 'target', step: null, kind: 'workflow_action',
      label: `${action.stepId || 'step'} · ${action.action || '-'}`,
      status: 'ok',
      detail: { workflowId: action.workflowId || null, durationMs: action.durationMs },
      evidenceRef: `workflowActions[${index}]`
    });
    if (index > 0) addEdge(`workflow:${index - 1}`, nodeId, 'flow');
  });

  // ── Proposed-but-not-executed: for each plan, mutating actions with no
  // matching executed operation in that step. Distinguish cap-drops (a
  // truncation event exists for the run) from plain unexecuted proposals.
  const truncationEventTypes = new Set(
    [...snapEvents, ...journalEvents]
      .map(event => event && event.type)
      .filter(type => typeof type === 'string' && /trunc/i.test(type))
  );
  const hasTruncationSignal = truncationEventTypes.size > 0;
  plans.forEach((plan, index) => {
    const step = Number.isInteger(plan.step) ? plan.step : index;
    const executed = executedByStep.get(step) || [];
    const executedSignatures = new Set(executed.map(item => item.signature));
    (Array.isArray(plan.actions) ? plan.actions : []).forEach((action, actionIndex) => {
      if (!action || !MUTATING_OPERATIONS.includes(action.operation)) return;
      const signature = actionSignature(action.operation, action.args || {});
      if (executedSignatures.has(signature)) return;
      const dropped = hasTruncationSignal;
      const nodeId = addNode({
        id: `unexecuted:${index}:${actionIndex}`,
        lane: 'authority', step, kind: dropped ? 'cap_dropped' : 'unexecuted_proposal',
        label: dropped
          ? `dropped by per-response cap: ${action.operation}${action.args && action.args.path ? ' ' + truncateLabel(action.args.path, 50) : ''}`
          : `proposed; no recorded execution: ${action.operation}${action.args && action.args.path ? ' ' + truncateLabel(action.args.path, 50) : ''}`,
        status: dropped ? 'dropped' : 'unexecuted',
        detail: { operation: action.operation, path: action.args && action.args.path ? action.args.path : null },
        evidenceRef: `parsedModelPlans[${index}].actions[${actionIndex}]`
      });
      addEdge(`plan:${index}`, nodeId, 'dropped');
    });
  });

  // ── Outcome lane: verification evidence, terminal status, triage.
  const verificationEvent = [...journalEvents, ...snapEvents].find(event =>
    event && ['run.verification_passed', 'run.verification_failed', 'run.postconditions_checked'].includes(event.type));
  let verificationNodeId = null;
  if (verificationEvent) {
    const passed = verificationEvent.type === 'run.verification_passed'
      || (verificationEvent.payload && verificationEvent.payload.status === 'passed');
    verificationNodeId = addNode({
      id: 'verification',
      lane: 'outcome', step: null, kind: 'verification',
      label: passed ? 'verification passed' : 'verification failed',
      status: passed ? 'passed' : 'failed',
      detail: { eventType: verificationEvent.type },
      evidenceRef: `event:${verificationEvent.type}`
    });
  }

  const terminalStatus = snap.terminalStatus || run.status || 'unknown';
  const terminalId = addNode({
    id: 'terminal',
    lane: 'outcome', step: null, kind: 'terminal',
    label: `run ${terminalStatus}${snap.failureReason ? ': ' + truncateLabel(snap.failureReason, 80) : ''}`,
    status: terminalStatus,
    detail: { failureReason: snap.failureReason || run.error || null },
    evidenceRef: 'run.status'
  });
  if (verificationNodeId) addEdge(verificationNodeId, terminalId, 'flow');
  if (plans.length > 0) addEdge(`plan:${plans.length - 1}`, verificationNodeId || terminalId, 'flow');

  if (run.triage && run.triage.createdAt) {
    const triageId = addNode({
      id: 'triage',
      lane: 'outcome', step: null, kind: 'triage',
      label: run.triage.required ? `triage required: ${run.triage.reasonCode}` : `triage resolved: ${run.triage.reasonCode}`,
      status: run.triage.required ? 'required' : 'resolved',
      detail: {
        reasonCode: run.triage.reasonCode,
        requiredDecision: run.triage.requiredDecision,
        summary: run.triage.summary || null,
        resolvedBy: run.triage.resolvedBy || null,
        resolution: run.triage.resolution || null
      },
      evidenceRef: 'run.triage'
    });
    addEdge(terminalId, triageId, 'flow');
  }

  // Notable replay events (limits, no-progress, truncation) as annotations.
  snapEvents.forEach((event, index) => {
    if (!event || typeof event.type !== 'string') return;
    if (!/limit|trunc|stalled|no_progress|violation/i.test(event.type)) return;
    addNode({
      id: `annotation:${index}`,
      lane: 'authority', step: null, kind: 'runtime_event',
      label: event.type,
      status: 'annotation',
      detail: { payload: event.payload !== undefined ? event.payload : null },
      evidenceRef: `events[${index}]`
    });
  });

  const cursor = JSON.stringify({
    status: run.status || null,
    plans: plans.length,
    workspaceOps: workspaceOps.length,
    browserOps: browserOps.length,
    workflowActions: workflowActions.length,
    providerRequests: providerRequests.length,
    snapEvents: snapEvents.length,
    journalEvents: journalEvents.length,
    history: history.length,
    triageResolvedAt: run.triage ? run.triage.resolvedAt || null : null
  });

  return {
    runId: run.id != null ? run.id : null,
    ticketId: run.ticketId != null ? run.ticketId : null,
    generatedAt: new Date().toISOString(),
    lanes: ['model', 'authority', 'target', 'outcome'],
    nodes,
    edges,
    cursor
  };
}

module.exports = { buildRunDecisionGraph };
