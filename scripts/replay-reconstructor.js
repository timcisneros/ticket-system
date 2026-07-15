#!/usr/bin/env node
// Replay Reconstructor — reconstructs full run state from events.jsonl + operation-history.json + runs.json.
// Does NOT require replay snapshot. Events are source of truth.
//
// Usage:
//   node scripts/replay-reconstructor.js --data-dir ./data --run-id 123
//   node scripts/replay-reconstructor.js --data-dir ./data --run-id 123 --compare

const fs = require('fs');
const path = require('path');
const { reconstructWorkspaceForRun } = require('./replay-workspace');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function readEventsJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch (e) { return { _parseError: true, _raw: line.substring(0, 200) }; }
    });
  } catch (e) { return []; }
}

// ── Hash chain verification ───────────────────────────────────────

function verifyHashChain(events) {
  const result = verifyCurrentRunEventChain(events);
  return { ...result, errors: result.errors.map(error => error.message) };
}

// ── State machine reconstruction ────────────────────────────────────

function reconstructStateMachine(events) {
  const transitions = [];
  const errors = [];
  let currentState = 'pending';
  const terminalStates = ['terminalized'];
  const validTransitions = {
    pending: ['pending', 'running', 'terminalized'],
    running: ['running', 'terminalized'],
    terminalized: ['terminalized']
  };
  const stateEventMap = {
    'run.created': 'pending', 'run.lease_acquired': 'pending', 'scheduler.run_selected': 'pending',
    'run.started': 'running',
    'run.execution_completed': 'running',
    'run.terminalized': 'terminalized'
  };
  for (const ev of events) {
    if (ev._parseError) continue;
    const newState = stateEventMap[ev.type];
    if (newState) {
      const allowed = validTransitions[currentState] || [];
      if (!allowed.includes(newState)) errors.push(`Impossible transition: ${currentState} -> ${newState} (${ev.type})`);
      transitions.push({ from: currentState, to: newState, event: ev.type, ts: ev.ts, seq: ev.seq });
      currentState = newState;
    }
  }
  return { transitions, finalState: currentState, errors, terminalReached: terminalStates.includes(currentState) };
}

// ── Authority graph reconstruction ──────────────────────────────────

function reconstructAuthorityGraph(events, operationHistory, runId) {
  const errors = [];
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);
  const runOps = operationHistory.filter(o => o.runId === runId);
  const workspaceEvents = runEvents.filter(e => e.type === 'workspace.operation');
  const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
  const graph = [];
  for (const op of runOps) {
    const opPath = op.args && op.args.path;
    const opName = op.operation;
    const wsEvent = workspaceEvents.find(e => {
      const p = e.payload || {};
      return p.operation === opName && p.path === opPath;
    });
    const authEvent = authEvents.find(a => {
      const p = a.payload || {};
      return p.operation === opName && p.path === opPath;
    });
    graph.push({
      operation: opName, path: opPath, historyId: op.id,
      hasWorkspaceEvent: !!wsEvent, hasAuthEvent: !!authEvent,
      authBeforeOp: authEvent && wsEvent ? authEvent.ts <= wsEvent.ts : false,
      authTs: authEvent ? authEvent.ts : null, opTs: wsEvent ? wsEvent.ts : null
    });
    if (!wsEvent) errors.push(`Op ${op.id} missing workspace event`);
    if (!authEvent) errors.push(`Op ${op.id} missing authority event`);
    if (authEvent && wsEvent && authEvent.ts > wsEvent.ts) errors.push(`Authority after op ${op.id}`);
  }
  // Detect replay entries with no history
  for (const ws of workspaceEvents) {
    const p = ws.payload || {};
    const wsOp = p.operation || (p.operation && p.operation.operation);
    const wsPath = p.path || (p.operation && p.operation.args && p.operation.args.path);
    const hasHistory = runOps.some(o => o.operation === wsOp && o.args && o.args.path === wsPath);
    if (!hasHistory) errors.push(`Workspace event ${wsOp} ${wsPath} missing history entry`);
  }
  return { graph, errors };
}

// ── Full reconstruction ─────────────────────────────────────────────

