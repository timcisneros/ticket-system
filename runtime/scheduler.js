function createRuntimeScheduler({
  intervalMs = 500,
  readRuns,
  readLogs,
  appendRunLog,
  appendEvent,
  canStartRunNow,
  acquireRunLease,
  expireStaleRunLeases,
  isRunStarting,
  isRunActiveInMemory,
  runner
}) {
  let timer = null;
  let ticking = false;

  function logQueuedOnce(run) {
    const alreadyLogged = readLogs().some(log => log.runId === run.id && log.type === 'run:queued');
    if (alreadyLogged) return;

    appendEvent({
      type: 'run.queued',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        status: 'queued'
      }
    });
    appendRunLog(run, 'run:queued', 'Queued for local model capacity');
  }

  function tick() {
    if (ticking) return;
    ticking = true;

    try {
      if (typeof expireStaleRunLeases === 'function') expireStaleRunLeases();

      const pendingRuns = readRuns()
        .filter(run => run.status === 'pending')
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

      // Emit scheduler.tick only when there is pending work to observe.
      // Idle ticks (pendingRuns === 0) are no-op heartbeat telemetry and are
      // not written to the append-only evidence log.
      if (pendingRuns.length > 0) {
        appendEvent({
          type: 'scheduler.tick',
          payload: {
            pendingRuns: pendingRuns.length
          }
        });
      }

      for (const run of pendingRuns) {
        if (isRunStarting(run)) {
          appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'already_starting' }
          });
          continue;
        }

        if (isRunActiveInMemory(run)) {
          appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'already_running_in_memory' }
          });
          continue;
        }

        if (!canStartRunNow(run)) {
          appendEvent({
            type: 'scheduler.capacity_blocked',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'concurrency_limit' }
          });
          logQueuedOnce(run);
          continue;
        }

        const leasedRun = typeof acquireRunLease === 'function' ? acquireRunLease(run.id) : run;
        if (!leasedRun) {
          appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'lease_not_acquired' }
          });
          continue;
        }

        appendEvent({
          type: 'scheduler.run_selected',
          ticketId: leasedRun.ticketId,
          runId: leasedRun.id,
          payload: {
            status: leasedRun.status,
            agentId: leasedRun.agentId
          }
        });
        runner.startRun(leasedRun);
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return { tick, stop, isRunning: true };
    tick();
    timer = setInterval(tick, intervalMs);
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
  createRuntimeScheduler
};
