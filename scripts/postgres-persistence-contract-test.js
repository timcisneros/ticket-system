#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeStore,
  StateTransitionConflictError,
  TriageConflictError,
  buildEventEnvelope,
  buildWorkspaceLockRequests,
  canonicalJson,
  normalizeWorkspacePath,
  quoteIdentifier,
  sha256Json
} = require('../persistence/postgres/store');
const { resolveRuntimePersistenceBackend } = require('../persistence/runtime-backend');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');

const ROOT = path.resolve(__dirname, '..');
const STORE_PATH = path.join(ROOT, 'persistence', 'postgres', 'store.js');
const MIGRATIONS_DIR = path.join(ROOT, 'persistence', 'postgres', 'migrations');
const CORE_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '001_runtime_core.sql');
const EVIDENCE_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '002_runtime_evidence.sql');
const NON_TERMINAL_EVIDENCE_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '004_non_terminal_evidence.sql');
const FINALIZED_REPLAY_APPEND_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '005_finalized_replay_append.sql');
const RUNTIME_STATE_READ_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '006_runtime_state_reads.sql');
const TICKET_OPERATOR_READ_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '007_ticket_operator_reads.sql');
const TRIAGE_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '008_triage_authority.sql');
const OPERATIONAL_STATUS_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '009_operational_status.sql');
const DIAGNOSTIC_LOG_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '010_diagnostic_logs.sql');
const WORKSPACE_OWNERSHIP_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '011_workspace_ownership_authority.sql');
const OPERATOR_RECOVERY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '012_operator_recovery_authority.sql');
const RUN_PHASE_PROJECTION_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '013_run_phase_projection.sql');
const PERFORMANCE_ANALYTICS_READ_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '014_performance_analytics_reads.sql');
const WORK_CONTEXT_CATALOG_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '015_work_context_catalog.sql');
const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
const CONFIGURED_AGENT_CATALOG_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '016_configured_agent_catalog.sql');
const PROCESS_TEMPLATE_PROJECTION_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '017_process_template_projection.sql');
const PROCESS_TEMPLATE_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '018_process_template_authority.sql');
const ACCESS_CATALOG_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '019_access_catalog_authority.sql');
const WORKFLOW_CATALOG_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '020_workflow_catalog_authority.sql');
const MODEL_ROUTING_POLICY_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '021_model_routing_policy_authority.sql');
const CONNECTOR_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '022_connector_authority.sql');
const WATCHER_AUTHORITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '023_watcher_authority.sql');
const RUNTIME_LIMIT_CONFIG_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '024_runtime_limit_config.sql');
const APPLICATION_STATE_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '025_application_state_and_sessions.sql');
const LOCAL_CONNECTOR_OBJECTS_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '026_local_connector_objects.sql');
const RUN_AGENT_INTEGRITY_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '027_run_agent_integrity.sql');
const PROCESS_TEMPLATE_TICKET_PROVENANCE_MIGRATION_PATH = path.join(MIGRATIONS_DIR, '028_process_template_ticket_provenance.sql');
const APPLICATION_STATE_METHODS_PATH = path.join(ROOT, 'persistence', 'postgres', 'application-state-methods.js');
const RUNTIME_BACKEND_PATH = path.join(ROOT, 'persistence', 'runtime-backend.js');
const SERVER_PATH = path.join(ROOT, 'server.js');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const coreMigration = fs.readFileSync(CORE_MIGRATION_PATH, 'utf8');
const evidenceMigration = fs.readFileSync(EVIDENCE_MIGRATION_PATH, 'utf8');
const nonTerminalEvidenceMigration = fs.readFileSync(NON_TERMINAL_EVIDENCE_MIGRATION_PATH, 'utf8');
const finalizedReplayAppendMigration = fs.readFileSync(FINALIZED_REPLAY_APPEND_MIGRATION_PATH, 'utf8');
const runtimeStateReadMigration = fs.readFileSync(RUNTIME_STATE_READ_MIGRATION_PATH, 'utf8');
const ticketOperatorReadMigration = fs.readFileSync(TICKET_OPERATOR_READ_MIGRATION_PATH, 'utf8');
const triageAuthorityMigration = fs.readFileSync(TRIAGE_AUTHORITY_MIGRATION_PATH, 'utf8');
const operationalStatusMigration = fs.readFileSync(OPERATIONAL_STATUS_MIGRATION_PATH, 'utf8');
const diagnosticLogMigration = fs.readFileSync(DIAGNOSTIC_LOG_MIGRATION_PATH, 'utf8');
const workspaceOwnershipMigration = fs.readFileSync(WORKSPACE_OWNERSHIP_MIGRATION_PATH, 'utf8');
const operatorRecoveryMigration = fs.readFileSync(OPERATOR_RECOVERY_MIGRATION_PATH, 'utf8');
const runPhaseProjectionMigration = fs.readFileSync(RUN_PHASE_PROJECTION_MIGRATION_PATH, 'utf8');
const performanceAnalyticsReadMigration = fs.readFileSync(PERFORMANCE_ANALYTICS_READ_MIGRATION_PATH, 'utf8');
const workContextCatalogMigration = fs.readFileSync(WORK_CONTEXT_CATALOG_MIGRATION_PATH, 'utf8');
const configuredAgentCatalogMigration = fs.readFileSync(CONFIGURED_AGENT_CATALOG_MIGRATION_PATH, 'utf8');
const processTemplateProjectionMigration = fs.readFileSync(PROCESS_TEMPLATE_PROJECTION_MIGRATION_PATH, 'utf8');
const processTemplateAuthorityMigration = fs.readFileSync(PROCESS_TEMPLATE_AUTHORITY_MIGRATION_PATH, 'utf8');
const accessCatalogAuthorityMigration = fs.readFileSync(ACCESS_CATALOG_AUTHORITY_MIGRATION_PATH, 'utf8');
const workflowCatalogAuthorityMigration = fs.readFileSync(WORKFLOW_CATALOG_AUTHORITY_MIGRATION_PATH, 'utf8');
const modelRoutingPolicyAuthorityMigration = fs.readFileSync(MODEL_ROUTING_POLICY_AUTHORITY_MIGRATION_PATH, 'utf8');
const connectorAuthorityMigration = fs.readFileSync(CONNECTOR_AUTHORITY_MIGRATION_PATH, 'utf8');
const watcherAuthorityMigration = fs.readFileSync(WATCHER_AUTHORITY_MIGRATION_PATH, 'utf8');
const runtimeLimitConfigMigration = fs.readFileSync(RUNTIME_LIMIT_CONFIG_MIGRATION_PATH, 'utf8');
const applicationStateMigration = fs.readFileSync(APPLICATION_STATE_MIGRATION_PATH, 'utf8');
const localConnectorObjectsMigration = fs.readFileSync(LOCAL_CONNECTOR_OBJECTS_MIGRATION_PATH, 'utf8');
const runAgentIntegrityMigration = fs.readFileSync(RUN_AGENT_INTEGRITY_MIGRATION_PATH, 'utf8');
const processTemplateTicketProvenanceMigration = fs.readFileSync(PROCESS_TEMPLATE_TICKET_PROVENANCE_MIGRATION_PATH, 'utf8');
const applicationStateMethodsSource = fs.readFileSync(APPLICATION_STATE_METHODS_PATH, 'utf8');
const runtimeBackendSource = fs.readFileSync(RUNTIME_BACKEND_PATH, 'utf8');
const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
const envExampleSource = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');

