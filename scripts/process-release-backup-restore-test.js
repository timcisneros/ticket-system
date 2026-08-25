#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PostgresRuntimeStore } = require('../persistence/postgres/store');
const {
  buildCompletionAuthoritySnapshot,
  buildCompletionDecision,
  canonicalJson
} = require('../runtime/completion-decision-contract');
const {
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  ProcessExecutionController
} = require('../runtime/process-execution-controller');
const {
  ProcessOutputArtifactStore
} = require('../runtime/process-output-artifact-store');
const {
  buildProcessSupervisionProjection
} = require('../runtime/process-supervision');
const { buildRuntimeBudgetSnapshot } = require('../runtime/runtime-budget-contract');
const { withHarness } = require('./postgres-test-harness');

const BASE_SOURCE_REVISION = '1c1fc2878acbdab57303e749c3a73eb7f606edc0';

class ProcessReleaseBackupError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ProcessReleaseBackupError';
    this.code = code;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new TypeError('PostgreSQL backup test schema identity is invalid');
  }
  return `"${value}"`;
}

function toolAvailable(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new ProcessReleaseBackupError(
      `${command} is required for the PostgreSQL release backup regression`,
      'PROCESS_RELEASE_BACKUP_TOOL_UNAVAILABLE'
    );
  }
  if (result.error || result.status !== 0) {
    throw new ProcessReleaseBackupError(
      `${command} availability check failed`,
      'PROCESS_RELEASE_BACKUP_TOOL_UNAVAILABLE'
    );
  }
}

function postgresToolEnvironment(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (_) {
    throw new ProcessReleaseBackupError(
      'PostgreSQL backup connection authority is invalid',
      'PROCESS_RELEASE_POSTGRES_BACKUP_FAILED'
    );
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new ProcessReleaseBackupError(
      'PostgreSQL backup connection authority is invalid',
      'PROCESS_RELEASE_POSTGRES_BACKUP_FAILED'
    );
  }
  return {
    environment: {
      ...process.env,
      PGHOST: parsed.hostname,
      ...(parsed.port ? { PGPORT: parsed.port } : {}),
      ...(parsed.username ? { PGUSER: decodeURIComponent(parsed.username) } : {}),
      ...(parsed.password ? { PGPASSWORD: decodeURIComponent(parsed.password) } : {}),
      PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
      ...(parsed.searchParams.get('sslmode')
        ? { PGSSLMODE: parsed.searchParams.get('sslmode') }
        : {})
    },
    databaseName: decodeURIComponent(parsed.pathname.slice(1))
  };
}

function runPostgresTool(command, args, databaseUrl, failureCode) {
  const connection = postgresToolEnvironment(databaseUrl);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: connection.environment,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new ProcessReleaseBackupError(
      `${command} is required for the PostgreSQL release backup regression`,
      'PROCESS_RELEASE_BACKUP_TOOL_UNAVAILABLE'
    );
  }
  if (result.error || result.status !== 0) {
    const detail = String(
      result.error ? result.error.message : result.stderr || result.stdout || ''
    ).trim().slice(0, 2000);
    throw new ProcessReleaseBackupError(
      `${command} failed${detail ? `: ${detail}` : ''}`,
      failureCode
    );
  }
}

function runtimeBudgetSnapshot() {
  return buildRuntimeBudgetSnapshot({
    runtimeLimits: {
      maxAttempts: 3,
      maxExecutionSteps: 12,
      maxModelRequestsPerRun: 6,
      maxWorkspaceOperationsPerRun: 8,
      maxProcessOperationsPerRun: 2,
      maxBrowserOperationsPerRun: 3,
      maxRuntimeDurationMs: 90_000,
      maxOutputArtifactBytesPerRun: 65_536,
      revision: 17
    },
    executionPolicy: {
      mode: 'assisted',
      requireVerification: 'when_declared',
      autoRetry: false,
      maxAttempts: null,
      maxExecutionSteps: null,
      maxRuntimeMs: null,
      maxModelRequests: null,
      maxWorkspaceOperations: null,
      maxProcessOperations: null,
      maxBrowserOperations: null,
      maxOutputArtifactBytes: null,
      allowWorkspaceWrites: true,
      allowParallelRuns: false,
      allowChildTickets: false,
      workspaceScope: 'shared'
    }
  });
}

