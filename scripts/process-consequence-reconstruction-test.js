#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { withHarness, createAsserter } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const ok = createAsserter();
const HASHES = Object.freeze({
  success: '1'.repeat(64),
  failed: '2'.repeat(64),
  cancelled: '3'.repeat(64),
  stdout: '4'.repeat(64),
  stderr: '5'.repeat(64)
});

function consequenceFromRuntimeState(body) {
  const state = JSON.parse(body);
  assert(state && state.runConsequence,
    'runtime-state projection contains the ordinary run consequence');
  return state.runConsequence;
}

function processReceipt({
  operationIdentity,
  terminalOutcome,
  terminalResultHash,
  targetId,
  profileId
}) {
  return {
    version: 1,
    operationIdentity,
    targetId,
    profileId,
    runtimePhase: 'verification',
    terminalOutcome,
    terminalResultHash,
    stdoutArtifact: {
      version: 1,
      id: `${operationIdentity.slice(-16)}:stdout`,
      path: '/private/launcher/output-must-not-project',
      stream: 'stdout',
      byteCount: 7,
      sha256: HASHES.stdout
    },
    stderrArtifact: {
      version: 1,
      id: `${operationIdentity.slice(-16)}:stderr`,
      path: '/private/launcher/output-must-not-project',
      stream: 'stderr',
      byteCount: 3,
      sha256: HASHES.stderr
    },
    // These fields are deliberately outside the frozen durable receipt shape.
    // A consequence projection must stay closed even if historical data carries
    // unrelated fields.
    rawStdout: 'secret child output',
    pid: 4242,
    executablePath: '/usr/bin/node',
    environment: { DATABASE_URL: 'must-not-project' },
    launchPlan: { private: true }
  };
}

