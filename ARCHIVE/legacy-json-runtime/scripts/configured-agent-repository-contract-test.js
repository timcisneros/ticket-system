#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ConfiguredAgentConflictError,
  ConfiguredAgentNameConflictError,
  JsonConfiguredAgentRepository,
  REQUIRED_CONFIGURED_AGENT_REPOSITORY_METHODS,
  assertConfiguredAgentRepository
} = require('../persistence/json/configured-agent-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-07-18T12:00:00.000Z';

function agent(id, name, provider = 'openai', revision = 1) {
  return {
    id,
    name,
    type: 'agent',
    provider,
    model: provider === 'ollama' ? 'gemma3:latest' : 'gpt-test',
    apiKey: provider === 'ollama' ? '' : 'secret',
    revision,
    createdAt: '2026-07-01T00:00:00.000Z',
    changedBy: 'seed',
    changedAt: '2026-07-01T00:00:00.000Z'
  };
}

function createHarness({ appendSystemLog = null, maxQueryRows = 3 } = {}) {
  let agents = [agent(1, 'Agent 1'), agent(2, 'Mike', 'ollama')];
  let memberships = [
    { id: 1, principalType: 'user', principalId: 7, groupId: 10 },
    { id: 2, principalType: 'agent', principalId: 1, groupId: 10 },
    { id: 3, principalType: 'agent', principalId: 2, groupId: 20 }
  ];
  const logs = [];
  const repository = new JsonConfiguredAgentRepository({
    readAgents: () => structuredClone(agents),
    writeAgents: value => { agents = structuredClone(value); },
    readGroups: () => [{ id: 10 }, { id: 20 }],
    readMemberships: () => structuredClone(memberships),
    writeMemberships: value => { memberships = structuredClone(value); },
    appendSystemLog: appendSystemLog || (entry => {
      const log = { id: logs.length + 1, ...structuredClone(entry) };
      logs.push(log);
      return log;
    }),
    now: () => new Date(NOW),
    maxQueryRows
  });
  return {
    repository,
    logs,
    agents: () => structuredClone(agents),
    memberships: () => structuredClone(memberships)
  };
}

async function main() {
  const harness = createHarness();
  const { repository, logs } = harness;
  assert.deepEqual(REQUIRED_CONFIGURED_AGENT_REPOSITORY_METHODS, [
    'listConfiguredAgents',
    'getConfiguredAgentById',
    'getConfiguredAgentByName',
    'getConfiguredAgentsByIds',
    'listConfiguredAgentsByGroup',
    'listAgentGroupMemberships',
    'createConfiguredAgent',
    'updateConfiguredAgent',
    'deleteConfiguredAgent',
    'removeConfiguredAgentMembershipsForGroup'
  ]);
  assert.equal(assertConfiguredAgentRepository(repository), repository);
  assert.equal(
    assertConfiguredAgentRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the configured-agent contract'
  );
  assert.throws(() => assertConfiguredAgentRepository({}), /must implement listConfiguredAgents/);

  const first = await repository.listConfiguredAgents({ limit: 1 });
  assert.deepEqual(first.agents.map(item => item.id), [1]);
  assert.equal(first.nextAfterId, 1);
  const second = await repository.listConfiguredAgents({ afterId: 1, limit: 1 });
  assert.deepEqual(second.agents.map(item => item.id), [2]);
  assert.equal(second.nextAfterId, null);
  assert.deepEqual((await repository.listConfiguredAgents({ providers: ['ollama'], limit: 2 })).agents.map(item => item.id), [2]);
  await assert.rejects(repository.listConfiguredAgents({ limit: 4 }), /configured maximum/);

  assert.deepEqual((await repository.getConfiguredAgentById(1)).groupIds, [10]);
  assert.equal((await repository.getConfiguredAgentByName('Mike')).id, 2);
  assert.equal((await repository.getConfiguredAgentByName('mIkE', { caseInsensitive: true })).id, 2);
  assert.equal(await repository.getConfiguredAgentById(999), null);
  assert.deepEqual((await repository.listConfiguredAgentsByGroup({ groupId: 20, limit: 2 })).agents.map(item => item.id), [2]);
  assert.deepEqual((await repository.listAgentGroupMemberships({ limit: 2 })).memberships, [
    { agentId: 1, groupId: 10 },
    { agentId: 2, groupId: 20 }
  ]);
  assert.deepEqual((await repository.getConfiguredAgentsByIds({ agentIds: [2, 1] })).map(item => item.id), [1, 2]);
  await assert.rejects(repository.getConfiguredAgentsByIds({ agentIds: [1, 2, 3, 4] }), /configured maximum/);

  const created = await repository.createConfiguredAgent({
    value: { name: 'Reviewer', provider: 'openai', model: 'gpt-review', apiKey: 'key' },
    groupIds: [10, 20],
    changedBy: 'operator'
  });
  assert.equal(created.agent.id, 3);
  assert.equal(created.agent.revision, 1);
  assert.deepEqual(created.agent.groupIds, [10, 20]);
  assert.equal(logs.at(-1).type, 'admin:agent_create');
  assert.equal(logs.at(-1).metadata.targetAgentId, 3);
  assert.equal(harness.memberships().some(item => item.principalType === 'user' && item.principalId === 7), true);

  await assert.rejects(
    repository.createConfiguredAgent({
      value: { name: 'Reviewer', provider: 'openai', model: '', apiKey: '' },
      changedBy: 'operator'
    }),
    error => error instanceof ConfiguredAgentNameConflictError
  );

  const updated = await repository.updateConfiguredAgent({
    agentId: 3,
    expectedRevision: 1,
    value: { ...created.agent, name: 'Review Agent', provider: 'ollama', model: 'gemma3:latest', apiKey: '' },
    groupIds: [20],
    changedBy: 'operator-2'
  });
  assert.equal(updated.agent.revision, 2);
  assert.equal(updated.agent.provider, 'ollama');
  assert.deepEqual(updated.agent.groupIds, [20]);
  assert.equal(logs.at(-1).type, 'admin:agent_edit');
  await assert.rejects(
    repository.updateConfiguredAgent({
      agentId: 3,
      expectedRevision: 1,
      value: updated.agent,
      groupIds: [],
      changedBy: 'stale'
    }),
    error => error instanceof ConfiguredAgentConflictError && error.current.revision === 2
  );

  const removed = await repository.deleteConfiguredAgent({ agentId: 3, expectedRevision: 2, changedBy: 'operator-3' });
  assert.equal(removed.agent.name, 'Review Agent');
  assert.equal(await repository.getConfiguredAgentById(3), null);
  assert.equal(harness.memberships().some(item => item.principalType === 'agent' && item.principalId === 3), false);
  assert.equal(logs.at(-1).type, 'admin:agent_delete');
  const pruned = await repository.removeConfiguredAgentMembershipsForGroup({ groupId: 20 });
  assert.equal(pruned.removedCount, 1);
  assert.equal(harness.memberships().some(item => item.principalType === 'agent' && item.groupId === 20), false);
  assert.equal(harness.memberships().some(item => item.principalType === 'user'), true);


  const rollback = createHarness({ appendSystemLog: () => { throw new Error('audit unavailable'); } });
  const beforeAgents = rollback.agents();
  const beforeMemberships = rollback.memberships();
  await assert.rejects(
    rollback.repository.createConfiguredAgent({
      value: { name: 'Rollback Agent', provider: 'openai', model: 'gpt-test', apiKey: 'key' },
      groupIds: [10],
      changedBy: 'operator'
    }),
    /audit unavailable/
  );
  assert.deepEqual(rollback.agents(), beforeAgents, 'JSON adapter restores agents when required audit evidence fails');
  assert.deepEqual(rollback.memberships(), beforeMemberships, 'JSON adapter restores memberships when required audit evidence fails');

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.join(ROOT, 'runtime/scheduler.js'), 'utf8');
  assert.ok(serverSource.includes('getConfiguredAgentRepository().listConfiguredAgents('));
  assert.ok(serverSource.includes('getConfiguredAgentRepository().getConfiguredAgentById('));
  assert.ok(serverSource.includes("getConfiguredAgentByName(requested, { caseInsensitive: true })"));
  assert.ok(serverSource.includes('getConfiguredAgentRepository().getConfiguredAgentsByIds({ agentIds })'));
  assert.ok(serverSource.includes('getConfiguredAgentRepository().createConfiguredAgent('));
  assert.ok(serverSource.includes('getConfiguredAgentRepository().updateConfiguredAgent('));
  assert.ok(serverSource.includes('getConfiguredAgentRepository().deleteConfiguredAgent('));
  assert.ok(schedulerSource.includes('prepareRunStartContext(pendingRuns)'));
  assert.equal(serverSource.includes('function readAgents()'), false);
  assert.equal(serverSource.includes('function writeAgents('), false);
  assert.equal(serverSource.includes('new Set(readConfiguredAgentFile()'), false);
  assert.equal(serverSource.includes('readConfiguredAgentFile().some'), false);
  assert.equal(serverSource.includes('nextId(agents)'), false);
  assert.equal(serverSource.includes("name.toLowerCase() === lower"), false);
  assert.ok(schedulerSource.includes('await getRunStartBlockReason(run, runStartContext)'));
  assert.ok(schedulerSource.includes('await tryReserveRunStart(run, runStartContext)'));

  console.log('configured-agent repository contract tests passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
