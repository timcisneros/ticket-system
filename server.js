const fastify = require('fastify')({ logger: false });
const path = require('path');
const fs = require('fs');
const argon2 = require('argon2');
const crypto = require('crypto');
const { createRuntimeRunner } = require('./runtime/runner');
const { createRuntimeScheduler } = require('./runtime/scheduler');
const { createTemplateScheduler } = require('./runtime/template-scheduler');
const { readMatchingEvents } = require('./runtime/event-reader');
const { buildObjectiveContract, parseSimpleFolderListObjective: contractParseSimpleFolderListObjective, isReportObjective: contractIsReportObjective, getReportRuntimeLimits: contractGetReportRuntimeLimits, runObjectiveClarificationGate } = require('./objective-contract');
require('dotenv').config()

const PORT = process.env.PORT || 3099;

// Data file paths
const REPO_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : REPO_DATA_DIR;
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DATA_FILE = path.join(DATA_DIR, 'tickets.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'permissions.json');
const MEMBERSHIPS_FILE = path.join(DATA_DIR, 'memberships.json');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const LOGS_FILE = path.join(DATA_DIR, 'logs.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const DATA_DIR_WRITER_LOCK_FILE = path.join(DATA_DIR, 'writer-lock.json');
const ALLOCATION_PLANS_FILE = path.join(DATA_DIR, 'allocation-plans.json');
const OPERATION_HISTORY_FILE = path.join(DATA_DIR, 'operation-history.json');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const PROCESS_TEMPLATES_FILE = path.join(DATA_DIR, 'process-templates.json');
const PROCESS_TEMPLATE_TRIGGERS_FILE = path.join(DATA_DIR, 'process-template-triggers.json');
// Smallest allowed scheduled-trigger interval. Guards against sub-minute storms; the
// separate template scheduler scans at PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS (default 60s).
const MIN_SCHEDULE_EVERY_SECONDS = 60;
const REPLAY_SNAPSHOTS_DIR = path.join(DATA_DIR, 'replay-snapshots');
const PROTECTED_PATHS_FILE = path.join(__dirname, 'config', 'protected-paths.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PROVIDERS = ['openai', 'ollama'];
const MODELS = ['gpt-5.1', 'gpt-5.1-mini', 'gpt-4.1', 'gpt-4.1-mini'];
const TICKET_STATUSES = ['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed'];
const TRIAGE_REASON_CODES = ['verification_failed', 'authority_blocked', 'runtime_failed', 'provider_failed', 'stopped', 'objective_ambiguous', 'unknown'];
const TRIAGE_REQUIRED_DECISIONS = ['review_failure', 'approve_retry', 'change_scope', 'fix_input', 'manual_recovery', 'clarify_objective', 'none'];
const DEFAULT_EXECUTION_POLICY = Object.freeze({
  mode: 'assisted',
  requireVerification: 'when_declared',
  autoRetry: false,
  maxAttempts: null,
  maxRuntimeMs: null,
  maxModelRequests: null,
  maxWorkspaceOperations: null,
  allowWorkspaceWrites: true,
  allowParallelRuns: false,
  allowChildTickets: false,
  workspaceScope: 'shared'
});
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, 'workspace-root'));

function isRepoDataDir() {
  return path.resolve(DATA_DIR) === path.resolve(REPO_DATA_DIR);
}

console.log(`DATA_DIR=${DATA_DIR}`);
console.log(`WORKSPACE_ROOT=${WORKSPACE_ROOT}`);
console.log(`repo-store=${isRepoDataDir()}`);

function writeMissingFile(fileName, content) {
  const targetPath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(targetPath)) return;
  fs.writeFileSync(targetPath, content);
}

function copyMissingSeedFile(fileName, fallbackContent = '[]') {
  const targetPath = path.join(DATA_DIR, fileName);
  if (fs.existsSync(targetPath)) return;

  const sourcePath = path.join(REPO_DATA_DIR, fileName);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    return;
  }

  fs.writeFileSync(targetPath, fallbackContent);
}

function seedOperationalDataDir() {
  if (isRepoDataDir()) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  [
    'users.json',
    'agents.json',
    'groups.json',
    'memberships.json',
    'permissions.json',
    'workflows.json',
    'protected-paths.json'
  ].forEach(fileName => copyMissingSeedFile(fileName, '[]'));

  [
    'tickets.json',
    'runs.json',
    'logs.json',
    'operation-history.json',
    'allocation-plans.json'
  ].forEach(fileName => writeMissingFile(fileName, '[]'));

  writeMissingFile('events.jsonl', '');
}
function readDataDirWriterLock() {
  try {
    return JSON.parse(fs.readFileSync(DATA_DIR_WRITER_LOCK_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function buildDataDirWriterLock(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    pid: process.pid,
    startedAt: timestamp,
    dataDir: DATA_DIR,
    workspaceRoot: WORKSPACE_ROOT,
    heartbeatAt: timestamp
  };
}

function writeDataDirWriterLock(lock) {
  fs.writeFileSync(DATA_DIR_WRITER_LOCK_FILE, JSON.stringify(lock, null, 2));
}

function acquireDataDirWriterLock() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lock = buildDataDirWriterLock();

  try {
    const fd = fs.openSync(DATA_DIR_WRITER_LOCK_FILE, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(lock, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    dataDirWriterLock = lock;
    return { acquired: true, lock };
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }

  const existingLock = readDataDirWriterLock();
  if (existingLock && isProcessAlive(existingLock.pid)) {
    return { acquired: false, lock: existingLock };
  }

  try {
    fs.unlinkSync(DATA_DIR_WRITER_LOCK_FILE);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  return acquireDataDirWriterLock();
}

function heartbeatDataDirWriterLock() {
  if (!dataDirWriterLock) return;
  const currentLock = readDataDirWriterLock();
  if (!currentLock || currentLock.pid !== process.pid) return;
  dataDirWriterLock = {
    ...dataDirWriterLock,
    heartbeatAt: new Date().toISOString()
  };
  writeDataDirWriterLock(dataDirWriterLock);
}

function startDataDirWriterLockHeartbeat() {
  if (!dataDirWriterLock || dataDirWriterLockHeartbeatTimer) return;
  dataDirWriterLockHeartbeatTimer = setInterval(heartbeatDataDirWriterLock, 5000);
}

function releaseDataDirWriterLock() {
  if (dataDirWriterLockHeartbeatTimer) clearInterval(dataDirWriterLockHeartbeatTimer);
  dataDirWriterLockHeartbeatTimer = null;

  const currentLock = readDataDirWriterLock();
  if (currentLock && currentLock.pid === process.pid) {
    try {
      fs.unlinkSync(DATA_DIR_WRITER_LOCK_FILE);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  dataDirWriterLock = null;
}

function refreshDataDirWriterLockForDebugReset() {
  if (!dataDirWriterLock) return;
  dataDirWriterLock = buildDataDirWriterLock();
  writeDataDirWriterLock(dataDirWriterLock);
}

const AGENT_ALLOWED_OPERATIONS = ['listDirectory', 'readFile', 'createFolder', 'writeFile', 'renamePath', 'deletePath'];
const AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED = process.env.AGENT_ALLOW_CANONICAL_WORKFLOW_DRAFT === '1';
const AGENT_WORKFLOW_DRAFT_OPERATIONS = [
  ...(AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED ? ['createWorkflowDraft'] : []),
  'createWorkflowDraftIntent'
];
const AGENT_HANDOFF_OPERATIONS = ['createHandoffTask'];
const AGENT_DIRECT_OPERATIONS = [...AGENT_ALLOWED_OPERATIONS, ...AGENT_WORKFLOW_DRAFT_OPERATIONS, ...AGENT_HANDOFF_OPERATIONS];
const AGENT_MUTATING_OPERATIONS = ['createFolder', 'writeFile', 'renamePath', 'deletePath'];
const AGENT_OPERATION_ARGS = {
  listDirectory: ['path'],
  readFile: ['path'],
  createFolder: ['path'],
  writeFile: ['path', 'content'],
  renamePath: ['path', 'nextPath'],
  deletePath: ['path']
};
const ACTION_TYPES = ['workspaceAction', 'agentAction', 'conditionAction', 'systemAction', 'stopAction', 'workflowAction'];
const MAX_AGENT_ACTIONS_PER_RESPONSE = 8;
const MAX_MUTATING_ACTIONS_PER_RESPONSE = parseInt(process.env.AGENT_MAX_MUTATING_ACTIONS_PER_RESPONSE || '2', 10) || 2;
const ENABLE_PREFIX_TRUNCATION = process.env.ENABLE_PREFIX_TRUNCATION === 'true';
const DEFAULT_AGENT_RUNTIME_LIMITS = {
  maxExecutionSteps: 4,
  maxWorkspaceOperationsPerRun: 32,
  maxModelRequestsPerRun: 4,
  maxRuntimeDurationMs: 120000
};
const DEFAULT_LOCAL_MODEL_CONCURRENCY = 1;
const DEFAULT_PROTECTED_WORKSPACE_PATHS = ['.git', '.env', '.env.*', 'node_modules', 'package.json', 'pnpm-lock.yaml'];
const WORKSPACE_FIXTURES = [
  { id: 'empty', name: 'Empty workspace' },
  { id: 'simple-files', name: 'Simple files' },
  { id: 'nested-folders', name: 'Nested folders' },
  { id: 'existing-target-folder', name: 'Existing target folder' },
  { id: 'conflicting-file-names', name: 'Conflicting file names' },
  { id: 'read-only-like', name: 'Read-only-like scenario' },
  { id: 'large-file', name: 'Large-ish file scenario' },
  { id: 'many-small-files', name: 'Many small files scenario' }
];

// ── Execution phases ──────────────────────────────────────────────
const EXECUTION_PHASES = ['planning', 'inspection', 'mutation', 'verification', 'terminalization'];
const PHASE_OPERATIONS = {
  planning: [],
  inspection: ['listDirectory', 'readFile'],
  mutation: ['writeFile', 'createFolder', 'renamePath', 'deletePath', 'createWorkflowDraft', 'createWorkflowDraftIntent', 'createHandoffTask'],
  verification: ['listDirectory', 'readFile'],
  terminalization: []
};
const ALLOWED_PHASE_TRANSITIONS = {
  planning: ['planning', 'inspection', 'mutation', 'verification'],
  inspection: ['inspection', 'mutation', 'verification'],
  mutation: ['mutation', 'verification'],
  verification: ['verification', 'terminalization'],
  terminalization: ['terminalization']
};

// Single source of truth for the operations the prompt may present as usable in a
// given phase. Derived from the validator contract (PHASE_OPERATIONS + the
// "one phase per response" rule enforced by checkPhaseCompliance): the validator
// accepts any pure single-phase response and rejects only mixed-phase and
// terminalization responses. Planning is an entry state whose immediate safe
// operations are inspection reads; to mutate, the model emits a pure mutation
// response (the prompt's transition guidance states this). This intentionally
// never lists an operation the validator would reject for the current phase as a
// pure response, and never advertises mutating operations under planning.
function getAllowedOperationsForPhase(phase) {
  switch (phase) {
    case 'mutation':
      return [...PHASE_OPERATIONS.mutation];
    case 'inspection':
    case 'verification':
      return ['listDirectory', 'readFile'];
    case 'terminalization':
      return [];
    case 'planning':
    default:
      return ['listDirectory', 'readFile'];
  }
}

// ── Workload Profiles ─────────────────────────────────────────────
// Explicit operational envelopes for common ticket classes.
// Derived from observed workload behavior during validation.

const WORKLOAD_PROFILES = {
  report: {
    name: 'report',
    description: 'Inspection-heavy task producing a summary or analysis document',
    executionStepLimit: 12,
    modelRequestLimit: 8,
    maxWorkspaceOperations: 32,
    maxListDirectory: 3,
    maxReadFile: 8,
    procedure: [
      'Cite specific file paths you inspected. Do not invent file contents.',
      'Do not create multiple report files. One report artifact per ticket.'
    ]
  },
  diagnosis: {
    name: 'diagnosis',
    description: 'Read files to identify bugs, test failures, or incorrect behavior',
    executionStepLimit: 12,
    modelRequestLimit: 8,
    maxWorkspaceOperations: 24,
    maxListDirectory: 2,
    maxReadFile: 6,
    procedure: [
      'Focus on identifying the root cause of the bug or test failure.',
      'Explain why each identified assertion is incorrect with evidence from the source code.'
    ]
  },
  refactor: {
    name: 'refactor',
    description: 'Move, rename, or restructure files and folders',
    executionStepLimit: 12,
    modelRequestLimit: 8,
    maxWorkspaceOperations: 24,
    maxListDirectory: 2,
    maxReadFile: 4,
    procedure: [
      'This is a workspace organization task. Follow this exact phase progression in your responses:',
      '  Phase 1 — DISCOVER: listDirectory the relevant directory ONCE. Identify every item that must be moved, renamed, or created. Do not list again in later steps.',
      '  Phase 2 — MUTATE: Use the discovered entries to emit bounded mutation batches. Do not repeat DISCOVER unless evidence is insufficient. Respect maxMutatingActionsPerResponse. If more mutations remain, continue with the next bounded mutation batch.',
      '  Phase 3 — VERIFY: listDirectory the affected directories to confirm items are in the correct locations. Check that no items remain at old locations. Verify only after at least one mutation batch has executed.',
      '  Phase 4 — COMPLETE: Set complete:true only after verification succeeds.',
      'If no matching items exist at the source, state this clearly and complete after any required createFolder operations.',
      'If required paths or destinations cannot be determined, fail with an explicit reason. Do not enter a loop of repeated listDirectory calls.'
    ]
  }
};

// ── Test-only deterministic interruption hooks ──────────────────────
// These hooks are activated by TEST_INTERRUPTION_POINT env var.
// They allow pressure tests to crash the server at known evidence
// boundaries, making recovery scenarios reproducible.
// No production behavior change when the env var is absent.

const TEST_INTERRUPTION_POINT = process.env.TEST_INTERRUPTION_POINT || '';
const testInterruptFirstAuthority = new Set();
const testInterruptFirstWorkspaceOp = new Set();

function maybeTestInterrupt(run, point) {
  if (!TEST_INTERRUPTION_POINT || TEST_INTERRUPTION_POINT !== point) return;
  if (!run || !run.id) return;

  // For per-run-once hooks, only fire once
  if (point === 'after_first_authority.allowed') {
    if (testInterruptFirstAuthority.has(run.id)) return;
    testInterruptFirstAuthority.add(run.id);
  }
  if (point === 'after_first_workspace.operation') {
    if (testInterruptFirstWorkspaceOp.has(run.id)) return;
    testInterruptFirstWorkspaceOp.add(run.id);
  }

  // Flush ALL pending events to disk synchronously before SIGKILL
  // so that recovery tools can reconstruct state from persisted evidence.
  // Avoid writing duplicates by skipping events already on disk.
  let persistedIds = new Set();
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev && ev.id) persistedIds.add(ev.id);
      } catch (_) {}
    }
  } catch (_) {}

  const eventsToFlush = pendingEventBuffer.filter(e => !persistedIds.has(e.id));
  if (eventsToFlush.length > 0) {
    const lines = eventsToFlush.map(ev => `${JSON.stringify(ev)}\n`).join('');
    try {
      fs.appendFileSync(EVENTS_FILE, lines, 'utf8');
      pendingEventBuffer = pendingEventBuffer.filter(e => !eventsToFlush.includes(e));
    } catch (e) {
      console.error(`Failed to flush pending events: ${e.message}`);
    }
  }

  // Write the interruption event itself
  const event = {
    id: normalizeEventId(),
    ts: createLogTimestamp(),
    type: 'interruption.test_hook',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: null,
    payload: { point, reason: 'Deterministic test interruption triggered' }
  };

  // Add seq/prevHash for run events
  if (event.runId !== null) {
    const runId = event.runId;
    const chain = runEventChains.get(runId) || { seq: 0, prevHash: null };
    event.seq = chain.seq;
    event.prevHash = chain.prevHash;
    const currentHash = computeEventHash(event);
    runEventChains.set(runId, {
      seq: chain.seq + 1,
      prevHash: currentHash
    });
  }

  try {
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (e) {
    console.error(`Failed to write interruption event: ${e.message}`);
  }

  // Kill the server process to simulate a crash
  process.kill(process.pid, 'SIGKILL');
}

// ── Resumable execution helpers (minimal) ─────────────────────────

function computeMutationFingerprint(operation, args) {
  if (operation === 'writeFile') return `writeFile:${args.path}`;
  if (operation === 'createFolder') return `createFolder:${args.path}`;
  if (operation === 'renamePath') return `renamePath:${args.path}->${args.nextPath}`;
  if (operation === 'deletePath') return `deletePath:${args.path}`;
  return null;
}

function computePathFingerprint(operation, args) {
  if (operation === 'writeFile') return `path:${args.path}`;
  if (operation === 'createFolder') return `path:${args.path}`;
  if (operation === 'renamePath') return `path:${args.path}`;
  if (operation === 'deletePath') return `path:${args.path}`;
  return null;
}

function findConflictingMutation(runId, operation, args) {
  const histories = readOperationHistory();
  const pathFingerprint = computePathFingerprint(operation, args);
  if (!pathFingerprint) return null;
  return histories.find(h => {
    if (h.runId !== runId) return false;
    if (computePathFingerprint(h.operation, h.args) !== pathFingerprint) return false;
    if (computeMutationFingerprint(h.operation, h.args) === computeMutationFingerprint(operation, args)) return false;
    // Allow writeFile -> renamePath and createFolder -> renamePath sequences
    if (operation === 'renamePath' && ['writeFile', 'createFolder'].includes(h.operation)) {
      return false;
    }
    return true;
  });
}

function findCommittedMutation(runId, operation, args) {
  const histories = readOperationHistory();
  const fingerprint = computeMutationFingerprint(operation, args);
  if (!fingerprint) return null;
  return histories.find(h =>
    h.runId === runId &&
    h.operation === operation &&
    computeMutationFingerprint(h.operation, h.args) === fingerprint
  );
}

function mutationAlreadyCommitted(runId, operation, args) {
  return !!findCommittedMutation(runId, operation, args);
}

function normalizeArtifactOwnershipPath(value) {
  const normalized = path.posix.normalize(String(value || '').replace(/\\/g, '/').trim()).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;
  if (normalized.split('/').some(segment => segment === '..')) return null;
  return normalized;
}

function getSuccessfulArtifactOwnershipPath(record) {
  if (!record || record.error) return null;
  const args = record.args || {};
  const result = record.result || {};
  if (record.operation === 'writeFile') return normalizeArtifactOwnershipPath(result.path || args.path);
  if (record.operation === 'createFolder') return normalizeArtifactOwnershipPath(result.path || args.path);
  if (record.operation === 'renamePath') return normalizeArtifactOwnershipPath(args.nextPath);
  return null;
}

function findPriorSuccessfulArtifactOwner(operationHistory, run, targetPath) {
  if (!run) return null;
  const normalizedTarget = normalizeArtifactOwnershipPath(targetPath);
  if (!normalizedTarget) return null;
  return (operationHistory || []).find(record => {
    if (!record || record.error) return false;
    if (record.ticketId === run.ticketId) return false;
    return getSuccessfulArtifactOwnershipPath(record) === normalizedTarget;
  }) || null;
}

// True when normalized relative paths a and b are the same path or one contains
// the other (ancestor/descendant). Used so a destructive deletePath/renamePath on
// `parent/` is recognized as overlapping an artifact produced at `parent/` or
// `parent/nested/file.txt`, and vice versa. `alpha/` and `beta/` do not overlap.
function workspacePathsOverlap(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

// Like findPriorSuccessfulArtifactOwner, but matches when another ticket's
// produced artifact overlaps (equals, contains, or is contained by) the candidate
// path — the protection a destructive deletePath/renamePath needs so it cannot
// remove or move a directory holding another ticket's output. Same-ticket records
// are ignored (rerun/idempotency stay allowed).
function findOverlappingSuccessfulArtifactOwner(operationHistory, run, candidatePath) {
  if (!run) return null;
  const normalizedCandidate = normalizeArtifactOwnershipPath(candidatePath);
  if (!normalizedCandidate) return null;
  return (operationHistory || []).find(record => {
    if (!record || record.error) return false;
    if (record.ticketId === run.ticketId) return false;
    const produced = getSuccessfulArtifactOwnershipPath(record);
    return produced && workspacePathsOverlap(normalizedCandidate, produced);
  }) || null;
}

// Permission that lets a human-delegated ticket authorize deleting an artifact
// another ticket produced. Granted to the Administrators group (which receives the
// full permission catalog in createDefaultData); other groups do not have it.
const CROSS_TICKET_DELETE_PERMISSION = 'workspace.delete.cross_ticket_artifact';

// Build the WORKSPACE_WRITE_CONFLICT error (same shape/mechanism as the writeFile
// prior-owner guard) for a destructive op overlapping another ticket's artifact.
function buildCrossTicketConflictError(operation, args, candidatePath, owner) {
  const ownerPath = getSuccessfulArtifactOwnershipPath(owner);
  const error = new Error(`Workspace ${operation === 'deletePath' ? 'delete' : 'rename'} conflict: path ${candidatePath} overlaps an artifact (${ownerPath}) previously produced by ticket ${owner.ticketId}, run ${owner.runId}`);
  error.code = 'WORKSPACE_WRITE_CONFLICT';
  error.failureKind = 'invalid_action';
  error.workspaceAction = {
    operation,
    args,
    path: candidatePath,
    blocked: true,
    reason: 'overlapping_artifact_owner',
    conflictingTicketId: owner.ticketId,
    conflictingRunId: owner.runId,
    conflictingHistoryId: owner.id || null,
    conflictingPath: ownerPath
  };
  return error;
}

// Build the run-level delegated-authority descriptor from an authenticated
// request. Captured at run-initiation time (creation/rerun/reopen) and stored on
// the run, so cross-ticket permission is evaluated against the user who actually
// initiated the run — never a later, unrelated ticket editor.
function delegatedFromRequest(request, source) {
  if (!request || !request.session || request.session.userId == null) return null;
  return {
    userId: request.session.userId,
    username: request.user ? request.user.username : null,
    source
  };
}

// Resolve the acting principal for shared ticket creation. Mirrors the historical
// POST /tickets createdBy resolution (username when known, else the session user id).
function actorFromRequest(request) {
  if (!request || !request.session) return { userId: null, username: null };
  return {
    userId: request.session.userId != null ? request.session.userId : null,
    username: request.user ? request.user.username : null
  };
}

// Record audit evidence for a permissioned cross-ticket artifact delete using the
// existing event + run-log mechanisms (no event-log mechanics changed). The actor
// is the run's delegated initiator, not whoever last edited the ticket.
function recordPermissionedCrossTicketDelete(run, operation, args, candidatePath, owner) {
  const audit = {
    operation,
    path: candidatePath,
    priorOwnerTicketId: owner.ticketId,
    priorOwnerRunId: owner.runId,
    priorOwnerHistoryId: owner.id || null,
    priorOwnerPath: getSuccessfulArtifactOwnershipPath(owner),
    requestingTicketId: run.ticketId,
    requestingRunId: run.id,
    actorUserId: run.delegatedUserId != null ? run.delegatedUserId : null,
    actorUsername: run.delegatedUsername || null,
    delegatedPermissionSource: run.delegatedPermissionSource || null,
    permissionUsed: CROSS_TICKET_DELETE_PERMISSION,
    source: 'permissioned_cross_ticket_artifact_delete'
  };
  appendEvent({ type: 'workspace.cross_ticket_delete_authorized', ticketId: run.ticketId, runId: run.id, payload: audit });
  appendRunLog(
    run,
    'workspace:cross_ticket_delete_authorized',
    `Permissioned cross-ticket delete of ${candidatePath} authorized (prior owner ticket ${owner.ticketId}, run ${owner.runId}; permission ${CROSS_TICKET_DELETE_PERMISSION})`,
    { operation, args, path: candidatePath, status: 'authorized_cross_ticket_delete' },
    audit
  );
}

// Guard a destructive op whose path overlaps another ticket's produced artifact.
// renamePath is always blocked. deletePath is blocked too, UNLESS the user who
// INITIATED this run (run.delegatedUserId) holds
// workspace.delete.cross_ticket_artifact — in which case the delete is allowed and
// recorded as a permissioned, audited action. Permission is evaluated live against
// that fixed initiator identity. Throws before any fs mutation or history persist;
// same-ticket never reaches here.
function assertNoCrossTicketOverlap(run, operation, args, candidatePath) {
  const owner = findOverlappingSuccessfulArtifactOwner(readOperationHistory(), run, candidatePath);
  if (!owner) return;
  if (operation === 'deletePath' && run && run.delegatedUserId != null && hasPermission(run.delegatedUserId, CROSS_TICKET_DELETE_PERMISSION)) {
    recordPermissionedCrossTicketDelete(run, operation, args, candidatePath, owner);
    return;
  }
  throw buildCrossTicketConflictError(operation, args, candidatePath, owner);
}

// ── Phase-aware execution helpers ─────────────────────────────────

function inferPhaseFromActions(actions) {
  const ops = actions.map(a => {
    if (a && typeof a === 'object' && a.operation) return a.operation;
    if (a && typeof a === 'object' && a.op) return a.op;
    return null;
  }).filter(Boolean);

  if (ops.length === 0) return 'planning';

  const phases = new Set();
  for (const op of ops) {
    for (const [phase, allowed] of Object.entries(PHASE_OPERATIONS)) {
      if (allowed.includes(op)) phases.add(phase);
    }
  }

  if (phases.size === 1) return [...phases][0];

  // Disambiguate: inspection and verification share the same operations.
  // If the only matched phases are inspection+verification, default to inspection.
  const onlyReadPhases = phases.size === 2 && phases.has('inspection') && phases.has('verification');
  if (onlyReadPhases) return 'inspection';

  return 'mixed';
}

function isPhaseTransitionAllowed(currentPhase, nextPhase) {
  if (currentPhase === nextPhase) return true;
  const allowed = ALLOWED_PHASE_TRANSITIONS[currentPhase] || [];
  return allowed.includes(nextPhase);
}

function checkPhaseCompliance(run, actions) {
  const currentPhase = run.currentPhase || 'planning';
  let inferredPhase = inferPhaseFromActions(actions);

  // Disambiguate inspection vs verification based on current phase.
  // readFile/listDirectory after mutation is verification, not inspection.
  if (inferredPhase === 'inspection' && ['mutation', 'verification'].includes(currentPhase)) {
    inferredPhase = 'verification';
  }

  // Terminalization with no actions stays in terminalization.
  if (currentPhase === 'terminalization' && inferredPhase === 'planning') {
    inferredPhase = 'terminalization';
  }

  if (inferredPhase === 'mixed') {
    return {
      compliant: false,
      reason: 'Mixed-phase response: actions belong to different execution phases',
      currentPhase,
      inferredPhase,
      violationType: 'mixed_phase'
    };
  }

  // Terminalization is a terminal state: no workspace or model operations allowed.
  if (currentPhase === 'terminalization' && inferredPhase !== 'terminalization') {
    return {
      compliant: false,
      reason: 'Run is in terminalization phase: no further workspace operations allowed',
      currentPhase,
      inferredPhase,
      violationType: 'terminalization_blocked'
    };
  }

  // The invariant is: a single model response must belong to exactly one execution phase.
  // Phase state tracks forward progression for observability, but does not constrain
  // which single-phase response the model may emit. The only rejection boundary is
  // mixed-phase responses (enforced above) and terminalization (enforced here).
  return { compliant: true, currentPhase, inferredPhase };
}

function advanceRunPhase(run, phase) {
  if (!run || !phase) return run;
  if (run.currentPhase === phase) return run;
  // Phase state tracks forward progression only. Do not record backward moves.
  if (!isPhaseTransitionAllowed(run.currentPhase || 'planning', phase)) return run;
  run.currentPhase = phase;
  const runs = readRuns();
  const idx = runs.findIndex(r => r.id === run.id);
  if (idx !== -1) {
    runs[idx].currentPhase = phase;
    writeRuns(runs);
  }
  return run;
}

function reconstructRunPhase(run) {
  const runEvents = readRunScopedEvents(run.id).sort((a, b) => {
    const tsCmp = String(a.ts).localeCompare(String(b.ts));
    if (tsCmp !== 0) return tsCmp;
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return 0;
  });

  // Replay phase transitions from events
  let phase = 'planning';
  for (const e of runEvents) {
    if (e.type === 'execution.phase_transition' && e.payload && e.payload.toPhase) {
      phase = e.payload.toPhase;
    }
    if (e.type === 'execution.phase_violation' && e.payload && e.payload.currentPhase) {
      phase = e.payload.currentPhase;
    }
  }
  return phase;
}

function reconstructResumableState(run) {
  // Read all events for this run
  const runEvents = readRunScopedEvents(run.id).sort((a, b) => {
    const tsCmp = String(a.ts).localeCompare(String(b.ts));
    if (tsCmp !== 0) return tsCmp;
    if (a.seq !== undefined && b.seq !== undefined) return a.seq - b.seq;
    return 0;
  });

  if (runEvents.length === 0) return null;

  // Count prior workspace operations
  let workspaceOperationCount = 0;
  const listedDirectoryPaths = new Set();
  const stalledResponses = 0; // We don't track stalled across restarts
  const noProgressResponses = 0;
  const hasLegacyTerminal = runEvents.some(e => ['run.completed', 'run.failed', 'run.interrupted'].includes(e.type));
  const hasTerminal = runEvents.some(e => e.type === 'run.terminalized');
  const hasExecutionCompleted = runEvents.some(e => e.type === 'run.execution_completed') || hasLegacyTerminal;
  const hasSnapshotFinalized = runEvents.some(e => e.type === 'replay.snapshot.finalized' || e.type === 'run.snapshot_finalized');

  // Backward compat: treat legacy terminal events as also-terminalized
  // (old logs have run.completed/failed/interrupted as the final event)
  const isTerminal = hasTerminal || hasLegacyTerminal;

  // Check hash chain integrity (allow seq resets after server restart)
  let hashChainIntact = true;
  let segmentStart = 0;
  for (let i = 1; i < runEvents.length; i++) {
    const ev = runEvents[i];
    const prev = runEvents[i - 1];
    // New chain segment starts with prevHash=null (run.created or run.resumed)
    if (ev.prevHash !== undefined && ev.prevHash === null) {
      segmentStart = i;
      continue;
    }
    // Also detect seq reset (safety net for events missing prevHash)
    if (ev.seq !== undefined && prev.seq !== undefined && ev.seq < prev.seq) {
      segmentStart = i;
      continue;
    }
    if (i <= segmentStart) continue;
    if (ev.seq !== undefined && prev.seq !== undefined) {
      if (ev.seq !== prev.seq + 1) {
        hashChainIntact = false;
        break;
      }
    }
    if (ev.prevHash !== undefined) {
      const expected = computeEventHash(prev);
      if (ev.prevHash !== expected) {
        hashChainIntact = false;
        break;
      }
    }
  }

  // Check for duplicate mutating operations
  const mutatingOps = runEvents.filter(e => e.type === 'workspace.operation' && e.payload && AGENT_MUTATING_OPERATIONS.includes(e.payload.operation));
  const seenMutations = new Set();
  let hasDuplicateMutation = false;
  for (const m of mutatingOps) {
    const p = m.payload;
    const key = `${p.operation}:${p.path}`;
    if (seenMutations.has(key)) {
      hasDuplicateMutation = true;
      break;
    }
    seenMutations.add(key);
  }

  // Check authority chain for mutating ops
  const authEvents = runEvents.filter(e => e.type === 'authority.allowed' || e.type === 'authority.denied');
  let authorityIntact = true;
  for (const m of mutatingOps) {
    const p = m.payload;
    const hasAuth = authEvents.some(a => {
      const ap = a.payload || {};
      return ap.operation === p.operation && ap.path === p.path;
    });
    if (!hasAuth) {
      authorityIntact = false;
      break;
    }
  }

  // Determine expected next phase
  const lastEvent = runEvents[runEvents.length - 1];
  let expectedNextPhase = 'unknown';
  if (lastEvent) {
    if (lastEvent.type === 'run.terminalized') {
      expectedNextPhase = 'already_terminal';
    } else if (['run.completed', 'run.failed', 'run.interrupted'].includes(lastEvent.type)) {
      // Legacy terminal events — old logs used these as final event
      expectedNextPhase = 'already_terminal';
    } else if (lastEvent.type === 'run.execution_completed') {
      expectedNextPhase = 'snapshot_finalization';
    } else if (lastEvent.type === 'run.evaluation_completed') {
      expectedNextPhase = 'consequence';
    } else if (lastEvent.type === 'run.consequence_recorded') {
      expectedNextPhase = 'terminalization';
    } else if (lastEvent.type === 'run.violations_checked') {
      expectedNextPhase = 'evaluation';
    } else if (lastEvent.type === 'authority.allowed') {
      expectedNextPhase = 'workspace_operation';
    } else if (lastEvent.type === 'replay.snapshot.finalized' || lastEvent.type === 'run.snapshot_finalized') {
      expectedNextPhase = 'terminalization_or_evaluation';
    } else if (lastEvent.type === 'workspace.operation') {
      // Check for unmatched authority events after this workspace op
      const lastSeq = lastEvent.seq;
      const unmatchedAuth = authEvents.filter(a => {
        if (a.seq <= lastSeq) return false;
        const ap = a.payload || {};
        const aOp = ap.operation;
        const aPath = ap.path;
        return !mutatingOps.some(mo => {
          const mp = mo.payload;
          return mp.operation === aOp && mp.path === aPath && mo.seq > a.seq;
        });
      });
      expectedNextPhase = unmatchedAuth.length > 0 ? 'workspace_operation' : 'terminalization_or_evaluation';
    } else if (lastEvent.type === 'run.heartbeat') {
      // Check if there are authority events without matching workspace ops
      const unmatchedAuth = authEvents.filter(a => {
        const ap = a.payload || {};
        const aOp = ap.operation;
        const aPath = ap.path;
        return !mutatingOps.some(mo => {
          const mp = mo.payload;
          return mp.operation === aOp && mp.path === aPath;
        });
      });
      expectedNextPhase = unmatchedAuth.length > 0 ? 'workspace_operation' : 'model_request';
    } else {
      expectedNextPhase = 'model_request';
    }
  }

  // Rebuild listedDirectoryPaths from events
  for (const e of runEvents) {
    if (e.type === 'workspace.operation' && e.payload && e.payload.operation === 'listDirectory') {
      const listedPath = e.payload.result && typeof e.payload.result.path === 'string'
        ? e.payload.result.path
        : (e.payload.input && e.payload.input.path) || '';
      listedDirectoryPaths.add(listedPath);
    }
    if (e.type === 'workspace.operation' && e.payload && AGENT_MUTATING_OPERATIONS.includes(e.payload.operation)) {
      workspaceOperationCount += 1;
      listedDirectoryPaths.clear(); // Mutating action clears listed paths
    }
  }

  // Three mutually-exclusive resume dispositions.
  // safeToResumeExecution:  model loop can continue (running normally or resuming mid-execution)
  // safeToReconcileTerminalState: execution completed but not yet terminalized — needs reconciliation
  //   (triggered by run.execution_completed, or legacy run.completed/failed/interrupted)
  // unsafeToContinue:        integrity broken, cannot proceed at all
  const safeToResumeExecution =
    hashChainIntact &&
    !isTerminal &&
    !hasExecutionCompleted &&
    authorityIntact &&
    !hasDuplicateMutation;

  const safeToReconcileTerminalState =
    hashChainIntact &&
    hasExecutionCompleted &&
    !isTerminal &&
    !hasDuplicateMutation;

  const unsafeToContinue =
    !hashChainIntact ||
    hasDuplicateMutation;

  // Reconstruct current phase from events
  const currentPhase = reconstructRunPhase(run);

  return {
    priorEvents: runEvents.length,
    workspaceOperationCount,
    listedDirectoryPaths,
    stalledResponses,
    noProgressResponses,
    isTerminal,
    hasTerminal,
    hasLegacyTerminal,
    hasExecutionCompleted,
    hasSnapshotFinalized,
    hashChainIntact,
    authorityIntact,
    hasDuplicateMutation,
    safeToResumeExecution,
    safeToReconcileTerminalState,
    unsafeToContinue,
    expectedNextPhase,
    lastEvent,
    currentPhase
  };
}

const AGENT_PRIMITIVE_METADATA = {
  listDirectory: {
    responseShape: { path: 'string', entries: [{ name: 'string', type: 'file', size: 'number', modifiedAt: 'string' }] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; protected/sensitive paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; run log workspace:list'
  },
  readFile: {
    responseShape: { path: 'string', content: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; sensitive application paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; run log workspace:read'
  },
  createFolder: {
    responseShape: { path: 'string', status: 'created' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:create; recovery preview'
  },
  writeFile: {
    responseShape: { path: 'string', size: 'number' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; existing protected files blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:write; recovery preview'
  },
  renamePath: {
    responseShape: { path: 'string', status: 'renamed' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership on both source and dest; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:rename; recovery preview'
  },
  deletePath: {
    responseShape: { path: 'string', status: 'deleted' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent workspace scope; allocated ownership required; protected paths blocked',
    provenanceSurface: 'Run replay snapshot workspaceOperations; operation-history; run log workspace:delete; recovery preview'
  }
};
const GENERATED_AGENT_ACTIONS = AGENT_ALLOWED_OPERATIONS.map(op => ({
  name: op, category: 'workspace', type: 'workspaceAction', invoker: 'agent', mutating: AGENT_MUTATING_OPERATIONS.includes(op),
  requestShape: { operation: op, args: Object.fromEntries(AGENT_OPERATION_ARGS[op].map(k => [k, 'string'])) },
  inputSchema: Object.fromEntries(AGENT_OPERATION_ARGS[op].map(k => [k, 'string'])),
  optionalShape: null,
  ...AGENT_PRIMITIVE_METADATA[op]
}));
const ACTIONS_CATALOG = [
  ...GENERATED_AGENT_ACTIONS,
  {
    name: 'executeActionPlan', displayName: 'Execute Action Plan', category: 'workspace', type: 'workflowAction', invoker: 'workflow', mutating: true,
    requestShape: { actions: [], allowedOperations: ['string'], maxActions: 'number', maxMutations: 'number' },
    inputSchema: { actions: [{}], allowedOperations: ['string'], maxActions: 'number', maxMutations: 'number' },
    optionalShape: null,
    responseShape: { proposedActions: [{}], acceptedActions: [{}], rejectedActions: [{}], executedActions: [{}], status: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Workflow-only bounded dynamic workspace action plan; catalog actions only; existing authority checks apply',
    provenanceSurface: 'Run replay snapshot workflowActionPlans, workflowActions, workspaceOperations, operation-history, events'
  },
  {
    name: 'executeTicketPlan', displayName: 'Execute Ticket Plan', category: 'workflow', type: 'workflowAction', invoker: 'workflow', mutating: false,
    requestShape: { tickets: [{}], allowedWorkflowIds: ['string'], maxTickets: 'number' },
    inputSchema: { tickets: [{}], allowedWorkflowIds: ['string'], maxTickets: 'number' },
    optionalShape: null,
    responseShape: { proposedTickets: [{}], acceptedTickets: [{}], rejectedTickets: [{}], createdTicketIds: ['number'], status: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Workflow-only bounded child workflow ticket creation; child workflows only; no child execution in v1',
    provenanceSurface: 'Run replay snapshot workflowTicketPlans, workflowActions, ticket records, events'
  },
  {
    name: 'agentStructuredOutput', displayName: 'Agent Structured Output', category: 'agent', type: 'agentAction', invoker: 'workflow', mutating: false,
    requestShape: { instruction: 'string', input: {}, outputSchema: {} },
    optionalShape: { context: {}, temperature: 'number' },
    responseShape: { output: {}, text: 'string', usage: {}, provider: 'string', model: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Workflow runner model budget; agent-scoped provider/model config; no direct workspace mutation',
    provenanceSurface: 'Run replay snapshot workflowActions, providerRequests, and modelResponses'
  },
  {
    name: 'condition', displayName: 'Condition', category: 'condition', type: 'conditionAction', invoker: 'workflow', mutating: false,
    requestShape: { value: 'any', equals: 'any' },
    optionalShape: { exists: 'boolean' },
    responseShape: { matched: 'boolean', next: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Declarative comparison only; no user code, JavaScript, shell, network, or filesystem access',
    provenanceSurface: 'Run replay snapshot workflowActions'
  },
  {
    name: 'stop', displayName: 'Stop', category: 'stop', type: 'stopAction', invoker: 'workflow', mutating: false,
    requestShape: {},
    optionalShape: { result: {} },
    responseShape: { stopped: 'boolean', result: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Terminates the current workflow run; no side effects',
    provenanceSurface: 'Run replay snapshot workflowActions'
  },
  {
    name: 'invokeWorkflow', displayName: 'Invoke Workflow', category: 'workflow', type: 'workflowAction', invoker: 'agent', mutating: false,
    requestShape: { workflowId: 'string', input: {} },
    optionalShape: null,
    responseShape: { workflowId: 'string', status: 'string', result: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent may invoke one approved workflow with structured inputs; workflow internals execute through the bounded runtime',
    provenanceSurface: 'Run replay snapshot workflowInvocation and workflowActions'
  },
  {
    name: 'createWorkflowDraft', displayName: 'Create Workflow Draft', category: 'workflow', type: 'workflowAction', invoker: 'agent', mutating: false,
    requestShape: { workflow: {} },
    inputSchema: { workflow: {} },
    optionalShape: null,
    responseShape: { workflowId: 'string', enabled: 'boolean', status: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent may save disabled workflow drafts only; existing action contracts only; mutating workflows require postconditions',
    provenanceSurface: 'data/workflows.json disabled draft; workflow.draft_created event; run replay snapshot workflowDrafts'
  },
  {
    name: 'createWorkflowDraftIntent', displayName: 'Create Workflow Draft Intent', category: 'workflow', type: 'workflowAction', invoker: 'agent', mutating: false,
    requestShape: { id: 'string', name: 'string', writes: [{ path: 'string', content: 'string' }], postconditions: [{ type: 'string', path: 'string', contains: 'string' }] },
    inputSchema: { id: 'string', name: 'string', writes: [{ path: 'string', content: 'string' }], postconditions: [{}] },
    optionalShape: null,
    responseShape: { workflowId: 'string', enabled: 'boolean', status: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent may submit simple write workflow draft intent only; runtime deterministically compiles to disabled workflow draft and validates normally',
    provenanceSurface: 'Run replay snapshot workflowDraftIntents and workflowDrafts; workflow.draft_created event'
  },
  {
    name: 'createHandoffTask', displayName: 'Create Handoff Task', category: 'agent', type: 'agentAction', invoker: 'agent', mutating: true,
    requestShape: { executor: 'string', operation: 'writeFile', args: { path: 'string', content: 'string' } },
    inputSchema: { executor: 'string', operation: 'string', args: { path: 'string', content: 'string' } },
    optionalShape: null,
    responseShape: { executorAgentId: 'number', executorAgentName: 'string', operation: 'writeFile', path: 'string', status: 'executed' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Planner may create one validated writeFile handoff to one existing executor agent; runtime executes directly through workspace authority',
    provenanceSurface: 'Run replay snapshot handoffTasks, authorityChecks, workspaceOperations, operation-history, run.evaluation, run.consequence'
  },
  {
    name: 'providerModelCall', displayName: 'Provider/Model Call', category: 'provider', invoker: 'agent', mutating: false,
    requestShape: { model: 'string', input: [{ role: 'system', content: 'string' }], text: { format: { type: 'json_object' } } },
    optionalShape: null,
    responseShape: { text: 'string', usage: { promptTokens: 'number', completionTokens: 'number' }, provider: 'string', model: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Agent-scoped API key; OpenAI or Ollama provider; model constrained by agent config; no shell/network access outside LLM API',
    provenanceSurface: 'Run replay snapshot providerRequests and modelResponses; run log model:request'
  },
  {
    name: 'ticketShaping', displayName: 'Ticket Shaping', category: 'provider', invoker: 'operator', mutating: false,
    requestShape: { objective: 'string', assignmentTargetType: 'string', assignmentMode: 'string' },
    optionalShape: null,
    responseShape: { suggestedObjective: 'string', expectedOutputs: ['string'], decomposition: ['string'], warnings: ['string'], tooBroadForOneRun: 'boolean', groupModeFit: 'string', providerRequestId: 'string', usage: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:create permission; uses agent-scoped OpenAI call; no execution side effects',
    provenanceSurface: 'HTTP response; system log ticket:shaped; no replay snapshot (pre-execution)'
  },
  {
    name: 'retryRerun', displayName: 'Retry / Rerun', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only failed/interrupted runs; allocation constraints re-checked',
    provenanceSurface: 'System log ticket:rerun; run log run:interrupted; old run replay snapshot finalized as interrupted'
  },
  {
    name: 'stopInterruption', displayName: 'Stop / Interruption', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { run: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only pending or running runs; triggers replay snapshot finalization',
    provenanceSurface: 'Run replay snapshot finalized as interrupted; run log run:interrupted; system log'
  },
  {
    name: 'operatorWorkspaceCreateFile', displayName: 'Operator: Create File', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceCreateFolder', displayName: 'Operator: Create Folder', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'created' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceWriteFile', displayName: 'Operator: Write File', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string', content: 'string' }, optionalShape: null,
    responseShape: { path: 'string', size: 'number' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceRenamePath', displayName: 'Operator: Rename', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string', nextPath: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'renamed' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'operatorWorkspaceDeletePath', displayName: 'Operator: Delete', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { path: 'string' }, optionalShape: null,
    responseShape: { path: 'string', status: 'deleted' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:write permission; bypasses agent scope checks; allows hidden paths',
    provenanceSurface: 'System log workspace:operator_mutation with pre/post state capture'
  },
  {
    name: 'workspaceFixtureReset', displayName: 'Workspace Fixture Reset', category: 'workspace', invoker: 'operator', mutating: true,
    requestShape: { fixtureId: 'string' }, optionalShape: null,
    responseShape: { path: 'string', entries: [] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires workspace:reset permission; destructive; clears entire workspace root and applies fixture',
    provenanceSurface: 'System log workspace:fixture with pre/post workspace listing'
  },
  {
    name: 'recovery', displayName: 'Recovery', category: 'workspace', invoker: 'operator', mutating: true,
    requestShape: { confirmed: true }, optionalShape: null,
    responseShape: { recovery: { id: 'number', originalId: 'number', operation: 'string', args: {}, preState: {}, restoredState: {} } },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only recovers failed/interrupted operations; undoes previous mutation',
    provenanceSurface: 'Operation-history record with original and recovery pair; system log workspace:recovery'
  },
  {
    name: 'ticketAssignment', displayName: 'Ticket Assignment', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { agentId: 'number' }, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; only open tickets; creates pending runs for the runtime scheduler',
    provenanceSurface: 'Ticket record updated (assignmentTargetType, assignmentTargetId); broadcastTicketChange; system log'
  },
  {
    name: 'ticketStatusUpdate', displayName: 'Ticket Status Update', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { status: 'string' }, optionalShape: null,
    responseShape: { ticket: {} },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires ticket:update permission; creates pending runs for the runtime scheduler',
    provenanceSurface: 'Ticket record updated; broadcastTicketChange; system log'
  },
  {
    name: 'adminCreateAccount', displayName: 'Admin: Create User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string', username: 'string', password: 'string', agentName: 'string', model: 'string', apiKey: 'string' },
    optionalShape: { provider: 'string', groupIds: 'string' },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:create permission; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json); system log (user:created / agent:created)'
  },
  {
    name: 'adminUpdateAccount', displayName: 'Admin: Update User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string' },
    optionalShape: { username: 'string', password: 'string', agentName: 'string', provider: 'string', model: 'string', apiKey: 'string', groupIds: 'string' },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:update permission; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json / memberships.json); system log'
  },
  {
    name: 'adminDeleteAccount', displayName: 'Admin: Delete User/Agent', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { accountType: 'string' }, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:delete permission; cannot delete self if user type; admin only',
    provenanceSurface: 'Data file updated (users.json / agents.json); memberships cleaned up; system log'
  },
  {
    name: 'adminCreateGroup', displayName: 'Admin: Create Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: { name: 'string' },
    optionalShape: { canReceiveTickets: 'boolean', permissions: ['string'] },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:create permission; admin only',
    provenanceSurface: 'Data file updated (groups.json); system log'
  },
  {
    name: 'adminUpdateGroup', displayName: 'Admin: Update Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: {},
    optionalShape: { name: 'string', canReceiveTickets: 'boolean', permissions: ['string'] },
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:update permission; admin only',
    provenanceSurface: 'Data file updated (groups.json); system log'
  },
  {
    name: 'adminDeleteGroup', displayName: 'Admin: Delete Group', category: 'operator', invoker: 'operator', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires group:delete permission; group id 1 (Administrators) protected; admin only',
    provenanceSurface: 'Data file updated (groups.json); memberships cleaned up; system log'
  },
  {
    name: 'debugReset', displayName: 'Debug Reset', category: 'system', type: 'systemAction', invoker: 'operator', mutating: true,
    requestShape: { confirmation: 'RESET DEBUG DATA' }, optionalShape: null,
    responseShape: { redirect: 'string' },
    errorShape: { error: 'string' },
    authorityConstraints: 'Requires user:update permission; disabled in NODE_ENV=production; destroys all ticket/run/log/history/workspace data',
    provenanceSurface: 'System log system:reset; all volatile data files emptied; workspace cleared'
  },
  {
    name: 'systemInterruptStaleRuns', displayName: 'System: Interrupt Stale Runs', category: 'system', type: 'systemAction', invoker: 'system', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { status: 'interrupted', runs: ['number'] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Automatic on server start; only affects pending/running runs; invokes interruptAgentRun per stale run',
    provenanceSurface: 'Run replay snapshots finalized as interrupted; run logs run:interrupted'
  },
  {
    name: 'systemAutoStartRuns', displayName: 'System: Auto-Start Ticket Runs', category: 'system', type: 'systemAction', invoker: 'system', mutating: true,
    requestShape: null, optionalShape: null,
    responseShape: { runs: [{}] },
    errorShape: { error: 'string' },
    authorityConstraints: 'Triggered by ticket creation, assignment, or status change to open; respects agent group canReceiveTickets; enforces allocation constraints',
    provenanceSurface: 'Run record created; runs.json updated; replay snapshot initialized; run log run:started'
  }
];

function inferActionType(action) {
  if (action.type) return action.type;
  if (action.category === 'workspace' && action.invoker === 'agent') return 'workspaceAction';
  if (action.category === 'provider' && action.invoker === 'agent') return 'agentAction';
  if (action.category === 'system') return 'systemAction';
  return 'systemAction';
}

function normalizeActionContract(action) {
  const type = inferActionType(action);
  if (!ACTION_TYPES.includes(type)) {
    throw new Error(`Unknown action type for ${action.name}: ${type}`);
  }

  action.type = type;
  action.inputSchema = action.inputSchema || action.requestShape || {};
  action.outputSchema = action.outputSchema || action.responseShape || {};
  action.errorSchema = action.errorSchema || action.errorShape || { error: 'string' };
  action.authority = action.authority || { summary: action.authorityConstraints || 'Runtime authority checks apply' };
  action.provenance = action.provenance || { surface: action.provenanceSurface || 'Runtime replay/log surfaces apply' };
  action.executable = action.executable !== false;
  return action;
}

ACTIONS_CATALOG.forEach(normalizeActionContract);
const ACTION_CONTRACTS_BY_NAME = new Map(ACTIONS_CATALOG.map(action => [action.name, action]));

function isWorkflowUsableAction(action) {
  if (!action || action.executable === false) return false;
  if (typeof action.name !== 'string' || !action.name.trim()) return false;
  if (!action.inputSchema || typeof action.inputSchema !== 'object' || Array.isArray(action.inputSchema)) return false;
  if (!action.errorSchema || typeof action.errorSchema !== 'object' || Array.isArray(action.errorSchema)) return false;
  if (!action.outputSchema || typeof action.outputSchema !== 'object' || Array.isArray(action.outputSchema)) return false;

  return action.type === 'workspaceAction' ||
    action.name === 'executeActionPlan' ||
    action.name === 'executeTicketPlan' ||
    action.name === 'agentStructuredOutput' ||
    action.name === 'condition' ||
    action.name === 'stop';
}

const ticketEventClients = new Set();
const logEventClients = new Set();
const runningRunKeys = new Set();
const startingRunIds = new Set();
const startingLocalModelRunIds = new Set();
const RUN_LEASE_OWNER = `${process.pid}:${crypto.randomUUID()}`;
const DEFAULT_RUN_LEASE_DURATION_MS = 180000;
let lastLogTimestampNs = 0n;
let serverReady = false;
let dataDirWriterLock = null;
let dataDirWriterLockHeartbeatTimer = null;
let dataVersion = 0;
const pageRenderCache = new Map();
const pageRenderInFlight = new Map();
const PAGE_RENDER_CACHE_TTL_MS = 10000;
const PAGE_RENDER_CACHE_MAX_ENTRIES = 100;

// Register Fastify plugins
fastify.register(require('@fastify/cookie'));
fastify.register(require('@fastify/session'), {
  secret: SESSION_SECRET,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
});
fastify.register(require('@fastify/formbody'));

fastify.get('/styles.css', async (request, reply) => {
  reply.type('text/css; charset=utf-8');
  return fs.readFileSync(path.join(__dirname, 'src', 'styles.css'), 'utf8');
});

fastify.get('/health', async (request, reply) => {
  if (!serverReady) {
    reply.code(503);
    return { status: 'starting', ready: false };
  }
  return { status: 'ok', ready: true };
});

fastify.register(require('@fastify/view'), {
  engine: { ejs: require('ejs') },
  root: path.join(__dirname, 'views'),
  layout: 'layout.ejs'
});

fastify.addHook('onRequest', async request => {
  request.routeStartedAtNs = process.hrtime.bigint();
});

fastify.addHook('onSend', async (request, reply, payload) => {
  if (request.routeStartedAtNs) {
    const elapsedMs = Number(process.hrtime.bigint() - request.routeStartedAtNs) / 1e6;
    reply.header('X-Route-Time-Ms', elapsedMs.toFixed(1));
    reply.header('X-Heap-Used-Mb', (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1));
  }

  return payload;
});

// ==================== DATA HELPERS ====================

const jsonReadCache = new Map();

function nextId(items) {
  return items.length > 0 ? Math.max(...items.map(item => item.id)) + 1 : 1;
}

function readJsonArrayCached(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = jsonReadCache.get(filePath);
    const mtimeNs = stat.mtimeNs !== undefined ? stat.mtimeNs.toString() : String(stat.mtimeMs);

    if (cached && cached.size === stat.size && cached.mtimeNs === mtimeNs) {
      return cached.value;
    }

    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const arrayValue = Array.isArray(value) ? value : [];
    jsonReadCache.set(filePath, { size: stat.size, mtimeNs, value: arrayValue });
    return arrayValue;
  } catch (error) {
    jsonReadCache.delete(filePath);
    return [];
  }
}

function readTickets() {
  return normalizeTickets(readJsonArrayCached(DATA_FILE));
}

function createDemoWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'demo-agent-write-if-approved',
    name: 'Demo: agent output gated write',
    description: 'Asks the selected agent for structured content, gates it with a condition, writes a file, then stops.',
    enabled: true,
    inputSchema: {
      instruction: 'string',
      path: 'string'
    },
    actions: [
      {
        id: 'draft',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.input.instruction}}',
          input: {
            path: '{{workflow.input.path}}'
          },
          outputSchema: {
            shouldWrite: 'boolean',
            content: 'string'
          }
        },
        saveAs: 'draft',
        next: 'should_write'
      },
      {
        id: 'should_write',
        action: 'condition',
        input: {
          value: '{{draft.shouldWrite}}',
          equals: true
        },
        trueNext: 'write_note',
        falseNext: 'stop_without_write'
      },
      {
        id: 'write_note',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.path}}',
          content: '{{draft.content}}'
        },
        next: 'stop_after_write'
      },
      {
        id: 'stop_without_write',
        action: 'stop',
        input: {
          result: {
            written: false,
            reason: 'condition did not match'
          }
        }
      },
      {
        id: 'stop_after_write',
        action: 'stop',
        input: {
          result: {
            written: true,
            path: '{{workflow.input.path}}'
          }
        }
      }
    ],
    createdAt: now,
    updatedAt: now
  };
}

const LEGAL_INTAKE_WORKFLOW_POLICY_TEXT = [
  'Decision rules:',
  '- Open Matter: all required fields are present and the description is specific enough to act on.',
  '- Request Information: missing Contact Email, missing Jurisdiction, missing Description, or Description is too vague to identify the requested legal work.',
  '- Decline: missing Requesting Party, missing Matter Type, or matter is outside company legal scope such as personal legal advice.',
  '- Duplicate: only later submissions in the same Duplicate Group should be Duplicate. The earliest intake in a Duplicate Group remains Open Matter unless another rule applies.',
  '',
  'Required source fields: Matter Type, Requesting Party, Contact Email, Jurisdiction, Business Unit, Description, Urgency.',
  'Use only these dispositions exactly: Open Matter, Request Information, Decline, Duplicate.',
  'The phrase "Help with contract" is too vague and requires Request Information.'
].join('\n');

function createLegalIntakeWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'legal-intake',
    name: 'Example: Legal Intake',
    version: '1',
    description: 'Classifies fixture legal intake files with an attached workflow policy and writes register artifacts.',
    enabled: true,
    policy: {
      id: 'legal-intake-decision-policy',
      version: '1',
      text: LEGAL_INTAKE_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Classify every provided legal intake using workflow.policy.text.',
      'Return a complete CSV and Markdown summary only after considering every intake input.',
      'CSV columns must be exactly: intake_id,matter_type,requesting_party,disposition,reason,next_action'
    ].join('\n'),
    verifierContract: {
      id: 'legal-intake-verifier',
      version: '1',
      fixture: 'legal-intake',
      expectedArtifacts: [
        'legal-intake/intake-register.csv',
        'legal-intake/matter-summary.md'
      ]
    },
    inputSchema: {
      basePath: 'string'
    },
    actions: [
      {
        id: 'read_001',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-001.md' },
        saveAs: 'intake001',
        next: 'read_002'
      },
      {
        id: 'read_002',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-002.md' },
        saveAs: 'intake002',
        next: 'read_003'
      },
      {
        id: 'read_003',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-003.md' },
        saveAs: 'intake003',
        next: 'read_004'
      },
      {
        id: 'read_004',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-004.md' },
        saveAs: 'intake004',
        next: 'read_005'
      },
      {
        id: 'read_005',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-005.md' },
        saveAs: 'intake005',
        next: 'read_006'
      },
      {
        id: 'read_006',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-006.md' },
        saveAs: 'intake006',
        next: 'read_007'
      },
      {
        id: 'read_007',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-007.md' },
        saveAs: 'intake007',
        next: 'read_008'
      },
      {
        id: 'read_008',
        action: 'readFile',
        input: { path: '{{workflow.input.basePath}}/incoming/intake-2026-008.md' },
        saveAs: 'intake008',
        next: 'classify'
      },
      {
        id: 'classify',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            intakes: {
              'intake-2026-001': '{{intake001.content}}',
              'intake-2026-002': '{{intake002.content}}',
              'intake-2026-003': '{{intake003.content}}',
              'intake-2026-004': '{{intake004.content}}',
              'intake-2026-005': '{{intake005.content}}',
              'intake-2026-006': '{{intake006.content}}',
              'intake-2026-007': '{{intake007.content}}',
              'intake-2026-008': '{{intake008.content}}'
            }
          },
          outputSchema: {
            intakeRegisterCsv: 'string',
            matterSummaryMd: 'string'
          }
        },
        saveAs: 'classification',
        next: 'write_register'
      },
      {
        id: 'write_register',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/intake-register.csv',
          content: '{{classification.intakeRegisterCsv}}'
        },
        next: 'write_summary'
      },
      {
        id: 'write_summary',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/matter-summary.md',
          content: '{{classification.matterSummaryMd}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            intakeRegisterPath: '{{workflow.input.basePath}}/intake-register.csv',
            matterSummaryPath: '{{workflow.input.basePath}}/matter-summary.md'
          }
        }
      }
    ],
    postconditions: [
      { id: 'register-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/intake-register.csv' },
      { id: 'summary-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/matter-summary.md' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


const CUSTOMER_SUPPORT_TRIAGE_WORKFLOW_POLICY_TEXT = [
  'Decision rules:',
  '- P1: production outage, service-down report, or possible security incident. Escalate immediately.',
  '- P2: customer-impacting bug, enterprise-customer ambiguous issue, or degraded business-critical workflow.',
  '- P3: feature request, how-to question, partial bug, or low-impact bug with workaround available and no incident/security/outage signals.',
  '- P4: internal-only or non-customer work without customer impact.',
  '- Assign outage P1 tickets to On-Call with SLA 15 minutes and next_action token page_on_call.',
  '- Assign possible security issues to Security with priority P1, escalation Yes, SLA 15 minutes, and next_action token security_escalation.',
  '- Assign enterprise ambiguous degraded production or business-critical issues to Engineering with priority P2, escalation Yes, SLA 1 hour, and next_action token engineering_triage_enterprise.',
  '- Enterprise sandbox or demo issues with production unaffected may be Engineering P2 with either escalation Yes/1 hour/engineering_triage_enterprise or escalation No/4 business hours/bug_triage depending on stated urgency.',
  '- Assign customer-impacting actionable bugs to Engineering with priority P2, escalation No, SLA 4 business hours, and next_action token bug_triage.',
  '- Bugs with workaround available, narrow archived-project scope, missing reproduction details, or contradictory low-impact metadata may be P3 and may route to Customer Success with next_action token request_reproduction_details.',
  '- If ticket metadata conflicts, prefer concrete impact and escalation signals over customer tier alone.',
  '- For duplicate groups, the earliest ticket remains the primary ticket. Later reports in the same Duplicate Group must set duplicate_of to the earliest ticket ID. Duplicate_of primary ID is mandatory even when another rule also applies.',
  '- If a duplicate ticket is also an incident, keep priority/escalation/SLA from the incident rule; next_action may use the incident action or duplicate-link action when both are defensible.',
  '- Use next_action token link_duplicate_to_sup_2026_003 for csv-export-february and link_duplicate_to_primary for other duplicate chains when choosing the duplicate-link action.',
  '- Assign billing/account issues to Customer Success with priority P3, escalation No, SLA 1 business day, and next_action token billing_account_followup.',
  '- Assign feature requests to Product with priority P3, escalation No, SLA 2 business days, and next_action token product_feedback.',
  '- Assign how-to questions to Customer Success with priority P3, escalation No, SLA 1 business day, and next_action token send_how_to_guidance unless the ticket specifically asks about service account API key rotation, then use send_key_rotation_steps.',
  '- Assign partial bug reports with missing reproduction details to Customer Success with priority P3, escalation No, SLA 1 business day, and next_action token request_reproduction_details.',
  '- Assign noisy or unknown-customer tickets to Internal Triage with priority P4, escalation No, SLA Backlog, and next_action token request_customer_context.',
  '- Assign internal-only/non-customer tickets to Internal Triage with priority P4, escalation No, SLA Backlog, and next_action token route_internal_backlog.',
  '',
  'The triage plan must be a Markdown table with exactly these columns: ticket_id, customer_name, priority, assignee_team, escalation, sla, next_action, duplicate_of.',
  'Use escalation values exactly: Yes or No.',
  'The escalation list must be a Markdown table with exactly these columns: ticket_id, customer_name, priority, reason, owner.',
  'The escalation list must include only tickets whose triage row has escalation Yes.',
  'Do not invent ticket IDs, customers, priorities, teams, facts, or source evidence.'
].join('\n');

function createCustomerSupportTriageWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'customer-support-triage',
    name: 'Example: Customer Support Triage',
    version: '1',
    description: 'Classifies customer support tickets with attached workflow policy and writes triage artifacts.',
    enabled: true,
    policy: {
      id: 'customer-support-triage-policy',
      version: '1',
      text: CUSTOMER_SUPPORT_TRIAGE_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Read every provided support ticket using workflow.policy.text.',
      'Return complete Markdown artifacts only after considering every support ticket.',
      'The triage plan table columns must be exactly: ticket_id, customer_name, priority, assignee_team, escalation, sla, next_action, duplicate_of.',
      'The escalation list table columns must be exactly: ticket_id, customer_name, priority, reason, owner.'
    ].join('\n'),
    verifierContract: {
      id: 'customer-support-triage-verifier',
      version: '1',
      fixture: 'customer-support',
      expectedArtifacts: [
        'support-queue/triage-plan.md',
        'support-queue/escalation-list.md'
      ]
    },
    inputSchema: {
      sourcePath: 'string',
      outputPath: 'string'
    },
    actions: [
      { id: 'read_001', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-001.md' }, saveAs: 'ticket001', next: 'read_002' },
      { id: 'read_002', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-002.md' }, saveAs: 'ticket002', next: 'read_003' },
      { id: 'read_003', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-003.md' }, saveAs: 'ticket003', next: 'read_004' },
      { id: 'read_004', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-004.md' }, saveAs: 'ticket004', next: 'read_005' },
      { id: 'read_005', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-005.md' }, saveAs: 'ticket005', next: 'read_006' },
      { id: 'read_006', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-006.md' }, saveAs: 'ticket006', next: 'read_007' },
      { id: 'read_007', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-007.md' }, saveAs: 'ticket007', next: 'read_008' },
      { id: 'read_008', action: 'readFile', input: { path: '{{workflow.input.sourcePath}}/ticket-008.md' }, saveAs: 'ticket008', next: 'triage' },
      {
        id: 'triage',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            tickets: {
              'SUP-2026-001': '{{ticket001.content}}',
              'SUP-2026-002': '{{ticket002.content}}',
              'SUP-2026-003': '{{ticket003.content}}',
              'SUP-2026-004': '{{ticket004.content}}',
              'SUP-2026-005': '{{ticket005.content}}',
              'SUP-2026-006': '{{ticket006.content}}',
              'SUP-2026-007': '{{ticket007.content}}',
              'SUP-2026-008': '{{ticket008.content}}'
            }
          },
          outputSchema: {
            triagePlanMd: 'string',
            escalationListMd: 'string'
          }
        },
        saveAs: 'triage',
        next: 'write_triage_plan'
      },
      {
        id: 'write_triage_plan',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.outputPath}}/triage-plan.md',
          content: '{{triage.triagePlanMd}}'
        },
        next: 'write_escalation_list'
      },
      {
        id: 'write_escalation_list',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.outputPath}}/escalation-list.md',
          content: '{{triage.escalationListMd}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            triagePlanPath: '{{workflow.input.outputPath}}/triage-plan.md',
            escalationListPath: '{{workflow.input.outputPath}}/escalation-list.md'
          }
        }
      }
    ],
    postconditions: [
      { id: 'triage-plan-exists', type: 'fileExists', path: '{{workflow.input.outputPath}}/triage-plan.md' },
      { id: 'escalation-list-exists', type: 'fileExists', path: '{{workflow.input.outputPath}}/escalation-list.md' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


function buildSupportTicketPlanChunks() {
  const semanticBundles = [
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [11, 12, 13, 14, 15, 16, 17, 19, 20, 21],
    [18, 22, 23, 24, 25, 26, 27, 28, 29, 30],
    [31, 32, 33, 34, 35, 36, 37, 38, 39, 40],
    [41, 42, 43, 44, 45, 46, 47, 48, 49, 50]
  ];
  return semanticBundles.map((ticketIndexes, chunkIndex) => {
    const chunkNumber = String(chunkIndex + 1).padStart(3, '0');
    const workflowInput = {
      sourcePath: 'support-inbox',
      outputPath: 'support-queue/chunks/triage-' + chunkNumber + '.csv',
      chunkId: 'chunk-' + chunkNumber,
      vendorId: 'support-chunk-' + chunkNumber
    };
    ticketIndexes.forEach((index, offset) => {
      const slot = String(offset + 1).padStart(2, '0');
      const padded = String(index).padStart(3, '0');
      workflowInput['path' + slot] = 'support-inbox/ticket-' + padded + '.md';
      workflowInput['id' + slot] = 'SUP-2026-' + padded;
    });
    return {
      workflowId: 'customer-support-triage-chunk',
      objective: 'Customer Support Triage Chunk ' + chunkNumber,
      workflowInput,
      reason: 'Triage semantic support bundle ' + chunkNumber + ' preserving duplicate and incident groups'
    };
  });
}

function createCustomerSupportTicketPlanWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'customer-support-triage-ticket-plan',
    name: 'Example: Customer Support Triage Ticket Plan',
    version: '1',
    description: 'Creates bounded child support triage workflow tickets for a 50-ticket queue.',
    enabled: true,
    policy: {
      id: 'customer-support-triage-ticket-plan-policy',
      version: '1',
      text: 'Create one child support triage ticket per bounded 10-ticket chunk. Do not auto-run children.'
    },
    verifierContract: {
      id: 'customer-support-triage-ticket-plan-verifier',
      version: '1',
      fixture: 'customer-support',
      expectedArtifacts: []
    },
    inputSchema: {},
    actions: [
      {
        id: 'create_child_chunks',
        action: 'executeTicketPlan',
        input: {
          tickets: buildSupportTicketPlanChunks(),
          allowedWorkflowIds: ['customer-support-triage-chunk'],
          maxTickets: 5
        },
        saveAs: 'ticketPlan',
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            childTicketIds: '{{ticketPlan.createdTicketIds}}'
          }
        }
      }
    ],
    postconditions: [],
    createdAt: now,
    updatedAt: now
  };
}

function createCustomerSupportChunkWorkflowDefinition(now = new Date().toISOString()) {
  const readActions = [];
  for (let offset = 1; offset <= 10; offset += 1) {
    const slot = String(offset).padStart(2, '0');
    readActions.push({
      id: 'read_' + slot,
      action: 'readFile',
      input: { path: '{{workflow.input.path' + slot + '}}' },
      saveAs: 'ticket' + slot,
      next: offset === 10 ? 'triage_chunk' : 'read_' + String(offset + 1).padStart(2, '0')
    });
  }
  return {
    id: 'customer-support-triage-chunk',
    name: 'Example: Customer Support Triage Chunk',
    version: '1',
    description: 'Classifies one bounded 10-ticket customer support chunk.',
    enabled: true,
    policy: {
      id: 'customer-support-triage-policy',
      version: '1',
      text: CUSTOMER_SUPPORT_TRIAGE_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Classify exactly the 10 provided support tickets using workflow.policy.text.',
      'Return CSV only, no Markdown fence.',
      'CSV columns exactly: ticket_id,customer_name,priority,assignee_team,escalation,sla,next_action,duplicate_of',
      'Include one row for every provided ticket ID.'
    ].join('\n'),
    verifierContract: {
      id: 'customer-support-triage-chunk-verifier',
      version: '1',
      fixture: 'customer-support',
      expectedArtifacts: ['support-queue/chunks/*.csv']
    },
    inputSchema: {
      sourcePath: 'string',
      outputPath: 'string',
      chunkId: 'string',
      vendorId: 'string',
      path01: 'string', id01: 'string',
      path02: 'string', id02: 'string',
      path03: 'string', id03: 'string',
      path04: 'string', id04: 'string',
      path05: 'string', id05: 'string',
      path06: 'string', id06: 'string',
      path07: 'string', id07: 'string',
      path08: 'string', id08: 'string',
      path09: 'string', id09: 'string',
      path10: 'string', id10: 'string'
    },
    actions: [
      ...readActions,
      {
        id: 'triage_chunk',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            chunkId: '{{workflow.input.chunkId}}',
            tickets: {
              '{{workflow.input.id01}}': '{{ticket01.content}}',
              '{{workflow.input.id02}}': '{{ticket02.content}}',
              '{{workflow.input.id03}}': '{{ticket03.content}}',
              '{{workflow.input.id04}}': '{{ticket04.content}}',
              '{{workflow.input.id05}}': '{{ticket05.content}}',
              '{{workflow.input.id06}}': '{{ticket06.content}}',
              '{{workflow.input.id07}}': '{{ticket07.content}}',
              '{{workflow.input.id08}}': '{{ticket08.content}}',
              '{{workflow.input.id09}}': '{{ticket09.content}}',
              '{{workflow.input.id10}}': '{{ticket10.content}}'
            }
          },
          outputSchema: {
            chunkCsv: 'string'
          }
        },
        saveAs: 'classification',
        next: 'write_chunk'
      },
      {
        id: 'write_chunk',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.outputPath}}',
          content: '{{classification.chunkCsv}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            chunkPath: '{{workflow.input.outputPath}}'
          }
        }
      }
    ],
    postconditions: [
      { id: 'chunk-exists', type: 'fileExists', path: '{{workflow.input.outputPath}}' }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function createCustomerSupportAggregateWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'customer-support-triage-aggregate',
    name: 'Example: Customer Support Triage Aggregate',
    version: '1',
    description: 'Aggregates support triage chunk artifacts into final queue artifacts.',
    enabled: true,
    policy: {
      id: 'customer-support-triage-aggregate-policy',
      version: '1',
      text: [
        'Combine the five chunk CSV artifacts into final Customer Support triage artifacts.',
        'Do not change ticket IDs, customer names, priorities, teams, escalation values, SLA values, next_action values, or duplicate_of values from the chunk CSV rows.',
        'The triage plan must be a Markdown table with exactly these columns: ticket_id, customer_name, priority, assignee_team, escalation, sla, next_action, duplicate_of.',
        'The escalation list must be a Markdown table with exactly these columns: ticket_id, customer_name, priority, reason, owner.',
        'The escalation list must include only rows where escalation is Yes.'
      ].join('\n')
    },
    taskPromptTemplate: [
      'Read all five chunk CSV artifacts and aggregate them into final support queue artifacts.',
      'Preserve every row from every chunk exactly except Markdown table formatting.',
      'Return only the two artifact contents.'
    ].join('\n'),
    verifierContract: {
      id: 'customer-support-triage-aggregate-verifier',
      version: '1',
      fixture: 'customer-support',
      expectedArtifacts: [
        'support-queue/triage-plan.md',
        'support-queue/escalation-list.md'
      ]
    },
    inputSchema: {
      outputPath: 'string',
      chunkPath01: 'string',
      chunkPath02: 'string',
      chunkPath03: 'string',
      chunkPath04: 'string',
      chunkPath05: 'string'
    },
    actions: [
      { id: 'read_chunk_01', action: 'readFile', input: { path: '{{workflow.input.chunkPath01}}' }, saveAs: 'chunk01', next: 'read_chunk_02' },
      { id: 'read_chunk_02', action: 'readFile', input: { path: '{{workflow.input.chunkPath02}}' }, saveAs: 'chunk02', next: 'read_chunk_03' },
      { id: 'read_chunk_03', action: 'readFile', input: { path: '{{workflow.input.chunkPath03}}' }, saveAs: 'chunk03', next: 'read_chunk_04' },
      { id: 'read_chunk_04', action: 'readFile', input: { path: '{{workflow.input.chunkPath04}}' }, saveAs: 'chunk04', next: 'read_chunk_05' },
      { id: 'read_chunk_05', action: 'readFile', input: { path: '{{workflow.input.chunkPath05}}' }, saveAs: 'chunk05', next: 'aggregate' },
      {
        id: 'aggregate',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            chunks: {
              chunk01: '{{chunk01.content}}',
              chunk02: '{{chunk02.content}}',
              chunk03: '{{chunk03.content}}',
              chunk04: '{{chunk04.content}}',
              chunk05: '{{chunk05.content}}'
            }
          },
          outputSchema: {
            triagePlanMd: 'string',
            escalationListMd: 'string'
          }
        },
        saveAs: 'aggregateOutput',
        next: 'write_triage_plan'
      },
      {
        id: 'write_triage_plan',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.outputPath}}/triage-plan.md',
          content: '{{aggregateOutput.triagePlanMd}}'
        },
        next: 'write_escalation_list'
      },
      {
        id: 'write_escalation_list',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.outputPath}}/escalation-list.md',
          content: '{{aggregateOutput.escalationListMd}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            triagePlanPath: '{{workflow.input.outputPath}}/triage-plan.md',
            escalationListPath: '{{workflow.input.outputPath}}/escalation-list.md'
          }
        }
      }
    ],
    postconditions: [
      { id: 'triage-plan-exists', type: 'fileExists', path: '{{workflow.input.outputPath}}/triage-plan.md' },
      { id: 'escalation-list-exists', type: 'fileExists', path: '{{workflow.input.outputPath}}/escalation-list.md' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


const VENDOR_COMPLIANCE_WORKFLOW_POLICY_TEXT = [
  'Decision rules:',
  '- Approve: DPA is signed/current, Security Certification is provided, Certification Status is Current, and there is no active security incident.',
  '- Conditional Approve: Certification Status is Expired but DPA is signed/current; require recertification within 90 days.',
  '- Conditional Approve: active security incident is under review but required documents are present; require monitoring condition.',
  '- Reject: Security Certification is missing/not provided or Certification Status is Missing.',
  '- Reject: Data Processing Agreement is missing.',
  '',
  'Resolved incidents do not require conditional approval when DPA is signed/current and Certification Status is Current.',
  'Use only these dispositions exactly: Approve, Conditional Approve, Reject.',
  'Each row must cite packet evidence and a policy reference.'
].join('\n');

function createVendorComplianceWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'vendor-compliance',
    name: 'Example: Vendor Compliance',
    version: '1',
    description: 'Classifies vendor compliance packets with attached workflow policy and writes audit artifacts.',
    enabled: true,
    policy: {
      id: 'vendor-compliance-decision-policy',
      version: '1',
      text: VENDOR_COMPLIANCE_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Classify every provided vendor compliance packet using workflow.policy.text.',
      'Return a complete CSV and Markdown audit summary only after considering every vendor packet.',
      'CSV columns must be exactly: vendor_id,vendor_name,disposition,reason,policy_reference,next_action'
    ].join('\n'),
    verifierContract: {
      id: 'vendor-compliance-verifier',
      version: '1',
      fixture: 'vendor-compliance',
      expectedArtifacts: [
        'vendors/vendor-decision-register.csv',
        'vendors/compliance-review.md'
      ]
    },
    inputSchema: {
      basePath: 'string'
    },
    actions: [
      { id: 'read_001', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-001.md' }, saveAs: 'vendor001', next: 'read_002' },
      { id: 'read_002', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-002.md' }, saveAs: 'vendor002', next: 'read_003' },
      { id: 'read_003', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-003.md' }, saveAs: 'vendor003', next: 'read_004' },
      { id: 'read_004', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-004.md' }, saveAs: 'vendor004', next: 'read_005' },
      { id: 'read_005', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-005.md' }, saveAs: 'vendor005', next: 'read_006' },
      { id: 'read_006', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-006.md' }, saveAs: 'vendor006', next: 'read_007' },
      { id: 'read_007', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-007.md' }, saveAs: 'vendor007', next: 'read_008' },
      { id: 'read_008', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-008.md' }, saveAs: 'vendor008', next: 'classify' },
      {
        id: 'classify',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            vendors: {
              'vendor-001': '{{vendor001.content}}',
              'vendor-002': '{{vendor002.content}}',
              'vendor-003': '{{vendor003.content}}',
              'vendor-004': '{{vendor004.content}}',
              'vendor-005': '{{vendor005.content}}',
              'vendor-006': '{{vendor006.content}}',
              'vendor-007': '{{vendor007.content}}',
              'vendor-008': '{{vendor008.content}}'
            }
          },
          outputSchema: {
            vendorDecisionRegisterCsv: 'string',
            complianceReviewMd: 'string'
          }
        },
        saveAs: 'classification',
        next: 'write_register'
      },
      {
        id: 'write_register',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/vendor-decision-register.csv',
          content: '{{classification.vendorDecisionRegisterCsv}}'
        },
        next: 'write_review'
      },
      {
        id: 'write_review',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/compliance-review.md',
          content: '{{classification.complianceReviewMd}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            vendorDecisionRegisterPath: '{{workflow.input.basePath}}/vendor-decision-register.csv',
            complianceReviewPath: '{{workflow.input.basePath}}/compliance-review.md'
          }
        }
      }
    ],
    postconditions: [
      { id: 'register-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/vendor-decision-register.csv' },
      { id: 'review-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/compliance-review.md' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


const VENDOR_REMEDIATION_WORKFLOW_POLICY_TEXT = [
  'Remediation rules:',
  '- Include only vendors whose Stage 1 disposition is Conditional Approve or Reject.',
  '- Do not include vendors whose Stage 1 disposition is Approve.',
  '- Conditional Approve due to expired certification requires recertification within 90 days.',
  '- Conditional Approve due to an active incident requires security monitoring and incident review within 30 days.',
  '- Reject due to missing security certification requires certification evidence before approval can proceed.',
  '- Reject due to missing Data Processing Agreement requires a signed DPA before approval can proceed.',
  '',
  'Use the Stage 1 vendor-decision-register.csv as the source of truth for dispositions.',
  'The remediation plan must summarize every Conditional Approve and Reject vendor.',
  'The remediation tasks CSV columns must be exactly: vendor_id,vendor_name,disposition,remediation_action,due_days,owner.',
  'due_days must always be numeric for every row: use 90 for expired certification, 30 for active incident monitoring, and 0 for Reject rows that are blocked until missing evidence is provided.'
].join('\n');

function createVendorRemediationWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'vendor-remediation-plan',
    name: 'Example: Vendor Remediation Plan',
    version: '1',
    description: 'Consumes vendor compliance review outputs and writes remediation artifacts.',
    enabled: true,
    policy: {
      id: 'vendor-remediation-policy',
      version: '1',
      text: VENDOR_REMEDIATION_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Read the Stage 1 vendor decision register and compliance review.',
      'Identify every vendor marked Conditional Approve or Reject.',
      'Write a complete remediation plan and remediation task CSV using workflow.policy.text.',
      'Do not include vendors marked Approve in remediation tasks.'
    ].join('\n'),
    verifierContract: {
      id: 'vendor-remediation-verifier',
      version: '1',
      fixture: 'vendor-compliance',
      expectedArtifacts: [
        'vendors/remediation-plan.md',
        'vendors/remediation-tasks.csv'
      ]
    },
    inputSchema: {
      basePath: 'string'
    },
    actions: [
      { id: 'read_register', action: 'readFile', input: { path: '{{workflow.input.basePath}}/vendor-decision-register.csv' }, saveAs: 'register', next: 'read_review' },
      { id: 'read_review', action: 'readFile', input: { path: '{{workflow.input.basePath}}/compliance-review.md' }, saveAs: 'review', next: 'plan_remediation' },
      {
        id: 'plan_remediation',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            vendorDecisionRegisterCsv: '{{register.content}}',
            complianceReviewMd: '{{review.content}}'
          },
          outputSchema: {
            remediationPlanMd: 'string',
            remediationTasksCsv: 'string'
          }
        },
        saveAs: 'remediation',
        next: 'write_plan'
      },
      {
        id: 'write_plan',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/remediation-plan.md',
          content: '{{remediation.remediationPlanMd}}'
        },
        next: 'write_tasks'
      },
      {
        id: 'write_tasks',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/remediation-tasks.csv',
          content: '{{remediation.remediationTasksCsv}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            remediationPlanPath: '{{workflow.input.basePath}}/remediation-plan.md',
            remediationTasksPath: '{{workflow.input.basePath}}/remediation-tasks.csv'
          }
        }
      }
    ],
    postconditions: [
      { id: 'remediation-plan-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/remediation-plan.md' },
      { id: 'remediation-tasks-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/remediation-tasks.csv' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


const VENDOR_REMEDIATION_FAILURE_HANDOFF_POLICY_TEXT = [
  'Failure handoff rules:',
  '- If Stage 1 status is not completed, do not claim remediation is complete.',
  '- Write remediation-blockers.md describing the failed Stage 1 run, missing or unavailable evidence, and why remediation cannot proceed.',
  '- Write remediation-tasks.csv with only the header row when Stage 1 did not produce a usable vendor-decision-register.csv.',
  '- The remediation-tasks.csv columns must be exactly: vendor_id,vendor_name,disposition,remediation_action,due_days,owner.',
  '- The blockers document must include the Stage 1 run id, Stage 1 status, and missing source path when provided.'
].join('\n');

function createVendorRemediationFailureHandoffWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'vendor-remediation-failure-handoff',
    name: 'Example: Vendor Remediation Failure Handoff',
    version: '1',
    description: 'Consumes Stage 1 failure evidence and writes deterministic remediation blockers.',
    enabled: true,
    policy: {
      id: 'vendor-remediation-failure-handoff-policy',
      version: '1',
      text: VENDOR_REMEDIATION_FAILURE_HANDOFF_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Use the Stage 1 status evidence from workflow input.',
      'If Stage 1 failed or did not produce a complete vendor decision register, write blockers instead of pretending remediation is complete.',
      'Write remediation-blockers.md and remediation-tasks.csv using workflow.policy.text.'
    ].join('\n'),
    verifierContract: {
      id: 'vendor-remediation-failure-handoff-verifier',
      version: '1',
      fixture: 'vendor-compliance',
      expectedArtifacts: [
        'vendors/remediation-blockers.md',
        'vendors/remediation-tasks.csv'
      ]
    },
    inputSchema: {
      basePath: 'string',
      stage1RunId: 'string',
      stage1Status: 'string',
      stage1Error: 'string',
      missingSourcePath: 'string'
    },
    actions: [
      {
        id: 'prepare_handoff',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            stage1RunId: '{{workflow.input.stage1RunId}}',
            stage1Status: '{{workflow.input.stage1Status}}',
            stage1Error: '{{workflow.input.stage1Error}}',
            missingSourcePath: '{{workflow.input.missingSourcePath}}'
          },
          outputSchema: {
            remediationBlockersMd: 'string',
            remediationTasksCsv: 'string'
          }
        },
        saveAs: 'handoff',
        next: 'write_blockers'
      },
      {
        id: 'write_blockers',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/remediation-blockers.md',
          content: '{{handoff.remediationBlockersMd}}'
        },
        next: 'write_tasks'
      },
      {
        id: 'write_tasks',
        action: 'writeFile',
        input: {
          path: '{{workflow.input.basePath}}/remediation-tasks.csv',
          content: '{{handoff.remediationTasksCsv}}'
        },
        next: 'done'
      },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            remediationBlockersPath: '{{workflow.input.basePath}}/remediation-blockers.md',
            remediationTasksPath: '{{workflow.input.basePath}}/remediation-tasks.csv'
          }
        }
      }
    ],
    postconditions: [
      { id: 'remediation-blockers-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/remediation-blockers.md' },
      { id: 'remediation-tasks-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/remediation-tasks.csv' }
    ],
    createdAt: now,
    updatedAt: now
  };
}


const SHARED_DRIVE_CLEANUP_WORKFLOW_POLICY_TEXT = [
  'Decision rules:',
  '- Preserve active files and files with active references in their original paths.',
  '- Move stale files to shared-drive/archive/. A stale file has Status: stale or no active reference with an old retired/closed planning date.',
  '- For duplicate groups, keep the file marked Canonical File: yes in place. Move only the non-canonical duplicate copy to shared-drive/duplicates/.',
  '- Normalize files whose Naming Status says they need kebab-case normalization by moving them to shared-drive/normalized/ with the normalized filename stated by the task evidence.',
  '- Leave ordinary current files with Naming Status: ok in place.',
  '- Do not delete files. Do not overwrite files. Do not move active files.',
  '',
  'Required cleanup-log.csv columns exactly: original_path,action,new_path,reason.',
  'Use only these cleanup log action values exactly: move_to_archive, move_duplicate, normalize_name.',
  'Reason values must be short and must not contain commas.',
  'Write one cleanup-log.csv row for each moved file only.',
  'The migration report must summarize preserved, archived, duplicate, normalized, and no-action files in at least 200 characters.'
].join('\n');

function createSharedDriveCleanupWorkflowDefinition(now = new Date().toISOString()) {
  return {
    id: 'shared-drive-cleanup',
    name: 'Example: Shared Drive Cleanup',
    version: '1',
    description: 'Cleans a bounded shared-drive fixture using attached workflow policy and writes audit artifacts.',
    enabled: true,
    policy: {
      id: 'shared-drive-cleanup-policy',
      version: '1',
      text: SHARED_DRIVE_CLEANUP_WORKFLOW_POLICY_TEXT
    },
    taskPromptTemplate: [
      'Inspect every provided shared-drive source file using workflow.policy.text.',
      'Return exact move paths for only the files that policy requires moving.',
      'Use exact Source Path values from each file as original paths. Do not remove the incoming/ path segment.',
      'Use exact required target paths from workflow input as new paths.',
      'Do not invent files. Do not move active files. Do not include policy artifacts in the workspace.',
      'Produce cleanup-log.csv with exact columns: original_path,action,new_path,reason',
      'Use action values exactly: move_to_archive, move_duplicate, normalize_name',
      'Reasons must not contain commas.'
    ].join('\n'),
    verifierContract: {
      id: 'shared-drive-cleanup-verifier',
      version: '1',
      fixture: 'shared-drive',
      expectedArtifacts: [
        'shared-drive/migration-report.md',
        'shared-drive/cleanup-log.csv'
      ]
    },
    inputSchema: {
      basePath: 'string'
    },
    actions: [
      { id: 'read_001', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/active-roadmap.md' }, saveAs: 'file001', next: 'read_002' },
      { id: 'read_002', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/active-support-runbook.md' }, saveAs: 'file002', next: 'read_003' },
      { id: 'read_003', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/2024-01-15-retired-launch-plan.md' }, saveAs: 'file003', next: 'read_004' },
      { id: 'read_004', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/2024-03-02-old-budget-notes.md' }, saveAs: 'file004', next: 'read_005' },
      { id: 'read_005', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-review.md' }, saveAs: 'file005', next: 'read_006' },
      { id: 'read_006', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/vendor-review-copy.md' }, saveAs: 'file006', next: 'read_007' },
      { id: 'read_007', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/Team_Status_FINAL.md' }, saveAs: 'file007', next: 'read_008' },
      { id: 'read_008', action: 'readFile', input: { path: '{{workflow.input.basePath}}/incoming/reference-checklist.md' }, saveAs: 'file008', next: 'plan_cleanup' },
      {
        id: 'plan_cleanup',
        action: 'agentStructuredOutput',
        input: {
          instruction: '{{workflow.taskPromptTemplate}}\n\nPolicy:\n{{workflow.policy.text}}',
          input: {
            files: {
              'active-roadmap.md': '{{file001.content}}',
              'active-support-runbook.md': '{{file002.content}}',
              '2024-01-15-retired-launch-plan.md': '{{file003.content}}',
              '2024-03-02-old-budget-notes.md': '{{file004.content}}',
              'vendor-review.md': '{{file005.content}}',
              'vendor-review-copy.md': '{{file006.content}}',
              'Team_Status_FINAL.md': '{{file007.content}}',
              'reference-checklist.md': '{{file008.content}}'
            },
            requiredMoves: {
              archive1: { originalPath: '{{workflow.input.basePath}}/incoming/2024-01-15-retired-launch-plan.md', newPath: '{{workflow.input.basePath}}/archive/2024-01-15-retired-launch-plan.md' },
              archive2: { originalPath: '{{workflow.input.basePath}}/incoming/2024-03-02-old-budget-notes.md', newPath: '{{workflow.input.basePath}}/archive/2024-03-02-old-budget-notes.md' },
              duplicate: { originalPath: '{{workflow.input.basePath}}/incoming/vendor-review-copy.md', newPath: '{{workflow.input.basePath}}/duplicates/vendor-review-copy.md' },
              normalized: { originalPath: '{{workflow.input.basePath}}/incoming/Team_Status_FINAL.md', newPath: '{{workflow.input.basePath}}/normalized/team-status.md' }
            }
          },
          outputSchema: {
            archive1OriginalPath: 'string',
            archive1NewPath: 'string',
            archive2OriginalPath: 'string',
            archive2NewPath: 'string',
            duplicateOriginalPath: 'string',
            duplicateNewPath: 'string',
            normalizeOriginalPath: 'string',
            normalizeNewPath: 'string',
            cleanupLogCsv: 'string',
            migrationReportMd: 'string'
          }
        },
        saveAs: 'cleanup',
        next: 'create_archive'
      },
      { id: 'create_archive', action: 'createFolder', input: { path: '{{workflow.input.basePath}}/archive' }, next: 'create_duplicates' },
      { id: 'create_duplicates', action: 'createFolder', input: { path: '{{workflow.input.basePath}}/duplicates' }, next: 'create_normalized' },
      { id: 'create_normalized', action: 'createFolder', input: { path: '{{workflow.input.basePath}}/normalized' }, next: 'move_archive_1' },
      { id: 'move_archive_1', action: 'renamePath', input: { path: '{{cleanup.archive1OriginalPath}}', nextPath: '{{cleanup.archive1NewPath}}' }, next: 'move_archive_2' },
      { id: 'move_archive_2', action: 'renamePath', input: { path: '{{cleanup.archive2OriginalPath}}', nextPath: '{{cleanup.archive2NewPath}}' }, next: 'move_duplicate' },
      { id: 'move_duplicate', action: 'renamePath', input: { path: '{{cleanup.duplicateOriginalPath}}', nextPath: '{{cleanup.duplicateNewPath}}' }, next: 'move_normalized' },
      { id: 'move_normalized', action: 'renamePath', input: { path: '{{cleanup.normalizeOriginalPath}}', nextPath: '{{cleanup.normalizeNewPath}}' }, next: 'write_log' },
      { id: 'write_log', action: 'writeFile', input: { path: '{{workflow.input.basePath}}/cleanup-log.csv', content: '{{cleanup.cleanupLogCsv}}' }, next: 'write_report' },
      { id: 'write_report', action: 'writeFile', input: { path: '{{workflow.input.basePath}}/migration-report.md', content: '{{cleanup.migrationReportMd}}' }, next: 'done' },
      {
        id: 'done',
        action: 'stop',
        input: {
          result: {
            cleanupLogPath: '{{workflow.input.basePath}}/cleanup-log.csv',
            migrationReportPath: '{{workflow.input.basePath}}/migration-report.md'
          }
        }
      }
    ],
    postconditions: [
      { id: 'cleanup-log-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/cleanup-log.csv' },
      { id: 'migration-report-exists', type: 'fileExists', path: '{{workflow.input.basePath}}/migration-report.md' }
    ],
    createdAt: now,
    updatedAt: now
  };
}

function readWorkflows() {
  return readJsonArrayCached(WORKFLOWS_FILE);
}

function cachePageRender(key, html) {
  pageRenderCache.set(key, {
    html,
    dataVersion,
    expiresAt: Date.now() + PAGE_RENDER_CACHE_TTL_MS
  });

  if (pageRenderCache.size > PAGE_RENDER_CACHE_MAX_ENTRIES) {
    const oldestKey = pageRenderCache.keys().next().value;
    if (oldestKey) pageRenderCache.delete(oldestKey);
  }
}

async function renderCachedView(request, reply, template, data) {
  if (request.method !== 'GET' || !request.session || !request.session.userId) {
    return reply.view(template, data);
  }

  const key = `${request.session.userId}:${template}:${request.url}`;
  const cached = pageRenderCache.get(key);

  if (cached && cached.dataVersion === dataVersion && cached.expiresAt > Date.now()) {
    reply.header('X-Page-Cache', 'hit');
    reply.type('text/html; charset=utf-8');
    return reply.send(cached.html);
  }

  let renderPromise = pageRenderInFlight.get(key);

  if (!renderPromise) {
    const renderDataVersion = dataVersion;
    renderPromise = reply.viewAsync(template, data)
      .then(html => {
        if (renderDataVersion === dataVersion) cachePageRender(key, html);
        return html;
      })
      .finally(() => {
        pageRenderInFlight.delete(key);
      });
    pageRenderInFlight.set(key, renderPromise);
  }

  const html = await renderPromise;
  reply.header('X-Page-Cache', cached ? 'stale' : 'miss');
  reply.type('text/html; charset=utf-8');
  return reply.send(html);
}

function normalizeOptionalPositiveInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ticketWorkspaceScope(ticket) {
  return ticket && ticket.assignmentTargetType === 'group' && ['allocated', 'dynamic'].includes(ticket.assignmentMode)
    ? 'owned_paths'
    : 'shared';
}

function runWorkspaceScope(run) {
  return run && run.executionWorkspaceType === 'main_owned_paths' ? 'owned_paths' : 'shared';
}

function normalizeExecutionPolicy(policy, workspaceScope = 'shared') {
  const source = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  return {
    mode: source.mode === 'manual' ? 'manual' : 'assisted',
    requireVerification: 'when_declared',
    // Strict boolean opt-in. Default-off; has effect only when maxAttempts is a
    // finite positive integer (enforced by the auto-retry gate, not here).
    autoRetry: source.autoRetry === true,
    // Unset/invalid → null (unlimited). Only an explicit finite positive value is
    // enforced (for manual rerun-from-start). Mirrors the other max* fields.
    maxAttempts: normalizeOptionalPositiveInteger(source.maxAttempts),
    maxRuntimeMs: normalizeOptionalPositiveInteger(source.maxRuntimeMs),
    maxModelRequests: normalizeOptionalPositiveInteger(source.maxModelRequests),
    maxWorkspaceOperations: normalizeOptionalPositiveInteger(source.maxWorkspaceOperations),
    allowWorkspaceWrites: source.allowWorkspaceWrites === undefined
      ? DEFAULT_EXECUTION_POLICY.allowWorkspaceWrites
      : source.allowWorkspaceWrites === true,
    allowParallelRuns: source.allowParallelRuns === true,
    allowChildTickets: source.allowChildTickets === true,
    workspaceScope: workspaceScope === 'owned_paths' ? 'owned_paths' : 'shared'
  };
}

function copyExecutionPolicy(policy, workspaceScope = 'shared') {
  return sanitizeSnapshotValue(normalizeExecutionPolicy(policy, workspaceScope));
}

function normalizeVerificationContractSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const workflowId = typeof snapshot.workflowId === 'string' && snapshot.workflowId.trim()
    ? snapshot.workflowId.trim()
    : null;
  if (!workflowId) return null;

  return {
    workflowId,
    workflowName: typeof snapshot.workflowName === 'string' && snapshot.workflowName.trim()
      ? snapshot.workflowName.trim()
      : workflowId,
    workflowVersion: typeof snapshot.workflowVersion === 'string' && snapshot.workflowVersion.trim()
      ? snapshot.workflowVersion.trim()
      : null,
    postconditions: Array.isArray(snapshot.postconditions)
      ? sanitizeSnapshotValue(snapshot.postconditions.filter(item => item && typeof item === 'object' && !Array.isArray(item)))
      : [],
    verifierContract: normalizeWorkflowVerifierContract(snapshot.verifierContract),
    capturedAt: typeof snapshot.capturedAt === 'string' && isValidIsoTimestamp(snapshot.capturedAt)
      ? snapshot.capturedAt
      : null
  };
}

function buildVerificationContractSnapshot(workflow, capturedAt = new Date().toISOString()) {
  if (!workflow || typeof workflow.id !== 'string') return null;
  return normalizeVerificationContractSnapshot({
    workflowId: workflow.id,
    workflowName: workflow.name || workflow.id,
    workflowVersion: workflow.version || null,
    postconditions: Array.isArray(workflow.postconditions) ? workflow.postconditions : [],
    verifierContract: workflow.verifierContract || null,
    capturedAt
  });
}

function normalizeTriage(triage) {
  if (!triage || typeof triage !== 'object' || Array.isArray(triage)) return null;
  const reasonCode = TRIAGE_REASON_CODES.includes(triage.reasonCode) ? triage.reasonCode : 'unknown';
  const requiredDecision = TRIAGE_REQUIRED_DECISIONS.includes(triage.requiredDecision)
    ? triage.requiredDecision
    : 'review_failure';
  return {
    required: triage.required !== false,
    reasonCode,
    summary: String(triage.summary || '').trim() || 'Run stopped without a structured summary.',
    requiredDecision,
    evidenceRefs: Array.isArray(triage.evidenceRefs)
      ? triage.evidenceRefs.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    allowedActions: Array.isArray(triage.allowedActions)
      ? triage.allowedActions.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    prohibitedActions: Array.isArray(triage.prohibitedActions)
      ? triage.prohibitedActions.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    createdAt: typeof triage.createdAt === 'string' && isValidIsoTimestamp(triage.createdAt) ? triage.createdAt : null,
    resolvedAt: typeof triage.resolvedAt === 'string' && isValidIsoTimestamp(triage.resolvedAt) ? triage.resolvedAt : null,
    resolvedBy: typeof triage.resolvedBy === 'string' && triage.resolvedBy.trim() ? triage.resolvedBy.trim() : null,
    resolution: typeof triage.resolution === 'string' && triage.resolution.trim() ? triage.resolution.trim() : null
  };
}

function normalizeTickets(tickets) {
  const seenTicketIds = new Set();

  return tickets.filter(ticket => {
    const ticketId = parseInt(ticket.id, 10);
    const assignmentTargetId = parseInt(ticket.assignmentTargetId, 10);

    if (Number.isNaN(ticketId) || seenTicketIds.has(ticketId)) return false;

    seenTicketIds.add(ticketId);
    ticket.id = ticketId;

    if (!['agent', 'group'].includes(ticket.assignmentTargetType)) {
      ticket.assignmentTargetType = 'agent';
    }

    ticket.assignmentTargetId = Number.isNaN(assignmentTargetId) ? 0 : assignmentTargetId;

    if (ticket.assignmentTargetType === 'agent') {
      ticket.assignmentMode = 'individual';
    } else if (!['allocated', 'dynamic'].includes(ticket.assignmentMode)) {
      ticket.assignmentMode = 'allocated';
    }

    ticket.ownedOutputPaths = (typeof ticket.ownedOutputPaths === 'object' && ticket.ownedOutputPaths !== null && !Array.isArray(ticket.ownedOutputPaths))
      ? ticket.ownedOutputPaths
      : null;
    ticket.executionMode = ticket.executionMode === 'workflow' ? 'workflow' : 'agent';
    ticket.workflowId = ticket.executionMode === 'workflow' && typeof ticket.workflowId === 'string' ? ticket.workflowId : null;
    ticket.workflowInput = ticket.executionMode === 'workflow' && ticket.workflowInput && typeof ticket.workflowInput === 'object' && !Array.isArray(ticket.workflowInput)
      ? ticket.workflowInput
      : null;
    ticket.capabilityType = ticket.executionMode === 'workflow' ? 'workflow' : 'directAction';
    ticket.capabilityId = ticket.capabilityType === 'workflow' ? ticket.workflowId : 'agent-selected-actions';
    ticket.capabilityInput = ticket.capabilityType === 'workflow' ? ticket.workflowInput : null;
    ticket.executionPolicy = normalizeExecutionPolicy(ticket.executionPolicy, ticketWorkspaceScope(ticket));
    ticket.triage = normalizeTriage(ticket.triage);

    return true;
  });
}

function writeTickets(tickets) {
  writeFileAtomic(DATA_FILE, JSON.stringify(normalizeTickets(tickets), null, 2));
}

// ==================== PROCESS TEMPLATES ====================
// Durable, manual-trigger-only process templates. A template stores a reusable
// ticket input and creates ordinary tickets through the same createTicketFromInput
// path as the POST /tickets route. Templates never create runs directly and never
// schedule themselves (schedule is inert in v1). The trigger log is append-only and
// serves as both the idempotency ledger and the provenance record.
function readProcessTemplates() {
  return readJsonArrayCached(PROCESS_TEMPLATES_FILE);
}

function writeProcessTemplates(templates) {
  writeFileAtomic(PROCESS_TEMPLATES_FILE, JSON.stringify(Array.isArray(templates) ? templates : [], null, 2));
}

function getProcessTemplateById(id) {
  const numericId = parseInt(id, 10);
  if (Number.isNaN(numericId)) return null;
  return readProcessTemplates().find(template => template.id === numericId) || null;
}

function readProcessTemplateTriggers() {
  return readJsonArrayCached(PROCESS_TEMPLATE_TRIGGERS_FILE);
}

function appendProcessTemplateTrigger(entry) {
  const triggers = readProcessTemplateTriggers();
  triggers.push(entry);
  writeFileAtomic(PROCESS_TEMPLATE_TRIGGERS_FILE, JSON.stringify(triggers, null, 2));
  return entry;
}

function findProcessTemplateTrigger(templateId, triggerToken) {
  if (!triggerToken) return null;
  return readProcessTemplateTriggers().find(entry =>
    entry && entry.templateId === templateId && entry.triggerToken === triggerToken) || null;
}

// Second idempotency source: an already-created ticket carrying this trigger token in
// its provenance. Closes the crash window where the ticket was created but the
// append-only trigger log write did not complete.
function findTicketByProcessTemplateToken(triggerToken) {
  if (!triggerToken) return null;
  return readTickets().find(ticket =>
    ticket && ticket.source && ticket.source.type === 'process_template' &&
    ticket.source.triggerToken === triggerToken) || null;
}

// Pure forward interval arithmetic (UTC). Returns null for an invalid schedule.
function computeNextRunAt(schedule, fromIso) {
  const everySeconds = schedule && Number.isInteger(schedule.everySeconds) ? schedule.everySeconds : null;
  if (!everySeconds || everySeconds <= 0) return null;
  const fromMs = Date.parse(fromIso);
  if (Number.isNaN(fromMs)) return null;
  return new Date(fromMs + everySeconds * 1000).toISOString();
}

// Advance an interval schedule's cursor FORWARD FROM `fromIso` (never by replaying
// missed slots). Used on a deduped scheduled re-entry so a stale nextRunAt (e.g. a
// crash that lost the post-create cursor update) cannot re-process the same past slot
// forever — the slot is already in the authoritative trigger log, so we just move on.
function advanceScheduleCursorForward(templateId, fromIso) {
  const templates = readProcessTemplates();
  const t = templates.find(item => item.id === templateId);
  if (!t || !t.schedule || t.schedule.kind !== 'interval' || t.schedule.enabled !== true) return;
  t.schedule.nextRunAt = computeNextRunAt(t.schedule, fromIso);
  t.updatedAt = fromIso;
  writeProcessTemplates(templates);
}

// Shared process-template trigger used by BOTH the manual route and the scheduled
// scanner. It enforces idempotency (append-only trigger log AND existing
// ticket.source.triggerToken), creates the ticket ONLY through createTicketFromInput
// (→ createRunsForTicket, inheriting every gate), appends the trigger log, writes a
// compact system log, and advances the template cursor. It never creates runs,
// calls createAgentRun, or mutates the workspace directly.
//
// triggerContext: { triggerType: 'manual'|'schedule', triggerToken, scheduledFor? }
//   actor: { userId, username }  (a manual live user, or { userId: null, username: 'system' })
function triggerProcessTemplate(template, actor, triggerContext) {
  const triggerToken = triggerContext.triggerToken;
  const triggerType = triggerContext.triggerType;
  const isScheduled = triggerType === 'schedule';

  // Idempotency: authoritative trigger log first, then existing tickets by source
  // token (the crash-window backstop). A deduped scheduled re-entry still advances
  // the cursor so the template moves past the already-handled slot.
  const existingTrigger = findProcessTemplateTrigger(template.id, triggerToken);
  const existingTicket = existingTrigger ? null : findTicketByProcessTemplateToken(triggerToken);
  if (existingTrigger || existingTicket) {
    if (isScheduled) advanceScheduleCursorForward(template.id, new Date().toISOString());
    return {
      ok: true,
      deduped: true,
      ticketId: existingTrigger ? existingTrigger.ticketId : existingTicket.id,
      templateId: template.id,
      triggerToken
    };
  }

  const triggeredBy = isScheduled
    ? 'system'
    : (actor && actor.username ? actor.username : (actor && actor.userId != null ? String(actor.userId) : 'system'));
  const now = new Date().toISOString();
  const tt = template.ticketTemplate || {};
  const source = {
    type: 'process_template',
    templateId: template.id,
    templateName: template.name,
    triggeredBy,
    triggerType,
    triggerRunId: null,
    triggerToken,
    createdAt: now
  };
  if (triggerContext.scheduledFor) source.scheduledFor = triggerContext.scheduledFor;

  const result = createTicketFromInput({
    objective: tt.objective,
    assignmentTargetType: tt.assignmentTargetType,
    assignmentTargetId: tt.assignmentTargetId,
    assignmentMode: tt.assignmentMode,
    capabilityType: tt.capabilityType,
    executionMode: tt.capabilityType === 'workflow' ? 'workflow' : 'agent',
    workflowId: tt.workflowId,
    workflowInput: tt.workflowInput,
    ownedOutputPaths: tt.ownedOutputPaths,
    executionPolicy: tt.executionPolicy
  }, { userId: actor ? actor.userId : null, username: triggeredBy }, {
    source,
    delegated: {
      userId: actor ? actor.userId : null,
      username: triggeredBy,
      source: isScheduled ? 'process_template_schedule' : 'process_template_trigger'
    }
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const generatedTicket = result.ticket;

  // Append-only trigger log: idempotency ledger + provenance snapshot.
  const logEntry = {
    triggerToken,
    templateId: template.id,
    templateName: template.name,
    ticketId: generatedTicket.id,
    triggeredBy,
    triggerType,
    createdAt: now,
    ticketTemplateSnapshot: tt,
    executionPolicyUsed: generatedTicket.executionPolicy
  };
  if (triggerContext.scheduledFor) logEntry.scheduledFor = triggerContext.scheduledFor;
  if (template.createdBy) logEntry.templateCreatedBy = template.createdBy;
  if (template.schedule && template.schedule.scheduledBy) logEntry.scheduledBy = template.schedule.scheduledBy;
  appendProcessTemplateTrigger(logEntry);

  // Advance the template cursor. Manual: lastTriggeredAt. Scheduled: also move
  // nextRunAt FORWARD FROM NOW (no replay of missed slots) + record last trigger.
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (persisted) {
    persisted.lastTriggeredAt = now;
    persisted.updatedAt = now;
    if (isScheduled && persisted.schedule && persisted.schedule.kind === 'interval' && persisted.schedule.enabled === true) {
      persisted.schedule.lastScheduledTriggerAt = now;
      persisted.schedule.nextRunAt = computeNextRunAt(persisted.schedule, now);
    }
    writeProcessTemplates(templates);
  }

  appendSystemLog('process_template:triggered', `Process template "${template.name}" created ticket #${generatedTicket.id}`, null, {
    contextTicketId: generatedTicket.id,
    templateId: template.id,
    templateName: template.name,
    triggeredBy,
    triggerType,
    triggerToken
  });

  return {
    ok: true,
    deduped: false,
    ticketId: generatedTicket.id,
    ticket: generatedTicket,
    templateId: template.id,
    triggerToken,
    source
  };
}

// Pure, read-only derivation of operator-facing process-template state. Joins the
// existing stores (templates + tickets) in memory and returns one derived row per
// template. It writes nothing, triggers nothing, and never calls the scheduler or any
// trigger / run-creation path — rendering this state is a pure read. `now` is a
// millisecond timestamp (injected for deterministic tests). The `triggers` ledger is
// accepted for signature symmetry but counts are derived from tickets (authoritative
// and dedupe-proof: deduped re-entries create no ticket, so they cannot double-count).
function deriveProcessTemplateState(templates, triggers, tickets, now) {
  const nowMs = typeof now === 'number' ? now : Date.now();

  const ticketsByTemplate = new Map();
  (tickets || []).forEach(ticket => {
    const src = ticket && ticket.source;
    if (!src || src.type !== 'process_template' || src.templateId == null) return;
    const list = ticketsByTemplate.get(src.templateId) || [];
    list.push(ticket);
    ticketsByTemplate.set(src.templateId, list);
  });

  function ticketOrderKey(t) {
    const createdMs = Date.parse((t.source && t.source.createdAt) || t.createdAt || '') || 0;
    return createdMs * 1e7 + (Number(t.id) || 0);
  }
  function isTriaged(t) { return Boolean(t && t.triage && t.triage.required === true); }

  function computeDueStatus(template) {
    if (!template || template.enabled !== true) return 'template_disabled';
    const s = template.schedule;
    if (!s) return 'unscheduled';
    // A schedule turned off while retaining a reusable interval config is "paused"
    // (one-click Resume restores it); without reusable config it is plainly disabled.
    if (s.enabled !== true) return scheduleHasReusableInterval(s) ? 'schedule_paused' : 'schedule_disabled';
    if (s.kind !== 'interval') return 'invalid_schedule';
    if (!Number.isInteger(s.everySeconds) || s.everySeconds <= 0) return 'invalid_schedule';
    const nextMs = typeof s.nextRunAt === 'string' ? Date.parse(s.nextRunAt) : NaN;
    if (Number.isNaN(nextMs)) return 'invalid_schedule';
    return nextMs <= nowMs ? 'due' : 'not_due';
  }

  return (templates || []).map(template => {
    const generated = (ticketsByTemplate.get(template.id) || []).slice().sort((a, b) => ticketOrderKey(a) - ticketOrderKey(b));
    const counts = { total: 0, blocked: 0, triaged: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 };
    generated.forEach(t => {
      counts.total++;
      if (t.status === 'blocked') counts.blocked++;
      if (isTriaged(t)) counts.triaged++;
      if (t.status === 'open') counts.pending++;
      if (t.status === 'in_progress') counts.inProgress++;
      if (t.status === 'completed') counts.completed++;
      if (t.status === 'failed') counts.failed++;
    });

    const last = generated.length > 0 ? generated[generated.length - 1] : null;
    const recentGeneratedTickets = generated.slice(-5).reverse().map(t => ({
      ticketId: t.id,
      triggerType: (t.source && t.source.triggerType) || 'manual',
      status: t.status,
      triageReason: isTriaged(t) ? (t.triage.reasonCode || null) : null,
      scheduledFor: (t.source && t.source.scheduledFor) || null
    }));

    const dueStatus = computeDueStatus(template);

    // Advisory health (derived; NOT a correctness guarantee; no remediation).
    let healthStatus;
    if (template.enabled !== true) {
      healthStatus = 'disabled';
    } else if (dueStatus === 'invalid_schedule') {
      healthStatus = 'invalid_schedule';
    } else if (last && (last.status === 'blocked' || isTriaged(last))) {
      healthStatus = 'attention_needed';
    } else if (recentGeneratedTickets.some(t => t.status === 'failed' || t.status === 'blocked')) {
      healthStatus = 'attention_needed';
    } else if (dueStatus === 'schedule_paused') {
      // Paused is neutral — but a real blocked/failed issue above still wins.
      healthStatus = 'paused';
    } else if (counts.total === 0) {
      healthStatus = 'no_recent_triggers';
    } else {
      healthStatus = 'ok';
    }

    const schedule = template.schedule || null;
    const tt = template.ticketTemplate || {};
    return {
      templateId: template.id,
      name: template.name,
      objective: tt.objective || '',
      assignmentTargetType: tt.assignmentTargetType || null,
      assignmentTargetId: tt.assignmentTargetId != null ? tt.assignmentTargetId : null,
      enabled: template.enabled === true,
      manualAvailable: template.enabled === true,
      scheduleEnabled: Boolean(schedule && schedule.enabled === true),
      scheduleKind: schedule ? (schedule.kind || null) : null,
      scheduleEverySeconds: schedule && Number.isInteger(schedule.everySeconds) ? schedule.everySeconds : null,
      nextRunAt: schedule ? (schedule.nextRunAt || null) : null,
      lastScheduledTriggerAt: schedule ? (schedule.lastScheduledTriggerAt || null) : null,
      lastTriggeredAt: template.lastTriggeredAt || null,
      lastTriggerType: last ? ((last.source && last.source.triggerType) || null) : null,
      lastGeneratedTicketId: last ? last.id : null,
      lastGeneratedTicketStatus: last ? last.status : null,
      lastGeneratedTicketTriageReason: last && isTriaged(last) ? (last.triage.reasonCode || null) : null,
      generatedTicketCounts: counts,
      recentGeneratedTickets,
      dueStatus,
      healthStatus
    };
  });
}

function normalizeWorkflowPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const id = typeof policy.id === 'string' ? policy.id.trim() : '';
  const version = typeof policy.version === 'string' ? policy.version.trim() : '';
  const text = typeof policy.text === 'string' ? policy.text : '';
  if (!id && !version && !text) return null;
  return { id, version, text };
}

function normalizeWorkflowVerifierContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  const id = typeof contract.id === 'string' ? contract.id.trim() : '';
  const version = typeof contract.version === 'string' ? contract.version.trim() : '';
  const fixture = typeof contract.fixture === 'string' ? contract.fixture.trim() : '';
  const expectedArtifacts = Array.isArray(contract.expectedArtifacts)
    ? contract.expectedArtifacts.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  if (!id && !version && !fixture && expectedArtifacts.length === 0) return null;
  return { id, version, fixture, expectedArtifacts };
}

function hashWorkflowPolicyText(policy) {
  const text = policy && typeof policy.text === 'string' ? policy.text : '';
  return text ? crypto.createHash('sha256').update(text).digest('hex') : null;
}

function buildWorkflowContractEvidence(workflow) {
  const policy = workflow && workflow.policy && typeof workflow.policy === 'object' ? workflow.policy : null;
  const verifierContract = workflow && workflow.verifierContract && typeof workflow.verifierContract === 'object'
    ? workflow.verifierContract
    : null;
  return {
    workflowId: workflow ? workflow.id : null,
    workflowVersion: workflow && typeof workflow.version === 'string' ? workflow.version : null,
    policyId: policy && typeof policy.id === 'string' ? policy.id : null,
    policyVersion: policy && typeof policy.version === 'string' ? policy.version : null,
    policyTextHash: hashWorkflowPolicyText(policy),
    verifierContractId: verifierContract && typeof verifierContract.id === 'string' ? verifierContract.id : null,
    verifierContractVersion: verifierContract && typeof verifierContract.version === 'string' ? verifierContract.version : null
  };
}

function normalizeWorkflows(workflows) {
  const seenWorkflowIds = new Set();
  const now = new Date().toISOString();

  return workflows.filter(workflow => {
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
    if (typeof workflow.id !== 'string' || !workflow.id.trim()) return false;
    const workflowId = workflow.id.trim();
    if (seenWorkflowIds.has(workflowId)) return false;
    seenWorkflowIds.add(workflowId);

    workflow.id = workflowId;
    workflow.name = typeof workflow.name === 'string' && workflow.name.trim() ? workflow.name.trim() : workflow.id;
    workflow.description = typeof workflow.description === 'string' ? workflow.description : '';
    workflow.version = typeof workflow.version === 'string' && workflow.version.trim() ? workflow.version.trim() : '1';
    const normalizedPolicy = normalizeWorkflowPolicy(workflow.policy);
    if (normalizedPolicy) workflow.policy = normalizedPolicy;
    else delete workflow.policy;
    workflow.taskPromptTemplate = typeof workflow.taskPromptTemplate === 'string' ? workflow.taskPromptTemplate : '';
    const normalizedVerifierContract = normalizeWorkflowVerifierContract(workflow.verifierContract);
    if (normalizedVerifierContract) workflow.verifierContract = normalizedVerifierContract;
    else delete workflow.verifierContract;
    workflow.enabled = workflow.enabled !== false;
    workflow.inputSchema = workflow.inputSchema && typeof workflow.inputSchema === 'object' && !Array.isArray(workflow.inputSchema)
      ? workflow.inputSchema
      : {};
    workflow.actions = Array.isArray(workflow.actions) ? workflow.actions : [];
    workflow.postconditions = Array.isArray(workflow.postconditions)
      ? workflow.postconditions.filter(item => item && typeof item === 'object' && !Array.isArray(item)).map((item, index) => ({
        ...item,
        id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `postcondition-${index + 1}`,
        type: typeof item.type === 'string' ? item.type.trim() : ''
      }))
      : [];
    workflow.createdAt = typeof workflow.createdAt === 'string' ? workflow.createdAt : now;
    workflow.updatedAt = typeof workflow.updatedAt === 'string' ? workflow.updatedAt : now;
    return true;
  });
}

function writeWorkflows(workflows) {
  writeFileAtomic(WORKFLOWS_FILE, JSON.stringify(normalizeWorkflows(workflows), null, 2));
}

function getWorkflowById(workflowId) {
  return readWorkflows().find(workflow => workflow.id === workflowId) || null;
}

function getEnabledWorkflows() {
  return readWorkflows().filter(workflow => workflow.enabled !== false);
}

function workflowHasMutatingActions(workflow) {
  return Boolean(workflow && Array.isArray(workflow.actions) && workflow.actions.some(step =>
    step && AGENT_MUTATING_OPERATIONS.includes(step.action)
  ));
}

function getTicketsForDisplay() {
  const agents = readAgents();
  const agentGroups = getTicketAssignableGroups();
  const runs = readRuns();
  const logs = readLogs();
  const history = readOperationHistory();
  const runsByTicketId = groupBy(runs, run => run.ticketId);
  const logsByRunId = groupBy(logs, log => log.runId);
  const mutationCountByRunId = buildMutationCountByRunId(history);
  const tickets = readTickets().map(ticket => enrichTicketForDisplay(ticket, {
    agents,
    agentGroups,
    runsByTicketId,
    logsByRunId,
    mutationCountByRunId
  }));

  tickets.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return tickets;
}

function getRunLatestParsedPlanMessage(run) {
  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || null;
  const plans = snapshot && Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];

  for (let index = plans.length - 1; index >= 0; index -= 1) {
    const message = plans[index] && typeof plans[index].message === 'string' ? plans[index].message.trim() : '';
    if (message) return sanitizeLogMessage(message);
  }

  return null;
}

function getDisplayMessageFromRunLog(log) {
  if (!log || typeof log.message !== 'string') return null;
  if (log.type === 'run:runtime') return null;
  if (log.type === 'run:queued') return 'queued';
  if (log.type === 'model:request') return 'waiting on model response';
  if (log.type && log.type.startsWith('workspace:')) return 'running actions';
  if (log.type === 'run:timeout') return 'timed out';

  const message = log.message.trim();
  if (!message) return null;

  if (log.type === 'model:response') {
    try {
      const parsed = JSON.parse(message);
      return typeof parsed.message === 'string' && parsed.message.trim()
        ? sanitizeLogMessage(parsed.message.trim())
        : null;
    } catch (error) {
      return null;
    }
  }

  return message;
}

function getRunDisplayState(run, logsByRunId) {
  if (!run) return null;
  const limits = getAgentRuntimeLimits();

  if (run.status === 'pending') {
    return {
      state: 'queued',
      label: 'queued',
      detail: 'waiting to start',
      elapsedMs: Math.max(0, Date.now() - new Date(run.createdAt || Date.now()).getTime()),
      timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
    };
  }

  if (run.status === 'failed' && run.error && /runtime duration limit/i.test(run.error)) {
    return {
      state: 'timed_out',
      label: 'timed out',
      detail: `timed out after ${formatDurationHuman(limits.maxRuntimeDurationMs)}`,
      elapsedMs: run.startedAt ? Math.max(0, Date.now() - new Date(run.startedAt).getTime()) : 0,
      timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
    };
  }

  if (run.status !== 'running') {
    return {
      state: run.status || 'unknown',
      label: displayRunStatus(run.status),
      detail: null,
      elapsedMs: 0,
      timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
    };
  }

  const runLogs = logsByRunId.get(run.id) || [];
  const latestModelRequestIndex = runLogs.map(log => log.type).lastIndexOf('model:request');
  const latestModelResponseIndex = runLogs.map(log => log.type).lastIndexOf('model:response');
  const latestWorkspaceIndex = runLogs.findLastIndex
    ? runLogs.findLastIndex(log => log.type && log.type.startsWith('workspace:'))
    : (() => {
      for (let i = runLogs.length - 1; i >= 0; i -= 1) {
        if (runLogs[i].type && runLogs[i].type.startsWith('workspace:')) return i;
      }
      return -1;
    })();
  const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
  const elapsedMs = Math.max(0, Date.now() - startedAt);

  if (latestModelRequestIndex > latestModelResponseIndex) {
    return {
      state: 'waiting_on_local_model',
      label: 'waiting on model response',
      detail: `waiting ${formatDurationHuman(elapsedMs)} of ${formatDurationHuman(limits.maxRuntimeDurationMs)}`,
      elapsedMs,
      timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
    };
  }

  if (latestWorkspaceIndex > latestModelResponseIndex - 1) {
    return {
      state: 'running_actions',
      label: 'running actions',
      detail: `working for ${formatDurationHuman(elapsedMs)}`,
      elapsedMs,
      timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
    };
  }

  return {
    state: 'running',
    label: 'running',
    detail: `running for ${formatDurationHuman(elapsedMs)}`,
    elapsedMs,
    timeoutLimit: formatDurationHuman(limits.maxRuntimeDurationMs)
  };
}

function getRunCurrentMessage(run, logsByRunId, suppliedSummary = null) {
  if (!run) return null;

  const eventSummary = suppliedSummary || recentEventSummary(run.id);
  if (eventSummary.latestError && eventSummary.latestError.message) return eventSummary.latestError.message;
  if (eventSummary.currentStep && run.status === 'running') {
    const action = eventSummary.currentStep.action || eventSummary.currentStep.stepId;
    if (eventSummary.currentStep.status === 'started') return `workflow step started: ${action}`;
    if (eventSummary.currentStep.status === 'completed') return `workflow step completed: ${action}`;
    if (eventSummary.currentStep.status === 'failed') return `workflow step failed: ${action}`;
  }
  if (eventSummary.latestWorkspaceMutation && eventSummary.latestWorkspaceMutation.operation && run.status === 'running') {
    return `workspace action: ${eventSummary.latestWorkspaceMutation.operation}`;
  }

  const parsedPlanMessage = getRunLatestParsedPlanMessage(run);
  if (parsedPlanMessage) return parsedPlanMessage;

  const runLogs = logsByRunId.get(run.id) || [];
  for (let index = runLogs.length - 1; index >= 0; index -= 1) {
    const message = getDisplayMessageFromRunLog(runLogs[index]);
    if (message) return message;
  }

  return null;
}

// Display-only: same fallback chain as getRunCurrentMessage, but also reports
// which source the message came from so the UI can label freshness/derivation.
function getRunCurrentMessageWithSource(run, logsByRunId, suppliedSummary = null) {
  if (!run) return { message: null, source: 'unavailable' };

  const eventSummary = suppliedSummary || recentEventSummary(run.id);
  if (eventSummary.latestError && eventSummary.latestError.message) {
    return { message: eventSummary.latestError.message, source: 'latest run error' };
  }
  if (eventSummary.currentStep && run.status === 'running') {
    const action = eventSummary.currentStep.action || eventSummary.currentStep.stepId;
    const status = eventSummary.currentStep.status;
    const message = status === 'started' ? `workflow step started: ${action}`
      : status === 'completed' ? `workflow step completed: ${action}`
      : status === 'failed' ? `workflow step failed: ${action}`
      : null;
    if (message) return { message, source: 'latest workflow step' };
  }
  if (eventSummary.latestWorkspaceMutation && eventSummary.latestWorkspaceMutation.operation && run.status === 'running') {
    return { message: `workspace action: ${eventSummary.latestWorkspaceMutation.operation}`, source: 'latest workspace action' };
  }

  const parsedPlanMessage = getRunLatestParsedPlanMessage(run);
  if (parsedPlanMessage) return { message: parsedPlanMessage, source: 'latest model response' };

  const runLogs = (logsByRunId && typeof logsByRunId.get === 'function' ? logsByRunId.get(run.id) : null) || [];
  for (let index = runLogs.length - 1; index >= 0; index -= 1) {
    const message = getDisplayMessageFromRunLog(runLogs[index]);
    if (message) return { message, source: 'latest run log' };
  }

  return { message: null, source: 'unavailable' };
}

// Display-only: a single object summarizing a ticket's execution state for the
// Ticket Detail page. Reads existing ticket/run/allocation data only; it does
// not change scheduling, assignment, allocation, or rerun behavior.
function buildTicketExecutionState(ticket, ticketRuns, allocationPlan, agents, groups) {
  const isGroup = ticket.assignmentTargetType === 'group';
  const target = isGroup
    ? (groups || []).find(group => group.id === ticket.assignmentTargetId)
    : (agents || []).find(agent => agent.id === ticket.assignmentTargetId);
  const assignmentTargetName = target ? target.name : null;
  const assignmentTargetLabel = !ticket.assignmentTargetId
    ? 'Unassigned'
    : (isGroup ? 'Group: ' : 'Agent: ') + (assignmentTargetName || ('#' + ticket.assignmentTargetId));

  const assignmentMode = ticket.assignmentMode || null;
  const assignmentModeLabel = assignmentMode === 'allocated' ? 'allocated (manual folder scopes)'
    : assignmentMode === 'dynamic' ? 'dynamic (automatic folder scopes)'
    : assignmentMode === 'individual' ? 'individual'
    : (assignmentMode || '-');

  const activeRun = ticketRuns
    .filter(run => ['pending', 'running'].includes(run.status))
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.startedAt || a.createdAt || 0))[0] || null;
  const latestRun = ticketRuns
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.completedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.completedAt || a.startedAt || a.createdAt || 0))[0] || null;

  const blocked = ticket.status === 'blocked' || Boolean(ticket.blockedReason);
  const blockedReason = ticket.blockedReason || (ticket.feasibility && ticket.feasibility.reason) || null;
  const memberCount = isGroup ? (getAgentGroupMembers()[ticket.assignmentTargetId] || []).length : 0;

  let autoRun;
  if (blocked) {
    autoRun = { state: 'blocked', label: 'Blocked — will not run until the blocking reason is resolved.' };
  } else if (!ticket.assignmentTargetId) {
    autoRun = { state: 'unassigned', label: 'No — unassigned. Assign an agent or group to enable a run.' };
  } else if (activeRun) {
    autoRun = { state: 'running', label: 'Running now (a run is active for this ticket).' };
  } else if (ticket.status === 'open' && ticketRuns.length === 0) {
    // Message-only: state stays 'no_target'. When the target is a group we can
    // name the most common concrete cause (no agents in the group) accurately
    // from memberCount; otherwise stay generic rather than speculate.
    autoRun = {
      state: 'no_target',
      label: isGroup && memberCount === 0
        ? 'No run started: this group has no agents. Add agents to the group to enable a run.'
        : 'No run started yet for the assigned target. Check the agent or group configuration.'
    };
  } else if (ticket.status === 'open') {
    autoRun = { state: 'auto', label: 'Will start a run automatically (ticket is open and assigned).' };
  } else {
    autoRun = { state: 'manual', label: 'No — ticket is not open. Use Rerun to start a new run.' };
  }

  let group = null;
  if (isGroup) {
    const items = allocationPlan && Array.isArray(allocationPlan.items) ? allocationPlan.items : [];
    group = {
      memberCount,
      workUnitsTotal: items.length,
      workUnitsCompleted: items.filter(item => item.status === 'completed').length,
      workUnitsFailed: items.filter(item => item.status === 'failed').length
    };
  }

  const visibleRun = activeRun || latestRun;
  let currentMessage = { text: null, source: 'unavailable' };
  if (visibleRun) {
    const logsForRun = readLogs().filter(log => log.runId === visibleRun.id);
    const result = getRunCurrentMessageWithSource(visibleRun, new Map([[visibleRun.id, logsForRun]]));
    currentMessage = { text: result.message, source: result.message ? result.source : 'unavailable' };
  }

  const lastOutcome = latestRun ? classifyRunOperationalOutcome(latestRun) : null;
  const lastOutcomeLabel = latestRun ? displayOperationalOutcome(lastOutcome, getRunMutationCount(latestRun)) : null;

  return {
    isGroup,
    assignmentTargetType: ticket.assignmentTargetType,
    assignmentTargetId: ticket.assignmentTargetId || null,
    assignmentTargetName,
    assignmentTargetLabel,
    assignmentMode,
    assignmentModeLabel,
    autoRun,
    blocked,
    blockedReason,
    activeRun: activeRun ? { id: activeRun.id, status: activeRun.status } : null,
    latestRun: latestRun ? { id: latestRun.id, status: latestRun.status } : null,
    lastOutcomeLabel,
    currentMessage,
    group
  };
}

function detectRunStateInconsistency(run, {
  logs = [],
  events = null,
  replaySnapshot = null,
  recentEventSummary: suppliedEventSummary = null
} = {}) {
  if (!run || !['pending', 'running', 'in_progress'].includes(run.status)) return null;

  const runLogs = Array.isArray(logs) ? logs.filter(log => log && log.runId === run.id) : [];
  const runEvents = Array.isArray(events) ? events.filter(event => event && event.runId === run.id) : getRunEvents(run.id);
  const snapshot = replaySnapshot || readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const eventSummary = suppliedEventSummary || recentEventSummary(run.id);
  const providerRequestCount = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0;
  const modelResponseCount = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0;
  const replayWorkspaceCount = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0;
  const hasNoReplayExecution = providerRequestCount === 0 && modelResponseCount === 0;
  const reasons = [];

  const hasLegacyTerminalLog = runLogs.some(log =>
    log.type === 'run:skip_terminal' ||
    /Run already in terminal state \(legacy\)/i.test(String(log.message || ''))
  );
  const hasTerminalEvent = runEvents.some(event =>
    ['run.completed', 'run.failed', 'run.interrupted', 'run.terminalized'].includes(event.type)
  );
  if (hasNoReplayExecution && (hasLegacyTerminalLog || hasTerminalEvent)) {
    reasons.push('Terminal legacy event appears on a running run.');
  }

  const hasResumePriorEvents = runLogs.some(log => {
    if (log.type !== 'run:resume_check') return false;
    const message = String(log.message || '');
    const match = message.match(/Resumable state detected:\s+(\d+)\s+prior events/i);
    return match ? parseInt(match[1], 10) > 0 : /prior events/i.test(message);
  });
  if (hasNoReplayExecution && hasResumePriorEvents) {
    reasons.push('Resume detected prior events before any provider request.');
  }

  if (eventSummary && eventSummary.latestWorkspaceMutation && replayWorkspaceCount === 0) {
    reasons.push('Event-derived mutation exists but replay has no workspace operations.');
  }

  const runCreatedAtMs = Date.parse(run.createdAt || '');
  if (!Number.isNaN(runCreatedAtMs)) {
    const hasOlderRunEvidence = [...runEvents, ...runLogs].some(item => {
      const timestamp = item.ts || item.timestamp;
      const timestampMs = Date.parse(timestamp || '');
      return !Number.isNaN(timestampMs) && timestampMs < runCreatedAtMs;
    });
    if (hasOlderRunEvidence && (hasLegacyTerminalLog || hasTerminalEvent || hasResumePriorEvents || (eventSummary && eventSummary.latestWorkspaceMutation))) {
      reasons.push('Run evidence predates the current run creation time.');
    }
  }

  if (!hasNoReplayExecution && replayWorkspaceCount > 0) {
    return null;
  }

  const uniqueReasons = [...new Set(reasons)];
  if (uniqueReasons.length === 0) return null;

  return {
    message: 'State inconsistency detected: this run’s evidence includes events from before this run (often left over from an earlier reset). Review reset/run history before relying on this run’s status.',
    reasons: uniqueReasons
  };
}

function enrichTicketForDisplay(ticket, context) {
  const target = ticket.assignmentTargetType === 'agent'
    ? context.agents.find(agent => agent.id === ticket.assignmentTargetId)
    : context.agentGroups.find(group => group.id === ticket.assignmentTargetId);
  const ticketRuns = context.runsByTicketId.get(ticket.id) || [];
  const activeRuns = ticketRuns.filter(run => ['pending', 'running'].includes(run.status));
  const lastRun = ticketRuns
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
  const lastRunPartialMutationCount = lastRun ? (context.mutationCountByRunId.get(lastRun.id) || 0) : 0;
  const primaryActiveRun = activeRuns
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
  const currentRunDisplayState = primaryActiveRun ? getRunDisplayState(primaryActiveRun, context.logsByRunId) : null;
  // For an active run show its live message; otherwise, for a terminally
  // failed/interrupted ticket, surface the last run's failure reason (the same
  // source Ticket Detail and Run Detail use) so the list card explains why,
  // not just that it failed. Display-only; does not affect execution or retry.
  const currentMessage = primaryActiveRun
    ? getRunCurrentMessage(primaryActiveRun, context.logsByRunId)
    : (lastRun && ['failed', 'interrupted'].includes(lastRun.status)
        ? getRunCurrentMessage(lastRun, context.logsByRunId)
        : null);
  const lastRunOperationalOutcome = lastRun ? classifyRunOperationalOutcome(lastRun) : null;
  const groupMemberCount = ticket.assignmentTargetType === 'group' && context.groupMembersById
    ? (context.groupMembersById[ticket.assignmentTargetId] || []).length
    : null;

  // Display-only compact execution summary for the card. Describes existing
  // runtime behavior; does not change scheduling or assignment.
  const ticketBlocked = ticket.status === 'blocked' || Boolean(ticket.blockedReason);
  const hasRunnableTarget = ticket.assignmentTargetType === 'group'
    ? (groupMemberCount || 0) > 0
    : Boolean(target);
  let executionSummaryLabel = null;
  if (ticketBlocked) executionSummaryLabel = 'blocked';
  else if (ticket.status === 'open' && hasRunnableTarget) executionSummaryLabel = 'will run automatically';
  else if (ticket.status === 'open' && ticket.assignmentTargetType === 'group') executionSummaryLabel = 'open — group has no agents';
  else if (ticket.status === 'completed') executionSummaryLabel = 'completed — rerun available';
  else if (ticket.status === 'failed') executionSummaryLabel = 'failed — retry available';

  return {
    ...ticket,
    assignmentTargetName: target ? target.name : null,
    groupMemberCount,
    executionSummaryLabel,
    latestRunId: lastRun ? lastRun.id : null,
    latestRunStatus: lastRun ? lastRun.status : null,
    activeRunIds: activeRuns.map(run => run.id),
    currentRunId: primaryActiveRun ? primaryActiveRun.id : null,
    currentRunDisplayState,
    currentRunDisplayLabel: currentRunDisplayState ? currentRunDisplayState.label : null,
    currentRunElapsedMs: currentRunDisplayState ? currentRunDisplayState.elapsedMs : null,
    currentRunTimeoutLimit: currentRunDisplayState ? currentRunDisplayState.timeoutLimit : formatDurationHuman(getAgentRuntimeLimits().maxRuntimeDurationMs),
    currentRunState: currentRunDisplayState ? currentRunDisplayState.state : null,
    currentRunStartedAt: primaryActiveRun ? primaryActiveRun.startedAt || null : null,
    currentRunCreatedAt: primaryActiveRun ? primaryActiveRun.createdAt || null : null,
    currentMessage,
    lastOutputMessage: currentMessage,
    lastRunStatus: lastRun ? lastRun.status : null,
    lastRunOperationalOutcome,
    lastRunOperationalOutcomeLabel: displayOperationalOutcome(lastRunOperationalOutcome, lastRunPartialMutationCount),
    lastRunPartialMutationCount,
    lastRunHadPartialMutations: lastRunPartialMutationCount > 0
  };
}

function ticketsPageHref(page, limit) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  return `/tickets?${params.toString()}`;
}

function getPaginatedTickets(query = {}) {
  const { page, limit } = getPagination(query, 25);
  const allTickets = readTickets()
    .slice()
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const agents = readAgents();
  const agentGroups = getTicketAssignableGroups();
  const runs = readRuns();
  const logs = readLogs();
  const history = readOperationHistory();
  const runsByTicketId = groupBy(runs, run => run.ticketId);
  const logsByRunId = groupBy(logs, log => log.runId);
  const mutationCountByRunId = buildMutationCountByRunId(history);
  const groupMembersById = getAgentGroupMembers();
  const total = allTickets.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * limit;
  const pageTickets = allTickets
    .slice(offset, offset + limit)
    .map(ticket => enrichTicketForDisplay(ticket, {
      agents,
      agentGroups,
      runsByTicketId,
      logsByRunId,
      mutationCountByRunId,
      groupMembersById
    }));

  return {
    tickets: pageTickets,
    pagination: {
      page: currentPage,
      limit,
      total,
      pageCount,
      start: total === 0 ? 0 : offset + 1,
      end: Math.min(offset + pageTickets.length, total),
      previousHref: currentPage > 1 ? ticketsPageHref(currentPage - 1, limit) : null,
      nextHref: currentPage < pageCount ? ticketsPageHref(currentPage + 1, limit) : null
    }
  };
}

function getRunMutationCount(run) {
  if (run && run.mutationCount !== undefined) return run.mutationCount;
  if (run && run.replaySummary && run.replaySummary.mutationCount !== undefined) return run.replaySummary.mutationCount;
  if (run && run.replaySnapshot && run.replaySnapshot.mutationCount !== undefined) return run.replaySnapshot.mutationCount;
  return run ? countRunMutatingOperations(run.id) : 0;
}

function classifyRunOperationalOutcome(run) {
  if (!run) return null;
  const snapshot = run.replaySnapshot || {};
  const summary = run.replaySummary || extractReplaySummary(snapshot) || {};
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];

  if (summary.hasBlockedOrRejected || workspaceOperations.some(item => item && (item.blocked || item.reason))) return 'blocked/rejected';
  if (run.status === 'interrupted') return 'interrupted';

  if (run.status === 'completed') {
    if (summary.hasPostconditionCompleted || events.some(event => event && event.type === 'run:postcondition_completed')) return 'completed_with_verified_postcondition';
    if (getRunMutationCount(run) > 0) return 'completed_with_mutations';
    if (workspaceOperations.some(item =>
      (item.result && item.result.status === 'not_found') ||
      (item.error && /not_found|enoent/i.test(item.error))
    )) return 'impossible_within_boundary';
    if (summary.hasCompletedNoop || events.some(event => event && event.type === 'run:completed_noop')) return 'completed_noop';
    return 'completed_noop';
  }

  if (run.status === 'failed') return 'failed_execution';
  return run.status || 'unknown';
}

const ALLOWANCE_MAP = {
  allowed_by_op: { allowed: true, type: 'allow', label: 'Operation permitted' },
  allowed_by_budget: { allowed: true, type: 'allow', label: 'Mutating budget available' },
  allowed_noop: { allowed: true, type: 'noop', label: 'No-op (already in desired state)' },
  blocked_sensitive_path: { allowed: false, type: 'block', label: 'Sensitive application path' },
  blocked_protected_path: { allowed: false, type: 'block', label: 'Protected path' },
  blocked_ownership: { allowed: false, type: 'block', label: 'Outside owned scope' },
  blocked_budget: { allowed: false, type: 'block', label: 'Budget exhausted' },
  blocked_unsupported_op: { allowed: false, type: 'block', label: 'Operation not permitted' },
  blocked_malformed: { allowed: false, type: 'block', label: 'Malformed action' },
  blocked_ownership_no_mutation: { allowed: false, type: 'block', label: 'Outside owned scope' },
  blocked_run_interrupted: { allowed: false, type: 'block', label: 'Run interrupted' }
};

function classifyOperationAllowance(source) {
  if (!source) return ALLOWANCE_MAP.blocked_malformed;

  // Snapshot workspace operation shape: { operation: { operation, args }, result, error, ... }
  // History record shape: { operation, args, result, error, ... }
  const opName = source.operation && typeof source.operation === 'object' ? source.operation.operation : source.operation;
  const err = source.error;
  const result = source.result;

  if (err) {
    const code = typeof err === 'string' ? err : (err.code || '');
    const msg = typeof err === 'string' ? err : (err.message || '');

    // Classify by error code (preferred path)
    if (code === 'WORKSPACE_SENSITIVE_PATH') return ALLOWANCE_MAP.blocked_sensitive_path;
    if (code === 'WORKSPACE_PROTECTED_PATH') return ALLOWANCE_MAP.blocked_protected_path;
    if (code === 'WORKSPACE_OWNERSHIP_VIOLATION') return ALLOWANCE_MAP.blocked_ownership;
    if (code === 'RUN_LIMIT_EXCEEDED') return ALLOWANCE_MAP.blocked_budget;
    if (code === 'WORKSPACE_MALFORMED_ACTION') return ALLOWANCE_MAP.blocked_malformed;
    if (code === 'WORKSPACE_UNSUPPORTED_OPERATION') return ALLOWANCE_MAP.blocked_unsupported_op;
    if (code === 'RUN_INTERRUPTED') return ALLOWANCE_MAP.blocked_run_interrupted;

    // Backward-compatible message fallback for legacy records
    // stored before error codes were added
    if (msg.includes('sensitive application path')) return ALLOWANCE_MAP.blocked_sensitive_path;
    if (msg.includes('protected workspace path')) return ALLOWANCE_MAP.blocked_protected_path;
    if (msg.includes('outside owned output paths')) return ALLOWANCE_MAP.blocked_ownership;
    if (msg.includes('limit')) return ALLOWANCE_MAP.blocked_budget;
    if (msg.includes('Unsupported workspace operation') || msg.includes('unsupported field') || msg.includes('must be an object') || msg.includes('is required') || msg.includes('must be a string') || msg.includes('cannot be blank')) return ALLOWANCE_MAP.blocked_malformed;
    if (msg.includes('Run interrupted')) return ALLOWANCE_MAP.blocked_run_interrupted;
    return { allowed: false, type: 'block', label: 'Operation error' };
  }

  if (result && result.status) {
    if (result.status === 'already_exists_noop' || result.status === 'already_missing_noop') return ALLOWANCE_MAP.allowed_noop;
    if (result.status === 'not_found') return { allowed: true, type: 'noop', label: 'Target not found' };
  }

  if (opName && AGENT_MUTATING_OPERATIONS.includes(opName)) return ALLOWANCE_MAP.allowed_by_budget;
  return ALLOWANCE_MAP.allowed_by_op;
}

const ERROR_CODE_EXPLANATIONS = {
  WORKSPACE_SENSITIVE_PATH: 'Blocked because the path is a sensitive application file or directory.',
  WORKSPACE_PROTECTED_PATH: 'Blocked because the path is protected from agent mutation.',
  WORKSPACE_OWNERSHIP_VIOLATION: 'Blocked because the operation is outside the run owned scope.',
  RUN_LIMIT_EXCEEDED: 'Stopped because a bounded runtime limit was exceeded.',
  WORKSPACE_MALFORMED_ACTION: 'Rejected because the workspace action contract was malformed.',
  WORKSPACE_UNSUPPORTED_OPERATION: 'Rejected because the operation is not in the allowed action vocabulary.',
  WORKSPACE_ACTION_INTERRUPTED: 'Stopped because the run was interrupted during workspace execution.',
  RUN_INTERRUPTED: 'Stopped because an operator or runtime interruption ended the run.'
};

function explainErrorCode(code) {
  return ERROR_CODE_EXPLANATIONS[code] || 'The operation failed; inspect the payload for full details.';
}

function getErrorCodeFromSource(source) {
  if (!source) return null;
  const err = source.error || source.failure || null;
  if (err && typeof err === 'object' && err.code) return err.code;
  if (typeof err === 'string' && ERROR_CODE_EXPLANATIONS[err]) return err;
  if (source.code) return source.code;
  return null;
}

function getErrorMessageFromSource(source) {
  if (!source) return null;
  const err = source.error || source.failure || null;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') return err.message || err.reason || null;
  return source.reason || source.failureReason || null;
}

function buildOperationErrorInfo(source) {
  const code = getErrorCodeFromSource(source);
  const message = getErrorMessageFromSource(source);
  if (!code && !message) return null;
  return {
    code: code || 'OPERATION_ERROR',
    explanation: code ? explainErrorCode(code) : 'The operation failed; inspect the payload for full details.',
    message
  };
}

function displayWorkspaceRootLabel(executionWorkspaceType) {
  return executionWorkspaceType === 'scoped' ? 'scoped workspace' : 'workspace-root';
}

function sanitizeWorkspaceDisplayValue(value, executionWorkspaceType = 'main') {
  if (typeof value === 'string') {
    return value.split(WORKSPACE_ROOT).join(displayWorkspaceRootLabel(executionWorkspaceType));
  }
  if (Array.isArray(value)) return value.map(item => sanitizeWorkspaceDisplayValue(item, executionWorkspaceType));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeWorkspaceDisplayValue(item, executionWorkspaceType)]));
  }
  return value;
}

function createDisplaySnapshot(snapshot) {
  if (!snapshot) return null;
  return sanitizeWorkspaceDisplayValue(snapshot, snapshot.executionWorkspaceType || 'main');
}

function countBoundedTransitionRejections(snapshot) {
  const events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
  return events.filter(event => {
    const type = event && event.type ? event.type : '';
    return type.includes('limit') || type.includes('stalled') || type.includes('no_progress') || type.includes('blocked');
  }).length;
}

function describeFirstFailedOperation(source) {
  if (!source) return '-';
  const operation = source.operation && typeof source.operation === 'object' ? source.operation.operation : source.operation;
  const args = source.operation && typeof source.operation === 'object' ? source.operation.args : source.args;
  const pathValue = args && args.path ? ` ${args.path}` : '';
  return `${operation || 'operation'}${pathValue}`;
}

function describeWorkspaceAction(action) {
  if (!action || typeof action !== 'object') return null;
  const op = action.operation || 'action';
  const args = action.args || {};
  const target = args.nextPath ? `${args.path || ''} -> ${args.nextPath}` : args.path;
  return target ? `${op} ${target}` : op;
}

function buildMutationSummary(operationHistory) {
  return (operationHistory || [])
    .filter(record => record && AGENT_MUTATING_OPERATIONS.includes(record.operation))
    .map(record => describeWorkspaceAction({ operation: record.operation, args: record.args }))
    .filter(Boolean);
}

function buildOutputSatisfactionSummary(ticket) {
  const checks = buildObviousPostconditionChecks(ticket && ticket.objective);
  if (checks.length === 0) {
    return {
      label: 'not automatically checkable',
      satisfiedCount: 0,
      totalCount: 0,
      items: []
    };
  }

  const items = checks.map(check => ({
    type: check.type,
    path: check.path,
    satisfied: check.satisfied()
  }));
  const satisfiedCount = items.filter(item => item.satisfied).length;
  const totalCount = items.length;

  return {
    label: satisfiedCount === totalCount
      ? 'yes'
      : satisfiedCount > 0
        ? `partially (${satisfiedCount}/${totalCount})`
        : 'no',
    satisfiedCount,
    totalCount,
    items
  };
}

function buildRunFailureSummary(run, snapshot, operationHistory, mutationCount, recoveryAvailable) {
  if (!['failed', 'interrupted'].includes(run.status)) return null;

  const workspaceOps = snapshot && Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const parsedPlans = snapshot && Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const lastPlan = parsedPlans.length > 0 ? parsedPlans[parsedPlans.length - 1] : null;
  const firstFailedOperation = workspaceOps.find(op => op && (op.error || op.blocked || op.reason))
    || (operationHistory || []).find(record => record && record.error)
    || null;
  const snapshotFailure = snapshot && snapshot.failure ? snapshot.failure : null;
  const code = getErrorCodeFromSource(firstFailedOperation) || getErrorCodeFromSource(snapshotFailure) || (run.status === 'interrupted' ? 'RUN_INTERRUPTED' : null);
  const rootCause = (snapshot && snapshot.failureReason) || run.error || getErrorMessageFromSource(firstFailedOperation) || (code ? explainErrorCode(code) : 'Run ended without a structured failure reason.');
  const timedOut = code === 'RUN_LIMIT_EXCEEDED' && snapshotFailure && snapshotFailure.kind === 'timeout' || /runtime duration limit/i.test(rootCause);
  const finalBlockingReason = timedOut ? `timed out after ${formatDurationHuman(getAgentRuntimeLimits().maxRuntimeDurationMs)}` : rootCause;
  const limitType = snapshotFailure && snapshotFailure.detail ? snapshotFailure.detail.limitType : null;
  const stepLimitWithMutations = code === 'RUN_LIMIT_EXCEEDED' && limitType === 'step' && (mutationCount || 0) > 0;
  const ticket = run && run.ticketId ? readTickets().find(item => item.id === run.ticketId) : null;

  return {
    status: run.status,
    statusLabel: displayRunStatus(run.status),
    rootCause: timedOut ? 'timed out' : rootCause,
    blockingErrorCode: code || '-',
    blockingErrorExplanation: code ? explainErrorCode(code) : '-',
    finalBlockingReason,
    firstFailedOperation: describeFirstFailedOperation(firstFailedOperation),
    mutationCount: mutationCount || 0,
    mutationSummary: buildMutationSummary(operationHistory),
    mutationsBeforeFailure: (mutationCount || 0) > 0,
    recoveryAvailable: recoveryAvailable === true,
    boundedTransitionRejectionCount: countBoundedTransitionRejections(snapshot),
    lastModelMessage: lastPlan && lastPlan.message ? lastPlan.message : '-',
    lastProposedActions: lastPlan && Array.isArray(lastPlan.actions)
      ? lastPlan.actions.map(describeWorkspaceAction).filter(Boolean)
      : [],
    outputSatisfaction: buildOutputSatisfactionSummary(ticket),
    retryGuidance: stepLimitWithMutations
      ? 'Run hit the step limit after successful workspace changes. Review mutations before retrying; a retry starts from the current workspace state.'
      : null
  };
}

// Display-only: explains why a run stopped/completed and what evidence supports
// it. Reads existing events/snapshot only; does not change runtime behavior.
function buildRunCompletionSummary(run, snapshot, runEvents, operationHistory, failureSummary) {
  const snapEvents = snapshot && Array.isArray(snapshot.events) ? snapshot.events : [];
  const logEvents = Array.isArray(runEvents) ? runEvents : [];
  const findSnap = type => snapEvents.find(event => event && event.type === type) || null;
  const findLog = type => logEvents.find(event => event && event.type === type) || null;
  // recordRunEvent flattens details onto the snapshot event; appendEvent nests
  // them under .payload. Read either shape.
  const detail = (event, key) => {
    if (!event) return undefined;
    if (event[key] !== undefined) return event[key];
    if (event.payload && event.payload[key] !== undefined) return event.payload[key];
    return undefined;
  };

  const evidence = {
    providerRequests: snapshot && Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0,
    modelResponses: snapshot && Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0,
    workspaceOperations: snapshot && Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0,
    operationHistory: Array.isArray(operationHistory) ? operationHistory.length : 0,
    replayEvents: snapEvents.length
  };

  // Per-response action-cap note (truncation or suppression), if it occurred.
  const truncated = findSnap('model:mutating_action_truncated') || findLog('action.truncated');
  const suppressed = findSnap('model:mutating_action_limit') || findLog('action.suppressed');
  const deferred = findSnap('run:completion_deferred_truncation');
  let capNote = null;
  if (truncated) {
    const proposed = detail(truncated, 'mutatingActionCount') ?? detail(truncated, 'mutatingCount');
    const limit = detail(truncated, 'maxMutatingActionsPerResponse') ?? detail(truncated, 'limit') ?? MAX_MUTATING_ACTIONS_PER_RESPONSE;
    const executed = detail(truncated, 'executedCount');
    const dropped = detail(truncated, 'truncatedCount');
    capNote = `Action cap applied: model proposed ${proposed} mutating action(s); runtime limit is ${limit}. Response was truncated (executed ${executed}, dropped ${dropped}) and the run continued.` +
      (deferred ? ' complete:true was not honored for that response until the dropped actions were applied.' : '');
  } else if (suppressed) {
    const proposed = detail(suppressed, 'mutatingActionCount') ?? detail(suppressed, 'mutatingCount');
    const limit = detail(suppressed, 'maxMutatingActionsPerResponse') ?? detail(suppressed, 'limit') ?? MAX_MUTATING_ACTIONS_PER_RESPONSE;
    capNote = `Action cap applied: model proposed ${proposed} mutating action(s); runtime limit is ${limit}. An over-cap model response was suppressed and not treated as completed; the run continued.`;
  }

  let source = 'unknown';
  let label = 'Run state could not be classified from available evidence.';
  let checkedPaths = [];
  let timeoutNote = null;
  let modelCallNote = null;
  let progressNote = null;

  if (run.status === 'failed' || run.status === 'interrupted') {
    source = run.status;
    label = run.status === 'interrupted'
      ? 'Run was interrupted before it completed.'
      : 'Run failed before completion.';
    if (failureSummary && failureSummary.rootCause) label += ' Root cause: ' + failureSummary.rootCause;

    const timedOut = failureSummary && failureSummary.rootCause === 'timed out';
    if (timedOut) {
      const latestPhase = evidence.providerRequests > evidence.modelResponses
        ? 'waiting for model response'
        : 'runtime timeout';
      timeoutNote = `Run timed out after ${formatDurationHuman(getAgentRuntimeLimits().maxRuntimeDurationMs)}. Latest observed phase: ${latestPhase}.`;
      if (evidence.providerRequests > evidence.modelResponses) {
        timeoutNote += ' Available evidence suggests the run timed out after the last model request and before a matching model response was recorded.';
      }
    }

    if (evidence.providerRequests !== evidence.modelResponses) {
      modelCallNote = `Model calls: ${evidence.providerRequests} request(s), ${evidence.modelResponses} response(s).`;
      if (evidence.providerRequests > evidence.modelResponses) {
        modelCallNote += ' Last request had no recorded response before timeout.';
      }
    }

    const progressCount = Math.max(evidence.workspaceOperations, evidence.operationHistory);
    if (progressCount > 0) {
      progressNote = `Workspace progress before failure: ${progressCount} action(s).`;
    }
  } else if (run.status === 'completed') {
    const postcondition = findSnap('run:postcondition_completed');
    if (postcondition) {
      source = 'postcondition';
      label = 'Completed: required postconditions verified — declared postconditions only; not independently verified against the full ticket objective.' + (postcondition.message ? ' ' + postcondition.message : (postcondition.reason ? ' ' + postcondition.reason : ''));
      if (Array.isArray(postcondition.checkedPaths)) checkedPaths = postcondition.checkedPaths;
    } else if (findSnap('workspace.objective_satisfied')) {
      source = 'workspace_objective';
      label = 'Completed — agent workspace changes were applied (not independently verified against the full ticket objective).';
    } else if (findSnap('workflow.draft_objective_satisfied')) {
      source = 'workflow_draft';
      label = 'Completed — workflow draft output was produced (not independently verified against the full ticket objective).';
    } else if (findSnap('run:completed_noop')) {
      source = 'completed_noop';
      label = 'Completed with no workspace changes (model reported complete with no actions).';
    } else {
      source = 'model_complete';
      label = 'Completed. The available run evidence points to a model complete:true completion; no more specific postcondition event was captured.';
    }
  } else {
    source = 'in_progress';
    label = 'Run is ' + run.status + '.';
  }

  return { state: run.status, source, label, checkedPaths, capNote, timeoutNote, modelCallNote, progressNote, evidence };
}

function buildRunAuthorityContext(run, ticket, agent, snapshot) {
  const s = snapshot || {};
  const allocationItem = getRunAllocationItem(run);
  const allocationPlanId = run.allocationPlanId || s.allocationPlanId || null;
  const allocationItemId = run.allocationItemId || s.allocationItemId || null;
  const ownedOutputPaths = getRunOwnedOutputPaths(run);
  const limits = getAgentRuntimeLimits();
  const groups = readGroups();
  const agentGroupNames = agent
    ? getPrincipalGroupIds('agent', agent.id).map(groupId => (groups.find(group => group.id === groupId) || {}).name).filter(Boolean)
    : [];
  const assignmentGroup = ticket && ticket.assignmentTargetType === 'group'
    ? groups.find(group => group.id === ticket.assignmentTargetId)
    : null;
  const executionWorkspaceType = run.executionWorkspaceType || s.executionWorkspaceType || 'main';

  return {
    principal: {
      agentId: run.agentId,
      agentName: agent ? agent.name : (run.agentName || s.agentNameSnapshot || 'Unknown'),
      allocationPlanId,
      allocationItemId,
      allocationSubtask: run.allocationSubtask || s.allocationSubtask || null,
      ownedOutputPaths: ownedOutputPaths.length > 0 ? ownedOutputPaths : (Array.isArray(s.ownedOutputPaths) ? s.ownedOutputPaths : [])
    },
    authority: {
      allowedOperations: (s.primitiveContract && s.primitiveContract.allowedOperations) || AGENT_ALLOWED_OPERATIONS,
      mutatingOperations: (s.primitiveContract && s.primitiveContract.mutatingOperations) || AGENT_MUTATING_OPERATIONS,
      maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
      maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
      maxSteps: limits.maxExecutionSteps,
      maxWorkspaceOperations: limits.maxWorkspaceOperationsPerRun,
      maxModelRequests: limits.maxModelRequestsPerRun,
      maxRuntimeDurationMs: limits.maxRuntimeDurationMs,
      provider: s.provider || (agent ? agent.provider : null) || '-',
      model: s.model || (agent ? agent.model : null) || '-',
      executionWorkspaceType,
      workspaceRoot: displayWorkspaceRootLabel(executionWorkspaceType)
    },
    provenance: {
      assignment: assignmentGroup
        ? `Granted via ticket assignment group "${assignmentGroup.name}"`
        : 'Granted via direct ticket assignment',
      groups: agentGroupNames.length > 0 ? agentGroupNames.join(', ') : 'No agent group grant recorded',
      runtimePolicy: 'Default bounded workspace runtime policy',
      scope: allocationPlanId ? 'Owned-scope allocation plan' : 'Direct assignment workspace scope'
    },
    controls: {
      interruptible: ['pending', 'running'].includes(run.status),
      recoverable: run.status === 'failed' || run.status === 'interrupted',
      replayAvailable: !!snapshot,
      recoveryAvailable: null
    }
  };
}

function broadcastTicketChange() {
  const event = `event: tickets-changed\ndata: ${JSON.stringify({ updatedAt: new Date().toISOString() })}\n\n`;
  ticketEventClients.forEach(client => {
    try {
      client.write(event);
    } catch (error) {
      ticketEventClients.delete(client);
    }
  });
}

function broadcastLogEntry(log) {
  const event = `event: log\ndata: ${JSON.stringify(sanitizeWorkspaceDisplayValue(log))}\n\n`;
  logEventClients.forEach(client => {
    try {
      client.write(event);
    } catch (error) {
      logEventClients.delete(client);
    }
  });
}

function sanitizeLogMessage(message) {
  return String(message || '').replace(/sk-[A-Za-z0-9_*\-]+/g, '[redacted-api-key]');
}

function formatDurationHuman(ms) {
  const value = Math.max(0, parseInt(ms, 10) || 0);
  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 1) return 'under 1 second';
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds} second${seconds === 1 ? '' : 's'}`;
}

function displayRunStatus(status) {
  if (status === 'pending') return 'queued';
  if (status === 'running') return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'stopped';
  return status || 'unknown';
}

function displayOperationalOutcome(outcome, mutationCount = 0) {
  if (!outcome) return null;
  const labels = {
    'blocked/rejected': 'blocked',
    interrupted: 'stopped',
    completed_with_verified_postcondition: 'completed — postconditions checked',
    completed_with_mutations: 'completed — changes applied',
    completed_noop: 'completed — no workspace change needed',
    impossible_within_boundary: 'could not complete in workspace',
    failed_execution: mutationCount > 0 ? 'failed after partial work' : 'failed',
    running: 'running',
    pending: 'queued'
  };
  return labels[outcome] || outcome;
}

function displayLogType(type) {
  const labels = {
    'run:created': 'run created',
    'run:queued': 'queued',
    'run:started': 'started',
    'run:timeout': 'timed out',
    'run:failed': 'failed',
    'run:completed': 'completed',
    'run:capability_started': 'workflow started',
    'run:capability_completed': 'workflow completed',
    'run:postcondition_completed': 'postconditions checked',
    'model:request': 'waiting on model',
    'model:response': 'model response',
    'model:no_progress': 'no progress',
    'workspace:list': 'workspace action',
    'workspace:read': 'workspace action',
    'workspace:create': 'workspace action',
    'workspace:write': 'workspace action',
    'workspace:delete': 'workspace action',
    'workspace:rename': 'workspace action'
  };
  return labels[type] || String(type || '').replace(/:/g, ' ');
}

function displayLogMessage(log) {
  if (!log) return '';
  if (log.type === 'run:timeout') return `Timed out after ${formatDurationHuman(getAgentRuntimeLimits().maxRuntimeDurationMs)}`;
  if (log.type === 'run:failed' && /runtime duration limit/i.test(log.message || '')) return `Failed after timing out at ${formatDurationHuman(getAgentRuntimeLimits().maxRuntimeDurationMs)}`;
  if (log.type === 'model:request') return 'Waiting for model response';
  if (log.type === 'model:no_progress') return 'The model repeated an inspection without making progress';
  if (log.type === 'run:queued') return 'Waiting to start';
  if (log.type === 'run:capability_started') return String(log.message || '').replace(/^Capability started:/, 'Workflow started:');
  if (log.type === 'run:capability_completed') return String(log.message || '').replace(/^Capability completed:/, 'Workflow completed:');
  return log.message || '';
}

function isSensitiveSnapshotKey(key) {
  const lowerKey = String(key || '').toLowerCase();

  return lowerKey === 'authorization' ||
    lowerKey === 'api_key' ||
    lowerKey === 'apikey' ||
    lowerKey === 'api-key' ||
    lowerKey === 'secret' ||
    lowerKey.endsWith('_secret') ||
    lowerKey.endsWith('-secret') ||
    lowerKey === 'token' ||
    lowerKey === 'access_token' ||
    lowerKey === 'refresh_token' ||
    lowerKey === 'id_token' ||
    lowerKey.endsWith('_token') && !lowerKey.endsWith('_tokens') ||
    lowerKey.endsWith('-token') && !lowerKey.endsWith('-tokens');
}

function sanitizeSnapshotValue(value) {
  if (typeof value === 'string') return sanitizeLogMessage(value);
  if (Array.isArray(value)) return value.map(item => sanitizeSnapshotValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      return [key, isSensitiveSnapshotKey(key) ? '[redacted]' : sanitizeSnapshotValue(item)];
    }));
  }

  return value;
}

function createLogTimestamp() {
  const wallClockNs = BigInt(Date.now()) * 1000000n;
  const highPrecisionRemainderNs = process.hrtime.bigint() % 1000000n;
  let timestampNs = wallClockNs + highPrecisionRemainderNs;

  if (timestampNs <= lastLogTimestampNs) {
    timestampNs = lastLogTimestampNs + 1n;
  }

  lastLogTimestampNs = timestampNs;

  const timestampMs = timestampNs / 1000000n;
  const fractionalNs = timestampNs % 1000000000n;
  const baseIso = new Date(Number(timestampMs)).toISOString().replace(/\.\d{3}Z$/, '');

  return `${baseIso}.${fractionalNs.toString().padStart(9, '0')}Z`;
}

let eventAppendChain = Promise.resolve();
let pendingEventBuffer = [];

// Per-run event chain state for forensic sequence numbers and hash chaining
const runEventChains = new Map(); // runId -> { seq: number, prevHash: string | null }

function normalizeEventId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : crypto.randomUUID();
}

function computeEventHash(event) {
  // Canonical content excludes mutable/transient forensic metadata (id, ts, seq, prevHash)
  const canonical = {
    type: event.type,
    ticketId: event.ticketId,
    runId: event.runId,
    stepId: event.stepId,
    payload: event.payload
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');
}

function normalizeNullableInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function appendEvent(event = {}) {
  const normalized = {
    id: normalizeEventId(event.id),
    ts: typeof event.ts === 'string' && event.ts.trim() ? event.ts : createLogTimestamp(),
    type: typeof event.type === 'string' && event.type.trim() ? event.type.trim() : 'event',
    ticketId: normalizeNullableInteger(event.ticketId),
    runId: normalizeNullableInteger(event.runId),
    stepId: event.stepId === undefined || event.stepId === null ? null : String(event.stepId),
    payload: sanitizeSnapshotValue(event.payload && typeof event.payload === 'object' ? event.payload : {})
  };

  // Add forensic sequence number and hash chain for run events
  if (normalized.runId !== null) {
    const runId = normalized.runId;
    const chain = runEventChains.get(runId) || { seq: 0, prevHash: null };
    normalized.seq = chain.seq;
    normalized.prevHash = chain.prevHash;
    // Advance chain for next event: current hash becomes previous for next
    const currentHash = computeEventHash(normalized);
    runEventChains.set(runId, {
      seq: chain.seq + 1,
      prevHash: currentHash
    });
  }

  const line = `${JSON.stringify(normalized)}\n`;

  pendingEventBuffer.push(normalized);
  eventAppendChain = eventAppendChain
    .then(() => {
      // Skip write if this event was already flushed synchronously
      // (e.g. by maybeTestInterrupt before SIGKILL).  The synchronous
      // flush removes events from pendingEventBuffer, so the buffer
      // membership check acts as a "was this already written?" guard.
      if (!pendingEventBuffer.some(event => event.id === normalized.id)) return;
      return new Promise((resolve, reject) => {
        fs.appendFile(EVENTS_FILE, line, 'utf8', error => {
          if (error) reject(error);
          else resolve();
        });
      });
    })
    .then(() => {
      pendingEventBuffer = pendingEventBuffer.filter(event => event.id !== normalized.id);
    })
    .catch(error => {
      console.error(`Failed to append event ${normalized.type}: ${error.message}`);
    });

  return normalized;
}

function readEvents() {
  let persistedEvents = [];
  if (!fs.existsSync(EVENTS_FILE)) return pendingEventBuffer.slice();

  try {
    persistedEvents = fs.readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          const event = JSON.parse(line);
          return event && typeof event === 'object' ? event : null;
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    persistedEvents = [];
  }

  const persistedIds = new Set(persistedEvents.map(event => event.id));
  const result = [
    ...persistedEvents,
    ...pendingEventBuffer.filter(event => !persistedIds.has(event.id))
  ];
  return result;
}

// Merge persisted matches with not-yet-flushed buffered events under the same
// predicate, preserving persisted-then-buffered order. This mirrors the old
// readEvents() composition (persisted events followed by buffer entries not yet
// on disk) that these bounded readers replaced.
function readBufferedAndMatchingEvents({ needles, predicate }) {
  const persisted = readMatchingEvents(EVENTS_FILE, { needles, predicate });
  const persistedIds = new Set(persisted.map(event => event.id));
  const buffered = pendingEventBuffer.filter(event => !persistedIds.has(event.id) && predicate(event));
  return [...persisted, ...buffered];
}

function getRunEvents(runId) {
  const parsedRunId = parseInt(runId, 10);
  if (Number.isNaN(parsedRunId)) return [];
  const run = readRuns().find(item => item.id === parsedRunId) || null;
  const ticketId = run ? run.ticketId : null;
  // Raw-line prefilter: only run-id matches or (for the ticket-scoped branch)
  // ticket-id matches can satisfy the predicate, so lines containing neither
  // needle are skipped without parsing. The exact predicate runs after parse.
  const needles = [`"runId":${parsedRunId}`];
  if (Number.isInteger(ticketId)) needles.push(`"ticketId":${ticketId}`);
  return readBufferedAndMatchingEvents({
    needles,
    predicate: event =>
      event.runId === parsedRunId ||
      (run && event.runId === null && event.ticketId === ticketId)
  });
}

// Events for a single run scoped strictly by runId (excludes the ticket-scoped
// null-runId events that getRunEvents also returns).
function readRunScopedEvents(runId) {
  const parsedRunId = parseInt(runId, 10);
  if (Number.isNaN(parsedRunId)) return [];
  return readBufferedAndMatchingEvents({
    needles: [`"runId":${parsedRunId}`],
    predicate: event => event.runId === parsedRunId
  });
}

// `suppliedEvents`, when an array, is used instead of re-reading the event log.
// Callers that already hold getRunEvents(runId) for this run pass it in to avoid
// a redundant full-log scan. The result is identical to computing from a fresh
// getRunEvents(runId) read.
function recentEventSummary(runId, suppliedEvents = null) {
  const events = Array.isArray(suppliedEvents) ? suppliedEvents : getRunEvents(runId);
  const summary = {
    currentStep: null,
    latestStatus: null,
    latestError: null,
    latestWorkspaceMutation: null
  };
  const statusTypes = new Set(['run.created', 'run.queued', 'run.started', 'run.completed', 'run.failed', 'run.interrupted', 'run.execution_completed', 'run.terminalized']);

  events.forEach(event => {
    const payload = event.payload || {};

    if (statusTypes.has(event.type)) {
      summary.latestStatus = {
        type: event.type,
        status: payload.status || event.type.replace('run.', ''),
        ts: event.ts,
        message: payload.message || null
      };
    }

    if (event.type === 'workflow.step.started' || event.type === 'workflow.step.completed' || event.type === 'workflow.step.failed') {
      summary.currentStep = {
        stepId: event.stepId,
        action: payload.action || null,
        status: event.type.replace('workflow.step.', ''),
        workflowId: payload.workflowId || null,
        ts: event.ts
      };
    }

    if (event.type === 'run.failed' || event.type === 'run.terminalized' || event.type === 'workflow.step.failed') {
      summary.latestError = {
        message: payload.error || payload.message || null,
        code: payload.code || null,
        stepId: event.stepId,
        ts: event.ts
      };
    }

    if (event.type === 'workspace.operation' && payload.mutating === true) {
      summary.latestWorkspaceMutation = {
        operation: payload.operation || null,
        path: payload.path || null,
        result: payload.result || null,
        error: payload.error || null,
        stepId: event.stepId,
        ts: event.ts
      };
    }
  });

  return summary;
}

function isValidIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,9})?Z$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function appendRunLog(run, type, message, workspaceAction = null, extraFields = {}) {
  const logs = readLogs();
  const log = {
    id: nextId(logs),
    timestamp: createLogTimestamp(),
    runId: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    type,
    message: sanitizeLogMessage(message),
    workspaceAction,
    ...extraFields
  };

  logs.push(log);
  writeLogs(logs);
  broadcastLogEntry(log);
  broadcastTicketChange();
  return log;
}

function appendSystemLog(type, message, workspaceAction = null, extraFields = {}) {
  const logs = readLogs();
  const contextFields = { ...extraFields };
  if (Object.prototype.hasOwnProperty.call(contextFields, 'ticketId')) {
    contextFields.contextTicketId = contextFields.ticketId;
    delete contextFields.ticketId;
  }
  if (Object.prototype.hasOwnProperty.call(contextFields, 'runId')) {
    contextFields.contextRunId = contextFields.runId;
    delete contextFields.runId;
  }
  delete contextFields.agentId;
  delete contextFields.agentName;
  const log = {
    id: nextId(logs),
    timestamp: createLogTimestamp(),
    runId: null,
    ticketId: null,
    agentId: null,
    agentName: 'System',
    type,
    message: sanitizeLogMessage(message),
    workspaceAction,
    ...contextFields
  };

  logs.push(log);
  writeLogs(logs);
  broadcastLogEntry(log);
  return log;
}

function updateTicketStatusById(ticketId, status) {
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) return null;
  if (ticket.status === status) return ticket;

  ticket.status = status;
  ticket.updatedAt = new Date().toISOString();
  if (['completed', 'failed', 'interrupted'].includes(status)) {
    delete ticket.rerunMode;
  }
  writeTickets(tickets);
  appendEvent({
    type: 'ticket.updated',
    ticketId: ticket.id,
    payload: {
      status: ticket.status,
      updatedAt: ticket.updatedAt
    }
  });
  broadcastTicketChange();
  return ticket;
}

function readUsers() {
  return readJsonArrayCached(USERS_FILE);
}

function normalizeUsers(users) {
  const seenUserIds = new Set();

  return users.filter(user => {
    const userId = parseInt(user.id, 10);
    if (Number.isNaN(userId) || seenUserIds.has(userId)) return false;

    seenUserIds.add(userId);
    user.id = userId;
    user.type = 'user';
    return true;
  });
}

function writeUsers(users) {
  writeFileAtomic(USERS_FILE, JSON.stringify(normalizeUsers(users), null, 2));
}

function readGroups() {
  return readJsonArrayCached(GROUPS_FILE);
}

function normalizeGroups(groups) {
  const seenGroupIds = new Set();
  const validPermissions = new Set(readPermissions());

  return groups.reduce((normalized, group) => {
    const groupId = parseInt(group.id, 10);

    if (Number.isNaN(groupId) || seenGroupIds.has(groupId)) return normalized;

    seenGroupIds.add(groupId);
    const submittedPermissions = Array.isArray(group.permissions) ? group.permissions : [];

    const permissions = [];
    submittedPermissions.forEach(permission => {
      const normalizedPermission = String(permission || '').trim();
      if (normalizedPermission && validPermissions.has(normalizedPermission) && !permissions.includes(normalizedPermission)) {
        permissions.push(normalizedPermission);
      }
    });

    normalized.push({
      id: groupId,
      name: String(group.name || '').trim() || `Group ${groupId}`,
      permissions,
      canReceiveTickets: group.canReceiveTickets === true
    });

    return normalized;
  }, []);
}

function writeGroups(groups) {
  writeFileAtomic(GROUPS_FILE, JSON.stringify(normalizeGroups(groups), null, 2));
}

function readPermissions() {
  return readJsonArrayCached(PERMISSIONS_FILE);
}

function readMemberships() {
  return readJsonArrayCached(MEMBERSHIPS_FILE);
}

function normalizeMemberships(memberships) {
  const seenMemberships = new Set();
  const normalized = [];
  const userIds = new Set(readUsers().map(user => user.id));
  const agentIds = new Set(readAgents().map(agent => agent.id));
  const groupIds = new Set(readGroups().map(group => group.id));

  memberships.forEach(membership => {
    const principalType = membership.principalType === 'agent' ? 'agent' : 'user';
    const principalId = parseInt(membership.principalId ?? membership.userId, 10);
    const groupId = parseInt(membership.groupId, 10);

    if (Number.isNaN(principalId) || Number.isNaN(groupId) || !groupIds.has(groupId)) return;
    if (principalType === 'user' && !userIds.has(principalId)) return;
    if (principalType === 'agent' && !agentIds.has(principalId)) return;

    const membershipKey = `${principalType}:${principalId}:${groupId}`;
    if (seenMemberships.has(membershipKey)) return;

    seenMemberships.add(membershipKey);
    normalized.push({
      id: normalized.length + 1,
      principalType,
      principalId,
      groupId
    });
  });

  return normalized;
}

function writeMemberships(memberships) {
  writeFileAtomic(MEMBERSHIPS_FILE, JSON.stringify(normalizeMemberships(memberships), null, 2));
}

function normalizeSubmittedGroupIds(groupIds) {
  if (!groupIds) return [];

  const validGroupIds = new Set(readGroups().map(group => group.id));
  const submittedGroupIds = Array.isArray(groupIds) ? groupIds : [groupIds];
  const normalizedGroupIds = [];

  submittedGroupIds.forEach(groupId => {
    const normalizedGroupId = parseInt(groupId, 10);

    if (Number.isNaN(normalizedGroupId)) {
      throw new Error('Invalid group selection');
    }

    if (!validGroupIds.has(normalizedGroupId)) {
      throw new Error('Selected group does not exist');
    }

    if (!normalizedGroupIds.includes(normalizedGroupId)) {
      normalizedGroupIds.push(normalizedGroupId);
    }
  });

  return normalizedGroupIds;
}

function setPrincipalGroupMemberships(principalType, principalId, groupIds) {
  const normalizedPrincipalType = principalType === 'agent' ? 'agent' : 'user';
  const normalizedPrincipalId = parseInt(principalId, 10);

  if (Number.isNaN(normalizedPrincipalId)) {
    throw new Error('Account not found for group assignment');
  }

  if (normalizedPrincipalType === 'user' && !readUsers().some(user => user.id === normalizedPrincipalId)) {
    throw new Error('User account not found for group assignment');
  }

  if (normalizedPrincipalType === 'agent' && !readAgents().some(agent => agent.id === normalizedPrincipalId)) {
    throw new Error('Agent account not found for group assignment');
  }

  const normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  const existingMemberships = readMemberships().filter(membership =>
    membership.principalType !== normalizedPrincipalType || membership.principalId !== normalizedPrincipalId
  );
  const nextMemberships = normalizedGroupIds.map((groupId, index) => ({
    id: existingMemberships.length + index + 1,
    principalType: normalizedPrincipalType,
    principalId: normalizedPrincipalId,
    groupId
  }));

  writeMemberships([...existingMemberships, ...nextMemberships]);
}

function normalizeSubmittedPermissions(permissions) {
  if (!permissions) return [];

  const validPermissions = new Set(readPermissions());
  const submittedPermissions = Array.isArray(permissions) ? permissions : [permissions];
  const normalizedPermissions = [];

  submittedPermissions.forEach(permission => {
    const normalizedPermission = String(permission || '').trim();

    if (!normalizedPermission || !validPermissions.has(normalizedPermission)) {
      throw new Error('Invalid permission selection');
    }

    if (!normalizedPermissions.includes(normalizedPermission)) {
      normalizedPermissions.push(normalizedPermission);
    }
  });

  return normalizedPermissions;
}

function readAgents() {
  return readJsonArrayCached(AGENTS_FILE);
}

function normalizeAgents(agents) {
  const seenAgentIds = new Set();

  return agents.filter(agent => {
    const agentId = parseInt(agent.id, 10);
    if (Number.isNaN(agentId) || seenAgentIds.has(agentId)) return false;

    seenAgentIds.add(agentId);
    agent.id = agentId;
    agent.type = 'agent';
    agent.provider = PROVIDERS.includes(agent.provider) ? agent.provider : 'openai';
    return true;
  });
}

function writeAgents(agents) {
  writeFileAtomic(AGENTS_FILE, JSON.stringify(normalizeAgents(agents), null, 2));
}

function readRuns() {
  return readJsonArrayCached(RUNS_FILE);
}

function replaySnapshotRelativePath(runId) {
  return path.join('replay-snapshots', `run-${runId}.json`);
}

function replaySnapshotFilePath(runId) {
  return path.join(DATA_DIR, replaySnapshotRelativePath(runId));
}

function extractReplaySummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  const parsedModelPlans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests : [];
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];

  return {
    model: snapshot.model || null,
    terminalStatus: snapshot.terminalStatus || null,
    failureReason: snapshot.failureReason || null,
    failure: snapshot.failure || null,
    mutationCount: snapshot.mutationCount,
    mutationOutcome: snapshot.mutationOutcome || null,
    finalizedAt: snapshot.finalizedAt || null,
    continuationOf: snapshot.continuationOf || null,
    steps: parsedModelPlans.length,
    workspaceOperations: workspaceOperations.length,
    providerRequests: providerRequests.length,
    modelResponses: modelResponses.length,
    hasBlockedOrRejected: workspaceOperations.some(item => item && (item.blocked || item.reason || (item.operation && item.operation.blocked))),
    hasCompletedNoop: events.some(item => item && item.type === 'run:completed_noop'),
    hasPostconditionCompleted: events.some(item => item && item.type === 'run:postcondition_completed')
  };
}

function readRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return null;
  if (run.replaySnapshot && typeof run.replaySnapshot === 'object') return run.replaySnapshot;
  if (!run.replaySnapshotPath) return null;

  const snapshotPath = path.resolve(DATA_DIR, run.replaySnapshotPath);
  if (!snapshotPath.startsWith(DATA_DIR + path.sep)) return null;
  if (!fs.existsSync(snapshotPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function hydrateRunReplaySnapshot(run) {
  if (!run || typeof run !== 'object') return run;
  const replaySnapshot = readRunReplaySnapshot(run);
  return replaySnapshot ? { ...run, replaySnapshot } : { ...run };
}

function writeReplaySnapshotFile(runId, snapshot) {
  if (!fs.existsSync(REPLAY_SNAPSHOTS_DIR)) {
    fs.mkdirSync(REPLAY_SNAPSHOTS_DIR, { recursive: true });
  }

  const filePath = replaySnapshotFilePath(runId);
  writeFileAtomic(filePath, JSON.stringify(snapshot, null, 2));
  return replaySnapshotRelativePath(runId);
}

function attachReplayMetadata(run, snapshot) {
  const summary = extractReplaySummary(snapshot);
  run.replaySnapshotPath = replaySnapshotRelativePath(run.id);
  run.replaySummary = summary;
  if (summary && summary.mutationCount !== undefined) run.mutationCount = summary.mutationCount;
  if (summary && summary.mutationOutcome) run.mutationOutcome = summary.mutationOutcome;
  delete run.replaySnapshot;
  return run;
}

function writeRunReplaySnapshot(runId, snapshot) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);

  if (!run) return null;

  const sanitizedSnapshot = sanitizeSnapshotValue(snapshot);
  writeReplaySnapshotFile(runId, sanitizedSnapshot);
  attachReplayMetadata(run, sanitizedSnapshot);
  writeRuns(runs);
  return sanitizedSnapshot;
}

function clearReplaySnapshotFiles() {
  fs.rmSync(REPLAY_SNAPSHOTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(REPLAY_SNAPSHOTS_DIR, { recursive: true });
  dataVersion += 1;
  pageRenderCache.clear();
  pageRenderInFlight.clear();
}

async function resetDebugEventState() {
  pendingEventBuffer = [];
  runEventChains.clear();

  eventAppendChain = eventAppendChain
    .catch(() => {})
    .then(() => {
      pendingEventBuffer = [];
      runEventChains.clear();
      writeFileAtomic(EVENTS_FILE, '');
    });

  await eventAppendChain;
}

function normalizeRuns(runs) {
  const seenRunIds = new Set();

  return runs.filter(run => {
    const runId = parseInt(run.id, 10);
    const ticketId = parseInt(run.ticketId, 10);
    const agentId = parseInt(run.agentId, 10);

    if (Number.isNaN(runId) || Number.isNaN(ticketId) || Number.isNaN(agentId)) return false;
    if (seenRunIds.has(runId)) return false;

    seenRunIds.add(runId);
    run.id = runId;
    run.ticketId = ticketId;
    run.agentId = agentId;
    run.workspaceRoot = run.workspaceRoot || WORKSPACE_ROOT;
    run.mainWorkspaceRoot = run.mainWorkspaceRoot || run.workspaceRoot || WORKSPACE_ROOT;
    run.executionWorkspaceType = run.executionWorkspaceType === 'main_owned_paths'
      ? run.executionWorkspaceType
      : 'main';
    run.allocationPlanId = run.allocationPlanId ? parseInt(run.allocationPlanId, 10) : null;
    run.allocationPlanId = Number.isNaN(run.allocationPlanId) ? null : run.allocationPlanId;
    run.allocationItemId = run.allocationItemId ? parseInt(run.allocationItemId, 10) : null;
    run.allocationItemId = Number.isNaN(run.allocationItemId) ? null : run.allocationItemId;
    run.ownedOutputPaths = Array.isArray(run.ownedOutputPaths) ? run.ownedOutputPaths : [];
    run.allocationSubtask = typeof run.allocationSubtask === 'string' ? run.allocationSubtask : null;
    run.executionMode = run.executionMode === 'workflow' ? 'workflow' : 'agent';
    run.workflowId = run.executionMode === 'workflow' && typeof run.workflowId === 'string' ? run.workflowId : null;
    run.workflowInput = run.executionMode === 'workflow' && run.workflowInput && typeof run.workflowInput === 'object' && !Array.isArray(run.workflowInput)
      ? run.workflowInput
      : null;
    run.capabilityType = run.executionMode === 'workflow' ? 'workflow' : 'directAction';
    run.capabilityId = run.capabilityType === 'workflow' ? run.workflowId : 'agent-selected-actions';
    run.capabilityInput = run.capabilityType === 'workflow' ? run.workflowInput : null;
    run.executionPolicySnapshot = copyExecutionPolicy(run.executionPolicySnapshot, runWorkspaceScope(run));
    run.verificationContractSnapshot = normalizeVerificationContractSnapshot(run.verificationContractSnapshot);
    run.leaseOwner = typeof run.leaseOwner === 'string' && run.leaseOwner.trim() ? run.leaseOwner : null;
    run.leaseExpiresAt = typeof run.leaseExpiresAt === 'string' && isValidIsoTimestamp(run.leaseExpiresAt) ? run.leaseExpiresAt : null;
    run.currentStepId = typeof run.currentStepId === 'string' && run.currentStepId.trim() ? run.currentStepId : null;
    run.currentWorkflowAction = typeof run.currentWorkflowAction === 'string' && run.currentWorkflowAction.trim() ? run.currentWorkflowAction : null;
    run.currentPhase = EXECUTION_PHASES.includes(run.currentPhase) ? run.currentPhase : 'planning';
    run.lastHeartbeatAt = typeof run.lastHeartbeatAt === 'string' && isValidIsoTimestamp(run.lastHeartbeatAt) ? run.lastHeartbeatAt : null;
    run.runEvaluation = run.runEvaluation && typeof run.runEvaluation === 'object' && !Array.isArray(run.runEvaluation)
      ? sanitizeSnapshotValue(run.runEvaluation)
      : null;
    run.runConsequence = run.runConsequence && typeof run.runConsequence === 'object' && !Array.isArray(run.runConsequence)
      ? sanitizeSnapshotValue(run.runConsequence)
      : null;
    run.triage = normalizeTriage(run.triage);
    if (run.replaySnapshot && typeof run.replaySnapshot === 'object') {
      const snapshot = sanitizeSnapshotValue(run.replaySnapshot);
      writeReplaySnapshotFile(run.id, snapshot);
      attachReplayMetadata(run, snapshot);
    } else {
      run.replaySnapshotPath = typeof run.replaySnapshotPath === 'string' ? run.replaySnapshotPath : null;
      run.replaySummary = run.replaySummary && typeof run.replaySummary === 'object' ? run.replaySummary : null;
    }
    return true;
  });
}

function writeRuns(runs) {
  writeFileAtomic(RUNS_FILE, JSON.stringify(normalizeRuns(runs), null, 2));
}

function getRunLeaseDurationMs() {
  const configured = parseInt(process.env.RUN_LEASE_DURATION_MS || '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RUN_LEASE_DURATION_MS;
}

function buildRunLease(now = new Date()) {
  const nowMs = now.getTime();
  return {
    leaseOwner: RUN_LEASE_OWNER,
    leaseExpiresAt: new Date(nowMs + getRunLeaseDurationMs()).toISOString(),
    lastHeartbeatAt: now.toISOString()
  };
}

function isRunLeaseExpired(run, nowMs = Date.now()) {
  if (!run || !run.leaseExpiresAt) return false;
  const expiresAtMs = Date.parse(run.leaseExpiresAt);
  return !Number.isNaN(expiresAtMs) && expiresAtMs <= nowMs;
}

function isRunLeaseHeldByCurrentProcess(run) {
  return Boolean(run && run.leaseOwner === RUN_LEASE_OWNER && !isRunLeaseExpired(run));
}

function acquireRunLease(runId) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run || run.status !== 'pending') return null;
  if (run.leaseOwner && run.leaseOwner !== RUN_LEASE_OWNER && !isRunLeaseExpired(run)) return null;

  Object.assign(run, buildRunLease());
  writeRuns(runs);
  appendEvent({
    type: 'run.lease_acquired',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      lastHeartbeatAt: run.lastHeartbeatAt
    }
  });
  return run;
}

function heartbeatRunLease(runId, payload = {}) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run || run.leaseOwner !== RUN_LEASE_OWNER) return null;

  Object.assign(run, buildRunLease());
  writeRuns(runs);
  appendEvent({
    type: 'run.heartbeat',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      lastHeartbeatAt: run.lastHeartbeatAt,
      currentStepId: run.currentStepId || null,
      currentWorkflowAction: run.currentWorkflowAction || null,
      ...sanitizeSnapshotValue(payload)
    }
  });
  return run;
}

function countRunRetryAttempts(run) {
  if (!run) return 0;
  const runCreatedAt = run.createdAt ? Date.parse(run.createdAt) : null;

  return readRuns().filter(item => {
    if (item.id === run.id || item.ticketId !== run.ticketId) return false;
    if (runCreatedAt === null || Number.isNaN(runCreatedAt)) return item.id < run.id;
    const itemCreatedAt = item.createdAt ? Date.parse(item.createdAt) : null;
    if (itemCreatedAt === null || Number.isNaN(itemCreatedAt)) return item.id < run.id;
    return itemCreatedAt < runCreatedAt;
  }).length;
}

function buildRunEvaluation(run) {
  if (!run) return null;

  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const replaySummary = run.replaySummary || extractReplaySummary(snapshot) || {};
  const events = getRunEvents(run.id);
  const runLogs = readLogs().filter(log => log.runId === run.id);
  const snapshotEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
  const workflowActions = Array.isArray(snapshot.workflowActions) ? snapshot.workflowActions : [];
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests : [];
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses : [];
  const legacyPostconditionPassedEvents = snapshotEvents.filter(event => event && event.type === 'run:postcondition_completed');
  const postconditionsCheckedEvents = events.filter(event => event.type === 'run.postconditions_checked');
  const postconditionFailedEvents = events.filter(event => event.type === 'run.postcondition_failed');
  const latestPostconditionsChecked = postconditionsCheckedEvents[postconditionsCheckedEvents.length - 1] || null;
  const latestPostconditionsPayload = latestPostconditionsChecked && latestPostconditionsChecked.payload
    ? latestPostconditionsChecked.payload
    : null;
  const errorMessages = [];

  if (run.error) errorMessages.push(sanitizeLogMessage(run.error));
  if (replaySummary.failureReason) errorMessages.push(sanitizeLogMessage(replaySummary.failureReason));
  runLogs
    .filter(log => log.type === 'run:failed' || log.type === 'workspace:error' || log.type === 'workspace:ownership_blocked')
    .forEach(log => {
      if (log.message) errorMessages.push(sanitizeLogMessage(log.message));
    });
  events
    .filter(event => event.type === 'run.failed' || event.type === 'run.terminalized' || event.type === 'workflow.step.failed')
    .forEach(event => {
      const payload = event.payload || {};
      const message = payload.error || payload.message;
      if (message) errorMessages.push(sanitizeLogMessage(message));
    });

  const uniqueErrors = [...new Set(errorMessages.filter(Boolean))];
  const durationMs = run.startedAt && run.completedAt
    ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.startedAt))
    : 0;
  const formalViolationEvents = events.filter(event =>
    event.type === 'run.violation_detected' ||
    event.type === 'runtime.violation_detected' ||
    event.type === 'workspace.violation_detected'
  );
  const formalViolationCheckEvents = events.filter(event => event.type === 'run.violations_checked');
  const mutationCount = getRunMutationCount({ ...run, replaySnapshot: snapshot, replaySummary });
  const violationItems = formalViolationEvents.map(event => ({
    id: event.id || null,
    ts: event.ts || null,
    type: event.type,
    ticketId: event.ticketId || null,
    runId: event.runId || null,
    stepId: event.stepId || null,
    payload: sanitizeSnapshotValue(event.payload || {})
  }));
  const latestViolationCheck = formalViolationCheckEvents[formalViolationCheckEvents.length - 1] || null;
  const violationStatus = violationItems.length > 0
    ? 'present'
    : latestViolationCheck && latestViolationCheck.payload && latestViolationCheck.payload.status === 'none'
      ? 'none'
      : 'unknown';

  const effectiveRuntimeConfig = snapshot.effectiveRuntimeConfig
    ? {
        effectiveConfig: snapshot.effectiveRuntimeConfig.effectiveConfig
          ? { ...snapshot.effectiveRuntimeConfig.effectiveConfig }
          : null,
        agentConfig: snapshot.effectiveRuntimeConfig.agentConfig
          ? { ...snapshot.effectiveRuntimeConfig.agentConfig }
          : null,
        configSources: snapshot.effectiveRuntimeConfig.configSources
          ? { ...snapshot.effectiveRuntimeConfig.configSources }
          : null,
        runtimeLimits: snapshot.effectiveRuntimeConfig.runtimeLimits
          ? { ...snapshot.effectiveRuntimeConfig.runtimeLimits }
          : null
      }
    : null;

  return {
    effectiveness: {
      status: postconditionFailedEvents.length > 0
        ? 'failed'
        : run.status === 'completed' && latestPostconditionsPayload && latestPostconditionsPayload.status === 'passed'
          ? 'passed'
          : 'unknown',
      postconditionsPassed: latestPostconditionsPayload && Number.isInteger(latestPostconditionsPayload.passed)
        ? latestPostconditionsPayload.passed
        : legacyPostconditionPassedEvents.length,
      postconditionsFailed: latestPostconditionsPayload && Number.isInteger(latestPostconditionsPayload.failed)
        ? latestPostconditionsPayload.failed
        : postconditionFailedEvents.length,
      errors: uniqueErrors
    },
    efficiency: {
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
      workflowSteps: workflowActions.length,
      providerRequests: replaySummary.providerRequests !== undefined ? replaySummary.providerRequests : providerRequests.length,
      modelResponses: replaySummary.modelResponses !== undefined ? replaySummary.modelResponses : modelResponses.length,
      workspaceOperations: replaySummary.workspaceOperations !== undefined ? replaySummary.workspaceOperations : workspaceOperations.length,
      mutationCount,
      retryCount: countRunRetryAttempts(run)
    },
    violations: {
      status: violationStatus,
      items: violationItems
    },
    effectiveRuntimeConfig
  };
}

// Measurement-only attempt/usage summary for a single run. Pure derivation from
// existing runs/events/evaluation — no new persisted fields, no enforcement, no
// limits. Unobservable metrics are reported as null (rendered as "unavailable")
// rather than fabricated. This is evidence for future retry/budget work; it does
// not change completion, verification, triage, or lifecycle semantics.
function buildRunAttemptUsage(run, ticketRuns = null) {
  if (!run) return null;

  // Attempt ordering is creation order; run ids are globally monotonic via
  // nextId(), so id-ascending within a ticket is a stable attempt sequence.
  const siblings = (Array.isArray(ticketRuns)
    ? ticketRuns
    : readRuns().filter(item => item.ticketId === run.ticketId))
    .slice()
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  const attemptCount = siblings.length;
  const index = siblings.findIndex(item => item.id === run.id);
  const attemptNumber = index >= 0 ? index + 1 : null;

  const isTerminal = ['completed', 'failed', 'interrupted'].includes(run.status);
  // Only trust usage counts once there is terminal evidence (persisted evaluation
  // or a terminal run). For pending/running runs without evaluation, counts are
  // not yet observable → null.
  const evaluation = run.runEvaluation || (isTerminal ? buildRunEvaluation(run) : null);
  const efficiency = evaluation && evaluation.efficiency ? evaluation.efficiency : null;
  const num = value => (Number.isFinite(value) ? value : null);

  const startedAt = run.startedAt || null;
  const completedAt = run.completedAt || null;
  const durationMs = startedAt && completedAt
    ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    : (efficiency && Number.isFinite(efficiency.durationMs) && efficiency.durationMs > 0 ? efficiency.durationMs : null);

  const verificationRequired = isRunVerificationRequired(run);
  let verificationOutcome;
  if (!verificationRequired) {
    verificationOutcome = 'not_required';
  } else {
    const events = getRunEvents(run.id);
    if (events.some(event => event.type === 'run.verification_passed')) {
      verificationOutcome = 'passed';
    } else if (events.some(event => event.type === 'run.verification_failed' || event.type === 'run.postcondition_failed')) {
      verificationOutcome = 'failed';
    } else {
      verificationOutcome = 'pending';
    }
  }

  return {
    attemptNumber,
    attemptCount,
    startedAt,
    completedAt,
    durationMs,
    outcome: run.status || null,
    modelRequestCount: efficiency ? num(efficiency.providerRequests) : null,
    workspaceOperationCount: efficiency ? num(efficiency.workspaceOperations) : null,
    mutatingWorkspaceOperationCount: efficiency ? num(efficiency.mutationCount) : null,
    verificationRequired,
    verificationOutcome,
    triageRequired: Boolean(run.triage && run.triage.required)
  };
}

// Per-ticket attempt roll-up for the ticket detail view. Derived only.
function buildTicketAttemptSummary(ticketRuns) {
  const runs = (Array.isArray(ticketRuns) ? ticketRuns : [])
    .slice()
    .sort((a, b) => (a.id || 0) - (b.id || 0));
  return {
    attemptCount: runs.length,
    attempts: runs.map(run => ({ runId: run.id, ...buildRunAttemptUsage(run, runs) }))
  };
}

// Advisory-only budget status: compares a run's recorded usage against the budget
// threshold fields recorded in its execution policy snapshot. This NEVER blocks,
// stops, fails, or reruns anything — it is purely a visibility signal derived from
// existing usage metrics. Per-metric status:
//   not_configured   threshold is null/unset → no warning
//   unavailable      usage not observable yet → no warning, no fabricated number
//   within_threshold usage <= threshold (equal is within)
//   exceeded         usage > threshold (advisory warning only)
function buildRunBudgetStatus(run, usage = null) {
  if (!run) return null;
  const policy = copyExecutionPolicy(run.executionPolicySnapshot, runWorkspaceScope(run));
  const u = usage || buildRunAttemptUsage(run);

  const metric = (threshold, used) => {
    const t = Number.isInteger(threshold) && threshold > 0 ? threshold : null;
    const usedValue = Number.isFinite(used) ? used : null;
    if (t === null) return { threshold: null, usage: usedValue, status: 'not_configured' };
    if (usedValue === null) return { threshold: t, usage: null, status: 'unavailable' };
    return { threshold: t, usage: usedValue, status: usedValue > t ? 'exceeded' : 'within_threshold' };
  };

  return {
    advisory: true,
    runtimeMs: metric(policy.maxRuntimeMs, u ? u.durationMs : null),
    modelRequests: metric(policy.maxModelRequests, u ? u.modelRequestCount : null),
    workspaceOperations: metric(policy.maxWorkspaceOperations, u ? u.workspaceOperationCount : null)
  };
}

// Advisory-only ticket-level budget rollup across a ticket's runs. Reuses each
// run's own buildRunBudgetStatus (so every run is compared against its OWN
// executionPolicySnapshot, never the current mutable ticket policy). Rolls up by
// priority exceeded > unavailable > within_threshold > not_configured. Visibility
// only — it never blocks, stops, fails, or reruns anything and is not read by any
// control flow.
const BUDGET_ROLLUP_PRIORITY = ['exceeded', 'unavailable', 'within_threshold', 'not_configured'];
function rollupBudgetStatuses(statuses) {
  return BUDGET_ROLLUP_PRIORITY.find(status => statuses.includes(status)) || 'not_configured';
}
function buildTicketBudgetSummary(ticketRuns) {
  const runs = Array.isArray(ticketRuns) ? ticketRuns.filter(Boolean) : [];
  const emptyCounts = { exceeded: 0, unavailable: 0, within_threshold: 0, not_configured: 0 };
  if (runs.length === 0) {
    return {
      advisory: true,
      runCount: 0,
      overall: 'no_runs',
      metrics: { runtimeMs: 'not_configured', modelRequests: 'not_configured', workspaceOperations: 'not_configured' },
      counts: { ...emptyCounts }
    };
  }

  const perRun = runs.map(run => buildRunBudgetStatus(run)).filter(Boolean);
  const statusesFor = key => perRun.map(budget => budget[key].status);
  const metrics = {
    runtimeMs: rollupBudgetStatuses(statusesFor('runtimeMs')),
    modelRequests: rollupBudgetStatuses(statusesFor('modelRequests')),
    workspaceOperations: rollupBudgetStatuses(statusesFor('workspaceOperations'))
  };

  const counts = { ...emptyCounts };
  perRun.forEach(budget => {
    const runOverall = rollupBudgetStatuses([budget.runtimeMs.status, budget.modelRequests.status, budget.workspaceOperations.status]);
    counts[runOverall] += 1;
  });

  return {
    advisory: true,
    runCount: runs.length,
    overall: rollupBudgetStatuses([metrics.runtimeMs, metrics.modelRequests, metrics.workspaceOperations]),
    metrics,
    counts
  };
}

function getWorkspaceOperationNameFromEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (typeof evidence.operation === 'string') return evidence.operation;
  if (evidence.operation && typeof evidence.operation.operation === 'string') return evidence.operation.operation;
  return null;
}

function getWorkspaceOperationArgsFromEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return {};
  if (evidence.operation && evidence.operation.args && typeof evidence.operation.args === 'object') return evidence.operation.args;
  if (evidence.input && typeof evidence.input === 'object') return evidence.input;
  if (evidence.args && typeof evidence.args === 'object') return evidence.args;
  return {};
}

function collectWorkspaceMutationPaths(operation, evidence) {
  const args = getWorkspaceOperationArgsFromEvidence(evidence);
  const paths = [];
  const primaryPath = args.path || evidence.path || null;
  const nextPath = args.nextPath || evidence.nextPath || null;

  if (primaryPath) paths.push({ role: 'path', path: primaryPath });
  if (operation === 'renamePath' && nextPath) paths.push({ role: 'nextPath', path: nextPath });
  return paths;
}

function createWorkspaceViolationItem(run, evidence, source) {
  const operation = getWorkspaceOperationNameFromEvidence(evidence);
  if (!operation || !AGENT_MUTATING_OPERATIONS.includes(operation)) return null;

  const paths = collectWorkspaceMutationPaths(operation, evidence);
  for (const pathItem of paths) {
    const matchedProtectedPattern = getProtectedWorkspacePathMatch(pathItem.path);
    if (matchedProtectedPattern) {
      return {
        rule: 'protected_path',
        operation,
        path: pathItem.path,
        pathRole: pathItem.role,
        matchedPattern: matchedProtectedPattern,
        source
      };
    }
  }

  if (run.executionWorkspaceType === 'main_owned_paths') {
    const ownedOutputPaths = getRunOwnedOutputPaths(run);
    const outsideOwnedPath = paths.find(pathItem => !isPathInsideOwnedOutputPaths(pathItem.path, ownedOutputPaths));
    if (outsideOwnedPath) {
      return {
        rule: 'owned_output_path',
        operation,
        path: outsideOwnedPath.path,
        pathRole: outsideOwnedPath.role,
        ownedOutputPaths,
        source
      };
    }
  }

  if (evidence.blocked === true || (evidence.operation && evidence.operation.blocked === true)) {
    return {
      rule: 'authority_blocked',
      operation,
      path: paths[0] ? paths[0].path : null,
      pathRole: paths[0] ? paths[0].role : null,
      source
    };
  }

  return null;
}

function collectFormalWorkspaceViolations(run) {
  if (!run) return [];

  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  const workspaceOperationEvents = getRunEvents(run.id).filter(event => event.type === 'workspace.operation');
  const violations = [];
  const seen = new Set();

  function addViolation(evidence, source) {
    const violation = createWorkspaceViolationItem(run, evidence, source);
    if (!violation) return;

    const key = [
      violation.rule,
      violation.operation,
      violation.path || '',
      violation.pathRole || ''
    ].join(':');
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(violation);
  }

  workspaceOperations.forEach((operation, index) => {
    addViolation(operation, {
      type: 'replay.workspaceOperations',
      index,
      historyId: operation && operation.historyId ? operation.historyId : null
    });
  });
  workspaceOperationEvents.forEach(event => {
    addViolation(event.payload || {}, {
      type: 'event.workspace.operation',
      eventId: event.id || null,
      stepId: event.stepId || null
    });
  });

  return violations;
}

function completeRunViolationCheck(runId) {
  const run = readRuns().find(item => item.id === runId);
  if (!run) return [];

  const existingEvents = getRunEvents(run.id);
  if (existingEvents.some(event => event.type === 'run.violation_detected' || event.type === 'run.violations_checked')) {
    return existingEvents.filter(event => event.type === 'run.violation_detected').map(event => event.payload || {});
  }

  const violations = collectFormalWorkspaceViolations(run);
  if (violations.length > 0) {
    violations.forEach(violation => {
      appendEvent({
        type: 'run.violation_detected',
        ticketId: run.ticketId,
        runId: run.id,
        payload: sanitizeSnapshotValue(violation)
      });
    });
    return violations;
  }

  appendEvent({
    type: 'run.violations_checked',
    ticketId: run.ticketId,
    runId: run.id,
    payload: { status: 'none', checked: 'workspace_mutations' }
  });
  return [];
}

function getValueAtPath(source, pathExpression) {
  if (!pathExpression) return undefined;
  const parts = String(pathExpression).split('.').filter(Boolean);
  let value = source;

  for (const part of parts) {
    if (!value || typeof value !== 'object' || !(part in value)) return undefined;
    value = value[part];
  }

  return value;
}

function valuesStrictlyEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function getRunWorkflowOutput(run) {
  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const outputs = Array.isArray(snapshot.capabilityOutputs) ? snapshot.capabilityOutputs : [];
  const matchingOutput = outputs
    .slice()
    .reverse()
    .find(item => item && item.capabilityType === 'workflow' && item.capabilityId === run.workflowId);

  return matchingOutput ? matchingOutput.output || {} : {};
}

function resolveWorkflowPostconditionTemplates(postcondition, run, output) {
  return resolveWorkflowInputTemplates(postcondition, {
    workflow: { input: run.workflowInput || {} },
    output,
    result: output
  });
}

function evaluateWorkflowPostcondition(run, workflow, postcondition, output) {
  const resolved = resolveWorkflowPostconditionTemplates(postcondition, run, output);
  const id = resolved.id || postcondition.id || null;

  if (resolved.type === 'fileExists') {
    const info = workspaceProvider.getPathInfo(resolved.path);
    const passed = info.exists && info.type === 'file';
    return {
      id,
      type: resolved.type,
      passed,
      expected: { path: resolved.path, exists: true, type: 'file' },
      actual: { exists: info.exists, type: info.type || null }
    };
  }

  if (resolved.type === 'fileContains') {
    const content = readWorkspaceFileIfExists(resolved.path);
    const passed = typeof content === 'string' && content.includes(String(resolved.contains ?? ''));
    return {
      id,
      type: resolved.type,
      passed,
      expected: { path: resolved.path, contains: String(resolved.contains ?? '') },
      actual: { exists: content !== null }
    };
  }

  if (resolved.type === 'jsonPathEquals') {
    const content = readWorkspaceFileIfExists(resolved.path);
    let actual;
    let parseError = null;
    if (content !== null) {
      try {
        actual = getValueAtPath(JSON.parse(content), resolved.jsonPath);
      } catch (error) {
        parseError = error.message;
      }
    }
    const passed = content !== null && !parseError && valuesStrictlyEqual(actual, resolved.equals);
    return {
      id,
      type: resolved.type,
      passed,
      expected: { path: resolved.path, jsonPath: resolved.jsonPath, equals: resolved.equals },
      actual: { exists: content !== null, value: actual, parseError }
    };
  }

  if (resolved.type === 'outputFieldEquals') {
    const actual = getValueAtPath(output, resolved.field);
    const passed = valuesStrictlyEqual(actual, resolved.equals);
    return {
      id,
      type: resolved.type,
      passed,
      expected: { field: resolved.field, equals: resolved.equals },
      actual: { value: actual }
    };
  }

  return {
    id,
    type: resolved.type || null,
    passed: false,
    expected: sanitizeSnapshotValue(resolved),
    actual: { error: 'Unsupported postcondition type' }
  };
}

function completeRunPostconditionCheck(runId) {
  const run = readRuns().find(item => item.id === runId);
  if (!run || run.executionMode !== 'workflow' || !run.workflowId) return null;

  const existingEvents = getRunEvents(run.id);
  if (existingEvents.some(event => event.type === 'run.postconditions_checked')) {
    return existingEvents.filter(event => event.type === 'run.postcondition_failed').map(event => event.payload || {});
  }

  const capturedContract = normalizeVerificationContractSnapshot(run.verificationContractSnapshot);
  const fallbackWorkflow = capturedContract ? null : getWorkflowById(run.workflowId);
  const workflow = capturedContract
    ? {
        id: capturedContract.workflowId,
        name: capturedContract.workflowName,
        version: capturedContract.workflowVersion,
        verifierContract: capturedContract.verifierContract,
        postconditions: capturedContract.postconditions
      }
    : fallbackWorkflow;
  const contractSource = capturedContract ? 'run_snapshot' : 'legacy_current_workflow';
  const postconditions = workflow && Array.isArray(workflow.postconditions) ? workflow.postconditions : [];
  if (postconditions.length === 0) return null;

  const output = getRunWorkflowOutput(run);
  const results = postconditions.map(postcondition => evaluateWorkflowPostcondition(run, workflow, postcondition, output));
  const failedResults = results.filter(result => !result.passed);

  failedResults.forEach(result => {
    appendEvent({
      type: 'run.postcondition_failed',
      ticketId: run.ticketId,
      runId: run.id,
      payload: sanitizeSnapshotValue({
        workflowId: workflow.id,
        contractSource,
        postcondition: result
      })
    });
  });
  appendEvent({
    type: 'run.postconditions_checked',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      workflowId: workflow.id,
      contractSource,
      status: failedResults.length > 0 ? 'failed' : 'passed',
      passed: results.length - failedResults.length,
      failed: failedResults.length,
      total: results.length,
      results: sanitizeSnapshotValue(results)
    }
  });

  return failedResults;
}

function buildVerificationFailureReason(failedResults) {
  const failures = Array.isArray(failedResults) ? failedResults : [];
  const labels = failures
    .map(result => result && (result.id || result.type))
    .filter(Boolean);
  const detail = labels.length > 0 ? `: ${labels.join(', ')}` : '';
  return `Verification failed: ${failures.length} postcondition${failures.length === 1 ? '' : 's'} did not pass${detail}`;
}

function buildVerificationFailure(failedResults) {
  return {
    code: 'RUN_VERIFICATION_FAILED',
    kind: 'verification_failed',
    detail: {
      failedPostconditions: sanitizeSnapshotValue(Array.isArray(failedResults) ? failedResults : [])
    }
  };
}

function persistRunEvaluation(runId) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run) return null;

  const runEvaluation = buildRunEvaluation(run);
  if (!runEvaluation) return null;

  run.runEvaluation = runEvaluation;
  writeRuns(runs);
  appendEvent({
    type: 'run.evaluation_completed',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      evaluation: runEvaluation
    }
  });
  return runEvaluation;
}

function buildMutationConsequenceFromHistory(record) {
  if (!record || record.error || !AGENT_MUTATING_OPERATIONS.includes(record.operation)) return null;

  const base = {
    operation: record.operation,
    path: record.args && record.args.path ? record.args.path : null,
    nextPath: record.args && record.args.nextPath ? record.args.nextPath : null,
    historyId: record.id,
    step: record.step,
    timestamp: record.timestamp,
    result: sanitizeSnapshotValue(record.result || {})
  };

  if (record.operation === 'createFolder') {
    if (record.result && record.result.status === 'created') return { category: 'created', item: { ...base, type: 'folder' } };
    return null;
  }

  if (record.operation === 'writeFile') {
    if (record.preState && record.preState.existed === false) return { category: 'created', item: { ...base, type: 'file' } };
    if (record.preState && record.preState.existed === true) return { category: 'updated', item: { ...base, type: 'file' } };
    return { category: 'mutations', item: { ...base, type: 'file' } };
  }

  if (record.operation === 'deletePath') {
    if (record.result && record.result.status === 'deleted') return { category: 'deleted', item: base };
    return null;
  }

  if (record.operation === 'renamePath') {
    return { category: 'renamed', item: base };
  }

  return { category: 'mutations', item: base };
}

function collectAttemptedMutationConsequences(run, snapshot) {
  const attempts = [];
  const seen = new Set();

  function addAttempt(operation, pathValue, evidence) {
    if (!operation || !AGENT_MUTATING_OPERATIONS.includes(operation)) return;
    const key = `${operation}:${pathValue || ''}:${evidence.type}:${evidence.id || evidence.index || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({
      operation,
      path: pathValue || null,
      evidence: sanitizeSnapshotValue(evidence)
    });
  }

  (Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : []).forEach((item, index) => {
    const operation = getWorkspaceOperationNameFromEvidence(item);
    if (!operation || !AGENT_MUTATING_OPERATIONS.includes(operation)) return;
    if (!item.error && !item.blocked && !(item.operation && item.operation.blocked)) return;
    const paths = collectWorkspaceMutationPaths(operation, item);
    addAttempt(operation, paths[0] ? paths[0].path : null, {
      type: 'replay.workspaceOperations',
      index,
      blocked: item.blocked === true || Boolean(item.operation && item.operation.blocked),
      error: item.error || null
    });
  });

  getRunEvents(run.id).filter(event => event.type === 'workspace.operation').forEach(event => {
    const payload = event.payload || {};
    const operation = getWorkspaceOperationNameFromEvidence(payload);
    if (!operation || !AGENT_MUTATING_OPERATIONS.includes(operation)) return;
    if (!payload.error && !payload.blocked) return;
    const paths = collectWorkspaceMutationPaths(operation, payload);
    addAttempt(operation, paths[0] ? paths[0].path : null, {
      type: 'event.workspace.operation',
      id: event.id,
      stepId: event.stepId,
      blocked: payload.blocked === true,
      error: payload.error || null
    });
  });

  return attempts;
}

function collectExplicitExternalEffects(run) {
  return getRunEvents(run.id)
    .filter(event => event.type === 'external.effect')
    .map(event => ({
      id: event.id || null,
      ts: event.ts || null,
      payload: sanitizeSnapshotValue(event.payload || {})
    }));
}

function collectExplicitNotifications(run) {
  return getRunEvents(run.id)
    .filter(event => event.type === 'notification.sent')
    .map(event => ({
      id: event.id || null,
      ts: event.ts || null,
      payload: sanitizeSnapshotValue(event.payload || {})
    }));
}

function buildRunConsequence(run) {
  if (!run) return null;

  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const evaluation = run.runEvaluation || buildRunEvaluation(run) || {};
  const consequence = {
    mutations: [],
    created: [],
    updated: [],
    deleted: [],
    renamed: [],
    notifications: collectExplicitNotifications(run),
    externalEffects: collectExplicitExternalEffects(run),
    verification: {
      postconditionsStatus: evaluation.effectiveness ? evaluation.effectiveness.status || 'unknown' : 'unknown',
      violationsStatus: evaluation.violations ? evaluation.violations.status || 'unknown' : 'unknown'
    }
  };

  getOperationHistoryForRun(run.id).forEach(record => {
    const mutation = buildMutationConsequenceFromHistory(record);
    if (!mutation) return;
    consequence.mutations.push(mutation.item);
    consequence[mutation.category].push(mutation.item);
  });

  collectAttemptedMutationConsequences(run, snapshot).forEach(attempt => {
    consequence.mutations.push({
      ...attempt,
      attempted: true
    });
  });

  return consequence;
}

function persistRunConsequence(runId) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run) return null;

  maybeTestInterrupt(run, 'before_run.consequence_recorded');

  const runConsequence = buildRunConsequence(run);
  if (!runConsequence) return null;

  run.runConsequence = runConsequence;
  writeRuns(runs);
  appendEvent({
    type: 'run.consequence_recorded',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      consequence: runConsequence
    }
  });
  return runConsequence;
}

function expireStaleRunLeases() {
  const expiredRuns = readRuns().filter(run => run.status === 'running' && isRunLeaseExpired(run));

  expiredRuns.forEach(run => {
    // Check if run is safe to resume before interrupting
    const resumeState = reconstructResumableState(run);
    if (resumeState && resumeState.safeToResumeExecution) {
      // Safe to resume: clear stale lease and return to pending so scheduler can restart it
      const runs = readRuns();
      const r = runs.find(item => item.id === run.id);
      if (r) {
        r.status = 'pending';
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
        delete r.startedAt;
        writeRuns(runs);
        appendEvent({
          type: 'run.resumed',
          ticketId: run.ticketId,
          runId: run.id,
          payload: {
            reason: 'stale lease, safe to resume',
            priorEvents: resumeState.priorEvents,
            expectedNextPhase: resumeState.expectedNextPhase
          }
        });
        appendRunLog(run, 'run:resumed', `Stale lease expired; run is safe to resume (${resumeState.priorEvents} prior events, next phase: ${resumeState.expectedNextPhase})`);
      }
      return;
    }

    // Terminal state reached — reconcile (evaluate, finalize, cleanup)
    if (resumeState && resumeState.safeToReconcileTerminalState) {
      reconcileTerminalRun(run);
      return;
    }

    appendEvent({
      type: 'run.lease_expired',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        leaseOwner: run.leaseOwner || null,
        leaseExpiresAt: run.leaseExpiresAt || null,
        currentStepId: run.currentStepId || null,
        currentWorkflowAction: run.currentWorkflowAction || null,
        lastHeartbeatAt: run.lastHeartbeatAt || null
      }
    });
    interruptAgentRun(run, `Run lease expired for owner ${run.leaseOwner || 'unknown'}`);
  });

  return expiredRuns;
}

function persistRunWorkflowStep(runId, step, status = 'started') {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run || run.leaseOwner !== RUN_LEASE_OWNER) return null;

  run.currentStepId = step && step.id ? step.id : null;
  run.currentWorkflowAction = step && step.action ? step.action : null;
  Object.assign(run, buildRunLease());
  writeRuns(runs);
  appendEvent({
    type: 'workflow.step.persisted',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: run.currentStepId,
    payload: {
      status,
      action: run.currentWorkflowAction,
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
      lastHeartbeatAt: run.lastHeartbeatAt
    }
  });
  return run;
}

function serializeRunLease(run) {
  if (!run) return null;
  return {
    leaseOwner: run.leaseOwner || null,
    leaseExpiresAt: run.leaseExpiresAt || null,
    lastHeartbeatAt: run.lastHeartbeatAt || null,
    expired: isRunLeaseExpired(run),
    heldByCurrentProcess: isRunLeaseHeldByCurrentProcess(run)
  };
}

function getRunAuthorityEvidence(run) {
  if (!run) return [];
  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const replayChecks = Array.isArray(snapshot.authorityChecks) ? snapshot.authorityChecks : [];
  const eventChecks = getRunEvents(run.id)
    .filter(event => event.type === 'authority.allowed' || event.type === 'authority.denied')
    .map(event => ({
      id: event.id || null,
      ts: event.ts || null,
      type: event.type,
      ...(event.payload || {})
    }));
  const seen = new Set();

  return [...replayChecks, ...eventChecks].filter(item => {
    const key = `${item.status}:${item.rule}:${item.operation}:${item.path}:${item.ts || ''}:${item.id || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// `options.eventSummary`, when provided, is reused instead of recomputing the
// run's event summary (and reused again for getRunCurrentMessage below), so a
// single serialization scans the event log at most once. Callers serializing
// the same run more than once per request supply it to avoid repeat scans.
function serializeRunRuntimeState(run, logsByRunId = null, options = {}) {
  if (!run) return null;
  const summary = options.eventSummary || recentEventSummary(run.id);
  const replaySummary = run.replaySummary || extractReplaySummary(readRunReplaySnapshot(run)) || null;
  const effectiveLogsByRunId = logsByRunId || groupBy(readLogs(), log => log.runId);
  const runLogs = effectiveLogsByRunId.get(run.id) || [];
  const replaySnapshot = readRunReplaySnapshot(run) || run.replaySnapshot || null;
  const serializedAttemptUsage = buildRunAttemptUsage(run, options.ticketRuns || null);

  return {
    id: run.id,
    ticketId: run.ticketId,
    agentId: run.agentId,
    agentName: run.agentName,
    status: run.status,
    executionMode: run.executionMode || 'agent',
    capabilityType: run.capabilityType || null,
    capabilityId: run.capabilityId || null,
    workflowId: run.workflowId || null,
    executionPolicySnapshot: copyExecutionPolicy(run.executionPolicySnapshot, runWorkspaceScope(run)),
    verificationContractSnapshot: normalizeVerificationContractSnapshot(run.verificationContractSnapshot),
    triage: normalizeTriage(run.triage),
    lease: serializeRunLease(run),
    leaseOwner: run.leaseOwner || null,
    leaseExpiresAt: run.leaseExpiresAt || null,
    currentStepId: run.currentStepId || null,
    currentWorkflowAction: run.currentWorkflowAction || null,
    lastHeartbeatAt: run.lastHeartbeatAt || null,
    eventSummary: summary,
    latestEventSummary: summary,
    replaySummary,
    authorityEvidence: getRunAuthorityEvidence(run),
    runEvaluation: run.runEvaluation || buildRunEvaluation(run),
    attemptUsage: serializedAttemptUsage,
    budgetStatus: buildRunBudgetStatus(run, serializedAttemptUsage),
    runConsequence: run.runConsequence || buildRunConsequence(run),
    currentMessage: getRunCurrentMessage(run, effectiveLogsByRunId, summary),
    stateInconsistency: detectRunStateInconsistency(run, {
      logs: runLogs,
      replaySnapshot,
      recentEventSummary: summary
    }),
    outcome: classifyRunOperationalOutcome(run),
    outcomeLabel: displayOperationalOutcome(classifyRunOperationalOutcome(run), countRunMutatingOperations(run.id)),
    createdAt: run.createdAt || null,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    updatedAt: run.updatedAt || null,
    error: run.error || null
  };
}

function getRuntimeStatusSnapshot() {
  const runs = readRuns();
  const activeRuns = runs.filter(run => ['pending', 'running'].includes(run.status));
  const pendingRuns = runs.filter(run => run.status === 'pending');
  const runningRuns = runs.filter(run => run.status === 'running');
  const expiredLeases = runs.filter(run => run.status === 'running' && isRunLeaseExpired(run));
  const localAgentIds = new Set(readAgents().filter(isLocalModelAgent).map(agent => agent.id));

  // The same run appears across activeRuns/pendingRuns/runningRuns/expiredLeases,
  // so memoize its event summary once per request and reuse it for every
  // serialization to avoid re-scanning the event log for the same run.
  const summaryByRunId = new Map();
  const serializeRunOnce = run => {
    if (!summaryByRunId.has(run.id)) summaryByRunId.set(run.id, recentEventSummary(run.id));
    return serializeRunRuntimeState(run, null, { eventSummary: summaryByRunId.get(run.id) });
  };

  return {
    scheduler: {
      running: Boolean(runtimeScheduler && runtimeScheduler.isRunning()),
      intervalMs: getPositiveIntegerEnv('RUNTIME_SCHEDULER_INTERVAL_MS', 500)
    },
    leaseOwner: RUN_LEASE_OWNER,
    concurrencyLimits: {
      localModel: getLocalModelConcurrencyLimit(),
      activeLocalModelRuns: runningRuns.filter(run => localAgentIds.has(run.agentId)).length,
      startingLocalModelRuns: startingLocalModelRunIds.size
    },
    activeRuns: activeRuns.map(serializeRunOnce),
    pendingRuns: pendingRuns.map(serializeRunOnce),
    runningRuns: runningRuns.map(serializeRunOnce),
    expiredLeases: expiredLeases.map(serializeRunOnce),
    counts: {
      active: activeRuns.length,
      pending: pendingRuns.length,
      running: runningRuns.length,
      expiredLeases: expiredLeases.length
    },
    runtimeLimits: getAgentRuntimeLimits()
  };
}

function compareRunsNewestFirst(a, b) {
  return new Date(b.updatedAt || b.completedAt || b.startedAt || b.createdAt || 0) -
    new Date(a.updatedAt || a.completedAt || a.startedAt || a.createdAt || 0);
}

function serializeTicketRuntimeState(ticketId) {
  const parsedTicketId = parseInt(ticketId, 10);
  if (Number.isNaN(parsedTicketId)) return null;

  const ticket = readTickets().find(item => item.id === parsedTicketId);
  if (!ticket) return null;

  const logsByRunId = groupBy(readLogs(), log => log.runId);
  const ticketRuns = readRuns()
    .filter(run => run.ticketId === parsedTicketId)
    .sort(compareRunsNewestFirst);
  const currentRun = ticketRuns.find(run => ['pending', 'running'].includes(run.status)) || null;
  const latestRun = ticketRuns[0] || null;
  const visibleRun = currentRun || latestRun;
  // visibleRun, currentRun and latestRun frequently overlap, so memoize each
  // run's event summary once and reuse it everywhere below to avoid re-scanning
  // the event log for the same run.
  const summaryByRunId = new Map();
  const summaryFor = id => {
    if (!summaryByRunId.has(id)) summaryByRunId.set(id, recentEventSummary(id));
    return summaryByRunId.get(id);
  };
  const eventSummary = visibleRun ? summaryFor(visibleRun.id) : null;
  const outcome = latestRun ? classifyRunOperationalOutcome(latestRun) : null;
  const runStateInconsistency = visibleRun
    ? detectRunStateInconsistency(visibleRun, {
      logs: logsByRunId.get(visibleRun.id) || [],
      recentEventSummary: eventSummary
    })
    : null;

  return {
    ticket,
    currentRun: currentRun ? serializeRunRuntimeState(currentRun, logsByRunId, { eventSummary: summaryFor(currentRun.id) }) : null,
    latestRun: latestRun ? serializeRunRuntimeState(latestRun, logsByRunId, { eventSummary: summaryFor(latestRun.id) }) : null,
    currentMessage: visibleRun ? getRunCurrentMessage(visibleRun, logsByRunId, eventSummary) : null,
    currentStep: eventSummary ? eventSummary.currentStep : null,
    leaseState: visibleRun ? serializeRunLease(visibleRun) : null,
    runStateInconsistency,
    outcome,
    outcomeLabel: latestRun ? displayOperationalOutcome(outcome, countRunMutatingOperations(latestRun.id)) : null
  };
}

function readAllocationPlans() {
  return readJsonArrayCached(ALLOCATION_PLANS_FILE);
}

function normalizeAllocationPlans(plans) {
  const seenPlanIds = new Set();
  const seenItemIds = new Set();

  return plans.filter(plan => {
    const planId = parseInt(plan.id, 10);
    const ticketId = parseInt(plan.ticketId, 10);

    if (Number.isNaN(planId) || Number.isNaN(ticketId) || seenPlanIds.has(planId)) return false;

    seenPlanIds.add(planId);
    plan.id = planId;
    plan.ticketId = ticketId;
    plan.mode = plan.mode === 'owned_paths' ? plan.mode : 'owned_paths';
    plan.ticketOpenedAt = typeof plan.ticketOpenedAt === 'string' ? plan.ticketOpenedAt : null;
    plan.status = ['pending', 'running', 'completed', 'failed', 'interrupted'].includes(plan.status) ? plan.status : 'pending';
    plan.createdAt = typeof plan.createdAt === 'string' ? plan.createdAt : new Date().toISOString();
    plan.items = Array.isArray(plan.items) ? plan.items.filter(item => {
      const allocationItemId = parseInt(item.allocationItemId, 10);
      const assignedAgentId = parseInt(item.assignedAgentId, 10);

      if (Number.isNaN(allocationItemId) || Number.isNaN(assignedAgentId) || seenItemIds.has(allocationItemId)) return false;

      seenItemIds.add(allocationItemId);
      item.allocationItemId = allocationItemId;
      item.assignedAgentId = assignedAgentId;
      item.allocationSubtask = typeof item.allocationSubtask === 'string' ? item.allocationSubtask : '';
      item.ownedOutputPaths = Array.isArray(item.ownedOutputPaths)
        ? item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath).filter(Boolean)
        : [];
      item.status = ['pending', 'running', 'completed', 'failed', 'interrupted'].includes(item.status) ? item.status : 'pending';
      item.createdAt = typeof item.createdAt === 'string' ? item.createdAt : plan.createdAt;
      return true;
    }) : [];

    return true;
  });
}

function writeAllocationPlans(plans) {
  writeFileAtomic(ALLOCATION_PLANS_FILE, JSON.stringify(normalizeAllocationPlans(plans), null, 2));
}

function readLogs() {
  return readJsonArrayCached(LOGS_FILE);
}

function normalizeLogs(logs) {
  const seenLogIds = new Set();
  const runsById = new Map(readRuns().map(run => [run.id, run]));

  return logs.filter(log => {
    const logId = parseInt(log.id, 10);
    const isSystemLog = log.runId === null && log.ticketId === null;
    const runId = isSystemLog ? null : parseInt(log.runId, 10);
    const ticketId = isSystemLog ? null : parseInt(log.ticketId, 10);
    const run = runsById.get(runId);

    if (Number.isNaN(logId)) return false;
    if (!isSystemLog && (Number.isNaN(runId) || Number.isNaN(ticketId))) return false;
    if (!isValidIsoTimestamp(log.timestamp)) return false;
    if (!isSystemLog && (!run || run.ticketId !== ticketId)) return false;
    if (seenLogIds.has(logId)) return false;

    seenLogIds.add(logId);
    log.id = logId;
    log.runId = runId;
    log.ticketId = ticketId;
    log.agentId = isSystemLog ? null : run.agentId;
    log.message = sanitizeLogMessage(log.message);
    return true;
  });
}

function writeLogs(logs) {
  writeFileAtomic(LOGS_FILE, JSON.stringify(normalizeLogs(logs), null, 2));
}

function readOperationHistory() {
  return readJsonArrayCached(OPERATION_HISTORY_FILE);
}

function normalizeOperationHistory(history) {
  const seenIds = new Set();
  const runsById = new Map(readRuns().map(run => [run.id, run]));

  return history.filter(record => {
    const id = parseInt(record.id, 10);
    if (Number.isNaN(id) || seenIds.has(id)) return false;
    seenIds.add(id);
    record.id = id;
    record.ticketId = parseInt(record.ticketId, 10);
    record.runId = parseInt(record.runId, 10);
    record.allocationPlanId = record.allocationPlanId ? parseInt(record.allocationPlanId, 10) : null;
    record.allocationItemId = record.allocationItemId ? parseInt(record.allocationItemId, 10) : null;
    record.step = parseInt(record.step, 10);
    record.isRecovery = record.isRecovery === true;
    record.recoveredHistoryId = record.recoveredHistoryId ? parseInt(record.recoveredHistoryId, 10) : null;
    if (!isValidIsoTimestamp(record.timestamp)) return false;
    const run = runsById.get(record.runId);
    if (!run || run.ticketId !== record.ticketId) return false;
    if (!AGENT_MUTATING_OPERATIONS.includes(record.operation)) return false;
    return true;
  });
}

function writeFileAtomic(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, filePath);
  jsonReadCache.delete(filePath);
  dataVersion += 1;
  pageRenderCache.clear();
  pageRenderInFlight.clear();
}

function writeOperationHistory(history) {
  writeFileAtomic(OPERATION_HISTORY_FILE, JSON.stringify(normalizeOperationHistory(history), null, 2));
}

function getOperationHistoryForRun(runId, history = readOperationHistory()) {
  return history.filter(record => record.runId === runId);
}

function getOperationHistoryForTicket(ticketId, history = readOperationHistory()) {
  return history.filter(record => record.ticketId === ticketId);
}

function buildWriteFileArtifactStatus(record, operationHistory = [], runIds = new Set()) {
  if (record && record.preState && record.preState.existed === false) return 'created';
  const args = record && record.args ? record.args : {};
  const result = record && record.result ? record.result : {};
  const artifactPath = result.path || args.path || '';
  if (record && record.preState && record.preState.existed === true) {
    const hasEarlierSameTicketWrite = (operationHistory || []).some(item => {
      if (!item || item === record || item.error || item.operation !== 'writeFile') return false;
      if (!runIds.has(item.runId) || item.runId === record.runId) return false;
      const itemArgs = item.args || {};
      const itemResult = item.result || {};
      const itemPath = itemResult.path || itemArgs.path || '';
      if (itemPath !== artifactPath) return false;
      if (Number.isFinite(Number(item.id)) && Number.isFinite(Number(record.id))) return Number(item.id) < Number(record.id);
      return String(item.timestamp || '') < String(record.timestamp || '');
    });
    return hasEarlierSameTicketWrite ? 'rewritten' : 'updated';
  }
  return 'written';
}

function normalizeArtifactComparisonPath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function normalizeArtifactComparisonType(value) {
  const type = String(value || '').trim();
  if (type === 'workflow draft' || type === 'workflowDraft') return 'workflowDraft';
  if (type === 'handoffFile') return 'handoffFile';
  if (['file', 'folder', 'renamed', 'deleted'].includes(type)) return type;
  return type || 'unknown';
}

function buildArtifactComparisonItem(type, artifact, details = {}) {
  const normalizedType = normalizeArtifactComparisonType(type);
  const normalizedArtifact = normalizeArtifactComparisonPath(artifact);
  return {
    type: normalizedType,
    artifact: normalizedArtifact,
    key: normalizedType + ':' + normalizedArtifact,
    ...details
  };
}

function buildRunActualArtifactEvidence(run, operationHistory = [], workflows = [], snapshot = null) {
  if (!run || run.id == null) return [];
  const actual = [];

  operationHistory.forEach(record => {
    if (!record || record.runId !== run.id || record.error) return;
    const args = record.args || {};
    const result = record.result || {};

    if (record.operation === 'writeFile') {
      actual.push(buildArtifactComparisonItem('file', result.path || args.path, {
        operation: 'writeFile',
        source: record.id != null ? 'Operation #' + record.id : 'operation-history'
      }));
      return;
    }

    if (record.operation === 'createFolder' && (
      result.status === 'created' ||
      (result.status === 'already_exists_noop' && record.preState && record.preState.type === 'directory')
    )) {
      actual.push(buildArtifactComparisonItem('folder', result.path || args.path, {
        operation: 'createFolder',
        source: record.id != null ? 'Operation #' + record.id : 'operation-history'
      }));
      return;
    }

    if (record.operation === 'renamePath') {
      actual.push(buildArtifactComparisonItem('renamed', result.path || args.nextPath, {
        operation: 'renamePath',
        source: record.id != null ? 'Operation #' + record.id : 'operation-history'
      }));
      return;
    }

    if (record.operation === 'deletePath' && result.status === 'deleted') {
      actual.push(buildArtifactComparisonItem('deleted', result.path || args.path, {
        operation: 'deletePath',
        source: record.id != null ? 'Operation #' + record.id : 'operation-history'
      }));
    }
  });

  const workflowDrafts = snapshot && Array.isArray(snapshot.workflowDrafts) ? snapshot.workflowDrafts : [];
  workflowDrafts.forEach(draft => {
    if (!draft) return;
    const workflowId = draft.workflowId || draft.id;
    const workflow = workflowId ? workflows.find(item => item && item.id === workflowId) : null;
    actual.push(buildArtifactComparisonItem('workflowDraft', workflowId || draft.name || (workflow && workflow.name), {
      operation: 'workflowDraft',
      source: 'Workflow draft'
    }));
  });

  const workspaceOperations = snapshot && Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations : [];
  workspaceOperations.forEach((item, index) => {
    if (!item || item.error || !item.handoffTask) return;
    const operation = item.operation && typeof item.operation === 'object' ? item.operation.operation : item.operation;
    const args = item.operation && typeof item.operation === 'object' ? item.operation.args || {} : {};
    const result = item.result || {};
    if (operation !== 'writeFile') return;
    actual.push(buildArtifactComparisonItem('handoffFile', result.path || args.path, {
      operation: 'createHandoffTask',
      source: 'Handoff workspace operation #' + (index + 1)
    }));
  });

  return actual.filter(item => item.artifact && item.artifact !== '-');
}

function buildArtifactPredictionComparison(run, snapshot, operationHistory = [], workflows = []) {
  const prediction = snapshot && snapshot.artifactPrediction ? snapshot.artifactPrediction : null;
  const predicted = prediction && Array.isArray(prediction.artifacts)
    ? prediction.artifacts.map(item => buildArtifactComparisonItem(item.type, item.artifact, {
      operation: item.operation || null,
      source: 'artifactPrediction',
      step: item.step,
      actionIndex: item.actionIndex
    })).filter(item => item.artifact && item.artifact !== '-')
    : [];
  const actual = buildRunActualArtifactEvidence(run, operationHistory, workflows, snapshot);
  const predictedKeys = new Set(predicted.map(item => item.key));
  const actualKeys = new Set(actual.map(item => item.key));

  return {
    matched: predicted.filter(item => actualKeys.has(item.key)),
    missing: predicted.filter(item => !actualKeys.has(item.key)),
    unexpected: actual.filter(item => !predictedKeys.has(item.key))
  };
}

function buildArtifactAccuracy(snapshot, comparison = {}) {
  const prediction = snapshot && snapshot.artifactPrediction ? snapshot.artifactPrediction : null;
  const predictedArtifacts = prediction && Array.isArray(prediction.artifacts) ? prediction.artifacts : [];
  const matched = Array.isArray(comparison.matched) ? comparison.matched.length : 0;
  const missing = Array.isArray(comparison.missing) ? comparison.missing.length : 0;
  const unexpected = Array.isArray(comparison.unexpected) ? comparison.unexpected.length : 0;
  const total = matched + missing + unexpected;

  if (predictedArtifacts.length === 0 || total === 0) {
    return {
      scored: false,
      score: null,
      percent: null,
      matched,
      total,
      missing,
      unexpected
    };
  }

  const score = matched / total;
  return {
    scored: true,
    score,
    percent: Math.round(score * 100),
    matched,
    total,
    missing,
    unexpected
  };
}

function isRunVerificationRequired(run) {
  const executionPolicy = copyExecutionPolicy(
    run && run.executionPolicySnapshot,
    runWorkspaceScope(run)
  );
  if (executionPolicy.requireVerification !== 'when_declared') return false;
  if (!run || run.executionMode !== 'workflow' || !run.workflowId) return false;
  const capturedContract = normalizeVerificationContractSnapshot(run.verificationContractSnapshot);
  if (capturedContract) return capturedContract.postconditions.length > 0;
  const workflow = getWorkflowById(run.workflowId);
  return Boolean(workflow && Array.isArray(workflow.postconditions) && workflow.postconditions.length > 0);
}

function buildObjectiveSuccess(run) {
  if (!run || !run.status) {
    return { scored: false, status: 'unknown', score: null, percent: null, reason: 'No run status available' };
  }

  if (run.status === 'completed') {
    const evaluation = run.runEvaluation || buildRunEvaluation(run);
    const verificationStatus = evaluation && evaluation.effectiveness
      ? evaluation.effectiveness.status
      : 'unknown';
    if (verificationStatus === 'failed') {
      return { scored: true, status: 'failed', score: 0, percent: 0, reason: 'Verification failed' };
    }
    const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
    const hasVerifiedDirectPostcondition = Array.isArray(snapshot.events) &&
      snapshot.events.some(event => event && event.type === 'run:postcondition_completed');
    if (verificationStatus === 'passed' || hasVerifiedDirectPostcondition) {
      return { scored: true, status: 'succeeded', score: 1, percent: 100, reason: 'Verification passed' };
    }
    return { scored: false, status: 'unverified', score: null, percent: null, reason: 'Run completed without a passing verification verdict' };
  }

  if (run.status === 'failed') {
    return { scored: true, status: 'failed', score: 0, percent: 0, reason: run.error || 'Run failed' };
  }

  if (run.status === 'interrupted') {
    return { scored: true, status: 'interrupted', score: 0, percent: 0, reason: run.error || 'Run interrupted' };
  }

  return { scored: false, status: 'unknown', score: null, percent: null, reason: 'Run is not terminal' };
}

function addCoveragePath(pathSet, value) {
  const normalized = normalizeObjectivePathToken(value);
  if (normalized) pathSet.add(normalized);
}

function collectWorkflowDraftCoveragePathsFromWorkflow(pathSet, workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return;

  if (Array.isArray(workflow.actions)) {
    workflow.actions.forEach(action => {
      if (!action || typeof action !== 'object') return;
      const input = action.input && typeof action.input === 'object' && !Array.isArray(action.input)
        ? action.input
        : {};
      addCoveragePath(pathSet, input.path);
    });
  }

  if (Array.isArray(workflow.postconditions)) {
    workflow.postconditions.forEach(postcondition => {
      if (!postcondition || typeof postcondition !== 'object') return;
      addCoveragePath(pathSet, postcondition.path);
    });
  }
}

function buildObjectiveCoveragePlannedPaths(snapshot) {
  const pathSet = new Set();
  const prediction = snapshot && snapshot.artifactPrediction ? snapshot.artifactPrediction : null;
  const predictedArtifacts = prediction && Array.isArray(prediction.artifacts) ? prediction.artifacts : [];
  predictedArtifacts.forEach(item => addCoveragePath(pathSet, item && item.artifact));

  const parsedPlans = snapshot && Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans : [];
  const firstPlan = parsedPlans[0] || null;
  const actions = firstPlan && Array.isArray(firstPlan.actions) ? firstPlan.actions : [];
  actions.forEach(action => {
    if (!action || typeof action !== 'object') return;
    const operation = action.operation;
    const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args)
      ? action.args
      : {};

    if (operation === 'createWorkflowDraftIntent') {
      if (Array.isArray(args.writes)) {
        args.writes.forEach(write => {
          if (!write || typeof write !== 'object') return;
          addCoveragePath(pathSet, write.path);
        });
      }
      if (Array.isArray(args.postconditions)) {
        args.postconditions.forEach(postcondition => {
          if (!postcondition || typeof postcondition !== 'object') return;
          addCoveragePath(pathSet, postcondition.path);
        });
      }
      return;
    }

    if (operation === 'createWorkflowDraft') {
      collectWorkflowDraftCoveragePathsFromWorkflow(pathSet, args.workflow);
    }
  });

  return Array.from(pathSet);
}

function buildObjectivePathCoverage(ticket, snapshot) {
  const objectivePaths = extractObjectivePathTokens(ticket && ticket.objective);
  const plannedPaths = buildObjectiveCoveragePlannedPaths(snapshot);

  if (objectivePaths.length === 0) {
    return {
      scored: false,
      percent: null,
      covered: 0,
      total: 0,
      missing: [],
      objectivePaths,
      plannedPaths
    };
  }

  const plannedPathSet = new Set(plannedPaths);
  const missing = objectivePaths.filter(pathItem => !plannedPathSet.has(pathItem));
  const covered = objectivePaths.length - missing.length;

  return {
    scored: true,
    percent: Math.round((covered / objectivePaths.length) * 100),
    covered,
    total: objectivePaths.length,
    missing,
    objectivePaths,
    plannedPaths
  };
}

// Display-only review-status derivation. Separates execution completion ("did the
// run finish?") from evidence/objective review ("does the result need a look?").
// It only reads already-computed evidence signals (objective path coverage,
// artifact accuracy, artifact prediction comparison) — it does not change any
// scoring, completion, or postcondition logic. Failed/interrupted runs already
// explain the next action through their failure status, so they are not flagged.
function buildRunReviewStatus(run, { objectivePathCoverage, artifactAccuracy, comparison } = {}) {
  if (!run || run.status !== 'completed') {
    return { applicable: false, needsReview: false, reasons: [] };
  }

  const coverage = objectivePathCoverage || {};
  const accuracy = artifactAccuracy || {};
  const cmp = comparison || {};
  const missing = Array.isArray(cmp.missing) ? cmp.missing : [];
  const unexpected = Array.isArray(cmp.unexpected) ? cmp.unexpected : [];
  const artifactName = item => (item && item.artifact) || (item && item.key) || null;

  const warnings = [];
  if (coverage.scored === false) {
    warnings.push('Objective path coverage was not scored.');
  } else if (typeof coverage.percent === 'number' && coverage.percent < 100) {
    warnings.push(`Objective path coverage is ${coverage.percent}% (${coverage.covered}/${coverage.total} planned).`);
  }
  if (accuracy.scored && typeof accuracy.percent === 'number' && accuracy.percent < 100) {
    warnings.push(`Artifact accuracy is ${accuracy.percent}% (${accuracy.matched}/${accuracy.total} matched).`);
  }
  if (missing.length > 0) {
    warnings.push(`Missing expected artifact${missing.length === 1 ? '' : 's'}: ${missing.map(artifactName).filter(Boolean).slice(0, 5).join(', ')}.`);
  }
  if (unexpected.length > 0) {
    warnings.push(`Unexpected artifact${unexpected.length === 1 ? '' : 's'}: ${unexpected.map(artifactName).filter(Boolean).slice(0, 5).join(', ')}.`);
  }

  if (warnings.length === 0) {
    return { applicable: true, needsReview: false, reasons: [] };
  }

  // The standing truthfulness caveat is listed first when review is flagged, then
  // the concrete evidence warnings that actually triggered the flag.
  return {
    applicable: true,
    needsReview: true,
    reasons: ['The full ticket objective was not independently verified.', ...warnings]
  };
}

function buildTicketArtifacts(operationHistory = [], workflows = [], ticketRuns = []) {
  const runIds = new Set(ticketRuns.map(run => run.id));
  const artifacts = [];

  operationHistory.forEach(record => {
    if (!record || record.error) return;
    if (!runIds.has(record.runId)) return;

    const args = record.args || {};
    const result = record.result || {};
    const base = {
      id: `operation:${record.id}`,
      runId: record.runId,
      source: `Operation #${record.id}`,
      timestamp: record.timestamp || null
    };

    if (record.operation === 'writeFile') {
      artifacts.push({
        ...base,
        type: 'file',
        artifact: result.path || args.path || '-',
        status: buildWriteFileArtifactStatus(record, operationHistory, runIds)
      });
      return;
    }

    if (record.operation === 'createFolder' && result.status === 'created') {
      artifacts.push({
        ...base,
        type: 'folder',
        artifact: result.path || args.path || '-',
        status: 'created'
      });
      return;
    }

    if (record.operation === 'renamePath') {
      const sourcePath = args.path || '-';
      const destinationPath = result.path || args.nextPath || '-';
      artifacts.push({
        ...base,
        type: 'renamed',
        artifact: `${sourcePath} -> ${destinationPath}`,
        status: 'renamed'
      });
      return;
    }

    if (record.operation === 'deletePath' && result.status === 'deleted') {
      artifacts.push({
        ...base,
        type: 'deleted',
        artifact: result.path || args.path || '-',
        status: 'deleted'
      });
    }
  });

  workflows.forEach(workflow => {
    if (!workflow || workflow.createdByType !== 'agent') return;
    if (!runIds.has(workflow.createdByRunId)) return;

    const actionCount = Array.isArray(workflow.actions) ? workflow.actions.length : 0;
    const postconditionCount = Array.isArray(workflow.postconditions) ? workflow.postconditions.length : 0;
    artifacts.push({
      id: `workflow:${workflow.id}`,
      type: 'workflow draft',
      artifact: workflow.id || workflow.name || '-',
      status: workflow.enabled ? 'enabled' : 'disabled',
      runId: workflow.createdByRunId,
      source: `${actionCount} action${actionCount === 1 ? '' : 's'}, ${postconditionCount} postcondition${postconditionCount === 1 ? '' : 's'}`,
      timestamp: workflow.createdAt || workflow.updatedAt || null
    });
  });

  return artifacts.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
}

function findOperationHistoryRecord(recordId) {
  return readOperationHistory().find(record => record.id === recordId) || null;
}

function isActualWorkspaceMutation(record) {
  if (record.error) return false;
  if (!AGENT_MUTATING_OPERATIONS.includes(record.operation)) return false;

  if (record.operation === 'createFolder') {
    return record.result && record.result.status === 'created';
  }

  if (record.operation === 'deletePath') {
    return record.result && record.result.status === 'deleted';
  }

  if (record.operation === 'writeFile') {
    return true;
  }

  if (record.operation === 'renamePath') {
    return true;
  }

  return false;
}

function countRunMutatingOperations(runId, history = readOperationHistory()) {
  return history.filter(record =>
    record.runId === runId && isActualWorkspaceMutation(record)
  ).length;
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  items.forEach(item => {
    const key = keyFn(item);
    const existing = grouped.get(key) || [];
    existing.push(item);
    grouped.set(key, existing);
  });
  return grouped;
}

function buildMutationCountByRunId(history) {
  const counts = new Map();
  history.forEach(record => {
    if (!isActualWorkspaceMutation(record)) return;
    counts.set(record.runId, (counts.get(record.runId) || 0) + 1);
  });
  return counts;
}

function getCurrentWorkspacePathInfo(relativePath) {
  try {
    return workspaceProvider.getPathInfo(relativePath);
  } catch (error) {
    return { exists: false, error: error.message || 'Workspace path access failed' };
  }
}

function getOperatorWorkspacePathInfo(relativePath) {
  try {
    return workspaceProvider.getPathInfo(relativePath, { allowHidden: true });
  } catch (error) {
    return { exists: false, error: error.message || 'Workspace path access failed' };
  }
}

function captureOperatorWorkspaceState(paths) {
  return Array.from(new Set(paths.filter(pathValue => pathValue != null).map(pathValue => String(pathValue)))).map(pathValue => ({
    path: pathValue,
    info: getOperatorWorkspacePathInfo(pathValue)
  }));
}

function captureWorkspaceRootListing() {
  try {
    return workspaceProvider.list('', { allowHidden: true });
  } catch (error) {
    return { error: error.message || 'Workspace root listing failed' };
  }
}

function classifyOperationRecoverability(record, recoveredIds = null) {
  if (record.isRecovery) {
    return { status: 'recovery_action', reason: 'This operation is a recovery action' };
  }
  if (record.error) {
    return { status: 'unrecoverable', reason: 'Operation failed' };
  }

  if (recoveredIds && recoveredIds.has(record.id)) {
    return { status: 'recovery_available', reason: 'Already recovered' };
  }

  const histories = readOperationHistory();
  const existingRecovery = histories.find(h => h.recoveredHistoryId === record.id);
  if (existingRecovery) {
    return { status: 'recovery_available', reason: `Recovered in history #${existingRecovery.id}` };
  }

  if (record.operation === 'writeFile') {
    if (!record.preState) {
      return { status: 'unrecoverable', reason: 'Missing pre-state' };
    }
    if (record.preState.existed === false) {
      return { status: 'recoverable', reason: 'Delete created file' };
    }
    if (record.preState.existed === true && record.preState.content != null) {
      return { status: 'recoverable', reason: 'Restore previous contents' };
    }
    return { status: 'unrecoverable', reason: 'Previous content not captured' };
  }

  if (record.operation === 'renamePath') {
    if (!record.preState || !record.preState.source) {
      return { status: 'unrecoverable', reason: 'Missing pre-state' };
    }
    if (record.preState.source.existed === true) {
      return { status: 'recoverable', reason: 'Restore original path' };
    }
    return { status: 'unrecoverable', reason: 'Source did not exist before rename' };
  }

  if (record.operation === 'deletePath') {
    return { status: 'unrecoverable', reason: 'Deleted content not stored' };
  }

  return { status: 'unrecoverable', reason: 'Operation type not supported for recovery' };
}

function validateRecoveryWorkspaceState(record) {
  if (record.operation === 'writeFile') {
    const currentInfo = getCurrentWorkspacePathInfo(record.args.path);
    if (currentInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${currentInfo.error}` };
    }
    if (!currentInfo.exists) {
      return { valid: false, reason: `File no longer exists at ${record.args.path}` };
    }
    if (currentInfo.type !== 'file') {
      return { valid: false, reason: `Path ${record.args.path} is no longer a file` };
    }
    if (!record.postState || !record.postState.contentHash) {
      return { valid: false, reason: 'Missing post-state content hash for validation' };
    }
    if (currentInfo.contentHash !== record.postState.contentHash) {
      return { valid: false, reason: `File content has diverged from expected state at ${record.args.path}` };
    }
    return { valid: true };
  }

  if (record.operation === 'renamePath') {
    const sourceInfo = getCurrentWorkspacePathInfo(record.args.path);
    const destInfo = getCurrentWorkspacePathInfo(record.args.nextPath);
    if (sourceInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${sourceInfo.error}` };
    }
    if (destInfo.error) {
      return { valid: false, reason: `Cannot access workspace path: ${destInfo.error}` };
    }
    if (sourceInfo.exists) {
      return { valid: false, reason: `Original source path still exists: ${record.args.path}` };
    }
    if (!destInfo.exists) {
      return { valid: false, reason: `Destination path no longer exists: ${record.args.nextPath}` };
    }
    if (record.postState && record.postState.destination && record.postState.destination.type) {
      if (destInfo.type !== record.postState.destination.type) {
        return { valid: false, reason: `Destination type has changed at ${record.args.nextPath}` };
      }
    }
    if (record.postState && record.postState.destination && record.postState.destination.contentHash) {
      if (destInfo.contentHash !== record.postState.destination.contentHash) {
        return { valid: false, reason: `Destination content has diverged from expected state at ${record.args.nextPath}` };
      }
    }
    return { valid: true };
  }

  return { valid: false, reason: 'Unsupported operation for recovery validation' };
}

function buildRecoveryAction(record) {
  if (record.operation === 'writeFile') {
    if (record.preState && record.preState.existed === true && record.preState.content != null) {
      return { operation: 'writeFile', args: { path: record.args.path, content: record.preState.content } };
    }
    return { operation: 'deletePath', args: { path: record.args.path } };
  }

  if (record.operation === 'renamePath') {
    return { operation: 'renamePath', args: { path: record.args.nextPath, nextPath: record.args.path } };
  }

  return null;
}

function previewRecovery(record) {
  const classification = classifyOperationRecoverability(record);

  if (classification.status !== 'recoverable') {
    return { ...classification, canProceed: false, proposedAction: null, validation: null };
  }

  const proposedAction = buildRecoveryAction(record);
  if (!proposedAction) {
    return { ...classification, canProceed: false, proposedAction: null, validation: { valid: false, reason: 'Could not determine recovery action' } };
  }

  const validation = validateRecoveryWorkspaceState(record);

  return {
    ...classification,
    canProceed: validation.valid,
    proposedAction,
    validation
  };
}

function persistRecoveryOperationHistory(originalRecord, recoveryAction, preState, postState, result, error) {
  const histories = readOperationHistory();
  const newId = nextId(histories);
  const record = {
    id: newId,
    timestamp: createLogTimestamp(),
    ticketId: originalRecord.ticketId,
    allocationPlanId: originalRecord.allocationPlanId || null,
    allocationItemId: originalRecord.allocationItemId || null,
    runId: originalRecord.runId,
    step: originalRecord.step,
    operation: recoveryAction.operation,
    args: sanitizeSnapshotValue(recoveryAction.args),
    preState,
    postState,
    result: error ? null : sanitizeSnapshotValue(result),
    error: error ? (error.message || String(error)) : null,
    isRecovery: true,
    recoveredHistoryId: originalRecord.id
  };
  histories.push(record);
  writeOperationHistory(histories);
  return record;
}

function executeRecovery(record, confirmed = false) {
  const preview = previewRecovery(record);

  if (!preview.canProceed) {
    const reason = preview.validation && preview.validation.reason ? preview.validation.reason : 'Recovery not possible';
    throw new Error(reason);
  }

  if (!confirmed) {
    throw new Error('Recovery requires explicit confirmation');
  }

  const recoveryAction = preview.proposedAction;

  if (recoveryAction.operation === 'deletePath') {
    const preState = { existed: true, type: 'file', contentHash: getCurrentWorkspacePathInfo(recoveryAction.args.path).contentHash || undefined };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.delete(recoveryAction.args.path);
    } catch (e) {
      error = e;
    }
    const postState = { existed: false };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  if (recoveryAction.operation === 'writeFile') {
    const preInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const preState = { existed: preInfo.exists, type: preInfo.type || undefined, contentHash: preInfo.contentHash || undefined };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.writeFile(recoveryAction.args.path, recoveryAction.args.content);
    } catch (e) {
      error = e;
    }
    const postInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const postState = { existed: postInfo.exists, type: postInfo.type || undefined, contentHash: postInfo.contentHash || undefined };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  if (recoveryAction.operation === 'renamePath') {
    const sourceInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const destInfo = getCurrentWorkspacePathInfo(recoveryAction.args.nextPath);
    const preState = {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined, contentHash: sourceInfo.contentHash || undefined },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined }
    };
    let result = null;
    let error = null;
    try {
      result = workspaceProvider.rename(recoveryAction.args.path, recoveryAction.args.nextPath);
    } catch (e) {
      error = e;
    }
    const postSourceInfo = getCurrentWorkspacePathInfo(recoveryAction.args.path);
    const postDestInfo = getCurrentWorkspacePathInfo(recoveryAction.args.nextPath);
    const postState = {
      source: { existed: postSourceInfo.exists, type: postSourceInfo.type || undefined },
      destination: { existed: postDestInfo.exists, type: postDestInfo.type || undefined, contentHash: postDestInfo.contentHash || undefined }
    };
    const recoveryRecord = persistRecoveryOperationHistory(record, recoveryAction, preState, postState, result, error);
    if (error) throw error;
    return recoveryRecord;
  }

  throw new Error('Unsupported recovery action');
}

function enrichOperationHistoryForDisplay(history) {
  const recoveredIds = new Set(
    history.filter(h => h.recoveredHistoryId != null).map(h => h.recoveredHistoryId)
  );
  return history.map(record => ({
    ...record,
    recoveryStatus: classifyOperationRecoverability(record, recoveredIds)
  }));
}

function usageTokenTotal(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;

  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const total = promptTokens + completionTokens + inputTokens + outputTokens;

  return total > 0 ? total : null;
}

function buildRunMetrics(run, runLogs) {
  const startedAt = run.startedAt || null;
  const completedAt = run.completedAt || null;
  const durationMs = startedAt && completedAt
    ? Math.max(0, new Date(completedAt) - new Date(startedAt))
    : null;
  const totalTokens = runLogs.reduce((total, log) => {
    const tokenTotal = usageTokenTotal(log.usage);
    return tokenTotal === null ? total : total + tokenTotal;
  }, 0);

  return {
    runId: run.id,
    agentId: run.agentId,
    ticketId: run.ticketId,
    startedAt,
    completedAt,
    durationMs,
    status: run.status,
    totalModelRequests: runLogs.filter(log => log.type === 'model:request').length,
    totalModelResponses: runLogs.filter(log => log.type === 'model:response').length,
    totalWorkspaceReads: runLogs.filter(log => log.type === 'workspace:read').length,
    totalWorkspaceWrites: runLogs.filter(log => log.type === 'workspace:write').length,
    // This guard relies on createFolder logs setting workspaceAction.kind to 'folder'.
    totalFilesCreated: runLogs.filter(log => log.type === 'workspace:create' && (!log.workspaceAction || log.workspaceAction.kind !== 'folder')).length,
    totalFilesModified: runLogs.filter(log => log.type === 'workspace:write').length,
    totalFilesDeleted: runLogs.filter(log => log.type === 'workspace:delete').length,
    totalTokensUsed: totalTokens > 0 ? totalTokens : null,
    totalEstimatedCost: null
  };
}

function average(values) {
  const numericValues = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (numericValues.length === 0) return null;
  return numericValues.reduce((total, value) => total + value, 0) / numericValues.length;
}

function isTerminalRun(run) {
  return Boolean(run && ['completed', 'failed', 'interrupted'].includes(run.status));
}

function getRunModelName(run, snapshot, agentsById = new Map()) {
  if (snapshot && typeof snapshot.model === 'string' && snapshot.model.trim()) return snapshot.model.trim();
  if (run && run.replaySummary && typeof run.replaySummary.model === 'string' && run.replaySummary.model.trim()) return run.replaySummary.model.trim();
  const agent = run ? agentsById.get(run.agentId) : null;
  if (agent && typeof agent.model === 'string' && agent.model.trim()) return agent.model.trim();
  return 'unknown';
}

function buildRunQualityMetrics(run, ticket, operationHistory = [], workflows = []) {
  const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
  const comparison = buildArtifactPredictionComparison(run, snapshot, operationHistory, workflows);
  return {
    artifactAccuracy: buildArtifactAccuracy(snapshot, comparison),
    objectiveSuccess: buildObjectiveSuccess(run),
    objectivePathCoverage: buildObjectivePathCoverage(ticket, snapshot)
  };
}

function buildEmptyQualityAggregation() {
  return {
    runs: 0,
    artifactAccuracyAvg: null,
    objectiveSuccessRate: null,
    objectivePathCoverageAvg: null,
    disagreements: {
      accuracyVsSuccess: 0,
      successVsCoverage: 0,
      accuracyVsCoverage: 0
    }
  };
}

function aggregateQualityMetrics(runQualityItems = []) {
  const aggregation = buildEmptyQualityAggregation();
  aggregation.runs = runQualityItems.length;

  const artifactValues = [];
  const successValues = [];
  const coverageValues = [];

  runQualityItems.forEach(item => {
    const artifact = item && item.artifactAccuracy;
    const success = item && item.objectiveSuccess;
    const coverage = item && item.objectivePathCoverage;

    if (artifact && artifact.scored && typeof artifact.percent === 'number' && Number.isFinite(artifact.percent)) {
      artifactValues.push(artifact.percent);
    }
    if (success && success.scored && typeof success.percent === 'number' && Number.isFinite(success.percent)) {
      successValues.push(success.percent);
    }
    if (coverage && coverage.scored && typeof coverage.percent === 'number' && Number.isFinite(coverage.percent)) {
      coverageValues.push(coverage.percent);
    }

    if (artifact && artifact.scored && success && success.scored && artifact.percent !== success.percent) {
      aggregation.disagreements.accuracyVsSuccess += 1;
    }
    if (success && success.scored && coverage && coverage.scored && success.percent !== coverage.percent) {
      aggregation.disagreements.successVsCoverage += 1;
    }
    if (artifact && artifact.scored && coverage && coverage.scored && artifact.percent !== coverage.percent) {
      aggregation.disagreements.accuracyVsCoverage += 1;
    }
  });

  aggregation.artifactAccuracyAvg = artifactValues.length > 0 ? Math.round(average(artifactValues)) : null;
  aggregation.objectiveSuccessRate = successValues.length > 0 ? Math.round(average(successValues)) : null;
  aggregation.objectivePathCoverageAvg = coverageValues.length > 0 ? Math.round(average(coverageValues)) : null;
  return aggregation;
}

function getAgentPerformanceMetrics() {
  const runs = readRuns();
  const logs = readLogs();
  const ticketsById = new Map(readTickets().map(ticket => [ticket.id, ticket]));
  const workflows = readWorkflows();
  const operationHistory = readOperationHistory();
  const runsByAgentId = groupBy(runs, run => run.agentId);
  const logsByRunId = groupBy(logs, log => log.runId);
  const workspaceActionTypes = new Set([
    'workspace:list',
    'workspace:read',
    'workspace:write',
    'workspace:create',
    'workspace:rename',
    'workspace:delete'
  ]);

  return readAgents().map(agent => {
    const agentRuns = runsByAgentId.get(agent.id) || [];
    const terminalRuns = agentRuns.filter(isTerminalRun);
    const runMetrics = agentRuns.map(run => buildRunMetrics(run, logsByRunId.get(run.id) || []));
    const completedRuns = runMetrics.filter(run => run.status === 'completed');
    const failedRuns = runMetrics.filter(run => run.status === 'failed');
    const activeRuns = runMetrics.filter(run => ['pending', 'running'].includes(run.status));
    const qualityAggregation = aggregateQualityMetrics(terminalRuns.map(run =>
      buildRunQualityMetrics(run, ticketsById.get(run.ticketId), operationHistory, workflows)
    ));
    const totalWorkspaceActions = agentRuns.reduce((total, run) => {
      return total + (logsByRunId.get(run.id) || []).filter(log => workspaceActionTypes.has(log.type)).length;
    }, 0);
    const lastRun = agentRuns
      .slice()
      .sort((a, b) => new Date(b.updatedAt || b.completedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.completedAt || a.startedAt || a.createdAt || 0))[0];

    return {
      agent,
      runMetrics,
      totalRuns: runMetrics.length,
      successfulRuns: completedRuns.length,
      failedRuns: failedRuns.length,
      activeRuns: activeRuns.length,
      averageDurationMs: average(runMetrics.map(run => run.durationMs)),
      averageTokenUsage: average(runMetrics.map(run => run.totalTokensUsed)),
      averageEstimatedCost: null,
      totalWorkspaceActions,
      lastRunTimestamp: lastRun ? (lastRun.completedAt || lastRun.startedAt || lastRun.createdAt || null) : null,
      quality: qualityAggregation
    };
  });
}

function getModelPerformanceMetrics() {
  const runs = readRuns();
  const ticketsById = new Map(readTickets().map(ticket => [ticket.id, ticket]));
  const workflows = readWorkflows();
  const operationHistory = readOperationHistory();
  const agentsById = new Map(readAgents().map(agent => [agent.id, agent]));
  const models = new Map();

  runs.filter(isTerminalRun).forEach(run => {
    const snapshot = readRunReplaySnapshot(run) || run.replaySnapshot || {};
    const model = getRunModelName(run, snapshot, agentsById);
    if (!models.has(model)) models.set(model, []);
    models.get(model).push(buildRunQualityMetrics(run, ticketsById.get(run.ticketId), operationHistory, workflows));
  });

  return Array.from(models.entries())
    .map(([model, qualityItems]) => ({
      model,
      ...aggregateQualityMetrics(qualityItems)
    }))
    .sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
}

function getTicketAssignableGroups() {
  return readGroups().filter(group => group.canReceiveTickets === true);
}

function getMembershipGroups() {
  return readGroups();
}

function getPrincipalGroupIds(principalType, principalId) {
  return readMemberships()
    .filter(membership => membership.principalType === principalType && membership.principalId === principalId)
    .map(membership => membership.groupId);
}

function getGroupPermissionNames(groupId) {
  const group = readGroups().find(item => item.id === groupId);
  return group && Array.isArray(group.permissions) ? group.permissions : [];
}

function renderAdminUserForm(reply, request, options = {}) {
  const accountType = options.accountType === 'agent' ? 'agent' : 'user';
  const editAccount = options.editAccount || null;
  const userGroups = options.userGroups ?? (
    editAccount ? getPrincipalGroupIds(accountType, editAccount.id) : []
  );

  return reply.view('admin/user-form.ejs', viewData({
    user: request.user,
    editAccount,
    accountType,
    groups: getMembershipGroups(),
    userGroups,
    providers: PROVIDERS,
    models: MODELS,
    hasOpenAIApiKeyFallback: Boolean(String(process.env.OPENAI_API_KEY || '').trim()),
    hasOpenAIModelFallback: Boolean(String(process.env.OPENAI_MODEL || '').trim()),
    hasOllamaModelFallback: Boolean(String(process.env.OLLAMA_MODEL || '').trim()),
    error: options.error || null
  }, request.session.userId));
}

function renderAdminGroupForm(reply, request, options = {}) {
  const editGroup = options.editGroup || null;
  const groupPermissions = options.groupPermissions ?? (editGroup ? getGroupPermissionNames(editGroup.id) : []);

  return reply.view('admin/group-form.ejs', viewData({
    user: request.user,
    editGroup,
    allPermissions: readPermissions(),
    groupPermissions,
    error: options.error || null
  }, request.session.userId));
}

// ==================== PERMISSION SYSTEM ====================

function getUserPermissions(userId) {
  const userGroupIds = getPrincipalGroupIds('user', userId);
  const groups = readGroups();
  const permissions = new Set();
  
  groups.forEach(group => {
    if (userGroupIds.includes(group.id)) {
      group.permissions.forEach(permission => permissions.add(permission));
    }
  });
  
  return Array.from(permissions);
}

function hasPermission(userId, permission) {
  const userPermissions = getUserPermissions(userId);
  return userPermissions.includes(permission);
}

// ==================== AGENT RUNS ====================

function updateRunStatus(runId, status, error = null) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);

  if (!run) return null;
  if (run.status === 'interrupted' && status !== 'interrupted') return run;
  if (run.status === status && !error) return run;

  run.status = status;
  run.updatedAt = new Date().toISOString();
  if (status === 'running') run.startedAt = run.startedAt || run.updatedAt;
  if (status === 'completed' || status === 'failed' || status === 'interrupted') run.completedAt = run.updatedAt;
  if (error) run.error = sanitizeLogMessage(error);
  writeRuns(runs);
  updateAllocationItemStatus(run, status);
  return run;
}

function updateRunReplaySnapshot(runId, updater) {
  const run = readRuns().find(item => item.id === runId);

  if (!run) return null;

  const currentSnapshot = readRunReplaySnapshot(run);
  const nextSnapshot = updater(currentSnapshot);
  if (!nextSnapshot) return null;
  return writeRunReplaySnapshot(runId, nextSnapshot);
}

function createReplaySnapshotBase(run, overrides = {}) {
  return {
    version: 1,
    runId: run.id,
    ticketId: run.ticketId,
    assignedAgentId: run.agentId,
    agentNameSnapshot: run.agentName,
    primitiveContract: {
      allowedOperations: [...AGENT_ALLOWED_OPERATIONS],
      mutatingOperations: [...AGENT_MUTATING_OPERATIONS],
      requiredArgs: AGENT_OPERATION_ARGS
    },
    workspaceRoot: run.workspaceRoot || workspaceProvider.root,
    mainWorkspaceRoot: run.mainWorkspaceRoot || workspaceProvider.root,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    executionPolicySnapshot: copyExecutionPolicy(run.executionPolicySnapshot, runWorkspaceScope(run)),
    verificationContractSnapshot: normalizeVerificationContractSnapshot(run.verificationContractSnapshot),
    triage: normalizeTriage(run.triage),
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    allocationItem: getRunAllocationItem(run),
    allocationSubtask: run.allocationSubtask || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    ticketOpenedAt: run.ticketOpenedAt || null,
    runtimeLimits: getAgentRuntimeLimits(),
    providerRequests: [],
    modelResponses: [],
    parsedModelPlans: [],
    capabilitySelection: [],
    capabilityOutputs: [],
    workflowInvocation: [],
    authorityChecks: [],
    artifactPrediction: null,
    workflowDrafts: [],
    workflowDraftIntents: [],
    handoffTasks: [],
    workflowActions: [],
    workflowActionPlans: [],
    workflowTicketPlans: [],
    workspaceOperations: [],
    events: [],
    terminalStatus: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

function createRunReplaySnapshot(run, ticket, agent, providerConfig, runtimeEnvelope, systemInstructionSnapshot) {
  updateRunReplaySnapshot(run.id, currentSnapshot => currentSnapshot || createReplaySnapshotBase(run, {
    provider: providerConfig.provider,
    model: providerConfig.model,
    runtimeEnvelope,
    ticketObjectiveSnapshot: ticket.objective,
    executionPolicySnapshot: copyExecutionPolicy(run.executionPolicySnapshot, runWorkspaceScope(run)),
    verificationContractSnapshot: normalizeVerificationContractSnapshot(run.verificationContractSnapshot),
    systemInstructionSnapshot,
    effectiveRuntimeConfig: buildEffectiveRuntimeConfigSnapshot(agent)
  }));
}

function appendRunReplaySnapshotItem(runId, key, item) {
  updateRunReplaySnapshot(runId, snapshot => {
    if (!snapshot) return snapshot;
    const items = Array.isArray(snapshot[key]) ? snapshot[key] : [];

    return {
      ...snapshot,
      [key]: [...items, { ...item, capturedAt: new Date().toISOString() }]
    };
  });
}

function buildArtifactPredictionFromActions(actions = [], step = 0) {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const artifacts = [];

  actions.forEach((action, actionIndex) => {
    if (!action || typeof action !== 'object') return;
    const operation = action.operation;
    const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args)
      ? action.args
      : {};

    if (operation === 'writeFile' && typeof args.path === 'string' && args.path.trim()) {
      artifacts.push({ type: 'file', artifact: args.path, operation, step, actionIndex });
      return;
    }

    if (operation === 'createFolder' && typeof args.path === 'string' && args.path.trim()) {
      artifacts.push({ type: 'folder', artifact: args.path, operation, step, actionIndex });
      return;
    }

    if (operation === 'renamePath' && typeof args.nextPath === 'string' && args.nextPath.trim()) {
      artifacts.push({ type: 'renamed', artifact: args.nextPath, operation, step, actionIndex });
      return;
    }

    if (operation === 'deletePath' && typeof args.path === 'string' && args.path.trim()) {
      artifacts.push({ type: 'deleted', artifact: args.path, operation, step, actionIndex });
      return;
    }

    if (operation === 'createWorkflowDraftIntent' && typeof args.id === 'string' && args.id.trim()) {
      artifacts.push({ type: 'workflowDraft', artifact: args.id, operation, step, actionIndex });
      return;
    }

    const workflow = args.workflow && typeof args.workflow === 'object' && !Array.isArray(args.workflow)
      ? args.workflow
      : null;
    if (operation === 'createWorkflowDraft' && workflow && typeof workflow.id === 'string' && workflow.id.trim()) {
      artifacts.push({ type: 'workflowDraft', artifact: workflow.id, operation, step, actionIndex });
      return;
    }

    const handoffArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? args.args
      : {};
    if (operation === 'createHandoffTask' && args.operation === 'writeFile' && typeof handoffArgs.path === 'string' && handoffArgs.path.trim()) {
      artifacts.push({ type: 'handoffFile', artifact: handoffArgs.path, operation, step, actionIndex });
    }
  });

  if (artifacts.length === 0) return null;
  return {
    version: 1,
    source: 'parsedModelPlans',
    capturedAt: new Date().toISOString(),
    firstPredictedAtStep: step,
    artifacts
  };
}

function captureRunArtifactPrediction(runId, actions = [], step = 0) {
  const prediction = buildArtifactPredictionFromActions(actions, step);
  if (!prediction) return;
  updateRunReplaySnapshot(runId, snapshot => {
    if (!snapshot || snapshot.artifactPrediction) return snapshot;
    return {
      ...snapshot,
      artifactPrediction: prediction
    };
  });
}

function recordRunEvent(run, type, message, details = {}) {
  appendRunLog(run, type, message);
  appendRunReplaySnapshotItem(run.id, 'events', {
    type,
    message,
    ...details
  });
}

function recordReplayEvent(run, type, message, details = {}) {
  appendRunReplaySnapshotItem(run.id, 'events', {
    type,
    message,
    ...details
  });
}

function getPositiveIntegerEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getAgentRuntimeLimits(objective = null) {
  const base = {
    maxExecutionSteps: getPositiveIntegerEnv('AGENT_MAX_EXECUTION_STEPS', DEFAULT_AGENT_RUNTIME_LIMITS.maxExecutionSteps),
    maxWorkspaceOperationsPerRun: getPositiveIntegerEnv('AGENT_MAX_WORKSPACE_OPERATIONS_PER_RUN', DEFAULT_AGENT_RUNTIME_LIMITS.maxWorkspaceOperationsPerRun),
    maxModelRequestsPerRun: getPositiveIntegerEnv('AGENT_MAX_MODEL_REQUESTS_PER_RUN', DEFAULT_AGENT_RUNTIME_LIMITS.maxModelRequestsPerRun),
    maxRuntimeDurationMs: getPositiveIntegerEnv('AGENT_MAX_RUNTIME_DURATION_MS', DEFAULT_AGENT_RUNTIME_LIMITS.maxRuntimeDurationMs)
  };
  const profile = detectWorkloadProfile(objective);
  if (profile) {
    return getProfileRuntimeLimits(base, profile);
  }
  // Fallback to legacy report detection for backward compatibility
  if (isReportObjective(objective)) {
    return getReportRuntimeLimits(base);
  }
  return base;
}

function createRunLimitError(run, type, message, details) {
  const eventTypeByLimitType = {
    step: 'run:step_limit',
    operation: 'run:operation_limit',
    model_request: 'run:model_request_limit',
    mutating_action: 'run:mutating_action_limit',
    timeout: 'run:timeout'
  };
  const eventType = eventTypeByLimitType[type];

  recordRunEvent(run, eventType, message, {
    limitType: type,
    ...details
  });

  const error = new Error(message);
  error.code = 'RUN_LIMIT_EXCEEDED';
  error.limitType = type;
  error.details = details || {};
  return error;
}

function assertRunNotTimedOut(run, startedAtMs, limits) {
  const elapsedMs = Date.now() - startedAtMs;

  if (elapsedMs > limits.maxRuntimeDurationMs) {
    throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
      currentValue: elapsedMs,
      configuredLimit: limits.maxRuntimeDurationMs
    });
  }
}

function getRemainingRunTimeMs(startedAtMs, limits) {
  return Math.max(0, limits.maxRuntimeDurationMs - (Date.now() - startedAtMs));
}

async function callModelProviderWithRunTimeout(run, agent, input, startedAtMs, limits, options = {}) {
  const remainingMs = getRemainingRunTimeMs(startedAtMs, limits);

  if (remainingMs <= 0) {
    throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
      currentValue: Date.now() - startedAtMs,
      configuredLimit: limits.maxRuntimeDurationMs
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  try {
    return await callModelProvider(agent, input, {
      signal: controller.signal,
      onRequest: options.onRequest
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw createRunLimitError(run, 'timeout', `Agent run exceeded runtime duration limit of ${limits.maxRuntimeDurationMs}ms`, {
        currentValue: Date.now() - startedAtMs,
        configuredLimit: limits.maxRuntimeDurationMs
      });
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertRunModelRequestAllowed(run, currentCount, limits) {
  if (currentCount >= limits.maxModelRequestsPerRun) {
    throw createRunLimitError(run, 'model_request', `Agent run exceeded model request limit of ${limits.maxModelRequestsPerRun}`, {
      currentValue: currentCount,
      configuredLimit: limits.maxModelRequestsPerRun
    });
  }
}

function assertRunStepAllowed(run, currentStep, limits) {
  if (currentStep >= limits.maxExecutionSteps) {
    throw createRunLimitError(run, 'step', `Agent run exceeded execution step limit of ${limits.maxExecutionSteps}`, {
      currentValue: currentStep,
      configuredLimit: limits.maxExecutionSteps
    });
  }
}

function assertRunWorkspaceOperationAllowed(run, currentCount, incomingCount, limits) {
  const nextCount = currentCount + incomingCount;

  if (nextCount > limits.maxWorkspaceOperationsPerRun) {
    appendEvent({
      type: 'action.rejected',
      ticketId: run.ticketId,
      runId: run.id,
      stepId: String(run.currentStepId || ''),
      payload: {
        reason: 'workspace_operation_limit',
        currentCount,
        incomingCount,
        nextCount,
        limit: limits.maxWorkspaceOperationsPerRun
      }
    });
    throw createRunLimitError(run, 'operation', `Agent run exceeded workspace operation limit of ${limits.maxWorkspaceOperationsPerRun}`, {
      currentValue: nextCount,
      configuredLimit: limits.maxWorkspaceOperationsPerRun
    });
  }
}

function checkPostconditionCompletion(run, actions, actionResults, step) {
  if (!actions || actions.length === 0) return null;

  const mutatingIndices = actions
    .map((action, i) => ({ action, i }))
    .filter(({ action }) => action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation));

  if (mutatingIndices.length === 0) return null;

  if (actionResults.some(r => r.error)) return null;

  const hasNonMutating = actions.some((action, i) =>
    action && typeof action === 'object' && !AGENT_MUTATING_OPERATIONS.includes(action.operation)
  );
  if (hasNonMutating) return null;

  const histories = readOperationHistory();

  for (const { action, i } of mutatingIndices) {
    const ar = actionResults[i];
    if (!ar || !ar.result) return null;

    // Skipped mutations were already committed in a prior step; the
    // current workspace state already reflects them — treat as redundant.
    if (ar.result.skipped) continue;

    if (action.operation === 'createFolder') {
      if (ar.result.status !== 'already_exists_noop') return null;
    } else if (action.operation === 'deletePath') {
      if (ar.result.status !== 'already_missing_noop') return null;
    } else if (action.operation === 'writeFile') {
      const historyRecord = histories.find(h => h.id === ar.result.historyId);
      if (!historyRecord || !historyRecord.preState) return null;
      if (!historyRecord.preState.existed) return null;
      if (historyRecord.preState.content !== action.args.content) return null;
    } else if (action.operation === 'renamePath') {
      return null;
    }
  }

  return {
    reason: `All ${mutatingIndices.length} proposed workspace mutation(s) are redundant relative to current state`,
    mutatingActionCount: mutatingIndices.length
  };
}

function cleanObjectivePath(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`,.]+$/g, '')
    .replace(/^\/+/, '');
}

function cleanObjectiveContent(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+once\b[\s\S]*$/i, '')
    .trim();
}

// Compatibility wrapper (v0.1.29): the ensure/create simple-folder-list grammar now
// lives in objective-contract.js. This delegates to that single source while
// preserving the historical signature and return shape exactly — an array of folder
// paths for a recognized "ensure|create folder(s) X [Y …]" objective, or null
// otherwise (callers rely on the null/array truthiness).
function parseSimpleFolderListObjective(text, command) {
  return contractParseSimpleFolderListObjective(text, command);
}

function addFolderPostconditionChecks(checks, folderPaths) {
  folderPaths.forEach(folderPath => {
    checks.push({
      type: 'folder',
      path: folderPath,
      satisfied: () => {
        const info = workspaceProvider.getPathInfo(folderPath);
        return info.exists && info.type === 'directory';
      }
    });
  });
}

function readWorkspaceFileIfExists(relativePath) {
  const info = workspaceProvider.getPathInfo(relativePath);
  if (!info.exists || info.type !== 'file') return null;
  return workspaceProvider.readFile(relativePath);
}

// Extract the exact delete target(s) from a *simple* delete objective, or null if
// the objective is not a recognized simple delete. Deliberately conservative: the
// whole objective must be a single "delete|remove [the] [file|folder|directory|
// path] <one-token-path>" form. Anything with extra words, multiple targets, or
// connectors returns null (the guard then does nothing). Returns normalized
// relative path strings.
// Compatibility wrapper (v0.1.28): the simple-delete grammar now lives in
// objective-contract.js. This delegates to buildObjectiveContract and preserves the
// historical return shape exactly — an array of target paths for a recognized simple
// delete, or null otherwise (callers rely on the null/array truthiness).
function extractSimpleDeleteTargets(objective) {
  const contract = buildObjectiveContract(objective);
  if (contract && contract.recognized && contract.intent === 'delete' && contract.targetPath) {
    return [contract.targetPath];
  }
  return null;
}

function buildObviousPostconditionChecks(objective) {
  const text = String(objective || '').replace(/\s+/g, ' ').trim();
  const checks = [];
  let match = null;

  // Simple delete objective: the requested state is "exact target absent". If the
  // exact path is already absent the run is idempotently satisfied (no model loop,
  // no mutation). If it exists, this check is unsatisfied and the run proceeds
  // normally so the existing deletePath path can run.
  const deleteTargets = extractSimpleDeleteTargets(text);
  if (deleteTargets) {
    deleteTargets.forEach(targetPath => {
      checks.push({
        type: 'absent',
        path: targetPath,
        satisfied: () => !workspaceProvider.getPathInfo(targetPath).exists
      });
    });
  }

  // Single "ensure folder X exists" recognizer: delegated to the objective contract
  // (objective-contract.js is the grammar source). The list-form ensure/create
  // handling below is unchanged; any overlap is removed by the dedup at the end, so
  // the resulting folder checks are identical to the previous inline regex.
  const ensureContract = buildObjectiveContract(text);
  if (ensureContract.intent === 'ensure_folder') {
    const ensureFolderPaths = ensureContract.postconditions
      .filter(pc => pc && pc.type === 'folder_exists')
      .map(pc => pc.path);
    if (ensureFolderPaths.length > 0) addFolderPostconditionChecks(checks, ensureFolderPaths);
  }

  const ensuredFolderPaths = parseSimpleFolderListObjective(text, 'ensure');
  if (ensuredFolderPaths) {
    addFolderPostconditionChecks(checks, ensuredFolderPaths);
  }

  const createdFolderPaths = parseSimpleFolderListObjective(text, 'create');
  if (createdFolderPaths) {
    addFolderPostconditionChecks(checks, createdFolderPaths);
  }

  match = text.match(/\binside it create file\s+([A-Za-z0-9._/-]+)\s+containing exactly\s+(.+?)(?:\.\s+Once\b|$)/i);
  if (match) {
    const folderCheck = checks.find(check => check.type === 'folder');
    if (folderCheck) {
      const filePath = cleanObjectivePath(path.posix.join(folderCheck.path, cleanObjectivePath(match[1])));
      const expectedContent = cleanObjectiveContent(match[2]);
      checks.push({
        type: 'file',
        path: filePath,
        expectedContent,
        satisfied: () => readWorkspaceFileIfExists(filePath) === expectedContent
      });
    }
  }

  match = text.match(/(?:^|(?<!inside it )\b)create file\s+([A-Za-z0-9._/-]+)\s+containing exactly\s+(.+?)(?:\.\s+Once\b|$)/i);
  if (match) {
    const filePath = cleanObjectivePath(match[1]);
    const expectedContent = cleanObjectiveContent(match[2]);
    checks.push({
      type: 'file',
      path: filePath,
      expectedContent,
      satisfied: () => readWorkspaceFileIfExists(filePath) === expectedContent
    });
  }

  return checks.filter((check, index, list) =>
    check.path && list.findIndex(item => item.type === check.type && item.path === check.path) === index
  );
}

function checkObviousTicketPostcondition(ticket) {
  const checks = buildObviousPostconditionChecks(ticket && ticket.objective);
  if (checks.length === 0) return null;
  if (!checks.every(check => check.satisfied())) return null;

  const absentDelete = checks.every(check => check.type === 'absent');
  const reason = absentDelete
    ? `Delete target already absent: ${checks.map(check => check.path).join(', ')}`
    : 'Requested workspace state is already satisfied';
  return {
    reason,
    absentDelete,
    checkedPaths: checks.map(check => ({
      type: check.type,
      path: check.path,
      ...(check.expectedContent !== undefined ? { expectedContent: check.expectedContent } : {})
    }))
  };
}

function buildFailureMetadata(error, status, failureReason = null, detail = {}) {
  if (status === 'interrupted') {
    return {
      code: 'RUN_INTERRUPTED',
      kind: 'interrupted',
      detail: {
        ...(failureReason ? { reason: sanitizeLogMessage(failureReason) } : {}),
        ...sanitizeSnapshotValue(detail)
      }
    };
  }

  if (!error) return null;

  if (error.failureKind) {
    return {
      code: error.code || error.failureCode || null,
      kind: error.failureKind,
      detail: sanitizeSnapshotValue(error.details || {})
    };
  }

  if (error.code === 'RUN_LIMIT_EXCEEDED') {
    return {
      code: error.code,
      kind: error.limitType === 'timeout' ? 'timeout' : 'budget_exhausted',
      detail: sanitizeSnapshotValue({
        limitType: error.limitType || null,
        ...(error.details || {})
      })
    };
  }

  if (error.code === 'WORKSPACE_PROTECTED_PATH') {
    return {
      code: error.code,
      kind: 'protected_path',
      detail: sanitizeSnapshotValue({
        operation: error.operation || null,
        path: error.path || null,
        reason: error.reason || null
      })
    };
  }

  if (error.code === 'WORKSPACE_OWNERSHIP_VIOLATION') {
    return {
      code: error.code,
      kind: 'protected_path',
      detail: sanitizeSnapshotValue({
        operation: error.operation || null,
        path: error.path || null,
        reason: error.reason || null
      })
    };
  }

  return null;
}

function buildRunTriage(run, {
  error = null,
  failure = null,
  status = null,
  summary = null,
  reasonCode = null
} = {}) {
  const effectiveStatus = status || (run && run.status) || 'failed';
  const failureCode = (failure && failure.code) || (error && error.code) || null;
  const failureKind = (failure && failure.kind) || (error && error.failureKind) || null;
  const message = sanitizeLogMessage(summary || (error && error.message) || (run && run.error) || 'Run stopped without a structured failure reason.');
  const authorityDenied = run ? getRunEvents(run.id).some(event => event.type === 'authority.denied') : false;
  let mappedReason = reasonCode;

  if (!mappedReason && effectiveStatus === 'interrupted') mappedReason = 'stopped';
  if (!mappedReason && (
    failureKind === 'protected_path' ||
    ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION', 'WORKSPACE_SENSITIVE_PATH'].includes(failureCode) ||
    authorityDenied
  )) mappedReason = 'authority_blocked';
  if (!mappedReason && (
    failureKind === 'provider_error' ||
    /Agent API key is missing|Agent model is missing|Ollama model is missing/i.test(message)
  )) mappedReason = 'provider_failed';
  if (!mappedReason && effectiveStatus === 'failed') mappedReason = 'runtime_failed';
  if (!mappedReason) mappedReason = 'unknown';

  const mutationCount = run ? countRunMutatingOperations(run.id) : 0;
  const mapping = {
    verification_failed: {
      requiredDecision: 'review_failure',
      evidenceRefs: ['event:run.postcondition_failed', 'event:run.postconditions_checked', 'event:run.verification_failed', 'replay:failure'],
      allowedActions: ['review', 'rerun_from_start'],
      prohibitedActions: ['mark_completed_without_verification']
    },
    authority_blocked: {
      requiredDecision: 'change_scope',
      evidenceRefs: ['event:authority.denied', 'event:run.violation_detected', 'replay:workspaceOperations', 'replay:failure'],
      allowedActions: ['review', 'rerun_from_start'],
      prohibitedActions: ['bypass_authority', 'repeat_same_action']
    },
    provider_failed: {
      requiredDecision: 'fix_input',
      evidenceRefs: ['replay:providerRequests', 'replay:modelResponses', 'event:run.execution_completed', 'replay:failure'],
      allowedActions: ['review', 'rerun_from_start'],
      prohibitedActions: ['automatic_retry']
    },
    stopped: {
      requiredDecision: 'approve_retry',
      evidenceRefs: ['event:run.execution_completed', 'event:run.terminalized', 'replay:failure'],
      allowedActions: ['review', 'rerun_from_start'],
      prohibitedActions: ['automatic_resume']
    },
    runtime_failed: {
      requiredDecision: mutationCount > 0 ? 'manual_recovery' : 'review_failure',
      evidenceRefs: ['event:run.execution_completed', 'event:run.terminalized', 'replay:failure'],
      allowedActions: mutationCount > 0 ? ['review', 'manual_recovery', 'rerun_from_start'] : ['review', 'rerun_from_start'],
      prohibitedActions: ['automatic_retry']
    },
    unknown: {
      requiredDecision: 'review_failure',
      evidenceRefs: ['event:run.execution_completed', 'replay:failure'],
      allowedActions: ['review'],
      prohibitedActions: ['automatic_retry']
    }
  };
  const selected = mapping[mappedReason] || mapping.unknown;

  return normalizeTriage({
    required: true,
    reasonCode: mappedReason,
    summary: message,
    requiredDecision: selected.requiredDecision,
    evidenceRefs: selected.evidenceRefs,
    allowedActions: selected.allowedActions,
    prohibitedActions: selected.prohibitedActions,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    resolution: null
  });
}

function persistRunTriage(runId, triage) {
  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run) return null;
  if (run.triage) return run.triage;

  const normalized = normalizeTriage(triage);
  if (!normalized) return null;
  run.triage = normalized;
  writeRuns(runs);
  updateRunReplaySnapshot(runId, snapshot => snapshot ? { ...snapshot, triage: normalized } : snapshot);
  appendEvent({
    type: 'run.triage_created',
    ticketId: run.ticketId,
    runId: run.id,
    payload: { triage: normalized }
  });
  return normalized;
}

// mutationCount parameter is reserved but never passed by callers; count is always derived.
function finalizeRunReplaySnapshot(run, status, failureReason = null, mutationCount = null, failure = null) {
  maybeTestInterrupt(run, 'before_run.snapshot_finalized');
  const effectiveMutationCount = mutationCount !== null ? mutationCount : countRunMutatingOperations(run.id);
  const finalizedAt = new Date().toISOString();
  updateRunReplaySnapshot(run.id, snapshot => snapshot ? {
    ...snapshot,
    terminalStatus: status,
    failureReason: failureReason ? sanitizeLogMessage(failureReason) : null,
    failure: failure ? sanitizeSnapshotValue(failure) : null,
    mutationOutcome: effectiveMutationCount === 0 ? 'no_mutations' : status === 'completed' ? 'all_intended' : 'partial_mutations',
    mutationCount: effectiveMutationCount,
    finalizedAt
  } : snapshot);
  appendEvent({
    type: 'run.snapshot_finalized',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      status,
      failureReason: failureReason ? sanitizeLogMessage(failureReason) : null,
      mutationCount: effectiveMutationCount,
      finalizedAt
    }
  });
  maybeTestInterrupt(run, 'after_run.snapshot_finalized');
}

function classifyInterruptionPhase(run) {
  const latestRun = readRuns().find(item => item.id === run.id) || run;
  const snapshot = readRunReplaySnapshot(latestRun) || latestRun.replaySnapshot || {};
  const logs = readLogs().filter(log => log.runId === run.id);
  const providerRequestLogs = logs.filter(log => log.type === 'model:request').length;
  const providerResponseLogs = logs.filter(log => log.type === 'model:response').length;
  const providerRequests = Array.isArray(snapshot.providerRequests) ? snapshot.providerRequests.length : 0;
  const modelResponses = Array.isArray(snapshot.modelResponses) ? snapshot.modelResponses.length : 0;
  const parsedPlans = Array.isArray(snapshot.parsedModelPlans) ? snapshot.parsedModelPlans.length : 0;
  const workspaceOperations = Array.isArray(snapshot.workspaceOperations) ? snapshot.workspaceOperations.length : 0;

  if (workspaceOperations > 0) return 'after_workspace_operation';
  if (parsedPlans > 0) return 'after_model_plan';
  if (modelResponses > 0 || providerResponseLogs > 0) return 'after_provider_response';
  if (providerRequestLogs > providerResponseLogs) return 'during_provider_call';
  if (providerRequests > 0 || providerRequestLogs > 0) return 'after_provider_request';
  if (latestRun.status === 'pending' || !latestRun.startedAt) return 'before_provider_call';
  return 'unknown';
}

function ensureInterruptedRunReplaySnapshot(run, reason, phase = null) {
  const ticket = readTickets().find(item => item.id === run.ticketId) || null;
  const agent = readAgents().find(item => item.id === run.agentId) || null;

  updateRunReplaySnapshot(run.id, snapshot => snapshot || createReplaySnapshotBase(run, {
    agentNameSnapshot: run.agentName || (agent ? agent.name : 'Unknown agent'),
    provider: agent ? (agent.provider || 'openai') : null,
    model: agent ? (agent.model || null) : null,
    runtimeEnvelope: null,
    ticketObjectiveSnapshot: ticket ? ticket.objective : null,
    systemInstructionSnapshot: null,
    primitiveContract: {
      allowedOperations: [...AGENT_ALLOWED_OPERATIONS],
      mutatingOperations: [...AGENT_MUTATING_OPERATIONS]
    },
    note: 'Run was interrupted before execution snapshot capture completed'
  }));

  recordReplayEvent(run, 'run:interrupted', reason, phase ? { phase } : {});
}

function ensureFailedRunReplaySnapshot(run, reason) {
  const ticket = readTickets().find(item => item.id === run.ticketId) || null;
  const agent = readAgents().find(item => item.id === run.agentId) || null;

  updateRunReplaySnapshot(run.id, snapshot => snapshot || createReplaySnapshotBase(run, {
    agentNameSnapshot: run.agentName || (agent ? agent.name : 'Unknown agent'),
    provider: agent ? (agent.provider || 'openai') : null,
    model: agent ? (agent.model || null) : null,
    runtimeEnvelope: null,
    ticketObjectiveSnapshot: ticket ? ticket.objective : null,
    systemInstructionSnapshot: null,
    primitiveContract: {
      allowedOperations: [...AGENT_ALLOWED_OPERATIONS],
      mutatingOperations: [...AGENT_MUTATING_OPERATIONS]
    },
    note: 'Run failed before execution snapshot capture completed'
  }));
  recordReplayEvent(run, 'run:failed', reason);
}

function runExecutionKey(run) {
  return `${run.ticketId}:${run.agentId}`;
}

function isLocalModelAgent(agent) {
  return agent && agent.provider === 'ollama';
}

function getLocalModelConcurrencyLimit() {
  return getPositiveIntegerEnv('LOCAL_MODEL_CONCURRENCY', DEFAULT_LOCAL_MODEL_CONCURRENCY);
}

function countActiveLocalModelRuns() {
  const localAgentIds = new Set(readAgents().filter(isLocalModelAgent).map(agent => agent.id));
  const persistedRunningCount = readRuns().filter(run =>
    run.status === 'running' &&
    localAgentIds.has(run.agentId)
  ).length;

  return persistedRunningCount + startingLocalModelRunIds.size;
}

function canStartRunNow(run) {
  const agent = readAgents().find(item => item.id === run.agentId);
  if (!isLocalModelAgent(agent)) return true;
  return countActiveLocalModelRuns() < getLocalModelConcurrencyLimit();
}

function isRunInterrupted(runId) {
  return readRuns().some(run => run.id === runId && run.status === 'interrupted');
}

function getAgentsInGroup(groupId) {
  const agentIds = new Set(readMemberships()
    .filter(membership => membership.principalType === 'agent' && membership.groupId === groupId)
    .map(membership => membership.principalId));

  return readAgents().filter(agent => agentIds.has(agent.id));
}

function getAgentGroupMembers() {
  const memberships = readMemberships().filter(m => m.principalType === 'agent');
  const agents = readAgents();
  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));
  const groupMap = {};

  for (const m of memberships) {
    if (!groupMap[m.groupId]) groupMap[m.groupId] = [];
    const agent = agentMap[m.principalId];
    if (agent) {
      groupMap[m.groupId].push({ id: agent.id, name: agent.name });
    }
  }

  return groupMap;
}

function deriveDynamicOwnedPaths(agents) {
  if (agents.length === 0) {
    throw new Error('Dynamic allocation rejected: selected group has no agents');
  }

  const rootListing = workspaceProvider.list('');

  const candidates = rootListing.entries
    .filter(e => e.type === 'folder')
    .filter(e => e.name !== 'data')
    .sort((a, b) => a.name.localeCompare(b.name));

  if (candidates.length < agents.length) {
    const error = new Error(
      `Dynamic allocation rejected: only ${candidates.length} usable workspace director${candidates.length === 1 ? 'y' : 'ies'} found, need ${agents.length} for ${agents.length} agent${agents.length === 1 ? '' : 's'}`
    );
    error.code = 'DYNAMIC_ALLOCATION_INSUFFICIENT_SCOPES';
    throw error;
  }

  const sortedAgents = [...agents].sort((a, b) => a.id - b.id);
  const pathMap = {};

  sortedAgents.forEach((agent, index) => {
    pathMap[agent.id] = candidates[index].path;
  });

  return pathMap;
}

function usesOwnedScopeAllocation(ticket) {
  return ticket &&
    ticket.assignmentTargetType === 'group' &&
    (ticket.assignmentMode === 'allocated' || ticket.assignmentMode === 'dynamic');
}

function getRunWorkspaceProvider(run) {
  return workspaceProvider;
}

function normalizeWorkspaceOwnershipPath(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/').trim());
  const cleanPath = normalized === '.' ? '' : normalized.replace(/^\/+/, '');

  if (!cleanPath) return '';
  return cleanPath.endsWith('/') ? cleanPath : `${cleanPath}/`;
}

function isPathInsideOwnedOutputPaths(relativePath, ownedOutputPaths) {
  const normalizedPath = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/').trim()).replace(/^\/+/, '');

  return ownedOutputPaths.some(ownedPath => {
    const normalizedOwnedPath = normalizeWorkspaceOwnershipPath(ownedPath);
    return normalizedPath === normalizedOwnedPath.slice(0, -1) || normalizedPath.startsWith(normalizedOwnedPath);
  });
}

function createWorkspaceOwnershipError(run, operation, relativePath) {
  const error = new Error(`Workspace operation blocked outside owned output paths: ${operation} ${relativePath}`);

  error.code = 'WORKSPACE_OWNERSHIP_VIOLATION';
  error.operation = operation;
  error.path = relativePath;
  error.reason = 'Owned-scope runs may only mutate owned output paths';
  error.ownedOutputPaths = getRunOwnedOutputPaths(run);
  return error;
}

function blockWorkspaceOwnershipViolation(run, operation, args, relativePath, runWorkspaceProvider) {
  const error = createWorkspaceOwnershipError(run, operation, relativePath);
  const workspaceAction = {
    operation,
    args,
    path: relativePath,
    workspaceRoot: runWorkspaceProvider ? runWorkspaceProvider.root : null,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    blocked: true,
    reason: error.reason
  };

  appendRunLog(run, 'workspace:ownership_blocked', error.message, workspaceAction);
  error.workspaceAction = workspaceAction;
  throw error;
}

function buildWorkspaceActionMetadata(run, runWorkspaceProvider, extra = {}) {
  return {
    ...extra,
    workspaceRoot: runWorkspaceProvider ? runWorkspaceProvider.root : null,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run)
  };
}

function assertAllocatedOwnershipAllowsMutation(run, operation, args, relativePath, runWorkspaceProvider) {
  if (run.executionWorkspaceType !== 'main_owned_paths') return;

  if (!isPathInsideOwnedOutputPaths(relativePath, getRunOwnedOutputPaths(run))) {
    blockWorkspaceOwnershipViolation(run, operation, args, relativePath, runWorkspaceProvider);
  }
}

function buildAuthorityEvidence(run, operation, pathValue, status, rule, reason) {
  return {
    rule,
    operation,
    path: pathValue || null,
    actor: run && run.agentId ? `agent:${run.agentId}` : 'unknown',
    workspaceType: run ? run.executionWorkspaceType || 'main' : 'unknown',
    status,
    reason: reason || ''
  };
}

function recordAuthorityEvidence(run, evidence) {
  const normalized = sanitizeSnapshotValue(evidence);
  appendRunReplaySnapshotItem(run.id, 'authorityChecks', normalized);
  appendEvent({
    type: evidence.status === 'denied' ? 'authority.denied' : 'authority.allowed',
    ticketId: run.ticketId,
    runId: run.id,
    payload: normalized
  });
  if (evidence.status !== 'denied') {
    maybeTestInterrupt(run, 'after_first_authority.allowed');
  }
  return normalized;
}

function createAuthorityDeniedError(evidence, operation, args) {
  if (evidence.rule === 'protected_path') {
    return createProtectedWorkspaceError(operation, evidence.path, evidence.reason || 'protected path');
  }

  if (evidence.rule === 'owned_output_path') {
    const error = createWorkspaceOwnershipError({ ownedOutputPaths: evidence.ownedOutputPaths || [] }, operation, evidence.path);
    error.reason = evidence.reason || error.reason;
    return error;
  }

  if (evidence.rule === 'lease_owner') {
    const error = new Error('Workspace mutation denied because the run lease is not held by this process');
    error.code = 'RUN_LEASE_REQUIRED';
    error.operation = operation;
    error.path = evidence.path;
    error.reason = evidence.reason;
    return error;
  }

  if (evidence.rule === 'agent_runtime_config') {
    const error = new Error(evidence.reason || `Operation denied by agent runtimeConfig`);
    error.code = 'AGENT_OPERATION_DISABLED';
    error.operation = operation;
    error.configKey = evidence.configKey;
    error.reason = evidence.reason;
    return error;
  }

  const error = new Error(evidence.reason || `Workspace mutation denied by authority rule: ${evidence.rule}`);
  error.code = 'WORKSPACE_AUTHORITY_DENIED';
  error.operation = operation;
  error.path = evidence.path;
  error.reason = evidence.reason;
  error.workspaceAction = { operation, args, path: evidence.path, blocked: true, reason: evidence.reason };
  return error;
}

function checkWorkspaceMutationAuthority(run, operation, args) {
  if (!AGENT_MUTATING_OPERATIONS.includes(operation)) return null;

  const paths = [];
  if (args && args.path) paths.push({ role: 'path', path: args.path });
  if (operation === 'renamePath' && args && args.nextPath) paths.push({ role: 'nextPath', path: args.nextPath });
  const primaryPath = paths[0] ? paths[0].path : null;

  if (!isRunLeaseHeldByCurrentProcess(run)) {
    const evidence = buildAuthorityEvidence(run, operation, primaryPath, 'denied', 'lease_owner', 'Current process does not hold the run lease');
    recordAuthorityEvidence(run, evidence);
    throw createAuthorityDeniedError(evidence, operation, args);
  }

  for (const pathItem of paths) {
    const matchedProtectedPattern = getProtectedWorkspacePathMatch(pathItem.path);
    if (matchedProtectedPattern) {
      const evidence = buildAuthorityEvidence(run, operation, pathItem.path, 'denied', 'protected_path', matchedProtectedPattern);
      recordAuthorityEvidence(run, evidence);
      throw createAuthorityDeniedError(evidence, operation, args);
    }
  }

  if (run.executionWorkspaceType === 'main_owned_paths') {
    const ownedOutputPaths = getRunOwnedOutputPaths(run);
    const outsideOwnedPath = paths.find(pathItem => !isPathInsideOwnedOutputPaths(pathItem.path, ownedOutputPaths));
    if (outsideOwnedPath) {
      const evidence = {
        ...buildAuthorityEvidence(run, operation, outsideOwnedPath.path, 'denied', 'owned_output_path', 'Mutation path is outside owned output paths'),
        ownedOutputPaths
      };
      recordAuthorityEvidence(run, evidence);
      throw createAuthorityDeniedError(evidence, operation, args);
    }
  }

  return recordAuthorityEvidence(
    run,
    buildAuthorityEvidence(run, operation, primaryPath, 'allowed', 'workspace_mutation', 'Runtime authority checks passed')
  );
}

function normalizeAgentRuntimeConfig(agent) {
  const KEYS = ['allowHandoffTask', 'allowWorkflowDraftIntent', 'allowCanonicalWorkflowDraft'];
  const result = {};
  for (const key of KEYS) {
    const agentVal = agent && agent.runtimeConfig && agent.runtimeConfig[key];
    const envKey = `AGENT_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      if (envVal === 'true' || envVal === '1') result[key] = true;
      else if (envVal === 'false' || envVal === '0') result[key] = false;
      else result[key] = envVal;
    } else if (agentVal !== undefined && agentVal !== null) {
      result[key] = agentVal;
    } else {
      result[key] = null;
    }
  }
  return result;
}

function getAgentEffectiveRuntimeConfig(agent) {
  return normalizeAgentRuntimeConfig(agent);
}

function buildEffectiveRuntimeConfigSnapshot(agent) {
  const effectiveConfig = getAgentEffectiveRuntimeConfig(agent);
  const runtimeLimits = getAgentRuntimeLimits();
  const KEYS = ['allowHandoffTask', 'allowWorkflowDraftIntent', 'allowCanonicalWorkflowDraft'];

  const configSources = {};
  for (const key of KEYS) {
    const envKey = `AGENT_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
    const envVal = process.env[envKey];
    const agentVal = agent && agent.runtimeConfig && agent.runtimeConfig[key];
    if (envVal !== undefined) {
      configSources[key] = 'env';
    } else if (agentVal !== undefined && agentVal !== null) {
      configSources[key] = 'agent';
    } else {
      configSources[key] = 'default';
    }
  }

  return {
    effectiveConfig,
    agentConfig: agent && agent.runtimeConfig ? { ...agent.runtimeConfig } : null,
    configSources,
    runtimeLimits
  };
}

function assertAgentOperationAllowed(run, agent, operation, step) {
  const configKeyByOperation = {
    createWorkflowDraft: 'allowCanonicalWorkflowDraft',
    createWorkflowDraftIntent: 'allowWorkflowDraftIntent',
    createHandoffTask: 'allowHandoffTask'
  };
  const configKey = configKeyByOperation[operation];
  if (!configKey) return;

  const cfg = getAgentEffectiveRuntimeConfig(agent);
  const allowed = cfg[configKey];
  if (allowed !== false) return;

  const configSource = agent && agent.runtimeConfig && agent.runtimeConfig[configKey] !== undefined
    ? `agent.${agent.id}.runtimeConfig.${configKey}`
    : `env.AGENT_${configKey.replace(/([A-Z])/g, '_$1').toUpperCase()}`;

  const evidence = buildAuthorityEvidence(
    run,
    operation,
    null,
    'denied',
    'agent_runtime_config',
    `Operation '${operation}' denied by ${configSource}=false`
  );
  evidence.configKey = configKey;
  evidence.configKeyEffectiveValue = false;
  evidence.agentId = agent ? agent.id : null;
  recordAuthorityEvidence(run, evidence);

  const error = new Error(`Operation '${operation}' is disabled for this agent by runtimeConfig`);
  error.code = 'AGENT_OPERATION_DISABLED';
  error.operation = operation;
  error.configKey = configKey;
  error.failureKind = 'invalid_action';
  throw error;
}

function assertNoOverlappingOwnedPaths(planItems) {
  const ownedPaths = planItems.flatMap(item => item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath));

  ownedPaths.forEach((ownedPath, index) => {
    ownedPaths.forEach((otherPath, otherIndex) => {
      if (index === otherIndex) return;
      if (ownedPath === otherPath || ownedPath.startsWith(otherPath) || otherPath.startsWith(ownedPath)) {
        throw new Error(`Owned-scope paths overlap: ${ownedPath} and ${otherPath}`);
      }
    });
  });
}

function assertAllocatedOwnedPathsExist(planItems) {
  planItems.forEach(item => {
    (item.ownedOutputPaths || []).forEach(ownedPath => {
      const normalizedPath = normalizeWorkspaceOwnershipPath(ownedPath);
      const info = workspaceProvider.getPathInfo(normalizedPath, { allowHidden: true });

      if (!info.exists) {
        const error = new Error(`Owned-scope path does not exist: ${normalizedPath}`);
        error.code = 'WORKSPACE_ALLOCATION_PATH_MISSING';
        error.path = normalizedPath;
        error.assignedAgentId = item.assignedAgentId || null;
        throw error;
      }

      if (info.type !== 'directory') {
        const error = new Error(`Owned-scope path is not a directory: ${normalizedPath}`);
        error.code = 'WORKSPACE_ALLOCATION_NOT_DIRECTORY';
        error.path = normalizedPath;
        error.assignedAgentId = item.assignedAgentId || null;
        throw error;
      }
    });
  });
}

function assertAllocatedTicketCanStart(ticket, agents) {
  const planDraft = buildAllocatedOwnershipPlan(ticket, agents);
  assertAllocatedOwnedPathsExist(planDraft.items);
  return planDraft;
}

function inferObjectiveRequiredWritableRoots(ticket) {
  const objective = String(ticket && ticket.objective || '').toLowerCase();
  if (!objective.includes('quarter') || !objective.includes('month')) return [];

  const rootListing = workspaceProvider.list('');
  return rootListing.entries
    .filter(entry => entry && entry.type === 'folder' && /^Q\d+$/i.test(entry.name))
    .map(entry => normalizeWorkspaceOwnershipPath(entry.path))
    .sort((a, b) => a.localeCompare(b));
}

function getTicketGrantedWritableRoots(ticket, agents) {
  const planDraft = buildAllocatedOwnershipPlan(ticket, agents);
  return planDraft.items
    .flatMap(item => item.ownedOutputPaths || [])
    .map(normalizeWorkspaceOwnershipPath)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function createTicketFeasibilityError(missingAuthorityGrants, requiredWritableRoots, grantedWritableRoots) {
  const missing = missingAuthorityGrants.map(normalizeWorkspaceOwnershipPath).filter(Boolean);
  const error = new Error('Ticket objective requires paths not granted by authority:' + String.fromCharCode(10) + missing.join(String.fromCharCode(10)));
  error.code = 'TICKET_FEASIBILITY_MISSING_GRANTS';
  error.kind = 'impossible_authority_scope';
  error.missingAuthorityGrants = missing;
  error.requiredWritableRoots = requiredWritableRoots;
  error.grantedWritableRoots = grantedWritableRoots;
  return error;
}

function assertTicketObjectiveWithinGrantedWritableRoots(ticket, agents) {
  const requiredWritableRoots = inferObjectiveRequiredWritableRoots(ticket);
  if (requiredWritableRoots.length === 0) return null;

  const grantedWritableRoots = getTicketGrantedWritableRoots(ticket, agents);
  const missingAuthorityGrants = requiredWritableRoots.filter(requiredRoot =>
    !isPathInsideOwnedOutputPaths(requiredRoot, grantedWritableRoots)
  );

  if (missingAuthorityGrants.length > 0) {
    throw createTicketFeasibilityError(missingAuthorityGrants, requiredWritableRoots, grantedWritableRoots);
  }

  return { requiredWritableRoots, grantedWritableRoots, missingAuthorityGrants: [] };
}

function buildTicketFeasibilityTriage(error, createdAt = new Date().toISOString()) {
  const authorityBlocked = (
    error.kind === 'impossible_authority_scope' ||
    error.code === 'TICKET_FEASIBILITY_MISSING_GRANTS'
  );

  return normalizeTriage({
    required: true,
    reasonCode: authorityBlocked ? 'authority_blocked' : 'unknown',
    summary: error.message,
    requiredDecision: authorityBlocked ? 'change_scope' : 'review_failure',
    evidenceRefs: ['event:ticket.blocked', 'ticket:feasibility', 'log:ticket:feasibility_blocked'],
    allowedActions: ['review', 'edit_ticket'],
    prohibitedActions: [authorityBlocked ? 'start_run_without_scope_change' : 'start_run_without_review'],
    createdAt,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null
  });
}

function blockTicketForFeasibility(ticket, error, context = {}) {
  const tickets = readTickets();
  const persistedTicket = tickets.find(item => item.id === ticket.id);
  if (!persistedTicket) return null;

  const now = new Date().toISOString();
  persistedTicket.status = 'blocked';
  persistedTicket.blockedReason = error.message;
  persistedTicket.feasibility = {
    status: 'blocked',
    reason: error.message,
    code: error.code || 'TICKET_FEASIBILITY_ERROR',
    kind: error.kind || 'impossible_authority_scope',
    requiredWritableRoots: error.requiredWritableRoots || [],
    grantedWritableRoots: error.grantedWritableRoots || [],
    missingAuthorityGrants: error.missingAuthorityGrants || []
  };
  persistedTicket.triage = buildTicketFeasibilityTriage(error, now);
  persistedTicket.updatedAt = now;
  persistedTicket.changedAt = now;
  if (context.changedBy) persistedTicket.changedBy = context.changedBy;
  writeTickets(tickets);

  appendEvent({
    type: 'ticket.blocked',
    ticketId: persistedTicket.id,
    payload: {
      status: persistedTicket.status,
      reason: persistedTicket.blockedReason,
      feasibility: persistedTicket.feasibility,
      triage: persistedTicket.triage,
      updatedAt: persistedTicket.updatedAt
    }
  });
  appendSystemLog('ticket:feasibility_blocked', error.message, null, {
    ticketId: persistedTicket.id,
    code: persistedTicket.feasibility.code,
    kind: persistedTicket.feasibility.kind,
    missingAuthorityGrants: persistedTicket.feasibility.missingAuthorityGrants,
    requiredWritableRoots: persistedTicket.feasibility.requiredWritableRoots,
    grantedWritableRoots: persistedTicket.feasibility.grantedWritableRoots,
    changedBy: context.changedBy || null
  });
  broadcastTicketChange();
  return persistedTicket;
}

function blockTicketForObjectiveAmbiguity(ticket, gateResult, context = {}) {
  const tickets = readTickets();
  const persistedTicket = tickets.find(item => item.id === ticket.id);
  if (!persistedTicket) return null;

  const now = new Date().toISOString();
  persistedTicket.status = 'blocked';
  persistedTicket.blockedReason = gateResult.summary;
  persistedTicket.triage = normalizeTriage({
    required: true,
    reasonCode: 'objective_ambiguous',
    summary: gateResult.summary,
    requiredDecision: 'clarify_objective',
    evidenceRefs: gateResult.evidenceRefs || ['objective-contract:gate'],
    allowedActions: gateResult.allowedActions || ['edit_objective', 'clarify_ticket'],
    prohibitedActions: gateResult.prohibitedActions || ['mutate_workspace_without_clarification', 'start_run_without_clarification'],
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null
  });
  persistedTicket.updatedAt = now;
  persistedTicket.changedAt = now;
  if (context.changedBy) persistedTicket.changedBy = context.changedBy;
  writeTickets(tickets);

  appendEvent({
    type: 'ticket.blocked',
    ticketId: persistedTicket.id,
    payload: {
      status: persistedTicket.status,
      reason: persistedTicket.blockedReason,
      reasonCode: 'objective_ambiguous',
      triage: persistedTicket.triage
    }
  });
  appendSystemLog('ticket:objective_ambiguous', gateResult.summary, null, {
    ticketId: persistedTicket.id,
    ambiguityPatterns: gateResult.ambiguityPatterns || [],
    changedBy: context.changedBy || null
  });
  broadcastTicketChange();
  return persistedTicket;
}

function assertAllocatedObjectiveSupported(objective) {
  const normalizedObjective = String(objective || '').toLowerCase();
  const destructivePattern = /\b(delete|remove|rename|move|refactor|fix|modify|overwrite|update existing|edit|cleanup|clean up|restructure|reorganize|replace)\b/;
  const additivePattern = /\b(file|files|folder|folders|report|reports|proposal|proposals|doc|docs|document|documents|fixture|fixtures|variant|variants|draft|drafts|analysis|analyses|deliverable|deliverables)\b/;

  if (destructivePattern.test(normalizedObjective)) {
    throw new Error('Owned-scope execution rejected: objective appears destructive or edits existing workspace state');
  }

  if (!additivePattern.test(normalizedObjective)) {
    throw new Error('Owned-scope execution rejected: objective does not clearly describe additive independent outputs');
  }
}

function buildAllocatedOwnershipPlan(ticket, agents) {
  assertAllocatedObjectiveSupported(ticket.objective);

  if (agents.length === 0) {
    throw new Error('Owned-scope execution rejected: selected group has no agents');
  }

  const userPaths = (typeof ticket.ownedOutputPaths === 'object' && ticket.ownedOutputPaths !== null && !Array.isArray(ticket.ownedOutputPaths))
    ? ticket.ownedOutputPaths
    : {};

  if (Object.keys(userPaths).length === 0) {
    throw new Error('Owned-scope execution rejected: ownedOutputPaths are required');
  }

  const missing = agents.filter(a => !userPaths[a.id]);
  if (missing.length > 0) {
    throw new Error(`Owned-scope execution rejected: missing owned output path for agent(s): ${missing.map(a => `${a.id} (${a.name})`).join(', ')}`);
  }

  const items = agents.map(agent => ({
    assignedAgentId: agent.id,
    allocationSubtask: `Produce your allocated output for ticket ${ticket.id} inside your owned path only.`,
    ownedOutputPaths: [normalizeWorkspaceOwnershipPath(userPaths[agent.id])]
  }));

  assertNoOverlappingOwnedPaths(items);
  return {
    ticketId: ticket.id,
    ticketOpenedAt: ticket.updatedAt,
    mode: 'owned_paths',
    status: 'pending',
    items
  };
}

function createAllocationPlan(ticket, agents) {
  const plans = readAllocationPlans();
  const planDraft = buildAllocatedOwnershipPlan(ticket, agents);
  assertAllocatedOwnedPathsExist(planDraft.items);
  const now = new Date().toISOString();
  const nextPlanId = nextId(plans);
  const maxItemId = plans.flatMap(plan => plan.items || []).reduce((maxId, item) => {
    return Math.max(maxId, parseInt(item.allocationItemId, 10) || 0);
  }, 0);
  const plan = {
    id: nextPlanId,
    ticketId: ticket.id,
    ticketOpenedAt: ticket.updatedAt,
    mode: planDraft.mode,
    status: 'pending',
    createdAt: now,
    items: planDraft.items.map((item, index) => ({
      allocationItemId: maxItemId + index + 1,
      allocationSubtask: item.allocationSubtask,
      ownedOutputPaths: item.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath),
      assignedAgentId: item.assignedAgentId,
      status: 'pending',
      createdAt: now
    }))
  };

  writeAllocationPlans([...plans, plan]);
  return plan;
}

function findAllocationPlan(planId) {
  return readAllocationPlans().find(plan => plan.id === planId) || null;
}

function findAllocationItem(planId, itemId) {
  const plan = findAllocationPlan(planId);
  if (!plan) return null;
  return (plan.items || []).find(item => item.allocationItemId === itemId) || null;
}

function getRunAllocationItem(run) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return null;
  return findAllocationItem(run.allocationPlanId, run.allocationItemId);
}

function getRunOwnedOutputPaths(run) {
  const allocationItem = getRunAllocationItem(run);
  if (allocationItem && Array.isArray(allocationItem.ownedOutputPaths)) {
    return allocationItem.ownedOutputPaths;
  }

  return run.ownedOutputPaths || [];
}

// Display-only: returns the most specific owned root (e.g. "Q1/") that contains
// entryPath, using the same containment shape as isPathInsideOwnedOutputPaths,
// or null if no owned path contains it.
function matchedOwnedRootForEntry(entryPath, ownedPaths) {
  const normalizedEntry = path.posix
    .normalize(String(entryPath || '').replace(/\\/g, '/').trim())
    .replace(/^\/+/, '');
  // Never tag the workspace root itself from a child owned path (e.g. "Q1/").
  if (!normalizedEntry || normalizedEntry === '.') return null;
  let best = null;
  for (const ownedPath of ownedPaths) {
    const normalizedOwned = normalizeWorkspaceOwnershipPath(ownedPath);
    if (!normalizedOwned) continue;
    const isInside = normalizedEntry === normalizedOwned.slice(0, -1) || normalizedEntry.startsWith(normalizedOwned);
    if (isInside && (!best || normalizedOwned.length > best.length)) best = normalizedOwned;
  }
  return best;
}

// Display-only: active (pending/running) runs that carry scoped owned output
// paths. Runs without owned paths are unscoped (full workspace) and intentionally
// excluded so the whole workspace is not falsely tagged.
function buildActiveOwnershipRecords() {
  return readRuns()
    .filter(run => ['pending', 'running'].includes(run.status))
    .map(run => {
      const ownedPaths = getRunOwnedOutputPaths(run);
      if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) return null;
      return { runId: run.id, ticketId: run.ticketId, agentId: run.agentId, agentName: run.agentName, ownedPaths };
    })
    .filter(Boolean);
}

// Display-only: annotate each workspace listing entry with ownership metadata
// when its path falls inside an active run's owned output path. Does not change
// permissions, enforcement, or workspace mutation behavior.
function annotateWorkspaceListingWithOwnership(listing) {
  if (!listing || !Array.isArray(listing.entries)) return listing;
  const records = buildActiveOwnershipRecords();
  if (records.length === 0) return listing;

  const entries = listing.entries.map(entry => {
    const matches = [];
    for (const record of records) {
      const ownedPath = matchedOwnedRootForEntry(entry.path, record.ownedPaths);
      if (ownedPath) {
        matches.push({ agentId: record.agentId, agentName: record.agentName, ticketId: record.ticketId, runId: record.runId, ownedPath });
      }
    }
    if (matches.length === 0) return entry;

    // Most-specific (deepest) owned path wins when deterministic. Only fall back
    // to a neutral "multiple active owners" label when distinct active runs tie
    // at the same deepest specificity. Never silently pick one of a tie.
    const maxSpecificity = Math.max(...matches.map(match => match.ownedPath.length));
    const deepestMatches = matches.filter(match => match.ownedPath.length === maxSpecificity);
    const distinctRuns = new Set(deepestMatches.map(match => match.runId));
    if (distinctRuns.size === 1) {
      return { ...entry, ownership: deepestMatches[0] };
    }
    return { ...entry, ownership: { multiple: true, owners: deepestMatches } };
  });

  return { ...listing, entries };
}

function getTicketAllocationPlan(ticketId) {
  return readAllocationPlans().find(plan => plan.ticketId === ticketId) || null;
}

function getTicketRuns(ticketId, history = readOperationHistory()) {
  const runs = readRuns().filter(run => run.ticketId === ticketId);
  const agents = readAgents();
  const mutationCountByRunId = buildMutationCountByRunId(history);
  return runs.map(run => {
    const partialMutationCount = mutationCountByRunId.get(run.id) || 0;
    return {
      ...run,
      agentName: agents.find(agent => agent.id === run.agentId)?.name || `Agent ${run.agentId}`,
      partialMutationCount,
      operationalOutcome: classifyRunOperationalOutcome(run)
    };
  });
}

function getRecentLogsForTicket(ticketId, limit = 5) {
  const logs = readLogs();
  const recentLogs = [];

  for (let index = logs.length - 1; index >= 0 && recentLogs.length < limit; index -= 1) {
    if (logs[index].ticketId === ticketId) recentLogs.push(logs[index]);
  }

  return sanitizeWorkspaceDisplayValue(recentLogs.reverse()).map(log => ({
    ...log,
    displayType: displayLogType(log.type),
    displayMessage: displayLogMessage(log)
  }));
}

function getRecentLogsForRun(runId, limit = 5) {
  const logs = readLogs();
  const recentLogs = [];

  for (let index = logs.length - 1; index >= 0 && recentLogs.length < limit; index -= 1) {
    if (logs[index].runId === runId && logs[index].type !== 'run:runtime') recentLogs.push(logs[index]);
  }

  return sanitizeWorkspaceDisplayValue(recentLogs.reverse()).map(log => ({
    ...log,
    displayType: displayLogType(log.type),
    displayMessage: displayLogMessage(log)
  }));
}

function updateAllocationItemStatus(run, status) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return null;

  const plans = readAllocationPlans();
  const plan = plans.find(item => item.id === run.allocationPlanId);
  if (!plan) return null;
  const allocationItem = (plan.items || []).find(item => item.allocationItemId === run.allocationItemId);
  if (!allocationItem) return null;

  allocationItem.status = status;
  plan.status = plan.items.some(item => item.status === 'failed') ? 'failed'
    : plan.items.some(item => item.status === 'interrupted') ? 'interrupted'
      : plan.items.every(item => item.status === 'completed') ? 'completed'
        : plan.items.some(item => item.status === 'running') ? 'running'
          : 'pending';
  writeAllocationPlans(plans);
  return allocationItem;
}

function updateTicketInProgressForRun(run) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket || ticket.status !== 'open') return ticket || null;
  return updateTicketStatusById(run.ticketId, 'in_progress');
}

function finalizeTicketForRun(run, terminalStatus) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket) return null;

  if (!usesOwnedScopeAllocation(ticket)) {
    return updateTicketStatusById(run.ticketId, terminalStatus);
  }

  const batchRuns = readRuns().filter(item =>
    item.ticketId === run.ticketId &&
    item.ticketOpenedAt === run.ticketOpenedAt
  );

  if (terminalStatus === 'failed' || batchRuns.some(item => item.status === 'failed')) {
    return updateTicketStatusById(run.ticketId, 'failed');
  }

  if (batchRuns.length > 0 && batchRuns.every(item => item.status === 'completed')) {
    return updateTicketStatusById(run.ticketId, 'completed');
  }

  return ticket;
}

function validateManualTicketCompletion(ticket) {
  if (!ticket) return { allowed: false, reason: 'Ticket not found' };
  if (ticket.triage && ticket.triage.required) {
    return { allowed: false, reason: 'Ticket cannot be completed while ticket-level triage is required.' };
  }

  const latestRun = readRuns()
    .filter(run => run.ticketId === ticket.id)
    .sort(compareRunsNewestFirst)[0] || null;
  if (!latestRun) {
    return { allowed: false, reason: 'Ticket cannot be completed without supporting runtime evidence.' };
  }
  if (latestRun.status !== 'completed') {
    return { allowed: false, reason: `Ticket cannot be completed because the latest run is ${latestRun.status}.` };
  }
  if (latestRun.triage && latestRun.triage.required) {
    return { allowed: false, reason: 'Ticket cannot be completed while the latest run requires triage.' };
  }

  const objectiveSuccess = buildObjectiveSuccess(latestRun);
  // Option A: completion means execution reached a valid terminal completion state.
  // When declared verification applies to this run, completion still requires a
  // passing verdict (verified). When no verification was required for the run
  // (e.g. a postcondition-free direct or branch run), operational completion is a
  // legitimate completed-but-unverified state and may be completed manually,
  // unless the run's objective success is explicitly failed.
  if (isRunVerificationRequired(latestRun)) {
    if (!objectiveSuccess.scored || objectiveSuccess.status !== 'succeeded') {
      return { allowed: false, reason: 'Ticket cannot be completed because the latest run has no verified objective-success evidence.' };
    }
  } else if (objectiveSuccess.status === 'failed') {
    return { allowed: false, reason: 'Ticket cannot be completed because the latest run did not reach objective success.' };
  }

  return { allowed: true, latestRun, objectiveSuccess };
}

function reconcileTerminalRun(run) {
  // Idempotent reconciliation for runs that have run.execution_completed (or legacy
  // run.completed/failed/interrupted) but not yet run.terminalized.
  // Call only when safeToReconcileTerminalState is true.
  const runId = run.id;
  const events = getRunEvents(runId);
  const existingTypes = new Set(events.map(e => e.type));

  // Already fully terminalized — no-op
  if (existingTypes.has('run.terminalized')) return;

  // Determine target status from execution_completed or legacy terminal event
  const execCompletedEvent = events.find(e => e.type === 'run.execution_completed');
  const legacyTerminalEvent = events.find(e => ['run.completed', 'run.failed', 'run.interrupted'].includes(e.type));
  const isLegacy = !execCompletedEvent && !!legacyTerminalEvent;

  let targetStatus = execCompletedEvent
    ? (execCompletedEvent.payload && execCompletedEvent.payload.status) || 'completed'
    : legacyTerminalEvent
      ? legacyTerminalEvent.type.replace('run.', '')
      : 'interrupted';
  let verificationFailureReason = null;
  let verificationFailure = null;

  const terminalPayload = (legacyTerminalEvent && legacyTerminalEvent.payload) ||
    (execCompletedEvent && execCompletedEvent.payload) || {};

  appendRunLog(run, 'run:reconciliation_started', `Reconciling run at terminal state ${targetStatus}`, {
    existingEvents: events.length,
    isLegacy,
    hasSnapshotFinalized: existingTypes.has('replay.snapshot.finalized') || existingTypes.has('run.snapshot_finalized'),
    hasEvaluation: existingTypes.has('run.evaluation_completed'),
    hasConsequence: existingTypes.has('run.consequence_recorded')
  });

  // 1. Required verification gates completion.
  if (targetStatus === 'completed' && run.executionMode === 'workflow' && run.workflowId) {
    const failedPostconditions = completeRunPostconditionCheck(runId);
    if (Array.isArray(failedPostconditions) && failedPostconditions.length > 0) {
      targetStatus = 'failed';
      verificationFailureReason = buildVerificationFailureReason(failedPostconditions);
      verificationFailure = buildVerificationFailure(failedPostconditions);
      if (!existingTypes.has('run.verification_failed')) {
        appendEvent({
          type: 'run.verification_failed',
          ticketId: run.ticketId,
          runId: run.id,
          payload: {
            status: 'failed',
            error: verificationFailureReason,
            failure: verificationFailure
          }
        });
      }
    } else if (isRunVerificationRequired(run) && !existingTypes.has('run.verification_passed')) {
      appendEvent({
        type: 'run.verification_passed',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          status: 'passed',
          contractSource: run.verificationContractSnapshot ? 'run_snapshot' : 'legacy_current_workflow'
        }
      });
    }
  }

  if ((targetStatus === 'failed' || targetStatus === 'interrupted') && !run.triage) {
    const triageSummary = verificationFailureReason || terminalPayload.error || run.error || `Run reconciled to ${targetStatus}`;
    if (targetStatus === 'failed') ensureFailedRunReplaySnapshot(run, triageSummary);
    run.triage = persistRunTriage(runId, buildRunTriage(run, {
      failure: verificationFailure || terminalPayload.failure || null,
      status: targetStatus,
      summary: triageSummary,
      reasonCode: verificationFailure ? 'verification_failed' : null
    }));
  }

  // 2. Finalize replay snapshot if not already done
  let didFinalize = false;
  const snapshotDone = existingTypes.has('replay.snapshot.finalized') || existingTypes.has('run.snapshot_finalized');
  if (!snapshotDone || verificationFailure) {
    maybeTestInterrupt(run, 'before_run.snapshot_finalized');
    let failure = verificationFailure;
    if (!failure && (targetStatus === 'failed' || targetStatus === 'interrupted')) {
      failure = buildFailureMetadata(null, targetStatus, run.error || 'Run reconciled to terminal state');
    }
    finalizeRunReplaySnapshot(run, targetStatus, verificationFailureReason || run.error || null, null, failure);
    didFinalize = true;
    maybeTestInterrupt(run, 'after_run.snapshot_finalized');
  }

  // 3. Violation check (idempotent internally)
  completeRunViolationCheck(runId);

  // 4. Evaluation (guard against double-emission)
  let didEvaluate = false;
  if (!existingTypes.has('run.evaluation_completed')) {
    persistRunEvaluation(runId);
    didEvaluate = true;
  }

  // 5. Consequence (guard against double-emission)
  let didConsequence = false;
  if (!existingTypes.has('run.consequence_recorded')) {
    persistRunConsequence(runId);
    didConsequence = true;
  }

  // 6. Normalize run status if still in a non-terminal state
  const runs = readRuns();
  const r = runs.find(item => item.id === runId);
  if (r) {
    if (!['completed', 'failed', 'interrupted'].includes(r.status) || r.status !== targetStatus) {
      r.status = targetStatus;
      r.completedAt = r.completedAt || terminalPayload.completedAt || new Date().toISOString();
      r.updatedAt = new Date().toISOString();
      if (verificationFailureReason) r.error = verificationFailureReason;
      writeRuns(runs);
    }
    // 7. Clean up stale lease
    if (r.leaseOwner || r.leaseExpiresAt) {
      r.leaseOwner = null;
      r.leaseExpiresAt = null;
      writeRuns(runs);
    }
  }

  // 8. Emit terminalized lifecycle event (skip for legacy logs — no migration)
  if (!existingTypes.has('run.terminalized') && !isLegacy) {
    appendEvent({
      type: 'run.terminalized',
      ticketId: run.ticketId,
      runId: run.id,
      payload: { status: targetStatus }
    });
  }

  // 9. Finalize ticket
  finalizeTicketForRun(run, targetStatus);

  // 10. Running-run cleanup
  runningRunKeys.delete(runExecutionKey(run));
  startingRunIds.delete(runId);
  startingLocalModelRunIds.delete(runId);

  appendRunLog(run, 'run:reconciled', `Run reconciled to terminal state after restart (${targetStatus})`, {
    events,
    isLegacy,
    didFinalize,
    didEvaluate,
    didConsequence
  });
}

function updateTicketAfterRunInterrupted(run) {
  const ticket = readTickets().find(item => item.id === run.ticketId);

  if (!ticket || ticket.status !== 'in_progress') return ticket || null;

  const currentBatchRuns = readRuns().filter(item =>
    item.ticketId === run.ticketId &&
    item.ticketOpenedAt === run.ticketOpenedAt
  );
  const hasActiveCurrentBatchRun = currentBatchRuns.some(item => ['pending', 'running'].includes(item.status));

  if (hasActiveCurrentBatchRun) return ticket;
  return updateTicketStatusById(run.ticketId, 'open');
}

function allocationLogSuffix(run) {
  if (!run || !run.allocationPlanId || !run.allocationItemId) return '';
  return ` (allocation plan ${run.allocationPlanId}, item ${run.allocationItemId})`;
}

function interruptAgentRun(run, reason) {
  advanceRunPhase(run, 'terminalization');
  const phase = classifyInterruptionPhase(run);
  ensureInterruptedRunReplaySnapshot(run, reason, phase);
  const interruptedRun = updateRunStatus(run.id, 'interrupted', reason) || {
    ...run,
    status: 'interrupted',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: sanitizeLogMessage(reason)
  };

  const failure = buildFailureMetadata(null, 'interrupted', reason, { phase });
  appendEvent({
    type: 'run.execution_completed',
    ticketId: interruptedRun.ticketId,
    runId: interruptedRun.id,
    payload: {
      status: 'interrupted',
      error: reason,
      failure,
      completedAt: interruptedRun.completedAt || interruptedRun.updatedAt
    }
  });
  interruptedRun.triage = persistRunTriage(interruptedRun.id, buildRunTriage(interruptedRun, {
    failure,
    status: 'interrupted',
    summary: reason
  }));
  finalizeRunReplaySnapshot(interruptedRun, 'interrupted', reason, null, failure);
  completeRunViolationCheck(interruptedRun.id);
  persistRunEvaluation(interruptedRun.id);
  persistRunConsequence(interruptedRun.id);
  appendEvent({
    type: 'run.terminalized',
    ticketId: interruptedRun.ticketId,
    runId: interruptedRun.id,
    payload: { status: 'interrupted', error: reason }
  });
  appendRunLog(interruptedRun, 'run:interrupted', `${reason}${allocationLogSuffix(interruptedRun)}`, null, {
    allocationPlanId: interruptedRun.allocationPlanId || null,
    allocationItemId: interruptedRun.allocationItemId || null,
    phase,
    failure
  });
  runningRunKeys.delete(runExecutionKey(interruptedRun));
  startingRunIds.delete(interruptedRun.id);
  startingLocalModelRunIds.delete(interruptedRun.id);
  updateTicketAfterRunInterrupted(interruptedRun);
  return interruptedRun;
}

function hasUnresolvedTicketTriage(ticket) {
  return !!(ticket && ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt);
}

function forceTicketOpenForRerun(ticketId, rerunMode = null) {
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) return null;

  if (hasUnresolvedTicketTriage(ticket)) {
    throw Object.assign(new Error('Cannot rerun: unresolved ticket-level triage exists on this ticket. Resolve triage first.'), { statusCode: 409 });
  }

  ticket.status = 'open';
  ticket.updatedAt = new Date().toISOString();
  if (rerunMode) {
    ticket.rerunMode = rerunMode;
  } else {
    delete ticket.rerunMode;
  }
  writeTickets(tickets);
  appendEvent({
    type: 'ticket.updated',
    ticketId: ticket.id,
    payload: {
      status: ticket.status,
      updatedAt: ticket.updatedAt
    }
  });
  broadcastTicketChange();
  return ticket;
}

// Manual rerun-from-start safety gate. This is the ONLY place maxAttempts is
// enforced: when an operator manually reruns a ticket and the ticket has already
// used >= maxAttempts runs, the manual rerun is rejected. Attempt count is derived
// from existing runs (no persisted counter, no fabricated attempts). maxAttempts
// that is null/non-finite preserves today's behavior (allow). This is NOT automatic
// retry — nothing here schedules, backs off, or retries on failure.
function validateManualRerun(ticket) {
  if (!ticket) return { allowed: false, reason: 'Ticket not found' };
  const policy = ticket.executionPolicy;
  const maxAttempts = policy && Number.isInteger(policy.maxAttempts) && policy.maxAttempts > 0
    ? policy.maxAttempts
    : null;
  if (maxAttempts === null) return { allowed: true, attemptCount: null, maxAttempts: null };

  const attemptCount = readRuns().filter(run => run.ticketId === ticket.id).length;
  if (attemptCount >= maxAttempts) {
    return {
      allowed: false,
      attemptCount,
      maxAttempts,
      reason: `Manual rerun rejected: this ticket has used ${attemptCount} of ${maxAttempts} allowed attempt${maxAttempts === 1 ? '' : 's'} (maxAttempts is enforced for manual rerun-from-start).`
    };
  }
  return { allowed: true, attemptCount, maxAttempts };
}

// v1 auto-retry allowlist (allowlist semantics, not denylist). The ONLY retryable
// class is a generic, unclassified runtime failure with no workspace mutations. A
// generic runtime error makes buildFailureMetadata return null, which buildRunTriage
// classifies as reasonCode 'runtime_failed'. Any structured failure kind
// (protected_path, provider_error, timeout, budget_exhausted, authority denial, …),
// verification_failed, interrupted, unknown, or any run that mutated the workspace is
// excluded. The caller re-derives the prospective triage reasonCode via buildRunTriage
// so this stays consistent with the real classifier (incl. authority.denied events).
function isAutoRetryableReason(prospectiveReasonCode, mutationCount) {
  if (mutationCount !== 0) return false;
  return prospectiveReasonCode === 'runtime_failed';
}

// Bounded automatic retry (v1). Called ONLY from failAgentRun, before run triage is
// persisted. Creates at most one new pending run when the ticket policy explicitly
// opts in AND a finite maxAttempts ceiling has room AND the failure is in the runtime
// allowlist with no mutations AND no triage is required. It never resolves triage,
// changes verification, mutates the workspace, or finalizes completion. On exhaustion
// or any non-retryable failure it returns { retried: false } so the caller falls
// through to today's triage behavior.
function maybeAutoRetryAfterFailure(failedRun, failure, mutationCount) {
  if (!failedRun) return { retried: false, reason: 'no_run' };
  const ticket = readTickets().find(item => item.id === failedRun.ticketId);
  if (!ticket) return { retried: false, reason: 'ticket_missing' };

  const policy = ticket.executionPolicy || {};
  if (policy.autoRetry !== true) return { retried: false, reason: 'auto_retry_disabled' };
  const maxAttempts = Number.isInteger(policy.maxAttempts) && policy.maxAttempts > 0 ? policy.maxAttempts : null;
  if (maxAttempts === null) return { retried: false, reason: 'no_finite_max_attempts' };
  if (ticket.triage && ticket.triage.required === true) return { retried: false, reason: 'ticket_triage_required' };
  // v1 supports only single-run individual-agent tickets (one new pending run).
  if (usesOwnedScopeAllocation(ticket) || ticket.assignmentTargetType !== 'agent') {
    return { retried: false, reason: 'unsupported_ticket_shape' };
  }

  // Classify exactly as triage would; only runtime_failed (no mutations) is retryable.
  const prospectiveTriage = buildRunTriage(failedRun, { failure, status: 'failed', summary: failedRun.error || 'Run failed' });
  const prospectiveReasonCode = prospectiveTriage ? prospectiveTriage.reasonCode : 'unknown';
  if (!isAutoRetryableReason(prospectiveReasonCode, mutationCount)) {
    return { retried: false, reason: `non_retryable:${prospectiveReasonCode}` };
  }

  // The just-failed run is already counted; require room under the ceiling.
  const attemptCount = readRuns().filter(run => run.ticketId === ticket.id).length;
  if (attemptCount >= maxAttempts) return { retried: false, reason: 'max_attempts_exhausted' };

  let newRun = null;
  try {
    // The just-failed run still holds its in-memory execution lock (cleared by the
    // runAgentTicket finally only after failAgentRun returns). Release it now so the
    // new pending run can be created; the finally's deletes are idempotent.
    runningRunKeys.delete(runExecutionKey(failedRun));
    startingRunIds.delete(failedRun.id);
    startingLocalModelRunIds.delete(failedRun.id);

    const reopened = forceTicketOpenForRerun(ticket.id, 'auto_retry');
    if (!reopened) return { retried: false, reason: 'reopen_failed' };
    const created = createRunsForTicket(reopened, { userId: null, username: 'system', source: 'auto_retry' });
    newRun = (Array.isArray(created) && created[0]) || null;
  } catch (error) {
    return { retried: false, reason: 'retry_creation_failed' };
  }
  if (!newRun) return { retried: false, reason: 'no_run_created' };

  appendSystemLog('ticket:auto_retry',
    `Ticket #${ticket.id} automatically retried after run #${failedRun.id} failed (attempt ${attemptCount} of ${maxAttempts})`,
    null, {
      contextTicketId: ticket.id,
      contextRunId: newRun.id,
      fromRunId: failedRun.id,
      toRunId: newRun.id,
      attemptCount,
      maxAttempts,
      reasonCode: prospectiveReasonCode,
      source: 'auto_retry'
    });

  return { retried: true, newRun, attemptCount, maxAttempts, reasonCode: prospectiveReasonCode };
}

function rerunTicketFromBeginning(ticketId, changedBy = 'operator', mode = 'retry', delegated = null) {
  const ticket = readTickets().find(item => item.id === ticketId);

  if (!ticket) return null;

  if (usesOwnedScopeAllocation(ticket)) {
    assertAllocatedTicketCanStart({
      ...ticket,
      status: 'open',
      updatedAt: new Date().toISOString()
    }, getAgentsInGroup(ticket.assignmentTargetId));
  }

  readRuns()
    .filter(run => run.ticketId === ticketId && ['pending', 'running'].includes(run.status))
    .forEach(run => interruptAgentRun(run, `${changedBy} rerun requested`));

  const reopenedTicket = forceTicketOpenForRerun(ticketId, mode);
  appendSystemLog('ticket:rerun', `Ticket #${ticketId} rerun requested by ${changedBy} (mode: ${mode})`, null, {
    ticketId,
    changedBy,
    mode,
    changedAt: new Date().toISOString()
  });
  createRunsForTicket(reopenedTicket, delegated);
  return reopenedTicket;
}

function hasIncompleteTerminalEvidence(run) {
  if (!run || !['completed', 'failed', 'interrupted'].includes(run.status)) return false;
  const events = getRunEvents(run.id);
  const hasExecutionCompleted = events.some(event => event.type === 'run.execution_completed' || event.type === 'run.execution_failed');
  if (!hasExecutionCompleted) return false;
  const hasSnapshotFinalized = events.some(event => event.type === 'run.snapshot_finalized' || event.type === 'replay.snapshot.finalized');
  const hasTerminalized = events.some(event => event.type === 'run.terminalized');
  return !hasSnapshotFinalized || !hasTerminalized;
}

function interruptStaleRunsOnStartup() {
  const allRuns = readRuns();
  const staleRuns = allRuns.filter(run => ['pending', 'running'].includes(run.status));
  const terminalRunsNeedingReconciliation = allRuns.filter(hasIncompleteTerminalEvidence);
  let interruptedCount = 0;
  let resumedCount = 0;
  let reconciledCount = 0;

  if (staleRuns.length > 0) {
  }

  terminalRunsNeedingReconciliation.forEach(run => {
    const resumeState = reconstructResumableState(run);
    if (resumeState && resumeState.safeToReconcileTerminalState) {
      reconcileTerminalRun(run);
      reconciledCount++;
    }
  });

  staleRuns.forEach(run => {
    const runEvents = readRunScopedEvents(run.id);
    const resumeState = reconstructResumableState(run);
    if (resumeState && resumeState.safeToResumeExecution) {
      // Safe to resume: clear stale lease and return to pending
      const runs = readRuns();
      const r = runs.find(item => item.id === run.id);
      if (r) {
        r.status = 'pending';
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
        delete r.startedAt;
        writeRuns(runs);
        appendEvent({
          type: 'run.resumed',
          ticketId: run.ticketId,
          runId: run.id,
          payload: {
            reason: 'startup resumption, safe to resume',
            priorEvents: resumeState.priorEvents,
            expectedNextPhase: resumeState.expectedNextPhase
          }
        });
        appendRunLog(run, 'run:resumed', `Startup resumption: ${resumeState.priorEvents} prior events, next phase ${resumeState.expectedNextPhase}`);
        resumedCount++;
      }
      return;
    }

    // Terminal state reached — reconcile (evaluate, finalize, cleanup)
    if (resumeState && resumeState.safeToReconcileTerminalState) {
      reconcileTerminalRun(run);
      reconciledCount++;
      return;
    }

    // Already terminalized — just fix the status to match the events
    if (resumeState && resumeState.isTerminal) {
      const runs = readRuns();
      const r = runs.find(item => item.id === run.id);
      if (r) {
        // Determine terminal status from events
        const terminalEvent = runEvents.find(e => e.type === 'run.terminalized');
        const legacyEvent = runEvents.find(e => ['run.completed', 'run.failed', 'run.interrupted'].includes(e.type));
        const status = terminalEvent ? (terminalEvent.payload && terminalEvent.payload.status) || 'completed'
          : legacyEvent ? legacyEvent.type.replace('run.', '') : 'interrupted';
        r.status = status;
        r.leaseOwner = null;
        r.leaseExpiresAt = null;
        writeRuns(runs);
        appendRunLog(run, 'run:terminalized', `Startup: terminal run ${run.id} had stale status '${run.status}', fixed to '${status}'`);
      }
      return;
    }

    interruptAgentRun(run, 'process restarted before run completed');
    interruptedCount++;
  });

  if (interruptedCount > 0) {
    console.log(`Marked ${interruptedCount} stale agent run(s) interrupted`);
  }
  if (resumedCount > 0) {
    console.log(`Resumed ${resumedCount} stale agent run(s) on startup`);
  }
  if (reconciledCount > 0) {
    console.log(`Reconciled ${reconciledCount} terminal agent run(s) on startup`);
  }

  reconcileUnfinalizedTicketsOnStartup();
}

// Heals the terminalized-run / unfinalized-ticket disagreement: a run can be
// fully terminalized (run.terminalized emitted, verification already decided)
// while a crash in the gap before finalizeTicketForRun left its ticket stuck in
// a non-terminal status. Such a run is invisible to the stale-run and
// incomplete-terminal-evidence reconcilers, so converge the ticket here. Runs
// after those reconcilers so resumed/reconciled runs are settled first.
function reconcileUnfinalizedTicketsOnStartup() {
  const tickets = readTickets();
  const runs = readRuns();
  let finalizedCount = 0;

  tickets.forEach(ticket => {
    if (ticket.status !== 'in_progress') return;
    const ticketRuns = runs.filter(run => run.ticketId === ticket.id);
    if (ticketRuns.length === 0) return;
    // Never finalize while execution could still be in flight.
    if (ticketRuns.some(run => ['pending', 'running'].includes(run.status))) return;

    const latestRun = ticketRuns.slice().sort(compareRunsNewestFirst)[0];
    if (!latestRun) return;
    // Only heal genuinely terminalized runs — run.terminalized is emitted after
    // verification has already passed/failed, so latestRun.status is trustworthy.
    const events = getRunEvents(latestRun.id);
    if (!events.some(event => event.type === 'run.terminalized')) return;

    let updated = null;
    if (latestRun.status === 'completed' || latestRun.status === 'failed') {
      updated = finalizeTicketForRun(latestRun, latestRun.status);
    } else if (latestRun.status === 'interrupted') {
      updated = updateTicketAfterRunInterrupted(latestRun);
    } else {
      return;
    }

    if (updated && updated.status !== 'in_progress') {
      finalizedCount++;
      appendRunLog(latestRun, 'run:ticket_finalized',
        `Startup: finalized stuck ticket #${ticket.id} from 'in_progress' to '${updated.status}' from terminal run ${latestRun.id}`);
    }
  });

  if (finalizedCount > 0) {
    console.log(`Finalized ${finalizedCount} unfinalized ticket(s) on startup`);
  }
}

function failAgentRun(run, error, workspaceAction = null) {
  advanceRunPhase(run, 'terminalization');
  let message = error && error.message ? error.message : String(error || 'Agent run failed');
  const failure = buildFailureMetadata(error, 'failed', message);

  if (error && error.code === 'RUN_LIMIT_EXCEEDED' && error.limitType === 'step') {
    const mutationCount = countRunMutatingOperations(run.id);
    if (mutationCount > 0) {
      message = `${message} The model performed ${mutationCount} successful workspace mutation${mutationCount === 1 ? '' : 's'} but did not signal completion before the limit was reached.`;
    }
  }

  const failedRun = updateRunStatus(run.id, 'failed', message) || {
    ...run,
    status: 'failed',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: sanitizeLogMessage(message)
  };

  if (failedRun.status === 'interrupted') return failedRun;
  ensureFailedRunReplaySnapshot(failedRun, message);
  appendEvent({
    type: 'run.execution_completed',
    ticketId: failedRun.ticketId,
    runId: failedRun.id,
    payload: {
      status: 'failed',
      error: message,
      failure,
      mutationCount: countRunMutatingOperations(failedRun.id),
      completedAt: failedRun.completedAt || failedRun.updatedAt
    }
  });
  // Bounded automatic retry (v1): decide BEFORE persisting run triage. The failed run
  // keeps all of its evidence below; only triage-creation and ticket-failure
  // finalization are skipped when an eligible immediate retry is created.
  const autoRetry = maybeAutoRetryAfterFailure(failedRun, failure, countRunMutatingOperations(failedRun.id));
  failedRun.triage = autoRetry.retried
    ? null
    : persistRunTriage(failedRun.id, buildRunTriage(failedRun, {
        error,
        failure,
        status: 'failed',
        summary: message
      }));
  finalizeRunReplaySnapshot(failedRun, 'failed', message, null, failure);
  appendRunLog(failedRun, autoRetry.retried ? 'run:failed_auto_retried' : 'run:failed', `${message}${allocationLogSuffix(failedRun)}`, workspaceAction, {
    allocationPlanId: failedRun.allocationPlanId || null,
    allocationItemId: failedRun.allocationItemId || null,
    failure,
    ...(autoRetry.retried ? { autoRetryRunId: autoRetry.newRun.id } : {})
  });
  completeRunPostconditionCheck(failedRun.id);
  completeRunViolationCheck(failedRun.id);
  persistRunEvaluation(failedRun.id);
  persistRunConsequence(failedRun.id);
  appendEvent({
    type: 'run.terminalized',
    ticketId: failedRun.ticketId,
    runId: failedRun.id,
    payload: { status: 'failed', error: message }
  });
  // When auto-retry created a new pending run it already reopened the ticket; do not
  // finalize the ticket as failed in that case.
  if (!autoRetry.retried) {
    finalizeTicketForRun(failedRun, 'failed');
  }
  return failedRun;
}

function completeAgentRun(run) {
  advanceRunPhase(run, 'terminalization');
  appendEvent({
    type: 'run.execution_completed',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      status: 'completed',
      mutationCount: countRunMutatingOperations(run.id),
      completedAt: new Date().toISOString()
    }
  });
  maybeTestInterrupt(run, 'after_run.execution_completed');

  const failedPostconditions = completeRunPostconditionCheck(run.id);
  if (Array.isArray(failedPostconditions) && failedPostconditions.length > 0) {
    const message = buildVerificationFailureReason(failedPostconditions);
    const failure = buildVerificationFailure(failedPostconditions);
    const failedRun = updateRunStatus(run.id, 'failed', message);
    if (failedRun.status === 'interrupted') return failedRun;
    appendEvent({
      type: 'run.verification_failed',
      ticketId: failedRun.ticketId,
      runId: failedRun.id,
      payload: {
        status: 'failed',
        error: message,
        failure
      }
    });
    failedRun.triage = persistRunTriage(failedRun.id, buildRunTriage(failedRun, {
      failure,
      status: 'failed',
      summary: message,
      reasonCode: 'verification_failed'
    }));
    finalizeRunReplaySnapshot(failedRun, 'failed', message, null, failure);
    appendRunLog(failedRun, 'run:verification_failed', `${message}${allocationLogSuffix(failedRun)}`, null, {
      allocationPlanId: failedRun.allocationPlanId || null,
      allocationItemId: failedRun.allocationItemId || null,
      failure
    });
    completeRunViolationCheck(failedRun.id);
    persistRunEvaluation(failedRun.id);
    persistRunConsequence(failedRun.id);
    appendEvent({
      type: 'run.terminalized',
      ticketId: failedRun.ticketId,
      runId: failedRun.id,
      payload: { status: 'failed', error: message }
    });
    finalizeTicketForRun(failedRun, 'failed');
    return failedRun;
  }

  const completedRun = updateRunStatus(run.id, 'completed');
  if (completedRun.status === 'interrupted') return completedRun;
  if (isRunVerificationRequired(completedRun)) {
    appendEvent({
      type: 'run.verification_passed',
      ticketId: completedRun.ticketId,
      runId: completedRun.id,
      payload: { status: 'passed' }
    });
  }
  finalizeRunReplaySnapshot(completedRun, 'completed');
  appendRunLog(completedRun, 'run:completed', `Agent run completed${allocationLogSuffix(completedRun)}`, null, {
    allocationPlanId: completedRun.allocationPlanId || null,
    allocationItemId: completedRun.allocationItemId || null
  });
  completeRunViolationCheck(completedRun.id);
  persistRunEvaluation(completedRun.id);
  persistRunConsequence(completedRun.id);
  appendEvent({
    type: 'run.terminalized',
    ticketId: completedRun.ticketId,
    runId: completedRun.id,
    payload: { status: 'completed' }
  });
  finalizeTicketForRun(completedRun, 'completed');
  return completedRun;
}

function createAgentRun(ticket, agent, allocationItem = null, allocationPlanId = null, delegated = null) {
  const runs = readRuns();
  const activeRun = runs.find(run =>
    run.ticketId === ticket.id &&
    run.agentId === agent.id &&
    ['pending', 'running'].includes(run.status)
  );
  const pendingRunKey = `${ticket.id}:${agent.id}`;

  if (activeRun || runningRunKeys.has(pendingRunKey)) return activeRun || null;
  if (usesOwnedScopeAllocation(ticket) && (!allocationPlanId || !allocationItem)) {
    throw new Error('Owned-scope run creation requires an allocation plan item');
  }

  const now = new Date().toISOString();
  const isRerun = runs.some(run => run.ticketId === ticket.id);
  const usesOwnedScope = usesOwnedScopeAllocation(ticket);
  const nextRunId = nextId(runs);
  const ownedOutputPaths = allocationItem ? allocationItem.ownedOutputPaths.map(normalizeWorkspaceOwnershipPath) : [];
  const workflow = ticket.executionMode === 'workflow' ? getWorkflowById(ticket.workflowId) : null;
  const run = {
    id: nextRunId,
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    workspaceRoot: workspaceProvider.root,
    mainWorkspaceRoot: workspaceProvider.root,
    executionWorkspaceType: usesOwnedScope ? 'main_owned_paths' : 'main',
    executionPolicySnapshot: copyExecutionPolicy(
      ticket.executionPolicy,
      usesOwnedScope ? 'owned_paths' : 'shared'
    ),
    verificationContractSnapshot: buildVerificationContractSnapshot(workflow, now),
    allocationPlanId: allocationPlanId || null,
    allocationItemId: allocationItem ? allocationItem.allocationItemId : null,
    allocationSubtask: allocationItem ? allocationItem.allocationSubtask : null,
    ownedOutputPaths,
    executionMode: ticket.executionMode === 'workflow' ? 'workflow' : 'agent',
    workflowId: ticket.executionMode === 'workflow' ? ticket.workflowId : null,
    workflowInput: ticket.executionMode === 'workflow' ? (ticket.workflowInput || {}) : null,
    capabilityType: ticket.executionMode === 'workflow' ? 'workflow' : 'directAction',
    capabilityId: ticket.executionMode === 'workflow' ? ticket.workflowId : 'agent-selected-actions',
    capabilityInput: ticket.executionMode === 'workflow' ? (ticket.workflowInput || {}) : null,
    rerunMode: ticket.rerunMode || null,
    // Delegated human authority for this run, captured at run-initiation time (not
    // derived from ticket.changedBy later). Drives permissioned cross-ticket
    // actions; null when no real user initiated the run (e.g. system/workflow).
    delegatedUserId: delegated && delegated.userId != null ? delegated.userId : null,
    delegatedUsername: delegated && delegated.username ? delegated.username : null,
    delegatedPermissionSource: delegated && delegated.source ? delegated.source : null,
    currentPhase: 'planning',
    leaseOwner: null,
    leaseExpiresAt: null,
    currentStepId: null,
    currentWorkflowAction: null,
    lastHeartbeatAt: null,
    status: 'pending',
    ticketOpenedAt: ticket.updatedAt,
    createdAt: now,
    updatedAt: now
  };

  runs.push(run);
  writeRuns(runs);
  appendEvent({
    type: 'run.created',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      agentId: run.agentId,
      agentName: run.agentName,
      status: run.status,
      executionMode: run.executionMode,
      capabilityType: run.capabilityType,
      capabilityId: run.capabilityId,
      workflowId: run.workflowId,
      executionPolicySnapshot: run.executionPolicySnapshot,
      verificationContractSnapshot: run.verificationContractSnapshot,
      createdAt: run.createdAt
    }
  });
  appendRunLog(run, 'run:created', `${isRerun ? 'Agent rerun created' : 'Agent run created'}${allocationLogSuffix(run)}`, null, {
    allocationPlanId: run.allocationPlanId,
    allocationItemId: run.allocationItemId
  });
  updateTicketInProgressForRun(run);
  maybeTestInterrupt(run, 'after_run.created');
  return run;
}

function createRunsForTicket(ticket, delegated = null) {
  if (!ticket || ticket.status !== 'open') return [];
  if (hasUnresolvedTicketTriage(ticket)) return [];

  // Direct-action tickets: check objective clarity before creating any run.
  if (ticket.executionMode !== 'workflow') {
    const gateResult = runObjectiveClarificationGate(ticket.objective, ticket);
    if (gateResult.verdict === 'ambiguous') {
      blockTicketForObjectiveAmbiguity(ticket, gateResult);
      return [];
    }
  }

  if (ticket.assignmentTargetType === 'agent') {
    const agent = readAgents().find(item => item.id === ticket.assignmentTargetId);
    return agent ? [createAgentRun(ticket, agent, null, null, delegated)].filter(Boolean) : [];
  }

  if (usesOwnedScopeAllocation(ticket)) {
    const agents = getAgentsInGroup(ticket.assignmentTargetId);
    try {
      assertTicketObjectiveWithinGrantedWritableRoots(ticket, agents);
    } catch (error) {
      blockTicketForFeasibility(ticket, error);
      return [];
    }

    const existingRuns = readRuns();
    const agentsToRun = agents.filter(agent => {
      const pendingRunKey = `${ticket.id}:${agent.id}`;
      return !runningRunKeys.has(pendingRunKey) && !existingRuns.some(run =>
        run.ticketId === ticket.id &&
        run.agentId === agent.id &&
        ['pending', 'running'].includes(run.status)
      );
    });

    if (agentsToRun.length === 0) return [];

    const allocationPlan = createAllocationPlan(ticket, agentsToRun);

    return agentsToRun
      .map(agent => createAgentRun(
        ticket,
        agent,
        allocationPlan.items.find(item => item.assignedAgentId === agent.id),
        allocationPlan.id,
        delegated
      ))
      .filter(Boolean);
  }

  return [];
}

function parseModelActions(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      message: parsed.message || '',
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      complete: Boolean(parsed.complete),
      parseError: null
    };
  } catch (error) {
    return {
      message: text,
      actions: [],
      complete: false,
      parseError: error.message
    };
  }
}

function extractOpenAIText(data) {
  if (data.output_text) return data.output_text;

  const responseText = (data.output || [])
    .flatMap(item => item.content || [])
    .map(content => content.text || '')
    .filter(Boolean)
    .join('\n');

  if (responseText) return responseText;
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content || '';
  }

  return JSON.stringify(data);
}

function getRuntimeTimezone() {
  return process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function formatDateTimeForTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date).reduce((values, part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
    return values;
  }, {});

  const hour = parts.hour === '24' ? '00' : parts.hour;
  const localTimeAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const offsetMinutes = Math.round((localTimeAsUtc - date.getTime()) / 60000);
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffsetMinutes / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffsetMinutes % 60).padStart(2, '0');

  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offsetSign}${offsetHours}:${offsetRemainder}`;
}

function buildRuntimeEnvelope(run, step = 0, objective = null) {
  const timezone = getRuntimeTimezone();
  const workspaceRoot = run.workspaceRoot || workspaceProvider.root;
  const limits = getAgentRuntimeLimits(objective);

  const disabledConfigToOps = {
    allowHandoffTask: 'createHandoffTask',
    allowWorkflowDraftIntent: 'createWorkflowDraftIntent',
    allowCanonicalWorkflowDraft: 'createWorkflowDraft'
  };

  const agent = readAgents().find(item => item.id === run.agentId);
  const effectiveConfig = agent ? getAgentEffectiveRuntimeConfig(agent) : {};
  const filteredOps = AGENT_DIRECT_OPERATIONS.filter(op => {
    for (const [configKey, operationName] of Object.entries(disabledConfigToOps)) {
      if (op === operationName && effectiveConfig[configKey] === false) return false;
    }
    return true;
  });

  const profile = detectWorkloadProfile(objective);

  return {
    runId: run.id,
    ticketId: run.ticketId,
    assignedAgentId: run.agentId,
    currentDateTime: formatDateTimeForTimezone(new Date(), timezone),
    timezone,
    workspaceRoot,
    mainWorkspaceRoot: run.mainWorkspaceRoot || workspaceProvider.root,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    allocationItem: getRunAllocationItem(run),
    allocationSubtask: run.allocationSubtask || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    allowedOperations: filteredOps,
    maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
    maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
    currentStep: step,
    maxExecutionSteps: limits.maxExecutionSteps,
    workloadProfile: profile || null,
    currentPhase: run.currentPhase || 'planning'
  };
}

function buildSimulationRuntimeEnvelope(ticket, agent) {
  const timezone = getRuntimeTimezone();
  const workspaceRoot = workspaceProvider.root;
  const limits = getAgentRuntimeLimits(ticket.objective);

  const disabledConfigToOps = {
    allowHandoffTask: 'createHandoffTask',
    allowWorkflowDraftIntent: 'createWorkflowDraftIntent',
    allowCanonicalWorkflowDraft: 'createWorkflowDraft'
  };

  const effectiveConfig = agent ? getAgentEffectiveRuntimeConfig(agent) : {};
  const filteredOps = AGENT_DIRECT_OPERATIONS.filter(op => {
    for (const [configKey, operationName] of Object.entries(disabledConfigToOps)) {
      if (op === operationName && effectiveConfig[configKey] === false) return false;
    }
    return true;
  });

  const profile = detectWorkloadProfile(ticket.objective);

  return {
    runId: null,
    ticketId: ticket.id,
    assignedAgentId: agent ? agent.id : null,
    currentDateTime: formatDateTimeForTimezone(new Date(), timezone),
    timezone,
    workspaceRoot,
    mainWorkspaceRoot: workspaceProvider.root,
    executionWorkspaceType: 'main',
    allocationPlanId: null,
    allocationItemId: null,
    allocationItem: null,
    allocationSubtask: null,
    ownedOutputPaths: [],
    allowedOperations: filteredOps,
    maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
    maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
    currentStep: 0,
    maxExecutionSteps: limits.maxExecutionSteps,
    workloadProfile: profile || null,
    currentPhase: 'planning',
    simulationMode: true
  };
}

function countMutatingActions(actions) {
  return (actions || []).filter(action =>
    action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation)
  ).length;
}

function normalizeActionPathForBundle(value) {
  const normalized = path.posix.normalize(String(value || '').replace(/\\/g, '/').trim()).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.includes('\0')) return null;
  if (normalized.split('/').some(segment => segment === '..')) return null;
  return normalized;
}

function isAllowedFolderWriteBundle(actions) {
  if (!Array.isArray(actions) || actions.length !== 3) return false;
  const createActions = actions.filter(action => action && action.operation === 'createFolder');
  const writeActions = actions.filter(action => action && action.operation === 'writeFile');
  if (createActions.length !== 1 || writeActions.length !== 2) return false;

  const folderPath = normalizeActionPathForBundle(createActions[0].args && createActions[0].args.path);
  if (!folderPath) return false;
  const folderPrefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';

  return writeActions.every(action => {
    const writePath = normalizeActionPathForBundle(action.args && action.args.path);
    return Boolean(writePath && writePath.startsWith(folderPrefix));
  });
}

function parseTicketShapeSuggestion(text) {
  try {
    const parsed = JSON.parse(text);
    const suggestedObjective = typeof parsed.suggestedObjective === 'string'
      ? parsed.suggestedObjective.trim()
      : '';
    const expectedOutputs = Array.isArray(parsed.expectedOutputs)
      ? parsed.expectedOutputs.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const decomposition = Array.isArray(parsed.decomposition)
      ? parsed.decomposition.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.map(item => String(item || '').trim()).filter(Boolean).slice(0, 5)
      : [];

    return {
      suggestedObjective,
      expectedOutputs,
      decomposition,
      warnings,
      tooBroadForOneRun: parsed.tooBroadForOneRun === true,
      groupModeFit: typeof parsed.groupModeFit === 'string' ? parsed.groupModeFit.trim() : '',
      parseError: null
    };
  } catch (error) {
    return {
      suggestedObjective: '',
      expectedOutputs: [],
      decomposition: [],
      warnings: ['The suggestion response was not valid JSON.'],
      tooBroadForOneRun: false,
      groupModeFit: '',
      parseError: error.message
    };
  }
}

function getTicketShapeAgent(body = {}) {
  const assignmentTargetType = body.assignmentTargetType === 'agent' ? 'agent' : null;
  const assignmentTargetId = parseInt(body.assignmentTargetId, 10);

  if (assignmentTargetType === 'agent' && !Number.isNaN(assignmentTargetId)) {
    const selectedAgent = readAgents().find(agent => agent.id === assignmentTargetId);
    if (selectedAgent) return selectedAgent;
  }

  return {
    id: null,
    name: 'Ticket shaping assistant',
    provider: process.env.OLLAMA_MODEL && !process.env.OPENAI_MODEL ? 'ollama' : 'openai',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || ''
  };
}

async function suggestBoundedTicketObjective(body = {}) {
  const objective = String(body.objective || '').trim();
  if (!objective) {
    const error = new Error('Objective is required for ticket shaping');
    error.statusCode = 400;
    throw error;
  }

  const agent = getTicketShapeAgent(body);
  const input = [
    {
      role: 'system',
      content: [
        'You help an operator shape a ticket before execution.',
        'The system works best with small concrete additive tasks that fit bounded execution.',
        `A model response can perform at most ${MAX_MUTATING_ACTIONS_PER_RESPONSE} mutating workspace actions before verification.`,
        'Do not create a plan for autonomous execution.',
        'Do not spawn tickets.',
        'Suggest wording only. The operator must decide whether to accept or edit it.',
        'Prefer concrete expected files, paths, or outputs.',
        'For group or dynamic mode, call out whether the work has independent outputs/scopes.',
        'Respond only as JSON with this shape:',
        '{"suggestedObjective":"clear bounded objective","expectedOutputs":["output path or result"],"decomposition":["smaller additive ticket if needed"],"warnings":["risk or vague wording"],"tooBroadForOneRun":true|false,"groupModeFit":"short assessment"}'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        objective,
        assignmentTargetType: body.assignmentTargetType || 'agent',
        assignmentMode: body.assignmentMode || 'individual',
        maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE
      })
    }
  ];

  const response = await callOpenAI(agent, input);
  const suggestion = parseTicketShapeSuggestion(response.text);

  if (!suggestion.suggestedObjective && !suggestion.parseError) {
    suggestion.warnings.push('The suggestion did not include a clearer objective.');
  }

  return {
    ...suggestion,
    providerRequestId: response.responsePayload && response.responsePayload.requestId || null,
    usage: response.usage || null
  };
}

function createStructuredWorkspaceError(message, code, kind, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = kind;
  error.details = detail;
  return error;
}

function createStructuredWorkspaceFsError(error, operation, relativePath) {
  if (error && error.code === 'ENOENT') {
    const parentPath = path.posix.dirname(String(relativePath || ''));
    return createStructuredWorkspaceError(error.message, 'WORKSPACE_FS_ENOENT', 'workspace_error', {
      operation,
      path: relativePath,
      parentPath: parentPath === '.' ? '' : parentPath,
      fsCode: error.code
    });
  }
  return error;
}

function assertAgentWorkspacePathAllowed(relativePath) {
  const normalized = path.posix.normalize(String(relativePath || '').replace(/\\/g, '/'));
  const cleanPath = normalized === '.' ? '' : normalized;

  if (!cleanPath) return;

  const sensitivePaths = [
    'data',
    'server.js',
    'views/admin',
    'views/login.ejs',
    'views/layout.ejs',
    'package.json',
    'pnpm-lock.yaml'
  ];

  if (sensitivePaths.some(sensitivePath => cleanPath === sensitivePath || cleanPath.startsWith(`${sensitivePath}/`))) {
    throw createStructuredWorkspaceError('Agent action blocked for sensitive application path', 'WORKSPACE_SENSITIVE_PATH', 'protected_path', {
      path: cleanPath
    });
  }
}

function getAgentOpenAIConfig(agent) {
  const apiKey = String(agent.apiKey || process.env.OPENAI_API_KEY || '').trim();
  const model = String(agent.model || process.env.OPENAI_MODEL || '').trim();

  if (!apiKey) {
    throw new Error('Agent API key is missing — set the agent’s API key or the OPENAI_API_KEY environment variable.');
  }

  if (!model) {
    throw new Error('Agent model is missing');
  }

  return { apiKey, model };
}

function getAgentOllamaConfig(agent) {
  const model = String(agent.model || process.env.OLLAMA_MODEL || '').trim();
  const baseUrl = String(agent.baseUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');

  if (!model) {
    throw new Error('Ollama model is missing');
  }

  return { provider: 'ollama', model, baseUrl };
}

function getAgentProviderConfig(agent) {
  const provider = PROVIDERS.includes(agent && agent.provider) ? agent.provider : 'openai';

  if (provider === 'ollama') {
    return getAgentOllamaConfig(agent);
  }

  return {
    provider: 'openai',
    ...getAgentOpenAIConfig(agent)
  };
}

function hasProviderModelFallback(provider) {
  return provider === 'ollama'
    ? Boolean(String(process.env.OLLAMA_MODEL || '').trim())
    : Boolean(String(process.env.OPENAI_MODEL || '').trim());
}

function hasProviderApiKeyFallback(provider) {
  return provider === 'ollama' || Boolean(String(process.env.OPENAI_API_KEY || '').trim());
}

function providerRequestId(headers) {
  if (!headers || typeof headers !== 'object') return null;
  return headers['x-request-id'] || headers['openai-request-id'] || headers['request-id'] || null;
}

function createProviderError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  error.failureKind = 'provider_error';
  error.details = detail;
  return error;
}

async function callOpenAI(agent, input, options = {}) {
  const openAIConfig = getAgentOpenAIConfig(agent);

  const responseBody = {
    model: openAIConfig.model,
    input,
    text: {
      format: {
        type: 'json_object'
      }
    }
  };
  const requestSnapshot = {
    url: 'https://api.openai.com/v1/responses',
    method: 'POST',
    headers: {
      Authorization: '[redacted]',
      'Content-Type': 'application/json'
    },
    body: responseBody
  };

  if (typeof options.onRequest === 'function') {
    options.onRequest(requestSnapshot);
  }

  let response = null;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAIConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify(responseBody)
    });
  } catch (fetchError) {
    if (fetchError && fetchError.name === 'AbortError') {
      throw fetchError;
    }
    const error = createProviderError(fetchError.message || 'OpenAI request failed before response', 'OPENAI_TRANSPORT_ERROR', {
      phase: 'request',
      provider: 'openai',
      model: openAIConfig.model
    });
    error.providerRequestPayload = requestSnapshot;
    throw error;
  }
  const responseHeaders = Object.fromEntries(response.headers.entries());
  const requestId = providerRequestId(responseHeaders);

  const responseText = await response.text();
  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      const providerError = createProviderError(!response.ok
        ? `OpenAI request failed with HTTP ${response.status}: ${responseText.slice(0, 240)}`
        : 'OpenAI response was not valid JSON', 'OPENAI_MALFORMED_RESPONSE', {
        phase: 'response_parse',
        provider: 'openai',
        status: response.status,
        requestId
      });
      providerError.providerRequestPayload = requestSnapshot;
      providerError.providerResponsePayload = {
        ok: response.ok,
        status: response.status,
        requestId,
        headers: sanitizeSnapshotValue(responseHeaders),
        body: responseText.slice(0, 2000)
      };
      throw providerError;
    }
  }

  if (!response.ok) {
    const errorMessage = data && data.error && data.error.message
      ? data.error.message
      : `OpenAI request failed with HTTP ${response.status}`;
    const error = createProviderError(errorMessage, 'OPENAI_HTTP_ERROR', {
      phase: 'response_status',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data || responseText
    };
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = createProviderError('OpenAI response was empty', 'OPENAI_EMPTY_RESPONSE', {
      phase: 'response_body',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  const text = extractOpenAIText(data);

  if (!String(text || '').trim()) {
    const error = createProviderError('OpenAI response did not include model output', 'OPENAI_NO_OUTPUT', {
      phase: 'model_output',
      provider: 'openai',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  return {
    text,
    usage: data.usage,
    provider: 'openai',
    model: openAIConfig.model,
    requestPayload: requestSnapshot,
    responsePayload: {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    }
  };
}

async function callOllama(agent, input, options = {}) {
  const ollamaConfig = getAgentOllamaConfig(agent);
  const messages = input.map(item => ({
    role: item.role || 'user',
    content: String(item.content || '')
  }));
  const responseBody = {
    model: ollamaConfig.model,
    messages,
    stream: false,
    format: 'json'
  };
  const requestSnapshot = {
    url: `${ollamaConfig.baseUrl}/api/chat`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: responseBody
  };

  if (typeof options.onRequest === 'function') {
    options.onRequest(requestSnapshot);
  }

  let response = null;
  try {
    response = await fetch(`${ollamaConfig.baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: options.signal,
      body: JSON.stringify(responseBody)
    });
  } catch (fetchError) {
    if (fetchError && fetchError.name === 'AbortError') {
      throw fetchError;
    }
    const error = createProviderError(fetchError.message || 'Ollama request failed before response', 'OLLAMA_TRANSPORT_ERROR', {
      phase: 'request',
      provider: 'ollama',
      model: ollamaConfig.model,
      baseUrl: ollamaConfig.baseUrl
    });
    error.providerRequestPayload = requestSnapshot;
    throw error;
  }

  const responseHeaders = Object.fromEntries(response.headers.entries());
  const requestId = providerRequestId(responseHeaders);
  const responseText = await response.text();
  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch (error) {
      const providerError = createProviderError(!response.ok
        ? `Ollama request failed with HTTP ${response.status}: ${responseText.slice(0, 240)}`
        : 'Ollama response was not valid JSON', 'OLLAMA_MALFORMED_RESPONSE', {
        phase: 'response_parse',
        provider: 'ollama',
        status: response.status,
        requestId
      });
      providerError.providerRequestPayload = requestSnapshot;
      providerError.providerResponsePayload = {
        ok: response.ok,
        status: response.status,
        requestId,
        headers: sanitizeSnapshotValue(responseHeaders),
        body: responseText.slice(0, 2000)
      };
      throw providerError;
    }
  }

  if (!response.ok) {
    const errorMessage = data && data.error
      ? String(data.error)
      : `Ollama request failed with HTTP ${response.status}`;
    const error = createProviderError(errorMessage, 'OLLAMA_HTTP_ERROR', {
      phase: 'response_status',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data || responseText
    };
    throw error;
  }

  if (!data || typeof data !== 'object') {
    const error = createProviderError('Ollama response was empty', 'OLLAMA_EMPTY_RESPONSE', {
      phase: 'response_body',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  const text = data.message && typeof data.message.content === 'string'
    ? data.message.content
    : typeof data.response === 'string'
      ? data.response
      : '';

  if (!String(text || '').trim()) {
    const error = createProviderError('Ollama response did not include model output', 'OLLAMA_NO_OUTPUT', {
      phase: 'model_output',
      provider: 'ollama',
      status: response.status,
      requestId
    });
    error.providerRequestPayload = requestSnapshot;
    error.providerResponsePayload = {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    };
    throw error;
  }

  return {
    text,
    usage: {
      prompt_eval_count: data.prompt_eval_count || null,
      eval_count: data.eval_count || null,
      total_duration: data.total_duration || null
    },
    provider: 'ollama',
    model: ollamaConfig.model,
    requestPayload: requestSnapshot,
    responsePayload: {
      ok: response.ok,
      status: response.status,
      requestId,
      headers: sanitizeSnapshotValue(responseHeaders),
      body: data
    }
  };
}

async function callModelProvider(agent, input, options = {}) {
  const provider = PROVIDERS.includes(agent && agent.provider) ? agent.provider : 'openai';
  if (provider === 'ollama') return callOllama(agent, input, options);
  return callOpenAI(agent, input, options);
}

function assertOnlyKeys(value, allowedKeys, label) {
  const keys = Object.keys(value || {});
  const unexpectedKey = keys.find(key => !allowedKeys.includes(key));

  if (unexpectedKey) {
    const error = new Error(`${label} includes unsupported field: ${unexpectedKey}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }
}

function requireStringArg(args, name, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(args, name)) {
    const error = new Error(`Workspace operation missing required arg: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (typeof args[name] !== 'string') {
    const error = new Error(`Workspace operation arg must be a string: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (options.nonEmpty && !args[name].trim()) {
    const error = new Error(`Workspace operation arg cannot be blank: ${name}`);
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  return args[name];
}

// Args that must be present and non-blank per operation. Mirrors the
// requireStringArg({ nonEmpty: true }) calls in executeWorkspaceOperation:
// listDirectory path may be "" (workspace root); every other op's path (and
// renamePath nextPath) must be non-blank. writeFile content may be "".
const WORKSPACE_PREFLIGHT_NONEMPTY_ARGS = {
  listDirectory: [],
  readFile: ['path'],
  createFolder: ['path'],
  writeFile: ['path'],
  renamePath: ['path', 'nextPath'],
  deletePath: ['path']
};

// Validate ONE standard workspace action's args without executing it, mirroring the
// rules executeWorkspaceOperation enforces (missing / non-string / blank-when-required).
// Returns an array of validation error strings (empty = valid). Non-standard
// operations (workflow/handoff) are not gated here and return [].
function validateWorkspaceActionForPreflight(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return ['action must be an object'];
  const operation = action.operation;
  if (!AGENT_ALLOWED_OPERATIONS.includes(operation)) return [];
  const requiredArgs = AGENT_OPERATION_ARGS[operation] || [];
  const nonEmptyArgs = WORKSPACE_PREFLIGHT_NONEMPTY_ARGS[operation] || [];
  const args = action.args && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : null;
  if (!args) return ['args must be an object'];
  const errors = [];
  for (const name of requiredArgs) {
    if (!Object.prototype.hasOwnProperty.call(args, name)) { errors.push('missing required arg: ' + name); continue; }
    if (typeof args[name] !== 'string') { errors.push('arg must be a string: ' + name); continue; }
    if (nonEmptyArgs.includes(name) && !args[name].trim()) errors.push('arg cannot be blank: ' + name);
  }
  return errors;
}

// Validate an entire model action batch before any execution. Returns the list of
// invalid standard-workspace actions (with index/operation/args/errors); empty list
// means the batch is safe to execute.
function validateWorkspaceActionBatch(actions) {
  const invalid = [];
  (Array.isArray(actions) ? actions : []).forEach((action, index) => {
    const errors = validateWorkspaceActionForPreflight(action);
    if (errors.length > 0) {
      invalid.push({
        actionIndex: index,
        operation: action && action.operation ? action.operation : null,
        args: action && action.args ? action.args : null,
        validationErrors: errors
      });
    }
  });
  return invalid;
}

function readProtectedWorkspacePaths() {
  try {
    const configuredPaths = JSON.parse(fs.readFileSync(PROTECTED_PATHS_FILE, 'utf8'));

    if (!Array.isArray(configuredPaths)) {
      throw new Error('Protected workspace paths config must be an array');
    }

    return configuredPaths
      .filter(item => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean);
  } catch (error) {
    return [...DEFAULT_PROTECTED_WORKSPACE_PATHS];
  }
}

function normalizeWorkspacePattern(pattern) {
  return String(pattern || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function workspacePatternMatches(pattern, relativePath) {
  const normalizedPattern = normalizeWorkspacePattern(pattern);
  const normalizedPath = normalizeWorkspacePattern(relativePath);

  if (!normalizedPattern || !normalizedPath) return false;

  if (normalizedPattern.endsWith('.*')) {
    const prefix = normalizedPattern.slice(0, -1);
    return normalizedPath === prefix.slice(0, -1) ||
      normalizedPath.startsWith(prefix) ||
      normalizedPath.includes(`/${prefix}`);
  }

  return normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(`${normalizedPattern}/`) ||
    normalizedPath.endsWith(`/${normalizedPattern}`) ||
    normalizedPath.includes(`/${normalizedPattern}/`);
}

function getProtectedWorkspacePathMatch(relativePath) {
  return readProtectedWorkspacePaths().find(pattern => workspacePatternMatches(pattern, relativePath)) || null;
}

function createProtectedWorkspaceError(operation, relativePath, matchedPattern) {
  const error = new Error(`Blocked protected workspace path mutation: ${operation} ${relativePath}`);

  error.code = 'WORKSPACE_PROTECTED_PATH';
  error.operation = operation;
  error.path = relativePath;
  error.reason = `Path matches protected workspace pattern: ${matchedPattern}`;
  return error;
}

function blockProtectedWorkspaceOperation(run, operation, args, relativePath, runWorkspaceProvider) {
  const matchedPattern = getProtectedWorkspacePathMatch(relativePath);

  if (!matchedPattern) return;

  const error = createProtectedWorkspaceError(operation, relativePath, matchedPattern);
  const workspaceAction = {
    operation,
    args,
    path: relativePath,
    ...buildWorkspaceActionMetadata(run, runWorkspaceProvider),
    blocked: true,
    reason: error.reason
  };

  appendRunLog(run, 'workspace:blocked', error.message, workspaceAction);
  error.workspaceAction = workspaceAction;
  throw error;
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function captureWorkspacePreState(runWorkspaceProvider, operation, args) {
  if (operation === 'createFolder') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  if (operation === 'writeFile') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    const content = info.exists && info.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined, content };
  }
  if (operation === 'renamePath') {
    const sourceInfo = runWorkspaceProvider.getPathInfo(args.path);
    const sourceContent = sourceInfo.exists && sourceInfo.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    const destInfo = runWorkspaceProvider.getPathInfo(args.nextPath);
    return {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined, contentHash: sourceInfo.contentHash || undefined, content: sourceContent },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined }
    };
  }
  if (operation === 'deletePath') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    const content = info.exists && info.type === 'file' ? runWorkspaceProvider.readFile(args.path) : undefined;
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined, content };
  }
  return null;
}

function captureWorkspacePostState(runWorkspaceProvider, operation, args) {
  if (operation === 'createFolder') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  if (operation === 'writeFile') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined, contentHash: info.contentHash || undefined };
  }
  if (operation === 'renamePath') {
    const sourceInfo = runWorkspaceProvider.getPathInfo(args.path);
    const destInfo = runWorkspaceProvider.getPathInfo(args.nextPath);
    return {
      source: { existed: sourceInfo.exists, type: sourceInfo.type || undefined },
      destination: { existed: destInfo.exists, type: destInfo.type || undefined, contentHash: destInfo.contentHash || undefined }
    };
  }
  if (operation === 'deletePath') {
    const info = runWorkspaceProvider.getPathInfo(args.path);
    return { existed: info.exists, type: info.type || undefined };
  }
  return null;
}

function persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, error) {
  const histories = readOperationHistory();
  const newId = nextId(histories);
  const record = {
    id: newId,
    timestamp: createLogTimestamp(),
    ticketId: run.ticketId,
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    runId: run.id,
    step,
    operation,
    args: sanitizeSnapshotValue(args),
    preState,
    postState,
    result: error ? null : sanitizeSnapshotValue(result),
    error: error ? (error.message || String(error)) : null
  };
  histories.push(record);
  writeOperationHistory(histories);
  return record;
}

function parseWorkspaceOperation(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    const error = new Error('Workspace action must be an object');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  assertOnlyKeys(action, ['operation', 'args'], 'Workspace action');

  if (typeof action.operation !== 'string' || !action.operation.trim()) {
    const error = new Error('Workspace action operation is required');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  if (!AGENT_ALLOWED_OPERATIONS.includes(action.operation)) {
    const error = new Error(`Unsupported workspace operation: ${action.operation}`);
    error.code = 'WORKSPACE_UNSUPPORTED_OPERATION';
    throw error;
  }

  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
    const error = new Error('Workspace action args must be an object');
    error.code = 'WORKSPACE_MALFORMED_ACTION';
    throw error;
  }

  return {
    operation: action.operation,
    args: action.args
  };
}

function normalizeWorkflowDraftIntentAction(action) {
  if (!action || action.operation !== 'createWorkflowDraftIntent') return action;
  if (!Object.prototype.hasOwnProperty.call(action, 'postconditions')) return action;
  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) return action;
  if (Object.prototype.hasOwnProperty.call(action.args, 'postconditions')) return action;

  assertOnlyKeys(action, ['operation', 'args', 'postconditions'], 'Agent action');
  return {
    operation: action.operation,
    args: {
      ...action.args,
      postconditions: action.postconditions
    }
  };
}

function parseAgentDirectAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    const error = new Error('Agent action must be an object');
    error.code = 'AGENT_ACTION_MALFORMED';
    throw error;
  }

  action = normalizeWorkflowDraftIntentAction(action);
  assertOnlyKeys(action, ['operation', 'args'], 'Agent action');

  if (typeof action.operation !== 'string' || !action.operation.trim()) {
    const error = new Error('Agent action operation is required');
    error.code = 'AGENT_ACTION_MALFORMED';
    throw error;
  }

  const operation = action.operation.trim();
  if (!AGENT_DIRECT_OPERATIONS.includes(operation)) {
    const error = new Error(`Unsupported agent operation: ${operation}`);
    error.code = 'AGENT_ACTION_UNSUPPORTED';
    throw error;
  }

  if (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)) {
    const error = new Error(`Agent operation args must be an object: ${operation}`);
    error.code = 'AGENT_ACTION_MALFORMED';
    throw error;
  }

  if (AGENT_ALLOWED_OPERATIONS.includes(operation)) return parseWorkspaceOperation(action);

  if (operation === 'createWorkflowDraft') {
    assertOnlyKeys(action.args, ['workflow'], 'createWorkflowDraft args');
    if (!action.args.workflow || typeof action.args.workflow !== 'object' || Array.isArray(action.args.workflow)) {
      const error = new Error('createWorkflowDraft args.workflow must be an object');
      error.code = 'WORKFLOW_DRAFT_INVALID';
      throw error;
    }
  }

  if (operation === 'createWorkflowDraftIntent') {
    assertOnlyKeys(action.args, ['id', 'name', 'writes', 'postconditions'], 'createWorkflowDraftIntent args');
  }

  if (operation === 'createHandoffTask') {
    assertOnlyKeys(action.args, ['executor', 'operation', 'args'], 'createHandoffTask args');
  }

  return { operation, args: action.args };
}

function getActionContract(name) {
  return ACTION_CONTRACTS_BY_NAME.get(name) || null;
}

function isWorkflowTemplateValue(value) {
  return typeof value === 'string' && /\{\{[^}]+\}\}/.test(value);
}

function validateSchemaValue(schema, value, pathLabel = 'input', options = {}) {
  const errors = [];
  const allowTemplates = options.allowTemplates === true;

  if (allowTemplates && isWorkflowTemplateValue(value)) {
    return errors;
  }

  if (schema === 'any') {
    return errors;
  }

  if (typeof schema === 'string') {
    if (schema === 'string' && typeof value !== 'string') errors.push(`${pathLabel} must be a string`);
    if (schema === 'number' && typeof value !== 'number') errors.push(`${pathLabel} must be a number`);
    if (schema === 'boolean' && typeof value !== 'boolean') errors.push(`${pathLabel} must be a boolean`);
    return errors;
  }

  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel} must be an array`);
      return errors;
    }

    if (schema.length > 0) {
      value.forEach((item, index) => {
        errors.push(...validateSchemaValue(schema[0], item, `${pathLabel}[${index}]`, options));
      });
    }

    return errors;
  }

  if (schema && typeof schema === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${pathLabel} must be an object`);
      return errors;
    }

    Object.keys(schema).forEach(key => {
      if (!(key in value)) {
        errors.push(`${pathLabel}.${key} is required`);
        return;
      }

      errors.push(...validateSchemaValue(schema[key], value[key], `${pathLabel}.${key}`, options));
    });
  }

  return errors;
}

function validateActionInput(actionName, input, options = {}) {
  const contract = getActionContract(actionName);
  if (!contract) {
    return [`Unknown action: ${actionName}`];
  }

  return validateSchemaValue(contract.inputSchema, input || {}, `${actionName}.input`, options);
}

function validateWorkflowDefinition(workflow) {
  const errors = [];

  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    return ['Workflow definition must be an object'];
  }

  if (typeof workflow.id !== 'string' || !workflow.id.trim()) errors.push('workflow.id is required');
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) errors.push('workflow.name is required');
  if (!workflow.inputSchema || typeof workflow.inputSchema !== 'object' || Array.isArray(workflow.inputSchema)) {
    errors.push('workflow.inputSchema must be an object');
  }
  if (!Array.isArray(workflow.actions) || workflow.actions.length === 0) {
    errors.push('workflow.actions must contain at least one action');
    return errors;
  }
  if (workflow.postconditions !== undefined && !Array.isArray(workflow.postconditions)) {
    errors.push('workflow.postconditions must be an array when provided');
  }
  if (workflow.version !== undefined && typeof workflow.version !== 'string') {
    errors.push('workflow.version must be a string when provided');
  }
  if (workflow.taskPromptTemplate !== undefined && typeof workflow.taskPromptTemplate !== 'string') {
    errors.push('workflow.taskPromptTemplate must be a string when provided');
  }
  if (workflow.policy !== undefined) {
    if (!workflow.policy || typeof workflow.policy !== 'object' || Array.isArray(workflow.policy)) {
      errors.push('workflow.policy must be an object when provided');
    } else {
      if (typeof workflow.policy.id !== 'string' || !workflow.policy.id.trim()) errors.push('workflow.policy.id is required');
      if (typeof workflow.policy.version !== 'string' || !workflow.policy.version.trim()) errors.push('workflow.policy.version is required');
      if (typeof workflow.policy.text !== 'string' || !workflow.policy.text.trim()) errors.push('workflow.policy.text is required');
    }
  }
  if (workflow.verifierContract !== undefined) {
    if (!workflow.verifierContract || typeof workflow.verifierContract !== 'object' || Array.isArray(workflow.verifierContract)) {
      errors.push('workflow.verifierContract must be an object when provided');
    } else {
      if (typeof workflow.verifierContract.id !== 'string' || !workflow.verifierContract.id.trim()) errors.push('workflow.verifierContract.id is required');
      if (typeof workflow.verifierContract.version !== 'string' || !workflow.verifierContract.version.trim()) errors.push('workflow.verifierContract.version is required');
      if (workflow.verifierContract.fixture !== undefined && typeof workflow.verifierContract.fixture !== 'string') errors.push('workflow.verifierContract.fixture must be a string when provided');
      if (workflow.verifierContract.expectedArtifacts !== undefined && !Array.isArray(workflow.verifierContract.expectedArtifacts)) {
        errors.push('workflow.verifierContract.expectedArtifacts must be an array when provided');
      }
    }
  }

  const stepIds = new Set();
  workflow.actions.forEach((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`workflow.actions[${index}] must be an object`);
      return;
    }

    if (typeof step.id !== 'string' || !step.id.trim()) {
      errors.push(`workflow.actions[${index}].id is required`);
    } else if (stepIds.has(step.id)) {
      errors.push(`workflow action id must be unique: ${step.id}`);
    } else {
      stepIds.add(step.id);
    }

    const contract = getActionContract(step.action);
    if (!contract) {
      errors.push(`workflow action ${step.id || index} references unknown action: ${step.action}`);
      return;
    }

    if (!isWorkflowUsableAction(contract)) {
      errors.push(`workflow action ${step.id || index} cannot invoke non-workflow action: ${step.action}`);
    }

    errors.push(...validateActionInput(step.action, step.input || {}, { allowTemplates: true }));
  });

  (Array.isArray(workflow.postconditions) ? workflow.postconditions : []).forEach((postcondition, index) => {
    if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) {
      errors.push(`workflow.postconditions[${index}] must be an object`);
      return;
    }

    const type = postcondition.type;
    if (!['fileExists', 'fileContains', 'jsonPathEquals', 'outputFieldEquals'].includes(type)) {
      errors.push(`workflow.postconditions[${index}].type is unsupported: ${type}`);
      return;
    }

    if ((type === 'fileExists' || type === 'fileContains' || type === 'jsonPathEquals') && typeof postcondition.path !== 'string') {
      errors.push(`workflow.postconditions[${index}].path is required`);
    }
    if (type === 'fileContains' && typeof postcondition.contains !== 'string') {
      errors.push(`workflow.postconditions[${index}].contains is required`);
    }
    if (type === 'jsonPathEquals' && typeof postcondition.jsonPath !== 'string') {
      errors.push(`workflow.postconditions[${index}].jsonPath is required`);
    }
    if (type === 'outputFieldEquals' && typeof postcondition.field !== 'string') {
      errors.push(`workflow.postconditions[${index}].field is required`);
    }
    if ((type === 'jsonPathEquals' || type === 'outputFieldEquals') && !Object.prototype.hasOwnProperty.call(postcondition, 'equals')) {
      errors.push(`workflow.postconditions[${index}].equals is required`);
    }
  });

  workflow.actions.forEach((step, index) => {
    if (!step || typeof step !== 'object') return;
    const nextValues = [step.next, step.trueNext, step.falseNext].filter(Boolean);
    nextValues.forEach(next => {
      if (next !== 'stop' && !stepIds.has(next)) {
        errors.push(`workflow action ${step.id || index} points to unknown next action: ${next}`);
      }
    });
  });

  return errors;
}

function requireIntentString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${label} must be a non-empty string`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  return value.trim();
}

function assertWorkflowDraftIntentId(value, label) {
  const id = requireIntentString(value, label);
  if (/^\d+$/.test(id)) {
    const error = new Error(`${label} must be a descriptive non-numeric id such as draft-summary-file-123 or draft-verified-output-123`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  return id;
}

function assertWorkflowDraftIntentRelativePath(value, label) {
  const candidate = requireIntentString(value, label);
  const normalized = candidate.replace(/\\/g, '/');
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || normalized.startsWith('/')) {
    const error = new Error(`${label} must be a relative workspace path`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  const normalizedPath = path.posix.normalize(normalized);
  const segments = normalizedPath.split('/').filter(Boolean);
  if (normalizedPath === '..' || normalizedPath.startsWith('../') || segments.includes('..')) {
    const error = new Error(`${label} must not contain path traversal`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  return normalizedPath === '.' ? '' : normalizedPath;
}

function assertWorkflowDraftIntentContent(content, label) {
  const text = requireIntentString(content, label);
  const lower = text.toLowerCase();
  const looksLikeWorkflowDocument = /(^|\n)\s*workflow\s*:/i.test(text) ||
    /(^|\n)\s*steps\s*:/i.test(text) ||
    /"actions"\s*:\s*\[/i.test(text);
  const looksLikeBranching = /(^|\n)\s*branches\s*:/i.test(text) ||
    /(^|\n)\s*condition\s*:/i.test(text) ||
    /(^|\n)\s*type\s*:\s*condition\b/i.test(text) ||
    /\b(trueNext|falseNext)\b/.test(text) ||
    /\bbranch(?:es|ing)?\b/i.test(text);

  if (looksLikeWorkflowDocument && looksLikeBranching) {
    const error = new Error(`${label} appears to encode an unsupported branching workflow; createWorkflowDraftIntent only writes literal files`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  if (lower.includes('createworkflowdraft') || lower.includes('createworkflowdraftintent')) {
    const error = new Error(`${label} must be literal file content, not another workflow draft request`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  return text;
}

function compileWorkflowDraftIntent(intentInput) {
  const intent = intentInput && typeof intentInput === 'object' && !Array.isArray(intentInput)
    ? sanitizeSnapshotValue(intentInput)
    : null;

  if (!intent) {
    const error = new Error('Workflow draft intent must be an object');
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }

  const id = assertWorkflowDraftIntentId(intent.id, 'createWorkflowDraftIntent.id');
  const name = requireIntentString(intent.name, 'createWorkflowDraftIntent.name');
  if (!Array.isArray(intent.writes) || intent.writes.length === 0) {
    const error = new Error('createWorkflowDraftIntent.writes must contain at least one write');
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }
  if (!Array.isArray(intent.postconditions) || intent.postconditions.length === 0) {
    const error = new Error('createWorkflowDraftIntent postconditions are required for write workflows');
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  }

  const writes = intent.writes.map((write, index) => {
    if (!write || typeof write !== 'object' || Array.isArray(write)) {
      const error = new Error(`createWorkflowDraftIntent.writes[${index}] must be an object`);
      error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
      throw error;
    }
    assertOnlyKeys(write, ['path', 'content'], `createWorkflowDraftIntent.writes[${index}]`);
    return {
      path: assertWorkflowDraftIntentRelativePath(write.path, `createWorkflowDraftIntent.writes[${index}].path`),
      content: assertWorkflowDraftIntentContent(write.content, `createWorkflowDraftIntent.writes[${index}].content`)
    };
  });

  const postconditions = intent.postconditions.map((postcondition, index) => {
    if (!postcondition || typeof postcondition !== 'object' || Array.isArray(postcondition)) {
      const error = new Error(`createWorkflowDraftIntent.postconditions[${index}] must be an object`);
      error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
      throw error;
    }
    if (postcondition.type === 'fileExists') {
      assertOnlyKeys(postcondition, ['id', 'type', 'path'], `createWorkflowDraftIntent.postconditions[${index}]`);
      return {
        id: typeof postcondition.id === 'string' && postcondition.id.trim() ? postcondition.id.trim() : `postcondition_${index + 1}`,
        type: 'fileExists',
        path: assertWorkflowDraftIntentRelativePath(postcondition.path, `createWorkflowDraftIntent.postconditions[${index}].path`)
      };
    }
    if (postcondition.type === 'fileContains') {
      assertOnlyKeys(postcondition, ['id', 'type', 'path', 'contains'], `createWorkflowDraftIntent.postconditions[${index}]`);
      return {
        id: typeof postcondition.id === 'string' && postcondition.id.trim() ? postcondition.id.trim() : `postcondition_${index + 1}`,
        type: 'fileContains',
        path: assertWorkflowDraftIntentRelativePath(postcondition.path, `createWorkflowDraftIntent.postconditions[${index}].path`),
        contains: requireIntentString(postcondition.contains, `createWorkflowDraftIntent.postconditions[${index}].contains`)
      };
    }
    const error = new Error(`createWorkflowDraftIntent.postconditions[${index}].type is unsupported: ${postcondition.type}`);
    error.code = 'WORKFLOW_DRAFT_INTENT_INVALID';
    throw error;
  });

  const actions = writes.map((write, index) => ({
    id: `write_${index + 1}`,
    action: 'writeFile',
    input: {
      path: write.path,
      content: write.content
    },
    next: index === writes.length - 1 ? 'stop' : `write_${index + 2}`
  }));

  actions.push({
    id: 'stop',
    action: 'stop',
    input: {
      result: {
        paths: writes.map(write => write.path)
      }
    }
  });

  return {
    intent,
    workflow: {
      id,
      name,
      inputSchema: {},
      actions,
      postconditions
    }
  };
}

function createWorkflowDraftFromAgent(run, workflowInput, step = 0) {
  const submittedWorkflow = workflowInput && typeof workflowInput === 'object' && !Array.isArray(workflowInput)
    ? workflowInput
    : null;

  if (!submittedWorkflow) {
    const error = new Error('Workflow draft must be an object');
    error.code = 'WORKFLOW_DRAFT_INVALID';
    throw error;
  }

  const now = new Date().toISOString();
  const draft = {
    ...sanitizeSnapshotValue(submittedWorkflow),
    enabled: false,
    createdByType: 'agent',
    createdByAgentId: run.agentId,
    createdByRunId: run.id,
    createdAt: now,
    updatedAt: now
  };

  const validationErrors = validateWorkflowDefinition(draft);
  if (workflowHasMutatingActions(draft) && (!Array.isArray(draft.postconditions) || draft.postconditions.length === 0)) {
    validationErrors.push('Agent-created workflows with mutating actions must include postconditions');
  }
  if (validationErrors.length > 0) {
    const error = new Error(`Workflow draft invalid: ${validationErrors.join('; ')}`);
    error.code = 'WORKFLOW_DRAFT_INVALID';
    error.details = { validationErrors };
    throw error;
  }
  if (getWorkflowById(draft.id)) {
    const error = new Error(`Workflow draft id already exists: ${draft.id}`);
    error.code = 'WORKFLOW_DRAFT_DUPLICATE';
    throw error;
  }

  const workflows = readWorkflows();
  workflows.push(draft);
  writeWorkflows(workflows);
  appendRunReplaySnapshotItem(run.id, 'workflowDrafts', {
    workflowId: draft.id,
    name: draft.name,
    enabled: false,
    createdByAgentId: run.agentId,
    createdByRunId: run.id,
    step
  });
  appendEvent({
    type: 'workflow.draft_created',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      workflowId: draft.id,
      name: draft.name,
      enabled: false,
      createdByType: 'agent',
      createdByAgentId: run.agentId,
      createdByRunId: run.id,
      createdAt: now
    }
  });
  appendRunLog(run, 'workflow:draft_created', `Workflow draft created: ${draft.name}`, null, {
    workflowId: draft.id,
    enabled: false
  });

  return { workflowId: draft.id, enabled: false, status: 'draft_created' };
}

function createWorkflowDraftFromIntent(run, intentInput, step = 0) {
  const compiled = compileWorkflowDraftIntent(intentInput);
  appendRunReplaySnapshotItem(run.id, 'workflowDraftIntents', {
    intent: compiled.intent,
    compiledWorkflowId: compiled.workflow.id,
    step
  });
  return createWorkflowDraftFromAgent(run, compiled.workflow, step);
}

function createHandoffTaskError(message, code = 'HANDOFF_TASK_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveHandoffExecutor(value) {
  const executorValue = typeof value === 'string' ? value.trim() : value;
  if (executorValue === null || executorValue === undefined || executorValue === '') {
    throw createHandoffTaskError('createHandoffTask executor is required');
  }

  const agents = readAgents();
  const numericId = Number(executorValue);
  const executor = Number.isInteger(numericId)
    ? agents.find(agent => agent.id === numericId)
    : agents.find(agent => String(agent.name || '').toLowerCase() === String(executorValue).toLowerCase());

  if (!executor) {
    throw createHandoffTaskError(`createHandoffTask executor not found: ${executorValue}`, 'HANDOFF_EXECUTOR_NOT_FOUND');
  }

  return executor;
}

function normalizeHandoffWritePath(value) {
  const pathValue = requireStringArg({ path: value }, 'path', { nonEmpty: true }).replace(/\\/g, '/').trim();
  if (path.isAbsolute(pathValue) || path.win32.isAbsolute(pathValue) || pathValue.startsWith('/')) {
    throw createHandoffTaskError('createHandoffTask args.path must be a relative workspace path', 'HANDOFF_PATH_INVALID');
  }

  const normalized = path.posix.normalize(pathValue);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || normalized.includes('/../')) {
    throw createHandoffTaskError('createHandoffTask args.path must not traverse outside the workspace', 'HANDOFF_PATH_INVALID');
  }

  assertAgentWorkspacePathAllowed(normalized);
  return normalized;
}

function validateHandoffTaskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw createHandoffTaskError('createHandoffTask args must be an object');
  }

  assertOnlyKeys(input, ['executor', 'operation', 'args'], 'createHandoffTask args');
  const executor = resolveHandoffExecutor(input.executor);
  if (input.operation !== 'writeFile') {
    throw createHandoffTaskError('createHandoffTask operation must be writeFile', 'HANDOFF_OPERATION_UNSUPPORTED');
  }
  if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
    throw createHandoffTaskError('createHandoffTask args.args must be an object');
  }
  assertOnlyKeys(input.args, ['path', 'content'], 'createHandoffTask args.args');

  return {
    executor,
    operation: 'writeFile',
    args: {
      path: normalizeHandoffWritePath(input.args.path),
      content: requireStringArg(input.args, 'content')
    }
  };
}

function executeHandoffTask(run, handoffInput, step = 0) {
  const validated = validateHandoffTaskInput(handoffInput);
  const planner = readAgents().find(agent => agent.id === run.agentId) || null;
  const executorRun = {
    ...run,
    agentId: validated.executor.id,
    agentName: validated.executor.name
  };
  const workspaceAction = {
    operation: 'writeFile',
    args: validated.args
  };
  const evidenceBase = {
    plannerAgentId: run.agentId,
    plannerAgentName: run.agentName || (planner ? planner.name : null),
    executorAgentId: validated.executor.id,
    executorAgentName: validated.executor.name,
    operation: validated.operation,
    args: sanitizeSnapshotValue(validated.args),
    step
  };

  appendRunReplaySnapshotItem(run.id, 'handoffTasks', {
    ...evidenceBase,
    status: 'validated'
  });
  appendEvent({
    type: 'handoff.task_validated',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: String(step),
    payload: evidenceBase
  });

  const result = executeWorkspaceOperation(executorRun, workspaceAction, step);
  const executionEvidence = {
    ...evidenceBase,
    status: 'executed',
    result: sanitizeSnapshotValue(result)
  };
  appendRunReplaySnapshotItem(run.id, 'handoffTasks', executionEvidence);
  appendEvent({
    type: 'handoff.task_executed',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: String(step),
    payload: executionEvidence
  });

  return {
    status: 'executed',
    executorAgentId: validated.executor.id,
    executorAgentName: validated.executor.name,
    operation: validated.operation,
    args: validated.args,
    result,
    historyId: result && result.historyId ? result.historyId : null
  };
}

function isWorkflowDraftObjective(objective) {
  const text = String(objective || '').toLowerCase();
  return /\b(workflow|draft)\b/.test(text) && /\b(create|draft|define|repair|workflow)\b/.test(text);
}

function hasSuccessfulWorkflowDraftAction(actionResults) {
  return (actionResults || []).some(item => {
    const operation = item && item.action ? item.action.operation : null;
    const result = item ? item.result : null;
    return (operation === 'createWorkflowDraft' || operation === 'createWorkflowDraftIntent') &&
      result &&
      result.status === 'draft_created' &&
      result.enabled === false &&
      typeof result.workflowId === 'string' &&
      result.workflowId.trim();
  });
}

function normalizeObjectivePathToken(value) {
  let token = String(value || '')
    .trim()
    .replace(/^["'`]+|["'`.,;:!?]+$/g, '')
    .replace(/\\/g, '/');
  while (token.startsWith('./')) token = token.slice(2);
  if (!token || token.startsWith('/') || token.includes('\0')) return null;
  let segments = token.split('/');
  if (segments.some(segment => segment === '..')) return null;
  if (segments[0] === 'workspace-root') {
    token = segments.slice(1).join('/');
    segments = token.split('/');
  }
  if (!token || token.startsWith('/') || segments.some(segment => segment === '..')) return null;
  return token;
}

function extractObjectivePathTokens(objective) {
  const text = String(objective || '');
  const tokens = new Set();
  const patterns = [
    /\b(?:file|note|summary|report)\s+(?:named|called)\s+([A-Za-z0-9._/-]+\.[A-Za-z0-9._-]+)/gi,
    /\b(?:write|create|update)\s+([A-Za-z0-9._/-]+\.[A-Za-z0-9._-]+)/gi,
    /\b([A-Za-z0-9._/-]+\.(?:md|txt|json|csv|yaml|yml|log|html|js|css))\b/gi
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const token = normalizeObjectivePathToken(match[1]);
      if (token) tokens.add(token);
    }
  });

  return Array.from(tokens);
}

function isDirectWorkspaceWriteObjective(objective) {
  const text = String(objective || '').toLowerCase();
  if (!text.trim()) return false;
  if (/\b(workflow|draft)\b/.test(text)) return false;
  if (/\b(read|list|inspect|review|check)\b/.test(text) && !/\b(write|create|update)\b/.test(text)) return false;
  if (/\bsuggest(?:ion|ions)?\b/.test(text) && !/\bwrite\b/.test(text)) return false;
  return /\b(write|create|update)\b/.test(text) &&
    (/\b(note|summary|report|file)\b/.test(text) || extractObjectivePathTokens(objective).length > 0);
}

// Compatibility wrappers (v0.1.31): report detection and report runtime-limit
// shaping now live in objective-contract.js. These delegate to that single source
// while preserving the historical signatures and return shapes exactly (boolean for
// isReportObjective; merged limits object for getReportRuntimeLimits).
function isReportObjective(objective) {
  return contractIsReportObjective(objective);
}

function getReportRuntimeLimits(baseLimits) {
  return contractGetReportRuntimeLimits(baseLimits);
}

// ── Workload profile detection ────────────────────────────────────

function detectWorkloadProfile(objective) {
  const text = String(objective || '').toLowerCase();

  if (/\b(diagnos|bug|failing test|incorrect assertion|test failure|which test|fix test|broken test)\b/.test(text)) {
    return 'diagnosis';
  }

  if (/\b(move|rename|restructur|refactor|reorganize|archive|consolidate)\b/.test(text)) {
    return 'refactor';
  }

  if (/\b(report|summary|synthesis|overview|analysis|status|audit)\b/.test(text)) {
    return 'report';
  }

  return null;
}

function getProfileRuntimeLimits(baseLimits, profileName) {
  const profile = WORKLOAD_PROFILES[profileName];
  if (!profile) return baseLimits;

  return {
    ...baseLimits,
    maxExecutionSteps: Math.min(baseLimits.maxExecutionSteps, profile.executionStepLimit),
    maxModelRequestsPerRun: Math.min(baseLimits.maxModelRequestsPerRun, profile.modelRequestLimit),
    maxWorkspaceOperationsPerRun: Math.min(baseLimits.maxWorkspaceOperationsPerRun, profile.maxWorkspaceOperations),
    maxListDirectoryPerRun: profile.maxListDirectory,
    maxReadFilePerRun: profile.maxReadFile,
    profileName: profile.name,
    profileDescription: profile.description
  };
}

function buildProfileGuidance(objective) {
  const profileName = detectWorkloadProfile(objective);
  if (!profileName) return [];

  const profile = WORKLOAD_PROFILES[profileName];
  if (!profile) return [];

  return [
    `This ticket matches the "${profile.name}" workload profile: ${profile.description}.`,
    `Use at most ${profile.maxListDirectory} listDirectory calls total. Use at most ${profile.maxReadFile} readFile calls total.`,
    ...profile.procedure
  ];
}

function hasViolationEvidence(runId) {
  return getRunEvents(runId).some(event => event.type === 'run.violation_detected' || event.type === 'authority.denied');
}

function hasSuccessfulObjectiveMutationEvidence(run, actionResults, objectivePaths) {
  const objectivePathSet = new Set((objectivePaths || []).map(normalizeObjectivePathToken).filter(Boolean));
  if (objectivePathSet.size === 0) return false;
  const successfulMutations = (actionResults || []).filter(item => {
    const action = item && item.action;
    const operation = action ? action.operation : null;
    const result = item ? item.result : null;
    return operation &&
      ['createFolder', 'writeFile', 'renamePath'].includes(operation) &&
      result &&
      !item.error;
  });

  if (successfulMutations.length === 0) return false;

  const historyRecords = getOperationHistoryForRun(run.id).filter(record =>
    record &&
    ['createFolder', 'writeFile', 'renamePath'].includes(record.operation) &&
    !record.error &&
    record.postState &&
    (record.postState.existed === true || (record.postState.destination && record.postState.destination.existed === true))
  );
  if (historyRecords.length === 0) return false;

  return historyRecords.some(record => {
    const candidates = [
      record.args && record.args.path,
      record.args && record.args.nextPath,
      record.result && record.result.path
    ].map(normalizeObjectivePathToken).filter(Boolean);
    return candidates.some(candidate => objectivePathSet.has(candidate));
  });
}

function isDirectWorkspaceObjectiveSatisfied(run, ticket, actionResults) {
  if (!run || !ticket) return false;
  if (!isDirectWorkspaceWriteObjective(ticket.objective)) return false;
  if (hasViolationEvidence(run.id)) return false;
  return hasSuccessfulObjectiveMutationEvidence(run, actionResults, extractObjectivePathTokens(ticket.objective));
}

function isUnsupportedObjectiveModelPlan(modelPlan) {
  if (!modelPlan || modelPlan.complete !== false) return false;
  if (Array.isArray(modelPlan.actions) && modelPlan.actions.length > 0) return false;
  const message = typeof modelPlan.message === 'string' ? modelPlan.message.trim() : '';
  if (!message) return false;
  return /\b(unsupported|unavailable|not available|cannot be completed|can't be completed|cannot be represented|can't be represented|not supported)\b/i.test(message) &&
    /\b(allowed operations|normal agents?|workflow drafts?|branching|conditional|createWorkflowDraftIntent|operation|operations)\b/i.test(message);
}

function executeWorkspaceOperation(run, action, step = 0) {
  const { operation, args } = parseWorkspaceOperation(action);
  const runWorkspaceProvider = getRunWorkspaceProvider(run);
  let result;

  if (operation === 'listDirectory') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.listDirectory, 'listDirectory args');
    const pathValue = requireStringArg(args, 'path');
    assertAgentWorkspacePathAllowed(pathValue);
    try {
      result = runWorkspaceProvider.list(pathValue);
    } catch (error) {
      if (error.code === 'ENOENT') {
        result = { status: 'not_found', path: pathValue, entries: [] };
      } else if (!error.failureKind) {
        throw createStructuredWorkspaceError(
          error.message,
          'WORKSPACE_PATH_TYPE_CONFLICT',
          'workspace_error',
          {
            operation: 'listDirectory',
            path: pathValue,
            fsCode: error.code || null
          }
        );
      } else {
        throw error;
      }
    }
    const logMessage = result.status === 'not_found'
      ? `Ran listDirectory on ${pathValue || '/'} (not_found)`
      : `Ran listDirectory on ${pathValue || '/'}`;
    appendRunLog(run, 'workspace:list', logMessage, {
      operation,
      args: { path: pathValue },
      ...(result.status === 'not_found' ? { status: result.status } : {}),
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return result;
  }

  if (operation === 'readFile') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.readFile, 'readFile args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    assertAgentWorkspacePathAllowed(pathValue);
    result = { path: pathValue, content: runWorkspaceProvider.readFile(pathValue) };
    appendRunLog(run, 'workspace:read', `Ran readFile on ${pathValue}`, {
      operation,
      args: { path: pathValue },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return result;
  }

  if (operation === 'createFolder') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.createFolder, 'createFolder args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    checkWorkspaceMutationAuthority(run, operation, { path: pathValue });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);

    // Skip if already committed in this run's ledger
    const committed = findCommittedMutation(run.id, operation, args);
    if (committed && committed.result) {
      appendRunLog(run, 'workspace:create', `Skipped createFolder on ${pathValue} (already committed in run ledger)`, {
        operation,
        args: { path: pathValue },
        status: 'already_exists_noop',
        kind: 'folder',
        ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
      });
      return { path: pathValue, status: 'already_exists_noop', historyId: committed.id, skipped: true };
    }

    // Reject if a different mutation already committed on the same path
    const conflict = findConflictingMutation(run.id, operation, args);
    if (conflict) {
      const error = new Error(`Conflicting mutation already committed on ${pathValue}: ${conflict.operation} (historyId: ${conflict.id})`);
      error.code = 'MUTATION_CONFLICT';
      throw error;
    }

    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.createFolder(pathValue);
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    const message = result.status === 'already_exists_noop'
      ? `Ran createFolder on ${result.path} (already exists, no-op)`
      : `Ran createFolder on ${result.path}`;
    appendRunLog(run, 'workspace:create', message, {
      operation,
      args: { path: result.path },
      status: result.status,
      kind: 'folder',
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'writeFile') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.writeFile, 'writeFile args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    const content = requireStringArg(args, 'content');
    checkWorkspaceMutationAuthority(run, operation, { path: pathValue, content });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    if (runWorkspaceProvider.exists(pathValue, { allowHidden: true })) {
      blockProtectedWorkspaceOperation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    }
    assertAgentWorkspacePathAllowed(pathValue);

    // Skip if already committed in this run's ledger
    const committed = findCommittedMutation(run.id, operation, args);
    if (committed && committed.result) {
      appendRunLog(run, 'workspace:write', `Skipped writeFile on ${pathValue} (already committed in run ledger)`, {
        operation,
        args: { path: pathValue },
        status: 'skipped_already_committed',
        ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
      });
      return { ...committed.result, size: committed.result.size || 0, historyId: committed.id, skipped: true };
    }

    // Reject if a different mutation already committed on the same path
    const conflict = findConflictingMutation(run.id, operation, args);
    if (conflict) {
      const error = new Error(`Conflicting mutation already committed on ${pathValue}: ${conflict.operation} (historyId: ${conflict.id})`);
      error.code = 'MUTATION_CONFLICT';
      throw error;
    }

    const priorOwner = findPriorSuccessfulArtifactOwner(readOperationHistory(), run, pathValue);
    if (priorOwner) {
      const error = new Error(`Workspace write conflict: path was previously produced by ticket ${priorOwner.ticketId}, run ${priorOwner.runId}`);
      error.code = 'WORKSPACE_WRITE_CONFLICT';
      error.failureKind = 'invalid_action';
      error.workspaceAction = {
        operation,
        args: { path: pathValue, content },
        path: pathValue,
        blocked: true,
        reason: 'prior_artifact_owner',
        conflictingTicketId: priorOwner.ticketId,
        conflictingRunId: priorOwner.runId,
        conflictingHistoryId: priorOwner.id || null
      };
      throw error;
    }

    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.writeFile(pathValue, content);
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    appendRunLog(run, 'workspace:write', `Ran writeFile on ${result.path}`, {
      operation,
      args: { path: result.path },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, size: Buffer.byteLength(content, 'utf8'), historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'renamePath') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.renamePath, 'renamePath args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    const nextPath = requireStringArg(args, 'nextPath', { nonEmpty: true });
    checkWorkspaceMutationAuthority(run, operation, { path: pathValue, nextPath });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, pathValue, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue, nextPath }, nextPath, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);
    assertAgentWorkspacePathAllowed(nextPath);

    // Skip if already committed in this run's ledger
    const committed = findCommittedMutation(run.id, operation, args);
    if (committed && committed.result) {
      appendRunLog(run, 'workspace:rename', `Skipped renamePath from ${pathValue} to ${nextPath} (already committed in run ledger)`, {
        operation,
        args: { path: pathValue, nextPath },
        status: 'already_committed_noop',
        ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
      });
      return { ...committed.result, status: committed.result.status || 'renamed', historyId: committed.id, skipped: true };
    }

    // Reject if a different mutation already committed on the same path
    const conflict = findConflictingMutation(run.id, operation, args);
    if (conflict) {
      const error = new Error(`Conflicting mutation already committed on ${pathValue}: ${conflict.operation} (historyId: ${conflict.id})`);
      error.code = 'MUTATION_CONFLICT';
      throw error;
    }

    // Reject if either the source (or anything below it) or the destination
    // overlaps an artifact another ticket produced — a rename must not move away
    // or clobber another ticket's output.
    assertNoCrossTicketOverlap(run, operation, { path: pathValue, nextPath }, pathValue);
    assertNoCrossTicketOverlap(run, operation, { path: pathValue, nextPath }, nextPath);

    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = { ...runWorkspaceProvider.rename(pathValue, nextPath), status: 'renamed' };
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    appendRunLog(run, 'workspace:rename', `Ran renamePath from ${pathValue} to ${result.path}`, {
      operation,
      args: { path: pathValue, nextPath: result.path },
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  if (operation === 'deletePath') {
    assertOnlyKeys(args, AGENT_OPERATION_ARGS.deletePath, 'deletePath args');
    const pathValue = requireStringArg(args, 'path', { nonEmpty: true });
    checkWorkspaceMutationAuthority(run, operation, { path: pathValue });
    assertAllocatedOwnershipAllowsMutation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    blockProtectedWorkspaceOperation(run, operation, { path: pathValue }, pathValue, runWorkspaceProvider);
    assertAgentWorkspacePathAllowed(pathValue);

    // Skip if already committed in this run's ledger
    const committed = findCommittedMutation(run.id, operation, args);
    if (committed && committed.result) {
      appendRunLog(run, 'workspace:delete', `Skipped deletePath on ${pathValue} (already committed in run ledger)`, {
        operation,
        args: { path: pathValue },
        status: 'already_committed_noop',
        ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
      });
      return { ...committed.result, historyId: committed.id, skipped: true };
    }

    // Reject if a different mutation already committed on the same path
    const conflict = findConflictingMutation(run.id, operation, args);
    if (conflict) {
      const error = new Error(`Conflicting mutation already committed on ${pathValue}: ${conflict.operation} (historyId: ${conflict.id})`);
      error.code = 'MUTATION_CONFLICT';
      throw error;
    }

    // Reject if the path (or anything below it) holds an artifact another ticket
    // produced — a destructive delete must not remove another ticket's output.
    assertNoCrossTicketOverlap(run, operation, { path: pathValue }, pathValue);

    const preState = captureWorkspacePreState(runWorkspaceProvider, operation, args);
    let historyRecord = null;
    try {
      result = runWorkspaceProvider.delete(pathValue);
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, result, null);
    } catch (error) {
      const postState = captureWorkspacePostState(runWorkspaceProvider, operation, args);
      historyRecord = persistWorkspaceOperationHistory(run, step, operation, args, preState, postState, null, error);
      if (historyRecord) error.historyId = historyRecord.id;
      throw error;
    }
    const logMessage = result.status === 'already_missing_noop'
      ? `Ran deletePath on ${result.path} (already missing, no-op)`
      : `Ran deletePath on ${result.path}`;
    appendRunLog(run, 'workspace:delete', logMessage, {
      operation,
      args: { path: result.path },
      status: result.status,
      ...buildWorkspaceActionMetadata(run, runWorkspaceProvider)
    });
    return { ...result, historyId: historyRecord ? historyRecord.id : null };
  }

  throw new Error(`Unsupported workspace operation: ${operation}`);
}

// ── Deterministic runtime verification ────────────────────────────
// After executing a bounded operation batch, the runtime verifies structural
// properties without re-entering the model. Only semantic ambiguity requires
// model re-entry.

function verifyBatchOperation(run, action, result) {
  const runWorkspaceProvider = getRunWorkspaceProvider(run);
  const operation = action && action.operation;
  const args = action && action.args ? action.args : {};
  const checks = [];

  if (operation === 'renamePath') {
    // Source should no longer exist; destination should exist
    const sourceExists = runWorkspaceProvider.exists(args.path, { allowHidden: true });
    const destExists = runWorkspaceProvider.exists(args.nextPath, { allowHidden: true });
    if (sourceExists) {
      checks.push({ check: 'source_still_exists', path: args.path, severity: 'warning' });
    }
    if (!destExists) {
      checks.push({ check: 'destination_missing', path: args.nextPath, severity: 'error' });
    } else {
      // Direct preservation check: destination must match source pre-state type and contentHash.
      // ContentHash is only evaluated when type matches, because contentHash comparison
      // is undefined for non-file destinations (getPathInfo returns undefined contentHash
      // for directories, and comparing undefined to a hash string would be a false positive).
      const histories = readOperationHistory();
      const record = histories.find(h => h.id === result.historyId);
      if (record && record.preState && record.preState.source && record.postState && record.postState.destination) {
        const destInfo = runWorkspaceProvider.getPathInfo(args.nextPath);
        if (record.preState.source.type && destInfo.type !== record.preState.source.type) {
          checks.push({ check: 'destination_type_mismatch', path: args.nextPath, severity: 'error', expected: record.preState.source.type, actual: destInfo.type });
        } else if (record.preState.source.contentHash && destInfo.contentHash !== record.preState.source.contentHash) {
          checks.push({ check: 'destination_content_mismatch', path: args.nextPath, severity: 'error' });
        }
      }
    }
  }

  if (operation === 'createFolder') {
    const folderExists = runWorkspaceProvider.exists(args.path, { allowHidden: true });
    if (!folderExists) {
      checks.push({ check: 'folder_missing', path: args.path, severity: 'error' });
    }
  }

  if (operation === 'writeFile') {
    const fileExists = runWorkspaceProvider.exists(args.path, { allowHidden: true });
    if (!fileExists) {
      checks.push({ check: 'file_missing', path: args.path, severity: 'error' });
    } else {
      // Verify content hash matches expected
      const actualContent = runWorkspaceProvider.readFile(args.path);
      const actualHash = hashContent(actualContent);
      const expectedHash = hashContent(args.content);
      if (actualHash !== expectedHash) {
        checks.push({ check: 'content_mismatch', path: args.path, severity: 'error' });
      }
    }
  }

  if (operation === 'deletePath') {
    const pathExists = runWorkspaceProvider.exists(args.path, { allowHidden: true });
    if (pathExists) {
      checks.push({ check: 'path_still_exists', path: args.path, severity: 'error' });
    }
  }

  if (checks.length > 0) {
    appendEvent({
      type: 'batch.verification_failed',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        operation,
        path: args.path,
        nextPath: args.nextPath || null,
        checks,
        result: sanitizeSnapshotValue(result)
      }
    });
    recordRunEvent(run, 'batch:verification_failed', `Batch verification failed for ${operation}`, {
      operation,
      checks
    });
  }

  return checks.length === 0;
}

function resolveWorkflowReference(expression, context) {
  const parts = String(expression).trim().split('.');
  let value = context;

  for (const part of parts) {
    if (!value || typeof value !== 'object' || !(part in value)) return undefined;
    value = value[part];
  }

  return value;
}

function resolveWorkflowInputTemplates(value, context) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return resolveWorkflowReference(exact[1], context);

    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expression) => {
      const resolved = resolveWorkflowReference(expression, context);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveWorkflowInputTemplates(item, context));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      resolveWorkflowInputTemplates(item, context)
    ]));
  }

  return value;
}

function evaluateConditionAction(input, step) {
  let matched;

  if (Object.prototype.hasOwnProperty.call(input, 'exists')) {
    const exists = input.value !== undefined && input.value !== null && input.value !== '';
    matched = Boolean(input.exists) === exists;
  } else {
    matched = JSON.stringify(input.value) === JSON.stringify(input.equals);
  }

  return {
    matched,
    next: matched ? (step.trueNext || step.next || 'stop') : (step.falseNext || 'stop')
  };
}

async function executeAgentStructuredOutputAction(run, agent, input, counters, startedAtMs, limits) {
  assertRunModelRequestAllowed(run, counters.modelRequests, limits);
  const requestStartedAt = Date.now();
  const messages = [
    {
      role: 'system',
      content: [
        'Return only JSON that conforms to the requested output schema.',
        'Do not request workspace actions. Do not include markdown.'
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        instruction: input.instruction,
        input: input.input || {},
        outputSchema: input.outputSchema || {}
      })
    }
  ];

  counters.modelRequests += 1;
  const modelResponse = await callModelProviderWithRunTimeout(run, agent, messages, startedAtMs, limits, {
    onRequest: requestPayload => {
      appendRunReplaySnapshotItem(run.id, 'providerRequests', {
        ...requestPayload,
        startedAt: new Date(requestStartedAt).toISOString(),
        durationMs: Date.now() - requestStartedAt,
        workflowAction: 'agentStructuredOutput'
      });
    }
  });
  const completedAt = Date.now();
  let output;

  try {
    output = JSON.parse(modelResponse.text);
  } catch (error) {
    const parseError = new Error(`agentStructuredOutput returned invalid JSON: ${error.message}`);
    parseError.code = 'MODEL_MALFORMED_JSON';
    parseError.failureKind = 'invalid_action';
    throw parseError;
  }

  const schemaErrors = validateSchemaValue(input.outputSchema || {}, output, 'agentStructuredOutput.output');
  if (schemaErrors.length > 0) {
    const schemaError = new Error(`agentStructuredOutput output failed schema validation: ${schemaErrors.join('; ')}`);
    schemaError.code = 'WORKFLOW_ACTION_OUTPUT_INVALID';
    schemaError.failureKind = 'invalid_action';
    schemaError.details = { schemaErrors };
    throw schemaError;
  }

  appendRunReplaySnapshotItem(run.id, 'modelResponses', {
    text: modelResponse.text,
    usage: modelResponse.usage || null,
    provider: modelResponse.provider || null,
    model: modelResponse.model || null,
    providerResponsePayload: modelResponse.responsePayload,
    startedAt: new Date(requestStartedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    durationMs: completedAt - requestStartedAt,
    workflowAction: 'agentStructuredOutput'
  });

  return {
    output,
    text: modelResponse.text,
    usage: modelResponse.usage || {},
    provider: modelResponse.provider || null,
    model: modelResponse.model || null
  };
}

const EXECUTE_ACTION_PLAN_ALLOWED_OPERATIONS = new Set(['createFolder', 'renamePath']);

function normalizeActionPlanReason(reason) {
  return typeof reason === 'string' ? reason : '';
}

function buildRejectedPlanAction(action, index, reasons) {
  return {
    index,
    operation: action && typeof action.operation === 'string' ? action.operation : null,
    args: action && action.args && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : null,
    reason: normalizeActionPlanReason(action && action.reason),
    validationReasons: reasons
  };
}

function validateActionPlanInput(input, limits, counters) {
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const allowedOperations = Array.isArray(input.allowedOperations)
    ? input.allowedOperations.filter(item => typeof item === 'string')
    : [];
  const maxActions = Number.isInteger(input.maxActions) && input.maxActions >= 0 ? input.maxActions : 0;
  const maxMutations = Number.isInteger(input.maxMutations) && input.maxMutations >= 0 ? input.maxMutations : 0;
  const allowedSet = new Set(allowedOperations);
  const proposedActions = actions.map((action, index) => ({
    index,
    operation: action && typeof action.operation === 'string' ? action.operation : null,
    args: action && action.args && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : null,
    reason: normalizeActionPlanReason(action && action.reason)
  }));
  const acceptedActions = [];
  const rejectedActions = [];
  let acceptedMutations = 0;

  if (!Array.isArray(input.actions)) {
    return {
      proposedActions,
      acceptedActions,
      rejectedActions: [buildRejectedPlanAction(null, null, ['executeActionPlan.actions must be an array'])]
    };
  }

  if (actions.length > maxActions) {
    return {
      proposedActions,
      acceptedActions,
      rejectedActions: proposedActions.map(action => ({
        ...action,
        validationReasons: ['plan length ' + actions.length + ' exceeds maxActions ' + maxActions]
      }))
    };
  }

  actions.forEach((action, index) => {
    const reasons = [];
    const operation = action && typeof action.operation === 'string' ? action.operation : null;
    const args = action && action.args && typeof action.args === 'object' && !Array.isArray(action.args) ? action.args : null;
    const reason = normalizeActionPlanReason(action && action.reason);
    const contract = operation ? getActionContract(operation) : null;

    if (!operation) reasons.push('operation is required');
    if (!args) reasons.push('args must be an object');
    if (operation && !allowedSet.has(operation)) reasons.push('operation ' + operation + ' is not in allowedOperations');
    if (operation && !EXECUTE_ACTION_PLAN_ALLOWED_OPERATIONS.has(operation)) reasons.push('operation ' + operation + ' is not supported by executeActionPlan');
    if (operation && !contract) reasons.push('unknown action: ' + operation);
    if (contract && !isWorkflowUsableAction(contract)) reasons.push('operation ' + operation + ' is not workflow-usable');
    if (contract && contract.type !== 'workspaceAction') reasons.push('operation ' + operation + ' is not a workspace action');
    if (contract && args) {
      reasons.push(...validateActionInput(operation, args).map(error => 'schema: ' + error));
    }

    const isMutating = contract && contract.mutating === true;
    if (isMutating) {
      if (acceptedMutations + 1 > maxMutations) reasons.push('plan mutation count exceeds maxMutations ' + maxMutations);
      if (counters.mutations + acceptedMutations + 1 > limits.maxMutations) reasons.push('workflow mutation budget exceeded: ' + limits.maxMutations);
    }

    if (reasons.length > 0) {
      rejectedActions.push(buildRejectedPlanAction(action, index, reasons));
      return;
    }

    if (isMutating) acceptedMutations += 1;
    acceptedActions.push({ index, operation, args, reason });
  });

  return { proposedActions, acceptedActions, rejectedActions };
}

function appendWorkflowPlanWorkspaceEvidence(run, workflow, step, action, result, startedAt, counters) {
  appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
    operation: { operation: action.operation, args: action.args, reason: action.reason || null },
    result,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    historyId: result && result.historyId ? result.historyId : null,
    workspaceRoot: getRunWorkspaceProvider(run).root,
    executionWorkspaceType: run.executionWorkspaceType || 'main',
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null,
    ownedOutputPaths: getRunOwnedOutputPaths(run),
    workflowId: workflow.id,
    workflowStepId: step.id,
    actionPlanIndex: action.index
  });
  appendEvent({
    type: 'workspace.operation',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: step.id,
    payload: {
      workflowId: workflow.id,
      operation: action.operation,
      path: action.args && action.args.path ? action.args.path : null,
      mutating: true,
      input: sanitizeSnapshotValue(action.args),
      result: sanitizeSnapshotValue(result),
      actionPlanIndex: action.index,
      reason: action.reason || null
    }
  });
  counters.workspaceOperations += 1;
  counters.mutations += 1;
}

async function executeActionPlanWorkflowAction(run, workflow, step, input, counters, limits) {
  const startedAt = Date.now();
  const validation = validateActionPlanInput(input, limits, counters);
  const executedActions = [];

  for (const action of validation.acceptedActions) {
    assertRunWorkspaceOperationAllowed(run, counters.workspaceOperations, 1, limits);
    const actionStartedAt = Date.now();
    const result = executeWorkspaceOperation(run, { operation: action.operation, args: action.args }, counters.transitions);
    appendWorkflowPlanWorkspaceEvidence(run, workflow, step, action, result, actionStartedAt, counters);
    executedActions.push({
      index: action.index,
      operation: action.operation,
      args: action.args,
      reason: action.reason || null,
      result
    });
  }

  const result = {
    proposedActions: validation.proposedActions,
    acceptedActions: validation.acceptedActions,
    rejectedActions: validation.rejectedActions,
    executedActions,
    status: validation.rejectedActions.length > 0 ? 'partial' : 'executed'
  };

  appendRunReplaySnapshotItem(run.id, 'workflowActionPlans', {
    workflowId: workflow.id,
    stepId: step.id,
    proposedActions: sanitizeSnapshotValue(validation.proposedActions),
    acceptedActions: sanitizeSnapshotValue(validation.acceptedActions),
    rejectedActions: sanitizeSnapshotValue(validation.rejectedActions),
    executedActions: sanitizeSnapshotValue(executedActions),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt
  });

  return result;
}


function normalizeTicketPlanReason(reason) {
  return typeof reason === 'string' ? reason : '';
}

function getTicketPlanVendorId(ticket) {
  const input = ticket && ticket.workflowInput && typeof ticket.workflowInput === 'object' && !Array.isArray(ticket.workflowInput)
    ? ticket.workflowInput
    : {};
  const vendorId = input.vendorId;
  return typeof vendorId === 'string' && vendorId.trim() ? vendorId.trim() : null;
}

function buildTicketPlanIdempotencyKey(run, ticket) {
  const vendorId = getTicketPlanVendorId(ticket) || 'no-vendor';
  return [run.ticketId, ticket.workflowId || 'no-workflow', vendorId].join(':');
}

function normalizeProposedTicketPlanItem(ticket, index) {
  const workflowInput = ticket && ticket.workflowInput && typeof ticket.workflowInput === 'object' && !Array.isArray(ticket.workflowInput)
    ? ticket.workflowInput
    : null;
  return {
    index,
    workflowId: ticket && typeof ticket.workflowId === 'string' ? ticket.workflowId : null,
    objective: ticket && typeof ticket.objective === 'string' ? ticket.objective : '',
    workflowInput,
    reason: normalizeTicketPlanReason(ticket && ticket.reason)
  };
}

function buildRejectedTicketPlanItem(ticket, index, reasons) {
  return {
    ...normalizeProposedTicketPlanItem(ticket, index),
    validationReasons: reasons
  };
}

function workflowContainsTicketPlanAction(workflow) {
  return Boolean(workflow && Array.isArray(workflow.actions) && workflow.actions.some(step => step && step.action === 'executeTicketPlan'));
}

function validateTicketPlanInput(run, input) {
  const tickets = Array.isArray(input.tickets) ? input.tickets : [];
  const allowedWorkflowIds = Array.isArray(input.allowedWorkflowIds)
    ? input.allowedWorkflowIds.filter(item => typeof item === 'string')
    : [];
  const allowedSet = new Set(allowedWorkflowIds);
  const maxTickets = Number.isInteger(input.maxTickets) && input.maxTickets >= 0 ? input.maxTickets : 0;
  const proposedTickets = tickets.map((ticket, index) => normalizeProposedTicketPlanItem(ticket, index));
  const acceptedTickets = [];
  const rejectedTickets = [];

  if (!Array.isArray(input.tickets)) {
    return {
      proposedTickets,
      acceptedTickets,
      rejectedTickets: [buildRejectedTicketPlanItem(null, null, ['executeTicketPlan.tickets must be an array'])]
    };
  }

  if (tickets.length > maxTickets) {
    return {
      proposedTickets,
      acceptedTickets,
      rejectedTickets: proposedTickets.map(ticket => ({
        ...ticket,
        validationReasons: ['ticket plan length ' + tickets.length + ' exceeds maxTickets ' + maxTickets]
      }))
    };
  }

  const existingTickets = readTickets();
  const seenKeys = new Set();

  tickets.forEach((ticket, index) => {
    const reasons = [];
    const proposed = normalizeProposedTicketPlanItem(ticket, index);
    const workflowId = proposed.workflowId;
    const workflow = workflowId ? getWorkflowById(workflowId) : null;
    const objective = typeof proposed.objective === 'string' ? proposed.objective.trim() : '';
    const workflowInput = proposed.workflowInput;

    if (!workflowId) reasons.push('workflowId is required');
    if (workflowId && !allowedSet.has(workflowId)) reasons.push('workflowId ' + workflowId + ' is not in allowedWorkflowIds');
    if (workflowId && !workflow) reasons.push('workflow not found: ' + workflowId);
    if (workflow && workflow.enabled === false) reasons.push('workflow is disabled: ' + workflowId);
    if (workflow && workflowContainsTicketPlanAction(workflow)) reasons.push('recursive executeTicketPlan child workflows are not allowed in v1');
    if (!workflowInput) reasons.push('workflowInput must be an object');
    if (workflow && workflowInput) {
      reasons.push(...validateSchemaValue(workflow.inputSchema || {}, workflowInput, 'workflowInput').map(error => 'schema: ' + error));
    }
    if (!objective) reasons.push('objective is required');
    if (objective.length > 240) reasons.push('objective exceeds 240 characters');

    const idempotencyKey = buildTicketPlanIdempotencyKey(run, proposed);
    if (seenKeys.has(idempotencyKey)) reasons.push('duplicate ticket plan item: ' + idempotencyKey);
    if (existingTickets.some(item => item && item.spawnIdempotencyKey === idempotencyKey)) reasons.push('duplicate child ticket already exists: ' + idempotencyKey);

    if (reasons.length > 0) {
      rejectedTickets.push({ ...proposed, idempotencyKey, validationReasons: reasons });
      return;
    }

    seenKeys.add(idempotencyKey);
    acceptedTickets.push({ ...proposed, objective, workflowInput, idempotencyKey });
  });

  return { proposedTickets, acceptedTickets, rejectedTickets };
}

function createChildWorkflowTicketFromPlan(run, workflow, step, planTicket, spawnPlanId) {
  const tickets = readTickets();
  const existing = tickets.find(ticket => ticket && ticket.spawnIdempotencyKey === planTicket.idempotencyKey);
  if (existing) return existing;

  const now = new Date().toISOString();
  const childTicket = {
    id: nextId(tickets),
    objective: planTicket.objective,
    status: 'blocked',
    blockedReason: 'Created by executeTicketPlan; child workflow execution is not automatic in v1.',
    assignmentTargetType: 'agent',
    assignmentTargetId: run.agentId,
    assignmentMode: 'individual',
    executionMode: 'workflow',
    workflowId: planTicket.workflowId,
    workflowInput: planTicket.workflowInput,
    capabilityType: 'workflow',
    capabilityId: planTicket.workflowId,
    capabilityInput: planTicket.workflowInput,
    executionPolicy: normalizeExecutionPolicy(null, 'shared'),
    parentTicketId: run.ticketId,
    parentRunId: run.id,
    parentWorkflowId: workflow.id,
    spawnedByStepId: step.id,
    spawnPlanId,
    spawnIdempotencyKey: planTicket.idempotencyKey,
    spawnReason: planTicket.reason || null,
    createdBy: 'workflow:' + workflow.id,
    createdAt: now,
    updatedAt: now
  };

  tickets.push(childTicket);
  writeTickets(tickets);
  appendEvent({
    type: 'ticket.created',
    ticketId: childTicket.id,
    runId: run.id,
    payload: {
      objective: childTicket.objective,
      assignmentTargetType: childTicket.assignmentTargetType,
      assignmentTargetId: childTicket.assignmentTargetId,
      assignmentMode: childTicket.assignmentMode,
      executionMode: childTicket.executionMode,
      workflowId: childTicket.workflowId,
      blockedReason: childTicket.blockedReason || null,
      parentTicketId: childTicket.parentTicketId,
      parentRunId: childTicket.parentRunId,
      parentWorkflowId: childTicket.parentWorkflowId,
      spawnedByStepId: childTicket.spawnedByStepId,
      spawnPlanId: childTicket.spawnPlanId,
      spawnIdempotencyKey: childTicket.spawnIdempotencyKey,
      createdBy: childTicket.createdBy,
      createdAt: childTicket.createdAt
    }
  });
  broadcastTicketChange();
  return childTicket;
}

async function executeTicketPlanWorkflowAction(run, workflow, step, input) {
  const startedAt = Date.now();
  const spawnPlanId = [run.id, workflow.id, step.id, startedAt].join(':');
  const validation = validateTicketPlanInput(run, input);
  const createdTickets = [];

  for (const ticket of validation.acceptedTickets) {
    const childTicket = createChildWorkflowTicketFromPlan(run, workflow, step, ticket, spawnPlanId);
    createdTickets.push({
      index: ticket.index,
      ticketId: childTicket.id,
      workflowId: childTicket.workflowId,
      objective: childTicket.objective,
      workflowInput: childTicket.workflowInput,
      idempotencyKey: childTicket.spawnIdempotencyKey
    });
  }

  const result = {
    proposedTickets: validation.proposedTickets,
    acceptedTickets: validation.acceptedTickets,
    rejectedTickets: validation.rejectedTickets,
    createdTicketIds: createdTickets.map(ticket => ticket.ticketId),
    status: validation.rejectedTickets.length > 0 ? 'partial' : 'created'
  };

  appendRunReplaySnapshotItem(run.id, 'workflowTicketPlans', {
    workflowId: workflow.id,
    stepId: step.id,
    spawnPlanId,
    proposedTickets: sanitizeSnapshotValue(validation.proposedTickets),
    acceptedTickets: sanitizeSnapshotValue(validation.acceptedTickets),
    rejectedTickets: sanitizeSnapshotValue(validation.rejectedTickets),
    createdTickets: sanitizeSnapshotValue(createdTickets),
    createdTicketIds: createdTickets.map(ticket => ticket.ticketId),
    validationReasons: sanitizeSnapshotValue(validation.rejectedTickets.flatMap(ticket => ticket.validationReasons || [])),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt
  });

  appendEvent({
    type: 'workflow.ticket_plan.executed',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: step.id,
    payload: {
      workflowId: workflow.id,
      spawnPlanId,
      proposedCount: validation.proposedTickets.length,
      acceptedCount: validation.acceptedTickets.length,
      rejectedCount: validation.rejectedTickets.length,
      createdTicketIds: createdTickets.map(ticket => ticket.ticketId)
    }
  });

  return result;
}

async function executeWorkflowAction(run, workflow, step, input, context, counters, startedAtMs, limits, agent) {
  const contract = getActionContract(step.action);
  if (!contract) throw new Error(`Unknown workflow action: ${step.action}`);

  const startedAt = Date.now();
  let result;
  appendEvent({
    type: 'workflow.step.started',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: step.id,
    payload: {
      workflowId: workflow.id,
      action: step.action,
      input: sanitizeSnapshotValue(input)
    }
  });

  try {
    const inputErrors = validateActionInput(step.action, input);
    if (inputErrors.length > 0) {
      const error = new Error(`Workflow action input failed schema validation: ${inputErrors.join('; ')}`);
      error.code = 'WORKFLOW_ACTION_INPUT_INVALID';
      error.failureKind = 'invalid_action';
      error.details = { workflowId: workflow.id, stepId: step.id, inputErrors };
      throw error;
    }

    if (contract.type === 'workspaceAction') {
      assertRunWorkspaceOperationAllowed(run, counters.workspaceOperations, 1, limits);
      result = executeWorkspaceOperation(run, { operation: step.action, args: input }, counters.transitions);
      counters.workspaceOperations += 1;
      if (contract.mutating) counters.mutations += 1;
      appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
        operation: { operation: step.action, args: input },
        result,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        historyId: result && result.historyId ? result.historyId : null,
        workspaceRoot: getRunWorkspaceProvider(run).root,
        executionWorkspaceType: run.executionWorkspaceType || 'main',
        allocationPlanId: run.allocationPlanId || null,
        allocationItemId: run.allocationItemId || null,
        ownedOutputPaths: getRunOwnedOutputPaths(run),
        workflowId: workflow.id,
        workflowStepId: step.id
      });
      appendEvent({
        type: 'workspace.operation',
        ticketId: run.ticketId,
        runId: run.id,
        stepId: step.id,
        payload: {
          workflowId: workflow.id,
          operation: step.action,
          path: input.path || null,
          mutating: contract.mutating === true,
          input: sanitizeSnapshotValue(input),
          result: sanitizeSnapshotValue(result)
        }
      });
    } else if (step.action === 'executeActionPlan') {
      result = await executeActionPlanWorkflowAction(run, workflow, step, input, counters, limits);
    } else if (step.action === 'executeTicketPlan') {
      result = await executeTicketPlanWorkflowAction(run, workflow, step, input);
    } else if (step.action === 'agentStructuredOutput') {
      result = await executeAgentStructuredOutputAction(run, agent, input, counters, startedAtMs, limits);
    } else if (step.action === 'condition') {
      result = evaluateConditionAction(input, step);
    } else if (step.action === 'stop') {
      result = { stopped: true, result: input.result || context };
    } else {
      const error = new Error(`Action ${step.action} is not executable inside workflows`);
      error.code = 'WORKFLOW_ACTION_NOT_ALLOWED';
      error.failureKind = 'invalid_action';
      throw error;
    }

    const outputErrors = validateSchemaValue(contract.outputSchema, result || {}, `${step.action}.output`);
    if (outputErrors.length > 0) {
      const error = new Error(`Workflow action output failed schema validation: ${outputErrors.join('; ')}`);
      error.code = 'WORKFLOW_ACTION_OUTPUT_INVALID';
      error.failureKind = 'invalid_action';
      error.details = { workflowId: workflow.id, stepId: step.id, outputErrors };
      throw error;
    }

    appendRunReplaySnapshotItem(run.id, 'workflowActions', {
      workflowId: workflow.id,
      stepId: step.id,
      action: step.action,
      input: sanitizeSnapshotValue(input),
      result: sanitizeSnapshotValue(result),
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt
    });
    appendEvent({
      type: 'workflow.step.completed',
      ticketId: run.ticketId,
      runId: run.id,
      stepId: step.id,
      payload: {
        workflowId: workflow.id,
        action: step.action,
        durationMs: Date.now() - startedAt,
        result: sanitizeSnapshotValue(result)
      }
    });

    return result;
  } catch (error) {
    if (contract && contract.type === 'workspaceAction') {
      appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
        operation: error.workspaceAction || { operation: step.action, args: input },
        error: error.message,
        blocked: error.failureKind === 'protected_path' || ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION'].includes(error.code),
        reason: error.reason || null,
        durationMs: Date.now() - startedAt,
        historyId: error.historyId || null,
        ownedOutputPaths: error.ownedOutputPaths || getRunOwnedOutputPaths(run),
        workspaceRoot: getRunWorkspaceProvider(run).root,
        executionWorkspaceType: run.executionWorkspaceType || 'main',
        allocationPlanId: run.allocationPlanId || null,
        allocationItemId: run.allocationItemId || null,
        workflowId: workflow.id,
        workflowStepId: step.id
      });
  appendEvent({
    type: 'workspace.operation',
    ticketId: run.ticketId,
    runId: run.id,
    stepId: step.id,
    payload: {
      workflowId: workflow.id,
      operation: step.action,
      path: input && input.path ? input.path : null,
      mutating: contract.mutating === true,
      input: sanitizeSnapshotValue(input),
      blocked: error.failureKind === 'protected_path' || ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION'].includes(error.code),
      reason: error.reason || null,
      error: error.message
    }
  });
    }

    appendRunReplaySnapshotItem(run.id, 'workflowActions', {
      workflowId: workflow.id,
      stepId: step.id,
      action: step.action,
      input: sanitizeSnapshotValue(input),
      error: error.message,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt
    });
    appendEvent({
      type: 'workflow.step.failed',
      ticketId: run.ticketId,
      runId: run.id,
      stepId: step.id,
      payload: {
        workflowId: workflow.id,
        action: step.action,
        error: error.message,
        code: error.code || null,
        durationMs: Date.now() - startedAt
      }
    });
    throw error;
  }
}

async function executeWorkflowDefinition(run, workflow, workflowInput, agent, options = {}) {
  const definitionErrors = validateWorkflowDefinition(workflow);
  if (definitionErrors.length > 0) {
    const error = new Error(`Workflow definition invalid: ${definitionErrors.join('; ')}`);
    error.code = 'WORKFLOW_DEFINITION_INVALID';
    error.failureKind = 'invalid_action';
    error.details = { definitionErrors };
    throw error;
  }

  const inputErrors = validateSchemaValue(workflow.inputSchema, workflowInput || {}, 'workflow.input');
  if (inputErrors.length > 0) {
    const error = new Error(`Workflow input invalid: ${inputErrors.join('; ')}`);
    error.code = 'WORKFLOW_INPUT_INVALID';
    error.failureKind = 'invalid_action';
    error.details = { inputErrors };
    throw error;
  }

  const limits = {
    ...getAgentRuntimeLimits(),
    maxTransitions: options.maxTransitions || getPositiveIntegerEnv('WORKFLOW_MAX_TRANSITIONS', 16),
    maxLoopIterations: options.maxLoopIterations || getPositiveIntegerEnv('WORKFLOW_MAX_LOOP_ITERATIONS', 3),
    maxMutations: options.maxMutations || getPositiveIntegerEnv('WORKFLOW_MAX_MUTATIONS', MAX_MUTATING_ACTIONS_PER_RESPONSE)
  };
  const counters = { transitions: 0, workspaceOperations: 0, modelRequests: 0, mutations: 0 };
  const context = {
    workflow: {
      input: workflowInput || {},
      version: typeof workflow.version === 'string' ? workflow.version : null,
      policy: workflow.policy || null,
      taskPromptTemplate: typeof workflow.taskPromptTemplate === 'string' ? workflow.taskPromptTemplate : '',
      verifierContract: workflow.verifierContract || null
    }
  };
  const stepsById = new Map(workflow.actions.map(step => [step.id, step]));
  const visitsByStepId = new Map();
  let currentStep = workflow.actions[0];
  const startedAtMs = Date.now();

  appendRunReplaySnapshotItem(run.id, 'workflowInvocation', {
    workflowId: workflow.id,
    workflowName: workflow.name,
    ...buildWorkflowContractEvidence(workflow),
    input: sanitizeSnapshotValue(workflowInput || {})
  });

  while (currentStep) {
    assertRunNotTimedOut(run, startedAtMs, limits);
    if (counters.transitions >= limits.maxTransitions) {
      throw createRunLimitError(run, 'step', `Workflow exceeded transition limit of ${limits.maxTransitions}`, {
        currentValue: counters.transitions,
        configuredLimit: limits.maxTransitions,
        workflowId: workflow.id
      });
    }

    const visits = (visitsByStepId.get(currentStep.id) || 0) + 1;
    visitsByStepId.set(currentStep.id, visits);
    if (visits > limits.maxLoopIterations) {
      throw createRunLimitError(run, 'step', `Workflow exceeded loop iteration limit of ${limits.maxLoopIterations} for ${currentStep.id}`, {
        currentValue: visits,
        configuredLimit: limits.maxLoopIterations,
        workflowId: workflow.id,
        stepId: currentStep.id
      });
    }

    const currentContract = getActionContract(currentStep.action);
    if (currentContract && currentContract.mutating === true && counters.mutations >= limits.maxMutations) {
      throw createRunLimitError(run, 'mutating_action', `Workflow exceeded mutation limit of ${limits.maxMutations}`, {
        currentValue: counters.mutations,
        configuredLimit: limits.maxMutations,
        workflowId: workflow.id
      });
    }

    persistRunWorkflowStep(run.id, currentStep, 'started');
    heartbeatRunLease(run.id, {
      phase: 'workflow_step_started',
      currentStepId: currentStep.id,
      currentWorkflowAction: currentStep.action
    });
    const input = resolveWorkflowInputTemplates(currentStep.input || {}, context);
    const result = await executeWorkflowAction(run, workflow, currentStep, input, context, counters, startedAtMs, limits, agent);
    counters.transitions += 1;
    persistRunWorkflowStep(run.id, currentStep, 'completed');
    heartbeatRunLease(run.id, {
      phase: 'workflow_step_completed',
      currentStepId: currentStep.id,
      currentWorkflowAction: currentStep.action
    });

    if (currentStep.saveAs) {
      context[currentStep.saveAs] = currentStep.action === 'agentStructuredOutput' ? result.output : result;
    }

    if (currentStep.action === 'stop' || result.stopped) {
      return { status: 'completed', result: result.result || context, counters };
    }

    const next = currentStep.action === 'condition' ? result.next : currentStep.next;
    if (!next || next === 'stop') {
      return { status: 'completed', result: context, counters };
    }

    currentStep = stepsById.get(next);
    if (!currentStep) {
      const error = new Error(`Workflow transition points to unknown action: ${next}`);
      error.code = 'WORKFLOW_TRANSITION_INVALID';
      error.failureKind = 'invalid_action';
      throw error;
    }
  }

  return { status: 'completed', result: context, counters };
}

function buildPriorFailureContext(ticketId, currentRunId) {
  const runs = readRuns().filter(r => r.ticketId === ticketId && r.id !== currentRunId);
  const terminalRuns = runs.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status));
  if (terminalRuns.length === 0) return null;

  // Only use the most recent prior terminal run
  const priorRun = terminalRuns.sort((a, b) => {
    const aTime = a.completedAt || a.updatedAt || a.startedAt || '';
    const bTime = b.completedAt || b.updatedAt || b.startedAt || '';
    return aTime.localeCompare(bTime);
  })[terminalRuns.length - 1];

  if (!priorRun || priorRun.status === 'completed') return null;

  const events = getRunEvents(priorRun.id);
  const workspaceOps = events.filter(e => e.type === 'workspace.operation');
  const lastAction = workspaceOps.length > 0 ? workspaceOps[workspaceOps.length - 1].payload?.operation : null;
  const inspectedFiles = events
    .filter(e => e.type === 'workspace.operation' && e.payload?.operation === 'readFile')
    .map(e => e.payload?.path)
    .filter(Boolean);
  const uniqueFiles = [...new Set(inspectedFiles)];
  const mutations = workspaceOps.filter(e =>
    e.payload?.mutating === true || ['writeFile', 'createFolder', 'renamePath', 'deletePath'].includes(e.payload?.operation)
  );

  return {
    priorRunId: priorRun.id,
    status: priorRun.status,
    reason: priorRun.error || priorRun.status,
    lastAction,
    inspectedFiles: uniqueFiles.slice(0, 8),
    mutationsCompleted: mutations.length,
    recoveryClassification: priorRun.status === 'failed' ? 'failed' : priorRun.status === 'interrupted' ? 'interrupted' : 'unknown'
  };
}

function buildTransitionGuidance(actionResults) {
  if (!actionResults || actionResults.length === 0) return [];

  // Filter to actual workspace operations (not warning entries from limit hits)
  const ops = actionResults.filter(item => item && item.action && item.action.operation);
  if (ops.length === 0) return [];

  // Check if all were inspection-only
  const allInspection = ops.every(item => {
    const op = item.action.operation;
    return op === 'listDirectory' || op === 'readFile';
  });

  if (!allInspection) return [];

  // Check if all succeeded (no error in result)
  const allSuccessful = ops.every(item => {
    const result = item.result;
    return result && !result.error;
  });

  if (!allSuccessful) return [];

  return [
    'Previous inspection is complete. You already have the directory entries in previousActionResults.',
    'Do not call listDirectory or readFile again for discovery.',
    'Use those entries now to emit up to runtimeEnvelope.maxMutatingActionsPerResponse exact mutation operations (createFolder, writeFile, renamePath, deletePath), or fail explicitly if no valid mutation can be determined.'
  ];
}

function isWorkflowDraftPromptObjective(objective) {
  const text = String(objective || '').toLowerCase();
  if (!text.trim()) return false;

  return /\b(createworkflowdraft|createworkflowdraftintent)\b/.test(text) ||
    /\bworkflow(s)?\b/.test(text) ||
    (/\bpostcondition(s)?\b/.test(text) && /\b(draft|create|define|verify|workflow)\b/.test(text));
}

function isHandoffPromptObjective(objective) {
  const text = String(objective || '').toLowerCase();
  if (!text.trim()) return false;

  return /\b(createhandofftask|handoff|hand off|delegate|delegation)\b/.test(text) ||
    (/\bworkflow(s)?\b/.test(text) && /\b(handoff|hand off|delegate|delegation|executor|another agent)\b/.test(text));
}

function compactRuntimeEnvelopeForPrompt(runtimeEnvelope) {
  const compact = { ...(runtimeEnvelope || {}) };

  if (compact.allocationPlanId === null) delete compact.allocationPlanId;
  if (compact.allocationItemId === null) delete compact.allocationItemId;
  if (compact.allocationItem === null) delete compact.allocationItem;
  if (compact.allocationSubtask === null) delete compact.allocationSubtask;
  if (Array.isArray(compact.ownedOutputPaths) && compact.ownedOutputPaths.length === 0) delete compact.ownedOutputPaths;
  if (compact.workloadProfile === null) delete compact.workloadProfile;

  return compact;
}

function compactTicketContextForPrompt(ticketObjective, previousActionResults, priorFailureContext, workspaceContext) {
  const compact = {
    ticketObjective
  };

  // Anchoring context: clearly separate the workspace as-of run start, the live
  // workspace, and the mutations this run already performed, so the model does
  // not re-interpret a relative objective against its own outputs.
  if (workspaceContext) {
    if (workspaceContext.initialWorkspaceSnapshot !== undefined) {
      compact.initialWorkspaceSnapshot = workspaceContext.initialWorkspaceSnapshot;
    }
    if (workspaceContext.currentWorkspaceSnapshot !== undefined) {
      compact.currentWorkspaceSnapshot = workspaceContext.currentWorkspaceSnapshot;
    }
    if (workspaceContext.mutationsByThisRun !== undefined) {
      compact.mutationsByThisRun = workspaceContext.mutationsByThisRun;
    }
  }

  if (Array.isArray(previousActionResults) && previousActionResults.length > 0) {
    compact.previousActionResults = previousActionResults;
  }
  if (priorFailureContext !== null && priorFailureContext !== undefined) {
    compact.priorFailureContext = priorFailureContext;
  }

  return compact;
}

const RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES = 200;

// Bounded, display-only listing of the run's root workspace. Used to give the
// model an initial (run-start) and current snapshot without spending a
// listDirectory action. Captures only the root level to stay small.
function captureRunWorkspaceRootSnapshot(run) {
  try {
    const listing = getRunWorkspaceProvider(run).list('');
    const allEntries = Array.isArray(listing.entries) ? listing.entries : [];
    return {
      path: '',
      entries: allEntries.slice(0, RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES).map(entry => ({ name: entry.name, type: entry.type })),
      truncated: allEntries.length > RUN_WORKSPACE_SNAPSHOT_MAX_ENTRIES
    };
  } catch (error) {
    return { path: '', entries: [], error: error.code || 'list_failed' };
  }
}

function buildAgentPrompt(ticket, runtimeEnvelope, actionResults = [], rerunMode = null, workspaceContext = null) {
  const baseAllowedOps = runtimeEnvelope.allowedOperations || AGENT_DIRECT_OPERATIONS;
  const currentPhase = runtimeEnvelope.currentPhase || 'planning';
  // Operation vocabulary (the full set of operation names available — used for the
  // JSON schema enum) is distinct from the operations usable in the current phase.
  const operationVocabulary = baseAllowedOps;
  const allowedOperationList = operationVocabulary.join('|');
  const currentPhaseAllowedOps = getAllowedOperationsForPhase(currentPhase).filter(op => baseAllowedOps.includes(op));
  const includeWorkflowDraftPromptGuidance = isWorkflowDraftPromptObjective(ticket.objective);
  const includeHandoffPromptGuidance = isHandoffPromptObjective(ticket.objective);
  const workflowDraftArgShape = AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED && includeWorkflowDraftPromptGuidance
    ? ',"workflow":"for createWorkflowDraft only"'
    : '';
  const workflowDraftIntentGuidance = includeWorkflowDraftPromptGuidance
    ? [
        'If the ticket asks to create, draft, define, or repair a simple workflow that writes files, use createWorkflowDraftIntent. Do not perform the workflow output actions directly. Emit exactly one workflow draft action and no writeFile/createFolder/readFile/listDirectory actions for that response.',
        'For workflow draft tickets, creating the disabled draft may satisfy the ticket if the objective was only to create that draft. Executing the workflow output actions directly does not satisfy a workflow draft objective.',
        'createWorkflowDraftIntent is only for flat simple write workflows. Args shape: {"id":"descriptive-non-numeric-slug","name":"string","writes":[{"path":"relative/path","content":"text"}],"postconditions":[{"type":"fileExists","path":"relative/path"},{"type":"fileContains","path":"relative/path","contains":"text"}]}. postconditions is required as a top-level sibling of id, name, and writes. Use ids such as draft-purpose-unique-token or draft-verified-output-unique-token; never use a bare number. Do not copy the example id. Choose an id that matches the workflow purpose.',
        'Never put complete, next, nextPath, or postconditions inside createWorkflowDraftIntent args.writes. Never put complete, next, or nextPath anywhere inside createWorkflowDraftIntent args.',
        'Minimal valid createWorkflowDraftIntent example: {"operation":"createWorkflowDraftIntent","args":{"id":"draft-purpose-unique-token","name":"Draft workflow purpose","writes":[{"path":"summary.txt","content":"ok"}],"postconditions":[{"type":"fileExists","path":"summary.txt"},{"type":"fileContains","path":"summary.txt","contains":"ok"}]}}.',
        'The complete flag belongs only at the top level of your response. Never put complete inside action args.',
        'All createWorkflowDraftIntent paths must be relative workspace paths like "note.txt" or "reports/note.txt". Never use absolute paths or runtimeEnvelope.workspaceRoot in a path.',
        'createWorkflowDraftIntent does not support branching, conditions, arbitrary actions, next fields, templates, or workflow JSON.',
        AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED
          ? 'If a ticket asks for a branching or conditional workflow, do not use createWorkflowDraftIntent; use canonical createWorkflowDraft instead.'
          : 'If a ticket asks for a branching or conditional workflow, do not fake it by writing YAML, JSON, prose, or another workflow definition file through createWorkflowDraftIntent. Return no actions, complete:false, and explain that branching workflow drafts are not available to normal agents.'
      ]
    : [];
  const canonicalWorkflowDraftGuidance = AGENT_CANONICAL_WORKFLOW_DRAFTS_ENABLED && includeWorkflowDraftPromptGuidance
    ? [
        'Trusted canonical workflow draft mode is enabled. You may emit createWorkflowDraft only when the ticket explicitly asks for operator-authored workflow JSON or a canonical workflow definition.',
        'For createWorkflowDraft, args must have exactly one key: workflow. Do not put postconditions beside workflow in args.',
        'For workflow drafts, the workflow object must have top-level keys id, name, inputSchema, actions, and postconditions. Each workflow step must use id, action, input, and optional next/trueNext/falseNext. Do not use type or args inside workflow.actions. Put postconditions only at args.workflow.postconditions. Never put postconditions inside a workflow action step or beside args.workflow.',
        'For branching canonical workflows, use a condition step with trueNext and falseNext as siblings of input. trueNext and falseNext must reference action ids in workflow.actions. Do not use createWorkflowDraftIntent for branching workflows.',
        'Before returning createWorkflowDraft, check: workflow.postconditions is present and non-empty when any workflow action is writeFile/createFolder/renamePath/deletePath; step.next/trueNext/falseNext are siblings of step.input, not inside step.input.',
        'Minimal valid createWorkflowDraft example: {"operation":"createWorkflowDraft","args":{"workflow":{"id":"write-note","name":"Write note","inputSchema":{},"actions":[{"id":"write","action":"writeFile","input":{"path":"note.txt","content":"ok"},"next":"done"},{"id":"done","action":"stop","input":{"result":{"path":"note.txt"}}}],"postconditions":[{"id":"file-exists","type":"fileExists","path":"note.txt"},{"id":"file-contains","type":"fileContains","path":"note.txt","contains":"ok"}]}}}',
        'Minimal valid branching createWorkflowDraft example: {"operation":"createWorkflowDraft","args":{"workflow":{"id":"branch-note","name":"Branch note","inputSchema":{"route":"string"},"actions":[{"id":"choose","action":"condition","input":{"value":"{{workflow.input.route}}","equals":"a"},"trueNext":"write-a","falseNext":"write-b"},{"id":"write-a","action":"writeFile","input":{"path":"branch-a.txt","content":"A"},"next":"done"},{"id":"write-b","action":"writeFile","input":{"path":"branch-b.txt","content":"B"},"next":"done"},{"id":"done","action":"stop","input":{"result":{"branched":true}}}],"postconditions":[{"id":"branch-a-exists","type":"fileExists","path":"branch-a.txt"}]}}}',
        'createWorkflowDraft args: { "workflow": { "id":"string", "name":"string", "inputSchema":{}, "actions":[], "postconditions":[] } }.'
      ]
    : !includeWorkflowDraftPromptGuidance ? [] : [
        'Do not emit createWorkflowDraft. Normal agents are not allowed to submit canonical workflow JSON.'
      ];
  const workflowDraftIntentArgReminder = includeWorkflowDraftPromptGuidance
    ? 'createWorkflowDraftIntent args: { "id":"descriptive non-numeric slug, e.g. draft-purpose-unique-token", "name":"string", "writes":[{"path":"string","content":"string"}], "postconditions":"required top-level array beside id/name/writes" }. Do not put complete, next, nextPath, or nested postconditions inside args.'
    : null;
  const workflowDraftIntentResponseFields = includeWorkflowDraftPromptGuidance
    ? ',"id":"for createWorkflowDraftIntent","name":"for createWorkflowDraftIntent","writes":"for createWorkflowDraftIntent","postconditions":"for createWorkflowDraftIntent"'
    : '';
  const handoffGuidance = includeHandoffPromptGuidance
    ? [
        'To hand one bounded write task to another agent, emit createHandoffTask. It executes directly through runtime authority; the executor model will not receive prose or make a model call.',
        'createHandoffTask is only for one writeFile operation to one existing executor. Args shape: {"executor":"agent name","operation":"writeFile","args":{"path":"relative/path.md","content":"exact content"}}. Do not include task descriptions, action lists, branches, or workflow JSON.'
      ]
    : [];
  const handoffArgReminder = includeHandoffPromptGuidance
    ? 'createHandoffTask args: { "executor":"agent name", "operation":"writeFile", "args":{"path":"relative/path","content":"exact content"} }.'
    : null;

  return [
    {
      role: 'system',
      content: [
        'You are an agent working inside a contained workspace.',
        'You may only request workspace CRUD actions. Do not request shell commands, terminal access, admin data, auth data, or files outside the workspace root.',
        'Use runtimeEnvelope.currentDateTime and runtimeEnvelope.timezone for any current date or time facts. Do not invent timestamps.',
        'The ticket context may include initialWorkspaceSnapshot (the root workspace at the start of this run), currentWorkspaceSnapshot (the live root workspace now), and mutationsByThisRun (the changes you have already made). You may still request list or read actions for deeper or nested details. No prior logs or run history are included.',
        'When a user objective refers to the current or existing workspace, interpret that relative to the workspace state at the start of the run (initialWorkspaceSnapshot). Do not treat files or folders created by this run (mutationsByThisRun) as pre-existing inputs for reinterpreting the same objective, unless the user explicitly asks you to continue from your own newly-created outputs.',
        'When the requested target state is achieved, return complete: true. Do not continue creating additional files or folders merely because the live workspace has changed from your own actions.',
        'If the ticket requires creating or changing files, request the necessary workspace actions.',
        'Do not say you will do work later. Do not describe future work instead of performing it.',
        'If the task cannot be completed, explain the failure reason clearly in the message.',
        'Never return complete false with an empty actions array unless the requested workflow cannot be represented by the allowed operations.',
        'Set complete:true only when the ticket objective has been fully satisfied by completed actions in this response or by prior verified state.',
        'Before setting complete:true, verify the ticket requirements have actually been satisfied. Do not assume an existing folder already contains required files or that earlier steps completed them.',
        'If the target path is clear or can be overwritten or created safely, emit the create or write operation.',
        `Budgets: runtimeEnvelope.maxExecutionSteps steps total; every response consumes one step, including retries. Emit at most runtimeEnvelope.maxActionsPerResponse (${MAX_AGENT_ACTIONS_PER_RESPONSE}) actions per response.`,
        `Mutating limit: at most runtimeEnvelope.maxMutatingActionsPerResponse (${MAX_MUTATING_ACTIONS_PER_RESPONSE}) createFolder/writeFile/renamePath/deletePath actions per response. If more mutations remain, emit a bounded batch, set complete:false, and continue next response.`,
        'Every response must belong to a single execution phase. Never mix inspection operations (listDirectory, readFile) and mutation operations (createFolder, writeFile, renamePath, deletePath) in the same response — a mixed response is rejected.',
        'Your current execution phase is runtimeEnvelope.currentPhase. Operations you may use in this phase: ' + (currentPhaseAllowedOps.length > 0 ? currentPhaseAllowedOps.join(', ') : 'none') + '.',
        'To perform mutations, respond with a single-phase mutation response containing only createFolder/writeFile/renamePath/deletePath actions (and no listDirectory/readFile); that moves you into the mutation phase.',
        'If you already performed inspection (listDirectory or readFile) and are now in the mutation phase, do not emit listDirectory or readFile again unless you are explicitly verifying results.',
        ...workflowDraftIntentGuidance,
        ...handoffGuidance,
        ...canonicalWorkflowDraftGuidance,
        ...buildProfileGuidance(ticket.objective),
        ...buildTransitionGuidance(actionResults),
        'If runtimeEnvelope.ownedOutputPaths is not empty, all create/write/rename/delete actions must stay inside those owned paths.',
        'If runtimeEnvelope.allocationSubtask is present, perform that subtask and put all output under your owned paths.',
        'Each action must be exactly {"operation":"operationName","args":{...}} with no extra fields.',
        'Required args: listDirectory {path}; readFile {path}; createFolder {path}; writeFile {path,content}; renamePath {path,nextPath}; deletePath {path}. Use path "" only for the workspace root in listDirectory.',
        ...(workflowDraftIntentArgReminder ? [workflowDraftIntentArgReminder] : []),
        ...(handoffArgReminder ? [handoffArgReminder] : []),
        'Respond only as JSON with this shape (the operation field lists the full operation vocabulary/schema, not the operations allowed in your current phase):',
        `{"message":"short summary","actions":[{"operation":"${allowedOperationList}","args":{"path":"relative/path","content":"for writeFile only","nextPath":"for renamePath only"${workflowDraftArgShape}${workflowDraftIntentResponseFields},"executor":"for createHandoffTask","operation":"writeFile for createHandoffTask","args":"nested args for createHandoffTask"}}],"complete":true|false}`
      ].join('\n')
    },
    {
      role: 'user',
      content: JSON.stringify({
        runtimeEnvelope: compactRuntimeEnvelopeForPrompt(runtimeEnvelope)
      })
    },
    {
      role: 'user',
      content: JSON.stringify(compactTicketContextForPrompt(
        ticket.objective,
        actionResults,
        actionResults.length === 0 && rerunMode === 'reassess'
          ? buildPriorFailureContext(ticket.id, runtimeEnvelope.runId)
          : null,
        workspaceContext
      ))
    }
  ];
}

async function runAgentTicket(runId) {
  startingRunIds.delete(runId);
  startingLocalModelRunIds.delete(runId);

  const leasedRun = readRuns().find(item => item.id === runId);
  if (!isRunLeaseHeldByCurrentProcess(leasedRun)) {
    appendEvent({
      type: 'scheduler.run_skipped',
      ticketId: leasedRun ? leasedRun.ticketId : null,
      runId,
      payload: {
        reason: 'lease_required',
        leaseOwner: leasedRun ? leasedRun.leaseOwner || null : null,
        leaseExpiresAt: leasedRun ? leasedRun.leaseExpiresAt || null : null
      }
    });
    return;
  }

  let run = updateRunStatus(runId, 'running');
  if (!run) return;
  if (run.status !== 'running') return;
  heartbeatRunLease(run.id, { phase: 'run_started' });

  runningRunKeys.add(runExecutionKey(run));
  appendEvent({
    type: 'run.started',
    ticketId: run.ticketId,
    runId: run.id,
    payload: {
      status: 'running',
      agentId: run.agentId,
      agentName: run.agentName,
      startedAt: run.startedAt || run.updatedAt
    }
  });
  appendRunLog(run, 'run:started', `Agent run started${allocationLogSuffix(run)}`, null, {
    allocationPlanId: run.allocationPlanId || null,
    allocationItemId: run.allocationItemId || null
  });
  updateTicketInProgressForRun(run);
  maybeTestInterrupt(run, 'after_run.started');
  let currentProviderRequestPersisted = false;
  let providerConfig = null;

  try {
    const ticket = readTickets().find(item => item.id === run.ticketId);
    const agent = readAgents().find(item => item.id === run.agentId);

    if (!ticket) throw new Error('Ticket not found');
    if (!agent) throw new Error('Agent not found');
    providerConfig = getAgentProviderConfig(agent);
    const runtimeEnvelope = buildRuntimeEnvelope(run, 0, ticket.objective);
    const initialInput = buildAgentPrompt(ticket, runtimeEnvelope, [], run.rerunMode);
    createRunReplaySnapshot(run, ticket, agent, providerConfig, runtimeEnvelope, initialInput[0].content);
    appendRunLog(run, 'run:runtime', JSON.stringify(runtimeEnvelope));

    if (ticket.executionMode === 'workflow' || run.executionMode === 'workflow') {
      const workflowId = run.workflowId || ticket.workflowId;
      const workflow = getWorkflowById(workflowId);
      if (!workflow || workflow.enabled === false) {
        const error = new Error(`Workflow not found or disabled: ${workflowId || 'none'}`);
        error.code = 'WORKFLOW_NOT_AVAILABLE';
        error.failureKind = 'invalid_action';
        throw error;
      }

      const workflowInput = run.workflowInput || ticket.workflowInput || {};
      const capability = {
        type: 'workflow',
        id: workflow.id,
        name: workflow.name,
        input: sanitizeSnapshotValue(workflowInput)
      };
      appendRunReplaySnapshotItem(run.id, 'capabilitySelection', {
        selectedBy: 'agent',
        capability,
        bounded: true,
        deterministic: true
      });
      appendRunLog(run, 'run:capability_started', `Capability started: ${workflow.name}`, null, {
        capabilityType: capability.type,
        capabilityId: capability.id
      });
      const workflowResult = await executeWorkflowDefinition(run, workflow, workflowInput, agent);
      appendRunReplaySnapshotItem(run.id, 'capabilityOutputs', {
        capabilityType: capability.type,
        capabilityId: capability.id,
        output: sanitizeSnapshotValue(workflowResult.result || {}),
        counters: workflowResult.counters || null
      });
      appendRunLog(run, 'run:capability_completed', `Capability completed: ${workflow.name}`, null, {
        capabilityType: capability.type,
        capabilityId: capability.id,
        counters: workflowResult.counters || null
      });
      completeAgentRun(run);
      return;
    }

    let actionResults = [];
    let stalledResponses = 0;
    let noProgressResponses = 0;
    let repeatedMutatingActionLimitViolations = 0;
    let lastMutatingActionLimitSignature = null;
    let modelRequestCount = 0;
    let workspaceOperationCount = 0;
    let listDirectoryCount = 0;
    let readFileCount = 0;
    const listedDirectoryPaths = new Set();
    let completed = false;
    let resumedFromPersistedState = false;
    const limits = getAgentRuntimeLimits(ticket.objective);
    const runStartedAtMs = Date.now();
    // Captured once at run start and never updated, so it does not absorb
    // folders/files this run creates. Anchors relative objectives.
    const initialWorkspaceSnapshot = captureRunWorkspaceRootSnapshot(run);
    const mutationsByThisRun = [];

    // ── Resumable execution check ─────────────────────────────────
    const resumeState = reconstructResumableState(run);
    if (resumeState) {
      appendRunLog(run, 'run:resume_check', `Resumable state detected: ${resumeState.priorEvents} prior events, execution=${resumeState.safeToResumeExecution}, reconcile=${resumeState.safeToReconcileTerminalState}, unsafe=${resumeState.unsafeToContinue}, nextPhase=${resumeState.expectedNextPhase}`);
      if (resumeState.unsafeToContinue) {
        const reason = resumeState.hasDuplicateMutation
          ? 'Duplicate mutations detected in event log'
          : 'Hash chain broken';
        const error = new Error(`Resume denied: ${reason}`);
        error.code = 'RUN_RESUME_UNSAFE';
        error.failureKind = 'resume_rejected';
        error.details = { expectedNextPhase: resumeState.expectedNextPhase, priorEvents: resumeState.priorEvents };
        throw error;
      }
      if (resumeState.safeToReconcileTerminalState) {
        appendRunLog(run, 'run:resume_reconcile', `Resuming into terminal state reconciliation: ${resumeState.expectedNextPhase}`);
        reconcileTerminalRun(run);
        return;
      }
      if (resumeState.isTerminal) {
        appendRunLog(run, 'run:skip_terminal', `Run already in terminal state (legacy)`);
        return;
      }
      if (!resumeState.safeToResumeExecution) {
        const error = new Error('Resume denied: Authority chain missing for committed mutations');
        error.code = 'RUN_RESUME_UNSAFE';
        error.failureKind = 'resume_rejected';
        error.details = { expectedNextPhase: resumeState.expectedNextPhase, priorEvents: resumeState.priorEvents };
        throw error;
      }
      // Reconstruct execution state from prior events
      // Only treat as resumed if there is actual prior execution evidence
      if (resumeState.workspaceOperationCount > 0) {
        resumedFromPersistedState = true;
      }
      workspaceOperationCount = resumeState.workspaceOperationCount;
      for (const p of resumeState.listedDirectoryPaths) listedDirectoryPaths.add(p);
      if (resumeState.currentPhase) {
        run.currentPhase = resumeState.currentPhase;
      }
      if (resumeState.expectedNextPhase === 'terminalization' || resumeState.expectedNextPhase === 'terminalization_or_evaluation' || resumeState.expectedNextPhase === 'consequence' || resumeState.expectedNextPhase === 'snapshot_finalization') {
        appendRunLog(run, 'run:resume_skip_model', `Resuming into terminalization phase: ${resumeState.expectedNextPhase}`);
        completed = true; // Skip model loop, go straight to completion
      }
    }

    // Exact delete-target identity: for a simple "delete <X>" objective, the only
    // legitimate deletePath target is X. Used to reject near-miss deletes (e.g.
    // deletePath C for "Delete CD") before execution. null for non-simple objectives.
    const simpleDeleteTargets = extractSimpleDeleteTargets(ticket && ticket.objective);
    const simpleDeleteTargetSet = simpleDeleteTargets
      ? new Set(simpleDeleteTargets.map(t => normalizeArtifactOwnershipPath(t)).filter(Boolean))
      : null;

    for (let step = 0; !completed; step += 1) {
      heartbeatRunLease(run.id, { phase: 'agent_step_started', step });
      assertRunNotTimedOut(run, runStartedAtMs, limits);
      assertRunStepAllowed(run, step, limits);
      assertRunModelRequestAllowed(run, modelRequestCount, limits);

      try { 
        const wsRoot = typeof workspaceProvider.root === 'string' ? workspaceProvider.root : String(workspaceProvider.root); 
        const fs2 = require('fs');
      } catch(e) { 
      }
      if (!resumedFromPersistedState) {
        const obviousPostcondition = checkObviousTicketPostcondition(ticket);
        if (obviousPostcondition) {
          recordRunEvent(run, 'run:postcondition_completed', obviousPostcondition.reason, {
            step,
            mutatingActionCount: 0,
            checkedPaths: obviousPostcondition.checkedPaths,
            source: 'pre_model'
          });
          if (obviousPostcondition.absentDelete) {
            appendEvent({
              type: 'workspace.delete_target_already_absent',
              ticketId: run.ticketId,
              runId: run.id,
              stepId: String(step),
              payload: {
                paths: obviousPostcondition.checkedPaths.map(check => check.path),
                reason: obviousPostcondition.reason,
                executed: false,
                mutationCommitted: false
              }
            });
          }
          completed = true;
          break;
        }
      }

      const currentEnvelope = buildRuntimeEnvelope(run, step, ticket.objective);
      const workspaceContext = {
        initialWorkspaceSnapshot,
        currentWorkspaceSnapshot: captureRunWorkspaceRootSnapshot(run),
        mutationsByThisRun
      };
      const input = buildAgentPrompt(ticket, currentEnvelope, actionResults, run.rerunMode, workspaceContext);
      appendRunLog(run, 'model:request', `${providerConfig.provider} request sent with model ${providerConfig.model}`);
      modelRequestCount += 1;
      currentProviderRequestPersisted = false;
      const modelRequestStartedAt = Date.now();
      const modelResponse = await callModelProviderWithRunTimeout(run, agent, input, runStartedAtMs, limits, {
        onRequest: requestPayload => {
          appendRunReplaySnapshotItem(run.id, 'providerRequests', {
            ...requestPayload,
            startedAt: new Date(modelRequestStartedAt).toISOString(),
            durationMs: Date.now() - modelRequestStartedAt
          });
          currentProviderRequestPersisted = true;
        }
      });
      const modelResponseCompletedAt = Date.now();
      const modelCallDurationMs = modelResponseCompletedAt - modelRequestStartedAt;
      assertRunNotTimedOut(run, runStartedAtMs, limits);
      const modelText = modelResponse.text;
      appendRunLog(
        run,
        'model:response',
        modelText,
        null,
        {
          ...(modelResponse.usage ? { usage: modelResponse.usage } : {}),
          requestId: modelResponse.responsePayload ? modelResponse.responsePayload.requestId || null : null
        }
      );
      appendRunReplaySnapshotItem(run.id, 'modelResponses', {
        text: modelText,
        usage: modelResponse.usage || null,
        provider: modelResponse.provider || providerConfig.provider,
        model: modelResponse.model || providerConfig.model,
        providerResponsePayload: modelResponse.responsePayload,
        startedAt: new Date(modelRequestStartedAt).toISOString(),
        completedAt: new Date(modelResponseCompletedAt).toISOString(),
        durationMs: modelCallDurationMs
      });

      const modelPlan = parseModelActions(modelText);
      if (modelPlan.parseError) {
        recordRunEvent(run, 'model:malformed', 'Model response was not valid execution JSON', {
          parseError: modelPlan.parseError,
          rawText: modelText,
          step
        });
        const error = new Error(`Model response was not valid execution JSON: ${modelPlan.parseError}`);
        error.code = 'MODEL_MALFORMED_JSON';
        error.failureKind = 'invalid_action';
        error.details = { parseError: modelPlan.parseError, step };
        throw error;
      }

      appendRunReplaySnapshotItem(run.id, 'parsedModelPlans', {
        message: modelPlan.message,
        actions: modelPlan.actions,
        complete: modelPlan.complete,
        step
      });
      captureRunArtifactPrediction(run.id, modelPlan.actions, step);
      broadcastTicketChange();
      const priorStepActionResults = actionResults;
      actionResults = [];
      let actions = modelPlan.actions;
      // Set when the mutating-action cap drops proposed actions this step. A
      // truncated response must not complete the run, because some proposed
      // actions were never applied.
      let completionBlockedByActionTruncation = false;

      if (isRunInterrupted(run.id)) {
        const error = new Error('Run interrupted');
        error.code = 'RUN_INTERRUPTED';
        throw error;
      }

      if (actions.length > MAX_AGENT_ACTIONS_PER_RESPONSE) {
        const message = `Model returned ${actions.length} workspace actions, exceeding the per-response limit of ${MAX_AGENT_ACTIONS_PER_RESPONSE}`;

        recordRunEvent(run, 'model:action_limit', message, {
          actionCount: actions.length,
          maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
          step
        });
        actionResults = [{
          warning: 'model:action_limit',
          message: `You returned ${actions.length} workspace actions, exceeding the per-response limit of ${MAX_AGENT_ACTIONS_PER_RESPONSE}. Retry with at most ${MAX_AGENT_ACTIONS_PER_RESPONSE} actions. If more work remains, emit up to the limit, set complete:false, and continue in the next response.`
        }];
        continue;
      }

      const mutatingActionCount = countMutatingActions(actions);
      if (mutatingActionCount > MAX_MUTATING_ACTIONS_PER_RESPONSE && !isAllowedFolderWriteBundle(actions)) {
        if (ENABLE_PREFIX_TRUNCATION) {
          // ── Prefix truncation path ──────────────────────────────
          const originalActions = [...actions];
          const executedActions = [];
          const droppedActions = [];
          let mutatingSeen = 0;

          for (const a of originalActions) {
            if (a && typeof a === 'object' && AGENT_MUTATING_OPERATIONS.includes(a.operation)) {
              if (mutatingSeen < MAX_MUTATING_ACTIONS_PER_RESPONSE) {
                executedActions.push(a);
                mutatingSeen++;
              } else {
                droppedActions.push(a);
              }
            } else {
              executedActions.push(a);
            }
          }

          if (droppedActions.length > 0) {
            completionBlockedByActionTruncation = true;
          }

          const truncatedMessage = `Model returned ${mutatingActionCount} mutating workspace actions, exceeding the per-response mutating limit of ${MAX_MUTATING_ACTIONS_PER_RESPONSE}. Executed the first ${MAX_MUTATING_ACTIONS_PER_RESPONSE} mutating action(s) and dropped ${droppedActions.length}. Non-mutating actions were preserved.${droppedActions.length > 0 ? ` complete:true was not honored because ${droppedActions.length} proposed action(s) were not applied; continue from the executed state and re-emit the remaining action(s).` : ''}`;

          recordRunEvent(run, 'model:mutating_action_truncated', truncatedMessage, {
            actionCount: originalActions.length,
            mutatingActionCount,
            maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
            maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
            executedCount: mutatingSeen,
            truncatedCount: droppedActions.length,
            step
          });

          appendEvent({
            type: 'action.truncated',
            ticketId: run.ticketId,
            runId: run.id,
            stepId: String(step),
            payload: {
              reason: 'mutating_action_limit',
              proposedCount: originalActions.length,
              mutatingCount: mutatingActionCount,
              limit: MAX_MUTATING_ACTIONS_PER_RESPONSE,
              executedCount: mutatingSeen,
              truncatedCount: droppedActions.length,
              droppedActions: droppedActions.map(a => ({
                operation: a.operation,
                path: a.args && a.args.path,
                nextPath: a.args && a.args.nextPath
              }))
            }
          });

          actionResults = [
            ...priorStepActionResults,
            { warning: 'model:mutating_action_limit',
              message: truncatedMessage }
          ];

          actions = executedActions;
        } else {
          // ── Suppression path (flag disabled) ────────────────────
          const message = `Model returned ${mutatingActionCount} mutating workspace actions, exceeding the per-response mutating limit of ${MAX_MUTATING_ACTIONS_PER_RESPONSE}`;
          const mutatingActionLimitSignature = actions
            .filter(action => action && typeof action === 'object' && AGENT_MUTATING_OPERATIONS.includes(action.operation))
            .map(action => `${action.operation}:${action.args && action.args.path ? action.args.path : ''}:${action.args && action.args.nextPath ? action.args.nextPath : ''}`)
            .join('|');

          repeatedMutatingActionLimitViolations = mutatingActionLimitSignature === lastMutatingActionLimitSignature
            ? repeatedMutatingActionLimitViolations + 1
            : 1;
          lastMutatingActionLimitSignature = mutatingActionLimitSignature;

          recordRunEvent(run, 'model:mutating_action_limit', message, {
            actionCount: actions.length,
            mutatingActionCount,
            maxActionsPerResponse: MAX_AGENT_ACTIONS_PER_RESPONSE,
            maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
            repeatedViolationCount: repeatedMutatingActionLimitViolations,
            step
          });

          appendEvent({
            type: 'action.suppressed',
            ticketId: run.ticketId,
            runId: run.id,
            stepId: String(step),
            payload: {
              reason: 'mutating_action_limit',
              proposedCount: actions.length,
              mutatingCount: mutatingActionCount,
              limit: MAX_MUTATING_ACTIONS_PER_RESPONSE,
              repeatedViolationCount: repeatedMutatingActionLimitViolations,
              droppedActions: actions
                .filter(a => a && typeof a === 'object' && AGENT_MUTATING_OPERATIONS.includes(a.operation))
                .map(a => ({ operation: a.operation, path: a.args && a.args.path, nextPath: a.args && a.args.nextPath }))
            }
          });

          if (repeatedMutatingActionLimitViolations >= 2) {
            const error = createRunLimitError(
              run,
              'mutating_action',
              'Model repeatedly proposed too many mutating actions; no workspace mutations were executed.',
              {
                currentValue: repeatedMutatingActionLimitViolations,
                configuredLimit: 1,
                mutatingActionCount,
                maxMutatingActionsPerResponse: MAX_MUTATING_ACTIONS_PER_RESPONSE,
                step
              }
            );
            error.failureKind = 'invalid_action';
            throw error;
          }

          actionResults = [
            ...priorStepActionResults,
            { warning: 'model:mutating_action_limit',
              message: `You returned ${mutatingActionCount} mutating workspace actions, exceeding the per-response mutating limit of ${MAX_MUTATING_ACTIONS_PER_RESPONSE}. Retry with at most ${MAX_MUTATING_ACTIONS_PER_RESPONSE} createFolder/writeFile/renamePath/deletePath action(s). You may include read/list actions if needed. If more work remains, set complete:false and continue in the next response.` }
          ];
          continue;
        }
      }

      // ── Phase-aware execution enforcement ─────────────────────────
      const phaseCheck = checkPhaseCompliance(run, actions);
      if (!phaseCheck.compliant) {
        recordRunEvent(run, 'execution.phase_violation', phaseCheck.reason, {
          step,
          currentPhase: phaseCheck.currentPhase,
          inferredPhase: phaseCheck.inferredPhase,
          violationType: phaseCheck.violationType,
          actions: actions.map(a => ({ operation: a.operation, path: a.args && a.args.path }))
        });
        appendEvent({
          type: 'execution.phase_violation',
          ticketId: run.ticketId,
          runId: run.id,
          stepId: String(step),
          payload: {
            currentPhase: phaseCheck.currentPhase,
            inferredPhase: phaseCheck.inferredPhase,
            violationType: phaseCheck.violationType,
            reason: phaseCheck.reason,
            actions: actions.map(a => ({ operation: a.operation, path: a.args && a.args.path }))
          }
        });
        actionResults = [{
          warning: 'execution.phase_violation',
          message: `${phaseCheck.reason}. Current phase is ${phaseCheck.currentPhase}. Actions in this response must all belong to the same allowed phase.`
        }];
        continue;
      }
      // Advance phase if transitioned
      if (phaseCheck.inferredPhase && phaseCheck.inferredPhase !== run.currentPhase) {
        advanceRunPhase(run, phaseCheck.inferredPhase);
        appendEvent({
          type: 'execution.phase_transition',
          ticketId: run.ticketId,
          runId: run.id,
          stepId: String(step),
          payload: {
            fromPhase: phaseCheck.currentPhase,
            toPhase: phaseCheck.inferredPhase,
            reason: 'Inferred from model response actions'
          }
        });
      }

      if (!modelPlan.complete && actions.length === 0) {
        if (isUnsupportedObjectiveModelPlan(modelPlan)) {
          const message = modelPlan.message.trim();
          recordRunEvent(run, 'model:unsupported_objective', message, { step });
          const error = new Error(message);
          error.code = 'OBJECTIVE_UNSUPPORTED_BY_ALLOWED_OPERATIONS';
          error.failureKind = 'unsupported_objective';
          error.details = { step, message };
          throw error;
        }

        stalledResponses += 1;
        recordRunEvent(run, 'model:stalled', 'Model returned complete:false with no workspace actions', { step });

        if (stalledResponses >= 2) {
          throw createRunLimitError(run, 'step', 'Model stalled twice with complete:false and no workspace actions', {
            currentValue: stalledResponses,
            configuredLimit: 1,
            step
          });
        }

        const remainingSteps = limits.maxExecutionSteps - step - 1;
        actionResults = [{
          warning: 'model:stalled',
          message: `You returned complete:false with no workspace actions. You have ${remainingSteps} remaining execution step(s). Emit the next required workspace operation now or fail explicitly.`
        }];
        continue;
      }

      // ── Invalid-action-args preflight ─────────────────────────────
      // Validate the entire batch before executing any action, so a later invalid
      // action cannot fail the run after an earlier action already executed. If any
      // standard workspace action has invalid args, execute none of them, record a
      // structured event, warn the model, and retry (bounded by the step limit).
      const invalidActions = validateWorkspaceActionBatch(actions);
      if (invalidActions.length > 0) {
        const first = invalidActions[0];
        const detail = {
          step,
          operation: first.operation,
          actionIndex: first.actionIndex,
          args: first.args,
          validationErrors: first.validationErrors,
          invalidArgs: first.validationErrors,
          invalidActions,
          rejectedBatch: true,
          executed: false,
          capturedAt: new Date().toISOString()
        };
        recordRunEvent(run, 'workspace.invalid_action_args', `Action batch rejected before execution: ${first.operation} ${first.validationErrors.join('; ')}`, detail);
        appendEvent({
          type: 'workspace.invalid_action_args',
          ticketId: run.ticketId,
          runId: run.id,
          stepId: String(step),
          payload: detail
        });
        actionResults = [{
          warning: 'workspace.invalid_action_args',
          message: `The action batch was rejected before execution because action ${first.actionIndex} (${first.operation}) has invalid args: ${first.validationErrors.join('; ')}. listDirectory may use path "" for the workspace root, but readFile, createFolder, writeFile, renamePath, and deletePath may not. Emit a corrected single-phase action batch.`,
          operation: first.operation,
          actionIndex: first.actionIndex,
          rejectedBatch: true,
          executed: false
        }];
        continue;
      }

      // ── Exact delete-target guard ─────────────────────────────────
      // For a simple "delete <X>" objective, reject any deletePath whose target is
      // not the exact objective target (e.g. deletePath C for "Delete CD") before
      // executing anything, so the model cannot mutate a near-miss path.
      if (simpleDeleteTargetSet) {
        const mismatched = actions
          .filter(a => a && a.operation === 'deletePath' && a.args && typeof a.args.path === 'string')
          .map(a => ({ proposed: a.args.path, norm: normalizeArtifactOwnershipPath(a.args.path) }))
          .filter(x => !x.norm || !simpleDeleteTargetSet.has(x.norm));
        if (mismatched.length > 0) {
          const first = mismatched[0];
          const targetList = Array.from(simpleDeleteTargetSet).join(', ');
          const detail = {
            step,
            proposedPath: first.proposed,
            objectiveTargets: Array.from(simpleDeleteTargetSet),
            rejectedBatch: true,
            executed: false,
            capturedAt: new Date().toISOString()
          };
          recordRunEvent(run, 'workspace.delete_target_mismatch_rejected', `deletePath ${first.proposed} does not match the objective's exact delete target (${targetList})`, detail);
          appendEvent({
            type: 'workspace.delete_target_mismatch_rejected',
            ticketId: run.ticketId,
            runId: run.id,
            stepId: String(step),
            payload: detail
          });
          actionResults = [{
            warning: 'workspace.delete_target_mismatch_rejected',
            message: `The action batch was rejected before execution because deletePath ${first.proposed} does not match the objective's exact delete target (${targetList}). Delete only the exact target path; do not substitute a nearby path.`,
            operation: 'deletePath',
            rejectedBatch: true,
            executed: false
          }];
          continue;
        }
      }

      let hasMutatingAction = false;
      const repeatedListPaths = [];
      const listPathsThisStep = new Set();

      assertRunWorkspaceOperationAllowed(run, workspaceOperationCount, actions.length, limits);

      for (const action of actions) {
        let operation = null;
        const actionStartedAt = Date.now();
        try {
          if (isRunInterrupted(run.id)) {
            const error = new Error('Run interrupted');
            error.code = 'RUN_INTERRUPTED';
            throw error;
          }

          assertRunNotTimedOut(run, runStartedAtMs, limits);
          operation = parseAgentDirectAction(action);
          assertAgentOperationAllowed(run, agent, operation.operation, step);

          // Report budget limits: listDirectory and readFile
          if (operation.operation === 'listDirectory' && limits.maxListDirectoryPerRun != null) {
            listDirectoryCount += 1;
            if (listDirectoryCount > limits.maxListDirectoryPerRun) {
              throw createRunLimitError(run, 'operation', `Agent run exceeded listDirectory limit of ${limits.maxListDirectoryPerRun}`, {
                currentValue: listDirectoryCount,
                configuredLimit: limits.maxListDirectoryPerRun
              });
            }
          }
          if (operation.operation === 'readFile' && limits.maxReadFilePerRun != null) {
            readFileCount += 1;
            if (readFileCount > limits.maxReadFilePerRun) {
              throw createRunLimitError(run, 'operation', `Agent run exceeded readFile limit of ${limits.maxReadFilePerRun}`, {
                currentValue: readFileCount,
                configuredLimit: limits.maxReadFilePerRun
              });
            }
          }

          let result;
          if (operation.operation === 'createWorkflowDraft') {
            result = createWorkflowDraftFromAgent(run, operation.args.workflow, step);
          } else if (operation.operation === 'createWorkflowDraftIntent') {
            result = createWorkflowDraftFromIntent(run, operation.args, step);
          } else if (operation.operation === 'createHandoffTask') {
            result = executeHandoffTask(run, operation.args, step);
          } else {
            result = executeWorkspaceOperation(run, action, step);
            // Deterministic runtime verification for bounded operation batches
            if (AGENT_MUTATING_OPERATIONS.includes(operation.operation)) {
              verifyBatchOperation(run, action, result);
            }
          }
          const opDurationMs = Date.now() - actionStartedAt;
          const isResumeSkipped = result && result.skipped === true;
          if (!isResumeSkipped && (AGENT_ALLOWED_OPERATIONS.includes(operation.operation) || operation.operation === 'createHandoffTask')) workspaceOperationCount += 1;

          // Track mutations performed by this run so later steps can tell their
          // own outputs apart from pre-existing inputs.
          if (!isResumeSkipped && AGENT_MUTATING_OPERATIONS.includes(operation.operation)) {
            mutationsByThisRun.push({
              operation: operation.operation,
              path: operation.args && operation.args.path,
              ...(operation.args && operation.args.nextPath ? { nextPath: operation.args.nextPath } : {}),
              status: result && result.status ? result.status : 'ok'
            });
          }

          actionResults.push({ action, result });
          // INVARIANT: Success replay entry shape must remain structurally
          // compatible with the error replay entry below (line ~2744).
          // operation is the object from parseWorkspaceOperation:
          //   { operation: string, args: object }.
          // Downstream consumers (EJS template, test assertions) access
          // item.operation.operation and item.result — any shape change
          // here must be mirrored in the error entry and all consumers.
          if (!isResumeSkipped && AGENT_ALLOWED_OPERATIONS.includes(operation.operation)) {
            appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
              operation,
              result,
              startedAt: new Date(actionStartedAt).toISOString(),
              durationMs: opDurationMs,
              historyId: result && result.historyId ? result.historyId : null,
              workspaceRoot: getRunWorkspaceProvider(run).root,
              executionWorkspaceType: run.executionWorkspaceType || 'main',
              allocationPlanId: run.allocationPlanId || null,
              allocationItemId: run.allocationItemId || null,
              ownedOutputPaths: getRunOwnedOutputPaths(run)
            });
            appendEvent({
              type: 'workspace.operation',
              ticketId: run.ticketId,
              runId: run.id,
              stepId: String(step),
              payload: {
                operation: operation.operation,
                path: operation.args ? operation.args.path || null : null,
                nextPath: operation.args ? operation.args.nextPath || null : null,
                mutating: AGENT_MUTATING_OPERATIONS.includes(operation.operation),
                input: sanitizeSnapshotValue(operation.args || {}),
                result: sanitizeSnapshotValue(result)
              }
            });
            maybeTestInterrupt(run, 'after_first_workspace.operation');
          }

          if (operation.operation === 'createHandoffTask') {
            const executedOperation = {
              operation: result.operation,
              args: result.args
            };
            appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
              operation: executedOperation,
              result: result.result,
              startedAt: new Date(actionStartedAt).toISOString(),
              durationMs: opDurationMs,
              historyId: result.historyId || null,
              handoffTask: {
                plannerAgentId: run.agentId,
                plannerAgentName: run.agentName || null,
                executorAgentId: result.executorAgentId,
                executorAgentName: result.executorAgentName
              },
              workspaceRoot: getRunWorkspaceProvider(run).root,
              executionWorkspaceType: run.executionWorkspaceType || 'main',
              allocationPlanId: run.allocationPlanId || null,
              allocationItemId: run.allocationItemId || null,
              ownedOutputPaths: getRunOwnedOutputPaths(run)
            });
            appendEvent({
              type: 'workspace.operation',
              ticketId: run.ticketId,
              runId: run.id,
              stepId: String(step),
              payload: {
                operation: result.operation,
                path: result.args ? result.args.path || null : null,
                nextPath: null,
                mutating: true,
                input: sanitizeSnapshotValue(result.args || {}),
                result: sanitizeSnapshotValue(result.result),
                handoffTask: {
                  plannerAgentId: run.agentId,
                  plannerAgentName: run.agentName || null,
                  executorAgentId: result.executorAgentId,
                  executorAgentName: result.executorAgentName
                }
              }
            });
          }

          if (AGENT_MUTATING_OPERATIONS.includes(operation.operation) || operation.operation === 'createHandoffTask') {
            hasMutatingAction = true;
          }

          if (operation.operation === 'listDirectory') {
            const listedPath = result && typeof result.path === 'string' ? result.path : operation.args.path;

            if (listedDirectoryPaths.has(listedPath) || listPathsThisStep.has(listedPath)) {
              repeatedListPaths.push(listedPath || '/');
            }

            listPathsThisStep.add(listedPath);
          }
        } catch (error) {
          const opDurationMs = Date.now() - actionStartedAt;
          actionResults.push({ action, error: error.message });
          if (error.workspaceAction || (operation && AGENT_ALLOWED_OPERATIONS.includes(operation.operation))) {
            // INVARIANT: Error replay entry shape must remain structurally
            // compatible with the success replay entry above (line ~2717).
            // operation may be either the parseWorkspaceOperation object
            // { operation: string, args: object } or the richer metadata
            // object from error.workspaceAction (which adds path, blocked,
            // reason, etc.). Downstream consumers access item.operation and
            // item.error — any shape change here must be mirrored in the
            // success entry and all consumers.
            appendRunReplaySnapshotItem(run.id, 'workspaceOperations', {
              operation: error.workspaceAction || operation,
              error: error.message,
              blocked: error.failureKind === 'protected_path' || ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION'].includes(error.code),
              reason: error.reason || null,
              durationMs: opDurationMs,
              historyId: error.historyId || null,
              ownedOutputPaths: error.ownedOutputPaths || getRunOwnedOutputPaths(run),
              workspaceRoot: getRunWorkspaceProvider(run).root,
              executionWorkspaceType: run.executionWorkspaceType || 'main',
              allocationPlanId: run.allocationPlanId || null,
              allocationItemId: run.allocationItemId || null
            });
            const eventOperation = error.workspaceAction || operation;
            appendEvent({
              type: 'workspace.operation',
              ticketId: run.ticketId,
              runId: run.id,
              stepId: String(step),
            payload: {
              operation: eventOperation ? eventOperation.operation : null,
              path: eventOperation && eventOperation.args ? eventOperation.args.path || null : eventOperation && eventOperation.path ? eventOperation.path : null,
              nextPath: eventOperation && eventOperation.args ? eventOperation.args.nextPath || null : null,
              mutating: eventOperation ? AGENT_MUTATING_OPERATIONS.includes(eventOperation.operation) : false,
              input: sanitizeSnapshotValue(eventOperation && eventOperation.args ? eventOperation.args : {}),
              blocked: error.failureKind === 'protected_path' || ['WORKSPACE_PROTECTED_PATH', 'WORKSPACE_OWNERSHIP_VIOLATION'].includes(error.code),
              reason: error.reason || null,
              error: error.message
            }
          });
          }
          error.workspaceAction = error.workspaceAction || action;
          if (error.failureKind !== 'workspace_error') {
            throw error;
          }
        }
      }

      if (hasMutatingAction) {
        listedDirectoryPaths.clear();
      }

      listPathsThisStep.forEach(listedPath => listedDirectoryPaths.add(listedPath));

      if (!modelPlan.complete && isWorkflowDraftObjective(ticket.objective) && hasSuccessfulWorkflowDraftAction(actionResults)) {
        recordRunEvent(run, 'workflow.draft_objective_satisfied', 'Workflow draft objective satisfied by created disabled draft', {
          step,
          source: 'successful_workflow_draft_action'
        });
        completed = true;
        break;
      }

      if (!resumedFromPersistedState && !modelPlan.complete && isDirectWorkspaceObjectiveSatisfied(run, ticket, actionResults)) {
        recordRunEvent(run, 'workspace.objective_satisfied', 'Workspace objective satisfied by successful mutation evidence', {
          step,
          source: 'successful_workspace_mutation',
          objectivePaths: extractObjectivePathTokens(ticket.objective)
        });
        completed = true;
        break;
      }

      // Bounded operation batch: repeated inspection without mutation is non-progress.
      // The model must produce exactly one bounded inspection phase, then emit a batch.
      if (!modelPlan.complete && !hasMutatingAction && actions.length > 0) {
        // Any inspection-only response (listDirectory, readFile) after prior
        // inspection is non-progress. The model must emit mutations after
        // bounded inspection or fail explicitly.
        const isInspectionOnly = actions.every(a => {
          const op = a && a.operation;
          return op === 'listDirectory' || op === 'readFile';
        });

        if (isInspectionOnly) {
          noProgressResponses += 1;

          // Only warn and penalize starting from the second inspection-only step.
          // The first inspection step is legitimate discovery and must not be scolded.
          if (noProgressResponses >= 2) {
            const uniqueRepeatedPaths = Array.from(new Set(repeatedListPaths));
            const message = uniqueRepeatedPaths.length > 0
              ? `Model repeated listDirectory without a write/create/rename/delete action: ${uniqueRepeatedPaths.join(', ')}`
              : 'Model emitted inspection-only actions without progress after bounded inspection phase';
            recordRunEvent(run, 'model:no_progress', message, {
              repeatedListPaths: uniqueRepeatedPaths,
              step,
              isInspectionOnly: true
            });

            if (noProgressResponses >= 3) {
              const error = createRunLimitError(run, 'step', 'Model repeated inspection-only non-progress twice. Bounded inspection must be followed by exactly one bounded operation batch.', {
                currentValue: noProgressResponses,
                configuredLimit: 1,
                step,
                repeatedListPaths: uniqueRepeatedPaths
              });
              error.failureKind = 'no_progress';
              throw error;
            }

            const remainingSteps = limits.maxExecutionSteps - step - 1;
            actionResults.push({
              warning: 'model:no_progress',
              repeatedListPaths: uniqueRepeatedPaths,
              message: `You emitted inspection-only actions without progress. Bounded inspection must be followed by exactly one bounded operation batch (createFolder, writeFile, renamePath, deletePath). You have ${remainingSteps} remaining execution step(s). Emit the required batch now or fail explicitly with a reason.`
            });
          }

          continue;
        }
      }

      const postcondition = checkPostconditionCompletion(run, actions, actionResults, step);
      if (postcondition) {
        recordRunEvent(run, 'run:postcondition_completed', postcondition.reason, {
          step,
          mutatingActionCount: postcondition.mutatingActionCount
        });
        completed = true;
        break;
      }

      if (modelPlan.complete && completionBlockedByActionTruncation) {
        recordRunEvent(run, 'run:completion_deferred_truncation', 'complete:true not honored: response was truncated by the mutating-action cap and proposed actions were dropped', { step });
      } else if (modelPlan.complete) {
        if (actions.length === 0) {
          recordRunEvent(run, 'run:completed_noop', 'Agent run completed with no workspace changes', { step });
        }

        completed = true;
        break;
      }
    }

    run = completeAgentRun(run);
  } catch (error) {
    if (error.providerRequestPayload && !currentProviderRequestPersisted) {
      appendRunReplaySnapshotItem(run.id, 'providerRequests', error.providerRequestPayload);
    }

    if (error.providerResponsePayload) {
      appendRunReplaySnapshotItem(run.id, 'modelResponses', {
        error: error.message,
        provider: providerConfig ? providerConfig.provider : null,
        model: providerConfig ? providerConfig.model : null,
        providerResponsePayload: error.providerResponsePayload
      });
    }

    run = failAgentRun(run, error, error.workspaceAction || null);
  } finally {
    startingRunIds.delete(runId);
    startingLocalModelRunIds.delete(runId);
    runningRunKeys.delete(runExecutionKey(run));
  }
}

// ==================== WORKSPACE PROVIDER ====================

function createLocalWorkspaceProvider(root) {
  const workspaceRoot = path.resolve(root);

  function ensureRoot() {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  }

  function assertRealPathInside(resolvedPath) {
    const realRoot = fs.realpathSync(workspaceRoot);
    let probePath = resolvedPath;

    while (!fs.existsSync(probePath)) {
      const parentPath = path.dirname(probePath);
      if (parentPath === probePath) break;
      probePath = parentPath;
    }

    const realProbe = fs.realpathSync(probePath);
    const relativeRealPath = path.relative(realRoot, realProbe);

    if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
      throw createStructuredWorkspaceError('Path is outside workspace root', 'WORKSPACE_OUTSIDE_ROOT', 'protected_path', {
        path: path.relative(workspaceRoot, resolvedPath)
      });
    }
  }

  function normalizeRelative(inputPath = '', options = {}) {
    const rawPath = String(inputPath || '').trim();

    if (path.isAbsolute(rawPath)) {
      throw createStructuredWorkspaceError('Absolute paths are not allowed', 'WORKSPACE_ABSOLUTE_PATH', 'protected_path', {
        path: rawPath
      });
    }

    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
    const relativePath = normalized === '.' ? '' : normalized;
    const segments = relativePath.split('/').filter(Boolean);

    if (relativePath.startsWith('../') || relativePath === '..' || segments.includes('..')) {
      throw createStructuredWorkspaceError('Path traversal is not allowed', 'WORKSPACE_PATH_TRAVERSAL', 'protected_path', {
        path: rawPath
      });
    }

    if (!options.allowHidden && segments.some(segment => segment.startsWith('.'))) {
      throw createStructuredWorkspaceError('Hidden and system paths are not allowed', 'WORKSPACE_HIDDEN_PATH', 'protected_path', {
        path: rawPath
      });
    }

    return relativePath;
  }

  function resolveInside(inputPath = '', options = {}) {
    ensureRoot();
    const relativePath = normalizeRelative(inputPath, options);
    const resolvedPath = path.resolve(workspaceRoot, relativePath);
    const relativeFromRoot = path.relative(workspaceRoot, resolvedPath);

    if (relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
      throw new Error('Path is outside workspace root');
    }

    assertRealPathInside(resolvedPath);

    return { relativePath, resolvedPath };
  }

  function toWorkspaceEntry(parentRelativePath, dirent) {
    const entryRelativePath = path.posix.join(parentRelativePath, dirent.name);
    return {
      name: dirent.name,
      path: entryRelativePath,
      type: dirent.isDirectory() ? 'folder' : 'file'
    };
  }

  return {
    root: workspaceRoot,

    exists(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      return fs.existsSync(resolved.resolvedPath);
    },

    getPathInfo(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      if (!fs.existsSync(resolved.resolvedPath)) {
        return { exists: false };
      }
      const stat = fs.lstatSync(resolved.resolvedPath);
      const type = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
      let contentHash = null;
      if (stat.isFile()) {
        try {
          const content = fs.readFileSync(resolved.resolvedPath, 'utf8');
          contentHash = crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
          contentHash = null;
        }
      }
      return { exists: true, type, contentHash };
    },

    list(relativePath = '', options = {}) {
      const resolved = resolveInside(relativePath, options);
      const entries = fs.readdirSync(resolved.resolvedPath, { withFileTypes: true })
        .filter(dirent => options.allowHidden || !dirent.name.startsWith('.'))
        .filter(dirent => dirent.isDirectory() || dirent.isFile())
        .map(dirent => toWorkspaceEntry(resolved.relativePath, dirent))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return { path: resolved.relativePath, entries };
    },

    readFile(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);
      let stat;
      try {
        stat = fs.lstatSync(resolved.resolvedPath);
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'readFile', resolved.relativePath);
      }

      if (!stat.isFile()) {
        throw createStructuredWorkspaceError(
          `Path is not a file: ${resolved.relativePath}`,
          'WORKSPACE_PATH_TYPE_CONFLICT',
          'workspace_error',
          {
            operation: 'readFile',
            path: resolved.relativePath,
            expectedType: 'file',
            actualType: stat.isDirectory() ? 'directory' : 'other'
          }
        );
      }

      try {
        return fs.readFileSync(resolved.resolvedPath, 'utf8');
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'readFile', resolved.relativePath);
      }
    },

    writeFile(relativePath, content, options = {}) {
      const resolved = resolveInside(relativePath, options);
      const stat = fs.existsSync(resolved.resolvedPath) ? fs.lstatSync(resolved.resolvedPath) : null;

      if (stat && !stat.isFile()) {
        throw createStructuredWorkspaceError(
          `Path is not a file: ${resolved.relativePath}`,
          'WORKSPACE_PATH_TYPE_CONFLICT',
          'workspace_error',
          {
            operation: 'writeFile',
            path: resolved.relativePath,
            expectedType: 'file',
            actualType: stat.isDirectory() ? 'directory' : 'other'
          }
        );
      }

      try {
        const parentDir = path.dirname(resolved.resolvedPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.writeFileSync(resolved.resolvedPath, String(content || ''), 'utf8');
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'writeFile', resolved.relativePath);
      }
      return { path: resolved.relativePath };
    },

    createFile(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (fs.existsSync(resolved.resolvedPath)) {
        throw new Error('Path already exists');
      }

      fs.mkdirSync(path.dirname(resolved.resolvedPath), { recursive: true });
      fs.writeFileSync(resolved.resolvedPath, '', 'utf8');
      return { path: resolved.relativePath };
    },

    createFolder(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (fs.existsSync(resolved.resolvedPath)) {
        const stat = fs.lstatSync(resolved.resolvedPath);
        if (stat.isDirectory()) {
          return { path: resolved.relativePath, status: 'already_exists_noop' };
        }
        throw createStructuredWorkspaceError('Path already exists and is not a directory', 'WORKSPACE_PATH_TYPE_CONFLICT', 'workspace_error', {
          operation: 'createFolder',
          path: resolved.relativePath,
          expectedType: 'directory',
          actualType: stat.isFile() ? 'file' : 'other'
        });
      }

      try {
        fs.mkdirSync(resolved.resolvedPath, { recursive: false });
      } catch (error) {
        throw createStructuredWorkspaceFsError(error, 'createFolder', resolved.relativePath);
      }
      return { path: resolved.relativePath, status: 'created' };
    },

    rename(relativePath, nextRelativePath, options = {}) {
      const current = resolveInside(relativePath, options);
      const next = resolveInside(nextRelativePath, options);

      if (!fs.existsSync(current.resolvedPath)) {
        throw new Error('Path does not exist');
      }

      if (fs.existsSync(next.resolvedPath)) {
        throw new Error('Destination already exists');
      }

      fs.mkdirSync(path.dirname(next.resolvedPath), { recursive: true });
      fs.renameSync(current.resolvedPath, next.resolvedPath);
      return { path: next.relativePath };
    },

    delete(relativePath, options = {}) {
      const resolved = resolveInside(relativePath, options);

      if (!resolved.relativePath) {
        throw new Error('Cannot delete workspace root');
      }

      if (!fs.existsSync(resolved.resolvedPath)) {
        return { path: resolved.relativePath, status: 'already_missing_noop' };
      }

      fs.rmSync(resolved.resolvedPath, { recursive: true, force: false });
      return { path: resolved.relativePath, status: 'deleted' };
    }
  };
}

const workspaceProvider = createLocalWorkspaceProvider(WORKSPACE_ROOT);

function assertWorkspaceChildPath(fullPath) {
  const relativePath = path.relative(workspaceProvider.root, fullPath);

  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Fixture reset path is outside workspace root');
  }
}

function clearWorkspaceRoot() {
  fs.mkdirSync(workspaceProvider.root, { recursive: true });
  fs.readdirSync(workspaceProvider.root).forEach(entryName => {
    const entryPath = path.join(workspaceProvider.root, entryName);
    assertWorkspaceChildPath(entryPath);
    fs.rmSync(entryPath, { recursive: true, force: false });
  });
}

function writeFixtureFile(relativePath, content) {
  workspaceProvider.writeFile(relativePath, content);
}

function createFixtureFolder(relativePath) {
  workspaceProvider.createFolder(relativePath);
}

function applyWorkspaceFixture(fixtureId) {
  if (!WORKSPACE_FIXTURES.some(fixture => fixture.id === fixtureId)) {
    throw new Error('Unknown workspace fixture');
  }

  clearWorkspaceRoot();

  if (fixtureId === 'empty') return;

  if (fixtureId === 'simple-files') {
    writeFixtureFile('README.md', '# Workspace fixture\n\nUse this file for basic edit tests.\n');
    writeFixtureFile('todo.txt', 'one\ntwo\nthree\n');
    return;
  }

  if (fixtureId === 'nested-folders') {
    createFixtureFolder('src');
    createFixtureFolder('src/components');
    createFixtureFolder('docs');
    writeFixtureFile('src/index.js', 'console.log("fixture");\n');
    writeFixtureFile('src/components/card.txt', 'component placeholder\n');
    writeFixtureFile('docs/notes.md', '# Notes\n');
    return;
  }

  if (fixtureId === 'existing-target-folder') {
    createFixtureFolder('target');
    writeFixtureFile('target/existing.txt', 'existing target content\n');
    writeFixtureFile('source.txt', 'move or copy this into target if requested\n');
    return;
  }

  if (fixtureId === 'conflicting-file-names') {
    writeFixtureFile('report.txt', 'current report\n');
    writeFixtureFile('report-copy.txt', 'existing copy\n');
    createFixtureFolder('archive');
    writeFixtureFile('archive/report.txt', 'archived report\n');
    return;
  }

  if (fixtureId === 'read-only-like') {
    writeFixtureFile('READ_ONLY_NOTICE.txt', 'Treat this fixture as read-only for scenario testing.\n');
    writeFixtureFile('locked-config.json', '{\n  "locked": true\n}\n');
    return;
  }

  if (fixtureId === 'large-file') {
    const lines = Array.from({ length: 1500 }, (_, index) => `Line ${index + 1}: deterministic large fixture content.`);
    writeFixtureFile('large-notes.txt', `${lines.join('\n')}\n`);
    return;
  }

  if (fixtureId === 'many-small-files') {
    createFixtureFolder('items');
    for (let index = 1; index <= 40; index += 1) {
      writeFixtureFile(`items/item-${String(index).padStart(2, '0')}.txt`, `item ${index}\n`);
    }
  }
}

async function resetDebugData(changedBy = 'system') {
  await resetDebugEventState();
  writeFileAtomic(DATA_FILE, '[]');
  writeFileAtomic(RUNS_FILE, '[]');
  writeFileAtomic(LOGS_FILE, '[]');
  writeFileAtomic(ALLOCATION_PLANS_FILE, '[]');
  writeFileAtomic(OPERATION_HISTORY_FILE, '[]');
  clearReplaySnapshotFiles();
  refreshDataDirWriterLockForDebugReset();

  clearWorkspaceRoot();
  runningRunKeys.clear();
  startingRunIds.clear();
  startingLocalModelRunIds.clear();

  appendSystemLog('system:reset', `Debug data reset completed by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString()
  });
}

function viewData(data, userId = null) {
  const permissions = userId ? getUserPermissions(userId) : [];
  return {
    ...data,
    assets: { css: '/styles.css', js: null },
    userPermissions: permissions
  };
}

// ==================== AUTH DECORATORS ====================

fastify.decorate('requireAuth', async function(request, reply) {
  if (!request.session.userId) {
    return reply.redirect('/login');
  }
});

// ==================== HOOKS ====================

fastify.addHook('preHandler', async (request, reply) => {
  if (request.session.userId) {
    const users = readUsers();
    const user = users.find(u => u.id === request.session.userId);
    request.user = user || null;
  }
});

function setupSSEConnection(reply, request, clientSet) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  reply.raw.write('retry: 5000\n\n');
  clientSet.add(reply.raw);
  request.raw.on('close', () => {
    clientSet.delete(reply.raw);
  });
}

// ==================== PUBLIC ROUTES ====================

fastify.get('/login', async (request, reply) => {
  if (request.session.userId) {
    return reply.redirect('/');
  }
  return reply.view('login.ejs', viewData({ error: null, user: null }));
});

fastify.post('/login', async (request, reply) => {
  const { username, password } = request.body;

  if (!username || !password) {
    return reply.view('login.ejs', viewData({ error: 'Username and password are required', user: null }));
  }

  const users = readUsers();
  const user = users.find(u => u.username === username);

  if (!user) {
    return reply.view('login.ejs', viewData({ error: 'Invalid username or password', user: null }));
  }

  const validPassword = await argon2.verify(user.passwordHash, password);

  if (!validPassword) {
    return reply.view('login.ejs', viewData({ error: 'Invalid username or password', user: null }));
  }

  request.session.userId = user.id;
  return reply.redirect('/');
});

fastify.get('/logout', async (request, reply) => {
  request.session.destroy();
  return reply.redirect('/login');
});

// ==================== TICKET ROUTES ====================

fastify.get('/', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    return reply.redirect('/tickets');
  }

  return reply.view('index.ejs', viewData({
    user: request.user,
    agents: readAgents(),
    agentGroups: getTicketAssignableGroups(),
    agentGroupMembers: getAgentGroupMembers(),
    workflows: getEnabledWorkflows(),
    error: null
  }, request.session.userId));
});

// Shared ticket creation. Validates resolved inputs, builds the ticket with a
// normalized execution policy, persists it, emits ticket.created, and routes run
// creation through createRunsForTicket (which enforces the unresolved-triage block,
// the objective clarification/ambiguity gate, and the feasibility gate). Both the
// POST /tickets route and the process-template trigger use this; neither creates
// runs directly. `input` carries already-parsed values (objects, not form strings);
// transport-level JSON parsing stays in the HTTP layer. Returns { ok, ticket, runs }
// or { ok: false, error } so each caller can shape its own response.
function createTicketFromInput(input, actor, options = {}) {
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  const assignmentTargetType = input.assignmentTargetType;

  if (!objective || !assignmentTargetType || input.assignmentTargetId == null || input.assignmentTargetId === '') {
    return { ok: false, error: 'Objective, assignment target type, and assignment target are required' };
  }

  const parsedAssignmentTargetId = parseInt(input.assignmentTargetId, 10);
  if (!['agent', 'group'].includes(assignmentTargetType) || Number.isNaN(parsedAssignmentTargetId)) {
    return { ok: false, error: 'Invalid assignment target' };
  }

  const resolvedAssignmentMode = assignmentTargetType === 'agent' ? 'individual' : input.assignmentMode;
  if (assignmentTargetType === 'group' && !['allocated', 'dynamic'].includes(resolvedAssignmentMode)) {
    return { ok: false, error: 'Group assignments require allocated or dynamic mode' };
  }
  if (assignmentTargetType === 'agent' && !readAgents().some(agent => agent.id === parsedAssignmentTargetId)) {
    return { ok: false, error: 'Selected agent does not exist' };
  }
  if (assignmentTargetType === 'group' && !getTicketAssignableGroups().some(group => group.id === parsedAssignmentTargetId)) {
    return { ok: false, error: 'Selected ticket-capable group does not exist' };
  }

  const resolvedCapabilityType = input.capabilityType === 'workflow' || input.executionMode === 'workflow' ? 'workflow' : 'directAction';
  const resolvedExecutionMode = resolvedCapabilityType === 'workflow' ? 'workflow' : 'agent';
  let selectedWorkflow = null;
  let parsedWorkflowInput = null;

  if (resolvedCapabilityType === 'workflow') {
    if (assignmentTargetType !== 'agent') {
      return { ok: false, error: 'Workflow tickets must be assigned to one agent' };
    }
    selectedWorkflow = getWorkflowById(input.workflowId);
    if (!selectedWorkflow || selectedWorkflow.enabled === false) {
      return { ok: false, error: 'Selected workflow does not exist or is disabled' };
    }
    parsedWorkflowInput = input.workflowInput && typeof input.workflowInput === 'object' && !Array.isArray(input.workflowInput)
      ? input.workflowInput
      : {};
    const inputErrors = validateSchemaValue(selectedWorkflow.inputSchema || {}, parsedWorkflowInput, 'workflow.input');
    if (inputErrors.length > 0) {
      return { ok: false, error: `Workflow input invalid: ${inputErrors.join('; ')}` };
    }
  }

  let parsedOwnedPaths = input.ownedOutputPaths != null ? input.ownedOutputPaths : null;
  if (parsedOwnedPaths != null && (typeof parsedOwnedPaths !== 'object' || Array.isArray(parsedOwnedPaths))) {
    return { ok: false, error: 'Owned output paths must be a mapping of agent ID to path' };
  }

  const tickets = readTickets();
  const now = new Date().toISOString();
  const nextTicketId = nextId(tickets);
  const actorName = actor && actor.username
    ? actor.username
    : (actor && actor.userId != null ? String(actor.userId) : 'system');

  const newTicket = {
    id: nextTicketId,
    objective,
    assignmentTargetType,
    assignmentTargetId: parsedAssignmentTargetId,
    assignmentMode: resolvedAssignmentMode,
    ownedOutputPaths: parsedOwnedPaths,
    executionMode: resolvedExecutionMode,
    workflowId: selectedWorkflow ? selectedWorkflow.id : null,
    workflowInput: selectedWorkflow ? parsedWorkflowInput : null,
    capabilityType: resolvedCapabilityType,
    capabilityId: selectedWorkflow ? selectedWorkflow.id : 'agent-selected-actions',
    capabilityInput: selectedWorkflow ? parsedWorkflowInput : null,
    executionPolicy: normalizeExecutionPolicy(input.executionPolicy, resolvedAssignmentMode === 'individual' ? 'shared' : 'owned_paths'),
    status: 'open',
    createdBy: actorName,
    changedBy: actorName,
    changedAt: now,
    createdAt: now,
    updatedAt: now
  };
  // Optional provenance (e.g. process-template origin). Durable on the ticket;
  // normalizeTickets preserves unknown fields.
  if (options.source && typeof options.source === 'object') {
    newTicket.source = options.source;
  }

  if (newTicket.assignmentMode === 'dynamic') {
    try {
      const agents = getAgentsInGroup(newTicket.assignmentTargetId);
      newTicket.ownedOutputPaths = deriveDynamicOwnedPaths(agents);
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'DYNAMIC_ALLOCATION_ERROR',
        ticketId: newTicket.id,
        assignmentTargetId: newTicket.assignmentTargetId,
        createdBy: newTicket.createdBy
      });
      return { ok: false, error: error.message };
    }
  }

  if (usesOwnedScopeAllocation(newTicket)) {
    try {
      assertAllocatedTicketCanStart(newTicket, getAgentsInGroup(newTicket.assignmentTargetId));
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'VALIDATION_ERROR',
        path: error.path || null,
        assignedAgentId: error.assignedAgentId || null,
        ticketId: newTicket.id,
        assignmentTargetId: newTicket.assignmentTargetId,
        createdBy: newTicket.createdBy
      });
      return { ok: false, error: error.message };
    }
  }

  tickets.push(newTicket);
  writeTickets(tickets);
  appendEvent({
    type: 'ticket.created',
    ticketId: newTicket.id,
    payload: {
      status: newTicket.status,
      assignmentTargetType: newTicket.assignmentTargetType,
      assignmentTargetId: newTicket.assignmentTargetId,
      assignmentMode: newTicket.assignmentMode,
      executionMode: newTicket.executionMode,
      capabilityType: newTicket.capabilityType,
      capabilityId: newTicket.capabilityId,
      workflowId: newTicket.workflowId,
      createdBy: newTicket.createdBy,
      createdAt: newTicket.createdAt,
      ...(newTicket.source ? { source: newTicket.source.type } : {})
    }
  });
  broadcastTicketChange();
  const runs = createRunsForTicket(newTicket, options.delegated || null);

  return { ok: true, ticket: newTicket, runs };
}

fastify.post('/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return 'Permission denied';
  }

  const { objective, assignmentTargetType, assignmentTargetId, assignmentMode, capabilityType, executionMode, workflowId, workflowInput, executionPolicy } = request.body;

  function renderTicketForm(error) {
    reply.code(400);
    return reply.view('index.ejs', viewData({
      user: request.user,
      agents: readAgents(),
      agentGroups: getTicketAssignableGroups(),
      agentGroupMembers: getAgentGroupMembers(),
      workflows: getEnabledWorkflows(),
      error
    }, request.session.userId));
  }

  // Transport-level JSON parsing (form fields arrive as strings). Semantic
  // validation and ticket construction live in the shared createTicketFromInput.
  const isWorkflowTicket = capabilityType === 'workflow' || executionMode === 'workflow';
  let parsedWorkflowInput = null;
  if (isWorkflowTicket) {
    try {
      parsedWorkflowInput = workflowInput && workflowInput.trim() ? JSON.parse(workflowInput) : {};
    } catch (error) {
      return renderTicketForm('Workflow input must be valid JSON');
    }
    if (!parsedWorkflowInput || typeof parsedWorkflowInput !== 'object' || Array.isArray(parsedWorkflowInput)) {
      return renderTicketForm('Workflow input must be a JSON object');
    }
  }

  let parsedOwnedPaths = null;
  if (request.body.ownedOutputPaths) {
    try {
      parsedOwnedPaths = JSON.parse(request.body.ownedOutputPaths);
    } catch (e) {
      return renderTicketForm('Owned output paths must be valid JSON');
    }
  }

  let parsedExecutionPolicy = executionPolicy;
  if (typeof executionPolicy === 'string' && executionPolicy.trim()) {
    try {
      parsedExecutionPolicy = JSON.parse(executionPolicy);
    } catch (error) {
      return renderTicketForm('Execution policy must be valid JSON');
    }
  }
  if (parsedExecutionPolicy !== undefined && parsedExecutionPolicy !== null &&
      (typeof parsedExecutionPolicy !== 'object' || Array.isArray(parsedExecutionPolicy))) {
    return renderTicketForm('Execution policy must be a JSON object');
  }

  const result = createTicketFromInput({
    objective,
    assignmentTargetType,
    assignmentTargetId,
    assignmentMode,
    capabilityType,
    executionMode,
    workflowId,
    workflowInput: parsedWorkflowInput,
    ownedOutputPaths: parsedOwnedPaths,
    executionPolicy: parsedExecutionPolicy
  }, actorFromRequest(request), { delegated: delegatedFromRequest(request, 'created_from_ticket') });

  if (!result.ok) {
    return renderTicketForm(result.error);
  }

  return reply.redirect('/tickets');
});

// ==================== PROCESS TEMPLATE ROUTES ====================
// Manual-trigger-only. Management is gated by processTemplate:manage; triggering is
// gated by ticket:create (the trigger creates an ordinary ticket and must respect
// ticket-creation authority). No scheduled execution, no cross-ticket spawning.
function normalizeProcessTemplateInput(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const tt = body.ticketTemplate && typeof body.ticketTemplate === 'object' && !Array.isArray(body.ticketTemplate)
    ? body.ticketTemplate
    : null;
  return { name, tt };
}

fastify.get('/api/process-templates', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  return { templates: readProcessTemplates() };
});

fastify.post('/api/process-templates', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const { name, tt } = normalizeProcessTemplateInput(request.body || {});
  if (!name) {
    reply.code(400);
    return { error: 'Template name is required' };
  }
  if (!tt) {
    reply.code(400);
    return { error: 'ticketTemplate object is required' };
  }

  const templates = readProcessTemplates();
  const now = new Date().toISOString();
  const actor = actorFromRequest(request);
  const createdBy = actor.username || (actor.userId != null ? String(actor.userId) : 'system');
  const template = {
    id: nextId(templates),
    name,
    enabled: request.body.enabled === false || request.body.enabled === 'false' ? false : true,
    triggerType: 'manual',
    schedule: null,
    // ticketTemplate is RAW reusable ticket input. executionPolicy is stored as
    // provided and is normalized ONLY at trigger time (createTicketFromInput).
    ticketTemplate: {
      objective: typeof tt.objective === 'string' ? tt.objective : '',
      assignmentTargetType: tt.assignmentTargetType,
      assignmentTargetId: tt.assignmentTargetId,
      assignmentMode: tt.assignmentMode || null,
      capabilityType: tt.capabilityType === 'workflow' ? 'workflow' : 'directAction',
      capabilityId: tt.capabilityId || (tt.capabilityType === 'workflow' ? (tt.workflowId || null) : 'agent-selected-actions'),
      workflowId: tt.workflowId || null,
      workflowInput: tt.workflowInput && typeof tt.workflowInput === 'object' && !Array.isArray(tt.workflowInput) ? tt.workflowInput : null,
      ownedOutputPaths: tt.ownedOutputPaths && typeof tt.ownedOutputPaths === 'object' && !Array.isArray(tt.ownedOutputPaths) ? tt.ownedOutputPaths : null,
      executionPolicy: tt.executionPolicy && typeof tt.executionPolicy === 'object' && !Array.isArray(tt.executionPolicy) ? tt.executionPolicy : null
    },
    createdBy,
    createdAt: now,
    updatedAt: now,
    lastTriggeredAt: null
  };
  templates.push(template);
  writeProcessTemplates(templates);
  appendSystemLog('process_template:created', `Process template "${name}" created`, null, {
    templateId: template.id,
    templateName: name,
    createdBy
  });
  return { ok: true, template };
});

fastify.post('/api/process-templates/:id/trigger', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }
  if (template.enabled !== true) {
    reply.code(409);
    return { error: 'Process template is disabled' };
  }

  const body = request.body || {};
  const triggerToken = (typeof body.triggerToken === 'string' && body.triggerToken.trim())
    ? body.triggerToken.trim()
    : crypto.randomUUID();

  // Manual trigger delegates to the shared helper (same logic the scheduler uses).
  // The helper runs synchronously through the trigger-log append (no awaits), so
  // sequential double-submits cannot interleave; a repeated token dedupes.
  const result = triggerProcessTemplate(template, actorFromRequest(request), {
    triggerType: 'manual',
    triggerToken
  });

  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }

  return {
    ok: true,
    deduped: result.deduped,
    ticketId: result.ticketId,
    templateId: template.id,
    triggerToken,
    ...(result.source ? { source: result.source } : {})
  };
});

// Set or clear an interval schedule for a template (the only schedule mode in v1).
// Management requires processTemplate:manage; ENABLING additionally requires
// ticket:create (the schedule will create ordinary tickets as a system actor, so the
// operator setting it must themselves be allowed to create tickets). No cron/RRULE/
// natural-language/daily/timezone parsing — interval seconds in UTC only.
fastify.post('/api/process-templates/:id/schedule', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }

  const body = request.body || {};
  const now = new Date().toISOString();
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (!persisted) {
    reply.code(404);
    return { error: 'Process template not found' };
  }

  const wantEnabled = !(body.enabled === false || body.enabled === 'false');

  if (!wantEnabled) {
    // Disable: stop future scheduled triggers, keep prior trigger history intact.
    persisted.schedule = (persisted.schedule && persisted.schedule.kind === 'interval')
      ? { ...persisted.schedule, enabled: false, nextRunAt: null }
      : null;
    persisted.updatedAt = now;
    writeProcessTemplates(templates);
    appendSystemLog('process_template:schedule_disabled', `Process template "${persisted.name}" schedule disabled`, null, {
      templateId: persisted.id, templateName: persisted.name, changedBy: actorFromRequest(request).username || 'system'
    });
    return { ok: true, schedule: persisted.schedule };
  }

  // Enabling additionally requires ticket:create.
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Enabling a schedule requires ticket:create' };
  }
  const kind = body.kind || 'interval';
  if (kind !== 'interval') {
    reply.code(400);
    return { error: 'Only interval schedules are supported' };
  }
  const everySeconds = parseInt(body.everySeconds, 10);
  if (!Number.isInteger(everySeconds) || everySeconds < MIN_SCHEDULE_EVERY_SECONDS) {
    reply.code(400);
    return { error: `everySeconds must be an integer >= ${MIN_SCHEDULE_EVERY_SECONDS}` };
  }

  const scheduledBy = actorFromRequest(request).username || String(request.session.userId);
  // Re-enabling recomputes nextRunAt FORWARD FROM NOW (anchor = now) so a stale old
  // slot never fires immediately on enable.
  persisted.schedule = {
    enabled: true,
    kind: 'interval',
    everySeconds,
    anchor: now,
    nextRunAt: computeNextRunAt({ everySeconds }, now),
    lastScheduledTriggerAt: null,
    timezone: 'UTC',
    scheduledBy
  };
  persisted.updatedAt = now;
  writeProcessTemplates(templates);
  appendSystemLog('process_template:schedule_set', `Process template "${persisted.name}" scheduled every ${everySeconds}s (UTC) by ${scheduledBy}`, null, {
    templateId: persisted.id, templateName: persisted.name, everySeconds, scheduledBy
  });
  return { ok: true, schedule: persisted.schedule };
});

// Template disable/enable + schedule pause/resume (r1.9). These are thin operator
// controls over the EXISTING enabled gates — they add no new durable state and change
// no scheduler behavior. Disabling a template makes the manual route's existing 409
// and the scheduler's existing `template.enabled` skip reachable; pausing a schedule
// is `schedule.enabled = false` (already skipped by the due filter). None of these
// touch tickets, runs, the trigger ledger, triage, verification, or provenance — they
// only affect FUTURE template-created tickets.
function scheduleHasReusableInterval(schedule) {
  return Boolean(schedule && schedule.kind === 'interval' && Number.isInteger(schedule.everySeconds) && schedule.everySeconds > 0);
}

fastify.post('/api/process-templates/:id/disable', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }
  const now = new Date().toISOString();
  const changedBy = actorFromRequest(request).username || String(request.session.userId);
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (!persisted) { reply.code(404); return { error: 'Process template not found' }; }
  persisted.enabled = false; // idempotent if already false
  persisted.updatedAt = now;
  writeProcessTemplates(templates);
  appendSystemLog('process_template:disabled', `Process template "${persisted.name}" disabled`, null, {
    templateId: persisted.id, templateName: persisted.name, changedBy
  });
  return { ok: true, enabled: false };
});

fastify.post('/api/process-templates/:id/enable', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  // Enabling re-allows manual ticket creation, so it additionally requires ticket:create.
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Enabling a template requires ticket:create' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }
  const now = new Date().toISOString();
  const changedBy = actorFromRequest(request).username || String(request.session.userId);
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (!persisted) { reply.code(404); return { error: 'Process template not found' }; }
  persisted.enabled = true; // idempotent if already true; does NOT create a ticket or change schedule
  persisted.updatedAt = now;
  writeProcessTemplates(templates);
  appendSystemLog('process_template:enabled', `Process template "${persisted.name}" enabled`, null, {
    templateId: persisted.id, templateName: persisted.name, changedBy
  });
  return { ok: true, enabled: true };
});

fastify.post('/api/process-templates/:id/schedule/pause', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }
  if (!scheduleHasReusableInterval(template.schedule)) {
    reply.code(400);
    return { error: 'No reusable interval schedule to pause' };
  }
  const now = new Date().toISOString();
  const changedBy = actorFromRequest(request).username || String(request.session.userId);
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (!persisted) { reply.code(404); return { error: 'Process template not found' }; }
  // Pause = schedule.enabled false, nextRunAt null. Interval config is preserved so
  // Resume can restore it without re-entering everySeconds. Idempotent if already paused.
  persisted.schedule = { ...persisted.schedule, enabled: false, nextRunAt: null };
  persisted.updatedAt = now;
  writeProcessTemplates(templates);
  appendSystemLog('process_template:schedule_paused', `Process template "${persisted.name}" schedule paused`, null, {
    templateId: persisted.id, templateName: persisted.name, changedBy
  });
  return { ok: true, schedule: persisted.schedule };
});

fastify.post('/api/process-templates/:id/schedule/resume', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  // Resuming re-enables future scheduled ticket creation, so it additionally requires ticket:create.
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Resuming a schedule requires ticket:create' };
  }
  const template = getProcessTemplateById(request.params.id);
  if (!template) {
    reply.code(404);
    return { error: 'Process template not found' };
  }
  if (!scheduleHasReusableInterval(template.schedule)) {
    reply.code(400);
    return { error: 'No reusable interval schedule to resume' };
  }
  const now = new Date().toISOString();
  const changedBy = actorFromRequest(request).username || String(request.session.userId);
  const templates = readProcessTemplates();
  const persisted = templates.find(item => item.id === template.id);
  if (!persisted) { reply.code(404); return { error: 'Process template not found' }; }
  // Resume = enable + recompute nextRunAt FORWARD FROM NOW (no catch-up, no stale slot,
  // no immediate ticket — the next scan one interval later creates the first ticket).
  // Reuses stored kind/everySeconds/timezone/scheduledBy/lastScheduledTriggerAt.
  persisted.schedule = {
    ...persisted.schedule,
    enabled: true,
    nextRunAt: computeNextRunAt(persisted.schedule, now)
  };
  persisted.updatedAt = now;
  writeProcessTemplates(templates);
  appendSystemLog('process_template:schedule_resumed', `Process template "${persisted.name}" schedule resumed`, null, {
    templateId: persisted.id, templateName: persisted.name, changedBy
  });
  return { ok: true, schedule: persisted.schedule };
});

// Run one scheduled-template scan now. Same bounded due-scan the interval scheduler
// runs (no catch-up, at most one trigger per due template). Gated by
// processTemplate:manage; this is a "scan due schedules now" control, not a new
// execution primitive — it only creates tickets through triggerProcessTemplate.
fastify.post('/api/process-templates/scheduler/tick', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  const results = runtimeTemplateScheduler ? runtimeTemplateScheduler.tick() : [];
  return { ok: true, results };
});

fastify.get('/process-templates', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'processTemplate:manage')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  // Pure read: derive operator-facing state from existing stores. Nothing here
  // triggers a schedule, creates a ticket/run, mutates the workspace, or writes logs.
  const templates = readProcessTemplates();
  const triggers = readProcessTemplateTriggers();
  const tickets = readTickets();
  const derivedById = new Map(
    deriveProcessTemplateState(templates, triggers, tickets, Date.now()).map(row => [row.templateId, row])
  );

  return reply.view('process-templates.ejs', viewData({
    user: request.user,
    templates: templates.map(template => ({
      ...template,
      ...(derivedById.get(template.id) || {})
    })),
    canTrigger: hasPermission(request.session.userId, 'ticket:create')
  }, request.session.userId));
});

fastify.get('/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return 'Permission denied';
  }

  const ticketPage = getPaginatedTickets(request.query || {});

  return renderCachedView(request, reply, 'tickets.ejs', viewData({
    tickets: ticketPage.tickets,
    pagination: ticketPage.pagination,
    user: request.user,
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update'),
    agents: readAgents(),
    ticketStatuses: TICKET_STATUSES
  }, request.session.userId));
});

fastify.get('/tickets/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const ticketId = parseInt(request.params.id, 10);

  if (Number.isNaN(ticketId)) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Ticket not found',
      user: request.user
    }, request.session.userId));
  }

  const ticket = readTickets().find(item => item.id === ticketId);

  if (!ticket) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Ticket not found',
      user: request.user
    }, request.session.userId));
  }

  const allocationPlan = getTicketAllocationPlan(ticketId);
  const history = readOperationHistory();
  const ticketRuns = getTicketRuns(ticketId, history);
  const agents = readAgents();
  const operationHistory = getOperationHistoryForTicket(ticketId, history);
  const activeRuntimeRun = ticketRuns
    .filter(run => ['pending', 'running'].includes(run.status))
    .sort((a, b) => new Date(b.updatedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.startedAt || a.createdAt || 0))[0] || null;
  const latestRuntimeRun = ticketRuns
    .slice()
    .sort((a, b) => new Date(b.updatedAt || b.completedAt || b.startedAt || b.createdAt || 0) - new Date(a.updatedAt || a.completedAt || a.startedAt || a.createdAt || 0))[0] || null;
  const visibleRuntimeRun = activeRuntimeRun || latestRuntimeRun;
  const runStateInconsistency = visibleRuntimeRun
    ? detectRunStateInconsistency(visibleRuntimeRun, {
      logs: readLogs().filter(log => log.runId === visibleRuntimeRun.id),
      replaySnapshot: readRunReplaySnapshot(visibleRuntimeRun) || visibleRuntimeRun.replaySnapshot || null
    })
    : null;

  const executionState = buildTicketExecutionState(ticket, ticketRuns, allocationPlan, agents, readGroups());

  // Review status for the latest terminal run — separates "did it finish" from
  // "does the result need a look". Derived from existing evidence signals only.
  let reviewStatus = { applicable: false, needsReview: false, reasons: [] };
  if (latestRuntimeRun) {
    const latestSnapshot = readRunReplaySnapshot(latestRuntimeRun) || latestRuntimeRun.replaySnapshot || null;
    const latestComparison = buildArtifactPredictionComparison(latestRuntimeRun, latestSnapshot, history, readWorkflows());
    reviewStatus = buildRunReviewStatus(latestRuntimeRun, {
      objectivePathCoverage: buildObjectivePathCoverage(ticket, latestSnapshot),
      artifactAccuracy: buildArtifactAccuracy(latestSnapshot, latestComparison),
      comparison: latestComparison
    });
  }

  return renderCachedView(request, reply, 'ticket-detail.ejs', viewData({
    user: request.user,
    ticket,
    allocationPlan,
    ticketRuns,
    agents,
    artifacts: buildTicketArtifacts(operationHistory, readWorkflows(), ticketRuns),
    recentLogs: getRecentLogsForTicket(ticketId),
    operationHistory: enrichOperationHistoryForDisplay(operationHistory),
    runStateInconsistency,
    executionState,
    reviewStatus,
    attemptSummary: buildTicketAttemptSummary(ticketRuns),
    budgetSummary: buildTicketBudgetSummary(ticketRuns),
    latestTriage: latestRuntimeRun ? normalizeTriage(latestRuntimeRun.triage) : null,
    latestRuntimeRunId: latestRuntimeRun ? latestRuntimeRun.id : null,
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update')
  }, request.session.userId));
});

fastify.get('/api/health', async (request, reply) => {
   return { status: 'ok', dataDir: DATA_DIR, workspaceRoot: workspaceProvider.root, port: PORT, uptime: Math.floor(process.uptime()) };
});

fastify.get('/api/runtime/status', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  return getRuntimeStatusSnapshot();
});

fastify.get('/api/tickets', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  return {
    ...getPaginatedTickets(request.query || {}),
    canUpdateTickets: hasPermission(request.session.userId, 'ticket:update'),
    agents: readAgents().map(agent => ({ id: agent.id, name: agent.name })),
    ticketStatuses: TICKET_STATUSES
  };
});

fastify.get('/api/tickets/:id/runtime', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);

  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const runtimeState = serializeTicketRuntimeState(ticketId);

  if (!runtimeState) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  return runtimeState;
});

fastify.post('/api/tickets/shape-objective', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:create')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    return await suggestBoundedTicketObjective(request.body || {});
  } catch (error) {
    reply.code(error.statusCode || 400);
    return { error: error.message || 'Ticket shaping failed' };
  }
});

fastify.patch('/api/tickets/:id/assignment', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  const agentId = parseInt(request.body && request.body.agentId, 10);
  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);
  const agent = readAgents().find(item => item.id === agentId);

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  if (!agent) {
    reply.code(400);
    return { error: 'Agent not found' };
  }

  const assignmentChanged = (
    ticket.assignmentTargetType !== 'agent' ||
    ticket.assignmentTargetId !== agent.id ||
    ticket.assignmentMode !== 'individual'
  );

  if (ticket.status !== 'open' && assignmentChanged) {
    reply.code(400);
    return { error: 'Only open tickets can be assigned to an agent run' };
  }

  let assignmentAudit = null;

  if (assignmentChanged) {
    const changedBy = request.user ? request.user.username : String(request.session.userId);
    const changedAt = new Date().toISOString();
    const previousAssignment = {
      assignmentTargetType: ticket.assignmentTargetType,
      assignmentTargetId: ticket.assignmentTargetId,
      assignmentMode: ticket.assignmentMode
    };

    ticket.assignmentTargetType = 'agent';
    ticket.assignmentTargetId = agent.id;
    ticket.assignmentMode = 'individual';
    ticket.updatedAt = changedAt;
    ticket.changedBy = changedBy;
    ticket.changedAt = changedAt;
    writeTickets(tickets);
    const nextAssignment = {
      assignmentTargetType: ticket.assignmentTargetType,
      assignmentTargetId: ticket.assignmentTargetId,
      assignmentMode: ticket.assignmentMode
    };
    assignmentAudit = { changedBy, changedAt };
    appendEvent({
      type: 'ticket.updated',
      ticketId: ticket.id,
      payload: {
        status: ticket.status,
        assignmentTargetType: ticket.assignmentTargetType,
        assignmentTargetId: ticket.assignmentTargetId,
        assignmentMode: ticket.assignmentMode,
        updatedAt: ticket.updatedAt,
        changedBy,
        changedAt
      }
    });
    appendSystemLog('ticket:assignment_change', `Ticket #${ticket.id} assignment changed by ${changedBy}`, null, {
      ticketId: ticket.id,
      changedBy,
      changedAt,
      previousAssignment,
      nextAssignment
    });
    broadcastTicketChange();
  }

  createRunsForTicket(ticket, delegatedFromRequest(request, 'assignment_change_auto_run'));

  if (assignmentAudit) {
    const updatedTickets = readTickets();
    const updatedTicket = updatedTickets.find(item => item.id === ticket.id);
    if (updatedTicket) {
      updatedTicket.changedBy = assignmentAudit.changedBy;
      updatedTicket.changedAt = assignmentAudit.changedAt;
      updatedTicket.updatedAt = assignmentAudit.changedAt;
      writeTickets(updatedTickets);
    }
  }

  return { ticket };
});

fastify.get('/api/tickets/events', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  setupSSEConnection(reply, request, ticketEventClients);
});

fastify.patch('/api/tickets/:id/status', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  const { status } = request.body || {};

  if (Number.isNaN(ticketId) || !TICKET_STATUSES.includes(status)) {
    reply.code(400);
    return { error: 'Invalid ticket status' };
  }

  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  if (ticket.status === status) {
    return { ticket };
  }

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  const changedAt = new Date().toISOString();

  if (status === 'completed') {
    const completionCheck = validateManualTicketCompletion(ticket);
    if (!completionCheck.allowed) {
      reply.code(409);
      return { error: completionCheck.reason };
    }
  }

  if (status === 'open' && usesOwnedScopeAllocation(ticket)) {
    try {
      assertAllocatedTicketCanStart({
        ...ticket,
        status,
        updatedAt: changedAt
      }, getAgentsInGroup(ticket.assignmentTargetId));
    } catch (error) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'VALIDATION_ERROR',
        path: error.path || null,
        assignedAgentId: error.assignedAgentId || null,
        ticketId: ticket.id,
        assignmentTargetId: ticket.assignmentTargetId,
        changedBy,
        changedAt
      });
      reply.code(400);
      return { error: error.message || 'Owned-scope execution rejected' };
    }
  }

  const previousStatus = ticket.status;
  ticket.status = status;
  ticket.updatedAt = changedAt;
  ticket.changedBy = changedBy;
  ticket.changedAt = changedAt;
  writeTickets(tickets);
  broadcastTicketChange();

  if (status === 'closed') {
    readRuns()
      .filter(run => run.ticketId === ticketId && ['pending', 'running'].includes(run.status))
      .forEach(run => interruptAgentRun(run, `${changedBy} closed ticket #${ticketId}`));
  }

  appendSystemLog('ticket:status_change', `Ticket #${ticketId} status changed from ${previousStatus} to ${status} by ${changedBy}`, null, {
    ticketId,
    changedBy,
    changedAt,
    fromStatus: previousStatus,
    toStatus: status
  });

  if (status === 'open') {
    try {
      createRunsForTicket(ticket, delegatedFromRequest(request, 'reopen_auto_run'));
    } catch (error) {
      ticket.status = 'failed';
      ticket.updatedAt = changedAt;
      writeTickets(tickets);
      broadcastTicketChange();
      reply.code(400);
      return { error: error.message || 'Owned-scope execution rejected' };
    }
  }

  return { ticket };
});

fastify.post('/api/tickets/:id/rerun', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);

  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const mode = request.body && request.body.mode === 'reassess' ? 'reassess' : 'retry';
  const changedBy = request.user ? request.user.username : 'operator';
  let ticket = null;

  const rerunGateTicket = readTickets().find(item => item.id === ticketId);
  if (rerunGateTicket) {
    if (hasUnresolvedTicketTriage(rerunGateTicket)) {
      reply.code(409);
      return { error: 'Cannot rerun: unresolved ticket-level triage exists on this ticket. Resolve triage first.' };
    }
    const rerunCheck = validateManualRerun(rerunGateTicket);
    if (!rerunCheck.allowed) {
      reply.code(409);
      return { error: rerunCheck.reason };
    }
  }

  try {
    ticket = rerunTicketFromBeginning(ticketId, changedBy, mode, delegatedFromRequest(request, 'manual_rerun'));
  } catch (error) {
    const statusCode = error.statusCode || 400;
    if (statusCode !== 409) {
      appendSystemLog('allocation:setup_failed', error.message, null, {
        code: error.code || 'VALIDATION_ERROR',
        path: error.path || null,
        assignedAgentId: error.assignedAgentId || null,
        ticketId,
        changedBy,
        changedAt: new Date().toISOString()
      });
    }
    reply.code(statusCode);
    return { error: error.message || 'Ticket rerun rejected' };
  }

  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  return { ticket };
});

// Agent behavior simulation — dry-run the model plan without mutating state or
// creating runs. Gate-only mode (includeModelPlan=false) requires ticket:read and
// returns just the clarification gate verdict. Model-plan mode
// (includeModelPlan=true) requires ticket:update and calls the model for a
// simulated action proposal without executing anything.
fastify.post('/api/tickets/:id/simulate-plan', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const includeModelPlan = request.body && request.body.includeModelPlan === true;
  const requiredPermission = includeModelPlan ? 'ticket:update' : 'ticket:read';
  if (!hasPermission(request.session.userId, requiredPermission)) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);
  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  const gateResult = runObjectiveClarificationGate(ticket.objective, ticket);

  const result = {
    ticketId: ticket.id,
    objective: ticket.objective,
    gateVerdict: gateResult.verdict,
    reasonCode: gateResult.reasonCode || null,
    requiredDecision: gateResult.requiredDecision || null,
    gateSummary: gateResult.summary || null,
    ambiguityPatterns: gateResult.ambiguityPatterns || null,
    modelCalled: false,
    productionRunCreated: false,
    workspaceMutated: false,
    actionsExecuted: 0,
    actionsProposed: [],
    validationFindings: []
  };

  if (includeModelPlan && ticket.assignmentTargetType === 'agent') {
    const agent = readAgents().find(a => a.id === ticket.assignmentTargetId);
    if (agent && agent.provider) {
      const runtimeEnvelope = buildSimulationRuntimeEnvelope(ticket, agent);
      const input = buildAgentPrompt(ticket, runtimeEnvelope, [], null, null);

      let modelResponse;
      try {
        modelResponse = await callModelProvider(agent, input, { simulation: true, timeout: 30000 });
      } catch (modelError) {
        result.modelCalled = true;
        result.modelError = modelError.message || 'Model call failed';
        appendSystemLog('ticket:simulation_plan', `Ticket #${ticket.id} simulation model call failed: ${result.modelError}`, null, {
          contextTicketId: ticket.id,
          gateVerdict: gateResult.verdict,
          modelCalled: true,
          productionRunCreated: false,
          workspaceMutated: false,
          actionsExecuted: 0,
          actionsProposed: 0,
          validationFindings: 0
        });
        return result;
      }

      const rawText = modelResponse.text || '';
      result.modelCalled = true;
      result.rawModelResponse = rawText;

      const parsed = parseModelActions(rawText);
      if (parsed.parseError) {
        result.parseError = parsed.parseError;
      } else {
        result.actionsProposed = parsed.actions || [];
        result.modelMessage = parsed.message || '';
        result.modelComplete = parsed.complete;
        result.validationFindings = validateWorkspaceActionBatch(parsed.actions);
      }
    }
  }

  appendSystemLog('ticket:simulation_plan', `Ticket #${ticket.id} simulation plan${includeModelPlan ? ' with model call' : ' (gate only)'}`, null, {
    contextTicketId: ticket.id,
    gateVerdict: gateResult.verdict,
    modelCalled: result.modelCalled,
    productionRunCreated: false,
    workspaceMutated: false,
    actionsExecuted: 0,
    actionsProposed: Array.isArray(result.actionsProposed) ? result.actionsProposed.length : 0,
    validationFindings: Array.isArray(result.validationFindings) ? result.validationFindings.length : 0
  });

  return result;
});

// Narrowly-scoped operator control to set/clear ONLY ticket.executionPolicy.maxAttempts
// (the one field enforced for manual rerun-from-start). Every other policy field is
// preserved. This edits no runs and creates no runs — it only updates the ticket's
// recorded ceiling, which the manual rerun guard reads fresh on future rerun attempts.
// No domain event is appended: executionPolicy is not part of the event-sourced ticket
// projection (ticket.created payloads omit it and the rebuilder never reconstructs it),
// so tickets.json is authoritative for policy. We persist + write a system-log audit
// entry, consistent with how the ticket record already stores policy.
fastify.post('/api/tickets/:id/execution-policy/max-attempts', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const raw = request.body ? request.body.maxAttempts : undefined;
  let nextValue;
  if (raw === null || raw === '' || (typeof raw === 'string' && raw.trim().toLowerCase() === 'clear')) {
    nextValue = null; // clear → unlimited
  } else if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw <= 0) {
      reply.code(400);
      return { error: 'maxAttempts must be a positive integer, or empty/clear for unlimited' };
    }
    nextValue = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const parsed = parseInt(raw.trim(), 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      reply.code(400);
      return { error: 'maxAttempts must be a positive integer, or empty/clear for unlimited' };
    }
    nextValue = parsed;
  } else {
    reply.code(400);
    return { error: 'maxAttempts must be a positive integer, or empty/clear for unlimited' };
  }

  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);
  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  const previousValue = ticket.executionPolicy ? ticket.executionPolicy.maxAttempts : null;
  // Preserve every other executionPolicy field; change only maxAttempts.
  ticket.executionPolicy = { ...ticket.executionPolicy, maxAttempts: nextValue };
  ticket.updatedAt = new Date().toISOString();
  writeTickets(tickets);
  broadcastTicketChange();
  appendSystemLog('ticket:max_attempts_change', `Ticket #${ticketId} maxAttempts changed from ${previousValue === null ? 'unlimited' : previousValue} to ${nextValue === null ? 'unlimited' : nextValue} by ${changedBy}`, null, {
    ticketId,
    changedBy,
    changedAt: ticket.updatedAt,
    fromMaxAttempts: previousValue,
    toMaxAttempts: nextValue
  });

  return { ticket, maxAttempts: nextValue };
});

// Human triage resolution: an operator annotation that marks an existing REQUIRED
// triage record as resolved/acknowledged. This NEVER reruns, completes, fails,
// retries, or modifies workspace/run state — it only flips triage.required to false
// and records who/when/why. Original reasonCode/summary/requiredDecision/
// evidenceRefs/allowed/prohibited actions are preserved. No allowedAction is
// performed. Replay/execution evidence is untouched (this is a triage annotation,
// not a change to the run record's execution snapshot).
function resolveTriageRecord(triage, resolvedBy, resolution) {
  return {
    ...triage,
    required: false,
    resolvedAt: new Date().toISOString(),
    resolvedBy,
    resolution
  };
}
function readTriageResolutionInput(request) {
  const raw = request.body ? request.body.resolution : undefined;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'A non-empty resolution note is required' };
  }
  return { resolution: raw.trim() };
}

fastify.post('/api/tickets/:id/triage/resolve', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const ticketId = parseInt(request.params.id, 10);
  if (Number.isNaN(ticketId)) {
    reply.code(400);
    return { error: 'Invalid ticket id' };
  }

  const parsed = readTriageResolutionInput(request);
  if (parsed.error) {
    reply.code(400);
    return { error: parsed.error };
  }

  const tickets = readTickets();
  const ticket = tickets.find(item => item.id === ticketId);
  if (!ticket) {
    reply.code(404);
    return { error: 'Ticket not found' };
  }
  if (!ticket.triage || ticket.triage.required !== true) {
    reply.code(409);
    return { error: 'No required ticket-level triage to resolve' };
  }

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  ticket.triage = resolveTriageRecord(ticket.triage, changedBy, parsed.resolution);
  ticket.updatedAt = new Date().toISOString();
  writeTickets(tickets);
  broadcastTicketChange();
  appendSystemLog('ticket:triage_resolve', `Ticket #${ticketId} ticket-level triage resolved by ${changedBy}`, null, {
    ticketId,
    changedBy,
    changedAt: ticket.updatedAt,
    reasonCode: ticket.triage.reasonCode,
    resolution: parsed.resolution
  });

  return { ticket, triage: ticket.triage };
});

fastify.post('/api/runs/:id/triage/resolve', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);
  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  const parsed = readTriageResolutionInput(request);
  if (parsed.error) {
    reply.code(400);
    return { error: parsed.error };
  }

  const runs = readRuns();
  const run = runs.find(item => item.id === runId);
  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }
  if (!run.triage || run.triage.required !== true) {
    reply.code(409);
    return { error: 'No required run-level triage to resolve' };
  }

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  run.triage = resolveTriageRecord(run.triage, changedBy, parsed.resolution);
  run.updatedAt = new Date().toISOString();
  writeRuns(runs);
  appendSystemLog('run:triage_resolve', `Run #${runId} triage resolved by ${changedBy}`, null, {
    runId,
    ticketId: run.ticketId,
    changedBy,
    changedAt: run.updatedAt,
    reasonCode: run.triage.reasonCode,
    resolution: parsed.resolution
  });

  return { run: { id: run.id, ticketId: run.ticketId, status: run.status, triage: run.triage }, triage: run.triage };
});

// ==================== RECOVERY ROUTES ====================

fastify.get('/api/operations/:id/recovery-preview', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const recordId = parseInt(request.params.id, 10);

  if (Number.isNaN(recordId)) {
    reply.code(400);
    return { error: 'Invalid operation history id' };
  }

  const record = findOperationHistoryRecord(recordId);

  if (!record) {
    reply.code(404);
    return { error: 'Operation history record not found' };
  }

  try {
    const preview = previewRecovery(record);
    return { preview };
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Recovery preview failed' };
  }
});

fastify.post('/api/operations/:id/recover', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const recordId = parseInt(request.params.id, 10);
  const { confirmed } = request.body || {};

  if (Number.isNaN(recordId)) {
    reply.code(400);
    return { error: 'Invalid operation history id' };
  }

  const record = findOperationHistoryRecord(recordId);

  if (!record) {
    reply.code(404);
    return { error: 'Operation history record not found' };
  }

  try {
    const recoveryRecord = executeRecovery(record, confirmed === true);
    const changedBy = request.user ? request.user.username : String(request.session.userId);
    appendSystemLog('workspace:recovery', `Recovered operation history #${recordId} as #${recoveryRecord.id} by ${changedBy}`, {
      operation: 'recovery',
      args: { originalHistoryId: recordId, recoveryHistoryId: recoveryRecord.id }
    }, {
      changedBy,
      changedAt: new Date().toISOString()
    });
    return { recovery: recoveryRecord };
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Recovery failed' };
  }
});

// ==================== LOG ROUTES ====================

function getLogFilters(query = {}) {
  const runId = query.runId !== undefined ? parseInt(query.runId, 10) : null;
  const ticketId = query.ticketId !== undefined ? parseInt(query.ticketId, 10) : null;
  return {
    runId: Number.isInteger(runId) ? runId : null,
    ticketId: Number.isInteger(ticketId) ? ticketId : null
  };
}

function filterLogsForQuery(logs, query = {}) {
  const filters = getLogFilters(query);
  return logs.filter(log => {
    if (filters.runId !== null && log.runId !== filters.runId) return false;
    if (filters.ticketId !== null && log.ticketId !== filters.ticketId) return false;
    return true;
  });
}

function formatDisplayTimestamp(timestamp) {
  if (!timestamp) return '-';
  const match = String(timestamp).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
  if (!match) return timestamp;
  const [, year, month, day, hour, minute, second] = match;
  return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
}

function getPagination(query = {}, defaultLimit = 50) {
  const page = parseInt(query.page || '1', 10);
  const limit = parseInt(query.limit || String(defaultLimit), 10);
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : defaultLimit
  };
}

function logsPageHref(filters, page, limit) {
  const params = new URLSearchParams();
  if (filters.runId !== null) params.set('runId', String(filters.runId));
  if (filters.ticketId !== null) params.set('ticketId', String(filters.ticketId));
  params.set('page', String(page));
  params.set('limit', String(limit));
  return `/logs?${params.toString()}`;
}

function getPaginatedLogs(query = {}) {
  const filters = getLogFilters(query);
  const { page, limit } = getPagination(query);
  const logs = readLogs();
  const matchesFilter = log => {
    if (filters.runId !== null && log.runId !== filters.runId) return false;
    if (filters.ticketId !== null && log.ticketId !== filters.ticketId) return false;
    return true;
  };
  let total = 0;

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    if (matchesFilter(logs[index])) total += 1;
  }

  const pageCount = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, pageCount);
  const offset = (currentPage - 1) * limit;
  const pageLogs = [];
  let matched = 0;

  for (let index = logs.length - 1; index >= 0 && pageLogs.length < limit; index -= 1) {
    const log = logs[index];
    if (!matchesFilter(log)) continue;
    if (matched >= offset) {
      pageLogs.push({
        ...log,
        displayTimestamp: formatDisplayTimestamp(log.timestamp)
      });
    }
    matched += 1;
  }

  return {
    logs: sanitizeWorkspaceDisplayValue(pageLogs),
    filters,
    pagination: {
      page: currentPage,
      limit,
      total,
      pageCount,
      start: total === 0 ? 0 : offset + 1,
      end: Math.min(offset + pageLogs.length, total),
      previousHref: currentPage > 1 ? logsPageHref(filters, currentPage - 1, limit) : null,
      nextHref: currentPage < pageCount ? logsPageHref(filters, currentPage + 1, limit) : null
    }
  };
}

fastify.get('/logs', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const logPage = getPaginatedLogs(request.query || {});
  return renderCachedView(request, reply, 'logs.ejs', viewData({
    user: request.user,
    logs: logPage.logs,
    filters: logPage.filters,
    pagination: logPage.pagination
  }, request.session.userId));
});

// Read-only operator triage inbox. Lists unresolved ticket-level and run-level
// triage so an operator can see what needs attention and navigate to the existing
// ticket/run detail pages (where the existing resolve controls already live). This
// page only reads JSON state — it never resolves, reruns, creates runs, or mutates
// any ticket/run.
fastify.get('/triage', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const tickets = readTickets();
  const ticketById = new Map(tickets.map(ticket => [ticket.id, ticket]));

  const ticketTriageItems = tickets
    .filter(ticket => ticket.triage && ticket.triage.required === true)
    .map(ticket => ({
      ticketId: ticket.id,
      objective: ticket.objective,
      ticketStatus: ticket.status,
      triage: ticket.triage
    }));

  const runTriageItems = readRuns()
    .filter(run => run.triage && run.triage.required === true)
    .map(run => {
      const ticket = ticketById.get(run.ticketId) || null;
      return {
        runId: run.id,
        runStatus: run.status,
        ticketId: run.ticketId,
        ticketObjective: ticket ? ticket.objective : null,
        ticketStatus: ticket ? ticket.status : null,
        triage: run.triage
      };
    });

  return renderCachedView(request, reply, 'triage.ejs', viewData({
    user: request.user,
    ticketTriageItems,
    runTriageItems
  }, request.session.userId));
});

fastify.get('/api/logs', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const logPage = getPaginatedLogs(request.query || {});
  return {
    logs: logPage.logs,
    filters: logPage.filters,
    pagination: logPage.pagination
  };
});

fastify.get('/api/export', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }
  return {
    tickets: readTickets(),
    runs: sanitizeWorkspaceDisplayValue(readRuns().map(hydrateRunReplaySnapshot)),
    logs: sanitizeWorkspaceDisplayValue(readLogs()),
    history: sanitizeWorkspaceDisplayValue(readOperationHistory()),
    plans: sanitizeWorkspaceDisplayValue(readAllocationPlans())
  };
});

fastify.get('/api/logs/events', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  setupSSEConnection(reply, request, logEventClients);
});

const DIAGNOSTIC_APP_VERSION = (() => {
  try { return require('./package.json').version || 'unavailable'; } catch (_) { return 'unavailable'; }
})();

// Render one workspace operation record into a single readable diagnostic line.
// A record's `operation` field is the parseWorkspaceOperation object
// ({ operation, args }) or the richer error.workspaceAction object — never a bare
// string — so this reads the nested fields instead of stringifying the object
// (which produced "[object Object]"). Uses only the actual record fields.
function formatDiagnosticWorkspaceOperation(record, index) {
  const opObj = record && record.operation;
  const opName = opObj && typeof opObj === 'object'
    ? (opObj.operation || 'unknown')
    : (typeof opObj === 'string' && opObj ? opObj : 'unknown');
  const args = opObj && typeof opObj === 'object' && opObj.args && typeof opObj.args === 'object' ? opObj.args : null;
  let pathVal = null;
  if (args && args.path !== undefined && args.path !== null) pathVal = args.path;
  else if (opObj && typeof opObj === 'object' && opObj.path !== undefined && opObj.path !== null) pathVal = opObj.path;
  else if (record && record.result && record.result.path !== undefined && record.result.path !== null) pathVal = record.result.path;
  const pathDisplay = pathVal === null ? 'unavailable' : (pathVal === '' ? '""' : pathVal);
  const status = record && record.error ? 'error' : (record && record.blocked ? 'blocked' : 'ok');
  let line = `- [${index}] ${opName} path=${pathDisplay} status=${status}`;
  if (record && record.blocked) line += ' blocked=true';
  if (record && record.reason) line += ' reason=' + record.reason;
  const nextPath = (args && args.nextPath !== undefined && args.nextPath !== null) ? args.nextPath
    : (opObj && typeof opObj === 'object' && opObj.nextPath !== undefined && opObj.nextPath !== null ? opObj.nextPath : null);
  if (nextPath !== null) line += ' nextPath=' + nextPath;
  if (record && record.historyId !== undefined && record.historyId !== null) line += ' historyId=' + record.historyId;
  if (record && record.error) line += ' error=' + record.error;
  return line;
}

// Build a single copyable Markdown diagnostic bundle for a run. Display/debug only:
// it reads already-computed run-detail data plus a few read-only lookups, writes
// nothing, and changes no runtime behavior. It never includes provider API keys,
// session cookies, password hashes, auth tokens, or environment secrets.
function buildRunDiagnosticBundle(ctx) {
  const {
    run, ticket, agent, snapshot, authorityContext, failureSummary,
    operationHistory, permissionedDeleteAuditEvents, completionSummary,
    eventSummary, recentLogs, artifactPredictionComparison, artifactAccuracy,
    objectiveSuccess, operationalOutcome, partialMutationCount,
    generatedAt, route
  } = ctx;

  const lines = [];
  const out = (s = '') => lines.push(s);
  const dash = v => (v === null || v === undefined || v === '') ? 'unavailable' : v;
  const j = v => { try { return JSON.stringify(v, null, 2); } catch (_) { return 'unavailable'; } };

  const s = snapshot || {};
  const fs2 = failureSummary || {};
  const history = Array.isArray(operationHistory) ? operationHistory : [];
  const opPath = op => (op && (op.path != null ? op.path : (op.args && op.args.path))) || null;

  // Canonical replay event list: snapshot.events is what the runtime records;
  // snapshot.replayEvents is a legacy/empty fallback. Reporting must agree with
  // the raw snapshot, so prefer .events.
  const replayEvents = Array.isArray(s.events)
    ? s.events
    : (Array.isArray(s.replayEvents) ? s.replayEvents : []);
  const evType = e => String((e && (e.type || e.kind)) || '');
  const phaseViolationCount = replayEvents.filter(e => evType(e) === 'execution.phase_violation').length;
  const modelStallCount = replayEvents.filter(e => evType(e) === 'model:stalled').length;
  const stepLimitCount = replayEvents.filter(e => evType(e) === 'run:step_limit').length;

  // Model-proposed actions (what the model asked for) are distinct from
  // runtime-accepted workspace operations (what the runtime actually executed) and
  // from committed mutations (what changed the workspace).
  const parsedModelPlans = Array.isArray(s.parsedModelPlans) ? s.parsedModelPlans : [];
  const proposedActions = [];
  parsedModelPlans.forEach(plan => {
    (Array.isArray(plan && plan.actions) ? plan.actions : []).forEach(a => {
      proposedActions.push({
        step: plan && plan.step != null ? plan.step : null,
        operation: a && a.operation ? a.operation : null,
        path: a && a.args && a.args.path !== undefined ? a.args.path : null
      });
    });
  });
  const proposedCount = proposedActions.length;
  const proposedMutatingCount = proposedActions.filter(a => a.operation && AGENT_MUTATING_OPERATIONS.includes(a.operation)).length;

  const workspaceOps = Array.isArray(s.workspaceOperations) ? s.workspaceOperations : [];
  const committedCount = typeof partialMutationCount === 'number'
    ? partialMutationCount
    : history.filter(h => h && !h.error).length;
  const runtimeAcceptedCount = workspaceOps.length;

  // Delegated authority + permission resolution. Distinguish the in-code constant
  // from the live permissions data — these can legitimately differ when a live
  // data dir is older than the app (do not claim the live file contains it if not).
  const delegatedUserId = run && run.delegatedUserId != null ? run.delegatedUserId : null;
  const permissionCatalog = (typeof readPermissions === 'function') ? readPermissions() : [];
  const permissionInLiveData = permissionCatalog.includes(CROSS_TICKET_DELETE_PERMISSION);
  let delegatedHasPermission = false;
  let delegatedGroups = [];
  if (delegatedUserId != null) {
    try {
      delegatedHasPermission = hasPermission(delegatedUserId, CROSS_TICKET_DELETE_PERMISSION);
      const groups = readGroups();
      delegatedGroups = getPrincipalGroupIds('user', delegatedUserId).map(id => {
        const g = groups.find(item => item.id === id);
        return g ? { id: g.id, name: g.name, permissions: Array.isArray(g.permissions) ? g.permissions : [] } : { id, name: 'unavailable', permissions: [] };
      });
    } catch (_) { /* read-only best effort */ }
  }

  // Cross-ticket conflict detection: prefer a recorded blocked workspace op; else
  // parse the deterministic conflict message (buildCrossTicketConflictError) from
  // the failure reason. Only treated as "blocked before mutation" when nothing was
  // committed for this run.
  let blockedConflict = workspaceOps.find(op => op && (op.blocked || op.reason) && op.reason === 'overlapping_artifact_owner') || null;
  if (blockedConflict) {
    blockedConflict = {
      operation: blockedConflict.operation || 'deletePath',
      path: opPath(blockedConflict),
      reason: blockedConflict.reason || 'overlapping_artifact_owner',
      conflictingTicketId: blockedConflict.conflictingTicketId != null ? blockedConflict.conflictingTicketId : null,
      conflictingRunId: blockedConflict.conflictingRunId != null ? blockedConflict.conflictingRunId : null,
      conflictingHistoryId: blockedConflict.conflictingHistoryId != null ? blockedConflict.conflictingHistoryId : null,
      conflictingPath: blockedConflict.conflictingPath != null ? blockedConflict.conflictingPath : null
    };
  } else if (committedCount === 0) {
    const errText = String((fs2.rootCause) || (run && run.error) || '');
    const m = errText.match(/Workspace (delete|rename) conflict: path (\S+) overlaps an artifact \(([^)]*)\) previously produced by ticket (\d+), run (\d+)/);
    if (m) {
      blockedConflict = {
        operation: m[1] === 'delete' ? 'deletePath' : 'renamePath',
        path: m[2],
        reason: 'overlapping_artifact_owner',
        conflictingTicketId: parseInt(m[4], 10),
        conflictingRunId: parseInt(m[5], 10),
        conflictingHistoryId: null,
        conflictingPath: m[3]
      };
    }
  }
  const blockedDelete = blockedConflict && blockedConflict.operation === 'deletePath' ? blockedConflict : null;
  const permEvents = Array.isArray(permissionedDeleteAuditEvents) ? permissionedDeleteAuditEvents : [];

  // ---- Header ----
  out('# Ticket System Diagnostic Bundle');
  out('');
  out('Generated At: ' + dash(generatedAt));
  out('App Version / Tag: ' + dash(DIAGNOSTIC_APP_VERSION));
  out('Route: ' + dash(route));
  out('Ticket: ' + (ticket ? '#' + ticket.id : 'unavailable'));
  out('Run: ' + (run ? '#' + run.id : 'unavailable'));
  out('Purpose: Single copyable bundle to diagnose this run/ticket.');
  out('');

  // 1. Summary
  out('## 1. Summary');
  if (blockedDelete && committedCount === 0) {
    const p = dash(opPath(blockedDelete));
    out(`This run was blocked before mutation. The model proposed deletePath ${p}, but ${p} overlaps an artifact produced by Ticket #${dash(blockedDelete.conflictingTicketId)} / Run #${dash(blockedDelete.conflictingRunId)}. No operation-history mutation was committed for this run.`);
  }
  if (permEvents.length > 0) {
    out(`This run was allowed to delete a cross-ticket artifact because the run's delegated user had ${CROSS_TICKET_DELETE_PERMISSION}. The audit evidence records the prior owner, requesting run, delegated actor, delegated permission source, and permission used.`);
  }
  // Phase/stall failure: model proposed mutation(s) during planning but nothing was
  // accepted or committed, with phase violations and stalls/step-limit.
  const runFailed = run && run.status === 'failed';
  // Status-aware count wording: "before failure" only for failed runs; completed
  // (and interrupted) runs read neutrally.
  const countSuffix = runFailed ? ' before failure' : '';
  if (runFailed && phaseViolationCount > 0 && proposedMutatingCount > 0 && runtimeAcceptedCount === 0 && committedCount === 0 && (modelStallCount > 0 || stepLimitCount > 0)) {
    const firstMut = proposedActions.find(a => a.operation && AGENT_MUTATING_OPERATIONS.includes(a.operation));
    const mutDesc = firstMut ? (firstMut.operation + (firstMut.path != null && firstMut.path !== '' ? ' ' + firstMut.path : '')) : 'a mutating action';
    out(`This run failed before workspace execution. The model proposed ${mutDesc} during the planning phase, but the response mixed mutation and inspection actions, causing phase violations. No workspace operation was accepted and no mutation was committed. The run then failed after repeated complete:false responses with no workspace actions.`);
  }
  out('- Run status: ' + dash(run && run.status));
  out('- Operational outcome: ' + dash(operationalOutcome));
  out('- Model-proposed workspace actions' + countSuffix + ': ' + proposedCount);
  out('- Runtime-accepted workspace operations' + countSuffix + ': ' + runtimeAcceptedCount);
  out('- Mutations committed' + countSuffix + ': ' + committedCount);
  out('');

  // 2. Ticket State
  out('## 2. Ticket State');
  if (ticket) {
    out('- Ticket id: ' + dash(ticket.id));
    out('- Objective/title: ' + dash(ticket.objective || ticket.title));
    out('- Status: ' + dash(ticket.status));
    out('- Assignment target type: ' + dash(ticket.assignmentTargetType));
    out('- Assignment target id: ' + dash(ticket.assignmentTargetId));
    out('- Assigned agent/group: ' + dash(agent ? agent.name : (authorityContext && authorityContext.authority && authorityContext.authority.assignment)));
    out('- createdBy: ' + dash(ticket.createdBy));
    out('- changedBy: ' + dash(ticket.changedBy));
    out('- createdAt: ' + dash(ticket.createdAt));
    out('- updatedAt: ' + dash(ticket.updatedAt));
  } else {
    out('Ticket: unavailable');
  }
  out('- Latest run id: ' + dash(run && run.id));
  out('- Latest outcome: ' + dash(operationalOutcome));
  out('- Current message: ' + dash(eventSummary && eventSummary.latestStatus && eventSummary.latestStatus.message));
  out('');

  // 3. Run State
  out('## 3. Run State');
  if (run) {
    out('- Run id: ' + dash(run.id));
    out('- Ticket id: ' + dash(run.ticketId));
    out('- Agent id: ' + dash(run.agentId));
    out('- Agent name: ' + dash(run.agentName || (agent && agent.name)));
    out('- Status: ' + dash(run.status));
    out('- Outcome: ' + dash(operationalOutcome));
    out('- startedAt: ' + dash(run.startedAt));
    out('- completedAt: ' + dash(run.completedAt));
    out('- duration: ' + dash(typeof formatDurationHuman === 'function' && run.startedAt && run.completedAt ? formatDurationHuman(new Date(run.completedAt) - new Date(run.startedAt)) : null));
    out('- Current phase: ' + dash(run.currentPhase));
    out('- Current step: ' + dash(eventSummary && eventSummary.currentStep && eventSummary.currentStep.stepId));
    out('- Current message: ' + dash(eventSummary && eventSummary.latestStatus && eventSummary.latestStatus.message));
    out('- Error / root cause: ' + dash(fs2.rootCause || run.error));
    out('- Final blocking reason: ' + dash(fs2.finalBlockingReason));
    out('- Completion source: ' + dash(completionSummary && completionSummary.source));
    out('- Mutations count: ' + committedCount);
    out('- Latest workspace mutation: ' + dash(eventSummary && eventSummary.latestWorkspaceMutation ? (eventSummary.latestWorkspaceMutation.operation + ' ' + (eventSummary.latestWorkspaceMutation.path || '')) : null));
    out('- Latest event error: ' + dash(eventSummary && eventSummary.latestError && eventSummary.latestError.message));
  } else {
    out('Run: unavailable');
  }
  out('');

  // 4. Failure / Blocking Reason
  out('## 4. Failure / Blocking Reason');
  out('- Run ended as: ' + dash(fs2.statusLabel || (run && run.status)));
  out('- Root cause: ' + dash(fs2.rootCause));
  out('- Blocking error code: ' + dash(fs2.blockingErrorCode));
  out('- Final blocking reason: ' + dash(fs2.finalBlockingReason));
  out('');

  // 5. Delegated Authority / Permissions
  out('## 5. Delegated Authority / Permissions');
  out('- run.delegatedUserId: ' + dash(delegatedUserId));
  out('- run.delegatedUsername: ' + dash(run && run.delegatedUsername));
  out('- run.delegatedPermissionSource: ' + dash(run && run.delegatedPermissionSource));
  out('- Permission defined in app constant/catalog: yes (' + CROSS_TICKET_DELETE_PERMISSION + ')');
  out('- Permission present in live permissions data: ' + (permissionInLiveData ? 'yes' : 'no'));
  if (!permissionInLiveData) {
    out('  - Note: this run\'s live permissions data does not contain the permission (the data dir may predate v0.1.18). No data was modified by this diagnostic.');
  }
  if (delegatedUserId == null) {
    out('- Delegated user is null; the cross-ticket delete permission cannot be applied to this run.');
  } else {
    out('- Delegated user has permission according to live data: ' + (delegatedHasPermission ? 'yes' : 'no'));
    out('- Delegated user groups: ' + (delegatedGroups.length > 0 ? delegatedGroups.map(g => g.name + ' (#' + g.id + ')').join(', ') : 'none'));
    delegatedGroups.forEach(g => {
      out('  - ' + g.name + ' permissions: ' + (g.permissions.length > 0 ? g.permissions.join(', ') : 'none'));
    });
  }
  out('');

  // 6. Assignment / Scope / Runtime Policy
  out('## 6. Assignment / Scope / Runtime Policy');
  const auth = (authorityContext && authorityContext.authority) || {};
  out('- Assignment: ' + dash(auth.assignment));
  out('- Scope: ' + dash(auth.scope));
  out('- Runtime policy: ' + dash(auth.runtimePolicy));
  out('- Execution mode: ' + dash(run && run.executionMode));
  out('- Capability: ' + dash(run && run.capabilityType) + ' / ' + dash(run && run.capabilityId));
  out('- Owned output paths: ' + ((run && Array.isArray(run.ownedOutputPaths) && run.ownedOutputPaths.length > 0) ? run.ownedOutputPaths.join(', ') : 'none'));
  out('');

  // 7. Proposed Actions
  out('## 7. Proposed Actions');
  out('- Last model message: ' + dash(fs2.lastModelMessage));
  out('- Model-proposed workspace actions' + countSuffix + ': ' + proposedCount);
  if (proposedActions.length > 0) {
    proposedActions.forEach(a => {
      const pathPart = a.path === null || a.path === undefined ? '' : (a.path === '' ? '""' : a.path);
      out('- step ' + dash(a.step) + ': ' + dash(a.operation) + (pathPart ? ' ' + pathPart : ''));
    });
  } else {
    out('- (no proposed actions captured)');
  }
  out('');

  // 8. Workspace Actions
  out('## 8. Workspace Actions');
  out('- Model-proposed workspace actions' + countSuffix + ': ' + proposedCount);
  out('- Runtime-accepted workspace operations' + countSuffix + ': ' + runtimeAcceptedCount);
  out('- Mutations committed' + countSuffix + ': ' + committedCount);
  if (workspaceOps.length > 0) {
    workspaceOps.forEach((op, i) => out(formatDiagnosticWorkspaceOperation(op, i)));
  } else {
    out('- (no workspace operations captured)');
  }
  out('');

  // 9. Operation History / Artifact Ownership
  out('## 9. Operation History / Artifact Ownership');
  if (history.length > 0) {
    history.forEach(h => {
      out(`- #${dash(h.id)} ${dash(h.operation)} path=${dash(opPath(h))} ${h.error ? 'ERROR=' + h.error : 'ok'}`);
    });
  } else {
    out('- No operation-history records committed for this run.');
  }
  if (blockedConflict) {
    out('- Conflicting owner (from blocked op): ticket #' + dash(blockedConflict.conflictingTicketId) + ', run #' + dash(blockedConflict.conflictingRunId) + ', history id ' + dash(blockedConflict.conflictingHistoryId) + ', path ' + dash(blockedConflict.conflictingPath));
  }
  out('');

  // 10. Permissioned Cross-Ticket Delete Audit
  out('## 10. Permissioned Cross-Ticket Delete Audit');
  if (permEvents.length > 0) {
    permEvents.forEach((e, i) => {
      out(`- [${i}] event type: ${dash(e.type)}`);
      out('  - timestamp: ' + dash(e.ts));
      out('  - operation: ' + dash(e.operation));
      out('  - path: ' + dash(e.path));
      out('  - priorOwnerTicketId: ' + dash(e.priorOwnerTicketId));
      out('  - priorOwnerRunId: ' + dash(e.priorOwnerRunId));
      out('  - priorOwnerHistoryId: ' + dash(e.priorOwnerHistoryId));
      out('  - priorOwnerPath: ' + dash(e.priorOwnerPath));
      out('  - requestingTicketId: ' + dash(e.requestingTicketId));
      out('  - requestingRunId: ' + dash(e.requestingRunId));
      out('  - actorUserId: ' + dash(e.actorUserId));
      out('  - actorUsername: ' + dash(e.actorUsername));
      out('  - delegatedPermissionSource: ' + dash(e.delegatedPermissionSource));
      out('  - permissionUsed: ' + dash(e.permissionUsed));
      out('  - source: ' + dash(e.source));
    });
  } else if (blockedConflict) {
    out('- No permissioned delete authorized. Blocked cross-ticket ' + (blockedConflict.operation === 'renamePath' ? 'rename' : 'delete') + ' diagnosis:');
    out('  - operation: ' + dash(blockedConflict.operation));
    out('  - path: ' + dash(blockedConflict.path));
    out('  - reason: ' + dash(blockedConflict.reason));
    out('  - conflictingTicketId: ' + dash(blockedConflict.conflictingTicketId));
    out('  - conflictingRunId: ' + dash(blockedConflict.conflictingRunId));
    out('  - conflictingHistoryId: ' + dash(blockedConflict.conflictingHistoryId));
    out('  - conflictingPath: ' + dash(blockedConflict.conflictingPath));
    out('  - mutation committed: no');
  } else {
    out('- No permissioned cross-ticket delete audit events for this run.');
  }
  out('');

  // 11. Replay Events (canonical: snapshot.events)
  out('## 11. Replay Events');
  out('- Replay event count: ' + replayEvents.length);
  out('- Phase violations (execution.phase_violation): ' + phaseViolationCount);
  out('- Model stalls (model:stalled): ' + modelStallCount);
  out('- Step limit (run:step_limit): ' + stepLimitCount);
  if (replayEvents.length > 0) {
    replayEvents.forEach(ev => out('- ' + dash(evType(ev)) + ': ' + dash(ev && (ev.message || ev.detail || ev.reason))));
  }
  out('');

  // 12. Provider / Model Evidence
  out('## 12. Provider / Model Evidence');
  out('- Provider request count: ' + (Array.isArray(s.providerRequests) ? s.providerRequests.length : 0));
  out('- Model response count: ' + (Array.isArray(s.modelResponses) ? s.modelResponses.length : 0));
  out('- Last model message: ' + dash(fs2.lastModelMessage));
  out('- Model-proposed workspace actions: ' + proposedCount);
  out('- Phase violations: ' + phaseViolationCount);
  out('- Model stalls: ' + modelStallCount);
  out('- Step limit events (run:step_limit): ' + stepLimitCount);
  out('- Replay event count: ' + replayEvents.length);
  out('');

  // 13. Artifact Prediction / Output Analysis
  out('## 13. Artifact Prediction / Output Analysis');
  const cmp = artifactPredictionComparison || { matched: [], missing: [], unexpected: [] };
  out('- Matched: ' + (Array.isArray(cmp.matched) ? cmp.matched.length : 0));
  out('- Missing: ' + (Array.isArray(cmp.missing) ? cmp.missing.length : 0));
  out('- Unexpected: ' + (Array.isArray(cmp.unexpected) ? cmp.unexpected.length : 0));
  out('- Artifact accuracy: ' + dash(artifactAccuracy && artifactAccuracy.percent != null ? artifactAccuracy.percent + '%' : null));
  out('- Objective success: ' + dash(objectiveSuccess && objectiveSuccess.status));
  out('');

  // 14. Recent Activity
  out('## 14. Recent Activity');
  const logs = Array.isArray(recentLogs) ? recentLogs : [];
  if (logs.length > 0) {
    logs.forEach(l => out('- ' + dash(l.displayType || l.type) + ': ' + dash(l.displayMessage || l.message)));
  } else {
    out('- No recent activity logs.');
  }
  out('');

  // 15. Raw Debug JSON (secret-free projection)
  out('## 15. Raw Debug JSON');
  const safeAgent = agent ? { id: agent.id, name: agent.name, provider: agent.provider, model: agent.model } : null;
  const rawDebug = {
    route, generatedAt, appVersion: DIAGNOSTIC_APP_VERSION,
    run: run || null,
    ticket: ticket || null,
    agent: safeAgent,
    failureSummary: failureSummary || null,
    operationHistory: history,
    permissionedDeleteAuditEvents: permEvents,
    eventSummary: eventSummary || null,
    snapshotSummary: {
      provider: s.provider || null,
      model: s.model || null,
      terminalStatus: s.terminalStatus || null,
      failureReason: s.failureReason || null,
      providerRequests: Array.isArray(s.providerRequests) ? s.providerRequests.length : 0,
      modelResponses: Array.isArray(s.modelResponses) ? s.modelResponses.length : 0,
      workspaceOperations: workspaceOps,
      replayEvents
    },
    delegatedAuthority: {
      delegatedUserId, delegatedUsername: run && run.delegatedUsername || null,
      delegatedPermissionSource: run && run.delegatedPermissionSource || null,
      permissionDefinedInConstant: true, permissionInLiveData, delegatedHasPermission, delegatedGroups
    }
  };
  out('```json');
  out(j(rawDebug));
  out('```');
  out('');

  // 16. Redaction Notice
  out('## 16. Redaction Notice');
  out('Provider keys, session cookies, password hashes, auth tokens, and environment secrets are excluded from this diagnostic bundle.');
  out('');

  return lines.join('\n');
}

fastify.get('/runs/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Run not found',
      user: request.user
    }, request.session.userId));
  }

  const run = hydrateRunReplaySnapshot(readRuns().find(item => item.id === runId));

  if (!run) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Run not found',
      user: request.user
    }, request.session.userId));
  }

  const history = readOperationHistory();
  const runPartialMutationCount = countRunMutatingOperations(runId, history);
  const agent = readAgents().find(a => a.id === run.agentId) || null;
  const ticket = readTickets().find(item => item.id === run.ticketId) || null;
  const snapshot = run.replaySnapshot || null;
  const authorityContext = buildRunAuthorityContext(run, ticket, agent, snapshot);

  if (authorityContext.controls.recoverable && history.some(h => h.runId === runId && h.error && h.operation !== 'recovery')) {
    authorityContext.controls.recoveryAvailable = true;
  }

  const opAllowance = {};
  const opErrorInfo = {};
  if (snapshot && Array.isArray(snapshot.workspaceOperations)) {
    snapshot.workspaceOperations.forEach((op, i) => {
      const key = op.historyId != null ? 'h:' + op.historyId : 's:' + i;
      opAllowance[key] = classifyOperationAllowance(op);
      opErrorInfo[key] = buildOperationErrorInfo(op);
    });
  }
  const enrichedHistory = enrichOperationHistoryForDisplay(getOperationHistoryForRun(runId, history));
  enrichedHistory.forEach(record => {
    record.allowance = classifyOperationAllowance(record);
    record.errorInfo = buildOperationErrorInfo(record);
  });
  const failureSummary = buildRunFailureSummary(run, snapshot, enrichedHistory, runPartialMutationCount, authorityContext.controls.recoveryAvailable);
  const workflows = readWorkflows();
  const artifactPredictionComparison = buildArtifactPredictionComparison(run, snapshot, history, workflows);
  const artifactAccuracy = buildArtifactAccuracy(snapshot, artifactPredictionComparison);
  const objectiveSuccess = buildObjectiveSuccess(run);
  const objectivePathCoverage = buildObjectivePathCoverage(ticket, snapshot);
  const reviewStatus = buildRunReviewStatus(run, { objectivePathCoverage, artifactAccuracy, comparison: artifactPredictionComparison });
  const displaySnapshot = createDisplaySnapshot(snapshot);
  const operationalOutcome = classifyRunOperationalOutcome(run);
  const runEvents = getRunEvents(runId);
  const eventSummary = recentEventSummary(runId, runEvents);
  const runStateInconsistency = detectRunStateInconsistency(run, {
    logs: readLogs().filter(log => log.runId === runId),
    events: runEvents,
    replaySnapshot: snapshot,
    recentEventSummary: eventSummary
  });
  const completionSummary = buildRunCompletionSummary(run, snapshot, runEvents, enrichedHistory, failureSummary);
  // Display-only: surface this run's permissioned cross-ticket delete audit events
  // (recorded in v0.1.18). Strictly scoped to this run's id. Derived for the view;
  // no runtime, permission, or event-writing behavior is affected.
  const permissionedDeleteAuditEvents = (runEvents || [])
    .filter(ev => ev && ev.type === 'workspace.cross_ticket_delete_authorized' && ev.runId === run.id && ev.payload && typeof ev.payload === 'object')
    .map(ev => ({
      type: ev.type,
      ts: ev.ts || null,
      operation: ev.payload.operation != null ? ev.payload.operation : null,
      path: ev.payload.path != null ? ev.payload.path : null,
      priorOwnerTicketId: ev.payload.priorOwnerTicketId != null ? ev.payload.priorOwnerTicketId : null,
      priorOwnerRunId: ev.payload.priorOwnerRunId != null ? ev.payload.priorOwnerRunId : null,
      priorOwnerHistoryId: ev.payload.priorOwnerHistoryId != null ? ev.payload.priorOwnerHistoryId : null,
      priorOwnerPath: ev.payload.priorOwnerPath != null ? ev.payload.priorOwnerPath : null,
      requestingTicketId: ev.payload.requestingTicketId != null ? ev.payload.requestingTicketId : null,
      requestingRunId: ev.payload.requestingRunId != null ? ev.payload.requestingRunId : null,
      actorUserId: ev.payload.actorUserId != null ? ev.payload.actorUserId : null,
      actorUsername: ev.payload.actorUsername != null ? ev.payload.actorUsername : null,
      delegatedPermissionSource: ev.payload.delegatedPermissionSource != null ? ev.payload.delegatedPermissionSource : null,
      permissionUsed: ev.payload.permissionUsed != null ? ev.payload.permissionUsed : null,
      source: ev.payload.source != null ? ev.payload.source : null
    }));

  const diagnosticsGeneratedAt = new Date().toISOString();
  const runDiagnosticBundle = buildRunDiagnosticBundle({
    run, ticket, agent, snapshot, authorityContext, failureSummary,
    operationHistory: enrichedHistory, permissionedDeleteAuditEvents, completionSummary,
    eventSummary, recentLogs: getRecentLogsForRun(runId), artifactPredictionComparison,
    artifactAccuracy, objectiveSuccess, operationalOutcome, partialMutationCount: runPartialMutationCount,
    generatedAt: diagnosticsGeneratedAt, route: '/runs/' + runId
  });

  const runDetailAttemptUsage = buildRunAttemptUsage(run, readRuns().filter(item => item.ticketId === run.ticketId));

  return renderCachedView(request, reply, 'run-detail.ejs', viewData({
    user: request.user,
    run,
    ticket,
    snapshot: displaySnapshot,
    agent,
    authorityContext,
    opAllowance,
    opErrorInfo,
    failureSummary,
    recentLogs: getRecentLogsForRun(runId),
    operationHistory: enrichedHistory,
    artifactPredictionComparison,
    artifactAccuracy,
    objectiveSuccess,
    objectivePathCoverage,
    reviewStatus,
    partialMutationCount: runPartialMutationCount,
    operationalOutcome,
    operationalOutcomeLabel: displayOperationalOutcome(operationalOutcome, runPartialMutationCount),
    attemptUsage: runDetailAttemptUsage,
    budgetStatus: buildRunBudgetStatus(run, runDetailAttemptUsage),
    runStatusLabel: displayRunStatus(run.status),
    runEvents,
    eventSummary,
    runStateInconsistency,
    completionSummary,
    permissionedDeleteAuditEvents,
    runDiagnosticBundle,
    diagnosticsGeneratedAt,
    formatDurationHuman,
    canUpdateRuns: hasPermission(request.session.userId, 'ticket:update')
  }, request.session.userId));
});

fastify.get('/api/runs/:id/events', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  const run = readRuns().find(item => item.id === runId);

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  const events = getRunEvents(runId);
  return {
    events,
    summary: recentEventSummary(runId, events)
  };
});

fastify.get('/api/runs/:id/state', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  const run = readRuns().find(item => item.id === runId);

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  return serializeRunRuntimeState(run);
});

fastify.get('/api/runs/:id/operations', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  const run = readRuns().find(item => item.id === runId);

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  return { operations: getOperationHistoryForRun(runId) };
});

fastify.post('/api/runs/:id/stop', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);
  const run = readRuns().find(item => item.id === runId);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  if (!['pending', 'running'].includes(run.status)) {
    reply.code(400);
    return { error: 'Only pending or running runs can be stopped' };
  }

  return { run: interruptAgentRun(run, 'manually stopped') };
});

fastify.post('/api/runs/:id/retry', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:update')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const runId = parseInt(request.params.id, 10);
  const run = readRuns().find(item => item.id === runId);

  if (Number.isNaN(runId)) {
    reply.code(400);
    return { error: 'Invalid run id' };
  }

  if (!run) {
    reply.code(404);
    return { error: 'Run not found' };
  }

  if (!['failed', 'interrupted'].includes(run.status)) {
    reply.code(400);
    return { error: 'Only failed or interrupted runs can be retried' };
  }

  const retryGateTicket = readTickets().find(item => item.id === run.ticketId);
  if (retryGateTicket) {
    if (hasUnresolvedTicketTriage(retryGateTicket)) {
      reply.code(409);
      return { error: 'Cannot retry: unresolved ticket-level triage exists on the parent ticket. Resolve triage first.' };
    }
    const rerunCheck = validateManualRerun(retryGateTicket);
    if (!rerunCheck.allowed) {
      reply.code(409);
      return { error: rerunCheck.reason };
    }
  }

  return { ticket: rerunTicketFromBeginning(run.ticketId, request.user ? request.user.username : 'operator', 'retry', delegatedFromRequest(request, 'manual_rerun')) };
});

// ==================== AGENT METRICS ROUTES ====================

fastify.get('/agents', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'ticket:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  return reply.view('agents.ejs', viewData({
    user: request.user,
    agentMetrics: getAgentPerformanceMetrics(),
    modelMetrics: getModelPerformanceMetrics()
  }, request.session.userId));
});

// ==================== WORKSPACE ROUTES ====================

function workspaceApi(request, reply, permission, operation) {
  if (!hasPermission(request.session.userId, permission)) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    return operation();
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Workspace operation failed' };
  }
}

function operatorWorkspaceMutationApi(request, reply, operationName, args, affectedPaths, operation) {
  if (!hasPermission(request.session.userId, 'workspace:write')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  const requestedBy = request.user ? request.user.username : String(request.session.userId);
  const preState = captureOperatorWorkspaceState(affectedPaths);
  let result = null;
  let error = null;

  try {
    result = operation();
    return result;
  } catch (operationError) {
    error = operationError;
    reply.code(400);
    return { error: error.message || 'Workspace operation failed' };
  } finally {
    const postState = captureOperatorWorkspaceState(affectedPaths);
    appendSystemLog('workspace:operator_mutation', `Operator workspace ${operationName} by ${requestedBy}`, {
      operation: operationName,
      args: sanitizeSnapshotValue(args)
    }, {
      source: 'operator_workspace_api',
      requestedBy,
      preState,
      postState,
      result: result ? sanitizeSnapshotValue(result) : null,
      error: error ? (error.message || String(error)) : null
    });
  }
}

fastify.get('/workspace', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'workspace:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  try {
    const workspaceListing = annotateWorkspaceListingWithOwnership(workspaceProvider.list(request.query.path || ''));

    return reply.view('workspace.ejs', viewData({
      user: request.user,
      workspaceRoot: workspaceProvider.root,
      workspacePath: workspaceListing.path,
      workspaceEntries: workspaceListing.entries,
      workspaceFixtures: WORKSPACE_FIXTURES,
      canResetWorkspaceFixtures: hasPermission(request.session.userId, 'workspace:reset')
    }, request.session.userId));
  } catch (error) {
    reply.code(400);
    return reply.view('error.ejs', viewData({
      message: error.message || 'Workspace operation failed',
      user: request.user
    }, request.session.userId));
  }
});

fastify.get('/api/workspace/list', { preHandler: fastify.requireAuth }, async (request, reply) => {
  return workspaceApi(request, reply, 'workspace:read', () => {
    const relativePath = request.query.path || '';
    return annotateWorkspaceListingWithOwnership(workspaceProvider.list(relativePath));
  });
});

fastify.get('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  return workspaceApi(request, reply, 'workspace:read', () => {
    return {
      path: request.query.path || '',
      content: workspaceProvider.readFile(request.query.path || '')
    };
  });
});

fastify.post('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'createFile', args, [request.body.path], () =>
    workspaceProvider.createFile(request.body.path, { allowHidden: true })
  );
});

fastify.post('/api/workspace/folder', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'createFolder', args, [request.body.path], () =>
    workspaceProvider.createFolder(request.body.path, { allowHidden: true })
  );
});

fastify.patch('/api/workspace/file', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'writeFile', args, [request.body.path], () =>
    workspaceProvider.writeFile(request.body.path, request.body.content, { allowHidden: true })
  );
});

fastify.patch('/api/workspace/rename', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path, nextPath: request.body.nextPath };
  return operatorWorkspaceMutationApi(request, reply, 'renamePath', args, [request.body.path, request.body.nextPath], () =>
    workspaceProvider.rename(request.body.path, request.body.nextPath, { allowHidden: true })
  );
});

fastify.delete('/api/workspace', { preHandler: fastify.requireAuth }, async (request, reply) => {
  const args = { path: request.body.path };
  return operatorWorkspaceMutationApi(request, reply, 'deletePath', args, [request.body.path], () =>
    workspaceProvider.delete(request.body.path, { allowHidden: true })
  );
});

fastify.post('/api/workspace/fixture', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'workspace:reset')) {
    reply.code(403);
    return { error: 'Permission denied' };
  }

  try {
    const fixtureId = String(request.body.fixtureId || '').trim();
    const fixture = WORKSPACE_FIXTURES.find(item => item.id === fixtureId);

    if (!fixture) {
      reply.code(400);
      return { error: 'Unknown workspace fixture' };
    }

    const requestedBy = request.user ? request.user.username : String(request.session.userId);
    const preState = captureWorkspaceRootListing();
    applyWorkspaceFixture(fixtureId);
    const postState = captureWorkspaceRootListing();
    appendSystemLog('workspace:fixture', `Workspace fixture reset: ${fixture.name}`, {
      operation: 'resetWorkspaceFixture',
      args: { fixtureId, workspaceRoot: workspaceProvider.root }
    }, {
      source: 'operator_workspace_fixture',
      requestedBy,
      preState,
      postState
    });

    return workspaceProvider.list('');
  } catch (error) {
    reply.code(400);
    return { error: error.message || 'Workspace fixture reset failed' };
  }
});

// ==================== ADMIN DASHBOARD ====================

fastify.get('/admin', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const users = readUsers();
  const agents = readAgents();
  const groups = readGroups();
  const memberships = readMemberships();
  const tickets = readTickets();
  const allPermissions = readPermissions();
  const adminMutationTypes = new Set([
    'ticket:status_change',
    'ticket:rerun',
    'workspace:recovery',
    'admin:user_create',
    'admin:user_edit',
    'admin:user_delete',
    'admin:agent_create',
    'admin:agent_edit',
    'admin:agent_delete',
    'admin:group_create',
    'admin:group_edit',
    'admin:group_delete',
    'system:reset'
  ]);
  const recentAdminActivity = readLogs()
    .filter(log => adminMutationTypes.has(log.type))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12);

  const usersWithGroups = users.map(account => {
    const accountGroupIds = Array.from(new Set(memberships
      .filter(membership => membership.principalType === 'user' && membership.principalId === account.id)
      .map(membership => membership.groupId)));
    const accountGroups = groups.filter(group => accountGroupIds.includes(group.id));
    return { ...account, type: 'user', groups: accountGroups };
  });

  const agentsWithMaskedKeys = agents.map(agent => {
    const accountGroupIds = Array.from(new Set(memberships
      .filter(membership => membership.principalType === 'agent' && membership.principalId === agent.id)
      .map(membership => membership.groupId)));
    const accountGroups = groups.filter(group => accountGroupIds.includes(group.id));
    return { ...agent, type: 'agent', groups: accountGroups };
  });

  const accounts = [...usersWithGroups, ...agentsWithMaskedKeys].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const groupsWithPermissions = groups.map(group => {
    const permissions = getGroupPermissionNames(group.id);
    return { ...group, permissions };
  });

  return reply.view('admin/dashboard.ejs', viewData({
    users,
    agents,
    groups,
    membershipGroups: groups,
    accounts,
    groupsWithPermissions,
    recentAdminActivity,
    tickets,
    permissions: allPermissions,
    providers: PROVIDERS,
    models: MODELS,
    hasOpenAIApiKeyFallback: Boolean(String(process.env.OPENAI_API_KEY || '').trim()),
    hasOpenAIModelFallback: Boolean(String(process.env.OPENAI_MODEL || '').trim()),
    hasOllamaModelFallback: Boolean(String(process.env.OLLAMA_MODEL || '').trim()),
    user: request.user,
    resetError: request.query.resetError || null,
    resetSuccess: request.query.resetSuccess || null
  }, request.session.userId));
});

fastify.post('/admin/debug-reset', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (process.env.NODE_ENV === 'production') {
    reply.code(403);
    return 'Debug reset is disabled in production';
  }

  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return 'Permission denied';
  }

  const confirmation = String(request.body.confirmation || '').trim();
  if (confirmation !== 'RESET DEBUG DATA') {
    return reply.redirect('/admin?resetError=' + encodeURIComponent('Confirmation phrase did not match. Type RESET DEBUG DATA exactly.'));
  }

  try {
    await resetDebugData(request.user ? request.user.username : String(request.session.userId));
    return reply.redirect('/admin?resetSuccess=1');
  } catch (error) {
    return reply.redirect('/admin?resetError=' + encodeURIComponent(error.message || 'Reset failed'));
  }
});

// ==================== USER MANAGEMENT ====================

fastify.post('/admin/users', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:create')) {
    reply.code(403);
    return 'Permission denied';
  }

  const { accountType, username, password, groupIds, agentName, apiKey, model } = request.body;

  if (accountType === 'agent') {
    const provider = PROVIDERS.includes(request.body.provider) ? request.body.provider : 'openai';
    const hasApiKey = provider === 'ollama' || Boolean(apiKey && apiKey.trim()) || hasProviderApiKeyFallback(provider);
    const hasModel = Boolean(model && model.trim()) || hasProviderModelFallback(provider);

    if (!agentName || !hasApiKey || !hasModel) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: provider === 'ollama'
          ? 'Agent name and Ollama model are required unless OLLAMA_MODEL is configured'
          : 'Agent name, API key, and model are required unless OpenAI env fallbacks are configured'
      });
    }

    const agents = readAgents();

    if (agents.find(a => a.name === agentName)) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: 'Agent name already exists'
      });
    }

    let normalizedGroupIds;
    try {
      normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
    } catch (error) {
      return renderAdminUserForm(reply, request, {
        accountType: 'agent',
        error: error.message
      });
    }

    const newAgent = {
      id: nextId(agents),
      name: agentName.trim(),
      type: 'agent',
      provider,
      model: model ? model.trim() : '',
      apiKey: apiKey ? apiKey.trim() : '',
      createdAt: new Date().toISOString(),
      changedBy: request.user ? request.user.username : String(request.session.userId),
      changedAt: new Date().toISOString()
    };

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    const changedAt = new Date().toISOString();

    agents.push(newAgent);
    writeAgents(agents);
    setPrincipalGroupMemberships('agent', newAgent.id, normalizedGroupIds);

    appendSystemLog('admin:agent_create', `Agent "${agentName.trim()}" created by ${changedBy}`, null, {
      changedBy,
      changedAt,
      targetAgentId: newAgent.id,
      targetAgentName: agentName.trim(),
      provider
    });

    return reply.redirect('/admin');
  }

  if (!username || !password) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: 'Username and password are required'
    });
  }

  let normalizedGroupIds;
  try {
    normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  } catch (error) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: error.message
    });
  }

  const users = readUsers();

  if (users.find(u => u.username === username)) {
    return renderAdminUserForm(reply, request, {
      accountType: 'user',
      error: 'Username already exists'
    });
  }

  const passwordHash = await argon2.hash(password);

  const newUser = {
    id: nextId(users),
    username: username.trim(),
    type: 'user',
    passwordHash,
    createdAt: new Date().toISOString(),
    changedBy: request.user ? request.user.username : String(request.session.userId),
    changedAt: new Date().toISOString()
  };

  users.push(newUser);
  writeUsers(users);

  setPrincipalGroupMemberships('user', newUser.id, normalizedGroupIds);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  const changedAt = new Date().toISOString();
  appendSystemLog('admin:user_create', `User "${username.trim()}" created by ${changedBy}`, null, {
    changedBy,
    changedAt,
    userId: newUser.id,
    username: username.trim()
  });

  return reply.redirect('/admin');
});

fastify.get('/admin/users/:id/edit', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({ 
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }
  
  const accountId = parseInt(request.params.id);
  const accountType = request.query.type === 'agent' ? 'agent' : 'user';
  const accounts = accountType === 'agent' ? readAgents() : readUsers();
  const foundAccount = accounts.find(a => a.id === accountId);
  
  if (!foundAccount) {
    return reply.redirect('/admin');
  }

  const editAccount = accountType === 'user'
    ? { ...foundAccount, type: 'user' }
    : foundAccount;

  return renderAdminUserForm(reply, request, {
    editAccount,
    accountType
  });
});

fastify.post('/admin/users/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:update')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const accountId = parseInt(request.params.id);
  const { accountType, username, password, groupIds, agentName, apiKey, model } = request.body;

  if (accountType === 'agent') {
    const provider = PROVIDERS.includes(request.body.provider) ? request.body.provider : 'openai';
    const hasModel = Boolean(model && model.trim()) || hasProviderModelFallback(provider);

    if (!agentName || !hasModel) {
      const agents = readAgents();
      const editAccount = agents.find(a => a.id === accountId);

      return renderAdminUserForm(reply, request, {
        editAccount,
        accountType: 'agent',
        error: provider === 'ollama'
          ? 'Agent name and Ollama model are required unless OLLAMA_MODEL is configured'
          : 'Agent name and model are required unless OPENAI_MODEL is configured'
      });
    }

    const agents = readAgents();
    const agentIndex = agents.findIndex(a => a.id === accountId);

    if (agentIndex === -1) {
      return reply.redirect('/admin');
    }

    if (agents.find(a => a.name === agentName && a.id !== accountId)) {
      return renderAdminUserForm(reply, request, {
        editAccount: agents[agentIndex],
        accountType: 'agent',
        error: 'Agent name already exists'
      });
    }

    let normalizedGroupIds;
    try {
      normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
    } catch (error) {
      return renderAdminUserForm(reply, request, {
        editAccount: agents[agentIndex],
        accountType: 'agent',
        error: error.message
      });
    }

    agents[agentIndex].name = agentName.trim();
    agents[agentIndex].provider = provider;
    agents[agentIndex].model = model ? model.trim() : '';
    agents[agentIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
    agents[agentIndex].changedAt = new Date().toISOString();

    if (apiKey && apiKey.trim()) {
      agents[agentIndex].apiKey = apiKey.trim();
    }

    writeAgents(agents);
    setPrincipalGroupMemberships('agent', accountId, normalizedGroupIds);

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    appendSystemLog('admin:agent_edit', `Agent "${agentName.trim()}" (#${accountId}) edited by ${changedBy}`, null, {
      changedBy,
      changedAt: new Date().toISOString(),
      targetAgentId: accountId,
      targetAgentName: agentName.trim()
    });

    return reply.redirect('/admin');
  }
  
  if (!username) {
    const users = readUsers();
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: 'Username is required'
    });
  }
  
  const users = readUsers();
  const userIndex = users.findIndex(u => u.id === accountId);
  
  if (userIndex === -1) {
    return reply.redirect('/admin');
  }

  if (users.find(u => u.username === username && u.id !== accountId)) {
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: 'Username already exists'
    });
  }

  let normalizedGroupIds;
  try {
    normalizedGroupIds = normalizeSubmittedGroupIds(groupIds);
  } catch (error) {
    const editAccount = users.find(u => u.id === accountId);

    return renderAdminUserForm(reply, request, {
      editAccount: editAccount ? { ...editAccount, type: 'user' } : null,
      accountType: 'user',
      error: error.message
    });
  }

  users[userIndex].username = username.trim();
  users[userIndex].type = 'user';
  users[userIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
  users[userIndex].changedAt = new Date().toISOString();
  
  if (password) {
    users[userIndex].passwordHash = await argon2.hash(password);
  }
	  
  writeUsers(users);
  setPrincipalGroupMemberships('user', accountId, normalizedGroupIds);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:user_edit', `User "${username.trim()}" (#${accountId}) edited by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    userId: accountId,
    username: username.trim()
  });

  return reply.redirect('/admin');
});

fastify.post('/admin/users/:id/delete', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:delete')) {
    reply.code(403);
    return 'Permission denied';
  }

  const accountId = parseInt(request.params.id);
  const { accountType } = request.body;

    const changedBy = request.user ? request.user.username : String(request.session.userId);
    const changedAt = new Date().toISOString();

	  if (accountType === 'agent') {
	    // Delete agent
	    let agents = readAgents();
	    const deletedAgent = agents.find(a => a.id === accountId);
	    agents = agents.filter(a => a.id !== accountId);
	    writeAgents(agents);
	    let memberships = readMemberships();
	    memberships = memberships.filter(membership =>
	      membership.principalType !== 'agent' || membership.principalId !== accountId
	    );
	    writeMemberships(memberships);

      appendSystemLog('admin:agent_delete', `Agent "${deletedAgent ? deletedAgent.name : '#' + accountId}" deleted by ${changedBy}`, null, {
        changedBy,
        changedAt,
        targetAgentId: accountId,
        targetAgentName: deletedAgent ? deletedAgent.name : null
      });
	  } else {
    // Delete user
    // Don't allow deleting yourself
    if (accountId === request.session.userId) {
      return reply.redirect('/admin');
    }

    let users = readUsers();
    const deletedUser = users.find(u => u.id === accountId);
    users = users.filter(u => u.id !== accountId);
    writeUsers(users);

	    let memberships = readMemberships();
	    memberships = memberships.filter(membership =>
	      membership.principalType !== 'user' || membership.principalId !== accountId
	    );
	    writeMemberships(memberships);

    appendSystemLog('admin:user_delete', `User "${deletedUser ? deletedUser.username : '#' + accountId}" deleted by ${changedBy}`, null, {
      changedBy,
      changedAt,
      userId: accountId,
      username: deletedUser ? deletedUser.username : null
    });
	  }

  return reply.redirect('/admin');
});

// ==================== GROUP MANAGEMENT ====================

fastify.post('/admin/groups', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:create')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const { name, permissions, canReceiveTickets } = request.body;
  const ticketAssignable = canReceiveTickets === 'on';
  
  if (!name) {
    return renderAdminGroupForm(reply, request, {
      error: 'Group name is required'
    });
  }
  
  const groups = readGroups();
  
  if (groups.find(g => g.name === name)) {
    return renderAdminGroupForm(reply, request, {
      error: 'Group name already exists'
    });
  }

  let normalizedPermissions = [];
  try {
    normalizedPermissions = normalizeSubmittedPermissions(permissions);
  } catch (error) {
    return renderAdminGroupForm(reply, request, {
      error: error.message
    });
  }
	  
  const newGroup = {
    id: nextId(groups),
    name: name.trim(),
    permissions: normalizedPermissions,
    canReceiveTickets: ticketAssignable,
    changedBy: request.user ? request.user.username : String(request.session.userId),
    changedAt: new Date().toISOString()
  };
  
  groups.push(newGroup);
  writeGroups(groups);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_create', `Group "${name.trim()}" created by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId: newGroup.id,
    groupName: name.trim()
  });

  return reply.redirect('/admin');
});

fastify.get('/admin/groups/:id/edit', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:update')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({ 
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }
  
  const groupId = parseInt(request.params.id);
  const groups = readGroups();
  const editGroup = groups.find(g => g.id === groupId);
  
  if (!editGroup) {
    return reply.redirect('/admin');
  }
  
  return renderAdminGroupForm(reply, request, {
    editGroup
  });
});

fastify.post('/admin/groups/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:update')) {
    reply.code(403);
    return 'Permission denied';
  }
  
  const groupId = parseInt(request.params.id);
  const { name, permissions, canReceiveTickets } = request.body;
  const ticketAssignable = canReceiveTickets === 'on';
  
  if (!name) {
    const groups = readGroups();
    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: 'Group name is required'
    });
  }
  
  const groups = readGroups();
  const groupIndex = groups.findIndex(g => g.id === groupId);
  
  if (groupIndex === -1) {
    return reply.redirect('/admin');
  }

	  if (groups.find(g => g.name === name && g.id !== groupId)) {
	    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: 'Group name already exists'
	    });
	  }

	  const hasGroupTickets = readTickets().some(ticket =>
	    ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === groupId
	  );

	  if (!ticketAssignable && hasGroupTickets) {
	    return renderAdminGroupForm(reply, request, {
	      editGroup: groups[groupIndex],
	      error: 'Group has assigned tickets and must remain ticket-capable'
	    });
	  }

	  let normalizedPermissions = [];
  try {
    normalizedPermissions = normalizeSubmittedPermissions(permissions);
  } catch (error) {
    const editGroup = groups.find(g => g.id === groupId);

    return renderAdminGroupForm(reply, request, {
      editGroup,
      error: error.message
    });
  }

  groups[groupIndex].name = name.trim();
  groups[groupIndex].permissions = normalizedPermissions;
  groups[groupIndex].canReceiveTickets = ticketAssignable;
  groups[groupIndex].changedBy = request.user ? request.user.username : String(request.session.userId);
  groups[groupIndex].changedAt = new Date().toISOString();
  writeGroups(groups);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_edit', `Group "${name.trim()}" (#${groupId}) edited by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId,
    groupName: name.trim()
  });

  return reply.redirect('/admin');
});

fastify.post('/admin/groups/:id/delete', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'group:delete')) {
    reply.code(403);
    return 'Permission denied';
  }
  
	  const groupId = parseInt(request.params.id);

  if (readTickets().some(ticket => ticket.assignmentTargetType === 'group' && ticket.assignmentTargetId === groupId)) {
    reply.code(400);
    return reply.view('error.ejs', viewData({
      message: 'Cannot delete a group with assigned tickets',
      user: request.user
    }, request.session.userId));
  }
	  
  let groups = readGroups();
  const deletedGroup = groups.find(g => g.id === groupId);
  groups = groups.filter(g => g.id !== groupId);
  writeGroups(groups);
  
  let memberships = readMemberships();
  memberships = memberships.filter(membership => membership.groupId !== groupId);
  writeMemberships(memberships);

  const changedBy = request.user ? request.user.username : String(request.session.userId);
  appendSystemLog('admin:group_delete', `Group "${deletedGroup ? deletedGroup.name : '#' + groupId}" deleted by ${changedBy}`, null, {
    changedBy,
    changedAt: new Date().toISOString(),
    groupId,
    groupName: deletedGroup ? deletedGroup.name : null
  });
  
  return reply.redirect('/admin');
});

// ==================== WORKFLOWS ====================

function parseWorkflowDefinitionJson(rawDefinition) {
  if (!rawDefinition || !String(rawDefinition).trim()) {
    return { error: 'Workflow JSON is required' };
  }

  try {
    const workflow = JSON.parse(rawDefinition);
    return { workflow };
  } catch (error) {
    return { error: `Workflow JSON is invalid: ${error.message}` };
  }
}

function renderWorkflowForm(reply, request, { workflow = null, definition = null, errors = [] } = {}) {
  const isEdit = Boolean(workflow);
  reply.code(errors.length > 0 ? 400 : 200);
  return reply.view('admin/workflow-form.ejs', viewData({
    user: request.user,
    isEdit,
    workflow,
    definition: definition || JSON.stringify(workflow || createDemoWorkflowDefinition(), null, 2),
    errors
  }, request.session.userId));
}

fastify.get('/admin/workflows', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  return reply.view('admin/workflows.ejs', viewData({
    user: request.user,
    workflows: readWorkflows()
  }, request.session.userId));
});

fastify.get('/admin/workflows/new', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  return renderWorkflowForm(reply, request);
});

fastify.post('/admin/workflows', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return 'Permission denied';
  }

  const rawDefinition = request.body.definition || '';
  const parsed = parseWorkflowDefinitionJson(rawDefinition);
  if (parsed.error) return renderWorkflowForm(reply, request, { definition: rawDefinition, errors: [parsed.error] });

  const errors = validateWorkflowDefinition(parsed.workflow);
  if (errors.length > 0) return renderWorkflowForm(reply, request, { definition: rawDefinition, errors });

  const workflows = readWorkflows();
  if (workflows.some(workflow => workflow.id === parsed.workflow.id)) {
    return renderWorkflowForm(reply, request, { definition: rawDefinition, errors: [`Workflow id already exists: ${parsed.workflow.id}`] });
  }

  const now = new Date().toISOString();
  workflows.push({
    ...parsed.workflow,
    enabled: parsed.workflow.enabled !== false,
    createdAt: parsed.workflow.createdAt || now,
    updatedAt: now
  });
  writeWorkflows(workflows);
  appendSystemLog('admin:workflow_create', `Workflow "${parsed.workflow.name}" created`, null, {
    workflowId: parsed.workflow.id,
    changedBy: request.user ? request.user.username : String(request.session.userId)
  });

  return reply.redirect('/admin/workflows');
});

fastify.get('/admin/workflows/:id/edit', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const workflow = getWorkflowById(request.params.id);
  if (!workflow) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Workflow not found',
      user: request.user
    }, request.session.userId));
  }

  return renderWorkflowForm(reply, request, { workflow });
});

fastify.post('/admin/workflows/:id', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return 'Permission denied';
  }

  const workflow = getWorkflowById(request.params.id);
  if (!workflow) {
    reply.code(404);
    return reply.view('error.ejs', viewData({
      message: 'Workflow not found',
      user: request.user
    }, request.session.userId));
  }

  const rawDefinition = request.body.definition || '';
  const parsed = parseWorkflowDefinitionJson(rawDefinition);
  if (parsed.error) return renderWorkflowForm(reply, request, { workflow, definition: rawDefinition, errors: [parsed.error] });

  if (parsed.workflow.id !== workflow.id) {
    return renderWorkflowForm(reply, request, { workflow, definition: rawDefinition, errors: ['Workflow id cannot be changed'] });
  }

  const errors = validateWorkflowDefinition(parsed.workflow);
  if (errors.length > 0) return renderWorkflowForm(reply, request, { workflow, definition: rawDefinition, errors });

  const workflows = readWorkflows();
  const index = workflows.findIndex(item => item.id === workflow.id);
  workflows[index] = {
    ...parsed.workflow,
    enabled: parsed.workflow.enabled !== false,
    createdAt: workflow.createdAt || parsed.workflow.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  writeWorkflows(workflows);
  appendSystemLog('admin:workflow_update', `Workflow "${parsed.workflow.name}" updated`, null, {
    workflowId: parsed.workflow.id,
    changedBy: request.user ? request.user.username : String(request.session.userId)
  });

  return reply.redirect('/admin/workflows');
});

// ==================== ACTIONS CATALOG ====================

fastify.get('/admin/actions', { preHandler: fastify.requireAuth }, async (request, reply) => {
  if (!hasPermission(request.session.userId, 'user:read')) {
    reply.code(403);
    return reply.view('error.ejs', viewData({
      message: 'Access denied',
      user: request.user
    }, request.session.userId));
  }

  const actions = ACTIONS_CATALOG.filter(isWorkflowUsableAction);
  const invokers = [...new Set(actions.map(a => a.invoker))];

  return reply.view('admin/actions.ejs', viewData({
    user: request.user,
    actions,
    invokers
  }, request.session.userId));
});

// ==================== INITIALIZATION ====================

let runtimeScheduler = null;
let runtimeTemplateScheduler = null;

function markRunStarting(run) {
  if (!run || !run.id) return;
  startingRunIds.add(run.id);
  const agent = readAgents().find(item => item.id === run.agentId);
  if (isLocalModelAgent(agent)) startingLocalModelRunIds.add(run.id);
}

function isRunStarting(run) {
  return Boolean(run && (startingRunIds.has(run.id) || startingLocalModelRunIds.has(run.id)));
}

function isRunActiveInMemory(run) {
  return Boolean(run && runningRunKeys.has(runExecutionKey(run)));
}

function startRuntimeScheduler() {
  if (runtimeScheduler && runtimeScheduler.isRunning()) return runtimeScheduler;

  const runner = createRuntimeRunner({
    runAgentTicket,
    markRunStarting
  });

  runtimeScheduler = createRuntimeScheduler({
    intervalMs: getPositiveIntegerEnv('RUNTIME_SCHEDULER_INTERVAL_MS', 500),
    readRuns,
    readLogs,
    appendRunLog,
    appendEvent,
    canStartRunNow,
    acquireRunLease,
    expireStaleRunLeases,
    isRunStarting,
    isRunActiveInMemory,
    runner
  });
  runtimeScheduler.start();
  return runtimeScheduler;
}

// Host wrapper: build the deterministic per-slot token and route a due scheduled
// template through the SAME shared helper the manual trigger uses. Never creates
// runs or mutates the workspace — triggerProcessTemplate goes through
// createTicketFromInput → createRunsForTicket only.
function triggerDueScheduledTemplate(template, scheduledForIso) {
  const triggerToken = `schedule:${template.id}:${scheduledForIso}`;
  return triggerProcessTemplate(template, { userId: null, username: 'system' }, {
    triggerType: 'schedule',
    triggerToken,
    scheduledFor: scheduledForIso
  });
}

function startTemplateScheduler() {
  if (runtimeTemplateScheduler && runtimeTemplateScheduler.isRunning()) return runtimeTemplateScheduler;
  runtimeTemplateScheduler = createTemplateScheduler({
    intervalMs: getPositiveIntegerEnv('PROCESS_TEMPLATE_SCHEDULER_INTERVAL_MS', 60000),
    readProcessTemplates,
    triggerDueTemplate: triggerDueScheduledTemplate,
    onError: (template, error) => {
      // Invalid schedule data is skipped and surfaced; it never triggers.
      appendSystemLog('process_template:schedule_skipped', `Process template schedule skipped: ${error && error.message ? error.message : 'invalid schedule'}`, null, {
        templateId: template && template.id, templateName: template && template.name
      });
    }
  });
  runtimeTemplateScheduler.start();
  return runtimeTemplateScheduler;
}

// Note: this does not validate integrity. It rewrites all data files through
// their normalize functions to ensure clean serialization on startup.
function normalizeDataIntegrity() {
  writeUsers(readUsers());
  writeAgents(readAgents());
  writeGroups(readGroups());
  writeMemberships(readMemberships());
  writeTickets(readTickets());
  writeRuns(readRuns());
  writeLogs(readLogs());
  writeWorkflows(readWorkflows());
}

async function createDefaultData() {
  seedOperationalDataDir();
  normalizeDataIntegrity();

  const users = readUsers();
  let adminUser = users.find(user => user.username === 'admin');

  if (users.length === 0) {
    const bootstrapPassword = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || 'admin123');
    const passwordHash = await argon2.hash(bootstrapPassword);
    adminUser = {
      id: 1,
      username: 'admin',
      passwordHash,
      createdAt: new Date().toISOString()
    };
    users.push(adminUser);
    writeUsers(users);
    console.log(`Default admin user created: username=admin, password=${bootstrapPassword}`);
  }

  const groups = readGroups();
  let adminGroup = groups.find(group => group.name === 'Administrators');

  if (!adminGroup) {
    adminGroup = {
      id: nextId(groups),
      name: 'Administrators',
      permissions: readPermissions(),
      canReceiveTickets: false
    };
    groups.push(adminGroup);
    console.log('Created Administrators group');
  } else {
    adminGroup.permissions = readPermissions();
    adminGroup.canReceiveTickets = false;
  }

  if (!groups.some(group => group.canReceiveTickets)) {
    groups.push({
      id: nextId(groups),
      name: 'Agent Support',
      permissions: [],
      canReceiveTickets: true
    });
    console.log('Created Agent Support group');
  }

  writeGroups(groups);

  if (adminUser) {
    const memberships = readMemberships();
    const hasAdminMembership = memberships.some(membership =>
      membership.principalType === 'user' &&
      membership.principalId === adminUser.id &&
      membership.groupId === adminGroup.id
    );

    if (!hasAdminMembership) {
      memberships.push({
        id: nextId(memberships),
        principalType: 'user',
        principalId: adminUser.id,
        groupId: adminGroup.id
      });
      writeMemberships(memberships);
      console.log('Assigned admin user to Administrators group');
    }
  }

  const workflows = readWorkflows();
  if (!workflows.some(workflow => workflow.id === 'demo-agent-write-if-approved')) {
    workflows.push(createDemoWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created demo workflow: demo-agent-write-if-approved');
  }

  if (!workflows.some(workflow => workflow.id === 'legal-intake')) {
    workflows.push(createLegalIntakeWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: legal-intake');
  }

  if (!workflows.some(workflow => workflow.id === 'customer-support-triage')) {
    workflows.push(createCustomerSupportTriageWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: customer-support-triage');
  }

  if (!workflows.some(workflow => workflow.id === 'customer-support-triage-ticket-plan')) {
    workflows.push(createCustomerSupportTicketPlanWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: customer-support-triage-ticket-plan');
  }

  if (!workflows.some(workflow => workflow.id === 'customer-support-triage-chunk')) {
    workflows.push(createCustomerSupportChunkWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: customer-support-triage-chunk');
  }

  if (!workflows.some(workflow => workflow.id === 'customer-support-triage-aggregate')) {
    workflows.push(createCustomerSupportAggregateWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: customer-support-triage-aggregate');
  }

  if (!workflows.some(workflow => workflow.id === 'vendor-compliance')) {
    workflows.push(createVendorComplianceWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: vendor-compliance');
  }

  if (!workflows.some(workflow => workflow.id === 'vendor-remediation-plan')) {
    workflows.push(createVendorRemediationWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: vendor-remediation-plan');
  }

  if (!workflows.some(workflow => workflow.id === 'vendor-remediation-failure-handoff')) {
    workflows.push(createVendorRemediationFailureHandoffWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: vendor-remediation-failure-handoff');
  }

  if (!workflows.some(workflow => workflow.id === 'shared-drive-cleanup')) {
    workflows.push(createSharedDriveCleanupWorkflowDefinition());
    writeWorkflows(workflows);
    console.log('Created workflow: shared-drive-cleanup');
  }
}

// Start server
async function start() {
  try {
    const writerLockResult = acquireDataDirWriterLock();
    if (!writerLockResult.acquired) {
      const owner = writerLockResult.lock || {};
      throw new Error(
        'DATA_DIR writer lock is owned by a live process; refusing startup. ' +
        `pid=${owner.pid || 'unknown'} dataDir=${owner.dataDir || DATA_DIR}`
      );
    }
    startDataDirWriterLockHeartbeat();

    await createDefaultData();
    interruptStaleRunsOnStartup();
    startRuntimeScheduler();
    startTemplateScheduler();
    serverReady = true;
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${PORT}`);
  } catch (err) {
    releaseDataDirWriterLock();
    console.error(err && err.message ? err.message : err);
    fastify.log.error(err);
    process.exit(1);
  }
}

function shutdown(signal) {
  try {
    if (runtimeScheduler && runtimeScheduler.isRunning()) runtimeScheduler.stop();
    if (runtimeTemplateScheduler && runtimeTemplateScheduler.isRunning()) runtimeTemplateScheduler.stop();
    releaseDataDirWriterLock();
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('exit', () => {
  try {
    releaseDataDirWriterLock();
  } catch (_) {}
});

start();
