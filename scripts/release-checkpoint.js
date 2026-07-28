#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const CHECKPOINT_TEST_SCRIPTS = Object.freeze([
  'bounded-worker-pool-test.js',
  'business-scenario-contracts-test.js',
  'dev-environment-test.js',
  'catalog-consistency-test.js',
  'action-contract-streak-test.js',
  'evidence-truthfulness-contract-test.js',
  'event-integrity-negative-test.js',
  'execution-semantics-snapshot-test.js',
  'mutation-admission-contract-test.js',
  'mutation-admission-scheduler-test.js',
  'no-tracked-provider-keys-test.js',
  'objective-contract-compiler-test.js',
  'objective-contract-parity-test.js',
  'operation-batch-test.js',
  'organization-guidance-test.js',
  'phase-gated-catalog-behavioral-test.js',
  'process-execution-contract-test.js',
  'process-launch-plan-test.js',
  'process-target-catalog-test.js',
  'postgres-persistence-contract-test.js',
  'recovery-state-reconstruction-test.js',
  'run-decision-graph-projection-test.js',
  'scheduler-observability-test.js',
  'workspace-fixture-catalog-test.js',
  'workspace-snapshot-availability-test.js',
  'run-evidence-drain-test.js',
  'release-checkpoint-coverage-test.js',
  // A20 — deterministic suites that pass today and were never registered. Nothing
  // was wrong with them; nothing ran them either, which is the same gap that let the
  // cutover orphans rot unnoticed. scripts/test-manifest.js now classifies every
  // test file, and the coverage test fails if a required one is missing here.
  'telemetry-test.js',
  'workload-profile-test.js',
  'archive-local-events-test.js',
  'mutating-limit-context-regression-test.js',
  // A20 tranche 2 — the shared child-settlement helper that removes the
  // silent-success failure mode from the orphaned suites. Deterministic: it spawns
  // only short-lived `node -e` children.
  'child-process-settlement-test.js'
]);

