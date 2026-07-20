#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS,
  WorkflowCatalogConflictError,
  WorkflowCatalogIdConflictError,
  WorkflowCatalogReferenceError,
  assertWorkflowCatalogRepository
} = require('../persistence/workflow-catalog');
const { JsonWorkflowCatalogRepository } = require('../persistence/json/workflow-catalog-repository');
const { JsonTicketRunLifecycleRepository } = require('../persistence/json/ticket-run-lifecycle-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const NOW = '2026-07-19T12:00:00.000Z';

function definition(id, options = {}) {
  return {
    id,
    name: options.name || `Workflow ${id}`,
    description: options.description || '',
    version: options.version || '1',
    enabled: options.enabled !== false,
    inputSchema: {},
    actions: [{ id: 'done', action: 'stop', input: {} }],
    postconditions: []
  };
}

function record(id, options = {}) {
  return {
    ...definition(id, options),
    revision: options.revision || 1,
    createdBy: 'seed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedBy: 'seed',
    updatedAt: '2026-07-01T00:00:00.000Z'
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

function createHarness({ initial = null, appendSystemLog = null, appendRunEvidence = null, queueMutation = null, maxQueryRows = 10 } = {}) {
  let workflows = structuredClone(initial || [record('alpha'), record('bravo', { enabled: false })]);
  const logs = [];
  const repository = new JsonWorkflowCatalogRepository({
    readWorkflows: () => structuredClone(workflows),
    writeWorkflows: value => { workflows = structuredClone(value); },
    appendRunEvidence,
    appendSystemLog: appendSystemLog || (entry => {
      const log = { id: logs.length + 1, ...structuredClone(entry) };
      logs.push(log);
      return log;
    }),
    queueMutation,
    now: () => new Date(NOW),
    maxQueryRows
  });
  return { repository, logs, workflows: () => structuredClone(workflows) };
}

async function main() {
  const harness = createHarness();
  const { repository, logs } = harness;
  assert.deepEqual(REQUIRED_WORKFLOW_CATALOG_REPOSITORY_METHODS, [
    'listWorkflows',
    'getWorkflowById',
    'getWorkflowsByIds',
    'createWorkflow',
    'createWorkflowWithEvidence',
    'updateWorkflow',
    'ensureDefaultWorkflows'
  ]);
  assert.equal(assertWorkflowCatalogRepository(repository), repository);
  assert.equal(
    assertWorkflowCatalogRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the workflow catalog contract'
  );
  assert.throws(() => assertWorkflowCatalogRepository({}), /must implement listWorkflows/);

  const first = await repository.listWorkflows({ limit: 1 });
  assert.deepEqual(first.workflows.map(item => item.id), ['alpha']);
  assert.equal(first.nextAfterId, 'alpha');
  assert.deepEqual((await repository.listWorkflows({ afterId: 'alpha', limit: 1 })).workflows.map(item => item.id), ['bravo']);
  assert.deepEqual((await repository.listWorkflows({ enabled: true, limit: 2 })).workflows.map(item => item.id), ['alpha']);
  assert.equal((await repository.getWorkflowById('alpha')).revision, 1);
  assert.equal(await repository.getWorkflowById('missing'), null);
  assert.deepEqual((await repository.getWorkflowsByIds({ workflowIds: ['bravo', 'alpha'] })).map(item => item.id), ['alpha', 'bravo']);
  await assert.rejects(repository.listWorkflows({ limit: 11 }), /configured maximum/);

  const created = await repository.createWorkflow({
    value: definition('charlie'),
    changedBy: 'operator',
    audit: {
      type: 'admin:workflow_create',
      message: 'Workflow "Workflow charlie" created',
      metadata: { workflowId: 'charlie', changedBy: 'operator' }
    }
  });
  assert.equal(created.workflow.revision, 1);
  assert.equal(created.workflow.createdAt, NOW);
  assert.equal(logs.at(-1).type, 'admin:workflow_create');
  await assert.rejects(
    repository.createWorkflow({ value: definition('charlie'), changedBy: 'operator' }),
    error => error instanceof WorkflowCatalogIdConflictError && error.workflowId === 'charlie'
  );

  const updated = await repository.updateWorkflow({
    workflowId: 'charlie',
    expectedRevision: 1,
    value: definition('charlie', { name: 'Reviewed workflow', enabled: false }),
    changedBy: 'operator-2',
    audit: {
      type: 'admin:workflow_update',
      message: 'Workflow "Reviewed workflow" updated',
      metadata: { workflowId: 'charlie', changedBy: 'operator-2' }
    }
  });
  assert.equal(updated.workflow.revision, 2);
  assert.equal(updated.workflow.enabled, false);
  assert.equal(updated.workflow.createdBy, 'operator');
  await assert.rejects(
    repository.updateWorkflow({
      workflowId: 'charlie', expectedRevision: 1, value: definition('charlie'), changedBy: 'stale'
    }),
    error => error instanceof WorkflowCatalogConflictError && error.current.revision === 2
  );

  const rollback = createHarness({ appendSystemLog: () => { throw new Error('audit unavailable'); } });
  const beforeRollback = rollback.workflows();
  await assert.rejects(
    rollback.repository.createWorkflow({
      value: definition('rollback'),
      changedBy: 'operator',
      audit: { type: 'admin:workflow_create', message: 'create', metadata: {} }
    }),
    /audit unavailable/
  );
  assert.deepEqual(rollback.workflows(), beforeRollback, 'required audit failure must restore JSON workflow authority');

  const evidenceRollback = createHarness({
    initial: [],
    appendRunEvidence: () => { throw new Error('run evidence unavailable'); }
  });
  await assert.rejects(
    evidenceRollback.repository.createWorkflowWithEvidence({
      value: definition('evidence-rollback'),
      changedBy: 'agent:1',
      evidence: { runId: 1, ticketId: 1, evidenceKey: 'draft:1' }
    }),
    /run evidence unavailable/
  );
  assert.deepEqual(evidenceRollback.workflows(), [], 'draft evidence failure must restore JSON workflow authority');
  let capturedEvidence = null;
  const evidenceSuccess = createHarness({
    initial: [],
    appendRunEvidence: evidence => { capturedEvidence = structuredClone(evidence); return { inserted: true }; }
  });
  const coupled = await evidenceSuccess.repository.createWorkflowWithEvidence({
    value: definition('evidence-coupled'),
    changedBy: 'agent:1',
    evidence: { runId: 1, ticketId: 1, evidenceKey: 'draft:coupled' }
  });
  assert.equal(coupled.evidence.inserted, true);
  assert.equal(capturedEvidence.evidenceKey, 'draft:coupled');
  assert.equal((await evidenceSuccess.repository.getWorkflowById('evidence-coupled')).revision, 1);

  const concurrent = createHarness({ initial: [record('shared')], queueMutation: createQueue() });
  const updates = await Promise.allSettled([
    concurrent.repository.updateWorkflow({
      workflowId: 'shared', expectedRevision: 1, value: definition('shared', { name: 'First' }), changedBy: 'one'
    }),
    concurrent.repository.updateWorkflow({
      workflowId: 'shared', expectedRevision: 1, value: definition('shared', { name: 'Second' }), changedBy: 'two'
    })
  ]);
  assert.equal(updates.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(updates.filter(item => item.status === 'rejected' && item.reason instanceof WorkflowCatalogConflictError).length, 1);

  const defaults = createHarness({ initial: [] });
  const bootstrapped = await defaults.repository.ensureDefaultWorkflows({
    definitions: [definition('default-a'), definition('default-b')], changedBy: 'system'
  });
  assert.deepEqual(bootstrapped.createdWorkflowIds, ['default-a', 'default-b']);
  assert.equal((await defaults.repository.ensureDefaultWorkflows({
    definitions: [definition('default-a'), definition('default-b')], changedBy: 'system'
  })).changed, false);

  const sharedQueue = createQueue();
  let sharedWorkflows = [record('gated', { enabled: false })];
  let sharedTickets = [];
  let releaseAudit;
  const pendingAudit = new Promise((resolve, reject) => { releaseAudit = { resolve, reject }; });
  const gatedCatalog = new JsonWorkflowCatalogRepository({
    readWorkflows: () => structuredClone(sharedWorkflows),
    writeWorkflows: value => { sharedWorkflows = structuredClone(value); },
    appendSystemLog: () => pendingAudit,
    queueMutation: sharedQueue,
    now: () => new Date(NOW)
  });
  const lifecycle = new JsonTicketRunLifecycleRepository({
    readTickets: () => structuredClone(sharedTickets),
    writeTickets: value => { sharedTickets = structuredClone(value); },
    readGroups: () => [],
    readWorkflows: () => structuredClone(sharedWorkflows),
    queueWorkflowMutation: sharedQueue,
    readRuns: () => [],
    writeRuns: () => {},
    appendEvent: event => event,
    now: () => new Date(NOW)
  });
  const failedEnable = gatedCatalog.updateWorkflow({
    workflowId: 'gated',
    expectedRevision: 1,
    value: definition('gated', { enabled: true }),
    changedBy: 'operator',
    audit: { type: 'admin:workflow_update', message: 'enable', metadata: {} }
  });
  await Promise.resolve();
  const queuedTicket = lifecycle.createTicketWithEvent({
    ticket: {
      objective: 'gated work', status: 'open', assignmentTargetType: 'agent', assignmentTargetId: 1,
      executionMode: 'workflow', capabilityType: 'workflow', workflowId: 'gated'
    },
    eventPayload: {}
  });
  releaseAudit.reject(new Error('workflow audit unavailable'));
  await assert.rejects(failedEnable, /workflow audit unavailable/);
  await assert.rejects(
    queuedTicket,
    error => error instanceof WorkflowCatalogReferenceError && error.code === 'WORKFLOW_DISABLED'
  );
  assert.equal(sharedTickets.length, 0, 'ticket admission must observe the rolled-back workflow state');

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const storeSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'store.js'), 'utf8');
  const methodsSource = fs.readFileSync(path.join(ROOT, 'persistence', 'postgres', 'workflow-catalog-methods.js'), 'utf8');
  const migrationSource = fs.readFileSync(
    path.join(ROOT, 'persistence', 'postgres', 'migrations', '020_workflow_catalog_authority.sql'),
    'utf8'
  );
  assert.ok(serverSource.includes('new JsonWorkflowCatalogRepository({'));
  assert.ok(serverSource.includes('queueMutation: queueWorkflowCatalogMutation'));
  assert.ok(serverSource.includes('queueWorkflowMutation: queueWorkflowCatalogMutation'));
  assert.ok(serverSource.includes('await getWorkflowById(ticket.workflowId)'));
  assert.ok(serverSource.includes('await getWorkflowById(workflowId)'));
  assert.ok(serverSource.includes('await getWorkflowCatalogRepository().createWorkflow({'));
  assert.ok(serverSource.includes('await getWorkflowCatalogRepository().createWorkflowWithEvidence({'));
  assert.ok(serverSource.includes('await getWorkflowCatalogRepository().updateWorkflow({'));
  assert.equal(serverSource.includes('function readWorkflows()'), false);
  assert.equal(serverSource.includes('function writeWorkflows('), false);
  assert.ok(storeSource.includes('installWorkflowCatalogMethods(PostgresRuntimeStore, { OptimisticConcurrencyError });'));
  assert.ok(storeSource.includes('await this._assertTicketWorkflow(connection, ticket);'));
  assert.ok(storeSource.includes('await this._assertTicketWorkflow(connection, record);'));
  assert.ok(methodsSource.includes('FOR SHARE'));
  assert.ok(methodsSource.includes('FOR UPDATE'));
  assert.ok(methodsSource.includes('ORDER BY id COLLATE "C"'));
  assert.ok(methodsSource.includes('const auditLog = audit ? await this._appendSystemLog(client, audit) : null;'));
  assert.ok(methodsSource.includes('await this.appendRunEvidence(evidence, { client })'));
  assert.ok(migrationSource.includes('CREATE TABLE workflow_definitions'));
  assert.ok(migrationSource.includes('workflow_definitions_enabled_id_c_idx'));
  assert.ok(migrationSource.includes('workflow_definitions_revision_guard'));
  assert.ok(migrationSource.includes('tickets_workflow_definition_fk'));
  assert.ok(migrationSource.includes('no JSON importer or legacy compatibility path is provided'));

  console.log('PASS: workflow catalog uses exact/batched/keyset reads, optimistic mutations, coupled admin audit, and coordinated ticket admission');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
