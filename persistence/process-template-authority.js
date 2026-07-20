'use strict';

const REQUIRED_PROCESS_TEMPLATE_AUTHORITY_METHODS = Object.freeze([
  'getProcessTemplateById',
  'createProcessTemplate',
  'setProcessTemplateEnabled',
  'setProcessTemplateSchedule',
  'pauseProcessTemplateSchedule',
  'resumeProcessTemplateSchedule',
  'assignProcessTemplateWorkContext',
  'createProcessTemplateDraft',
  'activateProcessTemplateVersion',
  'listDueProcessTemplates',
  'executeProcessTemplateTrigger',
  'reconcileProcessTemplateVersions'
]);

class ProcessTemplateConflictError extends Error {
  constructor(message, code = 'PROCESS_TEMPLATE_CONFLICT', current = null) {
    super(message);
    this.name = 'ProcessTemplateConflictError';
    this.code = code;
    this.current = current;
  }
}

function assertProcessTemplateAuthorityRepository(repository) {
  if (!repository || typeof repository !== 'object') throw new TypeError('process-template authority repository is required');
  for (const method of REQUIRED_PROCESS_TEMPLATE_AUTHORITY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`process-template authority repository must implement ${method}()`);
    }
  }
  return repository;
}

function positiveSafeInteger(value, label) {
  const parsed = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return parsed;
}

function requiredString(value, label) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return parsed.toISOString();
}

function cloneObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return structuredClone(value);
}

function processTemplateVersionId(templateId, version) {
  return `ptv_${positiveSafeInteger(templateId, 'templateId')}_${positiveSafeInteger(version, 'version')}`;
}

function activeVersionNumber(template) {
  if (template && Number.isInteger(template.currentVersion) && template.currentVersion > 0) return template.currentVersion;
  if (template && Number.isInteger(template.version) && template.version > 0) return template.version;
  return 1;
}

function computeNextRunAt(schedule, from) {
  const everySeconds = schedule && Number.isInteger(schedule.everySeconds) ? schedule.everySeconds : null;
  if (!everySeconds || everySeconds <= 0) return null;
  const fromIso = timestamp(from, 'from');
  return new Date(Date.parse(fromIso) + everySeconds * 1000).toISOString();
}

function scheduleHasReusableInterval(schedule) {
  return Boolean(schedule && schedule.kind === 'interval' && Number.isInteger(schedule.everySeconds) && schedule.everySeconds > 0);
}

function buildVersionContent(template) {
  const record = cloneObject(template, 'template');
  const ticketTemplate = cloneObject(record.ticketTemplate || {}, 'template.ticketTemplate');
  return {
    name: requiredString(record.name, 'template.name'),
    ticketTemplate,
    executionPolicy: ticketTemplate.executionPolicy && typeof ticketTemplate.executionPolicy === 'object'
      ? structuredClone(ticketTemplate.executionPolicy)
      : null
  };
}

function triggerSpawnIdempotencyKey(triggerToken) {
  return `process-template:${requiredString(triggerToken, 'triggerToken')}`;
}

module.exports = {
  ProcessTemplateConflictError,
  REQUIRED_PROCESS_TEMPLATE_AUTHORITY_METHODS,
  activeVersionNumber,
  assertProcessTemplateAuthorityRepository,
  buildVersionContent,
  cloneObject,
  computeNextRunAt,
  positiveSafeInteger,
  processTemplateVersionId,
  requiredString,
  scheduleHasReusableInterval,
  timestamp,
  triggerSpawnIdempotencyKey
};
