#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { JsonProcessTemplateAuthorityRepository } = require('../persistence/json/process-template-authority-repository');
const {
  ProcessTemplateConflictError,
  REQUIRED_PROCESS_TEMPLATE_AUTHORITY_METHODS,
  assertProcessTemplateAuthorityRepository
} = require('../persistence/process-template-authority');
const { PostgresRuntimeStore } = require('../persistence/postgres/store');

const ROOT = path.resolve(__dirname, '..');
let templates = [];
let versions = [];
let triggers = [];
let tickets = [];
let logs = [];
let clockMs = Date.parse('2026-07-18T12:00:00.000Z');
const clone = value => structuredClone(value);
const repository = new JsonProcessTemplateAuthorityRepository({
  readProcessTemplates: () => clone(templates),
  writeProcessTemplates: value => { templates = clone(value); },
  readProcessTemplateVersions: () => clone(versions),
  writeProcessTemplateVersions: value => { versions = clone(value); },
  readProcessTemplateTriggers: () => clone(triggers),
  writeProcessTemplateTriggers: value => { triggers = clone(value); },
  findTicketByTriggerToken: token => clone(tickets.find(ticket => ticket.source && ticket.source.triggerToken === token) || null),
  getTicketById: id => clone(tickets.find(ticket => ticket.id === id) || null),
  appendSystemLog: async value => {
    const log = { id: logs.length + 1, ...clone(value), ...(value.metadata || {}) };
    logs.push(log);
    return log;
  },
  now: () => new Date(clockMs),
  maxQueryRows: 2
});