async function publishArtifact(store, operationIdentity, stream, bytes) {
  const expectedSha256 = sha256(bytes);
  return store.publish({
    operationIdentity,
    stream,
    expectedBytes: bytes.length,
    expectedSha256,
    readChunk: async ({ offset, maximumBytes }) => {
      const chunk = bytes.subarray(offset, offset + maximumBytes);
      return {
        offset,
        bytes: chunk,
        end: offset + chunk.length === bytes.length
      };
    }
  });
}

function processReceipt({
  operation,
  stdoutArtifact,
  stderrArtifact
}) {
  return {
    version: 1,
    operationIdentity: operation.operationIdentity,
    targetId: operation.targetId,
    profileId: operation.profileId,
    runtimePhase: operation.runtimePhase,
    launchPlanHash: operation.launchPlanHash,
    policySnapshotHash: operation.policySnapshotHash,
    runtimeCapabilityGeneration: operation.runtimeCapabilityGeneration,
    containmentGenerationId: operation.containmentGenerationId,
    materializerGeneration: operation.materializerGeneration,
    workspaceSnapshotId: operation.workspaceSnapshotId,
    workspaceManifestHash: operation.workspaceManifestHash,
    rootfsId: operation.rootfsId,
    rootfsManifestHash: operation.rootfsManifestHash,
    executableIdentityHash: operation.executableIdentityHash,
    terminalOutcome: operation.terminalOutcome,
    terminalResultHash: operation.terminalResultHash,
    exitCode: operation.exitCode,
    signal: operation.terminatingSignal,
    resourceCause: operation.resourceCause,
    stdoutArtifact,
    stderrArtifact,
    stdoutByteCount: operation.stdoutByteCount,
    stderrByteCount: operation.stderrByteCount,
    combinedOutputByteCount: operation.combinedOutputByteCount
  };
}

function processConsequence(receipt) {
  return {
    operationIdentity: receipt.operationIdentity,
    operation: 'runProcess',
    targetId: receipt.targetId,
    profileId: receipt.profileId,
    outcome: receipt.terminalOutcome === 'completed' ? 'succeeded' : 'failed',
    terminalOutcome: receipt.terminalOutcome,
    terminalResultHash: receipt.terminalResultHash,
    stdoutArtifact: receipt.stdoutArtifact,
    stderrArtifact: receipt.stderrArtifact
  };
}

