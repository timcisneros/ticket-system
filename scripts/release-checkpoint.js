// Release/demo checkpoint runner for the v0.1.x internal-demo baseline.
//
// Runs the documented checkpoint checks sequentially, prints each command before
// running it, and stops on the first failure with a nonzero exit. Failures are
// not swallowed. Requires no external services (some checks start a local
// Fastify server on localhost; that may need normal port-binding permission in
// sandboxed environments). Does not print secrets.
//
// The test-script list is exported as CHECKPOINT_TEST_SCRIPTS so the coverage
// guard (scripts/release-checkpoint-coverage-test.js) can assert — without
// executing the suite — that every listed test exists, is unique, and that the
// critical primitive tests are present.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Deterministic, ordered list of checkpoint test scripts (relative to scripts/).
const CHECKPOINT_TEST_SCRIPTS = [
  'ticket-timeline-authority-visibility-test.js',
  'business-scenario-contracts-test.js',
  'workspace-fixture-catalog-test.js',
  'target-provider-contract-test.js',
  'catalog-consistency-test.js',
  'page-render-regression-test.js',
  'artifact-prediction-capture-test.js',
  'ticket-feasibility-gate-test.js',
  'moving-goalpost-regression-test.js',
  'complete-flag-truncation-guard-test.js',
  'direct-folder-postcondition-completeness-test.js',
  'debug-reset-contamination-test.js',
  'startup-data-integrity-test.js',
  'rbac-and-inline-data-security-test.js',
  'run-state-inconsistency-warning-test.js',
  'run-detail-evidence-clarity-test.js',
  'run-timeout-attribution-clarity-test.js',
  'runtime-limits-ui-test.js',
  'ticket-execution-state-clarity-test.js',
  'oquery-cli-parity-test.js',
  'health-live-paths-test.js',
  'internal-demo-security-test.js',
  'no-tracked-provider-keys-test.js',
  'concurrency-conflict-test.js',
  'run-detail-permissioned-delete-audit-test.js',
  'run-diagnostics-bundle-test.js',
  'phase-contract-alignment-test.js',
  'event-chain-verify-test.js',
  'event-chain-restart-test.js',
  'event-journal-streaming-startup-test.js',
  'durable-event-append-test.js',
  'bounded-worker-pool-test.js',
  'event-journal-route-admission-contract-test.js',
  'event-journal-admission-recovery-test.js',
  'event-journal-record-rejection-test.js',
  'journal-backpressure-scheduler-test.js',
  'event-append-await-contract-test.js',
  'event-reader-bounds-test.js',
  'run-lease-repository-contract-test.js',
  'run-terminalization-repository-contract-test.js',
  'ticket-run-lifecycle-repository-contract-test.js',
  'run-replay-repository-contract-test.js',
  'non-terminal-evidence-repository-contract-test.js',
  'target-operation-reconciliation-test.js',
  'postgres-persistence-contract-test.js',
  'invalid-action-preflight-recovery-test.js',
  'exact-delete-target-absent-guard-test.js',
  'objective-contract-parity-test.js',
  'objective-contract-compiler-test.js',
  'postcondition-completion-test.js',
  'process-template-trigger-test.js',
  'scheduled-process-template-trigger-test.js',
  'process-template-state-observability-test.js',
  'process-template-disable-pause-controls-test.js',
  'process-template-version-provenance-test.js',
  'process-template-append-only-version-store-test.js',
  'process-template-activation-durability-test.js',
  'work-context-primitive-test.js',
  'work-context-visibility-surface-test.js',
  'agent-handoff-queue-protocol-test.js',
  'handoff-smoke-test.js',
  'bounded-watcher-test.js',
  'model-provider-routing-test.js',
  'local-connector-contract-test.js',
  'operational-transparency-test.js',
  // 2026-07 transparency arc: inbox messaging, operator surfaces, and the
  // login origin gate (docs/OPERATOR_INBOX.md, docs/OPERATIONAL_TRANSPARENCY.md,
  // docs/BROWSER_ENVIRONMENT.md). browser-environment-test skips its live-engine
  // checks when no Chromium executable is available.
  'triage-resolution-test.js',
  'triage-inbox-test.js',
  'inbox-messaging-test.js',
  'browser-environment-test.js',
  'oquery-parity-test.js',
  'operator-visibility-test.js',
  'login-origin-test.js',
  'run-decision-graph-projection-test.js',
  // r1.32: the coverage guard verifies this very list stays honest.
  'release-checkpoint-coverage-test.js'
];

module.exports = { CHECKPOINT_TEST_SCRIPTS };

function runCheckpoint() {
  // Ensure node_modules resolves whether run from the main repo or a detached
  // worktree (where node_modules may be a symlink at ./node_modules).
  const childEnv = { ...process.env, NODE_PATH: process.env.NODE_PATH || path.join(ROOT, 'node_modules') };

  const checks = [
    { label: 'pnpm run build (project-wide JavaScript syntax)', args: [path.join('scripts', 'check-js-syntax.js')] },
    ...CHECKPOINT_TEST_SCRIPTS.map(name => ({ label: `NODE_PATH=./node_modules node scripts/${name}`, args: [path.join('scripts', name)] }))
  ];

  // Fail fast and loudly if any referenced test script is missing — an omission
  // must never be silently skipped.
  const missing = CHECKPOINT_TEST_SCRIPTS.filter(name => !fs.existsSync(path.join(ROOT, 'scripts', name)));
  if (missing.length > 0) {
    console.error(`CHECKPOINT FAILED (missing referenced test scripts):\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }

  console.log(`Release checkpoint: ${checks.length} checks\n`);
  const startedAt = Date.now();
  let passed = 0;
  for (const check of checks) {
    console.log(`\n$ ${check.label}`);
    const result = spawnSync(process.execPath, check.args, { cwd: ROOT, env: childEnv, stdio: 'inherit' });
    if (result.error) {
      console.error(`\nCHECKPOINT FAILED (could not run): ${check.label}\n${result.error.message}`);
      process.exit(1);
    }
    if (result.status !== 0) {
      console.error(`\nCHECKPOINT FAILED: ${check.label} (exit ${result.status})`);
      console.error(`${passed}/${checks.length} checks passed before the failure.`);
      process.exit(result.status || 1);
    }
    passed += 1;
  }

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\nRELEASE CHECKPOINT PASSED: ${passed}/${checks.length} checks in ${elapsedS}s`);
}

if (require.main === module) {
  runCheckpoint();
}
