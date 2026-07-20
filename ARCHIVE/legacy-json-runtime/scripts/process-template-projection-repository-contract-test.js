#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  JsonProcessTemplateProjectionRepository,
  REQUIRED_PROCESS_TEMPLATE_PROJECTION_REPOSITORY_METHODS,
  assertProcessTemplateProjectionRepository
} = require('../persistence/json/process-template-projection-repository');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function template(id, overrides = {}) {
  return {
    id,
    name: `Template ${id}`,
    version: 1,
    currentVersion: 1,
    enabled: true,
    schedule: null,
    ticketTemplate: {
      objective: `Objective ${id}`,
      assignmentTargetType: 'agent',
      assignmentTargetId: 1
    },
    createdBy: 'operator',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function generatedTicket(id, templateId, status, createdAt, triage = null) {
  return {
    id,
    status,
    createdAt,
    triage,
    source: {
      type: 'process_template',
      templateId,
      templateName: `Template ${templateId}`,
      templateVersion: 1,
      triggerType: id % 2 === 0 ? 'schedule' : 'manual',
      triggerToken: `token-${id}`,
      createdAt,
      ...(id % 2 === 0 ? { scheduledFor: createdAt } : {})
    }
  };
}

async function main() {
  const templates = [
    template(1, {
      workContextId: 10,
      schedule: { enabled: true, kind: 'interval', everySeconds: 60, nextRunAt: '2026-07-18T11:59:00.000Z' }
    }),
    template(2, { workContextId: 20, enabled: false }),
    template(3, {
      workContextId: 10,
      schedule: { enabled: false, kind: 'interval', everySeconds: 120, nextRunAt: null }
    })
  ];
  const tickets = [
    generatedTicket(101, 1, 'open', '2026-07-18T10:01:00.000Z'),
    generatedTicket(102, 1, 'completed', '2026-07-18T10:02:00.000Z'),
    generatedTicket(103, 1, 'failed', '2026-07-18T10:03:00.000Z'),
    generatedTicket(104, 1, 'completed', '2026-07-18T10:04:00.000Z'),
    generatedTicket(105, 1, 'in_progress', '2026-07-18T10:05:00.000Z'),
    generatedTicket(106, 1, 'blocked', '2026-07-18T10:06:00.000Z', { required: true, reasonCode: 'verification_failed' }),
    { id: 999, status: 'open', source: { type: 'handoff' } }
  ];
  const triggers = [{
    id: 7,
    triggerToken: 'token-106',
    templateId: 1,
    templateVersion: 1,
    ticketId: 106,
    triggeredBy: 'system',
    triggerType: 'schedule',
    scheduledFor: '2026-07-18T10:06:00.000Z',
    createdAt: '2026-07-18T10:06:00.000Z'
  }];
  const repository = new JsonProcessTemplateProjectionRepository({
    readProcessTemplates: () => structuredClone(templates),
    readProcessTemplateTriggers: () => structuredClone(triggers),
    readTickets: () => structuredClone(tickets),
    maxQueryRows: 2
  });

  assert.deepEqual(REQUIRED_PROCESS_TEMPLATE_PROJECTION_REPOSITORY_METHODS, [
    'listProcessTemplateStates',
    'getProcessTemplateStateById',
    'getProcessTemplateCounts',
    'getProcessTemplateCountsByWorkContextIds',
    'getProcessTemplateTriggerProvenance'
  ]);
  assert.equal(assertProcessTemplateProjectionRepository(repository), repository);
  assert.equal(
    assertProcessTemplateProjectionRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore,
    true,
    'PostgreSQL store must implement the projection contract'
  );
  assert.throws(() => assertProcessTemplateProjectionRepository({}), /must implement listProcessTemplateStates/);

  const firstPage = await repository.listProcessTemplateStates({ limit: 2, now: NOW });
  assert.deepEqual(firstPage.processTemplates.map(item => item.id), [1, 2]);
  assert.equal(firstPage.nextAfterId, 2);
  const first = firstPage.processTemplates[0];
  assert.equal(first.dueStatus, 'due');
  assert.equal(first.healthStatus, 'attention_needed');
  assert.deepEqual(first.generatedTicketCounts, {
    total: 6,
    blocked: 1,
    triaged: 1,
    pending: 1,
    inProgress: 1,
    completed: 2,
    failed: 1
  });
  assert.deepEqual(first.recentGeneratedTickets.map(item => item.ticketId), [106, 105, 104, 103, 102]);
  assert.equal(first.lastGeneratedTicketTriageReason, 'verification_failed');

  const secondPage = await repository.listProcessTemplateStates({ afterId: 2, limit: 2, now: NOW });
  assert.deepEqual(secondPage.processTemplates.map(item => item.id), [3]);
  assert.equal(secondPage.processTemplates[0].dueStatus, 'schedule_paused');
  assert.equal(secondPage.nextAfterId, null);
  assert.deepEqual(
    (await repository.listProcessTemplateStates({ workContextId: 10, limit: 2, now: NOW })).processTemplates.map(item => item.id),
    [1, 3]
  );
  await assert.rejects(repository.listProcessTemplateStates({ limit: 3 }), /configured maximum/);

  assert.equal((await repository.getProcessTemplateStateById(2, { now: NOW })).healthStatus, 'disabled');
  assert.equal(await repository.getProcessTemplateStateById(99), null);
  assert.deepEqual(await repository.getProcessTemplateCounts(), {
    total: 3,
    enabled: 2,
    disabled: 1,
    scheduled: 1,
    pausedSchedule: 1
  });
  assert.deepEqual(await repository.getProcessTemplateCountsByWorkContextIds({ workContextIds: [20, 10] }), [
    { workContextId: 20, processTemplateCount: 1, scheduledTemplateCount: 0 },
    { workContextId: 10, processTemplateCount: 2, scheduledTemplateCount: 1 }
  ]);
  await assert.rejects(repository.getProcessTemplateCountsByWorkContextIds({ workContextIds: [10, 20, 30] }), /configured maximum/);
  assert.equal((await repository.getProcessTemplateTriggerProvenance({ ticketId: 106 })).id, 7);
  assert.equal((await repository.getProcessTemplateTriggerProvenance({ triggerToken: 'token-106' })).ticketId, 106);
  assert.equal(await repository.getProcessTemplateTriggerProvenance({ ticketId: 101 }), null);
  await assert.rejects(repository.getProcessTemplateTriggerProvenance({}), /required/);

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(serverSource.includes('function getProcessTemplateProjectionRepository()'));
  assert.ok(serverSource.includes('getProcessTemplateProjectionRepository().listProcessTemplateStates({'));
  assert.ok(serverSource.includes('getProcessTemplateProjectionRepository().getProcessTemplateCounts()'));
  assert.ok(serverSource.includes('getProcessTemplateProjectionRepository().getProcessTemplateCountsByWorkContextIds({'));
  assert.ok(serverSource.includes('getProcessTemplateProjectionRepository().getProcessTemplateTriggerProvenance({'));
  assert.equal(serverSource.includes('function deriveProcessTemplateState('), false);

  const workContextSummary = serverSource.slice(
    serverSource.indexOf('async function buildWorkContextSummary('),
    serverSource.indexOf('// ---- Bounded watcher store', serverSource.indexOf('async function buildWorkContextSummary('))
  );
  assert.equal(workContextSummary.includes('readProcessTemplates()'), false);
  assert.equal(workContextSummary.includes('readProcessTemplateTriggers()'), false);
  const operationalSummary = serverSource.slice(
    serverSource.indexOf('async function buildOperationalSummary('),
    serverSource.indexOf('async function prepareAgentRunDraft(', serverSource.indexOf('async function buildOperationalSummary('))
  );
  assert.equal(operationalSummary.includes('readProcessTemplates()'), false);

  const migration = fs.readFileSync(path.join(ROOT, 'persistence/postgres/migrations/017_process_template_projection.sql'), 'utf8');
  for (const required of [
    'CREATE TABLE process_templates',
    'CREATE INDEX process_templates_work_context_id_idx',
    'CREATE INDEX process_templates_due_idx',
    'CONSTRAINT process_templates_schedule_cursor',
    'CREATE TRIGGER process_templates_revision_guard',
    'CREATE TABLE process_template_status_counts',
    'CREATE FUNCTION maintain_process_template_status_count()',
    'CREATE TRIGGER process_templates_status_count',
    'CONSTRAINT process_template_status_counts_nonnegative',
    'CREATE TABLE process_template_versions',
    'supersedes_version_id TEXT REFERENCES process_template_versions(id) ON DELETE RESTRICT',
    'CREATE FUNCTION enforce_process_template_version_immutability()',
    'process-template version activation provenance is immutable',
    'CREATE TRIGGER process_template_versions_immutability_guard',
    'CREATE UNIQUE INDEX process_template_versions_one_active_idx',
    'CREATE TABLE process_template_triggers',
    'CONSTRAINT process_template_triggers_schedule_shape',
    'CREATE TRIGGER process_template_triggers_append_only'
  ]) {
    assert.ok(migration.includes(required), `projection migration must include: ${required}`);
  }

  console.log('PASS: process-template projection uses bounded state, triage, Work Context counts, and trigger provenance authorities');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
