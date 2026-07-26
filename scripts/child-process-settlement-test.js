#!/usr/bin/env node
'use strict';
// Tests for scripts/child-process-settlement.js
// (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// Deterministic: spawns short-lived `node -e` children only. No database, no server.
//
// The case that matters most is "child already exited". That is the exact state the
// seven silent suites hit — server dies at startup, cleanup registers an `exit`
// listener on a dead emitter, the promise never settles, and the suite exits 0 with
// the real failure unprinted. Every other case here is a guard around that one.

const assert = require('assert/strict');
const { spawn } = require('child_process');
const {
  childHasExited, settleChild, stopChild, assertScenariosExecuted
} = require('./child-process-settlement');

let passed = 0;
function check(description, condition) {
  if (!condition) throw new Error(`FAILED: ${description}`);
  passed += 1;
  console.log(`  ok ${description}`);
}

function spawnNode(source) {
  return spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'ignore'] });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A settle call that must NOT hang. Races the helper against a watchdog so a
// regression surfaces as a failed assertion instead of a hung test run.
async function settleWithin(child, budgetMs, options) {
  const watchdog = sleep(budgetMs).then(() => { throw new Error(`settleChild did not settle within ${budgetMs}ms`); });
  return Promise.race([settleChild(child, options), watchdog]);
}

async function main() {
  // ── 1. Child still running when settle is called ─────────────────────────
  {
    const child = spawnNode('setTimeout(() => process.exit(0), 250);');
    check('1: a live child is not reported as exited', childHasExited(child) === false);
    const outcome = await settleWithin(child, 5000);
    check('1: settleChild resolves once the running child exits', outcome.code === 0);
    check('1: the outcome records that it had not already exited', outcome.alreadyExited === false);
    check('1: the child is reported exited afterwards', childHasExited(child) === true);
  }

  // ── 2. Child ALREADY exited — the defect this helper exists for ──────────
  {
    const child = spawnNode('process.exit(3);');
    await settleWithin(child, 5000);
    check('2: the child has exited before the second call', childHasExited(child) === true);
    // The old pattern hung forever here. This must return immediately.
    const started = Date.now();
    const outcome = await settleWithin(child, 2000);
    check('2: settleChild on an already-exited child resolves', outcome.code === 3);
    check('2: it reports that the child had already exited', outcome.alreadyExited === true);
    check('2: it resolves immediately rather than waiting for an event that will never fire',
      Date.now() - started < 1000);
  }

  // ── 3. Normal exit codes are reported faithfully ─────────────────────────
  {
    const zero = await settleWithin(spawnNode('process.exit(0);'), 5000);
    check('3: a zero exit is reported as 0', zero.code === 0);
    const nonZero = await settleWithin(spawnNode('process.exit(42);'), 5000);
    check('3: a non-zero exit is reported faithfully', nonZero.code === 42);
    check('3: a normal exit carries no signal', nonZero.signal === null);
  }

  // ── 4. Forced termination ────────────────────────────────────────────────
  {
    // Ignores SIGTERM, so stopChild must escalate to SIGKILL.
    const stubborn = spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    await sleep(300);
    const outcome = await stopChild(stubborn, { graceMs: 700, killMs: 5000 });
    check('4: stopChild settles a child that ignores SIGTERM', childHasExited(stubborn) === true);
    check('4: the forced termination is reported as a signal', outcome.signal === 'SIGKILL');

    // A cooperative child should stop on the graceful signal, without SIGKILL.
    const cooperative = spawnNode("process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);");
    await sleep(300);
    const graceful = await stopChild(cooperative, { graceMs: 5000 });
    check('4: a cooperative child stops on SIGTERM without escalation', graceful.code === 0);

    // stopChild on an already-dead child is a no-op, not a hang.
    const dead = spawnNode('process.exit(7);');
    await settleWithin(dead, 5000);
    const repeat = await Promise.race([
      stopChild(dead, { graceMs: 1000 }),
      sleep(2000).then(() => { throw new Error('stopChild hung on an already-exited child'); })
    ]);
    check('4: stopChild on an already-exited child returns its outcome', repeat.code === 7);
    check('4: and reports it as already exited', repeat.alreadyExited === true);
  }

  // ── 5. A child that never exits reaches the caller as a REJECTION ────────
  // The old pattern turned this into a silent hang and then a zero exit. It must
  // now be an error the caller cannot ignore.
  {
    const immortal = spawnNode("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    await sleep(200);
    let rejected = false;
    let message = '';
    try {
      await settleChild(immortal, { timeoutMs: 600 });
    } catch (error) {
      rejected = true;
      message = error.message;
    }
    check('5: settleChild rejects rather than hanging when the child will not exit', rejected === true);
    check('5: the rejection explains that cleanup cannot proceed', /did not exit within/.test(message));
    immortal.kill('SIGKILL');
    await settleWithin(immortal, 5000);
  }

  // Spawn failure must also reach the caller rather than hanging.
  {
    const missing = spawn('this-binary-does-not-exist-a20', [], { stdio: 'ignore' });
    const outcome = await settleWithin(missing, 5000, { timeoutMs: 4000 });
    check('5: a spawn failure settles instead of hanging', Boolean(outcome.error) || outcome.code !== undefined);
  }

  // ── 6. No successful zero-assertion exit ─────────────────────────────────
  {
    let threw = false;
    try { assertScenariosExecuted({ label: 'demo', assertions: 0 }); } catch (_) { threw = true; }
    check('6: zero assertions is rejected as a failure to run', threw === true);

    threw = false;
    try { assertScenariosExecuted({ label: 'demo', assertions: 5, scenarios: 0 }); } catch (_) { threw = true; }
    check('6: zero scenarios is rejected even when assertions ran', threw === true);

    threw = false;
    try { assertScenariosExecuted({ label: 'demo', assertions: 3, minAssertions: 10 }); } catch (_) { threw = true; }
    check('6: falling below a declared assertion floor is rejected', threw === true);

    const ok = assertScenariosExecuted({ label: 'demo', assertions: 12, scenarios: 4 });
    check('6: a suite that actually ran is accepted', ok.assertions === 12 && ok.scenarios === 4);
  }

  console.log(`\nPASS: child-process settlement — ${passed} assertions`);
}

main().catch(error => {
  console.error(`\nFAIL: child-process settlement — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
