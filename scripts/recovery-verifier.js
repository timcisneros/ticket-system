#!/usr/bin/env node
// Recovery Verifier — classifies non-terminal runs from persisted evidence.
// Reads: events.jsonl, runs.json, operation-history.json, replay snapshots, workspace.
// Reports: classification, last verified state, expected next safe phase.
// NO auto-resume. Pure diagnostic.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { reconstructWorkspaceForRun } = require('./replay-workspace');

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

function computeEventHash(event) {
  const canonical = { type: event.type, ticketId: event.ticketId, runId: event.runId, stepId: event.stepId, payload: event.payload };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function verifyHashChain(events) {
  const errors = [];
  if (events.length === 0) return { errors, chainValid: true, lastVerifiedSeq: null, lastVerifiedHash: null };
  const sorted = [...events].sort((a, b) => {
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return String(a.ts).localeCompare(String(b.ts));
  });

  let lastVerifiedSeq = null;
  let lastVerifiedHash = null;
  let chainBroken = false;

  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev._parseError) { chainBroken = true; continue; }

    if (ev.seq !== undefined) {
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.seq !== undefined && ev.seq !== prev.seq + 1) {
          errors.push(`seq gap at ${ev.seq}`);
          chainBroken = true;
        }
      } else if (ev.seq !== 0) {
        errors.push(`first seq not 0`);
        chainBroken = true;
      }
    }

    if (ev.prevHash !== undefined) {
      if (i === 0) {
        if (ev.prevHash !== null) { errors.push(`first prevHash not null`); chainBroken = true; }
      } else {
        const prev = sorted[i - 1];
        const expected = computeEventHash(prev);
        if (ev.prevHash !== expected) { errors.push(`hash break at seq=${ev.seq}`); chainBroken = true; }
      }
    }

    if (!chainBroken) {
      lastVerifiedSeq = ev.seq !== undefined ? ev.seq : i;
      lastVerifiedHash = computeEventHash(ev);
    }
  }

  // Check duplicates
  const seqCounts = {};
  for (const ev of sorted) { if (ev.seq !== undefined) seqCounts[ev.seq] = (seqCounts[ev.seq] || 0) + 1; }
  for (const [seq, count] of Object.entries(seqCounts)) {
    if (count > 1) { errors.push(`duplicate seq=${seq}`); chainBroken = true; }
  }

  return { errors, chainValid: !chainBroken, lastVerifiedSeq, lastVerifiedHash };
}

function getNextSafePhase(lastEventType) {
  const phaseMap = {
    'run.created': 'lease_acquisition',
    'run.lease_acquired': 'run_start',
    'scheduler.run_selected': 'run_start',
    'run.started': 'model_request',
    'run.heartbeat': 'authority_check',
    'authority.allowed': 'workspace_operation',
    'authority.denied': 'model_retry',
    'workspace.operation': 'heartbeat_or_model',
    'run.violations_checked': 'evaluation',
    'run.evaluation_completed': 'consequence',
    'run.consequence_recorded': 'terminalization_or_reconciliation',
    'run.execution_completed': 'snapshot_finalization',
    'run.snapshot_finalized': 'terminalization_or_evaluation',
    'replay.snapshot.finalized': 'terminalization_or_evaluation',
    'run.terminalized': 'already_terminal'
  };
  return phaseMap[lastEventType] || 'unknown';
}

