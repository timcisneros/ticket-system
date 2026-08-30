#!/usr/bin/env node
'use strict';

// Zero-drift freeze barrier — adversarial verification for the evaluation
// runner's ZERO-DRIFT measurement window.
//
// WHAT IT PROVES:
//
//   A. the product server process has EXITED before the first durable
//      fingerprint (the deterministic freeze barrier, observed at the runner's
//      named probe phase, not inferred from quiescence);
//   B. without adversarial mutation, the durable fingerprints are stable across
//      the frozen read-only window (two reports, three fingerprints);
//   C. a deliberate ticket-scoped durable write between the reports still fails
//      ZERO-DRIFT — the barrier removed the writer, not the detector;
//   D. the failure output carries bounded serialized before/between/after
//      fingerprint evidence, alongside the structured detail;
//   E. one normal fixture-mode trial succeeds end to end with the barrier and
//      truthfully records in its artifact warnings that the server was stopped
//      before the measurement and that quiescence alone did not provide that
//      guarantee.
//
// The probe is the runner's TEST-ONLY seam; production callers pass no probe.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { withHarness } = require('./postgres-test-harness');
const { ARMS } = require('./fixtures/evaluation-arms');
const { getScenario } = require('./fixtures/evaluation-scenarios');
const { runTrial } = require('./structured-allocation-evaluation-runner');

function repositoryCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
  } catch (_) { return 'unknown'; }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function assertServerExited(context, label) {
  const child = context.server && context.server.child;
  assert.ok(child, `${label}: the trial server handle carries its child process`);
  assert.ok(child.exitCode !== null || child.signalCode !== null,
    `${label}: the product server process has exited (exitCode=${child.exitCode}, signalCode=${child.signalCode})`);
  assert.ok(!isPidAlive(child.pid),
    `${label}: the product server pid is no longer alive`);
}

function parseFingerprints(message) {
  const fingerprints = {};
  for (const part of ['before', 'between', 'after']) {
    const match = message.match(new RegExp(`${part}=((?:\\{[^{}]*\\})|null)`));
    assert.ok(match, `the failure message carries the bounded ${part} fingerprint`);
    fingerprints[part] = JSON.parse(match[1]);
  }
  return fingerprints;
}

async function main() {
  const commit = repositoryCommit();
  const smokeRoot = path.join(os.tmpdir(),
    'evaluation-zero-drift-barrier', commit.slice(0, 8));
  fs.mkdirSync(smokeRoot, { recursive: true });
  const namespaceRoot = path.join(smokeRoot, 'namespaces', `${process.pid}-${Date.now()}`);
  fs.mkdirSync(namespaceRoot, { recursive: true });

  const scenario = getScenario('family-3-sibling-dependency');
  const arm = ARMS.A;

  await withHarness('evaluation zero-drift barrier',
    async ({ store, workspaceRoot, startServer }) => {
      // ── Trial 1 — normal fixture-mode trial (A, B, E) ────────────────────
      const observedPhases = [];
      let serverExitedBeforeMeasurement = false;
      const outputPathNormal = path.join(smokeRoot, 'zero-drift-normal.json');
      const artifact = await runTrial({
        store, startServer, workspaceRoot, scenario, arm,
        repetition: 1, seed: 'zero-drift-barrier-normal-seed',
        outputPath: outputPathNormal, commit, smokeRoot, namespaceRoot,
        zeroDriftProbe: async (phase, context) => {
          observedPhases.push(phase);
          if (phase === 'after_server_stop_before_first_fingerprint') {
            assertServerExited(context, 'normal trial');
            serverExitedBeforeMeasurement = true;
          }
        }
      });

      assert.ok(serverExitedBeforeMeasurement,
        'A: the product server process exited before the first fingerprint');
      assert.deepStrictEqual(observedPhases, [
        'after_server_stop_before_first_fingerprint',
        'after_first_report_before_between_fingerprint'
      ], 'the probe observes exactly the two named phases, in order');

      assert.strictEqual(artifact.ticketReport.secondReadIdentical, true,
        'B: without adversarial mutation, the two read-only reports did not drift');
      assert.ok(fs.existsSync(outputPathNormal),
        'E: the normal trial wrote its immutable artifact');

      assert.ok(Array.isArray(artifact.warnings) && artifact.warnings.some(warning =>
        /product server was stopped \(process exited\) before the read-only ZERO-DRIFT measurement/.test(warning) &&
        /quiescence alone did not provide/.test(warning)),
      'E: the artifact truthfully records the freeze barrier and does not imply ' +
      'quiescence provided the guarantee');

      // ── Trial 2 — adversarial write between the reports (C, D) ───────────
      const outputPathAdversarial = path.join(smokeRoot, 'zero-drift-adversarial.json');
      let driftError = null;
      try {
        await runTrial({
          store, startServer, workspaceRoot, scenario, arm,
          repetition: 2, seed: 'zero-drift-barrier-adversarial-seed',
          outputPath: outputPathAdversarial, commit, smokeRoot, namespaceRoot,
          zeroDriftProbe: async (phase, context) => {
            if (phase === 'after_server_stop_before_first_fingerprint') {
              assertServerExited(context, 'adversarial trial');
            }
            if (phase === 'after_first_report_before_between_fingerprint') {
              await context.store.appendEvent({
                type: 'evaluation.zero_drift_adversarial_write',
                ticketId: context.ticketId,
                payload: {
                  probe: 'deliberate ticket-scoped durable write between fingerprints'
                }
              });
            }
          }
        });
      } catch (error) {
        driftError = error;
      }

      assert.ok(driftError,
        'C: a deliberate ticket-scoped durable write between the reports must fail ZERO-DRIFT');
      assert.strictEqual(driftError.name, 'EvaluationRunnerError');
      assert.match(driftError.message, /the read-only report changed durable state/,
        'C: the ZERO-DRIFT contract still fails hard on a mismatch');
      assert.match(driftError.message,
        /before=\{.*\} between=\{.*\} after=\{.*\}/,
        'D: the failure output carries bounded serialized fingerprint evidence');

      const fingerprints = parseFingerprints(driftError.message);
      assert.ok(fingerprints.between.events === fingerprints.before.events + 1,
        `D: the between fingerprint shows exactly the adversarial event write ` +
        `(before=${fingerprints.before.events}, between=${fingerprints.between.events})`);
      assert.deepStrictEqual(fingerprints.after, fingerprints.between,
        'D: the adversarial write landed exactly once, between the fingerprints');
      assert.ok(driftError.detail &&
        driftError.detail.before && driftError.detail.between && driftError.detail.after,
        'D: the structured error detail preserves the raw fingerprints');
      assert.ok(!fs.existsSync(outputPathAdversarial),
        'C: a drifted trial writes no artifact');
    }, { timeoutMs: 3_600_000 });

  console.log('PASS: evaluation zero-drift barrier — the product server is stopped and ' +
    'exited before the ZERO-DRIFT measurement, the window remains stable without ' +
    'adversarial mutation, a deliberate ticket-scoped durable write between the ' +
    'reports still fails hard with before/between/after fingerprint evidence, and a ' +
    'normal fixture-mode trial succeeds with the truthful artifact warning');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
