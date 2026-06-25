'use strict';

// Separate, slow scheduler that creates ordinary tickets from due process-template
// schedules. It is deliberately NOT the runtime run scheduler (runtime/scheduler.js):
// it never reads runs, acquires leases, checks capacity, calls startRun, creates
// runs, or mutates the workspace. Its only action is to ask the host to trigger a
// due template, which routes through the shared triggerProcessTemplate →
// createTicketFromInput → createRunsForTicket path (inheriting every existing gate).
//
// No historical catch-up: at most ONE trigger per template per tick. The host
// advances schedule.nextRunAt forward from "now" after a trigger (or a deduped
// re-entry), so a long downtime produces a single current-slot ticket, never a storm.
//
// tick() is synchronous and drivable directly (tests call it via a host endpoint with
// a controlled schedule state — no wall-clock sleeps).
function createTemplateScheduler({
  intervalMs = 60000,
  readProcessTemplates,
  triggerDueTemplate,      // (template, scheduledForIso) => triggerResult  (host-provided)
  now = () => new Date(),
  onError = () => {}
}) {
  let timer = null;
  let ticking = false;

  function isDue(template, currentMs) {
    if (!template || template.enabled !== true) return false;
    const s = template.schedule;
    if (!s || s.enabled !== true || s.kind !== 'interval') return false;
    if (!Number.isInteger(s.everySeconds) || s.everySeconds <= 0) return false;
    if (typeof s.nextRunAt !== 'string') return false;
    const nextMs = Date.parse(s.nextRunAt);
    if (Number.isNaN(nextMs)) return false;
    return nextMs <= currentMs;
  }

  function tick() {
    if (ticking) return [];
    ticking = true;
    const results = [];
    try {
      const currentMs = now().getTime();
      const templates = readProcessTemplates() || [];
      for (const template of templates) {
        let due = false;
        try {
          due = isDue(template, currentMs);
        } catch (error) {
          onError(template, error);
          results.push({ templateId: template && template.id, action: 'error' });
          continue;
        }
        if (!due) continue;

        // Deterministic slot boundary = the schedule's current nextRunAt. The host
        // builds the deterministic token schedule:<id>:<scheduledForIso> from this.
        const scheduledForIso = template.schedule.nextRunAt;
        try {
          const result = triggerDueTemplate(template, scheduledForIso);
          results.push({
            templateId: template.id,
            action: result && result.deduped ? 'deduped' : (result && result.ok ? 'created' : 'error'),
            ticketId: result && result.ticketId
          });
        } catch (error) {
          onError(template, error);
          results.push({ templateId: template.id, action: 'error' });
        }
      }
    } finally {
      ticking = false;
    }
    return results;
  }

  function start() {
    if (timer) return { tick, stop, isRunning: true };
    // First scan happens one interval after boot (no immediate startup scan), so
    // startup never replays missed slots beyond the single current due slot.
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
    return { tick, stop, isRunning: true };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => Boolean(timer)
  };
}

module.exports = {
  createTemplateScheduler
};
