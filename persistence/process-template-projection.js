'use strict';

function activeVersionNumber(template) {
  if (template && Number.isInteger(template.currentVersion) && template.currentVersion > 0) return template.currentVersion;
  if (template && Number.isInteger(template.version) && template.version > 0) return template.version;
  return 1;
}

function scheduleHasReusableInterval(schedule) {
  return Boolean(
    schedule &&
    schedule.kind === 'interval' &&
    Number.isInteger(schedule.everySeconds) &&
    schedule.everySeconds > 0
  );
}

function emptyGeneratedTicketCounts() {
  return { total: 0, blocked: 0, triaged: 0, pending: 0, inProgress: 0, completed: 0, failed: 0 };
}

function isTriaged(ticket) {
  return Boolean(ticket && ticket.triage && ticket.triage.required === true);
}

function ticketTimestamp(ticket) {
  const value = ticket && ticket.source && ticket.source.createdAt
    ? ticket.source.createdAt
    : ticket && ticket.createdAt;
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareGeneratedTickets(left, right) {
  const time = ticketTimestamp(left) - ticketTimestamp(right);
  if (time !== 0) return time;
  return Number(left && left.id || 0) - Number(right && right.id || 0);
}

function countGeneratedTickets(tickets) {
  const counts = emptyGeneratedTicketCounts();
  for (const ticket of tickets) {
    counts.total += 1;
    if (ticket.status === 'blocked') counts.blocked += 1;
    if (isTriaged(ticket)) counts.triaged += 1;
    if (ticket.status === 'open') counts.pending += 1;
    if (ticket.status === 'in_progress') counts.inProgress += 1;
    if (ticket.status === 'completed') counts.completed += 1;
    if (ticket.status === 'failed') counts.failed += 1;
  }
  return counts;
}

function computeDueStatus(template, nowMs) {
  if (!template || template.enabled !== true) return 'template_disabled';
  const schedule = template.schedule;
  if (!schedule) return 'unscheduled';
  if (schedule.enabled !== true) return scheduleHasReusableInterval(schedule) ? 'schedule_paused' : 'schedule_disabled';
  if (schedule.kind !== 'interval') return 'invalid_schedule';
  if (!Number.isInteger(schedule.everySeconds) || schedule.everySeconds <= 0) return 'invalid_schedule';
  const nextMs = typeof schedule.nextRunAt === 'string' ? Date.parse(schedule.nextRunAt) : NaN;
  if (Number.isNaN(nextMs)) return 'invalid_schedule';
  return nextMs <= nowMs ? 'due' : 'not_due';
}

function buildProcessTemplateState(template, generatedTickets = [], now = Date.now(), providedCounts = null) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const ordered = (Array.isArray(generatedTickets) ? generatedTickets : []).slice().sort(compareGeneratedTickets);
  const counts = providedCounts ? { ...emptyGeneratedTicketCounts(), ...providedCounts } : countGeneratedTickets(ordered);
  const last = ordered.length > 0 ? ordered[ordered.length - 1] : null;
  const recentGeneratedTickets = ordered.slice(-5).reverse().map(ticket => ({
    ticketId: ticket.id,
    triggerType: ticket.source && ticket.source.triggerType || 'manual',
    status: ticket.status,
    triageReason: isTriaged(ticket) ? ticket.triage.reasonCode || null : null,
    scheduledFor: ticket.source && ticket.source.scheduledFor || null,
    templateVersion: ticket.source && ticket.source.templateVersion || null
  }));
  const dueStatus = computeDueStatus(template, Number.isNaN(nowMs) ? Date.now() : nowMs);

  let healthStatus;
  if (template.enabled !== true) healthStatus = 'disabled';
  else if (dueStatus === 'invalid_schedule') healthStatus = 'invalid_schedule';
  else if (last && (last.status === 'blocked' || isTriaged(last))) healthStatus = 'attention_needed';
  else if (recentGeneratedTickets.some(ticket => ticket.status === 'failed' || ticket.status === 'blocked')) healthStatus = 'attention_needed';
  else if (dueStatus === 'schedule_paused') healthStatus = 'paused';
  else if (counts.total === 0) healthStatus = 'no_recent_triggers';
  else healthStatus = 'ok';

  const schedule = template.schedule || null;
  const ticketTemplate = template.ticketTemplate || {};
  return {
    templateId: template.id,
    name: template.name,
    version: activeVersionNumber(template),
    currentVersionId: template.currentVersionId || null,
    objective: ticketTemplate.objective || '',
    assignmentTargetType: ticketTemplate.assignmentTargetType || null,
    assignmentTargetId: ticketTemplate.assignmentTargetId != null ? ticketTemplate.assignmentTargetId : null,
    enabled: template.enabled === true,
    manualAvailable: template.enabled === true,
    scheduleEnabled: Boolean(schedule && schedule.enabled === true),
    scheduleKind: schedule ? schedule.kind || null : null,
    scheduleEverySeconds: schedule && Number.isInteger(schedule.everySeconds) ? schedule.everySeconds : null,
    nextRunAt: schedule ? schedule.nextRunAt || null : null,
    lastScheduledTriggerAt: schedule ? schedule.lastScheduledTriggerAt || null : null,
    lastTriggeredAt: template.lastTriggeredAt || null,
    lastTriggerType: last ? last.source && last.source.triggerType || null : null,
    lastGeneratedTicketId: last ? last.id : null,
    lastGeneratedTicketStatus: last ? last.status : null,
    lastGeneratedTicketTriageReason: last && isTriaged(last) ? last.triage.reasonCode || null : null,
    generatedTicketCounts: counts,
    recentGeneratedTickets,
    dueStatus,
    healthStatus
  };
}

function deriveProcessTemplateState(templates, tickets, now = Date.now()) {
  const ticketsByTemplate = new Map();
  for (const ticket of Array.isArray(tickets) ? tickets : []) {
    const source = ticket && ticket.source;
    if (!source || source.type !== 'process_template' || source.templateId == null) continue;
    const templateId = Number(source.templateId);
    if (!Number.isSafeInteger(templateId) || templateId <= 0) continue;
    const list = ticketsByTemplate.get(templateId) || [];
    list.push(ticket);
    ticketsByTemplate.set(templateId, list);
  }
  return (Array.isArray(templates) ? templates : []).map(template =>
    buildProcessTemplateState(template, ticketsByTemplate.get(template.id) || [], now)
  );
}

module.exports = {
  activeVersionNumber,
  buildProcessTemplateState,
  deriveProcessTemplateState,
  emptyGeneratedTicketCounts,
  scheduleHasReusableInterval
};
