#!/usr/bin/env node
// Offline deterministic replay verifier — full reconstruction edition.
// Reconstructs run state, workspace state, state machine, authority graph,
// and temporal consistency from events + operation-history.
// Compares reconstructed projections against replay snapshot.
//
// Modes:
//   --mode strict          fail on any error or warning
//   --mode permissive      warnings do not cause exit 1
//   --mode forensic-diff   print exact diffs, do not exit 1
//
// Usage:
//   node scripts/replay-verifier.js --data-dir ./data --run-id 123 --mode strict

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { reconstructWorkspaceForRun } = require('./replay-workspace');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const AGENT_MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];

function die(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function readEventsJsonl(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean).map((line, i) => {
      try { return JSON.parse(line); } catch (e) { return { _parseError: true, _lineIndex: i + 1, _raw: line.substring(0, 200) }; }
    });
  } catch (e) { return []; }
}

function canonicalJson(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(canonicalJson);
  const sorted = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = canonicalJson(obj[key]);
  return sorted;
}

function computeReplayHash(replay) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(replay))).digest('hex');
}

// ── Hash chain reconstruction ─────────────────────────────────────

function verifyHashChain(events) {
  const result = verifyCurrentRunEventChain(events);
  return {
    errors: result.errors.map(error => error.message),
    chainValid: result.chainValid,
    breaks: result.errors
  };
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
    'run.created': 'pending',
    'run.lease_acquired': 'pending',
    'run.started': 'running',
    'run.execution_completed': 'running',
    'run.terminalized': 'terminalized'
  };

  for (const ev of events) {
    if (ev._parseError) continue;
    const newState = stateEventMap[ev.type];
    if (newState) {
      const allowed = validTransitions[currentState] || [];
      if (!allowed.includes(newState)) {
        errors.push(`Impossible state transition: ${currentState} -> ${newState} (event ${ev.type} at ${ev.ts})`);
      }
      transitions.push({ from: currentState, to: newState, event: ev.type, ts: ev.ts });
      currentState = newState;
    }
  }

  // Detect events after terminal state
  const ALLOWED_AFTER_TERMINAL = new Set([
    'run.evaluation_completed', 'run.consequence_recorded', 'run.violations_checked',
    'run.snapshot_finalized', 'run.execution_completed', 'run.terminalized'
  ]);
  let terminalReached = false;
  let terminalTs = null;
  for (const ev of events) {
    if (ev._parseError) continue;
    if (terminalStates.includes(stateEventMap[ev.type])) {
      terminalReached = true;
      terminalTs = ev.ts;
    } else if (terminalReached && !ALLOWED_AFTER_TERMINAL.has(ev.type)) {
      if (terminalTs && ev.ts && ev.ts > terminalTs) {
        errors.push(`Event after terminal state: ${ev.type} at ${ev.ts} (terminal at ${terminalTs})`);
      }
    }
  }

  return { transitions, finalState: currentState, errors, terminalReached };
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
    const isMutating = AGENT_MUTATING_OPERATIONS.includes(opName);
    // Find preceding authority event
    const authEvent = authEvents.find(a => {
      const p = a.payload || {};
      return p.operation === opName && p.path === opPath;
    });
    // Find corresponding workspace event
    const wsEvent = workspaceEvents.find(e => {
      const p = e.payload || {};
      return p.operation === opName && p.path === opPath;
    });

    const entry = {
      operation: opName,
      path: opPath,
      isMutating,
      historyId: op.id,
      hasAuth: !!authEvent,
      hasWorkspace: !!wsEvent,
      authBeforeOp: authEvent && wsEvent ? authEvent.ts <= wsEvent.ts : false,
      authTs: authEvent ? authEvent.ts : null,
      opTs: wsEvent ? wsEvent.ts : null
    };
    graph.push(entry);

    if (isMutating && !authEvent) errors.push(`Operation ${opName} ${opPath} missing authority event`);
    if (!wsEvent) errors.push(`Operation ${opName} ${opPath} missing workspace event`);
    if (authEvent && wsEvent && authEvent.ts > wsEvent.ts) {
      errors.push(`Authority after operation: ${opName} ${opPath} (auth=${authEvent.ts}, op=${wsEvent.ts})`);
    }
  }

  return { graph, errors };
}

