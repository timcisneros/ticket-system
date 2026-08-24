#!/usr/bin/env node
'use strict';

const {
  PostgresRuntimeStore,
  ProcessExecutionIntentConflictError,
  ProcessExecutionStateError
} = require('../persistence/postgres/store');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');

const assert = createAsserter();
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function intentFor({ run, agent, operationIdentity, launchPlanHash = SHA_A }) {
  return {
    operationIdentity,
    runId: run.id,
    ticketId: run.ticketId,
    actingAgentId: agent.id,
    stepId: '1',
    runtimePhase: 'verification',
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    policySnapshotHash: SHA_A,
    runtimeCapabilityGeneration: `process-runtime-v1-${SHA_A}`,
    launchPlanVersion: 1,
    launchPlanHash,
    launchPlan: {
      version: 1,
      operationIdentity,
      authority: 'immutable-test-plan'
    },
    workspaceSnapshotId: 'snapshot-opaque-001',
    workspaceManifestHash: SHA_A,
    materializerGeneration: 'materializer-v1-test',
    containmentGenerationId: `sandbox-containment-v1-${SHA_A}`,
    rootfsId: 'node-runtime-v1',
    rootfsManifestHash: SHA_A,
    executableIdentityHash: SHA_A,
    executionPolicyHash: SHA_A,
    filesystemPolicyHash: SHA_A
  };
}

