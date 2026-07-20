'use strict';

const {
  ProcessTemplateConflictError,
  activeVersionNumber,
  buildVersionContent,
  cloneObject,
  computeNextRunAt,
  positiveSafeInteger,
  processTemplateVersionId,
  requiredString,
  scheduleHasReusableInterval,
  timestamp,
  triggerSpawnIdempotencyKey
} = require('../process-template-authority');

function requiredFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return structuredClone(value);
}

class JsonProcessTemplateAuthorityRepository {
  constructor({
    readProcessTemplates, writeProcessTemplates,
    readProcessTemplateVersions, writeProcessTemplateVersions,
    readProcessTemplateTriggers, writeProcessTemplateTriggers,
    findTicketByTriggerToken, getTicketById, appendSystemLog,
    now = () => new Date(), maxQueryRows = 1_000
  } = {}) {
    this.readProcessTemplates = requiredFunction(readProcessTemplates, 'readProcessTemplates');
    this.writeProcessTemplates = requiredFunction(writeProcessTemplates, 'writeProcessTemplates');
    this.readProcessTemplateVersions = requiredFunction(readProcessTemplateVersions, 'readProcessTemplateVersions');
    this.writeProcessTemplateVersions = requiredFunction(writeProcessTemplateVersions, 'writeProcessTemplateVersions');
    this.readProcessTemplateTriggers = requiredFunction(readProcessTemplateTriggers, 'readProcessTemplateTriggers');
    this.writeProcessTemplateTriggers = requiredFunction(writeProcessTemplateTriggers, 'writeProcessTemplateTriggers');
    this.findTicketByTriggerToken = requiredFunction(findTicketByTriggerToken, 'findTicketByTriggerToken');
    this.getTicketById = requiredFunction(getTicketById, 'getTicketById');
    this.appendSystemLog = requiredFunction(appendSystemLog, 'appendSystemLog');
    this.now = requiredFunction(now, 'now');
    this.maxQueryRows = positiveSafeInteger(maxQueryRows, 'maxQueryRows');
    this._triggerTail = Promise.resolve();
  }

  _templates() { return array(this.readProcessTemplates(), 'process-template store'); }
  _versions() { return array(this.readProcessTemplateVersions(), 'process-template version store'); }
  _triggers() { return array(this.readProcessTemplateTriggers(), 'process-template trigger store'); }
  _now() { return timestamp(this.now(), 'now'); }

  async _audit(type, message, metadata) {
    return this.appendSystemLog({ type, message, metadata });
  }

  async _writeWithAudit({ templates, versions = null, triggers = null, rollback, audit }) {
    try {
      if (versions) this.writeProcessTemplateVersions(versions);
      if (triggers) this.writeProcessTemplateTriggers(triggers);
      this.writeProcessTemplates(templates);
      return await this._audit(audit.type, audit.message, audit.metadata);
    } catch (error) {
      try { this.writeProcessTemplates(rollback.templates); } catch (_) {}
      if (versions) try { this.writeProcessTemplateVersions(rollback.versions); } catch (_) {}
      if (triggers) try { this.writeProcessTemplateTriggers(rollback.triggers); } catch (_) {}
      throw error;
    }
  }

  _activeVersion(template, versions) {
    const rows = versions.filter(version => version && version.templateId === template.id);
    const active = rows.filter(version => version.status === 'active');
    if (active.length !== 1) {
      throw new ProcessTemplateConflictError(
        `Process template  must have exactly one active version`,
        'PROCESS_TEMPLATE_VERSION_INTEGRITY'
      );
    }
    return active[0];
  }

  async getProcessTemplateById(templateId) {
    const id = positiveSafeInteger(templateId, 'templateId');
    return this._templates().find(template => template && template.id === id) || null;
  }

