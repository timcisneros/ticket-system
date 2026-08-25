#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const {
  hashProcessContractValue
} = require('../runtime/process-execution-contract');
const {
  PROCESS_LAUNCHER_ENVIRONMENT
} = require('../runtime/process-authority-constants');
const { withHarness, createAsserter, sleep } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const assert = createAsserter();
const EMPTY_SHA = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

async function createProtocolServer(socketPath, handler) {
  const server = net.createServer(socket => {
    let bytes = Buffer.alloc(0);
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 4) return;
      const length = bytes.readUInt32BE(0);
      if (bytes.length !== length + 4) return;
      try {
        const request = JSON.parse(bytes.subarray(4).toString('utf8'));
        Promise.resolve(handler(request.operation, request.body)).then(result => {
          socket.end(frame({
            version: 1,
            requestId: request.requestId,
            ok: true,
            result
          }));
        }, error => {
          socket.end(frame({
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: {
              code: error.code || 'PROCESS_LAUNCHER_PROTOCOL_INVALID',
              message: error.message
            }
          }));
        });
      } catch (error) {
        socket.destroy(error);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function waitFor(operation, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function terminalStatus(status, terminalOutcome) {
  if (status.state === 'terminal') return status;
  const endedAt = new Date().toISOString();
  const result = {
    operationIdentity: status.operationIdentity,
    terminalOutcome,
    startedAt: new Date(Date.parse(endedAt) - 5).toISOString(),
    endedAt,
    durationMs: 5,
    exitCode: terminalOutcome === 'completed' ? 0 : null,
    signal: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    combinedOutputBytes: 0,
    stdoutSha256: EMPTY_SHA,
    stderrSha256: EMPTY_SHA,
    outputComplete: true,
    resourceCause: null,
    enforcementCause: terminalOutcome === 'cancelled'
      ? 'cancellation_requested'
      : null,
    cpuThrottledEvents: 0,
    launcherEnvironment: { ...PROCESS_LAUNCHER_ENVIRONMENT }
  };
  return {
    ...status,
    state: 'terminal',
    terminalResultHash: hashProcessContractValue(result),
    outputAvailable: true,
    result
  };
}

function intentFor(run, agent, operationIdentity) {
  const hash = 'a'.repeat(64);
  return {
    operationIdentity,
    runId: run.id,
    ticketId: run.ticketId,
    actingAgentId: agent.id,
    stepId: '1',
    runtimePhase: 'verification',
    targetId: 'ticket-system-local',
    profileId: 'syntax-check',
    policySnapshotHash: hash,
    runtimeCapabilityGeneration: `process-runtime-v1-${hash}`,
    launchPlanVersion: 1,
    launchPlanHash: hash,
    launchPlan: {
      version: 1,
      operationIdentity,
      immutableLeaseExpiryFixture: true
    },
    workspaceSnapshotId: `snapshot-${operationIdentity.slice(-12)}`,
    workspaceManifestHash: hash,
    materializerGeneration: 'materializer-v1-lease-expiry',
    containmentGenerationId: `sandbox-containment-v1-${hash}`,
    rootfsId: 'node-runtime-v1',
    rootfsManifestHash: hash,
    executableIdentityHash: hash,
    executionPolicyHash: hash,
    filesystemPolicyHash: hash
  };
}

async function createTicketRun(store, agent, title) {
  const ticket = (await store.createTicketWithEvent({
    ticket: {
      objective: 'Fixture requested outcome',
      status: 'open',
      title,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    },
    eventPayload: { source: 'process-lease-expiry-cancellation-test' }
  })).ticket;
  const run = await store.createRun({
    ticketId: ticket.id,
    agentId: agent.id,
    agentName: agent.name,
    runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
    executionPolicySnapshot: { requireVerification: 'when_declared' },
    status: 'pending',
    executionMode: 'agent'
  });
  await store.initializeRunReplay({
    runId: run.id,
    ticketId: ticket.id,
    snapshot: {
      version: 1,
      runId: run.id,
      ticketId: ticket.id,
      providerRequests: [],
      modelResponses: [],
      parsedModelPlans: [],
      workspaceOperations: [],
      processOperations: [],
      events: []
    }
  });
  return run;
}

async function markRunning(store, run, {
  owner,
  expired
}) {
  const result = await store.pool.query(
    `UPDATE ${store.table('runs')}
     SET status = 'running',
         current_phase = 'verification',
         started_at = COALESCE(started_at, clock_timestamp()),
         lease_owner = $2,
         lease_expires_at = clock_timestamp() +
           ($3::bigint * interval '1 millisecond'),
         last_heartbeat_at = clock_timestamp(),
         revision = revision + 1,
         updated_at = clock_timestamp()
     WHERE id = $1
     RETURNING *`,
    [run.id, owner, expired ? -30_000 : 300_000]
  );
  if (result.rowCount !== 1) throw new Error(`cannot mark run ${run.id} running`);
}

async function main() {
  await withHarness('process lease expiry cancellation PostgreSQL', async ({
    store,
    startServer
  }) => {
    const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'process-lease-expiry-'));
    const launcherSocket = path.join(privateRoot, 'launcher.sock');
    const artifactRoot = path.join(privateRoot, 'artifacts');
    const operations = new Map();
    const cancelOutcomes = new Map();
    const native = {
      launchCount: 0,
      cancelCount: new Map(),
      acknowledgeCount: new Map(),
      getBeforeCancelCount: new Map()
    };
    const launcherServer = await createProtocolServer(
      launcherSocket,
      (operation, body) => {
        if (operation === 'launch') {
          native.launchCount += 1;
          throw Object.assign(
            new Error('lease recovery must never submit a stored launch plan'),
            { code: 'PROCESS_EXECUTION_INTENT_CONFLICT' }
          );
        }
        const status = operations.get(body.operationIdentity);
        if (operation === 'getOperation') {
          if (!status) {
            throw Object.assign(new Error('operation not found'), {
              code: 'PROCESS_OPERATION_NOT_FOUND'
            });
          }
          if ((native.cancelCount.get(body.operationIdentity) || 0) === 0) {
            native.getBeforeCancelCount.set(
              body.operationIdentity,
              (native.getBeforeCancelCount.get(body.operationIdentity) || 0) + 1
            );
          }
          return status;
        }
        if (operation === 'cancelOperation') {
          if (!status) {
            throw Object.assign(new Error('operation not found'), {
              code: 'PROCESS_OPERATION_NOT_FOUND'
            });
          }
          native.cancelCount.set(
            body.operationIdentity,
            (native.cancelCount.get(body.operationIdentity) || 0) + 1
          );
          const terminal = terminalStatus(
            status,
            cancelOutcomes.get(body.operationIdentity)
          );
          operations.set(body.operationIdentity, terminal);
          return terminal;
        }
        if (operation === 'readOutput') {
          return {
            operationIdentity: body.operationIdentity,
            stream: body.stream,
            offset: body.offset,
            totalBytes: 0,
            sha256: EMPTY_SHA,
            dataBase64: '',
            end: true
          };
        }
        if (operation === 'acknowledgeOutput') {
          const current = operations.get(body.operationIdentity);
          if (!current || current.terminalResultHash !== body.terminalResultHash) {
            throw new Error('terminal result acknowledgement mismatch');
          }
          native.acknowledgeCount.set(
            body.operationIdentity,
            (native.acknowledgeCount.get(body.operationIdentity) || 0) + 1
          );
          current.outputAvailable = false;
          return current;
        }
        throw new Error(`unexpected launcher operation ${operation}`);
      }
    );

    try {
      const agent = (await store.createConfiguredAgent({
        value: {
          name: `Lease Expiry Process ${Date.now()}`,
          provider: 'openai',
          model: 'gpt-test',
          apiKey: ''
        },
        groupIds: [],
        changedBy: 'process-lease-expiry-cancellation-test'
      })).agent;
      const runtimeLimits = await store.getRuntimeLimitsConfig();
      await store.updateRuntimeLimitsConfig({
        expectedRevision: runtimeLimits.revision,
        value: {
          maxExecutionSteps: runtimeLimits.maxExecutionSteps,
          maxModelRequestsPerRun: runtimeLimits.maxModelRequestsPerRun,
          maxWorkspaceOperationsPerRun: runtimeLimits.maxWorkspaceOperationsPerRun,
          maxRuntimeDurationMs: runtimeLimits.maxRuntimeDurationMs,
          maxActiveRuns: 1,
          localModelConcurrency: runtimeLimits.localModelConcurrency
        },
        changedBy: 'process-lease-expiry-cancellation-test'
      });

      // A valid, unrelated lease consumes the only execution slot. Recovered
      // runs may become pending only after cancellation, but the same scheduler
      // tick cannot dispatch them into a new execution attempt.
      const blocker = await createTicketRun(store, agent, 'Lease capacity blocker');
      await markRunning(store, blocker, {
        owner: 'healthy-blocking-owner',
        expired: false
      });

      const cancelledRun = await createTicketRun(
        store,
        agent,
        'Expired process run cancelled'
      );
      const naturalRun = await createTicketRun(
        store,
        agent,
        'Expired process run natural completion race'
      );
      const nonProcessRun = await createTicketRun(
        store,
        agent,
        'Expired ordinary run'
      );
      for (const run of [cancelledRun, naturalRun, nonProcessRun]) {
        await markRunning(store, run, {
          owner: `stale-owner-${run.id}`,
          expired: true
        });
      }

      const fixtures = [
        {
          run: cancelledRun,
          operationIdentity: `process-operation:${'1'.repeat(64)}`,
          cancelRaceOutcome: 'cancelled'
        },
        {
          run: naturalRun,
          operationIdentity: `process-operation:${'2'.repeat(64)}`,
          cancelRaceOutcome: 'completed'
        }
      ];
      for (const fixture of fixtures) {
        let record = (await store.createProcessExecutionIntent(
          intentFor(fixture.run, agent, fixture.operationIdentity)
        )).record;
        record = await store.transitionProcessOperation({
          operationIdentity: fixture.operationIdentity,
          expectedStates: ['intent'],
          expectedRevision: record.revision,
          changes: {
            lifecycleState: 'active',
            launcherAcceptanceIdentity:
              `process-launcher-acceptance:${fixture.operationIdentity.slice(-64)}`,
            lastReconciliationResult: {
              kind: 'launcher_accepted',
              observedAt: new Date().toISOString()
            }
          }
        });
        operations.set(fixture.operationIdentity, {
          operationIdentity: fixture.operationIdentity,
          state: 'active',
          launcherAcceptanceIdentity: record.launcherAcceptanceIdentity,
          terminalResultHash: null,
          outputAvailable: false,
          result: null
        });
        cancelOutcomes.set(
          fixture.operationIdentity,
          fixture.cancelRaceOutcome
        );
      }

      const server = await startServer({ env: {
        TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
        RUNTIME_SCHEDULER_INTERVAL_MS: '150',
        RUN_LEASE_DURATION_MS: '30000',
        PROCESS_LAUNCHER_SOCKET_PATH: launcherSocket,
        ARTIFACT_ROOT: artifactRoot
      } });

      try {
        await waitFor(async () => {
          const records = await Promise.all(fixtures.map(item =>
            store.getProcessOperation(item.operationIdentity)));
          return records.every(record =>
            record.lifecycleState === 'terminal' &&
            record.requiredEvidenceState === 'complete' &&
            record.launcherOutputAcknowledged);
        }, 30000, 'lease-expiry process finalization');
      } catch (error) {
        const records = await Promise.all(fixtures.map(item =>
          store.getProcessOperation(item.operationIdentity)));
        throw new Error(
          `${error.message}\nrecords=${JSON.stringify(records)}\n` +
          server.output().slice(-5000)
        );
      }
      await waitFor(async () => {
        const eventSets = await Promise.all(fixtures.map(item =>
          store.listRunEvents(item.run.id, { afterSeq: -1, limit: 200 })));
        return eventSets.every(events => events.some(event =>
          event.type === 'run.resumed' || event.type === 'run.terminalized'));
      }, 30000, 'stale-run recovery completion after process finalization');

      for (const fixture of fixtures) {
        const record = await store.getProcessOperation(fixture.operationIdentity);
        assert(record.cancellationRequested === true,
          `${fixture.cancelRaceOutcome}: lease expiry durably requests cancellation`);
        assert((native.cancelCount.get(fixture.operationIdentity) || 0) === 1,
          `${fixture.cancelRaceOutcome}: exact launcher cancellation is invoked once`);
        assert((native.getBeforeCancelCount.get(fixture.operationIdentity) || 0) === 0,
          `${fixture.cancelRaceOutcome}: ordinary reconciliation cannot observe active execution before cancellation`);
        assert(record.terminalOutcome === fixture.cancelRaceOutcome,
          `${fixture.cancelRaceOutcome}: launcher single terminal result is preserved`);
        assert((native.acknowledgeCount.get(fixture.operationIdentity) || 0) === 1,
          `${fixture.cancelRaceOutcome}: output acknowledgement follows durable finalization`);

        const events = await store.listRunEvents(
          fixture.run.id,
          { afterSeq: -1, limit: 200 }
        );
        const cancellationEvents = events.filter(event =>
          event.type === 'process.cancellation_requested');
        const terminalEvents = events.filter(event => event.type === 'process.terminal');
        const recoveryFinished = events.find(event =>
          event.type === 'run.resumed' || event.type === 'run.terminalized');
        assert(cancellationEvents.length === 1 && terminalEvents.length === 1,
          `${fixture.cancelRaceOutcome}: cancellation and terminal evidence are idempotent`);
        assert(recoveryFinished && terminalEvents[0].seq < recoveryFinished.seq,
          `${fixture.cancelRaceOutcome}: terminal process evidence precedes stale-run recovery completion`);
      }
      assert(native.launchCount === 0,
        'lease expiry never duplicates or submits process execution');

      const naturalRecord = await store.getProcessOperation(
        fixtures[1].operationIdentity
      );
      assert(naturalRecord.terminalOutcome === 'completed' &&
        naturalRecord.cancellationRequested === true,
      'natural completion racing cancellation retains both the request and launcher result');

      const nonProcessTerminal = await waitFor(async () => {
        const run = await store.getRun(nonProcessRun.id);
        return run && run.status === 'interrupted' ? run : null;
      }, 30000, 'ordinary stale-run interruption');
      assert(nonProcessTerminal.status === 'interrupted' &&
        (await store.listProcessOperationsForRun(nonProcessRun.id)).length === 0,
      'existing non-process lease recovery remains unchanged');

      const replayFixture = fixtures[0];
      await markRunning(store, replayFixture.run, {
        owner: 'second-stale-owner',
        expired: true
      });
      await waitFor(async () => {
        const events = await store.listRunEvents(
          replayFixture.run.id,
          { afterSeq: -1, limit: 200 }
        );
        return events.filter(event => event.type === 'run.recovery_claimed').length >= 2;
      }, 30000, 'repeated lease-expiry recovery');
      await sleep(300);
      const repeatedEvents = await store.listRunEvents(
        replayFixture.run.id,
        { afterSeq: -1, limit: 200 }
      );
      assert((native.cancelCount.get(replayFixture.operationIdentity) || 0) === 1 &&
        repeatedEvents.filter(event =>
          event.type === 'process.cancellation_requested').length === 1 &&
        repeatedEvents.filter(event => event.type === 'process.terminal').length === 1,
      'repeated lease-expiry recovery converges without duplicate cancellation or evidence');
      assert((await store.getProcessOperation(replayFixture.operationIdentity))
        .terminalResultHash === operations.get(replayFixture.operationIdentity)
          .terminalResultHash,
      'repeated recovery preserves the same authoritative terminal result');
    } finally {
      await new Promise(resolve => launcherServer.close(resolve));
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  });
  console.log(`PASS: process lease-expiry cancellation PostgreSQL (${assert.count()} assertions)`);
}

main().catch(error => {
  console.error(
    `FAIL: process lease-expiry cancellation PostgreSQL — ${error.stack || error.message}`
  );
  process.exit(1);
});