assert.equal(quoteIdentifier('ticket_system'), '"ticket_system"');
assert.throws(() => quoteIdentifier('public; DROP SCHEMA public'), /Invalid PostgreSQL identifier/);
assert.throws(() => new PostgresRuntimeStore(), /connectionString is required/);
const boundedStore = new PostgresRuntimeStore({ pool: {}, maxJsonRecordBytes: 16 });
assert.throws(() => boundedStore.assertJsonRecord({ value: 'this is too large' }, 'record'), error => {
  return error && error.code === 'POSTGRES_RECORD_TOO_LARGE';
});
assert.equal(canonicalJson({ z: 1, nested: { b: 2, a: 1 } }), canonicalJson({ nested: { a: 1, b: 2 }, z: 1 }));
assert.equal(sha256Json({ b: 2, a: 1 }), sha256Json({ a: 1, b: 2 }));
assert.equal(new OptimisticConcurrencyError('run', 1, 2).code, 'OPTIMISTIC_CONCURRENCY_CONFLICT');
assert.equal(new ImmutableEvidenceConflictError('evaluation', 1).code, 'IMMUTABLE_EVIDENCE_CONFLICT');
assert.equal(new IdempotencyConflictError(1, 'step-1').code, 'IDEMPOTENCY_CONFLICT');
assert.equal(new StateTransitionConflictError('run', 1, ['running'], { status: 'pending' }).code, 'STATE_TRANSITION_CONFLICT');
assert.equal(new LeaseAuthorityError(1, 'worker', { status: 'running' }).code, 'LEASE_AUTHORITY_CONFLICT');
assert.equal(new TriageConflictError('ticket', 1).code, 'TRIAGE_NOT_REQUIRED');
assert.equal(resolveRuntimePersistenceBackend({}), 'postgres');
assert.equal(resolveRuntimePersistenceBackend({ PERSISTENCE_BACKEND: 'postgres' }), 'postgres');
assert.throws(() => resolveRuntimePersistenceBackend({ PERSISTENCE_BACKEND: 'json' }), /PostgreSQL-only/);
assert.throws(() => resolveRuntimePersistenceBackend({ PERSISTENCE_BACKEND: 'sqlite' }), /Unsupported/);
assert.match(runtimeBackendSource, /ACTIVE_RUNTIME_BACKEND = 'postgres'/);
assert.equal(fs.existsSync(path.join(ROOT, 'persistence', 'json')), false, 'active JSON repository directory must not exist');
assert.ok(serverSource.includes("if (!DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL runtime')"));
assert.ok(serverSource.includes('new PostgresSessionStore(postgresRuntimeStore)'), 'HTTP sessions must use PostgreSQL');
assert.ok(!serverSource.includes('process.env.DATA_DIR'), 'server must not select a JSON data directory');
assert.match(packageJson.scripts.dev, /node --env-file-if-exists=\.env\.local scripts\/dev\.js$/,
  'development startup must load local configuration through the preflight wrapper');
