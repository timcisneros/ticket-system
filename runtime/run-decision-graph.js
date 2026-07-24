'use strict';

// Run decision graph — a pure, side-effect-free projection of recorded run
// evidence into a lane graph (docs/RUN_DECISION_MAP_DESIGN.md). It renders the
// truth hierarchy spatially: what the model proposed (inference), what the
// runtime allowed (guards), what actually executed against the target (facts),
// and how the run was verified and terminalized (outcome). The recorded
// execution-phase progression (planning → inspection → mutation → verification
// → terminalization, docs/EXECUTION_PHASES.md) is carried as `phases` +
// `currentPhase` and rendered as the map's phase axis.
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

// Parse a recorded step reference (events carry stepId as a string, plan/history
// records as an integer) into an integer step, or null when absent/unparseable.
function parseStepRef(value) {
  if (Number.isInteger(value)) return value;
  if (value === null || value === undefined) return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
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

  // Operation-history step values come back from persistence as strings
  // ("0"), so parse rather than type-check — otherwise executed operations
  // render unlinked and their plan actions falsely render as unexecuted.
  const stepByHistoryId = new Map();
  history.forEach(record => {
    if (!record || record.id == null) return;
    const step = parseStepRef(record.step);
    if (step !== null) stepByHistoryId.set(record.id, step);
  });

  function addNode(node) {
    nodes.push(node);
    return node.id;
  }
  function addEdge(from, to, kind) {
    edges.push({ from, to, kind });
  }

  // ── Execution phase progression: recorded execution.phase_transition events
  // (the phase-aware execution contract, docs/EXECUTION_PHASES.md). Each event
  // carries stepId (the model-turn step), so transitions anchor to the step
  // axis. Runs start in `planning` by schema contract; `currentPhase` is the
  // stored run field, falling back to the last recorded transition.
  const phaseTransitions = [];
  const seenTransitions = new Set();
  for (const event of [...journalEvents, ...snapEvents]) {
    if (!event || event.type !== 'execution.phase_transition') continue;
    const payload = event.payload || {};
    const step = parseStepRef(event.stepId !== undefined ? event.stepId : payload.stepId);
    const key = `${payload.fromPhase || ''}>${payload.toPhase || ''}@${step}`;
    if (seenTransitions.has(key)) continue;
    seenTransitions.add(key);
    phaseTransitions.push({
      fromPhase: payload.fromPhase || null,
      toPhase: payload.toPhase || null,
      step,
      reason: payload.reason || null,
      evidenceRef: `event:execution.phase_transition[${phaseTransitions.length}]`
    });
  }
  const currentPhase = run.currentPhase
    || (phaseTransitions.length > 0 ? phaseTransitions[phaseTransitions.length - 1].toPhase : null);

  // ── Model lane: one plan node per parsed plan (the model's stated intent,
  // message verbatim), preceded by its provider request when 1:1 linkage holds.
  const requestLinkable = providerRequests.length === plans.length;
  const planNodeByStep = new Map();
  plans.forEach((plan, index) => {
    const step = Number.isInteger(plan.step) ? plan.step : index;
    if (requestLinkable) {
      const request = providerRequests[index] || {};
      const requestId = addNode({
        id: `request:${index}`,
        lane: 'model', step, kind: 'provider_request',
        label: `Model request ${index + 1}${request.body && request.body.model ? ' · ' + truncateLabel(request.body.model, 40) : ''}`,
        status: 'recorded',
        detail: {
          provider: request.provider || null,
          model: (request.body && request.body.model) || request.model || null,
          url: request.url || null,
          method: request.method || null,
          startedAt: request.startedAt || null,
          durationMs: request.durationMs
        },
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

  // ── Outcome lane: verification evidence, terminal status, evaluation,
  // consequence, triage — the recorded outcome chain in recording order.
  const verificationEvents = [...journalEvents, ...snapEvents].filter(event =>
    event && ['run.verification_passed', 'run.verification_failed', 'run.postconditions_checked'].includes(event.type));
  let verificationNodeId = null;
  if (verificationEvents.length > 0) {
    // An explicit pass/fail verdict event wins over the postconditions check;
    // the postconditions payload (counts, per-result detail) rides along either way.
    const verdictEvent = verificationEvents.find(event =>
      event.type === 'run.verification_passed' || event.type === 'run.verification_failed') || null;
    const postconditionsEvent = verificationEvents.find(event => event.type === 'run.postconditions_checked') || null;
    const chosen = verdictEvent || postconditionsEvent;
    const passed = chosen.type === 'run.verification_passed'
      || (chosen.type !== 'run.verification_failed' && chosen.payload && chosen.payload.status === 'passed');
    const pc = postconditionsEvent && postconditionsEvent.payload ? postconditionsEvent.payload : null;
    verificationNodeId = addNode({
      id: 'verification',
      lane: 'outcome', step: null, kind: 'verification',
      label: (passed ? 'verification passed' : 'verification failed')
        + (pc && Number.isInteger(pc.total) ? ` (${pc.passed}/${pc.total} postconditions passed)` : ''),
      status: passed ? 'passed' : 'failed',
      detail: {
        eventType: chosen.type,
        payload: chosen.payload !== undefined ? chosen.payload : null,
        postconditionsPayload: postconditionsEvent && postconditionsEvent !== chosen ? postconditionsEvent.payload || null : null
      },
      evidenceRef: `event:${chosen.type}`
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

  // Recorded evaluation (effectiveness / efficiency / violations) and
  // consequence (committed mutations, notifications, external effects) —
  // singular per-run records written at terminalization (run.runEvaluation /
  // run.runConsequence), chained after the terminal node in recording order.
  const evaluation = run.runEvaluation && typeof run.runEvaluation === 'object' ? run.runEvaluation : null;
  let evaluationNodeId = null;
  if (evaluation) {
    const effectivenessStatus = evaluation.effectiveness && evaluation.effectiveness.status ? evaluation.effectiveness.status : 'unknown';
    const violationsStatus = evaluation.violations && evaluation.violations.status ? evaluation.violations.status : 'unknown';
    evaluationNodeId = addNode({
      id: 'evaluation',
      lane: 'outcome', step: null, kind: 'evaluation',
      label: `evaluation: effectiveness ${effectivenessStatus} · violations ${violationsStatus}`,
      status: effectivenessStatus,
      detail: {
        effectiveness: evaluation.effectiveness || null,
        efficiency: evaluation.efficiency || null,
        violations: evaluation.violations || null
      },
      evidenceRef: 'run.runEvaluation'
    });
    addEdge(terminalId, evaluationNodeId, 'flow');
  }

  const consequence = run.runConsequence && typeof run.runConsequence === 'object' ? run.runConsequence : null;
  if (consequence) {
    const mutations = Array.isArray(consequence.mutations) ? consequence.mutations : [];
    const attempted = mutations.filter(item => item && item.attempted);
    const notifications = Array.isArray(consequence.notifications) ? consequence.notifications : [];
    const externalEffects = Array.isArray(consequence.externalEffects) ? consequence.externalEffects : [];
    const consequenceId = addNode({
      id: 'consequence',
      lane: 'outcome', step: null, kind: 'consequence',
      label: `consequence: ${mutations.length - attempted.length} committed mutation(s)`
        + (attempted.length > 0 ? ` · ${attempted.length} attempted` : '')
        + ` · ${notifications.length} notification(s) · ${externalEffects.length} external effect(s)`,
      status: 'recorded',
      detail: {
        mutations,
        notifications,
        externalEffects,
        verification: consequence.verification || null
      },
      evidenceRef: 'run.runConsequence'
    });
    addEdge(evaluationNodeId || terminalId, consequenceId, 'flow');
  }

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

  // Notable runtime events (limits, no-progress, truncation, violations) as
  // annotations — from both the replay snapshot and the journal, step-linked
  // when the event records a stepId. Phase transitions are excluded here: they
  // render as the phase axis, not as nodes.
  const seenAnnotations = new Set();
  function annotateEvents(events, source) {
    events.forEach((event, index) => {
      if (!event || typeof event.type !== 'string') return;
      if (event.type === 'execution.phase_transition') return;
      if (!/limit|trunc|stalled|no_progress|violation/i.test(event.type)) return;
      const key = `${event.type}|${event.stepId !== undefined ? event.stepId : ''}|${JSON.stringify(event.payload !== undefined ? event.payload : null)}`;
      if (seenAnnotations.has(key)) return;
      seenAnnotations.add(key);
      addNode({
        id: `annotation:${source}:${index}`,
        lane: 'authority',
        step: parseStepRef(event.stepId !== undefined ? event.stepId : (event.payload && event.payload.stepId)),
        kind: 'runtime_event',
        label: event.type,
        status: 'annotation',
        detail: { payload: event.payload !== undefined ? event.payload : null },
        evidenceRef: source === 'snapshot' ? `events[${index}]` : `journal:${event.type}[${index}]`
      });
    });
  }
  annotateEvents(snapEvents, 'snapshot');
  annotateEvents(journalEvents, 'journal');

  const cursor = JSON.stringify({
    status: run.status || null,
    currentPhase: currentPhase || null,
    phaseTransitions: phaseTransitions.length,
    plans: plans.length,
    workspaceOps: workspaceOps.length,
    browserOps: browserOps.length,
    workflowActions: workflowActions.length,
    providerRequests: providerRequests.length,
    snapEvents: snapEvents.length,
    journalEvents: journalEvents.length,
    history: history.length,
    verificationEvents: verificationEvents.length,
    evaluation: Boolean(evaluation),
    consequence: Boolean(consequence),
    triageResolvedAt: run.triage ? run.triage.resolvedAt || null : null
  });

  return {
    runId: run.id != null ? run.id : null,
    ticketId: run.ticketId != null ? run.ticketId : null,
    generatedAt: new Date().toISOString(),
    lanes: ['model', 'authority', 'target', 'outcome'],
    currentPhase,
    phases: phaseTransitions,
    nodes,
    edges,
    cursor
  };
}

// Full display text for a node, composed from the untruncated detail fields —
// the same no-truncation contract the map page renders under.
function nodeFullText(node) {
  const d = node.detail || {};
  if (d.message) return d.message;
  if (node.kind === 'workspace_operation') {
    return (d.operation || 'operation')
      + (d.path ? ' ' + d.path : '')
      + (d.nextPath ? ' -> ' + d.nextPath : '')
      + (d.reason ? ' — ' + d.reason : '');
  }
  if (node.kind === 'authority_decision') return d.reason || node.label;
  if (node.kind === 'cap_dropped') return 'dropped by per-response cap: ' + (d.operation || '') + (d.path ? ' ' + d.path : '');
  if (node.kind === 'unexecuted_proposal') return 'proposed; no recorded execution: ' + (d.operation || '') + (d.path ? ' ' + d.path : '');
  if (node.kind === 'browser_operation') return (d.operation || 'browser operation') + (d.url ? ' ' + d.url : '') + (d.error ? ' — ' + d.error : '');
  if (node.kind === 'terminal') return 'run ' + node.status + (d.failureReason ? ': ' + d.failureReason : '');
  if (node.kind === 'triage') {
    return node.label
      + (d.summary ? ' — ' + d.summary : '')
      + (d.resolution ? ' — resolution: ' + d.resolution : '');
  }
  if (node.kind === 'evaluation' && d.effectiveness) {
    const eff = d.effectiveness;
    return node.label
      + (Number.isInteger(eff.postconditionsPassed) ? ` — postconditions ${eff.postconditionsPassed} passed / ${eff.postconditionsFailed || 0} failed` : '')
      + (Array.isArray(eff.errors) && eff.errors.length > 0 ? ' — errors: ' + eff.errors.join('; ') : '');
  }
  return node.label;
}

// Plain-text rendering of the graph for the diagnostics bundle (and any other
// text surface). Same projection as the map page and `oquery run-graph`, so
// the copyable diagnostics can never drift from what the map shows: per-step
// verbatim model messages with complete flags, every action's fate (executed /
// blocked with reason / cap-dropped / unexecuted), workflow actions, and the
// outcome chain.
function nodeRenderText(node) {
  const text = nodeFullText(node);
  if (text === node.status) return node.status;
  return `${node.status}: ${text}`;
}

function renderRunDecisionGraphText(graph) {
  const lines = [];
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const laneOrder = { model: 0, authority: 1, target: 2, outcome: 3 };
  const plans = nodes.filter(node => node.kind === 'parsed_plan');

  lines.push(`- Nodes: ${nodes.length} · Edges: ${Array.isArray(graph.edges) ? graph.edges.length : 0} · Lanes: model / authority / target / outcome`);
  const phases = Array.isArray(graph.phases) ? graph.phases : [];
  if (phases.length > 0) {
    const chain = [phases[0].fromPhase || 'planning']
      .concat(phases.map(t => t.toPhase + (t.step !== null && t.step !== undefined ? ` (step ${t.step})` : '')))
      .join(' → ');
    lines.push(`- Execution phase: ${chain}`);
  } else if (graph.currentPhase) {
    lines.push(`- Execution phase: ${graph.currentPhase} (no recorded transitions)`);
  }
  for (const plan of plans) {
    const d = plan.detail || {};
    lines.push(`- step ${plan.step} [${d.complete ? 'complete:true' : 'continuing'}] model message (verbatim):`);
    String(d.message || plan.label || '').split('\n').forEach(line => lines.push('    ' + line));
    const siblings = nodes
      .filter(node => node.step === plan.step && node.id !== plan.id && node.kind !== 'provider_request')
      .sort((a, b) => (laneOrder[a.lane] || 0) - (laneOrder[b.lane] || 0));
    for (const node of siblings) {
      lines.push(`    [${node.lane}] ${nodeRenderText(node)}`);
    }
  }
  const stepless = nodes.filter(node => (node.step === null || node.step === undefined) && node.kind !== 'parsed_plan');
  if (stepless.length > 0) {
    lines.push('- outcome / unlinked:');
    for (const node of stepless.sort((a, b) => (laneOrder[a.lane] || 0) - (laneOrder[b.lane] || 0))) {
      lines.push(`    [${node.lane}] ${nodeRenderText(node)}`);
    }
  }
  if (plans.length === 0 && stepless.length === 0) lines.push('- (no evidence recorded)');
  return lines;
}

module.exports = { buildRunDecisionGraph, nodeFullText, renderRunDecisionGraphText };