  async createProcessTemplate({ value, changedBy }) {
    const body = cloneObject(value, 'value');
    const actor = requiredString(changedBy, 'changedBy');
    const name = requiredString(body.name, 'value.name');
    const ticketTemplate = cloneObject(body.ticketTemplate, 'value.ticketTemplate');
    const rollback = { templates: this._templates(), versions: this._versions() };
    const templates = structuredClone(rollback.templates);
    const versions = structuredClone(rollback.versions);
    const at = this._now();
    const id = templates.reduce((maximum, item) => Math.max(maximum, Number(item && item.id) || 0), 0) + 1;
    const versionId = processTemplateVersionId(id, 1);
    const template = {
      id, name, version: 1, currentVersion: 1, currentVersionId: versionId,
      enabled: body.enabled !== false, triggerType: 'manual', schedule: null,
      ticketTemplate, workContextId: body.workContextId || null, workContextSnapshot: body.workContextSnapshot || null,
      revision: 1, createdBy: actor, createdAt: at, updatedBy: actor, updatedAt: at, lastTriggeredAt: null
    };
    const content = buildVersionContent(template);
    const version = {
      id: versionId, templateId: id, version: 1, status: 'active', ...content,
      createdBy: actor, createdAt: at, activatedBy: actor, activatedAt: at,
      supersedesVersionId: null, changeSummary: null
    };
    templates.push(template);
    versions.push(version);
    const auditLog = await this._writeWithAudit({
      templates, versions, rollback,
      audit: { type: 'process_template:created', message: `Process template "${name}" created`, metadata: { templateId: id, templateName: name, createdBy: actor, activeVersionId: versionId } }
    });
    return { template, version, auditLog };
  }