async function main() {
  assert.deepEqual(REQUIRED_PROCESS_TEMPLATE_AUTHORITY_METHODS, [
    'getProcessTemplateById', 'createProcessTemplate', 'setProcessTemplateEnabled',
    'setProcessTemplateSchedule', 'pauseProcessTemplateSchedule', 'resumeProcessTemplateSchedule',
    'assignProcessTemplateWorkContext', 'createProcessTemplateDraft',
    'activateProcessTemplateVersion', 'listDueProcessTemplates',
    'executeProcessTemplateTrigger', 'reconcileProcessTemplateVersions'
  ]);
  assert.equal(assertProcessTemplateAuthorityRepository(repository), repository);
  assert.equal(assertProcessTemplateAuthorityRepository(Object.create(PostgresRuntimeStore.prototype)) instanceof PostgresRuntimeStore, true);
  assert.throws(() => assertProcessTemplateAuthorityRepository({}), /must implement getProcessTemplateById/);

  const created = await repository.createProcessTemplate({
    changedBy: 'operator',
    value: {
      name: 'Legal review', enabled: true,
      ticketTemplate: {
        objective: 'Review legal request', assignmentTargetType: 'agent', assignmentTargetId: 1,
        capabilityType: 'directAction', executionPolicy: { maxAttempts: 2 }
      }
    }
  });
  assert.equal(created.template.currentVersionId, 'ptv_1_1');
  assert.equal(created.template.revision, 1);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].status, 'active');
  assert.equal(logs[0].type, 'process_template:created');

  const assigned = await repository.assignProcessTemplateWorkContext({
    templateId: 1, workContextId: 7,
    workContextSnapshot: { id: 7, name: 'Legal' }, changedBy: 'operator'
  });
  assert.equal(assigned.template.workContextId, 7);
  assert.equal(assigned.template.revision, 2);

  const scheduled = await repository.setProcessTemplateSchedule({
    templateId: 1, enabled: true, everySeconds: 60, changedBy: 'operator'
  });
  assert.equal(scheduled.template.schedule.nextRunAt, '2026-07-18T12:01:00.000Z');
  clockMs += 61_000;
  assert.deepEqual((await repository.listDueProcessTemplates({ dueAt: new Date(clockMs), limit: 2 })).map(item => item.id), [1]);
  await assert.rejects(repository.listDueProcessTemplates({ limit: 3 }), /configured maximum/);

  async function createTicket({ template, source, spawnIdempotencyKey }) {
    const existing = tickets.find(ticket => ticket.spawnIdempotencyKey === spawnIdempotencyKey);
    if (existing) return { ok: true, ticket: clone(existing), created: false };
    const ticket = {
      id: tickets.length + 1, status: 'open', objective: template.ticketTemplate.objective,
      executionPolicy: template.ticketTemplate.executionPolicy, source, spawnIdempotencyKey
    };
    tickets.push(ticket);
    return { ok: true, ticket: clone(ticket), created: true };
  }

  const scheduledFor = scheduled.template.schedule.nextRunAt;
  const fired = await repository.executeProcessTemplateTrigger({
    templateId: 1, triggerToken: `schedule:1:${scheduledFor}`, triggerType: 'schedule',
    scheduledFor, triggeredBy: 'system', createTicket
  });
  assert.equal(fired.deduped, false);
  assert.equal(tickets.length, 1);
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].templateVersion, 1);
  assert.equal(templates[0].schedule.nextRunAt, '2026-07-18T12:02:01.000Z');

  templates[0].schedule.nextRunAt = scheduledFor;
  const replayed = await repository.executeProcessTemplateTrigger({
    templateId: 1, triggerToken: `schedule:1:${scheduledFor}`, triggerType: 'schedule',
    scheduledFor, triggeredBy: 'system', createTicket
  });
  assert.equal(replayed.deduped, true);
  assert.equal(tickets.length, 1);
  assert.equal(triggers.length, 1);
  assert.ok(Date.parse(templates[0].schedule.nextRunAt) > clockMs);

  await repository.pauseProcessTemplateSchedule({ templateId: 1, changedBy: 'operator' });
  const draft = await repository.createProcessTemplateDraft({
    templateId: 1, ticketTemplate: { objective: 'Review legal request v2' },
    changeSummary: 'tighten objective', changedBy: 'operator'
  });
  assert.equal(draft.draft.id, 'ptv_1_2');
  assert.equal(draft.draft.status, 'draft');
  await assert.rejects(
    repository.createProcessTemplateDraft({ templateId: 1, changedBy: 'operator' }),
    error => error instanceof ProcessTemplateConflictError && error.code === 'PROCESS_TEMPLATE_DRAFT_EXISTS'
  );
  const activated = await repository.activateProcessTemplateVersion({
    templateId: 1, versionId: 'ptv_1_2', changedBy: 'operator'
  });
  assert.equal(activated.template.currentVersion, 2);
  assert.equal(activated.template.ticketTemplate.objective, 'Review legal request v2');
  assert.deepEqual(versions.map(item => item.status), ['superseded', 'active']);
  assert.deepEqual(await repository.reconcileProcessTemplateVersions(), { repairedCount: 0 });

  await repository.setProcessTemplateEnabled({ templateId: 1, enabled: false, changedBy: 'operator' });
  await assert.rejects(
    repository.executeProcessTemplateTrigger({
      templateId: 1, triggerToken: 'disabled', triggerType: 'manual', triggeredBy: 'operator', createTicket
    }),
    error => error instanceof ProcessTemplateConflictError && error.code === 'PROCESS_TEMPLATE_DISABLED'
  );

  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routeRegion = serverSource.slice(
    serverSource.indexOf("fastify.post('/api/process-templates'"),
    serverSource.indexOf("fastify.get('/process-templates'", serverSource.indexOf("fastify.post('/api/process-templates'"))
  );
  for (const forbidden of ['writeProcessTemplates(', 'writeProcessTemplateVersions(', 'appendProcessTemplateTrigger(']) {
    assert.equal(routeRegion.includes(forbidden), false, `template routes must not call ${forbidden}`);
  }
  assert.ok(serverSource.includes('getProcessTemplateAuthorityRepository().executeProcessTemplateTrigger({'));
  assert.ok(serverSource.includes('listDueProcessTemplates: options => getProcessTemplateAuthorityRepository().listDueProcessTemplates(options)'));
  assert.equal(serverSource.includes('reconcileProcessTemplateVersionConsistencyOnStartup'), false);

  const migration = fs.readFileSync(path.join(ROOT, 'persistence/postgres/migrations/018_process_template_authority.sql'), 'utf8');
  for (const required of [
    'process_templates_active_version_fk', 'DEFERRABLE INITIALLY DEFERRED',
    'process_templates_schedule_body_shape', 'process_template_versions_identity_unique',
    'process_template_triggers_template_version_fk'
  ]) assert.ok(migration.includes(required), `authority migration must include ${required}`);

  console.log('PASS: process-template mutations, versions, schedules, and idempotent triggers use one bounded authority repository');
}

main().catch(error => { console.error(error); process.exit(1); });