async function seedSource(store, artifactRoot) {
  const agent = (await store.createConfiguredAgent({
    value: {
      name: `Release backup agent ${Date.now()}`,
      provider: 'openai',
      model: 'gpt-test',
      apiKey: ''
    },
    groupIds: [],
    changedBy: 'process-release-backup-restore-test'
  })).agent;

  // Advance both ticket and run sequences so identity preservation cannot pass
  // merely because two independently seeded databases both begin at one.
  for (let index = 0; index < 4; index += 1) {
    const dummyTicket = await store.createTicket({
      status: 'open',
      title: `Release backup sequence sentinel ${index}`,
        objective: `Release backup sequence sentinel ${index}`,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    });
    await store.createRun({
      ticketId: dummyTicket.id,
      agentId: agent.id,
      status: 'pending',
      executionMode: 'agent'
    });
  }

  const objective = 'Preserve exact durable process authority through release backup';
  const ticket = (await store.createTicketWithEvent({
    ticket: {
      status: 'in_progress',
      title: 'Release backup authority',
      objective,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    }
  })).ticket;
  const budget = runtimeBudgetSnapshot();
  const capturedAt = new Date().toISOString();
  const completionAuthority = buildCompletionAuthoritySnapshot({
    objective,
    kind: 'unrecognized',
    recognized: false,
    intent: 'model_driven',
    completionPolicy: 'explicit_evidence_required',
    verificationPolicy: 'when_declared',
    capturedAt
  });
  const leaseOwner = `release-backup-owner-${crypto.randomBytes(6).toString('hex')}`;
  let run = await store.createRun({
    ticketId: ticket.id,
    agentId: agent.id,
    status: 'pending',
    executionMode: 'agent',
    leaseOwner,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    runtimeBudgetSnapshot: budget,
    completionAuthoritySnapshot: completionAuthority,
    executionPolicySnapshot: {
      requireVerification: 'when_declared'
    }
  });
  run = (await store.transitionRun({
    runId: run.id,
    expectedRevision: run.revision,
    fromStatuses: ['pending'],
    toStatus: 'running',
    leaseOwner,
    eventType: 'run.started',
    eventPayload: { source: 'process-release-backup-restore-test' }
  })).run;
  await store.initializeRunReplay({
    runId: run.id,
    ticketId: ticket.id,
    snapshot: {
      runId: run.id,
      ticketId: ticket.id,
      events: [],
      parsedModelPlans: [{ complete: false }],
      providerRequests: [],
      modelResponses: [],
      workspaceOperations: [],
      processExecutionLifecycle: []
    }
  });

  const operationIdentity = `process-operation:${sha256(
    Buffer.from(`backup:${ticket.id}:${run.id}`)
  )}`;
  const authorityHash = character => character.repeat(64);
  let operation = (await store.createProcessExecutionIntent({
    operationIdentity,
    runId: run.id,
    ticketId: ticket.id,
    actingAgentId: agent.id,
    stepId: '7',
    runtimePhase: 'verification',
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    policySnapshotHash: authorityHash('2'),
    runtimeCapabilityGeneration: `process-runtime-v1-${authorityHash('3')}`,
    launchPlanVersion: 1,
    launchPlanHash: authorityHash('4'),
    launchPlan: {
      version: 1,
      operationIdentity,
      authority: 'immutable-release-backup-fixture'
    },
    workspaceSnapshotId: `snapshot-release-backup-${run.id}`,
    workspaceManifestHash: authorityHash('5'),
    materializerGeneration: `materializer-v1-${authorityHash('6')}`,
    containmentGenerationId: `sandbox-containment-v1-${authorityHash('7')}`,
    rootfsId: 'node-runtime-v1',
    rootfsManifestHash: authorityHash('8'),
    executableIdentityHash: authorityHash('9'),
    executionPolicyHash: authorityHash('a'),
    filesystemPolicyHash: authorityHash('b')
  })).record;
  operation = await store.transitionProcessOperation({
    operationIdentity,
    expectedStates: ['intent'],
    expectedRevision: operation.revision,
    changes: {
      lifecycleState: 'active',
      launcherAcceptanceIdentity:
        `process-launcher-acceptance:${authorityHash('c')}`,
      lastReconciliationResult: {
        kind: 'launcher_accepted',
        observedAt: capturedAt
      }
    }
  });

  const stdoutBytes = Buffer.from('release backup stdout\\0bytes\n');
  const stderrBytes = Buffer.from('release backup stderr\n');
  const artifactStore = new ProcessOutputArtifactStore({ artifactRoot });
  const stdoutArtifact = await publishArtifact(
    artifactStore,
    operationIdentity,
    'stdout',
    stdoutBytes
  );
  const stderrArtifact = await publishArtifact(
    artifactStore,
    operationIdentity,
    'stderr',
    stderrBytes
  );
  const startedAt = new Date().toISOString();
  const endedAt = new Date(Date.now() + 11).toISOString();
  const terminalResult = {
    operationIdentity,
    terminalOutcome: 'completed',
    startedAt,
    endedAt,
    durationMs: 11,
    exitCode: 0,
    signal: null,
    stdoutBytes: stdoutBytes.length,
    stderrBytes: stderrBytes.length,
    combinedOutputBytes: stdoutBytes.length + stderrBytes.length,
    stdoutSha256: sha256(stdoutBytes),
    stderrSha256: sha256(stderrBytes),
    outputComplete: true,
    resourceCause: null,
    enforcementCause: null,
    cpuThrottledEvents: 2,
    launcherEnvironment: {
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: '/tmp'
    }
  };
  const terminalResultHash = hashProcessContractValue(terminalResult);
  operation = await store.transitionProcessOperation({
    operationIdentity,
    expectedStates: ['active'],
    expectedRevision: operation.revision,
    changes: {
      lifecycleState: 'finalizing',
      startedAt,
      terminalAt: endedAt,
      terminalOutcome: 'completed',
      terminalResult,
      terminalResultHash,
      exitCode: 0,
      stdoutByteCount: stdoutBytes.length,
      stdoutSha256: sha256(stdoutBytes),
      stderrByteCount: stderrBytes.length,
      stderrSha256: sha256(stderrBytes),
      combinedOutputByteCount: stdoutBytes.length + stderrBytes.length,
      stdoutArtifact,
      stderrArtifact,
      lastReconciliationResult: {
        kind: 'artifacts_published',
        observedAt: endedAt
      }
    }
  });

  const evidenceBinding = {
    runId: run.id,
    ticketId: ticket.id,
    operationIdentity,
    launchPlanHash: operation.launchPlanHash,
    policySnapshotHash: operation.policySnapshotHash,
    runtimeCapabilityGeneration: operation.runtimeCapabilityGeneration,
    containmentGenerationId: operation.containmentGenerationId,
    materializerGeneration: operation.materializerGeneration,
    rootfsId: operation.rootfsId,
    rootfsManifestHash: operation.rootfsManifestHash,
    executableIdentityHash: operation.executableIdentityHash,
    workspaceSnapshotId: operation.workspaceSnapshotId,
    workspaceManifestHash: operation.workspaceManifestHash
  };
  for (const [eventType, payload] of [
    ['process.terminal', {
      ...evidenceBinding,
      terminalOutcome: operation.terminalOutcome,
      terminalResultHash
    }],
    ['process.stdout_artifact', {
      ...evidenceBinding,
      artifact: stdoutArtifact
    }],
    ['process.stderr_artifact', {
      ...evidenceBinding,
      artifact: stderrArtifact
    }]
  ]) {
    await store.appendRunEvidence({
      runId: run.id,
      ticketId: ticket.id,
      evidenceKey: `release-backup:${operationIdentity}:${eventType}`,
      replayKey: 'processExecutionLifecycle',
      replayItem: {
        version: 1,
        evidenceType: eventType,
        ...payload
      },
      event: {
        type: eventType,
        ticketId: ticket.id,
        runId: run.id,
        stepId: operation.stepId,
        payload
      }
    });
  }

  const receiptDocument = processReceipt({
    operation,
    stdoutArtifact,
    stderrArtifact
  });
  const receiptResult = await store.recordOperationReceipt({
    runId: run.id,
    idempotencyKey: operationIdentity,
    stepId: operation.stepId,
    operation: 'runProcess',
    outcome: 'succeeded',
    targetId: operation.targetId,
    targetKind: 'process',
    targetResourceId: `${operation.targetId}/${operation.profileId}`,
    receipt: receiptDocument,
    eventType: null
  });
  operation = await store.transitionProcessOperation({
    operationIdentity,
    expectedStates: ['finalizing'],
    expectedRevision: operation.revision,
    changes: {
      lifecycleState: 'terminal',
      requiredEvidenceState: 'complete',
      lastReconciliationResult: {
        kind: 'durable_finalization_complete',
        observedAt: endedAt
      }
    }
  });
  operation = await store.transitionProcessOperation({
    operationIdentity,
    expectedStates: ['terminal'],
    expectedRevision: operation.revision,
    changes: {
      launcherOutputAcknowledged: true,
      lastReconciliationResult: {
        kind: 'launcher_output_acknowledged',
        observedAt: endedAt
      }
    }
  });

  const processProjection = processConsequence(receiptDocument);
  const existingEvents = await store.listRunEvents(run.id, { limit: 500 });
  const replay = await store.getReplaySnapshot(run.id);
  const finalizedReplay = {
    ...replay.snapshot,
    terminalStatus: 'completed',
    finalizedAt: endedAt
  };
  const terminalized = await store.terminalizeRun({
    runId: run.id,
    expectedRevision: run.revision,
    expectedReplayRevision: replay.revision,
    fromStatuses: ['running'],
    status: 'completed',
    leaseOwner,
    patch: {
      currentPhase: 'terminalization'
    },
    replaySnapshot: finalizedReplay,
    evaluation: {
      effectiveness: { status: 'unknown' },
      violations: { status: 'none' },
      browserEvidence: null
    },
    consequence: context => {
      const base = {
        version: 1,
        mutations: [],
        created: [],
        modified: [],
        updated: [],
        deleted: [],
        renamed: [],
        notifications: [],
        externalEffects: [],
        processOperations: [processProjection],
        verification: {
          postconditionsStatus: 'not_required',
          violationsStatus: 'none',
          browserEvidence: null
        }
      };
      return {
        ...base,
        completionDecision: buildCompletionDecision({
          run: context.run,
          replaySnapshot: context.replaySnapshot,
          events: [...existingEvents, ...context.events],
          operations: [processProjection],
          consequence: base,
          verificationContract: null,
          evaluatedAt: endedAt
        })
      };
    },
    executionEvent: {
      type: 'run.execution_completed',
      payload: { status: 'completed', completedAt: endedAt }
    },
    replayEvent: {
      type: 'run.snapshot_finalized',
      payload: { status: 'completed', finalizedAt: endedAt }
    },
    beforeEvaluationEvents: [{
      type: 'run.violations_checked',
      payload: { status: 'none' }
    }],
    terminalEvent: {
      type: 'run.terminalized',
      payload: { status: 'completed' }
    }
  });

  await store.setProcessExecutionAdmission({
    enabled: true,
    releaseContractHash: authorityHash('d'),
    sourceRevision: BASE_SOURCE_REVISION,
    applicationVersion: '1.0.0',
    changedBy: 'process-release-backup-restore-test',
    reason: 'exercise restart-durable release authority through backup'
  });

  const stagingPath = path.join(
    artifactRoot,
    path.dirname(stdoutArtifact.path),
    `.stdout.${'f'.repeat(32)}.tmp`
  );
  fs.writeFileSync(stagingPath, 'must-not-be-published', { mode: 0o600 });
  const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stagingPath, staleAt, staleAt);

  return {
    agent,
    ticket,
    run: terminalized.run,
    operation,
    receiptId: receiptResult.record.id,
    receiptDocument,
    stdoutArtifact,
    stderrArtifact,
    budgetHash: budget.snapshotHash,
    completionAuthorityHash: completionAuthority.snapshotHash,
    completionDecisionHash:
      terminalized.consequence.completionDecision.decisionHash,
    terminalResultHash,
    stagingPath
  };
}