  async _updateTemplate(templateId, changedBy, update, audit) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const actor = requiredString(changedBy, 'changedBy');
    const rollback = { templates: this._templates() };
    const templates = structuredClone(rollback.templates);
    const template = templates.find(item => item && item.id === id);
    if (!template) return null;
    const at = this._now();
    update(template, at, actor);
    template.revision = (Number.isSafeInteger(template.revision) ? template.revision : 0) + 1;
    template.updatedBy = actor;
    template.updatedAt = at;
    const entry = audit(template, at, actor);
    const auditLog = await this._writeWithAudit({ templates, rollback, audit: entry });
    return { template, auditLog };
  }

  setProcessTemplateEnabled({ templateId, enabled, changedBy }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    return this._updateTemplate(templateId, changedBy, template => { template.enabled = enabled; },
      (template, at, actor) => ({
        type: enabled ? 'process_template:enabled' : 'process_template:disabled',
        message: `Process template "${template.name}" ${enabled ? 'enabled' : 'disabled'}`,
        metadata: { templateId: template.id, templateName: template.name, changedBy: actor, changedAt: at }
      }));
  }

  setProcessTemplateSchedule({ templateId, enabled, everySeconds = null, changedBy }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
    if (enabled && (!Number.isInteger(everySeconds) || everySeconds <= 0)) throw new TypeError('everySeconds must be a positive integer');
    return this._updateTemplate(templateId, changedBy, (template, at, actor) => {
      template.schedule = enabled ? {
        enabled: true, kind: 'interval', everySeconds, anchor: at,
        nextRunAt: computeNextRunAt({ everySeconds }, at), lastScheduledTriggerAt: null,
        timezone: 'UTC', scheduledBy: actor
      } : (scheduleHasReusableInterval(template.schedule)
        ? { ...template.schedule, enabled: false, nextRunAt: null }
        : null);
    }, (template, at, actor) => ({
      type: enabled ? 'process_template:schedule_set' : 'process_template:schedule_disabled',
      message: `Process template "${template.name}" schedule ${enabled ? `set to every ${everySeconds}s` : 'disabled'}`,
      metadata: { templateId: template.id, templateName: template.name, everySeconds: enabled ? everySeconds : null, changedBy: actor, changedAt: at }
    }));
  }

  pauseProcessTemplateSchedule({ templateId, changedBy }) {
    return this._updateTemplate(templateId, changedBy, template => {
      if (!scheduleHasReusableInterval(template.schedule)) throw new ProcessTemplateConflictError('No reusable interval schedule to pause', 'PROCESS_TEMPLATE_SCHEDULE_MISSING');
      template.schedule = { ...template.schedule, enabled: false, nextRunAt: null };
    }, (template, at, actor) => ({ type: 'process_template:schedule_paused', message: `Process template "${template.name}" schedule paused`, metadata: { templateId: template.id, templateName: template.name, changedBy: actor, changedAt: at } }));
  }

  resumeProcessTemplateSchedule({ templateId, changedBy }) {
    return this._updateTemplate(templateId, changedBy, (template, at) => {
      if (!scheduleHasReusableInterval(template.schedule)) throw new ProcessTemplateConflictError('No reusable interval schedule to resume', 'PROCESS_TEMPLATE_SCHEDULE_MISSING');
      template.schedule = { ...template.schedule, enabled: true, nextRunAt: computeNextRunAt(template.schedule, at) };
    }, (template, at, actor) => ({ type: 'process_template:schedule_resumed', message: `Process template "${template.name}" schedule resumed`, metadata: { templateId: template.id, templateName: template.name, changedBy: actor, changedAt: at } }));
  }

  assignProcessTemplateWorkContext({ templateId, workContextId = null, workContextSnapshot = null, changedBy }) {
    const contextId = workContextId === null ? null : positiveSafeInteger(workContextId, 'workContextId');
    return this._updateTemplate(templateId, changedBy, template => {
      template.workContextId = contextId;
      template.workContextSnapshot = contextId === null ? null : cloneObject(workContextSnapshot, 'workContextSnapshot');
    }, (template, at, actor) => ({ type: 'work_context:template_assigned', message: `Process template "${template.name}" Work Context ${contextId === null ? 'cleared' : 'updated'}`, metadata: { templateId: template.id, templateName: template.name, workContextId: contextId, changedBy: actor, changedAt: at } }));
  }

  async createProcessTemplateDraft({ templateId, name = null, ticketTemplate = null, changeSummary = null, changedBy }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const actor = requiredString(changedBy, 'changedBy');
    const rollback = { templates: this._templates(), versions: this._versions() };
    const templates = structuredClone(rollback.templates);
    const versions = structuredClone(rollback.versions);
    const template = templates.find(item => item && item.id === id);
    if (!template) return null;
    if (versions.some(version => version && version.templateId === id && version.status === 'draft')) {
      throw new ProcessTemplateConflictError('A draft version already exists for this template', 'PROCESS_TEMPLATE_DRAFT_EXISTS');
    }
    const at = this._now();
    const active = this._activeVersion(template, versions);
    const versionNumber = active.version + 1;
    const overlay = ticketTemplate === null ? {} : cloneObject(ticketTemplate, 'ticketTemplate');
    const nextTicketTemplate = { ...structuredClone(active.ticketTemplate), ...overlay };
    const draft = {
      id: processTemplateVersionId(id, versionNumber), templateId: id, version: versionNumber, status: 'draft',
      name: name === null ? active.name : requiredString(name, 'name'), ticketTemplate: nextTicketTemplate,
      executionPolicy: nextTicketTemplate.executionPolicy || null, createdBy: actor, createdAt: at,
      activatedBy: null, activatedAt: null, supersedesVersionId: active.id,
      changeSummary: changeSummary === null ? null : String(changeSummary)
    };
    versions.push(draft);
    template.revision = (Number.isSafeInteger(template.revision) ? template.revision : 0) + 1;
    template.updatedBy = actor;
    template.updatedAt = at;
    const auditLog = await this._writeWithAudit({
      templates, versions, rollback,
      audit: { type: 'process_template:version_draft_created', message: `Process template "${template.name}" draft v${versionNumber} created`, metadata: { templateId: id, templateName: template.name, fromVersion: active.version, toVersion: versionNumber, draftVersionId: draft.id, changedBy: actor } }
    });
    return { template, draft, activeVersion: active.version, auditLog };
  }

  async activateProcessTemplateVersion({ templateId, versionId, changedBy }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const targetId = requiredString(versionId, 'versionId');
    const actor = requiredString(changedBy, 'changedBy');
    const rollback = { templates: this._templates(), versions: this._versions() };
    const templates = structuredClone(rollback.templates);
    const versions = structuredClone(rollback.versions);
    const template = templates.find(item => item && item.id === id);
    if (!template) return null;
    const draft = versions.find(version => version && version.templateId === id && version.id === targetId);
    if (!draft) return { template, version: null };
    if (draft.status !== 'draft') throw new ProcessTemplateConflictError('Only a draft version can be activated', 'PROCESS_TEMPLATE_VERSION_NOT_DRAFT');
    if (template.schedule && template.schedule.enabled === true) throw new ProcessTemplateConflictError('Pause the schedule before activating a new version', 'PROCESS_TEMPLATE_SCHEDULE_ACTIVE');
    const at = this._now();
    const prior = versions.find(version => version && version.templateId === id && version.status === 'active');
    if (!prior) throw new ProcessTemplateConflictError(`Process template ${id} has no active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
    prior.status = 'superseded';
    draft.status = 'active';
    draft.activatedBy = actor;
    draft.activatedAt = at;
    draft.supersedesVersionId = prior.id;
    template.name = draft.name;
    template.ticketTemplate = structuredClone(draft.ticketTemplate);
    template.version = draft.version;
    template.currentVersion = draft.version;
    template.currentVersionId = draft.id;
    template.revision = (Number.isSafeInteger(template.revision) ? template.revision : 0) + 1;
    template.updatedBy = actor;
    template.updatedAt = at;
    const auditLog = await this._writeWithAudit({
      templates, versions, rollback,
      audit: { type: 'process_template:version_activated', message: `Process template "${template.name}" activated v${draft.version}`, metadata: { templateId: id, templateName: template.name, fromVersion: prior.version, toVersion: draft.version, activatedVersionId: draft.id, supersedesVersionId: prior.id, changedBy: actor } }
    });
    return { template, version: draft, priorVersion: prior, auditLog };
  }

  async listDueProcessTemplates({ dueAt = this._now(), limit = 100 } = {}) {
    const at = timestamp(dueAt, 'dueAt');
    const size = positiveSafeInteger(limit, 'limit');
    if (size > this.maxQueryRows) throw new RangeError(`limit exceeds the configured maximum of ${this.maxQueryRows}`);
    return this._templates()
      .filter(template => template && template.enabled === true && template.schedule && template.schedule.enabled === true && template.schedule.kind === 'interval')
      .filter(template => Number.isInteger(template.schedule.everySeconds) && template.schedule.everySeconds > 0 && !Number.isNaN(Date.parse(template.schedule.nextRunAt || '')))
      .filter(template => Date.parse(template.schedule.nextRunAt) <= Date.parse(at))
      .sort((left, right) => Date.parse(left.schedule.nextRunAt) - Date.parse(right.schedule.nextRunAt) || left.id - right.id)
      .slice(0, size);
  }

  executeProcessTemplateTrigger(options) {
    const operation = () => this._executeProcessTemplateTrigger(options);
    const result = this._triggerTail.then(operation, operation);
    this._triggerTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async _executeProcessTemplateTrigger({ templateId, triggerToken, triggerType, scheduledFor = null, triggeredBy, createTicket }) {
    const id = positiveSafeInteger(templateId, 'templateId');
    const token = requiredString(triggerToken, 'triggerToken');
    const kind = requiredString(triggerType, 'triggerType');
    if (!['manual', 'schedule'].includes(kind)) throw new TypeError('triggerType must be manual or schedule');
    const actor = requiredString(triggeredBy, 'triggeredBy');
    const create = requiredFunction(createTicket, 'createTicket');
    const rollback = { templates: this._templates(), versions: this._versions(), triggers: this._triggers() };
    const templates = structuredClone(rollback.templates);
    const versions = structuredClone(rollback.versions);
    const triggers = structuredClone(rollback.triggers);
    const template = templates.find(item => item && item.id === id);
    if (!template) return null;
    const at = this._now();
    const existing = triggers.find(trigger => trigger && trigger.triggerToken === token);
    if (existing) {
      if (existing.templateId !== id) throw new ProcessTemplateConflictError('Trigger token belongs to another template', 'PROCESS_TEMPLATE_TRIGGER_TOKEN_CONFLICT');
      if (kind === 'schedule' && template.schedule && template.schedule.enabled === true &&
          template.schedule.nextRunAt === timestamp(scheduledFor, 'scheduledFor')) {
        template.schedule.lastScheduledTriggerAt = at;
        template.schedule.nextRunAt = computeNextRunAt(template.schedule, at);
        template.updatedAt = at;
        template.revision = (Number.isSafeInteger(template.revision) ? template.revision : 0) + 1;
        this.writeProcessTemplates(templates);
      }
      return { ok: true, deduped: true, template, trigger: existing, ticket: this.getTicketById(existing.ticketId) };
    }
    if (template.enabled !== true) throw new ProcessTemplateConflictError('Process template is disabled', 'PROCESS_TEMPLATE_DISABLED');
    if (kind === 'schedule') {
      const slot = timestamp(scheduledFor, 'scheduledFor');
      if (!template.schedule || template.schedule.enabled !== true || template.schedule.nextRunAt !== slot) {
        return { ok: true, deduped: true, stale: true, template, trigger: null, ticket: null };
      }
    }
    const active = this._activeVersion(template, versions);
    const source = {
      type: 'process_template', templateId: id, templateName: template.name, templateVersion: active.version,
      triggeredBy: actor, triggerType: kind, triggerRunId: null, triggerToken: token, createdAt: at,
      ...(kind === 'schedule' ? { scheduledFor: timestamp(scheduledFor, 'scheduledFor') } : {})
    };
    let ticket = this.findTicketByTriggerToken(token);
    let created = false;
    if (!ticket) {
      const result = await create({ template: structuredClone(template), source, spawnIdempotencyKey: triggerSpawnIdempotencyKey(token) });
      if (!result || result.ok !== true || !result.ticket) return result || { ok: false, error: 'Ticket creation failed' };
      ticket = result.ticket;
      created = result.created !== false;
    }
    const trigger = {
      id: triggers.reduce((maximum, item) => Math.max(maximum, Number(item && item.id) || 0), 0) + 1,
      triggerToken: token, templateId: id, templateName: template.name, templateVersion: active.version,
      ticketId: ticket.id, triggeredBy: actor, triggerType: kind, createdAt: at,
      ticketTemplateSnapshot: structuredClone(template.ticketTemplate), executionPolicyUsed: structuredClone(ticket.executionPolicy || null),
      ...(kind === 'schedule' ? { scheduledFor: timestamp(scheduledFor, 'scheduledFor') } : {}),
      ...(template.createdBy ? { templateCreatedBy: template.createdBy } : {}),
      ...(template.schedule && template.schedule.scheduledBy ? { scheduledBy: template.schedule.scheduledBy } : {})
    };
    triggers.push(trigger);
    template.lastTriggeredAt = at;
    template.updatedAt = at;
    template.revision = (Number.isSafeInteger(template.revision) ? template.revision : 0) + 1;
    if (kind === 'schedule') {
      template.schedule.lastScheduledTriggerAt = at;
      template.schedule.nextRunAt = computeNextRunAt(template.schedule, at);
    }
    const auditLog = await this._writeWithAudit({
      templates, versions, triggers, rollback,
      audit: { type: 'process_template:triggered', message: `Process template "${template.name}" created ticket #${ticket.id}`, metadata: { contextTicketId: ticket.id, templateId: id, templateName: template.name, triggeredBy: actor, triggerType: kind, triggerToken: token } }
    });
    return { ok: true, deduped: !created, template, trigger, ticket, source, auditLog };
  }

  async reconcileProcessTemplateVersions() {
    const rollback = { templates: this._templates() };
    const templates = structuredClone(rollback.templates);
    const versions = this._versions();
    let repairedCount = 0;
    for (const template of templates) {
      const records = versions.filter(version => version && version.templateId === template.id);
      if (records.length === 0) continue;
      const active = records.filter(version => version.status === 'active');
      if (active.length !== 1) throw new ProcessTemplateConflictError(`Process template ${template.id} must have exactly one active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
      const record = active[0];
      if (template.currentVersionId === record.id && template.currentVersion === record.version && template.version === record.version && template.name === record.name && JSON.stringify(template.ticketTemplate) === JSON.stringify(record.ticketTemplate)) continue;
      if (record.version < activeVersionNumber(template)) throw new ProcessTemplateConflictError(`Process template ${template.id} root is ahead of its active version`, 'PROCESS_TEMPLATE_VERSION_INTEGRITY');
      template.name = record.name;
      template.ticketTemplate = structuredClone(record.ticketTemplate);
      template.currentVersion = record.version;
      template.currentVersionId = record.id;
      template.version = record.version;
      template.updatedBy = 'system';
      template.updatedAt = this._now();
      repairedCount += 1;
    }
    if (repairedCount > 0) this.writeProcessTemplates(templates);
    return { repairedCount };
  }
}

module.exports = { JsonProcessTemplateAuthorityRepository };