assert.match(packageJson.scripts['dev:setup'], /scripts\/dev-setup\.js$/, 'development setup command must remain wired');
assert.match(packageJson.scripts['dev:doctor'], /scripts\/dev-doctor\.js$/, 'development doctor command must remain wired');
assert.match(packageJson.scripts['admin:password'], /scripts\/admin-password\.js$/,
  'audited password command must remain wired');
assert.match(packageJson.scripts['db:migrate'], /node --env-file-if-exists=\.env\.local scripts\/postgres-migrate\.js$/,
  'the migration command must load the same local environment file');
assert.match(envExampleSource, /^DATABASE_URL=/m, '.env.example must teach the PostgreSQL connection');
assert.match(envExampleSource, /^SESSION_SECRET=/m, '.env.example must teach the session secret');

assert.equal(normalizeWorkspacePath('./reports//daily.json'), 'reports/daily.json');
assert.equal(normalizeWorkspacePath('.'), '');
assert.throws(() => normalizeWorkspacePath('../secret'), /Unsafe workspace path/);
assert.throws(() => normalizeWorkspacePath('/etc/passwd'), /Unsafe workspace path/);
assert.throws(() => normalizeWorkspacePath('C:\\Windows\\system32'), /Unsafe workspace path/);

function lockMap(paths) {
  return new Map(buildWorkspaceLockRequests('local', paths).map(item => [item.resource, item.mode]));
}

const child = lockMap(['reports/2026/daily.json']);
assert.equal(child.get('workspace:local:'), 'shared');
assert.equal(child.get('workspace:local:reports'), 'shared');
assert.equal(child.get('workspace:local:reports/2026'), 'shared');
assert.equal(child.get('workspace:local:reports/2026/daily.json'), 'exclusive');

const parent = lockMap(['reports/2026']);
assert.equal(parent.get('workspace:local:reports/2026'), 'exclusive');
const unrelated = lockMap(['exports/result.json']);
assert.equal(unrelated.get('workspace:local:exports/result.json'), 'exclusive');
assert.equal(unrelated.has('workspace:local:reports'), false);
const root = lockMap(['']);
assert.equal(root.get('workspace:local:'), 'exclusive');

const first = buildEventEnvelope({
  event: { type: 'run.created', ticketId: 10, runId: 20, payload: { source: 'test' } },
  eventId: 'event-1',
  timestamp: '2026-07-16T12:00:00.000Z',
  chain: { nextSeq: 0, previousHash: null }
});
const second = buildEventEnvelope({
  event: { type: 'run.started', ticketId: 10, runId: 20, payload: { source: 'test' } },
  eventId: 'event-2',
  timestamp: '2026-07-16T12:00:01.000Z',
  chain: { nextSeq: 1, previousHash: first.hash }
});
assert.equal(first.seq, 0);
assert.equal(second.prevHash, first.hash);
assert.equal(verifyCurrentRunEventChain([first, second]).chainValid, true);

