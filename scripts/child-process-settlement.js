'use strict';

// Deterministic child-process settlement for test harnesses
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// TEST INFRASTRUCTURE ONLY. Nothing here runs in production.
//
// THE DEFECT THIS REPLACES. Seven suites cleaned up like this:
//
//     await new Promise(resolve => child.once('exit', resolve));
//
// `exit` fires once. If the child has ALREADY exited — which is exactly what
// happens when a server dies at startup, the orphan condition — the listener is
// registered on a dead emitter and never fires. The promise never settles, so a
// `finally` block containing it never completes, the surrounding `.catch()` never
// runs, and node exits **0** with the real error never printed. The suite reports
// success having asserted nothing.
//
// That is not a cosmetic bug. It is the difference between a test that failed and
// a test that lied. Four of the seven produced no output at all.
//
// `settleChild` resolves whether the child exited before or after the call, and
// rejects rather than hangs if it somehow does neither. `stopChild` escalates
// SIGTERM → SIGKILL and always settles. Neither ever swallows a caller's error:
// they are cleanup helpers, so they resolve with the child's outcome and let the
// caller's own failure propagate.

const CHILD_ALREADY_EXITED = Symbol('childAlreadyExited');

// True once the process is known to be gone. `exitCode` is set for a normal exit,
// `signalCode` for a signalled one; `killed` alone is NOT sufficient, because it
// only records that a signal was delivered, not that the process has reaped.
function childHasExited(child) {
  if (!child) return true;
  return child.exitCode !== null || child.signalCode !== null;
}

// Resolve once the child is gone. Safe to call at any point in its lifetime,
// including after it has already exited, and safe to call more than once.
function settleChild(child, { timeoutMs = 15000 } = {}) {
  if (!child) return Promise.resolve({ code: null, signal: null, alreadyExited: true });

  if (childHasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode, alreadyExited: true });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      child.removeListener('error', onError);
      resolve(outcome);
    };
    const onExit = (code, signal) => finish({ code, signal, alreadyExited: false });
    // A spawn failure (ENOENT and friends) emits `error` and may never emit `exit`.
    // Treating it as settled-with-error keeps cleanup from hanging on it.
    const onError = error => finish({ code: null, signal: null, alreadyExited: false, error });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', onExit);
      child.removeListener('close', onExit);
      child.removeListener('error', onError);
      // Loud on purpose. A hang here previously presented as a passing test; it must
      // now present as a failure the caller has to deal with.
      reject(new Error(
        `child process did not exit within ${timeoutMs}ms (pid ${child.pid}); ` +
        'it was not reaped and cleanup cannot proceed'
      ));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.once('exit', onExit);
    child.once('error', onError);
    // `exit` can be missed in rare races where the stdio streams close first;
    // `close` is a belt-and-braces second chance, and finish() is idempotent.
    child.once('close', onExit);

    // Re-check after registering: the child may have exited between the guard above
    // and the listener registration.
    if (childHasExited(child)) {
      finish({ code: child.exitCode, signal: child.signalCode, alreadyExited: true });
    }
  });
}

// Terminate a child and wait for it to actually go away. Escalates to SIGKILL if
// the graceful signal is ignored, and always settles.
async function stopChild(child, { signal = 'SIGTERM', graceMs = 5000, killMs = 10000 } = {}) {
  if (!child || childHasExited(child)) {
    return { code: child ? child.exitCode : null, signal: child ? child.signalCode : null, alreadyExited: true };
  }

  try { child.kill(signal); } catch (_) { /* already gone */ }

  try {
    return await settleChild(child, { timeoutMs: graceMs });
  } catch (_) {
    // Graceful shutdown did not land. Escalate.
  }

  try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
  return settleChild(child, { timeoutMs: killMs });
}

// Vacuity floor. A suite that runs to completion having executed nothing must not
// be allowed to exit zero — that is the same failure mode as the hung `finally`,
// reached by a different route.
//
// `minAssertions` defaults to 1 rather than 0 deliberately: "no assertions ran" is
// never a valid successful outcome for a suite that claims to test something.
function assertScenariosExecuted({
  label,
  assertions,
  scenarios = null,
  minAssertions = 1,
  minScenarios = 1
} = {}) {
  const name = label || 'suite';
  if (!Number.isInteger(assertions) || assertions < minAssertions) {
    throw new Error(
      `${name} executed ${assertions} assertion(s), expected at least ${minAssertions}. ` +
      'A suite that asserts nothing has not passed; it has failed to run.'
    );
  }
  if (scenarios !== null && (!Number.isInteger(scenarios) || scenarios < minScenarios)) {
    throw new Error(
      `${name} executed ${scenarios} scenario(s), expected at least ${minScenarios}. ` +
      'A suite whose scenarios never ran has not passed; it has failed to run.'
    );
  }
  return { assertions, scenarios };
}

module.exports = {
  CHILD_ALREADY_EXITED,
  childHasExited,
  settleChild,
  stopChild,
  assertScenariosExecuted
};
