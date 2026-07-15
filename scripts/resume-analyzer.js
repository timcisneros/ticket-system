#!/usr/bin/env node
// Resume Safety Analyzer — determines whether a crashed/non-terminal run
// is safe to resume from persisted evidence only.
//
// Usage:
//   node scripts/resume-analyzer.js --data-dir ./data --run-id 123
//   node scripts/resume-analyzer.js --data-dir ./data

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
      transitions.push({ from: currentState, to: newState, event: ev.type, ts: ev.ts, seq: ev.seq });
      currentState = newState;
    }
  }
  return { transitions, finalState: currentState, terminalReached: terminalStates.includes(currentState), errors };
}

// ── Authority graph ───────────────────────────────────────────────

function reconstructAuthorityGraph(events, operationHistory, runId) {
  const errors = [];
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);
  const runOps = operationHistory.filter(o => o.runId === runId);
  const workspaceEvents = runEvents.filter(e => e.type === 'workspace.operation');
  const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');

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
    if (!wsEvent) errors.push(`Op ${op.id} (${opName} ${opPath}) missing workspace event`);
    if (!authEvent) errors.push(`Op ${op.id} (${opName} ${opPath}) missing authority event`);
    if (authEvent && wsEvent && authEvent.ts > wsEvent.ts) {
      errors.push(`Authority after op ${op.id} (${opName} ${opPath})`);
    }
  }

  for (const ws of workspaceEvents) {
    const p = ws.payload || {};
    const wsOp = p.operation || (p.operation && p.operation.operation);
    const wsPath = p.path || (p.operation && p.operation.args && p.operation.args.path);
    const hasHistory = runOps.some(o => o.operation === wsOp && o.args && o.args.path === wsPath);
    if (!hasHistory) errors.push(`Workspace event ${wsOp} ${wsPath} missing history entry`);
  }

  return { errors };
}

// ── Duplicate mutation risk ─────────────────────────────────────

const AGENT_MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function checkDuplicateMutationRisk(events, runId) {
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);
  const workspaceEvents = runEvents.filter(e => e.type === 'workspace.operation');
  const seen = new Map();
  const duplicates = [];
  for (const ws of workspaceEvents) {
    const p = ws.payload || {};
    const op = p.operation || (p.operation && p.operation.operation);
    const path = p.path || (p.operation && p.operation.args && p.operation.args.path);
    // Only check mutating operations for duplicate mutation risk
    if (!AGENT_MUTATING_OPERATIONS.includes(op)) continue;
    const key = `${op}:${path}`;
    if (seen.has(key)) {
      duplicates.push({ operation: op, path, firstSeq: seen.get(key), duplicateSeq: ws.seq });
    } else {
      seen.set(key, ws.seq);
    }
  }
  return { hasDuplicates: duplicates.length > 0, duplicates };
}

// ── Expected next phase ─────────────────────────────────────────────