async function captureAuthority(store, seeded) {
  const [
    ticket,
    run,
    operation,
    receipts,
    consequence,
    replay,
    events,
    releaseState,
    migrationRows,
    maxTicketRow
  ] = await Promise.all([
    store.getTicket(seeded.ticket.id),
    store.getRun(seeded.run.id),
    store.getProcessOperation(seeded.operation.operationIdentity),
    store.listOperationReceipts(seeded.run.id, { limit: 100 }),
    store.getRunConsequence(seeded.run.id),
    store.getReplaySnapshot(seeded.run.id),
    store.listRunEvents(seeded.run.id, { limit: 500 }),
    store.getProcessExecutionReleaseState(),
    store.pool.query(
      `SELECT version, sha256
       FROM ${store.table('schema_migration_identities')}
       ORDER BY version`
    ),
    store.pool.query(`SELECT MAX(id)::bigint AS id FROM ${store.table('tickets')}`)
  ]);
  const supervision = buildProcessSupervisionProjection({
    run: {
      ...run,
      processPolicySnapshot: { version: 3 }
    },
    processOperations: [operation],
    events,
    receipts,
    launcherObservations: [{
      operationIdentity: operation.operationIdentity,
      availability: 'available',
      state: 'terminal',
      launcherOwnershipState: 'owned_terminal',
      processTreeState: 'confirmed_empty',
      terminalOutcome: operation.terminalOutcome,
      terminalResultHash: operation.terminalResultHash,
      observedAt: '2026-07-29T12:00:00.000Z'
    }]
  });
  const evidence = events
    .filter(event => event.type.startsWith('process.') ||
      event.type === 'run.completion_decided')
    .map(event => ({
      seq: event.seq,
      type: event.type,
      payload: event.payload
    }));
  return {
    ticketId: ticket.id,
    runId: run.id,
    operationIdentity: operation.operationIdentity,
    receiptId: receipts[0].id,
    receiptIdentity: receipts[0].idempotencyKey,
    budgetSnapshotHash: run.runtimeBudgetSnapshot.snapshotHash,
    completionAuthorityHash: run.completionAuthoritySnapshot.snapshotHash,
    completionDecisionHash:
      consequence.consequence.completionDecision.decisionHash,
    terminalResultHash: operation.terminalResultHash,
    artifacts: [operation.stdoutArtifact, operation.stderrArtifact],
    evidence,
    evidenceCount: evidence.length,
    releaseState,
    migrationIdentities: migrationRows.rows,
    replaySnapshotHash: replay.snapshotHash,
    consequence: consequence.consequence,
    supervision,
    maxTicketId: Number(maxTicketRow.rows[0].id)
  };
}

