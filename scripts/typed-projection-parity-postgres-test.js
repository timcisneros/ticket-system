#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { withHarness } = require('./postgres-test-harness');
const { currentRuntimeLimitsSnapshot } = require('./current-run-fixture');

const PROCESS_IDENTITY = `process-operation:${'1'.repeat(64)}`;
const TERMINAL_HASH = '2'.repeat(64);
const STDOUT_HASH = '3'.repeat(64);
const STDERR_HASH = '4'.repeat(64);
const SCREENSHOT_HASH = '5'.repeat(64);

async function main() {
  await withHarness('typed projection parity', async ({ store, startServer }) => {
    const agent = (await store.createConfiguredAgent({
      value: {
        name: `Typed projection ${Date.now()}`,
        provider: 'openai',
        model: 'gpt-test',
        apiKey: ''
      },
      groupIds: [],
      changedBy: 'typed-projection-parity-postgres-test'
    })).agent;
    const ticket = (await store.createTicketWithEvent({
      ticket: {
        status: 'open',
        title: 'Typed browser and process projection',
        objective: 'Observe the browser and run the admitted syntax profile.',
        assignmentTargetType: 'agent',
        assignmentTargetId: agent.id,
        assignmentMode: 'individual'
      },
      eventPayload: { source: 'typed-projection-parity-postgres-test' }
    })).ticket;
    const pendingRun = await store.createRun({
      ticketId: ticket.id,
      agentId: agent.id,
      agentName: agent.name,
      runtimeLimitsSnapshot: currentRuntimeLimitsSnapshot(),
      executionPolicySnapshot: { requireVerification: 'when_declared' },
      status: 'pending',
      executionMode: 'agent'
    });
    const run = (await store.transitionRun({
      runId: pendingRun.id,
      expectedRevision: pendingRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'interrupted',
      eventType: 'run.interrupted',
      eventPayload: { source: 'typed-projection-parity-postgres-test' }
    })).run;
    const persistedConsequence = {
      mutations: [],
      created: [],
      updated: [],
      deleted: [],
      renamed: [],
      notifications: [],
      externalEffects: [],
      verification: {
        postconditionsStatus: 'unknown',
        violationsStatus: 'unknown'
      }
    };
    await store.recordRunConsequence({
      runId: run.id,
      consequence: persistedConsequence,
      eventPayload: { source: 'typed-projection-parity-postgres-test' }
    });

    await store.recordOperationReceipt({
      runId: run.id,
      idempotencyKey: PROCESS_IDENTITY,
      stepId: '1',
      operation: 'runProcess',
      outcome: 'succeeded',
      targetId: 'ticket-system-local',
      targetKind: 'process',
      targetResourceId: 'ticket-system-local/syntax-check',
      receipt: {
        version: 1,
        operationIdentity: PROCESS_IDENTITY,
        targetId: 'ticket-system-local',
        profileId: 'syntax-check',
        runtimePhase: 'verification',
        terminalOutcome: 'completed',
        terminalResultHash: TERMINAL_HASH,
        stdoutArtifact: {
          version: 1,
          id: 'process-stdout-artifact',
          path: '/private/process/stdout',
          stream: 'stdout',
          byteCount: 17,
          sha256: STDOUT_HASH
        },
        stderrArtifact: {
          version: 1,
          id: 'process-stderr-artifact',
          path: '/private/process/stderr',
          stream: 'stderr',
          byteCount: 9,
          sha256: STDERR_HASH
        },
        rawStdout: 'PRIVATE PROCESS OUTPUT',
        environment: { TOKEN: 'PRIVATE PROCESS TOKEN' }
      },
      eventType: null
    });
    await store.recordOperationReceipt({
      runId: run.id,
      idempotencyKey: 'browser-operation:typed-navigate',
      stepId: '3',
      operation: 'navigate',
      outcome: 'succeeded',
      targetId: 'browser:research',
      targetKind: 'browser',
      targetResourceId: 'https://example.test/redacted',
      receipt: {
        operation: 'navigate',
        timestamp: '2026-07-29T00:00:01.000Z',
        metadata: {
          requestedUrl: 'https://user:password@example.test/private?token=secret',
          finalUrl: 'https://example.test/private',
          status: 200,
          pageStateHash: 'browser-navigation-state'
        },
        partial: false,
        truncated: false,
        targetId: 'browser:research',
        targetKind: 'browser'
      },
      eventType: null
    });
    await store.recordOperationReceipt({
      runId: run.id,
      idempotencyKey: 'browser-operation:typed-screenshot',
      stepId: '2',
      operation: 'screenshot',
      outcome: 'succeeded',
      targetId: 'browser:research',
      targetKind: 'browser',
      targetResourceId: 'https://example.test/redacted',
      receipt: {
        operation: 'screenshot',
        timestamp: '2026-07-29T00:00:00.000Z',
        metadata: {
          artifactPath: `browser/run-${run.id}/step-2-1.png`,
          bytes: 23,
          sha256: SCREENSHOT_HASH,
          pageStateHash: 'browser-page-state',
          unrestrictedPageContent: 'PRIVATE PAGE CONTENT',
          credentials: 'PRIVATE BROWSER CREDENTIAL'
        },
        partial: false,
        truncated: false,
        targetId: 'browser:research',
        targetKind: 'browser',
        privateSessionState: { cookie: 'PRIVATE COOKIE' }
      },
      eventType: null
    });

    const server = await startServer({
      TEST_SKIP_STARTUP_RUN_RECOVERY: 'true',
      RUNTIME_SCHEDULER_INTERVAL_MS: '3600000'
    });
    const cookie = await server.login();
    const operationsBefore = await store.listRunOperations(run.id, { limit: 20 });
    const eventsBefore = await store.listRunEvents(run.id, { limit: 100 });

    const stateResponse = await server.request('GET', `/api/runs/${run.id}/state`, { cookie });
    assert.equal(stateResponse.statusCode, 200, stateResponse.body);
    const state = JSON.parse(stateResponse.body);
    const consequence = state.runConsequence;
    assert.deepEqual(
      ['created', 'updated', 'deleted', 'renamed'].map(key => consequence[key]),
      [[], [], [], []],
      'browser and process facts must never enter workspace mutation categories'
    );
    assert.equal(consequence.browserOperations.length, 2);
    const screenshotConsequence = consequence.browserOperations
      .find(item => item.operation === 'screenshot');
    assert.equal(screenshotConsequence.targetId, 'browser:research');
    assert.equal(screenshotConsequence.artifact.sha256, SCREENSHOT_HASH);
    assert.equal(consequence.processOperations.length, 1);
    assert.equal(consequence.processOperations[0].terminalResultHash, TERMINAL_HASH);

    const workResponse = await server.request('GET', `/api/runs/${run.id}/work-receipt`, { cookie });
    assert.equal(workResponse.statusCode, 200, workResponse.body);
    const workReceipt = JSON.parse(workResponse.body).workReceipt;
    assert.equal(workReceipt.typedOperations.browser.length, 2);
    assert.equal(workReceipt.typedOperations.process.length, 1);
    assert.equal(workReceipt.typedArtifacts.browser[0].sha256, SCREENSHOT_HASH);
    assert.equal(workReceipt.typedArtifacts.process.length, 2);
    assert.deepEqual(workReceipt.typedArtifacts.workspace, []);
    assert.deepEqual(workReceipt.artifactsProduced, [],
      'the compatibility path list must not mislabel process or browser artifacts as workspace paths');
    assert.deepEqual(state.runEvaluation.efficiency, {
      ...state.runEvaluation.efficiency,
      workspaceOperations: 0,
      workspaceMutations: 0,
      browserOperations: 2,
      processOperations: 1,
      mutationCount: 0
    }, 'generic efficiency metrics must report every operation family separately');

    const runPage = await server.request('GET', `/runs/${run.id}`, { cookie });
    assert.equal(runPage.statusCode, 200, runPage.body.slice(0, 1000));
    assert.match(runPage.body, /Browser operations \/ evidence \(2\)/);
    assert.match(runPage.body, /Process operations \/ artifacts \(1\)/);
    assert.match(runPage.body, /process-stdout-artifact/);
    assert.match(runPage.body, /browser\/run-/);
    assert.match(runPage.body, /Workspace Objective Path Coverage:<\/strong> Not applicable/);
    assert.match(runPage.body, /Workspace Artifact Accuracy:<\/strong> Not applicable/);

    const ticketPage = await server.request('GET', `/tickets/${ticket.id}`, { cookie });
    assert.equal(ticketPage.statusCode, 200, ticketPage.body.slice(0, 1000));
    assert.match(ticketPage.body, /process-stdout-artifact/);
    assert.match(ticketPage.body, /browser screenshot/);
    assert.equal((ticketPage.body.match(/browser screenshot/g) || []).length, 1,
      'ordinary browser evidence must not be mislabeled as an artifact');
    assert.doesNotMatch(ticketPage.body, /No artifacts produced yet/);

    const projectionSurfaces = {
      runtimeState: JSON.stringify(state),
      workReceipt: JSON.stringify(workReceipt),
      ticketPage: ticketPage.body
    };
    for (const secret of [
      'PRIVATE PROCESS OUTPUT',
      'PRIVATE PROCESS TOKEN',
      'PRIVATE PAGE CONTENT',
      'PRIVATE BROWSER CREDENTIAL',
      'PRIVATE COOKIE',
      '/private/process/'
    ]) {
      for (const [surface, body] of Object.entries(projectionSurfaces)) {
        assert.equal(body.includes(secret), false, `${surface} projection leaked ${secret}`);
      }
    }

    const secondState = await server.request('GET', `/api/runs/${run.id}/state`, { cookie });
    assert.equal(secondState.statusCode, 200);
    assert.deepEqual(JSON.parse(secondState.body).runConsequence, consequence,
      'exact reconstruction must produce the same typed consequence');
    assert.deepEqual((await store.getRunConsequence(run.id)).consequence, persistedConsequence,
      'read-time projection must not rewrite historical authority');
    const operationsAfter = await store.listRunOperations(run.id, { limit: 20 });
    const eventsAfter = await store.listRunEvents(run.id, { limit: 100 });
    assert.equal(operationsAfter.length, operationsBefore.length,
      'projection reads must not create receipts');
    assert.equal(eventsAfter.length, eventsBefore.length,
      'projection reads must not create evidence events');

    await server.stop();
  });

  console.log('PASS: typed projection parity PostgreSQL public seam');
}

main().catch(error => {
  console.error(`FAIL: typed projection parity PostgreSQL public seam — ${error.stack || error.message}`);
  process.exit(1);
});