function getExpectedNextPhase(lastEvent, allRunEvents) {
  if (!lastEvent) return 'unknown';

  const type = lastEvent.type;
  const seq = lastEvent.seq;

  // Authoritative terminal event
  if (type === 'run.terminalized') return 'already_terminal';

  // Execution completed (needs reconciliation)
  if (type === 'run.execution_completed') return 'terminalization_or_evaluation';

  // Evaluation/consequence
  if (type === 'run.evaluation_completed') return 'consequence';
  if (type === 'run.consequence_recorded') return 'terminalization';
  if (type === 'run.violations_checked') return 'evaluation';

  // Authority
  if (type === 'authority.allowed') return 'workspace_operation';
  if (type === 'authority.denied') return 'model_retry';

  // Snapshot finalized
  if (type === 'replay.snapshot.finalized' || type === 'run.snapshot_finalized') return 'terminalization_or_evaluation';

  // Workspace operation
  if (type === 'workspace.operation') {
    // Check if there are authority events AFTER this workspace operation
    // without matching workspace operations. If so, the model had more ops planned.
    const authEvents = allRunEvents.filter(e => e.type === 'authority.allowed');
    const wsEvents = allRunEvents.filter(e => e.type === 'workspace.operation');
    const unmatchedAuth = authEvents.filter(a => {
      if (a.seq <= seq) return false;
      const aPayload = a.payload || {};
      const aOp = aPayload.operation;
      const aPath = aPayload.path;
      const hasMatchingWs = wsEvents.some(w => {
        const wPayload = w.payload || {};
        const wOp = wPayload.operation || (wPayload.operation && wPayload.operation.operation);
        const wPath = wPayload.path || (wPayload.operation && wPayload.operation.args && wPayload.operation.args.path);
        return w.seq > seq && wOp === aOp && wPath === aPath;
      });
      return !hasMatchingWs;
    });
    if (unmatchedAuth.length > 0) return 'workspace_operation';
    return 'terminalization_or_evaluation';
  }

  // Heartbeat
  if (type === 'run.heartbeat') {
    // Check if there are authority events without matching workspace operations
    const authEvents = allRunEvents.filter(e => e.type === 'authority.allowed');
    const wsEvents = allRunEvents.filter(e => e.type === 'workspace.operation');
    const unmatchedAuth = authEvents.filter(a => {
      const aPayload = a.payload || {};
      const aOp = aPayload.operation;
      const aPath = aPayload.path;
      const hasMatchingWs = wsEvents.some(w => {
        const wPayload = w.payload || {};
        const wOp = wPayload.operation || (wPayload.operation && wPayload.operation.operation);
        const wPath = wPayload.path || (wPayload.operation && wPayload.operation.args && wPayload.operation.args.path);
        return wOp === aOp && wPath === aPath;
      });
      return !hasMatchingWs;
    });
    if (unmatchedAuth.length > 0) return 'workspace_operation';

    // If heartbeat is after workspace op but before next model call
    const wsEvents2 = allRunEvents.filter(e => e.type === 'workspace.operation');
    const lastWs = wsEvents2.length > 0 ? wsEvents2[wsEvents2.length - 1] : null;
    if (lastWs && seq > lastWs.seq) {
      return 'terminalization_or_evaluation';
    }
    // Before first model call or between steps
    return 'model_request';
  }

  // Start events
  if (['run.created', 'run.lease_acquired', 'scheduler.run_selected', 'run.started'].includes(type)) {
    return 'model_request';
  }

  return 'unknown';
}

// ── Resume safety analysis ────────────────────────────────────────

