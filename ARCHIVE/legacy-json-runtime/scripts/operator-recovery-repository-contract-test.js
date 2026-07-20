#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonOperatorRecoveryRepository,
  REQUIRED_OPERATOR_RECOVERY_REPOSITORY_METHODS,
  assertOperatorRecoveryRepository
} = require('../persistence/json/operator-recovery-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

async function main() {
  assert.deepEqual(REQUIRED_OPERATOR_RECOVERY_REPOSITORY_METHODS, [
    'getOperatorRecovery',
    'prepareOperatorRecovery',
    'completeOperatorRecovery',
    'withOperatorRecoveryLock'
  ]);
  assert.equal(
    assertOperatorRecoveryRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the operator recovery contract'
  );
  assert.throws(() => assertOperatorRecoveryRepository({}), /must implement getOperatorRecovery/);

  let histories = [{
    id: 11,
    timestamp: '2026-07-18T12:00:00.000Z',
    ticketId: 3,
    runId: 7,
    step: 1,
    operation: 'writeFile',
    args: { path: 'report.txt', content: 'new' },
    preState: { existed: false },
    postState: { existed: true, type: 'file', contentHash: 'new-hash' },
    result: { path: 'report.txt', size: 3 },
    targetId: 'workspace:local',
    targetKind: 'workspace'
  }];
  let replay = { finalizedAt: '2026-07-18T12:01:00.000Z', workspaceOperations: [] };
  const events = [];
  const calls = [];
  let failCompletionEvent = true;
  const repository = new JsonOperatorRecoveryRepository({
    readOperationHistory: () => structuredClone(histories),
    writeOperationHistory: records => { histories = structuredClone(records); calls.push('history'); },
    readReplaySnapshot: async () => structuredClone(replay),
    writeReplaySnapshot: async (_runId, snapshot) => { replay = structuredClone(snapshot); calls.push('replay'); },
    getRunEvents: runId => events.filter(event => event.runId === runId),
    appendEvent: async event => {
      if (event.type === 'workspace.recovery_completed' && failCompletionEvent) {
        throw new Error('simulated completion event interruption');
      }
      const stored = { id: `event-${events.length + 1}`, ts: '2026-07-18T12:02:00.000Z', ...structuredClone(event) };
      events.push(stored);
      calls.push(event.type);
      return stored;
    },
    acquireTargetLock: async options => {
      calls.push(`lock:${options.operation}`);
      return () => calls.push('unlock');
    },
    now: () => new Date('2026-07-18T12:03:00.000Z')
  });
  assert.equal(assertOperatorRecoveryRepository(repository), repository);

  const recoveryKey = 'operator-recovery:operation:11';
  const intent = {
    originalHistoryId: 11,
    requestedBy: 'admin',
    operation: 'deletePath',
    args: { path: 'report.txt' },
    preState: { existed: true, type: 'file', contentHash: 'new-hash', content: 'new' },
    target: {
      targetId: 'workspace:local',
      targetKind: 'workspace',
      targetPath: 'report.txt',
      targetResourceId: 'report.txt'
    },
    attemptStartedAt: '2026-07-18T12:02:00.000Z'
  };
  await repository.withOperatorRecoveryLock({ operation: 'deletePath' }, async () => {
    const prepared = await repository.prepareOperatorRecovery({
      originalHistoryId: 11,
      recoveryKey,
      intent
    });
    assert.equal(prepared.inserted, true);
    assert.equal(events.at(-1).type, 'workspace.recovery_prepared');
  });
  assert.deepEqual(calls.slice(0, 3), ['lock:deletePath', 'workspace.recovery_prepared', 'unlock']);

  const completion = {
    originalHistoryId: 11,
    recoveryKey,
    historyRecord: {
      operation: 'deletePath',
      args: { path: 'report.txt' },
      preState: intent.preState,
      postState: { existed: false },
      result: { path: 'report.txt', status: 'deleted' },
      error: null,
      outcome: 'succeeded',
      recoveredBy: 'admin'
    },
    receipt: {
      targetId: 'workspace:local',
      targetKind: 'workspace',
      targetPath: 'report.txt',
      operation: 'deletePath',
      timestamp: intent.attemptStartedAt,
      before: intent.preState,
      after: { existed: false },
      providerResponse: { path: 'report.txt', status: 'deleted' },
      error: null,
      recovery: { originalHistoryId: 11, requestedBy: 'admin', completedBy: 'admin', reconciliation: 'executed' }
    },
    replayItem: {
      operation: { operation: 'deletePath', args: { path: 'report.txt' } },
      result: { path: 'report.txt', status: 'deleted' },
      startedAt: intent.attemptStartedAt,
      isRecovery: true
    },
    event: {
      type: 'workspace.recovery_completed',
      stepId: '1',
      payload: { operation: 'deletePath', path: 'report.txt', isRecovery: true }
    }
  };

  await assert.rejects(
    repository.completeOperatorRecovery(completion),
    /simulated completion event interruption/
  );
  assert.equal(histories.filter(record => record.recoveredHistoryId === 11).length, 1,
    'interruption after history must leave one idempotent recovery receipt');
  assert.equal(replay.workspaceOperations.length, 1,
    'interruption after replay must preserve the appended recovery item');
  assert.equal(events.some(event => event.type === 'workspace.recovery_completed'), false);

  failCompletionEvent = false;
  const repaired = await repository.completeOperatorRecovery(completion);
  assert.equal(repaired.inserted, false);
  assert.equal(repaired.record.isRecovery, true);
  assert.equal(repaired.record.recoveredHistoryId, 11);
  assert.equal(histories.length, 2);
  assert.equal(replay.workspaceOperations.length, 1);
  assert.equal(events.filter(event => event.type === 'workspace.recovery_completed').length, 1);
  const repeated = await repository.completeOperatorRecovery(completion);
  assert.equal(repeated.inserted, false);
  assert.equal(repeated.record.id, repaired.record.id);
  assert.equal(histories.length, 2);
  assert.equal(replay.workspaceOperations.length, 1);
  assert.equal(events.filter(event => event.type === 'workspace.recovery_completed').length, 1);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const repositorySource = fs.readFileSync(path.join(__dirname, '..', 'persistence', 'json', 'operator-recovery-repository.js'), 'utf8');
  assert.ok(serverSource.includes('getOperatorRecoveryRepository().prepareOperatorRecovery({'));
  assert.ok(serverSource.includes('getOperatorRecoveryRepository().completeOperatorRecovery({'));
  assert.ok(serverSource.includes('getOperatorRecoveryRepository().withOperatorRecoveryLock({'));
  assert.ok(repositorySource.includes("type: 'workspace.recovery_prepared'"));
  assert.ok(serverSource.includes("type: 'workspace.recovery_completed'"));
  assert.ok(serverSource.includes("config: { eventJournalAdmission: true }"));
  assert.ok(serverSource.includes('classifyPreparedWorkspaceMutation(workspaceProvider, intent)'));

  console.log('PASS: operator recovery repository contract — durable preparation, target locking, idempotent completion, evidence repair, and PostgreSQL parity');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