function reconstructRun(data, runId) {
  const { events, operationHistory, runs } = data;
  const run = runs.find(r => r.id === runId) || null;
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);
  const runOps = operationHistory.filter(o => o.runId === runId);

  if (!run) return { error: 'Run not found' };

  // Hash chain
  const hashChain = verifyHashChain(runEvents);

  // State machine
  const stateMachine = reconstructStateMachine(runEvents);

  // Workspace projection
  const workspace = reconstructWorkspaceForRun(events, runId);

  // Authority graph
  const authority = reconstructAuthorityGraph(events, operationHistory, runId);

  // Counts from events
  const providerRequests = runEvents.filter(e => e.type === 'model.request' || e.type === 'run.heartbeat').length;
  const modelResponses = runEvents.filter(e => e.type === 'model.response').length;
  const workspaceOps = runEvents.filter(e => e.type === 'workspace.operation').length;
  const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied').length;
  const hasEvaluation = runEvents.some(e => e.type === 'run.evaluation_completed');
  const hasConsequence = runEvents.some(e => e.type === 'run.consequence_recorded');
  const hasTerminal = stateMachine.terminalReached;
  const hasExecutionCompleted = runEvents.some(e => e.type === 'run.execution_completed');

  // Mutations from operation history
  const mutations = runOps.map(op => ({
    operation: op.operation,
    path: op.args && op.args.path,
    historyId: op.id,
    timestamp: op.timestamp || op.createdAt || null
  }));

  return {
    runId,
    runStatus: run.status,
    hashChainValid: hashChain.chainValid,
    lastVerifiedSeq: hashChain.lastVerifiedSeq,
    lastVerifiedHash: hashChain.lastVerifiedHash,
    hashChainErrors: hashChain.errors,
    stateMachine: {
      finalState: stateMachine.finalState,
      terminalReached: stateMachine.terminalReached,
      transitions: stateMachine.transitions.length,
      errors: stateMachine.errors
    },
    workspace: workspace.finalState,
    workspaceOperationsApplied: workspace.applied.length,
    authorityGraph: authority.graph,
    authorityErrors: authority.errors,
    counts: {
      providerRequests, modelResponses, workspaceOperations: workspaceOps,
      authorityEvents: authEvents, mutations: mutations.length
    },
    evaluation: { present: hasEvaluation, fromEvents: hasEvaluation, fromRunRecord: !!(run.runEvaluation) },
    consequence: { present: hasConsequence, fromEvents: hasConsequence, fromRunRecord: !!(run.runConsequence) },
    mutations,
    terminalEventFromEvents: hasTerminal,
    executionCompletedFromEvents: hasExecutionCompleted,
    terminalStatusFromRunRecord: run.status,
    reconstructedFromEventsOnly: true,
    eventCount: runEvents.length
  };
}

// ── Compare reconstructed vs stored snapshot ────────────────────────

function compareWithSnapshot(reconstructed, snapshot) {
  if (!snapshot) return { snapshotPresent: false, diffs: [], match: false };

  const diffs = [];

  // Terminal status — map terminalized to the ultimate status
  function mapTerminalStatus(state) {
    if (['completed', 'failed', 'interrupted'].includes(state)) return state;
    // 'terminalized' means fully done; compare against snapshot's terminalStatus
    return 'completed'; // default mapped status for terminalized runs
  }
  const reconstructedTerminal = mapTerminalStatus(reconstructed.stateMachine.finalState);
  if (snapshot.terminalStatus !== reconstructedTerminal) {
    diffs.push({
      field: 'terminalStatus',
      reconstructed: reconstructedTerminal,
      snapshot: snapshot.terminalStatus,
      drift: snapshot.terminalStatus ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  // Provider requests
  const snapPr = (snapshot.providerRequests || []).length;
  if (snapPr !== reconstructed.counts.providerRequests) {
    diffs.push({
      field: 'providerRequests',
      reconstructed: reconstructed.counts.providerRequests,
      snapshot: snapPr,
      drift: snapPr > reconstructed.counts.providerRequests ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  // Model responses
  const snapMr = (snapshot.modelResponses || []).length;
  if (snapMr !== reconstructed.counts.modelResponses) {
    diffs.push({
      field: 'modelResponses',
      reconstructed: reconstructed.counts.modelResponses,
      snapshot: snapMr,
      drift: snapMr > reconstructed.counts.modelResponses ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  // Workspace operations
  const snapWo = (snapshot.workspaceOperations || []).length;
  if (snapWo !== reconstructed.counts.workspaceOperations) {
    diffs.push({
      field: 'workspaceOperations',
      reconstructed: reconstructed.counts.workspaceOperations,
      snapshot: snapWo,
      drift: snapWo > reconstructed.counts.workspaceOperations ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  // Evaluation
  const snapEval = snapshot.runEvaluation !== undefined && snapshot.runEvaluation !== null;
  if (snapEval !== reconstructed.evaluation.present) {
    diffs.push({
      field: 'evaluation',
      reconstructed: reconstructed.evaluation.present,
      snapshot: snapEval,
      drift: snapEval ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  // Consequence
  const snapConseq = snapshot.runConsequence !== undefined && snapshot.runConsequence !== null;
  if (snapConseq !== reconstructed.consequence.present) {
    diffs.push({
      field: 'consequence',
      reconstructed: reconstructed.consequence.present,
      snapshot: snapConseq,
      drift: snapConseq ? 'snapshot_ahead' : 'events_ahead'
    });
  }

  return {
    snapshotPresent: true,
    diffs,
    match: diffs.length === 0
  };
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let targetRunId = null;
  let compareMode = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--run-id' && args[i + 1]) { targetRunId = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--compare') { compareMode = true; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }
  if (!targetRunId) {
    console.error('Usage: node replay-reconstructor.js --data-dir <dir> --run-id <id> [--compare]');
    process.exit(1);
  }

  const runs = readJson(path.join(dataDir, 'runs.json')) || [];
  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const operationHistory = readJson(path.join(dataDir, 'operation-history.json')) || [];

  const data = { events, operationHistory, runs };
  const reconstructed = reconstructRun(data, targetRunId);

  if (reconstructed.error) {
    console.error(reconstructed.error);
    process.exit(1);
  }

  // Load snapshot if present
  let snapshot = null;
  const replayDir = path.join(dataDir, 'replay-snapshots');
  const replayPath = path.join(replayDir, `run-${targetRunId}.json`);
  if (fs.existsSync(replayPath)) {
    snapshot = readJson(replayPath);
  }

  if (compareMode && snapshot) {
    const comparison = compareWithSnapshot(reconstructed, snapshot);
    reconstructed.snapshotComparison = comparison;
  }

  console.log(JSON.stringify(reconstructed, null, 2));
}

main();