function recoveryController(repository, launchCounter) {
  const unavailable = async () => {
    throw new Error('terminal restored operation must not invoke launcher authority');
  };
  return new ProcessExecutionController({
    repository,
    capabilityResolver: {
      resolveLaunchAuthority: unavailable,
      resolve: unavailable
    },
    materializerClient: {},
    launcherClient: {
      launch: async () => {
        launchCounter.count += 1;
        return unavailable();
      },
      getOperation: unavailable,
      cancelOperation: unavailable,
      readOutput: unavailable,
      acknowledgeOutput: unavailable
    },
    artifactStore: {
      publish: unavailable
    },
    workspaceTargetId: 'ticket-system-local'
  });
}

async function schemaExists(store, schema) {
  const result = await store.pool.query(
    'SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS present',
    [schema]
  );
  return result.rows[0].present === true;
}

async function main() {
  toolAvailable('pg_dump');
  toolAvailable('pg_restore');
  await withHarness('process release PostgreSQL archive restore', async ({
    store,
    databaseUrl,
    schema
  }) => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'process-release-backup-restore-')
    );
    const sourceArtifactRoot = path.join(temporaryRoot, 'artifacts-source');
    const artifactBackupRoot = path.join(temporaryRoot, 'artifacts-backup');
    const restoredArtifactRoot = path.join(temporaryRoot, 'artifacts-restored');
    const archivePath = path.join(temporaryRoot, 'postgres.custom');
    fs.mkdirSync(sourceArtifactRoot, { recursive: true, mode: 0o700 });

    const suffix = crypto.randomBytes(3).toString('hex');
    const preservedSchema = `${schema.slice(0, 48)}_src_${suffix}`;
    const restoredSchema = `${schema.slice(0, 48)}_rst_${suffix}`;
    let sourceRenamed = false;
    let restoredStore = null;
    try {
      const seeded = await seedSource(store, sourceArtifactRoot);
      const original = await captureAuthority(store, seeded);
      assert.ok(original.ticketId > 4 && original.runId > 4,
        'fixture uses nontrivial durable identities');
      assert.equal(original.receiptId, seeded.receiptId);
      assert.equal(original.budgetSnapshotHash, seeded.budgetHash);
      assert.equal(original.completionAuthorityHash, seeded.completionAuthorityHash);
      assert.equal(original.completionDecisionHash, seeded.completionDecisionHash);
      assert.equal(original.terminalResultHash, seeded.terminalResultHash);

      fs.cpSync(sourceArtifactRoot, artifactBackupRoot, {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true
      });
      runPostgresTool('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '--schema',
        schema,
        '--file',
        archivePath
      ], databaseUrl, 'PROCESS_RELEASE_POSTGRES_BACKUP_FAILED');
      const archiveMetadata = fs.statSync(archivePath);
      assert.ok(archiveMetadata.isFile() && archiveMetadata.size > 0,
        'pg_dump produced a nonempty custom-format archive');

      await store.pool.query(
        `ALTER SCHEMA ${quoteIdentifier(schema)}
         RENAME TO ${quoteIdentifier(preservedSchema)}`
      );
      sourceRenamed = true;
      runPostgresTool('pg_restore', [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        postgresToolEnvironment(databaseUrl).databaseName,
        archivePath
      ], databaseUrl, 'PROCESS_RELEASE_POSTGRES_RESTORE_FAILED');
      await store.pool.query(
        `ALTER SCHEMA ${quoteIdentifier(schema)}
         RENAME TO ${quoteIdentifier(restoredSchema)}`
      );
      await store.pool.query(
        `ALTER SCHEMA ${quoteIdentifier(preservedSchema)}
         RENAME TO ${quoteIdentifier(schema)}`
      );
      sourceRenamed = false;

      fs.cpSync(artifactBackupRoot, restoredArtifactRoot, {
        recursive: true,
        errorOnExist: true,
        preserveTimestamps: true
      });
      restoredStore = new PostgresRuntimeStore({
        connectionString: databaseUrl,
        schema: restoredSchema
      });
      const migrationStatus = await restoredStore.getMigrationStatus();
      assert.equal(migrationStatus.fullyApplied, true,
        'restored schema opens through PostgresRuntimeStore without reseeding');
      const restored = await captureAuthority(restoredStore, seeded);
      assert.equal(canonicalJson(restored), canonicalJson(original),
        'PostgreSQL restore preserves every captured durable identity and hash');

      const restoredArtifacts = new ProcessOutputArtifactStore({
        artifactRoot: restoredArtifactRoot
      });
      for (const artifact of restored.artifacts) {
        const verification = await restoredArtifacts.verifyPublished(artifact);
        assert.equal(verification.byteCount, artifact.byteCount);
        assert.equal(verification.sha256, artifact.sha256);
      }
      const cleanup = await restoredArtifacts.cleanupAbandonedTemporaryFiles({
        olderThanMs: 60_000,
        nowMs: Date.now()
      });
      assert.equal(cleanup.removed, 1,
        'restored staging bytes are cleaned and never treated as published');
      assert.equal(fs.existsSync(path.join(
        restoredArtifactRoot,
        path.relative(sourceArtifactRoot, seeded.stagingPath)
      )), false);

      const missingArtifact = restored.artifacts[0];
      const missingPath = path.join(
        restoredArtifactRoot,
        ...missingArtifact.path.split('/')
      );
      const probePath = path.join(temporaryRoot, 'missing-artifact-probe.bin');
      fs.renameSync(missingPath, probePath);
      let missingError = null;
      try {
        await restoredArtifacts.verifyPublished(missingArtifact);
      } catch (error) {
        missingError = error;
      } finally {
        fs.renameSync(probePath, missingPath);
      }
      assert.equal(missingError && missingError.code, 'PROCESS_OUTPUT_UNAVAILABLE',
        'missing restored artifact bytes fail truthfully rather than becoming empty');
      await restoredArtifacts.verifyPublished(missingArtifact);

      const launchCounter = { count: 0 };
      const restoredRun = await restoredStore.getRun(seeded.run.id);
      const recovery = recoveryController(restoredStore, launchCounter);
      assert.deepEqual(await recovery.reconcileRun(restoredRun), []);
      assert.equal(launchCounter.count, 0,
        'restored terminal operation is not relaunched by canonical recovery');

      const readsBefore = {
        events: (await restoredStore.listRunEvents(seeded.run.id, {
          limit: 500
        })).length,
        receipts: (await restoredStore.listOperationReceipts(seeded.run.id, {
          limit: 100
        })).length
      };
      await captureAuthority(restoredStore, seeded);
      await captureAuthority(restoredStore, seeded);
      const readsAfter = {
        events: (await restoredStore.listRunEvents(seeded.run.id, {
          limit: 500
        })).length,
        receipts: (await restoredStore.listOperationReceipts(seeded.run.id, {
          limit: 100
        })).length
      };
      assert.deepEqual(readsAfter, readsBefore,
        'repeated restored reads create no events, receipts, or side effects');

      const newTicket = await restoredStore.createTicket({
        status: 'open',
        title: 'Post-restore sequence proof',
        objective: 'Post-restore sequence proof',
        assignmentTargetType: 'agent',
        assignmentTargetId: seeded.agent.id,
        assignmentMode: 'individual'
      });
      assert.ok(newTicket.id > restored.maxTicketId,
        'restored sequences admit a new noncolliding durable identity');

      console.log(JSON.stringify({
        status: 'passed',
        archiveFormat: 'postgresql-custom',
        archiveBytes: archiveMetadata.size,
        sourceTicketId: original.ticketId,
        sourceRunId: original.runId,
        operationIdentity: original.operationIdentity,
        evidenceCount: original.evidenceCount,
        artifactCount: original.artifacts.length,
        restoredSequenceId: newTicket.id,
        launcherLaunchCountAfterRestore: launchCounter.count
      }));
    } finally {
      if (restoredStore) {
        try { await restoredStore.close(); } catch (_) {}
      }
      try {
        await store.pool.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(restoredSchema)} CASCADE`
        );
      } catch (_) {}
      if (sourceRenamed) {
        try {
          if (await schemaExists(store, schema)) {
            await store.pool.query(
              `DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`
            );
          }
          if (await schemaExists(store, preservedSchema)) {
            await store.pool.query(
              `ALTER SCHEMA ${quoteIdentifier(preservedSchema)}
               RENAME TO ${quoteIdentifier(schema)}`
            );
          }
        } catch (_) {}
      }
      try {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
      } catch (_) {}
    }
  });
}

main().then(() => {
  console.log('PASS: real PostgreSQL archive and paired artifact restore');
}).catch(error => {
  const code = error && error.code
    ? `${error.code}: `
    : '';
  console.error(`${code}${error.message || String(error)}`);
  process.exit(1);
});