function classifyRun(run, events, replay, opHistory) {
  const legacyTerminalEventTypes = ['run.completed', 'run.failed', 'run.interrupted'];
  const terminalEventTypes = [...legacyTerminalEventTypes, 'run.terminalized'];
  const terminalEvents = events.filter(e => terminalEventTypes.includes(e.type));
  const executionCompletedEvents = events.filter(e => e.type === 'run.execution_completed');
  const workspaceEvents = events.filter(e => e.type === 'workspace.operation');
  const authEvents = events.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
  const hashChain = verifyHashChain(events);

  // ── Priority 1: already_completed_but_not_marked ──────────────
  const runTerminalStatuses = ['completed', 'failed', 'interrupted'];
  if (terminalEvents.length > 0 && !runTerminalStatuses.includes(run.status)) {
    return {
      classification: 'already_completed_but_not_marked',
      reason: `Terminal event ${terminalEvents[0].type} found but run.status=${run.status}`,
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp: null,
      lastCommittedMutation: null,
      expectedNextPhase: 'status_reconciliation',
      hashChainValid: hashChain.chainValid
    };
  }

  // ── Priority 2: replay_corrupt ────────────────────────────────
  if (!replay) {
    return {
      classification: 'replay_corrupt',
      reason: 'Replay snapshot missing',
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp: null,
      lastCommittedMutation: null,
      expectedNextPhase: 'manual_investigation',
      hashChainValid: hashChain.chainValid
    };
  }
  if (replay._parseError || (replay.runId && replay.runId !== run.id)) {
    return {
      classification: 'replay_corrupt',
      reason: replay._parseError ? 'Replay unparseable' : `Replay runId mismatch: ${replay.runId} !== ${run.id}`,
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp: null,
      lastCommittedMutation: null,
      expectedNextPhase: 'manual_investigation',
      hashChainValid: hashChain.chainValid
    };
  }

  // ── Priority 3: authority_missing ─────────────────────────────
  let lastAuthorizedOp = null;
  let authorityMissing = false;
  for (const ws of workspaceEvents) {
    const wsPayload = ws.payload || {};
    const wsOp = wsPayload.operation || (wsPayload.operation && wsPayload.operation.operation);
    const wsPath = wsPayload.path || (wsPayload.operation && wsPayload.operation.args && wsPayload.operation.args.path);
    const hasAuth = authEvents.some(a => {
      const p = a.payload || {};
      return p.operation === wsOp && p.path === wsPath;
    });
    if (hasAuth) {
      lastAuthorizedOp = { operation: wsOp, path: wsPath, seq: ws.seq, ts: ws.ts };
    } else {
      authorityMissing = true;
    }
  }
  if (authorityMissing) {
    return {
      classification: 'authority_missing',
      reason: 'Workspace operation found without preceding authority event',
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp,
      lastCommittedMutation: workspaceEvents.length > 0 ? {
        operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
        path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
        seq: workspaceEvents[workspaceEvents.length - 1].seq
      } : null,
      expectedNextPhase: 'manual_investigation',
      hashChainValid: hashChain.chainValid
    };
  }

  // ── Priority 4: lease_stale ───────────────────────────────────
  if (run.status === 'running' && run.leaseExpiresAt) {
    const expires = new Date(run.leaseExpiresAt).getTime();
    if (expires < Date.now()) {
      return {
        classification: 'lease_stale',
        reason: `Lease expired at ${run.leaseExpiresAt}, status still running`,
        lastVerifiedSeq: hashChain.lastVerifiedSeq,
        lastVerifiedHash: hashChain.lastVerifiedHash,
        lastAuthorizedOp,
        lastCommittedMutation: workspaceEvents.length > 0 ? {
          operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
          path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
          seq: workspaceEvents[workspaceEvents.length - 1].seq
        } : null,
        expectedNextPhase: 'lease_expiration_or_resume',
        hashChainValid: hashChain.chainValid
      };
    }
  }

  // ── Priority 5: unsafe_to_resume ─────────────────────────────
  if (!hashChain.chainValid) {
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    return {
      classification: 'unsafe_to_resume',
      reason: `Hash chain broken: ${hashChain.errors.join('; ')}`,
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp,
      lastCommittedMutation: workspaceEvents.length > 0 ? {
        operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
        path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
        seq: workspaceEvents[workspaceEvents.length - 1].seq
      } : null,
      expectedNextPhase: 'manual_investigation',
      hashChainValid: false
    };
  }

  // ── Priority 6: mutation_committed_without_terminalization ────
  if (workspaceEvents.length > 0 && terminalEvents.length === 0 && executionCompletedEvents.length === 0) {
    const lastWs = workspaceEvents[workspaceEvents.length - 1];
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    return {
      classification: 'mutation_committed_without_terminalization',
      reason: `${workspaceEvents.length} workspace operations but no terminal event`,
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp,
      lastCommittedMutation: {
        operation: lastWs.payload?.operation,
        path: lastWs.payload?.path,
        seq: lastWs.seq,
        ts: lastWs.ts
      },
      expectedNextPhase: getNextSafePhase(lastEvent ? lastEvent.type : 'unknown'),
      hashChainValid: true
    };
  }

  // ── Priority 7: execution_completed_awaiting_terminalization ──
  const newStyleTerminal = events.some(e => e.type === 'run.terminalized');
  if (executionCompletedEvents.length > 0 && !newStyleTerminal && events.some(e => e.type === 'replay.snapshot.finalized' || e.type === 'run.snapshot_finalized')) {
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    return {
      classification: 'execution_completed_awaiting_terminalization',
      reason: 'Execution completed with snapshot finalized, awaiting terminalization',
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp,
      lastCommittedMutation: workspaceEvents.length > 0 ? {
        operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
        path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
        seq: workspaceEvents[workspaceEvents.length - 1].seq
      } : null,
      expectedNextPhase: 'terminalization',
      hashChainValid: true
    };
  }
  if (executionCompletedEvents.length > 0 && !newStyleTerminal) {
    const lastEvent = events.length > 0 ? events[events.length - 1] : null;
    return {
      classification: 'execution_completed_awaiting_snapshot',
      reason: 'Execution completed but snapshot not finalized and not terminalized',
      lastVerifiedSeq: hashChain.lastVerifiedSeq,
      lastVerifiedHash: hashChain.lastVerifiedHash,
      lastAuthorizedOp,
      lastCommittedMutation: workspaceEvents.length > 0 ? {
        operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
        path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
        seq: workspaceEvents[workspaceEvents.length - 1].seq
      } : null,
      expectedNextPhase: 'snapshot_finalization',
      hashChainValid: true
    };
  }

  // ── Priority 8: safe_to_resume ──────────────────────────────
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  return {
    classification: 'safe_to_resume',
    reason: 'All evidence consistent, run interrupted at known phase',
    lastVerifiedSeq: hashChain.lastVerifiedSeq,
    lastVerifiedHash: hashChain.lastVerifiedHash,
    lastAuthorizedOp,
    lastCommittedMutation: workspaceEvents.length > 0 ? {
      operation: workspaceEvents[workspaceEvents.length - 1].payload?.operation,
      path: workspaceEvents[workspaceEvents.length - 1].payload?.path,
      seq: workspaceEvents[workspaceEvents.length - 1].seq
    } : null,
    expectedNextPhase: getNextSafePhase(lastEvent ? lastEvent.type : 'unknown'),
    hashChainValid: true
  };
}