async function main() {
  await withHarness('process runtime lifecycle PostgreSQL', async ({
    store,
    databaseUrl,
    schema
  }) => {
    const peer = new PostgresRuntimeStore({
      connectionString: databaseUrl,
      schema,
      lockTimeoutMs: 5_000
    });
    try {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `Process lifecycle ${Date.now()}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: ''
        },
        groupIds: [],
        changedBy: 'process-runtime-lifecycle-test'
      })).agent;
      const ticket = (await store.createTicketWithEvent({
        ticket: {
          status: 'open',
          title: 'Process lifecycle authority',
          assignmentTargetType: 'agent',
          assignmentTargetId: agent.id,
          assignmentMode: 'individual'
        }
      })).ticket;
      const run = await store.createRun({
        ticketId: ticket.id,
        agentId: agent.id,
        status: 'pending',
        executionMode: 'agent'
      });
      const operationIdentity = `process-operation:${'1'.repeat(64)}`;
      const intent = intentFor({ run, agent, operationIdentity });

      const raced = await Promise.all([
        store.createProcessExecutionIntent(intent),
        peer.createProcessExecutionIntent(structuredClone(intent))
      ]);
      assert(raced.filter(result => result.inserted).length === 1,
        'concurrent runtime instances commit one durable intent');
      assert(raced[0].record.operationIdentity === raced[1].record.operationIdentity &&
        raced[0].record.launchPlanHash === raced[1].record.launchPlanHash,
      'exact concurrent replay returns the same immutable authority');

      const replay = await peer.createProcessExecutionIntent(structuredClone(intent));
      assert(replay.inserted === false && replay.record.lifecycleState === 'intent',
        'exact intent replay is idempotent');
      let conflict = null;
      try {
        await store.createProcessExecutionIntent({
          ...intent,
          launchPlanHash: SHA_B
        });
      } catch (error) {
        conflict = error;
      }
      assert(conflict instanceof ProcessExecutionIntentConflictError &&
        conflict.code === 'PROCESS_EXECUTION_INTENT_CONFLICT',
      'same operation identity with different launch authority is a typed conflict');

      let concurrent = 0;
      let maximumConcurrent = 0;
      const lockEvents = [];
      await Promise.all([
        store.withProcessOperationLock(operationIdentity, async () => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          lockEvents.push({ tag: 'store', phase: 'enter' });
          await sleep(80);
          lockEvents.push({ tag: 'store', phase: 'leave' });
          concurrent -= 1;
        }),
        peer.withProcessOperationLock(operationIdentity, async () => {
          concurrent += 1;
          maximumConcurrent = Math.max(maximumConcurrent, concurrent);
          lockEvents.push({ tag: 'peer', phase: 'enter' });
          concurrent -= 1;
          lockEvents.push({ tag: 'peer', phase: 'leave' });
        })
      ]);
      // THE CONTRACT (docs/PROCESS_EXECUTION_CONTRACT.md): the session
      // advisory-lock family serializes operation ownership — exactly ONE
      // holder per canonical identity at any instant. It does NOT promise
      // WHICH contender acquires first: the two stores own independent pools,
      // so either may win the acquisition race. Mutual exclusion is therefore
      // proved structurally — four events, alternating enter/leave per tag,
      // inner pair sharing one tag, never overlapping — rather than by a
      // positional order that silently assumes `store` always wins.
      const serializedExclusively =
        maximumConcurrent === 1 &&
        lockEvents.length === 4 &&
        lockEvents[0].phase === 'enter' &&
        lockEvents[3].phase === 'leave' &&
        lockEvents[0].tag === lockEvents[1].tag &&
        lockEvents[2].tag === lockEvents[3].tag &&
        lockEvents[0].tag !== lockEvents[2].tag;
      assert(serializedExclusively,
      'the canonical PostgreSQL advisory-lock family serializes operation ownership');

      let record = await store.getProcessOperation(operationIdentity);
      record = await store.transitionProcessOperation({
        operationIdentity,
        expectedStates: ['intent'],
        expectedRevision: record.revision,
        changes: {
          lifecycleState: 'active',
          launcherAcceptanceIdentity:
            `process-launcher-acceptance:${'2'.repeat(64)}`,
          lastReconciliationResult: { kind: 'launcher_accepted' }
        }
      });
      assert(record.lifecycleState === 'active' && record.startedAt === null,
        'launcher acceptance is durable without inventing a process start timestamp');

      let staleTransition = null;
      try {
        await peer.transitionProcessOperation({
          operationIdentity,
          expectedStates: ['intent'],
          expectedRevision: 1,
          changes: { lastReconciliationResult: { kind: 'stale' } }
        });
      } catch (error) {
        staleTransition = error;
      }
      assert(staleTransition instanceof ProcessExecutionStateError,
        'compare-and-set rejects a stale lifecycle transition');

      const startedAt = new Date().toISOString();
      const endedAt = new Date(Date.now() + 5).toISOString();
      const terminalResult = {
        operationIdentity,
        terminalOutcome: 'completed',
        startedAt,
        endedAt,
        durationMs: 5,
        exitCode: 0,
        signal: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        combinedOutputBytes: 0,
        stdoutSha256: EMPTY_SHA,
        stderrSha256: EMPTY_SHA,
        outputComplete: true,
        resourceCause: null,
        enforcementCause: null,
        cpuThrottledEvents: 1,
        launcherEnvironment: { HOME: '/nonexistent', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
          PATH: '/usr/bin:/bin', TMPDIR: '/tmp' }
      };
      record = await store.transitionProcessOperation({
        operationIdentity,
        expectedStates: ['active'],
        expectedRevision: record.revision,
        changes: {
          lifecycleState: 'finalizing',
          startedAt,
          terminalAt: endedAt,
          terminalOutcome: 'completed',
          terminalResult,
          terminalResultHash: SHA_B,
          exitCode: 0,
          stdoutByteCount: 0,
          stdoutSha256: EMPTY_SHA,
          stderrByteCount: 0,
          stderrSha256: EMPTY_SHA,
          combinedOutputByteCount: 0
        }
      });
      assert(record.lifecycleState === 'finalizing' &&
        record.requiredEvidenceState === 'pending',
      'terminal launcher facts persist before artifact and evidence completion');

      record = await store.transitionProcessOperation({
        operationIdentity,
        expectedStates: ['finalizing'],
        expectedRevision: record.revision,
        changes: {
          stdoutArtifact: {
            version: 1, id: 'stdout-id', path: 'process/hash/stdout.bin',
            stream: 'stdout', byteCount: 0, sha256: EMPTY_SHA
          },
          stderrArtifact: {
            version: 1, id: 'stderr-id', path: 'process/hash/stderr.bin',
            stream: 'stderr', byteCount: 0, sha256: EMPTY_SHA
          }
        }
      });
      record = await store.transitionProcessOperation({
        operationIdentity,
        expectedStates: ['finalizing'],
        expectedRevision: record.revision,
        changes: {
          lifecycleState: 'terminal',
          requiredEvidenceState: 'complete'
        }
      });
      assert(record.lifecycleState === 'terminal' &&
        record.requiredEvidenceState === 'complete' &&
        record.launcherOutputAcknowledged === false,
      'terminal state requires durable facts, artifacts, and required evidence');
      assert((await store.listProcessOperationsRequiringReconciliation())
        .some(item => item.operationIdentity === operationIdentity),
      'unacknowledged terminal output remains in startup reconciliation authority');
      record = await store.transitionProcessOperation({
        operationIdentity,
        expectedStates: ['terminal'],
        expectedRevision: record.revision,
        changes: { launcherOutputAcknowledged: true }
      });
      assert(!(await store.listProcessOperationsRequiringReconciliation())
        .some(item => item.operationIdentity === operationIdentity),
      'durable acknowledgement removes a terminal operation from reconciliation');

      let immutableRewrite = null;
      try {
        await store.pool.query(
          `UPDATE ${store.table('process_operations')}
           SET launch_plan_hash = $2, revision = revision + 1
           WHERE operation_identity = $1`,
          [operationIdentity, SHA_B]
        );
      } catch (error) {
        immutableRewrite = error;
      }
      assert(Boolean(immutableRewrite) &&
        /authority is immutable/.test(immutableRewrite.message),
      'database trigger refuses an immutable launch-authority rewrite');

      const columns = await store.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'process_operations'`,
        [schema]
      );
      const names = new Set(columns.rows.map(row => row.column_name));
      assert(!names.has('pid') && !names.has('cgroup_path') &&
        !names.has('workspace_path') && !names.has('rootfs_path'),
      'durable lifecycle stores no PID or host path as operation authority');
    } finally {
      await peer.close();
    }
  });
  console.log(`PASS: process runtime lifecycle PostgreSQL (${assert.count()} assertions)`);
}

main().catch(error => {
  console.error(`FAIL: process runtime lifecycle PostgreSQL — ${error.stack || error.message}`);
  process.exit(1);
});
