'use strict';

// Separate, bounded scheduler that creates ordinary tickets from due
// process-template schedules. Due discovery belongs to the persistence authority:
// PostgreSQL uses its partial due index while preserving the active
// scan. The scheduler never reads runs, acquires leases, or mutates a workspace.
function createTemplateScheduler({
  intervalMs = 60000,
  listDueProcessTemplates,
  triggerDueTemplate,
  candidateLimit = 100,
  isAdmissionPaused = () => false,
  now = () => new Date(),
  onError = () => {}
}) {
  if (typeof listDueProcessTemplates !== 'function') throw new TypeError('listDueProcessTemplates must be a function');
  if (typeof triggerDueTemplate !== 'function') throw new TypeError('triggerDueTemplate must be a function');
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit <= 0) throw new TypeError('candidateLimit must be a positive safe integer');
  let timer = null;
  let ticking = false;
  let idleWaiters = [];

  async function tick() {
    if (ticking) return [];
    ticking = true;
    const results = [];
    try {
      if (isAdmissionPaused()) return results;
      const dueAt = now().toISOString();
      const templates = await listDueProcessTemplates({ dueAt, limit: candidateLimit });
      if (!Array.isArray(templates)) throw new TypeError('listDueProcessTemplates must return an array');
      if (templates.length > candidateLimit) throw new RangeError('due process-template result exceeds candidateLimit');
      for (const template of templates) {
        const scheduledForIso = template && template.schedule && template.schedule.nextRunAt;
        try {
          const result = await triggerDueTemplate(template, scheduledForIso);
          results.push({
            templateId: template && template.id,
            action: result && result.stale ? 'stale' : (result && result.deduped ? 'deduped' : (result && result.ok ? 'created' : 'error')),
            ticketId: result && result.ticketId
          });
        } catch (error) {
          onError(template, error);
          results.push({ templateId: template && template.id, action: 'error' });
        }
      }
    } finally {
      ticking = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach(resolve => resolve());
    }
    return results;
  }

  function scheduleTick() {
    void tick().catch(error => onError(null, error));
  }

  function start() {
    if (timer) return { tick, stop, isRunning: true };
    timer = setInterval(scheduleTick, intervalMs);
    if (timer.unref) timer.unref();
    return { tick, stop, isRunning: true };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function whenIdle() {
    if (!ticking) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
  }

  return { start, stop, tick, whenIdle, isRunning: () => Boolean(timer) };
}

module.exports = { createTemplateScheduler };