// ── Main ────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  let dataDir = path.resolve('data');
  let targetRunId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) { dataDir = path.resolve(args[i + 1]); i++; }
    else if (args[i] === '--run-id' && args[i + 1]) { targetRunId = parseInt(args[i + 1], 10); i++; }
  }

  if (!fs.existsSync(dataDir)) {
    console.error(`Data directory not found: ${dataDir}`);
    process.exit(1);
  }

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

  // Filter to non-terminal runs
  const terminalStatuses = ['completed', 'failed', 'interrupted'];
  const nonTerminalRuns = runs.filter(r => !terminalStatuses.includes(r.status));

  const report = {
    dataDir,
    totalRuns: runs.length,
    nonTerminalRuns: nonTerminalRuns.length,
    classifications: []
  };

  for (const run of nonTerminalRuns) {
    if (targetRunId && run.id !== targetRunId) continue;

    const runEvents = events.filter(e => e.runId === run.id && !e._parseError);
    const runOps = operationHistory.filter(o => o.runId === run.id);
    const replay = replaySnapshots[run.id] || null;

    const classification = classifyRun(run, runEvents, replay, runOps);
    report.classifications.push({
      runId: run.id,
      status: run.status,
      leaseOwner: run.leaseOwner || null,
      leaseExpiresAt: run.leaseExpiresAt || null,
      ...classification
    });
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.classifications.some(c => c.classification === 'unsafe_to_resume' || c.classification === 'authority_missing') ? 1 : 0);
}

main();