const POSTGRES_INTEGRATION_SCRIPTS = Object.freeze([
  'postgres-persistence-integration-test.js',
  'postgres-runtime-cutover-test.js',
  'page-render-regression-test.js',
  'postgres-startup-recovery-test.js',
  'provider-response-recovery-postgres-test.js',
  'process-execution-runtime-test.js',
  'lease-renewal-resume-safety-test.js',
  'model-contract-violation-test.js',
  'model-contract-violation-recovery-test.js',
  'execution-semantics-persistence-test.js',
  'workspace-snapshot-recovery-test.js',
  'operation-receipt-projection-test.js',
  'run-consequence-mutation-test.js',
  'required-replay-evidence-test.js',
  'delegated-run-logging-containment-test.js',
  'reconciliation-evidence-failure-test.js',
  // A10 — PostgreSQL runtime integrity suites, restored from the JSON-era orphans.
  // Registered here rather than in CHECKPOINT_TEST_SCRIPTS because every one of them
  // exercises the real PostgreSQL runtime and has no in-memory fallback. Until this
  // block existed the checkpoint stayed green while these suites rotted, which is the
  // gap A10 was opened for. scripts/suite-mutation-test.js proves a representative
  // sample of them still fails when the contract they guard is removed; it is
  // deliberately NOT registered because it edits tracked source in place.
  'ticket-feasibility-gate-test.js',
  'resume-obvious-postcondition-test.js',
  'direct-folder-postcondition-completeness-test.js',
  'runtime-feasibility-test.js',
  'recovery-regression-test.js',
  'postcondition-completion-test.js',
  'startup-data-integrity-test.js',
  'run-detail-evidence-clarity-test.js',
  'run-diagnostics-bundle-test.js',
  'bounded-transition-test.js',
  'replay-snapshot-storage-test.js',
  'runtime-limits-config-test.js',
  'runtime-limits-ui-test.js',
  'renamepath-runtime-regression-test.js',
  // A20 — the two confirmed orphans repaired in this tranche, plus two suites that
  // already exercised the PostgreSQL store and were nonetheless unregistered.
  'concurrency-conflict-test.js',
  'run-detail-permissioned-delete-audit-test.js',
  'operator-visibility-test.js',
  'oquery-parity-test.js',
  // A13 — behavioral replacements for the five retired source-extraction suites.
  // Those read server.js as text and evaluated extracted helpers, so they broke on
  // internal structure while the behavior they guarded stayed live and uncovered.
  'rerun-mode-evidence-test.js',
  'operation-poststate-observation-test.js',
  // A20 tranche 2 — repaired from cutover-orphan-silent.
  'status-transition-evidence-test.js',
  // A21 — reinstated once truthful reassignment was implemented. This suite is the
  // regression test for that fix; it was excluded as blocked-by-defect while the
  // production behavior it asserts was broken.
  'assignment-audit-test.js',
  // A22 — reinstated once the prepared-intent projection exposed its persisted
  // pre-state. Drives four crash seams; three of them are exercised by nothing else.
  'resumable-execution-test.js',
  // A20 — authority/gate residue split out of operational-abuse-test.js. Protected-path
  // and containment refusal had only pure-classifier coverage before this.
  'workspace-authority-gate-test.js',
  // A20 — replacements for the last two silent orphans. Workflow composition
  // (executeActionPlan / executeTicketPlan) had NO registered coverage at all before
  // these, and no suite asserted prompt content.
  'workflow-action-plan-test.js',
  'workflow-ticket-plan-test.js',
  'workflow-prompt-composition-test.js',
  // A20 — the only suite driving `after_first_workspace_target_effect`, the crash
  // window where the external effect has landed and its evidence has not.
  'target-operation-reconciliation-test.js',
  // A23 — the last three deterministic crash seams: run created, death before the
  // atomic terminalization bundle, and death immediately after it committed.
  'terminalization-boundary-recovery-test.js',
  // A20 — the authority half split out of rbac-and-inline-data-security-test.js.
  'permission-escalation-boundary-test.js',
  // A20 — the authority-evidence half of ticket-timeline-authority-visibility-test.js.
  'timeline-authority-evidence-test.js',
  // A20 — the authority core (scope admission + owned-path enforcement) split out of
  // allocated-regression-test.js.
  'allocation-scope-authority-test.js',
  // A20 — allocation attribution and provider-secret redaction, contracts 2 and 3 of
  // the five split out of allocated-regression-test.js.
  'allocation-attribution-redaction-test.js',
  // A20 — allocation lifecycle isolation, the fifth and final contract split out of
  // allocated-regression-test.js.
  'allocation-lifecycle-isolation-test.js',
  // A20 — the injection-security half split out of rbac-and-inline-data-security-test.js.
  'inline-data-injection-test.js',
  // A20 — the two halves of the retired state-agreement-completion-test.js:
  // what an operator may mark completed, and what startup concludes about
  // tickets whose runs already finished.
  'completion-admission-test.js',
  'startup-state-convergence-test.js',
  // A20 — replaces the JSON-era verification-contract-reconciliation-test.js.
  'verification-contract-authority-test.js',
  // A20 — replaces the JSON-era event-journal-record-rejection-test.js. Covers the
  // request-scoped rejection / latched evidence-failure distinction end to end.
  'event-record-limit-containment-test.js',
  // Lock-order regression for the _appendEvent deadlock: pins that every evidence
  // writer takes the run row before the event chain tip.
  'event-append-lock-order-test.js',
  // A20 — replaces the JSON-era event-journal-admission-recovery-test.js. Pins the
  // recoverable-backpressure versus latched-failure distinction on the admission side.
  'mutation-admission-backpressure-test.js',
  // A20 — replaces the JSON-era operational-transparency-test.js. Pins that the
  // deployment-wide operational summary is ops:read-gated and writes nothing.
  'operational-summary-readonly-test.js',
  // A20 — replaces the JSON-era tm2-evidence-preservation-test.js. Proves later model
  // turns are told truthfully what earlier turns did and why they were asked again.
  'carried-evidence-preservation-test.js',
  // A20 — completes ticket-timeline-authority-visibility-test.js: receipt dedupe across
  // the event journal and replay, triage projection, and template provenance.
  'timeline-receipt-projection-test.js',
  // A20 — replaces the JSON-era invalid-action-preflight-recovery-test.js. Pins that the
  // whole action batch is validated before any action executes.
  'action-batch-preflight-test.js',
  // A20 — replaces the JSON-era browser-evidence-audit-test.js. Pins the durable
  // browser-evidence verdict in both places the runtime writes it, so a model's claim
  // of success can never stand in for captured page text or DOM observation.
  'browser-evidence-verdict-test.js',
  // A20 — replaces the five JSON-era er* recoverable-error orphans. Pins the one
  // discriminator that separates an environmental workspace failure (contained, the
  // model gets one more turn) from a policy refusal (terminal, recorded as blocked).
  'workspace-error-containment-test.js',
  // A20 — replaces the three JSON-era rerun-gate orphans. The only coverage of what
  // may start new work after a run stops: unresolved ticket triage and the attempt
  // ceiling, on the rerun, retry and reopen paths.
  'rerun-admission-gate-test.js',
  // A24 — the provider-input privacy boundary: workspace-relative paths leave this
  // machine, host filesystem locations do not, and the durable record keeps both.
  'provider-input-privacy-test.js',
  // A25 — bounded automatic retry: default-off, ceiling-bounded, and allowed only for
  // the runtime_failed classification. The feature had never worked; see A25.
  'auto-retry-bounds-test.js',
  // A26 — committed-mutation evidence: one authority for the retry decision and the
  // finalized replay, counted from receipts, once per operation, failing closed.
  'run-mutation-evidence-test.js'
]);

function runCheckpoint() {
  if (!process.env.TEST_DATABASE_URL) {
    console.error('CHECKPOINT FAILED: TEST_DATABASE_URL is required for the Postgres release checkpoint');
    process.exit(1);
  }
  const allScripts = [...CHECKPOINT_TEST_SCRIPTS, ...POSTGRES_INTEGRATION_SCRIPTS];
  const missing = allScripts.filter(name => !fs.existsSync(path.join(ROOT, 'scripts', name)));
  if (missing.length) {
    console.error(`CHECKPOINT FAILED: missing test scripts: ${missing.join(', ')}`);
    process.exit(1);
  }
  const checks = [
    { label: 'project-wide JavaScript syntax', script: 'check-js-syntax.js' },
    ...allScripts.map(script => ({ label: script, script }))
  ];
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' };
  const startedAt = Date.now();
  let passed = 0;
  for (const check of checks) {
    console.log(`\n$ node scripts/${check.script}`);
    const result = spawnSync(process.execPath, [path.join('scripts', check.script)], {
      cwd: ROOT,
      env,
      stdio: 'inherit'
    });
    if (result.error || result.status !== 0) {
      console.error(`\nCHECKPOINT FAILED: ${check.label}${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`);
      console.error(`${passed}/${checks.length} checks passed before the failure.`);
      process.exit(result.status || 1);
    }
    passed += 1;
  }
  console.log(`\nRELEASE CHECKPOINT PASSED: ${passed}/${checks.length} checks in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

module.exports = { CHECKPOINT_TEST_SCRIPTS, POSTGRES_INTEGRATION_SCRIPTS };

if (require.main === module) runCheckpoint();
