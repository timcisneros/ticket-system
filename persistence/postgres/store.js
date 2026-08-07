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
  normalizeRuntimeBudgetSnapshot
} = require('../../runtime/runtime-budget-contract');
const {
  assertDeclaredWorkCompletionAuthorityBinding,
  hashCanonical,
  normalizeDeclaredWorkSnapshot
} = require('../../runtime/declared-work-contract');
const {
  assertParentDeclaredWorkObjectiveMatchesTicket,
  evaluateStructuredAllocationCurrentApplicability,
  materializeStructuredAllocationAuthority,
  normalizeStructuredAllocationAuthority,
  normalizeStructuredAllocationAuthorityDraft,
  ticketAssignmentMatchesPlanningAuthority
} = require('../../runtime/structured-allocation-prerequisites-contract');
const {
  advancePlanningAttempt,
  assertAdmissionBinding,
  buildPlanningProvenance,
  evaluatePlannerInvocationReadiness,
  normalizePlanningAttempt
} = require('../../runtime/structured-allocation-planning-contract');
const {
  ALLOCATION_PLAN_VERSION,
  createAllocationPlanV2StorageBody,
  materializeAllocationPlanV2Draft,
  normalizeAllocationPlanV2,
  serializeAllocationPlanV2StorageBody
} = require('../../runtime/allocation-plan-contract');
const {
  assertLeafBindingSetComplete,
  buildAggregatePlanDecision,
  buildLeafDeclaredWorkSnapshot,
  buildLeafRunBinding,
  deriveLeafItemDisposition,
  evaluateRunCompletionEvidence,
  normalizeAggregatePlanDecision,
  normalizeLeafRunBinding,
  refuseLeafAdmission
} = require('../../runtime/structured-allocation-leaf-run-contract');
const {
  normalizeCompletionAuthoritySnapshot,
  normalizeCompletionDecision,
  completionEvidenceProjection
} = require('../../runtime/completion-decision-contract');
const {
  normalizeEconomicAuthority,
  normalizeEconomicPolicy
} = require('../../runtime/economic-authority-contract');
const {
  governedRequestBytes,
  hashSerializedRequest,
  normalizeGovernedProviderRequest
} = require('../../runtime/governed-provider-request-contract');
const {
  evaluateGovernedRunProgress
} = require('../../runtime/governed-progress-evaluation');
const {
  projectRunVerifiedProgress,
  projectTicketVerifiedProgress
} = require('../../runtime/verified-progress-projection');
const { deepFreeze } = require('../../runtime/declared-work-contract');
const {
  assertGovernedRunHasEligibleFacts,
  eligibleExecutionFacts
} = require('../../runtime/governed-eligible-facts');
const {
  buildGovernedSatisfiedFactTransitions
} = require('../../runtime/governed-fact-transitions');
const {
  assertEvidenceAgrees,
  normalizeGovernedPostconditionEvidence,
  satisfiedFactIdentitiesByBatch
} = require('../../runtime/governed-postcondition-evidence-contract');
const {
  assertBlockAuthorityMatches,
  buildGovernedProgressBlock,
  normalizeGovernedProgressBlock
} = require('../../runtime/governed-progress-block-contract');
const {
  permitsGovernedRequest
} = require('../../runtime/churn-decision-contract');
const {
  isPathInsideOwnedOutputPaths,
  normalizeWorkspaceOwnershipPath,
  normalizeWorkspaceRelativePath
} = require('../../runtime/authority-paths');
const {
  assertRunGovernedExecutionPairing,
  buildGovernedRunAuthority,
  classifyRunGovernance,
  normalizeGovernedRunAuthority
} = require('../../runtime/governed-run-authority-contract');
const {
  buildRoleRoutingDecision
} = require('../../runtime/role-routing-contract');
const {
  buildEconomicAuthority
} = require('../../runtime/economic-authority-contract');
const {
  findPricingEntry
} = require('../../runtime/model-pricing-catalog');
const {
  prepareGovernedProviderRequest
} = require('../../runtime/governed-provider-request-contract');
const {
  assertReceiptMatchesPreparedRequest,
  buildSettlementReceiptFromCapturedBasis,
  normalizeSettlementReceipt
} = require('../../runtime/economic-settlement-receipt-contract');
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
const { installRuntimeBudgetMethods } = require('./runtime-budget-methods');
const {
  allocationPlanFromRow,
  installApplicationStateMethods
} = require('./application-state-methods');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE_PATTERN = /^[0-9]{3}_[a-z0-9_]+\.sql$/;
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const TICKET_STATUSES = new Set(['open', 'in_progress', 'completed', 'failed', 'blocked', 'closed']);
const RUN_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'interrupted']);
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
// The parent Ticket outcomes that END execution. `open` is deliberately absent:
// returning an interrupted owned-scope ticket to `open` is recovery, not
// terminalization, and must stay reachable without a leaf completion proof.
const TERMINAL_TICKET_STATUSES = new Set(['completed', 'failed', 'blocked']);
const RUN_RECOVERY_MODES = new Set(['lease_expiry', 'process_restart']);
const OPERATION_OUTCOMES = new Set(['succeeded', 'failed', 'refused']);
const PROCESS_OPERATION_STATES = new Set(['intent', 'active', 'finalizing', 'terminal']);
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
  'run.completion_decided',
  'run.terminalized'
]);
const RUN_STATUS_TRANSITIONS = new Map([
  ['pending', new Set(['pending', 'running', 'failed', 'interrupted'])],
  ['running', new Set(['running', 'pending', 'completed', 'failed', 'interrupted'])],
  ['completed', new Set()],
  ['failed', new Set()],
  ['interrupted', new Set()]
]);

function migrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(name => name.endsWith('.sql'))
    .sort();
  if (files.length === 0 ||
      files.some(name => !MIGRATION_FILE_PATTERN.test(name)) ||
      new Set(files.map(name => name.slice(0, 3))).size !== files.length) {
    throw new PostgresRuntimeIntegrityError(
      'schema_migrations',
      'migration filenames must have unique ordered NNN_name.sql identities'
    );
  }
  return files;
}

function migrationChecksum(version) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(MIGRATIONS_DIR, version)))
    .digest('hex');
}

function migrationHeadVersion(files = migrationFiles()) {
  return Number(files[files.length - 1].slice(0, 3));
}

function assertDeclaredWorkAuthorityNotPatched(patch, label) {
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'declaredWorkSnapshot')) return;
  const error = new Error(`${label} cannot mutate declaredWorkSnapshot after admission`);
  error.code = 'DECLARED_WORK_SNAPSHOT_IMMUTABLE';
  throw error;
}

function assertStructuredAllocationAuthorityNotPatched(patch, label) {
  if (!patch || !Object.prototype.hasOwnProperty.call(patch, 'structuredAllocationAuthority')) return;
  const error = new Error(`${label} cannot mutate structuredAllocationAuthority after ticket admission`);
  error.code = 'STRUCTURED_ALLOCATION_AUTHORITY_IMMUTABLE';
  throw error;
}

// The planning attempt has exactly two writers — writeStructuredAllocationPlanningAttempt
// and admitStructuredAllocationPlan — because both enforce the closed lifecycle and the
// optimistic attempt-state guard. A generic ticket patch reaching this field would let a
// status change or a reassignment silently rewrite planning evidence, so it is refused
// with the same shape as the authority guard above.
function assertStructuredAllocationPlanningAttemptNotPatched(patch, label) {
  if (!patch ||
      !Object.prototype.hasOwnProperty.call(patch, 'structuredAllocationPlanningAttempt')) return;
  const error = new Error(
    `${label} cannot mutate structuredAllocationPlanningAttempt outside planning admission`
  );
  error.code = 'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_IMMUTABLE';
  throw error;
}

function assertRunDeclaredCompletionAuthority(run, label) {
  if (!run || run.declaredWorkSnapshot === null ||
      run.declaredWorkSnapshot === undefined) return;
  try {
    normalizeDeclaredWorkSnapshot(run.declaredWorkSnapshot);
    if (run.completionAuthoritySnapshot !== null &&
        run.completionAuthoritySnapshot !== undefined) {
      normalizeCompletionAuthoritySnapshot(run.completionAuthoritySnapshot);
    }
    assertDeclaredWorkCompletionAuthorityBinding({
      declaredWorkSnapshot: run.declaredWorkSnapshot,
      completionAuthoritySnapshot: run.completionAuthoritySnapshot || null,
      verificationContractSnapshot: run.verificationContractSnapshot || null
    });
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

function processExecutionReleaseStateFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    admissionEnabled: row.admission_enabled === true,
    releaseContractHash: row.release_contract_hash,
    sourceRevision: row.source_revision,
    applicationVersion: row.application_version,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    revision: positiveSafeInteger(row.revision, 'process release revision'),
    updatedAt: rowTimestamp(row.updated_at)
  });
}

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

class ProcessExecutionIntentConflictError extends Error {
  constructor(operationIdentity, current = null) {
    super(`Process execution intent conflicts for ${operationIdentity}`);
    this.name = 'ProcessExecutionIntentConflictError';
    this.code = 'PROCESS_EXECUTION_INTENT_CONFLICT';
    this.operationIdentity = operationIdentity;
    this.current = current;
  }
}

class ProcessExecutionStateError extends Error {
  constructor(operationIdentity, expectedStates, current = null) {
    super(
      `Process execution ${operationIdentity} is ${current ? current.lifecycleState : 'missing'}; ` +
      `expected ${expectedStates.join(' or ')}`
    );
    this.name = 'ProcessExecutionStateError';
    this.code = 'PROCESS_EXECUTION_STATE_INVALID';
    this.operationIdentity = operationIdentity;
    this.expectedStates = expectedStates;
    this.current = current;
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
  const id = positiveSafeInteger(row.id, 'ticket.id');
  const ticket = {
    ...(row.body || {}),
    id,
    status: row.status,
    assignmentTargetType: row.assignment_target_type,
    assignmentTargetId: nullablePositiveSafeInteger(row.assignment_target_id, 'ticket.assignmentTargetId'),
    revision: positiveSafeInteger(row.revision, 'ticket.revision'),
    createdAt: rowTimestamp(row.created_at),
    updatedAt: rowTimestamp(row.updated_at)
  };
  if (Object.prototype.hasOwnProperty.call(ticket, 'structuredAllocationAuthority')) {
    ticket.structuredAllocationAuthority = normalizeStructuredAllocationAuthority(
      ticket.structuredAllocationAuthority,
      { expectedTicketId: id, expectedTicketObjective: ticket.objective }
    );
  }
  // Malformed, hash-conflicting or hand-edited planning state must fail closed
  // on read rather than project as if a planner had produced it.
  if (Object.prototype.hasOwnProperty.call(ticket, 'structuredAllocationPlanningAttempt') &&
      ticket.structuredAllocationPlanningAttempt != null) {
    ticket.structuredAllocationPlanningAttempt = normalizePlanningAttempt(
      ticket.structuredAllocationPlanningAttempt,
      { expectedTicketId: id }
    );
  }

  return ticket;
}

function runFromRow(row) {
  const run = {
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
  // Reconstruction refuses a malformed structured Run rather than handing it to
  // a scheduler, a projection, a recovery path or a provider. Enforcing here
  // covers every read in the store with one rule.
  assertRunGovernedExecutionPairing(run, `run ${run.id} governed execution`);
  return run;
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

function processOperationFromRow(row) {
  return {
    operationIdentity: row.operation_identity,
    runId: positiveSafeInteger(row.run_id, 'processOperation.runId'),
    ticketId: positiveSafeInteger(row.ticket_id, 'processOperation.ticketId'),
    actingAgentId: positiveSafeInteger(row.acting_agent_id, 'processOperation.actingAgentId'),
    stepId: row.step_id,
    runtimePhase: row.runtime_phase,
    targetId: row.target_id,
    profileId: row.profile_id,
    policySnapshotHash: row.policy_snapshot_hash,
    runtimeCapabilityGeneration: row.runtime_capability_generation,
    launchPlanVersion: positiveSafeInteger(row.launch_plan_version, 'processOperation.launchPlanVersion'),
    launchPlanHash: row.launch_plan_hash,
    launchPlan: row.launch_plan,
    workspaceSnapshotId: row.workspace_snapshot_id,
    workspaceManifestHash: row.workspace_manifest_hash,
    materializerGeneration: row.materializer_generation,
    containmentGenerationId: row.containment_generation_id,
    rootfsId: row.rootfs_id,
    rootfsManifestHash: row.rootfs_manifest_hash,
    executableIdentityHash: row.executable_identity_hash,
    executionPolicyHash: row.execution_policy_hash,
    filesystemPolicyHash: row.filesystem_policy_hash,
    lifecycleState: row.lifecycle_state,
    launcherAcceptanceIdentity: row.launcher_acceptance_identity,
    dispatchClaimOwner: row.dispatch_claim_owner,
    dispatchClaimExpiresAt: rowTimestamp(row.dispatch_claim_expires_at),
    requestedAt: rowTimestamp(row.requested_at),
    startedAt: rowTimestamp(row.started_at),
    terminalAt: rowTimestamp(row.terminal_at),
    terminalOutcome: row.terminal_outcome,
    terminalResult: row.terminal_result,
    terminalResultHash: row.terminal_result_hash,
    exitCode: row.exit_code,
    terminatingSignal: row.terminating_signal,
    resourceCause: row.resource_cause,
    stdoutByteCount: row.stdout_byte_count === null
      ? null
      : nonNegativeSafeInteger(row.stdout_byte_count, 'processOperation.stdoutByteCount'),
    stdoutSha256: row.stdout_sha256,
    stderrByteCount: row.stderr_byte_count === null
      ? null
      : nonNegativeSafeInteger(row.stderr_byte_count, 'processOperation.stderrByteCount'),
    stderrSha256: row.stderr_sha256,
    combinedOutputByteCount: row.combined_output_byte_count === null
      ? null
      : nonNegativeSafeInteger(
        row.combined_output_byte_count,
        'processOperation.combinedOutputByteCount'
      ),
    stdoutArtifact: row.stdout_artifact,
    stderrArtifact: row.stderr_artifact,
    requiredEvidenceState: row.required_evidence_state,
    launcherOutputAcknowledged: row.launcher_output_acknowledged === true,
    cancellationRequested: row.cancellation_requested === true,
    cancellationRequestedAt: rowTimestamp(row.cancellation_requested_at),
    cancellationReason: row.cancellation_reason,
    lastReconciliationResult: row.last_reconciliation_result,
    revision: positiveSafeInteger(row.revision, 'processOperation.revision'),
    updatedAt: rowTimestamp(row.updated_at)
  };
}

// Canonical prepared-intent projection (A22).
//
// The persisted intent document — `preState`, `args`, `authorityDecision`, `target` —
// lives in the `intent` jsonb column. Every runtime reader wants those fields, and
// several read them straight off this record: `classifyPreparedWorkspaceMutation` uses
// `intent.operation` / `intent.args` / `intent.preState`, and `beginWorkspaceMutation`
// returned `prepared.intent.preState` to its caller.
//
// Returning only the row shape made those reads land ONE LEVEL TOO SHALLOW. They
// silently produced `undefined` — `operation` appeared to work only because it is also
// a column. The first execution therefore built its receipt with no `preState`, while
// recovery rebuilt the same receipt from `targetOperationReceiptProjection`, which does
// dig into the document. The two projections of one operation disagreed, and the
// disagreement stayed invisible until a resume compared them and failed idempotency.
//
// The document is spread onto the record so the durable and in-memory projections are
// the same values by construction, and `intent` is kept nested so the prepare-conflict
// comparison (`canonicalJson(current.intent.intent)`) and
// `targetOperationReceiptProjection` continue to read the raw document.
function targetOperationIntentFromRow(row) {
  const document = row.intent && typeof row.intent === 'object' && !Array.isArray(row.intent)
    ? row.intent
    : {};
  return {
    ...document,
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
    // Pre-state survives on the prepared intent, not on the receipt document.
    // `document.preState` is accepted first so older/alternate receipt shapes
    // normalize identically; current receipts carry only `after`, so the intent
    // is what actually supplies this. See A14.
    preState: document.preState || document.before || intent.preState || null,
    postState: document.postState || document.after || null,
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

// The single canonical way to turn an operation-receipt envelope (plus its
// prepared intent, when one exists) into the projected operation record every
// consumer sees.
//
// Both access paths must use this. They previously diverged: `listRunOperations`
// projected, while `getOperation` returned the raw receipt document, so
// `preState` — which lives on the intent, not the receipt — was silently absent
// from single-operation reads. That made the live redundant-`writeFile`
// postcondition-completion path return null for every run. See
// docs/ARCHITECTURAL_DECISIONS_PENDING.md entry A14.
function projectOperationReceipt(envelope, intentRecord = null) {
  if (!envelope) return null;
  return intentRecord
    ? targetOperationReceiptProjection(envelope, intentRecord)
    : actionOperationReceiptProjection(envelope);
}

// Transaction-level conflicts PostgreSQL resolves by aborting one side and expects the
// caller to retry: serialization failure, deadlock, and lock-timeout.
const GOVERNED_WORKER_ROLE = 'structured_leaf_executor';
const RETRYABLE_TRANSACTION_CODES = new Set(['40001', '40P01', '55P03']);

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
    // Count of transaction retries absorbed by _retryTransientTransaction.
    this.transientConflictRetries = 0;
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
      const expectedMigrations = migrationFiles();
      const migrationResult = await client.query(
        `SELECT version FROM ${this.table('schema_migrations')} ORDER BY version`
      );
      const appliedMigrations = new Set(migrationResult.rows.map(row => row.version));
      const missingMigrations = expectedMigrations.filter(version => !appliedMigrations.has(version));
      const unknownMigrations = [...appliedMigrations]
        .filter(version => !expectedMigrations.includes(version));
      if (missingMigrations.length > 0) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migrations',
          `missing required migration(s): ${missingMigrations.join(', ')}`
        );
      }
      if (unknownMigrations.length > 0) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migrations',
          `unknown future migration(s): ${unknownMigrations.join(', ')}`
        );
      }
      const identityResult = await client.query(
        `SELECT version, sha256
         FROM ${this.table('schema_migration_identities')}
         ORDER BY version`
      );
      const identities = new Map(
        identityResult.rows.map(row => [row.version, row.sha256])
      );
      const identityFailures = expectedMigrations.filter(version =>
        identities.get(version) !== migrationChecksum(version));
      if (identityFailures.length > 0) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migration_identities',
          `missing or changed migration identity: ${identityFailures.join(', ')}`
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
        'governed_postcondition_evidence',
        'target_operation_intents',
        'process_operations',
        'process_execution_release_state',
        'schema_migration_identities',
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
        ['process_operations', 'process_operations_lifecycle_guard'],
        [
          'process_execution_release_state',
          'process_execution_release_state_guard'
        ],
        [
          'schema_migration_identities',
          'schema_migration_identities_append_only'
        ],
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
        ['process_operations', 'process_operations_pkey'],
        ['process_operations', 'process_operations_run_ticket_fk'],
        [
          'process_execution_release_state',
          'process_execution_release_state_singleton'
        ],
        [
          'process_execution_release_state',
          'process_execution_release_state_enablement'
        ],
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

  async getMigrationStatus({ client = null } = {}) {
    const execute = async connection => {
      const expected = migrationFiles();
      const migrationTable = await connection.query(
        'SELECT to_regclass($1) AS name',
        [`${this.schema}.schema_migrations`]
      );
      if (!migrationTable.rows[0] || migrationTable.rows[0].name === null) {
        return Object.freeze({
          currentVersion: 0,
          headVersion: migrationHeadVersion(expected),
          migrationHead: expected[expected.length - 1],
          fullyApplied: false,
          checksumsValid: false,
          partial: false,
          pendingMigrations: expected.length,
          unknownMigrations: 0
        });
      }
      const appliedRows = (await connection.query(
        `SELECT version FROM ${this.table('schema_migrations')} ORDER BY version`
      )).rows;
      const applied = new Set(appliedRows.map(row => row.version));
      const pending = expected.filter(version => !applied.has(version));
      const unknown = [...applied].filter(version => !expected.includes(version));
      const identityTable = await connection.query(
        'SELECT to_regclass($1) AS name',
        [`${this.schema}.schema_migration_identities`]
      );
      let identityRows = [];
      if (identityTable.rows[0] && identityTable.rows[0].name !== null) {
        identityRows = (await connection.query(
          `SELECT version, sha256
           FROM ${this.table('schema_migration_identities')}
           ORDER BY version`
        )).rows;
      }
      const identities = new Map(identityRows.map(row => [
        row.version,
        row.sha256
      ]));
      const checksumsValid = expected.every(version =>
        identities.get(version) === migrationChecksum(version));
      const current = appliedRows
        .map(row => Number(String(row.version).slice(0, 3)))
        .filter(Number.isSafeInteger);
      return Object.freeze({
        currentVersion: current.length > 0 ? Math.max(...current) : 0,
        headVersion: migrationHeadVersion(expected),
        migrationHead: expected[expected.length - 1],
        fullyApplied: pending.length === 0 &&
          unknown.length === 0 &&
          checksumsValid,
        checksumsValid,
        partial: pending.length === 0 && !checksumsValid,
        pendingMigrations: pending.length,
        unknownMigrations: unknown.length
      });
    };
    return client ? execute(client) : this.withTransaction(async connection => {
      await connection.query(
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      );
      return execute(connection);
    });
  }