for (const requiredSql of [
  'GENERATED BY DEFAULT AS IDENTITY',
  'id UUID NOT NULL UNIQUE',
  'revision BIGINT NOT NULL DEFAULT 1',
  'CONSTRAINT events_run_ticket_fk',
  'CONSTRAINT events_run_seq_unique UNIQUE (run_id, seq)',
  'CREATE TRIGGER events_append_only',
  'CREATE INDEX runs_pending_claim_idx',
  'CREATE TABLE run_event_chain_tips'
]) {
  assert.ok(coreMigration.includes(requiredSql), `core migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'ADD COLUMN started_at TIMESTAMPTZ',
  'ALTER COLUMN payload TYPE JSON',
  'requires an empty development event store',
  'CREATE TRIGGER tickets_revision_guard',
  'CREATE TRIGGER runs_revision_guard',
  'terminal runs cannot be reopened',
  'CREATE TABLE run_evaluations',
  'CREATE TABLE run_consequences',
  'CREATE TABLE replay_snapshots',
  'CREATE TABLE operation_receipts',
  'CONSTRAINT operation_receipts_idempotency_unique UNIQUE (run_id, idempotency_key)',
  'CREATE TRIGGER run_evaluations_append_only',
  'CREATE TRIGGER run_consequences_append_only',
  'CREATE TRIGGER operation_receipts_append_only',
  'CREATE TRIGGER replay_snapshots_mutation_guard',
  'PERFORM assert_terminal_run(NEW.run_id)'
]) {
  assert.ok(evidenceMigration.includes(requiredSql), `evidence migration must include: ${requiredSql}`);
}

for (const requiredPrimitive of [
  'FOR UPDATE OF pending_run SKIP LOCKED',
  'WHERE run_id = $1 FOR UPDATE',
  "type: 'run.lease_acquired'",
  "type: 'run.heartbeat'",
  "type: 'run.lease_released'",
  "set_config('lock_timeout'",
  'pg_advisory_xact_lock',
  'revision = run.revision + 1',
  'limit exceeds the configured maximum',
  'eligibleRunIds exceeds the configured limit',
  'async transitionTicket',
  'async transitionRun',
  'async verifyRunLease',
  'async listPendingRuns',
  'async listExpiredRunningRuns',
  'async startClaimedRun',
  'async listRecoverableRuns',
  'async claimRunRecovery',
  'async resumeRecoveredRun',
  'async repairRecoveredRunTerminalProjection',
  'async acquireRuntimeAuthority',
  'async prepareRuntimePersistence',
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  'async refreshRuntimeAuthority',
  'async releaseRuntimeAuthority',
  'async listTickets',
  'async listTicketPage',
  'async countTicketsByStatus',
  'async listRuns',
  'async listRunsForTicket',
  'async listRunsForTickets',
  'async listLatestRunsForTickets',
  'async getRunAttemptPositions',
  'async listChildTickets',
  'async createRunTriage',
  'async resolveTicketTriage',
  'async resolveRunTriage',
  'async getUnresolvedTriageSummary',
  'async getRuntimeOperationalSummary',
  'async listRunsNeedingTerminalReconciliation',
  'async listRunTimelineEvents',
  'async listTicketEvents',
  'async listRunOperations',
  'async countRunsForTicket',
  'async getTicketBySpawnIdempotencyKey',
  'async getTicketsBySpawnIdempotencyKeys',
  'async listTicketOperations',
  'async countRunMutations',
  'Unsupported run status transition',
  'leaseOwner is required to transition a running run',
  'LEASE_AUTHORITY_CONFLICT',
  'STATE_TRANSITION_CONFLICT',
  "lease_expires_at > clock_timestamp()",
  'async recordRunEvaluation',
  'async recordRunConsequence',
  'async writeReplaySnapshot',
  'async initializeRunReplay',
  'async readRunReplay',
  'async listRunReplays',
  'async updateRunReplay',
  'WHERE run_id = ANY($1::bigint[])',
  'update must return synchronously',
  'POSTGRES_REPLAY_INTEGRITY_FAILURE',
  'async recordOperationReceipt',
  'async appendRunEvidence',
  'async completeActionReceipt',
  'async prepareTargetOperation',
  'async completeTargetOperation',
  'async getTargetOperation',
  'async withTargetOperationLock',
  'async getOperatorRecovery',
  'async prepareOperatorRecovery',
  'async completeOperatorRecovery',
  'async withOperatorRecoveryLock',
  'async advanceRunPhase',
  'async listPerformanceRunEvidence',
  'async listWorkContexts',
  'async getWorkContextById',
  'async getWorkContextCounts',
  'async getWorkContextTicketCountsByIds',
  'async getWorkContextRuntimeSummary',
  'async createWorkContext',
  'async updateWorkContext',
  'async listConfiguredAgents',
  'async getConfiguredAgentsByIds',
  'async getConfiguredAgentById',
  'async getConfiguredAgentByName',
  'async listConfiguredAgentsByGroup',
  'async listAgentGroupMemberships',
  'async createConfiguredAgent',
  'async updateConfiguredAgent',
  'async deleteConfiguredAgent',
  'async removeConfiguredAgentMembershipsForGroup',
  'async listProcessTemplateStates',
  'async getProcessTemplateStateById',
  'async getProcessTemplateCounts',
  'async getProcessTemplateCountsByWorkContextIds',
  'async getProcessTemplateTriggerProvenance',
  'async getProcessTemplateById',
  'async createProcessTemplate',
  'async setProcessTemplateEnabled',
  'async setProcessTemplateSchedule',
  'async pauseProcessTemplateSchedule',
  'async resumeProcessTemplateSchedule',
  'async assignProcessTemplateWorkContext',
  'async createProcessTemplateDraft',
  'async activateProcessTemplateVersion',
  'async listDueProcessTemplates',
  'async executeProcessTemplateTrigger',
  'async reconcileProcessTemplateVersions',
  "FROM ${this.table('process_template_status_counts')}",
  'Non-terminal phase changes must use advanceRunPhase',
  'async findMutationConflict',
  'async listArtifactOwners',
  'pg_advisory_lock_shared',
  'pg_advisory_unlock_shared',
  'targetOperationClientStorage.run',
  'async persistRunWorkflowStep',
  'async recoverExpiredRun',
  "type: 'run.recovery_claimed'",
  "type: 'run.terminal_projection_repaired'",
  'async terminalizeRun',
  'async repairRunTerminalization',
  'TERMINAL_REPAIR_INTEGRITY_FAILURE',
  "eventType = 'operation.receipt_recorded'",
  "type: 'run.triage_created'",
  "type: 'ticket.triage_resolved'",
  "type: 'run.triage_resolved'",
  "SUM(count) FILTER (WHERE entity_type = 'run' AND status IN ('pending', 'running'))",
  'recent_failed_runs',
  'ON CONFLICT (run_id, idempotency_key) DO NOTHING',
  'POSTGRES_RECORD_TOO_LARGE'
]) {
  assert.ok(storeSource.includes(requiredPrimitive), `store must include: ${requiredPrimitive}`);
}

for (const requiredSql of [
  'CREATE TABLE target_operation_intents',
  'CONSTRAINT target_operation_intents_operation_key_unique UNIQUE (run_id, operation_key)',
  'CREATE TRIGGER target_operation_intents_append_only'
]) {
  assert.ok(nonTerminalEvidenceMigration.includes(requiredSql), `non-terminal evidence migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE OR REPLACE FUNCTION enforce_replay_snapshot_mutation()',
  'finalized replay permits only one append-only evidence item',
  'finalized replay evidence prefix is immutable'
]) {
  assert.ok(finalizedReplayAppendMigration.includes(requiredSql), `finalized replay append migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE INDEX tickets_status_id_idx',
  'CREATE INDEX runs_status_id_idx',
  'CREATE INDEX runs_ticket_id_idx',
  'CREATE INDEX events_run_position_idx',
  'CREATE INDEX events_run_type_position_idx'
]) {
  assert.ok(runtimeStateReadMigration.includes(requiredSql), `runtime state read migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE INDEX tickets_updated_id_idx',
  'CREATE INDEX tickets_work_context_status_updated_id_idx',
  'CREATE INDEX runs_ticket_status_updated_id_idx',
  'CREATE INDEX target_operation_intents_ticket_id_idx'
]) {
  assert.ok(ticketOperatorReadMigration.includes(requiredSql), `ticket operator read migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE INDEX tickets_unresolved_triage_id_idx',
  'CREATE INDEX runs_unresolved_triage_id_idx',
  "body->'triage'->>'required' = 'true'",
  "NULLIF(body->'triage'->>'resolvedAt', '') IS NULL"
]) {
  assert.ok(triageAuthorityMigration.includes(requiredSql), `triage authority migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE runtime_status_counts',
  'shard >= 0 AND shard < 256',
  'CONSTRAINT runtime_status_counts_nonnegative CHECK (count >= 0)',
  'LOCK TABLE tickets, runs IN SHARE ROW EXCLUSIVE MODE',
  'CREATE FUNCTION maintain_runtime_status_count()',
  'CREATE TRIGGER tickets_runtime_status_count',
  'CREATE TRIGGER runs_runtime_status_count',
  'CREATE INDEX runs_running_lease_expiry_id_idx'
]) {
  assert.ok(operationalStatusMigration.includes(requiredSql), `operational status migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE diagnostic_logs',
  'GENERATED ALWAYS AS IDENTITY',
  'CONSTRAINT diagnostic_logs_run_ticket_fk',
  'CONSTRAINT diagnostic_logs_context_run_ticket_fk',
  'CONSTRAINT diagnostic_logs_scope_shape',
  'CREATE INDEX diagnostic_logs_run_id_desc_idx',
  'CREATE INDEX diagnostic_logs_ticket_id_desc_idx',
  'CREATE INDEX diagnostic_logs_type_id_desc_idx',
  'CREATE TRIGGER diagnostic_logs_append_only'
]) {
  assert.ok(diagnosticLogMigration.includes(requiredSql), `diagnostic log migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'ADD COLUMN workspace_path TEXT',
  'ADD COLUMN artifact_path TEXT',
  'ADD COLUMN mutation_fingerprint TEXT',
  'requires an empty development operation receipt store',
  'CONSTRAINT operation_receipts_workspace_projection_shape',
  'CREATE INDEX operation_receipts_workspace_conflict_idx',
  'CREATE INDEX operation_receipts_artifact_owner_exact_idx',
  'CREATE INDEX operation_receipts_artifact_owner_prefix_idx',
  'artifact_path text_pattern_ops'
]) {
  assert.ok(workspaceOwnershipMigration.includes(requiredSql),
    `workspace ownership migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CONSTRAINT operation_receipts_identity_owner_unique UNIQUE (id, run_id, ticket_id)',
  'CREATE TABLE operator_recovery_intents',
  'CONSTRAINT operator_recovery_intents_original_owner_fk',
  'CONSTRAINT operator_recovery_intents_original_unique UNIQUE (original_operation_receipt_id)',
  'CONSTRAINT operator_recovery_intents_recovery_key_unique UNIQUE (run_id, recovery_key)',
  'CREATE INDEX operator_recovery_intents_target_path_idx',
  'CREATE TRIGGER operator_recovery_intents_append_only'
]) {
  assert.ok(operatorRecoveryMigration.includes(requiredSql),
    `operator recovery migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'requires an empty development run store',
  'ADD COLUMN current_phase TEXT NOT NULL',
  'CONSTRAINT runs_current_phase_check',
  'CONSTRAINT runs_terminal_phase_shape',
  "current_phase IN ('planning', 'inspection', 'mutation', 'verification', 'terminalization')"
]) {
  assert.ok(runPhaseProjectionMigration.includes(requiredSql),
    `run phase projection migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE INDEX operation_receipts_run_performance_evidence_idx',
  "WHERE outcome = 'succeeded'",
  "operation IN ('writeFile', 'createFolder', 'renamePath', 'deletePath')"
]) {
  assert.ok(performanceAnalyticsReadMigration.includes(requiredSql),
    `performance analytics read migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE work_contexts',
  'GENERATED ALWAYS AS IDENTITY',
  'CONSTRAINT work_contexts_status_check',
  'CONSTRAINT work_contexts_body_object',
  'CONSTRAINT work_contexts_revision_positive',
  'CREATE INDEX work_contexts_status_id_idx',
  'CREATE TRIGGER work_contexts_revision_guard'
]) {
  assert.ok(workContextCatalogMigration.includes(requiredSql),
    `Work Context catalog migration must include: ${requiredSql}`);
}
for (const requiredSql of [
  'CREATE TABLE browser_targets',
  'CREATE TABLE work_types',
  'CREATE TABLE allocation_plans',
  'CREATE TABLE message_threads',
  'CONSTRAINT message_threads_run_ticket_fk',
  'CREATE TABLE message_thread_messages',
  'CREATE TRIGGER message_thread_messages_append_only',
  'CREATE TABLE http_sessions',
  'CREATE INDEX http_sessions_expires_at_idx'
]) {
  assert.ok(applicationStateMigration.includes(requiredSql),
    `application-state migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE local_connector_objects',
  'work_context_id BIGINT NOT NULL REFERENCES work_contexts(id) ON DELETE RESTRICT',
  'CREATE TRIGGER local_connector_objects_revision_guard',
  'CREATE INDEX local_connector_objects_work_context_id_id_idx'
]) {
  assert.ok(localConnectorObjectsMigration.includes(requiredSql),
    `local connector object migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'reset development runs before migrating',
  'ADD CONSTRAINT runs_configured_agent_fk',
  'REFERENCES configured_agents(id) ON DELETE RESTRICT'
]) {
  assert.ok(runAgentIntegrityMigration.includes(requiredSql),
    `run-agent integrity migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'requires disposable development tickets with current-format process-template provenance',
  'CONSTRAINT tickets_process_template_source_current_shape',
  'ADD COLUMN process_template_source_id BIGINT GENERATED ALWAYS AS',
  'ADD COLUMN process_template_source_version BIGINT GENERATED ALWAYS AS',
  'ADD COLUMN process_template_trigger_token TEXT GENERATED ALWAYS AS',
  'CONSTRAINT process_template_triggers_ticket_source_identity_unique',
  'CONSTRAINT tickets_process_template_trigger_source_fk',
  'DEFERRABLE INITIALLY DEFERRED',
  'CREATE INDEX tickets_process_template_source_idx'
]) {
  assert.ok(processTemplateTicketProvenanceMigration.includes(requiredSql),
    `process-template ticket provenance migration must include: ${requiredSql}`);
}

for (const requiredMethod of [
  'async listBrowserTargets',
  'async getOperation',
  'async listWorkTypes',
  'async createLocalConnectorObject',
  'async createAllocationPlan',
  'async createMessageThreadIfAbsent',
  'async appendMessageThreadMessage',
  'async getHttpSession',
  'async setHttpSession',
  'async purgeExpiredHttpSessions'
]) {
  assert.ok(applicationStateMethodsSource.includes(requiredMethod),
    `application-state repository must include: ${requiredMethod}`);
}

const diagnosticListStart = storeSource.indexOf('async listLogs({');

for (const requiredSql of [
  'CREATE TABLE configured_agents',
  'GENERATED ALWAYS AS IDENTITY',
  'CONSTRAINT configured_agents_name_unique',
  'CONSTRAINT configured_agents_provider_check',
  'CONSTRAINT configured_agents_body_object',
  'CONSTRAINT configured_agents_revision_positive',
  'CREATE INDEX configured_agents_provider_id_idx',
  'CREATE INDEX configured_agents_name_lower_id_idx',
  'CREATE TRIGGER configured_agents_revision_guard',
  'CREATE TABLE agent_group_memberships',
  'CONSTRAINT agent_group_memberships_pkey PRIMARY KEY (agent_id, group_id)',
  'CONSTRAINT agent_group_memberships_agent_fk FOREIGN KEY (agent_id) REFERENCES configured_agents(id) ON DELETE CASCADE',
  'CONSTRAINT agent_group_memberships_group_positive',
  'CHECK (group_id > 0)',
  'CREATE INDEX agent_group_memberships_group_agent_idx'
]) {
  assert.ok(configuredAgentCatalogMigration.includes(requiredSql),
    `configured-agent catalog migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE access_permissions',
  'CREATE INDEX access_permissions_name_c_idx',
  'CREATE TRIGGER access_permissions_migration_owned',
  'BEFORE INSERT OR UPDATE OR DELETE ON access_permissions',
  'CREATE TABLE access_groups',
  'CONSTRAINT access_groups_name_unique',
  'CREATE TRIGGER access_groups_revision_guard',
  'CREATE TABLE access_group_permissions',
  'CONSTRAINT access_group_permissions_permission_fk',
  'CREATE TABLE access_users',
  'CONSTRAINT access_users_username_unique',
  'CREATE TRIGGER access_users_revision_guard',
  'CREATE TABLE user_group_memberships',
  'CONSTRAINT user_group_memberships_user_fk',
  'ADD CONSTRAINT agent_group_memberships_group_fk',
  'ADD COLUMN assignment_group_id BIGINT GENERATED ALWAYS AS',
  'CONSTRAINT tickets_assignment_group_fk'
]) {
  assert.ok(accessCatalogAuthorityMigration.includes(requiredSql),
    `access-catalog authority migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE workflow_definitions',
  'CREATE INDEX workflow_definitions_enabled_id_c_idx',
  'CREATE TRIGGER workflow_definitions_revision_guard',
  'requires disposable PostgreSQL workflow-ticket data to be reset',
  'ADD COLUMN workflow_definition_id TEXT GENERATED ALWAYS AS',
  'CONSTRAINT tickets_workflow_definition_fk'
]) {
  assert.ok(workflowCatalogAuthorityMigration.includes(requiredSql),
    `workflow-catalog authority migration must include: `);
}

for (const requiredSql of [
  'CREATE TABLE model_routing_policies',
  'CREATE INDEX model_routing_policies_dispatch_idx',
  'CREATE TRIGGER model_routing_policies_revision_guard',
  'requires disposable PostgreSQL ticket routing-policy data to be reset',
  'no JSON importer or legacy compatibility path is provided',
  'CONSTRAINT model_routing_policies_work_context_fk',
  'ADD COLUMN routing_policy_id BIGINT GENERATED ALWAYS AS',
  'CONSTRAINT tickets_routing_policy_body_shape',
  'CONSTRAINT tickets_routing_policy_fk'
]) {
  assert.ok(modelRoutingPolicyAuthorityMigration.includes(requiredSql),
    `model-routing-policy authority migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE connectors',
  'CREATE INDEX connectors_work_context_status_id_idx',
  'CREATE TRIGGER connectors_revision_guard',
  'CREATE TABLE connector_status_counts',
  'CONSTRAINT connector_status_counts_identity',
  'CONSTRAINT connector_status_counts_nonnegative',
  'CREATE FUNCTION maintain_connector_status_count()',
  'CREATE TRIGGER connectors_status_count',
  'CREATE TABLE connector_receipts',
  'CREATE INDEX connector_receipts_refusal_id_desc_idx',
  'CONSTRAINT connector_receipts_connector_context_fk',
  'CREATE TRIGGER connector_receipts_append_only',
  'no JSON importer or legacy branch is provided'
]) {
  assert.ok(connectorAuthorityMigration.includes(requiredSql),
    `connector authority migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE watchers',
  'CREATE TABLE watcher_status_counts',
  'CREATE TRIGGER watchers_status_count',
  'CREATE TABLE watcher_observations',
  'CREATE INDEX watcher_observations_failure_id_desc_idx',
  'CREATE TRIGGER watcher_observations_append_only',
  'CREATE TABLE watcher_ticket_proposals',
  'CONSTRAINT watcher_ticket_proposals_disposition_shape',
  'CONSTRAINT watcher_ticket_proposals_observation_context_fk',
  'CONSTRAINT tickets_watcher_proposal_fk',
  'no JSON importer or legacy branch is provided'
]) {
  assert.ok(watcherAuthorityMigration.includes(requiredSql),
    `watcher authority migration must include: `);
}

for (const requiredSql of [
  'CREATE TABLE runtime_limit_config',
  'CONSTRAINT runtime_limit_config_singleton',
  'CONSTRAINT runtime_limit_config_values',
  'CONSTRAINT runtime_limit_config_revision_positive',
  'CONSTRAINT runtime_limit_config_audit_shape',
  'CREATE TRIGGER runtime_limit_config_revision_guard',
  'no JSON importer or legacy branch'
]) {
  assert.ok(runtimeLimitConfigMigration.includes(requiredSql),
    `runtime-limit config migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'CREATE TABLE process_templates',
  'CONSTRAINT process_templates_schedule_cursor',
  'CREATE TRIGGER process_templates_revision_guard',
  'CREATE TABLE process_template_status_counts',
  'CONSTRAINT process_template_status_counts_shard_range',
  'CONSTRAINT process_template_status_counts_nonnegative',
  'CREATE FUNCTION maintain_process_template_status_count()',
  'CREATE TRIGGER process_templates_status_count',
  'CREATE TABLE process_template_versions',
  'supersedes_version_id TEXT REFERENCES process_template_versions(id) ON DELETE RESTRICT',
  'CONSTRAINT process_template_versions_activation_shape',
  'CREATE FUNCTION enforce_process_template_version_immutability()',
  'process-template version activation provenance is immutable',
  'CREATE TRIGGER process_template_versions_immutability_guard',
  'CREATE UNIQUE INDEX process_template_versions_one_active_idx',
  'CREATE UNIQUE INDEX process_template_versions_one_draft_idx',
  'CREATE TABLE process_template_triggers',
  'CONSTRAINT process_template_triggers_schedule_shape',
  'CREATE TRIGGER process_template_triggers_append_only'
]) {
  assert.ok(processTemplateProjectionMigration.includes(requiredSql),
    `process-template projection migration must include: ${requiredSql}`);
}

