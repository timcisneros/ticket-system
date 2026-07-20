'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool } = require('pg');
const {
  RUN_EVENT_SCHEMA_VERSION,
  computeRunEventHash,
  validateCurrentEventEnvelope
} = require('../../runtime/event-integrity');
const {
  buildProcessTemplateState,
  emptyGeneratedTicketCounts
} = require('../process-template-projection');
const {
  ProcessTemplateConflictError,
  computeNextRunAt,
  scheduleHasReusableInterval,
  triggerSpawnIdempotencyKey
} = require('../process-template-authority');
const { installAccessCatalogMethods } = require('./access-catalog-methods');
const { installWorkflowCatalogMethods } = require('./workflow-catalog-methods');
const { installModelRoutingPolicyMethods } = require('./model-routing-policy-methods');
const { installConnectorAuthorityMethods } = require('./connector-authority-methods');
const { installWatcherAuthorityMethods } = require('./watcher-authority-methods');
const { installRuntimeLimitsMethods } = require('./runtime-limits-methods');
const { installApplicationStateMethods } = require('./application-state-methods');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TICKET_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed']);
const RUN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'interrupted']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const RUN_RECOVERY_MODES = new Set(['lease_expiry', 'process_restart']);
const OPERATION_OUTCOMES = new Set(['succeeded', 'failed', 'refused']);
const RUN_EXECUTION_PHASES = new Set(['planning', 'inspection', 'mutation', 'verification', 'terminalization']);
const RUN_PHASE_TRANSITIONS = new Map([
  ['planning', new Set(['planning', 'inspection', 'mutation', 'verification'])],
  ['inspection', new Set(['inspection', 'mutation', 'verification'])],
  ['mutation', new Set(['mutation', 'verification'])],
  ['verification', new Set(['verification', 'terminalization'])],
  ['terminalization', new Set(['terminalization'])]
]);
const SINGULAR_TERMINAL_REPAIR_EVENT_TYPES = new Set([
  'run.postconditions_checked',
  'run.verification_failed',
  'run.verification_passed',
  'run.triage_created',
  'run.snapshot_finalized',
  'replay.snapshot.finalized',
  'run.violations_checked',
  'run.evaluation_completed',
  'run.consequence_recorded',
  'run.terminalized'
]);
const RUN_STATUS_TRANSITIONS = new Map([
  ['pending', new Set(['pending', 'running', 'failed', 'interrupted'])],
  ['running', new Set(['running', 'pending', 'completed', 'failed', 'interrupted'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['interrupted', new Set()]
]);

class OptimisticConcurrencyError extends Error {
  constructor(entity, id, expectedRevision, current = null) {
    super(`${entity} ${id} did not match expected revision ${expectedRevision}`);
    this.name = 'OptimisticConcurrencyError';
    this.code = 'OPTIMISTIC_CONCURRENCY_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedRevision = expectedRevision;
    this.current = current;
  }
}

class ImmutableEvidenceConflictError extends Error {
  constructor(kind, runId) {
    super(`${kind} for run ${runId} already exists with different evidence`);
    this.name = 'ImmutableEvidenceConflictError';
    this.code = 'IMMUTABLE_EVIDENCE_CONFLICT';
    this.kind = kind;
    this.runId = runId;
  }
}

class IdempotencyConflictError extends Error {
  constructor(runId, idempotencyKey) {
    super(`Operation receipt idempotency key conflicts for run ${runId}: ${idempotencyKey}`);
    this.name = 'IdempotencyConflictError';
    this.code = 'IDEMPOTENCY_CONFLICT';
    this.runId = runId;
    this.idempotencyKey = idempotencyKey;
  }
}

class StateTransitionConflictError extends Error {
  constructor(entity, id, expectedStatuses, current) {
    super(`${entity} ${id} is ${current.status}; expected ${expectedStatuses.join(' or ')}`);
    this.name = 'StateTransitionConflictError';
    this.code = 'STATE_TRANSITION_CONFLICT';
    this.entity = entity;
    this.entityId = id;
    this.expectedStatuses = expectedStatuses;
    this.current = current;
  }
}

class TriageConflictError extends Error {
  constructor(entity, id, current = null) {
    super(`${entity} ${id} does not have unresolved triage`);
    this.name = 'TriageConflictError';
    this.code = 'TRIAGE_NOT_REQUIRED';
    this.entity = entity;
    this.entityId = id;
    this.current = current;
  }
}

class LeaseAuthorityError extends Error {
  constructor(runId, leaseOwner, current) {
    super(`Run ${runId} is not controlled by a live lease for ${leaseOwner || '(no owner)'}`);
    this.name = 'LeaseAuthorityError';
    this.code = 'LEASE_AUTHORITY_CONFLICT';
    this.runId = runId;
    this.leaseOwner = leaseOwner;
    this.current = current;
  }
}

class RunPhaseConflictError extends Error {
  constructor(runId, expectedPhase, currentPhase) {
    super(`Run ${runId} phase is ${currentPhase}; expected ${expectedPhase}`);
    this.name = 'RunPhaseConflictError';
    this.code = 'RUN_PHASE_CONFLICT';
    this.runId = runId;
    this.expectedPhase = expectedPhase;
    this.currentPhase = currentPhase;
  }
}

class PostgresRuntimeIntegrityError extends Error {
  constructor(storeName, message) {
    super(`PostgreSQL runtime integrity check failed for ${storeName}: ${message}`);
    this.name = 'PostgresRuntimeIntegrityError';
    this.code = 'POSTGRES_RUNTIME_INTEGRITY_FAILURE';
    this.storeName = storeName;
  }
}

function quoteIdentifier(value) {
  const normalized = String(value || '');
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(`Invalid PostgreSQL identifier: ${normalized}`);
  }
  return `"${normalized}"`;
}

function positiveSafeInteger(value, label) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return number;
}

function nonNegativeSafeInteger(value, label) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function normalizeRunRecoveryMode(value) {
  const mode = requiredString(value || 'lease_expiry', 'mode');
  if (!RUN_RECOVERY_MODES.has(mode)) throw new TypeError(`Unsupported run recovery mode: ${mode}`);
  return mode;
}

function nullablePositiveSafeInteger(value, label) {
  if (value === undefined || value === null) return null;
  return positiveSafeInteger(value, label);
}

function boundedPositiveIds(value, maximum, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `${label}[${index}]`)))];
  if (ids.length > maximum) throw new RangeError(`${label} exceeds the configured maximum of ${maximum}`);
  return ids;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function jsonObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requiredString(value, label, maxLength = null) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  if (maxLength !== null && normalized.length > maxLength) {
    throw new RangeError(`${label} exceeds ${maxLength} characters`);
  }
  return normalized;
}

function normalizeRunPhase(value, label = 'phase') {
  const phase = requiredString(value || 'planning', label);
  if (!RUN_EXECUTION_PHASES.has(phase)) throw new TypeError(`Unsupported ${label}: ${phase}`);
  return phase;
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeStatuses(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  return [...new Set(value.map(item => requiredString(item, label)))].map(status => {
    if (!allowed.has(status)) throw new TypeError(`Unsupported ${label}: ${status}`);
    return status;
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function normalizeWorkspacePath(value) {
  const raw = String(value === undefined || value === null ? '' : value).replaceAll('\\', '/').trim();
  if (raw === '' || raw === '.') return '';
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || raw.includes('\0')) {
    throw new TypeError(`Unsafe workspace path: ${raw}`);
  }
  const parts = raw.split('/').filter(part => part && part !== '.');
  if (parts.some(part => part === '..')) throw new TypeError(`Unsafe workspace path: ${raw}`);
  return parts.join('/');
}

function workspaceMutationFingerprint(operation, args = {}) {
  if (operation === 'writeFile') return `writeFile:${args.path}`;
  if (operation === 'createFolder') return `createFolder:${args.path}`;
  if (operation === 'renamePath') return `renamePath:${args.path}->${args.nextPath}`;
  if (operation === 'deletePath') return `deletePath:${args.path}`;
  return null;
}

function workspaceArtifactPath(operation, args = {}) {
  if (operation === 'writeFile' || operation === 'createFolder') return normalizeWorkspacePath(args.path);
  if (operation === 'renamePath') return normalizeWorkspacePath(args.nextPath);
  return null;
}

function workspacePathAncestors(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) return [];
  const parts = normalized.split('/');
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/g, character => `\\${character}`);
}

// Hierarchical advisory-lock plan. Non-root mutations take shared locks on
// ancestors and an exclusive lock on the exact path. A parent mutation takes an
// exclusive lock on that parent, so it conflicts with descendants without
// globally serializing unrelated top-level paths.
function buildWorkspaceLockRequests(targetId, paths) {
  const target = String(targetId || '').trim();
  if (!target) throw new TypeError('targetId is required');
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('paths must be a non-empty array');

  const modes = new Map();
  for (const value of paths) {
    const normalized = normalizeWorkspacePath(value);
    const parts = normalized ? normalized.split('/') : [];
    const resources = [`workspace:${target}:`];
    for (let index = 0; index < parts.length; index += 1) {
      resources.push(`workspace:${target}:${parts.slice(0, index + 1).join('/')}`);
    }
    resources.forEach((resource, index) => {
      const mode = index === resources.length - 1 ? 'exclusive' : 'shared';
      if (mode === 'exclusive' || !modes.has(resource)) modes.set(resource, mode);
    });
  }

  return [...modes.entries()]
    .map(([resource, mode]) => ({ resource, mode }))
    .sort((left, right) => left.resource.localeCompare(right.resource));
}

function buildEventEnvelope({ event, eventId, timestamp, chain = null }) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const ticketId = nullablePositiveSafeInteger(input.ticketId, 'event.ticketId');
  const runId = nullablePositiveSafeInteger(input.runId, 'event.runId');
  const normalized = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    id: String(eventId || '').trim(),
    ts: isoTimestamp(timestamp, 'event timestamp'),
    type: typeof input.type === 'string' && input.type.trim() ? input.type.trim() : 'event',
    ticketId,
    runId,
    stepId: input.stepId === undefined || input.stepId === null ? null : String(input.stepId),
    payload: jsonObject(input.payload || {}, 'event.payload')
  };

  if (!normalized.id) throw new TypeError('eventId is required');
  if (runId !== null) {
    if (ticketId === null) throw new TypeError('Run events require ticketId');
    const nextSeq = nonNegativeSafeInteger(chain && chain.nextSeq, 'chain.nextSeq');
    const previousHash = chain && chain.previousHash !== undefined ? chain.previousHash : null;
    if (nextSeq === 0 && previousHash !== null) throw new TypeError('The first run event cannot have a previous hash');
    if (nextSeq > 0 && !/^[0-9a-f]{64}$/.test(String(previousHash || ''))) {
      throw new TypeError('A continued run event requires a valid previous hash');
    }
    normalized.seq = nextSeq;
    normalized.prevHash = previousHash;
    normalized.hash = computeRunEventHash(normalized);
  }

  const errors = validateCurrentEventEnvelope(normalized);
  if (errors.length > 0) throw new TypeError(errors[0].message);
  return normalized;
}

function rowTimestamp(value) {
  return value === null || value === undefined ? null : isoTimestamp(value, 'database timestamp');
}

function eventFromRow(row) {
  const event = {
    schemaVersion: Number(row.schema_version),
    id: row.id,
    ts: rowTimestamp(row.ts),
    type: row.type,
    ticketId: nullablePositiveSafeInteger(row.ticket_id, 'event.ticketId'),
    runId: nullablePositiveSafeInteger(row.run_id, 'event.runId'),
    stepId: row.step_id,
    payload: row.payload
  };
  if (event.runId !== null) {
    event.seq = nonNegativeSafeInteger(row.seq, 'event.seq');
    event.prevHash = row.prev_hash;
    event.hash = row.hash;
  }
  return event;
}

function diagnosticLogFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  const record = {
    ...body,
    id: positiveSafeInteger(row.id, 'diagnosticLog.id'),
    timestamp: rowTimestamp(row.occurred_at),
    runId: nullablePositiveSafeInteger(row.run_id, 'diagnosticLog.runId'),
    ticketId: nullablePositiveSafeInteger(row.ticket_id, 'diagnosticLog.ticketId'),
    type: row.type
  };
  const contextRunId = nullablePositiveSafeInteger(row.context_run_id, 'diagnosticLog.contextRunId');
  const contextTicketId = nullablePositiveSafeInteger(row.context_ticket_id, 'diagnosticLog.contextTicketId');
  if (contextRunId !== null) record.contextRunId = contextRunId;
  if (contextTicketId !== null) record.contextTicketId = contextTicketId;
  return record;
}

function workContextFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    ...body,
    id: positiveSafeInteger(row.id, 'workContext.id'),
    name: row.name,
    status: row.status,
    revision: positiveSafeInteger(row.revision, 'workContext.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function configuredAgentFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    ...body,
    id: positiveSafeInteger(row.id, 'configuredAgent.id'),
    name: row.name,
    type: 'agent',
    provider: row.provider,
    model: row.model,
    revision: positiveSafeInteger(row.revision, 'configuredAgent.revision'),
    createdAt: rowTimestamp(row.created_at),
    changedBy: row.updated_by,
    changedAt: rowTimestamp(row.updated_at)
  };
}

function processTemplateFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  const record = {
    ...body,
    id: positiveSafeInteger(row.id, 'processTemplate.id'),
    name: row.name,
    enabled: row.enabled === true,
    workContextId: nullablePositiveSafeInteger(row.work_context_id, 'processTemplate.workContextId'),
    currentVersion: positiveSafeInteger(row.current_version, 'processTemplate.currentVersion'),
    currentVersionId: row.current_version_id || null,
    revision: positiveSafeInteger(row.revision, 'processTemplate.revision'),
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    updatedBy: row.updated_by,
    updatedAt: rowTimestamp(row.updated_at)
  };
  if (record.workContextId === null) delete record.workContextId;
  if (record.schedule && typeof record.schedule === 'object' && !Array.isArray(record.schedule)) {
    record.schedule = {
      ...record.schedule,
      enabled: row.schedule_enabled === true,
      nextRunAt: row.next_run_at ? rowTimestamp(row.next_run_at) : null
    };
  }
  return record;
}

function processTemplateVersionFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    ...body,
    id: row.id,
    templateId: positiveSafeInteger(row.template_id, 'processTemplateVersion.templateId'),
    version: positiveSafeInteger(row.version, 'processTemplateVersion.version'),
    status: row.status,
    name: row.name,
    ticketTemplate: row.ticket_template,
    executionPolicy: body.executionPolicy || null,
    createdBy: row.created_by,
    createdAt: rowTimestamp(row.created_at),
    activatedBy: row.activated_by || null,
    activatedAt: row.activated_at ? rowTimestamp(row.activated_at) : null,
    supersedesVersionId: row.supersedes_version_id || null,
    changeSummary: body.changeSummary || null
  };
}

function processTemplateTriggerFromRow(row) {
  const body = row.body && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body : {};
  return {
    ...body,
    id: positiveSafeInteger(row.id, 'processTemplateTrigger.id'),
    triggerToken: row.trigger_token,
    templateId: positiveSafeInteger(row.template_id, 'processTemplateTrigger.templateId'),
    templateVersion: positiveSafeInteger(row.template_version, 'processTemplateTrigger.templateVersion'),
    ticketId: positiveSafeInteger(row.ticket_id, 'processTemplateTrigger.ticketId'),
    triggerType: row.trigger_type,
    triggeredBy: row.triggered_by,
    scheduledFor: row.scheduled_for ? rowTimestamp(row.scheduled_for) : null,
    createdAt: rowTimestamp(row.created_at)
  };
}