async function createRun(store, agent, suffix) {
  const ticket = (await store.createTicketWithEvent({
    ticket: {
      status: 'open',
      title: `Process consequence ${suffix}`,
      assignmentTargetType: 'agent',
      assignmentTargetId: agent.id,
      assignmentMode: 'individual'
    },
    eventPayload: { source: 'process-consequence-reconstruction-test' }
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
  return (await store.transitionRun({
    runId: run.id,
    expectedRevision: run.revision,
    fromStatuses: ['pending'],
    toStatus: 'interrupted',
    eventType: 'run.interrupted',
    eventPayload: { source: 'process-consequence-reconstruction-test' }
  })).run;
}

async function main() {
  await withHarness('process consequence reconstruction', async ({
    store,
    startServer
  }) => {
    let server = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    } });
    let cookie = await server.login();
    const agent = (await store.createConfiguredAgent({
      value: {
        name: `Process Consequence ${Date.now()}`,
        provider: 'openai',
        model: 'gpt-test',
        apiKey: ''
      },
      groupIds: [],
      changedBy: 'process-consequence-reconstruction-test'
    })).agent;
    const run = await createRun(store, agent, 'process');
    const verification = {
      postconditionsStatus: 'unknown',
      violationsStatus: 'unknown'
    };
    const persistedBase = {
      mutations: [],
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      notifications: [],
      externalEffects: [],
      verification
    };
    await store.recordRunConsequence({
      runId: run.id,
      consequence: persistedBase,
      eventPayload: { source: 'historical-process-consequence-fixture' }
    });

    const cases = [
      {
        suffix: 'a'.repeat(64),
        outcome: 'succeeded',
        terminalOutcome: 'completed',
        terminalResultHash: HASHES.success
      },
      {
        suffix: 'b'.repeat(64),
        outcome: 'failed',
        terminalOutcome: 'exited_nonzero',
        terminalResultHash: HASHES.failed
      },
      {
        suffix: 'c'.repeat(64),
        outcome: 'failed',
        terminalOutcome: 'cancelled',
        terminalResultHash: HASHES.cancelled
      }
    ];
    for (const [index, item] of cases.entries()) {
      const operationIdentity = `process-operation:${item.suffix}`;
      await store.recordOperationReceipt({
        runId: run.id,
        idempotencyKey: operationIdentity,
        stepId: String(index + 1),
        operation: 'runProcess',
        outcome: item.outcome,
        targetId: 'ticket-system-local',
        targetKind: 'process',
        targetResourceId: 'ticket-system-local/syntax-check',
        receipt: processReceipt({
          operationIdentity,
          terminalOutcome: item.terminalOutcome,
          terminalResultHash: item.terminalResultHash,
          targetId: 'ticket-system-local',
          profileId: 'syntax-check'
        }),
        eventType: null
      });
    }
    await store.recordOperationReceipt({
      runId: run.id,
      idempotencyKey: 'browser-generic-receipt',
      stepId: '4',
      operation: 'navigate',
      outcome: 'succeeded',
      targetId: 'browser-main',
      targetKind: 'browser',
      targetResourceId: 'https://example.invalid/',
      receipt: { status: 'observed' },
      eventType: null
    });

    const firstPage = await server.request('GET', `/api/runs/${run.id}/state?projection=first`, {
      cookie
    });
    assert.equal(firstPage.statusCode, 200,
      `${firstPage.body}\n${server.output().slice(-3000)}`);
    const first = consequenceFromRuntimeState(firstPage.body);
    ok(Array.isArray(first.processOperations) &&
      first.processOperations.length === 3,
    'non-mutating process receipts are retained in ordinary consequence reconstruction');
    ok(first.processOperations[0].outcome === 'succeeded' &&
      first.processOperations[0].terminalOutcome === 'completed',
    'successful process consequence preserves its truthful outcome');
    ok(first.processOperations[1].outcome === 'failed' &&
      first.processOperations[1].terminalOutcome === 'exited_nonzero',
    'failed process consequence preserves its truthful outcome');
    ok(first.processOperations[2].outcome === 'failed' &&
      first.processOperations[2].terminalOutcome === 'cancelled',
    'cancelled process consequence preserves its truthful outcome');
    ok(['created', 'updated', 'renamed', 'deleted'].every(key =>
      Array.isArray(first[key]) && first[key].length === 0),
    'process consequences populate no workspace mutation category');
    ok(first.externalEffects.length === 0,
      'process receipts are not misrepresented as unsupported external effects');
    const serializedProcess = JSON.stringify(first.processOperations);
    ok(!serializedProcess.includes('secret child output') &&
      !serializedProcess.includes('/private/') &&
      !serializedProcess.includes('/usr/bin/node') &&
      !serializedProcess.includes('DATABASE_URL') &&
      !serializedProcess.includes('"pid"') &&
      !serializedProcess.includes('launchPlan'),
    'process consequence excludes raw output, host paths, PID, environment, and launch authority');
    ok(first.processOperations.every(item =>
      item.stdoutArtifact &&
      item.stdoutArtifact.stream === 'stdout' &&
      item.stdoutArtifact.byteCount === 7 &&
      item.stdoutArtifact.sha256 === HASHES.stdout &&
      item.stderrArtifact &&
      item.stderrArtifact.stream === 'stderr' &&
      item.stderrArtifact.byteCount === 3 &&
      item.stderrArtifact.sha256 === HASHES.stderr),
    'process consequence retains only bounded immutable artifact metadata');
    assert.deepEqual(first.verification, verification);
    ok((await store.getRun(run.id)).status === 'interrupted',
    'consequence reconstruction does not alter postcondition or completion semantics');
    const operations = await store.listRunOperations(run.id, { limit: 20 });
    ok(operations.some(item => item.operation === 'navigate') &&
      first.processOperations.every(item => item.operation === 'runProcess'),
    'browser and generic receipts remain reconstructed normally without entering process consequences');

    await server.stop();
    server = await startServer({ env: {
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    } });
    cookie = await server.login();
    const replayPage = await server.request('GET', `/api/runs/${run.id}/state?projection=replay`, {
      cookie
    });
    assert.equal(replayPage.statusCode, 200,
      `${replayPage.body}\n${server.output().slice(-3000)}`);
    const replayed = consequenceFromRuntimeState(replayPage.body);
    assert.deepEqual(replayed, first);
    ok(true,
      'restart replay of the same durable receipts produces the same consequence');

    const workspaceRun = await createRun(store, agent, 'workspace-control');
    const workspaceOnly = {
      mutations: [{
        operation: 'writeFile',
        path: 'unchanged.txt',
        type: 'file'
      }],
      created: [{
        operation: 'writeFile',
        path: 'unchanged.txt',
        type: 'file'
      }],
      updated: [],
      deleted: [],
      renamed: [],
      notifications: [],
      externalEffects: [],
      verification
    };
    await store.recordRunConsequence({
      runId: workspaceRun.id,
      consequence: workspaceOnly,
      eventPayload: { source: 'workspace-consequence-control' }
    });
    const workspacePage = await server.request(
      'GET',
      `/api/runs/${workspaceRun.id}/state?projection=workspace`,
      { cookie }
    );
    assert.equal(workspacePage.statusCode, 200);
    assert.deepEqual(consequenceFromRuntimeState(workspacePage.body), workspaceOnly);
    ok(true,
      'existing workspace-only consequence structure remains unchanged');
  });
  console.log(`PASS: process consequence reconstruction (${ok.count()} assertions)`);
}

main().catch(error => {
  console.error(`FAIL: process consequence reconstruction — ${error.stack || error.message}`);
  process.exit(1);
});