for (const requiredSql of [
  'process_template_versions_identity_unique',
  'process_templates_active_version_fk',
  'DEFERRABLE INITIALLY DEFERRED',
  'process_templates_schedule_body_shape',
  'process_template_triggers_template_version_fk'
]) {
  assert.ok(processTemplateAuthorityMigration.includes(requiredSql),
    `process-template authority migration must include: `);
}
const diagnosticListEnd = storeSource.indexOf('\n  async listLogsForRuns(', diagnosticListStart);
const diagnosticListSource = storeSource.slice(diagnosticListStart, diagnosticListEnd);
assert.ok(diagnosticListSource.includes("FROM ${this.table('diagnostic_logs')}"));
assert.ok(diagnosticListSource.includes('LIMIT ${limitRef}'));
assert.ok(!/OFFSET|COUNT\(\*\)/.test(diagnosticListSource));

const operationalSummaryStart = storeSource.indexOf('async getRuntimeOperationalSummary(');
const operationalSummaryEnd = storeSource.indexOf('\n  async appendRunLog(', operationalSummaryStart);
const operationalSummarySource = storeSource.slice(operationalSummaryStart, operationalSummaryEnd);
assert.ok(operationalSummarySource.includes("FROM ${this.table('runtime_status_counts')}"));
assert.ok(!operationalSummarySource.includes("FROM ${this.table('tickets')}"));

assert.ok(!/appendFileSync|writeFileSync/.test(storeSource), 'PostgreSQL authority must not write JSON files');
assert.ok(!/upsertTicket|upsertRun|legacy/i.test(storeSource), 'cutover store must not carry development-data compatibility APIs');

console.log('PASS: PostgreSQL persistence contract — PostgreSQL-only backend, transactional authority, shared coordination, sessions, application state, and no JSON dual write');
