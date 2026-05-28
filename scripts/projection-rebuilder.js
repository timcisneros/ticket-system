#!/usr/bin/env node
// Projection Rebuilder — shared rebuild logic for runs and tickets from events.
//
// Exports:
//   readJson, readEventsJsonl
//   groupEventsByRun, rebuildRunProjection
//   groupEventsByTicket, rebuildTicketProjection
//   canonicalJson, computeCanonicalHash

const fs = require('fs');
const crypto = require('crypto');

// ── File helpers ──────────────────────────────────────────────────

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

// ── Canonical JSON ──────────────────────────────────────────────────

function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'undefined') return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => JSON.stringify(String(k)) + ':' + canonicalJson(value[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(value);
}

function computeCanonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ── Run grouping ──────────────────────────────────────────────────

function groupEventsByRun(events) {
  const map = {};
  for (const ev of events) {
    if (ev._parseError) continue;
    const rid = ev.runId;
    if (rid == null) continue;
    if (!map[rid]) map[rid] = [];
    map[rid].push(ev);
  }
  for (const rid of Object.keys(map)) {
    map[rid].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return map;
}

// ── Run rebuild ───────────────────────────────────────────────────

function rebuildRunProjection(runEvents) {
  if (runEvents.length === 0) return null;

  const firstEvent = runEvents[0];
  const runId = firstEvent.runId;
  const ticketId = firstEvent.ticketId;

  // Agent info: prefer run.created, then run.started
  let agentId = null;
  let agentName = null;

  const createdEvent = runEvents.find(e => e.type === 'run.created');
  if (createdEvent && createdEvent.payload) {
    agentId = createdEvent.payload.agentId ?? null;
    agentName = createdEvent.payload.agentName ?? null;
  }
  if (agentId == null) {
    const startedEvent = runEvents.find(e => e.type === 'run.started');
    if (startedEvent && startedEvent.payload) {
      agentId = startedEvent.payload.agentId ?? null;
      agentName = startedEvent.payload.agentName ?? null;
    }
  }
  if (agentId == null) {
    const schedulerEvent = runEvents.find(e => e.type === 'scheduler.run_selected');
    if (schedulerEvent && schedulerEvent.payload) {
      agentId = schedulerEvent.payload.agentId ?? null;
    }
  }

  // Terminal event detection
  const terminalizedEvent = runEvents.find(e => e.type === 'run.terminalized');
  const legacyCompletedEvent = runEvents.find(e => e.type === 'run.completed');
  const legacyFailedEvent = runEvents.find(e => e.type === 'run.failed');
  const legacyInterruptedEvent = runEvents.find(e => e.type === 'run.interrupted');

  // Status derivation (events-only)
  let status = 'pending';
  let completedAt = null;
  let terminalizedStatus = null;

  if (terminalizedEvent) {
    status = terminalizedEvent.payload?.status || 'completed';
    completedAt = terminalizedEvent.ts || null;
    terminalizedStatus = terminalizedEvent.payload?.status || 'completed';
  } else if (legacyCompletedEvent) {
    status = 'completed';
    completedAt = legacyCompletedEvent.ts || null;
    terminalizedStatus = 'completed';
  } else if (legacyFailedEvent) {
    status = 'failed';
    completedAt = legacyFailedEvent.ts || null;
    terminalizedStatus = 'failed';
  } else if (legacyInterruptedEvent) {
    status = 'interrupted';
    completedAt = legacyInterruptedEvent.ts || null;
    terminalizedStatus = 'interrupted';
  } else if (runEvents.some(e => e.type === 'run.started')) {
    status = 'running';
  }

  // Lifecycle phase
  let lifecyclePhase = 'pending';
  if (terminalizedEvent) {
    lifecyclePhase = 'terminalized';
  } else if (legacyCompletedEvent || legacyFailedEvent || legacyInterruptedEvent) {
    lifecyclePhase = 'legacy_terminal';
  } else if (runEvents.some(e => e.type === 'run.consequence_recorded')) {
    lifecyclePhase = 'consequence_recorded';
  } else if (runEvents.some(e => e.type === 'run.evaluation_completed')) {
    lifecyclePhase = 'evaluation_completed';
  } else if (runEvents.some(e => e.type === 'run.snapshot_finalized' || e.type === 'replay.snapshot.finalized')) {
    lifecyclePhase = 'snapshot_finalized';
  } else if (runEvents.some(e => e.type === 'run.execution_completed')) {
    lifecyclePhase = 'execution_completed';
  } else if (runEvents.some(e => e.type === 'run.started')) {
    lifecyclePhase = 'running';
  }

  // startedAt
  let startedAt = null;
  const startedEvent = runEvents.find(e => e.type === 'run.started');
  if (startedEvent) {
    startedAt = startedEvent.payload?.startedAt || startedEvent.ts || null;
  }

  // Evaluation / consequence presence
  const hasEvaluation = runEvents.some(e => e.type === 'run.evaluation_completed');
  const hasConsequence = runEvents.some(e => e.type === 'run.consequence_recorded');

  // Mutation count (from workspace.operation events)
  const mutationCount = runEvents.filter(e => e.type === 'workspace.operation').length;

  // Authority count
  const authorityCount = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied').length;

  // Snapshot finalized
  const hasSnapshotFinalized = runEvents.some(e => e.type === 'run.snapshot_finalized' || e.type === 'replay.snapshot.finalized');

  // Execution completed
  const hasExecutionCompleted = runEvents.some(e => e.type === 'run.execution_completed') ||
    !!(legacyCompletedEvent || legacyFailedEvent || legacyInterruptedEvent);

  // Reconcilable: execution done but not terminal
  const isReconcilable = hasExecutionCompleted && !terminalizedEvent && !(legacyCompletedEvent || legacyFailedEvent || legacyInterruptedEvent);

  return {
    id: runId,
    ticketId,
    agentId,
    agentName,
    status,
    lifecyclePhase,
    startedAt,
    completedAt,
    terminalizedStatus,
    hasEvaluation,
    hasConsequence,
    mutationCount,
    authorityCount,
    hasSnapshotFinalized,
    hasExecutionCompleted,
    isReconcilable,
    eventCount: runEvents.length
  };
}

// ── Ticket grouping ───────────────────────────────────────────────

function groupEventsByTicket(events) {
  const map = {};
  for (const ev of events) {
    if (ev._parseError) continue;
    const tid = ev.ticketId;
    if (tid == null) continue;
    if (!map[tid]) map[tid] = [];
    map[tid].push(ev);
  }
  for (const tid of Object.keys(map)) {
    map[tid].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return map;
}

// ── Ticket rebuild ────────────────────────────────────────────────

function rebuildTicketProjection(ticketEvents, allEvents) {
  if (ticketEvents.length === 0) return null;

  const ticketId = ticketEvents[0].ticketId;

  // ticket.created gives static fields
  const createdEvent = ticketEvents.find(e => e.type === 'ticket.created');
  const createdPayload = createdEvent?.payload || {};

  // ticket.updated gives status transitions
  const updatedEvents = ticketEvents.filter(e => e.type === 'ticket.updated').sort((a, b) => {
    const aSeq = a.seq ?? 0;
    const bSeq = b.seq ?? 0;
    return aSeq - bSeq;
  });

  // Derive status from run terminal events
  const runEvents = allEvents.filter(e => e.runId != null && !e._parseError);
  const runsForTicket = {};
  for (const ev of runEvents) {
    if (!runsForTicket[ev.runId]) runsForTicket[ev.runId] = [];
    runsForTicket[ev.runId].push(ev);
  }

  // Find runs that belong to this ticket
  const runIdsForTicket = new Set();
  for (const ev of runEvents) {
    if (ev.ticketId === ticketId && ev.runId != null) {
      runIdsForTicket.add(ev.runId);
    }
  }

  // Determine latest run and its terminal status
  let latestRunId = null;
  let latestRunTerminalStatus = null;
  let latestRunCompletedAt = null;
  let latestTerminalSeq = null;
  let hasFailedRun = false;
  let hasCompletedRun = false;
  let totalCompletedRuns = 0;
  let totalFailedRuns = 0;
  let totalInterruptedRuns = 0;
  let hasReconcilableRun = false;

  for (const runId of runIdsForTicket) {
    const revts = runsForTicket[runId] || [];
    const terminalized = revts.find(e => e.type === 'run.terminalized');
    const legacyCompleted = revts.find(e => e.type === 'run.completed');
    const legacyFailed = revts.find(e => e.type === 'run.failed');
    const legacyInterrupted = revts.find(e => e.type === 'run.interrupted');
    const executionCompleted = revts.find(e => e.type === 'run.execution_completed');

    let status = null;
    let completedAt = null;

    if (terminalized) {
      status = terminalized.payload?.status || 'completed';
      completedAt = terminalized.ts || null;
    } else if (legacyCompleted) {
      status = 'completed';
      completedAt = legacyCompleted.ts || null;
    } else if (legacyFailed) {
      status = 'failed';
      completedAt = legacyFailed.ts || null;
    } else if (legacyInterrupted) {
      status = 'interrupted';
      completedAt = legacyInterrupted.ts || null;
    } else if (executionCompleted) {
      status = 'execution_completed';
      completedAt = executionCompleted.ts || null;
      hasReconcilableRun = true;
    } else {
      status = 'pending_or_running';
    }

    if (status === 'completed') { hasCompletedRun = true; totalCompletedRuns++; }
    if (status === 'failed') { hasFailedRun = true; totalFailedRuns++; }
    if (status === 'interrupted') { totalInterruptedRuns++; }

    const terminalEvent = terminalized || legacyCompleted || legacyFailed || legacyInterrupted || executionCompleted || null;
    const tiebreakerSeq = terminalEvent?.seq ?? 0;
    if (completedAt) {
      if (!latestRunCompletedAt || completedAt > latestRunCompletedAt ||
          (completedAt === latestRunCompletedAt && tiebreakerSeq > (latestTerminalSeq ?? 0))) {
        latestRunCompletedAt = completedAt;
        latestRunId = runId;
        latestRunTerminalStatus = status;
        latestTerminalSeq = tiebreakerSeq;
      }
    } else {
      const started = revts.find(e => e.type === 'run.started');
      const created = revts.find(e => e.type === 'run.created');
      const ts = started?.ts || created?.ts || null;
      if (ts && (!latestRunCompletedAt || ts > latestRunCompletedAt ||
          (ts === latestRunCompletedAt && tiebreakerSeq > (latestTerminalSeq ?? 0)))) {
        latestRunCompletedAt = ts;
        latestRunId = runId;
        latestRunTerminalStatus = status;
        latestTerminalSeq = tiebreakerSeq;
      }
    }
  }

  // Derive ticket status from run outcomes
  let derivedStatus = 'open';
  let failureState = null;
  let interruptionState = null;

  if (hasFailedRun) {
    derivedStatus = 'failed';
    failureState = 'failed';
  } else if (latestRunTerminalStatus === 'interrupted') {
    derivedStatus = 'open';
    interruptionState = 'interrupted';
  } else if (hasCompletedRun) {
    derivedStatus = 'completed';
  } else if (latestRunTerminalStatus === 'execution_completed') {
    derivedStatus = 'in_progress';
  } else if (latestRunTerminalStatus === 'pending_or_running') {
    derivedStatus = 'in_progress';
  }

  // ticket.updated events override
  const lastUpdated = updatedEvents.length > 0 ? updatedEvents[updatedEvents.length - 1] : null;
  let statusFromEvents = derivedStatus;
  if (lastUpdated && lastUpdated.payload?.status) {
    statusFromEvents = lastUpdated.payload.status;
  }

  const createdAt = createdPayload.createdAt || (createdEvent?.ts) || null;
  let updatedAt = lastUpdated?.payload?.updatedAt || lastUpdated?.ts || latestRunCompletedAt || createdAt;

  // Mutation / authority counts across all runs
  let totalMutations = 0;
  let totalAuthorityEvents = 0;
  for (const runId of runIdsForTicket) {
    totalMutations += (runsForTicket[runId] || []).filter(e => e.type === 'workspace.operation').length;
    totalAuthorityEvents += (runsForTicket[runId] || []).filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied').length;
  }

  return {
    id: ticketId,
    status: statusFromEvents,
    derivedStatus,
    createdAt,
    updatedAt,
    assignmentTargetType: createdPayload.assignmentTargetType || null,
    assignmentTargetId: createdPayload.assignmentTargetId || null,
    assignmentMode: createdPayload.assignmentMode || null,
    executionMode: createdPayload.executionMode || null,
    capabilityType: createdPayload.capabilityType || null,
    capabilityId: createdPayload.capabilityId || null,
    workflowId: createdPayload.workflowId || null,
    createdBy: createdPayload.createdBy || null,
    latestRunId,
    latestRunTerminalStatus,
    failureState,
    interruptionState,
    totalRuns: runIdsForTicket.size,
    totalCompletedRuns,
    totalFailedRuns,
    totalInterruptedRuns,
    totalMutations,
    totalAuthorityEvents,
    hasReconcilableRun,
    eventCount: ticketEvents.length
  };
}

// ── Exports ───────────────────────────────────────────────────────

module.exports = {
  readJson,
  readEventsJsonl,
  canonicalJson,
  computeCanonicalHash,
  groupEventsByRun,
  rebuildRunProjection,
  groupEventsByTicket,
  rebuildTicketProjection
};
