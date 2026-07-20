#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonNonTerminalEvidenceRepository,
  REQUIRED_NON_TERMINAL_EVIDENCE_REPOSITORY_METHODS,
  TargetOperationConflictError,
  assertNonTerminalEvidenceRepository
} = require('../persistence/json/non-terminal-evidence-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

let history = [];
let snapshot = { version: 1, authorityChecks: [], workspaceOperations: [], browserOperations: [] };
const events = [];
let failNextEvent = false;

const repository = new JsonNonTerminalEvidenceRepository({
  readOperationHistory: () => history.map(record => structuredClone(record)),
  writeOperationHistory: records => { history = structuredClone(records); },
  readReplaySnapshot: () => structuredClone(snapshot),
  writeReplaySnapshot: (runId, value) => {
    assert.equal(runId, 1);
    snapshot = structuredClone(value);
  },
  getRunEvents: runId => events.filter(event => event.runId === runId).map(event => structuredClone(event)),
  appendEvent: async event => {
    if (failNextEvent) {
      failNextEvent = false;
      throw new Error('simulated journal interruption');
    }
    const stored = { ...structuredClone(event), id: `event-${events.length + 1}` };
    events.push(stored);
    return stored;
  },
  acquireTargetLock: async () => () => {},
  sanitizePayload: value => structuredClone(value),
  now: () => new Date('2026-07-16T12:00:00.000Z')
});

function completion(operationKey = 'run:1:agent:0:0:abc') {
  return {
    runId: 1,
    ticketId: 10,
    operationKey,
    historyRecord: {
      step: 0,
      operation: 'writeFile',
      args: { path: 'report.txt', content: 'complete' },
      preState: { existed: false },
      postState: { existed: true, type: 'file', contentHash: 'hash' },
      result: { path: 'report.txt', size: 8 },
      error: null,
      outcome: 'succeeded',
      targetId: 'local-workspace',
      targetKind: 'localWorkspace'
    },
    receipt: {
      operation: 'writeFile',
      targetId: 'local-workspace',
      targetKind: 'localWorkspace',
      targetPath: 'report.txt',
      providerResponse: { path: 'report.txt', size: 8 }
    },
    replayItem: {
      operation: { operation: 'writeFile', args: { path: 'report.txt', content: 'complete' } },
      result: { path: 'report.txt', size: 8 },
      startedAt: '2026-07-16T11:59:59.000Z',
      durationMs: 1000
    },
    event: {
      type: 'workspace.operation',
      stepId: '0',
      payload: {
        operation: 'writeFile',
        path: 'report.txt',
        mutating: true,
        result: { path: 'report.txt', size: 8 }
      }
    }
  };
}

async function main() {
  assert.deepEqual(REQUIRED_NON_TERMINAL_EVIDENCE_REPOSITORY_METHODS, [
    'appendRunEvidence',
    'completeActionReceipt',
    'prepareTargetOperation',
    'completeTargetOperation',
    'getTargetOperation',
    'withTargetOperationLock'
  ]);
  assert.equal(assertNonTerminalEvidenceRepository(repository), repository);
  assert.equal(
    assertNonTerminalEvidenceRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the non-terminal evidence repository contract'
  );
  assert.throws(() => assertNonTerminalEvidenceRepository({}), /must implement appendRunEvidence/);

  const authority = await repository.appendRunEvidence({
    runId: 1,
    ticketId: 10,
    evidenceKey: 'authority:run:1:agent:0:0:abc',
    replayKey: 'authorityChecks',
    replayItem: { operation: 'writeFile', status: 'allowed' },
    event: { type: 'authority.allowed', payload: { operation: 'writeFile', status: 'allowed' } }
  });
  assert.equal(authority.inserted, true);
  assert.equal(snapshot.authorityChecks.length, 1);
  assert.equal(events.filter(event => event.type === 'authority.allowed').length, 1);

  const browserReceiptInput = {
    runId: 1,
    ticketId: 10,
    operationKey: 'run:1:browser:0:observe',
    stepId: '0',
    operation: 'observe',
    outcome: 'succeeded',
    historyRecord: {
      step: 0,
      operation: 'observe',
      args: {},
      result: { elementCount: 2 },
      error: null,
      targetId: 'browser:test',
      targetKind: 'browser'
    },
    receipt: {
      operation: 'observe',
      targetId: 'browser:test',
      targetKind: 'browser',
      metadata: { elementCount: 2 }
    },
    replayKey: 'browserOperations',
    replayItem: { operation: { operation: 'observe', args: {} }, status: 'ok' },
    event: { type: 'browser.operation', stepId: '0', payload: { operation: 'observe', status: 'ok' } }
  };
  failNextEvent = true;
  await assert.rejects(repository.completeActionReceipt(browserReceiptInput), /simulated journal interruption/);
  assert.equal(history.length, 1, 'action receipt survives interruption before its event');
  assert.equal(snapshot.browserOperations.length, 1, 'action replay item survives interruption before its event');
  const repairedBrowserReceipt = await repository.completeActionReceipt(browserReceiptInput);
  assert.equal(repairedBrowserReceipt.inserted, false);
  assert.equal(history.length, 1, 'action receipt retry is idempotent');
  assert.equal(snapshot.browserOperations.length, 1, 'action replay retry is idempotent');
  assert.equal(events.filter(event => event.type === 'browser.operation').length, 1, 'action retry repairs its event');

  const operationKey = 'run:1:agent:0:0:abc';
  const intent = {
    operation: 'writeFile',
    args: { path: 'report.txt', content: 'complete' },
    preState: { existed: false },
    authorityDecision: { status: 'allowed' },
    target: { targetId: 'local-workspace', targetPath: 'report.txt' }
  };
  assert.equal((await repository.prepareTargetOperation({
    runId: 1, ticketId: 10, operationKey, stepId: '0', intent
  })).inserted, true);
  assert.equal((await repository.prepareTargetOperation({
    runId: 1, ticketId: 10, operationKey, stepId: '0', intent: structuredClone(intent)
  })).inserted, false);
  await assert.rejects(
    repository.prepareTargetOperation({
      runId: 1,
      ticketId: 10,
      operationKey,
      stepId: '0',
      intent: { ...intent, args: { ...intent.args, content: 'different' } }
    }),
    error => error instanceof TargetOperationConflictError
  );

  failNextEvent = true;
  await assert.rejects(repository.completeTargetOperation(completion(operationKey)), /simulated journal interruption/);
  assert.equal(history.length, 2, 'target receipt must survive an interruption after the target effect');
  assert.equal(snapshot.workspaceOperations.length, 1, 'replay progress is repairable by stable evidence key');
  assert.equal(events.filter(event => event.type === 'workspace.operation').length, 0);

  const repaired = await repository.completeTargetOperation(completion(operationKey));
  assert.equal(repaired.inserted, false);
  assert.equal(history.length, 2, 'retry must not duplicate the operation receipt');
  assert.equal(snapshot.workspaceOperations.length, 1, 'retry must not duplicate replay evidence');
  assert.equal(events.filter(event => event.type === 'workspace.operation').length, 1, 'retry must repair the missing event');
  const mutationHistory = history.find(record => record.operationKey === operationKey);
  assert.equal(mutationHistory.operationKey, operationKey);
  assert.equal(mutationHistory.mutationReceipt.operationKey, operationKey);
  assert.equal(snapshot.workspaceOperations[0].historyId, mutationHistory.id);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(serverSource.includes('getNonTerminalEvidenceRepository().prepareTargetOperation({'));
  assert.ok(serverSource.includes('getNonTerminalEvidenceRepository().completeTargetOperation({'));
  assert.ok(serverSource.includes('getNonTerminalEvidenceRepository().completeActionReceipt({'));
  assert.ok(serverSource.includes("error.code = 'TARGET_OPERATION_RECONCILIATION_REQUIRED'"));
  assert.ok(serverSource.includes('buildTargetOperationKey('));
  assert.equal(
    (serverSource.match(/await options\.onRequest\(requestSnapshot\);/g) || []).length,
    2,
    'both provider transports must await durable request evidence before fetch'
  );
  assert.equal(
    (serverSource.match(/appendRunReplaySnapshotItem\(/g) || []).length,
    3,
    'direct replay appends must remain confined to the helper and diagnostic replay events'
  );
  for (const evidenceType of [
    'provider.request.persisted',
    'provider.response.persisted',
    'model.plan.parsed',
    'workflow.step.completed',
    'workflow.step.failed'
  ]) {
    assert.ok(serverSource.includes(evidenceType), `server must route ${evidenceType} through non-terminal evidence`);
  }

  console.log('PASS: non-terminal evidence boundary pairs provider, plan, workflow, read/action, authority, and target-operation evidence');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
