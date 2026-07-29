'use strict';

// Canonical test manifest (docs/ARCHITECTURAL_DECISIONS_PENDING.md, A20).
//
// WHY THIS FILE EXISTS. The PostgreSQL cutover orphaned test suites in bulk and
// nothing detected it, because the release checkpoint only knows about the suites
// somebody remembered to register. A20's inventory found 85 orphaned suites against
// A10's recorded 14, plus six that PASS today and were never registered at all — a
// gap no filename heuristic can close, because live-provider, manual-demo, mutation
// and source-coupled suites are all legitimately excluded.
//
// This manifest is the authority. Every `scripts/*-test.js` file must appear here
// exactly once, and `scripts/release-checkpoint-coverage-test.js` enforces that plus
// the consistency rules below. A new test file that nobody classifies FAILS THE
// CHECKPOINT — which is the whole point: silence is no longer a valid state.
//
// Run `node scripts/test-manifest.js` for the current inventory.
//
// STATUSES
//
//   required  — must be registered in the release checkpoint. Where it runs is
//               determined by which list in scripts/release-checkpoint.js holds it:
//               CHECKPOINT_TEST_SCRIPTS (deterministic, no database) or
//               POSTGRES_INTEGRATION_SCRIPTS (real PostgreSQL).
//
//   orphaned  — a genuine PostgreSQL-cutover orphan with a repair obligation. It
//               guards a contract but cannot currently run. NOT registered, because
//               registering a failing suite would only break the checkpoint. This is
//               the A20 backlog, and its size is the honest measure of the gap.
//
//   excluded  — deliberately outside the checkpoint, permanently or until a separate
//               entry moves it. Every exclusion carries a reason from EXCLUSION_REASONS.
//               Note `blocked-by-defect`: the suite is correct and FAILS because
//               production is broken. Excluding it keeps the checkpoint honest; the
//               alternative — weakening the assertion until it passes — would hide the
//               defect the suite exists to catch.
//
// Moving a file between statuses is a disposition decision and belongs in the A20
// entry with its evidence — not a quiet edit here.

// Why a suite is deliberately not in the checkpoint.
const EXCLUSION_REASONS = Object.freeze({
  'live-provider':
    'Requires a real external model provider (OpenAI key, or a running Ollama at ' +
    'localhost:11434). Cannot run deterministically in CI and must not gate a release.',
  'manual-demo':
    'An operator-driven demo or stress runner, not a regression suite. Expects a ' +
    'developer server on the dev port and/or reads .local-data, and several write ' +
    'into the repository working tree. Kept for manual use; never automated.',
  'mutation-tool':
    'Deliberately edits tracked source in place to prove other suites are not vacuous. ' +
    'Running it inside the checkpoint would mutate the tree under the very suites it ' +
    'is validating. Invoked explicitly instead.',
  'superseded':
    'Every scenario it guarded is now covered by named registered successors, recorded ' +
    'scenario by scenario in the A20 entry. Retained on disk rather than deleted so the ' +
    'mapping can be re-checked; it is not run, and its coverage is not lost.',
  'blocked-by-defect':
    'Repaired, PostgreSQL-native, and correct — and it FAILS, because the production ' +
    'behavior it asserts is broken. Excluded so the checkpoint stays honest rather ' +
    'than green, not because the suite is wrong. The defect carries its own register ' +
    'entry; this classification reverts to required the moment that entry is fixed.',
  'source-coupled-other':
    'Same source-extraction coupling as the A13 suites but outside A13 scope, because ' +
    'the helpers they assert were not part of the commit-idempotency removal. Needs its ' +
    'own disposition; recorded in A20 rather than left unexplained.'
});