function analyzeRun(data, runId) {
  const { events, operationHistory, runs } = data;
  const run = runs.find(r => r.id === runId) || null;
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);

  const result = {
    runId,
    safeToResume: false,
    safeToReconcile: false,
    resumeFromSeq: null,
    expectedNextPhase: 'unknown',
    terminalStateReached: false,
    isTerminal: false,
    hasExecutionCompleted: false,
    hashChainIntact: false,
    authorityChainIntact: false,
    workspaceProjectionStable: false,
    duplicateMutationRisk: false,
    reasons: []
  };

  if (!run) {
    result.reasons.push('Run not found in runs.json');
    return result;
  }

  // 1. Hash chain check
  const hashChain = verifyHashChain(runEvents);
  result.hashChainIntact = hashChain.chainValid;
  if (!hashChain.chainValid) {
    result.reasons.push(...hashChain.errors.map(e => `hash_chain: ${e}`));
  }

  // 2. State machine
  const stateMachine = reconstructStateMachine(runEvents);
  result.terminalStateReached = stateMachine.terminalReached;
  if (stateMachine.terminalReached) {
    result.reasons.push(`Terminal state ${stateMachine.finalState} reached in event log`);
  }
  if (stateMachine.errors.length > 0) {
    result.reasons.push(...stateMachine.errors.map(e => `state_machine: ${e}`));
  }

  // 3. Terminal status consistency
  const terminalStatuses = ['completed', 'failed', 'interrupted'];
  if (stateMachine.terminalReached && !terminalStatuses.includes(run.status)) {
    result.reasons.push(`Status mismatch: events show terminal ${stateMachine.finalState} but run.status=${run.status}`);
  }
  if (!stateMachine.terminalReached && terminalStatuses.includes(run.status)) {
    result.reasons.push(`Status mismatch: run.status=${run.status} but no terminal event in log`);
  }

  // 4. Authority graph
  const authorityGraph = reconstructAuthorityGraph(events, operationHistory, runId);
  result.authorityChainIntact = authorityGraph.errors.length === 0;
  if (authorityGraph.errors.length > 0) {
    result.reasons.push(...authorityGraph.errors.map(e => `authority: ${e}`));
  }

  // 5. Workspace projection
  const workspaceResult = reconstructWorkspaceForRun(events, runId);
  result.workspaceProjectionStable = workspaceResult.applied.length >= 0; // Always true if no throw
  // Check for workspace reconstruction anomalies
  const wsErrors = [];
  for (const op of workspaceResult.applied) {
    if (op.result && op.result.status === 'unknown_operation') {
      wsErrors.push(`Unknown workspace operation: ${op.operation}`);
    }
  }
  if (wsErrors.length > 0) {
    result.workspaceProjectionStable = false;
    result.reasons.push(...wsErrors);
  }

  // 6. Duplicate mutation risk
  const dupCheck = checkDuplicateMutationRisk(events, runId);
  result.duplicateMutationRisk = dupCheck.hasDuplicates;
  if (dupCheck.hasDuplicates) {
    for (const d of dupCheck.duplicates) {
      result.reasons.push(`Duplicate mutation: ${d.operation} ${d.path} (seq ${d.firstSeq} and ${d.duplicateSeq})`);
    }
  }

  // 7. Event ordering (timestamps)
  let lastTs = '';
  for (const ev of runEvents) {
    if (ev.ts && ev.ts < lastTs) {
      result.reasons.push(`Timestamp ordering violation: ${lastTs} > ${ev.ts} (${ev.type})`);
    }
    if (ev.ts) lastTs = ev.ts;
  }

  // 8. Determine expected next phase
  const lastEvent = runEvents.length > 0 ? runEvents[runEvents.length - 1] : null;
  result.expectedNextPhase = getExpectedNextPhase(lastEvent, runEvents);
  result.resumeFromSeq = hashChain.lastVerifiedSeq !== null ? hashChain.lastVerifiedSeq + 1 : 0;

  // 9. Terminal & execution-completed state
  result.hasExecutionCompleted = runEvents.some(e => e.type === 'run.execution_completed');
  result.isTerminal = result.terminalStateReached;

  // 10. Final safety determination
  const reasonsPreventingResume = result.reasons.filter(r =>
    !r.startsWith('Status mismatch:') || stateMachine.terminalReached
  );

  // Safe to resume execution only if:
  // - Hash chain intact
  // - No terminal state reached
  // - No execution completed (run still needs model work)
  // - Authority chain intact
  // - Workspace projection stable
  // - No duplicate mutation risk
  // - No timestamp ordering violations
  result.safeToResume =
    result.hashChainIntact &&
    !result.isTerminal &&
    !result.hasExecutionCompleted &&
    result.authorityChainIntact &&
    result.workspaceProjectionStable &&
    !result.duplicateMutationRisk &&
    reasonsPreventingResume.filter(r => !r.startsWith('Status mismatch:')).length === 0;

  // Safe to reconcile when execution is complete but the current lifecycle has
  // not yet emitted run.terminalized.
  result.safeToReconcile =
    result.hashChainIntact &&
    result.hasExecutionCompleted &&
    !result.isTerminal &&
    !result.duplicateMutationRisk &&
    result.authorityChainIntact &&
    reasonsPreventingResume.filter(r => !r.startsWith('Status mismatch:')).length === 0;

  if (result.safeToResume) {
    result.reasons.push(`Safe to resume from seq=${result.resumeFromSeq}, next phase: ${result.expectedNextPhase}`);
  }
  if (result.safeToReconcile) {
    result.reasons.push(`Execution completed, safe to reconcile from seq=${result.resumeFromSeq}`);
  }

  return result;
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let targetRunId = null;
  let includeTerminal = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--run-id' && args[i + 1]) { targetRunId = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--include-terminal') { includeTerminal = true; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

  const runs = readJson(path.join(dataDir, 'runs.json')) || [];
  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const operationHistory = readJson(path.join(dataDir, 'operation-history.json')) || [];

  const data = { events, operationHistory, runs };
  const terminalStatuses = ['completed', 'failed', 'interrupted'];
  const runsToAnalyze = includeTerminal
    ? runs
    : runs.filter(r => !terminalStatuses.includes(r.status));

  const report = {
    dataDir,
    totalRuns: runs.length,
    nonTerminalRuns: runs.filter(r => !terminalStatuses.includes(r.status)).length,
    includeTerminal,
    analyses: []
  };

  for (const run of runsToAnalyze) {
    if (targetRunId && run.id !== targetRunId) continue;
    report.analyses.push(analyzeRun(data, run.id));
  }

  console.log(JSON.stringify(report, null, 2));
}

main();
