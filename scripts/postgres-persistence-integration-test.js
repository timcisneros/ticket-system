#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  IdempotencyConflictError,
  ImmutableEvidenceConflictError,
  LeaseAuthorityError,
  OptimisticConcurrencyError,
  PostgresRuntimeStore,
  TriageConflictError
} = require('../persistence/postgres/store');
const { verifyCurrentRunEventChain } = require('../runtime/event-integrity');
const { BUILTIN_PERMISSIONS, compareCatalogNames } = require('../persistence/access-catalog');
const { RuntimeLimitsConflictError } = require('../persistence/runtime-limits');

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString) {
  console.error('TEST_DATABASE_URL is required for the PostgreSQL integration test');
  process.exit(1);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref();
  });
}

async function main() {
  const schema = `ticket_system_test_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const nonemptyFoundationSchema = `${schema}_nonempty`;
  const store = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const peer = new PostgresRuntimeStore({ connectionString, schema, lockTimeoutMs: 3_000 });
  const smallRecordStore = new PostgresRuntimeStore({
    connectionString,
    schema,
    lockTimeoutMs: 3_000,
    maxJsonRecordBytes: 256
  });
  const singleConnectionStore = new PostgresRuntimeStore({
    connectionString,
    schema,
    lockTimeoutMs: 3_000,
    maxConnections: 1
  });
  const nonemptyFoundationStore = new PostgresRuntimeStore({
    connectionString,
    schema: nonemptyFoundationSchema,
    lockTimeoutMs: 3_000
  });

  try {
    const migrationResults = await Promise.all([store.migrate(), peer.migrate()]);
    assert.equal(migrationResults.flat().filter(name => name === '001_runtime_core.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '002_runtime_evidence.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '003_ticket_run_lifecycle.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '004_non_terminal_evidence.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '005_finalized_replay_append.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '006_runtime_state_reads.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '007_ticket_operator_reads.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '008_triage_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '009_operational_status.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '010_diagnostic_logs.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '011_workspace_ownership_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '012_operator_recovery_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '013_run_phase_projection.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '014_performance_analytics_reads.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '015_work_context_catalog.sql').length, 1);
    assert.deepEqual(await store.migrate(), []);
    assert.equal(migrationResults.flat().filter(name => name === '016_configured_agent_catalog.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '017_process_template_projection.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '018_process_template_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '019_access_catalog_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '020_workflow_catalog_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '021_model_routing_policy_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '022_connector_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '023_watcher_authority.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '024_runtime_limit_config.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '025_application_state_and_sessions.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '026_local_connector_objects.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '027_run_agent_integrity.sql').length, 1);
    assert.equal(migrationResults.flat().filter(name => name === '028_process_template_ticket_provenance.sql').length, 1);
    assert.equal(await store.health(), true);
    assert.equal((await store.acquireRuntimeAuthority()).mode, 'shared_transactional');
    const emptyRuntimeIntegrity = await store.prepareRuntimePersistence();
    assert.equal(emptyRuntimeIntegrity.checkedRelationCount, 41);
    assert.equal(emptyRuntimeIntegrity.checkedIntegrityArtifactCount, 199);
    assert.equal(emptyRuntimeIntegrity.integrityMode, 'transactional_constraints');

    const initialRuntimeLimits = await store.getRuntimeLimitsConfig();
    assert.equal(initialRuntimeLimits.revision, 1);
    assert.equal(initialRuntimeLimits.updatedAt, null);
    const runtimeLimitValues = {
      maxExecutionSteps: 8,
      maxModelRequestsPerRun: 6,
      maxWorkspaceOperationsPerRun: 40,
      maxRuntimeDurationMs: 30000,
      maxActiveRuns: 4096,
      localModelConcurrency: 4
    };
    const runtimeLimitUpdate = await store.updateRuntimeLimitsConfig({
      expectedRevision: 1,
      value: runtimeLimitValues,
      changedBy: 'integration-admin'
    });
    assert.equal(runtimeLimitUpdate.config.revision, 2);
    assert.equal(runtimeLimitUpdate.config.updatedBy, 'integration-admin');
    assert.equal((await peer.getRuntimeLimitsConfig()).revision, 2,
      'runtime policy must be immediately visible across processes');
    await assert.rejects(
      peer.updateRuntimeLimitsConfig({
        expectedRevision: 1,
        value: { ...runtimeLimitValues, maxExecutionSteps: 9 },
        changedBy: 'stale-admin'
      }),
      error => error instanceof RuntimeLimitsConflictError && error.current.revision === 2
    );
    const runtimeAuditBeforeRollback = await store.pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ${store.table('events')} WHERE type = 'runtime_limits.updated') AS events,
         (SELECT COUNT(*)::int FROM ${store.table('diagnostic_logs')} WHERE type = 'runtime_limits.updated') AS logs`
    );
    assert.deepEqual(runtimeAuditBeforeRollback.rows[0], { events: 1, logs: 1 });
    const appendRuntimeLimitAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected runtime-limit audit failure'); };
    try {
      await assert.rejects(
        store.updateRuntimeLimitsConfig({
          expectedRevision: 2,
          value: { ...runtimeLimitValues, maxExecutionSteps: 10 },
          changedBy: 'rollback-admin'
        }),
        /injected runtime-limit audit failure/
      );
    } finally {
      store._appendSystemLog = appendRuntimeLimitAudit;
    }
    assert.equal((await store.getRuntimeLimitsConfig()).revision, 2,
      'audit failure must roll back the policy update');
    const runtimeAuditAfterRollback = await store.pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM ${store.table('events')} WHERE type = 'runtime_limits.updated') AS events,
         (SELECT COUNT(*)::int FROM ${store.table('diagnostic_logs')} WHERE type = 'runtime_limits.updated') AS logs`
    );
    assert.deepEqual(runtimeAuditAfterRollback.rows[0], { events: 1, logs: 1 },
      'audit failure must roll back event and diagnostic evidence together');

    const legalContext = await store.createWorkContext({
      value: {
        name: 'Legal Ops',
        purpose: 'Bound legal operations',
        status: 'active',
        allowedTargetIds: [],
        allowedCapabilities: [],
        allowedProcessTemplateIds: []
      },
      changedBy: 'integration-operator'
    });
    const financeContext = await peer.createWorkContext({
      value: { name: 'Finance', purpose: 'Finance controls', status: 'archived' },
      changedBy: 'integration-peer'
    });
    assert.equal(legalContext.workContext.id > 0, true);
    assert.equal(legalContext.workContext.revision, 1);
    assert.equal(legalContext.auditLog.type, 'work_context:created');
    assert.equal(financeContext.workContext.id > legalContext.workContext.id, true);
    assert.deepEqual(await store.getWorkContextCounts(), { active: 1, archived: 1, total: 2 });
    const contextPage = await store.listWorkContexts({ limit: 1 });
    assert.deepEqual(contextPage.workContexts.map(item => item.id), [legalContext.workContext.id]);
    assert.equal(contextPage.nextAfterId, legalContext.workContext.id);
    const contextTail = await store.listWorkContexts({ afterId: contextPage.nextAfterId, limit: 1 });
    assert.deepEqual(contextTail.workContexts.map(item => item.id), [financeContext.workContext.id]);
    assert.equal((await peer.getWorkContextById(legalContext.workContext.id)).name, 'Legal Ops');

    const staleLegalContext = await peer.getWorkContextById(legalContext.workContext.id);
    const archivedLegalContext = await store.updateWorkContext({
      workContextId: legalContext.workContext.id,
      expectedRevision: legalContext.workContext.revision,
      value: {
        name: 'Legal Operations',
        purpose: 'Bound legal operations',
        status: 'archived',
        allowedTargetIds: [],
        allowedCapabilities: [],
        allowedProcessTemplateIds: []
      },
      changedBy: 'integration-operator'
    });
    assert.equal(archivedLegalContext.workContext.revision, 2);
    assert.equal(archivedLegalContext.auditLog.type, 'work_context:archived');
    await assert.rejects(
      peer.updateWorkContext({
        workContextId: staleLegalContext.id,
        expectedRevision: staleLegalContext.revision,
        value: { name: 'Stale name', status: 'active' },
        changedBy: 'stale-peer'
      }),
      error => error instanceof OptimisticConcurrencyError && error.entity === 'workContext'
    );
    const workContextLogs = await store.listLogs({
      types: ['work_context:created', 'work_context:archived'],
      order: 'asc',
      limit: 10
    });
    assert.deepEqual(workContextLogs.logs.map(log => log.type), [
      'work_context:created',
      'work_context:created',
      'work_context:archived'
    ]);

    const countsBeforeAuditRollback = await store.getWorkContextCounts();
    const appendSystemLog = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected Work Context audit failure'); };
    try {
      await assert.rejects(
        store.createWorkContext({
          value: { name: 'Must roll back', status: 'active' },
          changedBy: 'integration-operator'
        }),
        /injected Work Context audit failure/
      );
    } finally {
      store._appendSystemLog = appendSystemLog;
    }
    assert.deepEqual(await store.getWorkContextCounts(), countsBeforeAuditRollback);

    const ticketOne = await store.createTicket({
      status: 'open',
      title: 'First ticket',
      workContextId: legalContext.workContext.id,
      spawnIdempotencyKey: 'integration-spawn-key'
    });
    assert.equal((await store.getTicketBySpawnIdempotencyKey('integration-spawn-key')).id, ticketOne.id);
    assert.deepEqual(
      (await store.getTicketsBySpawnIdempotencyKeys({
        spawnIdempotencyKeys: ['missing-spawn-key', 'integration-spawn-key']
      })).map(ticket => ticket.id),
      [ticketOne.id]
    );
    assert.deepEqual(await store.getWorkContextTicketCountsByIds({
      workContextIds: [legalContext.workContext.id, financeContext.workContext.id]
    }), [{
      workContextId: legalContext.workContext.id,
      ticketCount: 1,
      openTicketCount: 1,
      blockedTicketCount: 0,
      unresolvedTriageCount: 0
    }]);
    const initialContextRuntimeSummary = await store.getWorkContextRuntimeSummary({
      workContextId: legalContext.workContext.id,
      limit: 10
    });
    assert.equal(initialContextRuntimeSummary.counts.ticketCount, 1);
    assert.equal(initialContextRuntimeSummary.counts.runCount, 0);
    assert.deepEqual(initialContextRuntimeSummary.recentTickets.map(ticket => ticket.id), [ticketOne.id]);
    const legalTemplateCreated = await store.createProcessTemplate({
      value: {
        name: 'Legal Review',
        enabled: true,
        workContextId: legalContext.workContext.id,
        ticketTemplate: {
          objective: 'Review legal request',
          assignmentTargetType: 'agent',
          assignmentTargetId: 1
        }
      },
      changedBy: 'integration-operator'
    });
    const financeTemplateCreated = await peer.createProcessTemplate({
      value: {
        name: 'Finance Review',
        enabled: false,
        workContextId: financeContext.workContext.id,
        ticketTemplate: { objective: 'Review finance request' }
      },
      changedBy: 'integration-operator'
    });
    const legalScheduled = await store.setProcessTemplateSchedule({
      templateId: legalTemplateCreated.template.id,
      enabled: true,
      everySeconds: 3600,
      changedBy: 'integration-operator'
    });
    const legalTemplateRow = { id: legalScheduled.template.id };
    const financeTemplateRow = { id: financeTemplateCreated.template.id };
    assert.equal(legalTemplateCreated.version.status, 'active');
    assert.equal(legalScheduled.template.schedule.enabled, true);

    const processTemplateTicket = await store.withTransaction(async client => {
      const ticket = await store.createTicket({
        status: 'blocked',
        title: 'Generated legal review',
        source: {
          type: 'process_template',
          templateId: legalTemplateRow.id,
          templateVersion: 1,
          triggerType: 'manual',
          triggerToken: 'integration-process-template-trigger',
          createdAt: '2026-07-18T12:00:00.000Z'
        },
        triage: { required: true, reasonCode: 'authority_blocked' }
      }, { client });
      await client.query(
        `INSERT INTO ${store.table('process_template_triggers')}
           (trigger_token, template_id, template_version, ticket_id, trigger_type, triggered_by, body)
         VALUES ($1, $2, 1, $3, 'manual', $4, $5::jsonb)`,
        [
          'integration-process-template-trigger',
          legalTemplateRow.id,
          ticket.id,
          'integration-operator',
          { source: 'integration' }
        ]
      );
      return ticket;
    });

    const processTemplatePage = await store.listProcessTemplateStates({
      limit: 1,
      now: '2026-07-18T12:00:00.000Z'
    });
    assert.deepEqual(processTemplatePage.processTemplates.map(item => item.id), [Number(legalTemplateRow.id)]);
    assert.equal(processTemplatePage.nextAfterId, Number(legalTemplateRow.id));
    assert.equal(processTemplatePage.processTemplates[0].healthStatus, 'attention_needed');
    assert.equal(processTemplatePage.processTemplates[0].dueStatus, 'not_due');
    assert.deepEqual(processTemplatePage.processTemplates[0].generatedTicketCounts, {
      total: 1,
      blocked: 1,
      triaged: 1,
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0
    });
    const financeTemplateState = await peer.getProcessTemplateStateById(financeTemplateRow.id, {
      now: '2026-07-18T12:00:00.000Z'
    });
    assert.equal(financeTemplateState.healthStatus, 'disabled');
    assert.equal(financeTemplateState.dueStatus, 'template_disabled');
    assert.deepEqual(await store.getProcessTemplateCounts(), {
      total: 2,
      enabled: 1,
      disabled: 1,
      scheduled: 1,
      pausedSchedule: 0
    });
    assert.deepEqual(
      await store.getProcessTemplateCountsByWorkContextIds({
        workContextIds: [financeContext.workContext.id, legalContext.workContext.id]
      }),
      [
        {
          workContextId: financeContext.workContext.id,
          processTemplateCount: 1,
          scheduledTemplateCount: 0
        },
        {
          workContextId: legalContext.workContext.id,
          processTemplateCount: 1,
          scheduledTemplateCount: 1
        }
      ]
    );
    const processTemplateProvenance = await peer.getProcessTemplateTriggerProvenance({
      ticketId: processTemplateTicket.id
    });
    assert.equal(processTemplateProvenance.triggerToken, 'integration-process-template-trigger');
    assert.equal(
      (await store.getProcessTemplateTriggerProvenance({
        triggerToken: 'integration-process-template-trigger'
      })).ticketId,
      processTemplateTicket.id
    );
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('process_template_versions')} SET name = 'Mutated' WHERE id = '${legalTemplateCreated.version.id}'`
      ),
      /version content is immutable/
    );
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('process_template_versions')}
         SET activated_by = 'different-operator'
         WHERE id = '${legalTemplateCreated.version.id}'`
      ),
      /activation provenance is immutable/
    );
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('process_template_versions')}
         SET status = 'draft'
         WHERE id = '${legalTemplateCreated.version.id}'`
      ),
      /invalid process-template version status transition/
    );
    await assert.rejects(
      store.pool.query(
        `DELETE FROM ${store.table('process_template_triggers')} WHERE trigger_token = $1`,
        ['integration-process-template-trigger']
      ),
      /append-only/
    );


    const concurrentTemplate = await store.createProcessTemplate({
      value: {
        name: 'Concurrent Template',
        enabled: true,
        ticketTemplate: {
          objective: 'Create one concurrent ticket',
          assignmentTargetType: 'agent',
          assignmentTargetId: 1,
          capabilityType: 'directAction'
        }
      },
      changedBy: 'integration-operator'
    });
    const createTriggeredTicket = runtimeStore => async ({ template, source, spawnIdempotencyKey, persistence }) => {
      const created = await runtimeStore.createTicketWithEvent({
        ticket: {
          status: 'open',
          objective: template.ticketTemplate.objective,
          assignmentTargetType: 'agent',
          assignmentTargetId: 1,
          source,
          spawnIdempotencyKey
        },
        eventPayload: { source: 'process_template' }
      }, persistence);
      return { ok: true, ticket: created.ticket, created: created.created };
    };
    const concurrentToken = 'integration-concurrent-template-token';
    const concurrentTriggers = await Promise.all([
      store.executeProcessTemplateTrigger({
        templateId: concurrentTemplate.template.id,
        triggerToken: concurrentToken,
        triggerType: 'manual',
        triggeredBy: 'integration-operator',
        createTicket: createTriggeredTicket(store)
      }),
      peer.executeProcessTemplateTrigger({
        templateId: concurrentTemplate.template.id,
        triggerToken: concurrentToken,
        triggerType: 'manual',
        triggeredBy: 'integration-peer',
        createTicket: createTriggeredTicket(peer)
      })
    ]);
    assert.equal(new Set(concurrentTriggers.map(result => result.ticket.id)).size, 1);
    assert.equal(concurrentTriggers.filter(result => result.deduped === false).length, 1);
    const concurrentLedgerCount = await store.pool.query(
      `SELECT COUNT(*)::bigint AS count FROM ${store.table('process_template_triggers')} WHERE trigger_token = $1`,
      [concurrentToken]
    );
    assert.equal(Number(concurrentLedgerCount.rows[0].count), 1);
    assert.equal((await store.listDueProcessTemplates({ dueAt: new Date(), limit: 10 })).length, 0);
    assert.deepEqual(await store.reconcileProcessTemplateVersions(), { repairedCount: 0 });

    const accessBootstrap = await store.ensureBootstrapAccess({
      passwordHash: 'integration-password-hash',
      changedBy: 'integration-bootstrap'
    });
    assert.equal(accessBootstrap.changed, true);
    assert.equal(accessBootstrap.adminUser.username, 'admin');
    assert.deepEqual(accessBootstrap.adminGroup.permissions, [...BUILTIN_PERMISSIONS].sort(compareCatalogNames));
    assert.equal((await peer.ensureBootstrapAccess({
      passwordHash: 'ignored-after-bootstrap',
      changedBy: 'integration-peer'
    })).changed, false);
    const accessGroups = (await store.listGroups({ limit: 10 })).groups;
    const administratorGroupId = accessGroups.find(group => group.name === 'Administrators').id;
    const agentSupportGroupId = accessGroups.find(group => group.name === 'Agent Support').id;
    const reviewGroup = await store.createGroup({
      value: { name: 'Integration Reviewers', permissions: ['ticket:read'], canReceiveTickets: true },
      changedBy: 'integration-operator'
    });
    assert.equal(reviewGroup.group.revision, 1);
    assert.equal(reviewGroup.auditLog.type, 'admin:group_create');
    const accessUser = await store.createUser({
      value: { username: 'integration-reviewer', passwordHash: 'integration-user-hash' },
      groupIds: [reviewGroup.group.id],
      changedBy: 'integration-operator'
    });
    assert.deepEqual((await peer.getUserAuthorization(accessUser.user.id)).permissions, ['ticket:read']);
    const staleAccessUser = await peer.getUserById(accessUser.user.id);
    const updatedAccessUser = await store.updateUser({
      userId: accessUser.user.id,
      expectedRevision: accessUser.user.revision,
      value: { ...accessUser.user, username: 'integration-review-lead' },
      groupIds: [administratorGroupId, reviewGroup.group.id],
      changedBy: 'integration-operator'
    });
    assert.equal(updatedAccessUser.user.revision, 2);
    await assert.rejects(
      peer.updateUser({
        userId: staleAccessUser.id,
        expectedRevision: staleAccessUser.revision,
        value: staleAccessUser,
        groupIds: staleAccessUser.groupIds,
        changedBy: 'stale-peer'
      }),
      error => error instanceof OptimisticConcurrencyError && error.entity === 'user'
    );
    const appendAccessAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected access-catalog audit failure'); };
    try {
      await assert.rejects(
        store.createGroup({
          value: { name: 'Must Roll Back Access Group', permissions: ['ticket:read'] },
          changedBy: 'integration-operator'
        }),
        /injected access-catalog audit failure/
      );
    } finally {
      store._appendSystemLog = appendAccessAudit;
    }
    assert.equal((await store.listGroups({ limit: 20 })).groups.some(group => group.name === 'Must Roll Back Access Group'), false);

    const assignmentRaceGroup = await store.createGroup({
      value: { name: 'Assignment Race', permissions: [], canReceiveTickets: true },
      changedBy: 'integration-operator'
    });
    const assignmentRace = await Promise.allSettled([
      store.createTicketWithEvent({
        ticket: {
          status: 'open',
          title: 'Group assignment race',
          assignmentTargetType: 'group',
          assignmentTargetId: assignmentRaceGroup.group.id
        }
      }),
      peer.updateGroup({
        groupId: assignmentRaceGroup.group.id,
        expectedRevision: assignmentRaceGroup.group.revision,
        value: { ...assignmentRaceGroup.group, canReceiveTickets: false },
        changedBy: 'integration-peer'
      })
    ]);
    assert.equal(assignmentRace.filter(result => result.status === 'fulfilled').length, 1,
      'ticket assignment and disabling its group must serialize to one valid winner');
    const assignmentRaceGroupAfter = await store.getGroupById(assignmentRaceGroup.group.id);
    if (assignmentRace[0].status === 'fulfilled') {
      assert.equal(assignmentRaceGroupAfter.canReceiveTickets, true);
      assert.equal(assignmentRace[1].reason.code, 'GROUP_HAS_ASSIGNED_TICKETS');
    } else {
      assert.equal(assignmentRaceGroupAfter.canReceiveTickets, false);
      assert.equal(assignmentRace[0].reason.code, 'GROUP_NOT_TICKET_CAPABLE');
    }

    const workflowDefinition = (id, options = {}) => ({
      id,
      name: options.name || `Integration ${id}`,
      description: '',
      version: '1',
      enabled: options.enabled !== false,
      inputSchema: {},
      actions: [{ id: 'done', action: 'stop', input: {} }],
      postconditions: []
    });
    const workflowDefaults = await store.ensureDefaultWorkflows({
      definitions: [workflowDefinition('integration-default-a'), workflowDefinition('integration-default-b')],
      changedBy: 'integration-bootstrap'
    });
    assert.deepEqual(workflowDefaults.createdWorkflowIds, ['integration-default-a', 'integration-default-b']);
    assert.equal((await peer.ensureDefaultWorkflows({
      definitions: [workflowDefinition('integration-default-a')],
      changedBy: 'integration-peer'
    })).changed, false);
    const workflowCreated = await store.createWorkflow({
      value: workflowDefinition('integration-workflow'),
      changedBy: 'integration-operator',
      audit: {
        type: 'admin:workflow_create',
        message: 'Integration workflow created',
        metadata: { workflowId: 'integration-workflow', changedBy: 'integration-operator' }
      }
    });
    assert.equal(workflowCreated.workflow.revision, 1);
    assert.equal(workflowCreated.auditLog.type, 'admin:workflow_create');
    assert.equal((await peer.getWorkflowById('integration-workflow')).name, 'Integration integration-workflow');
    assert.deepEqual(
      (await store.getWorkflowsByIds({ workflowIds: ['integration-workflow', 'integration-default-a'] })).map(item => item.id),
      ['integration-default-a', 'integration-workflow']
    );
    const workflowPage = await store.listWorkflows({ afterId: 'integration-default-b', limit: 10 });
    assert.equal(workflowPage.workflows.some(item => item.id === 'integration-workflow'), true);

    const workflowUpdates = await Promise.allSettled([
      store.updateWorkflow({
        workflowId: workflowCreated.workflow.id,
        expectedRevision: workflowCreated.workflow.revision,
        value: workflowDefinition('integration-workflow', { name: 'Integration winner one' }),
        changedBy: 'integration-operator'
      }),
      peer.updateWorkflow({
        workflowId: workflowCreated.workflow.id,
        expectedRevision: workflowCreated.workflow.revision,
        value: workflowDefinition('integration-workflow', { name: 'Integration winner two' }),
        changedBy: 'integration-peer'
      })
    ]);
    assert.equal(workflowUpdates.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(workflowUpdates.filter(item => item.status === 'rejected' &&
      item.reason instanceof OptimisticConcurrencyError && item.reason.entity === 'workflow').length, 1);

    const appendWorkflowAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected workflow audit failure'); };
    try {
      await assert.rejects(
        store.createWorkflow({
          value: workflowDefinition('must-roll-back-workflow'),
          changedBy: 'integration-operator',
          audit: { type: 'admin:workflow_create', message: 'rollback', metadata: {} }
        }),
        /injected workflow audit failure/
      );
    } finally {
      store._appendSystemLog = appendWorkflowAudit;
    }
    assert.equal(await store.getWorkflowById('must-roll-back-workflow'), null);

    const appendWorkflowEvidence = store.appendRunEvidence;
    store.appendRunEvidence = async () => { throw new Error('injected workflow evidence failure'); };
    try {
      await assert.rejects(
        store.createWorkflowWithEvidence({
          value: workflowDefinition('must-roll-back-workflow-evidence'),
          changedBy: 'agent:1',
          evidence: { runId: 1, ticketId: 1, evidenceKey: 'workflow-draft:rollback' }
        }),
        /injected workflow evidence failure/
      );
    } finally {
      store.appendRunEvidence = appendWorkflowEvidence;
    }
    assert.equal(await store.getWorkflowById('must-roll-back-workflow-evidence'), null);

    const disabledWorkflow = await store.createWorkflow({
      value: workflowDefinition('integration-disabled-workflow', { enabled: false }),
      changedBy: 'integration-operator'
    });
    await assert.rejects(
      store.createTicketWithEvent({
        ticket: {
          status: 'open', objective: 'disabled workflow ticket', assignmentTargetType: 'agent', assignmentTargetId: 1,
          executionMode: 'workflow', capabilityType: 'workflow', workflowId: disabledWorkflow.workflow.id
        },
        eventPayload: {}
      }),
      error => error && error.code === 'WORKFLOW_DISABLED'
    );
    await assert.rejects(
      store.createTicketWithEvent({
        ticket: {
          status: 'open', objective: 'missing workflow ticket', assignmentTargetType: 'agent', assignmentTargetId: 1,
          executionMode: 'workflow', capabilityType: 'workflow', workflowId: 'missing-workflow'
        },
        eventPayload: {}
      }),
      error => error && error.code === 'WORKFLOW_NOT_FOUND'
    );
    const enabledWorkflow = await store.createWorkflow({
      value: workflowDefinition('integration-enabled-workflow'),
      changedBy: 'integration-operator'
    });
    const workflowTicket = await store.createTicketWithEvent({
      ticket: {
        status: 'open', objective: 'enabled workflow ticket', assignmentTargetType: 'agent', assignmentTargetId: 1,
        executionMode: 'workflow', capabilityType: 'workflow', workflowId: enabledWorkflow.workflow.id
      },
      eventPayload: {}
    });
    const workflowTicketRelation = await store.pool.query(
      `SELECT workflow_definition_id FROM ${store.table('tickets')} WHERE id = $1`,
      [workflowTicket.ticket.id]
    );
    assert.equal(workflowTicketRelation.rows[0].workflow_definition_id, enabledWorkflow.workflow.id);

    const routingPolicyValue = (name, options = {}) => ({
      name,
      status: options.status || 'active',
      workContextId: options.workContextId === undefined ? null : options.workContextId,
      capabilityId: options.capabilityId === undefined ? null : options.capabilityId,
      allowedProviders: ['openai'],
      preferredProvider: 'openai',
      preferredModel: 'gpt-integration',
      fallbackProviders: [],
      maxCost: null,
      maxLatency: null,
      riskClass: 'standard',
      toolRequirements: [],
      targetRequirements: [],
      verificationRequirement: null,
      triageOnNoRoute: true
    });
    const globalRoutingPolicy = await store.createModelRoutingPolicy({
      value: routingPolicyValue('Integration global routing'),
      changedBy: 'integration-operator',
      audit: { type: 'model_routing:policy_created', message: 'Global routing created', metadata: {} }
    });
    const contextualRoutingPolicy = await peer.createModelRoutingPolicy({
      value: routingPolicyValue('Integration contextual routing', {
        workContextId: legalContext.workContext.id,
        capabilityId: 'agent-selected-actions'
      }),
      changedBy: 'integration-peer'
    });
    assert.equal(globalRoutingPolicy.policy.revision, 1);
    assert.equal(globalRoutingPolicy.auditLog.policyId, globalRoutingPolicy.policy.id);
    assert.deepEqual(await store.getModelRoutingPolicyCounts(), { active: 2, archived: 0, total: 2 });
    const routingPage = await store.listModelRoutingPolicies({ limit: 1 });
    assert.deepEqual(routingPage.policies.map(item => item.id), [globalRoutingPolicy.policy.id]);
    assert.equal(routingPage.nextAfterId, globalRoutingPolicy.policy.id);
    assert.equal((await peer.getModelRoutingPolicyById(contextualRoutingPolicy.policy.id)).name,
      'Integration contextual routing');
    const explicitRoute = await store.findApplicableModelRoutingPolicy({
      explicitPolicyId: globalRoutingPolicy.policy.id,
      workContextId: legalContext.workContext.id,
      capabilityId: 'agent-selected-actions'
    });
    assert.equal(explicitRoute.reason, 'explicit_override');
    assert.equal(explicitRoute.policy.id, globalRoutingPolicy.policy.id);
    const contextualRoute = await store.findApplicableModelRoutingPolicy({
      workContextId: legalContext.workContext.id,
      capabilityId: 'agent-selected-actions'
    });
    assert.equal(contextualRoute.reason, 'policy_preferred');
    assert.equal(contextualRoute.policy.id, contextualRoutingPolicy.policy.id);

    const routingUpdates = await Promise.allSettled([
      store.updateModelRoutingPolicy({
        policyId: contextualRoutingPolicy.policy.id,
        expectedRevision: contextualRoutingPolicy.policy.revision,
        value: routingPolicyValue('Integration routing winner one', {
          workContextId: legalContext.workContext.id,
          capabilityId: 'agent-selected-actions'
        }),
        changedBy: 'integration-operator'
      }),
      peer.updateModelRoutingPolicy({
        policyId: contextualRoutingPolicy.policy.id,
        expectedRevision: contextualRoutingPolicy.policy.revision,
        value: routingPolicyValue('Integration routing winner two', {
          workContextId: legalContext.workContext.id,
          capabilityId: 'agent-selected-actions'
        }),
        changedBy: 'integration-peer'
      })
    ]);
    assert.equal(routingUpdates.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(routingUpdates.filter(item => item.status === 'rejected' &&
      item.reason instanceof OptimisticConcurrencyError && item.reason.entity === 'modelRoutingPolicy').length, 1);

    const routingCountsBeforeRollback = await store.getModelRoutingPolicyCounts();
    const appendRoutingAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected routing audit failure'); };
    try {
      await assert.rejects(
        store.createModelRoutingPolicy({
          value: routingPolicyValue('Must roll back routing'),
          changedBy: 'integration-operator',
          audit: { type: 'model_routing:policy_created', message: 'rollback', metadata: {} }
        }),
        /injected routing audit failure/
      );
    } finally {
      store._appendSystemLog = appendRoutingAudit;
    }
    assert.deepEqual(await store.getModelRoutingPolicyCounts(), routingCountsBeforeRollback);
    await assert.rejects(
      store.createModelRoutingPolicy({
        value: routingPolicyValue('Missing context routing', { workContextId: 999999999 }),
        changedBy: 'integration-operator'
      }),
      error => error && error.code === 'WORK_CONTEXT_NOT_FOUND'
    );
    await assert.rejects(
      store.createTicketWithEvent({
        ticket: { status: 'open', objective: 'missing routing policy', routingPolicyId: 999999999 },
        eventPayload: {}
      }),
      error => error && error.code === 'MODEL_ROUTING_POLICY_NOT_FOUND'
    );
    const routingTicket = await store.createTicketWithEvent({
      ticket: {
        status: 'open',
        objective: 'valid routing policy',
        routingPolicyId: globalRoutingPolicy.policy.id
      },
      eventPayload: {}
    });
    const routingTicketRelation = await store.pool.query(
      `SELECT routing_policy_id FROM ${store.table('tickets')} WHERE id = $1`,
      [routingTicket.ticket.id]
    );
    assert.equal(Number(routingTicketRelation.rows[0].routing_policy_id), globalRoutingPolicy.policy.id);

    await store.updateWorkContext({
      workContextId: legalContext.workContext.id,
      expectedRevision: archivedLegalContext.workContext.revision,
      value: {
        name: 'Legal Operations', purpose: 'Bound legal operations', status: 'active',
        allowedTargetIds: [], allowedCapabilities: [], allowedProcessTemplateIds: []
      },
      changedBy: 'integration-operator'
    });

    const connectorValue = (name, options = {}) => ({
      name,
      status: options.status || 'active',
      kind: 'local_mock',
      workContextId: options.workContextId || legalContext.workContext.id,
      credentialRef: null,
      allowedScopes: ['read'],
      sourceRoots: ['inbox'],
      targetRoots: [],
      readPolicy: { mode: 'bounded' },
      writePolicy: { mode: 'disabled' },
      receiptPolicy: { mode: 'required' },
      syncPolicy: { mode: 'manual' }
    });
    const connectorReceiptValue = (connector, operation = 'read') => ({
      connectorId: connector.id,
      workContextId: connector.workContextId,
      operation,
      sourceRef: 'inbox/item.txt',
      targetRef: null,
      externalObjectId: 'inbox/item.txt',
      ticketId: null,
      runId: null,
      actor: 'integration-operator',
      request: { bounded: true },
      result: operation === 'read'
        ? { status: 'ok', bytes: 4, hash: 'a'.repeat(64) }
        : { status: 'refused', reason: 'policy' },
      error: operation === 'read' ? null : 'policy'
    });
    const primaryConnector = await store.createConnector({
      value: connectorValue('Integration connector'),
      changedBy: 'integration-operator',
      audit: { type: 'connector:created', message: 'Connector created', metadata: {} }
    });
    const pausedConnector = await peer.createConnector({
      value: connectorValue('Integration paused connector', { status: 'paused' }),
      changedBy: 'integration-peer'
    });
    assert.equal(primaryConnector.connector.revision, 1);
    assert.equal(primaryConnector.auditLog.connectorId, primaryConnector.connector.id);
    const connectorPage = await store.listConnectors({ limit: 1 });
    assert.deepEqual(connectorPage.connectors.map(item => item.id), [primaryConnector.connector.id]);
    assert.equal(connectorPage.nextAfterId, primaryConnector.connector.id);
    assert.deepEqual(
      (await peer.listConnectors({ afterId: connectorPage.nextAfterId, statuses: ['paused'], limit: 1 }))
        .connectors.map(item => item.id),
      [pausedConnector.connector.id]
    );
    assert.equal((await peer.getConnectorById(primaryConnector.connector.id)).name, 'Integration connector');

    const connectorUpdates = await Promise.allSettled([
      store.updateConnector({
        connectorId: primaryConnector.connector.id,
        expectedRevision: primaryConnector.connector.revision,
        value: connectorValue('Integration connector winner one'),
        changedBy: 'integration-operator'
      }),
      peer.updateConnector({
        connectorId: primaryConnector.connector.id,
        expectedRevision: primaryConnector.connector.revision,
        value: connectorValue('Integration connector winner two'),
        changedBy: 'integration-peer'
      })
    ]);
    assert.equal(connectorUpdates.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(connectorUpdates.filter(item => item.status === 'rejected' &&
      item.reason instanceof OptimisticConcurrencyError && item.reason.entity === 'connector').length, 1);
    const currentConnector = await store.getConnectorById(primaryConnector.connector.id);

    const readReceipt = await store.appendConnectorReceipt({
      value: connectorReceiptValue(currentConnector),
      audit: { type: 'connector:read', message: 'Connector read', metadata: {} }
    });
    const refusedReceipt = await peer.appendConnectorReceipt({
      value: connectorReceiptValue(currentConnector, 'write_refused')
    });
    assert.equal(readReceipt.auditLog.receiptId, readReceipt.receipt.id);
    const connectorReceiptPage = await store.listConnectorReceipts({
      connectorId: currentConnector.id,
      limit: 1
    });
    assert.deepEqual(connectorReceiptPage.receipts.map(item => item.id), [refusedReceipt.receipt.id]);
    assert.equal(connectorReceiptPage.nextBeforeId, refusedReceipt.receipt.id);
    assert.deepEqual(
      (await store.listConnectorReceipts({
        connectorId: currentConnector.id,
        beforeId: connectorReceiptPage.nextBeforeId,
        limit: 1
      })).receipts.map(item => item.id),
      [readReceipt.receipt.id]
    );
    const connectorSummary = await store.getConnectorOperationalSummary({ limit: 1 });
    assert.deepEqual(
      { active: connectorSummary.active, paused: connectorSummary.paused, archived: connectorSummary.archived, total: connectorSummary.total },
      { active: 1, paused: 1, archived: 0, total: 2 }
    );
    assert.equal(connectorSummary.recentRefusals[0].id, refusedReceipt.receipt.id);

    const archivedConnector = await peer.updateConnector({
      connectorId: pausedConnector.connector.id,
      expectedRevision: pausedConnector.connector.revision,
      value: connectorValue('Integration archived connector', { status: 'archived' }),
      changedBy: 'integration-peer'
    });
    assert.equal(archivedConnector.connector.revision, 2);
    const transitionedConnectorSummary = await store.getConnectorOperationalSummary({ limit: 1 });
    assert.deepEqual(
      {
        active: transitionedConnectorSummary.active,
        paused: transitionedConnectorSummary.paused,
        archived: transitionedConnectorSummary.archived,
        total: transitionedConnectorSummary.total
      },
      { active: 1, paused: 0, archived: 1, total: 2 }
    );

    const receiptCountBeforeRollback = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('connector_receipts')}`
    );
    const appendConnectorAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected connector audit failure'); };
    try {
      await assert.rejects(
        store.appendConnectorReceipt({
          value: connectorReceiptValue(currentConnector, 'read_refused'),
          audit: { type: 'connector:read_refused', message: 'rollback', metadata: {} }
        }),
        /injected connector audit failure/
      );
    } finally {
      store._appendSystemLog = appendConnectorAudit;
    }
    const receiptCountAfterRollback = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('connector_receipts')}`
    );
    assert.equal(receiptCountAfterRollback.rows[0].count, receiptCountBeforeRollback.rows[0].count);
    await assert.rejects(
      store.createConnector({
        value: connectorValue('Inactive context connector', { workContextId: financeContext.workContext.id }),
        changedBy: 'integration-operator'
      }),
      error => error && error.code === 'WORK_CONTEXT_NOT_ACTIVE'
    );
    await assert.rejects(
      store.appendConnectorReceipt({
        value: { ...connectorReceiptValue(currentConnector), workContextId: financeContext.workContext.id }
      }),
      error => error && error.code === 'CONNECTOR_WORK_CONTEXT_MISMATCH'
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('connector_receipts')} SET result_status = 'failed' WHERE id = $1`, [readReceipt.receipt.id]),
      /append-only/i
    );

    const authorityContext = await store.createWorkContext({
      value: { name: 'Authority integration', purpose: 'Active catalog authority tests', status: 'active' },
      changedBy: 'integration-operator'
    });

    const watcherValue = (name, options = {}) => ({
      name,
      status: options.status || 'active',
      workContextId: options.workContextId || authorityContext.workContext.id,
      sourceKind: 'workspace_file',
      sourceRefs: [{ path: 'inbox/item.txt' }],
      cadence: { mode: 'manual' },
      triggerPolicy: { mode: 'manual' },
      deltaPolicy: { mode: 'hash' },
      actionPolicy: { allowedActions: ['summarize', 'propose_ticket'] },
      triagePolicy: { mode: 'manual' },
      ticketProposalPolicy: { enabled: true },
      notificationPolicy: { mode: 'none' }
    });
    const primaryWatcher = await store.createWatcher({
      value: watcherValue('Integration watcher'),
      changedBy: 'integration-operator',
      audit: { type: 'watcher:created', message: 'Watcher created', metadata: {} }
    });
    const pausedWatcher = await peer.createWatcher({
      value: watcherValue('Integration paused watcher', { status: 'paused' }),
      changedBy: 'integration-peer'
    });
    assert.equal(primaryWatcher.watcher.revision, 1);
    assert.equal(primaryWatcher.auditLog.watcherId, primaryWatcher.watcher.id);
    const watcherPage = await store.listWatchers({ limit: 1 });
    assert.deepEqual(watcherPage.watchers.map(item => item.id), [primaryWatcher.watcher.id]);
    assert.equal(watcherPage.nextAfterId, primaryWatcher.watcher.id);
    assert.deepEqual(
      (await peer.listWatchers({ afterId: watcherPage.nextAfterId, statuses: ['paused'], limit: 1 })).watchers.map(item => item.id),
      [pausedWatcher.watcher.id]
    );

    const watcherUpdates = await Promise.allSettled([
      store.updateWatcher({
        watcherId: primaryWatcher.watcher.id,
        expectedRevision: primaryWatcher.watcher.revision,
        value: watcherValue('Integration watcher winner one'),
        changedBy: 'integration-operator'
      }),
      peer.updateWatcher({
        watcherId: primaryWatcher.watcher.id,
        expectedRevision: primaryWatcher.watcher.revision,
        value: watcherValue('Integration watcher winner two'),
        changedBy: 'integration-peer'
      })
    ]);
    assert.equal(watcherUpdates.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(watcherUpdates.filter(item => item.status === 'rejected' &&
      item.reason instanceof OptimisticConcurrencyError && item.reason.entity === 'watcher').length, 1);
    const currentWatcher = await store.getWatcherById(primaryWatcher.watcher.id);
    const observation = await store.recordWatcherObservation({
      watcherId: currentWatcher.id,
      expectedRevision: currentWatcher.revision,
      value: {
        watcherId: currentWatcher.id,
        workContextId: currentWatcher.workContextId,
        status: 'changed',
        sourceKind: currentWatcher.sourceKind,
        sourceRefs: currentWatcher.sourceRefs,
        previousHash: null,
        currentHash: 'a'.repeat(64),
        summary: { bytes: 4, lineCount: 1 },
        actionTaken: 'summarized',
        ticketProposalId: null,
        error: null
      },
      changedBy: 'integration-operator',
      advanceCursor: true,
      audit: { type: 'watcher:observed', message: 'Watcher observed', metadata: {} }
    });
    assert.equal(observation.watcher.revision, currentWatcher.revision + 1);
    assert.equal(observation.watcher.lastObservationHash, 'a'.repeat(64));
    assert.equal(observation.auditLog.observationId, observation.observation.id);
    const failedObservation = await peer.recordWatcherObservation({
      watcherId: observation.watcher.id,
      expectedRevision: observation.watcher.revision,
      value: {
        watcherId: observation.watcher.id,
        workContextId: observation.watcher.workContextId,
        status: 'failed',
        sourceKind: observation.watcher.sourceKind,
        sourceRefs: observation.watcher.sourceRefs,
        previousHash: observation.watcher.lastObservationHash,
        currentHash: null,
        summary: null,
        actionTaken: null,
        ticketProposalId: null,
        error: 'source unavailable'
      },
      changedBy: 'integration-peer',
      advanceCursor: true
    });
    const observationPage = await store.listWatcherObservations({ watcherId: currentWatcher.id, limit: 1 });
    assert.deepEqual(observationPage.observations.map(item => item.id), [failedObservation.observation.id]);
    assert.equal(observationPage.nextBeforeId, failedObservation.observation.id);

    const proposalDraft = await store.createWatcherProposal({
      watcherId: currentWatcher.id,
      value: {
        watcherId: currentWatcher.id,
        workContextId: currentWatcher.workContextId,
        observationId: observation.observation.id,
        objective: 'Triage the bounded intake',
        sourceRefs: currentWatcher.sourceRefs,
        evidenceRefs: [`watcher-observation:${observation.observation.id}`],
        constraints: 'read-only intake',
        authorityLimits: null,
        stopCondition: 'stop when triage is complete',
        receiptExpectation: 'work_receipt'
      },
      changedBy: 'integration-operator',
      audit: { type: 'watcher:proposal_created', message: 'Proposal drafted', metadata: {} }
    });
    assert.equal(proposalDraft.proposal.status, 'proposed');
    const approved = await store.approveWatcherProposal({
      proposalId: proposalDraft.proposal.id,
      changedBy: 'integration-approver',
      createTicket: async ({ proposal, source, persistence }) => {
        const created = await store.createTicketWithEvent({
          ticket: {
            status: 'open',
            objective: proposal.objective,
            assignmentTargetType: 'agent',
            assignmentTargetId: 1,
            workContextId: proposal.workContextId,
            source
          },
          eventPayload: { source: 'watcher_proposal' }
        }, persistence);
        return { ok: true, ticket: created.ticket, created: created.created };
      }
    });
    assert.equal(approved.proposal.status, 'approved');
    assert.equal(approved.proposal.createdTicketId, approved.ticket.id);
    assert.equal(approved.ticket.source.proposalId, proposalDraft.proposal.id);
    const approvalEvents = await store.listTicketEvents(approved.ticket.id, { limit: 10 });
    assert.deepEqual(approvalEvents.events.map(item => item.type), ['ticket.created', 'watcher.proposal_approved']);
    await assert.rejects(
      peer.approveWatcherProposal({ proposalId: proposalDraft.proposal.id, changedBy: 'again', createTicket: async () => null }),
      error => error && error.code === 'WATCHER_PROPOSAL_NOT_PROPOSED'
    );

    const rollbackDraft = await store.createWatcherProposal({
      watcherId: currentWatcher.id,
      value: {
        watcherId: currentWatcher.id,
        workContextId: currentWatcher.workContextId,
        observationId: null,
        objective: 'Must roll back',
        sourceRefs: currentWatcher.sourceRefs,
        evidenceRefs: [],
        constraints: null,
        authorityLimits: null,
        stopCondition: null,
        receiptExpectation: 'work_receipt'
      },
      changedBy: 'integration-operator'
    });
    const ticketCountBeforeWatcherRollback = await store.pool.query(`SELECT count(*)::int AS count FROM ${store.table('tickets')}`);
    const eventCountBeforeWatcherRollback = await store.pool.query(`SELECT count(*)::int AS count FROM ${store.table('events')}`);
    const appendWatcherAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected watcher approval audit failure'); };
    try {
      await assert.rejects(
        store.approveWatcherProposal({
          proposalId: rollbackDraft.proposal.id,
          changedBy: 'integration-approver',
          createTicket: async ({ proposal, source, persistence }) => {
            const created = await store.createTicketWithEvent({
              ticket: { status: 'open', objective: proposal.objective, workContextId: proposal.workContextId, source },
              eventPayload: { source: 'watcher_proposal' }
            }, persistence);
            return { ok: true, ticket: created.ticket };
          }
        }),
        /injected watcher approval audit failure/
      );
    } finally {
      store._appendSystemLog = appendWatcherAudit;
    }
    assert.equal((await store.getWatcherProposalById(rollbackDraft.proposal.id)).status, 'proposed');
    assert.equal((await store.pool.query(`SELECT count(*)::int AS count FROM ${store.table('tickets')}`)).rows[0].count, ticketCountBeforeWatcherRollback.rows[0].count);
    assert.equal((await store.pool.query(`SELECT count(*)::int AS count FROM ${store.table('events')}`)).rows[0].count, eventCountBeforeWatcherRollback.rows[0].count);
    await store.rejectWatcherProposal({
      proposalId: rollbackDraft.proposal.id,
      changedBy: 'integration-reviewer',
      audit: { type: 'watcher:proposal_rejected', message: 'Proposal rejected', metadata: {} }
    });
    assert.equal((await store.getWatcherProposalById(rollbackDraft.proposal.id)).status, 'rejected');

    const archivedWatcher = await peer.updateWatcher({
      watcherId: pausedWatcher.watcher.id,
      expectedRevision: pausedWatcher.watcher.revision,
      value: watcherValue('Integration archived watcher', { status: 'archived' }),
      changedBy: 'integration-peer'
    });
    assert.equal(archivedWatcher.watcher.revision, 2);
    const watcherSummary = await store.getWatcherOperationalSummary({ limit: 1 });
    assert.deepEqual(
      { active: watcherSummary.active, paused: watcherSummary.paused, archived: watcherSummary.archived, total: watcherSummary.total },
      { active: 1, paused: 0, archived: 1, total: 2 }
    );
    assert.equal(watcherSummary.recentFailures[0].id, failedObservation.observation.id);
    await assert.rejects(
      store.createWatcher({
        value: watcherValue('Inactive context watcher', { workContextId: financeContext.workContext.id }),
        changedBy: 'integration-operator'
      }),
      error => error && error.code === 'WORK_CONTEXT_NOT_ACTIVE'
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('watcher_observations')} SET status = 'refused' WHERE id = $1`, [observation.observation.id]),
      /append-only/i
    );

    const configuredAgent = await store.createConfiguredAgent({
      value: { name: 'Integration Agent', provider: 'openai', model: 'gpt-integration', apiKey: 'secret' },
      groupIds: [administratorGroupId, agentSupportGroupId],
      changedBy: 'integration-operator'
    });
    assert.equal(configuredAgent.agent.id > 0, true);
    assert.equal(configuredAgent.agent.revision, 1);
    assert.deepEqual(configuredAgent.agent.groupIds, [administratorGroupId, agentSupportGroupId]);
    assert.equal(configuredAgent.auditLog.type, 'admin:agent_create');
    const localAgent = await peer.createConfiguredAgent({
      value: { name: 'Local Agent', provider: 'ollama', model: 'gemma3:latest', apiKey: '' },
      groupIds: [agentSupportGroupId],
      changedBy: 'integration-peer'
    });
    for (let agentId = 3; agentId <= 40; agentId += 1) {
      const filler = await store.createConfiguredAgent({
        value: { name: `Integration Agent ${agentId}`, provider: 'openai', model: 'gpt-integration', apiKey: '' },
        groupIds: [],
        changedBy: 'integration-fixture'
      });
      assert.equal(filler.agent.id, agentId);
    }
    const agentPage = await store.listConfiguredAgents({ limit: 1 });
    assert.deepEqual(agentPage.agents.map(item => item.id), [configuredAgent.agent.id]);
    assert.equal(agentPage.nextAfterId, configuredAgent.agent.id);
    assert.deepEqual(
      (await store.listConfiguredAgents({ afterId: agentPage.nextAfterId, limit: 1 })).agents.map(item => item.id),
      [localAgent.agent.id]
    );
    assert.equal((await peer.getConfiguredAgentByName('Integration Agent')).id, configuredAgent.agent.id);
    assert.equal((await peer.getConfiguredAgentByName('iNtEgRaTiOn AgEnT', { caseInsensitive: true })).id, configuredAgent.agent.id);
    assert.deepEqual((await store.getConfiguredAgentById(configuredAgent.agent.id)).groupIds, [administratorGroupId, agentSupportGroupId]);
    assert.deepEqual(
      (await store.listConfiguredAgentsByGroup({ groupId: agentSupportGroupId, limit: 10 })).agents.map(item => item.id),
      [configuredAgent.agent.id, localAgent.agent.id]
    );
    assert.deepEqual(
      (await store.listAgentGroupMemberships({ agentIds: [configuredAgent.agent.id], limit: 10 })).memberships,
      [
        { agentId: configuredAgent.agent.id, groupId: administratorGroupId },
        { agentId: configuredAgent.agent.id, groupId: agentSupportGroupId }
      ]
    );

    const staleAgent = await peer.getConfiguredAgentById(configuredAgent.agent.id);
    const updatedAgent = await store.updateConfiguredAgent({
      agentId: configuredAgent.agent.id,
      expectedRevision: configuredAgent.agent.revision,
      value: { ...configuredAgent.agent, name: 'Integration Reviewer', provider: 'openai', model: 'gpt-review' },
      groupIds: [agentSupportGroupId],
      changedBy: 'integration-operator'
    });
    assert.equal(updatedAgent.agent.revision, 2);
    assert.deepEqual(updatedAgent.agent.groupIds, [agentSupportGroupId]);
    assert.equal(updatedAgent.auditLog.type, 'admin:agent_edit');
    await assert.rejects(
      peer.updateConfiguredAgent({
        agentId: staleAgent.id,
        expectedRevision: staleAgent.revision,
        value: { ...staleAgent, name: 'Stale Agent' },
        groupIds: staleAgent.groupIds,
        changedBy: 'stale-peer'
      }),
      error => error instanceof OptimisticConcurrencyError && error.entity === 'configuredAgent'
    );
    await assert.rejects(
      peer.createConfiguredAgent({
        value: { name: 'Integration Reviewer', provider: 'openai', model: '', apiKey: '' },
        changedBy: 'integration-peer'
      }),
      error => error && error.code === 'CONFIGURED_AGENT_NAME_CONFLICT'
    );

    const appendAgentAudit = store._appendSystemLog;
    store._appendSystemLog = async () => { throw new Error('injected configured-agent audit failure'); };
    try {
      await assert.rejects(
        store.createConfiguredAgent({
          value: { name: 'Must Roll Back Agent', provider: 'openai', model: 'gpt-test', apiKey: '' },
          groupIds: [administratorGroupId],
          changedBy: 'integration-operator'
        }),
        /injected configured-agent audit failure/
      );
    } finally {
      store._appendSystemLog = appendAgentAudit;
    }
    assert.equal(await store.getConfiguredAgentByName('Must Roll Back Agent'), null);

    const removedAgent = await store.deleteConfiguredAgent({
      agentId: localAgent.agent.id,
      expectedRevision: localAgent.agent.revision,
      changedBy: 'integration-operator'
    });
    assert.equal(removedAgent.auditLog.type, 'admin:agent_delete');
    assert.equal(await store.getConfiguredAgentById(localAgent.agent.id), null);
    assert.deepEqual(
      (await store.listAgentGroupMemberships({ agentIds: [localAgent.agent.id], limit: 10 })).memberships,
      []
    );
    assert.deepEqual(
      await store.removeConfiguredAgentMembershipsForGroup({ groupId: agentSupportGroupId }),
      { removedCount: 1 }
    );
    assert.deepEqual(
      (await store.listAgentGroupMemberships({ groupIds: [agentSupportGroupId], limit: 10 })).memberships,
      []
    );
    const ticketTwo = await store.createTicket({ status: 'open', title: 'Second ticket' });
    const lifecycleTicket = await store.createTicket({ status: 'open', title: 'Lifecycle ticket' });
    const ticketRaceTicket = await store.createTicket({ status: 'open', title: 'Ticket transition race' });
    const rollbackTicket = await store.createTicket({ status: 'open', title: 'Rollback ticket' });
    const transitionRollbackTicket = await store.createTicket({ status: 'open', title: 'Transition rollback ticket' });
    const composedTicket = await store.createTicket({ status: 'open', title: 'Composed evidence transaction' });
    const composedRollbackTicket = await store.createTicket({ status: 'open', title: 'Composed rollback transaction' });
    const fencedTicket = await store.createTicket({ status: 'open', title: 'Lease fencing transaction' });
    const leaseRepositoryTicket = await store.createTicket({ status: 'open', title: 'Lease repository boundary' });
    const phaseProjectionTicket = await store.createTicket({ status: 'open', title: 'Run phase projection boundary' });
    const terminalBoundaryTicket = await store.createTicket({ status: 'open', title: 'Terminalization boundary' });
    const terminalRepairTicket = await store.createTicket({ status: 'open', title: 'Terminal repair boundary' });
    const terminalRollbackTicket = await store.createTicket({ status: 'open', title: 'Terminalization rollback' });
    const terminalExpiredTicket = await store.createTicket({ status: 'open', title: 'Expired terminal recovery' });
    const nonTerminalEvidenceTicket = await store.createTicket({ status: 'open', title: 'Non-terminal evidence boundary' });
    const runtimeStateReadTicket = await store.createTicket({ status: 'open', title: 'Runtime state read boundary' });
    const triageAuthorityTicket = await store.createTicket({
      status: 'blocked',
      title: 'Triage authority boundary',
      triage: {
        required: true,
        reasonCode: 'authority_blocked',
        summary: 'Operator decision required',
        requiredDecision: 'change_scope',
        evidenceRefs: ['event:authority.denied'],
        allowedActions: ['review'],
        prohibitedActions: ['bypass_authority'],
        createdAt: '2026-07-16T09:00:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
        resolution: null
      }
    });
    const operatorReadParentTicket = await store.createTicket({
      status: 'open', title: 'Operator read parent', workContextId: 700
    });
    const operatorReadChildTicket = await store.createTicket({
      status: 'blocked', title: 'Operator read child', workContextId: 700,
      parentTicketId: operatorReadParentTicket.id
    });
    const lifecycleBoundaryTicket = await store.createTicketWithEvent({
      ticket: {
        status: 'open',
        title: 'Ticket/run lifecycle boundary',
        assignmentTargetType: 'group',
        assignmentTargetId: agentSupportGroupId,
        assignmentMode: 'allocated',
        changedAt: '2000-01-01T00:00:00.000Z'
      },
      eventPayload: { source: 'integration' }
    });
    const lifecycleRaceTicket = await store.createTicket({
      status: 'open', title: 'Lifecycle creation race', assignmentTargetType: 'agent', assignmentTargetId: 30
    });
    const retryBoundaryTicket = await store.createTicket({
      status: 'open', title: 'Atomic retry boundary', assignmentTargetType: 'agent', assignmentTargetId: 40,
      assignmentMode: 'individual'
    });
    assert.notEqual(ticketOne.id, ticketTwo.id);
    assert.equal(ticketOne.revision, 1);
    assert.equal(lifecycleBoundaryTicket.ticket.status, 'open');
    assert.notEqual(lifecycleBoundaryTicket.ticket.changedAt, '2000-01-01T00:00:00.000Z');
    assert.equal(lifecycleBoundaryTicket.event.type, 'ticket.created');
    const childTicketRace = await Promise.all([
      store.createTicketWithEvent({
        ticket: { status: 'blocked', assignmentTargetType: 'agent', assignmentTargetId: 99,
          spawnIdempotencyKey: 'integration-child-once' },
        eventPayload: { parentRunId: 999 }
      }),
      peer.createTicketWithEvent({
        ticket: { status: 'blocked', assignmentTargetType: 'agent', assignmentTargetId: 99,
          spawnIdempotencyKey: 'integration-child-once' },
        eventPayload: { parentRunId: 999 }
      })
    ]);
    assert.equal(childTicketRace[0].ticket.id, childTicketRace[1].ticket.id);
    assert.equal(childTicketRace.filter(result => result.created).length, 1,
      'workflow child idempotency must survive multi-process creation races');

    const runOne = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    const runTwo = await store.createRun({ ticketId: ticketOne.id, agentId: 1, status: 'pending' });
    assert.equal(await store.countRunsForTicket(ticketOne.id), 2);
    const populatedContextRuntimeSummary = await store.getWorkContextRuntimeSummary({
      workContextId: legalContext.workContext.id,
      limit: 1
    });
    assert.equal(populatedContextRuntimeSummary.counts.runCount, 2);
    assert.equal(populatedContextRuntimeSummary.recentRuns.length, 1);
    assert.equal(populatedContextRuntimeSummary.recentRuns[0].id, runTwo.id);
    const runThree = await store.createRun({ ticketId: ticketTwo.id, agentId: 1, status: 'pending' });
    const diagnosticRequest = await store.appendRunLog({
      run: { ...runOne, agentName: 'Agent One' },
      type: 'model:request',
      message: 'request',
      metadata: { usage: { total_tokens: 7 } }
    });
    const [diagnosticResponse, diagnosticWorkspace] = await Promise.all([
      store.appendRunLog({
        run: { ...runOne, agentName: 'Agent One' },
        type: 'model:response',
        message: 'response',
        metadata: { usage: { prompt_tokens: 2, completion_tokens: 3 } }
      }),
      peer.appendRunLog({
        run: { ...runOne, agentName: 'Agent One' },
        type: 'workspace:create',
        message: 'created',
        workspaceAction: { kind: 'file', path: 'report.md' }
      })
    ]);
    const diagnosticSystem = await store.appendSystemLog({
      type: 'ticket:status_change',
      message: 'changed',
      metadata: { runId: runOne.id, ticketId: ticketOne.id, changedBy: 'operator' }
    });
    assert.equal(diagnosticRequest.runId, runOne.id);
    assert.equal(diagnosticRequest.agentId, runOne.agentId);
    assert.notEqual(diagnosticResponse.id, diagnosticWorkspace.id);
    assert.equal(diagnosticSystem.runId, null);
    assert.equal(diagnosticSystem.contextRunId, runOne.id);
    assert.equal(diagnosticSystem.contextTicketId, ticketOne.id);
    const diagnosticPage = await store.listLogs({ runId: runOne.id, limit: 2 });
    assert.equal(diagnosticPage.logs.length, 2);
    assert.ok(diagnosticPage.nextBeforeId !== null);
    assert.ok((await store.listLogs({ runId: runOne.id, beforeId: diagnosticPage.nextBeforeId, limit: 10 })).logs.length >= 1);
    assert.equal(await store.hasRunLogType({ runId: runOne.id, type: 'model:request' }), true);
    const performancePage = await store.listPerformanceRunEvidence({ limit: 2 });
    assert.deepEqual(performancePage.evidence.map(item => item.run.id), [runOne.id, runTwo.id]);
    assert.equal(performancePage.nextAfterRunId, runTwo.id);
    assert.equal(performancePage.evidence[0].ticket.title, 'First ticket');
    assert.equal(performancePage.throughRunId, runThree.id);
    assert.equal(performancePage.evidence[0].replaySnapshot, null);
    assert.deepEqual(performancePage.evidence[0].operationHistory, []);
    assert.equal(performancePage.evidence[0].logMetrics.totalTokensUsed, 12);
    assert.equal(performancePage.evidence[0].logMetrics.totalWorkspaceActions, 1);
    const performanceTail = await store.listPerformanceRunEvidence({
      afterRunId: runTwo.id,
      throughRunId: performancePage.throughRunId,
      limit: 2
    });
    assert.deepEqual(performanceTail.evidence.map(item => item.run.id), [runThree.id]);
    assert.equal(performanceTail.nextAfterRunId, null);

    assert.deepEqual((await store.listLogsForRuns({ runIds: [runOne.id, runThree.id], limitPerRun: 2 }))
      .filter(log => log.runId === runThree.id), []);
    const [diagnosticMetric] = await store.getRunLogMetrics({ runIds: [runOne.id] });
    assert.equal(diagnosticMetric.totalTokensUsed, 12);
    assert.equal(diagnosticMetric.totalModelRequests, 1);
    assert.equal(diagnosticMetric.totalModelResponses, 1);
    assert.equal(diagnosticMetric.totalFilesCreated, 1);
    assert.equal(diagnosticMetric.totalWorkspaceActions, 1);
    await assert.rejects(
      store.appendRunLog({
        run: { ...runOne, ticketId: ticketTwo.id, agentName: 'Agent One' },
        type: 'run:invalid',
        message: 'invalid authority'
      }),
      error => error && error.code === 'POSTGRES_RECORD_NOT_FOUND'
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('diagnostic_logs')} SET type = 'changed' WHERE id = $1`, [diagnosticRequest.id]),
      /append-only/
    );
    const lifecycleRun = await store.createRun({ ticketId: lifecycleTicket.id, agentId: 3, status: 'pending' });
    const rollbackRun = await store.createRun({ ticketId: rollbackTicket.id, agentId: 4, status: 'pending' });
    const startRollbackRun = await store.createRun({
      ticketId: rollbackTicket.id, agentId: 4, status: 'pending'
    });
    const replayIntegrityRun = await store.createRun({ ticketId: rollbackTicket.id, agentId: 4, status: 'pending' });
    const replayBoundaryRun = await store.createRun({ ticketId: rollbackTicket.id, agentId: 4, status: 'pending' });
    const composedRun = await store.createRun({ ticketId: composedTicket.id, agentId: 5, status: 'pending' });
    const composedRollbackRun = await store.createRun({
      ticketId: composedRollbackTicket.id, agentId: 6, status: 'pending'
    });
    const fencedRun = await store.createRun({ ticketId: fencedTicket.id, agentId: 7, status: 'pending' });
    const leaseRepositoryRun = await store.createRun({
      ticketId: leaseRepositoryTicket.id, agentId: 8, status: 'pending'
    });
    const phaseProjectionRun = await store.createRun({
      ticketId: phaseProjectionTicket.id, agentId: 18, status: 'pending', currentPhase: 'planning'
    });
    const terminalBoundaryRun = await store.createRun({
      ticketId: terminalBoundaryTicket.id, agentId: 9, status: 'pending'
    });
    const terminalRepairRun = await store.createRun({
      ticketId: terminalRepairTicket.id, agentId: 10, status: 'pending'
    });
    const terminalRollbackRun = await store.createRun({
      ticketId: terminalRollbackTicket.id, agentId: 11, status: 'pending'
    });
    const terminalExpiredRun = await store.createRun({
      ticketId: terminalExpiredTicket.id, agentId: 12, status: 'pending'
    });
    const nonTerminalEvidenceRun = await store.createRun({
      ticketId: nonTerminalEvidenceTicket.id, agentId: 13, status: 'pending'
    });
    const runtimeStateReadRun = await store.createRun({
      ticketId: runtimeStateReadTicket.id, agentId: 14, status: 'pending'
    });
    const triageAuthorityPendingRun = await store.createRun({
      ticketId: triageAuthorityTicket.id, agentId: 15, status: 'pending'
    });
    const triageAuthorityTransition = await store.transitionRun({
      runId: triageAuthorityPendingRun.id,
      expectedRevision: triageAuthorityPendingRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.failed'
    });
    const triageAuthorityRun = triageAuthorityTransition.run;

    const ticketReadPage = await store.listTickets({ statuses: ['open'], limit: 2 });
    assert.equal(ticketReadPage.tickets.length, 2);
    assert.ok(ticketReadPage.nextAfterId);
    assert.deepEqual(
      (await store.listRunsForTicket({ ticketId: ticketOne.id, limit: 10 })).runs.map(run => run.id),
      [runOne.id, runTwo.id]
    );
    const operatorTicketPage = await store.listTicketPage({ workContextId: 700, limit: 1 });
    assert.equal(operatorTicketPage.tickets.length, 1);
    assert.equal(operatorTicketPage.hasPrevious, false);
    assert.equal(operatorTicketPage.hasNext, true);
    const operatorTicketNextPage = await store.listTicketPage({
      workContextId: 700,
      cursorUpdatedAt: operatorTicketPage.tickets[0].updatedAt,
      cursorId: operatorTicketPage.tickets[0].id,
      direction: 'next',
      limit: 1
    });
    assert.equal(operatorTicketNextPage.tickets.length, 1);
    assert.equal(operatorTicketNextPage.hasPrevious, true);
    assert.deepEqual(await store.countTicketsByStatus({ workContextId: 700 }), {
      all: 2,
      open: 1,
      in_progress: 0,
      completed: 0,
      failed: 0,
      blocked: 1,
      closed: 0
    });
    assert.deepEqual(
      (await store.listChildTickets({ parentTicketId: operatorReadParentTicket.id, limit: 10 })).tickets.map(ticket => ticket.id),
      [operatorReadChildTicket.id]
    );
    assert.deepEqual(
      (await store.listRunsForTickets({ ticketIds: [ticketOne.id, ticketTwo.id], statuses: ['pending'], limit: 10 })).runs.map(run => run.id),
      [runOne.id, runTwo.id, runThree.id]
    );
    assert.deepEqual(
      (await store.listLatestRunsForTickets({ ticketIds: [ticketOne.id, ticketTwo.id] })).map(run => run.id),
      [runTwo.id, runThree.id]
    );
    assert.deepEqual(await store.getRunAttemptPositions({ runIds: [runOne.id, runTwo.id, runThree.id] }), [
      { runId: runOne.id, attemptNumber: 1, attemptCount: 2 },
      { runId: runTwo.id, attemptNumber: 2, attemptCount: 2 },
      { runId: runThree.id, attemptNumber: 1, attemptCount: 1 }
    ]);

    const triageBefore = await store.getUnresolvedTriageSummary({ limit: 10 });
    assert.ok(triageBefore.recentTickets.some(item => item.ticketId === triageAuthorityTicket.id));
    const runTriageRace = await Promise.all([
      store.createRunTriage({
        runId: triageAuthorityRun.id,
        triage: {
          required: true,
          reasonCode: 'runtime_failed',
          summary: 'Runtime failure requires review',
          requiredDecision: 'review_failure',
          evidenceRefs: ['event:run.execution_failed'],
          allowedActions: ['review'],
          prohibitedActions: ['automatic_retry'],
          createdAt: '2000-01-01T00:00:00.000Z'
        }
      }),
      peer.createRunTriage({
        runId: triageAuthorityRun.id,
        triage: {
          required: true,
          reasonCode: 'runtime_failed',
          summary: 'Conflicting duplicate must not replace the winner',
          requiredDecision: 'review_failure',
          evidenceRefs: [],
          allowedActions: [],
          prohibitedActions: []
        }
      })
    ]);
    assert.equal(runTriageRace.filter(result => result.created).length, 1);
    assert.equal(runTriageRace[0].triage.createdAt, runTriageRace[1].triage.createdAt);
    assert.notEqual(runTriageRace[0].triage.createdAt, '2000-01-01T00:00:00.000Z');
    const triageAfterCreate = await store.getUnresolvedTriageSummary({ limit: 10 });
    assert.equal(triageAfterCreate.unresolvedTicketCount, triageBefore.unresolvedTicketCount);
    assert.equal(triageAfterCreate.unresolvedRunCount, triageBefore.unresolvedRunCount + 1);

    const [ticketResolutionRace, runResolutionRace] = await Promise.all([
      Promise.allSettled([
        store.resolveTicketTriage({
          ticketId: triageAuthorityTicket.id,
          resolvedBy: 'operator-a',
          resolution: 'Scope was corrected.'
        }),
        peer.resolveTicketTriage({
          ticketId: triageAuthorityTicket.id,
          resolvedBy: 'operator-b',
          resolution: 'Duplicate resolution.'
        })
      ]),
      Promise.allSettled([
        store.resolveRunTriage({
          runId: triageAuthorityRun.id,
          resolvedBy: 'operator-a',
          resolution: 'Failure reviewed.'
        }),
        peer.resolveRunTriage({
          runId: triageAuthorityRun.id,
          resolvedBy: 'operator-b',
          resolution: 'Duplicate resolution.'
        })
      ])
    ]);
    for (const race of [ticketResolutionRace, runResolutionRace]) {
      assert.equal(race.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = race.find(result => result.status === 'rejected');
      assert.ok(rejected.reason instanceof TriageConflictError);
      assert.equal(rejected.reason.code, 'TRIAGE_NOT_REQUIRED');
    }
    const triageAfterResolve = await store.getUnresolvedTriageSummary({ limit: 10 });
    assert.equal(triageAfterResolve.unresolvedTicketCount, triageBefore.unresolvedTicketCount - 1);
    assert.equal(triageAfterResolve.unresolvedRunCount, triageBefore.unresolvedRunCount);
    assert.ok((await store.listTicketEvents(triageAuthorityTicket.id, { limit: 20 })).events
      .some(event => event.type === 'ticket.triage_resolved'));
    const triageRunEvents = await store.listRunEvents(triageAuthorityRun.id);
    assert.equal(triageRunEvents.filter(event => event.type === 'run.triage_created').length, 1);
    assert.equal(triageRunEvents.filter(event => event.type === 'run.triage_resolved').length, 1);
    const operationalBeforeStateTransition = await store.getRuntimeOperationalSummary({ limit: 1 });
    assert.equal(
      operationalBeforeStateTransition.runs.active,
      operationalBeforeStateTransition.runs.pending + operationalBeforeStateTransition.runs.running
    );
    assert.equal(operationalBeforeStateTransition.runs.expiredLeasesTruncated, false);
    assert.deepEqual(operationalBeforeStateTransition.recentFailedRuns, [
      { runId: triageAuthorityRun.id, ticketId: triageAuthorityTicket.id }
    ]);
    const runtimeStateReadClaim = await store.claimPendingRun({
      leaseOwner: 'state-read-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [runtimeStateReadRun.id]
    });
    const runtimeStateReadRunning = await store.transitionRun({
      runId: runtimeStateReadRun.id,
      expectedRevision: runtimeStateReadClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'state-read-worker',
      eventType: 'run.started'
    });
    const operationalWhileRunning = await store.getRuntimeOperationalSummary({ limit: 1 });
    assert.equal(operationalWhileRunning.runs.active, operationalBeforeStateTransition.runs.active);
    assert.equal(operationalWhileRunning.runs.pending, operationalBeforeStateTransition.runs.pending - 1);
    assert.equal(operationalWhileRunning.runs.running, operationalBeforeStateTransition.runs.running + 1);
    await store.transitionRun({
      runId: runtimeStateReadRun.id,
      expectedRevision: runtimeStateReadRunning.run.revision,
      fromStatuses: ['running'],
      toStatus: 'failed',
      leaseOwner: 'state-read-worker',
      eventType: 'run.execution_failed'
    });
    const operationalAfterFailure = await store.getRuntimeOperationalSummary({ limit: 1 });
    assert.equal(operationalAfterFailure.runs.active, operationalBeforeStateTransition.runs.active - 1);
    assert.equal(operationalAfterFailure.runs.failed, operationalBeforeStateTransition.runs.failed + 1);
    await store.appendEvent({
      type: 'ticket.observed',
      ticketId: runtimeStateReadTicket.id,
      payload: { source: 'state-read-integration' }
    });
    assert.deepEqual(
      (await store.listRunsNeedingTerminalReconciliation({ limit: 10 })).runs.map(run => run.id),
      [runtimeStateReadRun.id]
    );
    const runtimeTimeline = await store.listRunTimelineEvents(runtimeStateReadRun.id, { limit: 10 });
    assert.ok(runtimeTimeline.events.some(event => event.type === 'ticket.observed'));
    assert.ok(runtimeTimeline.events.some(event => event.type === 'run.execution_failed'));
    const ticketTimeline = await store.listTicketEvents(runtimeStateReadTicket.id, { limit: 10 });
    assert.ok(ticketTimeline.events.some(event => event.type === 'ticket.observed'));
    assert.ok(ticketTimeline.events.some(event => event.type === 'run.execution_failed'));

    const replayInitializationRace = await Promise.all([
      store.initializeRunReplay({
        runId: replayBoundaryRun.id,
        ticketId: rollbackTicket.id,
        snapshot: { version: 1, events: [], initializedBy: 'store' }
      }),
      peer.initializeRunReplay({
        runId: replayBoundaryRun.id,
        ticketId: rollbackTicket.id,
        snapshot: { version: 1, events: [], initializedBy: 'peer' }
      })
    ]);
    assert.equal(replayInitializationRace.filter(result => result.initialized).length, 1);
    assert.equal(
      replayInitializationRace[0].record.snapshot.initializedBy,
      replayInitializationRace[1].record.snapshot.initializedBy,
      'concurrent replay initialization must converge on the first committed document'
    );
    await Promise.all([
      store.updateRunReplay({
        runId: replayBoundaryRun.id,
        update: snapshot => ({ ...snapshot, events: [...snapshot.events, { type: 'store' }] })
      }),
      peer.updateRunReplay({
        runId: replayBoundaryRun.id,
        update: snapshot => ({ ...snapshot, events: [...snapshot.events, { type: 'peer' }] })
      })
    ]);
    const replayBoundaryRecord = await store.readRunReplay(replayBoundaryRun.id);
    assert.deepEqual(
      replayBoundaryRecord.snapshot.events.map(event => event.type).sort(),
      ['peer', 'store'],
      'per-run row serialization must preserve concurrent replay projections'
    );
    assert.deepEqual(
      (await store.listRunReplays({ runIds: [replayBoundaryRun.id], limit: 1 })).map(record => record.runId),
      [replayBoundaryRun.id]
    );
    await assert.rejects(
      store.listRunReplays({ runIds: [runOne.id, runTwo.id, runThree.id], limit: 2 }),
      /exceeds the requested limit/
    );

    const nonTerminalClaim = await store.claimPendingRun({
      leaseOwner: 'evidence-worker', leaseDurationMs: 30_000, eligibleRunIds: [nonTerminalEvidenceRun.id]
    });
    await store.transitionRun({
      runId: nonTerminalEvidenceRun.id,
      expectedRevision: nonTerminalClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'evidence-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: nonTerminalEvidenceRun.id,
      snapshot: { version: 1, authorityChecks: [], workspaceOperations: [], browserOperations: [] }
    });
    const operationKey = `run:${nonTerminalEvidenceRun.id}:agent:0:0:integration`;
    const operationIntent = {
      operation: 'writeFile',
      args: { path: 'integration/report.txt', content: 'ready' },
      preState: { existed: false },
      authorityDecision: { status: 'allowed' },
      target: {
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt'
      }
    };
    assert.equal((await store.prepareTargetOperation({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      stepId: '0',
      leaseOwner: 'evidence-worker',
      intent: operationIntent
    })).inserted, true);
    assert.equal((await peer.prepareTargetOperation({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      stepId: '0',
      leaseOwner: 'evidence-worker',
      intent: { ...operationIntent, args: { content: 'ready', path: 'integration/report.txt' } }
    })).inserted, false);
    await store.appendRunEvidence({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      evidenceKey: `authority:${operationKey}`,
      replayKey: 'authorityChecks',
      replayItem: { operation: 'writeFile', status: 'allowed' },
      event: { type: 'authority.allowed', payload: { operation: 'writeFile', status: 'allowed' } }
    });
    const targetCompletion = {
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey,
      historyRecord: {
        operation: 'writeFile',
        args: operationIntent.args,
        outcome: 'succeeded'
      },
      receipt: {
        operation: 'writeFile',
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt',
        providerResponse: { path: 'integration/report.txt', size: 5 }
      },
      replayItem: {
        operation: { operation: 'writeFile', args: operationIntent.args },
        result: { path: 'integration/report.txt', size: 5 }
      },
      event: {
        type: 'workspace.operation',
        stepId: '0',
        payload: { operation: 'writeFile', path: 'integration/report.txt', mutating: true }
      }
    };
    const completionRace = await Promise.all([
      store.completeTargetOperation(targetCompletion),
      peer.completeTargetOperation(targetCompletion)
    ]);
    assert.equal(completionRace.filter(result => result.inserted).length, 1,
      'concurrent completion must create one receipt/evidence bundle');
    const targetState = await store.getTargetOperation(nonTerminalEvidenceRun.id, operationKey);
    assert.ok(targetState.intent);
    assert.ok(targetState.receipt);
    assert.deepEqual(targetState.receipt.args, operationIntent.args);
    assert.equal(targetState.receipt.result.path, 'integration/report.txt');
    assert.equal(targetState.receipt.mutationReceipt.targetPath, 'integration/report.txt');
    assert.equal(targetState.receipt.workspacePath, 'integration/report.txt');
    assert.equal(targetState.receipt.artifactPath, 'integration/report.txt');
    assert.equal(targetState.receipt.mutationFingerprint, 'writeFile:integration/report.txt');
    assert.equal(await store.findMutationConflict({
      runId: nonTerminalEvidenceRun.id,
      targetId: 'local-workspace',
      operation: 'writeFile',
      args: operationIntent.args
    }), null);
    const persistedMutationConflict = await store.findMutationConflict({
      runId: nonTerminalEvidenceRun.id,
      targetId: 'local-workspace',
      operation: 'deletePath',
      args: { path: 'integration/report.txt' }
    });
    assert.equal(persistedMutationConflict.id, targetState.receipt.id);
    const exactArtifactOwners = await store.listArtifactOwners({
      targetId: 'local-workspace',
      candidatePath: 'integration/report.txt',
      ticketId: nonTerminalEvidenceTicket.id,
      limit: 10
    });
    assert.deepEqual(exactArtifactOwners.owners.map(owner => owner.id), [targetState.receipt.id]);
    const overlappingArtifactOwners = await store.listArtifactOwners({
      targetId: 'local-workspace',
      candidatePath: 'integration',
      overlap: true,
      excludeTicketId: nonTerminalEvidenceTicket.id + 1000,
      limit: 10
    });
    assert.deepEqual(overlappingArtifactOwners.owners.map(owner => owner.artifactPath), ['integration/report.txt']);
    assert.deepEqual((await store.listArtifactOwners({
      targetId: 'local-workspace', candidatePath: 'integration', overlap: true,
      excludeTicketId: nonTerminalEvidenceTicket.id, limit: 10
    })).owners, []);
    const actionReceiptInput = {
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      operationKey: `run:${nonTerminalEvidenceRun.id}:browser:0:observe`,
      stepId: '0',
      operation: 'observe',
      outcome: 'succeeded',
      historyRecord: {
        operation: 'observe',
        args: {},
        result: { elementCount: 2 },
        targetId: 'browser:integration',
        targetKind: 'browser'
      },
      receipt: {
        operation: 'observe',
        targetId: 'browser:integration',
        targetKind: 'browser',
        metadata: { elementCount: 2 }
      },
      replayKey: 'browserOperations',
      replayItem: { operation: { operation: 'observe', args: {} }, status: 'ok' },
      event: { type: 'browser.operation', stepId: '0', payload: { operation: 'observe', status: 'ok' } }
    };
    const actionReceiptRace = await Promise.all([
      store.completeActionReceipt(actionReceiptInput),
      peer.completeActionReceipt(actionReceiptInput)
    ]);
    assert.equal(actionReceiptRace.filter(result => result.inserted).length, 1,
      'concurrent action receipt completion must create one receipt/evidence bundle');
    assert.equal((await store.listOperationReceipts(nonTerminalEvidenceRun.id)).length, 2);
    const projectedOperations = await store.listRunOperations(nonTerminalEvidenceRun.id, { limit: 10 });
    assert.equal(projectedOperations.length, 2);
    assert.equal(projectedOperations[0].operationKey, operationKey);
    assert.deepEqual(projectedOperations[0].args, operationIntent.args);
    assert.equal(projectedOperations[1].operation, 'observe');
    const projectedTicketOperations = await store.listTicketOperations(nonTerminalEvidenceTicket.id, { limit: 10 });
    assert.equal(projectedTicketOperations.length, 2);
    assert.deepEqual(await store.countRunMutations({ runIds: [nonTerminalEvidenceRun.id] }), [
      { runId: nonTerminalEvidenceRun.id, count: 1 }
    ]);
    const targetReplay = await store.getReplaySnapshot(nonTerminalEvidenceRun.id);
    assert.equal(targetReplay.snapshot.authorityChecks.length, 1);
    assert.equal(targetReplay.snapshot.workspaceOperations.length, 1);
    assert.equal(targetReplay.snapshot.browserOperations.length, 1);
    const targetEvents = await store.listRunEvents(nonTerminalEvidenceRun.id);
    assert.ok(targetEvents.some(event => event.type === 'workspace.operation_prepared'));
    assert.ok(targetEvents.some(event => event.type === 'workspace.operation'));
    assert.equal(targetEvents.filter(event => event.type === 'browser.operation').length, 1);
    assert.equal(verifyCurrentRunEventChain(targetEvents).chainValid, true);
    await singleConnectionStore.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, () => singleConnectionStore.appendRunEvidence({
      runId: nonTerminalEvidenceRun.id,
      ticketId: nonTerminalEvidenceTicket.id,
      evidenceKey: `authority:${operationKey}`,
      replayKey: 'authorityChecks',
      replayItem: { operation: 'writeFile', status: 'allowed' },
      event: { type: 'authority.allowed', payload: { operation: 'writeFile', status: 'allowed' } }
    }));
    const targetLockEntered = deferred();
    const releaseTargetLock = deferred();
    let competingTargetLockEntered = false;
    const heldTargetLock = store.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, async () => {
      targetLockEntered.resolve();
      await releaseTargetLock.promise;
    });
    await targetLockEntered.promise;
    const competingTargetLock = peer.withTargetOperationLock({
      targetId: 'local-workspace',
      paths: ['integration/report.txt']
    }, async () => { competingTargetLockEntered = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(competingTargetLockEntered, false,
      'session target lock must span committed intent, external effect, and completion transactions');
    releaseTargetLock.resolve();
    await Promise.all([heldTargetLock, competingTargetLock]);
    assert.equal(competingTargetLockEntered, true);

    const operatorRecoveryKey = `operator-recovery:operation:${targetState.receipt.id}`;
    const operatorRecoveryIntent = {
      originalHistoryId: targetState.receipt.id,
      requestedBy: 'integration-admin',
      operation: 'deletePath',
      args: { path: 'integration/report.txt' },
      preState: { existed: true, type: 'file', contentHash: 'integration-hash', content: 'ready' },
      target: {
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt'
      },
      attemptStartedAt: '2026-07-18T12:00:00.000Z'
    };
    const operatorRecoveryPrepareRace = await Promise.all([
      store.prepareOperatorRecovery({
        originalHistoryId: targetState.receipt.id,
        recoveryKey: operatorRecoveryKey,
        intent: operatorRecoveryIntent
      }),
      peer.prepareOperatorRecovery({
        originalHistoryId: targetState.receipt.id,
        recoveryKey: operatorRecoveryKey,
        intent: { ...operatorRecoveryIntent, args: { path: 'integration/report.txt' } }
      })
    ]);
    assert.equal(operatorRecoveryPrepareRace.filter(result => result.inserted).length, 1,
      'concurrent operator recovery preparation must create one immutable intent');
    await assert.rejects(
      store.prepareOperatorRecovery({
        originalHistoryId: targetState.receipt.id,
        recoveryKey: `${operatorRecoveryKey}:conflict`,
        intent: operatorRecoveryIntent
      }),
      error => error && error.code === 'IDEMPOTENCY_CONFLICT'
    );
    const preparedOperatorRecovery = await store.getOperatorRecovery(targetState.receipt.id);
    assert.equal(preparedOperatorRecovery.original.id, targetState.receipt.id);
    assert.equal(preparedOperatorRecovery.intent.operation, 'deletePath');
    assert.equal(preparedOperatorRecovery.receipt, null);

    const operatorRecoveryCompletion = {
      originalHistoryId: targetState.receipt.id,
      recoveryKey: operatorRecoveryKey,
      historyRecord: {
        operation: 'deletePath',
        args: operatorRecoveryIntent.args,
        preState: operatorRecoveryIntent.preState,
        postState: { existed: false },
        result: { path: 'integration/report.txt', status: 'deleted' },
        error: null,
        outcome: 'succeeded',
        recoveredBy: 'integration-admin'
      },
      receipt: {
        targetId: 'local-workspace',
        targetKind: 'localWorkspace',
        targetPath: 'integration/report.txt',
        targetResourceId: 'integration/report.txt',
        operation: 'deletePath',
        timestamp: operatorRecoveryIntent.attemptStartedAt,
        before: operatorRecoveryIntent.preState,
        after: { existed: false },
        providerResponse: { path: 'integration/report.txt', status: 'deleted' },
        error: null,
        authorityDecision: {
          allowed: true,
          actorType: 'operator',
          requestedBy: 'integration-admin',
          completedBy: 'integration-admin'
        },
        recovery: {
          originalHistoryId: targetState.receipt.id,
          requestedBy: 'integration-admin',
          completedBy: 'integration-admin',
          reconciliation: 'applied_effect_confirmed'
        }
      },
      replayItem: {
        operation: { operation: 'deletePath', args: operatorRecoveryIntent.args },
        result: { path: 'integration/report.txt', status: 'deleted' },
        startedAt: operatorRecoveryIntent.attemptStartedAt,
        isRecovery: true
      },
      event: {
        type: 'workspace.recovery_completed',
        stepId: '0',
        payload: { operation: 'deletePath', path: 'integration/report.txt', isRecovery: true }
      }
    };
    const operatorRecoveryCompletionRace = await Promise.all([
      store.completeOperatorRecovery(operatorRecoveryCompletion),
      peer.completeOperatorRecovery(operatorRecoveryCompletion)
    ]);
    assert.equal(operatorRecoveryCompletionRace.filter(result => result.inserted).length, 1,
      'concurrent operator recovery completion must commit one receipt/evidence bundle');
    const completedOperatorRecovery = await store.getOperatorRecovery(targetState.receipt.id);
    assert.equal(completedOperatorRecovery.receipt.isRecovery, true);
    assert.equal(completedOperatorRecovery.receipt.recoveredHistoryId, targetState.receipt.id);
    assert.equal(completedOperatorRecovery.receipt.operation, 'deletePath');
    assert.equal(completedOperatorRecovery.receipt.workspacePath, 'integration/report.txt');
    assert.equal(completedOperatorRecovery.receipt.artifactPath, null);
    assert.equal(completedOperatorRecovery.receipt.mutationFingerprint, 'deletePath:integration/report.txt');
    assert.equal((await store.completeOperatorRecovery(operatorRecoveryCompletion)).inserted, false,
      'repeated operator recovery completion must be idempotent');
    const operatorRecoveryEvents = await store.listRunEvents(nonTerminalEvidenceRun.id);
    assert.equal(operatorRecoveryEvents.filter(event => event.type === 'workspace.recovery_prepared').length, 1);
    assert.equal(operatorRecoveryEvents.filter(event => event.type === 'workspace.recovery_completed').length, 1);
    assert.equal(verifyCurrentRunEventChain(operatorRecoveryEvents).chainValid, true);
    const operatorRecoveryReplay = await store.getReplaySnapshot(nonTerminalEvidenceRun.id);
    assert.equal(operatorRecoveryReplay.snapshot.workspaceOperations.length, 2);
    const projectedRecoveryOperations = await store.listRunOperations(nonTerminalEvidenceRun.id, { limit: 10 });
    const projectedRecovery = projectedRecoveryOperations.find(record => record.id === completedOperatorRecovery.receipt.id);
    assert.equal(projectedRecovery.isRecovery, true);
    assert.equal(projectedRecovery.recoveredHistoryId, targetState.receipt.id);
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('operator_recovery_intents')} SET requested_by = 'tampered'`),
      /append-only/
    );
    const lifecycleBatch = await store.createRunsAndStartTicket({
      ticketId: lifecycleBoundaryTicket.ticket.id,
      runDrafts: [{
        ticketId: lifecycleBoundaryTicket.ticket.id, agentId: 20, agentName: 'Twenty', status: 'pending',
        executionMode: 'agent'
      }, {
        ticketId: lifecycleBoundaryTicket.ticket.id, agentId: 21, agentName: 'Twenty One', status: 'pending',
        executionMode: 'agent'
      }],
      runEventPayload: run => ({ agentId: run.agentId, agentName: run.agentName })
    });
    assert.equal(lifecycleBatch.ticket.status, 'in_progress');
    assert.equal(lifecycleBatch.ticket.revision, 2);
    assert.equal(lifecycleBatch.runs.length, 2);
    assert.deepEqual(lifecycleBatch.events.map(event => event.type), ['run.created', 'run.created', 'ticket.updated']);
    assert.ok(lifecycleBatch.runs.every(run => run.ticketOpenedAt === lifecycleBoundaryTicket.ticket.updatedAt));
    const failedAllocationMember = await store.transitionRun({
      runId: lifecycleBatch.runs[0].id,
      expectedRevision: lifecycleBatch.runs[0].revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.execution_failed',
      eventPayload: { source: 'lifecycle settlement integration' }
    });
    const failedAllocationSettlement = await store.transitionTicketAfterRun({ runId: failedAllocationMember.run.id });
    assert.equal(failedAllocationSettlement.changed, true);
    assert.equal(failedAllocationSettlement.ticket.status, 'failed');

    const lifecycleCreationRace = await Promise.allSettled([
      store.createRunsAndStartTicket({
        ticketId: lifecycleRaceTicket.id,
        runDrafts: [{ ticketId: lifecycleRaceTicket.id, agentId: 30, status: 'pending', executionMode: 'agent' }]
      }),
      peer.createRunsAndStartTicket({
        ticketId: lifecycleRaceTicket.id,
        runDrafts: [{ ticketId: lifecycleRaceTicket.id, agentId: 30, status: 'pending', executionMode: 'agent' }]
      })
    ]);
    assert.equal(lifecycleCreationRace.filter(result => result.status === 'fulfilled').length, 1);
    const lifecycleRaceCount = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('runs')} WHERE ticket_id = $1`,
      [lifecycleRaceTicket.id]
    );
    assert.equal(lifecycleRaceCount.rows[0].count, 1, 'same-ticket lifecycle creation must not duplicate a run');

    const retryInitial = await store.createRunsAndStartTicket({
      ticketId: retryBoundaryTicket.id,
      runDrafts: [{ ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' }]
    });
    const retryFailed = await store.transitionRun({
      runId: retryInitial.runs[0].id,
      expectedRevision: retryInitial.runs[0].revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.execution_failed',
      eventPayload: { reason: 'retryable integration failure' }
    });
    await assert.rejects(
      smallRecordStore.createRetryRun({
        ticketId: retryBoundaryTicket.id,
        predecessorRunId: retryFailed.run.id,
        runDraft: { ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' },
        runEventPayload: () => ({ padding: 'x'.repeat(300) })
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    assert.equal((await store.getTicket(retryBoundaryTicket.id)).status, 'in_progress',
      'failed retry evidence must roll back ticket reopen');
    const retryCountAfterRollback = await store.pool.query(
      `SELECT count(*)::int AS count FROM ${store.table('runs')} WHERE ticket_id = $1`,
      [retryBoundaryTicket.id]
    );
    assert.equal(retryCountAfterRollback.rows[0].count, 1, 'failed retry evidence must roll back the new run');

    const retryCreated = await store.createRetryRun({
      ticketId: retryBoundaryTicket.id,
      predecessorRunId: retryFailed.run.id,
      runDraft: { ticketId: retryBoundaryTicket.id, agentId: 40, status: 'pending', executionMode: 'agent' },
      runEventPayload: run => ({ agentId: run.agentId })
    });
    assert.equal(retryCreated.ticket.status, 'in_progress');
    assert.equal(retryCreated.runs[0].status, 'pending');
    assert.equal(retryCreated.runs[0].rerunMode, 'auto_retry');
    assert.equal((await store.getRun(retryFailed.run.id)).status, 'failed');

    const ticketInProgress = await store.transitionTicket({
      ticketId: ticketRaceTicket.id,
      expectedRevision: ticketRaceTicket.revision,
      fromStatuses: ['open'],
      toStatus: 'in_progress',
      eventPayload: { source: 'integration' }
    });
    assert.equal(ticketInProgress.ticket.revision, 2);
    assert.equal(ticketInProgress.event.payload.previousStatus, 'open');
    const ticketRace = await Promise.allSettled([
      store.transitionTicket({
        ticketId: ticketRaceTicket.id,
        expectedRevision: 2,
        fromStatuses: ['in_progress'],
        toStatus: 'completed'
      }),
      peer.transitionTicket({
        ticketId: ticketRaceTicket.id,
        expectedRevision: 2,
        fromStatuses: ['in_progress'],
        toStatus: 'failed'
      })
    ]);
    assert.equal(ticketRace.filter(result => result.status === 'fulfilled').length, 1);
    const ticketRaceFailure = ticketRace.find(result => result.status === 'rejected');
    assert.ok(ticketRaceFailure.reason instanceof OptimisticConcurrencyError);

    await assert.rejects(
      smallRecordStore.transitionTicket({
        ticketId: transitionRollbackTicket.id,
        expectedRevision: transitionRollbackTicket.revision,
        fromStatuses: ['open'],
        toStatus: 'blocked',
        eventPayload: { padding: 'x'.repeat(220) }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const ticketAfterRollback = await store.getTicket(transitionRollbackTicket.id);
    assert.equal(ticketAfterRollback.status, 'open', 'event failure must roll back ticket state');
    assert.equal(ticketAfterRollback.revision, 1, 'event failure must roll back ticket revision');

    await store.writeReplaySnapshot({
      runId: replayIntegrityRun.id,
      snapshot: { version: 1, integrity: 'original' }
    });
    await store.pool.query(
      `UPDATE ${store.table('replay_snapshots')}
       SET snapshot = '{"version":1,"integrity":"tampered"}'::jsonb,
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE run_id = $1`,
      [replayIntegrityRun.id]
    );
    await assert.rejects(
      store.getReplaySnapshot(replayIntegrityRun.id),
      error => error && error.code === 'POSTGRES_REPLAY_INTEGRITY_FAILURE'
    );

    const lifecycleClaim = await store.claimPendingRun({
      leaseOwner: 'lifecycle-worker', leaseDurationMs: 30_000, eligibleRunIds: [lifecycleRun.id]
    });
    const startedLifecycle = await store.transitionRun({
      runId: lifecycleRun.id,
      expectedRevision: lifecycleClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'lifecycle-worker',
      eventType: 'run.started'
    });
    assert.equal(startedLifecycle.run.status, 'running');
    assert.ok(startedLifecycle.run.startedAt);
    assert.equal(startedLifecycle.run.revision, 3);

    await assert.rejects(
      store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation: { effectiveness: { status: 'unknown' } } }),
      /requires a terminal run/
    );

    const replayCreated = await store.writeReplaySnapshot({
      runId: lifecycleRun.id,
      snapshot: { version: 1, steps: [] }
    });
    assert.equal(replayCreated.record.revision, 1);
    const replayRace = await Promise.allSettled([
      store.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 1,
        snapshot: { version: 1, steps: ['store'] }
      }),
      peer.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 1,
        snapshot: { version: 1, steps: ['peer'] }
      })
    ]);
    assert.equal(replayRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(replayRace.find(result => result.status === 'rejected').reason instanceof OptimisticConcurrencyError);
    const replayWinner = replayRace.find(result => result.status === 'fulfilled').value;
    assert.equal(replayWinner.record.revision, 2);

    const runRace = await Promise.allSettled([
      store.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'lifecycle-worker',
        eventType: 'run.terminalized'
      }),
      peer.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        fromStatuses: ['running'],
        toStatus: 'failed',
        leaseOwner: 'lifecycle-worker',
        eventType: 'run.terminalized'
      })
    ]);
    assert.equal(runRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(runRace.find(result => result.status === 'rejected').reason instanceof OptimisticConcurrencyError);
    const terminalRun = runRace.find(result => result.status === 'fulfilled').value.run;
    assert.ok(terminalRun.completedAt);
    assert.equal(terminalRun.leaseOwner, null);
    assert.equal(terminalRun.revision, 4);
    await assert.rejects(
      store.transitionRun({
        runId: lifecycleRun.id,
        expectedRevision: terminalRun.revision,
        fromStatuses: [terminalRun.status],
        toStatus: 'pending'
      }),
      /Unsupported run status transition/
    );
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('runs')}
         SET status = 'pending', revision = revision + 1, completed_at = NULL
         WHERE id = $1`,
        [lifecycleRun.id]
      ),
      /terminal runs cannot be reopened/
    );

    const finalizedReplay = await store.writeReplaySnapshot({
      runId: lifecycleRun.id,
      expectedRevision: replayWinner.record.revision,
      snapshot: { ...replayWinner.record.snapshot, terminalStatus: terminalRun.status },
      finalize: true
    });
    assert.equal(finalizedReplay.record.revision, 3);
    assert.ok(finalizedReplay.record.finalizedAt);
    await assert.rejects(
      store.writeReplaySnapshot({
        runId: lifecycleRun.id,
        expectedRevision: 3,
        snapshot: { version: 1, tampered: true }
      }),
      error => error instanceof ImmutableEvidenceConflictError
    );

    const evaluation = { effectiveness: { status: terminalRun.status === 'completed' ? 'passed' : 'failed' } };
    const recordedEvaluation = await store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation });
    assert.equal(recordedEvaluation.inserted, true);
    assert.equal((await store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation })).inserted, false);
    await assert.rejects(
      store.recordRunEvaluation({ runId: lifecycleRun.id, evaluation: { effectiveness: { status: 'different' } } }),
      error => error instanceof ImmutableEvidenceConflictError
    );

    const consequence = { mutations: [], verification: { status: evaluation.effectiveness.status } };
    assert.equal((await store.recordRunConsequence({ runId: lifecycleRun.id, consequence })).inserted, true);
    assert.equal((await store.recordRunConsequence({ runId: lifecycleRun.id, consequence })).inserted, false);

    const receiptDocument = {
      targetId: 'local-workspace',
      targetKind: 'workspace',
      targetPath: 'reports/daily.json',
      changedResources: ['reports/daily.json']
    };
    const recordedReceipt = await store.recordOperationReceipt({
      runId: lifecycleRun.id,
      idempotencyKey: 'lifecycle-step-1-write',
      stepId: '1',
      operation: 'writeFile',
      outcome: 'succeeded',
      receipt: receiptDocument
    });
    assert.equal(recordedReceipt.inserted, true);
    const exactOperation = await store.getOperation(recordedReceipt.record.id);
    assert.equal(exactOperation.id, recordedReceipt.record.id);
    assert.equal(exactOperation.runId, lifecycleRun.id);
    assert.equal(exactOperation.operation, 'writeFile');
    assert.equal(exactOperation.targetPath, 'reports/daily.json');
    assert.equal((await store.recordOperationReceipt({
      runId: lifecycleRun.id,
      idempotencyKey: 'lifecycle-step-1-write',
      stepId: '1',
      operation: 'writeFile',
      outcome: 'succeeded',
      receipt: { changedResources: ['reports/daily.json'], targetPath: 'reports/daily.json', targetKind: 'workspace', targetId: 'local-workspace' }
    })).inserted, false, 'semantically identical JSON must be idempotent regardless of key order');
    await assert.rejects(
      store.recordOperationReceipt({
        runId: lifecycleRun.id,
        idempotencyKey: 'lifecycle-step-1-write',
        stepId: '1',
        operation: 'writeFile',
        outcome: 'failed',
        receipt: receiptDocument
      }),
      error => error instanceof IdempotencyConflictError
    );
    assert.equal((await store.listOperationReceipts(lifecycleRun.id)).length, 1);

    const composedClaim = await store.claimPendingRun({
      leaseOwner: 'composed-worker', leaseDurationMs: 30_000, eligibleRunIds: [composedRun.id]
    });
    const composedStarted = await store.transitionRun({
      runId: composedRun.id,
      expectedRevision: composedClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'composed-worker',
      eventType: 'run.started'
    });
    const composedReplayCreated = await store.writeReplaySnapshot({
      runId: composedRun.id,
      snapshot: { version: 1, steps: [] }
    });
    const composedEvidence = await store.withTransaction(async client => {
      const terminal = await store.transitionRun({
        runId: composedRun.id,
        expectedRevision: composedStarted.run.revision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'composed-worker',
        eventType: 'run.completed'
      }, { client });
      const replay = await store.writeReplaySnapshot({
        runId: composedRun.id,
        expectedRevision: composedReplayCreated.record.revision,
        snapshot: { version: 1, steps: ['completed'] },
        finalize: true
      }, { client });
      const runEvaluation = await store.recordRunEvaluation({
        runId: composedRun.id,
        evaluation: { effectiveness: { status: 'passed' } }
      }, { client });
      const runConsequence = await store.recordRunConsequence({
        runId: composedRun.id,
        consequence: { mutations: [], verification: { status: 'passed' } }
      }, { client });
      const operationReceipt = await store.recordOperationReceipt({
        runId: composedRun.id,
        idempotencyKey: 'composed-terminal-receipt',
        operation: 'verifyPostconditions',
        outcome: 'succeeded',
        receipt: { checks: 1, passed: 1 }
      }, { client });
      return { terminal, replay, runEvaluation, runConsequence, operationReceipt };
    });
    assert.equal(composedEvidence.terminal.run.status, 'completed');
    assert.equal(composedEvidence.terminal.run.currentPhase, 'terminalization');
    assert.ok(composedEvidence.replay.record.finalizedAt);
    assert.equal(composedEvidence.runEvaluation.inserted, true);
    assert.equal(composedEvidence.runConsequence.inserted, true);
    assert.equal(composedEvidence.operationReceipt.inserted, true);
    assert.equal((await store.getRun(composedRun.id)).status, 'completed');
    assert.equal((await store.getReplaySnapshot(composedRun.id)).revision, 2);
    assert.equal((await store.listOperationReceipts(composedRun.id)).length, 1);
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(composedRun.id)).chainValid, true);

    const terminalClaim = await store.claimPendingRun({
      leaseOwner: 'terminal-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalBoundaryRun.id]
    });
    const terminalStarted = await store.transitionRun({
      runId: terminalBoundaryRun.id,
      expectedRevision: terminalClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'terminal-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: terminalBoundaryRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    const terminalBundle = await store.terminalizeRun({
      runId: terminalBoundaryRun.id,
      fromStatuses: ['running'],
      status: 'completed',
      leaseOwner: 'terminal-worker',
      patch: { currentPhase: 'terminalization', browserReport: null },
      replaySnapshot: {
        version: 1,
        steps: ['started', 'completed'],
        modelResponses: [],
        terminalStatus: 'completed',
        finalizedAt: '2026-07-16T12:00:00.000Z'
      },
      executionEvent: { type: 'run.execution_completed', payload: { status: 'completed' } },
      beforeReplayEvents: [{ type: 'run.verification_passed', payload: { status: 'passed' } }],
      replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'completed' } },
      beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
      evaluation: context => {
        assert.deepEqual(context.events.map(event => event.type), [
          'run.execution_completed',
          'run.verification_passed',
          'run.snapshot_finalized',
          'run.violations_checked'
        ]);
        assert.ok(context.events.every(event => event.id && Number.isInteger(event.seq)));
        return { effectiveness: { status: 'passed' }, violations: { status: 'none' } };
      },
      consequence: context => ({
        mutations: [],
        verification: { status: context.evaluation.effectiveness.status }
      }),
      terminalEvent: { type: 'run.terminalized', payload: { status: 'completed' } }
    });
    assert.equal(terminalBundle.run.status, 'completed');
    assert.equal(terminalBundle.run.currentPhase, 'terminalization');
    assert.equal(terminalBundle.run.leaseOwner, null);
    assert.equal(terminalBundle.run.lastHeartbeatAt, null);
    assert.equal(terminalBundle.evaluation.effectiveness.status, 'passed');
    assert.equal(terminalBundle.consequence.verification.status, 'passed');
    assert.ok((await store.getReplaySnapshot(terminalBoundaryRun.id)).finalizedAt);
    assert.equal((await store.getRunEvaluation(terminalBoundaryRun.id)).evaluation.effectiveness.status, 'passed');
    assert.equal((await store.getRunConsequence(terminalBoundaryRun.id)).consequence.verification.status, 'passed');
    assert.deepEqual(
      (await store.listRunEvents(terminalBoundaryRun.id)).slice(-7).map(event => event.type),
      [
        'run.execution_completed',
        'run.verification_passed',
        'run.snapshot_finalized',
        'run.violations_checked',
        'run.evaluation_completed',
        'run.consequence_recorded',
        'run.terminalized'
      ]
    );
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(terminalBoundaryRun.id)).chainValid, true);
    const lateProviderEvidence = await store.appendRunEvidence({
      runId: terminalBoundaryRun.id,
      ticketId: terminalBoundaryTicket.id,
      evidenceKey: `provider-response:${terminalBoundaryRun.id}:late`,
      replayKey: 'modelResponses',
      replayItem: { provider: 'openai', response: { complete: false } },
      event: { type: 'provider.response.persisted', payload: { provider: 'openai', late: true } }
    });
    assert.equal(lateProviderEvidence.inserted, true);
    assert.equal(lateProviderEvidence.replaySnapshot.snapshot.modelResponses.length, 1);
    assert.ok(lateProviderEvidence.replaySnapshot.finalizedAt, 'late evidence must not unseal terminal fields');
    await assert.rejects(
      store.updateRunReplay({
        runId: terminalBoundaryRun.id,
        update: snapshot => ({ ...snapshot, terminalStatus: 'failed' })
      }),
      error => error instanceof ImmutableEvidenceConflictError
    );

    const repairClaim = await store.claimPendingRun({
      leaseOwner: 'terminal-repair-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalRepairRun.id]
    });
    await store.transitionRun({
      runId: terminalRepairRun.id,
      expectedRevision: repairClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'terminal-repair-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: terminalRepairRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    await store.appendEvent({
      type: 'run.execution_completed',
      ticketId: terminalRepairTicket.id,
      runId: terminalRepairRun.id,
      payload: { status: 'failed', error: 'provider failed before terminal evidence committed' }
    });
    const repairInput = {
      runId: terminalRepairRun.id,
      status: 'failed',
      recoveryOwner: 'terminal-repair-worker',
      patch: { currentPhase: 'terminalization', error: 'provider failed before terminal evidence committed' },
      replaySnapshot: {
        version: 1,
        steps: ['started'],
        terminalStatus: 'failed',
        finalizedAt: '2026-07-16T12:00:30.000Z'
      },
      beforeReplayEvents: [{
        type: 'run.triage_created',
        payload: { triage: { required: true, reasonCode: 'provider_failed' } }
      }],
      replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
      beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
      evaluation: context => ({
        effectiveness: { status: 'failed' },
        violations: {
          status: context.events.some(event => event.type === 'run.violations_checked') ? 'none' : 'unknown'
        }
      }),
      consequence: context => ({
        mutations: [],
        verification: { status: context.evaluation.effectiveness.status }
      }),
      terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
    };
    const repairRace = await Promise.all([
      store.repairRunTerminalization(repairInput),
      peer.repairRunTerminalization(repairInput)
    ]);
    assert.equal(repairRace.filter(result => result && result.repaired).length, 1);
    assert.equal(repairRace.filter(result => result && !result.repaired).length, 1);
    const repairedRun = await store.getRun(terminalRepairRun.id);
    assert.equal(repairedRun.status, 'failed');
    assert.equal(repairedRun.currentPhase, 'terminalization');
    assert.equal(repairedRun.leaseOwner, null);
    assert.ok((await store.getReplaySnapshot(terminalRepairRun.id)).finalizedAt);
    assert.equal((await store.getRunEvaluation(terminalRepairRun.id)).evaluation.effectiveness.status, 'failed');
    assert.equal((await store.getRunConsequence(terminalRepairRun.id)).consequence.verification.status, 'failed');
    assert.deepEqual(
      (await store.listRunEvents(terminalRepairRun.id)).slice(-6).map(event => event.type),
      [
        'run.triage_created',
        'run.snapshot_finalized',
        'run.violations_checked',
        'run.evaluation_completed',
        'run.consequence_recorded',
        'run.terminalized'
      ]
    );
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(terminalRepairRun.id)).chainValid, true);
    await store.appendEvent({
      type: 'run.evaluation_completed',
      ticketId: terminalRepairTicket.id,
      runId: terminalRepairRun.id,
      payload: { evaluation: { effectiveness: { status: 'passed' } } }
    });
    await assert.rejects(
      store.repairRunTerminalization(repairInput),
      error => error && error.code === 'TERMINAL_REPAIR_INTEGRITY_FAILURE'
    );

    const rollbackClaim = await smallRecordStore.claimPendingRun({
      leaseOwner: 'terminal-rollback-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalRollbackRun.id]
    });
    await smallRecordStore.transitionRun({
      runId: terminalRollbackRun.id,
      expectedRevision: rollbackClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'terminal-rollback-worker',
      eventType: 'run.started'
    });
    const rollbackReplay = await smallRecordStore.writeReplaySnapshot({
      runId: terminalRollbackRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    const rollbackEventsBefore = await store.listRunEvents(terminalRollbackRun.id);
    await assert.rejects(
      smallRecordStore.terminalizeRun({
        runId: terminalRollbackRun.id,
        fromStatuses: ['running'],
        status: 'failed',
        leaseOwner: 'terminal-rollback-worker',
        patch: { error: 'rollback' },
        replaySnapshot: { version: 1, terminalStatus: 'failed', finalizedAt: '2026-07-16T12:00:00.000Z' },
        executionEvent: { type: 'run.execution_completed', payload: { status: 'failed' } },
        replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
        evaluation: { effectiveness: { status: 'failed' }, padding: 'x'.repeat(300) },
        consequence: { mutations: [] },
        terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const rollbackRunAfter = await store.getRun(terminalRollbackRun.id);
    assert.equal(rollbackRunAfter.status, 'running');
    assert.equal(rollbackRunAfter.leaseOwner, 'terminal-rollback-worker');
    const rollbackReplayAfter = await store.getReplaySnapshot(terminalRollbackRun.id);
    assert.equal(rollbackReplayAfter.revision, rollbackReplay.record.revision);
    assert.equal(rollbackReplayAfter.finalizedAt, null);
    assert.equal(await store.getRunEvaluation(terminalRollbackRun.id), null);
    assert.equal(await store.getRunConsequence(terminalRollbackRun.id), null);
    assert.deepEqual(await store.listRunEvents(terminalRollbackRun.id), rollbackEventsBefore);

    await store.appendEvent({
      type: 'run.execution_failed',
      ticketId: terminalRollbackTicket.id,
      runId: terminalRollbackRun.id,
      payload: { status: 'failed', error: 'repair rollback fixture' }
    });
    const repairRollbackEventsBefore = await store.listRunEvents(terminalRollbackRun.id);
    await assert.rejects(
      smallRecordStore.repairRunTerminalization({
        runId: terminalRollbackRun.id,
        status: 'failed',
        recoveryOwner: 'terminal-rollback-worker',
        patch: { error: 'repair rollback' },
        replaySnapshot: { version: 1, terminalStatus: 'failed', finalizedAt: '2026-07-16T12:00:30.000Z' },
        beforeReplayEvents: [{ type: 'run.triage_created', payload: { triage: { required: true } } }],
        replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'failed' } },
        beforeEvaluationEvents: [{ type: 'run.violations_checked', payload: { status: 'none' } }],
        evaluation: { effectiveness: { status: 'failed' }, padding: 'x'.repeat(300) },
        consequence: { mutations: [] },
        terminalEvent: { type: 'run.terminalized', payload: { status: 'failed' } }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const repairRollbackRun = await store.getRun(terminalRollbackRun.id);
    assert.equal(repairRollbackRun.status, 'running');
    assert.equal(repairRollbackRun.leaseOwner, 'terminal-rollback-worker');
    assert.equal((await store.getReplaySnapshot(terminalRollbackRun.id)).finalizedAt, null);
    assert.equal(await store.getRunEvaluation(terminalRollbackRun.id), null);
    assert.equal(await store.getRunConsequence(terminalRollbackRun.id), null);
    assert.deepEqual(await store.listRunEvents(terminalRollbackRun.id), repairRollbackEventsBefore);

    const expiredClaim = await store.claimPendingRun({
      leaseOwner: 'expired-terminal-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [terminalExpiredRun.id]
    });
    await store.transitionRun({
      runId: terminalExpiredRun.id,
      expectedRevision: expiredClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'expired-terminal-worker',
      eventType: 'run.started'
    });
    await store.writeReplaySnapshot({
      runId: terminalExpiredRun.id,
      snapshot: { version: 1, steps: ['started'] }
    });
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [terminalExpiredRun.id]
    );
    const expiredTerminal = await store.terminalizeRun({
      runId: terminalExpiredRun.id,
      fromStatuses: ['running'],
      status: 'interrupted',
      leaseOwner: null,
      allowExpiredLease: true,
      patch: { error: 'lease expired' },
      replaySnapshot: { version: 1, terminalStatus: 'interrupted', finalizedAt: '2026-07-16T12:00:00.000Z' },
      executionEvent: { type: 'run.execution_completed', payload: { status: 'interrupted' } },
      replayEvent: { type: 'run.snapshot_finalized', payload: { status: 'interrupted' } },
      evaluation: { effectiveness: { status: 'unknown' }, violations: { status: 'none' } },
      consequence: { mutations: [], verification: { status: 'unknown' } },
      terminalEvent: { type: 'run.terminalized', payload: { status: 'interrupted' } }
    });
    assert.equal(expiredTerminal.run.status, 'interrupted');
    assert.equal(expiredTerminal.run.leaseOwner, null);
    assert.equal(expiredTerminal.run.lastHeartbeatAt, null);

    await assert.rejects(
      smallRecordStore.withTransaction(async client => {
        await smallRecordStore.transitionRun({
          runId: composedRollbackRun.id,
          expectedRevision: composedRollbackRun.revision,
          fromStatuses: ['pending'],
          toStatus: 'failed',
          eventType: 'run.failed'
        }, { client });
        await smallRecordStore.recordRunEvaluation({
          runId: composedRollbackRun.id,
          evaluation: { effectiveness: { status: 'failed' } },
          eventPayload: { padding: 'x'.repeat(220) }
        }, { client });
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const composedRunAfterRollback = await store.getRun(composedRollbackRun.id);
    assert.equal(composedRunAfterRollback.status, 'pending');
    assert.equal(composedRunAfterRollback.revision, 1);
    assert.equal(await store.getRunEvaluation(composedRollbackRun.id), null);
    assert.deepEqual(await store.listRunEvents(composedRollbackRun.id), []);

    assert.equal(phaseProjectionRun.currentPhase, 'planning');
    const phaseBody = await store.pool.query(
      `SELECT body ? 'currentPhase' AS has_phase_body FROM ${store.table('runs')} WHERE id = $1`,
      [phaseProjectionRun.id]
    );
    assert.equal(phaseBody.rows[0].has_phase_body, false, 'phase must have one PostgreSQL projection authority');
    const phaseClaim = await store.claimPendingRun({
      leaseOwner: 'phase-worker',
      leaseDurationMs: 60_000,
      eligibleRunIds: [phaseProjectionRun.id]
    });
    const phaseStarted = await store.startClaimedRun({
      runId: phaseProjectionRun.id,
      leaseOwner: 'phase-worker',
      leaseDurationMs: 60_000
    });
    assert.equal(phaseStarted.run.currentPhase, 'planning');
    const phaseRace = await Promise.all([
      store.advanceRunPhase({
        runId: phaseProjectionRun.id,
        leaseOwner: 'phase-worker',
        fromPhase: 'planning',
        toPhase: 'inspection',
        stepId: '1',
        reason: 'integration phase race'
      }),
      peer.advanceRunPhase({
        runId: phaseProjectionRun.id,
        leaseOwner: 'phase-worker',
        fromPhase: 'planning',
        toPhase: 'inspection',
        stepId: '1',
        reason: 'integration phase race'
      })
    ]);
    assert.equal(phaseRace.filter(result => result && result.changed).length, 1,
      'concurrent identical phase writes must commit one projection and event');
    assert.equal(phaseRace.filter(result => result && !result.changed).length, 1);
    assert.equal(await store.advanceRunPhase({
      runId: phaseProjectionRun.id,
      leaseOwner: 'wrong-worker',
      fromPhase: 'inspection',
      toPhase: 'mutation'
    }), null, 'wrong-owner phase writes must be fenced');
    const backwardPhase = await store.advanceRunPhase({
      runId: phaseProjectionRun.id,
      leaseOwner: 'phase-worker',
      fromPhase: 'inspection',
      toPhase: 'planning'
    });
    assert.equal(backwardPhase.changed, false);
    await assert.rejects(
      store.advanceRunPhase({
        runId: phaseProjectionRun.id,
        leaseOwner: 'phase-worker',
        fromPhase: 'planning',
        toPhase: 'mutation'
      }),
      error => error && error.code === 'RUN_PHASE_CONFLICT'
    );
    const mutationPhase = await store.advanceRunPhase({
      runId: phaseProjectionRun.id,
      leaseOwner: 'phase-worker',
      fromPhase: 'inspection',
      toPhase: 'mutation',
      stepId: '2'
    });
    assert.equal(mutationPhase.run.currentPhase, 'mutation');
    const phaseEvents = await store.listRunEvents(phaseProjectionRun.id);
    assert.equal(phaseEvents.filter(event => event.type === 'execution.phase_transition').length, 2);
    assert.equal(verifyCurrentRunEventChain(phaseEvents).chainValid, true);
    await assert.rejects(
      store.pool.query(
        `UPDATE ${store.table('runs')} SET current_phase = 'invalid', revision = revision + 1 WHERE id = $1`,
        [phaseProjectionRun.id]
      ),
      /runs_current_phase_check/
    );

    const firstPendingPage = await store.listPendingRuns({ limit: 1 });
    assert.equal(firstPendingPage.runs.length, 1);
    assert.ok(firstPendingPage.nextCursor, 'bounded pending discovery must expose a continuation cursor');
    const secondPendingPage = await store.listPendingRuns({
      limit: 1,
      cursor: firstPendingPage.nextCursor,
      scanEndCursor: firstPendingPage.scanEndCursor
    });
    assert.equal(secondPendingPage.runs.length, 1);
    assert.notEqual(secondPendingPage.runs[0].id, firstPendingPage.runs[0].id);
    assert.ok((await store.listPendingRuns({ limit: 100 })).runs.some(run => run.id === leaseRepositoryRun.id));
    const repositoryClaim = await store.claimPendingRun({
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [leaseRepositoryRun.id],
      claimPayload: run => ({ repositoryBoundary: true, claimedRevision: run.revision })
    });
    assert.equal(repositoryClaim.event.payload.repositoryBoundary, true);
    assert.equal(repositoryClaim.event.payload.claimedRevision, repositoryClaim.run.revision);
    assert.equal((await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker'
    })).id, leaseRepositoryRun.id);
    assert.equal(await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'wrong-worker'
    }), null);
    assert.equal(await store.startClaimedRun({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'wrong-worker',
      leaseDurationMs: 60_000
    }), null, 'a wrong owner must not start a claimed run');
    const startRace = await Promise.all([
      store.startClaimedRun({
        runId: leaseRepositoryRun.id,
        leaseOwner: 'repository-worker',
        leaseDurationMs: 60_000,
        eventPayload: { status: 'forged', source: 'store' }
      }),
      peer.startClaimedRun({
        runId: leaseRepositoryRun.id,
        leaseOwner: 'repository-worker',
        leaseDurationMs: 60_000,
        eventPayload: { status: 'forged', source: 'peer' }
      })
    ]);
    assert.equal(startRace.filter(Boolean).length, 1, 'concurrent starts must produce one transition');
    const repositoryStarted = startRace.find(Boolean);
    assert.equal(repositoryStarted.run.status, 'running');
    assert.equal(repositoryStarted.event.type, 'run.started');
    assert.equal(repositoryStarted.event.payload.status, 'running');
    assert.ok(Date.parse(repositoryStarted.run.leaseExpiresAt) > Date.parse(repositoryClaim.run.leaseExpiresAt));
    assert.equal((await store.listRunEvents(leaseRepositoryRun.id))
      .filter(event => event.type === 'run.started').length, 1);

    const startRollbackClaim = await smallRecordStore.claimPendingRun({
      runId: startRollbackRun.id,
      leaseOwner: 'start-rollback-worker',
      leaseDurationMs: 30_000,
      eligibleRunIds: [startRollbackRun.id]
    });
    await assert.rejects(
      smallRecordStore.startClaimedRun({
        runId: startRollbackRun.id,
        leaseOwner: 'start-rollback-worker',
        leaseDurationMs: 30_000,
        eventPayload: { padding: 'x'.repeat(300) }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    const startRollbackAfter = await store.getRun(startRollbackRun.id);
    assert.equal(startRollbackAfter.status, 'pending', 'start event failure must roll back the state transition');
    assert.equal(startRollbackAfter.revision, startRollbackClaim.run.revision);
    assert.equal((await store.listRunEvents(startRollbackRun.id))
      .filter(event => event.type === 'run.started').length, 0);
    assert.equal(await store.persistRunWorkflowStep({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'wrong-worker',
      leaseDurationMs: 30_000,
      stepId: 'wrong',
      action: 'writeFile'
    }), null);
    const repositoryStep = await store.persistRunWorkflowStep({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000,
      stepId: 'verify',
      action: 'condition',
      status: 'completed',
      payload: { status: 'forged' }
    });
    assert.equal(repositoryStep.run.currentStepId, 'verify');
    assert.equal(repositoryStep.run.currentWorkflowAction, 'condition');
    assert.equal(repositoryStep.event.payload.status, 'completed');
    assert.equal(repositoryStep.run.revision, repositoryStarted.run.revision + 1);
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [leaseRepositoryRun.id]
    );
    assert.equal(await store.heartbeatRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker',
      leaseDurationMs: 30_000
    }), null, 'an expired PostgreSQL lease must not be renewable');
    assert.equal(await store.verifyRunLease({
      runId: leaseRepositoryRun.id,
      leaseOwner: 'repository-worker'
    }), null, 'an expired PostgreSQL lease must not authorize another action');
    assert.ok((await store.listExpiredRunningRuns({ limit: 100 })).some(run => run.id === leaseRepositoryRun.id));
    const repositoryRecovered = await store.recoverExpiredRun({
      runId: leaseRepositoryRun.id,
      eventPayload: { reason: 'safe repository recovery', status: 'forged' }
    });
    assert.equal(repositoryRecovered.run.status, 'pending');
    assert.equal(repositoryRecovered.run.leaseOwner, null);
    assert.equal(repositoryRecovered.run.lastHeartbeatAt, null);
    assert.equal(repositoryRecovered.event.payload.status, 'pending');
    assert.equal(repositoryRecovered.previousLease.leaseOwner, 'repository-worker');
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(leaseRepositoryRun.id)).chainValid, true);

    const recoveryBoundaryClaim = await store.claimPendingRun({
      leaseOwner: 'recovery-boundary-old',
      leaseDurationMs: 30_000,
      eligibleRunIds: [leaseRepositoryRun.id]
    });
    const recoveryBoundaryRunning = await store.transitionRun({
      runId: leaseRepositoryRun.id,
      expectedRevision: recoveryBoundaryClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'recovery-boundary-old',
      eventType: 'run.started'
    });
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [recoveryBoundaryRunning.run.id]
    );
    assert.ok((await store.listRecoverableRuns({
      mode: 'process_restart',
      limit: 100
    })).runs.some(run => run.id === leaseRepositoryRun.id));
    const recoveryAuthority = await store.claimRunRecovery({
      runId: leaseRepositoryRun.id,
      recoveryOwner: 'recovery-boundary-new',
      leaseDurationMs: 30_000,
      mode: 'process_restart',
      eventPayload: { source: 'integration' }
    });
    assert.equal(recoveryAuthority.run.leaseOwner, 'recovery-boundary-new');
    assert.equal(recoveryAuthority.previousLease.leaseOwner, 'recovery-boundary-old');
    assert.equal(recoveryAuthority.event.payload.mode, 'process_restart');
    assert.equal(await peer.claimRunRecovery({
      runId: leaseRepositoryRun.id,
      recoveryOwner: 'recovery-boundary-racer',
      leaseDurationMs: 30_000,
      mode: 'lease_expiry'
    }), null, 'a live recovery lease must fence another process');
    const recoveryResumed = await store.resumeRecoveredRun({
      runId: leaseRepositoryRun.id,
      recoveryOwner: 'recovery-boundary-new',
      eventPayload: { reason: 'evidence is safe to resume' }
    });
    assert.equal(recoveryResumed.run.status, 'pending');
    assert.equal(recoveryResumed.run.leaseOwner, null);

    const projectionClaim = await store.claimPendingRun({
      leaseOwner: 'projection-old',
      leaseDurationMs: 30_000,
      eligibleRunIds: [leaseRepositoryRun.id]
    });
    const projectionRunning = await store.transitionRun({
      runId: leaseRepositoryRun.id,
      expectedRevision: projectionClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'projection-old',
      eventType: 'run.started'
    });
    await store.appendEvent({
      type: 'run.terminalized',
      ticketId: projectionRunning.run.ticketId,
      runId: projectionRunning.run.id,
      payload: { status: 'interrupted', simulatedProjectionGap: true }
    });
    await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [projectionRunning.run.id]
    );
    const projectionRecovery = await store.claimRunRecovery({
      runId: projectionRunning.run.id,
      recoveryOwner: 'projection-recovery',
      leaseDurationMs: 30_000,
      mode: 'lease_expiry'
    });
    const repairedProjection = await store.repairRecoveredRunTerminalProjection({
      runId: projectionRunning.run.id,
      recoveryOwner: 'projection-recovery',
      status: 'interrupted',
      eventPayload: { terminalEventId: 'simulated' }
    });
    assert.equal(repairedProjection.run.status, 'interrupted');
    assert.equal(repairedProjection.run.leaseOwner, null);
    assert.equal(repairedProjection.event.payload.previousStatus, 'running');
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(leaseRepositoryRun.id)).chainValid, true);

    const fencedClaim = await store.claimPendingRun({
      leaseOwner: 'fenced-worker-old', leaseDurationMs: 30_000, eligibleRunIds: [fencedRun.id]
    });
    const fencedStarted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: fencedClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'fenced-worker-old',
      eventType: 'run.started'
    });
    const expiredLease = await store.pool.query(
      `UPDATE ${store.table('runs')}
       SET lease_expires_at = clock_timestamp() - interval '1 second',
           revision = revision + 1,
           updated_at = clock_timestamp()
       WHERE id = $1
       RETURNING revision`,
      [fencedRun.id]
    );
    const expiredRevision = Number(expiredLease.rows[0].revision);
    assert.equal(expiredRevision, fencedStarted.run.revision + 1);
    await assert.rejects(
      store.transitionRun({
        runId: fencedRun.id,
        expectedRevision: expiredRevision,
        fromStatuses: ['running'],
        toStatus: 'completed',
        leaseOwner: 'fenced-worker-old'
      }),
      error => error instanceof LeaseAuthorityError
    );
    const recovered = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: expiredRevision,
      fromStatuses: ['running'],
      toStatus: 'pending',
      eventType: 'run.lease_expired'
    });
    assert.equal(recovered.run.status, 'pending');
    const replacementClaim = await store.claimPendingRun({
      leaseOwner: 'fenced-worker-new', leaseDurationMs: 30_000, eligibleRunIds: [fencedRun.id]
    });
    const replacementStarted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: replacementClaim.run.revision,
      fromStatuses: ['pending'],
      toStatus: 'running',
      leaseOwner: 'fenced-worker-new',
      eventType: 'run.started'
    });
    await assert.rejects(
      store.transitionRun({
        runId: fencedRun.id,
        expectedRevision: replacementStarted.run.revision,
        fromStatuses: ['running'],
        toStatus: 'failed',
        leaseOwner: 'fenced-worker-old'
      }),
      error => error instanceof LeaseAuthorityError
    );
    const fencedCompleted = await store.transitionRun({
      runId: fencedRun.id,
      expectedRevision: replacementStarted.run.revision,
      fromStatuses: ['running'],
      toStatus: 'completed',
      leaseOwner: 'fenced-worker-new'
    });
    assert.equal(fencedCompleted.run.status, 'completed');
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(fencedRun.id)).chainValid, true);

    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('run_evaluations')} SET evaluation = '{}'::jsonb WHERE run_id = $1`, [lifecycleRun.id]),
      /append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('operation_receipts')} SET outcome = 'failed' WHERE id = $1`, [recordedReceipt.record.id]),
      /append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('replay_snapshots')} SET revision = revision + 1 WHERE run_id = $1`, [lifecycleRun.id]),
      /finalized replay permits only one append-only evidence item/
    );

    const rollbackTerminalTransition = await store.transitionRun({
      runId: rollbackRun.id,
      expectedRevision: rollbackRun.revision,
      fromStatuses: ['pending'],
      toStatus: 'failed',
      eventType: 'run.terminalized'
    });
    assert.equal(rollbackTerminalTransition.run.status, 'failed');
    await assert.rejects(
      smallRecordStore.recordRunEvaluation({
        runId: rollbackRun.id,
        evaluation: { effectiveness: { status: 'failed' } },
        eventPayload: { padding: 'x'.repeat(220) }
      }),
      error => error && error.code === 'POSTGRES_RECORD_TOO_LARGE'
    );
    assert.equal(await store.getRunEvaluation(rollbackRun.id), null, 'event failure must roll back evaluation insert');

    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(lifecycleRun.id)).chainValid, true);

    await Promise.all([
      store.appendEvent({ type: 'run.created', ticketId: ticketOne.id, runId: runOne.id, payload: { writer: 'one' } }),
      peer.appendEvent({ type: 'run.observed', ticketId: ticketOne.id, runId: runOne.id, payload: { writer: 'two' } })
    ]);
    let runOneEvents = await store.listRunEvents(runOne.id);
    assert.equal(runOneEvents.length, 2);
    assert.equal(verifyCurrentRunEventChain(runOneEvents).chainValid, true);

    await assert.rejects(
      store.appendEvent({ type: 'run.invalid_ticket', ticketId: ticketTwo.id, runId: runOne.id, payload: {} }),
      /foreign key|violates/i
    );
    const afterRollback = await store.appendEvent({
      type: 'run.after_rollback', ticketId: ticketOne.id, runId: runOne.id, payload: {}
    });
    assert.equal(afterRollback.seq, 2, 'failed append must roll back the chain-tip reservation');
    runOneEvents = await store.listRunEvents(runOne.id);
    assert.equal(verifyCurrentRunEventChain(runOneEvents).chainValid, true);

    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('events')} SET type = 'tampered' WHERE run_id = $1`, [runOne.id]),
      /events are append-only/
    );
    await assert.rejects(
      store.pool.query(`UPDATE ${store.table('runs')} SET revision = revision + 2 WHERE id = $1`, [runOne.id]),
      /revision must advance exactly once/
    );

    const eligibleRunIds = [runTwo.id, runThree.id];
    const [firstClaim, secondClaim] = await Promise.all([
      store.claimPendingRun({
        leaseOwner: 'worker-a', leaseDurationMs: 30_000, eligibleRunIds,
        claimPayload: { leaseOwner: 'forged', scheduler: 'a' }
      }),
      peer.claimPendingRun({
        leaseOwner: 'worker-b', leaseDurationMs: 30_000, eligibleRunIds,
        claimPayload: { leaseOwner: 'forged', scheduler: 'b' }
      })
    ]);
    assert.ok(firstClaim && secondClaim);
    assert.notEqual(firstClaim.run.id, secondClaim.run.id, 'SKIP LOCKED claims must not duplicate a run');
    assert.equal(firstClaim.event.payload.leaseOwner, firstClaim.run.leaseOwner);
    assert.equal(secondClaim.event.payload.leaseOwner, secondClaim.run.leaseOwner);
    assert.equal(firstClaim.run.revision, 2);
    assert.equal(await store.claimPendingRun({ leaseOwner: 'worker-c', leaseDurationMs: 30_000, eligibleRunIds }), null);

    const workerAClaim = firstClaim.run.leaseOwner === 'worker-a' ? firstClaim : secondClaim;
    assert.equal(await peer.heartbeatRunLease({
      runId: workerAClaim.run.id, leaseOwner: 'wrong-worker', leaseDurationMs: 30_000
    }), null);
    const heartbeat = await store.heartbeatRunLease({
      runId: workerAClaim.run.id,
      leaseOwner: 'worker-a',
      leaseDurationMs: 30_000,
      payload: { leaseOwner: 'forged', source: 'integration' }
    });
    assert.equal(heartbeat.event.payload.leaseOwner, 'worker-a');
    assert.equal(heartbeat.run.revision, 3);
    const released = await store.releaseRunLease({
      runId: workerAClaim.run.id, leaseOwner: 'worker-a', payload: { source: 'integration' }
    });
    assert.equal(released.run.leaseOwner, null);
    assert.equal(released.run.lastHeartbeatAt, null);
    assert.equal(released.event.type, 'run.lease_released');
    assert.equal(released.run.revision, 4);
    assert.equal(verifyCurrentRunEventChain(await store.listRunEvents(workerAClaim.run.id)).chainValid, true);

    const outerEntered = deferred();
    const releaseOuter = deferred();
    const parentEntered = deferred();
    const unrelatedEntered = deferred();
    let parentWasEntered = false;

    const outer = store.withWorkspaceMutationLocks({ targetId: 'local', paths: ['reports/daily.json'] }, async () => {
      outerEntered.resolve();
      await releaseOuter.promise;
    });
    await outerEntered.promise;

    const parentWaiter = peer.withWorkspaceMutationLocks({ targetId: 'local', paths: ['reports'] }, async () => {
      parentWasEntered = true;
      parentEntered.resolve();
    });
    const unrelated = store.withWorkspaceMutationLocks({ targetId: 'local', paths: ['exports/result.json'] }, async () => {
      unrelatedEntered.resolve();
    });

    await Promise.race([unrelatedEntered.promise, timeout(2_000, 'unrelated path lock was globally serialized')]);
    assert.equal(parentWasEntered, false, 'parent path must wait while a descendant mutation is active');
    await unrelated;
    releaseOuter.resolve();
    await outer;
    await Promise.race([parentEntered.promise, timeout(2_000, 'parent path lock did not resume')]);
    await parentWaiter;

    const populatedRuntimeIntegrity = await store.prepareRuntimePersistence();
    assert.equal(populatedRuntimeIntegrity.checkedRelationCount, 41);
    assert.equal(populatedRuntimeIntegrity.checkedIntegrityArtifactCount, 199);
    assert.equal(populatedRuntimeIntegrity.integrityMode, 'transactional_constraints');
    assert.equal(await store.releaseRuntimeAuthority(), true);

    const foundationClient = await nonemptyFoundationStore.pool.connect();
    try {
      await foundationClient.query(`CREATE SCHEMA ${nonemptyFoundationStore.schemaSql}`);
      await foundationClient.query(`CREATE TABLE ${nonemptyFoundationStore.table('schema_migrations')} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      await foundationClient.query('BEGIN');
      await foundationClient.query(`SET LOCAL search_path TO ${nonemptyFoundationStore.schemaSql}, public`);
      await foundationClient.query(fs.readFileSync(
        path.join(__dirname, '..', 'persistence', 'postgres', 'migrations', '001_runtime_core.sql'),
        'utf8'
      ));
      await foundationClient.query(
        `INSERT INTO ${nonemptyFoundationStore.table('schema_migrations')} (version) VALUES ($1)`,
        ['001_runtime_core.sql']
      );
      await foundationClient.query('COMMIT');
    } catch (error) {
      try { await foundationClient.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      foundationClient.release();
    }
    const foundationTicket = await nonemptyFoundationStore.createTicket({ status: 'open', title: 'Disposable foundation data' });
    const foundationRunResult = await nonemptyFoundationStore.pool.query(
      `INSERT INTO ${nonemptyFoundationStore.table('runs')}
        (ticket_id, agent_id, status, execution_mode, body)
       VALUES ($1, 1, 'pending', 'agent', '{}'::jsonb)
       RETURNING id`,
      [foundationTicket.id]
    );
    const foundationRun = { id: Number(foundationRunResult.rows[0].id) };
    await nonemptyFoundationStore.appendEvent({
      type: 'run.created',
      ticketId: foundationTicket.id,
      runId: foundationRun.id,
      payload: { orderSensitive: { z: 1, a: 2 } }
    });
    await assert.rejects(
      nonemptyFoundationStore.migrate(),
      /requires an empty development event store/
    );
    const preservedFoundationEvents = await nonemptyFoundationStore.pool.query(
      `SELECT count(*)::int AS count FROM ${nonemptyFoundationStore.table('events')}`
    );
    assert.equal(preservedFoundationEvents.rows[0].count, 1, 'refused migration must preserve development evidence');
    const refusedMigration = await nonemptyFoundationStore.pool.query(
      `SELECT 1 FROM ${nonemptyFoundationStore.table('schema_migrations')} WHERE version = $1`,
      ['002_runtime_evidence.sql']
    );
    assert.equal(refusedMigration.rowCount, 0);
    await assert.rejects(
      nonemptyFoundationStore.prepareRuntimePersistence(),
      error => error && error.code === 'POSTGRES_RUNTIME_INTEGRITY_FAILURE' &&
        error.storeName === 'schema_migrations'
    );

    console.log('PASS: PostgreSQL integration — bootstrap integrity, transactional watcher approval and evidence, transactional connector counts and receipts, transactional ticket/run lifecycle, paged lease/runtime/recovery authority, immutable evidence, replay revisions, idempotent receipts, rollback, claims, and path concurrency');
  } finally {
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${store.schemaSql} CASCADE`); } catch (_) {}
    try { await store.pool.query(`DROP SCHEMA IF EXISTS ${nonemptyFoundationStore.schemaSql} CASCADE`); } catch (_) {}
    await Promise.allSettled([
      store.close(),
      peer.close(),
      smallRecordStore.close(),
      singleConnectionStore.close(),
      nonemptyFoundationStore.close()
    ]);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