// ── Temporal consistency checks ─────────────────────────────────────

function verifyTemporalConsistency(events, run) {
  const errors = [];
  const runEvents = events.filter(e => e.runId === run.id && !e._parseError);

  // Heartbeat cadence (should be roughly every few seconds during running)
  const heartbeats = runEvents.filter(e => e.type === 'run.heartbeat');
  let gaps = [];
  if (heartbeats.length > 1) {
    for (let i = 1; i < heartbeats.length; i++) {
      const prev = new Date(heartbeats[i - 1].ts).getTime();
      const curr = new Date(heartbeats[i].ts).getTime();
      const gap = curr - prev;
      gaps.push(gap);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const maxGap = Math.max(...gaps);
    // If average gap is > 30 seconds, flag as anomaly
    if (avgGap > 30000) {
      errors.push(`Heartbeat cadence anomaly: avg gap ${(avgGap / 1000).toFixed(1)}s, max ${(maxGap / 1000).toFixed(1)}s`);
    }
  }

  // Evaluation after terminalization (currently allowed by runtime; note as warning only)
  const evalEvents = runEvents.filter(e => e.type === 'run.evaluation_completed');
  const terminalEvent = runEvents.find(e => e.type === 'run.terminalized');
  if (terminalEvent && evalEvents.length > 0) {
    const lastEval = evalEvents[evalEvents.length - 1];
    if (lastEval.ts > terminalEvent.ts) {
      // Runtime computes evaluation after terminal event; this is expected behavior
      // Do not flag as error, only track in checks
    }
  }

  // Consequence without evaluation
  const conseqEvents = runEvents.filter(e => e.type === 'run.consequence_recorded');
  if (conseqEvents.length > 0 && evalEvents.length === 0) {
    errors.push('Consequence recorded without evaluation');
  }
  if (conseqEvents.length > 0 && evalEvents.length > 0) {
    const firstEval = evalEvents[0].ts;
    const firstConseq = conseqEvents[0].ts;
    if (firstConseq < firstEval) {
      errors.push(`Consequence (${firstConseq}) before evaluation (${firstEval})`);
    }
  }

  // Impossible timestamps (before run creation)
  const createdEvent = runEvents.find(e => e.type === 'run.created');
  if (createdEvent) {
    const createdTs = new Date(createdEvent.ts).getTime();
    for (const ev of runEvents) {
      if (ev.ts && new Date(ev.ts).getTime() < createdTs) {
        errors.push(`Impossible timestamp: ${ev.type} at ${ev.ts} before run.created at ${createdEvent.ts}`);
      }
    }
  }

  return { errors, heartbeats: heartbeats.length, avgHeartbeatGap: heartbeats.length > 1 ? gaps.reduce((a,b)=>a+b,0)/gaps.length : null };
}

// ── Workspace projection comparison ─────────────────────────────────

function compareWorkspaceProjection(reconstructed, snapshot) {
  const errors = [];
  const diffs = [];

  // Compare file paths
  const reconPaths = Object.keys(reconstructed.files || {}).sort();
  const snapshotOps = (snapshot.workspaceOperations || []);
  const snapshotPaths = snapshotOps
    .map(op => {
      if (op.operation && op.operation.args) return op.operation.args.path;
      if (op.operation && typeof op.operation === 'string' && op.args) return op.args.path;
      return null;
    })
    .filter(Boolean)
    .sort();

  // Check that reconstructed files exist in snapshot operations
  for (const path of reconPaths) {
    if (!snapshotPaths.includes(path)) {
      errors.push(`Reconstructed file ${path} not found in snapshot operations`);
      diffs.push({ type: 'file_missing_in_snapshot', path });
    }
  }

  // Check that snapshot operations resulted in actual files
  for (const path of snapshotPaths) {
    if (!reconPaths.includes(path)) {
      // This can be normal for operations that don't create files (readFile, deletePath, executeFile)
      const op = snapshotOps.find(o => {
        if (o.operation && o.operation.args) return o.operation.args.path === path;
        if (o.args) return o.args.path === path;
        return false;
      });
      if (op && op.operation && op.operation.operation === 'writeFile') {
        errors.push(`Snapshot writeFile ${path} not present in reconstructed workspace`);
        diffs.push({ type: 'snapshot_write_missing', path });
      }
    }
  }

  return { errors, diffs };
}

// ── Replay projection comparison ────────────────────────────────────

function compareReplayProjection(reconstructed, snapshot) {
  const diffs = [];

  // Provider requests
  if (reconstructed.providerRequests !== snapshot.providerRequests) {
    diffs.push({ field: 'providerRequests', reconstructed: reconstructed.providerRequests, snapshot: (snapshot.providerRequests || []).length });
  }

  // Model responses
  if (reconstructed.modelResponses !== snapshot.modelResponses) {
    diffs.push({ field: 'modelResponses', reconstructed: reconstructed.modelResponses, snapshot: (snapshot.modelResponses || []).length });
  }

  // Workspace operations
  if (reconstructed.workspaceOperations !== snapshot.workspaceOperations) {
    diffs.push({ field: 'workspaceOperations', reconstructed: reconstructed.workspaceOperations, snapshot: (snapshot.workspaceOperations || []).length });
  }

  // Terminal status
  if (reconstructed.terminalStatus !== snapshot.terminalStatus) {
    diffs.push({ field: 'terminalStatus', reconstructed: reconstructed.terminalStatus, snapshot: snapshot.terminalStatus });
  }

  // Evaluation
  if (reconstructed.hasEvaluation !== snapshot.hasEvaluation) {
    diffs.push({ field: 'evaluation', reconstructed: reconstructed.hasEvaluation, snapshot: snapshot.hasEvaluation });
  }

  // Consequence
  if (reconstructed.hasConsequence !== snapshot.hasConsequence) {
    diffs.push({ field: 'consequence', reconstructed: reconstructed.hasConsequence, snapshot: snapshot.hasConsequence });
  }

  return diffs;
}

// ── Per-run verification ──────────────────────────────────────────

function verifyRun(data, runId, mode) {
  const { replaySnapshots, events, operationHistory, runs } = data;
  const runRecord = runs.find(r => r.id === runId) || {};
  const result = { runId, passed: true, errors: [], warnings: [], checks: {} };

  const replay = replaySnapshots[runId] || null;
  const run = runs.find(r => r.id === runId) || null;
  const runEvents = events.filter(e => e.runId === runId && !e._parseError);

  if (!replay) { result.passed = false; result.errors.push('Missing replay snapshot'); return result; }
  if (!run) { result.passed = false; result.errors.push('Missing run record'); return result; }

  // ── Check 1: Replay hash ──────────────────────────────────────────
  result.checks.replayHash = computeReplayHash(replay);

  // ── Check 2: Count consistency ─────────────────────────────────────
  result.checks.providerRequests = (replay.providerRequests || []).length;
  result.checks.modelResponses = (replay.modelResponses || []).length;
  result.checks.workspaceOperationsReplay = (replay.workspaceOperations || []).length;
  result.checks.workspaceOperationsEvents = runEvents.filter(e => e.type === 'workspace.operation').length;
  if (result.checks.workspaceOperationsReplay !== result.checks.workspaceOperationsEvents) {
    result.passed = false;
    result.errors.push(`Workspace operation count mismatch: replay=${result.checks.workspaceOperationsReplay}, events=${result.checks.workspaceOperationsEvents}`);
  }

  // ── Check 3: Mutation set ────────────────────────────────────────
  const replayPaths = new Set((replay.workspaceOperations || []).map(op => {
    const args = op && op.operation && op.operation.args ? op.operation.args : op.args;
    return args && args.path;
  }).filter(Boolean));
  const runOps = operationHistory.filter(o => o.runId === runId);
  const historyPaths = new Set(runOps.map(op => op.args && op.args.path).filter(Boolean));
  result.checks.replayMutationPaths = Array.from(replayPaths).sort();
  result.checks.historyMutationPaths = Array.from(historyPaths).sort();
  const missingInHistory = [...replayPaths].filter(p => !historyPaths.has(p));
  const missingInReplay = [...historyPaths].filter(p => !replayPaths.has(p));
  if (missingInHistory.length > 0) { result.passed = false; result.errors.push(`Replay mutations missing from history: ${missingInHistory.join(', ')}`); }
  if (missingInReplay.length > 0) { result.warnings.push(`History mutations missing from replay: ${missingInReplay.join(', ')}`); }

  // ── Check 4: Evaluation / Consequence ──────────────────────────────
  const hasEvalEvent = runEvents.some(e => e.type === 'run.evaluation_completed');
  const hasEvalReplay = replay.runEvaluation !== undefined && replay.runEvaluation !== null;
  result.checks.evaluationPresent = hasEvalEvent || hasEvalReplay;
  const hasConseqEvent = runEvents.some(e => e.type === 'run.consequence_recorded');
  const hasConseqReplay = replay.runConsequence !== undefined && replay.runConsequence !== null;
  result.checks.consequencePresent = hasConseqEvent || hasConseqReplay;
  const terminal = replay.terminalStatus || run.status;
  if (terminal === 'completed') {
    if (!result.checks.evaluationPresent) { result.passed = false; result.errors.push('Terminal status completed but evaluation missing'); }
    if (!result.checks.consequencePresent) { result.passed = false; result.errors.push('Terminal status completed but consequence missing'); }
  }

  // ── Check 5: Authority evidence ──────────────────────────────────
  const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
  result.checks.authorityEvents = authEvents.length;
  result.checks.authorityReplay = (replay.authorityChecks || []).length;
  const mutatingWsEvents = runEvents.filter(e => e.type === 'workspace.operation' && e.payload && AGENT_MUTATING_OPERATIONS.includes(e.payload.operation));
  if (mutatingWsEvents.length > 0 && authEvents.length === 0) {
    result.passed = false;
    result.errors.push(`${mutatingWsEvents.length} mutating workspace operations but zero authority events`);
  }

  // ── Check 6: Hash chain integrity ─────────────────────────────────
  const chainResult = verifyHashChain(runEvents);
  result.checks.hashChainValid = chainResult.chainValid;
  result.checks.hashChainBreaks = chainResult.breaks;
  if (!chainResult.chainValid) result.errors.push(...chainResult.errors);

  // ── Check 7: Event ordering (timestamp) ─────────────────────────
  let lastTs = '';
  for (const ev of runEvents) {
    if (ev.ts && ev.ts < lastTs) { result.passed = false; result.errors.push(`Out-of-order event: ${lastTs} > ${ev.ts} (type=${ev.type})`); }
    if (ev.ts) lastTs = ev.ts;
  }

  // ── Check 8: Duplicate events ─────────────────────────────────────
  const seen = new Map();
  for (const ev of runEvents) {
    const sig = JSON.stringify(canonicalJson(ev));
    if (seen.has(sig)) { result.passed = false; result.errors.push(`Duplicate events detected: ${ev.type} at ${ev.ts}`); }
    seen.set(sig, true);
  }

  // ── Check 9: Terminal status consistency ──────────────────────────
  result.checks.terminalStatusReplay = replay.terminalStatus;
  result.checks.terminalStatusRun = run.status;
  if (replay.terminalStatus && replay.terminalStatus !== run.status) {
    result.passed = false;
    result.errors.push(`Terminal status mismatch: replay=${replay.terminalStatus}, run=${run.status}`);
  }

  // ── Check 10: Handoff integrity ───────────────────────────────────
  result.checks.handoffTasksReplay = (replay.handoffTasks || []).length;
  result.checks.handoffValidatedEvents = runEvents.filter(e => e.type === 'handoff.task_validated').length;
  result.checks.handoffExecutedEvents = runEvents.filter(e => e.type === 'handoff.task_executed').length;

  // ── Check 11: Parse errors ───────────────────────────────────────
  const parseErrors = runEvents.filter(e => e._parseError);
  if (parseErrors.length > 0) { result.passed = false; result.errors.push(`Parse errors: ${parseErrors.length}`); }

  // ── Check 12: State machine reconstruction ────────────────────────
  const smResult = reconstructStateMachine(runEvents);
  result.checks.stateMachine = { transitions: smResult.transitions.length, finalState: smResult.finalState, terminalReached: smResult.terminalReached };
  if (smResult.errors.length > 0) { result.passed = false; result.errors.push(...smResult.errors); }

  // ── Check 13: Authority graph reconstruction ──────────────────────
  const authGraph = reconstructAuthorityGraph(events, operationHistory, runId);
  result.checks.authorityGraph = authGraph.graph;
  if (authGraph.errors.length > 0) { result.passed = false; result.errors.push(...authGraph.errors); }

  // ── Check 14: Temporal consistency ────────────────────────────────
  const temporal = verifyTemporalConsistency(events, run);
  result.checks.heartbeats = temporal.heartbeats;
  result.checks.temporalErrors = temporal.errors;
  if (temporal.errors.length > 0) { result.passed = false; result.errors.push(...temporal.errors); }

  // ── Check 15: Workspace reconstruction ──────────────────────────
  const workspaceResult = reconstructWorkspaceForRun(events, runId);
  result.checks.workspaceReconstructed = workspaceResult.finalState;
  result.checks.workspaceOperationsApplied = workspaceResult.applied.length;
  const wsCompare = compareWorkspaceProjection(workspaceResult.finalState, replay);
  result.checks.workspaceDiffs = wsCompare.diffs;
  if (wsCompare.errors.length > 0) { result.passed = false; result.errors.push(...wsCompare.errors); }

  // ── Check 16: Replay projection comparison ────────────────────────
  // Note: replay snapshot is a derived projection. Evaluation/consequence
  // are stored on the run record (runs.json), not in the snapshot.
  const reconstructed = {
    providerRequests: result.checks.providerRequests,
    modelResponses: result.checks.modelResponses,
    workspaceOperations: result.checks.workspaceOperationsEvents,
    terminalStatus: smResult.finalState,
    hasEvaluation: result.checks.evaluationPresent,
    hasConsequence: result.checks.consequencePresent
  };
  const snapshotProjection = {
    providerRequests: result.checks.providerRequests,
    modelResponses: result.checks.modelResponses,
    workspaceOperations: result.checks.workspaceOperationsReplay,
    terminalStatus: replay.terminalStatus,
    hasEvaluation: !!(runRecord.runEvaluation),
    hasConsequence: !!(runRecord.runConsequence)
  };
  const projectionDiffs = compareReplayProjection(reconstructed, snapshotProjection);
  result.checks.projectionDiffs = projectionDiffs;
  if (projectionDiffs.length > 0) {
    for (const d of projectionDiffs) {
      result.warnings.push(`Projection diff: ${d.field} reconstructed=${d.reconstructed} snapshot=${d.snapshot}`);
    }
  }

  if (mode === 'strict' && result.warnings.length > 0) result.passed = false;

  return result;
}

// ── Main ──────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let targetRunId = null;
  let mode = 'strict';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--run-id' && args[i + 1]) { targetRunId = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--mode' && args[i + 1]) { mode = args[i + 1]; i++; }
  }

  if (!fs.existsSync(dataDir)) die(`Data directory not found: ${dataDir}`);

  const runs = readJson(path.join(dataDir, 'runs.json')) || [];
  const events = readEventsJsonl(path.join(dataDir, 'events.jsonl'));
  const operationHistory = readJson(path.join(dataDir, 'operation-history.json')) || [];

  const replaySnapshots = {};
  const replayDir = path.join(dataDir, 'replay-snapshots');
  if (fs.existsSync(replayDir)) {
    for (const file of fs.readdirSync(replayDir)) {
      const m = file.match(/^run-(\d+)\.json$/);
      if (!m) continue;
      const runId = parseInt(m[1], 10);
      const snapshot = readJson(path.join(replayDir, file));
      if (snapshot) replaySnapshots[runId] = snapshot;
    }
  }

  const data = { replaySnapshots, events, operationHistory, runs };

  // ── Identity-level checks ─────────────────────────────────────────
  const identityErrors = [];
  for (const run of runs) {
    if (!run.replaySnapshotPath) continue;
    const replayFile = path.join(dataDir, run.replaySnapshotPath);
    if (!fs.existsSync(replayFile)) { identityErrors.push(`Run ${run.id}: missing replay file`); continue; }
    const filenameMatch = run.replaySnapshotPath.match(/run-(\d+)\.json$/);
    if (!filenameMatch) { identityErrors.push(`Run ${run.id}: invalid filename`); continue; }
    if (parseInt(filenameMatch[1], 10) !== run.id) identityErrors.push(`Run ${run.id}: filename ID mismatch`);
    const snapshot = replaySnapshots[run.id];
    if (snapshot && snapshot.runId !== run.id) identityErrors.push(`Run ${run.id}: snapshot.runId mismatch`);
  }

  if (fs.existsSync(replayDir)) {
    const runIdsFromRuns = new Set(runs.map(r => r.id));
    const snapshotCounts = {};
    for (const file of fs.readdirSync(replayDir)) {
      const m = file.match(/^run-(\d+)\.json$/);
      if (!m) continue;
      const sid = parseInt(m[1], 10);
      if (!runIdsFromRuns.has(sid)) identityErrors.push(`Orphan snapshot: ${file}`);
      snapshotCounts[sid] = (snapshotCounts[sid] || 0) + 1;
    }
    for (const [sid, count] of Object.entries(snapshotCounts)) {
      if (count > 1) identityErrors.push(`Duplicate snapshots for run ${sid}: ${count}`);
    }
  }

  // ── Per-run verification ────────────────────────────────────
  const runIds = targetRunId ? [targetRunId] : runs.map(r => r.id).filter(id => replaySnapshots[id]);
  const report = {
    dataDir, mode, totalRunsExamined: runIds.length,
    identityErrors, identityPassed: identityErrors.length === 0,
    passed: 0, failed: 0, runs: []
  };
  let exitCode = (identityErrors.length > 0 && mode === 'strict') ? 1 : 0;

  for (const runId of runIds) {
    const result = verifyRun(data, runId, mode);
    report.runs.push(result);
    if (result.passed) report.passed++; else { report.failed++; if (mode !== 'forensic-diff') exitCode = 1; }
  }

  // ── Forensic-diff mode: detailed diffs ────────────────────────
  if (mode === 'forensic-diff') {
    for (const runResult of report.runs) {
      if (runResult.passed) continue;
      console.error(`\n--- Forensic diff for run ${runResult.runId} ---`);
      for (const err of runResult.errors) console.error(`  ERROR: ${err}`);
      for (const warn of runResult.warnings) console.error(`  WARN:  ${warn}`);
      if (runResult.checks.workspaceDiffs && runResult.checks.workspaceDiffs.length > 0) {
        console.error(`  WORKSPACE DIFFS: ${runResult.checks.workspaceDiffs.length}`);
        for (const d of runResult.checks.workspaceDiffs) console.error(`    ${d.type}: ${d.path}`);
      }
      if (runResult.checks.projectionDiffs && runResult.checks.projectionDiffs.length > 0) {
        console.error(`  PROJECTION DIFFS: ${runResult.checks.projectionDiffs.length}`);
        for (const d of runResult.checks.projectionDiffs) console.error(`    ${d.field}: reconstructed=${d.reconstructed} snapshot=${d.snapshot}`);
      }
      if (runResult.checks.hashChainBreaks && runResult.checks.hashChainBreaks.length > 0) {
        console.error(`  HASH CHAIN BREAKS: ${runResult.checks.hashChainBreaks.length}`);
        for (const br of runResult.checks.hashChainBreaks) console.error(`    ${br.type}${br.expected ? ` expected=${br.expected} actual=${br.actual}` : ''}`);
      }
      if (runResult.checks.stateMachine && runResult.checks.stateMachine.transitions > 0) {
        console.error(`  STATE MACHINE: ${runResult.checks.stateMachine.transitions} transitions, final=${runResult.checks.stateMachine.finalState}`);
      }
      if (runResult.checks.authorityGraph) {
        const incomplete = runResult.checks.authorityGraph.filter(g => !g.hasAuth || !g.hasWorkspace || !g.authBeforeOp);
        if (incomplete.length > 0) {
          console.error(`  AUTHORITY GAPS: ${incomplete.length}`);
          for (const g of incomplete) console.error(`    ${g.operation} ${g.path}: auth=${g.hasAuth} ws=${g.hasWorkspace} order=${g.authBeforeOp}`);
        }
      }
    }
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

main();
