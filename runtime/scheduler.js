function createRuntimeScheduler({
  intervalMs = 500,
  readRuns,
  listPendingRuns = null,
  readLogs,
  appendRunLog,
  appendEvent,
  canStartRunNow,
  getRunStartBlockReason = run => canStartRunNow(run) ? null : 'concurrency_limit',
  tryReserveRunStart = run => ({ runId: run.id }),
  releaseRunStartReservation = () => {},
  acquireRunLease,
  releaseRunLease = null,
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
  let pendingCursor = null;
  let pendingScanEndCursor = null;

  async function readPendingPage() {
    if (typeof listPendingRuns !== 'function') {
      const listed = await readRuns();
      return {
        runs: Array.isArray(listed) ? listed : [],
        nextCursor: null
      };
    }

    const priorCursor = pendingCursor;
    let listed = await listPendingRuns({ cursor: priorCursor, scanEndCursor: pendingScanEndCursor });
    let page = Array.isArray(listed) ? { runs: listed, nextCursor: null } : listed;
    if (!page || !Array.isArray(page.runs)) page = { runs: [], nextCursor: null };

    // A page can empty between ticks as other workers claim its rows. Wrap once
    // immediately so work before the old cursor does not wait for another tick.
    if (page.runs.length === 0 && priorCursor !== null) {
      listed = await listPendingRuns({ cursor: null });
      page = Array.isArray(listed) ? { runs: listed, nextCursor: null } : listed;
      if (!page || !Array.isArray(page.runs)) page = { runs: [], nextCursor: null };
    }
    pendingCursor = page.nextCursor || null;
    pendingScanEndCursor = pendingCursor === null ? null : page.scanEndCursor || pendingScanEndCursor;
    return page;
  }

  async function logQueuedOnce(run, reason) {
    const alreadyLogged = readLogs().some(log => log.runId === run.id && log.type === 'run:queued');
    if (alreadyLogged) return;

    await appendEvent({
      type: 'scheduler.capacity_blocked',
      ticketId: run.ticketId,
      runId: run.id,
      payload: { reason }
    });
    await appendEvent({
      type: 'run.queued',
      ticketId: run.ticketId,
      runId: run.id,
      payload: {
        status: 'queued'
      }
    });
    appendRunLog(run, 'run:queued', `Queued for ${reason.replaceAll('_', ' ')}`);
  }

  async function selectAndDispatchRun(run, runAdmission, startReservation) {
    let admissionHeld = true;
    let reservationHeld = true;
    let leasedRun = null;
    let leaseReleaseAttempted = false;
    const releaseClaimedRun = async reason => {
      if (!leasedRun || leaseReleaseAttempted || typeof releaseRunLease !== 'function') return;
      leaseReleaseAttempted = true;
      await releaseRunLease(leasedRun.id, { reason });
    };
    try {
      leasedRun = await runWithAdmission(runAdmission, async () => {
        const selected = typeof acquireRunLease === 'function' ? await acquireRunLease(run.id) : run;
        if (!selected) {
          await appendEvent({
            type: 'scheduler.run_skipped',
            ticketId: run.ticketId,
            runId: run.id,
            payload: { reason: 'lease_not_acquired' }
          });
          return null;
        }
        // Retain the claim for cleanup even if selection evidence fails below.
        leasedRun = selected;
        await appendEvent({
          type: 'scheduler.run_selected',
          ticketId: selected.ticketId,
          runId: selected.id,
          payload: {
            status: selected.status,
            agentId: selected.agentId
          }
        });
        return selected;
      });

      releaseRunAdmission(runAdmission);
      admissionHeld = false;

      if (!leasedRun) {
        releaseRunStartReservation(startReservation);
        reservationHeld = false;
        return;
      }

      const started = runner.startRun(leasedRun);
      if (started === false) {
        await releaseClaimedRun('runner_start_refused');
        releaseRunStartReservation(startReservation);
        reservationHeld = false;
      }
    } catch (error) {
      if (admissionHeld) releaseRunAdmission(runAdmission);
      await releaseClaimedRun('runner_start_failed');
      if (reservationHeld) releaseRunStartReservation(startReservation);
      throw error;
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;

    try {
      // Journal capacity pressure is recoverable. Leave pending runs untouched
      // and let the next tick resume automatically after durable appends drain.
      if (isAdmissionPaused()) return;
      if (typeof expireStaleRunLeases === 'function') await expireStaleRunLeases();

      const pendingPage = await readPendingPage();
      const pendingRuns = pendingPage.runs
        .filter(run => run.status === 'pending')
        .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));

      // Emit scheduler.tick only when there is pending work to observe.
      // Idle ticks (pendingRuns === 0) are no-op heartbeat telemetry and are
      // not written to the append-only evidence log.
      if (pendingRuns.length > 0) {
        await appendEvent({
          type: 'scheduler.tick',
          payload: {
            pendingRuns: pendingRuns.length,
            selectionTruncated: pendingPage.nextCursor !== null
          }
        });
      }

      const selections = [];
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

        const blockReason = getRunStartBlockReason(run);
        if (blockReason) {
          await logQueuedOnce(run, blockReason);
          // A process-wide limit applies to every later run. Provider-specific
          // pressure does not: keep scanning so another provider can start.
          if (blockReason === 'process_concurrency_limit') break;
          continue;
        }

        const startReservation = tryReserveRunStart(run);
        if (!startReservation) continue;

        const runAdmission = acquireRunAdmission(run);
        if (!runAdmission) {
          // Another producer acquired the final bounded slot after this tick's
          // initial pressure check. Leave this and later pending runs untouched;
          // the next tick retries after a producer releases capacity.
          releaseRunStartReservation(startReservation);
          break;
        }
        // Start all bounded selections before awaiting them. The single writer
        // can group their lease/selection records into durable batches instead
        // of forcing one sync barrier per run.
        selections.push(selectAndDispatchRun(run, runAdmission, startReservation));
      }

      const settledSelections = await Promise.allSettled(selections);
      const failedSelection = settledSelections.find(result => result.status === 'rejected');
      if (failedSelection) {
        throw failedSelection.reason;
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
