#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  ModelRoutingPolicyConflictError,
  ModelRoutingPolicyIdConflictError,
  ModelRoutingPolicyReferenceError,
  assertModelRoutingPolicyRepository
} = require('../persistence/model-routing-policy-catalog');
const { JsonModelRoutingPolicyRepository } = require('../persistence/json/model-routing-policy-repository');

const ROOT = path.resolve(__dirname, '..');
const ISO = '2026-07-19T12:00:00.000Z';

function value(name, overrides = {}) {
  return {
    name,
    status: 'active',
    workContextId: null,
    capabilityId: null,
    allowedProviders: [],
    preferredProvider: null,
    preferredModel: null,
    fallbackProviders: [],
    maxCost: null,
    maxLatency: null,
    riskClass: 'standard',
    toolRequirements: [],
    targetRequirements: [],
    verificationRequirement: null,
    triageOnNoRoute: true,
    ...overrides
  };
}

function record(id, name = `Policy ${id}`, overrides = {}) {
  return {
    id,
    ...value(name, overrides),
    revision: 1,
    createdBy: 'seed',
    createdAt: ISO,
    updatedBy: 'seed',
    updatedAt: ISO
  };
}

function createQueue() {
  let tail = Promise.resolve();
  return operation => {
    const result = tail.then(operation, operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

function harness({ initial = [], workContexts = [{ id: 10 }, { id: 20 }], appendSystemLog = async value => value } = {}) {
  let policies = structuredClone(initial);
  const repository = assertModelRoutingPolicyRepository(new JsonModelRoutingPolicyRepository({
    readPolicies: () => structuredClone(policies),
    writePolicies: value => { policies = structuredClone(value); },
    readWorkContexts: () => structuredClone(workContexts),
    appendSystemLog,
    queueMutation: createQueue(),
    now: () => new Date(ISO),
    maxQueryRows: 3
  }));
  return { repository, policies: () => structuredClone(policies) };
}

async function main() {
  const catalog = harness({
    initial: [
      record(7, 'Archived', { status: 'archived' }),
      record(2, 'Global later'),
      record(1, 'Global first'),
      record(3, 'Capability', { capabilityId: 'draft' }),
      record(4, 'Context', { workContextId: 10 }),
      record(6, 'Context capability later', { workContextId: 10, capabilityId: 'draft' }),
      record(5, 'Context capability first', { workContextId: 10, capabilityId: 'draft' })
    ]
  });

  const firstPage = await catalog.repository.listModelRoutingPolicies({ limit: 3 });
  assert.deepEqual(firstPage.policies.map(item => item.id), [1, 2, 3]);
  assert.equal(firstPage.nextAfterId, 3);
  const secondPage = await catalog.repository.listModelRoutingPolicies({ afterId: 3, statuses: ['active'], limit: 3 });
  assert.deepEqual(secondPage.policies.map(item => item.id), [4, 5, 6]);
  assert.equal((await catalog.repository.getModelRoutingPolicyById(4)).name, 'Context');
  assert.deepEqual(await catalog.repository.getModelRoutingPolicyCounts(), { active: 6, archived: 1, total: 7 });

  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({
    explicitPolicyId: 3, workContextId: 10, capabilityId: 'draft'
  })).policy.id, 3);
  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({
    workContextId: 10, capabilityId: 'draft'
  })).policy.id, 5);
  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({
    workContextId: 10, capabilityId: 'other'
  })).policy.id, 4);
  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({
    workContextId: 20, capabilityId: 'draft'
  })).policy.id, 3);
  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({
    workContextId: 20, capabilityId: 'other'
  })).policy.id, 1);
  assert.equal((await catalog.repository.findApplicableModelRoutingPolicy({ explicitPolicyId: 7 })).policy.id, 1);

  const mutations = harness({ initial: [record(1, 'Existing')] });
  const created = await mutations.repository.createModelRoutingPolicy({
    value: value('Scoped', { workContextId: 10 }),
    changedBy: 'operator',
    audit: { type: 'model_routing:policy_created', message: 'created', metadata: {} }
  });
  assert.equal(created.policy.id, 2);
  assert.equal(created.policy.revision, 1);
  assert.equal(created.auditLog.metadata.policyId, 2);
  const updated = await mutations.repository.updateModelRoutingPolicy({
    policyId: 2,
    expectedRevision: 1,
    value: value('Scoped reviewed', { workContextId: 10, status: 'archived' }),
    changedBy: 'reviewer',
    audit: { type: 'model_routing:policy_updated', message: 'updated', metadata: {} }
  });
  assert.equal(updated.policy.revision, 2);
  assert.equal(updated.policy.createdBy, 'operator');
  await assert.rejects(
    mutations.repository.updateModelRoutingPolicy({
      policyId: 2,
      expectedRevision: 1,
      value: value('Stale'),
      changedBy: 'stale'
    }),
    error => error instanceof ModelRoutingPolicyConflictError && error.current.revision === 2
  );

  await assert.rejects(
    mutations.repository.createModelRoutingPolicy({
      value: value('Missing context', { workContextId: 999 }),
      changedBy: 'operator'
    }),
    error => error instanceof ModelRoutingPolicyReferenceError && error.code === 'WORK_CONTEXT_NOT_FOUND'
  );

  const rollback = harness({
    initial: [record(1, 'Rollback')],
    appendSystemLog: async () => { throw new Error('audit unavailable'); }
  });
  await assert.rejects(
    rollback.repository.updateModelRoutingPolicy({
      policyId: 1,
      expectedRevision: 1,
      value: value('Should roll back'),
      changedBy: 'operator',
      audit: { type: 'model_routing:policy_updated', message: 'updated', metadata: {} }
    }),
    /audit unavailable/
  );
  assert.equal(rollback.policies()[0].name, 'Rollback');
  assert.equal(rollback.policies()[0].revision, 1);

  const concurrent = harness({ initial: [record(1, 'Concurrent')] });
  const race = await Promise.allSettled([
    concurrent.repository.updateModelRoutingPolicy({
      policyId: 1, expectedRevision: 1, value: value('Winner one'), changedBy: 'one'
    }),
    concurrent.repository.updateModelRoutingPolicy({
      policyId: 1, expectedRevision: 1, value: value('Winner two'), changedBy: 'two'
    })
  ]);
  assert.equal(race.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(race.filter(item => item.status === 'rejected').length, 1);

  const duplicate = harness({ initial: [record(1), record(1, 'Duplicate')] });
  await assert.rejects(
    duplicate.repository.listModelRoutingPolicies({ limit: 1 }),
    error => error instanceof ModelRoutingPolicyIdConflictError
  );
  const incomplete = harness({
    initial: [{ id: 1, name: 'Old shape', status: 'active', createdAt: ISO, updatedAt: ISO }]
  });
  await assert.rejects(
    incomplete.repository.listModelRoutingPolicies({ limit: 1 }),
    /missing current-format field/
  );
  await assert.rejects(catalog.repository.listModelRoutingPolicies({ limit: 4 }), /configured maximum/);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  const methodSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'model-routing-policy-methods.js'), 'utf8');
  const migrationSource = fs.readFileSync(
    path.join(ROOT, 'persistence', 'postgres', 'migrations', '021_model_routing_policy_authority.sql'),
    'utf8'
  );
  assert.equal(serverSource.includes('function readModelRoutingPolicies()'), false);
  assert.equal(serverSource.includes('function writeModelRoutingPolicies('), false);
  assert.ok(serverSource.includes('findApplicableModelRoutingPolicy({'));
  assert.ok(serverSource.includes('await resolveModelRouteForRun({'));
  assert.ok(serverSource.includes('expectedRevision ?? request.body.revision'));
  assert.ok(storeSource.includes('installModelRoutingPolicyMethods(PostgresRuntimeStore'));
  assert.ok(storeSource.includes('await this._assertTicketRoutingPolicy(connection, ticket)'));
  assert.ok(methodSource.includes("WHERE id = $1 AND status = 'active'"));
  assert.ok(methodSource.includes('work_context_id IS NOT DISTINCT FROM $1::bigint'));
  assert.ok(methodSource.includes("SELECT * FROM ${this.table('model_routing_policies')} WHERE id = $1 FOR UPDATE"));
  assert.ok(migrationSource.includes('CREATE TABLE model_routing_policies'));
  assert.ok(migrationSource.includes('CREATE INDEX model_routing_policies_dispatch_idx'));
  assert.ok(migrationSource.includes('CONSTRAINT model_routing_policies_work_context_fk'));
  assert.ok(migrationSource.includes('CONSTRAINT tickets_routing_policy_body_shape'));
  assert.ok(migrationSource.includes('CONSTRAINT tickets_routing_policy_fk'));
  assert.ok(migrationSource.includes('no JSON importer or legacy compatibility path is provided'));

  console.log('PASS: model routing policy repository — bounded catalog reads, strict current-format records, indexed deterministic selection, optimistic audited mutations, and references');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