// Why a suite is orphaned, and how its failure presents.
const ORPHAN_REASONS = Object.freeze({
  'cutover-orphan':
    'JSON-era harness orphaned by the PostgreSQL cutover: it seeds a DATA_DIR the ' +
    'runtime no longer reads and spawns a server with no DATABASE_URL. Fails loudly, ' +
    'either with "DATABASE_URL is required for the PostgreSQL runtime" or with the ' +
    'downstream readiness timeout that masks it.',
  'cutover-orphan-silent':
    'The same cutover orphan, but its failure is UNOBSERVABLE. Cleanup awaits ' +
    "child.once('exit') with no guard for an already-exited child, so when the server " +
    'dies at startup the finally block never settles, the .catch() never runs, and node ' +
    'exits 0 having asserted nothing. More dangerous than a loud orphan: registering one ' +
    'of these would create permanent false confidence.'
});

// Every scripts/*-test.js file, classified. Alphabetical.
const TESTS = Object.freeze([
  { file: "suite-mutation-test.js", status: "excluded", reason: "mutation-tool" },
  { file: "action-contract-streak-test.js", status: "required" },
  { file: "agent-behavior-simulation-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "agent-handoff-queue-protocol-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "agent-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "allocated-live-openai-test.js", status: "excluded", reason: "live-provider" },
  { file: "allocation-attribution-redaction-test.js", status: "required" },
  { file: "allocation-lifecycle-isolation-test.js", status: "required" },
  { file: "allocation-scope-authority-test.js", status: "required" },
  { file: "archive-local-events-test.js", status: "required" },
  { file: "artifact-prediction-capture-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "artifact-projection-status-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "assignment-audit-test.js", status: "required" },
  { file: "attempt-usage-visibility-test.js", status: "orphaned", reason: "cutover-orphan" },
  // A26: partially superseded by auto-retry-bounds-test.js. RETAINED because its
  // "runtime failure with mutation never retries" scenario has no destination
  // while the mutated-run guard is inert. Retire it when A26 is implemented.
  { file: "auto-retry-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "batch-workload-validation-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "bounded-transition-test.js", status: "required" },
  { file: "bounded-watcher-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "bounded-worker-pool-test.js", status: "required" },
  { file: "browser-environment-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "browser-evidence-verdict-test.js", status: "required" },
  { file: "browser-read-result-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "browser-target-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "budget-visibility-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "business-scenario-contracts-test.js", status: "required" },
  { file: "catalog-consistency-test.js", status: "required" },
  { file: "child-process-settlement-test.js", status: "required" },
  { file: "completion-admission-test.js", status: "required" },
  { file: "completion-decision-contract-test.js", status: "required" },
  { file: "completion-decision-postgres-test.js", status: "required" },
  { file: "startup-state-convergence-test.js", status: "required" },
  { file: "verification-contract-authority-test.js", status: "required" },
  { file: "event-record-limit-containment-test.js", status: "required" },
  { file: "mutation-admission-backpressure-test.js", status: "required" },
  { file: "operational-summary-readonly-test.js", status: "required" },
  { file: "carried-evidence-preservation-test.js", status: "required" },
  { file: "timeline-receipt-projection-test.js", status: "required" },
  { file: "action-batch-preflight-test.js", status: "required" },
  { file: "event-append-lock-order-test.js", status: "required" },
  { file: "complete-flag-truncation-guard-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "concurrency-conflict-test.js", status: "required" },
  { file: "debug-reset-contamination-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "delegated-run-logging-containment-test.js", status: "required" },
  { file: "demo-seed-test.js", status: "excluded", reason: "manual-demo" },
  { file: "dev-environment-test.js", status: "required" },
  { file: "direct-folder-postcondition-completeness-test.js", status: "required" },
  { file: "dynamic-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "workspace-error-containment-test.js", status: "required" },
  { file: "rerun-admission-gate-test.js", status: "required" },
  { file: "provider-input-privacy-test.js", status: "required" },
  { file: "auto-retry-bounds-test.js", status: "required" },
  { file: "run-mutation-evidence-test.js", status: "required" },
  { file: "event-chain-restart-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "event-integrity-negative-test.js", status: "required" },
  { file: "evidence-truthfulness-contract-test.js", status: "required" },
  { file: "exact-delete-target-absent-guard-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "execution-semantics-persistence-test.js", status: "required" },
  { file: "execution-semantics-snapshot-test.js", status: "required" },
  { file: "handoff-smoke-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "health-live-paths-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "inbox-messaging-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "inline-data-injection-test.js", status: "required" },
  { file: "internal-demo-security-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "lease-renewal-resume-safety-test.js", status: "required" },
  { file: "live-openai-test.js", status: "excluded", reason: "live-provider" },
  { file: "local-connector-contract-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "login-origin-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "model-contract-violation-recovery-test.js", status: "required" },
  { file: "model-contract-violation-test.js", status: "required" },
  { file: "model-provider-routing-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "moving-goalpost-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "mutating-folder-bundle-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "mutating-limit-context-regression-test.js", status: "required" },
  { file: "mutation-admission-contract-test.js", status: "required" },
  { file: "mutation-admission-scheduler-test.js", status: "required" },
  { file: "navigation-stress-test.js", status: "excluded", reason: "manual-demo" },
  { file: "no-tracked-provider-keys-test.js", status: "required" },
  { file: "objective-clarification-gate-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "objective-contract-compiler-test.js", status: "required" },
  { file: "objective-contract-parity-test.js", status: "required" },
  { file: "ollama-failure-scenario-test.js", status: "excluded", reason: "live-provider" },
  { file: "ollama-provider-test.js", status: "excluded", reason: "live-provider" },
  { file: "operation-batch-test.js", status: "required" },
  { file: "operation-poststate-observation-test.js", status: "required" },
  { file: "operation-receipt-projection-test.js", status: "required" },
  { file: "operational-abuse-test.js", status: "excluded", reason: "superseded" },
  { file: "operator-visibility-test.js", status: "required" },
  { file: "operator-workflow-test.js", status: "excluded", reason: "source-coupled-other" },
  { file: "oquery-cli-parity-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "oquery-parity-test.js", status: "required" },
  { file: "organization-guidance-test.js", status: "required" },
  { file: "page-render-regression-test.js", status: "required" },
  { file: "phase-contract-alignment-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "permission-escalation-boundary-test.js", status: "required" },
  { file: "phase-gated-catalog-behavioral-test.js", status: "required" },
  { file: "postcondition-completion-test.js", status: "required" },
  { file: "postgres-persistence-contract-test.js", status: "required" },
  { file: "postgres-persistence-integration-test.js", status: "required" },
  { file: "postgres-runtime-cutover-test.js", status: "required" },
  { file: "postgres-startup-recovery-test.js", status: "required" },
  { file: "prefix-truncation-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "prior-artifact-owner-retry-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "process-execution-contract-test.js", status: "required" },
  { file: "process-execution-release-contract-test.js", status: "required" },
  { file: "process-execution-release-health-test.js", status: "required" },
  { file: "process-execution-release-postgres-test.js", status: "required" },
  { file: "process-execution-release-soak-test.js", status: "required" },
  { file: "process-consequence-reconstruction-test.js", status: "required" },
  { file: "process-deployment-systemd-test.js", status: "required" },
  { file: "process-lease-expiry-cancellation-postgres-test.js", status: "required" },
  { file: "process-launch-plan-test.js", status: "required" },
  { file: "process-launcher-foundation-contract-test.js", status: "required" },
  { file: "process-launcher-foundation-cross-uid-test.js", status: "required" },
  { file: "process-launcher-foundation-deployment-test.js", status: "required" },
  { file: "process-launcher-foundation-native-test.js", status: "required" },
  { file: "process-launcher-retention-test.js", status: "required" },
  { file: "process-materializer-contract-test.js", status: "required" },
  { file: "process-materializer-cross-uid-test.js", status: "required" },
  { file: "process-materializer-deployment-test.js", status: "required" },
  { file: "process-materializer-linux-test.js", status: "required" },
  { file: "process-materializer-native-test.js", status: "required" },
  { file: "process-output-artifact-test.js", status: "required" },
  { file: "process-release-backup-restore-test.js", status: "required" },
  { file: "process-release-ga-evidence-contract-test.js", status: "required" },
  { file: "process-runtime-capability-test.js", status: "required" },
  { file: "process-runtime-dispatch-postgres-test.js", status: "required" },
  { file: "process-runtime-fault-recovery-test.js", status: "required" },
  { file: "process-runtime-lifecycle-postgres-test.js", status: "required" },
  { file: "process-execution-runtime-test.js", status: "required" },
  { file: "process-supervision-contract-test.js", status: "required" },
  { file: "process-supervision-postgres-test.js", status: "required" },
  { file: "process-target-catalog-test.js", status: "required" },
  { file: "process-workspace-mutation-boundary-test.js", status: "required" },
  { file: "process-template-append-only-version-store-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "process-template-disable-pause-controls-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "process-template-state-observability-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "process-template-trigger-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "provider-response-recovery-postgres-test.js", status: "required" },
  { file: "quality-aggregation-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "reconciliation-evidence-failure-test.js", status: "required" },
  { file: "release-manifest-test.js", status: "required" },
  { file: "release-package-test.js", status: "required" },
  { file: "release-security-check-test.js", status: "required" },
  { file: "recovery-regression-test.js", status: "required" },
  { file: "recovery-state-reconstruction-test.js", status: "required" },
  { file: "release-checkpoint-coverage-test.js", status: "required" },
  { file: "renamepath-runtime-regression-test.js", status: "required" },
  { file: "replay-snapshot-storage-test.js", status: "required" },
  { file: "report-generation-test.js", status: "excluded", reason: "source-coupled-other" },
  { file: "required-replay-evidence-test.js", status: "required" },
  { file: "rerun-mode-evidence-test.js", status: "required" },
  { file: "resumable-execution-test.js", status: "required" },
  { file: "resume-obvious-postcondition-test.js", status: "required" },
  { file: "run-consequence-mutation-test.js", status: "required" },
  { file: "run-customer-support-test.js", status: "excluded", reason: "manual-demo" },
  { file: "run-decision-graph-projection-test.js", status: "required" },
  { file: "run-detail-evidence-clarity-test.js", status: "required" },
  { file: "run-detail-permissioned-delete-audit-test.js", status: "required" },
  { file: "run-diagnostics-bundle-test.js", status: "required" },
  { file: "run-evidence-drain-test.js", status: "required" },
  { file: "run-legal-intake-test.js", status: "excluded", reason: "manual-demo" },
  { file: "run-shared-drive-test.js", status: "excluded", reason: "manual-demo" },
  { file: "run-state-inconsistency-warning-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "run-ticket-plan-test.js", status: "excluded", reason: "manual-demo" },
  { file: "run-timeout-attribution-clarity-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "run-vendor-chunk-test.js", status: "excluded", reason: "manual-demo" },
  { file: "run-vendor-compliance-test.js", status: "excluded", reason: "manual-demo" },
  { file: "runtime-budget-contract-test.js", status: "required" },
  { file: "runtime-budget-postgres-test.js", status: "required" },
  { file: "runtime-budget-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "runtime-feasibility-test.js", status: "required" },
  { file: "runtime-limits-config-test.js", status: "required" },
  { file: "runtime-limits-ui-test.js", status: "required" },
  { file: "scheduled-process-template-trigger-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "scheduler-integrity-abuse-test.js", status: "excluded", reason: "superseded" },
  { file: "scheduler-observability-test.js", status: "required" },
  { file: "startup-data-integrity-test.js", status: "required" },
  { file: "status-transition-evidence-test.js", status: "required" },
  { file: "target-operation-reconciliation-test.js", status: "required" },
  { file: "target-provider-contract-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "telemetry-test.js", status: "required" },
  { file: "terminalization-boundary-recovery-test.js", status: "required" },
  { file: "ticket-budget-rollup-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "ticket-execution-state-clarity-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "ticket-feasibility-gate-test.js", status: "required" },
  { file: "timeline-authority-evidence-test.js", status: "required" },
  { file: "ticket-shaping-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "tm1-inspection-productivity-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "triage-inbox-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "triage-resolution-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "unverified-evaluation-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "verifier-contract-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "wal-append-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "work-context-primitive-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "work-context-visibility-surface-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "work-type-regression-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "workload-profile-test.js", status: "required" },
  { file: "workflow-action-plan-test.js", status: "required" },
  { file: "workflow-prompt-composition-test.js", status: "required" },
  { file: "workflow-ticket-plan-test.js", status: "required" },
  { file: "workspace-authority-gate-test.js", status: "required" },
  { file: "workspace-fixture-catalog-test.js", status: "required" },
  { file: "workspace-snapshot-availability-test.js", status: "required" },
  { file: "workspace-snapshot-recovery-test.js", status: "required" },
  { file: "write-conflict-protection-test.js", status: "orphaned", reason: "cutover-orphan" },
  { file: "writer-lock-test.js", status: "orphaned", reason: "cutover-orphan" },]);

function byStatus(status) {
  return TESTS.filter(entry => entry.status === status).map(entry => entry.file);
}

const REQUIRED_TESTS = Object.freeze(byStatus('required'));
const ORPHANED_TESTS = Object.freeze(byStatus('orphaned'));
const EXCLUDED_TESTS = Object.freeze(byStatus('excluded'));

function manifestByFile() {
  return new Map(TESTS.map(entry => [entry.file, entry]));
}

module.exports = {
  TESTS,
  REQUIRED_TESTS,
  ORPHANED_TESTS,
  EXCLUDED_TESTS,
  EXCLUSION_REASONS,
  ORPHAN_REASONS,
  manifestByFile
};

if (require.main === module) {
  const { CHECKPOINT_TEST_SCRIPTS, POSTGRES_INTEGRATION_SCRIPTS } = require('./release-checkpoint');
  const deterministic = new Set(CHECKPOINT_TEST_SCRIPTS);
  const postgres = new Set(POSTGRES_INTEGRATION_SCRIPTS);
  const where = file => (deterministic.has(file) ? 'deterministic' : postgres.has(file) ? 'postgres' : 'UNREGISTERED');

  console.log(`Test inventory — ${TESTS.length} suites under scripts/\n`);
  console.log(`  required : ${REQUIRED_TESTS.length}`);
  for (const [label, count] of Object.entries(
    REQUIRED_TESTS.reduce((acc, file) => ({ ...acc, [where(file)]: (acc[where(file)] || 0) + 1 }), {})
  )) console.log(`      ${label.padEnd(14)} ${count}`);

  console.log(`\n  orphaned : ${ORPHANED_TESTS.length}   (repair backlog — A20)`);
  for (const reason of Object.keys(ORPHAN_REASONS)) {
    const count = TESTS.filter(e => e.reason === reason).length;
    if (count) console.log(`      ${reason.padEnd(24)} ${count}`);
  }

  console.log(`\n  excluded : ${EXCLUDED_TESTS.length}`);
  for (const reason of Object.keys(EXCLUSION_REASONS)) {
    const count = TESTS.filter(e => e.reason === reason).length;
    if (count) console.log(`      ${reason.padEnd(24)} ${count}`);
  }

  const unregistered = REQUIRED_TESTS.filter(file => where(file) === 'UNREGISTERED');
  if (unregistered.length) {
    console.log(`\n  REQUIRED BUT UNREGISTERED (${unregistered.length}):`);
    for (const file of unregistered) console.log(`      ${file}`);
  }
}