function ticketFromRow(row) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'ticket.id'),
    status: row.status,
    assignmentTargetType: row.assignment_target_type,
    assignmentTargetId: nullablePositiveSafeInteger(row.assignment_target_id, 'ticket.assignmentTargetId'),
    revision: positiveSafeInteger(row.revision, 'ticket.revision'),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function runFromRow(row) {
  return {
    ...(row.body || {}),
    id: positiveSafeInteger(row.id, 'run.id'),
    ticketId: positiveSafeInteger(row.ticket_id, 'run.ticketId'),
    agentId: positiveSafeInteger(row.agent_id, 'run.agentId'),
    status: row.status,
    executionMode: row.execution_mode,
    currentPhase: normalizeRunPhase(row.current_phase, 'run.currentPhase'),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: rowTimestamp(row.lease_expires_at),
    lastHeartbeatAt: rowTimestamp(row.last_heartbeat_at),
    revision: positiveSafeInteger(row.revision, 'run.revision'),
    startedAt: rowTimestamp(row.started_at),
    completedAt: rowTimestamp(row.completed_at),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function evaluationFromRow(row) {
  return {
    runId: positiveSafeInteger(row.run_id, 'evaluation.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'evaluation.ticketId'),
    evaluation: row.evaluation,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function consequenceFromRow(row) {
  return {
    runId: positiveSafeInteger(row.run_id, 'consequence.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'consequence.ticketId'),
    consequence: row.consequence,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function replaySnapshotFromRow(row) {
  const computedHash = sha256Json(row.snapshot);
  if (computedHash !== row.snapshot_hash) {
    const error = new Error(`Replay snapshot integrity check failed for run ${row.run_id}`);
    error.code = 'POSTGRES_REPLAY_INTEGRITY_FAILURE';
    error.expectedHash = row.snapshot_hash;
    error.computedHash = computedHash;
    throw error;
  }
  return {
    runId: positiveSafeInteger(row.run_id, 'replaySnapshot.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'replaySnapshot.ticketId'),
    snapshot: row.snapshot,
    snapshotHash: row.snapshot_hash,
    revision: positiveSafeInteger(row.revision, 'replaySnapshot.revision'),
    finalizedAt: rowTimestamp(row.finalized_at),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

function operationReceiptFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'operationReceipt.id'),
    runId: positiveSafeInteger(row.run_id, 'operationReceipt.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'operationReceipt.ticketId'),
    idempotencyKey: row.idempotency_key,
    stepId: row.step_id,
    operation: row.operation,
    outcome: row.outcome,
    targetId: row.target_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    targetResourceId: row.target_resource_id,
    workspacePath: row.workspace_path || null,
    artifactPath: row.artifact_path || null,
    mutationFingerprint: row.mutation_fingerprint || null,
    receipt: row.receipt,
    recordedAt: rowTimestamp(row.recorded_at)
  };
}

function targetOperationIntentFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'targetOperationIntent.id'),
    runId: positiveSafeInteger(row.run_id, 'targetOperationIntent.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'targetOperationIntent.ticketId'),
    operationKey: row.operation_key,
    stepId: row.step_id,
    operation: row.operation,
    targetId: row.target_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    targetResourceId: row.target_resource_id,
    intent: row.intent,
    preparedAt: rowTimestamp(row.prepared_at)
  };
}

function operatorRecoveryIntentFromRow(row) {
  return {
    id: positiveSafeInteger(row.id, 'operatorRecoveryIntent.id'),
    originalHistoryId: positiveSafeInteger(row.original_operation_receipt_id, 'operatorRecoveryIntent.originalHistoryId'),
    runId: positiveSafeInteger(row.run_id, 'operatorRecoveryIntent.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'operatorRecoveryIntent.ticketId'),
    recoveryKey: row.recovery_key,
    requestedBy: row.requested_by,
    operation: row.operation,
    targetId: row.target_id,
    targetKind: row.target_kind,
    targetPath: row.target_path,
    targetResourceId: row.target_resource_id,
    intent: row.intent,
    preparedAt: rowTimestamp(row.prepared_at)
  };
}

function operatorRecoveryReceiptProjection(envelope, intentRecord) {
  if (!envelope) return null;
  const document = envelope.receipt && typeof envelope.receipt === 'object' && !Array.isArray(envelope.receipt)
    ? envelope.receipt
    : {};
  const intent = intentRecord && intentRecord.intent ? intentRecord.intent : {};
  const error = document.error && typeof document.error === 'object' ? document.error : null;
  const recovery = document.recovery && typeof document.recovery === 'object' ? document.recovery : {};
  return {
    id: envelope.id,
    timestamp: envelope.recordedAt,
    runId: envelope.runId,
    ticketId: envelope.ticketId,
    step: document.step === undefined ? envelope.stepId : document.step,
    operation: envelope.operation,
    operationKey: envelope.idempotencyKey,
    args: document.args || intent.args || {},
    preState: document.preState || document.before || intent.preState || null,
    postState: document.postState || document.after || null,
    result: envelope.outcome === 'succeeded' ? document.result || document.providerResponse || null : null,
    error: error ? error.message || 'Operator recovery failed' : document.error || null,
    errorCode: error ? error.code || null : document.errorCode || null,
    failureKind: error ? error.failureKind || null : document.failureKind || null,
    outcome: envelope.outcome,
    isRecovery: true,
    recoveredHistoryId: recovery.originalHistoryId || intentRecord.originalHistoryId,
    recoveredBy: recovery.completedBy || document.recoveredBy || null,
    authorityDecision: document.authorityDecision || null,
    mutationReceipt: document,
    targetId: envelope.targetId,
    targetKind: envelope.targetKind,
    targetPath: envelope.targetPath,
    targetResourceId: envelope.targetResourceId,
    workspacePath: envelope.workspacePath,
    artifactPath: envelope.artifactPath,
    mutationFingerprint: envelope.mutationFingerprint
  };
}

function targetOperationReceiptProjection(envelope, intentRecord) {
  if (!envelope) return null;
  const document = envelope.receipt || {};
  const intent = intentRecord && intentRecord.intent ? intentRecord.intent : {};
  const error = document.error && typeof document.error === 'object' ? document.error : null;
  return {
    id: envelope.id,
    timestamp: envelope.recordedAt,
    runId: envelope.runId,
    ticketId: envelope.ticketId,
    step: envelope.stepId,
    operation: envelope.operation,
    operationKey: envelope.idempotencyKey,
    args: intent.args || {},
    preState: document.before || intent.preState || null,
    postState: document.after || null,
    result: envelope.outcome === 'succeeded' ? document.providerResponse || null : null,
    error: error ? error.message || 'Target operation failed' : null,
    errorCode: error ? error.code || null : null,
    failureKind: error ? error.failureKind || null : null,
    outcome: envelope.outcome,
    isRecovery: document.reconciliation === 'applied_effect_confirmed',
    authorityDecision: document.authorityDecision || intent.authorityDecision || null,
    mutationReceipt: document,
    targetId: envelope.targetId,
    targetKind: envelope.targetKind,
    targetPath: envelope.targetPath,
    targetResourceId: envelope.targetResourceId,
    workspacePath: envelope.workspacePath,
    artifactPath: envelope.artifactPath,
    mutationFingerprint: envelope.mutationFingerprint
  };
}

function actionOperationReceiptProjection(envelope) {
  if (!envelope) return null;
  const document = envelope.receipt && typeof envelope.receipt === 'object' && !Array.isArray(envelope.receipt)
    ? envelope.receipt
    : {};
  return {
    ...document,
    id: envelope.id,
    timestamp: envelope.recordedAt,
    runId: envelope.runId,
    ticketId: envelope.ticketId,
    step: document.step === undefined ? envelope.stepId : document.step,
    operation: envelope.operation,
    operationKey: envelope.idempotencyKey,
    outcome: envelope.outcome,
    targetId: envelope.targetId || document.targetId || null,
    targetKind: envelope.targetKind || document.targetKind || null,
    targetPath: envelope.targetPath || document.targetPath || null,
    targetResourceId: envelope.targetResourceId || document.targetResourceId || null
  };
}

class PostgresRuntimeStore {
  constructor({
    connectionString,
    pool = null,
    schema = 'ticket_system',
    maxConnections = 16,
    connectionTimeoutMs = 5_000,
    statementTimeoutMs = 30_000,
    lockTimeoutMs = 5_000,
    maxQueryRows = 1_000,
    maxEligibleRunIds = 1_000,
    maxJsonRecordBytes = 2 * 1024 * 1024,
    defaultMaxActiveRuns = 32,
    defaultLocalModelConcurrency = 1
  } = {}) {
    this.schema = String(schema || 'ticket_system');
    this.schemaSql = quoteIdentifier(this.schema);
    this.lockTimeoutMs = positiveSafeInteger(lockTimeoutMs, 'lockTimeoutMs');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this.maxEligibleRunIds = positiveSafeInteger(maxEligibleRunIds, 'maxEligibleRunIds');
    this.maxJsonRecordBytes = positiveSafeInteger(maxJsonRecordBytes, 'maxJsonRecordBytes');
    this.defaultMaxActiveRuns = positiveSafeInteger(defaultMaxActiveRuns, 'defaultMaxActiveRuns');
    this.defaultLocalModelConcurrency = positiveSafeInteger(defaultLocalModelConcurrency, 'defaultLocalModelConcurrency');
    this.targetOperationClientStorage = new AsyncLocalStorage();
    this.ownsPool = !pool;
    if (!pool && (typeof connectionString !== 'string' || !connectionString.trim())) {
      throw new TypeError('connectionString is required when pool is not provided');
    }
    this.pool = pool || new Pool({
      connectionString,
      max: positiveSafeInteger(maxConnections, 'maxConnections'),
      connectionTimeoutMillis: positiveSafeInteger(connectionTimeoutMs, 'connectionTimeoutMs'),
      statement_timeout: positiveSafeInteger(statementTimeoutMs, 'statementTimeoutMs')
    });
  }

  table(name) {
    return `${this.schemaSql}.${quoteIdentifier(name)}`;
  }

  assertJsonRecord(value, label) {
    const record = jsonObject(value, label);
    const bytes = Buffer.byteLength(canonicalJson(record), 'utf8');
    if (bytes > this.maxJsonRecordBytes) {
      const error = new RangeError(`${label} exceeds the configured maximum of ${this.maxJsonRecordBytes} bytes`);
      error.code = 'POSTGRES_RECORD_TOO_LARGE';
      error.recordBytes = bytes;
      error.maxRecordBytes = this.maxJsonRecordBytes;
      throw error;
    }
    return record;
  }

  async acquireRuntimeAuthority() {
    await this.health();
    return Object.freeze({
      backend: 'postgres',
      mode: 'shared_transactional',
      owner: null
    });
  }

  async prepareRuntimePersistence() {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);

      const migrationTableName = `${this.schema}.schema_migrations`;
      const migrationTable = await client.query('SELECT to_regclass($1) AS name', [migrationTableName]);
      if (!migrationTable.rows[0] || migrationTable.rows[0].name === null) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migrations',
          'schema is not initialized; run the explicit migration command before startup'
        );
      }
      const expectedMigrations = fs.readdirSync(MIGRATIONS_DIR)
        .filter(name => name.endsWith('.sql'))
        .sort();
      const migrationResult = await client.query(
        `SELECT version FROM ${this.table('schema_migrations')} ORDER BY version`
      );
      const appliedMigrations = new Set(migrationResult.rows.map(row => row.version));
      const missingMigrations = expectedMigrations.filter(version => !appliedMigrations.has(version));
      if (missingMigrations.length > 0) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migrations',
          `missing required migration(s): ${missingMigrations.join(', ')}`
        );
      }
      const requiredRelations = [
        'tickets',
        'runs',
        'run_event_chain_tips',
        'events',
        'run_evaluations',
        'run_consequences',
        'replay_snapshots',
        'operation_receipts',
        'target_operation_intents',
        'operator_recovery_intents',
        'runtime_status_counts',
        'diagnostic_logs',
        'work_contexts',
        'configured_agents',
        'agent_group_memberships',
        'access_permissions',
        'access_groups',
        'access_group_permissions',
        'access_users',
        'user_group_memberships',
        'process_templates',
        'process_template_status_counts',
        'process_template_versions',
        'process_template_triggers',
        'workflow_definitions',
        'model_routing_policies',
        'connectors',
        'connector_status_counts',
        'connector_receipts',
        'watchers',
        'watcher_status_counts',
        'watcher_observations',
        'watcher_ticket_proposals',
        'runtime_limit_config',
        'browser_targets',
        'work_types',
        'allocation_plans',
        'message_threads',
        'message_thread_messages',
        'http_sessions',
        'local_connector_objects'
      ];
      const relationResult = await client.query(
        `SELECT relation_name
         FROM unnest($2::text[]) AS relation(relation_name)
         WHERE to_regclass($1 || '.' || relation_name) IS NULL
         ORDER BY relation_name`,
        [this.schema, requiredRelations]
      );
      if (relationResult.rowCount > 0) {
        const missingRelations = relationResult.rows.map(row => row.relation_name);
        throw new PostgresRuntimeIntegrityError(
          'runtime_schema',
          `missing required relation(s): ${missingRelations.join(', ')}`
        );
      }
      const requiredTriggers = [
        ['events', 'events_append_only'],
        ['tickets', 'tickets_revision_guard'],
        ['runs', 'runs_revision_guard'],
        ['run_evaluations', 'run_evaluations_append_only'],
        ['run_consequences', 'run_consequences_append_only'],
        ['operation_receipts', 'operation_receipts_append_only'],
        ['replay_snapshots', 'replay_snapshots_terminal_guard'],
        ['replay_snapshots', 'replay_snapshots_mutation_guard'],
        ['target_operation_intents', 'target_operation_intents_append_only'],
        ['operator_recovery_intents', 'operator_recovery_intents_append_only'],
        ['tickets', 'tickets_runtime_status_count'],
        ['runs', 'runs_runtime_status_count'],
        ['diagnostic_logs', 'diagnostic_logs_append_only'],
        ['work_contexts', 'work_contexts_revision_guard'],
        ['configured_agents', 'configured_agents_revision_guard'],
        ['access_permissions', 'access_permissions_migration_owned'],
        ['access_groups', 'access_groups_revision_guard'],
        ['access_users', 'access_users_revision_guard'],
        ['process_templates', 'process_templates_revision_guard'],
        ['process_templates', 'process_templates_status_count'],
        ['process_template_versions', 'process_template_versions_immutability_guard'],
        ['process_template_triggers', 'process_template_triggers_append_only'],
        ['workflow_definitions', 'workflow_definitions_revision_guard'],
        ['model_routing_policies', 'model_routing_policies_revision_guard'],
        ['connectors', 'connectors_revision_guard'],
        ['connectors', 'connectors_status_count'],
        ['connector_receipts', 'connector_receipts_append_only'],
        ['watchers', 'watchers_revision_guard'],
        ['watchers', 'watchers_status_count'],
        ['watcher_observations', 'watcher_observations_append_only'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_revision_guard'],
        ['runtime_limit_config', 'runtime_limit_config_revision_guard'],
        ['browser_targets', 'browser_targets_revision_guard'],
        ['work_types', 'work_types_revision_guard'],
        ['allocation_plans', 'allocation_plans_revision_guard'],
        ['message_threads', 'message_threads_revision_guard'],
        ['message_thread_messages', 'message_thread_messages_append_only'],
        ['local_connector_objects', 'local_connector_objects_revision_guard']
      ];
      const triggerResult = await client.query(
        `SELECT required.trigger_name
         FROM unnest($2::text[], $3::text[]) AS required(relation_name, trigger_name)
         WHERE NOT EXISTS (
           SELECT 1
           FROM pg_trigger AS trigger_record
           JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = $1
             AND relation.relname = required.relation_name
             AND trigger_record.tgname = required.trigger_name
             AND NOT trigger_record.tgisinternal
         )
         ORDER BY required.trigger_name`,
        [
          this.schema,
          requiredTriggers.map(([relationName]) => relationName),
          requiredTriggers.map(([, triggerName]) => triggerName)
        ]
      );
      if (triggerResult.rowCount > 0) {
        const missingTriggers = triggerResult.rows.map(row => row.trigger_name);
        throw new PostgresRuntimeIntegrityError(
          'runtime_schema',
          `missing required trigger(s): ${missingTriggers.join(', ')}`
        );
      }
      const requiredConstraints = [
        ['runs', 'runs_lease_complete'],
        ['runs', 'runs_current_phase_check'],
        ['runs', 'runs_terminal_phase_shape'],
        ['runs', 'runs_configured_agent_fk'],
        ['run_event_chain_tips', 'run_event_chain_tip_hash'],
        ['events', 'events_run_seq_unique'],
        ['events', 'events_chain_shape'],
        ['operation_receipts', 'operation_receipts_idempotency_unique'],
        ['operation_receipts', 'operation_receipts_workspace_projection_shape'],
        ['operation_receipts', 'operation_receipts_identity_owner_unique'],
        ['target_operation_intents', 'target_operation_intents_operation_key_unique'],
        ['operator_recovery_intents', 'operator_recovery_intents_original_owner_fk'],
        ['operator_recovery_intents', 'operator_recovery_intents_run_ticket_fk'],
        ['operator_recovery_intents', 'operator_recovery_intents_original_unique'],
        ['operator_recovery_intents', 'operator_recovery_intents_recovery_key_unique'],
        ['runtime_status_counts', 'runtime_status_counts_nonnegative'],
        ['diagnostic_logs', 'diagnostic_logs_run_ticket_fk'],
        ['diagnostic_logs', 'diagnostic_logs_context_run_ticket_fk'],
        ['diagnostic_logs', 'diagnostic_logs_scope_shape'],
        ['diagnostic_logs', 'diagnostic_logs_context_shape'],
        ['work_contexts', 'work_contexts_status_check'],
        ['work_contexts', 'work_contexts_body_object'],
        ['work_contexts', 'work_contexts_revision_positive'],
        ['configured_agents', 'configured_agents_name_unique'],
        ['configured_agents', 'configured_agents_provider_check'],
        ['configured_agents', 'configured_agents_body_object'],
        ['configured_agents', 'configured_agents_revision_positive'],
        ['agent_group_memberships', 'agent_group_memberships_pkey'],
        ['agent_group_memberships', 'agent_group_memberships_agent_fk'],
        ['agent_group_memberships', 'agent_group_memberships_group_positive'],
        ['agent_group_memberships', 'agent_group_memberships_group_fk'],
        ['tickets', 'tickets_assignment_group_fk'],
        ['access_permissions', 'access_permissions_pkey'],
        ['access_permissions', 'access_permissions_name_trimmed'],
        ['access_groups', 'access_groups_name_unique'],
        ['access_groups', 'access_groups_name_trimmed'],
        ['access_groups', 'access_groups_body_object'],
        ['access_groups', 'access_groups_revision_positive'],
        ['access_group_permissions', 'access_group_permissions_pkey'],
        ['access_group_permissions', 'access_group_permissions_group_fk'],
        ['access_group_permissions', 'access_group_permissions_permission_fk'],
        ['access_users', 'access_users_username_unique'],
        ['access_users', 'access_users_username_trimmed'],
        ['access_users', 'access_users_body_object'],
        ['access_users', 'access_users_revision_positive'],
        ['user_group_memberships', 'user_group_memberships_pkey'],
        ['user_group_memberships', 'user_group_memberships_user_fk'],
        ['user_group_memberships', 'user_group_memberships_group_fk'],
        ['process_templates', 'process_templates_body_object'],
        ['process_templates', 'process_templates_revision_positive'],
        ['process_templates', 'process_templates_schedule_cursor'],
        ['process_templates', 'process_templates_active_version_fk'],
        ['process_templates', 'process_templates_schedule_body_shape'],
        ['process_template_status_counts', 'process_template_status_counts_shard_range'],
        ['process_template_status_counts', 'process_template_status_counts_nonnegative'],
        ['process_template_versions', 'process_template_versions_template_version_unique'],
        ['process_template_versions', 'process_template_versions_ticket_template_object'],
        ['process_template_versions', 'process_template_versions_body_object'],
        ['process_template_versions', 'process_template_versions_activation_shape'],
        ['process_template_versions', 'process_template_versions_identity_unique'],
        ['process_template_triggers', 'process_template_triggers_body_object'],
        ['process_template_triggers', 'process_template_triggers_schedule_shape'],
        ['process_template_triggers', 'process_template_triggers_template_version_fk'],
        ['process_template_triggers', 'process_template_triggers_ticket_source_identity_unique'],
        ['tickets', 'tickets_process_template_source_current_shape'],
        ['tickets', 'tickets_process_template_trigger_source_fk'],
        ['workflow_definitions', 'workflow_definitions_id_trimmed'],
        ['workflow_definitions', 'workflow_definitions_body_object'],
        ['workflow_definitions', 'workflow_definitions_revision_positive'],
        ['tickets', 'tickets_workflow_definition_fk'],
        ['model_routing_policies', 'model_routing_policies_name_trimmed'],
        ['model_routing_policies', 'model_routing_policies_status_check'],
        ['model_routing_policies', 'model_routing_policies_body_object'],
        ['model_routing_policies', 'model_routing_policies_revision_positive'],
        ['model_routing_policies', 'model_routing_policies_work_context_fk'],
        ['tickets', 'tickets_routing_policy_body_shape'],
        ['tickets', 'tickets_routing_policy_fk'],
        ['connectors', 'connectors_name_trimmed'],
        ['connectors', 'connectors_status_check'],
        ['connectors', 'connectors_kind_check'],
        ['connectors', 'connectors_body_object'],
        ['connectors', 'connectors_revision_positive'],
        ['connectors', 'connectors_work_context_fk'],
        ['connectors', 'connectors_identity_work_context_unique'],
        ['connector_status_counts', 'connector_status_counts_primary_key'],
        ['connector_status_counts', 'connector_status_counts_identity'],
        ['connector_status_counts', 'connector_status_counts_nonnegative'],
        ['connector_receipts', 'connector_receipts_operation_check'],
        ['connector_receipts', 'connector_receipts_result_status_check'],
        ['connector_receipts', 'connector_receipts_body_object'],
        ['connector_receipts', 'connector_receipts_connector_context_fk'],
        ['watchers', 'watchers_name_trimmed'],
        ['watchers', 'watchers_status_check'],
        ['watchers', 'watchers_source_kind_check'],
        ['watchers', 'watchers_body_object'],
        ['watchers', 'watchers_revision_positive'],
        ['watchers', 'watchers_work_context_fk'],
        ['watchers', 'watchers_identity_work_context_unique'],
        ['watcher_status_counts', 'watcher_status_counts_primary_key'],
        ['watcher_status_counts', 'watcher_status_counts_identity'],
        ['watcher_status_counts', 'watcher_status_counts_nonnegative'],
        ['watcher_observations', 'watcher_observations_status_check'],
        ['watcher_observations', 'watcher_observations_hash_shape'],
        ['watcher_observations', 'watcher_observations_body_object'],
        ['watcher_observations', 'watcher_observations_watcher_context_fk'],
        ['watcher_observations', 'watcher_observations_identity_unique'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_status_check'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_body_object'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_revision_positive'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_disposition_shape'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_watcher_context_fk'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_observation_context_fk'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_created_ticket_fk'],
        ['watcher_ticket_proposals', 'watcher_ticket_proposals_identity_unique'],
        ['tickets', 'tickets_watcher_proposal_body_shape'],
        ['tickets', 'tickets_watcher_proposal_fk'],
        ['runtime_limit_config', 'runtime_limit_config_singleton'],
        ['runtime_limit_config', 'runtime_limit_config_values'],
        ['runtime_limit_config', 'runtime_limit_config_revision_positive'],
        ['runtime_limit_config', 'runtime_limit_config_audit_shape']
      ];
      const constraintResult = await client.query(
        `SELECT required.constraint_name
         FROM unnest($2::text[], $3::text[]) AS required(relation_name, constraint_name)
         WHERE NOT EXISTS (
           SELECT 1
           FROM pg_constraint AS constraint_record
           JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
           JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = $1
             AND relation.relname = required.relation_name
             AND constraint_record.conname = required.constraint_name
         )
         ORDER BY required.constraint_name`,
        [
          this.schema,
          requiredConstraints.map(([relationName]) => relationName),
          requiredConstraints.map(([, constraintName]) => constraintName)
        ]
      );
      if (constraintResult.rowCount > 0) {
        const missingConstraints = constraintResult.rows.map(row => row.constraint_name);
        throw new PostgresRuntimeIntegrityError(
          'runtime_schema',
          `missing required constraint(s): ${missingConstraints.join(', ')}`
        );
      }

      await client.query('COMMIT');
      return {
        backend: 'postgres',
        authorityMode: 'shared_transactional',
        migrationCount: expectedMigrations.length,
        checkedRelationCount: requiredRelations.length,
        checkedIntegrityArtifactCount: requiredRelations.length +
          requiredTriggers.length + requiredConstraints.length,
        integrityMode: 'transactional_constraints'
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshRuntimeAuthority() {
    return Object.freeze({
      backend: 'postgres',
      mode: 'shared_transactional',
      owner: null
    });
  }

  async releaseRuntimeAuthority() {
    return true;
  }

  async close() {
    if (this.ownsPool && this.pool) await this.pool.end();
  }

  async migrate() {
    const client = await this.pool.connect();
    const lockName = `ticket-system:migrations:${this.schema}`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schemaSql}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table('schema_migrations')} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);

      const migrations = fs.readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort();
      const applied = [];
      for (const version of migrations) {
        await client.query('BEGIN');
        try {
          await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
          const existing = await client.query(
            `SELECT 1 FROM ${this.table('schema_migrations')} WHERE version = $1`,
            [version]
          );
          if (existing.rowCount === 0) {
            await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, version), 'utf8'));
            await client.query(
              `INSERT INTO ${this.table('schema_migrations')} (version) VALUES ($1)`,
              [version]
            );
            applied.push(version);
          }
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return applied;
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]); } catch (_) {}
      client.release();
    }
  }

  async withTransaction(operation) {
    const scopedClient = this.targetOperationClientStorage.getStore();
    if (scopedClient) return this._withClientTransaction(scopedClient, operation);
    const client = await this.pool.connect();
    try {
      return await this._withClientTransaction(client, operation);
    } finally {
      client.release();
    }
  }

  async _withClientTransaction(client, operation) {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  async health() {
    const result = await this.pool.query('SELECT 1 AS ok');
    return result.rows[0] && Number(result.rows[0].ok) === 1;
  }

  async _throwTransitionConflict(client, {
    entity,
    tableName,
    id,
    expectedRevision,
    expectedStatuses,
    fromRow,
    leaseOwner = null,
    leaseConstrained = false
  }) {
    const currentResult = await client.query(
      `SELECT * FROM ${this.table(tableName)} WHERE id = $1`,
      [id]
    );
    if (currentResult.rowCount === 0) {
      const error = new Error(`${entity} ${id} was not found`);
      error.code = 'POSTGRES_RECORD_NOT_FOUND';
      throw error;
    }
    const current = fromRow(currentResult.rows[0]);
    if (current.revision !== expectedRevision) {
      throw new OptimisticConcurrencyError(entity, id, expectedRevision, current);
    }
    if (!expectedStatuses.includes(current.status)) {
      throw new StateTransitionConflictError(entity, id, expectedStatuses, current);
    }
    if (leaseConstrained) throw new LeaseAuthorityError(id, leaseOwner, current);
    throw new StateTransitionConflictError(entity, id, expectedStatuses, current);
  }

  async createTicket(record, { client = null } = {}) {
    const ticket = this.assertJsonRecord(record, 'ticket');
    const status = requiredString(ticket.status || 'open', 'ticket.status');
    if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket.status: ${status}`);
    const values = [
      status,
      ticket.assignmentTargetType || null,
      nullablePositiveSafeInteger(ticket.assignmentTargetId, 'ticket.assignmentTargetId'),
      ticket
    ];
    const execute = async connection => {
      await this._assertTicketAssignmentTarget(connection, ticket);
      await this._assertTicketWorkflow(connection, ticket);
      await this._assertTicketRoutingPolicy(connection, ticket);
      const result = await connection.query(
        `INSERT INTO ${this.table('tickets')}
          (status, assignment_target_type, assignment_target_id, body)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *`,
        values
      );
      return ticketFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createTicketWithEvent({ ticket, eventPayload = {} }, { client = null } = {}) {
    const body = this.assertJsonRecord(ticket, 'ticket');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const execute = async connection => {
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'ticket clock');
      const record = {
        ...body,
        createdAt: now,
        updatedAt: now,
        ...(Object.prototype.hasOwnProperty.call(body, 'changedAt') ? { changedAt: now } : {})
      };
      const spawnIdempotencyKey = optionalString(record.spawnIdempotencyKey);
      if (spawnIdempotencyKey) record.spawnIdempotencyKey = spawnIdempotencyKey;
      let created;
      let inserted = true;
      if (spawnIdempotencyKey) {
        await this._assertTicketAssignmentTarget(connection, record);
        await this._assertTicketWorkflow(connection, record);
        await this._assertTicketRoutingPolicy(connection, record);
        const status = requiredString(record.status || 'open', 'ticket.status');
        if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket.status: ${status}`);
        const result = await connection.query(
          `INSERT INTO ${this.table('tickets')}
            (status, assignment_target_type, assignment_target_id, body)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            status,
            record.assignmentTargetType || null,
            nullablePositiveSafeInteger(record.assignmentTargetId, 'ticket.assignmentTargetId'),
            record
          ]
        );
        if (result.rowCount > 0) {
          created = ticketFromRow(result.rows[0]);
        } else {
          const existing = await connection.query(
            `SELECT * FROM ${this.table('tickets')} WHERE body->>'spawnIdempotencyKey' = $1`,
            [spawnIdempotencyKey]
          );
          if (existing.rowCount !== 1) throw new Error(`Ticket idempotency conflict for ${spawnIdempotencyKey}`);
          created = ticketFromRow(existing.rows[0]);
          inserted = false;
        }
      } else {
        created = await this.createTicket(record, { client: connection });
      }
      if (!inserted) return { ticket: created, event: null, created: false };
      const event = await this._appendEvent(connection, {
        type: 'ticket.created',
        ticketId: created.id,
        payload: {
          ...callerPayload,
          status: created.status,
          createdAt: created.createdAt
        }
      });
      return { ticket: created, event, created: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRun(record, { client = null } = {}) {
    const run = this.assertJsonRecord(record, 'run');
    const status = requiredString(run.status || 'pending', 'run.status');
    if (status !== 'pending') throw new TypeError('New runs must start pending');
    const currentPhase = normalizeRunPhase(run.currentPhase || 'planning', 'run.currentPhase');
    if (currentPhase !== 'planning') throw new TypeError('New runs must start in planning phase');
    const runBody = { ...run };
    delete runBody.currentPhase;
    const leaseOwner = typeof run.leaseOwner === 'string' && run.leaseOwner.trim() ? run.leaseOwner.trim() : null;
    const leaseExpiresAt = leaseOwner ? isoTimestamp(run.leaseExpiresAt, 'run.leaseExpiresAt') : null;
    const values = [
      positiveSafeInteger(run.ticketId, 'run.ticketId'),
      positiveSafeInteger(run.agentId, 'run.agentId'),
      status,
      run.executionMode === 'workflow' ? 'workflow' : 'agent',
      leaseOwner,
      leaseExpiresAt,
      run.lastHeartbeatAt ? isoTimestamp(run.lastHeartbeatAt, 'run.lastHeartbeatAt') : null,
      currentPhase,
      runBody
    ];
    const execute = async connection => {
      const result = await connection.query(
        `INSERT INTO ${this.table('runs')}
          (ticket_id, agent_id, status, execution_mode, lease_owner, lease_expires_at,
           last_heartbeat_at, current_phase, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         RETURNING *`,
        values
      );
      return runFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRunsAndStartTicket({
    ticketId,
    runDrafts,
    afterTerminalRunId = null,
    runEventPayload = () => ({}),
    ticketEventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(runDrafts) || runDrafts.length === 0) {
      throw new TypeError('runDrafts must be a non-empty array');
    }
    if (typeof runEventPayload !== 'function') throw new TypeError('runEventPayload must be a function');
    const drafts = runDrafts.map((draft, index) => {
      const run = this.assertJsonRecord(draft, `runDrafts[${index}]`);
      if (positiveSafeInteger(run.ticketId, `runDrafts[${index}].ticketId`) !== id) {
        throw new TypeError('Every run draft must belong to ticketId');
      }
      positiveSafeInteger(run.agentId, `runDrafts[${index}].agentId`);
      if (run.status !== undefined && run.status !== 'pending') {
        throw new TypeError('New runs must start pending');
      }
      return run;
    });
    const callerTicketPayload = this.assertJsonRecord(ticketEventPayload, 'ticketEventPayload');
    const predecessorId = afterTerminalRunId === null || afterTerminalRunId === undefined
      ? null
      : positiveSafeInteger(afterTerminalRunId, 'afterTerminalRunId');
    if (predecessorId !== null && drafts.length !== 1) {
      throw new TypeError('A terminal predecessor can authorize exactly one new run');
    }

    const execute = async connection => {
      const ticketResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (ticketResult.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(ticketResult.rows[0]);
      if (ticket.status !== 'open') {
        throw new StateTransitionConflictError('ticket', id, ['open'], ticket);
      }
      if (ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt) {
        const error = new Error('Cannot start runs while unresolved ticket-level triage exists');
        error.code = 'TICKET_TRIAGE_REQUIRED';
        throw error;
      }

      const agentIds = drafts.map(run => run.agentId);
      const active = await connection.query(
        `SELECT * FROM ${this.table('runs')}
         WHERE ticket_id = $1 AND agent_id = ANY($2::bigint[])
           AND status = ANY(ARRAY['pending', 'running'])
         ORDER BY id LIMIT 1`,
        [id, agentIds]
      );
      if (active.rowCount > 0) {
        const current = runFromRow(active.rows[0]);
        throw new StateTransitionConflictError('run', current.id, ['no active run for this ticket and agent'], current);
      }

      if (predecessorId !== null) {
        const predecessorResult = await connection.query(
          `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
          [predecessorId]
        );
        const predecessor = predecessorResult.rowCount === 0 ? null : runFromRow(predecessorResult.rows[0]);
        if (!predecessor || predecessor.ticketId !== id || predecessor.agentId !== drafts[0].agentId ||
            !TERMINAL_RUN_STATUSES.has(predecessor.status)) {
          throw new StateTransitionConflictError(
            'run',
            predecessorId,
            ['terminal predecessor for the requested retry'],
            predecessor || { status: 'missing' }
          );
        }
      }

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'run creation clock');
      const runs = [];
      const events = [];
      for (const draft of drafts) {
        const run = await this.createRun({
          ...draft,
          status: 'pending',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          ticketOpenedAt: ticket.updatedAt,
          createdAt: now,
          updatedAt: now
        }, { client: connection });
        runs.push(run);
        const payload = this.assertJsonRecord(runEventPayload(run), `run ${run.id} event payload`);
        events.push(await this._appendEvent(connection, {
          type: 'run.created',
          ticketId: id,
          runId: run.id,
          payload: { ...payload, status: run.status, createdAt: run.createdAt }
        }));
      }

      const transitioned = await this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses: ['open'],
        toStatus: 'in_progress',
        eventPayload: callerTicketPayload
      }, { client: connection });
      events.push(transitioned.event);
      return {
        ticket: transitioned.ticket,
        runs,
        events,
        previousStatus: transitioned.previousStatus
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async getTicket(ticketId) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const result = await this.pool.query(`SELECT * FROM ${this.table('tickets')} WHERE id = $1`, [id]);
    return result.rowCount === 0 ? null : ticketFromRow(result.rows[0]);
  }

  async getRun(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(`SELECT * FROM ${this.table('runs')} WHERE id = $1`, [id]);
    return result.rowCount === 0 ? null : runFromRow(result.rows[0]);
  }

  async countRunsForTicket(ticketId) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const result = await this.pool.query(
      `SELECT COUNT(*)::bigint AS count FROM ${this.table('runs')} WHERE ticket_id = $1`,
      [id]
    );
    const count = Number(result.rows[0].count);
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('run count exceeds safe integer range');
    return count;
  }

  async getTicketBySpawnIdempotencyKey(spawnIdempotencyKey) {
    const key = requiredString(spawnIdempotencyKey, 'spawnIdempotencyKey');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('tickets')} WHERE body->>'spawnIdempotencyKey' = $1`,
      [key]
    );
    return result.rowCount === 0 ? null : ticketFromRow(result.rows[0]);
  }

  async getTicketsBySpawnIdempotencyKeys({ spawnIdempotencyKeys } = {}) {
    if (!Array.isArray(spawnIdempotencyKeys)) throw new TypeError('spawnIdempotencyKeys must be an array');
    const keys = [...new Set(spawnIdempotencyKeys.map(value => requiredString(value, 'spawnIdempotencyKey')))];
    if (keys.length > this.maxQueryRows) {
      throw new RangeError(`spawnIdempotencyKeys exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    if (keys.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('tickets')} WHERE body->>'spawnIdempotencyKey' = ANY($1::text[]) ORDER BY id`,
      [keys]
    );
    return result.rows.map(ticketFromRow);
  }

  async listTickets({ statuses = null, afterId = 0, limit = 100 } = {}) {
    const normalizedStatuses = statuses === null || statuses === undefined
      ? null
      : normalizeStatuses(statuses, TICKET_STATUSES, 'ticket status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('tickets')}
       WHERE id > $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       ORDER BY id
       LIMIT $3`,
      [cursor, normalizedStatuses, boundedLimit + 1]
    );
    const page = result.rows.slice(0, boundedLimit).map(ticketFromRow);
    const last = page[page.length - 1] || null;
    return {
      tickets: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async listTicketPage({
    statuses = null,
    workContextId = null,
    cursorUpdatedAt = null,
    cursorId = null,
    direction = 'next',
    limit = 25
  } = {}) {
    const normalizedStatuses = statuses === null || statuses === undefined
      ? null
      : normalizeStatuses(statuses, TICKET_STATUSES, 'ticket status');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const cursorTimestamp = cursorUpdatedAt === null || cursorUpdatedAt === undefined || cursorUpdatedAt === ''
      ? null
      : isoTimestamp(cursorUpdatedAt, 'cursorUpdatedAt');
    const id = cursorId === null || cursorId === undefined || cursorId === ''
      ? null
      : positiveSafeInteger(cursorId, 'cursorId');
    if ((cursorTimestamp === null) !== (id === null)) {
      throw new TypeError('cursorUpdatedAt and cursorId must be provided together');
    }
    if (!['next', 'previous'].includes(direction)) throw new TypeError(`Unsupported direction: ${direction}`);
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const tuplePredicate = cursorTimestamp === null
      ? '($3::timestamptz IS NULL AND $4::bigint IS NULL)'
      : direction === 'previous'
        ? '(updated_at > $3::timestamptz OR (updated_at = $3::timestamptz AND id < $4::bigint))'
        : '(updated_at < $3::timestamptz OR (updated_at = $3::timestamptz AND id > $4::bigint))';
    const order = direction === 'previous'
      ? 'updated_at ASC, id DESC'
      : 'updated_at DESC, id ASC';
    const result = await this.pool.query(
      `SELECT *, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS keyset_updated_at
       FROM ${this.table('tickets')}
       WHERE ($1::text[] IS NULL OR status = ANY($1::text[]))
         AND ($2::bigint IS NULL OR body->>'workContextId' = $2::text)
         AND ${tuplePredicate}
       ORDER BY ${order}
       LIMIT $5`,
      [normalizedStatuses, contextId, cursorTimestamp, id, boundedLimit]
    );
    const page = result.rows.map(row => ({ ...ticketFromRow(row), updatedAt: row.keyset_updated_at }));
    if (direction === 'previous') page.reverse();
    if (page.length === 0) return { tickets: [], hasPrevious: false, hasNext: false };
    const first = page[0];
    const last = page[page.length - 1];
    const navigation = await this.pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM ${this.table('tickets')}
           WHERE ($1::text[] IS NULL OR status = ANY($1::text[]))
             AND ($2::bigint IS NULL OR body->>'workContextId' = $2::text)
             AND (updated_at > $3::timestamptz OR (updated_at = $3::timestamptz AND id < $4::bigint))
         ) AS has_previous,
         EXISTS (
           SELECT 1 FROM ${this.table('tickets')}
           WHERE ($1::text[] IS NULL OR status = ANY($1::text[]))
             AND ($2::bigint IS NULL OR body->>'workContextId' = $2::text)
             AND (updated_at < $5::timestamptz OR (updated_at = $5::timestamptz AND id > $6::bigint))
         ) AS has_next`,
      [normalizedStatuses, contextId, first.updatedAt, first.id, last.updatedAt, last.id]
    );
    return {
      tickets: page,
      hasPrevious: navigation.rows[0].has_previous,
      hasNext: navigation.rows[0].has_next
    };
  }

  async countTicketsByStatus({ workContextId = null } = {}) {
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const result = await this.pool.query(
      `SELECT status, COUNT(*)::bigint AS count
       FROM ${this.table('tickets')}
       WHERE $1::bigint IS NULL OR body->>'workContextId' = $1::text
       GROUP BY status`,
      [contextId]
    );
    const counts = { all: 0 };
    for (const status of TICKET_STATUSES) counts[status] = 0;
    for (const row of result.rows) {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('ticket count exceeds safe integer range');
      if (Object.prototype.hasOwnProperty.call(counts, row.status)) counts[row.status] = count;
      counts.all += count;
    }
    return counts;
  }

  async getWorkContextTicketCountsByIds({ workContextIds } = {}) {
    const ids = boundedPositiveIds(workContextIds, this.maxQueryRows, 'workContextIds');
    const result = await this.pool.query(
      `SELECT
         (body->>'workContextId')::bigint AS work_context_id,
         COUNT(*)::bigint AS ticket_count,
         COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::bigint AS open_ticket_count,
         COUNT(*) FILTER (WHERE status = 'blocked')::bigint AS blocked_ticket_count,
         COUNT(*) FILTER (WHERE body #>> '{triage,required}' = 'true')::bigint AS unresolved_triage_count
       FROM ${this.table('tickets')}
       WHERE body->>'workContextId' = ANY($1::text[])
       GROUP BY body->>'workContextId'
       ORDER BY work_context_id`,
      [ids.map(String)]
    );
    return result.rows.map(row => {
      const count = (value, label) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} exceeds safe integer range`);
        return number;
      };
      return {
        workContextId: positiveSafeInteger(row.work_context_id, 'workContextId'),
        ticketCount: count(row.ticket_count, 'ticket count'),
        openTicketCount: count(row.open_ticket_count, 'open ticket count'),
        blockedTicketCount: count(row.blocked_ticket_count, 'blocked ticket count'),
        unresolvedTriageCount: count(row.unresolved_triage_count, 'unresolved triage count')
      };
    });
  }

  async getWorkContextRuntimeSummary({ workContextId, limit = 10 } = {}) {
    const id = positiveSafeInteger(workContextId, 'workContextId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const [ticketCountsResult, runCountsResult, recentTicketsResult, ticketTriageResult, runTriageResult, recentRunsResult] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::bigint AS ticket_count,
                COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::bigint AS open_ticket_count,
                COUNT(*) FILTER (WHERE status = 'blocked')::bigint AS blocked_ticket_count,
                COUNT(*) FILTER (WHERE body #>> '{triage,required}' = 'true')::bigint AS triage_count
         FROM ${this.table('tickets')} WHERE body->>'workContextId' = $1`,
        [String(id)]
      ),
      this.pool.query(
        `SELECT COUNT(*)::bigint AS run_count,
                COUNT(*) FILTER (WHERE run.body #>> '{triage,required}' = 'true')::bigint AS triage_count
         FROM ${this.table('runs')} AS run
         JOIN ${this.table('tickets')} AS ticket ON ticket.id = run.ticket_id
         WHERE ticket.body->>'workContextId' = $1`,
        [String(id)]
      ),
      this.pool.query(
        `SELECT ticket.* FROM ${this.table('tickets')} AS ticket
         WHERE ticket.body->>'workContextId' = $1 ORDER BY ticket.id DESC LIMIT $2`,
        [String(id), boundedLimit]
      ),
      this.pool.query(
        `SELECT ticket.* FROM ${this.table('tickets')} AS ticket
         WHERE ticket.body->>'workContextId' = $1 AND ticket.body #>> '{triage,required}' = 'true'
         ORDER BY ticket.id DESC LIMIT $2`,
        [String(id), boundedLimit]
      ),
      this.pool.query(
        `SELECT run.* FROM ${this.table('runs')} AS run
         JOIN ${this.table('tickets')} AS ticket ON ticket.id = run.ticket_id
         WHERE ticket.body->>'workContextId' = $1 AND run.body #>> '{triage,required}' = 'true'
         ORDER BY run.id DESC LIMIT $2`,
        [String(id), boundedLimit]
      ),
      this.pool.query(
        `SELECT run.* FROM ${this.table('runs')} AS run
         JOIN ${this.table('tickets')} AS ticket ON ticket.id = run.ticket_id
         WHERE ticket.body->>'workContextId' = $1 ORDER BY run.id DESC LIMIT $2`,
        [String(id), boundedLimit]
      )
    ]);
    const safeCount = (value, label) => {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return number;
    };
    const ticketCounts = ticketCountsResult.rows[0];
    const runCounts = runCountsResult.rows[0];
    return {
      counts: {
        ticketCount: safeCount(ticketCounts.ticket_count, 'ticket count'),
        openTicketCount: safeCount(ticketCounts.open_ticket_count, 'open ticket count'),
        blockedTicketCount: safeCount(ticketCounts.blocked_ticket_count, 'blocked ticket count'),
        ticketTriageCount: safeCount(ticketCounts.triage_count, 'ticket triage count'),
        runCount: safeCount(runCounts.run_count, 'run count'),
        runTriageCount: safeCount(runCounts.triage_count, 'run triage count')
      },
      recentTickets: recentTicketsResult.rows.map(ticketFromRow),
      ticketTriage: ticketTriageResult.rows.map(ticketFromRow),
      runTriage: runTriageResult.rows.map(runFromRow),
      recentRuns: recentRunsResult.rows.map(runFromRow)
    };
  }

  async listRuns({ statuses = null, afterId = 0, limit = 100 } = {}) {
    const normalizedStatuses = statuses === null || statuses === undefined
      ? null
      : normalizeStatuses(statuses, RUN_STATUSES, 'run status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE id > $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       ORDER BY id
       LIMIT $3`,
      [cursor, normalizedStatuses, boundedLimit + 1]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async listRunsForTicket({ ticketId, afterId = 0, limit = 100 } = {}) {
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE ticket_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [ownerTicketId, cursor, boundedLimit + 1]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async listRunsForTickets({ ticketIds, statuses = null, afterId = 0, limit = 100 } = {}) {
    const ids = boundedPositiveIds(ticketIds, this.maxQueryRows, 'ticketIds');
    const normalizedStatuses = statuses === null || statuses === undefined
      ? null
      : normalizeStatuses(statuses, RUN_STATUSES, 'run status');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE ticket_id = ANY($1::bigint[])
         AND id > $2
         AND ($3::text[] IS NULL OR status = ANY($3::text[]))
       ORDER BY id
       LIMIT $4`,
      [ids, cursor, normalizedStatuses, boundedLimit + 1]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async listLatestRunsForTickets({ ticketIds } = {}) {
    const ids = boundedPositiveIds(ticketIds, this.maxQueryRows, 'ticketIds');
    const result = await this.pool.query(
      `SELECT DISTINCT ON (ticket_id) *
       FROM ${this.table('runs')}
       WHERE ticket_id = ANY($1::bigint[])
       ORDER BY ticket_id, updated_at DESC, id DESC`,
      [ids]
    );
    const byTicketId = new Map(result.rows.map(row => {
      const run = runFromRow(row);
      return [run.ticketId, run];
    }));
    return ids.map(ticketId => byTicketId.get(ticketId)).filter(Boolean);
  }

  async listChildTickets({ parentTicketId, afterId = 0, limit = 100 } = {}) {
    const parentId = positiveSafeInteger(parentTicketId, 'parentTicketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('tickets')}
       WHERE body->>'parentTicketId' = $1::text AND id > $2
       ORDER BY id
       LIMIT $3`,
      [parentId, cursor, boundedLimit + 1]
    );
    const page = result.rows.slice(0, boundedLimit).map(ticketFromRow);
    const last = page[page.length - 1] || null;
    return {
      tickets: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async createRunTriage({ runId, triage }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const callerTriage = this.assertJsonRecord(triage, 'triage');
    const execute = async connection => {
      const currentResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentResult.rowCount === 0) return null;
      const current = runFromRow(currentResult.rows[0]);
      if (current.triage) {
        return { run: current, triage: current.triage, event: null, created: false };
      }
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const createdAt = isoTimestamp(clock.rows[0].ts, 'triage creation clock');
      const document = this.assertJsonRecord({
        ...callerTriage,
        required: true,
        createdAt,
        resolvedAt: null,
        resolvedBy: null,
        resolution: null
      }, 'triage');
      const updated = await connection.query(
        `UPDATE ${this.table('runs')}
         SET body = jsonb_set(body, '{triage}', $2::jsonb, true),
             revision = revision + 1,
             updated_at = $3::timestamptz
         WHERE id = $1
         RETURNING *`,
        [id, document, createdAt]
      );
      const run = runFromRow(updated.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'run.triage_created',
        ticketId: run.ticketId,
        runId: run.id,
        payload: { triage: document }
      });
      return { run, triage: document, event, created: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async resolveTicketTriage({ ticketId, resolvedBy, resolution }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const actor = requiredString(resolvedBy, 'resolvedBy');
    const note = requiredString(resolution, 'resolution');
    const execute = async connection => {
      const currentResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentResult.rowCount === 0) return null;
      const current = ticketFromRow(currentResult.rows[0]);
      if (!current.triage || current.triage.required !== true || current.triage.resolvedAt) {
        throw new TriageConflictError('ticket', id, current);
      }
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const resolvedAt = isoTimestamp(clock.rows[0].ts, 'triage resolution clock');
      const document = this.assertJsonRecord({
        ...current.triage,
        required: false,
        resolvedAt,
        resolvedBy: actor,
        resolution: note
      }, 'triage');
      const updated = await connection.query(
        `UPDATE ${this.table('tickets')}
         SET body = jsonb_set(body, '{triage}', $2::jsonb, true),
             revision = revision + 1,
             updated_at = $3::timestamptz
         WHERE id = $1
         RETURNING *`,
        [id, document, resolvedAt]
      );
      const ticket = ticketFromRow(updated.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'ticket.triage_resolved',
        ticketId: ticket.id,
        payload: { triage: document }
      });
      return { ticket, triage: document, event };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async resolveRunTriage({ runId, resolvedBy, resolution }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const actor = requiredString(resolvedBy, 'resolvedBy');
    const note = requiredString(resolution, 'resolution');
    const execute = async connection => {
      const currentResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentResult.rowCount === 0) return null;
      const current = runFromRow(currentResult.rows[0]);
      if (!current.triage || current.triage.required !== true || current.triage.resolvedAt) {
        throw new TriageConflictError('run', id, current);
      }
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const resolvedAt = isoTimestamp(clock.rows[0].ts, 'triage resolution clock');
      const document = this.assertJsonRecord({
        ...current.triage,
        required: false,
        resolvedAt,
        resolvedBy: actor,
        resolution: note
      }, 'triage');
      const updated = await connection.query(
        `UPDATE ${this.table('runs')}
         SET body = jsonb_set(body, '{triage}', $2::jsonb, true),
             revision = revision + 1,
             updated_at = $3::timestamptz
         WHERE id = $1
         RETURNING *`,
        [id, document, resolvedAt]
      );
      const run = runFromRow(updated.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'run.triage_resolved',
        ticketId: run.ticketId,
        runId: run.id,
        payload: { triage: document }
      });
      return { run, triage: document, event };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async getUnresolvedTriageSummary({ limit = 10 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const predicate = `body->'triage'->>'required' = 'true'
      AND NULLIF(body->'triage'->>'resolvedAt', '') IS NULL`;
    const [ticketCountResult, runCountResult, recentResult] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::bigint AS count FROM ${this.table('tickets')} WHERE ${predicate}`),
      this.pool.query(`SELECT COUNT(*)::bigint AS count FROM ${this.table('runs')} WHERE ${predicate}`),
      this.pool.query(
        `SELECT * FROM ${this.table('tickets')}
         WHERE ${predicate}
         ORDER BY id DESC
         LIMIT $1`,
        [boundedLimit]
      )
    ]);
    const unresolvedTicketCount = Number(ticketCountResult.rows[0].count);
    const unresolvedRunCount = Number(runCountResult.rows[0].count);
    if (![unresolvedTicketCount, unresolvedRunCount].every(count => Number.isSafeInteger(count) && count >= 0)) {
      throw new RangeError('triage count exceeds safe integer range');
    }
    return {
      unresolvedTicketCount,
      unresolvedRunCount,
      recentTickets: recentResult.rows.map(ticketFromRow).map(ticket => ({
        ticketId: ticket.id,
        reasonCode: ticket.triage.reasonCode || null
      }))
    };
  }

  async getRuntimeOperationalSummary({ limit = 10 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `WITH counter_totals AS (
         SELECT
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'ticket'), 0)::bigint AS ticket_total,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'ticket' AND status IN ('open', 'in_progress')), 0)::bigint AS ticket_open,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'ticket' AND status = 'blocked'), 0)::bigint AS ticket_blocked,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'ticket' AND status = 'completed'), 0)::bigint AS ticket_completed,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'ticket' AND status = 'failed'), 0)::bigint AS ticket_failed,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run'), 0)::bigint AS run_total,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status IN ('pending', 'running')), 0)::bigint AS run_active,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status = 'pending'), 0)::bigint AS run_pending,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status = 'running'), 0)::bigint AS run_running,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status = 'completed'), 0)::bigint AS run_completed,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status = 'failed'), 0)::bigint AS run_failed,
           COALESCE(SUM(count) FILTER (WHERE entity_type = 'run' AND status = 'interrupted'), 0)::bigint AS run_interrupted
         FROM ${this.table('runtime_status_counts')}
       ), expired_lease_window AS (
         SELECT 1
         FROM ${this.table('runs')}
         WHERE status = 'running'
           AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
         ORDER BY lease_expires_at NULLS FIRST, id
         LIMIT $2
       )
       SELECT
         counter_totals.*,
         (SELECT COUNT(*)::bigint FROM expired_lease_window) AS run_expired_leases,
         COALESCE((
           SELECT json_agg(recent ORDER BY recent.run_id DESC)
           FROM (
             SELECT id AS run_id, ticket_id
             FROM ${this.table('runs')}
             WHERE status = 'failed'
             ORDER BY id DESC
             LIMIT $1
           ) recent
         ), '[]'::json) AS recent_failed_runs
       FROM counter_totals`,
      [boundedLimit, this.maxQueryRows + 1]
    );
    const row = result.rows[0];
    const safeCount = (value, label) => {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return count;
    };
    return {
      tickets: {
        total: safeCount(row.ticket_total, 'ticket total'),
        open: safeCount(row.ticket_open, 'open ticket count'),
        blocked: safeCount(row.ticket_blocked, 'blocked ticket count'),
        completed: safeCount(row.ticket_completed, 'completed ticket count'),
        failed: safeCount(row.ticket_failed, 'failed ticket count')
      },
      runs: {
        total: safeCount(row.run_total, 'run total'),
        active: safeCount(row.run_active, 'active run count'),
        pending: safeCount(row.run_pending, 'pending run count'),
        running: safeCount(row.run_running, 'running run count'),
        completed: safeCount(row.run_completed, 'completed run count'),
        failed: safeCount(row.run_failed, 'failed run count'),
        interrupted: safeCount(row.run_interrupted, 'interrupted run count'),
        expiredLeases: Math.min(
          safeCount(row.run_expired_leases, 'expired lease count'),
          this.maxQueryRows
        ),
        expiredLeasesTruncated: safeCount(row.run_expired_leases, 'expired lease count') > this.maxQueryRows
      },
      recentFailedRuns: row.recent_failed_runs.map(item => ({
        runId: positiveSafeInteger(item.run_id, 'recentFailedRun.runId'),
        ticketId: positiveSafeInteger(item.ticket_id, 'recentFailedRun.ticketId')
      }))
    };
  }

  async appendRunLog({ run, type, message, workspaceAction = null, metadata = {} } = {}) {
    if (!run || typeof run !== 'object') throw new TypeError('run is required');
    const runId = positiveSafeInteger(run.id, 'run.id');
    const ticketId = positiveSafeInteger(run.ticketId, 'run.ticketId');
    const agentId = positiveSafeInteger(run.agentId, 'run.agentId');
    const logType = requiredString(type, 'type');
    const fields = this.assertJsonRecord(metadata, 'metadata');
    const body = this.assertJsonRecord({
      ...fields,
      agentId,
      agentName: optionalString(run.agentName) || `Agent ${agentId}`,
      message: String(message === undefined || message === null ? '' : message),
      workspaceAction
    }, 'diagnostic log');
    const result = await this.pool.query(
      `INSERT INTO ${this.table('diagnostic_logs')}
         (run_id, ticket_id, type, body)
       SELECT id, ticket_id, $4, $5::jsonb
       FROM ${this.table('runs')}
       WHERE id = $1 AND ticket_id = $2 AND agent_id = $3
       RETURNING *`,
      [runId, ticketId, agentId, logType, body]
    );
    if (result.rowCount === 0) {
      const error = new Error(`run ${runId} was not found with the supplied ticket and agent authority`);
      error.code = 'POSTGRES_RECORD_NOT_FOUND';
      throw error;
    }
    return diagnosticLogFromRow(result.rows[0]);
  }

  async _appendSystemLog(connection, { type, message, workspaceAction = null, metadata = {} } = {}) {
    const logType = requiredString(type, 'type');
    const fields = this.assertJsonRecord(metadata, 'metadata');
    const requestedContextTicketId = nullablePositiveSafeInteger(
      fields.ticketId === undefined ? fields.contextTicketId : fields.ticketId,
      'metadata.ticketId'
    );
    const contextRunId = nullablePositiveSafeInteger(
      fields.runId === undefined ? fields.contextRunId : fields.runId,
      'metadata.runId'
    );
    const body = { ...fields };
    delete body.ticketId;
    delete body.runId;
    delete body.contextTicketId;
    delete body.contextRunId;
    delete body.agentId;
    delete body.agentName;
    Object.assign(body, {
      agentId: null,
      agentName: 'System',
      message: String(message === undefined || message === null ? '' : message),
      workspaceAction
    });
    this.assertJsonRecord(body, 'diagnostic log');

    if (contextRunId !== null) {
      const result = await connection.query(
        `INSERT INTO ${this.table('diagnostic_logs')}
           (context_run_id, context_ticket_id, type, body)
         SELECT id, ticket_id, $3, $4::jsonb
         FROM ${this.table('runs')}
         WHERE id = $1 AND ($2::bigint IS NULL OR ticket_id = $2)
         RETURNING *`,
        [contextRunId, requestedContextTicketId, logType, body]
      );
      if (result.rowCount === 0) {
        const error = new Error(`context run ${contextRunId} was not found for the supplied ticket`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      return diagnosticLogFromRow(result.rows[0]);
    }

    const result = await connection.query(
      `INSERT INTO ${this.table('diagnostic_logs')}
         (context_ticket_id, type, body)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [requestedContextTicketId, logType, body]
    );
    return diagnosticLogFromRow(result.rows[0]);
  }

  async appendSystemLog(options = {}, { client = null } = {}) {
    return this._appendSystemLog(client || this.pool, options);
  }

  _workContextValue(value) {
    const source = this.assertJsonRecord(value, 'value');
    const name = requiredString(source.name, 'value.name');
    const status = requiredString(source.status, 'value.status');
    if (!['active', 'archived'].includes(status)) {
      throw new TypeError(`Unsupported Work Context status: ${status}`);
    }
    const body = { ...source };
    for (const key of ['id', 'name', 'status', 'revision', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt']) {
      delete body[key];
    }
    return { name, status, body: this.assertJsonRecord(body, 'work context body') };
  }

  async listWorkContexts({ afterId = 0, statuses = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    let allowed = null;
    if (statuses !== null && statuses !== undefined) {
      if (!Array.isArray(statuses) || statuses.length === 0) {
        throw new TypeError('statuses must be a non-empty array');
      }
      allowed = [...new Set(statuses.map(item => requiredString(item, 'status')))];
      for (const status of allowed) {
        if (!['active', 'archived'].includes(status)) {
          throw new TypeError(`Unsupported Work Context status: ${status}`);
        }
      }
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('work_contexts')}
       WHERE id > $1
         AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       ORDER BY id
       LIMIT $3`,
      [cursor, allowed, size + 1]
    );
    const page = result.rows.slice(0, size).map(workContextFromRow);
    return {
      workContexts: page,
      nextAfterId: result.rows.length > size && page.length > 0 ? page[page.length - 1].id : null
    };
  }

  async getWorkContextById(workContextId) {
    const id = positiveSafeInteger(workContextId, 'workContextId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('work_contexts')} WHERE id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : workContextFromRow(result.rows[0]);
  }

  async getWorkContextCounts() {
    const result = await this.pool.query(
      `SELECT COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE status = 'active')::bigint AS active,
              COUNT(*) FILTER (WHERE status = 'archived')::bigint AS archived
       FROM ${this.table('work_contexts')}`
    );
    const safeCount = (value, label) => {
      const count = Number(value || 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return count;
    };
    const row = result.rows[0] || {};
    return {
      active: safeCount(row.active, 'active Work Context count'),
      archived: safeCount(row.archived, 'archived Work Context count'),
      total: safeCount(row.total, 'Work Context count')
    };
  }

  async createWorkContext({ value, changedBy }) {
    const normalized = this._workContextValue(value);
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const result = await client.query(
        `INSERT INTO ${this.table('work_contexts')}
           (name, status, body, created_by, updated_by)
         VALUES ($1, $2, $3::jsonb, $4, $4)
         RETURNING *`,
        [normalized.name, normalized.status, normalized.body, actor]
      );
      const workContext = workContextFromRow(result.rows[0]);
      const auditLog = await this._appendSystemLog(client, {
        type: 'work_context:created',
        message: `Work Context \"${workContext.name}\" created`,
        metadata: {
          workContextId: workContext.id,
          name: workContext.name,
          status: workContext.status,
          changedBy: actor
        }
      });
      return { workContext, auditLog };
    });
  }

  async updateWorkContext({ workContextId, expectedRevision, value, changedBy }) {
    const id = positiveSafeInteger(workContextId, 'workContextId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const normalized = this._workContextValue(value);
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const previousResult = await client.query(
        `SELECT * FROM ${this.table('work_contexts')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (previousResult.rowCount === 0) return null;
      const previous = workContextFromRow(previousResult.rows[0]);
      if (previous.revision !== revision) {
        throw new OptimisticConcurrencyError('workContext', id, revision, previous);
      }
      const result = await client.query(
        `UPDATE ${this.table('work_contexts')}
         SET name = $3,
             status = $4,
             body = $5::jsonb,
             revision = revision + 1,
             updated_by = $6,
             updated_at = clock_timestamp()
         WHERE id = $1 AND revision = $2
         RETURNING *`,
        [id, revision, normalized.name, normalized.status, normalized.body, actor]
      );
      if (result.rowCount === 0) {
        throw new OptimisticConcurrencyError('workContext', id, revision, previous);
      }
      const workContext = workContextFromRow(result.rows[0]);
      const archived = previous.status !== workContext.status && workContext.status === 'archived';
      const type = archived ? 'work_context:archived' : 'work_context:updated';
      const auditLog = await this._appendSystemLog(client, {
        type,
        message: `Work Context \"${workContext.name}\" ${archived ? 'archived' : 'updated'}`,
        metadata: {
          workContextId: id,
          name: workContext.name,
          status: workContext.status,
          changedBy: actor
        }
      });
      return { workContext, auditLog };
    });
  }

  _configuredAgentValue(value) {
    const source = this.assertJsonRecord(value, 'value');
    const name = requiredString(source.name, 'value.name');
    const provider = requiredString(source.provider, 'value.provider');
    if (!['openai', 'ollama'].includes(provider)) {
      throw new TypeError(`Unsupported configured-agent provider: ${provider}`);
    }
    const model = String(source.model === undefined || source.model === null ? '' : source.model).trim();
    const body = { ...source };
    for (const key of ['id', 'name', 'type', 'provider', 'model', 'revision', 'groupIds', 'createdAt', 'changedBy', 'changedAt']) {
      delete body[key];
    }
    return { name, provider, model, body: this.assertJsonRecord(body, 'configured agent body') };
  }

  _configuredAgentGroupIds(value) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError('groupIds must be an array');
    const ids = [...new Set(value.map((id, index) => positiveSafeInteger(id, `groupIds[${index}]`)))];
    if (ids.length > this.maxQueryRows) throw new RangeError(`groupIds exceeds the configured maximum of ${this.maxQueryRows}`);
    return ids;
  }

  async _configuredAgentWithGroups(connection, row) {
    if (!row) return null;
    const agent = configuredAgentFromRow(row);
    const memberships = await connection.query(
      `SELECT group_id
       FROM ${this.table('agent_group_memberships')}
       WHERE agent_id = $1
       ORDER BY group_id
       LIMIT $2`,
      [agent.id, this.maxQueryRows + 1]
    );
    if (memberships.rowCount > this.maxQueryRows) {
      throw new RangeError(`agent ${agent.id} group memberships exceed the configured maximum`);
    }
    return { ...agent, groupIds: memberships.rows.map(item => positiveSafeInteger(item.group_id, 'membership.groupId')) };
  }

  async listConfiguredAgents({ afterId = 0, providers = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    let allowed = null;
    if (providers !== null && providers !== undefined) {
      if (!Array.isArray(providers) || providers.length === 0) throw new TypeError('providers must be a non-empty array');
      allowed = [...new Set(providers.map(item => requiredString(item, 'provider')))];
      for (const provider of allowed) {
        if (!['openai', 'ollama'].includes(provider)) throw new TypeError(`Unsupported configured-agent provider: ${provider}`);
      }
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('configured_agents')}
       WHERE id > $1
         AND ($2::text[] IS NULL OR provider = ANY($2::text[]))
       ORDER BY id
       LIMIT $3`,
      [cursor, allowed, size + 1]
    );
    const agents = result.rows.slice(0, size).map(configuredAgentFromRow);
    return { agents, nextAfterId: result.rows.length > size && agents.length > 0 ? agents[agents.length - 1].id : null };
  }

  async getConfiguredAgentById(agentId) {
    const id = positiveSafeInteger(agentId, 'agentId');
    const result = await this.pool.query(`SELECT * FROM ${this.table('configured_agents')} WHERE id = $1`, [id]);
    return result.rowCount === 0 ? null : this._configuredAgentWithGroups(this.pool, result.rows[0]);
  }

  async getConfiguredAgentByName(name, { caseInsensitive = false } = {}) {
    const normalized = requiredString(name, 'name');
    const result = await this.pool.query(
      `SELECT *
       FROM ${this.table('configured_agents')}
       WHERE name = $1
          OR ($2::boolean = TRUE AND lower(name) = lower($1))
       ORDER BY CASE WHEN name = $1 THEN 0 ELSE 1 END, id
       LIMIT 1`,
      [normalized, caseInsensitive === true]
    );
    return result.rowCount === 0 ? null : this._configuredAgentWithGroups(this.pool, result.rows[0]);
  }

  async getConfiguredAgentsByIds({ agentIds }) {
    const ids = boundedPositiveIds(agentIds, this.maxQueryRows, 'agentIds');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('configured_agents')}
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       LIMIT $2`,
      [ids, ids.length]
    );
    return result.rows.map(configuredAgentFromRow);
  }

  async listConfiguredAgentsByGroup({ groupId, afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(groupId, 'groupId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const result = await this.pool.query(
      `SELECT agent.*
       FROM ${this.table('agent_group_memberships')} AS membership
       JOIN ${this.table('configured_agents')} AS agent ON agent.id = membership.agent_id
       WHERE membership.group_id = $1 AND agent.id > $2
       ORDER BY agent.id
       LIMIT $3`,
      [id, cursor, size + 1]
    );
    const agents = result.rows.slice(0, size).map(configuredAgentFromRow);
    return { agents, nextAfterId: result.rows.length > size && agents.length > 0 ? agents[agents.length - 1].id : null };
  }

  async listAgentGroupMemberships({ afterAgentId = 0, afterGroupId = 0, agentIds = null, groupIds = null, limit = 100 } = {}) {
    const agentCursor = nonNegativeSafeInteger(afterAgentId, 'afterAgentId');
    const groupCursor = nonNegativeSafeInteger(afterGroupId, 'afterGroupId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const allowedAgents = agentIds === null || agentIds === undefined ? null : boundedPositiveIds(agentIds, this.maxQueryRows, 'agentIds');
    const allowedGroups = groupIds === null || groupIds === undefined ? null : boundedPositiveIds(groupIds, this.maxQueryRows, 'groupIds');
    const result = await this.pool.query(
      `SELECT agent_id, group_id
       FROM ${this.table('agent_group_memberships')}
       WHERE (agent_id, group_id) > ($1, $2)
         AND ($3::bigint[] IS NULL OR agent_id = ANY($3::bigint[]))
         AND ($4::bigint[] IS NULL OR group_id = ANY($4::bigint[]))
       ORDER BY agent_id, group_id
       LIMIT $5`,
      [agentCursor, groupCursor, allowedAgents, allowedGroups, size + 1]
    );
    const memberships = result.rows.slice(0, size).map(row => ({
      agentId: positiveSafeInteger(row.agent_id, 'membership.agentId'),
      groupId: positiveSafeInteger(row.group_id, 'membership.groupId')
    }));
    const last = memberships[memberships.length - 1] || null;
    return { memberships, nextCursor: result.rows.length > size && last ? { afterAgentId: last.agentId, afterGroupId: last.groupId } : null };
  }

  async _replaceConfiguredAgentMemberships(client, agentId, groupIds, actor) {
    await client.query(`DELETE FROM ${this.table('agent_group_memberships')} WHERE agent_id = $1`, [agentId]);
    if (groupIds.length === 0) return;
    await client.query(
      `INSERT INTO ${this.table('agent_group_memberships')} (agent_id, group_id, created_by)
       SELECT $1, group_id, $3
       FROM unnest($2::bigint[]) AS membership(group_id)`,
      [agentId, groupIds, actor]
    );
  }

  _throwConfiguredAgentNameConflict(error, name) {
    if (error && error.code === '23505' && error.constraint === 'configured_agents_name_unique') {
      const conflict = new Error(`Configured agent name already exists: ${name}`);
      conflict.name = 'ConfiguredAgentNameConflictError';
      conflict.code = 'CONFIGURED_AGENT_NAME_CONFLICT';
      throw conflict;
    }
    throw error;
  }

  async createConfiguredAgent({ value, groupIds = [], changedBy }) {
    const normalized = this._configuredAgentValue(value);
    const groups = this._configuredAgentGroupIds(groupIds);
    const actor = requiredString(changedBy, 'changedBy');
    try {
      return await this.withTransaction(async client => {
        await this._assertAccessGroups(client, groups);
        const result = await client.query(
          `INSERT INTO ${this.table('configured_agents')}
             (name, provider, model, body, created_by, updated_by)
           VALUES ($1, $2, $3, $4::jsonb, $5, $5)
           RETURNING *`,
          [normalized.name, normalized.provider, normalized.model, normalized.body, actor]
        );
        const agent = configuredAgentFromRow(result.rows[0]);
        await this._replaceConfiguredAgentMemberships(client, agent.id, groups, actor);
        const auditLog = await this._appendSystemLog(client, {
          type: 'admin:agent_create',
          message: `Agent \"${agent.name}\" created by ${actor}`,
          metadata: { changedBy: actor, changedAt: agent.changedAt, targetAgentId: agent.id, targetAgentName: agent.name, provider: agent.provider }
        });
        return { agent: { ...agent, groupIds: groups }, auditLog };
      });
    } catch (error) {
      return this._throwConfiguredAgentNameConflict(error, normalized.name);
    }
  }

  async updateConfiguredAgent({ agentId, expectedRevision, value, groupIds = [], changedBy }) {
    const id = positiveSafeInteger(agentId, 'agentId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const normalized = this._configuredAgentValue(value);
    const groups = this._configuredAgentGroupIds(groupIds);
    const actor = requiredString(changedBy, 'changedBy');
    try {
      return await this.withTransaction(async client => {
        const previousResult = await client.query(`SELECT * FROM ${this.table('configured_agents')} WHERE id = $1 FOR UPDATE`, [id]);
        if (previousResult.rowCount === 0) return null;
        const previous = configuredAgentFromRow(previousResult.rows[0]);
        if (previous.revision !== revision) throw new OptimisticConcurrencyError('configuredAgent', id, revision, previous);
        await this._assertAccessGroups(client, groups);
        const result = await client.query(
          `UPDATE ${this.table('configured_agents')}
           SET name = $3, provider = $4, model = $5, body = $6::jsonb,
               revision = revision + 1, updated_by = $7, updated_at = clock_timestamp()
           WHERE id = $1 AND revision = $2
           RETURNING *`,
          [id, revision, normalized.name, normalized.provider, normalized.model, normalized.body, actor]
        );
        if (result.rowCount === 0) throw new OptimisticConcurrencyError('configuredAgent', id, revision, previous);
        const agent = configuredAgentFromRow(result.rows[0]);
        await this._replaceConfiguredAgentMemberships(client, id, groups, actor);
        const auditLog = await this._appendSystemLog(client, {
          type: 'admin:agent_edit',
          message: `Agent \"${agent.name}\" (#${id}) edited by ${actor}`,
          metadata: { changedBy: actor, changedAt: agent.changedAt, targetAgentId: id, targetAgentName: agent.name }
        });
        return { agent: { ...agent, groupIds: groups }, auditLog };
      });
    } catch (error) {
      return this._throwConfiguredAgentNameConflict(error, normalized.name);
    }
  }

  async deleteConfiguredAgent({ agentId, expectedRevision, changedBy }) {
    const id = positiveSafeInteger(agentId, 'agentId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const currentResult = await client.query(`SELECT * FROM ${this.table('configured_agents')} WHERE id = $1 FOR UPDATE`, [id]);
      if (currentResult.rowCount === 0) return null;
      const agent = configuredAgentFromRow(currentResult.rows[0]);
      if (agent.revision !== revision) throw new OptimisticConcurrencyError('configuredAgent', id, revision, agent);
      const changedAtResult = await client.query('SELECT clock_timestamp() AS changed_at');
      const changedAt = rowTimestamp(changedAtResult.rows[0].changed_at);
      const deleteResult = await client.query(
        `DELETE FROM ${this.table('configured_agents')} WHERE id = $1 AND revision = $2 RETURNING id`,
        [id, revision]
      );
      if (deleteResult.rowCount === 0) throw new OptimisticConcurrencyError('configuredAgent', id, revision, agent);
      const auditLog = await this._appendSystemLog(client, {
        type: 'admin:agent_delete',
        message: `Agent \"${agent.name}\" deleted by ${actor}`,
        metadata: { changedBy: actor, changedAt, targetAgentId: id, targetAgentName: agent.name }
      });
      return { agent, auditLog };
    });
  }

  async removeConfiguredAgentMembershipsForGroup({ groupId }) {
    const id = positiveSafeInteger(groupId, 'groupId');
    return this.withTransaction(async client => {
      const candidates = await client.query(
        `SELECT agent_id
         FROM ${this.table('agent_group_memberships')}
         WHERE group_id = $1
         ORDER BY agent_id
         LIMIT $2
         FOR UPDATE`,
        [id, this.maxQueryRows + 1]
      );
      if (candidates.rowCount > this.maxQueryRows) {
        throw new RangeError(`group ${id} agent memberships exceed the configured maximum`);
      }
      if (candidates.rowCount === 0) return { removedCount: 0 };
      const result = await client.query(
        `DELETE FROM ${this.table('agent_group_memberships')}
         WHERE group_id = $1
           AND agent_id = ANY($2::bigint[])`,
        [id, candidates.rows.map(row => positiveSafeInteger(row.agent_id, 'membership.agentId'))]
      );
      return { removedCount: result.rowCount };
    });
  }

  async _hydrateProcessTemplateStates(templates, now = Date.now()) {
    if (!Array.isArray(templates) || templates.length === 0) return [];
    const templateIds = templates.map(template => template.id);
    const sourceTemplateId = `CASE
      WHEN body->'source'->>'type' = 'process_template'
       AND body->'source'->>'templateId' ~ '^[1-9][0-9]*$'
      THEN (body->'source'->>'templateId')::bigint
      ELSE NULL
    END`;
    const aggregateResult = await this.pool.query(
      `WITH sourced AS (
         SELECT status, body->'triage' AS triage, ${sourceTemplateId} AS template_id
         FROM ${this.table('tickets')}
       )
       SELECT template_id,
              COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE status = 'blocked')::bigint AS blocked,
              COUNT(*) FILTER (WHERE triage->>'required' = 'true')::bigint AS triaged,
              COUNT(*) FILTER (WHERE status = 'open')::bigint AS pending,
              COUNT(*) FILTER (WHERE status = 'in_progress')::bigint AS in_progress,
              COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed,
              COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed
       FROM sourced
       WHERE template_id = ANY($1::bigint[])
       GROUP BY template_id`,
      [templateIds]
    );
    const countByTemplate = new Map();
    for (const row of aggregateResult.rows) {
      const count = value => {
        const number = Number(value || 0);
        if (!Number.isSafeInteger(number) || number < 0) throw new RangeError('process-template ticket count exceeds safe integer range');
        return number;
      };
      countByTemplate.set(positiveSafeInteger(row.template_id, 'processTemplateState.templateId'), {
        total: count(row.total),
        blocked: count(row.blocked),
        triaged: count(row.triaged),
        pending: count(row.pending),
        inProgress: count(row.in_progress),
        completed: count(row.completed),
        failed: count(row.failed)
      });
    }

    const recentResult = await this.pool.query(
      `WITH sourced AS (
         SELECT id, status, created_at, body->'source' AS source, body->'triage' AS triage,
                ${sourceTemplateId} AS template_id
         FROM ${this.table('tickets')}
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (
           PARTITION BY template_id
           ORDER BY created_at DESC, id DESC
         ) AS template_rank
         FROM sourced
         WHERE template_id = ANY($1::bigint[])
       )
       SELECT id, status, created_at, source, triage, template_id
       FROM ranked
       WHERE template_rank <= 5
       ORDER BY template_id, created_at, id`,
      [templateIds]
    );
    const ticketsByTemplate = new Map(templateIds.map(id => [id, []]));
    for (const row of recentResult.rows) {
      const templateId = positiveSafeInteger(row.template_id, 'processTemplateTicket.templateId');
      const list = ticketsByTemplate.get(templateId);
      if (!list) continue;
      list.push({
        id: positiveSafeInteger(row.id, 'processTemplateTicket.id'),
        status: row.status,
        createdAt: rowTimestamp(row.created_at),
        source: row.source && typeof row.source === 'object' ? row.source : null,
        triage: row.triage && typeof row.triage === 'object' ? row.triage : null
      });
    }

    return templates.map(template => ({
      ...template,
      ...buildProcessTemplateState(
        template,
        ticketsByTemplate.get(template.id) || [],
        now,
        countByTemplate.get(template.id) || emptyGeneratedTicketCounts()
      )
    }));
  }

  async listProcessTemplateStates({ afterId = 0, workContextId = null, limit = 100, now = Date.now() } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const contextId = nullablePositiveSafeInteger(workContextId, 'workContextId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const result = await this.pool.query(
      `SELECT *
       FROM ${this.table('process_templates')}
       WHERE id > $1
         AND ($2::bigint IS NULL OR work_context_id = $2)
       ORDER BY id
       LIMIT $3`,
      [cursor, contextId, size + 1]
    );
    const roots = result.rows.slice(0, size).map(processTemplateFromRow);
    const processTemplates = await this._hydrateProcessTemplateStates(roots, now);
    return {
      processTemplates,
      nextAfterId: result.rows.length > size && processTemplates.length > 0
        ? processTemplates[processTemplates.length - 1].id
        : null
    };
  }

  async getProcessTemplateStateById(templateId, { now = Date.now() } = {}) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('process_templates')} WHERE id = $1`,
      [id]
    );
    if (result.rowCount === 0) return null;
    return (await this._hydrateProcessTemplateStates([processTemplateFromRow(result.rows[0])], now))[0];
  }

  async getProcessTemplateCounts() {
    const result = await this.pool.query(
      `SELECT COALESCE(SUM(total), 0)::bigint AS total,
              COALESCE(SUM(enabled), 0)::bigint AS enabled,
              COALESCE(SUM(disabled), 0)::bigint AS disabled,
              COALESCE(SUM(scheduled), 0)::bigint AS scheduled,
              COALESCE(SUM(paused_schedule), 0)::bigint AS paused_schedule
       FROM ${this.table('process_template_status_counts')}`
    );
    const row = result.rows[0] || {};
    const count = (value, label) => {
      const number = Number(value || 0);
      if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return number;
    };
    return {
      total: count(row.total, 'process-template total'),
      enabled: count(row.enabled, 'process-template enabled count'),
      disabled: count(row.disabled, 'process-template disabled count'),
      scheduled: count(row.scheduled, 'process-template scheduled count'),
      pausedSchedule: count(row.paused_schedule, 'process-template paused-schedule count')
    };
  }

  async getProcessTemplateCountsByWorkContextIds({ workContextIds }) {
    const ids = boundedPositiveIds(workContextIds, this.maxQueryRows, 'workContextIds');
    const result = await this.pool.query(
      `SELECT requested.work_context_id,
              COUNT(template.id)::bigint AS process_template_count,
              COUNT(template.id) FILTER (WHERE template.schedule_enabled = TRUE)::bigint AS scheduled_template_count
       FROM unnest($1::bigint[]) WITH ORDINALITY AS requested(work_context_id, ordinal)
       LEFT JOIN ${this.table('process_templates')} AS template
         ON template.work_context_id = requested.work_context_id
       GROUP BY requested.work_context_id, requested.ordinal
       ORDER BY requested.ordinal`,
      [ids]
    );
    const count = (value, label) => {
      const number = Number(value || 0);
      if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return number;
    };
    return result.rows.map(row => ({
      workContextId: positiveSafeInteger(row.work_context_id, 'workContextId'),
      processTemplateCount: count(row.process_template_count, 'process-template Work Context count'),
      scheduledTemplateCount: count(row.scheduled_template_count, 'scheduled process-template Work Context count')
    }));
  }

  async getProcessTemplateTriggerProvenance({ ticketId = null, triggerToken = null } = {}) {
    const id = ticketId === null || ticketId === undefined ? null : positiveSafeInteger(ticketId, 'ticketId');
    const token = triggerToken === null || triggerToken === undefined ? null : String(triggerToken).trim();
    if (id === null && !token) throw new TypeError('ticketId or triggerToken is required');
    const result = await this.pool.query(
      `SELECT *
       FROM ${this.table('process_template_triggers')}
       WHERE ($1::bigint IS NOT NULL AND ticket_id = $1)
          OR ($2::text IS NOT NULL AND trigger_token = $2)
       ORDER BY CASE WHEN ticket_id = $1 THEN 0 ELSE 1 END, id DESC
       LIMIT 1`,
      [id, token || null]
    );
    return result.rowCount === 0 ? null : processTemplateTriggerFromRow(result.rows[0]);
  }

  async getProcessTemplateById(templateId, { client = null } = {}) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const result = await (client || this.pool).query(
      `SELECT * FROM ${this.table('process_templates')} WHERE id = $1`, [id]
    );
    return result.rowCount === 0 ? null : processTemplateFromRow(result.rows[0]);
  }

  _processTemplateTicketTemplate(value) {
    const source = this.assertJsonRecord(value, 'ticketTemplate');
    return structuredClone(source);
  }

  async createProcessTemplate({ value, changedBy }) {
    const source = this.assertJsonRecord(value, 'value');
    const name = requiredString(source.name, 'value.name');
    const ticketTemplate = this._processTemplateTicketTemplate(source.ticketTemplate);
    const actor = requiredString(changedBy, 'changedBy');
    const enabled = source.enabled !== false;
    const workContextId = nullablePositiveSafeInteger(source.workContextId, 'value.workContextId');
    return this.withTransaction(async client => {
      const sequence = await client.query(
        'SELECT nextval(pg_get_serial_sequence($1, $2))::bigint AS id',
        [`${this.schema}.process_templates`, 'id']
      );
      const id = positiveSafeInteger(sequence.rows[0].id, 'processTemplate.id');
      const versionId = `ptv_${id}_1`;
      const body = {
        version: 1,
        triggerType: 'manual',
        schedule: null,
        ticketTemplate,
        workContextSnapshot: source.workContextSnapshot || null,
        lastTriggeredAt: null
      };
      const rootResult = await client.query(
        `INSERT INTO ${this.table('process_templates')}
           (id, name, enabled, work_context_id, current_version, current_version_id,
            schedule_enabled, next_run_at, body, created_by, updated_by)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4, 1, $5, FALSE, NULL, $6::jsonb, $7, $7)
         RETURNING *`,
        [id, name, enabled, workContextId, versionId, body, actor]
      );
      await client.query(
        `INSERT INTO ${this.table('process_template_versions')}
           (id, template_id, version, status, name, ticket_template, body,
            created_by, activated_by, activated_at)
         VALUES ($1, $2, 1, 'active', $3, $4::jsonb, $5::jsonb, $6, $6, clock_timestamp())`,
        [versionId, id, name, ticketTemplate, { executionPolicy: ticketTemplate.executionPolicy || null, changeSummary: null }, actor]
      );
      const template = processTemplateFromRow(rootResult.rows[0]);
      const auditLog = await this._appendSystemLog(client, {
        type: 'process_template:created', message: `Process template "${name}" created`,
        metadata: { templateId: id, templateName: name, createdBy: actor, activeVersionId: versionId }
      });
      return { template, version: {
        id: versionId, templateId: id, version: 1, status: 'active', name,
        ticketTemplate, executionPolicy: ticketTemplate.executionPolicy || null,
        createdBy: actor, activatedBy: actor
      }, auditLog };
    });
  }

  async _mutateProcessTemplate(templateId, changedBy, mutate) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const currentResult = await client.query(
        `SELECT * FROM ${this.table('process_templates')} WHERE id = $1 FOR UPDATE`, [id]
      );
      if (currentResult.rowCount === 0) return null;
      const current = processTemplateFromRow(currentResult.rows[0]);
      const change = await mutate(current, client);
      const body = { ...(currentResult.rows[0].body || {}), ...(change.bodyPatch || {}) };
      const enabled = change.enabled === undefined ? current.enabled : change.enabled;
      const workContextId = change.workContextId === undefined
        ? nullablePositiveSafeInteger(currentResult.rows[0].work_context_id, 'processTemplate.workContextId')
        : change.workContextId;
      const schedule = Object.prototype.hasOwnProperty.call(change, 'schedule') ? change.schedule : current.schedule || null;
      const result = await client.query(
        `UPDATE ${this.table('process_templates')}
         SET enabled = $2,
             work_context_id = $3,
             schedule_enabled = $4,
             next_run_at = $5,
             body = $6::jsonb,
             revision = revision + 1,
             updated_by = $7,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING *`,
        [id, enabled, workContextId, Boolean(schedule && schedule.enabled === true),
          schedule && schedule.enabled === true ? schedule.nextRunAt : null,
          { ...body, schedule }, actor]
      );
      const template = processTemplateFromRow(result.rows[0]);
      const audit = change.audit(template, actor);
      const auditLog = await this._appendSystemLog(client, audit);
      return { template, auditLog };
    });
  }

  async setProcessTemplateEnabled({ templateId, enabled, changedBy }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    return this._mutateProcessTemplate(templateId, changedBy, async current => ({
      enabled,
      audit: (template, actor) => ({
        type: enabled ? 'process_template:enabled' : 'process_template:disabled',
        message: `Process template "${template.name}" ${enabled ? 'enabled' : 'disabled'}`,
        metadata: { templateId: template.id, templateName: template.name, changedBy: actor }
      })
    }));
  }

  async setProcessTemplateSchedule({ templateId, enabled, everySeconds = null, changedBy }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    if (enabled && (!Number.isInteger(everySeconds) || everySeconds <= 0)) throw new TypeError('everySeconds must be a positive integer');
    return this._mutateProcessTemplate(templateId, changedBy, async (current, client) => {
      const clock = rowTimestamp((await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts);
      const schedule = enabled ? {
        enabled: true, kind: 'interval', everySeconds, anchor: clock,
        nextRunAt: computeNextRunAt({ everySeconds }, clock), lastScheduledTriggerAt: null,
        timezone: 'UTC', scheduledBy: requiredString(changedBy, 'changedBy')
      } : (scheduleHasReusableInterval(current.schedule)
        ? { ...current.schedule, enabled: false, nextRunAt: null }
        : null);
      return {
        schedule,
        audit: (template, actor) => ({
          type: enabled ? 'process_template:schedule_set' : 'process_template:schedule_disabled',
          message: `Process template "${template.name}" schedule ${enabled ? `set to every ${everySeconds}s` : 'disabled'}`,
          metadata: { templateId: template.id, templateName: template.name, everySeconds: enabled ? everySeconds : null, changedBy: actor }
        })
      };
    });
  }

  async pauseProcessTemplateSchedule({ templateId, changedBy }) {
    return this._mutateProcessTemplate(templateId, changedBy, async current => {
      if (!scheduleHasReusableInterval(current.schedule)) throw new ProcessTemplateConflictError('No reusable interval schedule to pause', 'PROCESS_TEMPLATE_SCHEDULE_MISSING');
      return {
        schedule: { ...current.schedule, enabled: false, nextRunAt: null },
        audit: (template, actor) => ({ type: 'process_template:schedule_paused', message: `Process template "${template.name}" schedule paused`, metadata: { templateId: template.id, templateName: template.name, changedBy: actor } })
      };
    });
  }

  async resumeProcessTemplateSchedule({ templateId, changedBy }) {
    return this._mutateProcessTemplate(templateId, changedBy, async (current, client) => {
      if (!scheduleHasReusableInterval(current.schedule)) throw new ProcessTemplateConflictError('No reusable interval schedule to resume', 'PROCESS_TEMPLATE_SCHEDULE_MISSING');
      const clock = rowTimestamp((await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts);
      return {
        schedule: { ...current.schedule, enabled: true, nextRunAt: computeNextRunAt(current.schedule, clock) },
        audit: (template, actor) => ({ type: 'process_template:schedule_resumed', message: `Process template "${template.name}" schedule resumed`, metadata: { templateId: template.id, templateName: template.name, changedBy: actor } })
      };
    });
  }

  async assignProcessTemplateWorkContext({ templateId, workContextId = null, workContextSnapshot = null, changedBy }) {
    const contextId = workContextId === null ? null : positiveSafeInteger(workContextId, 'workContextId');
    const snapshot = contextId === null ? null : this.assertJsonRecord(workContextSnapshot, 'workContextSnapshot');
    return this._mutateProcessTemplate(templateId, changedBy, async () => ({
      workContextId: contextId,
      bodyPatch: { workContextSnapshot: snapshot },
      audit: (template, actor) => ({ type: 'work_context:template_assigned', message: `Process template "${template.name}" work context ${contextId === null ? 'cleared' : `set to ${contextId}`}`, metadata: { templateId: template.id, workContextId: contextId, changedBy: actor } })
    }));
  }

  async createProcessTemplateDraft({ templateId, name = null, ticketTemplate = null, changeSummary = null, changedBy }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const rootResult = await client.query(`SELECT * FROM ${this.table('process_templates')} WHERE id = $1 FOR UPDATE`, [id]);
      if (rootResult.rowCount === 0) return null;
      const template = processTemplateFromRow(rootResult.rows[0]);
      const activeResult = await client.query(
        `SELECT * FROM ${this.table('process_template_versions')} WHERE template_id = $1 AND status = 'active' FOR UPDATE`, [id]
      );
      if (activeResult.rowCount !== 1) throw new ProcessTemplateConflictError(`Process template ${id} must have exactly one active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
      const draftResult = await client.query(
        `SELECT id FROM ${this.table('process_template_versions')} WHERE template_id = $1 AND status = 'draft'`, [id]
      );
      if (draftResult.rowCount > 0) throw new ProcessTemplateConflictError('A draft version already exists for this template', 'PROCESS_TEMPLATE_DRAFT_EXISTS');
      const active = processTemplateVersionFromRow(activeResult.rows[0]);
      const version = active.version + 1;
      const nextTicketTemplate = { ...active.ticketTemplate, ...(ticketTemplate === null ? {} : this._processTemplateTicketTemplate(ticketTemplate)) };
      const versionId = `ptv_${id}_${version}`;
      const inserted = await client.query(
        `INSERT INTO ${this.table('process_template_versions')}
           (id, template_id, version, status, name, ticket_template, body, created_by, supersedes_version_id)
         VALUES ($1, $2, $3, 'draft', $4, $5::jsonb, $6::jsonb, $7, $8)
         RETURNING *`,
        [versionId, id, version, name === null ? active.name : requiredString(name, 'name'), nextTicketTemplate,
          { executionPolicy: nextTicketTemplate.executionPolicy || null, changeSummary: changeSummary === null ? null : String(changeSummary) }, actor, active.id]
      );
      const draft = processTemplateVersionFromRow(inserted.rows[0]);
      await client.query(`UPDATE ${this.table('process_templates')} SET revision = revision + 1, updated_by = $2, updated_at = clock_timestamp() WHERE id = $1`, [id, actor]);
      const auditLog = await this._appendSystemLog(client, {
        type: 'process_template:version_draft_created', message: `Process template "${template.name}" draft v${version} created`,
        metadata: { templateId: id, templateName: template.name, fromVersion: active.version, toVersion: version, draftVersionId: draft.id, changedBy: actor }
      });
      return { template, draft, activeVersion: active.version, auditLog };
    });
  }

  async activateProcessTemplateVersion({ templateId, versionId, changedBy }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const targetId = requiredString(versionId, 'versionId');
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      const rootResult = await client.query(`SELECT * FROM ${this.table('process_templates')} WHERE id = $1 FOR UPDATE`, [id]);
      if (rootResult.rowCount === 0) return null;
      const current = processTemplateFromRow(rootResult.rows[0]);
      const targetResult = await client.query(`SELECT * FROM ${this.table('process_template_versions')} WHERE template_id = $1 AND id = $2 FOR UPDATE`, [id, targetId]);
      if (targetResult.rowCount === 0) return { template: current, version: null };
      const draft = processTemplateVersionFromRow(targetResult.rows[0]);
      if (draft.status !== 'draft') throw new ProcessTemplateConflictError('Only a draft version can be activated', 'PROCESS_TEMPLATE_VERSION_NOT_DRAFT');
      if (current.schedule && current.schedule.enabled === true) throw new ProcessTemplateConflictError('Pause the schedule before activating a new version', 'PROCESS_TEMPLATE_SCHEDULE_ACTIVE');
      const activeResult = await client.query(`SELECT * FROM ${this.table('process_template_versions')} WHERE template_id = $1 AND status = 'active' FOR UPDATE`, [id]);
      if (activeResult.rowCount !== 1) throw new ProcessTemplateConflictError(`Process template ${id} must have exactly one active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
      const active = processTemplateVersionFromRow(activeResult.rows[0]);
      if (draft.supersedesVersionId !== active.id) throw new ProcessTemplateConflictError('Draft supersedes a different active version', 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
      await client.query(`UPDATE ${this.table('process_template_versions')} SET status = 'superseded' WHERE id = $1`, [active.id]);
      const activatedResult = await client.query(
        `UPDATE ${this.table('process_template_versions')}
         SET status = 'active', activated_by = $2, activated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`, [draft.id, actor]
      );
      const activated = processTemplateVersionFromRow(activatedResult.rows[0]);
      const body = { ...(rootResult.rows[0].body || {}), version: activated.version, ticketTemplate: activated.ticketTemplate };
      const updatedResult = await client.query(
        `UPDATE ${this.table('process_templates')}
         SET name = $2, current_version = $3, current_version_id = $4, body = $5::jsonb,
             revision = revision + 1, updated_by = $6, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [id, activated.name, activated.version, activated.id, body, actor]
      );
      const template = processTemplateFromRow(updatedResult.rows[0]);
      const auditLog = await this._appendSystemLog(client, {
        type: 'process_template:version_activated', message: `Process template "${template.name}" activated v${activated.version}`,
        metadata: { templateId: id, templateName: template.name, fromVersion: active.version, toVersion: activated.version, activatedVersionId: activated.id, supersedesVersionId: active.id, changedBy: actor }
      });
      return { template, version: activated, priorVersion: active, auditLog };
    });
  }

  async listDueProcessTemplates({ dueAt = new Date(), limit = 100 } = {}) {
    const at = isoTimestamp(dueAt, 'dueAt');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('process_templates')}
       WHERE enabled = TRUE AND schedule_enabled = TRUE AND next_run_at <= $1
       ORDER BY next_run_at, id LIMIT $2`, [at, size]
    );
    return result.rows.map(processTemplateFromRow);
  }

  async executeProcessTemplateTrigger({ templateId, triggerToken, triggerType, scheduledFor = null, triggeredBy, createTicket }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const token = requiredString(triggerToken, 'triggerToken');
    const kind = requiredString(triggerType, 'triggerType');
    if (!['manual', 'schedule'].includes(kind)) throw new TypeError('triggerType must be manual or schedule');
    const actor = requiredString(triggeredBy, 'triggeredBy');
    if (typeof createTicket !== 'function') throw new TypeError('createTicket must be a function');
    try {
      return await this.withTransaction(async client => {
        const rootResult = await client.query(`SELECT * FROM ${this.table('process_templates')} WHERE id = $1 FOR UPDATE`, [id]);
        if (rootResult.rowCount === 0) return null;
        const template = processTemplateFromRow(rootResult.rows[0]);
        const existingResult = await client.query(`SELECT * FROM ${this.table('process_template_triggers')} WHERE trigger_token = $1`, [token]);
        if (existingResult.rowCount > 0) {
          const trigger = processTemplateTriggerFromRow(existingResult.rows[0]);
          if (trigger.templateId !== id) throw new ProcessTemplateConflictError('Trigger token belongs to another template', 'PROCESS_TEMPLATE_TRIGGER_TOKEN_CONFLICT');
          const ticketResult = await client.query(`SELECT * FROM ${this.table('tickets')} WHERE id = $1`, [trigger.ticketId]);
          return { ok: true, deduped: true, template, trigger, ticket: ticketFromRow(ticketResult.rows[0]) };
        }
        if (template.enabled !== true) throw new ProcessTemplateConflictError('Process template is disabled', 'PROCESS_TEMPLATE_DISABLED');
        const slot = kind === 'schedule' ? isoTimestamp(scheduledFor, 'scheduledFor') : null;
        if (kind === 'schedule' && (!template.schedule || template.schedule.enabled !== true || template.schedule.nextRunAt !== slot)) {
          return { ok: true, deduped: true, stale: true, template, trigger: null, ticket: null };
        }
        const activeResult = await client.query(`SELECT * FROM ${this.table('process_template_versions')} WHERE template_id = $1 AND status = 'active' FOR UPDATE`, [id]);
        if (activeResult.rowCount !== 1) throw new ProcessTemplateConflictError(`Process template ${id} must have exactly one active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
        const active = processTemplateVersionFromRow(activeResult.rows[0]);
        const clock = rowTimestamp((await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts);
        const source = {
          type: 'process_template', templateId: id, templateName: template.name, templateVersion: active.version,
          triggeredBy: actor, triggerType: kind, triggerRunId: null, triggerToken: token, createdAt: clock,
          ...(slot ? { scheduledFor: slot } : {})
        };
        const ticketResult = await createTicket({
          template, source, spawnIdempotencyKey: triggerSpawnIdempotencyKey(token), persistence: { client }
        });
        if (!ticketResult || ticketResult.ok !== true || !ticketResult.ticket) return ticketResult || { ok: false, error: 'Ticket creation failed' };
        const ticket = ticketResult.ticket;
        if (!ticket.source || ticket.source.triggerToken !== token || ticket.source.templateId !== id) {
          throw new ProcessTemplateConflictError('Trigger idempotency resolved to a ticket from another template', 'PROCESS_TEMPLATE_TRIGGER_TOKEN_CONFLICT');
        }
        const triggerBody = {
          templateName: template.name,
          ticketTemplateSnapshot: template.ticketTemplate,
          executionPolicyUsed: ticket.executionPolicy || null,
          ...(template.createdBy ? { templateCreatedBy: template.createdBy } : {}),
          ...(template.schedule && template.schedule.scheduledBy ? { scheduledBy: template.schedule.scheduledBy } : {})
        };
        const inserted = await client.query(
          `INSERT INTO ${this.table('process_template_triggers')}
             (trigger_token, template_id, template_version, ticket_id, trigger_type, triggered_by, scheduled_for, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
          [token, id, active.version, ticket.id, kind, actor, slot, triggerBody]
        );
        const schedule = template.schedule ? { ...template.schedule } : null;
        if (kind === 'schedule') {
          schedule.lastScheduledTriggerAt = clock;
          schedule.nextRunAt = computeNextRunAt(schedule, clock);
        }
        const body = { ...(rootResult.rows[0].body || {}), lastTriggeredAt: clock, schedule };
        await client.query(
          `UPDATE ${this.table('process_templates')}
           SET schedule_enabled = $2, next_run_at = $3, body = $4::jsonb,
               revision = revision + 1, updated_by = $5, updated_at = clock_timestamp()
           WHERE id = $1`,
          [id, Boolean(schedule && schedule.enabled === true), schedule && schedule.enabled === true ? schedule.nextRunAt : null, body, actor]
        );
        const trigger = processTemplateTriggerFromRow(inserted.rows[0]);
        const auditLog = await this._appendSystemLog(client, {
          type: 'process_template:triggered', message: `Process template "${template.name}" created ticket #${ticket.id}`,
          metadata: { contextTicketId: ticket.id, templateId: id, templateName: template.name, triggeredBy: actor, triggerType: kind, triggerToken: token }
        });
        return { ok: true, deduped: ticketResult.created === false, template, trigger, ticket, source, auditLog };
      });
    } catch (error) {
      if (error && error.code === '23505' && ['process_template_triggers_trigger_token_key', 'process_template_triggers_ticket_id_key'].includes(error.constraint)) {
        throw new ProcessTemplateConflictError('Process-template trigger idempotency conflict', 'PROCESS_TEMPLATE_TRIGGER_TOKEN_CONFLICT');
      }
      throw error;
    }
  }

  async reconcileProcessTemplateVersions() {
    const result = await this.pool.query(
      `SELECT template.id
       FROM ${this.table('process_templates')} AS template
       LEFT JOIN ${this.table('process_template_versions')} AS version
         ON version.id = template.current_version_id
        AND version.template_id = template.id
        AND version.status = 'active'
        AND version.version = template.current_version
       WHERE version.id IS NULL
       ORDER BY template.id
       LIMIT $1`, [this.maxQueryRows + 1]
    );
    if (result.rowCount > 0) {
      throw new ProcessTemplateConflictError(`Process-template version integrity failed for template ${result.rows[0].id}`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
    }
    return { repairedCount: 0 };
  }

  async listLogs({
    runId = null,
    ticketId = null,
    types = null,
    excludeTypes = null,
    beforeId = null,
    afterId = null,
    order = 'desc',
    limit = 100
  } = {}) {
    const scopedRunId = nullablePositiveSafeInteger(runId, 'runId');
    const scopedTicketId = nullablePositiveSafeInteger(ticketId, 'ticketId');
    const before = nullablePositiveSafeInteger(beforeId, 'beforeId');
    const after = afterId === null || afterId === undefined || afterId === ''
      ? null
      : nonNegativeSafeInteger(afterId, 'afterId');
    if (before !== null && after !== null) throw new TypeError('beforeId and afterId are mutually exclusive');
    if (!['asc', 'desc'].includes(order)) throw new TypeError(`Unsupported order: ${order}`);
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const normalizeTypeList = (value, label) => {
      if (value === null || value === undefined) return null;
      if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
      if (value.length > this.maxQueryRows) throw new RangeError(`${label} exceeds the configured maximum`);
      return [...new Set(value.map(item => requiredString(item, label)))];
    };
    const included = normalizeTypeList(types, 'types');
    const excluded = normalizeTypeList(excludeTypes, 'excludeTypes');
    const clauses = [];
    const values = [];
    const parameter = value => {
      values.push(value);
      return `$${values.length}`;
    };
    if (scopedRunId !== null) {
      const ref = parameter(scopedRunId);
      clauses.push(`(run_id = ${ref} OR context_run_id = ${ref})`);
    }
    if (scopedTicketId !== null) {
      const ref = parameter(scopedTicketId);
      clauses.push(`(ticket_id = ${ref} OR context_ticket_id = ${ref})`);
    }
    if (included) clauses.push(`type = ANY(${parameter(included)}::text[])`);
    if (excluded) clauses.push(`NOT (type = ANY(${parameter(excluded)}::text[]))`);
    if (before !== null) clauses.push(`id < ${parameter(before)}`);
    if (after !== null) clauses.push(`id > ${parameter(after)}`);
    const limitRef = parameter(boundedLimit + 1);
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('diagnostic_logs')}
       ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY id ${order === 'desc' ? 'DESC' : 'ASC'}
       LIMIT ${limitRef}`,
      values
    );
    const page = result.rows.slice(0, boundedLimit).map(diagnosticLogFromRow);
    const last = page[page.length - 1] || null;
    return {
      logs: page,
      nextBeforeId: order === 'desc' && result.rows.length > boundedLimit && last ? last.id : null,
      nextAfterId: order === 'asc' && result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async listLogsForRuns({ runIds, types = null, excludeTypes = null, limitPerRun = 25 } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const boundedLimit = positiveSafeInteger(limitPerRun, 'limitPerRun');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limitPerRun exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const normalizeTypeList = (value, label) => {
      if (value === null || value === undefined) return null;
      if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
      return [...new Set(value.map(item => requiredString(item, label)))];
    };
    const included = normalizeTypeList(types, 'types');
    const excluded = normalizeTypeList(excludeTypes, 'excludeTypes');
    const result = await this.pool.query(
      `SELECT selected.*
       FROM unnest($1::bigint[]) AS requested(run_id)
       CROSS JOIN LATERAL (
         SELECT * FROM ${this.table('diagnostic_logs')} AS log
         WHERE log.run_id = requested.run_id
           AND ($2::text[] IS NULL OR log.type = ANY($2::text[]))
           AND ($3::text[] IS NULL OR NOT (log.type = ANY($3::text[])))
         ORDER BY log.id DESC
         LIMIT $4
       ) AS selected
       ORDER BY selected.run_id, selected.id`,
      [ids, included, excluded, boundedLimit]
    );
    return result.rows.map(diagnosticLogFromRow);
  }

  async hasRunLogType({ runId, type } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const logType = requiredString(type, 'type');
    const result = await this.pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM ${this.table('diagnostic_logs')}
         WHERE run_id = $1 AND type = $2
       ) AS present`,
      [id, logType]
    );
    return result.rows[0].present === true;
  }

  async getRunLogMetrics({ runIds } = {}, { client = null } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const connection = client || this.pool;
    const numericValue = expression => `CASE WHEN ${expression} ~ '^\\d+(\\.\\d+)?$' THEN (${expression})::numeric ELSE 0 END`;
    const totalTokens = numericValue("body->'usage'->>'total_tokens'");
    const totalTokensCamel = numericValue("body->'usage'->>'totalTokens'");
    const promptTokens = numericValue("COALESCE(body->'usage'->>'prompt_tokens', body->'usage'->>'input_tokens', body->'usage'->>'promptTokens', body->'usage'->>'inputTokens')");
    const completionTokens = numericValue("COALESCE(body->'usage'->>'completion_tokens', body->'usage'->>'output_tokens', body->'usage'->>'completionTokens', body->'usage'->>'outputTokens')");
    const result = await connection.query(
      `SELECT run_id,
         COALESCE(SUM(CASE
           WHEN COALESCE(body->'usage'->>'total_tokens', '') <> '' THEN ${totalTokens}
           WHEN COALESCE(body->'usage'->>'totalTokens', '') <> '' THEN ${totalTokensCamel}
           ELSE ${promptTokens} + ${completionTokens}
         END), 0)::numeric AS total_tokens_used,
         COUNT(*) FILTER (WHERE type = 'model:request')::bigint AS model_requests,
         COUNT(*) FILTER (WHERE type = 'model:response')::bigint AS model_responses,
         COUNT(*) FILTER (WHERE type = 'workspace:read')::bigint AS workspace_reads,
         COUNT(*) FILTER (WHERE type = 'workspace:write')::bigint AS workspace_writes,
         COUNT(*) FILTER (
           WHERE type = 'workspace:create'
             AND COALESCE(body #>> '{workspaceAction,kind}', '') <> 'folder'
         )::bigint AS files_created,
         COUNT(*) FILTER (WHERE type = 'workspace:write')::bigint AS files_modified,
         COUNT(*) FILTER (WHERE type = 'workspace:delete')::bigint AS files_deleted,
         COUNT(*) FILTER (
           WHERE type = ANY($2::text[])
         )::bigint AS workspace_actions
       FROM ${this.table('diagnostic_logs')}
       WHERE run_id = ANY($1::bigint[])
       GROUP BY run_id`,
      [ids, ['workspace:list', 'workspace:read', 'workspace:write', 'workspace:create', 'workspace:rename', 'workspace:delete']]
    );
    const safeCount = (value, label) => {
      const count = Number(value || 0);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`${label} exceeds safe integer range`);
      return count;
    };
    const byRun = new Map(result.rows.map(row => [positiveSafeInteger(row.run_id, 'metric.runId'), {
      runId: positiveSafeInteger(row.run_id, 'metric.runId'),
      totalTokensUsed: safeCount(row.total_tokens_used, 'token count'),
      totalModelRequests: safeCount(row.model_requests, 'model request count'),
      totalModelResponses: safeCount(row.model_responses, 'model response count'),
      totalWorkspaceReads: safeCount(row.workspace_reads, 'workspace read count'),
      totalWorkspaceWrites: safeCount(row.workspace_writes, 'workspace write count'),
      totalFilesCreated: safeCount(row.files_created, 'files created count'),
      totalFilesModified: safeCount(row.files_modified, 'files modified count'),
      totalFilesDeleted: safeCount(row.files_deleted, 'files deleted count'),
      totalWorkspaceActions: safeCount(row.workspace_actions, 'workspace action count')
    }]));
    const emptyMetric = runId => ({
      runId,
      totalTokensUsed: 0,
      totalModelRequests: 0,
      totalModelResponses: 0,
      totalWorkspaceReads: 0,
      totalWorkspaceWrites: 0,
      totalFilesCreated: 0,
      totalFilesModified: 0,
      totalFilesDeleted: 0,
      totalWorkspaceActions: 0
    });
    return ids.map(id => byRun.get(id) || emptyMetric(id));
  }

  async listPerformanceRunEvidence({ afterRunId = 0, throughRunId = null, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterRunId, 'afterRunId');
    const requestedHighWater = throughRunId === null || throughRunId === undefined ? null : nonNegativeSafeInteger(throughRunId, 'throughRunId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }

    return this.withTransaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const highWaterRunId = requestedHighWater === null
        ? Number((await client.query(
            `SELECT COALESCE(MAX(id), 0)::bigint AS through_run_id FROM ${this.table('runs')}`
          )).rows[0].through_run_id)
        : requestedHighWater;
      if (!Number.isSafeInteger(highWaterRunId) || highWaterRunId < 0) throw new RangeError('throughRunId exceeds safe integer range');
      const runResult = await client.query(
        `SELECT run.*,
           ticket.id AS analytics_ticket_id,
           ticket.status AS analytics_ticket_status,
           ticket.assignment_target_type AS analytics_ticket_assignment_target_type,
           ticket.assignment_target_id AS analytics_ticket_assignment_target_id,
           ticket.body AS analytics_ticket_body,
           ticket.revision AS analytics_ticket_revision,
           ticket.created_at AS analytics_ticket_created_at,
           ticket.updated_at AS analytics_ticket_updated_at,
           replay.snapshot AS analytics_replay_snapshot,
           replay.snapshot_hash AS analytics_replay_snapshot_hash,
           replay.revision AS analytics_replay_revision,
           replay.finalized_at AS analytics_replay_finalized_at,
           replay.created_at AS analytics_replay_created_at,
           replay.updated_at AS analytics_replay_updated_at,
           evaluation.evaluation AS analytics_run_evaluation
         FROM ${this.table('runs')} AS run
         JOIN ${this.table('tickets')} AS ticket ON ticket.id = run.ticket_id
         LEFT JOIN ${this.table('replay_snapshots')} AS replay ON replay.run_id = run.id
         LEFT JOIN ${this.table('run_evaluations')} AS evaluation ON evaluation.run_id = run.id
         WHERE run.id > $1 AND run.id <= $2
         ORDER BY run.id
         LIMIT $3`,
        [cursor, highWaterRunId, boundedLimit + 1]
      );
      const pageRows = runResult.rows.slice(0, boundedLimit);
      if (pageRows.length === 0) return { evidence: [], nextAfterRunId: null, throughRunId: highWaterRunId };

      const runIds = pageRows.map(row => positiveSafeInteger(row.id, 'run.id'));
      const operationResult = await client.query(
        `SELECT requested.run_id AS analytics_requested_run_id, selected.*
         FROM unnest($1::bigint[]) AS requested(run_id)
         CROSS JOIN LATERAL (
           SELECT receipt.*, intent.intent AS analytics_intent
           FROM ${this.table('operation_receipts')} AS receipt
           LEFT JOIN ${this.table('target_operation_intents')} AS intent
             ON intent.run_id = receipt.run_id
            AND intent.operation_key = receipt.idempotency_key
           WHERE receipt.run_id = requested.run_id
             AND receipt.outcome = 'succeeded'
             AND receipt.operation = ANY($2::text[])
           ORDER BY receipt.id
           LIMIT $3
         ) AS selected
         ORDER BY requested.run_id, selected.id`,
        [runIds, ['writeFile', 'createFolder', 'renamePath', 'deletePath'], this.maxQueryRows + 1]
      );
      const operationsByRunId = new Map(runIds.map(runId => [runId, []]));
      for (const row of operationResult.rows) {
        const runId = positiveSafeInteger(row.analytics_requested_run_id, 'operation.runId');
        const envelope = operationReceiptFromRow(row);
        const operation = row.analytics_intent
          ? targetOperationReceiptProjection(envelope, { intent: row.analytics_intent })
          : actionOperationReceiptProjection(envelope);
        const operations = operationsByRunId.get(runId);
        operations.push(operation);
        if (operations.length > this.maxQueryRows) {
          throw new RangeError(
            `run ${runId} performance operation evidence exceeds the configured maximum of ${this.maxQueryRows}`
          );
        }
      }

      const logMetrics = await this.getRunLogMetrics({ runIds }, { client });
      const logMetricsByRunId = new Map(logMetrics.map(metric => [metric.runId, metric]));
      const evidence = pageRows.map(row => {
        const run = runFromRow(row);
        if (row.analytics_run_evaluation) run.runEvaluation = row.analytics_run_evaluation;
        const ticket = {
          ...(row.analytics_ticket_body || {}),
          id: positiveSafeInteger(row.analytics_ticket_id, 'ticket.id'),
          status: row.analytics_ticket_status,
          assignmentTargetType: row.analytics_ticket_assignment_target_type,
          assignmentTargetId: nullablePositiveSafeInteger(row.analytics_ticket_assignment_target_id, 'ticket.assignmentTargetId'),
          revision: positiveSafeInteger(row.analytics_ticket_revision, 'ticket.revision'),
          createdAt: rowTimestamp(row.analytics_ticket_created_at),
          updatedAt: rowTimestamp(row.analytics_ticket_updated_at)
        };
        const replayRecord = row.analytics_replay_snapshot === null ? null : replaySnapshotFromRow({
          run_id: run.id,
          ticket_id: run.ticketId,
          snapshot: row.analytics_replay_snapshot,
          snapshot_hash: row.analytics_replay_snapshot_hash,
          revision: row.analytics_replay_revision,
          finalized_at: row.analytics_replay_finalized_at,
          created_at: row.analytics_replay_created_at,
          updated_at: row.analytics_replay_updated_at
        });
        return {
          run,
          ticket,
          replaySnapshot: replayRecord ? replayRecord.snapshot : null,
          operationHistory: operationsByRunId.get(run.id) || [],
          logMetrics: logMetricsByRunId.get(run.id) || null
        };
      });
      const last = evidence[evidence.length - 1];
      return {
        evidence,
        nextAfterRunId: runResult.rows.length > boundedLimit && last ? last.run.id : null,
        throughRunId: highWaterRunId
      };
    });
  }

  async resetLogs() {
    await this.pool.query(`TRUNCATE TABLE ${this.table('diagnostic_logs')} RESTART IDENTITY`);
  }

  async resetDevelopmentState({ changedBy = 'system' } = {}) {
    const actor = requiredString(changedBy, 'changedBy');
    return this.withTransaction(async client => {
      // Development reset intentionally removes every ticket-linked projection
      // and its evidence. PostgreSQL discovers dependent relations through the
      // foreign-key graph, so newly added projections cannot be left orphaned.
      await client.query(`TRUNCATE TABLE ${this.table('tickets')} RESTART IDENTITY CASCADE`);
      const log = await this._appendSystemLog(client, {
        type: 'system:reset',
        message: `Debug data reset completed by ${actor}`,
        metadata: { changedBy: actor }
      });
      return { reset: true, log };
    });
  }

  async listRunsNeedingTerminalReconciliation({ afterId = 0, limit = 100 } = {}) {
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT run.*
       FROM ${this.table('runs')} AS run
       WHERE run.id > $1
         AND run.status = ANY($2::text[])
         AND EXISTS (
           SELECT 1 FROM ${this.table('events')} AS execution_event
           WHERE execution_event.run_id = run.id
             AND execution_event.type = ANY($3::text[])
         )
         AND (
           NOT EXISTS (
             SELECT 1 FROM ${this.table('events')} AS replay_event
             WHERE replay_event.run_id = run.id
               AND replay_event.type = ANY($4::text[])
           )
           OR NOT EXISTS (
             SELECT 1 FROM ${this.table('events')} AS terminal_event
             WHERE terminal_event.run_id = run.id
               AND terminal_event.type = 'run.terminalized'
           )
         )
       ORDER BY run.id
       LIMIT $5`,
      [
        cursor,
        [...TERMINAL_RUN_STATUSES],
        ['run.execution_completed', 'run.execution_failed'],
        ['run.snapshot_finalized', 'replay.snapshot.finalized'],
        boundedLimit + 1
      ]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async verifyRunLease({ runId, leaseOwner }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE id = $1
         AND status = ANY($2::text[])
         AND lease_owner = $3
         AND lease_expires_at > clock_timestamp()`,
      [id, ['pending', 'running'], owner]
    );
    return result.rowCount === 0 ? null : runFromRow(result.rows[0]);
  }

  async listPendingRuns({ limit = 100, cursor = null, scanEndCursor = null } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const after = cursor === null || cursor === undefined ? null : jsonObject(cursor, 'cursor');
    const afterCreatedAt = after ? requiredString(after.createdAt, 'cursor.createdAt') : null;
    if (afterCreatedAt !== null && Number.isNaN(Date.parse(afterCreatedAt))) {
      throw new TypeError('cursor.createdAt must be a valid timestamp');
    }
    const afterId = after ? positiveSafeInteger(after.id, 'cursor.id') : null;
    const requestedScanEnd = scanEndCursor === null || scanEndCursor === undefined
      ? null
      : jsonObject(scanEndCursor, 'scanEndCursor');
    let scanEndCreatedAt = requestedScanEnd
      ? requiredString(requestedScanEnd.createdAt, 'scanEndCursor.createdAt')
      : null;
    if (scanEndCreatedAt !== null && Number.isNaN(Date.parse(scanEndCreatedAt))) {
      throw new TypeError('scanEndCursor.createdAt must be a valid timestamp');
    }
    let scanEndId = requestedScanEnd
      ? positiveSafeInteger(requestedScanEnd.id, 'scanEndCursor.id')
      : null;
    if (!requestedScanEnd) {
      const horizon = await this.pool.query(
        `SELECT id, created_at::text AS cursor_created_at
         FROM ${this.table('runs')}
         WHERE status = 'pending'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      );
      if (horizon.rowCount > 0) {
        scanEndCreatedAt = horizon.rows[0].cursor_created_at;
        scanEndId = positiveSafeInteger(horizon.rows[0].id, 'scanEndCursor.id');
      }
    }
    const result = await this.pool.query(
      `SELECT run.*, run.created_at::text AS cursor_created_at
       FROM ${this.table('runs')} AS run
       WHERE run.status = 'pending'
         AND ($2::timestamptz IS NULL OR (run.created_at, run.id) > ($2::timestamptz, $3::bigint))
         AND ($4::timestamptz IS NULL OR (run.created_at, run.id) <= ($4::timestamptz, $5::bigint))
       ORDER BY run.created_at, run.id
       LIMIT $1`,
      [boundedLimit + 1, afterCreatedAt, afterId, scanEndCreatedAt, scanEndId]
    );
    const page = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = page[page.length - 1] || null;
    return {
      runs: page,
      nextCursor: result.rows.length > boundedLimit && last
        ? { createdAt: result.rows[boundedLimit - 1].cursor_created_at, id: last.id }
        : null,
      scanEndCursor: result.rows.length > boundedLimit
        ? { createdAt: scanEndCreatedAt, id: scanEndId }
        : null
    };
  }

  async listExpiredRunningRuns({ limit = 100 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE status = 'running'
         AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
       ORDER BY lease_expires_at NULLS FIRST, id
       LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(runFromRow);
  }

  async getRunAttemptPositions({ runIds } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const result = await this.pool.query(
      `SELECT
         target.id AS run_id,
         COUNT(sibling.id)::bigint AS attempt_count,
         COUNT(sibling.id) FILTER (WHERE sibling.id <= target.id)::bigint AS attempt_number
       FROM ${this.table('runs')} AS target
       JOIN ${this.table('runs')} AS sibling ON sibling.ticket_id = target.ticket_id
       WHERE target.id = ANY($1::bigint[])
       GROUP BY target.id
       ORDER BY target.id`,
      [ids]
    );
    return result.rows.map(row => {
      const attemptNumber = Number(row.attempt_number);
      const attemptCount = Number(row.attempt_count);
      if (![attemptNumber, attemptCount].every(value => Number.isSafeInteger(value) && value > 0)) {
        throw new RangeError('run attempt position exceeds safe integer range');
      }
      return {
        runId: positiveSafeInteger(row.run_id, 'runAttemptPosition.runId'),
        attemptNumber,
        attemptCount
      };
    });
  }

  async listRecoverableRuns({ mode = 'lease_expiry', afterId = 0, limit = 100 } = {}) {
    normalizeRunRecoveryMode(mode);
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    // A PostgreSQL process never infers that another process is gone merely
    // because this process started. Both recovery modes therefore use the same
    // database-fenced authority: an unowned or expired running lease.
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('runs')}
       WHERE status = 'running'
         AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
         AND id > $1
       ORDER BY id
       LIMIT $2`,
      [cursor, boundedLimit + 1]
    );
    const runs = result.rows.slice(0, boundedLimit).map(runFromRow);
    const last = runs[runs.length - 1] || null;
    return {
      runs,
      nextAfterId: result.rows.length > boundedLimit && last ? last.id : null
    };
  }

  async claimRunRecovery({
    runId,
    recoveryOwner,
    leaseDurationMs,
    mode = 'lease_expiry',
    eventPayload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const recoveryMode = normalizeRunRecoveryMode(mode);
    const callerPayload = this.assertJsonRecord(eventPayload, 'recovery claim event payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, status, lease_owner, lease_expires_at, last_heartbeat_at
           FROM ${this.table('runs')}
           WHERE id = $1
             AND status = 'running'
             AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET lease_owner = $2,
               lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
               last_heartbeat_at = clock_timestamp(),
               revision = run.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.status AS previous_status,
             candidate.lease_owner AS previous_lease_owner,
             candidate.lease_expires_at AS previous_lease_expires_at,
             candidate.last_heartbeat_at AS previous_last_heartbeat_at
         )
         SELECT * FROM updated`,
        [id, owner, duration]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const previousLease = {
        leaseOwner: result.rows[0].previous_lease_owner,
        leaseExpiresAt: rowTimestamp(result.rows[0].previous_lease_expires_at),
        lastHeartbeatAt: rowTimestamp(result.rows[0].previous_last_heartbeat_at)
      };
      const event = await this._appendEvent(client, {
        type: 'run.recovery_claimed',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          mode: recoveryMode,
          recoveryOwner: owner,
          recoveryLeaseExpiresAt: run.leaseExpiresAt,
          previousStatus,
          previousLease,
          recoveredAt: run.updatedAt
        }
      });
      return { run, event, previousStatus, previousLease };
    });
  }

  async resumeRecoveredRun({ runId, recoveryOwner, eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const callerPayload = this.assertJsonRecord(eventPayload, 'resume event payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, status, lease_owner, lease_expires_at, last_heartbeat_at
           FROM ${this.table('runs')}
           WHERE id = $1
             AND status = 'running'
             AND lease_owner = $2
             AND lease_expires_at > clock_timestamp()
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = 'pending',
               started_at = NULL,
               completed_at = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               revision = run.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.status AS previous_status,
             candidate.lease_owner AS previous_lease_owner,
             candidate.lease_expires_at AS previous_lease_expires_at,
             candidate.last_heartbeat_at AS previous_last_heartbeat_at
         )
         SELECT * FROM updated`,
        [id, owner]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const previousLease = {
        leaseOwner: result.rows[0].previous_lease_owner,
        leaseExpiresAt: rowTimestamp(result.rows[0].previous_lease_expires_at),
        lastHeartbeatAt: rowTimestamp(result.rows[0].previous_last_heartbeat_at)
      };
      const event = await this._appendEvent(client, {
        type: 'run.resumed',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousStatus,
          previousLease,
          recoveredAt: run.updatedAt,
          status: run.status
        }
      });
      return { run, event, previousStatus, previousLease };
    });
  }

  async repairRecoveredRunTerminalProjection({
    runId,
    recoveryOwner,
    status,
    eventPayload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(recoveryOwner, 'recoveryOwner');
    const terminalStatus = requiredString(status, 'status');
    if (!TERMINAL_RUN_STATUSES.has(terminalStatus)) {
      throw new TypeError(`Unsupported terminal run status: ${terminalStatus}`);
    }
    const callerPayload = this.assertJsonRecord(eventPayload, 'terminal projection repair event payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, status, lease_owner, lease_expires_at, last_heartbeat_at
           FROM ${this.table('runs')}
           WHERE id = $1
             AND status = 'running'
             AND lease_owner = $2
             AND lease_expires_at > clock_timestamp()
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = $3,
               current_phase = 'terminalization',
               completed_at = COALESCE(run.completed_at, clock_timestamp()),
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               revision = run.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.status AS previous_status,
             candidate.lease_owner AS previous_lease_owner,
             candidate.lease_expires_at AS previous_lease_expires_at,
             candidate.last_heartbeat_at AS previous_last_heartbeat_at
         )
         SELECT * FROM updated`,
        [id, owner, terminalStatus]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const previousLease = {
        leaseOwner: result.rows[0].previous_lease_owner,
        leaseExpiresAt: rowTimestamp(result.rows[0].previous_lease_expires_at),
        lastHeartbeatAt: rowTimestamp(result.rows[0].previous_last_heartbeat_at)
      };
      const event = await this._appendEvent(client, {
        type: 'run.terminal_projection_repaired',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousStatus,
          previousLease,
          repairedAt: run.updatedAt,
          status: terminalStatus
        }
      });
      return { run, event, previousStatus, previousLease };
    });
  }

  async transitionTicket({
    ticketId,
    expectedRevision,
    fromStatuses,
    toStatus,
    patch = {},
    eventType = 'ticket.updated',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const sources = normalizeStatuses(fromStatuses, TICKET_STATUSES, 'ticket source status');
    const target = requiredString(toStatus, 'toStatus');
    if (!TICKET_STATUSES.has(target)) throw new TypeError(`Unsupported ticket status: ${target}`);
    const bodyPatch = this.assertJsonRecord(patch, 'ticket patch');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const result = await connection.query(
        `WITH candidate AS (
           SELECT id, status
           FROM ${this.table('tickets')}
           WHERE id = $1 AND revision = $2 AND status = ANY($3::text[])
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('tickets')} AS ticket
           SET status = $4,
               body = ticket.body || $5::jsonb,
               revision = ticket.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE ticket.id = candidate.id
           RETURNING ticket.*, candidate.status AS previous_status
         )
         SELECT * FROM updated`,
        [id, revision, sources, target, bodyPatch]
      );
      if (result.rowCount === 0) {
        return this._throwTransitionConflict(connection, {
          entity: 'ticket',
          tableName: 'tickets',
          id,
          expectedRevision: revision,
          expectedStatuses: sources,
          fromRow: ticketFromRow
        });
      }
      const ticket = ticketFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const event = await this._appendEvent(connection, {
        type,
        ticketId: ticket.id,
        payload: {
          ...callerPayload,
          previousStatus,
          status: ticket.status,
          revision: ticket.revision,
          updatedAt: ticket.updatedAt
        }
      });
      return { ticket, event, previousStatus };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async transitionTicketState({
    ticketId,
    fromStatuses,
    toStatus,
    patch = {},
    eventType = 'ticket.updated',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (result.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(result.rows[0]);
      const bodyPatch = this.assertJsonRecord(patch, 'ticket patch');
      let authoritativePatch = bodyPatch;
      let authoritativeEventPayload = eventPayload;
      if (Object.prototype.hasOwnProperty.call(bodyPatch, 'changedAt')) {
        const clock = await connection.query('SELECT clock_timestamp() AS ts');
        const changedAt = isoTimestamp(clock.rows[0].ts, 'ticket change clock');
        authoritativePatch = { ...bodyPatch, changedAt };
        authoritativeEventPayload = { ...eventPayload, changedAt };
      }
      return this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses,
        toStatus,
        patch: authoritativePatch,
        eventType,
        eventPayload: authoritativeEventPayload
      }, { client: connection });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async transitionTicketAfterRun({ runId }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const runIdentityResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runIdentityResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runIdentityResult.rows[0].ticket_id, 'run.ticketId');
      const ticketResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [ticketId]
      );
      if (ticketResult.rowCount === 0) {
        const error = new Error(`ticket ${ticketId} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(ticketResult.rows[0]);
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const run = runFromRow(runResult.rows[0]);
      if (run.ticketId !== ticketId || !TERMINAL_RUN_STATUSES.has(run.status)) {
        throw new StateTransitionConflictError('run', id, [...TERMINAL_RUN_STATUSES], run);
      }
      const batchResult = await connection.query(
        `SELECT * FROM ${this.table('runs')}
         WHERE ticket_id = $1 AND body->>'ticketOpenedAt' = $2
         ORDER BY id
         FOR UPDATE`,
        [run.ticketId, run.ticketOpenedAt]
      );
      const batchRuns = batchResult.rows.map(runFromRow);
      const ownedScope = ticket.assignmentTargetType === 'group' &&
        ['allocated', 'dynamic'].includes(ticket.assignmentMode);
      let targetStatus = null;
      if (run.status === 'interrupted') {
        if (ticket.status === 'in_progress' &&
            !batchRuns.some(item => ['pending', 'running'].includes(item.status))) {
          targetStatus = 'open';
        }
      } else if (!ownedScope) {
        targetStatus = run.status;
      } else if (run.status === 'failed' || batchRuns.some(item => item.status === 'failed')) {
        targetStatus = 'failed';
      } else if (batchRuns.length > 0 && batchRuns.every(item => item.status === 'completed')) {
        targetStatus = 'completed';
      }

      if (!targetStatus || ticket.status === targetStatus) {
        return { ticket, event: null, previousStatus: ticket.status, changed: false };
      }
      const patch = ['completed', 'failed', 'interrupted'].includes(targetStatus)
        ? { rerunMode: null }
        : {};
      const transitioned = await this.transitionTicket({
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        fromStatuses: [ticket.status],
        toStatus: targetStatus,
        patch
      }, { client: connection });
      return { ...transitioned, changed: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async reopenTicket({ ticketId, rerunMode = null }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (result.rowCount === 0) return null;
      const ticket = ticketFromRow(result.rows[0]);
      if (ticket.triage && ticket.triage.required === true && !ticket.triage.resolvedAt) {
        const error = new Error('Cannot rerun: unresolved ticket-level triage exists on this ticket. Resolve triage first.');
        error.code = 'TICKET_TRIAGE_REQUIRED';
        throw error;
      }
      return this.transitionTicket({
        ticketId: id,
        expectedRevision: ticket.revision,
        fromStatuses: [ticket.status],
        toStatus: 'open',
        patch: { rerunMode: rerunMode ? String(rerunMode) : null }
      }, { client: connection });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRetryRun({
    ticketId,
    predecessorRunId,
    runDraft,
    runEventPayload = () => ({})
  }) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const predecessorId = positiveSafeInteger(predecessorRunId, 'predecessorRunId');
    const draft = this.assertJsonRecord(runDraft, 'runDraft');
    return this.withTransaction(async client => {
      const reopened = await this.reopenTicket({ ticketId: id, rerunMode: 'auto_retry' }, { client });
      if (!reopened) return null;
      const created = await this.createRunsAndStartTicket({
        ticketId: id,
        runDrafts: [{ ...draft, rerunMode: 'auto_retry' }],
        afterTerminalRunId: predecessorId,
        runEventPayload,
        ticketEventPayload: { rerunMode: 'auto_retry', predecessorRunId: predecessorId }
      }, { client });
      return { ...created, reopenEvent: reopened.event };
    });
  }

  async transitionRun({
    runId,
    expectedRevision,
    fromStatuses,
    toStatus,
    leaseOwner = null,
    allowExpiredLease = false,
    patch = {},
    eventType = 'run.status_changed',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const sources = normalizeStatuses(fromStatuses, RUN_STATUSES, 'run source status');
    const target = requiredString(toStatus, 'toStatus');
    if (!RUN_STATUSES.has(target)) throw new TypeError(`Unsupported run status: ${target}`);
    for (const source of sources) {
      if (!RUN_STATUS_TRANSITIONS.get(source).has(target)) {
        throw new TypeError(`Unsupported run status transition: ${source} -> ${target}`);
      }
    }
    const owner = optionalString(leaseOwner);
    const permitExpiredLease = allowExpiredLease === true;
    if (target === 'running' && !owner) throw new TypeError('leaseOwner is required to start a run');
    const expiredTerminalRecovery = permitExpiredLease && ['failed', 'interrupted'].includes(target);
    if (sources.includes('running') && target !== 'pending' && !owner && !expiredTerminalRecovery) {
      throw new TypeError('leaseOwner is required to transition a running run');
    }
    const requestedPatch = this.assertJsonRecord(patch, 'run patch');
    const requestedPhase = Object.prototype.hasOwnProperty.call(requestedPatch, 'currentPhase')
      ? normalizeRunPhase(requestedPatch.currentPhase, 'patch.currentPhase')
      : null;
    if (requestedPhase && !TERMINAL_RUN_STATUSES.has(target)) {
      throw new TypeError('Non-terminal phase changes must use advanceRunPhase');
    }
    const projectedPhase = TERMINAL_RUN_STATUSES.has(target) ? 'terminalization' : requestedPhase;
    if (TERMINAL_RUN_STATUSES.has(target) && requestedPhase && requestedPhase !== 'terminalization') {
      throw new TypeError('Terminal runs must project terminalization phase');
    }
    const bodyPatch = { ...requestedPatch };
    delete bodyPatch.currentPhase;
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const result = await connection.query(
        `WITH candidate AS (
           SELECT id, status
           FROM ${this.table('runs')}
           WHERE id = $1
             AND revision = $2
             AND status = ANY($3::text[])
             AND (
               (
                 status = 'pending' AND
                 (
                   ($4::text = 'running' AND $6::text IS NOT NULL AND
                     lease_owner = $6 AND lease_expires_at > clock_timestamp()) OR
                   ($4::text = 'pending' AND (
                     ($6::text IS NULL AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())) OR
                     ($6::text IS NOT NULL AND lease_owner = $6 AND lease_expires_at > clock_timestamp())
                   )) OR
                   ($4::text = ANY(ARRAY['failed', 'interrupted']) AND (
                     $6::text IS NULL OR
                     (lease_owner = $6 AND lease_expires_at > clock_timestamp())
                   ))
                 )
               ) OR (
               status = 'running' AND
               (
                  ($4::text = 'pending' AND $6::text IS NULL AND (
                    lease_owner IS NULL OR lease_expires_at <= clock_timestamp()
                  )) OR (
                    $6::text IS NOT NULL AND
                    lease_owner = $6 AND
                    lease_expires_at > clock_timestamp()
                  ) OR (
                    $7::boolean = TRUE AND
                    $4::text = ANY(ARRAY['failed', 'interrupted']) AND
                    (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
                  )
                )
               )
             )
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = $4,
               body = run.body || $5::jsonb,
               current_phase = COALESCE($8::text, run.current_phase),
               revision = run.revision + 1,
               started_at = CASE
                 WHEN $4 = 'pending' THEN NULL
                 WHEN $4 = 'running' THEN COALESCE(run.started_at, clock_timestamp())
                 ELSE run.started_at
               END,
               completed_at = CASE
                 WHEN $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN clock_timestamp()
                 ELSE NULL
               END,
               lease_owner = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.lease_owner
               END,
               lease_expires_at = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.lease_expires_at
               END,
               last_heartbeat_at = CASE
                 WHEN $4 = 'pending' OR $4 = ANY(ARRAY['completed', 'failed', 'interrupted']) THEN NULL
                 ELSE run.last_heartbeat_at
               END,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.status AS previous_status
         )
         SELECT * FROM updated`,
        [id, revision, sources, target, bodyPatch, owner, permitExpiredLease, projectedPhase]
      );
      if (result.rowCount === 0) {
        return this._throwTransitionConflict(connection, {
          entity: 'run',
          tableName: 'runs',
          id,
          expectedRevision: revision,
          expectedStatuses: sources,
          fromRow: runFromRow,
          leaseOwner: owner,
          leaseConstrained: true
        });
      }
      const run = runFromRow(result.rows[0]);
      const previousStatus = result.rows[0].previous_status;
      const event = await this._appendEvent(connection, {
        type,
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousStatus,
          status: run.status,
          revision: run.revision,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          updatedAt: run.updatedAt
        }
      });
      return { run, event, previousStatus };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async appendEvent(event, { client = null } = {}) {
    const execute = connection => this._appendEvent(connection, event);
    return client ? execute(client) : this.withTransaction(execute);
  }

  async _appendEvent(client, event) {
    const runId = nullablePositiveSafeInteger(event && event.runId, 'event.runId');
    let chain = null;
    if (runId !== null) {
      await client.query(
        `INSERT INTO ${this.table('run_event_chain_tips')} (run_id, next_seq, previous_hash)
         VALUES ($1, 0, NULL) ON CONFLICT (run_id) DO NOTHING`,
        [runId]
      );
      const tip = await client.query(
        `SELECT next_seq, previous_hash FROM ${this.table('run_event_chain_tips')}
         WHERE run_id = $1 FOR UPDATE`,
        [runId]
      );
      if (tip.rowCount !== 1) throw new Error(`Run ${runId} has no event-chain tip`);
      chain = {
        nextSeq: nonNegativeSafeInteger(tip.rows[0].next_seq, 'chain.nextSeq'),
        previousHash: tip.rows[0].previous_hash
      };
    }

    const clock = await client.query('SELECT clock_timestamp() AS ts');
    const normalized = buildEventEnvelope({
      event,
      eventId: crypto.randomUUID(),
      timestamp: clock.rows[0].ts,
      chain
    });
    this.assertJsonRecord(normalized.payload, 'event.payload');
    const result = await client.query(
      `INSERT INTO ${this.table('events')}
        (id, schema_version, ts, type, ticket_id, run_id, step_id, seq, prev_hash, hash, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::json)
       RETURNING *`,
      [
        normalized.id,
        normalized.schemaVersion,
        normalized.ts,
        normalized.type,
        normalized.ticketId,
        normalized.runId,
        normalized.stepId,
        normalized.seq === undefined ? null : normalized.seq,
        normalized.prevHash === undefined ? null : normalized.prevHash,
        normalized.hash === undefined ? null : normalized.hash,
        normalized.payload
      ]
    );

    if (runId !== null) {
      await client.query(
        `UPDATE ${this.table('run_event_chain_tips')}
         SET next_seq = $2, previous_hash = $3, updated_at = clock_timestamp()
         WHERE run_id = $1`,
        [runId, normalized.seq + 1, normalized.hash]
      );
    }
    return eventFromRow(result.rows[0]);
  }

  async _recordImmutableRunEvidence({
    runId,
    value,
    valueLabel,
    tableName,
    columnName,
    eventType,
    eventPayloadKey,
    eventPayload = {},
    fromRow,
    client = null
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const document = this.assertJsonRecord(value, valueLabel);
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id, status FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      if (!TERMINAL_RUN_STATUSES.has(runResult.rows[0].status)) {
        throw new TypeError(`${valueLabel} requires a terminal run`);
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table(tableName)} (run_id, ticket_id, ${quoteIdentifier(columnName)})
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING *`,
        [id, ticketId, document]
      );
      if (inserted.rowCount === 0) {
        const existingResult = await connection.query(
          `SELECT *, ${quoteIdentifier(columnName)} = $2::jsonb AS evidence_matches
           FROM ${this.table(tableName)}
           WHERE run_id = $1`,
          [id, document]
        );
        if (existingResult.rowCount === 1 && existingResult.rows[0].evidence_matches === true) {
          return { record: fromRow(existingResult.rows[0]), event: null, inserted: false };
        }
        throw new ImmutableEvidenceConflictError(valueLabel, id);
      }

      const record = fromRow(inserted.rows[0]);
      const event = await this._appendEvent(connection, {
        type: eventType,
        ticketId,
        runId: id,
        payload: {
          ...callerPayload,
          [eventPayloadKey]: document,
          recordedAt: record.recordedAt
        }
      });
      return { record, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async recordRunEvaluation({ runId, evaluation, eventPayload = {} }, { client = null } = {}) {
    return this._recordImmutableRunEvidence({
      runId,
      value: evaluation,
      valueLabel: 'run evaluation',
      tableName: 'run_evaluations',
      columnName: 'evaluation',
      eventType: 'run.evaluation_completed',
      eventPayloadKey: 'evaluation',
      eventPayload,
      fromRow: evaluationFromRow,
      client
    });
  }

  async recordRunConsequence({ runId, consequence, eventPayload = {} }, { client = null } = {}) {
    return this._recordImmutableRunEvidence({
      runId,
      value: consequence,
      valueLabel: 'run consequence',
      tableName: 'run_consequences',
      columnName: 'consequence',
      eventType: 'run.consequence_recorded',
      eventPayloadKey: 'consequence',
      eventPayload,
      fromRow: consequenceFromRow,
      client
    });
  }

  async getRunEvaluation(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('run_evaluations')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : evaluationFromRow(result.rows[0]);
  }

  async getRunConsequence(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('run_consequences')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : consequenceFromRow(result.rows[0]);
  }

  async writeReplaySnapshot({
    runId,
    expectedRevision = null,
    snapshot,
    finalize = false,
    eventType = null,
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const document = this.assertJsonRecord(snapshot, 'replay snapshot');
    const snapshotHash = sha256Json(document);
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const explicitEventType = eventType === null || eventType === undefined
      ? null
      : requiredString(eventType, 'eventType');
    const isCreate = expectedRevision === null || expectedRevision === undefined;
    const revision = isCreate ? null : positiveSafeInteger(expectedRevision, 'expectedRevision');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id, status FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      if (finalize === true && !TERMINAL_RUN_STATUSES.has(runResult.rows[0].status)) {
        throw new TypeError('Finalizing a replay snapshot requires a terminal run');
      }
      let result;
      if (isCreate) {
        result = await connection.query(
          `INSERT INTO ${this.table('replay_snapshots')}
            (run_id, ticket_id, snapshot, snapshot_hash, finalized_at)
           VALUES ($1, $2, $3::jsonb, $4, CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END)
           ON CONFLICT (run_id) DO NOTHING
           RETURNING *`,
          [id, ticketId, document, snapshotHash, finalize === true]
        );
      } else {
        result = await connection.query(
          `UPDATE ${this.table('replay_snapshots')}
           SET snapshot = $3::jsonb,
               snapshot_hash = $4,
               revision = revision + 1,
               finalized_at = CASE WHEN $5::boolean THEN clock_timestamp() ELSE NULL END,
               updated_at = clock_timestamp()
           WHERE run_id = $1 AND revision = $2 AND finalized_at IS NULL
           RETURNING *`,
          [id, revision, document, snapshotHash, finalize === true]
        );
      }

      if (result.rowCount === 0) {
        const currentResult = await connection.query(
          `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`,
          [id]
        );
        if (currentResult.rowCount === 1 && currentResult.rows[0].finalized_at !== null) {
          throw new ImmutableEvidenceConflictError('finalized replay snapshot', id);
        }
        const current = currentResult.rowCount === 0 ? null : replaySnapshotFromRow(currentResult.rows[0]);
        throw new OptimisticConcurrencyError('replay snapshot', id, revision || 0, current);
      }

      const record = replaySnapshotFromRow(result.rows[0]);
      const resolvedEventType = explicitEventType || (record.finalizedAt
        ? 'replay.snapshot.finalized'
        : record.revision === 1
          ? 'replay.snapshot.created'
          : 'replay.snapshot.updated');
      const event = await this._appendEvent(connection, {
        type: resolvedEventType,
        ticketId,
        runId: id,
        payload: {
          ...callerPayload,
          snapshotHash: record.snapshotHash,
          revision: record.revision,
          finalizedAt: record.finalizedAt,
          updatedAt: record.updatedAt
        }
      });
      return { record, event, created: isCreate };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async advanceRunPhase({
    runId,
    leaseOwner,
    fromPhase,
    toPhase,
    stepId = null,
    reason = 'Inferred from model response actions'
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const source = normalizeRunPhase(fromPhase, 'fromPhase');
    const target = normalizeRunPhase(toPhase, 'toPhase');
    const normalizedStepId = stepId === undefined || stepId === null ? null : requiredString(stepId, 'stepId');
    const normalizedReason = requiredString(reason, 'reason');

    return this.withTransaction(async client => {
      const currentResult = await client.query(
        `SELECT *, lease_expires_at > clock_timestamp() AS lease_live
         FROM ${this.table('runs')}
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (currentResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const current = runFromRow(currentResult.rows[0]);
      if (current.status !== 'running' || current.leaseOwner !== owner || currentResult.rows[0].lease_live !== true) {
        return null;
      }
      if (current.currentPhase === target) return { run: current, event: null, changed: false };
      if (current.currentPhase !== source) {
        throw new RunPhaseConflictError(id, source, current.currentPhase);
      }
      if (!RUN_PHASE_TRANSITIONS.get(source).has(target)) {
        return { run: current, event: null, changed: false };
      }

      const updated = await client.query(
        `UPDATE ${this.table('runs')}
         SET current_phase = $3,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND lease_owner = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, target]
      );
      if (updated.rowCount === 0) return null;
      const run = runFromRow(updated.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'execution.phase_transition',
        ticketId: run.ticketId,
        runId: run.id,
        ...(normalizedStepId === null ? {} : { stepId: normalizedStepId }),
        payload: {
          fromPhase: source,
          toPhase: target,
          reason: normalizedReason
        }
      });
      return { run, event, changed: true };
    });
  }

  async terminalizeRun({
    runId,
    expectedRevision,
    expectedReplayRevision = null,
    fromStatuses,
    status,
    leaseOwner = null,
    allowExpiredLease = false,
    patch = {},
    replaySnapshot,
    evaluation,
    consequence,
    executionEvent,
    beforeReplayEvents = [],
    replayEvent,
    beforeEvaluationEvents = [],
    terminalEvent
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const requestedRevision = expectedRevision === null || expectedRevision === undefined
      ? null
      : positiveSafeInteger(expectedRevision, 'expectedRevision');
    const requestedReplayRevision = expectedReplayRevision === null || expectedReplayRevision === undefined
      ? null
      : positiveSafeInteger(expectedReplayRevision, 'expectedReplayRevision');
    if (!Array.isArray(beforeReplayEvents) || !Array.isArray(beforeEvaluationEvents)) {
      throw new TypeError('terminalization event groups must be arrays');
    }
    const normalizeTerminalEvent = (event, label) => {
      const source = this.assertJsonRecord(event, label);
      return {
        type: requiredString(source.type, `${label}.type`),
        ...(source.stepId === undefined || source.stepId === null ? {} : { stepId: String(source.stepId) }),
        payload: this.assertJsonRecord(source.payload || {}, `${label}.payload`)
      };
    };
    const execution = normalizeTerminalEvent(executionEvent, 'executionEvent');
    const preReplay = beforeReplayEvents.map((event, index) => normalizeTerminalEvent(event, `beforeReplayEvents[${index}]`));
    const replay = normalizeTerminalEvent(replayEvent, 'replayEvent');
    const preEvaluation = beforeEvaluationEvents.map((event, index) => normalizeTerminalEvent(event, `beforeEvaluationEvents[${index}]`));
    const terminal = normalizeTerminalEvent(terminalEvent, 'terminalEvent');

    return this.withTransaction(async client => {
      const storedEvents = [];
      const currentRun = await client.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentRun.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const revision = positiveSafeInteger(currentRun.rows[0].revision, 'run.revision');
      if (requestedRevision !== null && requestedRevision !== revision) {
        throw new OptimisticConcurrencyError('run', id, requestedRevision, runFromRow(currentRun.rows[0]));
      }
      const currentReplay = await client.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      const replayRevision = currentReplay.rowCount === 0
        ? null
        : positiveSafeInteger(currentReplay.rows[0].revision, 'replaySnapshot.revision');
      if (requestedReplayRevision !== null && requestedReplayRevision !== replayRevision) {
        throw new OptimisticConcurrencyError(
          'replay snapshot',
          id,
          requestedReplayRevision,
          currentReplay.rowCount === 0 ? null : replaySnapshotFromRow(currentReplay.rows[0])
        );
      }
      const transitioned = await this.transitionRun({
        runId: id,
        expectedRevision: revision,
        fromStatuses,
        toStatus: status,
        leaseOwner,
        allowExpiredLease,
        patch,
        eventType: execution.type,
        eventPayload: execution.payload
      }, { client });
      storedEvents.push(transitioned.event);

      for (const event of preReplay) {
        storedEvents.push(await this._appendEvent(client, {
          ...event,
          ticketId: transitioned.run.ticketId,
          runId: id
        }));
      }

      const replayResult = await this.writeReplaySnapshot({
        runId: id,
        expectedRevision: replayRevision,
        snapshot: replaySnapshot,
        finalize: true,
        eventType: replay.type,
        eventPayload: replay.payload
      }, { client });
      storedEvents.push(replayResult.event);

      for (const event of preEvaluation) {
        storedEvents.push(await this._appendEvent(client, {
          ...event,
          ticketId: transitioned.run.ticketId,
          runId: id
        }));
      }

      const evaluationDocument = typeof evaluation === 'function'
        ? await evaluation({
            run: transitioned.run,
            replaySnapshot,
            events: storedEvents.slice()
          })
        : evaluation;
      const evaluationResult = await this.recordRunEvaluation({
        runId: id,
        evaluation: evaluationDocument
      }, { client });
      storedEvents.push(evaluationResult.event);
      const consequenceDocument = typeof consequence === 'function'
        ? await consequence({
            run: transitioned.run,
            replaySnapshot,
            events: storedEvents.slice(),
            evaluation: evaluationDocument
          })
        : consequence;
      const consequenceResult = await this.recordRunConsequence({
        runId: id,
        consequence: consequenceDocument
      }, { client });
      storedEvents.push(consequenceResult.event);
      const terminalizedEvent = await this._appendEvent(client, {
        ...terminal,
        ticketId: transitioned.run.ticketId,
        runId: id
      });
      storedEvents.push(terminalizedEvent);

      return {
        run: transitioned.run,
        replaySnapshot: replayResult.record,
        evaluation: evaluationDocument,
        consequence: consequenceDocument,
        events: storedEvents.filter(Boolean)
      };
    });
  }

  async repairRunTerminalization({
    runId,
    status,
    recoveryOwner = null,
    patch = {},
    replaySnapshot,
    beforeReplayEvents = [],
    replayEvent,
    beforeEvaluationEvents = [],
    evaluation,
    consequence,
    terminalEvent
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const target = requiredString(status, 'status');
    if (!TERMINAL_RUN_STATUSES.has(target)) throw new TypeError(`Unsupported terminal run status: ${target}`);
    const owner = recoveryOwner === undefined || recoveryOwner === null
      ? null
      : requiredString(recoveryOwner, 'recoveryOwner');
    const requestedPatch = this.assertJsonRecord(patch, 'patch');
    if (Object.prototype.hasOwnProperty.call(requestedPatch, 'currentPhase') &&
        normalizeRunPhase(requestedPatch.currentPhase, 'patch.currentPhase') !== 'terminalization') {
      throw new TypeError('Terminal runs must project terminalization phase');
    }
    const bodyPatch = { ...requestedPatch };
    delete bodyPatch.currentPhase;
    const requestedSnapshot = this.assertJsonRecord(replaySnapshot, 'replaySnapshot');
    if (!Array.isArray(beforeReplayEvents) || !Array.isArray(beforeEvaluationEvents)) {
      throw new TypeError('terminal repair event groups must be arrays');
    }
    const normalizeRepairEvent = (event, label) => {
      const source = this.assertJsonRecord(event, label);
      return {
        type: requiredString(source.type, `${label}.type`),
        ...(source.stepId === undefined || source.stepId === null ? {} : { stepId: String(source.stepId) }),
        payload: this.assertJsonRecord(source.payload || {}, `${label}.payload`)
      };
    };
    const preReplay = beforeReplayEvents.map((event, index) =>
      normalizeRepairEvent(event, `beforeReplayEvents[${index}]`));
    const replay = normalizeRepairEvent(replayEvent, 'replayEvent');
    const preEvaluation = beforeEvaluationEvents.map((event, index) =>
      normalizeRepairEvent(event, `beforeEvaluationEvents[${index}]`));
    const terminal = normalizeRepairEvent(terminalEvent, 'terminalEvent');
    const repairEventTypes = [...new Set([
      'run.execution_completed',
      'run.execution_failed',
      'run.postcondition_failed',
      'run.violation_detected',
      'runtime.violation_detected',
      'workspace.violation_detected',
      'workflow.step.failed',
      ...SINGULAR_TERMINAL_REPAIR_EVENT_TYPES,
      ...preReplay.map(event => event.type),
      ...preEvaluation.map(event => event.type),
      replay.type,
      terminal.type
    ])];
    return this.withTransaction(async client => {
      const failIntegrity = message => {
        const error = new Error(`Run ${id} terminal repair failed integrity validation: ${message}`);
        error.code = 'TERMINAL_REPAIR_INTEGRITY_FAILURE';
        return error;
      };
      const runResult = await client.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const initialRun = runFromRow(runResult.rows[0]);
      const eventResult = await client.query(
        `SELECT * FROM ${this.table('events')}
         WHERE run_id = $1 AND type = ANY($2::text[])
         ORDER BY seq`,
        [id, repairEventTypes]
      );
      const observedEvents = eventResult.rows.map(eventFromRow);
      for (const [label, types] of [
        ['postcondition summary', ['run.postconditions_checked']],
        ['verification verdict', ['run.verification_failed', 'run.verification_passed']],
        ['triage record', ['run.triage_created']],
        ['replay finalization', ['run.snapshot_finalized', 'replay.snapshot.finalized']],
        ['violation summary', ['run.violations_checked']],
        ['evaluation', ['run.evaluation_completed']],
        ['consequence', ['run.consequence_recorded']],
        ['terminal lifecycle', ['run.terminalized']]
      ]) {
        const matches = observedEvents.filter(event => types.includes(event.type));
        if (matches.length > 1) throw failIntegrity(`${label} evidence is duplicated or contradictory`);
      }
      const existingTerminalEvent = observedEvents.find(event => event.type === 'run.terminalized');
      if (existingTerminalEvent) {
        const evidenceStatus = existingTerminalEvent.payload && existingTerminalEvent.payload.status;
        if (initialRun.status !== target || (evidenceStatus && evidenceStatus !== target)) {
          throw failIntegrity(`terminal projection or lifecycle evidence conflicts with target ${target}`);
        }
        // A pg Client executes one query at a time. Keep this transaction's
        // reads sequential so the code remains valid when pg 9 removes queued
        // overlapping client.query calls.
        const replayResult = await client.query(
          `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`, [id]
        );
        const evaluationResult = await client.query(
          `SELECT * FROM ${this.table('run_evaluations')} WHERE run_id = $1`, [id]
        );
        const consequenceResult = await client.query(
          `SELECT * FROM ${this.table('run_consequences')} WHERE run_id = $1`, [id]
        );
        return {
          repaired: false,
          run: initialRun,
          replaySnapshot: replayResult.rowCount === 0 ? null : replaySnapshotFromRow(replayResult.rows[0]),
          evaluation: evaluationResult.rowCount === 0 ? null : evaluationFromRow(evaluationResult.rows[0]).evaluation,
          consequence: consequenceResult.rowCount === 0 ? null : consequenceFromRow(consequenceResult.rows[0]).consequence,
          events: []
        };
      }
      if (!observedEvents.some(event =>
        event.type === 'run.execution_completed' || event.type === 'run.execution_failed')) {
        throw failIntegrity('execution-completion evidence is missing');
      }
      if (TERMINAL_RUN_STATUSES.has(initialRun.status) && initialRun.status !== target) {
        throw failIntegrity(`stored status ${initialRun.status} conflicts with target ${target}`);
      }
      if (initialRun.status === 'running' && !owner) return null;
      if (initialRun.status !== 'running' && !TERMINAL_RUN_STATUSES.has(initialRun.status)) return null;

      let projectedResult;
      if (initialRun.status === 'running') {
        projectedResult = await client.query(
          `UPDATE ${this.table('runs')}
           SET status = $2,
               current_phase = 'terminalization',
               body = body || $3::jsonb,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               completed_at = COALESCE(completed_at, clock_timestamp()),
               updated_at = clock_timestamp(),
               revision = revision + 1
           WHERE id = $1
             AND lease_owner = $4
             AND lease_expires_at > clock_timestamp()
           RETURNING *`,
          [id, target, bodyPatch, owner]
        );
        if (projectedResult.rowCount === 0) return null;
      } else {
        projectedResult = await client.query(
          `UPDATE ${this.table('runs')}
           SET current_phase = 'terminalization',
               body = body || $2::jsonb,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               completed_at = COALESCE(completed_at, clock_timestamp()),
               updated_at = clock_timestamp(),
               revision = revision + 1
           WHERE id = $1 AND status = $3
           RETURNING *`,
          [id, bodyPatch, target]
        );
        if (projectedResult.rowCount === 0) return null;
      }
      const projectedRun = runFromRow(projectedResult.rows[0]);
      const storedEvents = [];
      const appendMissing = async event => {
        const duplicate = SINGULAR_TERMINAL_REPAIR_EVENT_TYPES.has(event.type)
          ? observedEvents.some(item => item.type === event.type)
          : observedEvents.some(item => item.type === event.type &&
            canonicalJson(item.payload || {}) === canonicalJson(event.payload));
        if (duplicate) return null;
        const stored = await this._appendEvent(client, {
          ...event,
          ticketId: projectedRun.ticketId,
          runId: id
        });
        observedEvents.push(stored);
        storedEvents.push(stored);
        return stored;
      };

      for (const event of preReplay) await appendMissing(event);

      const replayFinalizedEvent = observedEvents.some(event =>
        event.type === 'run.snapshot_finalized' || event.type === 'replay.snapshot.finalized');
      const currentReplayResult = await client.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      let effectiveReplay;
      if (replayFinalizedEvent) {
        if (currentReplayResult.rowCount !== 1 || currentReplayResult.rows[0].finalized_at === null) {
          throw failIntegrity('snapshot-finalized evidence does not match replay storage');
        }
        effectiveReplay = replaySnapshotFromRow(currentReplayResult.rows[0]);
        if (effectiveReplay.snapshot.terminalStatus && effectiveReplay.snapshot.terminalStatus !== target) {
          throw failIntegrity(
            `finalized replay status ${effectiveReplay.snapshot.terminalStatus} conflicts with target ${target}`
          );
        }
      } else {
        if (currentReplayResult.rowCount === 1 && currentReplayResult.rows[0].finalized_at !== null) {
          throw failIntegrity('a finalized replay is missing its lifecycle event');
        }
        const replayWrite = await this.writeReplaySnapshot({
          runId: id,
          expectedRevision: currentReplayResult.rowCount === 0
            ? null
            : positiveSafeInteger(currentReplayResult.rows[0].revision, 'replaySnapshot.revision'),
          snapshot: requestedSnapshot,
          finalize: true,
          eventType: replay.type,
          eventPayload: replay.payload
        }, { client });
        effectiveReplay = replayWrite.record;
        observedEvents.push(replayWrite.event);
        storedEvents.push(replayWrite.event);
      }

      for (const event of preEvaluation) await appendMissing(event);
      const projectedTerminalEvent = {
        ...terminal,
        ticketId: projectedRun.ticketId,
        runId: id
      };
      const contextEvents = [...observedEvents, projectedTerminalEvent];

      const evaluationEvent = observedEvents.find(event => event.type === 'run.evaluation_completed');
      const evaluationRow = await client.query(
        `SELECT * FROM ${this.table('run_evaluations')} WHERE run_id = $1`,
        [id]
      );
      if (Boolean(evaluationEvent) !== (evaluationRow.rowCount === 1)) {
        throw failIntegrity('evaluation storage and lifecycle evidence disagree');
      }
      let evaluationDocument;
      if (evaluationRow.rowCount === 1) {
        evaluationDocument = evaluationFromRow(evaluationRow.rows[0]).evaluation;
        const eventDocument = evaluationEvent.payload && evaluationEvent.payload.evaluation;
        if (canonicalJson(eventDocument) !== canonicalJson(evaluationDocument)) {
          throw failIntegrity('evaluation storage and lifecycle evidence disagree');
        }
      } else {
        evaluationDocument = typeof evaluation === 'function'
          ? await evaluation({
              run: projectedRun,
              replaySnapshot: effectiveReplay.snapshot,
              events: contextEvents
            })
          : evaluation;
        const recorded = await this.recordRunEvaluation({
          runId: id,
          evaluation: evaluationDocument
        }, { client });
        if (recorded.event) {
          observedEvents.push(recorded.event);
          storedEvents.push(recorded.event);
        }
      }

      const consequenceEvent = observedEvents.find(event => event.type === 'run.consequence_recorded');
      const consequenceRow = await client.query(
        `SELECT * FROM ${this.table('run_consequences')} WHERE run_id = $1`,
        [id]
      );
      if (Boolean(consequenceEvent) !== (consequenceRow.rowCount === 1)) {
        throw failIntegrity('consequence storage and lifecycle evidence disagree');
      }
      let consequenceDocument;
      if (consequenceRow.rowCount === 1) {
        consequenceDocument = consequenceFromRow(consequenceRow.rows[0]).consequence;
        const eventDocument = consequenceEvent.payload && consequenceEvent.payload.consequence;
        if (canonicalJson(eventDocument) !== canonicalJson(consequenceDocument)) {
          throw failIntegrity('consequence storage and lifecycle evidence disagree');
        }
      } else {
        consequenceDocument = typeof consequence === 'function'
          ? await consequence({
              run: projectedRun,
              replaySnapshot: effectiveReplay.snapshot,
              events: [...observedEvents, projectedTerminalEvent],
              evaluation: evaluationDocument
            })
          : consequence;
        const recorded = await this.recordRunConsequence({
          runId: id,
          consequence: consequenceDocument
        }, { client });
        if (recorded.event) {
          observedEvents.push(recorded.event);
          storedEvents.push(recorded.event);
        }
      }

      await appendMissing(terminal);
      return {
        repaired: true,
        run: projectedRun,
        replaySnapshot: effectiveReplay,
        evaluation: evaluationDocument,
        consequence: consequenceDocument,
        events: storedEvents
      };
    });
  }

  async getReplaySnapshot(runId) {
    const id = positiveSafeInteger(runId, 'runId');
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`,
      [id]
    );
    return result.rowCount === 0 ? null : replaySnapshotFromRow(result.rows[0]);
  }

  async initializeRunReplay({ runId, ticketId, snapshot }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const document = this.assertJsonRecord(snapshot, 'replay snapshot');
    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) return null;
      if (positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId') !== ownerTicketId) {
        throw new TypeError(`Run ${id} does not belong to ticket ${ownerTicketId}`);
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table('replay_snapshots')}
          (run_id, ticket_id, snapshot, snapshot_hash)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING *`,
        [id, ownerTicketId, document, sha256Json(document)]
      );
      if (inserted.rowCount === 1) {
        return { record: replaySnapshotFromRow(inserted.rows[0]), initialized: true };
      }
      const current = await connection.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1`,
        [id]
      );
      return current.rowCount === 0
        ? null
        : { record: replaySnapshotFromRow(current.rows[0]), initialized: false };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async readRunReplay(runId) {
    return this.getReplaySnapshot(runId);
  }

  async listRunReplays({ runIds, limit = this.maxQueryRows } = {}) {
    if (!Array.isArray(runIds)) throw new TypeError('runIds must be an array');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const ids = [...new Set(runIds.map((runId, index) => positiveSafeInteger(runId, `runIds[${index}]`)))];
    if (ids.length > boundedLimit) {
      throw new RangeError(`runIds exceeds the requested limit of ${boundedLimit}`);
    }
    if (ids.length === 0) return [];
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('replay_snapshots')}
       WHERE run_id = ANY($1::bigint[])
       ORDER BY run_id
       LIMIT $2`,
      [ids, boundedLimit]
    );
    return result.rows.map(replaySnapshotFromRow);
  }

  async updateRunReplay({ runId, update }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    if (typeof update !== 'function') throw new TypeError('update must be a function');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      if (result.rowCount === 0) return null;
      const current = replaySnapshotFromRow(result.rows[0]);
      const proposed = update(structuredClone(current.snapshot));
      if (proposed && typeof proposed.then === 'function') {
        throw new TypeError('update must return synchronously');
      }
      if (proposed === null || proposed === undefined) return { record: current, updated: false };
      const document = this.assertJsonRecord(proposed, 'replay snapshot');
      if (canonicalJson(document) === canonicalJson(current.snapshot)) {
        return { record: current, updated: false };
      }
      if (current.finalizedAt) throw new ImmutableEvidenceConflictError('finalized replay snapshot', id);
      const updated = await connection.query(
        `UPDATE ${this.table('replay_snapshots')}
         SET snapshot = $3::jsonb,
             snapshot_hash = $4,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE run_id = $1 AND revision = $2 AND finalized_at IS NULL
         RETURNING *`,
        [id, current.revision, document, sha256Json(document)]
      );
      if (updated.rowCount !== 1) {
        throw new OptimisticConcurrencyError('replay snapshot', id, current.revision, current);
      }
      return { record: replaySnapshotFromRow(updated.rows[0]), updated: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async recordOperationReceipt({
    runId,
    idempotencyKey,
    stepId = null,
    operation,
    outcome,
    receipt,
    workspacePath = null,
    artifactPath = null,
    mutationFingerprint = null,
    eventType = 'operation.receipt_recorded',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(idempotencyKey, 'idempotencyKey', 512);
    const normalizedStepId = optionalString(stepId);
    const operationName = requiredString(operation, 'operation');
    const normalizedOutcome = requiredString(outcome, 'outcome');
    if (!OPERATION_OUTCOMES.has(normalizedOutcome)) {
      throw new TypeError(`Unsupported operation receipt outcome: ${normalizedOutcome}`);
    }
    const document = this.assertJsonRecord(receipt, 'operation receipt');
    const type = eventType === null ? null : requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const targetId = optionalString(document.targetId);
    const targetKind = optionalString(document.targetKind);
    const targetPath = optionalString(document.targetPath);
    const targetResourceId = optionalString(document.targetResourceId);
    const normalizedWorkspacePath = workspacePath === null || workspacePath === undefined
      ? null
      : normalizeWorkspacePath(workspacePath);
    const normalizedArtifactPath = artifactPath === null || artifactPath === undefined
      ? null
      : normalizeWorkspacePath(artifactPath);
    const normalizedMutationFingerprint = mutationFingerprint === null || mutationFingerprint === undefined
      ? null
      : requiredString(mutationFingerprint, 'mutationFingerprint', 1024);
    if ((normalizedWorkspacePath === null) !== (normalizedMutationFingerprint === null) ||
        normalizedWorkspacePath === '' || normalizedArtifactPath === '') {
      throw new TypeError('Workspace receipt projections require a non-empty path and mutation fingerprint');
    }

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticketId = positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId');
      const inserted = await connection.query(
        `INSERT INTO ${this.table('operation_receipts')}
          (run_id, ticket_id, idempotency_key, step_id, operation, outcome,
           target_id, target_kind, target_path, target_resource_id, workspace_path,
           artifact_path, mutation_fingerprint, receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
         ON CONFLICT (run_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          ticketId,
          key,
          normalizedStepId,
          operationName,
          normalizedOutcome,
          targetId,
          targetKind,
          targetPath,
          targetResourceId,
          normalizedWorkspacePath,
          normalizedArtifactPath,
          normalizedMutationFingerprint,
          document
        ]
      );

      if (inserted.rowCount === 0) {
        const existingResult = await connection.query(
          `SELECT * FROM ${this.table('operation_receipts')}
           WHERE run_id = $1 AND idempotency_key = $2`,
          [id, key]
        );
        const existing = existingResult.rowCount === 0 ? null : operationReceiptFromRow(existingResult.rows[0]);
        const matches = existing &&
          existing.ticketId === ticketId &&
          existing.stepId === normalizedStepId &&
          existing.operation === operationName &&
          existing.outcome === normalizedOutcome &&
          existing.targetId === targetId &&
          existing.targetKind === targetKind &&
          existing.targetPath === targetPath &&
          existing.targetResourceId === targetResourceId &&
          existing.workspacePath === normalizedWorkspacePath &&
          existing.artifactPath === normalizedArtifactPath &&
          existing.mutationFingerprint === normalizedMutationFingerprint &&
          canonicalJson(existing.receipt) === canonicalJson(document);
        if (matches) return { record: existing, event: null, inserted: false };
        throw new IdempotencyConflictError(id, key);
      }

      const record = operationReceiptFromRow(inserted.rows[0]);
      const event = type === null ? null : await this._appendEvent(connection, {
        type,
        ticketId,
        runId: id,
        stepId: normalizedStepId,
        payload: {
          ...callerPayload,
          receiptId: record.id,
          idempotencyKey: record.idempotencyKey,
          operation: record.operation,
          outcome: record.outcome,
          receipt: record.receipt,
          recordedAt: record.recordedAt
        }
      });
      return { record, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async listOperationReceipts(runId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    return result.rows.map(operationReceiptFromRow);
  }

  async findMutationConflict({ runId, targetId, operation, args = {} } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const target = requiredString(targetId, 'targetId');
    const operationName = requiredString(operation, 'operation');
    const input = jsonObject(args, 'args');
    const workspacePath = normalizeWorkspacePath(input.path);
    const mutationFingerprint = workspaceMutationFingerprint(operationName, input);
    if (!workspacePath || !mutationFingerprint) return null;
    const connection = this.targetOperationClientStorage.getStore() || this.pool;
    const result = await connection.query(
      `SELECT *
       FROM ${this.table('operation_receipts')}
       WHERE run_id = $1
         AND target_id = $2
         AND workspace_path = $3
         AND mutation_fingerprint <> $4
         AND NOT ($5::text = 'renamePath' AND operation = ANY($6::text[]))
       ORDER BY id
       LIMIT 1`,
      [id, target, workspacePath, mutationFingerprint, operationName, ['writeFile', 'createFolder']]
    );
    return result.rowCount === 0 ? null : operationReceiptFromRow(result.rows[0]);
  }

  async listArtifactOwners({
    targetId,
    candidatePath,
    overlap = false,
    ticketId = null,
    excludeTicketId = null,
    afterId = 0,
    limit = 100
  } = {}) {
    const target = requiredString(targetId, 'targetId');
    const candidate = normalizeWorkspacePath(candidatePath);
    if (!candidate) throw new TypeError('candidatePath is required');
    if (typeof overlap !== 'boolean') throw new TypeError('overlap must be a boolean');
    const includeTicketId = nullablePositiveSafeInteger(ticketId, 'ticketId');
    const omittedTicketId = nullablePositiveSafeInteger(excludeTicketId, 'excludeTicketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const connection = this.targetOperationClientStorage.getStore() || this.pool;
    let result;
    if (overlap) {
      const ancestors = workspacePathAncestors(candidate);
      const descendantPattern = `${escapeLikePattern(candidate)}/%`;
      result = await connection.query(
        `SELECT *
         FROM ${this.table('operation_receipts')}
         WHERE target_id = $1
           AND outcome = 'succeeded'
           AND artifact_path IS NOT NULL
           AND (artifact_path = ANY($2::text[]) OR artifact_path LIKE $3 ESCAPE E'\\\\')
           AND ($4::bigint IS NULL OR ticket_id = $4)
           AND ($5::bigint IS NULL OR ticket_id <> $5)
           AND id > $6
         ORDER BY id
         LIMIT $7`,
        [target, ancestors, descendantPattern, includeTicketId, omittedTicketId, cursor, size]
      );
    } else {
      result = await connection.query(
        `SELECT *
         FROM ${this.table('operation_receipts')}
         WHERE target_id = $1
           AND outcome = 'succeeded'
           AND artifact_path = $2
           AND ($3::bigint IS NULL OR ticket_id = $3)
           AND ($4::bigint IS NULL OR ticket_id <> $4)
           AND id > $5
         ORDER BY id
         LIMIT $6`,
        [target, candidate, includeTicketId, omittedTicketId, cursor, size]
      );
    }
    const owners = result.rows.map(operationReceiptFromRow);
    return {
      owners,
      nextAfterId: owners.length === size ? owners[owners.length - 1].id : null
    };
  }

  async appendRunEvidence({
    runId,
    ticketId,
    evidenceKey,
    replayKey,
    replayItem,
    event
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(evidenceKey, 'evidenceKey', 512);
    const collection = requiredString(replayKey, 'replayKey');
    const item = { ...this.assertJsonRecord(replayItem, 'replayItem'), evidenceKey: key };
    const eventInput = this.assertJsonRecord(event, 'event');
    const eventType = requiredString(eventInput.type, 'event.type');
    const eventStepId = eventInput.stepId === undefined || eventInput.stepId === null
      ? null
      : String(eventInput.stepId);
    const eventPayload = {
      ...this.assertJsonRecord(eventInput.payload || {}, 'event.payload'),
      evidenceKey: key
    };

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      if (positiveSafeInteger(runResult.rows[0].ticket_id, 'run.ticketId') !== ownerTicketId) {
        throw new TypeError(`Run ${id} does not belong to ticket ${ownerTicketId}`);
      }
      const replayResult = await connection.query(
        `SELECT * FROM ${this.table('replay_snapshots')} WHERE run_id = $1 FOR UPDATE`,
        [id]
      );
      if (replayResult.rowCount === 0) throw new TypeError(`Run ${id} does not have a replay snapshot`);
      const currentReplay = replaySnapshotFromRow(replayResult.rows[0]);
      const snapshot = currentReplay.snapshot;
      const items = Array.isArray(snapshot[collection]) ? snapshot[collection] : [];
      const existingItem = items.find(candidate => candidate && candidate.evidenceKey === key) || null;
      if (existingItem && canonicalJson(existingItem) !== canonicalJson(item)) {
        throw new IdempotencyConflictError(id, key);
      }
      let storedReplay = currentReplay;
      if (!existingItem) {
        const document = this.assertJsonRecord(
          { ...snapshot, [collection]: [...items, item] },
          'replay snapshot'
        );
        const updated = await connection.query(
          `UPDATE ${this.table('replay_snapshots')}
           SET snapshot = $3::jsonb,
               snapshot_hash = $4,
               revision = revision + 1,
               updated_at = clock_timestamp()
           WHERE run_id = $1 AND revision = $2
           RETURNING *`,
          [id, currentReplay.revision, document, sha256Json(document)]
        );
        if (updated.rowCount !== 1) {
          throw new OptimisticConcurrencyError('replay snapshot', id, currentReplay.revision, currentReplay);
        }
        storedReplay = replaySnapshotFromRow(updated.rows[0]);
      }

      const existingEventResult = await connection.query(
        `SELECT * FROM ${this.table('events')}
         WHERE run_id = $1 AND payload->>'evidenceKey' = $2
         ORDER BY position
         LIMIT 1`,
        [id, key]
      );
      let storedEvent = existingEventResult.rowCount === 0 ? null : eventFromRow(existingEventResult.rows[0]);
      if (storedEvent) {
        if (storedEvent.type !== eventType || storedEvent.stepId !== eventStepId ||
            canonicalJson(storedEvent.payload) !== canonicalJson(eventPayload)) {
          throw new IdempotencyConflictError(id, key);
        }
      } else {
        storedEvent = await this._appendEvent(connection, {
          type: eventType,
          ticketId: ownerTicketId,
          runId: id,
          ...(eventStepId === null ? {} : { stepId: eventStepId }),
          payload: eventPayload
        });
      }
      return {
        replayItem: existingItem || item,
        replaySnapshot: storedReplay,
        event: storedEvent,
        inserted: !existingItem
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async completeActionReceipt({
    runId,
    ticketId,
    operationKey,
    stepId = null,
    operation,
    outcome,
    historyRecord,
    receipt,
    replayKey,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const operationName = requiredString(operation, 'operation');
    const normalizedOutcome = requiredString(outcome, 'outcome');
    const history = this.assertJsonRecord(historyRecord, 'historyRecord');
    const receiptDocument = this.assertJsonRecord(receipt, 'receipt');
    const replayDocument = this.assertJsonRecord(replayItem, 'replayItem');
    const eventDocument = this.assertJsonRecord(event, 'event');

    return this.withTransaction(async client => {
      const recorded = await this.recordOperationReceipt({
        runId: id,
        idempotencyKey: key,
        stepId,
        operation: operationName,
        outcome: normalizedOutcome,
        receipt: {
          ...history,
          readReceipt: receiptDocument
        },
        eventType: null
      }, { client });
      if (recorded.record.ticketId !== ownerTicketId) {
        throw new TypeError(`Run ${id} does not belong to ticket ${ownerTicketId}`);
      }
      const evidence = await this.appendRunEvidence({
        runId: id,
        ticketId: ownerTicketId,
        evidenceKey: `action-receipt:${key}:completed`,
        replayKey,
        replayItem: {
          ...replayDocument,
          historyId: recorded.record.id,
          operationKey: key
        },
        event: {
          ...eventDocument,
          payload: {
            ...this.assertJsonRecord(eventDocument.payload || {}, 'event.payload'),
            historyId: recorded.record.id,
            operationKey: key
          }
        }
      }, { client });
      return { record: recorded.record, evidence, inserted: recorded.inserted };
    });
  }

  async getTargetOperation(runId, operationKey, { client = null, forUpdate = false } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const connection = client || this.pool;
    const intentResult = await connection.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE run_id = $1 AND operation_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, key]
    );
    const receiptResult = await connection.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND idempotency_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
      [id, key]
    );
    const intent = intentResult.rowCount === 0 ? null : targetOperationIntentFromRow(intentResult.rows[0]);
    const receiptEnvelope = receiptResult.rowCount === 0 ? null : operationReceiptFromRow(receiptResult.rows[0]);
    return {
      intent,
      receipt: targetOperationReceiptProjection(receiptEnvelope, intent),
      receiptEnvelope
    };
  }

  async prepareTargetOperation({
    runId,
    ticketId,
    operationKey,
    stepId = null,
    leaseOwner,
    intent
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const document = this.assertJsonRecord(intent, 'intent');
    const operation = requiredString(document.operation, 'intent.operation');
    const target = document.target && typeof document.target === 'object' && !Array.isArray(document.target)
      ? document.target
      : {};
    const normalizedStepId = optionalString(stepId);
    const owner = requiredString(leaseOwner, 'leaseOwner');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT *, lease_expires_at > clock_timestamp() AS lease_live
         FROM ${this.table('runs')}
         WHERE id = $1
         FOR UPDATE`,
        [id]
      );
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const runRow = runResult.rows[0];
      const liveLease = runRow.status === 'running' && runRow.lease_owner === owner && runRow.lease_live === true;
      if (positiveSafeInteger(runRow.ticket_id, 'run.ticketId') !== ownerTicketId || !liveLease) {
        throw new LeaseAuthorityError(id, owner, runFromRow(runRow));
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table('target_operation_intents')}
          (run_id, ticket_id, operation_key, step_id, operation,
           target_id, target_kind, target_path, target_resource_id, intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (run_id, operation_key) DO NOTHING
         RETURNING *`,
        [
          id,
          ownerTicketId,
          key,
          normalizedStepId,
          operation,
          optionalString(target.targetId),
          optionalString(target.targetKind),
          optionalString(target.targetPath),
          optionalString(target.targetResourceId),
          document
        ]
      );
      if (inserted.rowCount === 0) {
        const current = await this.getTargetOperation(id, key, { client: connection, forUpdate: true });
        if (current.intent && current.intent.ticketId === ownerTicketId &&
            current.intent.stepId === normalizedStepId && current.intent.operation === operation &&
            canonicalJson(current.intent.intent) === canonicalJson(document)) {
          return { intent: current.intent, receipt: current.receipt, event: null, inserted: false };
        }
        throw new IdempotencyConflictError(id, key);
      }
      const record = targetOperationIntentFromRow(inserted.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'workspace.operation_prepared',
        ticketId: ownerTicketId,
        runId: id,
        ...(normalizedStepId === null ? {} : { stepId: normalizedStepId }),
        payload: { operationKey: key, intent: document }
      });
      return { intent: record, receipt: null, event, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async completeTargetOperation({
    runId,
    ticketId,
    operationKey,
    historyRecord,
    receipt,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const history = this.assertJsonRecord(historyRecord, 'historyRecord');
    const receiptDocument = this.assertJsonRecord(receipt, 'receipt');
    const proposedReplayItem = this.assertJsonRecord(replayItem, 'replayItem');
    const proposedEvent = this.assertJsonRecord(event, 'event');

    return this.withTransaction(async client => {
      const current = await this.getTargetOperation(id, key, { client, forUpdate: true });
      if (!current.intent) throw new TypeError(`Target operation ${key} was not prepared`);
      if (current.intent.ticketId !== ownerTicketId) throw new IdempotencyConflictError(id, key);
      const outcome = history.outcome === 'failed' || history.outcome === 'refused'
        ? history.outcome
        : 'succeeded';
      const intentArgs = current.intent.intent && current.intent.intent.args
        ? current.intent.intent.args
        : {};
      const workspacePath = normalizeWorkspacePath(intentArgs.path);
      const artifactPath = outcome === 'succeeded'
        ? workspaceArtifactPath(current.intent.operation, intentArgs)
        : null;
      const mutationFingerprint = workspaceMutationFingerprint(current.intent.operation, intentArgs);
      const recorded = await this.recordOperationReceipt({
        runId: id,
        idempotencyKey: key,
        stepId: current.intent.stepId,
        operation: current.intent.operation,
        outcome,
        receipt: receiptDocument,
        workspacePath,
        artifactPath,
        mutationFingerprint,
        eventType: null
      }, { client });
      if (!recorded.inserted) return { record: recorded.record, evidence: null, inserted: false };
      const evidence = await this.appendRunEvidence({
        runId: id,
        ticketId: ownerTicketId,
        evidenceKey: `target-operation:${key}:completed`,
        replayKey: 'workspaceOperations',
        replayItem: {
          ...proposedReplayItem,
          historyId: recorded.record.id,
          operationKey: key,
          mutationReceipt: recorded.record.receipt
        },
        event: {
          ...proposedEvent,
          payload: {
            ...this.assertJsonRecord(proposedEvent.payload || {}, 'event.payload'),
            historyId: recorded.record.id,
            operationKey: key,
            mutationReceipt: recorded.record.receipt
          }
        }
      }, { client });
      return { record: recorded.record, evidence, inserted: recorded.inserted };
    });
  }

  async getOperatorRecovery(originalHistoryId, { client = null, forUpdate = false } = {}) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const connection = client || this.pool;
    const lock = forUpdate ? ' FOR UPDATE' : '';
    const originalResult = await connection.query(
      `SELECT * FROM ${this.table('operation_receipts')} WHERE id = $1${lock}`,
      [id]
    );
    if (originalResult.rowCount === 0) {
      return { original: null, intent: null, intentRecord: null, receipt: null, receiptEnvelope: null, completionEvent: null };
    }
    const originalEnvelope = operationReceiptFromRow(originalResult.rows[0]);
    const targetIntentResult = await connection.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE run_id = $1 AND operation_key = $2${lock}`,
      [originalEnvelope.runId, originalEnvelope.idempotencyKey]
    );
    const targetIntent = targetIntentResult.rowCount === 0
      ? null
      : targetOperationIntentFromRow(targetIntentResult.rows[0]);
    const original = targetIntent
      ? targetOperationReceiptProjection(originalEnvelope, targetIntent)
      : actionOperationReceiptProjection(originalEnvelope);
    const intentResult = await connection.query(
      `SELECT * FROM ${this.table('operator_recovery_intents')}
       WHERE original_operation_receipt_id = $1${lock}`,
      [id]
    );
    const intentRecord = intentResult.rowCount === 0
      ? null
      : operatorRecoveryIntentFromRow(intentResult.rows[0]);
    if (!intentRecord) {
      return { original, intent: null, intentRecord: null, receipt: null, receiptEnvelope: null, completionEvent: null };
    }
    const receiptResult = await connection.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND idempotency_key = $2${lock}`,
      [intentRecord.runId, intentRecord.recoveryKey]
    );
    const completionEventResult = await connection.query(
      `SELECT * FROM ${this.table('events')}
       WHERE run_id = $1 AND payload->>'evidenceKey' = $2
       ORDER BY position
       LIMIT 1`,
      [intentRecord.runId, `operator-recovery:${id}:completed`]
    );
    const receiptEnvelope = receiptResult.rowCount === 0
      ? null
      : operationReceiptFromRow(receiptResult.rows[0]);
    return {
      original,
      intent: intentRecord.intent,
      intentRecord,
      receipt: operatorRecoveryReceiptProjection(receiptEnvelope, intentRecord),
      receiptEnvelope,
      completionEvent: completionEventResult.rowCount === 0 ? null : eventFromRow(completionEventResult.rows[0])
    };
  }

  async prepareOperatorRecovery({ originalHistoryId, recoveryKey, intent }, { client = null } = {}) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const key = requiredString(recoveryKey, 'recoveryKey', 512);
    const document = this.assertJsonRecord(intent, 'intent');
    const requestedBy = requiredString(document.requestedBy, 'intent.requestedBy');
    const operation = requiredString(document.operation, 'intent.operation');
    if (!['writeFile', 'renamePath', 'deletePath'].includes(operation)) {
      throw new TypeError(`Unsupported operator recovery operation: ${operation}`);
    }
    const target = this.assertJsonRecord(document.target, 'intent.target');
    const targetId = requiredString(target.targetId, 'intent.target.targetId');
    const targetPath = requiredString(target.targetPath, 'intent.target.targetPath');

    const execute = async connection => {
      const current = await this.getOperatorRecovery(id, { client: connection, forUpdate: true });
      if (!current.original) {
        const error = new Error(`operation receipt ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      if (current.receipt) return { ...current, inserted: false, event: null };
      if (current.intentRecord) {
        if (current.intentRecord.recoveryKey === key &&
            canonicalJson(current.intentRecord.intent) === canonicalJson(document)) {
          return { ...current, inserted: false, event: null };
        }
        throw new IdempotencyConflictError(current.original.runId, key);
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table('operator_recovery_intents')}
          (original_operation_receipt_id, run_id, ticket_id, recovery_key, requested_by,
           operation, target_id, target_kind, target_path, target_resource_id, intent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          id,
          current.original.runId,
          current.original.ticketId,
          key,
          requestedBy,
          operation,
          targetId,
          optionalString(target.targetKind),
          targetPath,
          optionalString(target.targetResourceId),
          document
        ]
      );
      if (inserted.rowCount === 0) {
        const raced = await this.getOperatorRecovery(id, { client: connection, forUpdate: true });
        if (raced.intentRecord && raced.intentRecord.recoveryKey === key &&
            canonicalJson(raced.intentRecord.intent) === canonicalJson(document)) {
          return { ...raced, inserted: false, event: null };
        }
        throw new IdempotencyConflictError(current.original.runId, key);
      }
      const intentRecord = operatorRecoveryIntentFromRow(inserted.rows[0]);
      const event = await this._appendEvent(connection, {
        type: 'workspace.recovery_prepared',
        ticketId: intentRecord.ticketId,
        runId: intentRecord.runId,
        ...(current.original.step === null || current.original.step === undefined
          ? {}
          : { stepId: String(current.original.step) }),
        payload: { originalHistoryId: id, recoveryKey: key, intent: document }
      });
      return {
        original: current.original,
        intent: intentRecord.intent,
        intentRecord,
        receipt: null,
        receiptEnvelope: null,
        inserted: true,
        event
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async completeOperatorRecovery({
    originalHistoryId,
    recoveryKey,
    historyRecord,
    receipt,
    replayItem,
    event
  }) {
    const id = positiveSafeInteger(originalHistoryId, 'originalHistoryId');
    const key = requiredString(recoveryKey, 'recoveryKey', 512);
    const history = this.assertJsonRecord(historyRecord, 'historyRecord');
    const receiptDocument = this.assertJsonRecord(receipt, 'receipt');
    const replayDocument = this.assertJsonRecord(replayItem, 'replayItem');
    const eventDocument = this.assertJsonRecord(event, 'event');

    return this.withTransaction(async client => {
      const current = await this.getOperatorRecovery(id, { client, forUpdate: true });
      if (!current.intentRecord) throw new TypeError(`Operator recovery ${key} was not prepared`);
      if (current.intentRecord.recoveryKey !== key) {
        throw new IdempotencyConflictError(current.intentRecord.runId, key);
      }
      const outcome = history.outcome === 'failed' || history.outcome === 'refused'
        ? history.outcome
        : 'succeeded';
      const args = current.intent.args && typeof current.intent.args === 'object' ? current.intent.args : {};
      const workspacePath = normalizeWorkspacePath(args.path);
      const artifactPath = outcome === 'succeeded'
        ? workspaceArtifactPath(current.intentRecord.operation, args)
        : null;
      const mutationFingerprint = workspaceMutationFingerprint(current.intentRecord.operation, args);
      const recorded = await this.recordOperationReceipt({
        runId: current.intentRecord.runId,
        idempotencyKey: key,
        stepId: current.original.step,
        operation: current.intentRecord.operation,
        outcome,
        receipt: {
          ...history,
          ...receiptDocument,
          isRecovery: true,
          recoveredHistoryId: id
        },
        workspacePath,
        artifactPath,
        mutationFingerprint,
        eventType: null
      }, { client });
      const recoveryRecord = operatorRecoveryReceiptProjection(recorded.record, current.intentRecord);
      const evidence = await this.appendRunEvidence({
        runId: current.intentRecord.runId,
        ticketId: current.intentRecord.ticketId,
        evidenceKey: `operator-recovery:${id}:completed`,
        replayKey: 'workspaceOperations',
        replayItem: {
          ...replayDocument,
          historyId: recoveryRecord.id,
          operationKey: key,
          recoveredHistoryId: id,
          mutationReceipt: recorded.record.receipt
        },
        event: {
          ...eventDocument,
          payload: {
            ...this.assertJsonRecord(eventDocument.payload || {}, 'event.payload'),
            historyId: recoveryRecord.id,
            operationKey: key,
            recoveredHistoryId: id,
            mutationReceipt: recorded.record.receipt
          }
        }
      }, { client });
      return { record: recoveryRecord, evidence, inserted: recorded.inserted };
    });
  }

  async withOperatorRecoveryLock(options, operation) {
    return this.withTargetOperationLock(options, operation);
  }

  async withTargetOperationLock({ targetId, paths }, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const requests = buildWorkspaceLockRequests(targetId, paths);
    const client = await this.pool.connect();
    const acquired = [];
    try {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [`${this.lockTimeoutMs}ms`]);
      for (const request of requests) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_lock' : 'pg_advisory_lock_shared';
        await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]);
        acquired.push(request);
      }
      return await this.targetOperationClientStorage.run(client, () => operation(requests));
    } finally {
      for (const request of acquired.reverse()) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_unlock' : 'pg_advisory_unlock_shared';
        try { await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]); } catch (_) {}
      }
      try { await client.query("SELECT set_config('lock_timeout', '0', false)"); } catch (_) {}
      client.release();
    }
  }

  async claimPendingRun({ leaseOwner, leaseDurationMs, eligibleRunIds = null, claimPayload = {} }) {
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const eligible = eligibleRunIds === null
      ? null
      : eligibleRunIds.map((id, index) => positiveSafeInteger(id, `eligibleRunIds[${index}]`));
    if (eligible && eligible.length > this.maxEligibleRunIds) {
      throw new RangeError(`eligibleRunIds exceeds the configured limit of ${this.maxEligibleRunIds}`);
    }

    return this.withTransaction(async client => {
      // Serialize only the deployment-wide admission decision. The lease is
      // committed immediately and execution remains concurrent across workers.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('ticket-system:run-admission', 0))`
      );
      const result = await client.query(
        `WITH policy AS (
           SELECT
             COALESCE(max_active_runs, $4::bigint) AS max_active_runs,
             COALESCE(local_model_concurrency, $5::bigint) AS local_model_concurrency
           FROM ${this.table('runtime_limit_config')}
           WHERE id = 1
         ), active AS (
           SELECT
             COUNT(*)::bigint AS total,
             COUNT(*) FILTER (WHERE agent.provider = 'ollama')::bigint AS local_model
           FROM ${this.table('runs')} AS active_run
           JOIN ${this.table('configured_agents')} AS agent ON agent.id = active_run.agent_id
           WHERE active_run.status IN ('pending', 'running')
             AND active_run.lease_owner IS NOT NULL
             AND active_run.lease_expires_at > clock_timestamp()
         ), candidate AS (
           SELECT pending_run.id
           FROM ${this.table('runs')} AS pending_run
           JOIN ${this.table('configured_agents')} AS agent ON agent.id = pending_run.agent_id
           CROSS JOIN policy
           CROSS JOIN active
           WHERE pending_run.status = 'pending'
             AND (pending_run.lease_owner IS NULL OR pending_run.lease_expires_at <= clock_timestamp())
             AND ($3::bigint[] IS NULL OR pending_run.id = ANY($3::bigint[]))
             AND active.total < policy.max_active_runs
             AND (agent.provider <> 'ollama' OR active.local_model < policy.local_model_concurrency)
           ORDER BY pending_run.created_at, pending_run.id
           FOR UPDATE OF pending_run SKIP LOCKED
           LIMIT 1
         )
         UPDATE ${this.table('runs')} AS run
         SET lease_owner = $1,
             lease_expires_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = run.revision + 1,
             updated_at = clock_timestamp()
         FROM candidate
         WHERE run.id = candidate.id
         RETURNING run.*`,
        [owner, duration, eligible, this.defaultMaxActiveRuns, this.defaultLocalModelConcurrency]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const callerPayload = typeof claimPayload === 'function'
        ? this.assertJsonRecord(claimPayload(run), 'claimPayload')
        : this.assertJsonRecord(claimPayload, 'claimPayload');
      const event = await this._appendEvent(client, {
        type: 'run.lease_acquired',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async startClaimedRun({ runId, leaseOwner, leaseDurationMs, eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');

    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')} AS run
         SET status = 'running',
             started_at = COALESCE(run.started_at, clock_timestamp()),
             lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = run.revision + 1,
             updated_at = clock_timestamp()
         WHERE run.id = $1
           AND run.status = 'pending'
           AND run.lease_owner = $2
           AND run.lease_expires_at > clock_timestamp()
         RETURNING run.*`,
        [id, owner, duration]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const callerPayload = typeof eventPayload === 'function'
        ? this.assertJsonRecord(eventPayload(run), 'eventPayload')
        : this.assertJsonRecord(eventPayload, 'eventPayload');
      const event = await this._appendEvent(client, {
        type: 'run.started',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousStatus: 'pending',
          status: run.status,
          revision: run.revision,
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event, previousStatus: 'pending' };
    });
  }

  async heartbeatRunLease({ runId, leaseOwner, leaseDurationMs, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');

    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND status = ANY($4::text[])
           AND lease_owner = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, duration, ['pending', 'running']]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'run.heartbeat',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...jsonObject(payload, 'heartbeat payload'),
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async releaseRunLease({ runId, leaseOwner, payload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = String(leaseOwner || '').trim();
    if (!owner) throw new TypeError('leaseOwner is required');
    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET lease_owner = NULL,
             lease_expires_at = NULL,
             last_heartbeat_at = NULL,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND lease_owner = $2 AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'run.lease_released',
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...jsonObject(payload, 'release payload'),
          leaseOwner: owner,
          releasedAt: run.updatedAt
        }
      });
      return { run, event };
    });
  }

  async persistRunWorkflowStep({
    runId,
    leaseOwner,
    leaseDurationMs,
    stepId = null,
    action = null,
    status = 'started',
    payload = {}
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    const owner = requiredString(leaseOwner, 'leaseOwner');
    const duration = positiveSafeInteger(leaseDurationMs, 'leaseDurationMs');
    const normalizedStepId = optionalString(stepId);
    const normalizedAction = optionalString(action);
    const normalizedStatus = requiredString(status, 'status');
    const callerPayload = this.assertJsonRecord(payload, 'workflow step payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `UPDATE ${this.table('runs')}
         SET body = body || $4::jsonb,
             lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             last_heartbeat_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND status = 'running'
           AND lease_owner = $2
           AND lease_expires_at > clock_timestamp()
         RETURNING *`,
        [id, owner, duration, {
          currentStepId: normalizedStepId,
          currentWorkflowAction: normalizedAction
        }]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const event = await this._appendEvent(client, {
        type: 'workflow.step.persisted',
        ticketId: run.ticketId,
        runId: run.id,
        stepId: normalizedStepId,
        payload: {
          ...callerPayload,
          status: normalizedStatus,
          action: normalizedAction,
          leaseOwner: run.leaseOwner,
          leaseExpiresAt: run.leaseExpiresAt,
          lastHeartbeatAt: run.lastHeartbeatAt
        }
      });
      return { run, event };
    });
  }

  async recoverExpiredRun({ runId, eventType = 'run.resumed', eventPayload = {} }) {
    const id = positiveSafeInteger(runId, 'runId');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'recovery event payload');

    return this.withTransaction(async client => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, lease_owner, lease_expires_at, last_heartbeat_at
           FROM ${this.table('runs')}
           WHERE id = $1
             AND status = 'running'
             AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
           FOR UPDATE
         ), updated AS (
           UPDATE ${this.table('runs')} AS run
           SET status = 'pending',
               started_at = NULL,
               completed_at = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_heartbeat_at = NULL,
               revision = run.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE run.id = candidate.id
           RETURNING run.*, candidate.lease_owner AS previous_lease_owner,
             candidate.lease_expires_at AS previous_lease_expires_at,
             candidate.last_heartbeat_at AS previous_last_heartbeat_at
         )
         SELECT * FROM updated`,
        [id]
      );
      if (result.rowCount === 0) return null;
      const run = runFromRow(result.rows[0]);
      const previousLease = {
        leaseOwner: result.rows[0].previous_lease_owner,
        leaseExpiresAt: rowTimestamp(result.rows[0].previous_lease_expires_at),
        lastHeartbeatAt: rowTimestamp(result.rows[0].previous_last_heartbeat_at)
      };
      const event = await this._appendEvent(client, {
        type,
        ticketId: run.ticketId,
        runId: run.id,
        payload: {
          ...callerPayload,
          previousLease,
          recoveredAt: run.updatedAt,
          status: run.status
        }
      });
      return { run, event, previousLease };
    });
  }

  async withWorkspaceMutationLocks({ targetId, paths }, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const requests = buildWorkspaceLockRequests(targetId, paths);
    return this.withTransaction(async client => {
      await client.query("SELECT set_config('lock_timeout', $1, true)", [`${this.lockTimeoutMs}ms`]);
      for (const request of requests) {
        const fn = request.mode === 'exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
        await client.query(`SELECT ${fn}(hashtextextended($1, 0))`, [request.resource]);
      }
      return operation(client, requests);
    });
  }

  async listRunEvents(runId, { afterSeq = -1, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = Number(afterSeq);
    if (!Number.isSafeInteger(cursor) || cursor < -1) {
      throw new TypeError('afterSeq must be a safe integer greater than or equal to -1');
    }
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('events')}
       WHERE run_id = $1 AND seq > $2
       ORDER BY seq
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    return result.rows.map(eventFromRow);
  }

  async listRunTimelineEvents(runId, { afterPosition = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterPosition, 'afterPosition');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT event.*
       FROM ${this.table('events')} AS event
       JOIN ${this.table('runs')} AS run ON run.id = $1
       WHERE event.position > $2
         AND (
           event.run_id = run.id
           OR (event.run_id IS NULL AND event.ticket_id = run.ticket_id)
         )
       ORDER BY event.position
       LIMIT $3`,
      [id, cursor, boundedLimit + 1]
    );
    const pageRows = result.rows.slice(0, boundedLimit);
    const last = pageRows[pageRows.length - 1] || null;
    return {
      events: pageRows.map(eventFromRow),
      nextPosition: result.rows.length > boundedLimit && last
        ? positiveSafeInteger(last.position, 'event.position')
        : null
    };
  }

  async listTicketEvents(ticketId, { afterPosition = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterPosition, 'afterPosition');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('events')}
       WHERE ticket_id = $1 AND position > $2
       ORDER BY position
       LIMIT $3`,
      [id, cursor, boundedLimit + 1]
    );
    const pageRows = result.rows.slice(0, boundedLimit);
    const last = pageRows[pageRows.length - 1] || null;
    return {
      events: pageRows.map(eventFromRow),
      nextPosition: result.rows.length > boundedLimit && last
        ? positiveSafeInteger(last.position, 'event.position')
        : null
    };
  }

  async listRunOperations(runId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const receiptResult = await this.pool.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    const receipts = receiptResult.rows.map(operationReceiptFromRow);
    if (receipts.length === 0) return [];
    const keys = receipts.map(receipt => receipt.idempotencyKey);
    const intentResult = await this.pool.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE run_id = $1 AND operation_key = ANY($2::text[])`,
      [id, keys]
    );
    const intentsByKey = new Map(intentResult.rows.map(row => {
      const record = targetOperationIntentFromRow(row);
      return [record.operationKey, record];
    }));
    return receipts.map(receipt => {
      const intent = intentsByKey.get(receipt.idempotencyKey) || null;
      return intent
        ? targetOperationReceiptProjection(receipt, intent)
        : actionOperationReceiptProjection(receipt);
    });
  }

  async listTicketOperations(ticketId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const receiptResult = await this.pool.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE ticket_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    const receipts = receiptResult.rows.map(operationReceiptFromRow);
    if (receipts.length === 0) return [];
    const keys = [...new Set(receipts.map(receipt => receipt.idempotencyKey))];
    const intentResult = await this.pool.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE ticket_id = $1 AND operation_key = ANY($2::text[])`,
      [id, keys]
    );
    const intentsByKey = new Map(intentResult.rows.map(row => {
      const record = targetOperationIntentFromRow(row);
      return [`${record.runId}:${record.operationKey}`, record];
    }));
    return receipts.map(receipt => {
      const intent = intentsByKey.get(`${receipt.runId}:${receipt.idempotencyKey}`) || null;
      return intent
        ? targetOperationReceiptProjection(receipt, intent)
        : actionOperationReceiptProjection(receipt);
    });
  }

  async countRunMutations({ runIds } = {}) {
    const ids = boundedPositiveIds(runIds, this.maxQueryRows, 'runIds');
    const result = await this.pool.query(
      `SELECT run_id, COUNT(*)::bigint AS count
       FROM ${this.table('operation_receipts')}
       WHERE run_id = ANY($1::bigint[])
         AND outcome = 'succeeded'
         AND (
           operation IN ('writeFile', 'renamePath')
           OR (
             operation = 'createFolder'
             AND COALESCE(receipt #>> '{providerResponse,status}', receipt #>> '{result,status}') = 'created'
           )
           OR (
             operation = 'deletePath'
             AND COALESCE(receipt #>> '{providerResponse,status}', receipt #>> '{result,status}') = 'deleted'
           )
         )
       GROUP BY run_id`,
      [ids]
    );
    const counts = new Map(result.rows.map(row => {
      const count = Number(row.count);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('mutation count exceeds safe integer range');
      return [positiveSafeInteger(row.run_id, 'mutationCount.runId'), count];
    }));
    return ids.map(runId => ({ runId, count: counts.get(runId) || 0 }));
  }

  async listEventJournal({ limit = 100, typePrefix = null, ticketId = null, runId = null } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    const ticket = nullablePositiveSafeInteger(ticketId, 'ticketId');
    const run = nullablePositiveSafeInteger(runId, 'runId');
    const prefix = optionalString(typePrefix);
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('events')}
       WHERE ($2::text IS NULL OR type LIKE $2 || '%')
         AND ($3::bigint IS NULL OR ticket_id = $3)
         AND ($4::bigint IS NULL OR run_id = $4)
       ORDER BY position DESC LIMIT $1`,
      [boundedLimit + 1, prefix, ticket, run]
    );
    return {
      events: result.rows.slice(0, boundedLimit).reverse().map(eventFromRow),
      truncated: result.rowCount > boundedLimit
    };
  }

  async listRecentEvents(limit = 100) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT * FROM ${this.table('events')} ORDER BY position DESC LIMIT $1
       ) recent ORDER BY position`,
      [boundedLimit]
    );
    return result.rows.map(eventFromRow);
  }
}

installAccessCatalogMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });
installWorkflowCatalogMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });
installModelRoutingPolicyMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });
installConnectorAuthorityMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });
installWatcherAuthorityMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });
installRuntimeLimitsMethods(PostgresRuntimeStore);
installApplicationStateMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });

module.exports = {
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeIntegrityError,
  PostgresRuntimeStore,
  RunPhaseConflictError,
  StateTransitionConflictError,
  TriageConflictError,
  buildEventEnvelope,
  buildWorkspaceLockRequests,
  canonicalJson,
  normalizeWorkspacePath,
  quoteIdentifier,
  sha256Json
};