  async getProcessExecutionReleaseState({ client = null, forUpdate = false } = {}) {
    const execute = async connection => {
      const result = await connection.query(
        `SELECT *
         FROM ${this.table('process_execution_release_state')}
         WHERE id = 1${forUpdate ? ' FOR UPDATE' : ''}`
      );
      if (result.rowCount !== 1) {
        throw new PostgresRuntimeIntegrityError(
          'process_execution_release_state',
          'release authority singleton is missing'
        );
      }
      return processExecutionReleaseStateFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async setProcessExecutionAdmission({
    enabled,
    releaseContractHash = null,
    sourceRevision = null,
    applicationVersion = null,
    changedBy,
    reason
  } = {}) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled must be boolean');
    }
    const actor = requiredString(changedBy, 'changedBy', 256);
    const changeReason = requiredString(reason, 'reason', 1024);
    if (enabled && (
      typeof releaseContractHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(releaseContractHash) ||
      typeof sourceRevision !== 'string' ||
      !/^[0-9a-f]{40}$/.test(sourceRevision) ||
      typeof applicationVersion !== 'string' ||
      !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(
        applicationVersion
      )
    )) {
      throw new TypeError(
        'Enabling admission requires exact release contract authority'
      );
    }
    return this.withTransaction(async client => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('ticket-system:process-release-admission', 0)
         )`
      );
      const current = await this.getProcessExecutionReleaseState({
        client,
        forUpdate: true
      });
      const nextContractHash = enabled
        ? releaseContractHash
        : current.releaseContractHash;
      const nextSourceRevision = enabled
        ? sourceRevision
        : current.sourceRevision;
      const nextApplicationVersion = enabled
        ? applicationVersion
        : current.applicationVersion;
      if (current.admissionEnabled === enabled &&
          current.releaseContractHash === nextContractHash &&
          current.sourceRevision === nextSourceRevision &&
          current.applicationVersion === nextApplicationVersion) {
        return { state: current, changed: false };
      }
      const result = await client.query(
        `UPDATE ${this.table('process_execution_release_state')}
         SET admission_enabled = $1,
             release_contract_hash = $2,
             source_revision = $3,
             application_version = $4,
             changed_by = $5,
             change_reason = $6,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = 1
         RETURNING *`,
        [
          enabled,
          nextContractHash,
          nextSourceRevision,
          nextApplicationVersion,
          actor,
          changeReason
        ]
      );
      await this._appendSystemLog(client, {
        type: enabled
          ? 'process_release:admission_enabled'
          : 'process_release:admission_disabled',
        message: enabled
          ? 'Process execution admission enabled for validated release'
          : 'Process execution admission disabled; recovery remains available',
        metadata: {
          actor,
          reason: changeReason,
          admissionEnabled: enabled,
          releaseContractHash: nextContractHash,
          sourceRevision: nextSourceRevision,
          applicationVersion: nextApplicationVersion
        }
      });
      return {
        state: processExecutionReleaseStateFromRow(result.rows[0]),
        changed: true
      };
    });
  }

  async getProcessReleaseOperationalMetrics() {
    const result = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE lifecycle_state IN ('intent', 'active')
         )::bigint AS active_count,
         COUNT(*) FILTER (
           WHERE lifecycle_state = 'finalizing'
              OR lifecycle_state = 'terminal'
                 AND (
                   required_evidence_state <> 'complete'
                   OR launcher_output_acknowledged = false
                 )
         )::bigint AS finalizing_count,
         COUNT(*) FILTER (
           WHERE lifecycle_state = 'terminal'
             AND NOT EXISTS (
               SELECT 1
               FROM ${this.table('operation_receipts')} AS receipt
               WHERE receipt.run_id = process_operation.run_id
                 AND receipt.operation = 'runProcess'
                 AND receipt.idempotency_key =
                   process_operation.operation_identity
             )
         )::bigint AS awaiting_receipt_count,
         COUNT(*) FILTER (
           WHERE required_evidence_state <> 'complete'
         )::bigint AS awaiting_evidence_count,
         COUNT(*) FILTER (
           WHERE lifecycle_state = 'terminal'
             AND launcher_acceptance_identity IS NOT NULL
             AND launcher_output_acknowledged = false
         )::bigint AS awaiting_output_ack_count,
         COUNT(*) FILTER (
           WHERE cancellation_requested = true
             AND lifecycle_state <> 'terminal'
         )::bigint AS cancellation_pending_count,
         COUNT(*) FILTER (
           WHERE lifecycle_state <> 'terminal'
             AND (
               last_reconciliation_result->>'kind' LIKE '%failed%'
               OR last_reconciliation_result->>'kind' LIKE '%lost%'
             )
         )::bigint AS reconciliation_failed_count,
         MIN(requested_at) FILTER (
           WHERE lifecycle_state IN ('intent', 'active')
         ) AS oldest_active_at,
         MIN(updated_at) FILTER (
           WHERE lifecycle_state = 'finalizing'
         ) AS oldest_finalizing_at
       FROM ${this.table('process_operations')} AS process_operation`
    );
    const row = result.rows[0];
    const count = (value, label) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new RangeError(`${label} exceeds safe integer range`);
      }
      return parsed;
    };
    return Object.freeze({
      activeOperations: count(row.active_count, 'active process count'),
      finalizingOperations: count(
        row.finalizing_count,
        'finalizing process count'
      ),
      operationsAwaitingReceipts: count(
        row.awaiting_receipt_count,
        'awaiting receipt count'
      ),
      operationsAwaitingEvidence: count(
        row.awaiting_evidence_count,
        'awaiting evidence count'
      ),
      operationsAwaitingOutputAcknowledgement: count(
        row.awaiting_output_ack_count,
        'awaiting output acknowledgement count'
      ),
      cancellationPending: count(
        row.cancellation_pending_count,
        'pending cancellation count'
      ),
      reconciliationFailed: count(
        row.reconciliation_failed_count,
        'failed reconciliation count'
      ),
      oldestActiveAt: row.oldest_active_at
        ? rowTimestamp(row.oldest_active_at)
        : null,
      oldestFinalizingAt: row.oldest_finalizing_at
        ? rowTimestamp(row.oldest_finalizing_at)
        : null
    });
  }

  async listProcessLauncherCompactionCandidates({ limit = 100 } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > 1000) throw new RangeError('limit exceeds 1000');
    const result = await this.pool.query(
      `SELECT
         process_operation.*,
         run.status AS run_status,
         receipt.receipt AS operation_receipt,
         consequence.consequence AS run_consequence
       FROM ${this.table('process_operations')} AS process_operation
       JOIN ${this.table('runs')} AS run
         ON run.id = process_operation.run_id
        AND run.ticket_id = process_operation.ticket_id
       JOIN ${this.table('operation_receipts')} AS receipt
         ON receipt.run_id = process_operation.run_id
        AND receipt.ticket_id = process_operation.ticket_id
        AND receipt.operation = 'runProcess'
        AND receipt.idempotency_key = process_operation.operation_identity
       JOIN ${this.table('run_consequences')} AS consequence
         ON consequence.run_id = process_operation.run_id
        AND consequence.ticket_id = process_operation.ticket_id
       WHERE process_operation.lifecycle_state = 'terminal'
         AND process_operation.required_evidence_state = 'complete'
         AND process_operation.launcher_output_acknowledged = true
         AND run.status = ANY(ARRAY['completed', 'failed', 'interrupted'])
         AND consequence.consequence ? 'completionDecision'
       ORDER BY process_operation.terminal_at, process_operation.operation_identity
       LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(row => Object.freeze({
      processOperation: processOperationFromRow(row),
      runStatus: row.run_status,
      operationReceipt: row.operation_receipt,
      runConsequence: row.run_consequence
    }));
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

      const migrations = migrationFiles();
      const currentVersions = new Set((await client.query(
        `SELECT version FROM ${this.table('schema_migrations')} ORDER BY version`
      )).rows.map(row => row.version));
      const unknown = [...currentVersions].filter(version =>
        !migrations.includes(version));
      if (unknown.length > 0) {
        throw new PostgresRuntimeIntegrityError(
          'schema_migrations',
          `unknown future migration(s): ${unknown.join(', ')}`
        );
      }
      const identityTable = await client.query(
        'SELECT to_regclass($1) AS name',
        [`${this.schema}.schema_migration_identities`]
      );
      if (identityTable.rows[0] && identityTable.rows[0].name !== null) {
        const identities = await client.query(
          `SELECT version, sha256
           FROM ${this.table('schema_migration_identities')}
           ORDER BY version`
        );
        for (const row of identities.rows) {
          if (!migrations.includes(row.version) ||
              row.sha256 !== migrationChecksum(row.version)) {
            throw new PostgresRuntimeIntegrityError(
              'schema_migration_identities',
              `historical migration identity changed: ${row.version}`
            );
          }
        }
      }
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
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${this.schemaSql}, public`);
        for (const version of migrations) {
          const checksum = migrationChecksum(version);
          const existing = await client.query(
            `SELECT sha256
             FROM ${this.table('schema_migration_identities')}
             WHERE version = $1`,
            [version]
          );
          if (existing.rowCount === 0) {
            await client.query(
              `INSERT INTO ${this.table('schema_migration_identities')}
                 (version, sha256)
               VALUES ($1, $2)`,
              [version, checksum]
            );
          } else if (existing.rows[0].sha256 !== checksum) {
            throw new PostgresRuntimeIntegrityError(
              'schema_migration_identities',
              `historical migration identity changed: ${version}`
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
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

  async _assertStructuredAllocationAuthorityDraftReferences(connection, draftValue, ticket) {
    const draft = normalizeStructuredAllocationAuthorityDraft(draftValue);
    const conflict = message => {
      const error = new Error(message);
      error.code = 'STRUCTURED_ALLOCATION_REFERENCE_CONFLICT';
      throw error;
    };
    try {
      assertParentDeclaredWorkObjectiveMatchesTicket(
        draft.parentDeclaredWorkSnapshot,
        ticket.objective,
        'ticket.objective'
      );
    } catch (error) {
      conflict(error.message);
    }
    const planning = draft.planningAuthorityDraft;
    if (!planning) return draft;
    if (!ticketAssignmentMatchesPlanningAuthority(ticket, planning)) {
      conflict('Planning-authority draft does not match the ticket assignment authority');
    }

    const groupResult = await connection.query(
      `SELECT * FROM ${this.table('access_groups')} WHERE id = $1 FOR KEY SHARE`,
      [planning.assignmentGroup.id]
    );
    if (groupResult.rowCount !== 1) conflict('Snapshotted planning group no longer exists');
    const group = groupResult.rows[0];
    if (group.name !== planning.assignmentGroup.name ||
        positiveSafeInteger(group.revision, 'group.revision') !== planning.assignmentGroup.revision ||
        nullablePositiveSafeInteger(group.planner_agent_id, 'group.plannerAgentId') !== planning.planner.agentId) {
      conflict('Snapshotted planning group changed before ticket admission');
    }

    const candidateIds = planning.candidates.map(candidate => candidate.agentId);
    const agentResult = await connection.query(
      `SELECT * FROM ${this.table('configured_agents')}
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR KEY SHARE`,
      [candidateIds]
    );
    if (agentResult.rowCount !== candidateIds.length) {
      conflict('A snapshotted planning candidate no longer exists');
    }
    const agentById = new Map(agentResult.rows.map(row => [
      positiveSafeInteger(row.id, 'configuredAgent.id'), row
    ]));
    for (const candidate of planning.candidates) {
      const row = agentById.get(candidate.agentId);
      if (!row || row.name !== candidate.name ||
          positiveSafeInteger(row.revision, 'configuredAgent.revision') !== candidate.revision) {
        conflict(`Snapshotted candidate agent ${candidate.agentId} changed before ticket admission`);
      }
    }
    const plannerRow = agentById.get(planning.planner.agentId);
    if (!plannerRow || plannerRow.name !== planning.planner.name ||
        positiveSafeInteger(plannerRow.revision, 'configuredAgent.revision') !== planning.planner.revision ||
        plannerRow.provider !== planning.planner.provider || plannerRow.model !== planning.planner.model) {
      conflict('Snapshotted planner route changed before ticket admission');
    }

    const membershipResult = await connection.query(
      `SELECT agent_id
       FROM ${this.table('agent_group_memberships')}
       WHERE group_id = $1
       ORDER BY agent_id
       FOR KEY SHARE`,
      [planning.assignmentGroup.id]
    );
    const memberIds = membershipResult.rows.map(row => positiveSafeInteger(row.agent_id, 'membership.agentId'));
    if (memberIds.length !== candidateIds.length ||
        memberIds.some((agentId, index) => agentId !== candidateIds[index])) {
      conflict('Snapshotted candidate membership changed before ticket admission');
    }
    return draft;
  }

  async _createTicketRecord(record, {
    client = null,
    allowStructuredAllocationAuthority = false
  } = {}) {
    const ticket = this.assertJsonRecord(record, 'ticket');
    if (Object.prototype.hasOwnProperty.call(ticket, 'structuredAllocationAuthority') &&
        !allowStructuredAllocationAuthority) {
      const error = new TypeError('structuredAllocationAuthority must be materialized by createTicketWithEvent');
      error.code = 'STRUCTURED_ALLOCATION_AUTHORITY_ADMISSION_REQUIRED';
      throw error;
    }
    const explicitId = ticket.id == null ? null : positiveSafeInteger(ticket.id, 'ticket.id');
    const status = requiredString(ticket.status || 'open', 'ticket.status');
    if (!TICKET_STATUSES.has(status)) throw new TypeError(`Unsupported ticket.status: ${status}`);
    const ticketBody = { ...ticket };
    delete ticketBody.id;
    if (Object.prototype.hasOwnProperty.call(ticketBody, 'structuredAllocationAuthority')) {
      ticketBody.structuredAllocationAuthority = normalizeStructuredAllocationAuthority(
        ticketBody.structuredAllocationAuthority,
        { expectedTicketId: explicitId, expectedTicketObjective: ticketBody.objective }
      );
    }
    const values = [
      status,
      ticket.assignmentTargetType || null,
      nullablePositiveSafeInteger(ticket.assignmentTargetId, 'ticket.assignmentTargetId'),
      ticketBody
    ];
    const execute = async connection => {
      await this._assertTicketAssignmentTarget(connection, ticket);
      await this._assertTicketWorkflow(connection, ticket);
      await this._assertTicketRoutingPolicy(connection, ticket);
      const result = explicitId === null
        ? await connection.query(
          `INSERT INTO ${this.table('tickets')}
            (status, assignment_target_type, assignment_target_id, body)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING *`,
          values
        )
        : await connection.query(
          `INSERT INTO ${this.table('tickets')}
            (id, status, assignment_target_type, assignment_target_id, body)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING *`,
          [explicitId, ...values]
        );
      return ticketFromRow(result.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createTicket(record, { client = null } = {}) {
    return this._createTicketRecord(record, { client });
  }

  async createTicketWithEvent({
    ticket,
    eventPayload = {},
    structuredAllocationAuthorityDraft = null
  }, { client = null } = {}) {
    const body = this.assertJsonRecord(ticket, 'ticket');
    if (Object.prototype.hasOwnProperty.call(body, 'structuredAllocationAuthority')) {
      throw new TypeError('ticket.structuredAllocationAuthority is store-materialized authority');
    }
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const normalizedAuthorityDraft = structuredAllocationAuthorityDraft == null
      ? null
      : normalizeStructuredAllocationAuthorityDraft(structuredAllocationAuthorityDraft);
    const execute = async connection => {
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'ticket clock');
      const record = {
        ...body,
        createdAt: now,
        updatedAt: now,
        ...(Object.prototype.hasOwnProperty.call(body, 'changedAt') ? { changedAt: now } : {})
      };
      if (normalizedAuthorityDraft) {
        record.objective = assertParentDeclaredWorkObjectiveMatchesTicket(
          normalizedAuthorityDraft.parentDeclaredWorkSnapshot,
          record.objective,
          'ticket.objective'
        );
        await this._assertStructuredAllocationAuthorityDraftReferences(
          connection,
          normalizedAuthorityDraft,
          record
        );
        const identityResult = await connection.query(
          `SELECT nextval(pg_get_serial_sequence($1, 'id')) AS id`,
          [`${this.schema}.tickets`]
        );
        record.id = positiveSafeInteger(identityResult.rows[0].id, 'ticket.id');
        record.structuredAllocationAuthority = materializeStructuredAllocationAuthority(
          normalizedAuthorityDraft,
          { ticketId: record.id, capturedAt: now }
        );
      }
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
        const storedBody = { ...record };
        delete storedBody.id;
        const result = record.id == null
          ? await connection.query(
            `INSERT INTO ${this.table('tickets')}
              (status, assignment_target_type, assignment_target_id, body)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
              status,
              record.assignmentTargetType || null,
              nullablePositiveSafeInteger(record.assignmentTargetId, 'ticket.assignmentTargetId'),
              storedBody
            ]
          )
          : await connection.query(
            `INSERT INTO ${this.table('tickets')}
              (id, status, assignment_target_type, assignment_target_id, body)
             VALUES ($1, $2, $3, $4, $5::jsonb)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
              record.id,
              status,
              record.assignmentTargetType || null,
              nullablePositiveSafeInteger(record.assignmentTargetId, 'ticket.assignmentTargetId'),
              storedBody
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
        created = await this._createTicketRecord(record, {
          client: connection,
          allowStructuredAllocationAuthority: true
        });
      }
      if (!inserted) return { ticket: created, event: null, created: false };
      const admittedAuthority = created.structuredAllocationAuthority || null;
      const event = await this._appendEvent(connection, {
        type: 'ticket.created',
        ticketId: created.id,
        payload: {
          ...callerPayload,
          status: created.status,
          createdAt: created.createdAt,
          ...(admittedAuthority ? {
            parentDeclaredWorkHash: admittedAuthority.parentDeclaredWorkSnapshot.contractHash,
            structuredAllocationAuthorityHash: admittedAuthority.authorityHash,
            structuredAllocationEligible: admittedAuthority.structuredAllocationEligibility.eligible,
            planningAuthoritySnapshotHash:
              admittedAuthority.planningAuthoritySnapshot?.snapshotHash || null
          } : {})
        }
      });
      return { ticket: created, event, created: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ── Tranche 2B: structured allocation planning ────────────────────────────
  //
  // The planning attempt lives in the Ticket JSONB body under
  // `structuredAllocationPlanningAttempt`, and every write appends a Ticket
  // event in the same transaction. No new table and no migration are involved:
  // Ticket already provides row locking, revision-checked patching and
  // transactional event append, which is exactly the durability the attempt
  // needs. `structuredAllocationAuthority` remains untouched by all of this —
  // the attempt is a separate field, so the existing immutability guard on the
  // authority still holds.

  // Re-derive every catalog fact the planning-authority snapshot captured, in
  // the caller's transaction. `plannerCredentialsAvailable` is supplied by the
  // caller because credential resolution can fall back to process environment,
  // which is not a database fact and cannot be re-read transactionally.
  async _currentPlanningRouteFacts(connection, planning) {
    const groupResult = await connection.query(
      `SELECT * FROM ${this.table('access_groups')} WHERE id = $1 FOR KEY SHARE`,
      [planning.assignmentGroup.id]
    );
    const group = groupResult.rowCount === 1 ? groupResult.rows[0] : null;
    const agentResult = await connection.query(
      `SELECT * FROM ${this.table('configured_agents')}
       WHERE id = ANY($1::bigint[]) ORDER BY id FOR KEY SHARE`,
      [planning.candidates.map(candidate => candidate.agentId)]
    );
    const agents = agentResult.rows.map(configuredAgentFromRow);
    const membershipResult = group === null ? { rows: [] } : await connection.query(
      `SELECT agent_id FROM ${this.table('agent_group_memberships')}
       WHERE group_id = $1 ORDER BY agent_id FOR KEY SHARE`,
      [planning.assignmentGroup.id]
    );
    return {
      plannerAgent: agents.find(agent => agent.id === planning.planner.agentId) || null,
      groupPlannerAgentId: group === null
        ? null
        : nullablePositiveSafeInteger(group.planner_agent_id, 'group.plannerAgentId'),
      groupMemberAgentIds: membershipResult.rows.map(row =>
        positiveSafeInteger(row.agent_id, 'membership.agentId')),
      candidateAgents: agents
    };
  }

  // One durable planning-attempt write. `expectedAttemptStateHash` is the
  // optimistic guard: null means "no attempt may exist yet", any hash means
  // "the stored attempt must still be exactly this one". Two concurrent
  // planners therefore cannot both start, and a stale caller cannot overwrite
  // a newer stage.
  async writeStructuredAllocationPlanningAttempt({
    ticketId,
    attempt,
    expectedAttemptStateHash = null,
    eventType = 'ticket.structured_planning_attempt',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const nextAttempt = normalizePlanningAttempt(attempt, { expectedTicketId: id });
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
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
      const authority = ticket.structuredAllocationAuthority || null;
      if (!authority || !authority.planningAuthoritySnapshot) {
        const error = new Error(`ticket ${id} has no admitted structured planning authority`);
        error.code = 'STRUCTURED_ALLOCATION_PLANNING_AUTHORITY_MISSING';
        throw error;
      }
      if (nextAttempt.structuredAuthorityHash !== authority.authorityHash ||
          nextAttempt.planningAuthoritySnapshotHash !==
            authority.planningAuthoritySnapshot.snapshotHash ||
          nextAttempt.parentDeclaredWorkHash !==
            authority.parentDeclaredWorkSnapshot.contractHash) {
        const error = new Error(
          `ticket ${id} planning attempt does not bind its admitted structured authority`
        );
        error.code = 'STRUCTURED_ALLOCATION_PLANNING_AUTHORITY_CONFLICT';
        throw error;
      }
      const storedAttempt = ticket.structuredAllocationPlanningAttempt == null
        ? null
        : normalizePlanningAttempt(ticket.structuredAllocationPlanningAttempt, {
          expectedTicketId: id
        });
      const storedHash = storedAttempt === null ? null : storedAttempt.attemptStateHash;
      if (storedHash !== expectedAttemptStateHash) {
        const error = new Error(
          `ticket ${id} planning attempt state changed before this write`
        );
        error.code = 'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_CONFLICT';
        throw error;
      }
      if (storedAttempt !== null && storedAttempt.attemptId !== nextAttempt.attemptId) {
        const error = new Error(`ticket ${id} already owns a different planning attempt`);
        error.code = 'STRUCTURED_ALLOCATION_PLANNING_ATTEMPT_CONFLICT';
        throw error;
      }
      const updated = await connection.query(
        `UPDATE ${this.table('tickets')}
         SET body = body || $2::jsonb,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [id, { structuredAllocationPlanningAttempt: nextAttempt }]
      );
      const event = await this._appendEvent(connection, {
        type: requiredString(eventType, 'eventType'),
        ticketId: id,
        payload: {
          ...callerPayload,
          attemptId: nextAttempt.attemptId,
          attemptState: nextAttempt.state,
          attemptStateHash: nextAttempt.attemptStateHash,
          planningAuthoritySnapshotHash: nextAttempt.planningAuthoritySnapshotHash,
          requestHash: nextAttempt.requestHash,
          responseHash: nextAttempt.responseHash,
          proposalHash: nextAttempt.proposalHash,
          failureStage: nextAttempt.failureStage,
          failureReason: nextAttempt.failureReason
        }
      });
      return { ticket: ticketFromRow(updated.rows[0]), attempt: nextAttempt, event };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Atomic Allocation Plan v2 admission. Every final fact — the plan, its
  // durable planning provenance, the terminal attempt state and the admission
  // event — commits together or not at all. It creates NO worker runs; leaf-run
  // admission is Tranche 3 and is deliberately absent from this transaction.
  async admitStructuredAllocationPlan({
    ticketId,
    attempt,
    allocationPlanDraft,
    plannerCredentialsAvailable = false,
    eventType = 'ticket.allocation_plan_admitted',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const validatedAttempt = normalizePlanningAttempt(attempt, { expectedTicketId: id });
    if (validatedAttempt.state !== 'proposal_validated') {
      throw new TypeError('Only a proposal_validated planning attempt can admit a plan');
    }
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');
    const conflict = message => {
      const error = new Error(message);
      error.code = 'STRUCTURED_ALLOCATION_PLAN_ADMISSION_CONFLICT';
      throw error;
    };

    const execute = async connection => {
      // 1. Re-lock and re-read the ticket. ticketFromRow re-validates the
      //    structured authority and its objective binding on the way in.
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
      const authority = ticket.structuredAllocationAuthority || null;
      if (!authority || !authority.planningAuthoritySnapshot) {
        conflict(`ticket ${id} has no admitted structured planning authority`);
      }
      const planning = authority.planningAuthoritySnapshot;

      // 2. Immutable authority hashes.
      if (validatedAttempt.structuredAuthorityHash !== authority.authorityHash ||
          validatedAttempt.planningAuthoritySnapshotHash !== planning.snapshotHash ||
          validatedAttempt.parentDeclaredWorkHash !==
            authority.parentDeclaredWorkSnapshot.contractHash) {
        conflict('Planning attempt no longer binds its admitted structured authority');
      }

      // 3. Current applicability, re-derived from the locked ticket.
      const applicability = evaluateStructuredAllocationCurrentApplicability(ticket);
      if (!applicability.applicable) {
        conflict(
          `Structured allocation is no longer applicable: ${applicability.refusalReasons.join(', ')}`
        );
      }

      // 4. Invocation readiness, re-derived from live catalog rows in this
      //    transaction. The captured authority is read, never rebuilt.
      const routeFacts = await this._currentPlanningRouteFacts(connection, planning);
      const readiness = evaluatePlannerInvocationReadiness({
        planningAuthoritySnapshot: planning,
        current: {
          ...routeFacts,
          plannerCredentialsAvailable: plannerCredentialsAvailable === true,
          assignmentMatchesCapturedAuthority:
            ticketAssignmentMatchesPlanningAuthority(ticket, planning)
        }
      });
      if (!readiness.ready) {
        conflict(`Planner invocation readiness failed: ${readiness.refusalReasons.join(', ')}`);
      }

      // 5. The attempt is uniquely active and is exactly the one we validated.
      const storedAttempt = ticket.structuredAllocationPlanningAttempt == null
        ? null
        : normalizePlanningAttempt(ticket.structuredAllocationPlanningAttempt, {
          expectedTicketId: id
        });
      if (storedAttempt === null) conflict('Ticket has no durable planning attempt to admit');
      if (storedAttempt.attemptId === validatedAttempt.attemptId &&
          storedAttempt.state === 'plan_admitted') {
        // Idempotent: a retried admission observes the committed outcome and
        // re-reports it instead of admitting a second plan.
        const existing = await connection.query(
          `SELECT * FROM ${this.table('allocation_plans')} WHERE id = $1 AND ticket_id = $2`,
          [storedAttempt.admittedPlanId, id]
        );
        if (existing.rowCount !== 1) conflict('Admitted attempt has no allocation plan');
        return {
          ticket,
          plan: allocationPlanFromRow(existing.rows[0]),
          attempt: storedAttempt,
          event: null,
          admitted: false
        };
      }
      if (storedAttempt.attemptStateHash !== validatedAttempt.attemptStateHash) {
        conflict('Planning attempt state changed between proposal validation and admission');
      }

      // 6. Request, response and proposal evidence.
      for (const field of ['requestHash', 'responseHash', 'proposalHash']) {
        if (storedAttempt[field] !== validatedAttempt[field] || storedAttempt[field] === null) {
          conflict(`Planning attempt ${field} is missing or changed before admission`);
        }
      }

      // Exactly one allocation plan. There is no unique constraint on
      // allocation_plans.ticket_id — historical v1 tickets legitimately have
      // one plan per ticket but nothing enforces it — so the invariant is
      // enforced here, under the ticket lock.
      const existingPlans = await connection.query(
        `SELECT id FROM ${this.table('allocation_plans')} WHERE ticket_id = $1`,
        [id]
      );
      if (existingPlans.rowCount > 0) {
        conflict(`ticket ${id} already has an allocation plan`);
      }
      // One attempt binds to exactly one plan. The ticket lock plus the
      // one-attempt-per-ticket guard already make this true transitively; the
      // check is explicit so a future writer cannot weaken it silently.
      const attemptPlans = await connection.query(
        `SELECT id FROM ${this.table('allocation_plans')}
         WHERE body->'planningProvenance'->>'attemptId' = $1`,
        [storedAttempt.attemptId]
      );
      if (attemptPlans.rowCount > 0) {
        conflict(`planning attempt ${storedAttempt.attemptId} already admitted a plan`);
      }
      // Proof of the Tranche 2B stopping boundary, enforced rather than
      // asserted: admission refuses if any run already exists for this ticket.
      const existingRuns = await connection.query(
        `SELECT 1 FROM ${this.table('runs')} WHERE ticket_id = $1 LIMIT 1`,
        [id]
      );
      if (existingRuns.rowCount > 0) {
        conflict(`ticket ${id} already has runs; structured plan admission would not be first`);
      }

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'allocation plan admission clock');

      // 7. Reserve plan and item identities.
      const draftItemCount = Array.isArray(allocationPlanDraft && allocationPlanDraft.items)
        ? allocationPlanDraft.items.length
        : 0;
      if (draftItemCount === 0) conflict('Allocation plan draft has no items');
      const planIdentity = await connection.query(
        'SELECT nextval(pg_get_serial_sequence($1, $2))::bigint AS id',
        [`${this.schema}.allocation_plans`, 'id']
      );
      const itemIdentities = await connection.query(
        `SELECT nextval('${this.schemaSql}.allocation_item_id_seq') AS id
         FROM generate_series(1, $1)`,
        [draftItemCount]
      );

      // 8-9. Materialize and validate immutable v2 authority and its planHash.
      const planAuthority = materializeAllocationPlanV2Draft(allocationPlanDraft, {
        id: positiveSafeInteger(planIdentity.rows[0].id, 'allocationPlan.id'),
        allocationItemIds: itemIdentities.rows.map(row =>
          positiveSafeInteger(row.id, 'allocationItemId'))
      });
      if (planAuthority.ticketId !== id) conflict('Allocation plan draft targets another ticket');
      if (planAuthority.parentDeclaredWorkSnapshot.contractHash !==
          authority.parentDeclaredWorkSnapshot.contractHash) {
        conflict('Allocation plan draft does not carry the admitted parent declared work');
      }
      normalizeAllocationPlanV2(planAuthority);

      // 11. Immutable planning provenance, bound to this exact plan.
      const provenance = buildPlanningProvenance({
        attemptId: storedAttempt.attemptId,
        plannerAgentId: storedAttempt.planner.agentId,
        provider: storedAttempt.planner.provider,
        model: storedAttempt.planner.model,
        planningAuthoritySnapshotHash: storedAttempt.planningAuthoritySnapshotHash,
        parentDeclaredWorkHash: storedAttempt.parentDeclaredWorkHash,
        requestHash: storedAttempt.requestHash,
        responseHash: storedAttempt.responseHash,
        proposalHash: storedAttempt.proposalHash,
        planHash: planAuthority.planHash,
        admittedAt: now
      });

      // 10. Persist the plan with its provenance in one row.
      const body = this.assertJsonRecord(
        createAllocationPlanV2StorageBody(planAuthority, now, provenance),
        'allocation plan v2 body'
      );
      const planResult = await connection.query(
        `INSERT INTO ${this.table('allocation_plans')}
           (id, ticket_id, status, body, created_at, updated_at)
         OVERRIDING SYSTEM VALUE
         VALUES ($1, $2, $3, $4::jsonb, $5, $5)
         RETURNING *`,
        [planAuthority.id, id, 'pending', body, now]
      );
      const plan = allocationPlanFromRow(planResult.rows[0]);
      // Re-validate the three independently checked values off the persisted
      // row, not the in-memory objects, so a serialization defect cannot admit
      // an unverifiable binding.
      assertAdmissionBinding({
        planHash: plan.planHash,
        provenanceHash: plan.planningProvenance.provenanceHash,
        admissionHash: plan.planningProvenance.admissionHash
      });

      // 12. Mark the attempt admitted.
      const admittedAttempt = advancePlanningAttempt(storedAttempt, {
        state: 'plan_admitted',
        admittedPlanId: plan.id,
        admittedPlanHash: plan.planHash,
        completedAt: now
      });
      const updatedTicket = await connection.query(
        `UPDATE ${this.table('tickets')}
         SET body = body || $2::jsonb,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [id, { structuredAllocationPlanningAttempt: admittedAttempt }]
      );

      // 13. Append the admission event.
      const event = await this._appendEvent(connection, {
        type: requiredString(eventType, 'eventType'),
        ticketId: id,
        payload: {
          ...callerPayload,
          attemptId: admittedAttempt.attemptId,
          attemptState: admittedAttempt.state,
          attemptStateHash: admittedAttempt.attemptStateHash,
          allocationPlanId: plan.id,
          allocationPlanVersion: plan.version,
          allocationPlanStatus: plan.status,
          planHash: plan.planHash,
          planningProvenanceHash: provenance.provenanceHash,
          admissionHash: provenance.admissionHash,
          plannerAgentId: provenance.plannerAgentId,
          provider: provenance.provider,
          model: provenance.model,
          requestHash: provenance.requestHash,
          responseHash: provenance.responseHash,
          proposalHash: provenance.proposalHash,
          // Plan admission itself still creates zero worker runs: leaf-run
          // admission is a separate atomic transaction that runs immediately
          // after this one commits. Both facts are reported, not conflated.
          workerRunsCreated: 0,
          leafExecutionCapabilityAvailable: true
        }
      });

      // 14. Commit is the caller's transaction boundary.
      return {
        ticket: ticketFromRow(updatedTicket.rows[0]),
        plan,
        attempt: admittedAttempt,
        event,
        admitted: true
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ── Tranche 3: structured allocation leaf-run admission ───────────────────
  //
  // Two transactions, both store-owned:
  //
  //   admitStructuredAllocationLeafRuns()      one initial Run per immutable item
  //   reconcileStructuredAllocationLeafItems() persisted facts -> item status
  //
  // Neither creates authority. Admission binds Runs to items the planner already
  // admitted; reconciliation reads the durable Run lifecycle and completion
  // decisions and writes back the item status they imply. No caller supplies an
  // item status for a planner-admitted plan, and no model participates in either.
  //
  // Lock order for both is tickets -> allocation_plans -> runs. Reconciliation
  // takes a strict subset (allocation_plans only, runs read-only), so the pair
  // cannot deadlock against each other, against updateAllocationItemStatus,
  // which takes allocation_plans alone, or against createRunsAndStartTicket,
  // which takes tickets then runs.

  // The plan row a leaf operation is allowed to act on: exactly one v2 plan,
  // carrying planner provenance whose admission binding still verifies.
  async _lockedPlannerAdmittedPlan(connection, ticketId, { allocationPlanId = null } = {}) {
    const result = await connection.query(
      `SELECT * FROM ${this.table('allocation_plans')}
       WHERE ticket_id = $1 ORDER BY id FOR UPDATE`,
      [ticketId]
    );
    if (result.rowCount === 0) refuseLeafAdmission('admitted_plan_missing');
    if (result.rowCount > 1) {
      refuseLeafAdmission('admitted_plan_mismatch',
        `ticket ${ticketId} holds ${result.rowCount} allocation plans`);
    }
    const plan = allocationPlanFromRow(result.rows[0]);
    if (plan.version !== ALLOCATION_PLAN_VERSION) {
      refuseLeafAdmission('admitted_plan_mismatch',
        'Structured leaf admission applies only to Allocation Plan v2');
    }
    if (allocationPlanId !== null && plan.id !== allocationPlanId) {
      refuseLeafAdmission('admitted_plan_mismatch',
        `ticket ${ticketId} allocation plan is ${plan.id}, not ${allocationPlanId}`);
    }
    if (!plan.planningProvenance) refuseLeafAdmission('plan_provenance_missing');
    try {
      assertAdmissionBinding({
        planHash: plan.planHash,
        provenanceHash: plan.planningProvenance.provenanceHash,
        admissionHash: plan.planningProvenance.admissionHash
      });
    } catch (error) {
      refuseLeafAdmission('plan_admission_binding_invalid', error.message);
    }
    return plan;
  }

  // Lenient sibling of _lockedPlannerAdmittedPlan for callers that must work for
  // EVERY ticket. Returns null when this ticket simply holds no planner-admitted
  // v2 plan (no plan, a historical v1 plan, or a v2 plan with no provenance);
  // a plan that IS planner-admitted but no longer verifies still fails closed.
  async _findLockedPlannerAdmittedPlan(connection, ticketId) {
    const result = await connection.query(
      `SELECT * FROM ${this.table('allocation_plans')}
       WHERE ticket_id = $1 ORDER BY id FOR UPDATE`,
      [ticketId]
    );
    if (result.rowCount !== 1) return null;
    const plan = allocationPlanFromRow(result.rows[0]);
    if (plan.version !== ALLOCATION_PLAN_VERSION || !plan.planningProvenance) return null;
    assertAdmissionBinding({
      planHash: plan.planHash,
      provenanceHash: plan.planningProvenance.provenanceHash,
      admissionHash: plan.planningProvenance.admissionHash
    });
    return plan;
  }

  // Every persisted leaf binding for this plan, verified against the plan on the
  // way out. A run that carries no binding, or one bound to another plan, is not
  // a leaf of this plan and is reported separately so the caller can refuse
  // rather than silently reconcile a mixed run set.
  _leafRunsForPlan(runs, plan) {
    const leaves = [];
    const foreign = [];
    for (const run of runs) {
      const binding = run.leafRunBinding || null;
      if (!binding || binding.allocationPlanId !== plan.id) {
        foreign.push(run);
        continue;
      }
      leaves.push({
        run,
        binding: normalizeLeafRunBinding(binding, {
          expectedRunId: run.id,
          expectedTicketId: plan.ticketId,
          expectedPlanId: plan.id,
          expectedPlanHash: plan.planHash
        })
      });
    }
    return { leaves, foreign };
  }

  // Atomic leaf-run admission. Exactly one initial Run per immutable allocation
  // item, every Run carrying its immutable binding at INSERT, all of them
  // scheduler-visible together or none at all. A refusal creates zero Runs and
  // zero bindings and leaves the admitted plan untouched.
  async admitStructuredAllocationLeafRuns({
    ticketId,
    allocationPlanId = null,
    leafDrafts,
    // Tranche 4 cutover: REQUIRED. There is no ungoverned structured leaf
    // admission. Every sibling receives complete governed authority or no Run
    // becomes scheduler-visible.
    governedLeafCapture,
    runEventPayload = () => ({}),
    eventType = 'ticket.allocation_leaf_runs_admitted',
    eventPayload = {}
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(leafDrafts) || leafDrafts.length === 0) {
      throw new TypeError('leafDrafts must be a non-empty array');
    }
    if (typeof runEventPayload !== 'function') {
      throw new TypeError('runEventPayload must be a function');
    }
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      // Lock order is allocation_plans -> runs -> tickets, matching
      // transitionTicketAfterRun so the two cannot deadlock. The runs lock is
      // taken before the ticket lock even though the set is normally empty: the
      // ticket lock is what actually serializes two concurrent admissions, and
      // the existing-run set is re-read below, after it is held.
      const plan = await this._lockedPlannerAdmittedPlan(connection, id, { allocationPlanId });
      await connection.query(
        `SELECT id FROM ${this.table('runs')} WHERE ticket_id = $1 ORDER BY id FOR UPDATE`,
        [id]
      );
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

      // Re-derived from the LOCKED ticket, not from the caller's preflight.
      // Plan admission already re-evaluates both in its own transaction; leaf
      // admission must too, or a reassignment or eligibility change committed
      // between preflight and this lock would admit worker Runs against
      // authority the ticket no longer holds.
      const authority = ticket.structuredAllocationAuthority || null;
      if (!authority || !authority.planningAuthoritySnapshot) {
        refuseLeafAdmission('historical_authority_unavailable');
      }
      const applicability = evaluateStructuredAllocationCurrentApplicability(ticket);
      if (!applicability.applicable) {
        refuseLeafAdmission('admission_ineligible', applicability.refusalReasons.join(', '));
      }
      if (!ticketAssignmentMatchesPlanningAuthority(ticket, authority.planningAuthoritySnapshot)) {
        refuseLeafAdmission('assignment_changed_since_capture');
      }

      // The plan must still be the one the ticket's planning attempt admitted.
      const attempt = ticket.structuredAllocationPlanningAttempt == null
        ? null
        : normalizePlanningAttempt(ticket.structuredAllocationPlanningAttempt, {
          expectedTicketId: id
        });
      if (!attempt || attempt.state !== 'plan_admitted') {
        refuseLeafAdmission('planning_attempt_not_admitted');
      }
      if (attempt.admittedPlanId !== plan.id || attempt.admittedPlanHash !== plan.planHash) {
        refuseLeafAdmission('admitted_plan_mismatch');
      }
      if (attempt.attemptId !== plan.planningProvenance.attemptId) {
        refuseLeafAdmission('admitted_plan_mismatch',
          'The stored plan provenance names a different planning attempt');
      }
      if (plan.status !== 'pending') refuseLeafAdmission('plan_not_pending');

      // Exactly-once, enforced under the ticket lock rather than asserted. A
      // committed complete leaf set re-reports itself; anything else refuses.
      const existingRunsResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE ticket_id = $1 ORDER BY id FOR UPDATE`,
        [id]
      );
      const existingRuns = existingRunsResult.rows.map(runFromRow);
      if (existingRuns.length > 0) {
        const { leaves, foreign } = this._leafRunsForPlan(existingRuns, plan);
        if (foreign.length > 0) refuseLeafAdmission('leaf_runs_already_exist');
        try {
          assertLeafBindingSetComplete(leaves.map(leaf => leaf.binding), plan, {
            declaredWorkHashByItemId: new Map(leaves.map(leaf => [
              leaf.binding.allocationItemId,
              leaf.run.declaredWorkSnapshot ? leaf.run.declaredWorkSnapshot.contractHash : null
            ]))
          });
        } catch (_) {
          refuseLeafAdmission('leaf_runs_already_exist');
        }
        return {
          ticket,
          plan,
          runs: leaves.map(leaf => leaf.run),
          bindings: leaves.map(leaf => leaf.binding),
          event: null,
          admitted: false
        };
      }

      // Every item exactly once, and every draft carrying exactly the authority
      // its item admitted. Preflight completes before any Run identity is
      // reserved, so an unsupported item refuses the whole admission.
      const itemsById = new Map(plan.items.map(item => [item.allocationItemId, item]));
      const drafts = leafDrafts.map((leaf, index) => {
        const label = `leafDrafts[${index}]`;
        const source = this.assertJsonRecord(leaf, label);
        const allocationItemId = positiveSafeInteger(
          source.allocationItemId,
          `${label}.allocationItemId`
        );
        const item = itemsById.get(allocationItemId);
        if (!item) {
          refuseLeafAdmission('leaf_ownership_drift',
            `${label} names allocation item ${allocationItemId}, which this plan does not contain`);
        }
        const run = this.assertJsonRecord(source.run, `${label}.run`);
        if (positiveSafeInteger(run.ticketId, `${label}.run.ticketId`) !== id) {
          throw new TypeError('Every leaf run draft must belong to ticketId');
        }
        if (positiveSafeInteger(run.agentId, `${label}.run.agentId`) !== item.assignedAgentId) {
          refuseLeafAdmission('leaf_agent_not_authorized',
            `${label} assigns agent ${run.agentId}, but the item admitted ${item.assignedAgentId}`);
        }
        if (run.allocationPlanId !== plan.id || run.allocationItemId !== allocationItemId) {
          refuseLeafAdmission('leaf_ownership_drift',
            `${label} does not identify its allocation item`);
        }
        // Ownership is the admitted item ownership, never regenerated from the
        // current group. buildLeafDeclaredWorkSnapshot re-runs the typed-criterion
        // preflight, so an unsupported criterion refuses here, before any
        // identity is reserved.
        if (run.executionMode === 'workflow') {
          refuseLeafAdmission('leaf_execution_mode_unsupported');
        }
        const declared = buildLeafDeclaredWorkSnapshot(item, {
          sharedConstraints: plan.sharedConstraints,
          completionAuthoritySnapshot: run.completionAuthoritySnapshot || null
        });
        const draftPaths = Array.isArray(run.ownedOutputPaths) ? [...run.ownedOutputPaths].sort() : [];
        const itemPaths = [...item.ownedOutputPaths].sort();
        if (draftPaths.length !== itemPaths.length ||
            draftPaths.some((ownedPath, position) => ownedPath !== itemPaths[position])) {
          refuseLeafAdmission('leaf_ownership_drift',
            `${label} does not carry the exact admitted owned paths`);
        }
        if (!run.declaredWorkSnapshot ||
            run.declaredWorkSnapshot.contractHash !== declared.contractHash) {
          refuseLeafAdmission('leaf_ownership_drift',
            `${label} declared work does not come from its allocation item`);
        }
        return { allocationItemId, item, run, declaredWorkHash: declared.contractHash };
      });
      const draftItemIds = drafts.map(draft => draft.allocationItemId);
      if (new Set(draftItemIds).size !== draftItemIds.length ||
          draftItemIds.length !== plan.items.length) {
        refuseLeafAdmission('leaf_ownership_drift',
          'Leaf admission must supply exactly one run draft per allocation item');
      }

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'leaf run admission clock');
      const identities = await connection.query(
        `SELECT nextval(pg_get_serial_sequence($1, $2))::bigint AS id
         FROM generate_series(1, $3)`,
        [`${this.schema}.runs`, 'id', drafts.length]
      );
      const bindings = drafts.map((draft, index) => buildLeafRunBinding({
        ticketId: id,
        allocationPlanId: plan.id,
        planHash: plan.planHash,
        allocationItemId: draft.allocationItemId,
        assignedAgentId: draft.item.assignedAgentId,
        itemDeclaredWorkHash: draft.declaredWorkHash,
        ownedOutputPaths: draft.item.ownedOutputPaths,
        parentDeclaredWorkHash: plan.parentDeclaredWorkSnapshot.contractHash,
        planningAttemptId: plan.planningProvenance.attemptId,
        planningAdmissionHash: plan.planningProvenance.admissionHash,
        runId: positiveSafeInteger(identities.rows[index].id, 'run.id'),
        admittedAt: now
      }));
      // One-to-one with the admitted items, no reused Run, every binding
      // re-derived from the plan. Checked before anything is written.
      const declaredWorkHashByItemId = new Map(drafts.map(draft =>
        [draft.allocationItemId, draft.declaredWorkHash]));
      assertLeafBindingSetComplete(bindings, plan, { declaredWorkHashByItemId });

      // Governed authority is captured HERE, inside the admission transaction
      // and after Run identities are reserved, because the authority binds the
      // Run ID. Capturing it earlier would require guessing an identity; later
      // would mean a Run briefly existed without the authority that governs it.
      //
      // All siblings or none: any refusal below aborts the transaction, so no
      // partially governed leaf set can become scheduler-visible.
      const governedEnvelopes = await this._captureGovernedLeafAuthority(connection, {
        ticketId: id,
        drafts,
        runIds: drafts.map((_, index) =>
          positiveSafeInteger(identities.rows[index].id, 'run.id')),
        capture: governedLeafCapture,
        capturedAt: now
      });

      const created = await this.createRunsAndStartTicket({
        ticketId: id,
        runDrafts: drafts.map((draft, index) => ({
          ...draft.run,
          leafRunBinding: bindings[index],
          governedExecution: governedEnvelopes[index]
        })),
        runEventPayload,
        ticketEventPayload: {
          source: 'structured_allocation_leaf_admission',
          allocationPlanId: plan.id,
          planHash: plan.planHash,
          workerRunsCreated: bindings.length
        }
      }, {
        client: connection,
        // The identities this transaction reserved from the runs sequence, and
        // only those. They travel beside the drafts, never inside them.
        reservedRunIds: bindings.map(binding => binding.runId)
      });

      // Re-verify off the persisted rows, not the in-memory drafts, so a
      // serialization defect cannot leave an unverifiable binding committed.
      const persisted = this._leafRunsForPlan(created.runs, plan);
      if (persisted.foreign.length > 0) {
        throw new TypeError('Leaf admission persisted a run without its immutable binding');
      }
      assertLeafBindingSetComplete(persisted.leaves.map(leaf => leaf.binding), plan, {
        declaredWorkHashByItemId: new Map(persisted.leaves.map(leaf => [
          leaf.binding.allocationItemId,
          leaf.run.declaredWorkSnapshot ? leaf.run.declaredWorkSnapshot.contractHash : null
        ]))
      });

      const event = await this._appendEvent(connection, {
        type: requiredString(eventType, 'eventType'),
        ticketId: id,
        payload: {
          ...callerPayload,
          allocationPlanId: plan.id,
          allocationPlanVersion: plan.version,
          planHash: plan.planHash,
          planningAttemptId: plan.planningProvenance.attemptId,
          admissionHash: plan.planningProvenance.admissionHash,
          workerRunsCreated: bindings.length,
          leafBindings: bindings.map(binding => ({
            allocationItemId: binding.allocationItemId,
            assignedAgentId: binding.assignedAgentId,
            runId: binding.runId,
            itemDeclaredWorkHash: binding.itemDeclaredWorkHash,
            ownedOutputPaths: binding.ownedOutputPaths,
            bindingHash: binding.bindingHash
          }))
        }
      });

      return {
        ticket: created.ticket,
        plan,
        runs: created.runs,
        bindings: persisted.leaves.map(leaf => leaf.binding),
        event,
        admitted: true
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Store-owned item-status derivation. The caller may request reconciliation;
  // it may not supply, propose or force any item status. Every value written
  // here comes from the immutable binding, the persisted Run lifecycle, the
  // durable completion decision and declared-work/completion-authority hash
  // agreement — nothing else. Repeated calls over unchanged facts write nothing.
  // The single leaf derivation, applied to an ALREADY-LOCKED planner-admitted
  // plan. Both entry points call exactly this: the caller-requested
  // reconciliation, and the canonical Ticket transition, which must consume the
  // aggregate proof rather than re-derive a parallel one.
  async _reconcileLeafItemsLocked(connection, plan) {
    const id = plan.ticketId;
    {
      const runsResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE ticket_id = $1 ORDER BY id`,
        [id]
      );
      const { leaves } = this._leafRunsForPlan(runsResult.rows.map(runFromRow), plan);
      if (leaves.length === 0) {
        // Leaf admission has not happened yet. There is nothing to derive, and
        // inventing a status here would be exactly the caller-forced write this
        // method exists to prevent.
        return { plan, decision: null, reconciled: false, changed: false };
      }

      const byItem = new Map();
      for (const leaf of leaves) {
        const existing = byItem.get(leaf.binding.allocationItemId) || [];
        existing.push(leaf);
        byItem.set(leaf.binding.allocationItemId, existing);
      }
      const missing = plan.items
        .map(item => item.allocationItemId)
        .filter(allocationItemId => !byItem.has(allocationItemId));
      if (missing.length > 0) {
        // A partially persisted leaf set is an integrity defect. It is reported,
        // never filled in from mutable configuration.
        const error = new Error(
          `Allocation plan ${plan.id} has no leaf run for item(s): ${missing.join(', ')}`
        );
        error.code = 'STRUCTURED_ALLOCATION_LEAF_BINDING_INCOMPLETE';
        throw error;
      }

      const decisionResult = await connection.query(
        `SELECT run_id, consequence FROM ${this.table('run_consequences')}
         WHERE run_id = ANY($1::bigint[])`,
        [leaves.map(leaf => leaf.run.id)]
      );
      const decisionByRunId = new Map(decisionResult.rows.map(row => [
        positiveSafeInteger(row.run_id, 'runConsequence.runId'),
        row.consequence && row.consequence.completionDecision
          ? normalizeCompletionDecision(row.consequence.completionDecision)
          : null
      ]));

      const aggregateItems = plan.items.map(item => {
        const lineage = [...byItem.get(item.allocationItemId)]
          .sort((left, right) => left.run.id - right.run.id);
        // Retry lineage is representable, but Tranche 3 admits exactly one
        // initial Run per item and auto-retry already refuses owned-scope
        // tickets, so this is a single element in practice. The most recent Run
        // is the one whose durable facts decide the item.
        const current = lineage[lineage.length - 1];
        const disposition = deriveLeafItemDisposition({
          binding: current.binding,
          runId: current.run.id,
          runTicketId: current.run.ticketId,
          runStatus: current.run.status,
          runDeclaredWorkHash: current.run.declaredWorkSnapshot
            ? current.run.declaredWorkSnapshot.contractHash
            : null,
          runCompletionAuthorityHash: current.run.completionAuthoritySnapshot
            ? current.run.completionAuthoritySnapshot.objectiveContractHash
            : null,
          decision: decisionByRunId.get(current.run.id) || null,
          // The DURABLE governed block, when the Run holds one. Reconciliation
          // received no block before, so a Run stopped by the coordination
          // controls was indistinguishable here from one that merely failed —
          // both arrive with an `incomplete` / `RUN_EXECUTION_FAILED` decision.
          // Nothing is inferred: only a persisted block is passed.
          governedProgressBlock: current.run.governedProgressBlock || null
        });
        return {
          allocationItemId: item.allocationItemId,
          assignedAgentId: item.assignedAgentId,
          runId: current.run.id,
          runLineage: lineage.map(leaf => leaf.run.id),
          itemStatus: disposition.itemStatus,
          completionDecisionHash: disposition.completionDecisionHash,
          reason: disposition.reason
        };
      });

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const now = isoTimestamp(clock.rows[0].ts, 'leaf reconciliation clock');
      const decision = buildAggregatePlanDecision({
        ticketId: id,
        allocationPlanId: plan.id,
        planHash: plan.planHash,
        planningAdmissionHash: plan.planningProvenance.admissionHash,
        items: aggregateItems,
        decidedAt: now
      });

      const statusByItem = new Map(decision.items.map(item =>
        [item.allocationItemId, item.itemStatus]));
      const itemStatuses = plan.itemStatuses.map(itemStatus => ({
        ...itemStatus,
        status: statusByItem.get(itemStatus.allocationItemId)
      }));
      const stored = plan.aggregateDecision || null;
      const unchanged = stored !== null &&
        stored.aggregateStatus === decision.aggregateStatus &&
        plan.status === decision.aggregateStatus &&
        itemStatuses.every((itemStatus, index) =>
          itemStatus.status === plan.itemStatuses[index].status) &&
        decision.items.every((item, index) =>
          item.itemStatus === stored.items[index].itemStatus &&
          item.completionDecisionHash === stored.items[index].completionDecisionHash &&
          item.reason === stored.items[index].reason);
      if (unchanged) {
        // Idempotent: identical facts produce no write, no revision bump and no
        // event. `decidedAt` is deliberately excluded from that comparison —
        // otherwise the wall clock alone would make reconciliation non-idempotent.
        return {
          plan,
          decision: normalizeAggregatePlanDecision(stored, {
            expectedPlanHash: plan.planHash,
            expectedPlanId: plan.id
          }),
          reconciled: true,
          changed: false
        };
      }

      const body = this.assertJsonRecord(
        serializeAllocationPlanV2StorageBody(plan, itemStatuses, {
          aggregateDecision: decision
        }),
        'allocation plan v2 body'
      );
      const updated = await connection.query(
        `UPDATE ${this.table('allocation_plans')}
         SET status = $2, body = $3::jsonb, revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [plan.id, decision.aggregateStatus, body]
      );
      const reconciledPlan = allocationPlanFromRow(updated.rows[0]);
      // Verify off the persisted row: a stored aggregate decision that does not
      // reproduce its own hash and item projection is not authority.
      const persistedDecision = normalizeAggregatePlanDecision(
        reconciledPlan.aggregateDecision,
        { expectedPlanHash: reconciledPlan.planHash, expectedPlanId: reconciledPlan.id }
      );
      // Journalled in the SAME transaction as the write it describes, so the
      // event can never claim a reconciliation that rolled back, and a replay
      // can reconstruct every item disposition change from the event stream.
      const previousByItem = new Map((stored ? stored.items : [])
        .map(item => [item.allocationItemId, item]));
      const event = await this._appendEvent(connection, {
        type: 'ticket.allocation_leaf_items_reconciled',
        ticketId: id,
        payload: {
          allocationPlanId: reconciledPlan.id,
          planHash: reconciledPlan.planHash,
          allocationPlanStatus: reconciledPlan.status,
          aggregateStatus: persistedDecision.aggregateStatus,
          aggregateDecisionHash: persistedDecision.decisionHash,
          completedItemIds: persistedDecision.completedItemIds,
          failedItemIds: persistedDecision.failedItemIds,
          unresolvedItemIds: persistedDecision.unresolvedItemIds,
          changedItems: persistedDecision.items
            .filter(item => {
              const previous = previousByItem.get(item.allocationItemId) || null;
              return !previous || previous.itemStatus !== item.itemStatus ||
                previous.reason !== item.reason ||
                previous.completionDecisionHash !== item.completionDecisionHash;
            })
            .map(item => ({
              allocationItemId: item.allocationItemId,
              runId: item.runId,
              itemStatus: item.itemStatus,
              reason: item.reason,
              completionDecisionHash: item.completionDecisionHash
            }))
        }
      });
      return {
        plan: reconciledPlan,
        decision: persistedDecision,
        reconciled: true,
        changed: true,
        event
      };
    }
  }

  // Caller-requested reconciliation. It may request; it may not supply a status.
  // Lock order is allocation_plans -> runs -> tickets everywhere a leaf plan is
  // involved, so this, leaf admission and the canonical Ticket transition cannot
  // deadlock against each other.
  async reconcileStructuredAllocationLeafItems({
    ticketId,
    allocationPlanId = null
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const planId = allocationPlanId === null || allocationPlanId === undefined
      ? null
      : positiveSafeInteger(allocationPlanId, 'allocationPlanId');
    const execute = async connection => this._reconcileLeafItemsLocked(
      connection,
      await this._lockedPlannerAdmittedPlan(connection, id, { allocationPlanId: planId })
    );
    return client ? execute(client) : this.withTransaction(execute);
  }


  // ── Role-scoped economic accounting (Tranche 4) ────────────────────────────
  //
  // Money moves through exactly one path here, and every transition is a single
  // transaction that both changes state and appends its event. There is no
  // "record it and journal it later": a state change whose event failed to
  // append is a state change nobody can audit.
  //
  // The lifecycle is deliberately one-way:
  //
  //   reserved ─▶ request_started ─▶ response_persisted ─▶ settled
  //      └──────▶ released   (only from `reserved`; see below)
  //
  // RELEASE IS ONLY LEGAL BEFORE START. Once `markEconomicRequestStarted` wins,
  // the bytes may already be on the wire, so the reservation can never be handed
  // back — it settles, conservatively if the provider never reported usage.
  //
  // ONE-WINNER START. `markEconomicRequestStarted` is a conditional UPDATE
  // predicated on the row still being `reserved`. Two concurrent workers issue
  // the same statement; PostgreSQL serializes them on the row lock and the
  // second sees zero rows, so exactly one caller ever receives dispatch
  // authority for a given reservation.
  //
  // THE WINNER RECEIVES BYTES, NOT A HASH. The reservation stores the exact
  // serialized request, so the winner is handed the bytes that were priced
  // rather than being trusted to re-supply them. A caller cannot substitute a
  // different body after reservation, and a process that died mid-dispatch can
  // recover the authorized bytes without remembering anything.

  _economicReservationFromRow(row) {
    if (!row) return null;
    return {
      id: Number(row.id),
      accountId: Number(row.account_id),
      ticketId: Number(row.ticket_id),
      role: row.role,
      planningAttemptId: row.planning_attempt_id,
      runId: row.run_id === null ? null : Number(row.run_id),
      modelRequestOrdinal: Number(row.model_request_ordinal),
      exactRequestHash: row.exact_request_hash,
      routingDecisionHash: row.routing_decision_hash,
      economicAuthorityHash: row.economic_authority_hash,
      targetEvidenceHash: row.target_evidence_hash,
      adapterCapabilityHash: row.adapter_capability_hash,
      modelCapabilityHash: row.model_capability_hash,
      pricingCatalogHash: row.pricing_catalog_hash,
      pricingEntryHash: row.pricing_entry_hash,
      logicalSourceIdentity: row.logical_source_identity,
      economicAuthority: row.economic_authority,
      pricingEntrySnapshot: row.pricing_entry_snapshot,
      preparedRequest: row.prepared_request,
      serializedRequest: row.serialized_request,
      serializedRequestByteCount: Number(row.serialized_request_byte_count),
      preparedRequestHash: row.prepared_request_hash,
      reservedMaxMicroUsd: Number(row.reserved_max_micro_usd),
      state: row.state,
      settlementReceipt: row.settlement_receipt,
      settledMicroUsd: row.settled_micro_usd === null ? null : Number(row.settled_micro_usd),
      responseIdentity: row.response_identity,
      responseHash: row.response_hash,
      createdAt: row.created_at,
      startedAt: row.started_at,
      // The claim that started this request. NULL for rows predating the
      // binding, which callers must treat conservatively rather than as current.
      startedClaimEventPosition: row.started_claim_event_position === null ||
        row.started_claim_event_position === undefined
        ? null
        : Number(row.started_claim_event_position),
      responsePersistedAt: row.response_persisted_at,
      settledAt: row.settled_at,
      releasedAt: row.released_at,
      revision: Number(row.revision)
    };
  }

  // Locks the account row FIRST and always. Every balance-changing method takes
  // this lock before reading any amount, so two concurrent reservations against
  // one account cannot both read the same pre-reservation balance and both
  // conclude there is room. Without the lock the CHECK constraint would still
  // refuse the overdraft, but as a constraint violation rather than a governed
  // refusal, and only after the second transaction had already done its work.
  async _lockedEconomicAccount(client, { ticketId, role }) {
    const result = await client.query(
      `SELECT * FROM ${this.table('ticket_economic_accounts')}
       WHERE ticket_id = $1 AND role = $2 FOR UPDATE`,
      [ticketId, role]
    );
    if (result.rowCount === 0) {
      const error = new Error(
        `no economic account exists for ticket ${ticketId} role ${role}`);
      error.code = 'ECONOMIC_ACCOUNT_NOT_FOUND';
      throw error;
    }
    return result.rows[0];
  }

  // Takes the account lock through the reservation, so callers holding only a
  // reservation id still serialize against concurrent reservations on the same
  // account. The account is locked BEFORE the reservation to preserve a single
  // global lock order (account → reservation) and keep deadlock impossible.
  async _lockedEconomicReservation(client, reservationId, { expectedStates = null } = {}) {
    const located = await client.query(
      `SELECT ticket_id, role FROM ${this.table('economic_request_reservations')}
       WHERE id = $1`,
      [reservationId]
    );
    if (located.rowCount === 0) {
      const error = new Error(`economic reservation ${reservationId} was not found`);
      error.code = 'ECONOMIC_RESERVATION_NOT_FOUND';
      throw error;
    }
    const account = await this._lockedEconomicAccount(client, {
      ticketId: Number(located.rows[0].ticket_id),
      role: located.rows[0].role
    });
    const result = await client.query(
      `SELECT * FROM ${this.table('economic_request_reservations')}
       WHERE id = $1 FOR UPDATE`,
      [reservationId]
    );
    const reservation = this._economicReservationFromRow(result.rows[0]);
    if (expectedStates && !expectedStates.includes(reservation.state)) {
      const error = new Error(
        `economic reservation ${reservationId} is ${reservation.state}, ` +
        `not ${expectedStates.join(' or ')}`);
      error.code = 'ECONOMIC_RESERVATION_STATE_CONFLICT';
      error.detail = { state: reservation.state, expected: expectedStates };
      throw error;
    }
    return { account, reservation };
  }

  // Admits the role-scoped account. Idempotent by (ticket, role): re-admitting
  // the SAME policy returns the existing account untouched, and re-admitting a
  // DIFFERENT policy refuses rather than silently re-authorizing a budget that
  // reservations have already been taken against.
  async admitTicketEconomicAccount({
    ticketId,
    role,
    economicPolicy,
    eventType = 'ticket.economic_account_admitted'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const policy = normalizeEconomicPolicy(economicPolicy);
    if (policy.role !== role) {
      throw new TypeError(`economic policy authorizes ${policy.role}, not ${String(role)}`);
    }

    const execute = async connection => {
      // Lock the ticket so account admission serializes with ticket lifecycle,
      // matching the lock order used by the leaf-admission path.
      const ticket = await connection.query(
        `SELECT id FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`, [id]);
      if (ticket.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const existing = await connection.query(
        `SELECT * FROM ${this.table('ticket_economic_accounts')}
         WHERE ticket_id = $1 AND role = $2 FOR UPDATE`,
        [id, policy.role]
      );
      if (existing.rowCount > 0) {
        const row = existing.rows[0];
        if (row.economic_policy_hash !== policy.policyHash) {
          const error = new Error(
            `ticket ${id} role ${policy.role} is already governed by a different economic policy`);
          error.code = 'ECONOMIC_POLICY_CONFLICT';
          error.detail = {
            existingPolicyHash: row.economic_policy_hash,
            presentedPolicyHash: policy.policyHash
          };
          throw error;
        }
        // Same policy, same account: admission is a no-op and appends no event.
        return { account: row, admitted: false };
      }
      const inserted = await connection.query(
        `INSERT INTO ${this.table('ticket_economic_accounts')}
          (ticket_id, role, economic_policy_id, economic_policy_hash, authorized_micro_usd)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, policy.role, policy.policyId, policy.policyHash, policy.authorizedMicroUsd]
      );
      await this._appendEvent(connection, {
        type: eventType,
        ticketId: id,
        payload: {
          role: policy.role,
          economicPolicyId: policy.policyId,
          economicPolicyHash: policy.policyHash,
          authorizedMicroUsd: policy.authorizedMicroUsd,
          maximumProviderRequests: policy.maximumProviderRequests
        }
      });
      return { account: inserted.rows[0], admitted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Reserves the maximum liability for ONE prepared request, before any provider
  // contact. The reservation stores the authorized bytes themselves.
  async reserveEconomicRequest({
    preparedRequest,
    economicAuthority,
    pricingEntry,
    // The canonical model-request source identity. When supplied, the database
    // permits exactly one reservation per logical request for this Run.
    logicalSourceIdentity = null,
    eventType = 'ticket.economic_request_reserved'
  }, { client = null } = {}) {
    const request = normalizeGovernedProviderRequest(preparedRequest);
    const authority = normalizeEconomicAuthority(economicAuthority);
    if (request.economicAuthorityHash !== authority.authorityHash) {
      throw new TypeError('preparedRequest was not prepared under this economic authority');
    }
    // The exact rates are captured HERE, at reservation, and never consulted
    // from live configuration again. Settlement after a restart, a re-pricing
    // or a catalog deletion reads only what this row retains.
    if (!pricingEntry || typeof pricingEntry !== 'object') {
      throw new TypeError('pricingEntry must be the exact captured pricing entry');
    }
    if (hashCanonical(pricingEntry) !== authority.pricingEntryHash) {
      const error = new Error(
        'pricingEntry does not match the pricing entry hash the authority captured');
      error.code = 'ECONOMIC_PRICING_BASIS_MISMATCH';
      throw error;
    }

    const execute = async connection => {
      const account = await this._lockedEconomicAccount(connection, {
        ticketId: request.ticketId,
        role: request.role
      });
      // The account must be governed by the policy this authority was captured
      // under, or the ceilings being charged against were never authorized.
      if (account.economic_policy_hash !== authority.economicPolicyHash) {
        const error = new Error(
          `economic authority cites a policy the account is not governed by`);
        error.code = 'ECONOMIC_POLICY_CONFLICT';
        throw error;
      }

      const amount = request.maximumLiabilityMicroUsd;
      const reserved = Number(account.reserved_micro_usd);
      const settled = Number(account.settled_micro_usd);
      const authorized = Number(account.authorized_micro_usd);
      // Checked against the LOCKED balance, so this is a governed refusal rather
      // than a constraint violation discovered after the fact.
      if (reserved + settled + amount > authorized) {
        const error = new Error(
          `reserving ${amount} would exceed the ${authorized} micro-USD authorized ` +
          `for ticket ${request.ticketId} role ${request.role}`);
        error.code = 'ECONOMIC_AUTHORITY_EXCEEDED';
        error.detail = { authorized, reserved, settled, requested: amount };
        throw error;
      }

      let inserted;
      try {
        inserted = await connection.query(
          `INSERT INTO ${this.table('economic_request_reservations')}
            (account_id, ticket_id, role, planning_attempt_id, run_id, model_request_ordinal,
             exact_request_hash, routing_decision_hash, economic_authority_hash,
             target_evidence_hash, adapter_capability_hash, model_capability_hash,
             pricing_catalog_hash, pricing_entry_hash,
             economic_authority, pricing_entry_snapshot,
             prepared_request, serialized_request, serialized_request_byte_count,
             prepared_request_hash, reserved_max_micro_usd, logical_source_identity, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,
             $17::jsonb,$18,$19,$20,$21,$22,'reserved')
           RETURNING *`,
          [
            Number(account.id), request.ticketId, request.role,
            request.planningAttemptId, request.runId, request.modelRequestOrdinal,
            request.requestHash, request.routingDecisionHash, authority.authorityHash,
            request.targetEvidenceHash, request.adapterCapabilityHash,
            request.modelCapabilityHash, authority.pricingCatalogHash,
            request.pricingEntryHash,
            JSON.stringify(authority), JSON.stringify(pricingEntry),
            JSON.stringify(request), governedRequestBytes(request).serializedRequest,
            request.serializedByteCount, request.preparedRequestHash, amount,
            logicalSourceIdentity
          ]
        );
      } catch (error) {
        // The per-source ordinal uniqueness constraint is what makes reservation
        // idempotent under retry: the same subject cannot reserve the same
        // request ordinal twice, so a retried reservation is refused rather than
        // double-charging the account.
        if (error && error.code === '23505') {
          // Two distinct conflicts live here. A repeated ORDINAL means the
          // caller re-derived a number already spent; a repeated LOGICAL SOURCE
          // means two callers meant the same request. The second is idempotent
          // rather than exceptional, so it is named separately.
          const logicalConflict = String(error.constraint || '')
            .includes('logical_source_unique');
          const conflict = new Error(logicalConflict
            ? `logical request ${logicalSourceIdentity} is already reserved for this run`
            : `request ordinal ${request.modelRequestOrdinal} is already reserved for this subject`);
          conflict.code = logicalConflict
            ? 'ECONOMIC_LOGICAL_REQUEST_DUPLICATE'
            : 'ECONOMIC_RESERVATION_DUPLICATE';
          conflict.detail = { constraint: error.constraint || null };
          throw conflict;
        }
        throw error;
      }

      await connection.query(
        `UPDATE ${this.table('ticket_economic_accounts')}
         SET reserved_micro_usd = reserved_micro_usd + $2,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [Number(account.id), amount]
      );

      const reservation = this._economicReservationFromRow(inserted.rows[0]);
      // Identities and hashes only. No credentials, no provider secrets, and no
      // request body: the bytes live in the reservation row, not in the journal.
      await this._appendEvent(connection, {
        type: eventType,
        ticketId: request.ticketId,
        runId: request.runId,
        payload: {
          reservationId: reservation.id,
          role: request.role,
          modelRequestOrdinal: request.modelRequestOrdinal,
          exactRequestHash: request.requestHash,
          preparedRequestHash: request.preparedRequestHash,
          economicAuthorityHash: authority.authorityHash,
          routingDecisionHash: request.routingDecisionHash,
          reservedMaxMicroUsd: amount
        }
      });
      return reservation;
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ONE-WINNER dispatch authority. Returns the exact bytes to send; every other
  // concurrent caller is refused.
  async markEconomicRequestStarted({
    reservationId,
    // The claim the CALLER believes it is running under. Validated, never
    // trusted: see the check below.
    expectedClaimEventPosition = null,
    eventType = 'ticket.economic_request_started'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(reservationId, 'reservationId');

    const execute = async connection => {
      // The conditional predicate is the whole guarantee: `state = 'reserved'`
      // can only be true for one caller, because the row lock serializes them
      // and the winner leaves the row in `request_started`.
      // THE CLAIM THE CALLER RAN UNDER, VALIDATED — not whichever claim happens
      // to be newest when this statement executes.
      //
      // Reading the newest claim internally was subtly wrong. A caller that
      // began under claim 10, paused, and resumed after the Run was reclaimed
      // as claim 11 would have its request recorded against 11 — a claim it
      // never ran under — and a later reader comparing identities would then
      // call that request current and report a live winner for work whose
      // initiator is gone.
      //
      // So the caller states which claim it believes it holds, and this
      // transaction refuses unless that is still the governing claim for THIS
      // Run. The value is never used as authority on the caller's say-so: it is
      // matched against the append-only event log, and a superseded claim is a
      // refusal rather than a silent substitution.
      if (expectedClaimEventPosition !== null) {
        // A MALFORMED expected position is an authority integrity failure, not
        // a generic argument error. It is coded so the orchestration can return
        // a closed outcome instead of letting an uncoded throw escape as an
        // unattributable rejection — the caller still gets refused either way,
        // but only a coded refusal is classifiable.
        let expected;
        try {
          expected = positiveSafeInteger(
            expectedClaimEventPosition, 'expectedClaimEventPosition');
        } catch (invalid) {
          const error = new Error(
            `expected claim event position is not a usable claim identity: ${invalid.message}`);
          error.code = 'ECONOMIC_REQUEST_CLAIM_POSITION_INVALID';
          error.detail = { reservationId: id };
          throw error;
        }
        const governing = await connection.query(
          `SELECT max(claim.position) AS current_position
             FROM ${this.table('events')} AS claim
             JOIN ${this.table('economic_request_reservations')} AS reservation
               ON reservation.run_id = claim.run_id
            WHERE reservation.id = $1 AND claim.type = 'run.lease_acquired'`,
          [id]);
        const current = governing.rows[0].current_position === null
          ? null
          : Number(governing.rows[0].current_position);
        if (current === null || current !== expected) {
          const error = new Error(
            `reservation ${id} cannot start under claim ${expected}: the ` +
            `governing claim is ${current === null ? 'absent' : current}`);
          error.code = 'ECONOMIC_REQUEST_STALE_CLAIM_ATTEMPT';
          error.detail = { reservationId: id, expected, current };
          throw error;
        }
      }

      const won = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')} AS reservation
         SET state = 'request_started',
             started_at = clock_timestamp(),
             started_claim_event_position = COALESCE($2::bigint, (
               SELECT max(claim.position) FROM ${this.table('events')} AS claim
                WHERE claim.run_id = reservation.run_id
                  AND claim.type = 'run.lease_acquired'
             )),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE reservation.id = $1 AND reservation.state = 'reserved'
         RETURNING *`,
        [id, expectedClaimEventPosition === null ? null : Number(expectedClaimEventPosition)]
      );
      if (won.rowCount === 0) {
        const current = await connection.query(
          `SELECT state FROM ${this.table('economic_request_reservations')} WHERE id = $1`,
          [id]
        );
        if (current.rowCount === 0) {
          const error = new Error(`economic reservation ${id} was not found`);
          error.code = 'ECONOMIC_RESERVATION_NOT_FOUND';
          throw error;
        }
        const error = new Error(
          `economic reservation ${id} was already started or closed ` +
          `(state ${current.rows[0].state})`);
        error.code = 'ECONOMIC_REQUEST_ALREADY_STARTED';
        error.detail = { state: current.rows[0].state };
        throw error;
      }

      const reservation = this._economicReservationFromRow(won.rows[0]);
      // The persisted bytes are re-verified against the persisted hash before
      // being handed out. Storage that returned different bytes than were priced
      // must fail here rather than reach a provider.
      const actual = hashSerializedRequest(reservation.serializedRequest);
      if (actual !== reservation.exactRequestHash) {
        const error = new Error(
          `persisted request bytes for reservation ${id} do not match the reserved hash`);
        error.code = 'ECONOMIC_REQUEST_BYTES_CORRUPT';
        error.detail = { expected: reservation.exactRequestHash, actual };
        throw error;
      }

      await this._appendEvent(connection, {
        type: eventType,
        ticketId: reservation.ticketId,
        runId: reservation.runId,
        payload: {
          reservationId: reservation.id,
          role: reservation.role,
          modelRequestOrdinal: reservation.modelRequestOrdinal,
          exactRequestHash: reservation.exactRequestHash,
          reservedMaxMicroUsd: reservation.reservedMaxMicroUsd
        }
      });
      return {
        reservation,
        // The authorized bytes, from storage — not from the caller.
        serializedRequest: reservation.serializedRequest
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async markEconomicResponsePersisted({
    reservationId,
    responseIdentity,
    responseHash,
    eventType = 'ticket.economic_response_persisted'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(reservationId, 'reservationId');
    const identity = requiredString(responseIdentity, 'responseIdentity');
    if (typeof responseHash !== 'string' || !/^[0-9a-f]{64}$/.test(responseHash)) {
      throw new TypeError('responseHash must be a lowercase SHA-256');
    }

    const execute = async connection => {
      const { reservation } = await this._lockedEconomicReservation(connection, id, {
        expectedStates: ['request_started']
      });
      const updated = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')}
         SET state = 'response_persisted',
             response_persisted_at = clock_timestamp(),
             response_identity = $2,
             response_hash = $3,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND state = 'request_started'
         RETURNING *`,
        [id, identity, responseHash]
      );
      if (updated.rowCount === 0) {
        const error = new Error(`economic reservation ${id} was not awaiting a response`);
        error.code = 'ECONOMIC_RESERVATION_STATE_CONFLICT';
        throw error;
      }
      await this._appendEvent(connection, {
        type: eventType,
        ticketId: reservation.ticketId,
        runId: reservation.runId,
        payload: {
          reservationId: id,
          role: reservation.role,
          exactRequestHash: reservation.exactRequestHash,
          responseIdentity: identity,
          responseHash
        }
      });
      return this._economicReservationFromRow(updated.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Settles once. The receipt is verified against the PERSISTED prepared request
  // rather than against whatever the caller presents alongside it, so a receipt
  // for different bytes cannot close this reservation.
  //
  // The caller supplies USAGE, never rates. There is deliberately no parameter
  // through which a replacement price, catalog or authority could enter: the
  // basis is read from the reservation row and verified against the hashes it
  // was reserved under. Current configuration is not consulted, so an
  // administrator who re-prices or deletes a catalog entry can neither change
  // nor block the settlement of a request already reserved against it.
  async settleEconomicRequest({
    reservationId,
    usage,
    eventType = 'ticket.economic_request_settled'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(reservationId, 'reservationId');

    const execute = async connection => {
      const { account, reservation } = await this._lockedEconomicReservation(connection, id);
      // Settlement from `request_started` is legal and deliberate: a request
      // that reached the provider but whose response was never persisted must
      // still settle, conservatively, rather than leak a reservation forever.
      //
      // A reservation already in a terminal state reports the SAME code whether
      // the second attempt arrived sequentially or lost the conditional UPDATE
      // race below, so a caller handling double settlement never has to
      // distinguish the two.
      if (reservation.state === 'settled' || reservation.state === 'released') {
        const error = new Error(
          `economic reservation ${id} was already ${reservation.state}`);
        error.code = 'ECONOMIC_RESERVATION_ALREADY_SETTLED';
        error.detail = { state: reservation.state };
        throw error;
      }
      if (reservation.state === 'reserved') {
        const error = new Error(
          `economic reservation ${id} was never started and cannot be settled`);
        error.code = 'ECONOMIC_RESERVATION_STATE_CONFLICT';
        error.detail = { state: reservation.state };
        throw error;
      }

      // A request with no persisted response has no metered usage anyone can
      // trust, so it settles at the reserved maximum and nothing else.
      if (reservation.responseHash === null &&
          (!usage || usage.source !== 'authorized_maximum_assumed')) {
        const error = new Error(
          `reservation ${id} has no persisted response and must settle conservatively`);
        error.code = 'ECONOMIC_SETTLEMENT_USAGE_UNPROVEN';
        throw error;
      }
      // Built here, from the durable captured basis alone.
      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const builtReceipt = buildSettlementReceiptFromCapturedBasis({
        preparedRequest: reservation.preparedRequest,
        authority: reservation.economicAuthority,
        pricingEntry: reservation.pricingEntrySnapshot,
        reservedMaximumMicroUsd: reservation.reservedMaxMicroUsd,
        // A request that started but never persisted a response still has to
        // settle. It is bound to the reservation's own identity so the receipt
        // never claims a provider response that was never received.
        responseIdentity: reservation.responseIdentity === null
          ? `unconfirmed:reservation:${id}`
          : reservation.responseIdentity,
        responseHash: reservation.responseHash === null
          ? hashCanonical({ unconfirmedReservation: id, requestHash: reservation.exactRequestHash })
          : reservation.responseHash,
        usage,
        settledAt: new Date(clock.rows[0].ts).toISOString()
      });
      // Re-normalized against the captured entry, so a tampered stored basis is
      // caught even though the receipt was just built from it.
      const receipt = normalizeSettlementReceipt(builtReceipt, {
        pricingEntry: reservation.pricingEntrySnapshot
      });
      // Bind to the bytes THIS reservation authorized, read from the row.
      assertReceiptMatchesPreparedRequest(receipt, reservation.preparedRequest);
      // The stored authority must still be the one the reservation names.
      if (receipt.economicAuthorityHash !== reservation.economicAuthorityHash) {
        const error = new Error(
          `stored economic authority for reservation ${id} does not match its recorded hash`);
        error.code = 'ECONOMIC_CAPTURED_BASIS_CORRUPT';
        throw error;
      }
      if (receipt.requestHash !== reservation.exactRequestHash ||
          receipt.preparedRequestHash !== reservation.preparedRequestHash) {
        const error = new Error(
          `settlement receipt does not settle the bytes reservation ${id} authorized`);
        error.code = 'ECONOMIC_SETTLEMENT_REQUEST_MISMATCH';
        throw error;
      }
      if (receipt.economicAuthorityHash !== reservation.economicAuthorityHash) {
        const error = new Error(
          `settlement receipt cites a different economic authority than reservation ${id}`);
        error.code = 'ECONOMIC_SETTLEMENT_AUTHORITY_MISMATCH';
        throw error;
      }
      if (receipt.reservedMaximumMicroUsd !== reservation.reservedMaxMicroUsd) {
        const error = new Error(
          `settlement receipt reserves ${receipt.reservedMaximumMicroUsd} but reservation ` +
          `${id} reserved ${reservation.reservedMaxMicroUsd}`);
        error.code = 'ECONOMIC_SETTLEMENT_RESERVATION_MISMATCH';
        throw error;
      }
      // A response-bearing reservation must settle against the response it
      // actually persisted.
      if (reservation.responseHash !== null && receipt.responseHash !== reservation.responseHash) {
        const error = new Error(
          `settlement receipt settles a different response than reservation ${id} persisted`);
        error.code = 'ECONOMIC_SETTLEMENT_RESPONSE_MISMATCH';
        throw error;
      }

      const settled = receipt.settledMicroUsd;
      const updated = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')}
         SET state = 'settled',
             settled_at = clock_timestamp(),
             settlement_receipt = $2::jsonb,
             settled_micro_usd = $3,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND state IN ('response_persisted', 'request_started')
         RETURNING *`,
        [id, JSON.stringify(receipt), settled]
      );
      // Zero rows here means another transaction settled or closed this
      // reservation first. Refusing rather than retrying is what keeps a single
      // dispatch from being charged twice.
      if (updated.rowCount === 0) {
        const error = new Error(`economic reservation ${id} was already settled or closed`);
        error.code = 'ECONOMIC_RESERVATION_ALREADY_SETTLED';
        throw error;
      }

      // The reserve is released in full and only the actual cost is charged, in
      // the same statement, so the account can never briefly show both.
      await connection.query(
        `UPDATE ${this.table('ticket_economic_accounts')}
         SET reserved_micro_usd = reserved_micro_usd - $2,
             settled_micro_usd = settled_micro_usd + $3,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [Number(account.id), reservation.reservedMaxMicroUsd, settled]
      );

      await this._appendEvent(connection, {
        type: eventType,
        ticketId: reservation.ticketId,
        runId: reservation.runId,
        payload: {
          reservationId: id,
          role: reservation.role,
          exactRequestHash: reservation.exactRequestHash,
          receiptHash: receipt.receiptHash,
          usageSource: receipt.usageSource,
          settledMicroUsd: settled,
          reservedMaxMicroUsd: reservation.reservedMaxMicroUsd,
          unusedReservationMicroUsd: receipt.unusedReservationMicroUsd
        }
      });
      return this._economicReservationFromRow(updated.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Releases a reservation that was NEVER started. A started request may have
  // reached the provider, so releasing it would give back money that may be
  // owed; those settle instead.
  async releaseUndispatchedEconomicReservation({
    reservationId,
    reason,
    eventType = 'ticket.economic_reservation_released'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(reservationId, 'reservationId');
    const releaseReason = requiredString(reason, 'reason');

    const execute = async connection => {
      const { account, reservation } = await this._lockedEconomicReservation(connection, id);
      if (reservation.state !== 'reserved') {
        const error = new Error(
          `economic reservation ${id} is ${reservation.state} and can no longer be released`);
        error.code = 'ECONOMIC_RESERVATION_NOT_RELEASABLE';
        error.detail = { state: reservation.state };
        throw error;
      }
      const updated = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')}
         SET state = 'released',
             released_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND state = 'reserved'
         RETURNING *`,
        [id]
      );
      if (updated.rowCount === 0) {
        const error = new Error(`economic reservation ${id} was no longer releasable`);
        error.code = 'ECONOMIC_RESERVATION_NOT_RELEASABLE';
        throw error;
      }
      await connection.query(
        `UPDATE ${this.table('ticket_economic_accounts')}
         SET reserved_micro_usd = reserved_micro_usd - $2,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1`,
        [Number(account.id), reservation.reservedMaxMicroUsd]
      );
      await this._appendEvent(connection, {
        type: eventType,
        ticketId: reservation.ticketId,
        runId: reservation.runId,
        payload: {
          reservationId: id,
          role: reservation.role,
          exactRequestHash: reservation.exactRequestHash,
          releasedMicroUsd: reservation.reservedMaxMicroUsd,
          reason: releaseReason
        }
      });
      return this._economicReservationFromRow(updated.rows[0]);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Is a Run's executor still alive?
  //
  // This reuses the EXACT predicate the canonical recovery path uses to decide
  // a Run is recoverable — `lease_owner IS NULL OR lease_expires_at <=
  // clock_timestamp()` — so there is one definition of abandonment in the
  // system rather than two that can disagree. Elapsed wall-clock time alone is
  // never the proof: the lease is, and it is evaluated against the database
  // clock inside the query so a skewed application clock cannot declare a live
  // executor dead.
  async isRunExecutorActive(runId, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT status, lease_owner,
                (lease_owner IS NOT NULL AND lease_expires_at > clock_timestamp())
                  AS lease_live
           FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (result.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const row = result.rows[0];

      // THE CURRENT CLAIM ATTEMPT, not merely its owner.
      //
      // `lease_owner` is a PROCESS identity, so two concurrent callers inside
      // one process share it and a later claim by the same process reuses it.
      // Neither a duplicate racing a live winner nor a recovery after a crash
      // can be told apart by it — and they need opposite answers.
      //
      // Every claim appends one `run.lease_acquired` event, so the newest such
      // event dates the CURRENT claim. A request started before it belongs to
      // an earlier attempt; one started at or after it belongs to this one.
      // Append-only and hash-chained, so it cannot be rewritten by a later
      // mutation the way a revision counter can.
      const claimed = await connection.query(
        `SELECT max(position) AS claim_event_position, max(ts) AS claimed_at
           FROM ${this.table('events')}
          WHERE run_id = $1 AND type = 'run.lease_acquired'`, [id]);

      return {
        // A LIVE LEASE is the executor, and the status is deliberately not part
        // of this test: `claimPendingRun` takes the lease before the Run
        // advances to `running`, so requiring `running` would report a
        // just-claimed executor as gone and let a duplicate settle its request.
        // Abandonment is exactly the absence of a live lease, which is the same
        // condition the canonical recovery query uses.
        active: row.lease_live === true,
        status: row.status,
        leaseOwner: row.lease_owner,
        // THE IDENTITY. The timestamp below is retained for diagnostics only;
        // classification compares this id, because two claims can share a
        // millisecond and clock order is not append order.
        currentClaimEventPosition: claimed.rows[0].claim_event_position === null
          ? null
          : Number(claimed.rows[0].claim_event_position),
        currentClaimAt: claimed.rows[0].claimed_at === null
          ? null
          : isoTimestamp(claimed.rows[0].claimed_at, 'run current claim')
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // The single READ-ONLY seam every governed-economics projection is built
  // from. One transaction, so an account row and the reservations charged
  // against it are always read at the same instant — a projection assembled
  // from two separate reads could show a balance that never existed.
  //
  // No mutation happens anywhere in this method. Projections observe; they do
  // not repair.
  async readTicketGovernedEconomics(ticketId, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const accounts = await connection.query(
        `SELECT * FROM ${this.table('ticket_economic_accounts')}
          WHERE ticket_id = $1 ORDER BY role`,
        [id]
      );
      const reservations = await connection.query(
        `SELECT * FROM ${this.table('economic_request_reservations')}
          WHERE ticket_id = $1
          ORDER BY role, run_id NULLS FIRST, model_request_ordinal`,
        [id]
      );
      return {
        accounts: accounts.rows.map(row => ({
          id: Number(row.id),
          ticketId: Number(row.ticket_id),
          role: row.role,
          economicPolicyId: row.economic_policy_id,
          economicPolicyHash: row.economic_policy_hash,
          // Every amount comes from the DURABLE ROW. Nothing here is derived
          // from process memory or from summing reservations, because a sum of
          // reservations is not the account and can disagree with it.
          authorizedMicroUsd: Number(row.authorized_micro_usd),
          reservedMicroUsd: Number(row.reserved_micro_usd),
          settledMicroUsd: Number(row.settled_micro_usd),
          remainingMicroUsd: Number(row.authorized_micro_usd) -
            Number(row.reserved_micro_usd) - Number(row.settled_micro_usd),
          revision: Number(row.revision)
        })),
        reservations: reservations.rows.map(row => this._economicReservationFromRow(row))
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async getEconomicReservation(reservationId, { client = null } = {}) {
    const id = positiveSafeInteger(reservationId, 'reservationId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('economic_request_reservations')} WHERE id = $1`, [id]);
      return this._economicReservationFromRow(result.rows[0] || null);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Classifies reservations a crashed process left open. Classification only —
  // nothing is settled, released or dispatched here. Acting on these is a
  // separate authority that this method deliberately does not exercise.
  //
  //   never_dispatched      — reserved, never started. Releasable: the bytes
  //                           provably never reached a provider.
  //   dispatch_uncertain    — started, no response persisted. NOT releasable:
  //                           the provider may have been billed, so it must
  //                           settle, conservatively if usage is unknown.
  //   awaiting_settlement   — a response is persisted and metered settlement
  //                           can proceed from the recorded response.
  async listRecoverableEconomicReservations({
    ticketId = null,
    role = null,
    olderThanSeconds = 0,
    limit = 100
  } = {}, { client = null } = {}) {
    const id = ticketId === null ? null : positiveSafeInteger(ticketId, 'ticketId');
    const age = nonNegativeSafeInteger(olderThanSeconds, 'olderThanSeconds');
    const cap = positiveSafeInteger(limit, 'limit');

    const execute = async connection => {
      const result = await connection.query(
        `SELECT * FROM ${this.table('economic_request_reservations')}
         WHERE state IN ('reserved', 'request_started', 'response_persisted')
           AND ($1::bigint IS NULL OR ticket_id = $1)
           AND ($2::text IS NULL OR role = $2)
           AND updated_at <= clock_timestamp() - make_interval(secs => $3)
         ORDER BY id
         LIMIT $4`,
        [id, role, age, cap]
      );
      return result.rows.map(row => {
        const reservation = this._economicReservationFromRow(row);
        const classification = reservation.state === 'reserved'
          ? 'never_dispatched'
          : (reservation.state === 'request_started'
            ? 'dispatch_uncertain'
            : 'awaiting_settlement');
        return {
          ...reservation,
          classification,
          // Only a provably undispatched reservation may be handed back.
          releasable: classification === 'never_dispatched'
        };
      });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }


  // ── Governed structured-planner alignment (Tranche 4) ──────────────────────
  //
  // Two facts about one planner request live in two places: the economic
  // reservation and the planning attempt. Writing them in separate transactions
  // would create a window in which they disagree, and the disagreement that
  // matters is the dangerous one:
  //
  //   planning attempt says the request may run
  //   while the reservation never granted the one winning start
  //
  // A process that crashed in that window would re-issue a provider request
  // that may already have been billed. So both transitions commit together, and
  // THE RESERVATION IS THE NO-REPEAT AUTHORITY: if the reservation says
  // `request_started`, the request is never dispatched again, whatever the
  // attempt marker says.
  //
  // Lock order is tickets → account → reservation, matching every other path
  // that touches these rows, so no deadlock is possible.

  async startGovernedPlannerRequest({
    ticketId,
    attempt,
    reservationId,
    // The hash of the attempt state this write expects to replace. Supplied by
    // the caller, exactly as the plain attempt writer requires, so a concurrent
    // writer cannot be silently overwritten.
    expectedAttemptStateHash = null,
    reservationEventType = 'ticket.economic_request_started',
    attemptEventType = 'ticket.structured_planning_attempt_requested'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const reservation = positiveSafeInteger(reservationId, 'reservationId');
    // Normalized before the transaction so a malformed attempt never takes locks.
    const nextAttempt = normalizePlanningAttempt(attempt, { expectedTicketId: id });
    if (nextAttempt.state !== 'request_started') {
      throw new TypeError('startGovernedPlannerRequest requires a request_started attempt');
    }
    const governed = nextAttempt.governedExecution;
    if (!governed) {
      throw new TypeError('a governed planner start requires captured governedExecution state');
    }
    if (governed.reservationId !== reservation) {
      throw new TypeError('the attempt names a different reservation than the one being started');
    }

    const execute = async connection => {
      await connection.query(
        `SELECT id FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`, [id]);

      // The one-winner transition. Exactly one caller leaves this with a row.
      const won = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')}
         SET state = 'request_started',
             started_at = clock_timestamp(),
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND state = 'reserved' AND ticket_id = $2
         RETURNING *`,
        [reservation, id]
      );
      if (won.rowCount === 0) {
        const current = await connection.query(
          `SELECT state FROM ${this.table('economic_request_reservations')} WHERE id = $1`,
          [reservation]);
        const error = new Error(current.rowCount === 0
          ? `economic reservation ${reservation} was not found`
          : `economic reservation ${reservation} is ${current.rows[0].state} and cannot start`);
        error.code = current.rowCount === 0
          ? 'ECONOMIC_RESERVATION_NOT_FOUND'
          : 'ECONOMIC_REQUEST_ALREADY_STARTED';
        error.detail = { state: current.rowCount === 0 ? null : current.rows[0].state };
        // A loser dispatches nothing.
        error.dispatchAuthorized = false;
        error.startedNow = false;
        throw error;
      }

      const row = this._economicReservationFromRow(won.rows[0]);

      // Everything the winner is about to send is re-verified from storage.
      // A caller cannot influence any of it: no bytes, route or authority are
      // parameters to this method.
      const actual = hashSerializedRequest(row.serializedRequest);
      if (actual !== row.exactRequestHash) {
        const error = new Error(
          `persisted request bytes for reservation ${reservation} do not match the reserved hash`);
        error.code = 'ECONOMIC_REQUEST_BYTES_CORRUPT';
        throw error;
      }
      for (const [field, expected] of [
        ['economicAuthorityHash', governed.economicAuthorityHash],
        ['exactRequestHash', governed.exactRequestHash],
        ['preparedRequestHash', governed.preparedRequestHash]
      ]) {
        if (row[field] !== expected) {
          const error = new Error(
            `reservation ${reservation} ${field} disagrees with the captured attempt`);
          error.code = 'GOVERNED_ATTEMPT_RESERVATION_MISMATCH';
          throw error;
        }
      }
      if (row.preparedRequest.dispatchTarget !== governed.dispatchTarget ||
          row.preparedRequest.targetEvidenceHash !== governed.targetEvidenceHash) {
        const error = new Error(
          `reservation ${reservation} targets a route the captured attempt did not authorize`);
        error.code = 'GOVERNED_ATTEMPT_ROUTE_MISMATCH';
        throw error;
      }

      // Same transaction: the attempt marker.
      const written = await this.writeStructuredAllocationPlanningAttempt({
        ticketId: id,
        attempt: nextAttempt,
        expectedAttemptStateHash,
        eventType: attemptEventType,
        eventPayload: {
          reservationId: reservation,
          exactRequestHash: row.exactRequestHash
        }
      }, { client: connection });

      await this._appendEvent(connection, {
        type: reservationEventType,
        ticketId: id,
        payload: {
          reservationId: reservation,
          role: row.role,
          modelRequestOrdinal: row.modelRequestOrdinal,
          exactRequestHash: row.exactRequestHash,
          reservedMaxMicroUsd: row.reservedMaxMicroUsd,
          planningAttemptId: row.planningAttemptId
        }
      });

      return {
        // The two facts a caller needs, and the only two that authorize a call.
        startedNow: true,
        dispatchAuthorized: true,
        reservation: row,
        // The authorized bytes, from storage.
        serializedRequest: row.serializedRequest,
        attempt: written.attempt
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // The mirror of the start: one transaction, both durable response markers.
  // Neither may exist without the other, so no recovery path can conclude "the
  // response is missing" for a request whose response was in fact received.
  async persistGovernedPlannerResponse({
    ticketId,
    attempt,
    reservationId,
    responseIdentity,
    responseHash,
    expectedAttemptStateHash = null,
    reservationEventType = 'ticket.economic_response_persisted',
    attemptEventType = 'ticket.structured_planning_attempt_responded'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const reservation = positiveSafeInteger(reservationId, 'reservationId');
    const identity = requiredString(responseIdentity, 'responseIdentity');
    if (typeof responseHash !== 'string' || !/^[0-9a-f]{64}$/.test(responseHash)) {
      throw new TypeError('responseHash must be a lowercase SHA-256');
    }
    const nextAttempt = normalizePlanningAttempt(attempt, { expectedTicketId: id });
    if (nextAttempt.state !== 'response_received') {
      throw new TypeError('persistGovernedPlannerResponse requires a response_received attempt');
    }

    const execute = async connection => {
      await connection.query(
        `SELECT id FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`, [id]);
      const updated = await connection.query(
        `UPDATE ${this.table('economic_request_reservations')}
         SET state = 'response_persisted',
             response_persisted_at = clock_timestamp(),
             response_identity = $2,
             response_hash = $3,
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND state = 'request_started' AND ticket_id = $4
         RETURNING *`,
        [reservation, identity, responseHash, id]
      );
      if (updated.rowCount === 0) {
        const current = await connection.query(
          `SELECT state, response_hash FROM ${this.table('economic_request_reservations')}
           WHERE id = $1`, [reservation]);
        // Already persisted with the SAME response is idempotent success, not a
        // conflict: a retried orchestration must not be told the response is
        // missing and must never trigger another provider call.
        if (current.rowCount === 1 &&
            current.rows[0].state !== 'request_started' &&
            current.rows[0].response_hash === responseHash) {
          return { reservation: await this.getEconomicReservation(reservation,
            { client: connection }), attempt: nextAttempt, alreadyPersisted: true };
        }
        const error = new Error(
          `economic reservation ${reservation} was not awaiting a response`);
        error.code = 'ECONOMIC_RESERVATION_STATE_CONFLICT';
        error.detail = { state: current.rowCount === 0 ? null : current.rows[0].state };
        throw error;
      }

      const written = await this.writeStructuredAllocationPlanningAttempt({
        ticketId: id,
        attempt: nextAttempt,
        expectedAttemptStateHash,
        eventType: attemptEventType,
        eventPayload: { reservationId: reservation, responseIdentity: identity }
      }, { client: connection });

      await this._appendEvent(connection, {
        type: reservationEventType,
        ticketId: id,
        payload: {
          reservationId: reservation,
          responseIdentity: identity,
          responseHash
        }
      });

      return {
        reservation: this._economicReservationFromRow(updated.rows[0]),
        attempt: written.attempt,
        alreadyPersisted: false
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }


  // ── Governed structured leaf authority (Tranche 4) ─────────────────────────
  //
  // Captures one routing decision and one economic authority per sibling Run,
  // admits the single shared worker-role account, and returns one complete
  // envelope per draft. Every refusal throws, which aborts the enclosing
  // admission transaction, so the guarantee is structural:
  //
  //   all Runs with complete governed authority, or zero Runs
  //
  // No provider-request reservation is created here. Admission establishes what
  // a Run MAY spend; reservations are created per request, later.
  async _captureGovernedLeafAuthority(connection, {
    ticketId, drafts, runIds, capture, capturedAt
  }) {
    if (!capture) {
      const error = new Error(
        'structured leaf admission requires governed leaf capture; ungoverned ' +
        'structured leaf admission was removed by the Tranche 4 cutover');
      error.code = 'GOVERNED_LEAF_CAPTURE_REQUIRED';
      throw error;
    }
    const source = capture && capture.policySource;
    if (!capture.progressControlPolicy) {
      const error = new Error(
        'governed leaf admission requires a captured progress-control policy');
      error.code = 'GOVERNED_LEAF_PROGRESS_POLICY_REQUIRED';
      throw error;
    }
    if (!source || !source.roleRoutingPolicy || !source.economicPolicy ||
        !source.pricingCatalog) {
      const error = new Error(
        'governed leaf admission requires all three closed policy documents');
      error.code = 'GOVERNED_LEAF_POLICY_INCOMPLETE';
      throw error;
    }
    // EVERY governed leaf Run must admit at least one execution-evaluable fact.
    //
    // A Run with none can never be credited with verified progress, so its
    // consecutive no-progress streak would grow on every window until it stopped
    // with `verified_progress_exhausted` — a persisted reason that would be
    // false about the work it actually did. Refusing here, before the Run is
    // ever schedulable, is the truthful alternative to admitting it and
    // explaining it wrongly later.
    //
    // This is deliberately an ADMISSION decision, made once, rather than a
    // judgement repeated during execution.
    for (const draft of drafts) {
      assertGovernedRunHasEligibleFacts(
        draft.run || draft,
        `allocation item ${draft.allocationItemId}`);
    }
    if (source.economicPolicy.role !== GOVERNED_WORKER_ROLE) {
      const error = new Error(
        `governed leaf admission requires a ${GOVERNED_WORKER_ROLE} economic policy`);
      error.code = 'GOVERNED_LEAF_ROLE_MISMATCH';
      throw error;
    }

    // The shared account, admitted once for the whole Ticket and role. Sibling
    // Runs contend against this one balance; a conflicting policy refuses here
    // rather than letting half the siblings be governed by a different budget.
    const account = await this.admitTicketEconomicAccount({
      ticketId,
      role: GOVERNED_WORKER_ROLE,
      economicPolicy: source.economicPolicy
    }, { client: connection });
    const economicAccountId = Number(account.account.id);

    const envelopes = [];
    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index];
      const runId = runIds[index];
      // The worker principal is the agent the ITEM admitted. It is never
      // replaced, and the routing policy must authorize that exact agent's
      // route rather than a default or the planner's.
      const assignedAgentId = positiveSafeInteger(
        draft.item.assignedAgentId, 'allocationItem.assignedAgentId');

      const routingDecision = buildRoleRoutingDecision({
        policy: source.roleRoutingPolicy,
        role: GOVERNED_WORKER_ROLE,
        ticketId,
        subjectKind: 'run',
        subjectId: runId,
        actingAgentId: assignedAgentId,
        decidedAt: capturedAt
      });
      const economicAuthority = buildEconomicAuthority({
        policy: source.economicPolicy,
        routingDecision,
        pricingCatalog: source.pricingCatalog,
        capturedAt
      });
      envelopes.push(buildGovernedRunAuthority({
        policySource: source,
        routingDecision,
        economicAuthority,
        // The exact entry the authority priced against, from the CAPTURED
        // catalog — never resolved from current configuration later.
        pricingEntry: findPricingEntry(source.pricingCatalog, {
          provider: economicAuthority.provider,
          model: economicAuthority.dispatchTarget,
          adapterId: economicAuthority.adapterId
        }),
        // Tranche 5 tolerance, captured before the Run becomes visible.
        progressControlPolicy: capture.progressControlPolicy,
        economicAccountId,
        ticketId,
        runId,
        allocationItemId: positiveSafeInteger(
          draft.allocationItemId, 'leafDraft.allocationItemId'),
        capturedAt
      }));
    }
    return envelopes;
  }

  // ── Durable next-request ordinal and reservation (Tranche 4) ───────────────
  //
  // THE ORDINAL IS DERIVED, NOT REMEMBERED. A process-local counter cannot
  // survive a restart, and a mutable `nextOrdinal` column would be a second
  // source of truth that could disagree with the reservations it counts. The
  // reservation ledger already proves the sequence, so the next ordinal is read
  // from it under the Run lock:
  //
  //   existing reservations for this Run + locked Run identity -> next ordinal
  //
  // This method contacts NO provider. It ends with a committed reservation and
  // the exact bytes that a later dispatch will send.
  async prepareAndReserveNextGovernedRunRequest({
    runId,
    // The canonical model-request source identity — the SAME string the runtime
    // budget ledger uses (`model-request:<evidence slot>`). It is required, not
    // optional: without it two concurrent orchestrations of one logical request
    // become ordinals 1 and 2, which is the defect this parameter closes.
    logicalSourceIdentity,
    canonicalBody,
    endpointIdentity,
    runtimeModelRequestMaximum = null,
    runtimeModelRequestsUsed = null,
    // Maps durable receipt identities to the declared-work facts they newly
    // satisfy. Derived from typed evidence by the caller; never a model claim.
    satisfiedFactIdentitiesByReceiptId = null,
    preparedAt = null
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const logicalIdentity = requiredString(
      logicalSourceIdentity, 'logicalSourceIdentity', 512);
    if (!canonicalBody || typeof canonicalBody !== 'object') {
      throw new TypeError('canonicalBody must be the caller-built worker request body');
    }

    const execute = async connection => {
      // Lock the RUN first, so its captured authority cannot be mutated while a
      // request is prepared against it.
      //
      // ORDERING NOTE, because it is easy to misread this lock as the one that
      // makes ordinals safe: it is not. `reserveEconomicRequest` takes the
      // shared account row lock, and THAT is what serializes two concurrent
      // preparations for the same Run — the second waits there, then reads the
      // ledger the first committed. Removing this Run lock alone does not
      // duplicate an ordinal; removing the account lock does. The account lock
      // is taken here too, before any balance or ledger is read, so the lock
      // order is runs -> account everywhere and no deadlock is possible.
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`, [id]);
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const run = runFromRow(runResult.rows[0]);

      // A structured leaf Run with COMPLETE authority, or nothing. A partial
      // envelope throws here and never degrades to the historical path.
      if (!run.leafRunBinding) {
        const error = new Error(`run ${id} is not a structured leaf run`);
        error.code = 'GOVERNED_RUN_NOT_LEAF';
        throw error;
      }
      const classified = classifyRunGovernance(run);
      if (!classified.governed) {
        const error = new Error(`run ${id} carries no governed authority`);
        error.code = 'GOVERNED_RUN_AUTHORITY_ABSENT';
        throw error;
      }
      const authority = normalizeGovernedRunAuthority(run.governedExecution, {
        expectedRunId: id,
        expectedTicketId: run.ticketId,
        expectedAllocationItemId: run.leafRunBinding.allocationItemId
      });

      // The shared worker account, locked before any balance or ledger is read.
      // This is the lock that orders sibling Runs against one budget.
      const accountRow = await this._lockedEconomicAccount(connection, {
        ticketId: run.ticketId, role: GOVERNED_WORKER_ROLE
      });
      if (Number(accountRow.id) !== authority.economicAccountId) {
        const error = new Error(
          `run ${id} names economic account ${authority.economicAccountId}, ` +
          `but ticket ${run.ticketId} holds ${accountRow.id}`);
        error.code = 'GOVERNED_RUN_ACCOUNT_MISMATCH';
        throw error;
      }

      // ── Tranche 5 pre-reservation gate ────────────────────────────────
      //
      // Evaluated BEFORE the ordinal is derived and long before anything is
      // reserved or dispatched, so a blocked Run creates no economic
      // reservation, no model-request budget charge and makes no provider call.
      //
      // The whole evaluation reads durable rows under the Run lock already held
      // above, so repeating it on identical facts yields an identical decision
      // and nothing is written twice.
      // A Run already carrying a persisted block never re-evaluates. Reading
      // the stored decision rather than re-deriving one is what stops a receipt
      // committed after the cutoff from changing why the Run was blocked, and
      // what makes restart unable to grant another request.
      if (run.governedProgressBlock) {
        const stored = normalizeGovernedProgressBlock(run.governedProgressBlock);
        const error = new Error(
          `run ${id} is blocked by a persisted progress decision: ${stored.reason}`);
        error.code = 'GOVERNED_RUN_PROGRESS_BLOCKED';
        error.detail = {
          reason: stored.reason,
          blockHash: stored.blockHash,
          churnDecisionHash: stored.churnDecisionHash,
          progressProjectionHash: stored.verifiedProgressProjectionHash,
          progressPolicyHash: stored.progressPolicyHash,
          cutoff: stored.cutoff,
          persisted: true
        };
        throw error;
      }

      const progressPolicy = run.governedExecution &&
        run.governedExecution.progressControlPolicy
        ? run.governedExecution.progressControlPolicy
        : null;
      if (progressPolicy) {
        const progressState = await this.readGovernedRunProgressState(id,
          { client: connection });
        // DERIVED HERE, from canonical evidence under this evaluation's own
        // cutoff. The caller's parameter is accepted only from contract tests;
        // production passes nothing and cannot assert progress.
        //
        // An incomplete or conflicting evidence set THROWS rather than
        // producing an empty mapping — "we did not record it" and "it did not
        // advance" must not stop a Run for the same reason.
        const transitions = await this.readGovernedFactTransitions(id, {
          client: connection, cutoff: progressState.cutoff, run
        });
        const evaluated = evaluateGovernedRunProgress({
          progressState,
          declaredWorkSnapshot: run.declaredWorkSnapshot,
          progressPolicy,
          allocationPlanId: run.allocationPlanId || null,
          allocationItemId: run.allocationItemId || null,
          satisfiedFactIdentitiesByReceiptId: transitions
            ? transitions.satisfiedFactIdentitiesByReceiptId
            : (satisfiedFactIdentitiesByReceiptId || new Map())
        });
        if (!permitsGovernedRequest(evaluated.decision)) {
          // RETURNED, not thrown. Throwing here would roll back this
          // transaction and discard the very block we need to persist, so the
          // refusal is carried out and committed by the caller below.
          return {
            progressBlockRequired: {
              cutoff: progressState.cutoff,
              projection: evaluated.projection,
              churnDecision: evaluated.decision
            }
          };
        }
      }

      // The durable ledger for THIS Run. Released reservations are excluded
      // from the count but not from the ordinal sequence: an ordinal is spent
      // once, so a released request never lets a later one reuse its number.
      const ledger = await connection.query(
        `SELECT id, model_request_ordinal, state, logical_source_identity
           FROM ${this.table('economic_request_reservations')}
          WHERE run_id = $1 AND ticket_id = $2 AND role = $3
          ORDER BY model_request_ordinal`,
        [id, run.ticketId, GOVERNED_WORKER_ROLE]
      );
      // IDEMPOTENT RE-REPORT. If this exact logical request already has a
      // reservation, that IS the answer. Deriving a new ordinal here would turn
      // duplicate execution of one request into two charged requests.
      const existing = ledger.rows.find(
        row => row.logical_source_identity === logicalIdentity);
      if (existing) {
        const reservation = this._economicReservationFromRow(
          (await connection.query(
            `SELECT * FROM ${this.table('economic_request_reservations')} WHERE id = $1`,
            [existing.id])).rows[0]);
        return {
          reservation,
          preparedRequest: reservation.preparedRequest,
          ordinal: reservation.modelRequestOrdinal,
          run,
          // The caller must be able to tell "I reserved this" from "this was
          // already reserved", because only the former should log a new request.
          alreadyReserved: true
        };
      }

      const ordinals = ledger.rows.map(row => Number(row.model_request_ordinal));
      const nextOrdinal = ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1;
      const chargeableRequests = ledger.rows.filter(row => row.state !== 'released').length;

      // Economic ceiling.
      const maximumRequests = authority.economicAuthority.maximumProviderRequests;
      if (nextOrdinal > maximumRequests) {
        const error = new Error(
          `run ${id} request ${nextOrdinal} exceeds the ${maximumRequests} ` +
          'provider requests its economic authority permits');
        error.code = 'GOVERNED_RUN_REQUEST_COUNT_EXCEEDED';
        error.detail = { nextOrdinal, maximumRequests };
        throw error;
      }

      // The existing runtime model-request budget. Economic governance
      // SUPPLEMENTS it; both must admit the request, and neither is bypassed.
      if (runtimeModelRequestMaximum !== null) {
        const runtimeMaximum = positiveSafeInteger(
          runtimeModelRequestMaximum, 'runtimeModelRequestMaximum');
        if (nextOrdinal > runtimeMaximum) {
          const error = new Error(
            `run ${id} request ${nextOrdinal} exceeds the runtime maximum of ` +
            `${runtimeMaximum} model requests`);
          error.code = 'GOVERNED_RUN_RUNTIME_BUDGET_EXCEEDED';
          error.detail = { nextOrdinal, runtimeMaximum };
          throw error;
        }
      }
      // A disagreement between the two ledgers is an integrity problem, not
      // something to quietly reconcile: one of them has lost a request.
      if (runtimeModelRequestsUsed !== null &&
          Number(runtimeModelRequestsUsed) !== chargeableRequests) {
        const error = new Error(
          `run ${id} runtime model-request count ${runtimeModelRequestsUsed} disagrees ` +
          `with ${chargeableRequests} durable economic reservations`);
        error.code = 'GOVERNED_RUN_BUDGET_DISAGREEMENT';
        error.detail = { runtimeModelRequestsUsed, chargeableRequests };
        throw error;
      }

      // The request is built from the CAPTURED route: the model, the cap and
      // the truncation mode all come from the authority, never from the agent
      // row or the environment.
      // The durable captured entry, read from the Run's own envelope. No
      // current catalog is consulted anywhere in this transaction.
      const pricingEntry = authority.pricingEntry;
      const prepared = prepareGovernedProviderRequest({
        routingDecision: authority.routingDecision,
        economicAuthority: authority.economicAuthority,
        modelRequestOrdinal: nextOrdinal,
        endpointIdentity,
        canonicalBody,
        authorizedOutputTokens: authority.economicAuthority.maximumOutputTokensPerRequest,
        truncationMode: 'disabled',
        pricingEntryHash: authority.economicAuthority.pricingEntryHash,
        maximumLiabilityMicroUsd: authority.economicAuthority.maximumPerRequestMicroUsd,
        preparedAt: preparedAt || isoTimestamp(
          (await connection.query('SELECT clock_timestamp() AS ts')).rows[0].ts,
          'governed run request clock')
      });

      const reservation = await this.reserveEconomicRequest({
        preparedRequest: prepared,
        economicAuthority: authority.economicAuthority,
        pricingEntry,
        logicalSourceIdentity: logicalIdentity
      }, { client: connection });

      return {
        reservation, preparedRequest: prepared, ordinal: nextOrdinal, run,
        alreadyReserved: false
      };
    };

    // The evaluation transaction commits (or rolls back) cleanly first; only
    // then is the block persisted, in its own transaction, and the refusal
    // raised. Persisting inside the evaluation would lose the block to the
    // rollback that the refusal causes.
    const outcome = client ? await execute(client) : await this.withTransaction(execute);
    if (outcome && outcome.progressBlockRequired) {
      const { cutoff, projection, churnDecision } = outcome.progressBlockRequired;
      const persisted = await this.blockGovernedRunForProgressDecision({
        runId: id, cutoff, projection, churnDecision
      });
      const error = new Error(
        `run ${id} is blocked by verified-progress controls: ${churnDecision.reason}`);
      error.code = 'GOVERNED_RUN_PROGRESS_BLOCKED';
      error.detail = {
        reason: churnDecision.reason,
        blockHash: persisted.block.blockHash,
        churnDecisionHash: churnDecision.decisionHash,
        progressProjectionHash: projection.projectionHash,
        progressPolicyHash: churnDecision.progressPolicyHash,
        cutoff: persisted.block.cutoff,
        persisted: true
      };
      throw error;
    }
    return outcome;
  }


  // ── Tranche 5: durable verified-progress reconstruction ────────────────────
  //
  // WHY AN EXPLICIT CUTOFF IS REQUIRED — and why the Run row lock is not enough.
  //
  // `withTransaction` issues a bare `BEGIN`, so this runs at PostgreSQL's
  // default READ COMMITTED: every statement takes a FRESH snapshot. Reading
  // reservations, receipts and budget charges in separate queries can therefore
  // observe a mixed pre-/post-commit state.
  //
  // The Run row lock serializes evaluators, but it does not block receipt
  // inserts: those write through `targetOperationClientStorage.getStore() ||
  // this.pool`, an independent connection that never touches the `runs` row. So
  // evidence really can commit underneath a multi-query evaluation.
  //
  // The fix is a CUTOFF captured in a single statement — one snapshot, one
  // consistent set of maxima — after which every query filters to `id <=
  // cutoff`. Facts committing later are invisible to this evaluation and belong
  // to the next explicitly created one. Because the cutoff is a document, a
  // restart that reuses it reconstructs exactly the same membership rather than
  // taking a fresh maximum.
  //
  // A window is therefore a half-open interval over that sequence:
  //
  //   window(ordinal N) = receipts recorded at or after reservation N started,
  //                       and before reservation N+1 started
  //
  // Each receipt falls in exactly one window; a restart replays the same rows in
  // the same order and reconstructs the same intervals; and two processes cannot
  // disagree because they cannot both hold the lock.
  //
  // NOTHING HERE IS PROCESS-LOCAL. That is the point: the counters this replaces
  // reset on recovery, which is precisely what pending decision A3 records.
  async readGovernedRunProgressState(runId, {
    client = null, cutoff: explicitCutoff = null, forUpdate = true
  } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      // The Run row lock. It both serializes evaluators and fixes the cutoff.
      //
      // `forUpdate: false` is for READ-ONLY PROJECTION ONLY. A projection that
      // took a write lock on every governed Run of a Ticket would serialize
      // page loads against the execution gate and hold those locks for the
      // whole read. It does not need the lock: it decides nothing, and the
      // cutoff is still captured in a single statement, so the rows it reads
      // are still a mutually consistent set. Every DECIDING caller keeps the
      // lock, which is the default.
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1` +
        (forUpdate ? ' FOR UPDATE' : ''), [id]);
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const run = runFromRow(runResult.rows[0]);

      // The immutable first-execution epoch, from the append-only event log.
      const epochRow = await connection.query(
        `SELECT min(ts) AS epoch_at FROM ${this.table('events')}
          WHERE run_id = $1 AND type = 'run.lease_acquired'`,
        [id]
      );

      // ONE statement, ONE snapshot: the cutoff maxima are mutually consistent.
      // Taking them in separate queries would reintroduce the mixed-state
      // problem this exists to solve.
      const cutoffRow = await connection.query(
        `SELECT
           COALESCE((SELECT max(id) FROM ${this.table('operation_receipts')}
                      WHERE run_id = $1), 0)::bigint AS receipt_cutoff,
           COALESCE((SELECT max(id) FROM ${this.table('economic_request_reservations')}
                      WHERE run_id = $1), 0)::bigint AS reservation_cutoff,
           COALESCE((SELECT max(id) FROM ${this.table('run_budget_charges')}
                      WHERE run_id = $1), 0)::bigint AS budget_cutoff,
           COALESCE((SELECT max(id) FROM ${this.table('governed_postcondition_evidence')}
                      WHERE run_id = $1), 0)::bigint AS evidence_cutoff,
           clock_timestamp() AS evaluated_at`,
        [id]
      );
      // THE EVALUATION INSTANT comes from the DATABASE clock, captured in the
      // SAME statement and snapshot as the three maxima above.
      //
      // Not Date.now(): the process clock is unshared, unverifiable and
      // resettable, so a duration bound derived from it could be moved simply
      // by restarting on a differently-skewed host. The epoch is already a
      // database-stamped event; measuring elapsed time between two readings of
      // the SAME clock is the only comparison that means anything.
      //
      // clock_timestamp() rather than now(): now() is the transaction start
      // time and would be identical for two evaluations inside one
      // transaction, understating elapsed execution time.
      //
      // A supplied cutoff is REUSED WHOLE, including its evaluatedAt. That is
      // what makes replaying a stored block reproduce the identical decision
      // instead of a fresh one that merely resembles it.
      const cutoff = explicitCutoff || {
        receiptCutoff: Number(cutoffRow.rows[0].receipt_cutoff),
        reservationCutoff: Number(cutoffRow.rows[0].reservation_cutoff),
        budgetCutoff: Number(cutoffRow.rows[0].budget_cutoff),
        postconditionEvidenceCutoff: Number(cutoffRow.rows[0].evidence_cutoff),
        evaluatedAt: isoTimestamp(cutoffRow.rows[0].evaluated_at,
          'governed progress evaluation instant')
      };

      // Ordered governed request windows for this Run.
      const reservations = await connection.query(
        `SELECT id, model_request_ordinal, logical_source_identity, state,
                started_at, created_at, settled_micro_usd, response_hash
           FROM ${this.table('economic_request_reservations')}
          WHERE run_id = $1 AND role = $2 AND id <= $3
          ORDER BY model_request_ordinal`,
        [id, GOVERNED_WORKER_ROLE, cutoff.reservationCutoff]
      );

      // Ordered durable operation receipts. `id` is monotonic within the Run
      // because of the single-writer guarantee above.
      const receipts = await connection.query(
        `SELECT id, operation, outcome, workspace_path, mutation_fingerprint,
                artifact_path, recorded_at
           FROM ${this.table('operation_receipts')}
          WHERE run_id = $1 AND id <= $2
          ORDER BY id`,
        [id, cutoff.receiptCutoff]
      );

      // Durable runtime-budget consumption. Reused, never duplicated.
      //
      // `source_identity` is selected because it is also the RESPONSE-DELIVERY
      // boundary — see `deliveredToExecution` below. It is the same string the
      // economic reservation stores as `logical_source_identity`, so no join,
      // no new column and no new cutoff dimension is required to learn whether
      // a window's answer ever reached execution.
      const charges = await connection.query(
        `SELECT dimension, source_identity, state, reserved_amount, committed_amount
           FROM ${this.table('run_budget_charges')}
          WHERE run_id = $1 AND id <= $2`,
        [id, cutoff.budgetCutoff]
      );

      // ── WHICH WINDOWS' ANSWERS ACTUALLY REACHED EXECUTION ────────────────
      //
      // A durable response proves the provider answered. It does NOT prove the
      // runtime ever handed that answer to the worker — and those are different
      // facts whenever a required write between them fails.
      //
      // The model-request budget charge is committed in exactly one place:
      // `dispatchGovernedLeafModelRequest`, after the orchestration returns
      // `received` or `reused_durable_response` and immediately before the
      // response envelope is returned to the worker loop. It is reserved before
      // transport and committed only there, under the SAME logical source
      // identity the economic reservation carries. So a committed
      // `model_request` charge is the durable statement "this window's answer
      // was delivered to execution", and it exists for a turn that proposed no
      // actions at all — which is what keeps ordinary churn countable.
      //
      // Read under the EXISTING `budgetCutoff`, so the cutoff shape, and
      // therefore every stored block hash, is unchanged.
      //
      // OBSERVABLE, OR NOT AT ALL — and the difference is never guessed.
      // `runtimeBudgetController` is a no-op for a Run carrying no runtime
      // budget snapshot, so such a Run has no `model_request` charge rows for
      // ANY window. Reading that absence as "nothing was ever delivered" would
      // silently disable churn control for those Runs, which is the fail-OPEN
      // direction and strictly worse than the defect this fixes. So delivery is
      // reported as UNOBSERVABLE (null) rather than false, and the evaluator
      // falls back to the durable-response rule for that Run. Only an explicit
      // false — a Run whose budget ledger is in use and whose window was never
      // committed — withholds churn eligibility.
      const modelRequestCharges = charges.rows
        .filter(row => row.dimension === 'model_request');
      const deliveryObservable = modelRequestCharges.length > 0;
      const deliveredToExecution = new Set(modelRequestCharges
        .filter(row => row.state === 'committed')
        .map(row => row.source_identity));

      const settledMicroUsd = reservations.rows.reduce(
        (total, row) => total + Number(row.settled_micro_usd || 0), 0);
      const budgetChargedUnits = charges.rows.reduce(
        (total, row) => total + Number(row.committed_amount || 0), 0);

      // The evaluation cutoff: the highest receipt id visible under the lock.
      // A later evaluation takes a new cutoff explicitly; it never re-reads an
      // old one and gets a different answer.
      // The captured receipt cutoff IS the source cutoff. It is the document a
      // restart reuses, not a fresh maximum recomputed later.
      const sourceCutoff = cutoff.receiptCutoff;

      return {
        run,
        // Cumulative totals, reconstructed entirely from durable rows.
        cumulativeResources: {
          providerRequests: reservations.rows.filter(r => r.state !== 'released').length,
          durableOperations: receipts.rowCount,
          settledMicroUsd,
          budgetChargedUnits
        },
        // THE EXECUTION EPOCH — the FIRST time this Run actually began
        // executing, which is neither of the two obvious candidates.
        //
        // NOT `runs.started_at`: `recoverExpiredRun` sets it to NULL on lease
        // expiry and the next claim re-stamps it, so it measures the latest
        // ATTEMPT. A Run recovering N times would receive N wall-clock budgets —
        // the defect pending decision A3 records.
        //
        // NOT `governedExecution.capturedAt` either: that is stamped during leaf
        // admission, and Runs are created `pending`. A Run waiting hours in the
        // scheduler queue would have that wait counted as execution duration.
        // Immutable, but measuring the wrong thing.
        //
        // The earliest `run.lease_acquired` event IS first execution start. The
        // event is appended inside the claim transaction, the event log is
        // append-only and hash-chained, and no event exists before the first
        // claim — so the epoch is absent while queued, set exactly once, and
        // unrewritable by recovery, retry preparation or status transitions. A
        // genuinely new retry Run has its own events and its own epoch.
        executionEpochAt: epochRow.rows.length > 0 && epochRow.rows[0].epoch_at
          ? isoTimestamp(epochRow.rows[0].epoch_at, 'run execution epoch')
          : null,
        // Retained for diagnostics only. Never used as duration authority.
        latestAttemptStartedAt: run.startedAt,
        reservations: reservations.rows.map(row => ({
          reservationId: Number(row.id),
          modelRequestOrdinal: Number(row.model_request_ordinal),
          logicalSourceIdentity: row.logical_source_identity,
          state: row.state,
          // A DURABLE RESPONSE IS WHAT COMPLETES A REQUEST WINDOW. Carried here
          // because progress accounting must distinguish a request that was
          // answered from one that was merely authorized: only the first can be
          // said to have made, or not made, progress.
          hasDurableResponse: Boolean(row.response_hash),
          // AND WHETHER THAT ANSWER REACHED EXECUTION. A response that is
          // durable but was never delivered to the worker has not had the
          // chance to advance the work either, so it is not a no-progress
          // window. TRUE, FALSE, or NULL when this Run's budget ledger cannot
          // answer the question at all. See `deliveredToExecution` above.
          responseDeliveredToExecution: deliveryObservable
            ? deliveredToExecution.has(row.logical_source_identity)
            : null,
          startedAt: row.started_at,
          createdAt: row.created_at
        })),
        receipts: receipts.rows.map(row => ({
          receiptId: Number(row.id),
          operation: row.operation,
          outcome: row.outcome,
          workspacePath: row.workspace_path,
          mutationFingerprint: row.mutation_fingerprint,
          artifactPath: row.artifact_path,
          recordedAt: row.recorded_at
        })),
        // Bound so a caller can persist it with the decision and reuse it.
        cutoff,
        sourceCutoff
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }


  // ── Tranche 5: persist a cutoff-bound progress block ───────────────────────
  //
  // A churn decision that lives only as a thrown exception is re-derived on
  // every restart from whatever rows exist then — so a receipt committed after
  // the stop could silently change WHY the Run was blocked. Persisting the
  // block with its exact cutoff makes the decision a historical fact.
  //
  // The caller cannot supply merely a reason: the block is rebuilt here from
  // the projection and decision, and refuses unless the decision is `blocked`.
  async blockGovernedRunForProgressDecision({
    runId,
    cutoff,
    projection,
    churnDecision,
    siblingDependency = null,
    eventType = 'run.progress_blocked'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');

    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`, [id]);
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const run = runFromRow(runResult.rows[0]);

      // Complete governed structured-leaf authority, revalidated under the lock.
      const classified = classifyRunGovernance(run);
      if (!classified.governed) {
        const error = new Error(`run ${id} is not a governed structured leaf run`);
        error.code = 'GOVERNED_RUN_AUTHORITY_ABSENT';
        throw error;
      }
      const policy = classified.authority.progressControlPolicy;

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const candidate = buildGovernedProgressBlock({
        ticketId: run.ticketId,
        runId: id,
        allocationPlanId: run.allocationPlanId || null,
        allocationItemId: run.allocationItemId || null,
        progressPolicyHash: policy.policyHash,
        cutoff,
        verifiedProgressProjectionHash: projection.projectionHash,
        churnDecision,
        executionEpochAt: (await this.readGovernedRunProgressState(id,
          { client: connection, cutoff })).executionEpochAt,
        siblingDependency,
        blockedAt: isoTimestamp(clock.rows[0].ts, 'progress block clock')
      });

      // IDEMPOTENT. Identical authority re-reports the stored block and writes
      // nothing; different authority refuses rather than overwriting the
      // decision that actually stopped the Run.
      const existing = run.governedProgressBlock || null;
      if (existing) {
        const stored = assertBlockAuthorityMatches(existing, candidate);
        return { block: stored, alreadyBlocked: true, run };
      }

      const nextBody = { ...run, governedProgressBlock: candidate };
      delete nextBody.id;
      delete nextBody.currentPhase;
      await connection.query(
        `UPDATE ${this.table('runs')}
            SET body = $2::jsonb, revision = revision + 1, updated_at = clock_timestamp()
          WHERE id = $1`,
        [id, JSON.stringify(nextBody)]
      );

      // One event, in the same transaction as the state change. Identities and
      // hashes only — no request bytes, no credentials.
      await this._appendEvent(connection, {
        type: eventType,
        ticketId: run.ticketId,
        runId: id,
        payload: {
          reason: candidate.reason,
          blockHash: candidate.blockHash,
          churnDecisionHash: candidate.churnDecisionHash,
          verifiedProgressProjectionHash: candidate.verifiedProgressProjectionHash,
          progressPolicyHash: candidate.progressPolicyHash,
          cutoff: candidate.cutoff,
          consecutiveNoProgressWindows: candidate.consecutiveNoProgressWindows
        }
      });

      return { block: candidate, alreadyBlocked: false, run };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Reads a stored block WITHOUT capturing fresh maxima. A Run that is already
  // blocked stays blocked for the reason it was blocked, whatever has committed
  // since.
  async readGovernedProgressBlock(runId, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const result = await connection.query(
        `SELECT body FROM ${this.table('runs')} WHERE id = $1`, [id]);
      if (result.rowCount === 0) return null;
      const stored = result.rows[0].body && result.rows[0].body.governedProgressBlock;
      return stored ? normalizeGovernedProgressBlock(stored) : null;
    };
    return client ? execute(client) : this.withTransaction(execute);
  }


  // ── Tranche 5: canonical governed postcondition evidence ───────────────────
  //
  // The append-only record that a NAMED admitted declared-work fact was
  // deterministically evaluated against a NAMED committed operation receipt.
  // This is the only thing verified progress may be credited from.
  //
  // The verdict is not the caller's to assert: the contract accepts only a
  // canonical evaluator verdict object and derives `satisfied` from it, so a
  // model claim, an operation success or a caller-supplied boolean cannot
  // become evidence.
  async appendGovernedPostconditionEvidence({ evidence }, { client = null } = {}) {
    const record = normalizeGovernedPostconditionEvidence(evidence);
    const execute = async connection => {
      // A BASELINE precedes every governed request and every receipt, so there
      // is no batch to validate against. The contract has already refused any
      // baseline carrying a request, step, anchor or count.
      const isBaseline = record.evaluationKind === 'baseline';
      if (!isBaseline) {
      // REQUEST IDENTITY IMPLICATION.
      //
      // The governed leaf request slot is a pure function of the execution step
      // (`agent:<step>:provider`), and both ledgers enforce uniqueness on the
      // resulting identity — run_budget_charges_identity, and migration 034's
      // reservation index. So (run_id, batch_step_id) already names exactly one
      // governed request window, which is why migration 036's uniqueness rule
      // does not need the source identity in the index.
      //
      // That implication is ENFORCED rather than assumed. A row whose stated
      // request identity does not match its own batch step would make the index
      // and the record disagree about which window the evaluation belongs to,
      // and the index would silently win.
      const impliedSource = `model-request:agent:${record.batchStepId}:provider`;
      if (record.requestSourceIdentity !== impliedSource) {
        const error = new Error(
          `evidence names request ${record.requestSourceIdentity}, but batch step ` +
          `${record.batchStepId} implies ${impliedSource}`);
        error.code = 'GOVERNED_POSTCONDITION_EVIDENCE_REQUEST_IDENTITY_MISMATCH';
        throw error;
      }

      // BOUNDARY VALIDATION, relationally — never by comparing identifiers.
      //
      // `operation_receipts.id` is global, so concurrent Runs interleave
      // numerically and a receipt id range proves nothing about membership. The
      // batch is (run_id, step_id); the anchor must belong to THAT batch, and
      // the count must match how many of the batch's receipts actually
      // committed at or before it.
      if (record.throughOperationReceiptId !== null) {
        const anchor = await connection.query(
          `SELECT run_id, ticket_id, step_id FROM ${this.table('operation_receipts')}
            WHERE id = $1`, [record.throughOperationReceiptId]);
        if (anchor.rowCount === 0) {
          const error = new Error(
            `operation receipt ${record.throughOperationReceiptId} does not exist`);
          error.code = 'GOVERNED_POSTCONDITION_EVIDENCE_RECEIPT_MISSING';
          throw error;
        }
        const row = anchor.rows[0];
        if (Number(row.run_id) !== record.runId ||
            Number(row.ticket_id) !== record.ticketId) {
          const error = new Error(
            `operation receipt ${record.throughOperationReceiptId} belongs to another run`);
          error.code = 'GOVERNED_POSTCONDITION_EVIDENCE_FOREIGN_RECEIPT';
          throw error;
        }
        // The anchor must be IN the batch it claims to bound. An anchor from a
        // different step is a cross-window boundary: the evaluation would be
        // attributed to an observation window it did not happen in.
        if (String(row.step_id) !== String(record.batchStepId)) {
          const error = new Error(
            `operation receipt ${record.throughOperationReceiptId} belongs to step ` +
            `${row.step_id}, not the evaluated batch ${record.batchStepId}`);
          error.code = 'GOVERNED_POSTCONDITION_EVIDENCE_CROSS_WINDOW_BOUNDARY';
          throw error;
        }
        // The count must describe the batch's own committed receipts, so it
        // cannot be inflated to imply an evaluation stood on work it did not.
        const committed = await connection.query(
          `SELECT count(*)::int AS c FROM ${this.table('operation_receipts')}
            WHERE run_id = $1 AND step_id = $2 AND id <= $3`,
          [record.runId, record.batchStepId, record.throughOperationReceiptId]);
        if (Number(committed.rows[0].c) !== record.evaluatedReceiptCount) {
          const error = new Error(
            `evaluated receipt count ${record.evaluatedReceiptCount} disagrees with ` +
            `${committed.rows[0].c} committed receipts in batch ${record.batchStepId}`);
          error.code = 'GOVERNED_POSTCONDITION_EVIDENCE_BOUNDARY_DISAGREEMENT';
          throw error;
        }
      }
      }

      // IDEMPOTENT. Recovery re-evaluating the same fact against the same
      // receipt must not append a second row. A genuine conflict — same pair,
      // different verdict — is refused by the contract rather than kept as a
      // second opinion.
      const inserted = await connection.query(
        `INSERT INTO ${this.table('governed_postcondition_evidence')}
           (ticket_id, run_id, allocation_plan_id, allocation_item_id,
            governed_authority_hash, completion_authority_hash,
            declared_fact_identity, criterion_hash, criterion_type,
            evaluator_identity, evaluator_version, through_operation_receipt_id,
            logical_source_identity, observed_evidence, satisfied, evidence_hash,
            request_source_identity, batch_step_id, evaluated_receipt_count,
            evaluation_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,
                 $17,$18,$19,$20)
         ON CONFLICT DO NOTHING
         RETURNING id, evaluated_at`,
        [record.ticketId, record.runId, record.allocationPlanId,
          record.allocationItemId, record.governedAuthorityHash,
          record.completionAuthorityHash, record.declaredFactIdentity,
          record.criterionHash, record.criterionType, record.evaluatorIdentity,
          record.evaluatorVersion, record.throughOperationReceiptId,
          record.logicalSourceIdentity, JSON.stringify(record.observedEvidence),
          record.satisfied, record.evidenceHash,
          record.requestSourceIdentity, record.batchStepId,
          record.evaluatedReceiptCount, record.evaluationKind]
      );
      if (inserted.rowCount === 1) {
        return {
          evidence: record,
          evidenceId: Number(inserted.rows[0].id),
          evaluatedAt: isoTimestamp(inserted.rows[0].evaluated_at,
            'governed postcondition evidence instant'),
          alreadyRecorded: false
        };
      }
      const existingRow = await connection.query(
        record.evaluationKind === 'baseline'
          ? `SELECT * FROM ${this.table('governed_postcondition_evidence')}
              WHERE run_id = $1 AND declared_fact_identity = $2
                AND evaluation_kind = 'baseline'`
          : `SELECT * FROM ${this.table('governed_postcondition_evidence')}
              WHERE run_id = $1 AND batch_step_id = $2
                AND declared_fact_identity = $3`,
        record.evaluationKind === 'baseline'
          ? [record.runId, record.declaredFactIdentity]
          : [record.runId, record.batchStepId, record.declaredFactIdentity]
      );
      const stored = this._governedPostconditionEvidenceFromRow(existingRow.rows[0]);
      assertEvidenceAgrees(stored, record);
      return {
        evidence: stored,
        evidenceId: Number(existingRow.rows[0].id),
        evaluatedAt: isoTimestamp(existingRow.rows[0].evaluated_at,
          'governed postcondition evidence instant'),
        alreadyRecorded: true
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  _governedPostconditionEvidenceFromRow(row) {
    return {
      version: 1,
      ticketId: Number(row.ticket_id),
      runId: Number(row.run_id),
      allocationPlanId: Number(row.allocation_plan_id),
      allocationItemId: Number(row.allocation_item_id),
      governedAuthorityHash: row.governed_authority_hash,
      completionAuthorityHash: row.completion_authority_hash,
      declaredFactIdentity: row.declared_fact_identity,
      criterionHash: row.criterion_hash,
      criterionType: row.criterion_type,
      evaluatorIdentity: row.evaluator_identity,
      evaluatorVersion: Number(row.evaluator_version),
      evaluationKind: row.evaluation_kind,
      throughOperationReceiptId: row.through_operation_receipt_id === null
        ? null
        : Number(row.through_operation_receipt_id),
      requestSourceIdentity: row.request_source_identity,
      batchStepId: row.batch_step_id,
      evaluatedReceiptCount: Number(row.evaluated_receipt_count),
      logicalSourceIdentity: row.logical_source_identity,
      observedEvidence: row.observed_evidence,
      satisfied: row.satisfied,
      evidenceHash: row.evidence_hash
    };
  }

  // The canonical satisfied-fact derivation. STORE-OWNED: no orchestration
  // caller may supply satisfied facts, because a caller-supplied mapping is
  // exactly the hole that let production credit nothing while looking wired.
  async readGovernedFactTransitions(runId, {
    client = null, cutoff = null, run = null
  } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const target = run || runFromRow((await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1`, [id])).rows[0]);
      const eligibleFacts = eligibleExecutionFacts(target);
      if (eligibleFacts.length === 0) return null;

      const evidenceRows = await this.readGovernedPostconditionEvidence(id, {
        client: connection,
        cutoff: cutoff === null ? null : cutoff.postconditionEvidenceCutoff
      });

      // Batches that committed receipts owed a complete evidence set. Read from
      // durable receipts, bounded by the SAME receipt cutoff the rest of the
      // evaluation uses, so a batch whose receipts fall outside this evaluation
      // is not held to have owed evidence inside it.
      const batchRows = await connection.query(
        cutoff === null
          ? `SELECT DISTINCT step_id FROM ${this.table('operation_receipts')}
              WHERE run_id = $1 AND step_id IS NOT NULL`
          : `SELECT DISTINCT step_id FROM ${this.table('operation_receipts')}
              WHERE run_id = $1 AND step_id IS NOT NULL AND id <= $2`,
        cutoff === null ? [id] : [id, cutoff.receiptCutoff]
      );
      return buildGovernedSatisfiedFactTransitions({
        runId: id,
        allocationItemId: target.allocationItemId || null,
        eligibleFacts,
        evidenceRows,
        receiptBearingBatches: batchRows.rows.map(row => String(row.step_id))
      });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ATOMIC FACT SET. Every eligible fact of one evaluation commits together, or
  // none does.
  //
  // Appending per fact in its own transaction made a partial evidence set
  // reachable: a crash between facts would leave a batch that looks evaluated
  // but is missing verdicts, and a missing verdict is indistinguishable from
  // "this fact did not advance" unless completeness is guaranteed. Completeness
  // is what lets a later reader treat absence as an integrity problem rather
  // than as no progress.
  async appendGovernedPostconditionEvidenceSet({ evidenceRecords }, { client = null } = {}) {
    const records = Array.isArray(evidenceRecords) ? evidenceRecords : [];
    if (records.length === 0) return { appended: [], evidenceIds: [] };
    const execute = async connection => {
      const appended = [];
      for (const evidence of records) {
        appended.push(await this.appendGovernedPostconditionEvidence(
          { evidence }, { client: connection }));
      }
      return {
        appended,
        evidenceIds: appended.map(entry => entry.evidenceId)
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ── Tranche 5: the committed operation batch, read from durable receipts ──
  //
  // Built from persisted `operation_receipts`, never from model action claims:
  // the model says what it intended, the receipts say what committed, and only
  // the second can anchor evidence.
  //
  // Membership is (run_id, step_id). It is emphatically NOT a receipt id range —
  // `operation_receipts.id` is global, so a concurrent Run's receipts land
  // numerically inside any range this batch spans. Selecting by step excludes
  // them by construction rather than by arithmetic.
  async readGovernedCommittedOperationBatch({
    ticketId, runId, batchStepId, requestSourceIdentity
  }, { client = null } = {}) {
    const run = positiveSafeInteger(runId, 'runId');
    const ticket = positiveSafeInteger(ticketId, 'ticketId');
    const step = requiredString(String(batchStepId), 'batchStepId', 128);
    const source = requiredString(requestSourceIdentity, 'requestSourceIdentity', 512);
    // The governed leaf request identity is a pure function of the step. A
    // caller naming a different request for this step is describing a window
    // that does not exist.
    const implied = `model-request:agent:${step}:provider`;
    if (source !== implied) {
      const error = new Error(
        `request ${source} does not match the identity implied by step ${step}`);
      error.code = 'GOVERNED_BATCH_REQUEST_IDENTITY_MISMATCH';
      throw error;
    }
    const execute = async connection => {
      const rows = await connection.query(
        `SELECT id, operation, outcome, workspace_path, mutation_fingerprint
           FROM ${this.table('operation_receipts')}
          WHERE run_id = $1 AND ticket_id = $2 AND step_id = $3
          ORDER BY id`,
        [run, ticket, step]
      );
      const receipts = rows.rows.map(row => ({
        receiptId: Number(row.id),
        operation: row.operation,
        outcome: row.outcome,
        workspacePath: row.workspace_path,
        mutationFingerprint: row.mutation_fingerprint
      }));
      const inspection = new Set(['listDirectory', 'readFile']);
      const committedOperationReceiptIds = receipts.map(r => r.receiptId);
      return deepFreeze({
        requestSourceIdentity: source,
        batchStepId: step,
        // ORDERING ANCHOR ONLY: the greatest committed receipt of this batch.
        // Null when the batch committed nothing, because borrowing an older
        // receipt would attach the evaluation to work it did not follow.
        throughOperationReceiptId: committedOperationReceiptIds.length === 0
          ? null
          : committedOperationReceiptIds[committedOperationReceiptIds.length - 1],
        evaluatedReceiptCount: committedOperationReceiptIds.length,
        committedOperationReceiptIds: deepFreeze(committedOperationReceiptIds),
        // Outcome classes stay distinguishable: a failed operation is not a
        // mutation, and an inspection is not progress.
        successfulMutationReceiptIds: deepFreeze(receipts
          .filter(r => r.outcome === 'succeeded' && !inspection.has(r.operation))
          .map(r => r.receiptId)),
        inspectionReceiptIds: deepFreeze(receipts
          .filter(r => inspection.has(r.operation)).map(r => r.receiptId)),
        failedOrRefusedReceiptIds: deepFreeze(receipts
          .filter(r => r.outcome === 'failed' || r.outcome === 'refused')
          .map(r => r.receiptId))
      });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Ordered, cutoff-bounded read. Evidence committed after the cutoff is
  // invisible to this evaluation by construction.
  async readGovernedPostconditionEvidence(runId, {
    client = null, cutoff = null
  } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const bound = cutoff === null || cutoff === undefined
      ? null
      : positiveSafeInteger(cutoff + 1, 'postconditionEvidenceCutoff') - 1;
    const execute = async connection => {
      const rows = bound === null
        ? await connection.query(
          `SELECT * FROM ${this.table('governed_postcondition_evidence')}
            WHERE run_id = $1 ORDER BY id`, [id])
        : await connection.query(
          `SELECT * FROM ${this.table('governed_postcondition_evidence')}
            WHERE run_id = $1 AND id <= $2 ORDER BY id`, [id, bound]);
      return rows.rows.map(row => ({
        evidenceId: Number(row.id),
        evaluatedAt: isoTimestamp(row.evaluated_at, 'evidence instant'),
        ...this._governedPostconditionEvidenceFromRow(row)
      }));
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ── Tranche 5: the canonical read-only progress projection ─────────────────
  //
  // Assembles the durable inputs the projection seam needs and hands them over.
  // It DECIDES NOTHING. The evaluation it performs is the same deterministic
  // replay the gate performs, over the same durable rows, so a page and the
  // gate cannot disagree — and where a block already exists, the STORED cutoff
  // is replayed rather than a fresh one taken, so merely looking at a blocked
  // Run cannot change what it says.
  async readRunVerifiedProgressProjection(runId, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1`, [id]);
      if (runResult.rowCount === 0) return null;
      const run = runFromRow(runResult.rows[0]);

      // Not a governed structured leaf Run: the seam returns null and every
      // other execution family is untouched.
      if (!run.governedExecution && !run.leafRunBinding) {
        return projectRunVerifiedProgress({ run });
      }
      const storedBlock = run.governedProgressBlock
        ? normalizeGovernedProgressBlock(run.governedProgressBlock)
        : null;

      // A blocked Run is replayed through its OWN stored cutoff. Reading must
      // never capture a later evaluation instant for a decision already made.
      const progressState = await this.readGovernedRunProgressState(id, {
        client: connection,
        cutoff: storedBlock ? storedBlock.cutoff : null,
        // Read-only: no write lock, so viewing a Ticket never blocks execution.
        forUpdate: false
      });

      let evaluation = null;
      if (run.governedExecution && run.governedExecution.progressControlPolicy) {
        evaluation = evaluateGovernedRunProgress({
          progressState,
          declaredWorkSnapshot: run.declaredWorkSnapshot,
          progressPolicy: run.governedExecution.progressControlPolicy,
          allocationPlanId: run.allocationPlanId || null,
          allocationItemId: run.allocationItemId || null,
          siblingDependencyBlocked: Boolean(
            storedBlock && storedBlock.siblingDependency)
        });
      }
      return projectRunVerifiedProgress({
        run, evaluation, storedBlock, progressState
      });
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Ticket level. Projects each governed structured leaf Run through the seam
  // above and summarizes; it computes no ticket-level fact of its own.
  async readTicketVerifiedProgressProjection(ticketId, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const execute = async connection => {
      const rows = await connection.query(
        `SELECT id FROM ${this.table('runs')} WHERE ticket_id = $1 ORDER BY id`,
        [id]
      );
      const projections = [];
      for (const row of rows.rows) {
        const projection = await this.readRunVerifiedProgressProjection(
          Number(row.id), { client: connection });
        if (projection) projections.push(projection);
      }
      return projectTicketVerifiedProgress(projections);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // ── Tranche 5: sibling-read authority ──────────────────────────────────────
  //
  // Structured siblings are authority-wise INDEPENDENT — there is no dependency
  // graph, no ordering and no waiting. But independence cuts both ways: a leaf
  // Run reading another item's owned output is consuming work whose truthfulness
  // nobody has established yet. So the read is refused rather than served, and
  // the Run stops. It does not wait for the sibling, because waiting would be a
  // dependency by another name.
  //
  // Completion is proven ONLY through the Tranche 3 item disposition and its
  // supporting completion decision. A terminal Run is not a completed item; a
  // status without its decision is not proof; a file existing on disk is not
  // proof at all.
  //
  // Returns one closed outcome. It never returns prose and never accepts a
  // caller-supplied sibling status.
  async resolveGovernedSiblingReadAuthority({ runId, requestedPath }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const execute = async connection => {
      const runResult = await connection.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1`, [id]);
      if (runResult.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      // Reconstruction already enforces the governed pairing rule, so a
      // malformed structured Run cannot reach either branch below.
      const run = runFromRow(runResult.rows[0]);
      const classified = classifyRunGovernance(run);
      if (!classified.governed || !run.leafRunBinding) {
        return { outcome: 'unrelated_scope', sibling: null };
      }

      // The requested path, through the CANONICAL normalizer. No second matcher.
      const normalizedPath = normalizeWorkspaceOwnershipPath(
        normalizeWorkspaceRelativePath(requestedPath || ''));
      if (!normalizedPath) return { outcome: 'unrelated_scope', sibling: null };

      const plan = await this.getAllocationPlanForTicket(run.ticketId);
      if (!plan || plan.version !== 2 || !Array.isArray(plan.items)) {
        return { outcome: 'unrelated_scope', sibling: null };
      }
      const ownItemId = run.leafRunBinding.allocationItemId;

      // Own scope first: a Run reading inside its own admitted ownership is
      // never a sibling dependency.
      const ownItem = plan.items.find(item => item.allocationItemId === ownItemId) || null;
      if (ownItem && isPathInsideOwnedOutputPaths(normalizedPath, ownItem.ownedOutputPaths)) {
        return { outcome: 'own_scope', sibling: null };
      }

      // Sibling scopes. Admitted ownership is non-overlapping, so at most one
      // item can match; more than one means the durable authority is corrupt
      // and the read fails closed rather than picking a winner.
      const matches = plan.items.filter(item =>
        item.allocationItemId !== ownItemId &&
        isPathInsideOwnedOutputPaths(normalizedPath, item.ownedOutputPaths));
      if (matches.length === 0) {
        // Neither own nor sibling-owned: ordinary shared or unrelated path, and
        // the existing workspace read authority decides. A shared parent
        // directory is NOT treated as a dependency merely because a
        // sibling-owned descendant exists beneath it.
        return { outcome: 'unrelated_scope', sibling: null };
      }
      if (matches.length > 1) {
        return {
          outcome: 'integrity_conflict',
          sibling: null,
          detail: `path ${normalizedPath} matches ${matches.length} sibling scopes`
        };
      }

      const siblingItem = matches[0];
      // The canonical Tranche 3 location: reconciliation persists the aggregate
      // decision, and its `items` are the per-item dispositions. Reading a
      // field that does not exist would make EVERY sibling look decision-absent
      // — blocking correctly by accident while making a genuinely completed
      // sibling permanently unreadable.
      const dispositions = plan.aggregateDecision &&
        Array.isArray(plan.aggregateDecision.items)
        ? plan.aggregateDecision.items
        : [];
      const disposition = dispositions.find(
        entry => entry.allocationItemId === siblingItem.allocationItemId) || null;

      const sibling = {
        requestedPath: normalizedPath,
        siblingAllocationItemId: siblingItem.allocationItemId,
        siblingRunId: disposition && disposition.runId ? Number(disposition.runId) : null,
        siblingOwnedScope: (siblingItem.ownedOutputPaths || []).join(','),
        siblingCompletionDecisionHash: null,
        siblingCompletionState: 'unresolved'
      };

      if (!disposition) {
        // The sibling has produced no durable disposition at all.
        sibling.siblingCompletionState = 'decision_absent';
        return { outcome: 'blocked_incomplete_sibling', sibling };
      }
      if (disposition.itemStatus !== 'completed') {
        sibling.siblingCompletionState = 'incomplete';
        return { outcome: 'blocked_incomplete_sibling', sibling };
      }
      if (!disposition.completionDecisionHash) {
        // Completed status WITHOUT its supporting decision. A terminal Run is
        // not a completed item, and status alone is not proof.
        //
        // ATTRIBUTION: this branch is UNREACHABLE through canonical authority.
        // `normalizeAggregatePlanDecision` refuses a completed item that has no
        // supporting decision hash, and `getAllocationPlanForTicket` normalizes
        // on read, so a tampered row cannot deliver this state either. The
        // invariant is owned by the leaf-run contract; the guard is retained as
        // fail-closed depth, and is deliberately NOT backed by a manufactured
        // fixture that would misattribute ownership to this resolver.
        sibling.siblingCompletionState = 'terminal_without_decision';
        return { outcome: 'blocked_incomplete_sibling', sibling };
      }

      return {
        outcome: 'verified_completed_sibling',
        sibling: {
          ...sibling,
          siblingCompletionState: 'unresolved',
          siblingCompletionDecisionHash: disposition.completionDecisionHash
        }
      };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  // Refuses a governed sibling read by persisting the CANONICAL block first and
  // only then raising. The block is committed in its own transaction, so the
  // refusal cannot roll it back — the trap the churn gate already exposed.
  async blockGovernedRunForSiblingRead({ runId, sibling }) {
    const id = positiveSafeInteger(runId, 'runId');

    // ALREADY BLOCKED: read the stored decision and stop. No fresh cutoff is
    // captured and no re-evaluation is performed.
    //
    // This is not merely an optimization. Since Tranche 5 began capturing the
    // evaluation instant from the database clock, re-evaluating a blocked Run
    // would produce a later `evaluatedAt`, hence a different projection hash,
    // hence a block that conflicts with the one already on record — turning a
    // repeated refusal into a spurious integrity failure. The block IS the
    // decision of record; re-deriving it is what would be wrong.
    //
    // Tamper detection is not weakened: `readGovernedProgressBlock` normalizes
    // through the block contract, which recomputes and verifies `blockHash`
    // over the stored fields. That contract, not this method, owns the
    // invariant that a stored block cannot be edited.
    const stored = await this.readGovernedProgressBlock(id);
    if (stored) {
      return {
        block: stored,
        alreadyBlocked: true,
        run: await this.getRun(id)
      };
    }

    const progressState = await this.readGovernedRunProgressState(id);
    const run = progressState.run;
    const policy = run.governedExecution.progressControlPolicy;
    const evaluated = evaluateGovernedRunProgress({
      progressState,
      declaredWorkSnapshot: run.declaredWorkSnapshot,
      progressPolicy: policy,
      allocationPlanId: run.allocationPlanId || null,
      allocationItemId: run.allocationItemId || null,
      // The coordination fact, supplied by the resolver above rather than by a
      // caller asserting it.
      siblingDependencyBlocked: true
    });
    return this.blockGovernedRunForProgressDecision({
      runId: id,
      cutoff: progressState.cutoff,
      projection: evaluated.projection,
      churnDecision: evaluated.decision,
      siblingDependency: sibling
    });
  }

  async createRun(record, { client = null, reservedId = null } = {}) {
    const run = this.assertJsonRecord(record, 'run');
    assertRunDeclaredCompletionAuthority(run, 'run declared/completion authority');
    assertRunGovernedExecutionPairing(run, 'run governed execution');
    const status = requiredString(run.status || 'pending', 'run.status');
    if (status !== 'pending') throw new TypeError('New runs must start pending');
    const currentPhase = normalizeRunPhase(run.currentPhase || 'planning', 'run.currentPhase');
    if (currentPhase !== 'planning') throw new TypeError('New runs must start in planning phase');
    // Run identity is NEVER caller data. A record carrying `id` is refused
    // outright rather than silently ignored, so no HTTP body, import payload,
    // recovery record, fixture or model-controlled value can select an identity
    // by smuggling a field into a run draft.
    if (Object.prototype.hasOwnProperty.call(run, 'id')) {
      const error = new TypeError('run.id must not be supplied by a caller');
      error.code = 'RUN_IDENTITY_NOT_CALLER_OWNED';
      throw error;
    }
    // The one exception is transaction-scoped and arrives through the OPTIONS
    // argument, never through the record: structured leaf admission reserves
    // identities from the runs sequence and must insert exactly those, because
    // the immutable leaf binding hashes the Run ID and has to be complete at
    // INSERT rather than patched in afterwards. Requiring an explicit client
    // confines it to a caller already composing inside one transaction.
    const reserved = reservedId === null || reservedId === undefined
      ? null
      : positiveSafeInteger(reservedId, 'reservedId');
    if (reserved !== null && client === null) {
      throw new TypeError('A reserved run identity requires the reserving transaction');
    }
    const runBody = { ...run };
    delete runBody.currentPhase;
    delete runBody.id;
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
      const result = reserved === null
        ? await connection.query(
          `INSERT INTO ${this.table('runs')}
            (ticket_id, agent_id, status, execution_mode, lease_owner, lease_expires_at,
             last_heartbeat_at, current_phase, body)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           RETURNING *`,
          values
        )
        : await connection.query(
          `INSERT INTO ${this.table('runs')}
            (ticket_id, agent_id, status, execution_mode, lease_owner, lease_expires_at,
             last_heartbeat_at, current_phase, body, id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           RETURNING *`,
          [...values, reserved]
        );
      const created = runFromRow(result.rows[0]);
      if (reserved !== null && created.id !== reserved) {
        throw new TypeError('run.id was not honoured by the runs table');
      }
      return created;
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async createRunsAndStartTicket({
    ticketId,
    runDrafts,
    afterTerminalRunId = null,
    runEventPayload = () => ({}),
    ticketEventPayload = {}
  }, { client = null, reservedRunIds = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    if (!Array.isArray(runDrafts) || runDrafts.length === 0) {
      throw new TypeError('runDrafts must be a non-empty array');
    }
    // Reserved identities are call-site authority, not draft content, and are
    // only meaningful to a caller composing inside the transaction that reserved
    // them. Every ordinary caller omits this and gets sequence-assigned ids.
    const reserved = reservedRunIds === null || reservedRunIds === undefined
      ? null
      : reservedRunIds.map((value, index) =>
        positiveSafeInteger(value, `reservedRunIds[${index}]`));
    if (reserved !== null) {
      if (client === null) {
        throw new TypeError('Reserved run identities require the reserving transaction');
      }
      if (reserved.length !== runDrafts.length) {
        throw new TypeError('reservedRunIds must supply one identity per run draft');
      }
      if (new Set(reserved).size !== reserved.length) {
        throw new TypeError('reservedRunIds must not repeat an identity');
      }
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
      const budgetSnapshots = drafts.map((run, index) => {
        if (!Object.prototype.hasOwnProperty.call(run, 'runtimeBudgetSnapshot') ||
            run.runtimeBudgetSnapshot === null) {
          return null;
        }
        try {
          return normalizeRuntimeBudgetSnapshot(run.runtimeBudgetSnapshot);
        } catch (error) {
          error.message = `runDrafts[${index}].runtimeBudgetSnapshot: ${error.message}`;
          throw error;
        }
      });
      drafts.forEach((run, index) => {
        if (run.declaredWorkSnapshot !== null &&
            run.declaredWorkSnapshot !== undefined) {
          assertRunDeclaredCompletionAuthority(
            run,
            `runDrafts[${index}] declared/completion authority`
          );
          return;
        }
        if (run.completionAuthoritySnapshot !== null &&
            run.completionAuthoritySnapshot !== undefined) {
          try {
            normalizeCompletionAuthoritySnapshot(run.completionAuthoritySnapshot);
          } catch (error) {
            error.message = `runDrafts[${index}].completionAuthoritySnapshot: ${error.message}`;
            throw error;
          }
        }
      });
      const effectiveAttemptLimits = budgetSnapshots
        .filter(Boolean)
        .map(snapshot => snapshot.maxAttempts);
      if (effectiveAttemptLimits.length > 0) {
        if (effectiveAttemptLimits.length !== drafts.length ||
            new Set(effectiveAttemptLimits).size !== 1) {
          const error = new Error(
            'One run-admission batch must use one complete effective attempt limit'
          );
          error.code = 'RUN_BUDGET_SNAPSHOT_INVALID';
          throw error;
        }
        const admitted = await connection.query(
          `SELECT COUNT(DISTINCT CASE
             WHEN NULLIF(body->>'allocationPlanId', '') IS NOT NULL
               THEN 'allocation:' || (body->>'allocationPlanId')
             ELSE 'run:' || id::text
           END)::bigint AS count
           FROM ${this.table('runs')}
           WHERE ticket_id = $1`,
          [id]
        );
        const admittedCount = Number(admitted.rows[0].count);
        const requestedAttemptCount = new Set(drafts.map((draft, index) => {
          const allocationPlanId = draft && draft.allocationPlanId;
          return allocationPlanId === null || allocationPlanId === undefined ||
            String(allocationPlanId).trim() === ''
            ? `draft:${index}`
            : `allocation:${String(allocationPlanId).trim()}`;
        })).size;
        const maxAttempts = effectiveAttemptLimits[0];
        if (!Number.isSafeInteger(admittedCount) ||
            admittedCount + requestedAttemptCount > maxAttempts) {
          const error = new Error(
            `Ticket ${id} cannot admit ${requestedAttemptCount} attempt(s): ` +
            `${admittedCount} of ${maxAttempts} attempts already exist`
          );
          error.code = 'RUN_BUDGET_EXHAUSTED';
          error.failureKind = 'runtime_budget_exhausted';
          error.details = {
            dimension: 'attempt',
            currentCommittedUsage: admittedCount,
            requestedAmount: requestedAttemptCount,
            limit: maxAttempts
          };
          throw error;
        }
      }
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
      for (const [draftIndex, draft] of drafts.entries()) {
        const run = await this.createRun({
          ...draft,
          status: 'pending',
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          ticketOpenedAt: ticket.updatedAt,
          createdAt: now,
          updatedAt: now
        }, {
          client: connection,
          reservedId: reserved === null ? null : reserved[draftIndex]
        });
        runs.push(run);
        const payload = this.assertJsonRecord(runEventPayload(run), `run ${run.id} event payload`);
        events.push(await this._appendEvent(connection, {
          type: 'run.created',
          ticketId: id,
          runId: run.id,
          payload: { ...payload, status: run.status, createdAt: run.createdAt }
        }));
        if (run.runtimeBudgetSnapshot) {
          events.push(await this._appendEvent(connection, {
            type: 'budget.snapshot_created',
            ticketId: id,
            runId: run.id,
            payload: {
              budgetSnapshotHash: run.runtimeBudgetSnapshot.snapshotHash,
              version: run.runtimeBudgetSnapshot.version,
              runtimeLimitsRevision: run.runtimeBudgetSnapshot.runtimeLimitsRevision,
              executionPolicyHash: run.runtimeBudgetSnapshot.executionPolicyHash
            }
          }));
        }
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

  async _assertConfiguredAgentPlannerMembershipsRetained(client, agentId, groupIds) {
    const retained = new Set(groupIds);
    const result = await client.query(
      `SELECT id
       FROM ${this.table('access_groups')}
       WHERE planner_agent_id = $1
       ORDER BY id
       FOR UPDATE`,
      [agentId]
    );
    const removedPlannerGroup = result.rows
      .map(row => positiveSafeInteger(row.id, 'group.id'))
      .find(groupId => !retained.has(groupId));
    if (removedPlannerGroup !== undefined) {
      const error = new Error(
        `Agent ${agentId} is the designated planner for group ${removedPlannerGroup}; select another planner or clear it first`
      );
      error.code = 'GROUP_PLANNER_MEMBERSHIP_REQUIRED';
      throw error;
    }
  }

  async _replaceConfiguredAgentMemberships(client, agentId, groupIds, actor) {
    await this._assertConfiguredAgentPlannerMembershipsRetained(client, agentId, groupIds);
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
      await this._assertConfiguredAgentPlannerMembershipsRetained(client, id, []);
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
    assertStructuredAllocationAuthorityNotPatched(bodyPatch, 'ticket patch');
    assertStructuredAllocationPlanningAttemptNotPatched(bodyPatch, 'ticket patch');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      if (Object.prototype.hasOwnProperty.call(bodyPatch, 'objective')) {
        const currentResult = await connection.query(
          `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (currentResult.rowCount > 0) {
          const current = ticketFromRow(currentResult.rows[0]);
          if (current.structuredAllocationAuthority &&
              bodyPatch.objective !== current.objective) {
            const error = new Error(
              'Ticket objective cannot change after structured-allocation authority admission'
            );
            error.code = 'STRUCTURED_ALLOCATION_OBJECTIVE_IMMUTABLE';
            throw error;
          }
        }
      }
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

  // Reassign a ticket to a different principal (A21).
  //
  // WHY THIS IS A DEDICATED METHOD rather than a patch through transitionTicket.
  // `assignment_target_type` and `assignment_target_id` are COLUMNS, and
  // `ticketFromRow` reads them from the columns — so anything written into the JSON
  // `body` under those keys is shadowed and silently lost. transitionTicket updates
  // only `status` and `body`, which is correct for its eleven other callers: none of
  // them changes the assignment, and widening its UPDATE to touch the assignment
  // columns would make every status transition capable of moving a ticket between
  // principals. Reassignment gets its own writer instead.
  //
  // `assignmentMode` genuinely lives in the body, so this writes both surfaces in one
  // statement and they cannot diverge.
  //
  // The event AND the audit log are appended inside the same transaction as the
  // update. Evidence that a reassignment happened therefore commits with the
  // reassignment or not at all — a failure cannot leave a durable record claiming a
  // move that never landed, which is the defect this method exists to prevent.
  async reassignTicket({
    ticketId,
    expectedRevision,
    fromStatuses,
    assignmentTargetType,
    assignmentTargetId,
    assignmentMode,
    changedBy,
    eventType = 'ticket.updated',
    eventPayload = {},
    auditLogType = 'ticket:assignment_change'
  }, { client = null } = {}) {
    const id = positiveSafeInteger(ticketId, 'ticketId');
    const revision = positiveSafeInteger(expectedRevision, 'expectedRevision');
    const sources = normalizeStatuses(fromStatuses, TICKET_STATUSES, 'ticket source status');
    const targetType = requiredString(assignmentTargetType, 'assignmentTargetType');
    if (!['agent', 'group'].includes(targetType)) {
      throw new TypeError(`Unsupported assignment target type: ${targetType}`);
    }
    const targetId = positiveSafeInteger(assignmentTargetId, 'assignmentTargetId');
    const mode = requiredString(assignmentMode, 'assignmentMode');
    const actor = requiredString(changedBy, 'changedBy');
    const type = requiredString(eventType, 'eventType');
    const callerPayload = this.assertJsonRecord(eventPayload, 'eventPayload');

    const execute = async connection => {
      // Read the prior assignment inside the transaction so the audit record and the
      // update describe the same instant. Reading it from a caller-supplied snapshot
      // would let a concurrent writer make the "previous" value a lie.
      const currentResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (currentResult.rowCount === 0) {
        const error = new Error(`ticket ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const before = ticketFromRow(currentResult.rows[0]);
      const previousAssignment = {
        assignmentTargetType: before.assignmentTargetType,
        assignmentTargetId: before.assignmentTargetId,
        assignmentMode: before.assignmentMode || null
      };

      const clock = await connection.query('SELECT clock_timestamp() AS ts');
      const changedAt = isoTimestamp(clock.rows[0].ts, 'ticket assignment clock');
      const bodyPatch = { assignmentMode: mode, changedBy: actor, changedAt };

      const result = await connection.query(
        `WITH candidate AS (
           SELECT id
           FROM ${this.table('tickets')}
           WHERE id = $1 AND revision = $2 AND status = ANY($3::text[])
         ), updated AS (
           UPDATE ${this.table('tickets')} AS ticket
           SET assignment_target_type = $4,
               assignment_target_id = $5,
               body = ticket.body || $6::jsonb,
               revision = ticket.revision + 1,
               updated_at = clock_timestamp()
           FROM candidate
           WHERE ticket.id = candidate.id
           RETURNING ticket.*
         )
         SELECT * FROM updated`,
        [id, revision, sources, targetType, targetId, bodyPatch]
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
      const nextAssignment = {
        assignmentTargetType: ticket.assignmentTargetType,
        assignmentTargetId: ticket.assignmentTargetId,
        assignmentMode: ticket.assignmentMode || null
      };

      // Both records are built from the row that was actually written, so neither can
      // describe an assignment the ticket does not hold.
      const event = await this._appendEvent(connection, {
        type,
        ticketId: ticket.id,
        payload: {
          ...callerPayload,
          ...nextAssignment,
          changedBy: actor,
          previousAssignment,
          status: ticket.status,
          revision: ticket.revision,
          updatedAt: ticket.updatedAt
        }
      });

      const auditLog = await this._appendSystemLog(connection, {
        type: auditLogType,
        message: `Ticket #${ticket.id} assignment changed by ${actor}`,
        metadata: {
          ticketId: ticket.id,
          changedBy: actor,
          changedAt: ticket.changedAt,
          previousAssignment,
          nextAssignment
        }
      });

      return { ticket, event, auditLog, previousAssignment, nextAssignment };
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
      assertStructuredAllocationAuthorityNotPatched(bodyPatch, 'ticket patch');
      assertStructuredAllocationPlanningAttemptNotPatched(bodyPatch, 'ticket patch');
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
      // Lock order is allocation_plans -> runs -> tickets.
      //
      // Runs are still locked before the owning ticket. Required run evidence
      // takes the run row before its event insert obtains the ticket foreign-key
      // lock, so the former ticket-first order could deadlock operator
      // cancellation:
      //
      //   ticket projection  tickets FOR UPDATE -> runs FOR UPDATE
      //   process evidence   runs FOR KEY SHARE -> events(ticket FK)
      //
      // The allocation plan is taken FIRST because a planner-admitted v2 ticket
      // is reconciled inside this transaction, and leaf admission takes the same
      // three locks in the same order. Finding the plan needs the run's ticket,
      // so the run is read once WITHOUT a lock purely to route; every value that
      // decides anything is re-read under lock below.
      const routing = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1`,
        [id]
      );
      if (routing.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const leafPlan = await this._findLockedPlannerAdmittedPlan(
        connection,
        positiveSafeInteger(routing.rows[0].ticket_id, 'run.ticketId')
      );
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
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
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
      const ticketResult = await connection.query(
        `SELECT * FROM ${this.table('tickets')} WHERE id = $1 FOR UPDATE`,
        [run.ticketId]
      );
      if (ticketResult.rowCount === 0) {
        const error = new Error(`ticket ${run.ticketId} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const ticket = ticketFromRow(ticketResult.rows[0]);
      const decisionResult = await connection.query(
        `SELECT run_id, consequence
         FROM ${this.table('run_consequences')}
         WHERE run_id = ANY($1::bigint[])`,
        [batchRuns.map(item => item.id)]
      );
      const completionDecisionByRunId = new Map(decisionResult.rows.map(row => {
        const decision = row.consequence && row.consequence.completionDecision
          ? normalizeCompletionDecision(row.consequence.completionDecision)
          : null;
        return [positiveSafeInteger(row.run_id, 'runConsequence.runId'), decision];
      }));
      const projectedStatus = item => {
        if (!item.completionAuthoritySnapshot) return item.status;

        const decision = completionDecisionByRunId.get(item.id);

        // THE SHARED RULE, NOT A SECOND COPY OF IT. `evaluateRunCompletionEvidence`
        // owns the question "does this Run's claim need a decision, and is that
        // decision valid" for both allocation reconciliation and this
        // projection. The two callers still map the answer differently — a full
        // item disposition there, a projected status or refusal here — but they
        // no longer decide it separately, which is how they came to disagree.
        // THE EXPECTED AUTHORITY IS ALREADY IN HAND.
        //
        // This passed `null`, which the shared rule reads as "no opinion" so it
        // never reported `completion_authority_mismatch`. That rule exists for
        // a caller that genuinely holds no comparable hash — but this one does:
        // the guard above has just proved `item.completionAuthoritySnapshot`
        // exists, and allocation reconciliation compares against exactly this
        // field. A structured leaf could therefore present a decision built
        // against a DIFFERENT objective contract and be projected `completed`
        // by the Ticket while reconciliation called it a mismatch.
        //
        // A generic Run never reaches this line — the guard returns its status
        // first — so supplying the hash cannot make an unstructured Run fail
        // for lacking structured authority.
        const evidence = evaluateRunCompletionEvidence({
          runStatus: item.status,
          runId: item.id,
          runTicketId: item.ticketId,
          runCompletionAuthorityHash:
            item.completionAuthoritySnapshot.objectiveContractHash || null,
          decision: decision || null
        });
        if (evidence.result === 'not_applicable') {
          // A Run that never claimed success is truthfully itself.
          return item.status === 'interrupted' ? 'interrupted' : 'failed';
        }
        if (evidence.result !== 'valid') {
          const error = new Error(
            `Run ${item.id} cannot project its ticket: ${evidence.reason}`);
          error.code = 'COMPLETION_EVIDENCE_MISSING';
          error.completionEvidenceResult = evidence.result;
          error.completionEvidenceReason = evidence.reason;
          throw error;
        }
        if (decision.completionDisposition === 'completed') return 'completed';
        if (decision.completionDisposition === 'blocked') return 'blocked';
        return item.status === 'interrupted' ? 'interrupted' : 'failed';
      };
      const projectedBatchStatuses = batchRuns.map(projectedStatus);
      const projectedRunStatus = projectedStatus(run);
      const ownedScope = ticket.assignmentTargetType === 'group' &&
        ['allocated', 'dynamic'].includes(ticket.assignmentMode);
      let targetStatus = null;
      if (projectedRunStatus === 'interrupted') {
        if (ticket.status === 'in_progress' &&
            !batchRuns.some(item => ['pending', 'running'].includes(item.status))) {
          targetStatus = 'open';
        }
      } else if (!ownedScope) {
        targetStatus = projectedRunStatus;
      } else if (projectedRunStatus === 'blocked' || projectedBatchStatuses.includes('blocked')) {
        targetStatus = 'blocked';
      } else if (projectedRunStatus === 'failed' || projectedBatchStatuses.includes('failed')) {
        targetStatus = 'failed';
      } else if (batchRuns.length > 0 && projectedBatchStatuses.every(status => status === 'completed')) {
        targetStatus = 'completed';
      }

      // ── Tranche 3: the aggregate decision is the completion proof ──────────
      //
      // This method remains the ONE owner of the parent status mapping. For a
      // planner-admitted v2 plan it does not get to reach that mapping's
      // `completed` on its own evidence: the store-owned leaf derivation runs
      // here, in this transaction, and its persisted aggregate decision must
      // independently agree. The two are not parallel authorities — the leaf
      // derivation is strictly stronger (it also proves item-to-Run binding,
      // declared-work agreement, completion-authority agreement and
      // run-lifecycle agreement), so the aggregate is consumed as a gate rather
      // than re-mapped into a second status vocabulary.
      //
      // Reconciling HERE also removes every ordering obligation from callers: no
      // path can transition the Ticket first and persist the aggregate later,
      // and no crash can leave a completed parent with an absent aggregate.
      let leafDecision = null;
      let leafPlanId = null;
      if (leafPlan) {
        const reconciled = await this._reconcileLeafItemsLocked(connection, leafPlan);
        if (reconciled.reconciled) {
          leafDecision = reconciled.decision;
          leafPlanId = reconciled.plan.id;
        }
        // EVERY terminal parent outcome is gated, not just completion. Gating
        // only `completed` left the failure paths as parallel authorities: an
        // aggregate reporting `interrupted` because a decision was stale,
        // conflicting or evaluated against other completion authority could sit
        // beside a batch projection that independently reached `blocked` or
        // `failed`, and the parent terminalized on the weaker evidence.
        //
        // This does NOT re-map anything. The canonical logic above still chooses
        // blocked versus failed, and its choice is used verbatim; the aggregate
        // only decides whether ANY terminal outcome is provable yet.
        if (TERMINAL_TICKET_STATUSES.has(targetStatus)) {
          const provenTerminal = leafDecision !== null && (
            targetStatus === 'completed'
              ? leafDecision.aggregateStatus === 'completed'
              : leafDecision.aggregateStatus === 'failed'
          );
          // Absent, unpersisted or non-terminal proof all resolve the same way:
          // no terminal transition. `pending`, `running` and `interrupted` mean
          // the leaf set is unresolved, and an unresolved leaf set cannot end
          // the parent in any outcome. A malformed or hash-conflicting stored
          // aggregate never reaches here at all — allocationPlanFromRow and
          // normalizeAggregatePlanDecision reject it on read, aborting this
          // transaction before any transition.
          if (!provenTerminal) targetStatus = null;
        }
      }

      if (!targetStatus || ticket.status === targetStatus) {
        return {
          ticket,
          event: null,
          previousStatus: ticket.status,
          changed: false,
          aggregateDecision: leafDecision
        };
      }
      const patch = ['completed', 'failed', 'interrupted'].includes(targetStatus)
        ? { rerunMode: null }
        : {};
      const transitioned = await this.transitionTicket({
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        fromStatuses: [ticket.status],
        toStatus: targetStatus,
        patch,
        // The parent outcome names the plan and the exact aggregate decision that
        // authorized it, so a completed parent is traceable to its proof.
        eventPayload: leafDecision === null ? {} : {
          allocationPlanId: leafPlanId,
          planHash: leafDecision.planHash,
          aggregateStatus: leafDecision.aggregateStatus,
          aggregateDecisionHash: leafDecision.decisionHash
        }
      }, { client: connection });
      return { ...transitioned, changed: true, aggregateDecision: leafDecision };
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
    assertDeclaredWorkAuthorityNotPatched(requestedPatch, 'run patch');
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
    // A caller-supplied client means the CALLER owns the transaction: its earlier
    // statements are not ours to replay, so a retry here could re-run half a unit of
    // work. Only the self-owned transaction is safely replayable.
    if (client) return execute(client);
    return this._retryTransientTransaction(() => this.withTransaction(execute));
  }

  // Bounded retry for PostgreSQL's genuinely transient transaction conflicts. These
  // abort the whole transaction — nothing committed — so replaying appends the event
  // exactly once and cannot duplicate it.
  //
  // WHY THIS EXISTS. A deadlock is a routine condition PostgreSQL expects the loser to
  // retry. Without this, a single 40P01 propagates to the server's `appendEvent`, which
  // cannot classify it as request-scoped and therefore latches
  // `evidencePersistenceFailure`, stops both schedulers, and leaves every pending run
  // unleased until restart. One transient conflict took the whole deployment down.
  //
  // Deliberately NOT retried: statement timeout (57014) and connection failures, which
  // signal genuine overload or loss rather than a resolvable conflict — retrying those
  // compounds the problem. When retries are exhausted the original error is rethrown, so
  // a persistent inability to record evidence still fails closed exactly as before.
  async _retryTransientTransaction(run, { attempts = 4 } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        const code = error && error.code ? String(error.code) : null;
        if (attempt >= attempts || !RETRYABLE_TRANSACTION_CODES.has(code)) throw error;
        // Observable so callers can distinguish "no conflict arose" from "a conflict
        // arose and was absorbed". Without this the retry hides lock-ordering
        // regressions: the append still succeeds, so nothing reports that the ordering
        // guarantee was lost. Prevention and recovery are separate contracts.
        this.transientConflictRetries += 1;
        // Exponential backoff with jitter so two conflicting writers do not retry in
        // lockstep and immediately re-conflict.
        const backoffMs = Math.min(120, 8 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 12);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }

  async _appendEvent(client, event) {
    const runId = nullablePositiveSafeInteger(event && event.runId, 'event.runId');
    let chain = null;
    if (runId !== null) {
      // Take the run row BEFORE the chain tip, in the same mode the events foreign key
      // will need anyway. Without this the two evidence paths acquire the same pair of
      // locks in opposite orders and deadlock:
      //
      //   caller-locked path   runs FOR UPDATE ............ then chain tip FOR UPDATE
      //   standalone append    chain tip FOR UPDATE ....... then runs FOR KEY SHARE
      //                                                    (the events FK check)
      //
      // FOR UPDATE and FOR KEY SHARE conflict, so that pair is a genuine cycle and
      // PostgreSQL resolves it with SQLSTATE 40P01. Acquiring the run row first makes
      // every evidence writer follow one order, so a concurrent append WAITS instead of
      // deadlocking. FOR KEY SHARE is deliberately the weakest lock that serves: it does
      // not serialize concurrent appends against each other, which continue to order
      // themselves on the chain tip exactly as before.
      await client.query(
        `SELECT 1 FROM ${this.table('runs')} WHERE id = $1 FOR KEY SHARE`,
        [runId]
      );
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

  async _recordCompletionDecisionEvidence(connection, runId, ticketId, consequence) {
    const decision = consequence && consequence.completionDecision
      ? normalizeCompletionDecision(consequence.completionDecision)
      : null;
    const existing = await connection.query(
      `SELECT * FROM ${this.table('events')}
       WHERE run_id = $1 AND type = 'run.completion_decided'
       ORDER BY seq`,
      [runId]
    );
    if (!decision) {
      if (existing.rowCount > 0) {
        const error = new Error(`Run ${runId} has completion evidence without a completion decision`);
        error.code = 'COMPLETION_DECISION_CONFLICT';
        throw error;
      }
      return null;
    }
    const payload = completionEvidenceProjection(decision);
    if (existing.rowCount > 1) {
      const error = new Error(`Run ${runId} has duplicate completion-decision evidence`);
      error.code = 'COMPLETION_DECISION_CONFLICT';
      throw error;
    }
    if (existing.rowCount === 1) {
      const event = eventFromRow(existing.rows[0]);
      if (canonicalJson(event.payload || {}) !== canonicalJson(payload)) {
        const error = new Error(`Run ${runId} completion-decision evidence conflicts with its consequence`);
        error.code = 'COMPLETION_DECISION_CONFLICT';
        throw error;
      }
      return null;
    }
    return this._appendEvent(connection, {
      type: 'run.completion_decided',
      ticketId,
      runId,
      payload
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
      // Receipts are read on the terminalization client so the consequence
      // describes exactly the evidence committed in this transaction. See A16.
      const consequenceDocument = typeof consequence === 'function'
        ? await consequence({
            run: transitioned.run,
            replaySnapshot,
            events: storedEvents.slice(),
            evaluation: evaluationDocument,
            operations: await this._listRunOperationsOn(client, id, { limit: this.maxQueryRows })
          })
        : consequence;
      const consequenceResult = await this.recordRunConsequence({
        runId: id,
        consequence: consequenceDocument
      }, { client });
      storedEvents.push(consequenceResult.event);
      const completionDecisionEvent = await this._recordCompletionDecisionEvidence(
        client,
        id,
        transitioned.run.ticketId,
        consequenceDocument
      );
      if (completionDecisionEvent) storedEvents.push(completionDecisionEvent);
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

  // ── Terminalize a Run whose replay snapshot cannot be trusted ────────────
  //
  // THE FAILURE PATH MUST NOT DEPEND ON THE THING THAT FAILED. The ordinary
  // terminalization path reconstructs a Run's replay, consequence and completion
  // decision. For a Run whose replay snapshot fails its integrity check that is
  // impossible: recording the failure re-reads the corruption, throws the same
  // error, escapes to the scheduler, and the Run is reclaimed and fails
  // identically — forever. A Run could not be recorded as failed BECAUSE its
  // transcript was broken, which is exactly backwards.
  //
  // So this writes the terminal state from RELATIONAL AUTHORITY ONLY: the `runs`
  // row, its identity, and its lease. It reads no replay snapshot, reconstructs
  // nothing, and evaluates no progress or completion.
  //
  // THE CORRUPTED SNAPSHOT IS LEFT EXACTLY AS IT IS. It is the evidence of what
  // happened; overwriting it with a synthetic healthy one would destroy the only
  // record of the corruption and make the Run look ordinarily failed.
  async terminalizeRunForReplayIntegrityFailure({
    runId,
    ticketId = null,
    leaseOwner = null,
    code = 'POSTGRES_REPLAY_INTEGRITY_FAILURE',
    reason = 'Replay snapshot integrity check failed; replay reconstruction is unavailable'
  }) {
    const id = positiveSafeInteger(runId, 'runId');
    return this.withTransaction(async client => {
      const locked = await client.query(
        `SELECT * FROM ${this.table('runs')} WHERE id = $1 FOR UPDATE`, [id]);
      if (locked.rowCount === 0) {
        const error = new Error(`run ${id} was not found`);
        error.code = 'POSTGRES_RECORD_NOT_FOUND';
        throw error;
      }
      const current = locked.rows[0];
      if (ticketId !== null && Number(current.ticket_id) !== Number(ticketId)) {
        const error = new Error(
          `run ${id} belongs to ticket ${current.ticket_id}, not ${ticketId}`);
        error.code = 'POSTGRES_RUN_TICKET_MISMATCH';
        throw error;
      }

      // IDEMPOTENT. A second observation of the same corruption re-reports the
      // stored disposition and writes nothing — no duplicate event, no second
      // terminal timestamp, no revision churn.
      const alreadyTerminal = TERMINAL_RUN_STATUSES.has(current.status) &&
        current.body && current.body.integrityFailureCode === code;
      if (alreadyTerminal) {
        return { run: runFromRow(current), terminalized: false, alreadyTerminal: true };
      }

      const patch = {
        error: reason,
        integrityFailureCode: code,
        integrityFailureAt: null,
        replayReconstructionAvailable: false,
        failureKind: 'run_integrity_failure'
      };

      const updated = await client.query(
        `UPDATE ${this.table('runs')}
            SET status = 'failed',
                current_phase = 'terminalization',
                body = body || $2::jsonb
                       || jsonb_build_object('integrityFailureAt',
                            to_char(clock_timestamp() AT TIME ZONE 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
                lease_owner = NULL,
                lease_expires_at = NULL,
                last_heartbeat_at = NULL,
                completed_at = COALESCE(completed_at, clock_timestamp()),
                updated_at = clock_timestamp(),
                revision = revision + 1
          WHERE id = $1
            AND ($3::text IS NULL OR lease_owner IS NULL OR lease_owner = $3)
          RETURNING *`,
        [id, JSON.stringify(patch), leaseOwner]
      );
      if (updated.rowCount === 0) {
        // Another live executor holds the claim. Its own observation will reach
        // the same conclusion; nothing is forced out from under it.
        return { run: runFromRow(current), terminalized: false, alreadyTerminal: false };
      }

      // The event log is append-only and does not read the replay snapshot, so
      // it stays available exactly when replay does not.
      await this._appendEvent(client, {
        ticketId: Number(current.ticket_id),
        runId: id,
        type: 'run.integrity_terminalized',
        summary: reason,
        payload: { code, replayReconstructionAvailable: false }
      });

      return { run: runFromRow(updated.rows[0]), terminalized: true, alreadyTerminal: false };
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
    assertDeclaredWorkAuthorityNotPatched(requestedPatch, 'repair patch');
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
        ['completion decision', ['run.completion_decided']],
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
              evaluation: evaluationDocument,
              operations: await this._listRunOperationsOn(client, id, { limit: this.maxQueryRows })
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

      const completionDecisionEvent = await this._recordCompletionDecisionEvidence(
        client,
        id,
        projectedRun.ticketId,
        consequenceDocument
      );
      if (completionDecisionEvent) {
        observedEvents.push(completionDecisionEvent);
        storedEvents.push(completionDecisionEvent);
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
    // A BULK PROJECTION MUST NOT BE DESTROYED BY ONE CORRUPT ROW.
    //
    // This is the read a Ticket page makes for every Run it shows. Mapping it
    // strictly meant a single Run whose snapshot failed its integrity check
    // returned HTTP 500 for the entire Ticket — the corrupt Run had already been
    // terminalized truthfully, and its siblings were perfectly readable, but
    // nobody could see any of them.
    //
    // The corrupt row is OMITTED, never repaired and never silently presented as
    // healthy. Callers already handle a Run without a replay record; a Run whose
    // transcript cannot be trusted is exactly such a Run, and its integrity
    // failure is recorded on the Run itself where a reader will find it.
    const records = [];
    for (const row of result.rows) {
      try {
        records.push(replaySnapshotFromRow(row));
      } catch (error) {
        if (!error || error.code !== 'POSTGRES_REPLAY_INTEGRITY_FAILURE') throw error;
      }
    }
    return records;
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

  // ── The durable provider-transport observation ────────────────────────────
  //
  // APPEND-ONLY EVIDENCE, AND NOTHING ELSE. It records that a production
  // transport owner executed its platform call for one canonical provider
  // request. It transitions no reservation, charges no budget, touches no
  // replay snapshot and returns no authority: a caller cannot use it to change
  // what happens next, which is what keeps an evidence seam from becoming a
  // control point.
  //
  // NO REPLAY ITEM. `appendRunEvidence` also mutates the run's replay snapshot,
  // and this fact has no replay meaning — recovery decides what to do from the
  // reservation and the persisted request, never from this. Writing an event
  // alone is the smallest durable representation that carries it.
  //
  // TICKET-SCOPED WHEN THERE IS NO RUN. The structured planner dispatches
  // against a planning attempt, not a Run, so `runId` is null there and the
  // event binds the Ticket. Run-scoped observations join the run event chain
  // like every other run event.
  //
  // IDEMPOTENT ON THE EVIDENCE KEY, so a retried orchestration cannot make one
  // invocation look like two, and a DIFFERENT payload under the same key is a
  // conflict rather than a silent overwrite.
  async recordProviderTransportInvocation({
    runId = null,
    ticketId,
    evidenceKey,
    eventType,
    payload
  }, { client = null } = {}) {
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const id = nullablePositiveSafeInteger(runId, 'runId');
    const key = requiredString(evidenceKey, 'evidenceKey', 512);
    const type = requiredString(eventType, 'eventType');
    const eventPayload = {
      ...this.assertJsonRecord(payload || {}, 'payload'),
      evidenceKey: key
    };

    const execute = async connection => {
      const scoped = id === null
        ? await connection.query(
          `SELECT * FROM ${this.table('events')}
            WHERE ticket_id = $1 AND run_id IS NULL AND payload->>'evidenceKey' = $2
            ORDER BY position LIMIT 1`,
          [ownerTicketId, key])
        : await connection.query(
          `SELECT * FROM ${this.table('events')}
            WHERE run_id = $1 AND payload->>'evidenceKey' = $2
            ORDER BY position LIMIT 1`,
          [id, key]);
      if (scoped.rowCount > 0) {
        const existing = eventFromRow(scoped.rows[0]);
        if (existing.type !== type ||
            canonicalJson(existing.payload) !== canonicalJson(eventPayload)) {
          throw new IdempotencyConflictError(id === null ? ownerTicketId : id, key);
        }
        return { event: existing, inserted: false };
      }
      const stored = await this._appendEvent(connection, {
        type,
        ticketId: ownerTicketId,
        ...(id === null ? {} : { runId: id }),
        payload: eventPayload
      });
      return { event: stored, inserted: true };
    };
    return client ? execute(client) : this.withTransaction(execute);
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
      // Evidence bundles also update the replay row before appending their event.
      // Take the run row first so this path follows the same lock order as
      // terminalizeRun (runs -> replay_snapshots -> event chain). Without the
      // explicit key-share lock, cancellation finalization can hold the run row
      // while appendRunEvidence holds the replay row, and each then waits for
      // the other with PostgreSQL 40P01.
      const runResult = await connection.query(
        `SELECT ticket_id FROM ${this.table('runs')} WHERE id = $1 FOR KEY SHARE`,
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
    intent,
    // Optional execution-turn identity (executionTurn / planKey / actionIndex),
    // projected into the workspace.operation_prepared event payload — the
    // agent resume safety contract requires prepared mutations to carry it.
    identity = null
  }, { client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const ownerTicketId = positiveSafeInteger(ticketId, 'ticketId');
    const key = requiredString(operationKey, 'operationKey', 512);
    const document = this.assertJsonRecord(intent, 'intent');
    const eventIdentity = identity === null || identity === undefined
      ? null
      : this.assertJsonRecord(identity, 'identity');
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
        payload: { operationKey: key, ...(eventIdentity || {}), intent: document }
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

  async getProcessOperation(operationIdentity, { client = null, forUpdate = false } = {}) {
    const identity = requiredString(operationIdentity, 'operationIdentity', 82);
    if (!/^process-operation:[0-9a-f]{64}$/.test(identity)) {
      throw new TypeError('operationIdentity must be a canonical process operation identity');
    }
    const connection = client || this.targetOperationClientStorage.getStore() || this.pool;
    const result = await connection.query(
      `SELECT * FROM ${this.table('process_operations')}
       WHERE operation_identity = $1${forUpdate ? ' FOR UPDATE' : ''}`,
      [identity]
    );
    return result.rowCount === 0 ? null : processOperationFromRow(result.rows[0]);
  }

  async listProcessOperationsForRun(runId, { states = null, client = null } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const normalizedStates = states === null
      ? null
      : normalizeStatuses(states, PROCESS_OPERATION_STATES, 'process operation state');
    const connection = client || this.targetOperationClientStorage.getStore() || this.pool;
    const result = await connection.query(
      `SELECT * FROM ${this.table('process_operations')}
       WHERE run_id = $1
         AND ($2::text[] IS NULL OR lifecycle_state = ANY($2::text[]))
       ORDER BY requested_at, operation_identity`,
      [id, normalizedStates]
    );
    return result.rows.map(processOperationFromRow);
  }

  async listNonterminalProcessOperations({ limit = 100, client = null } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const connection = client || this.targetOperationClientStorage.getStore() || this.pool;
    const result = await connection.query(
      `SELECT * FROM ${this.table('process_operations')}
       WHERE lifecycle_state <> 'terminal'
       ORDER BY updated_at, operation_identity
       LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(processOperationFromRow);
  }

  async listProcessOperationsRequiringReconciliation({
    limit = 100,
    client = null
  } = {}) {
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const connection = client || this.targetOperationClientStorage.getStore() || this.pool;
    const result = await connection.query(
      `SELECT * FROM ${this.table('process_operations')}
       WHERE lifecycle_state <> 'terminal'
          OR launcher_output_acknowledged = false
       ORDER BY updated_at, operation_identity
       LIMIT $1`,
      [boundedLimit]
    );
    return result.rows.map(processOperationFromRow);
  }

  async isProcessExecutionSchemaAvailable() {
    const result = await this.pool.query(
      'SELECT to_regclass($1) IS NOT NULL AS available',
      [`${this.schema}.process_operations`]
    );
    return result.rows[0] && result.rows[0].available === true;
  }

  async createProcessExecutionIntent(input, { client = null } = {}) {
    const document = this.assertJsonRecord(input, 'process execution intent');
    const operationIdentity = requiredString(
      document.operationIdentity,
      'operationIdentity',
      82
    );
    if (!/^process-operation:[0-9a-f]{64}$/.test(operationIdentity)) {
      throw new TypeError('operationIdentity must be a canonical process operation identity');
    }
    const runId = positiveSafeInteger(document.runId, 'runId');
    const ticketId = positiveSafeInteger(document.ticketId, 'ticketId');
    const actingAgentId = positiveSafeInteger(document.actingAgentId, 'actingAgentId');
    const runtimePhase = requiredString(document.runtimePhase, 'runtimePhase');
    if (!['inspection', 'mutation', 'verification'].includes(runtimePhase)) {
      throw new TypeError('runtimePhase must be an executable runtime phase');
    }
    const targetId = requiredString(document.targetId, 'targetId', 128);
    const profileId = requiredString(document.profileId, 'profileId', 128);
    const sha256 = (value, label) => {
      const normalized = requiredString(value, label, 64);
      if (!/^[0-9a-f]{64}$/.test(normalized)) {
        throw new TypeError(`${label} must be a lowercase SHA-256`);
      }
      return normalized;
    };
    const launchPlan = this.assertJsonRecord(document.launchPlan, 'launchPlan');
    const launchPlanVersion = positiveSafeInteger(
      document.launchPlanVersion,
      'launchPlanVersion'
    );
    if (launchPlanVersion !== 1) throw new TypeError('launchPlanVersion must be 1');
    const authority = {
      operationIdentity,
      runId,
      ticketId,
      actingAgentId,
      stepId: optionalString(document.stepId),
      runtimePhase,
      targetId,
      profileId,
      policySnapshotHash: sha256(document.policySnapshotHash, 'policySnapshotHash'),
      runtimeCapabilityGeneration: requiredString(
        document.runtimeCapabilityGeneration,
        'runtimeCapabilityGeneration',
        83
      ),
      launchPlanVersion,
      launchPlanHash: sha256(document.launchPlanHash, 'launchPlanHash'),
      launchPlan,
      workspaceSnapshotId: requiredString(
        document.workspaceSnapshotId,
        'workspaceSnapshotId',
        128
      ),
      workspaceManifestHash: sha256(document.workspaceManifestHash, 'workspaceManifestHash'),
      materializerGeneration: requiredString(
        document.materializerGeneration,
        'materializerGeneration',
        128
      ),
      containmentGenerationId: requiredString(
        document.containmentGenerationId,
        'containmentGenerationId',
        128
      ),
      rootfsId: requiredString(document.rootfsId, 'rootfsId', 128),
      rootfsManifestHash: sha256(document.rootfsManifestHash, 'rootfsManifestHash'),
      executableIdentityHash: sha256(
        document.executableIdentityHash,
        'executableIdentityHash'
      ),
      executionPolicyHash: sha256(document.executionPolicyHash, 'executionPolicyHash'),
      filesystemPolicyHash: sha256(document.filesystemPolicyHash, 'filesystemPolicyHash')
    };
    const execute = async connection => {
      await connection.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`process-execution:${operationIdentity}`]
      );
      const inserted = await connection.query(
        `INSERT INTO ${this.table('process_operations')} (
          operation_identity, run_id, ticket_id, acting_agent_id, step_id, runtime_phase,
          target_id, profile_id, policy_snapshot_hash, runtime_capability_generation,
          launch_plan_version, launch_plan_hash, launch_plan,
          workspace_snapshot_id, workspace_manifest_hash, materializer_generation,
          containment_generation_id, rootfs_id, rootfs_manifest_hash,
          executable_identity_hash, execution_policy_hash, filesystem_policy_hash
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14,
          $15, $16, $17, $18, $19, $20, $21, $22
        )
        ON CONFLICT (operation_identity) DO NOTHING
        RETURNING *`,
        [
          authority.operationIdentity,
          authority.runId,
          authority.ticketId,
          authority.actingAgentId,
          authority.stepId,
          authority.runtimePhase,
          authority.targetId,
          authority.profileId,
          authority.policySnapshotHash,
          authority.runtimeCapabilityGeneration,
          authority.launchPlanVersion,
          authority.launchPlanHash,
          JSON.stringify(authority.launchPlan),
          authority.workspaceSnapshotId,
          authority.workspaceManifestHash,
          authority.materializerGeneration,
          authority.containmentGenerationId,
          authority.rootfsId,
          authority.rootfsManifestHash,
          authority.executableIdentityHash,
          authority.executionPolicyHash,
          authority.filesystemPolicyHash
        ]
      );
      if (inserted.rowCount === 1) {
        return { inserted: true, record: processOperationFromRow(inserted.rows[0]) };
      }
      const current = await this.getProcessOperation(operationIdentity, {
        client: connection,
        forUpdate: true
      });
      const exact = current &&
        current.runId === authority.runId &&
        current.ticketId === authority.ticketId &&
        current.actingAgentId === authority.actingAgentId &&
        current.stepId === authority.stepId &&
        current.runtimePhase === authority.runtimePhase &&
        current.targetId === authority.targetId &&
        current.profileId === authority.profileId &&
        current.policySnapshotHash === authority.policySnapshotHash &&
        current.runtimeCapabilityGeneration === authority.runtimeCapabilityGeneration &&
        current.launchPlanVersion === authority.launchPlanVersion &&
        current.launchPlanHash === authority.launchPlanHash &&
        canonicalJson(current.launchPlan) === canonicalJson(authority.launchPlan) &&
        current.workspaceSnapshotId === authority.workspaceSnapshotId &&
        current.workspaceManifestHash === authority.workspaceManifestHash &&
        current.materializerGeneration === authority.materializerGeneration &&
        current.containmentGenerationId === authority.containmentGenerationId &&
        current.rootfsId === authority.rootfsId &&
        current.rootfsManifestHash === authority.rootfsManifestHash &&
        current.executableIdentityHash === authority.executableIdentityHash &&
        current.executionPolicyHash === authority.executionPolicyHash &&
        current.filesystemPolicyHash === authority.filesystemPolicyHash;
      if (!exact) throw new ProcessExecutionIntentConflictError(operationIdentity, current);
      return { inserted: false, record: current };
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async transitionProcessOperation({
    operationIdentity,
    expectedStates,
    expectedRevision = null,
    changes
  }, { client = null } = {}) {
    const identity = requiredString(operationIdentity, 'operationIdentity', 82);
    const states = normalizeStatuses(
      expectedStates,
      PROCESS_OPERATION_STATES,
      'expected process operation state'
    );
    const patch = this.assertJsonRecord(changes, 'process operation changes');
    const columns = new Map([
      ['lifecycleState', ['lifecycle_state', value => {
        const state = requiredString(value, 'lifecycleState');
        if (!PROCESS_OPERATION_STATES.has(state)) throw new TypeError('Invalid lifecycleState');
        return state;
      }]],
      ['launcherAcceptanceIdentity', ['launcher_acceptance_identity', optionalString]],
      ['startedAt', ['started_at', value => value == null ? null : isoTimestamp(value, 'startedAt')]],
      ['terminalAt', ['terminal_at', value => value == null ? null : isoTimestamp(value, 'terminalAt')]],
      ['terminalOutcome', ['terminal_outcome', optionalString]],
      ['terminalResult', ['terminal_result', value => value == null
        ? null
        : this.assertJsonRecord(value, 'terminalResult')]],
      ['terminalResultHash', ['terminal_result_hash', optionalString]],
      ['exitCode', ['exit_code', value => value == null ? null : Number(value)]],
      ['terminatingSignal', ['terminating_signal', value => value == null ? null : Number(value)]],
      ['resourceCause', ['resource_cause', optionalString]],
      ['stdoutByteCount', ['stdout_byte_count', value => value == null
        ? null
        : nonNegativeSafeInteger(value, 'stdoutByteCount')]],
      ['stdoutSha256', ['stdout_sha256', optionalString]],
      ['stderrByteCount', ['stderr_byte_count', value => value == null
        ? null
        : nonNegativeSafeInteger(value, 'stderrByteCount')]],
      ['stderrSha256', ['stderr_sha256', optionalString]],
      ['combinedOutputByteCount', ['combined_output_byte_count', value => value == null
        ? null
        : nonNegativeSafeInteger(value, 'combinedOutputByteCount')]],
      ['stdoutArtifact', ['stdout_artifact', value => value == null
        ? null
        : this.assertJsonRecord(value, 'stdoutArtifact')]],
      ['stderrArtifact', ['stderr_artifact', value => value == null
        ? null
        : this.assertJsonRecord(value, 'stderrArtifact')]],
      ['requiredEvidenceState', ['required_evidence_state', value => {
        const state = requiredString(value, 'requiredEvidenceState');
        if (!['pending', 'complete'].includes(state)) {
          throw new TypeError('requiredEvidenceState must be pending or complete');
        }
        return state;
      }]],
      ['launcherOutputAcknowledged', ['launcher_output_acknowledged', value => value === true]],
      ['cancellationRequested', ['cancellation_requested', value => value === true]],
      ['cancellationRequestedAt', ['cancellation_requested_at', value => value == null
        ? null
        : isoTimestamp(value, 'cancellationRequestedAt')]],
      ['cancellationReason', ['cancellation_reason', value => value == null
        ? null
        : requiredString(value, 'cancellationReason', 1024)]],
      ['lastReconciliationResult', ['last_reconciliation_result', value => value == null
        ? null
        : this.assertJsonRecord(value, 'lastReconciliationResult')]]
    ]);
    const entries = Object.entries(patch);
    if (entries.length === 0) throw new TypeError('process operation changes cannot be empty');
    const assignments = [];
    const values = [identity, states];
    for (const [key, value] of entries) {
      const definition = columns.get(key);
      if (!definition) throw new TypeError(`Unsupported process operation change: ${key}`);
      const [column, normalize] = definition;
      values.push(normalize(value));
      assignments.push(`${column} = $${values.length}${column.endsWith('_result') ||
        column.endsWith('_artifact') ? '::jsonb' : ''}`);
    }
    const revision = expectedRevision === null
      ? null
      : positiveSafeInteger(expectedRevision, 'expectedRevision');
    values.push(revision);
    const revisionParameter = values.length;
    const execute = async connection => {
      const result = await connection.query(
        `UPDATE ${this.table('process_operations')}
         SET ${assignments.join(', ')},
             revision = revision + 1,
             updated_at = clock_timestamp()
         WHERE operation_identity = $1
           AND lifecycle_state = ANY($2::text[])
           AND ($${revisionParameter}::bigint IS NULL OR revision = $${revisionParameter})
         RETURNING *`,
        values.map((value, index) => {
          const key = index >= 2 && index - 2 < entries.length ? entries[index - 2][0] : null;
          return key && ['terminalResult', 'stdoutArtifact', 'stderrArtifact',
            'lastReconciliationResult'].includes(key) && value !== null
            ? JSON.stringify(value)
            : value;
        })
      );
      if (result.rowCount === 1) return processOperationFromRow(result.rows[0]);
      const current = await this.getProcessOperation(identity, {
        client: connection,
        forUpdate: true
      });
      throw new ProcessExecutionStateError(identity, states, current);
    };
    return client ? execute(client) : this.withTransaction(execute);
  }

  async requestProcessOperationCancellation({
    operationIdentity,
    reason,
    requestedAt = new Date().toISOString()
  }) {
    const current = await this.getProcessOperation(operationIdentity);
    if (!current) {
      throw new ProcessExecutionStateError(operationIdentity, [...PROCESS_OPERATION_STATES], null);
    }
    if (current.cancellationRequested) return current;
    return this.transitionProcessOperation({
      operationIdentity,
      expectedStates: ['intent', 'active', 'finalizing'],
      expectedRevision: current.revision,
      changes: {
        cancellationRequested: true,
        cancellationRequestedAt: requestedAt,
        cancellationReason: reason || 'process operation cancellation requested'
      }
    });
  }

  async withProcessOperationLock(operationIdentity, operation) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    const identity = requiredString(operationIdentity, 'operationIdentity', 82);
    if (!/^process-operation:[0-9a-f]{64}$/.test(identity)) {
      throw new TypeError('operationIdentity must be a canonical process operation identity');
    }
    const resource = `process-execution:${identity}`;
    const client = await this.pool.connect();
    try {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [`${this.lockTimeoutMs}ms`]);
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [resource]);
      return await this.targetOperationClientStorage.run(client, () => operation(resource));
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [resource]);
      } catch (_) {}
      try { await client.query("SELECT set_config('lock_timeout', '0', false)"); } catch (_) {}
      client.release();
    }
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

  // The workspace-wide materialization boundary is the root-exclusive member
  // of the same hierarchical advisory-lock family used by every path mutation.
  // Normal mutations hold this root resource shared; materialization holds it
  // exclusive across every PostgreSQL-connected runtime process.
  async withWorkspaceMutationBoundary({ targetId }, operation) {
    return this.withTargetOperationLock({ targetId, paths: [''] }, operation);
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
             AND NOT EXISTS (
               SELECT 1
               FROM ${this.table('runs')} AS sibling_run
               WHERE sibling_run.ticket_id = pending_run.ticket_id
                 AND sibling_run.id <> pending_run.id
                 AND sibling_run.status IN ('pending', 'running')
                 AND sibling_run.lease_owner IS NOT NULL
                 AND sibling_run.lease_expires_at > clock_timestamp()
                 AND (
                   COALESCE(
                     (pending_run.body #>>
                       '{runtimeBudgetSnapshot,allowParallelRuns}')::boolean,
                     true
                   ) = false OR
                   COALESCE(
                     (sibling_run.body #>>
                       '{runtimeBudgetSnapshot,allowParallelRuns}')::boolean,
                     true
                   ) = false
                 )
             )
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
      const waits = await client.query(
        `UPDATE ${this.table('run_capacity_waits')}
         SET active = false, updated_at = clock_timestamp(), revision = revision + 1
         WHERE run_id = $1 AND active = true
         RETURNING capacity_domain, resource_key, source_identity`,
        [run.id]
      );
      const capacityEvents = [];
      for (const wait of waits.rows) {
        capacityEvents.push(await this._appendEvent(client, {
          type: 'capacity.acquired',
          ticketId: run.ticketId,
          runId: run.id,
          payload: {
            capacityDomain: wait.capacity_domain,
            resourceKey: wait.resource_key,
            sourceIdentity: wait.source_identity,
            authority: 'run_lease'
          }
        }));
      }
      return { run, event, capacityEvents };
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
             body = run.body || jsonb_build_object(
               'runtimeBudgetStartedAt',
               COALESCE(
                 run.body->>'runtimeBudgetStartedAt',
                 to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
               )
             ),
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

  async getRunEvidenceEvent(runId, evidenceKey) {
    const id = positiveSafeInteger(runId, 'runId');
    const key = requiredString(evidenceKey, 'evidenceKey', 512);
    const result = await this.pool.query(
      `SELECT * FROM ${this.table('events')}
       WHERE run_id = $1 AND payload->>'evidenceKey' = $2
       ORDER BY seq
       LIMIT 1`,
      [id, key]
    );
    return result.rowCount === 0 ? null : eventFromRow(result.rows[0]);
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

  // Connection-aware operation read. Terminalization must derive a run's
  // consequence from the receipts visible INSIDE its own transaction, so the
  // consequence and the evidence it describes are committed under one boundary.
  // Both the pooled reader and the in-transaction reader share this body so they
  // cannot project differently. See A16.
  async listRunOperations(runId, options = {}) {
    return this._listRunOperationsOn(this.pool, runId, options);
  }

  async _listRunOperationsOn(connection, runId, { afterId = 0, limit = 100 } = {}) {
    const id = positiveSafeInteger(runId, 'runId');
    const cursor = nonNegativeSafeInteger(afterId, 'afterId');
    const boundedLimit = positiveSafeInteger(limit, 'limit');
    if (boundedLimit > this.maxQueryRows) {
      throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    }
    const receiptResult = await connection.query(
      `SELECT * FROM ${this.table('operation_receipts')}
       WHERE run_id = $1 AND id > $2
       ORDER BY id
       LIMIT $3`,
      [id, cursor, boundedLimit]
    );
    const receipts = receiptResult.rows.map(operationReceiptFromRow);
    if (receipts.length === 0) return [];
    const keys = receipts.map(receipt => receipt.idempotencyKey);
    const intentResult = await connection.query(
      `SELECT * FROM ${this.table('target_operation_intents')}
       WHERE run_id = $1 AND operation_key = ANY($2::text[])`,
      [id, keys]
    );
    const intentsByKey = new Map(intentResult.rows.map(row => {
      const record = targetOperationIntentFromRow(row);
      return [record.operationKey, record];
    }));
    return receipts.map(receipt =>
      projectOperationReceipt(receipt, intentsByKey.get(receipt.idempotencyKey) || null));
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
installRuntimeBudgetMethods(PostgresRuntimeStore);
installApplicationStateMethods(PostgresRuntimeStore, {
  OptimisticConcurrencyError,
  operationReceiptFromRow,
  targetOperationIntentFromRow,
  projectOperationReceipt
});

module.exports = {
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeIntegrityError,
  PostgresRuntimeStore,
  ProcessExecutionIntentConflictError,
  ProcessExecutionStateError,
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
