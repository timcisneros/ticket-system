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
  isAdmissionPaused = () => false,
  // Callers that do not supply journal admission keep the scheduler's prior
  // behavior. The server supplies the bounded admission implementation.
  acquireRunAdmission = () => ({}),
  releaseRunAdmission = () => {},
  runWithAdmission = (_admission, operation) => operation(),
  runner,
  onError
}) {
  let timer = null;
  let ticking = false;
  let idleWaiters = [];

  async function logQueuedOnce(run) {
    const alreadyLogged = readLogs().some(log => log.runId === run.id && log.type === 'run:queued');
    if (alreadyLogged) return;

    await appendEvent({
      type: 'run.queued',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        status: 'queued'
      }
    });
    appendRunLog(run, 'run:queued', 'Queued for local model capacity');
  }

  async function tick() {
    if (ticking) return;
    ticking = true;

    try {
      // Journal capacity pressure is recoverable. Leave pending runs untouched
      // and let the next tick resume automatically after durable appends drain.
      if (isAdmissionPaused()) return;
      if (typeof expireStaleRunLeases === 'function') await expireStaleRunLeases();

      const pendingRuns = readRuns()
        .filter(run => run.status === 'pending')
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

      // Emit scheduler.tick only when there is pending work to observe.
      // Idle ticks (pendingRuns === 0) are no-op heartbeat telemetry and are
      // not written to the append-only evidence log.
      if (pendingRuns.length > 0) {
        await appendEvent({
          type: 'scheduler.tick',
          payload: {
            pendingRuns: pendingRuns.length
          }
        });
      }

      for (const run of pendingRuns) {
        if (isRunStarting(run)) {
          await appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'already_starting' }
          });
          continue;
        }

        if (isRunActiveInMemory(run)) {
          await appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'already_running_in_memory' }
          });
          continue;
        }

        if (!canStartRunNow(run)) {
          await appendEvent({
            type: 'scheduler.capacity_blocked',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'concurrency_limit' }
          });
          await logQueuedOnce(run);
          continue;
        }

        const runAdmission = acquireRunAdmission(run);
        if (!runAdmission) {
          // Another producer acquired the final bounded slot after this tick's
          // initial pressure check. Leave this and later pending runs untouched;
          // the next tick retries after a producer releases capacity.
          break;
        }

        let leasedRun;
        let admissionHeld = true;
        try {
          leasedRun = typeof acquireRunLease === 'function' ? await acquireRunLease(run.id) : run;
        } catch (error) {
          releaseRunAdmission(runAdmission);
          admissionHeld = false;
          throw error;
        }
        if (!leasedRun) {
          releaseRunAdmission(runAdmission);
          admissionHeld = false;
          await appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'lease_not_acquired' }
          });
          continue;
        }

        try {
          await runWithAdmission(runAdmission, async () => {
            await appendEvent({
              type: 'scheduler.run_selected',
              ticketId: leasedRun.ticketId,
              runId: leasedRun.id,
              payload: {
                status: leasedRun.status,
                agentId: leasedRun.agentId
              }
            });
          });
          // Admission protects only lease selection and its evidence. Active
          // runs acquire their own short mutation scopes; they do not occupy a
          // producer slot while waiting on providers or between actions.
          releaseRunAdmission(runAdmission);
          admissionHeld = false;
          runner.startRun(leasedRun);
        } catch (error) {
          if (admissionHeld) releaseRunAdmission(runAdmission);
          throw error;
        }
      }
    } finally {
      ticking = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach(resolve => resolve());
    }
  }

  function reportTickFailure(error) {
    if (typeof onError === 'function') onError(error);
    else console.error(`Runtime scheduler tick failed: ${error && error.message ? error.message : error}`);
  }

  function scheduleTick() {
    void tick().catch(reportTickFailure);
  }

  function start() {
    if (timer) return { tick, stop, isRunning: true };
    scheduleTick();
    timer = setInterval(scheduleTick, intervalMs);
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

  return {
    start,
    stop,
    tick,
    whenIdle,
    isRunning: () => Boolean(timer)
  };
}

module.exports = {
  createRuntimeScheduler
};
